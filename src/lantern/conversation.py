"""The desk's model of what is on screen: profiles, the open chat, the turn being written.

It turns Hermes's events into the small vocabulary of ``docs/local-api.md`` and keeps enough state
that a screen which connects late (or reloads) gets everything in one ``hello``.

Chats follow Hermes's official apps (Bot Mode): every profile has one main chat, its canonical
"Bot Chat", shared with the phone and desktop apps; side chats are ordinary sessions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import config, media as media_mod
from .dashboard import Hermes, RpcError
from .errors import LanternError

log = logging.getLogger("lantern.conversation")

PAGE = 120  # stored rows per page; tool calls are rows too, so a page shows fewer messages
_ATTACHED_CONTEXT = "\n\n--- Attached Context ---"
_DEFAULT_NAME = "Hermes"


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _utf16_suffix(text: str, skip_units: int) -> str:
    """``text`` without its first ``skip_units`` UTF-16 code units."""
    if skip_units <= 0:
        return text
    encoded = text.encode("utf-16-le")
    return encoded[skip_units * 2:].decode("utf-16-le", "ignore")


def _tool_label(name: str, payload: Dict[str, Any]) -> str:
    label = name.replace("_", " ").replace(".", " ").strip().capitalize() or "Working"
    hint = str(payload.get("context") or payload.get("preview") or "").strip().splitlines()
    return f"{label}: {hint[0][:60]}" if hint and hint[0] else label


class Conversation:
    def __init__(self, home: Path, emit: Callable[[Dict[str, Any]], None]):
        self.home = home
        self.emit = emit
        self.hermes: Optional[Hermes] = None
        self.media = media_mod.Registry()
        self.profiles: List[Dict[str, Any]] = []
        self.view: Dict[str, Any] = self._empty_view("default")
        self.sid = ""          # the open chat's runtime (live) session id
        self.turn: Optional[Dict[str, Any]] = None
        self.prompt: Optional[Dict[str, Any]] = None
        self._loaded = 0       # how many stored messages of the open chat are on screen
        self._own_turn = False
        self._quiet_until = 0.0
        self._mains: Dict[str, float] = {}  # profile -> last_active of its main chat, for "attention"
        self._refresh_task: Optional[asyncio.Task] = None
        self._open_lock = asyncio.Lock()
        self.on_reply: Optional[Callable[[Dict[str, Any]], None]] = None
        self._commands: Dict[str, List[Dict[str, Any]]] = {}
        saved = config.read_json(home / "state.json", {}) or {}
        if isinstance(saved.get("view"), dict):
            self.view.update({k: saved["view"].get(k) for k in ("profile", "session_id", "kind", "title") if saved["view"].get(k)})

    # -- the shapes the screen sees -----------------------------------------------------

    def _empty_view(self, profile: str) -> Dict[str, Any]:
        return {"profile": profile, "session_id": "", "kind": "main", "title": "", "messages": [], "has_more": False}

    def public_view(self) -> Dict[str, Any]:
        return dict(self.view)

    def public_turn(self) -> Optional[Dict[str, Any]]:
        if not self.turn:
            return None
        t = self.turn
        return {"id": t["id"], "started": t["started"], "text": media_mod.displayable(t["raw"]),
                "status": t["status"], "tools": list(t["tools"].values())}

    def public_prompt(self) -> Optional[Dict[str, Any]]:
        if not self.prompt:
            return None
        return {k: v for k, v in self.prompt.items() if not k.startswith("_")}

    def _save_state(self) -> None:
        try:
            self.home.mkdir(parents=True, exist_ok=True)
            config.write_private(self.home / "state.json", json.dumps({"view": {
                k: self.view.get(k) for k in ("profile", "session_id", "kind", "title")}}) + "\n")
        except OSError:
            pass

    def _profile_row(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        name = str(raw.get("name"))
        main = raw.get("canonical_session") if isinstance(raw.get("canonical_session"), dict) else {}
        main_id = main.get("resolved_id") or main.get("id")
        display = raw.get("display_name") or (_DEFAULT_NAME if raw.get("is_default") else name.replace("-", " ").title())
        return {
            "name": name, "display_name": str(display), "is_default": bool(raw.get("is_default")),
            "avatar": f"/avatar/{name}" if raw.get("has_avatar") else None,
            "main": {"id": str(main_id), "preview": str(main.get("preview") or ""),
                     "last_active": main.get("last_active"), "message_count": main.get("message_count") or 0}
            if main_id else None,
        }

    def message_from_row(self, profile: str, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        role = row.get("role")
        if role not in ("user", "assistant") or row.get("display_kind") == "hidden":
            return None
        content = row.get("display_content")
        if not isinstance(content, str):
            content = row.get("content")
        if not isinstance(content, str) or not content.strip():
            return None
        found: List[Any] = []
        text = content.split(_ATTACHED_CONTEXT, 1)[0].strip()
        if role == "assistant":
            found, text = media_mod.extract(text)
        message: Dict[str, Any] = {"id": f"m{row.get('id') or uuid.uuid4().hex[:12]}", "role": role, "text": text,
                                   "ts": float(row.get("timestamp") or 0), "media": [self.media.add(profile, p, v) for p, v in found]}
        if any(v for _, v in found):
            message["voice"] = True
        return message if text or message["media"] else None

    # -- opening chats --------------------------------------------------------------------

    async def start(self, hermes: Hermes, settings: Dict[str, Any]) -> None:
        """After connecting: the profiles, then the chat that was open (or the default main chat)."""
        self.hermes = hermes
        self.media.base = hermes.base
        self.sid, self.turn, self.prompt = "", None, None
        await self.refresh_profiles(announce=False)
        names = [p["name"] for p in self.profiles]
        profile = self.view.get("profile")
        if profile not in names:
            wanted = settings.get("default_profile")
            profile = wanted if wanted in names else next((p["name"] for p in self.profiles if p["is_default"]),
                                                          names[0] if names else "default")
        stored = self.view.get("session_id") if self.view.get("profile") == profile else ""
        if not settings.get("conversations"):
            # The simple desk is always the main chat of the default profile.
            wanted = settings.get("default_profile")
            profile = wanted if wanted in names else next((p["name"] for p in self.profiles if p["is_default"]), profile)
            stored = ""
        try:
            await self.open(profile, stored or None, kind=(self.view.get("kind") or "main") if stored else "main")
        except RpcError as exc:
            log.info("could not reopen %s (%s); opening the main chat", stored, exc)
            await self.open(profile, None)

    async def refresh_profiles(self, announce: bool = True) -> None:
        assert self.hermes is not None
        rows = [self._profile_row(p) for p in await self.hermes.profiles()]
        rows.sort(key=lambda p: (not p["is_default"], p["display_name"].lower()))
        for p in rows:
            last = float((p["main"] or {}).get("last_active") or 0)
            before = self._mains.get(p["name"])
            self._mains[p["name"]] = last
            if (announce and before is not None and last > before + 0.5 and p["main"]
                    and not (self.view["profile"] == p["name"] and self.view["kind"] == "main")):
                self.emit({"type": "attention", "profile": p["name"], "session_id": p["main"]["id"],
                           "preview": p["main"]["preview"]})
        changed = rows != self.profiles
        self.profiles = rows
        if changed and announce:
            self.emit({"type": "profiles", "profiles": rows})

    def _main_id(self, profile: str) -> str:
        row = next((p for p in self.profiles if p["name"] == profile), None)
        return str(row["main"]["id"]) if row and row.get("main") else ""

    async def open(self, profile: str, stored_id: Optional[str] = None, kind: str = "") -> Dict[str, Any]:
        assert self.hermes is not None
        async with self._open_lock:
            main_id = self._main_id(profile) or ""
            wanted = stored_id or main_id
            if self.sid and wanted and profile == self.view["profile"] and wanted == self.view["session_id"]:
                return self.public_view()  # already open and live: nothing to do, and a running turn carries on
            await self._leave()
            if not stored_id:
                stored_id = main_id or await self.hermes.find_main(profile)
                kind = "main"
                if not stored_id:
                    created = await self.hermes.create(profile, main=True)
                    stored_id = str(created.get("stored_session_id") or "")
                    self.sid = str(created.get("session_id") or "")
            else:
                kind = "main" if stored_id == main_id or kind == "main" and not main_id else "session"
            if not self.sid:
                resumed = await self.hermes.resume(profile, stored_id)
                self.sid = str(resumed.get("session_id") or "")
                stored_id = str(resumed.get("stored_session_id") or stored_id)
            title = ""
            if kind == "session":
                title = await self._title_of(profile, stored_id)
            self.view = {"profile": profile, "session_id": stored_id, "kind": kind, "title": title,
                         "messages": [], "has_more": False}
            await self._load_latest()
            self._save_state()
            self.emit({"type": "view", "view": self.public_view()})
            return self.public_view()

    async def _title_of(self, profile: str, stored_id: str) -> str:
        try:
            meta = await self.hermes.http.get(f"/api/sessions/{stored_id}?profile={profile}")  # type: ignore[union-attr]
        except (LanternError, ConnectionError):
            return ""
        meta = meta.get("session") if isinstance(meta.get("session"), dict) else meta
        return str(meta.get("title") or "")

    async def _load_latest(self) -> None:
        rows = await self.hermes.messages(self.view["profile"], self.view["session_id"], limit=PAGE)  # type: ignore[union-attr]
        self._loaded = len(rows)
        self.view["messages"] = [m for m in (self.message_from_row(self.view["profile"], r) for r in rows) if m]
        self.view["has_more"] = len(rows) >= PAGE

    async def _leave(self) -> None:
        if self.sid and self.hermes is not None:
            await self.hermes.leave(self.view["profile"], self.sid)
        self.sid, self.turn, self._own_turn = "", None, False
        if self.prompt:
            self.emit({"type": "prompt.close", "id": self.prompt["id"]})
            self.prompt = None

    async def new_chat(self, profile: Optional[str] = None) -> Dict[str, Any]:
        assert self.hermes is not None
        profile = profile or self.view["profile"]
        async with self._open_lock:
            await self._leave()
            created = await self.hermes.create(profile, main=False)
            self.sid = str(created.get("session_id") or "")
            self.view = {"profile": profile, "session_id": str(created.get("stored_session_id") or ""),
                         "kind": "session", "title": "", "messages": [], "has_more": False}
            self._loaded = 0
            self._save_state()
            self.emit({"type": "view", "view": self.public_view()})
            return self.public_view()

    async def compact(self) -> None:
        assert self.hermes is not None
        if self.turn:
            raise LanternError("Wait for Hermes to finish, then compact.")
        if not self.sid:
            raise LanternError("Open a chat first.")
        self.emit({"type": "notice", "text": "Compacting this chat…", "level": "info", "ttl_s": 4})
        result = await self.hermes.compact(self.view["profile"], self.sid)
        if result.get("compressed") is False or result.get("status") == "aborted":
            raise LanternError(str(result.get("message") or "Hermes could not compact this chat right now."))
        await self._load_latest()
        self.emit({"type": "view", "view": self.public_view()})
        self.emit({"type": "notice", "text": "Chat compacted. Hermes keeps a summary of what came before.",
                   "level": "info", "ttl_s": 6})

    async def more(self) -> Dict[str, Any]:
        assert self.hermes is not None
        rows = await self.hermes.messages(self.view["profile"], self.view["session_id"], limit=PAGE, offset=self._loaded)
        self._loaded += len(rows)
        older = [m for m in (self.message_from_row(self.view["profile"], r) for r in rows) if m]
        known = {m["id"] for m in self.view["messages"]}
        older = [m for m in older if m["id"] not in known]
        self.view["messages"] = older + self.view["messages"]
        self.view["has_more"] = len(rows) >= PAGE
        return {"messages": older, "has_more": self.view["has_more"]}

    async def sessions(self, profile: str, query: str = "", limit: int = 30, offset: int = 0) -> List[Dict[str, Any]]:
        assert self.hermes is not None
        rows = await self.hermes.sessions(profile, query, limit, offset)
        main_id = self._main_id(profile)
        out = []
        for r in rows:
            sid = str(r.get("resolved_id") or r.get("id") or "")
            if not sid:
                continue
            preview = str(r.get("preview") or "").split(_ATTACHED_CONTEXT, 1)[0]
            title = str(r.get("title") or "") or " ".join(preview.split())[:60] or "Untitled chat"
            is_main = sid == main_id or str(r.get("id")) == main_id or title == "Bot Chat"
            out.append({"id": sid, "title": "Main chat" if is_main else title, "preview": " ".join(preview.split())[:160],
                        "source": str(r.get("source") or ""), "last_active": r.get("last_active") or r.get("started_at"),
                        "message_count": r.get("message_count") or 0, "is_main": is_main})
        return out

    # -- talking ----------------------------------------------------------------------------

    async def send(self, text: str, display: str = "") -> str:
        """Send a message in the open chat. ``display`` is what the screen shows when it differs from
        what Hermes is sent (a command that expands into a longer prompt)."""
        assert self.hermes is not None
        text = (text or "").strip()
        if not text:
            raise LanternError("Nothing to send.")
        async with self._open_lock:
            pass  # a chat being opened finishes first, so the message lands in it
        if self.turn:
            raise LanternError("Hermes is still answering. Stop it or wait a moment.")
        if not self.sid:
            await self.open(self.view["profile"], self.view.get("session_id") or None, kind=self.view.get("kind", "main"))
        message = {"id": f"u{uuid.uuid4().hex[:12]}", "role": "user", "text": display or text, "ts": time.time(), "media": []}
        self._own_turn = True
        self.view["messages"].append(message)
        self.emit({"type": "message", "message": message})
        try:
            await self.hermes.submit(self.view["profile"], self.sid, text)
        except Exception as exc:
            self._own_turn = False
            message["error"] = str(exc) or "Not sent."
            self.emit({"type": "message", "message": message})
            raise
        self._loaded += 1
        return message["id"]

    # -- slash commands -------------------------------------------------------------------

    async def commands(self) -> List[Dict[str, Any]]:
        """The commands this profile offers a screen like this one, cached until skills change."""
        assert self.hermes is not None
        profile = self.view["profile"]
        if profile in self._commands:
            return self._commands[profile]
        catalog = await self.hermes.commands(profile, self.sid)
        meta = catalog.get("commands") if isinstance(catalog.get("commands"), dict) else {}
        sub = catalog.get("sub") if isinstance(catalog.get("sub"), dict) else {}
        rows: List[Dict[str, Any]] = []
        seen = set()
        for pair in catalog.get("pairs") or []:
            if not (isinstance(pair, list) and pair and isinstance(pair[0], str)):
                continue
            name = "/" + pair[0].lstrip("/")
            info = meta.get(name) if isinstance(meta.get(name), dict) else {}
            if info.get("desktop") or name in seen:
                continue  # hidden, terminal-only or settings-only in Hermes's own apps
            seen.add(name)
            options = [o for o in sub.get(name) or [] if isinstance(o, str)]
            rows.append({"name": name, "description": str(pair[1] if len(pair) > 1 else ""),
                         "args": info.get("argument_mode") or ("options" if options else None),
                         **({"options": options[:24]} if options else {})})
        self._commands[profile] = rows
        return rows

    async def run_command(self, text: str) -> Dict[str, Any]:
        """Run a Hermes slash command in the open chat. Output arrives as a ``message`` with
        ``command`` set; a command that expands into a prompt is sent as a turn."""
        assert self.hermes is not None
        async with self._open_lock:
            pass
        if not self.sid:
            await self.open(self.view["profile"], self.view.get("session_id") or None, kind=self.view.get("kind", "main"))
        text = text.strip()
        result = await self.hermes.run_command(self.view["profile"], self.sid, text)
        if result.get("type") == "alias" and result.get("target"):
            arg = text.partition(" ")[2]
            text = "/" + str(result["target"]).lstrip("/") + (" " + arg if arg else "")
            result = await self.hermes.run_command(self.view["profile"], self.sid, text)
        kind = result.get("type")
        if kind in ("send", "skill") and result.get("message"):
            await self.send(str(result["message"]), display=str(result.get("display") or text))
            return {"sent": True}
        if kind == "prefill":
            return {"prefill": str(result.get("message") or ""), "notice": str(result.get("notice") or "")}
        output = str(result.get("output") or result.get("notice") or result.get("warning") or "").strip()
        message = {"id": f"k{uuid.uuid4().hex[:12]}", "role": "assistant", "text": output or "Done.",
                   "ts": time.time(), "media": [], "command": text.split(" ", 1)[0]}
        self.view["messages"].append(message)
        self.emit({"type": "message", "message": message})
        return {"output": output}

    async def stop(self) -> None:
        if self.hermes is not None and self.sid:
            await self.hermes.interrupt(self.view["profile"], self.sid)

    async def answer(self, prompt_id: str, choice: Optional[str], text: Optional[str]) -> None:
        prompt = self.prompt
        if prompt is None or prompt["id"] != prompt_id or self.hermes is None:
            raise LanternError("That question has already been answered.")
        if prompt["kind"] == "approval":
            if choice not in ("once", "deny"):
                raise LanternError("From the desk you can allow a command once, or deny it.")
            self.prompt = None
            await self.hermes.answer_approval(self.view["profile"], self.sid, prompt["_request"], prompt["_prompt"], choice,
                                              prompt.get("_generation"))
        else:
            answer = (text if text is not None else choice) or ""
            questions = prompt.get("_questions") or []
            if questions:
                prompt["_answers"][prompt["_qid"]] = answer
                pending = [q for q in questions if q["qid"] not in prompt["_answers"]]
                if pending:
                    self._show_clarify(prompt, pending[0])
                    return
                self.prompt = None
                await self.hermes.answer_clarify(self.view["profile"], self.sid, prompt["_request"], prompt["_prompt"],
                                                 prompt["_answers"], prompt.get("_generation"))
            else:
                self.prompt = None
                await self.hermes.answer_clarify(self.view["profile"], self.sid, prompt["_request"], prompt["_prompt"], answer,
                                                 prompt.get("_generation"))
        self.emit({"type": "prompt.close", "id": prompt_id})

    # -- what Hermes says -----------------------------------------------------------------

    def connection_lost(self) -> None:
        self.sid = ""
        if self.turn:
            self.turn = None
            self.emit({"type": "turn.end", "outcome": "failure", "error": "The connection to Hermes dropped."})
        if self.prompt:
            self.emit({"type": "prompt.close", "id": self.prompt["id"]})
            self.prompt = None

    def _activity(self) -> None:
        if self.turn:
            self.emit({"type": "turn.activity", "status": self.turn["status"], "tools": list(self.turn["tools"].values())})

    def _begin(self, turn_id: str) -> Dict[str, Any]:
        self.turn = {"id": turn_id or uuid.uuid4().hex[:12], "started": time.time(), "raw": "", "applied": {},
                     "status": "", "tools": {}, "media": []}
        self.emit({"type": "turn.start", "turn": self.public_turn()})
        return self.turn

    async def on_event(self, kind: str, sid: str, payload: Dict[str, Any]) -> None:
        if kind == "skills.changed":
            self._commands.clear()  # new skills are new commands
            return
        if kind in ("sessions.changed", "session.list.changed"):
            self._schedule_refresh()
            return
        if kind == "session.reclaimed":
            if payload.get("session_id") == self.sid or payload.get("stored_session_id") == self.view["session_id"]:
                log.info("Hermes reclaimed the open chat (%s); resuming", payload.get("reason"))
                self.sid = ""
                if self.hermes is not None:
                    resumed = await self.hermes.resume(self.view["profile"], self.view["session_id"])
                    self.sid = str(resumed.get("session_id") or "")
            return
        if sid and sid != self.sid:
            return  # another chat on the same connection
        turn = self.turn
        if kind == "message.start":
            self._begin(str(payload.get("turn_id") or ""))
        elif kind == "message.delta":
            text = payload.get("text")
            if not isinstance(text, str) or not text:
                return
            turn = turn or self._begin(str(payload.get("turn_id") or ""))
            offset = payload.get("offset")
            if isinstance(offset, int):
                segment = payload.get("segment") or 0
                applied = turn["applied"].get(segment, 0)
                if offset + _utf16_len(text) <= applied:
                    return  # already shown
                text = _utf16_suffix(text, applied - offset) if offset < applied else text
                turn["applied"][segment] = max(applied, offset) + _utf16_len(text)
            turn["raw"] += text
            if turn["status"] == "Thinking":
                turn["status"] = ""
                self._activity()
            self.emit({"type": "turn.delta", "text": media_mod.displayable(turn["raw"])})
        elif kind in ("reasoning.delta", "thinking.delta", "reasoning.available", "tool.generating"):
            # Hermes is thinking (or writing a tool call). The reasoning and the spinner's own words
            # are never shown; the screen animates instead.
            if kind == "thinking.delta" and not str(payload.get("text") or ""):
                return
            if turn and not turn["raw"] and turn["status"] != "Thinking":
                turn["status"] = "Thinking"
                self._activity()
        elif kind == "tool.start":
            turn = turn or self._begin("")
            tool_id = str(payload.get("tool_id") or uuid.uuid4().hex[:8])
            name = str(payload.get("name") or "tool")
            turn["tools"][tool_id] = {"id": tool_id, "name": name, "label": _tool_label(name, payload), "state": "running"}
            turn["status"] = ""
            self._activity()
        elif kind == "tool.progress" and turn:
            tool = turn["tools"].get(str(payload.get("tool_id")))
            if tool is not None:
                total = payload.get("total")
                if isinstance(payload.get("percent"), (int, float)):
                    tool["progress"] = max(0.0, min(1.0, payload["percent"] / 100))
                elif isinstance(total, (int, float)) and total:
                    tool["progress"] = max(0.0, min(1.0, float(payload.get("progress") or 0) / total))
                self._activity()
        elif kind == "tool.complete" and turn:
            tool = turn["tools"].get(str(payload.get("tool_id")))
            if tool is not None:
                tool["state"] = "failed" if payload.get("error") else "done"
                if isinstance(payload.get("duration_s"), (int, float)):
                    tool["duration_s"] = round(payload["duration_s"], 1)
            if payload.get("image_path"):
                turn["media"].append(self.media.add(self.view["profile"], str(payload["image_path"])))
            self._activity()
        elif kind == "status.update":
            if payload.get("kind") in ("heartbeat",):
                return
            turn = turn or (self._begin("") if payload.get("text") else None)
            if turn:
                turn["status"] = str(payload.get("text") or "")[:120]
                self._activity()
        elif kind == "message.interim":
            text = str(payload.get("text") or "").strip()
            if text:
                found, cleaned = media_mod.extract(text)
                message = {"id": f"i{uuid.uuid4().hex[:12]}", "role": "assistant", "text": cleaned, "ts": time.time(),
                           "media": [self.media.add(self.view["profile"], p, v) for p, v in found], "interim": True}
                self.view["messages"].append(message)
                self.emit({"type": "message", "message": message})
            if turn:
                turn["raw"], turn["applied"] = "", {}
                self.emit({"type": "turn.delta", "text": ""})
        elif kind == "message.complete":
            await self._complete(payload)
        elif kind == "session.title":
            if payload.get("session_id") in (self.view["session_id"], self.sid) and self.view["kind"] == "session":
                self.view["title"] = str(payload.get("title") or "")
                self._save_state()
                self.emit({"type": "title", "session_id": self.view["session_id"], "title": self.view["title"]})
        elif kind == "error":
            self.emit({"type": "notice", "text": str(payload.get("message") or "Something went wrong."),
                       "level": "error", "ttl_s": 12})
            if turn:
                self.turn = None
                self.emit({"type": "turn.end", "outcome": "failure", "error": str(payload.get("message") or "")})
        elif kind in ("notice", "notification.show"):
            text = str(payload.get("text") or payload.get("message") or "").strip()
            if text:
                ttl = payload.get("ttl_ms")
                level = str(payload.get("level") or "info")
                self.emit({"type": "notice", "text": text[:300], "level": level if level in ("info", "warning", "error") else "info",
                           "ttl_s": (ttl / 1000) if isinstance(ttl, (int, float)) and ttl else 8})
        elif kind in ("request.cancel", "approval.cancelled", "approval.settled", "clarify.settled"):
            # Cancelled, or answered somewhere else (the phone, the computer): the card goes away.
            ids = {str(payload.get(k) or "") for k in ("id", "prompt_id", "request_id")} | {
                str(i) for i in payload.get("request_ids") or []}
            ids.discard("")
            wanted = "approval" if kind.startswith("approval") else "clarify" if kind.startswith("clarify") else ""
            if self.prompt and (self.prompt["_request"] in ids or self.prompt["_prompt"] in ids
                                or (wanted and not ids and self.prompt["kind"] == wanted)
                                or (kind == "approval.cancelled" and self.prompt["kind"] == "approval")):
                self.emit({"type": "prompt.close", "id": self.prompt["id"]})
                self.prompt = None
        elif kind == "approval.request":
            self._show_approval("", str(payload.get("prompt_id") or ""), payload)
        elif kind == "clarify.request":
            self._show_question("", str(payload.get("prompt_id") or ""), payload)

    async def _complete(self, payload: Dict[str, Any]) -> None:
        turn = self.turn or self._begin("")
        text = payload.get("text") if isinstance(payload.get("text"), str) else turn["raw"]
        surface = payload.get("error_surface") if isinstance(payload.get("error_surface"), dict) else {}
        error = str(payload.get("error") or payload.get("failure_reason") or surface.get("message") or "")
        outcome = "failure" if error or payload.get("status") == "error" else \
            "cancelled" if payload.get("status") == "interrupted" else "success"
        found, cleaned = media_mod.extract(text or "")
        items = turn["media"] + [self.media.add(self.view["profile"], p, v) for p, v in found]
        own = self._own_turn
        self.turn, self._own_turn = None, False
        if own:
            self._quiet_until = time.time() + 6  # the change notice for our own turn is not news
        last = self.view["messages"][-1] if self.view["messages"] else None
        if payload.get("response_reused") and last and last.get("interim") and last.get("text") == cleaned and not items:
            cleaned = ""  # already on screen as the interim message: Hermes only re-sent it
        if cleaned or items:
            message = {"id": f"a{turn['id']}", "role": "assistant", "text": cleaned, "ts": time.time(), "media": items}
            if any(m.get("voice") for m in items):
                message["voice"] = True
            if payload.get("partial") or outcome == "cancelled":
                message["interim"] = False
            self.view["messages"].append(message)
            self._loaded += 1
            self.emit({"type": "message", "message": message})
            if outcome == "success" and self.on_reply:
                self.on_reply(message)
        self.emit({"type": "turn.end", "outcome": outcome, **({"error": error} if error else {})})
        if not own:
            # Someone else's turn (the phone, a routine): the stored transcript has their message too.
            self._schedule_refresh(reload_view=True)

    def _schedule_refresh(self, reload_view: bool = False) -> None:
        if self._refresh_task and not self._refresh_task.done():
            self._refresh_task.cancel()
        self._refresh_task = asyncio.ensure_future(self._refresh_later(reload_view))

    async def _refresh_later(self, reload_view: bool) -> None:
        await asyncio.sleep(0.8)  # a burst of changes becomes one refresh
        try:
            before = self._mains.get(self.view["profile"])
            await self.refresh_profiles()
            mine = self._mains.get(self.view["profile"])
            changed_here = (self.view["kind"] == "main" and before is not None and mine is not None
                            and mine > before + 0.5 and time.time() > self._quiet_until)
            if (reload_view or changed_here) and not self.turn and self.hermes is not None:
                before_ids = [m["id"] for m in self.view["messages"]]
                await self._load_latest()
                if [m["id"] for m in self.view["messages"]] != before_ids:
                    self.emit({"type": "view", "view": self.public_view()})
        except (LanternError, ConnectionError) as exc:
            log.debug("refresh after a change failed: %s", exc)

    # -- questions from Hermes ------------------------------------------------------------

    async def on_request(self, request_id: str, method: str, params: Dict[str, Any]) -> None:
        if method == "approval":
            self._show_approval(request_id, str(params.get("request_id") or ""), params)
        elif method == "clarify":
            self._show_question(request_id, str(params.get("request_id") or ""), params)
        elif self.hermes is not None:
            await self.hermes.gateway.respond(request_id, error={"code": -32601, "message": f"the desk cannot answer {method}"})

    def _show_approval(self, request_id: str, prompt_id: str, params: Dict[str, Any]) -> None:
        command = str(params.get("command") or "").strip()
        description = str(params.get("description") or "").strip()
        self.prompt = {"id": request_id or prompt_id or uuid.uuid4().hex[:10], "kind": "approval",
                       "title": "Allow this command?", "text": description, "command": command,
                       "choices": [{"id": "once", "label": "Allow once"}, {"id": "deny", "label": "Deny"}],
                       "free_text": False, "_request": request_id, "_prompt": prompt_id,
                       "_generation": params.get("execution_generation")}
        self.emit({"type": "prompt", "prompt": self.public_prompt()})

    def _show_question(self, request_id: str, prompt_id: str, params: Dict[str, Any]) -> None:
        questions = [q for q in params.get("questions") or [] if isinstance(q, dict) and q.get("qid")]
        base = {"id": request_id or prompt_id or uuid.uuid4().hex[:10], "kind": "clarify", "title": "Hermes asks",
                "_request": request_id, "_prompt": prompt_id, "_questions": questions, "_answers": {},
                "_generation": params.get("execution_generation")}
        if questions:
            self._show_clarify(base, questions[0])
            return
        choices = [c for c in params.get("choices") or [] if isinstance(c, str)]
        base.update(text=str(params.get("question") or params.get("text") or ""),
                    choices=[{"id": c, "label": c} for c in choices], free_text=True)
        self.prompt = base
        self.emit({"type": "prompt", "prompt": self.public_prompt()})

    def _show_clarify(self, prompt: Dict[str, Any], question: Dict[str, Any]) -> None:
        choices = [c for c in question.get("choices") or [] if isinstance(c, str)]
        prompt.update(text=str(question.get("question") or ""), choices=[{"id": c, "label": c} for c in choices],
                      free_text=not choices, _qid=question["qid"])
        self.prompt = prompt
        self.emit({"type": "prompt", "prompt": self.public_prompt()})
