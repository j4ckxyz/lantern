"""A stand-in for a Hermes dashboard, for tests and for building the desk without a Hermes.

    lantern fakehermes --port 9119        # then: lantern setup http://127.0.0.1:9119 (user ada, password pw)

It speaks the parts of Hermes's dashboard API the desk uses, on one port like the real thing:
native sign-in (PKCE), bearer tokens and their refresh, ``/api/ws`` with ``gateway.ready``
(heartbeat on), strict parameter checking (an undeclared key is refused the way Hermes 0.22.5
refuses it), profiles with a main chat, history, file downloads and streaming speech.

Replies are scripted by words in the message:

    slow    statuses and two tools over a few seconds      media   a picture, an audio clip and a file
    links   a reply with links                             voice   a spoken reply ([[audio_as_voice]])
    approve an approval request                            ask     a question with choices, then one without
    error   a failed turn                                  long    a long reply: headings, a table, code
    reasoning  thinks for a while before answering

Anything else is echoed with a little Markdown. Needs ``aiohttp`` (in the ``dev`` extra).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import math
import struct
import time
import uuid
import wave
import zlib
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

PLAIN_PARAMS: Dict[str, set] = {
    "client.capabilities": {"server_requests", "desktop_local"},
    "gateway.ping": set(),
    "profiles.list": set(),
    "profiles.get_asset": {"profile", "name", "asset"},
    "session.list": {"profile", "limit", "offset", "include_hidden", "title", "source"},
    "session.create": {"profile", "cols", "source", "cwd", "cwd_explicit", "messages", "parent_session_id", "title",
                       "model", "provider", "reasoning_effort", "fast", "service_tier", "close_on_disconnect",
                       "hidden", "room_plumbing", "follow_profile_config"},
    "session.resume": {"session_id", "profile", "cols", "source", "lazy", "defer_history", "omit_messages",
                       "eager_build", "close_on_disconnect", "inline_images"},
    "session.close": {"session_id", "profile"},
    "session.interrupt": {"session_id", "profile"},
    "session.compress": {"session_id", "profile", "focus_topic"},
    "session.delete": {"session_id", "profile"},
    "prompt.submit": {"session_id", "profile", "text", "surface"},
}

LONG_REPLY = """## Your week at a glance

Three things stand out, in order of urgency:

1. **Parents' evening** on Tuesday at 18:00. You said you would bring the reading log.
2. The *quarterly VAT return* is due on the 7th.
3. Your train to London on Friday leaves at 07:42 from Manchester Piccadilly.

| Day | Event | Time |
|---|---|---|
| Tue | Parents' evening | 18:00 |
| Thu | Dentist | 09:15 |
| Fri | Ferry to Poole | 07:42 |

Here is the script that pulls the calendar, if you want to run it yourself:

```python
from datetime import date, timedelta

def this_week(events):
    start = date.today()
    end = start + timedelta(days=7)
    return [e for e in events if start <= e.day < end]
```

And the same in shell:

```bash
curl -s https://calendar.example.com/feed.ics | grep -E '^(SUMMARY|DTSTART)'
```

> Tip: say "remind me the day before" and I will set reminders for each of these.

