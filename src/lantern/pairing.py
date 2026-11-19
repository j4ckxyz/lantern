"""Setting the desk up from a phone, like signing a games console in from another device.

Hermes has no device-code sign-in, so the desk briefly serves its own small page on the local
network. The screen shows a QR code (the page's address with a one-time key) and a short code for
typing in by hand. On the phone you enter the Hermes address, your username and your password;
the desk then signs in the normal way, as if they had been typed on its own screen.

The page exists only while someone asks for it from the setup or sign-in screen: it closes after
one successful use, after ten minutes, or after five wrong codes. It is plain http on your own
network (or tailnet), so the password crosses that network once; the page says so.
"""

from __future__ import annotations

import asyncio
import hmac
import html
import ipaddress
import logging
import secrets
import socket
import subprocess
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

from .errors import LanternError

log = logging.getLogger("lantern.pairing")

PORT = 8770
LIFETIME_S = 600
MAX_WRONG = 5
_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679"  # no 0/O, 1/I/L, 2/Z, 5/S, 8/B

Submit = Callable[[str, str, str, bool], Awaitable[None]]


def new_code() -> str:
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(6))
    return f"{raw[:3]}-{raw[3:]}"


def _norm_code(text: str) -> str:
    return "".join(ch for ch in text.upper() if ch.isalnum())


def addresses() -> List[str]:
    """This machine's addresses a phone could reach, most useful first: the local network, then
    the tailnet."""
    found: List[str] = []
    try:
        out = subprocess.run(["ip", "-o", "-4", "addr", "show", "scope", "global"], capture_output=True,
                             text=True, timeout=3).stdout
        for line in out.splitlines():
            parts = line.split()
            if "inet" in parts:
                found.append(parts[parts.index("inet") + 1].split("/")[0])
    except (OSError, subprocess.SubprocessError):
        pass
    if not found:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:  # the route out, without sending anything
            try:
                s.connect(("192.0.2.1", 9))
                found.append(s.getsockname()[0])
            except OSError:
                pass
    tailnet = ipaddress.ip_network("100.64.0.0/10")
    found = [a for a in dict.fromkeys(found) if not ipaddress.ip_address(a).is_loopback]
    return sorted(found, key=lambda a: ipaddress.ip_address(a) in tailnet)


