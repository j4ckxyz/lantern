"""Shared fixtures. Everything runs with no Hermes, no hardware and no network beyond 127.0.0.1:
the service against ``lantern.fakehermes``, and a pretend screen on the bridge's WebSocket."""

from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))


@pytest.fixture
def run():
    """Run a coroutine to completion on a fresh loop."""
    def _run(coro, timeout: float = 30):
        async def bounded():
            return await asyncio.wait_for(coro, timeout)
        return asyncio.run(bounded())
    return _run


@pytest.fixture
def short_tmp():
    """A short temporary directory: Unix socket paths are limited to about 100 characters."""
    path = tempfile.mkdtemp(prefix="hl-", dir="/tmp")
    try:
        yield Path(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


async def until(predicate, timeout: float = 10, what: str = "condition"):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        value = predicate()
        if value:
            return value
        await asyncio.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


class Screen:
    """What the desk's screen sees: every event, and a way to send operations."""

    def __init__(self, ws):
        self.ws = ws
        self.events: List[Dict[str, Any]] = []
        self.binary: List[bytes] = []
        self._results: Dict[str, asyncio.Future] = {}
        self._n = 0
        self._reader = asyncio.ensure_future(self._read())

    async def _read(self) -> None:
        async for raw in self.ws:
            if isinstance(raw, bytes):
                self.binary.append(raw)
                continue
            msg = json.loads(raw)
            if msg.get("type") == "result" and msg.get("req") in self._results:
                self._results.pop(msg["req"]).set_result(msg)
                continue
            self.events.append(msg)

    async def op(self, op: str, **fields: Any) -> Dict[str, Any]:
        self._n += 1
        req = f"t{self._n}"
        future = asyncio.get_running_loop().create_future()
        self._results[req] = future
        await self.ws.send(json.dumps({"op": op, "req": req, **fields}))
        return await asyncio.wait_for(future, 20)

    def of(self, kind: str) -> List[Dict[str, Any]]:
        return [e for e in self.events if e["type"] == kind]

    def last(self, kind: str) -> Optional[Dict[str, Any]]:
        found = self.of(kind)
        return found[-1] if found else None

    async def wait(self, kind: str, after: int = 0, timeout: float = 10, where=None) -> Dict[str, Any]:
        def find():
            for e in self.events[after:]:
                if e["type"] == kind and (where is None or where(e)):
                    return e
            return None
        return await until(find, timeout, f"a {kind} event")

    async def close(self) -> None:
        await self.ws.close()
        self._reader.cancel()


@contextlib.asynccontextmanager
async def desk(home: Path, signed_in: bool = True, **fake_kw):
    """A fake Hermes, the service pointed at it (signed in), and a screen connected to the bridge."""
    from websockets.asyncio.client import connect

    from lantern import config
    from lantern.auth import Auth
    from lantern.fakehermes import FakeHermes
    from lantern.service import Service

    fake_kw.setdefault("word_delay", 0.0)
    fake = FakeHermes(**fake_kw)
    await fake.start()
    config.save({"url": fake.base, "name": "Desk"}, home)
    if signed_in:
        await Auth(fake.base, home / "credentials.json").sign_in("ada", "pw", remember=True)
    service = Service(home=home, port=0)
    task = asyncio.ensure_future(service.run())
    await until(lambda: service.bridge._server is not None, what="the bridge")
    port = service.bridge.bound_port
    ws = await connect(f"ws://127.0.0.1:{port}/ws?t={service.bridge.token}", max_size=None)
    screen = Screen(ws)
    try:
        yield fake, service, screen
    finally:
        await screen.close()
        await service.stop()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        await fake.stop()


@pytest.fixture
def desk_ctx():
    return desk