That is everything for now. Inline code like `this_week()` stays readable too."""


def png(width: int, height: int, colour: tuple, accent: tuple) -> bytes:
    """A small generated PNG: a soft diagonal gradient, so pictures in tests are real images."""
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            t = (x + y) / (width + height)
            row += bytes(int(colour[i] * (1 - t) + accent[i] * t) for i in range(3))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


def tone_pcm(seconds: float, rate: int = 24000, freq: float = 220.0) -> bytes:
    """A gentle tone with a fade, standing in for speech."""
    count = int(seconds * rate)
    out = bytearray()
    for i in range(count):
        fade = min(1.0, i / (rate * 0.05), (count - i) / (rate * 0.05))
        value = 0.25 * fade * (math.sin(2 * math.pi * freq * i / rate) + 0.3 * math.sin(2 * math.pi * freq * 1.5 * i / rate))
        out += struct.pack("<h", int(max(-1, min(1, value)) * 32767))
    return bytes(out)


def wav(pcm: bytes, rate: int = 24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class FakeHermes:
    def __init__(self, username: str = "ada", password: str = "pw", host: str = "127.0.0.1", port: int = 0,
                 word_delay: float = 0.02, version: str = "0.22.5"):
        self.username, self.password = username, password
        self.host, self.port = host, port
        self.word_delay = word_delay
        self.version = version
        self.home = "/home/hermes/.hermes"
        self.tokens: Dict[str, Dict[str, Any]] = {}   # access token -> {refresh, expires_at}
        self.refresh_tokens: Dict[str, str] = {}      # refresh -> access
        self.codes: Dict[str, str] = {}               # code -> challenge
        self.pkce: Dict[str, str] = {}                # pkce cookie -> challenge
        self.tickets: set = set()
        self.token_ttl = 12 * 3600
        self.rpc_log: List[tuple] = []
        self.connections: list = []
        self.sockets_by_session: Dict[str, Any] = {}
        self.live: Dict[str, Dict[str, str]] = {}     # runtime id -> {stored, profile}
        self.speech_texts: List[str] = []
        self.interrupted: set = set()
        now = time.time()
        self.profiles: Dict[str, Dict[str, Any]] = {
            "default": {"name": "default", "display_name": None, "is_default": True, "has_avatar": True, "main": "bot-1"},
            "sidequest-content": {"name": "sidequest-content", "display_name": None, "is_default": False,
                                  "has_avatar": False, "main": None},
        }
        self.sessions: Dict[str, Dict[str, Any]] = {
            "bot-1": {"id": "bot-1", "profile": "default", "source": "gui", "title": "Bot Chat", "hidden": True,
                      "started_at": now - 86400 * 30, "last_active": now - 3600},
            "disc-1": {"id": "disc-1", "profile": "default", "source": "discord", "title": "Trip planning",
                       "started_at": now - 86400 * 2, "last_active": now - 86400},
            "cron-1": {"id": "cron-1", "profile": "default", "source": "cron", "title": "Nightly backup",
                       "started_at": now - 7200, "last_active": now - 7000},
        }
        self.messages: Dict[str, List[Dict[str, Any]]] = {"bot-1": [], "disc-1": [], "cron-1": []}
        self._row = 0
        self._add("bot-1", "user", "Morning. Anything I should know about today?", now - 3700)
        self._add("bot-1", "assistant", "Good morning. Two things: the **parents' evening** is at 18:00, and it "
                  "looks like rain after 3pm, so take a coat.", now - 3690)
        self._add("disc-1", "user", "Find me a ferry to Poole on Friday", now - 86400 * 2)
        self._add("disc-1", "assistant", "There is one at 07:42, arriving 11:00.", now - 86400 * 2 + 5)
        self._add("cron-1", "assistant", "Backup finished.", now - 7000)
        self.files: Dict[str, bytes] = {
            f"{self.home}/cache/images/garden.png": png(320, 200, (38, 70, 120), (120, 180, 120)),
            f"{self.home}/cache/audio/tts_reply.wav": wav(tone_pcm(2.5)),
            f"{self.home}/cache/documents/report.pdf": b"%PDF-1.4\n% a stand-in report\n",
        }
        self.avatar = png(96, 96, (110, 40, 60), (200, 120, 140))
        self._runner = None

    # -- helpers ----------------------------------------------------------------------------

    def _add(self, stored: str, role: str, content: str, ts: Optional[float] = None, **extra: Any) -> Dict[str, Any]:
        self._row += 1
        row = {"id": self._row, "role": role, "content": content, "timestamp": ts or time.time(), **extra}
        self.messages.setdefault(stored, []).append(row)
        self.sessions[stored]["last_active"] = row["timestamp"]
        return row

    @property
    def base(self) -> str:
        return f"http://{self.host}:{self.port}"

    def expire_tokens(self) -> None:
        """What a 30-day-unused session looks like: every token is refused."""
        self.tokens.clear()
        self.refresh_tokens.clear()

    async def post_elsewhere(self, profile: str, text: str, reply: str) -> None:
        """Your phone (or a routine) adding to a profile's main chat while the desk watches."""
        stored = self.profiles[profile]["main"]
        self._add(stored, "user", text)
        self._add(stored, "assistant", reply)
        for ws in list(self.connections):
            await self._event(ws, "sessions.changed", {})

    def _canonical(self, name: str) -> Dict[str, Any]:
        main = self.profiles[name]["main"]
        if not main:
            return {"id": None, "resolved_id": None, "title": None, "source": None, "message_count": None, "last_active": None}
        row = self.sessions[main]
        return {"id": main, "resolved_id": main, "title": "Bot Chat", "source": None,
                "message_count": len(self.messages.get(main, [])), "last_active": row["last_active"]}

    # -- serving ----------------------------------------------------------------------------

    async def start(self) -> None:
        from aiohttp import web

        app = web.Application(client_max_size=64 * 1024 * 1024)
        app.router.add_get("/api/status", self._status)
        app.router.add_get("/auth/native/authorize", self._authorize)
        app.router.add_post("/auth/password-login", self._password_login)
        app.router.add_post("/auth/native/token", self._token)
        app.router.add_post("/auth/native/refresh", self._refresh)
        app.router.add_post("/api/auth/ws-ticket", self._ws_ticket)
        app.router.add_get("/api/ws", self._ws)
        app.router.add_get("/api/audio/speak-stream", self._speak_stream)
        app.router.add_post("/api/audio/speak", self._speak)
        app.router.add_get("/api/sessions", self._sessions)
        app.router.add_get("/api/sessions/search", self._search)
        app.router.add_get("/api/sessions/{sid}", self._session)
        app.router.add_get("/api/sessions/{sid}/messages", self._messages)
        app.router.add_get("/api/files/download", self._download)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]

    async def stop(self) -> None:
        for ws in list(self.connections):
            await ws.close()
        if self._runner is not None:
            await self._runner.cleanup()

    def _bearer(self, request) -> bool:
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        entry = self.tokens.get(token)
        return bool(entry and entry["expires_at"] > time.time())

    def _deny(self):
        from aiohttp import web

        return web.json_response({"detail": "Unauthorized"}, status=401)

    async def _status(self, request):
        from aiohttp import web

        return web.json_response({"version": self.version, "release_date": "2026.9.24", "auth_required": True,
                                  "auth_providers": ["basic"], "auth_flows": ["cookie", "native_pkce"]})

    async def _authorize(self, request):
        from aiohttp import web

        q = request.query
        if q.get("code_challenge_method") != "S256" or not q.get("code_challenge"):
            return web.json_response({"detail": "bad request"}, status=400)
        cookie = uuid.uuid4().hex
        self.pkce[cookie] = json.dumps({"challenge": q["code_challenge"], "redirect": q.get("redirect_uri"),
                                        "state": q.get("state")})
        response = web.Response(status=302, headers={"Location": "/login"})
        response.set_cookie("hermes_session_pkce", cookie, httponly=True)
        return response

    async def _password_login(self, request):
        from aiohttp import web

        body = await request.json()
        if body.get("username") != self.username or body.get("password") != self.password:
            return web.json_response({"detail": "Invalid credentials"}, status=401)
        pending = self.pkce.pop(request.cookies.get("hermes_session_pkce", ""), None)
        if pending is None:
            return web.json_response({"ok": True, "next": "/"})
        info = json.loads(pending)
        code = uuid.uuid4().hex
        self.codes[code] = info["challenge"]
        return web.json_response({"ok": True, "next": f"{info['redirect']}?{urlencode({'code': code, 'state': info['state']})}"})

    def _issue(self) -> Dict[str, Any]:
        access, refresh = "at-" + uuid.uuid4().hex, "rt-" + uuid.uuid4().hex
        expires = time.time() + self.token_ttl
        self.tokens[access] = {"refresh": refresh, "expires_at": expires}
        self.refresh_tokens[refresh] = access
        return {"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_at": int(expires),
                "provider": "basic", "user_id": "basic:" + self.username}

    async def _token(self, request):
        from aiohttp import web

        body = await request.json()
        challenge = self.codes.pop(str(body.get("code") or ""), None)
        digest = base64.urlsafe_b64encode(hashlib.sha256(str(body.get("code_verifier") or "").encode()).digest()).rstrip(b"=").decode()
        if challenge is None or digest != challenge:
            return web.json_response({"detail": "invalid_grant"}, status=400)
        return web.json_response(self._issue())

    async def _refresh(self, request):
        from aiohttp import web

        body = await request.json()
        old_access = self.refresh_tokens.pop(str(body.get("refresh_token") or ""), None)
        if old_access is None:
            return web.json_response({"detail": "session_expired"}, status=401)
        self.tokens.pop(old_access, None)
        return web.json_response(self._issue())

    async def _ws_ticket(self, request):
        from aiohttp import web

        if not self._bearer(request):
            return self._deny()
        ticket = uuid.uuid4().hex
        self.tickets.add(ticket)
        return web.json_response({"ticket": ticket, "ttl_seconds": 30})

    async def _sessions(self, request):
        from aiohttp import web

        if not self._bearer(request):
            return self._deny()
        q = request.query
        profile = q.get("profile") or "default"
        excluded = (q.get("exclude_sources") or "").split(",")
        rows = [dict(r, message_count=len(self.messages.get(r["id"], [])),
                     preview=next((m["content"][:80] for m in self.messages.get(r["id"], []) if m["role"] == "user"), ""))
                for r in self.sessions.values() if r["profile"] == profile and r["source"] not in excluded]
        rows = [r for r in rows if r["message_count"] >= int(q.get("min_messages") or 0)]
        rows.sort(key=lambda r: -r["last_active"])
        start = int(q.get("offset") or 0)
        return web.json_response({"sessions": rows[start:start + int(q.get("limit") or 20)], "total": len(rows)})

    async def _search(self, request):
        from aiohttp import web

        if not self._bearer(request):
            return self._deny()
        needle = (request.query.get("q") or "").lower()
        hits = [{"session_id": sid, "title": self.sessions[sid]["title"], "source": self.sessions[sid]["source"],
                 "snippet": m["content"][:120], "last_active": self.sessions[sid]["last_active"]}
                for sid, rows in self.messages.items() for m in rows if needle in m["content"].lower()]
        return web.json_response({"results": hits})

    async def _session(self, request):
        from aiohttp import web

        if not self._bearer(request):
            return self._deny()
        row = self.sessions.get(request.match_info["sid"])
        if row is None:
            return web.json_response({"detail": "Session not found"}, status=404)
        return web.json_response(row)

    async def _messages(self, request):
        from aiohttp import web

        if not self._bearer(request):
            return self._deny()
        sid = request.match_info["sid"]
        if sid not in self.sessions:
            return web.json_response({"detail": "Session not found"}, status=404)
        q = request.query
        rows = self.messages.get(sid, [])
        limit, offset = int(q.get("limit") or 500), int(q.get("offset") or 0)
        if q.get("order") == "latest":
            end = max(len(rows) - offset, 0)
            page = rows[max(end - limit, 0):end]
        else:
            page = rows[offset:offset + limit]
        return web.json_response({"session_id": sid, "messages": page,
                                  "pagination": {"limit": limit, "offset": offset, "returned": len(page)}})

    async def _download(self, request):
        from aiohttp import web

        if not self._bearer(request):
            return self._deny()
        path = request.query.get("path", "")
        if path not in self.files:
            return web.json_response({"detail": "File not found"}, status=404)
        import mimetypes

        return web.Response(body=self.files[path], content_type=mimetypes.guess_type(path)[0] or "application/octet-stream")

    async def _speak(self, request):
        from aiohttp import web

        if not self._bearer(request):
            return self._deny()
        body = await request.json()
        self.speech_texts.append(body.get("text") or "")
        data = wav(tone_pcm(1.0))
        return web.json_response({"ok": True, "data_url": "data:audio/wav;base64," + base64.b64encode(data).decode(),
                                  "mime_type": "audio/wav", "provider": "fake"})

    async def _speak_stream(self, request):
        from aiohttp import web

        if request.query.get("ticket") not in self.tickets:
            return web.Response(status=401)
        self.tickets.discard(request.query["ticket"])
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        text = ""
        async for msg in ws:
            frame = json.loads(msg.data)
            if "text" in frame:
                text += frame["text"]
            if frame.get("done"):
                break
            if frame.get("stop"):
                await ws.close()
                return ws
        self.speech_texts.append(text)
        await ws.send_str(json.dumps({"type": "start", "sample_rate": 24000}))
        sentences = [s for s in text.replace("!", ".").replace("?", ".").split(".") if s.strip()] or [text]
        for i, _ in enumerate(sentences[:6]):
            await ws.send_bytes(tone_pcm(0.6, freq=200 + 30 * i))
            await asyncio.sleep(0.05)
        await ws.send_str(json.dumps({"type": "end"}))
        await ws.close()
        return ws

    # -- /api/ws ------------------------------------------------------------------------------

    async def _ws(self, request):
        from aiohttp import web, WSMsgType

        if request.query.get("ticket") not in self.tickets:
            return web.Response(status=401)
        self.tickets.discard(request.query["ticket"])
        ws = web.WebSocketResponse(max_msg_size=32 * 1024 * 1024)
        await ws.prepare(request)
        self.connections.append(ws)
        answers: Dict[str, asyncio.Future] = {}
        ws._lantern_answers = answers  # type: ignore[attr-defined]
        await self._event(ws, "gateway.ready", {"skin": {}, "change_events": True, "heartbeat": True, "replay_epoch": "fake"})
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                frame = json.loads(msg.data)
                if "method" not in frame:
                    waiter = answers.pop(str(frame.get("id")), None)
                    if waiter and not waiter.done():
                        waiter.set_result(frame)
                    continue
                asyncio.ensure_future(self._dispatch(ws, frame))
        finally:
            self.connections.remove(ws)
        return ws

    async def _dispatch(self, ws, frame: Dict[str, Any]) -> None:
        method, params = frame["method"], frame.get("params") or {}
        self.rpc_log.append((method, params))
        allowed = PLAIN_PARAMS.get(method)
        if allowed is None:
            reply = {"error": {"code": -32601, "message": f"method not found: {method}"}}
        else:
            extra = sorted(set(params) - allowed)
            if extra:
                reply = {"error": {"code": 4000, "message": f"invalid params for {method}: {extra[0]}: Extra inputs are "
                                   "not permitted - the client and the Hermes backend are out of sync"}}
            else:
                try:
                    reply = {"result": await self._method(ws, method, params)}
                except LookupError as exc:
                    reply = {"error": {"code": 4007, "message": str(exc)}}
        await ws.send_str(json.dumps({"jsonrpc": "2.0", "id": frame["id"], **reply}))

    async def _event(self, ws, kind: str, payload: Any, session_id: Optional[str] = None) -> None:
        params: Dict[str, Any] = {"type": kind, "payload": payload}
        if session_id:
            params["session_id"] = session_id
        if not ws.closed:
            await ws.send_str(json.dumps({"jsonrpc": "2.0", "method": "event", "params": params}))

    async def _method(self, ws, method: str, p: Dict[str, Any]) -> Dict[str, Any]:
        if method == "client.capabilities":
            return {"server_requests": ["approval", "clarify"]}
        if method == "gateway.ping":
            return {"ok": True}
        if method == "profiles.list":
            return {"bot_mode_protocol": True, "install_id": "fake", "profiles": [
                {"name": n, "display_name": pr["display_name"], "is_default": pr["is_default"], "has_avatar": pr["has_avatar"],
                 "canonical_session": self._canonical(n)} for n, pr in self.profiles.items()]}
        if method == "profiles.get_asset":
            if p.get("name") == "default":
                return {"found": True, "mime": "image/png", "size": len(self.avatar),
                        "data": "data:image/png;base64," + base64.b64encode(self.avatar).decode()}
            return {"found": False}
        if method == "session.list":
            profile = p.get("profile") or "default"
            rows = [dict(r, resolved_id=r["id"]) for r in self.sessions.values() if r["profile"] == profile
                    and (not p.get("title") or r["title"] == p["title"])]
            return {"sessions": rows}
        if method == "session.create":
            profile = p.get("profile") or "default"
            stored = f"s-{uuid.uuid4().hex[:6]}"
            self.sessions[stored] = {"id": stored, "profile": profile, "source": p.get("source") or "tui",
                                     "title": p.get("title") or "", "hidden": bool(p.get("hidden")),
                                     "started_at": time.time(), "last_active": time.time()}
            self.messages[stored] = []
            if p.get("title") == "Bot Chat":
                self.profiles[profile]["main"] = stored
            runtime = "r-" + uuid.uuid4().hex[:8]
            self.live[runtime] = {"stored": stored, "profile": profile}
            self.sockets_by_session[runtime] = ws
            return {"session_id": runtime, "stored_session_id": stored, "message_count": 0, "messages": [], "info": {}}
        if method == "session.resume":
            stored = p["session_id"]
            if stored not in self.sessions:
                raise LookupError("session not found")
            runtime = "r-" + uuid.uuid4().hex[:8]
            self.live[runtime] = {"stored": stored, "profile": self.sessions[stored]["profile"]}
            self.sockets_by_session[runtime] = ws
            return {"session_id": runtime, "stored_session_id": stored,
                    "message_count": len(self.messages.get(stored, [])), "messages": [], "info": {}}
        if method == "session.close":
            self.live.pop(p["session_id"], None)
            return {"closed": True}
        if method == "session.interrupt":
            self.interrupted.add(p["session_id"])
            return {"status": "interrupted"}
        if method == "session.delete":
            if p["session_id"] not in self.sessions:
                raise LookupError("session not found")
            self.sessions.pop(p["session_id"])
            self.messages.pop(p["session_id"], None)
            return {"deleted": p["session_id"]}
        if method == "session.compress":
            live = self.live.get(p["session_id"])
            if live is None:
                raise LookupError("session not found")
            rows = self.messages[live["stored"]]
            removed = max(len(rows) - 2, 0)
            summary = {"id": 0, "role": "assistant", "content": "Summary of the earlier conversation.", "timestamp": time.time()}
            self.messages[live["stored"]] = [summary] + rows[-2:]
            return {"status": "compressed", "removed": removed, "compressed": True}
        if method == "prompt.submit":
            live = self.live.get(p["session_id"])
            if live is None:
                raise LookupError("session not found")
            asyncio.ensure_future(self._turn(ws, p["session_id"], live["stored"], str(p.get("text") or "")))
            return {"status": "streaming"}
        raise LookupError(method)

    async def _ask(self, ws, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        frame_id = "srq-" + uuid.uuid4().hex[:6]
        future = asyncio.get_running_loop().create_future()
        ws._lantern_answers[frame_id] = future
        await ws.send_str(json.dumps({"jsonrpc": "2.0", "id": frame_id, "method": method, "params": params}))
        reply = await asyncio.wait_for(future, 120)
        return reply.get("result") or {}

    async def _stream(self, ws, runtime: str, text: str, turn_id: str, segment: int = 0, repeat_one: bool = True) -> None:
        offset = 0
        words = [w + " " for w in text.split(" ")]
        words[-1] = words[-1][:-1]
        for i, word in enumerate(words):
            if runtime in self.interrupted:
                return
            payload = {"text": word, "turn_id": turn_id, "segment": segment, "offset": offset}
            await self._event(ws, "message.delta", payload, runtime)
            if repeat_one and i == 2:
                await self._event(ws, "message.delta", payload, runtime)  # a re-sent chunk a client must drop
            offset += len(word.encode("utf-16-le")) // 2
            await asyncio.sleep(self.word_delay)

    async def _turn(self, ws, runtime: str, stored: str, text: str) -> None:
        self._add(stored, "user", text)
        low = text.lower()
        turn_id = uuid.uuid4().hex[:8]
        self.interrupted.discard(runtime)
        await self._event(ws, "message.start", {"turn_id": turn_id}, runtime)
        status = "complete"
        if "reasoning" in low:
            for chunk in ("Let me think", " about the", " best answer."):
                await self._event(ws, "reasoning.delta", {"text": chunk}, runtime)
                await asyncio.sleep(0.4)
        if "slow" in low:
            await self._event(ws, "status.update", {"kind": "status", "text": "Planning"}, runtime)
            await asyncio.sleep(0.8)
            for tool_id, name, ctx in (("t1", "web_search", "weather in Manchester"), ("t2", "read_file", "notes/plans.md")):
                await self._event(ws, "tool.start", {"tool_id": tool_id, "name": name, "context": ctx}, runtime)
                for step in range(1, 4):
                    await asyncio.sleep(0.4)
                    await self._event(ws, "tool.progress", {"tool_id": tool_id, "name": name, "progress": step, "total": 3}, runtime)
                await self._event(ws, "tool.complete", {"tool_id": tool_id, "name": name, "duration_s": 1.2}, runtime)
        if "approve" in low:
            answer = await self._ask(ws, "approval", {"request_id": "ap-1", "command": "rm -rf ~/build/cache",
                                                      "description": "Delete the build cache to free 2 GB",
                                                      "choices": ["once", "session", "always", "deny"], "session_id": runtime})
            reply = f"You chose **{answer.get('choice')}**."
        elif "ask" in low:
            answer = await self._ask(ws, "clarify", {"session_id": runtime, "questions": [
                {"qid": "q1", "question": "Tea or coffee?", "choices": ["Tea", "Coffee"]},
                {"qid": "q2", "question": "Anything to go with it?"}]})
            reply = "Noted: " + json.dumps(answer.get("answers"), sort_keys=True)
        elif "error" in low:
            await self._stream(ws, runtime, "Let me try that", turn_id, repeat_one=False)
            await self._event(ws, "message.complete", {"text": "", "status": "error",
                                                       "error": "The model provider is unavailable right now."}, runtime)
            return
        elif "media" in low:
            reply = (f"Here is the garden plan, the recording and the report.\n\nMEDIA:{self.home}/cache/images/garden.png\n"
                     f"MEDIA:{self.home}/cache/audio/tts_reply.wav\n**MEDIA:{self.home}/cache/documents/report.pdf**\n\n"
                     "An example that must stay text: `MEDIA:/not/a/delivery.png`")
        elif "voice" in low:
            reply = f"[[audio_as_voice]]\nMEDIA:{self.home}/cache/audio/tts_reply.wav"
        elif "links" in low:
            reply = ("Two good reads: [the Touch Display 2 page](https://www.raspberrypi.com/products/touch-display-2/) "
                     "and https://www.gov.je/Travel/ for ferry times.")
        elif "long" in low:
            reply = LONG_REPLY
        else:
            reply = f"You said: *{text}*. This is the **fake Hermes**, echoing."
        if "slow" in low:
            await self._event(ws, "message.interim", {"text": "I found the forecast; putting it together now.",
                                                      "already_streamed": False}, runtime)
        await self._stream(ws, runtime, reply, turn_id)
        if runtime in self.interrupted:
            status = "interrupted"
        self._add(stored, "assistant", reply)
        if self.sessions[stored]["title"] in ("",):
            self.sessions[stored]["title"] = text[:40]
            await self._event(ws, "session.title", {"session_id": stored, "title": text[:40]})
        await self._event(ws, "message.complete", {"text": reply, "status": status}, runtime)
        for other in list(self.connections):
            await self._event(other, "sessions.changed", {})


async def serve_forever(host: str = "127.0.0.1", port: int = 9119) -> None:
    fake = FakeHermes(host=host, port=port, word_delay=0.05)
    await fake.start()
    print(f"fake Hermes at {fake.base}  (username {fake.username}, password {fake.password})", flush=True)
    await asyncio.Event().wait()
