"""The ``lantern`` command."""

from __future__ import annotations

import argparse
from pathlib import Path
import asyncio
import getpass
import json
import logging
import os
import shutil
import sys
from typing import List, Optional

from . import __version__, config
from .client import connect
from .errors import LanternError


def say(text: str = "") -> None:
    print(text, flush=True)


def fail(text: str) -> int:
    print(f"lantern: {text}", file=sys.stderr, flush=True)
    return 1


def _service_running() -> bool:
    try:
        connect(timeout=3).close()
        return True
    except LanternError:
        return False


def cmd_run(args: argparse.Namespace) -> int:
    from .service import Service

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("websockets").setLevel(logging.WARNING)

    url_file = os.environ.get("LANTERN_URL_FILE")
    token = ""
    if url_file and Path(url_file).is_file():  # restarted this boot: keep the token the open page has
        token = Path(url_file).read_text().strip().partition("?t=")[2]

    async def main() -> None:
        service = Service(port=args.port, dev=args.dev, token=token)
        task = asyncio.ensure_future(service.run())
        while not service.bridge._server and not task.done():
            await asyncio.sleep(0.05)
        if service.bridge._server:
            say(f"screen: {service.bridge.start_url}")
            if url_file:  # the kiosk reads the start URL (with this boot's token) from here
                path = Path(url_file)
                config.write_private(path, service.bridge.start_url + "\n")
                os.chmod(path, 0o640)  # readable by the kiosk account (group lantern), nobody else
        await task

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except LanternError as exc:
        return fail(str(exc))
    return 0


def cmd_setup(args: argparse.Namespace) -> int:
    url = args.url or input("Hermes address (for example https://hermes.your-tailnet.ts.net): ").strip()
    if _service_running():
        with connect() as h:
            h.request("setup", url=url, timeout=30)
            say(f"Hermes address set: {h.request('status')['status']['server']['url']}")
    else:
        from .auth import normalize_base

        cfg = config.load()
        cfg["url"] = normalize_base(url if "://" in url else ("https://" + url if url.endswith(".ts.net") else url))
        if args.name:
            cfg["name"] = args.name
        config.save(cfg)
        say(f"Hermes address set: {cfg['url']}")
    if not args.no_signin:
        return cmd_signin(args)
    return 0


def cmd_signin(args: argparse.Namespace) -> int:
    username = getattr(args, "username", None) or input("Hermes username: ").strip()
    password = os.environ.get("LANTERN_PASSWORD") or getpass.getpass("Hermes password: ")
    remember = not getattr(args, "forget_password", False)
    if _service_running():
        with connect() as h:
            h.request("signin", username=username, password=password, remember=remember, timeout=60)
    else:
        from .auth import Auth

        cfg = config.load()
        if not cfg.get("url"):
            return fail("set the Hermes address first: lantern setup <address>")
        auth = Auth(cfg["url"], config.home() / "credentials.json")
        asyncio.run(auth.sign_in(username, password, remember))
    say("Signed in." + (" The password is kept so the desk can sign in again by itself." if remember else ""))
    return 0


