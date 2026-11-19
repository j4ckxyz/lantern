"""The desk's screen talks to the service here: the built UI, media, and a WebSocket, on 127.0.0.1.

One small server (the ``websockets`` library the service already uses answers plain HTTP GETs
before any WebSocket handshake), so there is nothing else to install. Everything but the UI's
static files needs the per-boot token: the kiosk opens ``/?t=<token>``, which sets an HttpOnly
cookie for the rest. ``docs/local-api.md`` describes the paths.
"""

from __future__ import annotations

import base64
import http.cookies
import logging
import mimetypes
import os
import re
import secrets
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from .errors import LanternError

if TYPE_CHECKING:
    from .service import Service

log = logging.getLogger("lantern.bridge")

COOKIE = "lantern_ui"
CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; "
       "font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")
_PROFILE = re.compile(r"^[\w.-]{1,64}$")


def ui_dir() -> Optional[Path]:
    """Where the built UI is: ``$LANTERN_UI_DIR``, the package's copy, or ``ui/dist`` in a checkout."""
    candidates = [os.environ.get("LANTERN_UI_DIR") or "", str(Path(__file__).with_name("ui")),
                  str(Path(__file__).resolve().parents[2] / "ui" / "dist")]
    for candidate in candidates:
        if candidate and (Path(candidate) / "index.html").is_file():
            return Path(candidate)
    return None


class Bridge:
    def __init__(self, service: "Service", host: str = "127.0.0.1", port: int = 8765, dev: bool = False,
                 token: str = ""):
        self.service = service
        self.host, self.port = host, port
        self.dev = dev
        self.token = "dev" if dev else (token or secrets.token_urlsafe(24))
        self.ui = ui_dir()
        self._server = None
        self._avatars: Dict[str, Tuple[bytes, str]] = {}

    @property
    def start_url(self) -> str:
        return f"http://{self.host}:{self.bound_port}/?t={self.token}"

    @property
    def bound_port(self) -> int:
        if self._server is not None:
            for sock in self._server.sockets:
                return sock.getsockname()[1]
        return self.port

    async def start(self) -> None:
        self._server = await serve(self._handle, self.host, self.port, process_request=self._process,
                                   max_size=1_000_000, server_header="lantern", compression=None)
        log.info("screen at http://%s:%s/ (UI %s)", self.host, self.bound_port, self.ui or "not built")

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    # -- requests --------------------------------------------------------------------------

    def _allowed(self, request: Request, query: Dict[str, Any]) -> bool:
        given = (query.get("t") or [""])[0]
        if given and secrets.compare_digest(given, self.token):
            return True
        cookie = http.cookies.SimpleCookie(request.headers.get("Cookie", ""))
        morsel = cookie.get(COOKIE)
        return bool(morsel and secrets.compare_digest(morsel.value, self.token))

    async def _process(self, connection: ServerConnection, request: Request) -> Optional[Response]:
        parts = urlsplit(request.path)
        path, query = unquote(parts.path), parse_qs(parts.query)
        if path == "/ws":
            if not self._allowed(request, query):
                return _plain(403, "This connection is only for the desk's own screen.")
            return None  # carry on with the WebSocket handshake
        try:
            if path.startswith("/assets/") or path in ("/favicon.ico", "/favicon.svg"):
                return self._static(path.lstrip("/"), immutable=path.startswith("/assets/"))
            if path in ("/", "/index.html"):
                if not self._allowed(request, query):
                    return _plain(403, "This page is only for the desk's own screen.")
                response = self._static("index.html", immutable=False)
                given = (query.get("t") or [""])[0]
                if given:
                    response.headers["Set-Cookie"] = f"{COOKIE}={self.token}; HttpOnly; SameSite=Strict; Path=/"
                return response
            if not self._allowed(request, query):
                return _plain(403, "Not for this page.")
            if path.startswith("/media/"):
                body, mime = await self.service.media_bytes(path[len("/media/"):])
                return _ranged(request, body, mime)
            if path == "/proxy/image":
                body, mime = await self.service.fetcher.image((query.get("url") or [""])[0])
                if mime == "image/svg+xml":
                    return _bytes(200, body, mime, cache="private, max-age=86400",
                                  extra={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})
                return _bytes(200, body, mime, cache="private, max-age=86400")
            if path.startswith("/avatar/"):
                return await self._avatar(path[len("/avatar/"):])
            if self.ui is not None and "." not in path.rsplit("/", 1)[-1]:
                return self._static("index.html", immutable=False)  # client-side routes
            return _plain(404, "Not found.")
        except LanternError as exc:
            return _plain(404 if "No such" in str(exc) else 502, str(exc))
        except (ConnectionError, OSError) as exc:
            return _plain(502, f"Could not fetch that: {exc}")

    async def _avatar(self, profile: str) -> Response:
        if not _PROFILE.match(profile):
            return _plain(404, "Not found.")
        if profile not in self._avatars:
            asset = await self.service.avatar(profile)
            if not asset:
                return _plain(404, "No avatar.")
            data_url = str(asset.get("data") or "")
            header, _, encoded = data_url.partition(",")
            mime = str(asset.get("mime") or header[5:].split(";")[0] or "image/png")
            self._avatars[profile] = (base64.b64decode(encoded), mime)
        body, mime = self._avatars[profile]
        return _bytes(200, body, mime, cache="private, max-age=600")

    def forget_avatars(self) -> None:
        self._avatars.clear()

    def _static(self, relative: str, immutable: bool) -> Response:
        if self.ui is None:
            return _plain(503, "The screen's UI has not been built. Run: cd ui && npm install && npm run build")
        target = (self.ui / relative).resolve()
        if self.ui.resolve() not in target.parents or not target.is_file():
            return _plain(404, "Not found.")
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js" or target.suffix == ".mjs":
            mime = "text/javascript"
        elif target.suffix == ".woff2":
            mime = "font/woff2"
        cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
        extra = {"Content-Security-Policy": CSP} if target.name == "index.html" else None
        return _bytes(200, target.read_bytes(), mime, cache=cache, extra=extra)

    # -- the WebSocket ---------------------------------------------------------------------

    async def _handle(self, connection: ServerConnection) -> None:
        await self.service.serve_screen(connection)


