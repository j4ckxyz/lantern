"""The service end to end: the screen's WebSocket, the bridge's HTTP, and a fake Hermes."""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request

import pytest

from conftest import until


def _get(url: str, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def test_the_screen_gets_everything_in_hello(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            hello = (await screen.op("status"))["status"]
            assert hello["state"] == "ready" and hello["server"]["version"] == "0.22.5"
            assert [p["display_name"] for p in hello["profiles"]] == ["Hermes", "Sidequest Content"]
            assert hello["profiles"][0]["avatar"] == "/avatar/default"
            view = hello["view"]
            assert view["kind"] == "main" and view["session_id"] == "bot-1"
            assert [m["role"] for m in view["messages"]] == ["user", "assistant"]
            assert hello["account"] == {"username": "ada", "remembered": True}
    run(main())


def test_a_turn_streams_once_with_resent_chunks_dropped(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            start = len(screen.events)
            await screen.op("send", text="hello there friend")
            end = await screen.wait("turn.end", after=start)
            assert end["outcome"] == "success"
            final = screen.last("message")["message"]
            assert final["text"] == "You said: *hello there friend*. This is the **fake Hermes**, echoing."
            deltas = [e["text"] for e in screen.events[start:] if e["type"] == "turn.delta"]
            assert deltas[-1] == final["text"]
            assert all(b.startswith(a) for a, b in zip(deltas, deltas[1:]))  # cumulative, never repeating
            kinds = [e["type"] for e in screen.events[start:]]
            assert kinds.index("message") < kinds.index("turn.start") < kinds.index("turn.end")
    run(main())


def test_media_arrives_as_items_served_with_range(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            start = len(screen.events)
            await screen.op("send", text="media please")
            await screen.wait("turn.end", after=start)
            message = screen.last("message")["message"]
            assert [m["kind"] for m in message["media"]] == ["image", "audio", "file"]
            assert "MEDIA:/home" not in message["text"] and "`MEDIA:/not/a/delivery.png`" in message["text"]
            base = f"http://127.0.0.1:{service.bridge.bound_port}"
            loop = asyncio.get_running_loop()
            audio = message["media"][1]["url"]
            status, headers, body = await loop.run_in_executor(
                None, _get, f"{base}{audio}?t={service.bridge.token}", {"Range": "bytes=10-19"})
            assert status == 206 and len(body) == 10 and headers["Content-Range"].startswith("bytes 10-19/")
            status, _, _ = await loop.run_in_executor(None, _get, f"{base}{audio}")
            assert status == 403
            status, headers, body = await loop.run_in_executor(None, _get, f"{base}/avatar/default?t={service.bridge.token}")
            assert status == 200 and body.startswith(b"\x89PNG")
    run(main())


def test_new_chats_work_on_a_hermes_that_refuses_newer_keys(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            view = (await screen.op("chat.new"))["view"]
            assert view["kind"] == "session" and view["messages"] == []
            creates = [p for m, p in fake.rpc_log if m == "session.create"]
            assert "idempotency_key" in creates[0] and "idempotency_key" not in creates[-1]
            start = len(screen.events)
            await screen.op("send", text="plan my weekend")
            title = await screen.wait("title", after=start)
            assert title["title"] == "plan my weekend"
            sessions = (await screen.op("sessions.list", profile="default"))["sessions"]
            assert sessions[0]["title"] == "plan my weekend" and any(s["is_main"] for s in sessions)
            assert all(s["source"] != "cron" for s in sessions)
    run(main())


def test_approvals_offer_only_once_or_deny(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            start = len(screen.events)
            await screen.op("send", text="please approve this")
            prompt = (await screen.wait("prompt", after=start))["prompt"]
            assert prompt["command"] == "rm -rf ~/build/cache"
            assert [c["id"] for c in prompt["choices"]] == ["once", "deny"]
            refused = await screen.op("answer", id=prompt["id"], choice="always")
            assert not refused["ok"] and "once" in refused["error"]
            assert (await screen.op("answer", id=prompt["id"], choice="once"))["ok"]
            await screen.wait("turn.end", after=start)
            assert screen.last("message")["message"]["text"] == "You chose **once**."
    run(main())


def test_questions_are_asked_one_at_a_time(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            start = len(screen.events)
            await screen.op("send", text="ask me")
            first = (await screen.wait("prompt", after=start))["prompt"]
            assert first["text"] == "Tea or coffee?" and not first["free_text"]
            mark = len(screen.events)
            await screen.op("answer", id=first["id"], choice="Tea")
            second = (await screen.wait("prompt", after=mark))["prompt"]
            assert second["free_text"]
            await screen.op("answer", id=second["id"], text="A biscuit")
            await screen.wait("turn.end", after=start)
            assert '"q1": "Tea"' in screen.last("message")["message"]["text"]
    run(main())


def test_a_failed_turn_says_why(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            start = len(screen.events)
            await screen.op("send", text="error please")
            end = await screen.wait("turn.end", after=start)
            assert end["outcome"] == "failure" and "unavailable" in end["error"]
    run(main())


def test_activity_elsewhere_reloads_the_open_main_chat_or_asks_for_attention(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            start = len(screen.events)
            await fake.post_elsewhere("default", "From my phone", "Got it, from the phone.")
            view = (await screen.wait("view", after=start))["view"]
            assert view["messages"][-1]["text"] == "Got it, from the phone."
            await screen.op("chat.new")
            mark = len(screen.events)
            await fake.post_elsewhere("default", "Routine output", "The backup finished.")
            attention = await screen.wait("attention", after=mark)
            assert attention["profile"] == "default"
    run(main())


def test_older_messages_page_in(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            for i in range(130):
                fake._add("bot-1", "user" if i % 2 == 0 else "assistant", f"message {i}")
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            # The main chat may already be open from before the messages were added: leave and
            # come back, so it loads afresh.
            await screen.op("chat.new")
            view = (await screen.op("chat.open", profile="default"))["view"]
            assert len(view["messages"]) == 120 and view["has_more"]
            assert view["messages"][-1]["text"] == "message 129"
            older = await screen.op("history.more")
            assert len(older["messages"]) == 12 and not older["has_more"]
            assert older["messages"][-1]["text"] == "message 9"
    run(main())


def test_a_profile_without_a_main_chat_gets_one(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            view = (await screen.op("chat.open", profile="sidequest-content"))["view"]
            assert view["kind"] == "main" and fake.profiles["sidequest-content"]["main"] == view["session_id"]
            created = [p for m, p in fake.rpc_log if m == "session.create"][-1]
            assert created["title"] == "Bot Chat" and created["hidden"] is True
    run(main())


def test_compact_reloads_the_chat(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            for text in ("one", "two"):
                start = len(screen.events)
                await screen.op("send", text=text)
                await screen.wait("turn.end", after=start)
            mark = len(screen.events)
            assert (await screen.op("chat.compact"))["ok"]
            view = (await screen.wait("view", after=mark))["view"]
            assert view["messages"][0]["text"] == "Summary of the earlier conversation."
    run(main())


def test_reading_aloud_streams_pcm(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            start = len(screen.events)
            await screen.op("send", text="links please")
            await screen.wait("turn.end", after=start)
            message = screen.last("message")["message"]
            spoken = await screen.op("speak", message_id=message["id"])
            began = await screen.wait("speech.start", after=start)
            assert began["id"] == spoken["id"] and began["sample_rate"] == 24000
            end = await screen.wait("speech.end", after=start)
            assert end["reason"] == "done" and len(screen.binary) >= 1
            assert "https" not in fake.speech_texts[-1]
    run(main())


def test_signing_out_and_in_again(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            mark = len(screen.events)
            await screen.op("signout")
            await screen.wait("link", after=mark, where=lambda e: e["state"] == "signin")
            assert not json.loads((short_tmp / "credentials.json").read_text()).get("password")
            bad = await screen.op("signin", username="ada", password="wrong", remember=False)
            assert not bad["ok"] and "not right" in bad["error"]
            mark = len(screen.events)
            assert (await screen.op("signin", username="ada", password="pw", remember=False))["ok"]
            await screen.wait("link", after=mark, where=lambda e: e["state"] == "ready")
    run(main())


def test_a_dropped_connection_comes_back_by_itself(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            mark = len(screen.events)
            for ws in list(fake.connections):
                await ws.close()
            offline = await screen.wait("link", after=mark, where=lambda e: e["state"] == "offline")
            assert offline["error"] and "retry_in" in offline
            await screen.wait("link", after=mark, where=lambda e: e["state"] == "ready", timeout=15)
    run(main())


def test_settings_are_checked_and_kept(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            result = await screen.op("settings.set", changes={"text_size": "large", "brightness": 7, "bogus": 1,
                                                              "quiet_start": "25:00"})
            assert result["settings"]["text_size"] == "large" and result["settings"]["brightness"] == 1.0
            assert result["settings"]["quiet_start"] == "23:00"
            saved = json.loads((short_tmp / "settings.json").read_text())
            assert saved["text_size"] == "large" and "bogus" not in saved
    run(main())


def test_the_bridge_needs_its_token(run, short_tmp, desk_ctx):
    async def main():
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus

        async with desk_ctx(short_tmp) as (fake, service, screen):
            port = service.bridge.bound_port
            with pytest.raises(InvalidStatus):
                await connect(f"ws://127.0.0.1:{port}/ws?t=wrong")
            loop = asyncio.get_running_loop()
            status, _, _ = await loop.run_in_executor(None, _get, f"http://127.0.0.1:{port}/")
            assert status == 403
    run(main())


def test_the_heartbeat_pings_hermes(run, short_tmp, desk_ctx, monkeypatch):
    from lantern import dashboard

    monkeypatch.setattr(dashboard, "PING_EVERY_S", 0.2)

    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            await until(lambda: any(m == "gateway.ping" for m, _ in fake.rpc_log), 5, "a gateway.ping")
    run(main())


def test_opening_the_open_chat_keeps_it_and_a_send_waits_for_a_switch(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            resumes = sum(1 for m, _ in fake.rpc_log if m == "session.resume")
            await screen.op("chat.open", profile="default")
            assert sum(1 for m, _ in fake.rpc_log if m == "session.resume") == resumes  # nothing reopened
            # Switch chats and send at once: the message must land in the chat being opened.
            switching = asyncio.ensure_future(screen.op("chat.open", profile="default", session_id="disc-1"))
            await asyncio.sleep(0)
            start = len(screen.events)
            await screen.op("send", text="hello after switching")
            await switching
            await screen.wait("turn.end", after=start)
            assert fake.messages["disc-1"][-2]["content"] == "hello after switching"
    run(main())


def test_slash_commands_from_hermes(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            listed = await screen.op("commands.list")
            names = [c["name"] for c in listed["commands"]]
            assert names[0] == "/stop" and "/usage" in names and "/help" in names
            assert "/model" not in names and "/shell" not in names  # kept out of Hermes's own app menus too
            assert next(c for c in listed["commands"] if c["name"] == "/personality")["options"] == ["concise", "friendly", "formal"]
            assert "/new" not in names  # the simple desk keeps one conversation

            start = len(screen.events)
            result = await screen.op("command", text="/usage")
            assert result["ok"] and "1,234 tokens" in result["output"]
            card = await screen.wait("message", after=start, where=lambda e: e["message"].get("command"))
            assert card["message"]["command"] == "/usage" and "567 out" in card["message"]["text"]

            # A command that becomes a prompt: Hermes is sent the expansion, the screen shows the command.
            start = len(screen.events)
            await screen.op("command", text="/plan the move")
            mine = await screen.wait("message", after=start, where=lambda e: e["message"]["role"] == "user")
            assert mine["message"]["text"] == "/plan the move"
            await screen.wait("turn.end", after=start)
            submitted = [p["text"] for m, p in fake.rpc_log if m == "prompt.submit"]
            assert submitted[-1] == "Before acting, write a short plan for: the move"

            refused = await screen.op("command", text="/new")
            assert not refused["ok"] and "Profiles and side chats" in refused["error"]
            await screen.op("settings.set", changes={"conversations": True})
            assert "/new" in [c["name"] for c in (await screen.op("commands.list"))["commands"]]
            made = await screen.op("command", text="/new")
            assert made["ok"] and made["view"]["kind"] == "session"
    run(main())


def test_setup_check_finds_the_dashboard_and_repairs_the_address(run, short_tmp, desk_ctx):
    async def main():
        async with desk_ctx(short_tmp) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "ready")
            port = fake.port
            found = await screen.op("setup.check", url=f"  HTTP//127.0.0.1:{port}/sessions  ")
            assert found["url"] == f"http://127.0.0.1:{port}" and found["version"] == "0.22.5"
            assert found["insecure"] is False
            nothing = await screen.op("setup.check", url="127.0.0.1:9")
            assert nothing["url"] is None and nothing["tried"]
            bad = await screen.op("setup.check", url="https://ada:pw@example.com")
            assert not bad["ok"] and "Leave the username" in bad["error"]
    run(main())


def _post_form(url: str, fields):
    from urllib.parse import urlencode
    req = urllib.request.Request(url, data=urlencode(fields).encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def test_setting_up_from_a_phone(run, short_tmp, desk_ctx, monkeypatch):
    import socket as _socket
    with _socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setenv("LANTERN_PAIR_PORT", str(port))

    async def main():
        async with desk_ctx(short_tmp, signed_in=False) as (fake, service, screen):
            await screen.wait("link", where=lambda e: e["state"] == "signin")
            started = await screen.op("pair.start")
            pairing = started["pairing"]
            assert pairing["state"] == "waiting" and len(pairing["code"]) == 7 and "?k=" in pairing["url"]
            page = f"http://127.0.0.1:{port}/"
            loop = asyncio.get_running_loop()
            status, _headers, body = await loop.run_in_executor(None, _get, page + "?k=" + pairing["url"].split("?k=")[1])
            assert status == 200 and b'name="k"' in body and b"Set up your Lantern" in body

            # A wrong code is refused; the right one (typed, any case and spacing) signs the desk in.
            status, body = await loop.run_in_executor(None, _post_form, page, {
                "code": "ZZZ-ZZZ", "url": fake.base, "username": "ada", "password": "pw", "remember": "on"})
            assert status == 403 and "not the one on the desk" in body
            status, body = await loop.run_in_executor(None, _post_form, page, {
                "code": pairing["code"].lower().replace("-", " "), "url": fake.base, "username": "ada",
                "password": "pw", "remember": "on"})
            assert status == 200 and "The desk is signed in" in body
            await screen.wait("link", where=lambda e: e["state"] == "ready", timeout=20)
            done = await screen.wait("pair", where=lambda e: e["pairing"]["state"] == "done")
            assert done
            # The page is gone.
            await asyncio.sleep(0.2)
            with pytest.raises(OSError):
                await loop.run_in_executor(None, _get, page)
    run(main())
