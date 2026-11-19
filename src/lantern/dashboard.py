"""Hermes's dashboard API: the only file that speaks it.

The desk talks to Hermes the way Hermes's own apps do:

* ``/api/ws``: the gateway JSON-RPC 2.0 stream. Events arrive as
  ``{"method": "event", "params": {type, session_id, payload}}``; Hermes may also ask the client
  something (``approval``, ``clarify``) as a JSON-RPC request with a string id.
* REST under ``/api`` for history, files and speech.

A socket is either a plain gateway socket or a session-authority socket (``gateway.ready`` says
``session_authority: true``). Since Hermes v2026.9.14 both refuse any key a method's contract does
not declare, so requests are shaped per mode (as in Hermes Desktop's ``wire.rs``). If a Hermes
release refuses a key a request can do without (``DROPPABLE``), the request is sent again without
it and the key is left out for the rest of that connection; any other refusal is reported.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set
from urllib.parse import quote, urlencode

from .auth import Auth, Http, split_url
from .errors import LanternError, NeedsSignIn

log = logging.getLogger("lantern.dashboard")

SOURCE = "lantern"
COMMAND_TIMEOUT_S = 45
BOT_CHAT_TITLE = "Bot Chat"
PING_EVERY_S = 15
SILENCE_LIMIT_S = 45
WS_MAX_BYTES = 32 * 1024 * 1024
QUIET_SOURCES = "cron,subagent,kanban,tool,oneshot"
NOT_CONVERSATIONS = set(QUIET_SOURCES.split(","))

DROPPABLE: Dict[str, Set[str]] = {
    "session.create": {"idempotency_key", "request_id", "follow_profile_config", "hidden", "source"},
    "session.resume": {"cols", "source", "defer_history", "omit_messages", "inline_images"},
    "session.list": {"include_hidden"},
}
_PLAIN_REFUSAL = re.compile(r"invalid params for [\w.]+: ([\w.]+)")

EventHandler = Callable[[str, str, Dict[str, Any]], Awaitable[None]]
RequestHandler = Callable[[str, str, Dict[str, Any]], Awaitable[None]]


class RpcError(LanternError):
    def __init__(self, method: str, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.method, self.code, self.data = method, code, data


class Gateway:
    """One WebSocket to Hermes: requests, events, server requests and the heartbeat."""

    def __init__(self, http: Http, auth: Auth, on_event: EventHandler, on_request: RequestHandler):
        self.http, self.auth = http, auth
        self._on_event, self._on_request = on_event, on_request
        self._ws = None
        self._calls: Dict[str, asyncio.Future] = {}
        self._n = 0
        self._send_lock = asyncio.Lock()
        self._dropped: Dict[str, Set[str]] = {}
        self.authority = False
        self.heartbeat = False
        self.ready_payload: Dict[str, Any] = {}
        self._last_heard = 0.0

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def run(self, on_open: Callable[[], Awaitable[None]]) -> None:
        """Connect, call ``on_open`` once ready, and return when the connection ends."""
        from websockets.asyncio.client import connect

        scheme, rest = split_url(self.http.base)
        url = f"{scheme}://{rest}/api/ws?{await self._credential()}"
        loop = asyncio.get_running_loop()
        async with connect(url, max_size=WS_MAX_BYTES, open_timeout=20, ping_interval=20, ping_timeout=40,
                           user_agent_header="lantern-desk") as ws:
            self._ws = ws
            self._dropped = {}
            self._last_heard = loop.time()
            ready = loop.create_future()
            reader = asyncio.ensure_future(self._read(ws, ready))
            beat: Optional[asyncio.Task] = None
            try:
                try:
                    await asyncio.wait_for(asyncio.shield(ready), 10)
                except asyncio.TimeoutError:
                    log.info("no gateway.ready within 10 s; assuming a plain gateway")
                if reader.done():
                    reader.result()
                await self.call("client.capabilities", server_requests=True)
                beat = asyncio.ensure_future(self._heartbeat(ws))
                await on_open()
                done, _ = await asyncio.wait({reader, beat}, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in (reader, beat):
                    if task is not None:
                        task.cancel()
                self._ws = None
                for future in self._calls.values():
                    if not future.done():
                        future.set_exception(ConnectionError("the connection to Hermes dropped"))
                self._calls.clear()

    async def close(self) -> None:
        if self._ws is not None:
            await self._ws.close()

    async def _credential(self) -> str:
        status = await self.http.raw("GET", "/api/status", timeout=15, signed=False)
        info = status.json()
        if status.status != 200 or not isinstance(info, dict) or "version" not in info:
            raise LanternError(f"{self.http.base} does not look like a Hermes dashboard.")
        self.status = info
        if info.get("auth_required"):
            self.auth.open_dashboard = False
            if not self.auth.signed_in:
                raise NeedsSignIn("Sign in to your Hermes to use this desk.")
            ticket = await self.http.post("/api/auth/ws-ticket", {})
            return urlencode({"ticket": ticket["ticket"]})
        self.auth.open_dashboard = True
        if not await self.auth.read_page_token():
            raise LanternError("This Hermes dashboard did not offer a way to connect.")
        return urlencode({"token": self.auth.page_token})

    async def _heartbeat(self, ws) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(PING_EVERY_S)
            if self.heartbeat:
                try:
                    await self.call("gateway.ping", timeout=SILENCE_LIMIT_S)
                except RpcError:
                    self.heartbeat = False  # a Hermes that does not know it; the transport pings remain
            if loop.time() - self._last_heard > SILENCE_LIMIT_S + PING_EVERY_S:
                raise ConnectionError("Hermes stopped answering")

    async def _read(self, ws, ready: asyncio.Future) -> None:
        loop = asyncio.get_running_loop()
        async for raw in ws:
            self._last_heard = loop.time()
            if isinstance(raw, (bytes, bytearray)):
                continue
            for line in raw.splitlines():
                if not line.strip():
                    continue
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(frame, dict):
                    continue
                method = frame.get("method")
                if method is None:
                    future = self._calls.get(str(frame.get("id")))
                    if future is not None and not future.done():
                        future.set_result(frame)
                elif method == "event":
                    params = frame.get("params") or {}
                    kind = str(params.get("type") or "")
                    payload = params.get("payload") if isinstance(params.get("payload"), dict) else {}
                    if kind == "gateway.ready":
                        self.ready_payload = payload
                        self.authority = payload.get("session_authority") is True
                        self.heartbeat = payload.get("heartbeat") is True
                        if not ready.done():
                            ready.set_result(payload)
                        continue
                    asyncio.ensure_future(self._safe(self._on_event(kind, str(params.get("session_id") or ""), payload)))
                elif "id" in frame:
                    params = frame.get("params") if isinstance(frame.get("params"), dict) else {}
                    asyncio.ensure_future(self._safe(self._on_request(str(frame["id"]), str(method), params)))

    @staticmethod
    async def _safe(coro) -> None:
        try:
            await coro
        except Exception:
            log.exception("handling a message from Hermes failed")

    async def call(self, method: str, timeout: float = 30, **params: Any) -> Dict[str, Any]:
        """A request, with keys this Hermes refused before left out, and one retry without newly refused optional keys."""
        params = {k: v for k, v in params.items() if v is not None and k not in self._dropped.get(method, set())}
        try:
            return await self._call(method, params, timeout)
        except RpcError as exc:
            refused = refused_keys(exc)
            optional = DROPPABLE.get(method, set())
            if not refused or not set(refused) <= optional or not set(refused) & set(params):
                raise
            log.info("Hermes refused %s for %s; sending without", ",".join(refused), method)
            self._dropped.setdefault(method, set()).update(refused)
            return await self._call(method, {k: v for k, v in params.items() if k not in refused}, timeout)

    async def _call(self, method: str, params: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        ws = self._ws
        if ws is None:
            raise ConnectionError("not connected to Hermes")
        self._n += 1
        call_id = f"d{self._n}"
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._calls[call_id] = future
        try:
            async with self._send_lock:
                await ws.send(json.dumps({"jsonrpc": "2.0", "id": call_id, "method": method, "params": params}))
            reply = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            raise LanternError(f"Hermes did not answer in time ({method}).") from None
        finally:
            self._calls.pop(call_id, None)
        if "error" in reply:
            error = reply.get("error") or {}
            raise RpcError(method, int(error.get("code") or 0), str(error.get("message") or error), error.get("data"))
        result = reply.get("result")
        return result if isinstance(result, dict) else {}

    async def respond(self, request_id: str, result: Optional[Dict[str, Any]] = None,
                      error: Optional[Dict[str, Any]] = None) -> None:
        ws = self._ws
        if ws is None:
            return
        body: Dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
        body["error" if error else "result"] = error or result or {}
        async with self._send_lock:
            await ws.send(json.dumps(body))


def refused_keys(exc: RpcError) -> List[str]:
    """Keys a contract refused: the authority lists them in ``data.fields``; a plain socket names the first."""
    if exc.code == 4001 and isinstance(exc.data, dict) and isinstance(exc.data.get("fields"), list):
        return [str(f).split(".")[0] for f in exc.data["fields"]]
    if exc.code == 4000:
        match = _PLAIN_REFUSAL.search(str(exc))
        if match:
            return [match.group(1).split(".")[0]]
    return []


class Hermes:
    """What the desk asks of Hermes, shaped for whichever socket mode is connected."""

    def __init__(self, base: str, auth: Auth, on_event: EventHandler, on_request: RequestHandler):
        self.base = base
        self.auth = auth
        self.http = Http(base, auth)
        self.gateway = Gateway(self.http, auth, on_event, on_request)
        # Per runtime session: the fences the authority wants (generation, revision, subscription).
        self.fences: Dict[str, Dict[str, Any]] = {}

    @property
    def version(self) -> str:
        return str(getattr(self.gateway, "status", {}).get("version") or "")

    # -- profiles and main chats ----------------------------------------------------------

    async def profiles(self) -> List[Dict[str, Any]]:
        result = await self.gateway.call("profiles.list")
        return [p for p in result.get("profiles") or [] if isinstance(p, dict) and p.get("name")]

    async def avatar(self, profile: str) -> Optional[Dict[str, Any]]:
        try:
            result = await self.gateway.call("profiles.get_asset", name=profile, asset="avatar", timeout=20)
        except RpcError:
            return None
        return result if result.get("found") and result.get("data") else None

    async def find_main(self, profile: str) -> str:
        """The stored id of a profile's main chat (its canonical Bot Chat), or "" when it has none."""
        params: Dict[str, Any] = {"profile": profile, "title": BOT_CHAT_TITLE, "limit": 20, "include_hidden": True}
        if self.gateway.authority:
            params["scope"] = "stored"
        try:
            rows = (await self.gateway.call("session.list", **params)).get("sessions") or []
        except RpcError:
            return ""
        chats = [r for r in rows if isinstance(r, dict) and (r.get("root_title") or r.get("title")) == BOT_CHAT_TITLE]
        if not chats:
            return ""
        best = max(chats, key=lambda r: float(r.get("last_active") or r.get("started_at") or 0))
        return str(best.get("resolved_id") or best.get("id") or best.get("session_id") or "")

    async def create(self, profile: str, main: bool) -> Dict[str, Any]:
        """A new live session: the profile's main chat (hidden, titled "Bot Chat") or a side chat."""
        key = uuid.uuid4().hex
        # A session-authority socket only takes the sources Hermes's own apps use (cli, tui, gui, ...).
        params: Dict[str, Any] = {"profile": profile, "source": "gui" if main or self.gateway.authority else SOURCE}
        if main:
            params.update(title=BOT_CHAT_TITLE, hidden=True, follow_profile_config=True)
        params["request_id" if self.gateway.authority else "idempotency_key"] = key
        result = await self.gateway.call("session.create", timeout=60, **params)
        self._remember_fences(result)
        return result

    async def resume(self, profile: str, stored_id: str) -> Dict[str, Any]:
        result = await self.gateway.call("session.resume", timeout=60, session_id=stored_id, profile=profile,
                                         source="gui" if self.gateway.authority else SOURCE,
                                         defer_history=True, omit_messages=True)
        self._remember_fences(result)
        return result

    def _remember_fences(self, result: Dict[str, Any]) -> None:
        sid = str(result.get("session_id") or "")
        if sid:
            info = result.get("info") if isinstance(result.get("info"), dict) else {}
            self.fences[sid] = {k: result.get(k, info.get(k)) for k in
                                ("execution_generation", "revision", "subscription_id")}
            self.fences[sid]["stored"] = str(result.get("stored_session_id") or "")

    async def submit(self, profile: str, sid: str, text: str) -> Dict[str, Any]:
        params: Dict[str, Any] = {"session_id": sid, "text": text, "profile": profile}
        if self.gateway.authority:
            params["submission_id"] = uuid.uuid4().hex
        return await self.gateway.call("prompt.submit", timeout=60, **params)

    async def interrupt(self, profile: str, sid: str) -> None:
        params: Dict[str, Any] = {"session_id": sid, "profile": profile}
        if self.gateway.authority:
            fresh = await self.resume(profile, str(self.fences.get(sid, {}).get("stored") or sid))
            params["execution_generation"] = fresh.get("execution_generation")
        await self.gateway.call("session.interrupt", **params)

    async def compact(self, profile: str, sid: str) -> Dict[str, Any]:
        try:
            return await self.gateway.call("session.compress", timeout=180, session_id=sid, profile=profile)
        except RpcError as exc:
            if exc.code != -32601:
                raise
        fence = self.fences.get(sid, {})
        return await self.gateway.call("session.mutate", timeout=180, session_id=sid, profile=profile,
                                       request_id=uuid.uuid4().hex, expected_revision=fence.get("revision"),
                                       expected_generation=fence.get("execution_generation"),
                                       operation="compress", payload={})

    async def leave(self, profile: str, sid: str) -> None:
        """Stop watching a live session (the conversation itself carries on in Hermes)."""
        try:
            if self.gateway.authority:
                fence = self.fences.get(sid, {})
                await self.gateway.call("session.detach", session_id=sid,
                                        subscription_id=fence.get("subscription_id"))
            else:
                await self.gateway.call("session.close", session_id=sid, profile=profile)
        except (RpcError, ConnectionError, LanternError) as exc:
            log.debug("leaving %s: %s", sid, exc)
        self.fences.pop(sid, None)

    # An approval or question carries the execution generation it belongs to; the answer must quote
    # that one, not whatever the session had when the desk last resumed it.
    async def answer_approval(self, profile: str, sid: str, request_id: str, prompt_id: str, choice: str,
                              generation: Any = None) -> None:
        if request_id:
            await self.gateway.respond(request_id, {"choice": choice})
        else:
            await self.gateway.call("approval.respond", session_id=sid, prompt_id=prompt_id, choice=choice,
                                    execution_generation=generation if generation is not None
                                    else self.fences.get(sid, {}).get("execution_generation"))

    async def answer_clarify(self, profile: str, sid: str, request_id: str, prompt_id: str, answers: Any,
                             generation: Any = None) -> None:
        if request_id:
            await self.gateway.respond(request_id, {"answers": answers} if isinstance(answers, dict) else {"answer": answers})
        else:
            await self.gateway.call("clarify.respond", session_id=sid, prompt_id=prompt_id, answer=answers,
                                    execution_generation=generation if generation is not None
                                    else self.fences.get(sid, {}).get("execution_generation"))

    async def delete(self, profile: str, stored_id: str) -> None:
        """Delete a stored conversation. A session-authority socket refuses ``session.delete``, so that
        mode (or a plain socket that has stopped offering it) uses the REST route, which goes through
        the authority."""
        if not self.gateway.authority:
            try:
                await self.gateway.call("session.delete", session_id=stored_id, profile=profile)
                return
            except RpcError as exc:
                if exc.code not in (-32601, 4001):
                    raise
        query = {"profile": profile} if profile else {}
        response = await self.http.raw("DELETE", f"/api/sessions/{quote(stored_id, safe='')}" +
                                       ("?" + urlencode(query) if query else ""))
        if response.status not in (200, 204, 404):
            self.http.checked(response, "delete")

    # -- slash commands -------------------------------------------------------------------

    async def commands(self, profile: str, sid: str = "") -> Dict[str, Any]:
        """Hermes's command catalogue (``commands.catalog``): names, descriptions, argument modes."""
        params: Dict[str, Any] = {"profile": profile}
        if sid:
            params["session_id"] = sid
        return await self.gateway.call("commands.catalog", timeout=20, **params)

    async def run_command(self, profile: str, sid: str, text: str) -> Dict[str, Any]:
        """Run ``/name arg`` the way Hermes's own apps do: ``slash.exec`` first, and
        ``command.dispatch`` when Hermes says the command needs it (skills, bundles, input-taking
        commands). Answers one directive: ``exec``/``plugin`` with ``output``, ``send``/``skill``
        with a ``message`` to submit, ``prefill`` with a ``message`` for the box, or ``alias``."""
        name, _, arg = text.strip().lstrip("/").partition(" ")
        try:
            # Without the leading "/", as Hermes's desktop app sends it. Commands Hermes cannot answer
            # in-process start its command worker, which can be slow (or stuck) on some hosts.
            result = await self.gateway.call("slash.exec", timeout=COMMAND_TIMEOUT_S, session_id=sid,
                                             command=text.strip().lstrip("/"), profile=profile)
        except RpcError as exc:
            if exc.code in (4018, -32601):
                result = await self.gateway.call("command.dispatch", timeout=120, name=name.lower(),
                                                 arg=arg.strip() or None, session_id=sid, profile=profile)
            elif "unsupported_command" in f"{exc.message} {exc.data}":
                detail = exc.data.get("detail") if isinstance(exc.data, dict) else ""
                raise LanternError(f"/{name} is not available from the desk." + (f" {detail}" if detail else "")) from None
            else:
                raise
        except LanternError as exc:
            if "did not answer in time" in str(exc):
                raise LanternError(f"Hermes did not finish /{name} in time. Commands that need Hermes's command "
                                   "worker can be slow to start; try again in a minute.") from None
            raise
        if not result.get("type"):
            result = {**result, "type": "exec"}
        return result

    # -- history --------------------------------------------------------------------------

    async def messages(self, profile: str, stored_id: str, limit: int = 60, offset: int = 0) -> List[Dict[str, Any]]:
        """Stored messages, oldest first: the latest ``limit`` after skipping ``offset`` newer ones."""
        query = {"limit": limit, "offset": offset, "order": "latest", "inline_images": "false"}
        if profile:
            query["profile"] = profile
        response = await self.http.raw("GET", f"/api/sessions/{quote(stored_id, safe='')}/messages?" + urlencode(query))
        if response.status == 404:
            return []  # a chat with no stored rows yet
        rows = self.http.checked(response, "messages").get("messages") or []
        return [r for r in rows if isinstance(r, dict)]

    async def sessions(self, profile: str, query: str = "", limit: int = 30, offset: int = 0) -> List[Dict[str, Any]]:
        if query:
            found = await self.http.get("/api/sessions/search?" + urlencode(
                {"q": query, "limit": limit, "profile": profile, "exclude_sources": QUIET_SOURCES}))
            return [{"id": h.get("session_id") or h.get("id"), "title": h.get("title"), "preview": h.get("snippet"),
                     "source": h.get("source"), "last_active": h.get("last_active") or h.get("session_started"),
                     "message_count": h.get("message_count") or 0}
                    for h in found.get("results") or [] if h.get("session_id") or h.get("id")]
        listing = await self.http.get("/api/sessions?" + urlencode(
            {"limit": min(max(limit, 1), 100), "offset": max(offset, 0), "order": "recent", "min_messages": 1,
             "exclude_sources": QUIET_SOURCES, "profile": profile}))
        return [r for r in listing.get("sessions") or [] if isinstance(r, dict)
                and str(r.get("source") or "") not in NOT_CONVERSATIONS]

    # -- speech ---------------------------------------------------------------------------

    async def speak_stream(self, text: str, on_start: Callable[[int], Awaitable[None]],
                           on_audio: Callable[[bytes], Awaitable[None]], stop: asyncio.Event,
                           profile: str = "") -> None:
        """Hermes's streaming text-to-speech: PCM (s16le mono) per sentence as it is synthesised.

        Raises :class:`SpeechFallback` when Hermes's voice cannot stream; ``speak_once`` then works."""
        from websockets.asyncio.client import connect

        ticket = (await self.http.post("/api/auth/ws-ticket", {}))["ticket"]
        scheme, rest = split_url(self.base)
        query = {"ticket": ticket, **({"profile": profile} if profile and profile != "default" else {})}
        async with connect(f"{scheme}://{rest}/api/audio/speak-stream?" + urlencode(query),
                           max_size=WS_MAX_BYTES, open_timeout=15) as ws:
            await ws.send(json.dumps({"text": text}))
            await ws.send(json.dumps({"done": True}))
            stopper = asyncio.ensure_future(stop.wait())
            try:
                while True:
                    receive = asyncio.ensure_future(ws.recv())
                    done, _ = await asyncio.wait({receive, stopper}, timeout=60, return_when=asyncio.FIRST_COMPLETED)
                    if stopper in done:
                        receive.cancel()
                        await ws.send(json.dumps({"stop": True}))
                        return
                    if not done:
                        receive.cancel()
                        raise LanternError("Hermes stopped sending speech.")
                    message = receive.result()
                    if isinstance(message, (bytes, bytearray)):
                        await on_audio(bytes(message))
                        continue
                    frame = json.loads(message)
                    kind = frame.get("type")
                    if kind == "start":
                        await on_start(int(frame.get("sample_rate") or 24000))
                    elif kind == "end":
                        return
                    elif kind == "fallback":
                        raise SpeechFallback()
                    elif kind == "error":
                        raise LanternError(str(frame.get("message") or "Hermes could not speak that."))
            finally:
                stopper.cancel()

    async def speak_once(self, text: str, profile: str = "") -> Dict[str, Any]:
        """The whole reply as one audio file (``/api/audio/speak``): ``{data_url, mime_type}``."""
        path = "/api/audio/speak" + (("?" + urlencode({"profile": profile})) if profile and profile != "default" else "")
        return await self.http.post(path, {"text": text[:4000]}, timeout=120)


class SpeechFallback(LanternError):
    """Hermes's voice cannot stream; ask for the whole clip with ``speak_once`` instead."""
