"""Signing in to Hermes the way its native apps do, and staying signed in.

The Hermes dashboard offers native clients an RFC 8252 flow (PKCE, S256) that ends in bearer
tokens: ``/auth/native/authorize`` → ``/auth/password-login`` → ``/auth/native/token``, then
``Authorization: Bearer`` on every request and ``/auth/native/refresh`` to rotate the pair. The
desk runs these steps itself; no browser and no loopback listener are involved (the
``redirect_uri`` is only echoed back).

What is kept (``credentials.json``, mode 0600, readable only by the service's account): the access
and refresh tokens and, when the owner chose "remember", the password, used only to sign in again
by itself when the refresh token is refused. A password Hermes rejects is deleted at once.

A dashboard bound to loopback has no accounts; it puts a session token in its page instead,
which is read on every connect.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlsplit

from . import config
from .errors import LanternError, NeedsSignIn

log = logging.getLogger("lantern.auth")

REFRESH_EARLY_S = 120
_TOKEN_RE = re.compile(r'__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"')
_REDIRECT = "http://127.0.0.1:53682/callback"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any):  # a redirect to /login means "sign in", not "follow"
        return None


class Response:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status: int, headers: Mapping[str, str], body: bytes):
        self.status, self.headers, self.body = status, headers, body

    def json(self) -> Any:
        try:
            return json.loads(self.body) if self.body else {}
        except ValueError:
            return None

    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def detail(self) -> str:
        data = self.json()
        if isinstance(data, dict) and data.get("detail"):
            detail = data["detail"]
            return detail if isinstance(detail, str) else json.dumps(detail)[:200]
        return self.text()[:200]


def _fetch(url: str, method: str, data: Optional[bytes], headers: Dict[str, str], timeout: float,
           max_bytes: int) -> Response:
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        status = getattr(response, "status", None) or response.getcode()
        body = response.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise LanternError(f"Hermes sent more than {max_bytes // 1_000_000} MB, which is more than this device takes.")
        return Response(status, response.headers, body)


class Http:
    """A small HTTP client for one Hermes: JSON in and out, bearer auth, a 401 refreshes once."""

    def __init__(self, base: str, auth: "Auth"):
        self.base = base
        self.auth = auth

    async def raw(self, method: str, path: str, *, body: Any = None, headers: Optional[Dict[str, str]] = None,
                  timeout: float = 30, max_bytes: int = 32_000_000, signed: bool = True) -> Response:
        data = None
        sent = {"Accept": "application/json", "User-Agent": "lantern-desk"}
        if body is not None:
            data = json.dumps(body).encode()
            sent["Content-Type"] = "application/json"
        sent.update(headers or {})
        for attempt in (0, 1):
            if signed:
                sent.update(await self.auth.headers())
            response = await _run(_fetch, self.base + path, method, data, dict(sent), timeout, max_bytes)
            if response.status == 401 and signed and attempt == 0 and await self.auth.recover():
                continue
            return response
        return response

    async def get(self, path: str, timeout: float = 30) -> Any:
        return self.checked(await self.raw("GET", path, timeout=timeout), path)

    async def post(self, path: str, body: Any, timeout: float = 30) -> Any:
        return self.checked(await self.raw("POST", path, body=body, timeout=timeout), path)

    @staticmethod
    def checked(response: Response, path: str) -> Any:
        if response.status in (401, 403):
            raise NeedsSignIn("Hermes wants you to sign in again.")
        if response.status >= 400:
            raise LanternError(response.detail() or f"Hermes answered {response.status} for {path}.")
        return response.json()


async def _run(fn, *args):
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, fn, *args)
    except LanternError:
        raise
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        raise ConnectionError(f"cannot reach Hermes: {reason}") from None


class Auth:
    """The signed-in session with one Hermes, kept fresh."""

    def __init__(self, base: str, store: Path):
        self.base = base
        self._store = store
        self._lock = asyncio.Lock()
        self.page_token = ""  # loopback dashboards: no accounts, a token in the page instead
        self.open_dashboard = False
        saved = config.read_json(store, {}) or {}
        self.creds: Dict[str, Any] = saved if saved.get("base") == base else {}

    # -- what the rest of the service asks ------------------------------------------------

    @property
    def signed_in(self) -> bool:
        return bool(self.creds.get("refresh_token") or self.creds.get("access_token"))

    @property
    def username(self) -> str:
        return str(self.creds.get("username") or "")

    @property
    def remembered(self) -> bool:
        return bool(self.creds.get("password"))

    async def headers(self) -> Dict[str, str]:
        if self.open_dashboard:
            return {"X-Hermes-Session-Token": self.page_token} if self.page_token else {}
        if not self.signed_in:
            return {}
        if float(self.creds.get("expires_at") or 0) - time.time() < REFRESH_EARLY_S:
            await self.recover(expired=True)
        token = self.creds.get("access_token")
        return {"Authorization": f"Bearer {token}"} if token else {}

    async def recover(self, expired: bool = False) -> bool:
        """After a 401 (or before expiry): refresh, else sign in again with a saved password.

        Returns whether there is now a session worth retrying with. Raises ``NeedsSignIn`` when
        only the person can help.
        """
        if self.open_dashboard:
            return await self.read_page_token()
        stale = self.creds.get("access_token")
        async with self._lock:
            if self.creds.get("access_token") != stale:
                return True  # another caller refreshed while this one waited
            if not expired and not self.signed_in:
                return False
            if self.creds.get("refresh_token") and await self._refresh():
                return True
            password = self.creds.get("password")
            if password:
                try:
                    await self._password_flow(self.username, password, remember=True)
                    log.info("signed in again with the saved password")
                    return True
                except NeedsSignIn:
                    raise
                except LanternError as exc:
                    log.info("could not sign in again by itself: %s", exc)
                    return False
            self._forget(keep_username=True)
            raise NeedsSignIn("Your Hermes sign-in has expired. Sign in again to carry on.")

    # -- signing in ---------------------------------------------------------------------

    async def sign_in(self, username: str, password: str, remember: bool) -> None:
        username = (username or "").strip()
        if not username or not password:
            raise LanternError("Enter your Hermes username and password.")
        async with self._lock:
            await self._password_flow(username, password, remember)

    def sign_out(self) -> None:
        self._forget(keep_username=True)

    async def read_page_token(self) -> bool:
        response = await _run(_fetch, self.base + "/", "GET", None, {"Accept": "text/html"}, 15, 4_000_000)
        match = _TOKEN_RE.search(response.text()) if response.status == 200 else None
        self.page_token = match.group(1) if match else ""
        return bool(self.page_token)

    async def _password_flow(self, username: str, password: str, remember: bool) -> None:
        status = await self._public_json("/api/status")
        providers = [p for p in (status.get("auth_providers") or []) if isinstance(p, str)]
        provider = "basic" if "basic" in providers or not providers else providers[0]
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(12)
        authorize = await _run(_fetch, self.base + "/auth/native/authorize?" + urlencode({
            "provider": provider, "code_challenge": challenge, "code_challenge_method": "S256",
            "redirect_uri": _REDIRECT, "state": state}), "GET", None, {"Accept": "application/json"}, 20, 1_000_000)
        cookies = _cookies(authorize.headers)
        if authorize.status >= 400 or not cookies:
            raise LanternError("This Hermes does not offer the sign-in native apps use. Update Hermes and try again.")
        login = await _run(_fetch, self.base + "/auth/password-login", "POST",
                           json.dumps({"provider": provider, "username": username, "password": password}).encode(),
                           {"Accept": "application/json", "Content-Type": "application/json",
                            "Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items())}, 20, 1_000_000)
        if login.status == 401:
            if self.creds.get("password"):
                self.creds.pop("password", None)  # never retry a password Hermes refused
                self._save()
            raise NeedsSignIn("That username or password is not right.")
        if login.status == 429:
            raise LanternError("Too many attempts. Wait a minute and try again.")
        if login.status >= 400:
            raise LanternError(f"Hermes would not sign in: {login.detail() or login.status}")
        query = parse_qs(urlsplit(str((login.json() or {}).get("next") or "")).query)
        code = (query.get("code") or [""])[0]
        if not code or (query.get("state") or [""])[0] != state:
            raise LanternError("Hermes did not finish signing in. Try again.")
        tokens = await _run(_fetch, self.base + "/auth/native/token", "POST",
                            json.dumps({"code": code, "code_verifier": verifier}).encode(),
                            {"Accept": "application/json", "Content-Type": "application/json"}, 20, 1_000_000)
        if tokens.status >= 400:
            raise LanternError(f"Hermes did not hand over a session: {tokens.detail() or tokens.status}")
        self._take(tokens.json() or {}, username, password if remember else None)

    async def _refresh(self) -> bool:
        response = await _run(_fetch, self.base + "/auth/native/refresh", "POST",
                              json.dumps({"refresh_token": self.creds.get("refresh_token"),
                                          "provider": self.creds.get("provider") or "basic"}).encode(),
                              {"Accept": "application/json", "Content-Type": "application/json"}, 20, 1_000_000)
        if response.status != 200:
            log.info("token refresh refused (%s)", response.status)
            return False
        self._take(response.json() or {}, self.username, self.creds.get("password"))
        return True

    async def _public_json(self, path: str) -> Dict[str, Any]:
        response = await _run(_fetch, self.base + path, "GET", None, {"Accept": "application/json"}, 15, 2_000_000)
        data = response.json()
        if response.status != 200 or not isinstance(data, dict):
            raise LanternError(f"{self.base} does not look like a Hermes dashboard.")
        return data

    def _take(self, tokens: Dict[str, Any], username: str, password: Optional[str]) -> None:
        if not tokens.get("access_token"):
            raise LanternError("Hermes answered without a session.")
        self.creds = {
            "base": self.base, "username": username, "provider": tokens.get("provider") or "basic",
            "user_id": tokens.get("user_id"), "access_token": tokens["access_token"],
            "refresh_token": tokens.get("refresh_token") or self.creds.get("refresh_token"),
            "expires_at": float(tokens.get("expires_at") or time.time() + 3600),
        }
        if password:
            self.creds["password"] = password
        self._save()

    def _forget(self, keep_username: bool) -> None:
        name = self.username if keep_username else ""
        self.creds = {"base": self.base, "username": name} if name else {}
        self._save()

    def _save(self) -> None:
        self._store.parent.mkdir(parents=True, exist_ok=True)
        config.write_private(self._store, json.dumps(self.creds) + "\n")


def _cookies(headers: Mapping[str, str]) -> Dict[str, str]:
    from http.cookies import SimpleCookie

    jar: Dict[str, str] = {}
    getter = getattr(headers, "get_all", None)
    for header in (getter("Set-Cookie") if getter else None) or []:
        for name, morsel in SimpleCookie(header).items():
            if morsel.value:
                jar[name] = morsel.value
    return jar


def split_url(base: str) -> Tuple[str, str]:
    parts = urlsplit(base)
    return ("wss" if parts.scheme == "https" else "ws"), parts.netloc + parts.path