def _headers(mime: str, length: int, cache: str = "no-store", extra: Optional[Dict[str, str]] = None) -> Headers:
    headers = Headers()
    headers["Content-Type"] = mime + ("; charset=utf-8" if mime.startswith("text/") else "")
    headers["Content-Length"] = str(length)
    headers["Cache-Control"] = cache
    headers["X-Content-Type-Options"] = "nosniff"
    headers["Referrer-Policy"] = "no-referrer"
    headers["Connection"] = "close"
    for key, value in (extra or {}).items():
        headers[key] = value
    return headers


def _bytes(status: int, body: bytes, mime: str, cache: str = "no-store", extra: Optional[Dict[str, str]] = None) -> Response:
    reason = {200: "OK", 206: "Partial Content"}.get(status, "OK")
    return Response(status, reason, _headers(mime, len(body), cache, extra), body)


def _plain(status: int, text: str) -> Response:
    reasons = {403: "Forbidden", 404: "Not Found", 416: "Range Not Satisfiable", 502: "Bad Gateway", 503: "Service Unavailable"}
    body = (text + "\n").encode()
    return Response(status, reasons.get(status, "Error"), _headers("text/plain", len(body)), body)


def _ranged(request: Request, body: bytes, mime: str) -> Response:
    """Media with ``Range`` support, so an audio player can seek."""
    wanted = request.headers.get("Range", "")
    match = _RANGE.match(wanted.strip()) if wanted else None
    extra = {"Accept-Ranges": "bytes"}
    if not match or not (match.group(1) or match.group(2)):
        return _bytes(200, body, mime, cache="private, max-age=3600", extra=extra)
    size = len(body)
    if match.group(1):
        start = int(match.group(1))
        end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
    else:
        start, end = max(size - int(match.group(2)), 0), size - 1
    if start >= size or start > end:
        response = _plain(416, "Range not satisfiable.")
        response.headers["Content-Range"] = f"bytes */{size}"
        return response
    extra["Content-Range"] = f"bytes {start}-{end}/{size}"
    return _bytes(206, body[start:end + 1], mime, cache="private, max-age=3600", extra=extra)
