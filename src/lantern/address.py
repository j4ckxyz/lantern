"""Turning whatever someone types as their Hermes address into URLs worth trying.

People type ``hermes.tail1234.ts.net``, ``192.168.1.20``, ``https//hermes.example.com``,
``HTTPS://Hermes.Example.com/sessions?x=1`` or paste the dashboard's own address with a route
on the end. :func:`clean` repairs what can be repaired and says plainly what cannot;
:func:`candidates` lists the base URLs to try, most likely first, so the service can probe them
together and keep the first that answers.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import urlsplit

DASHBOARD_PORT = 9119
# Routes of the dashboard's own web app: pasted addresses often end in one of these.
_APP_ROUTES = re.compile(r"^/(login|chat|chats|sessions?|settings|profiles?|files|cron|skills|logs|config|app)(/.*)?$", re.I)
_SCHEME = re.compile(r"^\s*([a-z]{3,7})\s*(?::\s*/{0,3}|/{2,3})\s*", re.I)


@dataclass(frozen=True)
class Address:
    scheme: Optional[str]  # "http", "https", or None when none was typed
    host: str  # lower case; an IPv6 literal without brackets
    port: Optional[int]
    path: str  # "" or "/prefix" for a dashboard behind a reverse proxy

    @property
    def netloc(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{host}:{self.port}" if self.port else host

    def url(self, scheme: str, port: Optional[int] = None) -> str:
        port = port if port is not None else self.port
        if (scheme, port) in (("http", 80), ("https", 443)):
            port = None
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{scheme}://{host}{':' + str(port) if port else ''}{self.path}"


def _fix_scheme(word: str) -> Optional[str]:
    """``https``, ``htps``, ``HTTPS`` and friends; None for anything that is not trying to be one."""
    w = word.lower()
    if w in ("http", "https"):
        return w
    if w[0] == "h" and set(w) <= set("htps") and "p" in w and len(w) <= 7:
        return "https" if w.endswith("s") else "http"
    return None


def clean(raw: str) -> Address:
    """What was typed, repaired. Raises ValueError with a sentence a person can act on."""
    text = (raw or "").strip().strip("<>\"'`").strip()
    if not text:
        raise ValueError("Type the address of your Hermes dashboard.")
    scheme = None
    m = _SCHEME.match(text)
    if m and _fix_scheme(m.group(1)):
        scheme = _fix_scheme(m.group(1))
        text = text[m.end():]
    text = text.replace("\\", "/")
    if re.search(r"\s", text.split("/")[0]):
        text = re.sub(r"\s+", "", text.split("/")[0]) + text[len(text.split("/")[0]):]
    if re.match(r"^[0-9a-f:]+$", text, re.I) and text.count(":") >= 2:
        text = f"[{text}]"  # a bare IPv6 address
    parts = urlsplit("//" + text)
    if parts.username or parts.password:
        raise ValueError("Leave the username and password out of the address. You sign in on the next screen.")
    try:
        host = (parts.hostname or "").rstrip(".")
        port = parts.port
    except ValueError:
        raise ValueError(f"The port in {raw.strip()} is not a number this desk can use.") from None
    if not host or not re.match(r"^[a-z0-9._\-:\[\]]+$", host, re.I):
        raise ValueError(f"That does not look like an address: {raw.strip()}")
    path = re.sub(r"/+", "/", parts.path or "").rstrip("/")
    if _APP_ROUTES.match(path) or path.startswith("/#"):
        path = ""  # the dashboard's own page, not where it is served from
    return Address(scheme, host.lower(), port, path)


def is_private(host: str) -> bool:
    """A name or address on this network or tailnet, where plain http is the norm."""
    host = host.lower()
    if host == "localhost" or host.endswith((".local", ".lan", ".home", ".internal", ".home.arpa", ".ts.net")):
        return True
    if "." not in host and ":" not in host:
        return True  # a bare machine name
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip in ipaddress.ip_network("100.64.0.0/10")


def is_tailnet(host: str) -> bool:
    host = host.lower()
    if host.endswith(".ts.net"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip in ipaddress.ip_network("100.64.0.0/10") or ip in ipaddress.ip_network("fd7a:115c:a1e0::/48")


def candidates(raw: str) -> List[str]:
    """Base URLs to try for what was typed, most likely first, without duplicates."""
    a = clean(raw)
    out: List[str] = []

    def add(scheme: str, port: Optional[int] = None) -> None:
        url = a.url(scheme, port)
        if url not in out:
            out.append(url)

    if a.scheme:
        if a.port:
            add(a.scheme)
        elif a.scheme == "https":
            add("https")
        else:
            add("http", DASHBOARD_PORT)
            add("http", 80)
        if a.path:  # a pasted address with a path we did not recognise: also try the site's root
            out.extend(u for u in [Address(a.scheme, a.host, a.port, "").url(a.scheme)] if u not in out)
        return out
    if a.port:
        if a.port == 443:
            add("https")
        else:
            add("http")
            add("https")
        return out
    if is_tailnet(a.host) or not is_private(a.host):
        add("https")  # Tailscale serve and reverse proxies give https on 443
        add("http", DASHBOARD_PORT)
        add("http", 80)
    else:
        add("http", DASHBOARD_PORT)  # hermes dashboard on a home network
        add("https")
        add("http", 80)
    return out


def needs_warning(url: str) -> bool:
    """Plain http to somewhere outside this network or tailnet: the password would travel in the clear."""
    parts = urlsplit(url)
    return parts.scheme == "http" and not is_private(parts.hostname or "")
