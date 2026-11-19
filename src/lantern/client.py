"""A small client for the service's Unix socket, used by the ``lantern`` command and scripts.

    import lantern

    with lantern.connect() as h:
        print(h.ask("What is on my calendar today?"))

The protocol is ``docs/local-api.md``: JSON objects, one per line.
"""

from __future__ import annotations

import json
import queue
import socket
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Iterator, Optional, Union

from . import config
from .errors import LanternError


class Lantern:
    def __init__(self, socket_path: Optional[Union[str, Path]] = None, timeout: float = 15):
        self._path = str(socket_path or config.socket_path())
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.settimeout(timeout)
        try:
            self._sock.connect(self._path)
        except OSError as exc:
            self._sock.close()
            raise LanternError(f"The lantern service is not running ({self._path}: {exc.strerror or exc}). "
                               "Start it with 'lantern run' or 'sudo systemctl start lantern'.") from None
        self._sock.settimeout(None)
        self._file = self._sock.makefile("rb")
        self._lock = threading.Lock()
        self._events: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self._pending: Dict[str, "queue.Queue[Dict[str, Any]]"] = {}
        self._timeout = timeout
        self._closed = False
        first = self._file.readline()
        self.status: Dict[str, Any] = json.loads(first) if first else {}
        self._thread = threading.Thread(target=self._read, name="lantern-client", daemon=True)
        self._thread.start()

    def __enter__(self) -> "Lantern":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._closed = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._sock.close()

    def _read(self) -> None:
        try:
            for line in self._file:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("type") == "result" and msg.get("req") in self._pending:
                    self._pending[msg["req"]].put(msg)
                    continue
                if msg.get("type") == "hello":
                    self.status = msg
                elif msg.get("type") == "link":
                    self.status["state"] = msg.get("state")
                    self.status["error"] = msg.get("error", "")
                self._events.put(msg)
        except (OSError, ValueError):
            pass
        finally:
            self._closed = True
            self._events.put(None)
            for waiting in list(self._pending.values()):
                waiting.put({"ok": False, "error": "The lantern service stopped."})

    def request(self, op: str, timeout: Optional[float] = None, **fields: Any) -> Dict[str, Any]:
        """Send one operation and wait for its result. Raises ``LanternError`` when it fails."""
        req = uuid.uuid4().hex[:10]
        waiting: "queue.Queue[Dict[str, Any]]" = queue.Queue()
        self._pending[req] = waiting
        try:
            data = json.dumps({"op": op, "req": req, **fields}, ensure_ascii=False).encode() + b"\n"
            with self._lock:
                try:
                    self._sock.sendall(data)
                except OSError as exc:
                    raise LanternError(f"The lantern service stopped ({exc}).") from None
            try:
                result = waiting.get(timeout=timeout or self._timeout)
            except queue.Empty:
                raise LanternError(f"The lantern service did not answer '{op}' in time.") from None
        finally:
            self._pending.pop(req, None)
        if not result.get("ok"):
            raise LanternError(str(result.get("error") or f"'{op}' failed"))
        return result

    @property
    def state(self) -> str:
        return str(self.status.get("state") or "offline")

    def events(self, timeout: Optional[float] = None) -> Iterator[Dict[str, Any]]:
        while True:
            try:
                msg = self._events.get(timeout=timeout)
            except queue.Empty:
                return
            if msg is None:
                return
            yield msg

    def send(self, text: str) -> str:
        return str(self.request("send", text=text).get("id") or "")

    def ask(self, text: str, timeout: float = 600) -> str:
        """Send a message and return the finished reply."""
        while not self._events.empty():
            self._events.get_nowait()
        self.send(text)
        reply = ""
        for event in self.events(timeout=timeout):
            if event.get("type") == "message" and event["message"].get("role") == "assistant" \
                    and not event["message"].get("interim"):
                reply = event["message"].get("text") or ""
            elif event.get("type") == "turn.end":
                if event.get("outcome") == "failure" and not reply:
                    raise LanternError(event.get("error") or "Hermes could not answer.")
                return reply
        return reply


def connect(socket_path: Optional[Union[str, Path]] = None, timeout: float = 15) -> Lantern:
    return Lantern(socket_path, timeout)
