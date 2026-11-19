"""Where the desk keeps its things, and its settings.

Everything lives under one directory: ``$LANTERN_HOME``, else ``/var/lib/lantern`` when the
service runs as the ``lantern`` system user on the device, else ``~/.config/lantern``.

    config.json       the Hermes address and this device's name
    credentials.json  the signed-in session (and, if chosen, the password); mode 0600
    settings.json     what the screen lets you change (text size, sounds, sleep, ...)
    state.json        which chat was open, so a restart comes back to it
    lantern.sock      the local socket the `lantern` command uses
"""

from __future__ import annotations

import json
import os
import re
import socket
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULTS: Dict[str, Any] = {
    "url": "",   # https://hermes.your-tailnet.ts.net (the Hermes dashboard)
    "name": "",  # this device's name; defaults to the host name
}

SETTINGS_DEFAULTS: Dict[str, Any] = {
    "text_size": "comfortable",
    "theme": "dark",
    "sounds": False,
    "sound_volume": 0.4,
    "speech_volume": 0.8,
    "read_aloud": False,
    "brightness": 0.8,
    "dim_after_s": 120,
    "off_after_s": 600,
    "quiet_start": "23:00",
    "quiet_end": "07:00",
    "touch_keyboard": "auto",
    "default_profile": "default",
}

_CHOICES = {
    "text_size": ("compact", "comfortable", "large"),
    "theme": ("dark", "light", "auto"),
    "touch_keyboard": ("auto", "always"),
}
_BOOLS = ("sounds", "read_aloud")
_UNIT = {"sound_volume": (0.0, 1.0), "speech_volume": (0.0, 1.0), "brightness": (0.05, 1.0)}
_SECONDS = ("dim_after_s", "off_after_s")
_TIMES = ("quiet_start", "quiet_end")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def home() -> Path:
    override = os.environ.get("LANTERN_HOME")
    if override:
        return Path(override).expanduser()
    system = Path("/var/lib/lantern")
    if system.is_dir() and os.access(system, os.W_OK):
        return system
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return Path(base) / "lantern"


def socket_path(base: Optional[Path] = None) -> Path:
    return (base or home()) / "lantern.sock"


def default_name() -> str:
    host = socket.gethostname().split(".")[0] or "desk"
    return host[:1].upper() + host[1:]


def load(base: Optional[Path] = None) -> Dict[str, Any]:
    cfg = dict(DEFAULTS)
    raw = read_json((base or home()) / "config.json", {})
    if isinstance(raw, dict):
        cfg.update({k: v for k, v in raw.items() if k in DEFAULTS})
    if not cfg.get("name"):
        cfg["name"] = default_name()
    return cfg


def save(cfg: Dict[str, Any], base: Optional[Path] = None) -> Path:
    directory = base or home()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "config.json"
    write_private(path, json.dumps({k: cfg.get(k, "") for k in DEFAULTS}, indent=2, sort_keys=True) + "\n")
    return path


def clean_settings(raw: Any) -> Dict[str, Any]:
    """The recognised settings in ``raw``, each checked. Anything else is dropped."""
    out: Dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    for key, allowed in _CHOICES.items():
        if raw.get(key) in allowed:
            out[key] = raw[key]
    for key in _BOOLS:
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]
    for key, (low, high) in _UNIT.items():
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = round(min(max(float(value), low), high), 3)
    for key in _SECONDS:
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 24 * 3600:
            out[key] = int(value)
    for key in _TIMES:
        if isinstance(raw.get(key), str) and _TIME_RE.match(raw[key]):
            out[key] = raw[key]
    name = raw.get("default_profile")
    if isinstance(name, str) and 0 < len(name.strip()) <= 64:
        out["default_profile"] = name.strip()
    return out


def load_settings(base: Optional[Path] = None) -> Dict[str, Any]:
    settings = dict(SETTINGS_DEFAULTS)
    settings.update(clean_settings(read_json((base or home()) / "settings.json", {})))
    return settings


def save_settings(settings: Dict[str, Any], base: Optional[Path] = None) -> None:
    directory = base or home()
    directory.mkdir(parents=True, exist_ok=True)
    write_private(directory / "settings.json", json.dumps(clean_settings(settings), indent=1, sort_keys=True) + "\n")


def write_private(path: Path, text: str) -> None:
    """Write a file only this account can read, replacing it in one step (safe across power cuts)."""
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    try:
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
