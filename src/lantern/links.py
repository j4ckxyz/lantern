"""Link previews and remote pictures, fetched by the desk itself with strict limits.

A reply can contain any URL, so every fetch here is treated as hostile input:

* only ``http`` and ``https`` on ports 80, 443 and 8080 to 8443;
* the host name is resolved first and every address must be public: loopback, private,
  link-local, multicast, reserved, carrier-grade NAT (which includes the tailnet's 100.64/10) and
  Tailscale's IPv6 range are refused, so a reply cannot make the desk probe your network;
* the connection goes to the address that was checked (no second lookup to rebind), with TLS
  still verified against the name;
* at most three redirects, each checked again; no cookies; a short timeout; a size cap.

Results are kept in memory only.
"""

from __future__ import annotations

import asyncio
import collections
import html
import html.parser
import http.client
import ipaddress
import socket
import ssl
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, urljoin, urlsplit

from .errors import LanternError

USER_AGENT = "Mozilla/5.0 (X11; Linux aarch64) LanternDesk/0.2 (link preview)"
PAGE_BYTES = 512_000
IMAGE_BYTES = 10_000_000
TIMEOUT_S = 6
_TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")
_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_PORTS = {80, 443} | set(range(8080, 8444))


class Blocked(LanternError):
    pass


def _public(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip in _CGNAT or ip in _TAILNET_V6:
        return False
    return ip.is_global and not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
                                 or ip.is_reserved or ip.is_unspecified)