def cmd_signout(args: argparse.Namespace) -> int:
    if _service_running():
        with connect() as h:
            h.request("signout")
    else:
        from .auth import Auth

        cfg = config.load()
        if cfg.get("url"):
            Auth(cfg["url"], config.home() / "credentials.json").sign_out()
    say("Signed out. The saved session and password are gone.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    with connect() as h:
        status = h.request("status")["status"]
    if args.json:
        say(json.dumps(status, indent=2))
        return 0
    view = status.get("view") or {}
    say(f"state:    {status['state']}" + (f"  ({status['error']})" if status.get("error") else ""))
    say(f"hermes:   {status['server']['url'] or '(not set)'}  {status['server'].get('version') or ''}".rstrip())
    say(f"account:  {status['account']['username'] or '(signed out)'}"
        + ("  password kept" if status["account"].get("remembered") else ""))
    say(f"profiles: {', '.join(p['display_name'] for p in status.get('profiles') or []) or '-'}")
    say(f"open:     {view.get('profile')} / {'main chat' if view.get('kind') == 'main' else view.get('title') or view.get('session_id')}")
    return 0


def cmd_send(args: argparse.Namespace) -> int:
    text = " ".join(args.text).strip() or sys.stdin.read().strip()
    with connect() as h:
        if h.state != "ready":
            return fail(f"not connected to Hermes ({h.state}): {h.status.get('error') or ''}".strip())
        say(h.ask(text, timeout=args.timeout))
    return 0


def cmd_chat(args: argparse.Namespace) -> int:
    with connect() as h:
        if h.state != "ready":
            return fail(f"not connected to Hermes ({h.state})")
        say("Talking to Hermes. Ctrl+D to leave.")
        while True:
            try:
                text = input("you> ").strip()
            except EOFError:
                say()
                return 0
            if text:
                try:
                    say("hermes> " + h.ask(text))
                except LanternError as exc:
                    say(f"({exc})")


def cmd_doctor(args: argparse.Namespace) -> int:
    ok = True

    def check(good: bool, label: str, hint: str = "") -> None:
        nonlocal ok
        ok &= good
        say(f"  {'ok ' if good else 'NO '} {label}" + ("" if good or not hint else f"\n       {hint}"))

    cfg = config.load()
    say(f"lantern {__version__}, settings in {config.home()}")
    check(sys.version_info >= (3, 11), f"Python {sys.version.split()[0]}", "Python 3.11 or later is needed.")
    check(bool(cfg.get("url")), f"Hermes address: {cfg.get('url') or '(not set)'}", "Run: lantern setup <address>")
    check(shutil.which("tailscale") is not None, "Tailscale installed", "Install it from tailscale.com/download/linux")
    from .bridge import ui_dir

    check(ui_dir() is not None, f"screen UI built: {ui_dir() or '(missing)'}", "Build it: cd ui && npm install && npm run build")
    if _service_running():
        with connect() as h:
            status = h.request("status")["status"]
        check(status["state"] == "ready", f"service: {status['state']}", status.get("error") or "")
    else:
        check(False, "service running", "Start it: sudo systemctl start lantern (or: lantern run)")
    say("all good" if ok else "something needs attention (see above)")
    return 0 if ok else 1


def cmd_fakehermes(args: argparse.Namespace) -> int:
    from .fakehermes import serve_forever

    try:
        asyncio.run(serve_forever(args.host, args.port))
    except KeyboardInterrupt:
        pass
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="lantern", description="A desk device for your own Hermes Agent.")
    parser.add_argument("--version", action="version", version=f"lantern {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("run", help="run the service the desk's screen talks to")
    p.add_argument("--port", type=int, default=8765, help="port on 127.0.0.1 for the screen (default 8765)")
    p.add_argument("--dev", action="store_true", help="development: fixed token 'dev', for a Vite dev server")
    p.add_argument("-v", "--verbose", action="store_true")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("setup", help="set the Hermes address, then sign in")
    p.add_argument("url", nargs="?")
    p.add_argument("--name", help="a name for this desk")
    p.add_argument("--username")
    p.add_argument("--forget-password", action="store_true", help="do not keep the password")
    p.add_argument("--no-signin", action="store_true")
    p.set_defaults(fn=cmd_setup)

    p = sub.add_parser("signin", help="sign in to Hermes (the password is read from LANTERN_PASSWORD or asked)")
    p.add_argument("--username")
    p.add_argument("--forget-password", action="store_true", help="do not keep the password")
    p.set_defaults(fn=cmd_signin)

    p = sub.add_parser("signout", help="forget the session and any saved password")
    p.set_defaults(fn=cmd_signout)

    p = sub.add_parser("status", help="what the desk is doing")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("send", help="send one message in the open chat and print the answer")
    p.add_argument("text", nargs="*")
    p.add_argument("--timeout", type=float, default=600)
    p.set_defaults(fn=cmd_send)

    p = sub.add_parser("chat", help="talk to Hermes in the terminal, in the desk's open chat")
    p.set_defaults(fn=cmd_chat)

    p = sub.add_parser("doctor", help="check what the desk needs")
    p.set_defaults(fn=cmd_doctor)

    p = sub.add_parser("fakehermes", help="a stand-in Hermes for development (needs the dev extra)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=9119)
    p.set_defaults(fn=cmd_fakehermes)

    args = parser.parse_args(argv)
    try:
        return int(args.fn(args) or 0)
    except LanternError as exc:
        return fail(str(exc))
    except KeyboardInterrupt:
        return 130
