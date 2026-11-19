"""Lantern: a desk device for your own Hermes Agent.

``lantern run`` is the service between the desk's screen and Hermes; ``docs/local-api.md`` is the
protocol it serves. ``lantern.connect()`` is a small client for scripts on the same machine.
"""

from __future__ import annotations

__version__ = "0.2.0"

from .client import Lantern, connect  # noqa: E402
from .errors import LanternError, NeedsSignIn  # noqa: E402

__all__ = ["Lantern", "LanternError", "NeedsSignIn", "connect", "__version__"]
