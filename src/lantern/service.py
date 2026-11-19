"""``lantern run``: the service between the desk's screen and Hermes.

It holds the one connection to Hermes and the credentials, and serves the protocol in
``docs/local-api.md`` twice: to the screen over a WebSocket on 127.0.0.1 (``bridge.py``) and to
the ``lantern`` command over a Unix socket. It reconnects by itself, with a growing, jittered
delay that the screen can show as a countdown.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import random
import re
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from . import __version__, config
from .auth import Auth, normalize_base
from .bridge import Bridge
from .conversation import Conversation
from .dashboard import Hermes
from .errors import LanternError, NeedsSignIn
from .links import Blocked, Fetcher

log = logging.getLogger("lantern.service")

SETUP, SIGNIN, CONNECTING, OFFLINE, READY = "setup", "signin", "connecting", "offline", "ready"
SOCKET_LIMIT = 4 * 1024 * 1024


class _Client:
    """One screen (WebSocket) or one command (Unix socket)."""

    def __init__(self, kind: str, send_text, send_bytes=None, close=None):
        self.kind = kind
        self._send_text, self._send_bytes, self._close = send_text, send_bytes, close
        self.queue: "asyncio.Queue[Any]" = asyncio.Queue(maxsize=2000)

    def send(self, msg: Dict[str, Any]) -> None:
        self._put(json.dumps(msg, separators=(",", ":"), ensure_ascii=False))

    def send_binary(self, data: bytes) -> None:
        if self._send_bytes is not None:
            self._put(data)

    def _put(self, item: Any) -> None:
        try:
            self.queue.put_nowait(item)
        except asyncio.QueueFull:  # a client that stopped reading is dropped, never waited for
            log.warning("a %s client stopped reading; disconnecting it", self.kind)
            if self._close is not None:
                asyncio.ensure_future(self._close())

    async def pump(self) -> None:
        try:
            while True:
                item = await self.queue.get()
                if isinstance(item, bytes):
                    await self._send_bytes(item)
                else:
                    await self._send_text(item)
        except asyncio.CancelledError:
            raise
        except Exception:  # the client went away; _serve notices and cleans up
            return


class Service:
    def __init__(self, home: Optional[Path] = None, port: int = 8765, dev: bool = False, token: str = ""):
        from . import net

        net.install()  # a Tailscale name resolves even where MagicDNS is turned off
        self.home = Path(home) if home else config.home()
        self.cfg = config.load(self.home)
        self.settings = config.load_settings(self.home)
        self.clients: Set[_Client] = set()
        self.state = SETUP if not self.cfg.get("url") else CONNECTING
        self.error, self.detail = "", ""
        self.retry_at = 0.0
        self.conversation = Conversation(self.home, self.broadcast)
        self.conversation.on_reply = self._maybe_read_aloud
        self.fetcher = Fetcher()
        self.bridge = Bridge(self, port=port, dev=dev, token=token)
        self.dev = dev
        self.auth: Optional[Auth] = None
        self.hermes: Optional[Hermes] = None
        self.last_alive = 0.0
        self._wake = asyncio.Event()
        self._stopping = False
        self._unix = None
        self._speech: Optional[Tuple[str, asyncio.Event, asyncio.Task]] = None
        self._setup_auth()

    def _setup_auth(self) -> None:
        url = self.cfg.get("url") or ""
        self.auth = Auth(url, self.home / "credentials.json") if url else None

    # -- lifecycle --------------------------------------------------------------------------

    async def run(self) -> None:
        await self.start()
        try:
            await self._connect_forever()
        finally:
            await self.stop()

    async def start(self) -> None:
        await self.bridge.start()
        path = config.socket_path(self.home)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            if await _socket_alive(path):
                raise LanternError(f"lantern is already running here ({path}).")
            path.unlink()
        self._unix = await asyncio.start_unix_server(self._serve_unix, path=str(path), limit=SOCKET_LIMIT)
        os.chmod(path, 0o600)
        log.info("local socket at %s", path)

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        if self.hermes is not None:
            await self.hermes.gateway.close()
        await self.bridge.stop()
        if self._unix is not None:
            self._unix.close()
            self._unix = None
        with contextlib.suppress(OSError):
            config.socket_path(self.home).unlink()

    async def _connect_forever(self) -> None:
        delay = 1.0
        while not self._stopping:
            if not self.cfg.get("url") or self.auth is None:
                await self._set_state(SETUP)
                await self._sleep(None)
                continue
            self.hermes = Hermes(self.auth.base, self.auth, self.conversation.on_event, self.conversation.on_request)
            await self._set_state(CONNECTING)
            started = time.monotonic()
            try:
                await self.hermes.gateway.run(self._on_open)
                error, detail = "The connection to Hermes closed.", ""
            except NeedsSignIn as exc:
                self.conversation.connection_lost()
                await self._set_state(SIGNIN, error=str(exc))
                await self._sleep(None)
                delay = 1.0
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # anything at all: say so, wait, try again
                error, detail = _explain(exc)
                log.info("connection to Hermes ended: %s (%s)", error, detail)
            self.conversation.connection_lost()
            if self._stopping:
                break
            if time.monotonic() - started > 60:
                delay = 1.0  # it had been working; try again quickly
            wait = delay + random.uniform(0, delay / 2)
            self.retry_at = time.time() + wait
            await self._set_state(OFFLINE, error=error, detail=detail, retry_in=round(wait))
            if await self._sleep(wait):
                delay = 1.0
            else:
                delay = min(delay * 2, 30.0)
        await self._set_state(OFFLINE)

    async def _sleep(self, seconds: Optional[float]) -> bool:
        """Wait, but wake at once when asked (a sign-in, a new address, Retry). True when woken."""
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), seconds)
            return True
        except asyncio.TimeoutError:
            return False

    async def _on_open(self) -> None:
        assert self.hermes is not None
        await self.conversation.start(self.hermes, self.settings)
        self.error = self.detail = ""
        await self._set_state(READY)
        self.broadcast(self.snapshot())

    async def _set_state(self, state: str, error: str = "", detail: str = "", **extra: Any) -> None:
        changed = (state, error, detail) != (self.state, self.error, self.detail)
        self.state, self.error, self.detail = state, error, detail
        if changed or extra:
            self.broadcast({"type": "link", "state": state, "error": error, "detail": detail, **extra})

    # -- what clients see -----------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        c = self.conversation
        return {
            "type": "hello", "version": 2, "state": self.state, "error": self.error, "detail": self.detail,
            "server": {"url": self.cfg.get("url") or "", "version": self.hermes.version if self.hermes else ""},
            "device": {"name": self.cfg.get("name") or "", "software": __version__},
            "account": {"username": self.auth.username if self.auth else "",
                        "remembered": self.auth.remembered if self.auth else False},
            "profiles": c.profiles, "view": c.public_view(), "turn": c.public_turn(), "prompt": c.public_prompt(),
            "settings": dict(self.settings), "dev": self.dev,
        }

    def broadcast(self, msg: Dict[str, Any]) -> None:
        for client in list(self.clients):
            client.send(msg)

    def _broadcast_binary(self, data: bytes) -> None:
        for client in list(self.clients):
            client.send_binary(data)

    async def serve_screen(self, connection) -> None:
        async def close() -> None:
            await connection.close()

        client = _Client("screen", connection.send, connection.send, close)
        await self._serve(client, connection)

    async def _serve_unix(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        async def send_text(text: str) -> None:
            writer.write(text.encode() + b"\n")
            await writer.drain()

        async def close() -> None:
            writer.close()

        async def lines():
            while True:
                line = await reader.readline()
                if not line:
                    return
                yield line

        client = _Client("command", send_text, None, close)
        try:
            await self._serve(client, lines())
        finally:
            writer.close()

    async def _serve(self, client: _Client, incoming) -> None:
        self.clients.add(client)
        client.send(self.snapshot())
        pump = asyncio.ensure_future(client.pump())
        try:
            async for raw in incoming:
                if isinstance(raw, (bytes, bytearray)) and not raw.strip():
                    continue
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    asyncio.ensure_future(self._handle(client, msg))
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as exc:  # websockets raises its own ConnectionClosed family
            if "ConnectionClosed" not in type(exc).__name__:
                log.exception("a client failed")
        finally:
            self.clients.discard(client)
            pump.cancel()

    async def _handle(self, client: _Client, msg: Dict[str, Any]) -> None:
        op, req = str(msg.get("op") or ""), msg.get("req")
        try:
            result = await self._op(op, msg)
        except Exception as exc:  # every op gets an answer, never a silent hang
            if not isinstance(exc, (LanternError, ConnectionError, asyncio.TimeoutError, ValueError, KeyError, TypeError)):
                log.exception("op %s failed", op)
            error, _ = _explain(exc) if not isinstance(exc, LanternError) else (str(exc), "")
            client.send({"type": "result", "req": req, "op": op, "ok": False, "error": error})
            if isinstance(exc, NeedsSignIn) and self.state == READY:
                self._wake.set()
            return
        if req is not None:
            client.send({"type": "result", "req": req, "op": op, "ok": True, **(result or {})})

    # -- operations ---------------------------------------------------------------------------

    def _ready(self) -> None:
        if self.state != READY:
            raise LanternError({SETUP: "Set up the Hermes address first.", SIGNIN: "Sign in to Hermes first."}
                               .get(self.state, "Not connected to Hermes right now."))

    async def _op(self, op: str, msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        c = self.conversation
        if op == "status":
            return {"status": self.snapshot()}
        if op == "alive":
            self.last_alive = time.time()
            return None
        if op == "retry":
            self._wake.set()
            return None
        if op == "settings.set":
            changes = config.clean_settings(msg.get("changes"))
            if not changes:
                raise LanternError("Nothing to change.")
            self.settings.update(changes)
            config.save_settings(self.settings, self.home)
            self.broadcast({"type": "settings", "settings": dict(self.settings)})
            return {"settings": dict(self.settings)}
        if op == "setup":
            await self.configure(str(msg.get("url") or ""))
            return None
        if op == "signin":
            if self.auth is None:
                raise LanternError("Set up the Hermes address first.")
            await self.auth.sign_in(str(msg.get("username") or ""), str(msg.get("password") or ""),
                                    bool(msg.get("remember", True)))
            self._wake.set()
            return None
        if op == "signout":
            if self.auth is not None:
                self.auth.sign_out()
            if self.hermes is not None:
                await self.hermes.gateway.close()
            await self._set_state(SIGNIN, error="Signed out.")
            self.broadcast(self.snapshot())
            return None
        if op == "link.preview":
            url = str(msg.get("url") or "")
            try:
                return {"preview": await self.fetcher.preview(url)}
            except Blocked as exc:
                raise LanternError(str(exc)) from None
        if op == "speak.stop":
            self._stop_speaking()
            return None
        self._ready()
        if op == "send":
            return {"id": await c.send(str(msg.get("text") or ""))}
        if op == "stop":
            self._stop_speaking()
            await c.stop()
            return None
        if op == "chat.open":
            profile = str(msg.get("profile") or c.view["profile"])
            return {"view": await c.open(profile, str(msg.get("session_id") or "") or None)}
        if op == "chat.new":
            return {"view": await c.new_chat(str(msg.get("profile") or "") or None)}
        if op == "chat.compact":
            await c.compact()
            return None
        if op == "history.more":
            return await c.more()
        if op == "sessions.list":
            return {"sessions": await c.sessions(str(msg.get("profile") or c.view["profile"]), str(msg.get("query") or ""),
                                                 int(msg.get("limit") or 30), int(msg.get("offset") or 0))}
        if op == "answer":
            await c.answer(str(msg.get("id") or ""), msg.get("choice"), msg.get("text"))
            return None
        if op == "speak":
            return {"id": self.speak(str(msg.get("message_id") or ""))}
        raise LanternError(f"Unknown operation: {op or '(none)'}.")

    async def configure(self, raw: str) -> None:
        """Point the desk at a Hermes (first run, or a corrected address) and start connecting."""
        raw = raw.strip()
        try:
            if "://" in raw:
                url = normalize_base(raw)
            else:  # just a name: try the usual places a dashboard answers and keep the one that does
                guesses = [normalize_base("https://" + raw), normalize_base("http://" + raw)]
                url = await _first_answering(guesses) or guesses[0 if raw.endswith(".ts.net") else 1]
        except ValueError as exc:
            raise LanternError(str(exc)) from None
        if url == self.cfg.get("url") and self.auth is not None:
            self._wake.set()
            return
        self.cfg["url"] = url
        config.save(self.cfg, self.home)
        self._setup_auth()
        self.bridge.forget_avatars()
        self.conversation.profiles = []
        self.conversation.view = self.conversation._empty_view("default")
        if self.hermes is not None:
            await self.hermes.gateway.close()
        self._wake.set()
        self.broadcast(self.snapshot())

    async def media_bytes(self, media_id: str) -> Tuple[bytes, str]:
        if self.hermes is None:
            raise LanternError("Not connected to Hermes right now.")
        return await self.conversation.media.fetch(self.hermes.http, media_id)

    async def avatar(self, profile: str) -> Optional[Dict[str, Any]]:
        if self.hermes is None or not self.hermes.gateway.connected:
            return None
        return await self.hermes.avatar(profile)

    # -- reading aloud ------------------------------------------------------------------------

    def _maybe_read_aloud(self, message: Dict[str, Any]) -> None:
        if self.settings.get("read_aloud") and not message.get("voice"):
            with contextlib.suppress(LanternError):
                self.speak(message["id"])

    def speak(self, message_id: str) -> str:
        message = next((m for m in self.conversation.view["messages"] if m["id"] == message_id), None)
        if message is None or message.get("role") != "assistant":
            raise LanternError("There is no reply to read aloud.")
        text = speakable(message.get("text") or "")
        if not text:
            raise LanternError("That reply has nothing to read aloud.")
        self._stop_speaking()
        speech_id = uuid.uuid4().hex[:10]
        stop = asyncio.Event()
        task = asyncio.ensure_future(self._speak(speech_id, message_id, text, stop))
        self._speech = (speech_id, stop, task)
        return speech_id

    def _stop_speaking(self) -> None:
        if self._speech is not None:
            self._speech[1].set()

    async def _speak(self, speech_id: str, message_id: str, text: str, stop: asyncio.Event) -> None:
        assert self.hermes is not None
        started = False
        reason, error = "done", ""

        async def on_start(rate: int) -> None:
            nonlocal started
            started = True
            self.broadcast({"type": "speech.start", "id": speech_id, "message_id": message_id, "sample_rate": rate})

        async def on_audio(data: bytes) -> None:
            if started and not stop.is_set():
                self._broadcast_binary(data)

        try:
            await self.hermes.speak_stream(text, on_start, on_audio, stop)
            if stop.is_set():
                reason = "stopped"
        except Exception as exc:
            reason, error = "error", _explain(exc)[0]
            log.info("speaking failed: %s", exc)
        finally:
            if not started:
                self.broadcast({"type": "speech.start", "id": speech_id, "message_id": message_id, "sample_rate": 24000})
            self.broadcast({"type": "speech.end", "id": speech_id, "reason": reason, **({"error": error} if error else {})})
            if self._speech is not None and self._speech[0] == speech_id:
                self._speech = None


_CODE_BLOCK = re.compile(r"```.*?(```|$)", re.DOTALL)
_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_URL = re.compile(r"https?://\S+")


def speakable(markdown: str) -> str:
    """A reply as something worth hearing: no code, no URLs, no Markdown punctuation."""
    text = _CODE_BLOCK.sub(" (code shown on screen) ", markdown)
    text = _MD_LINK.sub(lambda m: m.group(1), text)
    text = _URL.sub("(link on screen)", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"(\*\*|__|\*|_|~~)", "", text)
    text = re.sub(r"\|", " ", text)
    return re.sub(r"\s+\n", "\n", re.sub(r"[ \t]+", " ", text)).strip()[:4000]


def _explain(exc: BaseException) -> Tuple[str, str]:
    """A sentence for the screen, and the technical detail."""
    detail = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
    if isinstance(exc, LanternError):
        return str(exc), ""
    if isinstance(exc, ConnectionError) or "cannot reach" in str(exc):
        return "Can't reach Hermes. Check the network and that Hermes is running.", detail
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "Hermes took too long to answer.", detail
    name = type(exc).__name__
    if "InvalidStatus" in name or "InvalidHandshake" in name:
        return "Hermes refused the connection.", detail
    if "ConnectionClosed" in name:
        return "The connection to Hermes dropped.", detail
    if isinstance(exc, OSError):
        return "Can't reach Hermes. Check the network and that Hermes is running.", detail
    return "Something went wrong talking to Hermes.", detail


def _answers(url: str) -> bool:
    from . import net

    net.install()
    try:
        with urllib.request.urlopen(url + "/api/status", timeout=5) as response:
            return isinstance(json.loads(response.read() or b"null"), dict)
    except urllib.error.HTTPError as exc:
        return exc.code in (401, 403)
    except Exception:
        return False


async def _first_answering(urls: List[str]) -> Optional[str]:
    loop = asyncio.get_running_loop()
    for url in urls:
        if await loop.run_in_executor(None, _answers, url):
            return url
    return None


async def _socket_alive(path: Path) -> bool:
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(str(path)), 1)
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    return True