class Pairing:
    """One pairing window. ``state`` is waiting, working, done, failed or stopped."""

    def __init__(self, submit: Submit, on_change: Callable[[Dict[str, Any]], None], current_url: str = "",
                 port: int = PORT, host: str = "0.0.0.0"):
        self.submit, self.on_change, self.current_url = submit, on_change, current_url
        self.port, self.host = port, host
        self.code = new_code()
        self.key = secrets.token_urlsafe(16)
        self.expires = time.time() + LIFETIME_S
        self.wrong = 0
        self.state, self.error = "waiting", ""
        self._server: Optional[asyncio.base_events.Server] = None
        self._expiry: Optional[asyncio.Task] = None
        self._busy = asyncio.Lock()

    def public(self) -> Dict[str, Any]:
        addrs = addresses()
        hostname = socket.gethostname()
        urls = [f"http://{a}:{self.port}" for a in addrs]
        names = [f"http://{hostname}.local:{self.port}"] if hostname and hostname != "localhost" else []
        return {"state": self.state, "error": self.error, "code": self.code,
                "expires_in": max(0, int(self.expires - time.time())),
                "url": (urls[0] if urls else (names[0] if names else "")) + f"/?k={self.key}",
                "addresses": names + urls}

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, self.host, self.port, reuse_address=True)
        self._expiry = asyncio.ensure_future(self._expire())
        log.info("pairing page open on port %s", self.port)

    async def stop(self, state: str = "stopped", error: str = "") -> None:
        if self._expiry and self._expiry is not asyncio.current_task():
            self._expiry.cancel()
        if self._server is not None:
            self._server.close()
            self._server = None
        if self.state not in ("done", "failed") or state == "done":
            self.state, self.error = state, error
        self.on_change(self.public())

    async def _expire(self) -> None:
        await asyncio.sleep(max(0.0, self.expires - time.time()))
        await self.stop("failed", "The pairing code ran out. Start again from the desk.")

    # -- the little web server ------------------------------------------------------------

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = head.decode("latin-1").split("\r\n")
            method, target, _ = (lines[0].split(" ") + ["", "", ""])[:3]
            headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:] if ln)}
            length = int(headers.get("content-length") or 0)
            if length > 8192:
                return await self._send(writer, 413, "<p>Too much.</p>")
            body = (await asyncio.wait_for(reader.readexactly(length), 10)).decode("utf-8", "replace") if length else ""
            query = parse_qs(urlsplit(target).query)
            if method == "GET" and urlsplit(target).path in ("/", "/index.html"):
                key = (query.get("k") or [""])[0]
                return await self._send(writer, 200, self._page(key_ok=bool(key) and hmac.compare_digest(key, self.key)))
            if method == "POST" and urlsplit(target).path == "/":
                return await self._send(writer, *await self._post(parse_qs(body)))
            await self._send(writer, 404, "<p>Nothing here.</p>")
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError, ValueError):
            pass
        finally:
            writer.close()

    async def _post(self, form: Dict[str, List[str]]) -> tuple:
        field = lambda k: (form.get(k) or [""])[0].strip()  # noqa: E731
        if self.state != "waiting":
            return 410, self._message("This pairing has ended", "Start again from the desk if you still need to.")
        key, code = field("k"), _norm_code(field("code"))
        if not ((key and hmac.compare_digest(key, self.key)) or (code and hmac.compare_digest(code, _norm_code(self.code)))):
            self.wrong += 1
            if self.wrong >= MAX_WRONG:
                asyncio.ensure_future(self.stop("failed", "Too many wrong codes. Start again from the desk."))
                return 403, self._message("Too many wrong codes", "For safety this pairing has ended. Start again from the desk.")
            return 403, self._page(key_ok=False, error="That code is not the one on the desk.", form=form)
        url, user, password = field("url"), field("username"), (form.get("password") or [""])[0]
        if not (url and user and password):
            return 400, self._page(key_ok=bool(key), error="Fill in all three: address, username and password.", form=form)
        async with self._busy:
            self.state, self.error = "working", ""
            self.on_change(self.public())
            try:
                await self.submit(url, user, password, field("remember") == "on")
            except LanternError as exc:
                self.state, self.error = "waiting", str(exc)
                self.on_change(self.public())
                return 200, self._page(key_ok=bool(key), error=str(exc), form=form)
        asyncio.ensure_future(self.stop("done"))
        return 200, self._message("The desk is signed in", "You can put your phone away. Hermes is on the desk now.")

    async def _send(self, writer: asyncio.StreamWriter, status: int, body: str) -> None:
        reason = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 410: "Gone", 413: "Too Large"}[status]
        data = _DOC.format(body=body).encode()
        writer.write(
            f"HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {len(data)}\r\n"
            "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n"
            "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
            "frame-ancestors 'none'; base-uri 'none'\r\nConnection: close\r\n\r\n".encode() + data)
        await writer.drain()

    # -- the page -------------------------------------------------------------------------

    def _page(self, key_ok: bool, error: str = "", form: Optional[Dict[str, List[str]]] = None) -> str:
        form = form or {}
        value = lambda k, d="": html.escape((form.get(k) or [d])[0], quote=True)  # noqa: E731
        code_field = (f'<input type="hidden" name="k" value="{html.escape(self.key)}">' if key_ok else
                      '<label>Code on the desk<input name="code" autocomplete="one-time-code" autocapitalize="characters" '
                      'placeholder="ABC-123" required></label>')
        return f"""
<h1>Set up your Lantern</h1>
<p>Enter your Hermes dashboard's address and sign-in. The desk signs in with them, as if you had typed them on it.</p>
{f'<p class="err" role="alert">{html.escape(error)}</p>' if error else ''}
<form method="post" action="/">
  {code_field}
  <label>Hermes address<input name="url" inputmode="url" autocapitalize="off" spellcheck="false" required
    placeholder="hermes.your-tailnet.ts.net" value="{value('url', self.current_url)}"></label>
  <label>Username<input name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required
    value="{value('username')}"></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
  <label class="check"><input type="checkbox" name="remember" checked> Stay signed in (the desk keeps the password so it can sign in again by itself)</label>
  <button>Sign the desk in</button>
</form>
<p class="note">This page is on your own network and closes once the desk is signed in. Your password travels to the desk once, unencrypted unless you are on Tailscale.</p>"""

    def _message(self, title: str, text: str) -> str:
        return f"<h1>{html.escape(title)}</h1><p>{html.escape(text)}</p>"


_DOC = """<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Set up your Lantern</title>
<style>
:root{{color-scheme:dark;--bg:#000;--card:#0f1130;--line:rgba(150,160,255,.24);--text:#f2f3fb;--muted:#aab0d6;--accent:#2f58d6;--danger:#ff8a8a}}
@media (prefers-color-scheme:light){{:root{{color-scheme:light;--bg:#f4f5fb;--card:#fff;--line:rgba(20,28,90,.18);--text:#0c0e2e;--muted:#464c76;--danger:#c22c2c}}}}
body{{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:24px 16px}}
main{{max-width:420px;margin:0 auto}}h1{{font-size:24px;margin:8px 0}}p{{color:var(--muted)}}
form{{display:flex;flex-direction:column;gap:14px;margin:18px 0}}label{{display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--muted)}}
input{{font:inherit;color:var(--text);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}}
.check{{flex-direction:row;align-items:flex-start;gap:10px}}.check input{{width:20px;height:20px;margin:2px 0 0}}
button{{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:24px;padding:14px}}
.err{{color:var(--danger)}}.note{{font-size:13px}}
</style></head><body><main>{body}</main></body></html>"""