def check_url(url: str) -> Tuple[str, str, int, str]:
    """``(scheme, host, port, path)`` of a URL the desk may fetch, or ``Blocked``."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise Blocked("Only web addresses can be previewed.")
    if parts.username or parts.password:
        raise Blocked("Addresses with a password in them are not fetched.")
    try:
        literal = ipaddress.ip_address(parts.hostname)
    except ValueError:
        literal = None
    if literal is not None and not _public(str(literal)):
        raise Blocked(f"{parts.hostname} is not a public address.")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    if port not in _PORTS:
        raise Blocked("That port is not fetched.")
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return parts.scheme, parts.hostname, port, quote(path, safe="/?&=%:@!$'()*+,;~-._")


def _resolve(host: str, port: int) -> str:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise Blocked(f"{host} could not be found.") from None
    addresses = [info[4][0] for info in infos]
    if not addresses or not all(_public(a) for a in addresses):
        raise Blocked(f"{host} is not a public address.")
    return addresses[0]


def _get(url: str, max_bytes: int, accept: str) -> Tuple[str, str, bytes]:
    """GET with the checks above. Returns ``(final_url, content_type, body)``."""
    for _ in range(4):
        scheme, host, port, path = check_url(url)
        address = _resolve(host, port)
        if scheme == "https":
            context = ssl.create_default_context()
            raw = socket.create_connection((address, port), timeout=TIMEOUT_S)
            try:
                sock = context.wrap_socket(raw, server_hostname=host)
            except Exception:
                raw.close()
                raise
            conn: http.client.HTTPConnection = http.client.HTTPSConnection(host, port, timeout=TIMEOUT_S, context=context)
        else:
            sock = socket.create_connection((address, port), timeout=TIMEOUT_S)
            conn = http.client.HTTPConnection(host, port, timeout=TIMEOUT_S)
        conn.sock = sock
        try:
            conn.request("GET", path, headers={"User-Agent": USER_AGENT, "Accept": accept,
                                               "Accept-Language": "en-GB,en;q=0.8"})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location") or ""
                if not location:
                    raise Blocked("The page redirected nowhere.")
                url = urljoin(url, location)
                continue
            if response.status >= 400:
                raise LanternError(f"The page answered {response.status}.")
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes and not accept.startswith("text/html"):
                raise Blocked("That is too large to show.")
            return url, (response.getheader("Content-Type") or "").split(";")[0].strip().lower(), body[:max_bytes]
        finally:
            conn.close()
    raise Blocked("Too many redirects.")


class _Head(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: Dict[str, str] = {}
        self.icons: List[Tuple[str, str]] = []
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "link" and a.get("href"):
            rel = a.get("rel", "").lower()
            if "icon" in rel:
                self.icons.append((rel, a["href"]))
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and len(self.title) < 300:
            self.title += data


def _clean(text: str, limit: int) -> str:
    text = " ".join(html.unescape(text or "").split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def parse_page(url: str, body: bytes, content_type: str) -> Dict[str, Any]:
    parts = urlsplit(url)
    site = (parts.hostname or "").removeprefix("www.")
    if content_type and "html" not in content_type:
        return {"url": url, "title": parts.path.rsplit("/", 1)[-1] or site, "description": "", "site": site,
                "favicon": None, "image": proxied(url) if content_type.startswith("image/") else None}
    charset = "utf-8"
    head = body[:4096].decode("ascii", "ignore").lower()
    marker = head.find("charset=")
    if marker >= 0:
        charset = head[marker + 8:marker + 40].strip("\"' ").split("\"")[0].split(";")[0].split(">")[0].strip() or "utf-8"
    try:
        text = body.decode(charset, "replace")
    except LookupError:
        text = body.decode("utf-8", "replace")
    parser = _Head()
    try:
        parser.feed(text)
    except Exception:  # broken markup still gives what was read so far
        pass
    meta = parser.meta
    title = meta.get("og:title") or meta.get("twitter:title") or parser.title
    description = meta.get("og:description") or meta.get("description") or meta.get("twitter:description") or ""
    image = meta.get("og:image") or meta.get("twitter:image") or ""
    icons = sorted(parser.icons, key=lambda pair: ("apple-touch" in pair[0], "svg" in pair[1]))
    icon = icons[0][1] if icons else "/favicon.ico"
    return {
        "url": url, "title": _clean(title, 140) or site, "description": _clean(description, 220),
        "site": _clean(meta.get("og:site_name") or site, 60),
        "favicon": proxied(urljoin(url, icon)), "image": proxied(urljoin(url, image)) if image else None,
    }


def proxied(url: str) -> Optional[str]:
    try:
        check_url(url)
    except Blocked:
        return None
    return "/proxy/image?url=" + quote(url, safe="")


class Fetcher:
    """Previews and pictures, cached in memory."""

    def __init__(self) -> None:
        self._previews: "collections.OrderedDict[str, Tuple[float, Dict[str, Any]]]" = collections.OrderedDict()
        self._images: "collections.OrderedDict[str, Tuple[bytes, str]]" = collections.OrderedDict()
        self._image_bytes = 0
        self._pending: Dict[str, asyncio.Future] = {}

    async def preview(self, url: str) -> Dict[str, Any]:
        check_url(url)
        hit = self._previews.get(url)
        if hit and time.time() - hit[0] < 24 * 3600:
            return hit[1]
        if url in self._pending:
            return await asyncio.shield(self._pending[url])
        future = asyncio.get_running_loop().create_future()
        self._pending[url] = future
        try:
            try:
                final, content_type, body = await asyncio.get_running_loop().run_in_executor(
                    None, _get, url, PAGE_BYTES, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
                result = parse_page(final, body, content_type)
                result["url"] = url
            except (LanternError, OSError, http.client.HTTPException, ssl.SSLError, ValueError) as exc:
                site = (urlsplit(url).hostname or "").removeprefix("www.")
                result = {"url": url, "title": site, "description": "", "site": site, "favicon": None,
                          "image": None, "unavailable": str(exc) if isinstance(exc, LanternError) else True}
            self._previews[url] = (time.time(), result)
            while len(self._previews) > 300:
                self._previews.popitem(last=False)
            future.set_result(result)
            return result
        finally:
            self._pending.pop(url, None)
            if not future.done():
                future.cancel()

    async def image(self, url: str) -> Tuple[bytes, str]:
        if url in self._images:
            self._images.move_to_end(url)
            return self._images[url]
        _, content_type, body = await asyncio.get_running_loop().run_in_executor(
            None, _get, url, IMAGE_BYTES, "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8")
        if not content_type.startswith("image/") and not body[:8].startswith(b"\x89PNG"):
            raise Blocked("That is not a picture.")
        entry = (body, content_type or "image/png")
        self._images[url] = entry
        self._image_bytes += len(body)
        while self._image_bytes > 32_000_000 and self._images:
            _, (old, _) = self._images.popitem(last=False)
            self._image_bytes -= len(old)
        return entry
