"""Pictures, audio and files the agent sends, and getting them onto the screen.

Hermes does not take media out of replies for dashboard clients: the agent writes
``MEDIA:/path/on/the/hermes/host.png`` into its reply text (and ``[[audio_as_voice]]`` for a
spoken reply), and each client finds those itself. This module does it with the same rules as
Hermes's own messaging adapters (``gateway/platforms/base.py``: ``MEDIA_TAG_CLEANUP_RE``,
``extract_media``): only paths with a deliverable extension count, tags inside code or
blockquotes are examples rather than deliveries, and a tag with an unknown extension stays in the
text.

The bytes are fetched from Hermes by the service (``/api/files/download``), so the screen only
ever sees ``/media/<id>`` on 127.0.0.1.
"""

from __future__ import annotations

import collections
import hashlib
import mimetypes
import posixpath
import re
from typing import Any, Dict, List, Optional, Tuple

from .errors import LanternError

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg")
AUDIO_EXTS = (".mp3", ".m2a", ".wav", ".ogg", ".opus", ".m4a", ".flac")
DELIVERABLE_EXTS = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg",
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp",
    ".mp3", ".m2a", ".wav", ".ogg", ".opus", ".m4a", ".flac",
    ".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md", ".epub",
    ".xlsx", ".xls", ".ods", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
    ".kmz", ".kml", ".geojson", ".gpx",
    ".pptx", ".ppt", ".odp", ".key",
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".apk", ".ipa",
    ".html", ".htm",
)
_EXT_ALTERNATION = "|".join(sorted((e.lstrip(".") for e in DELIVERABLE_EXTS), key=len, reverse=True))
_CJK = "（）〈〉《》：，。；！？、“”‘’【】"
TAG_RE = re.compile(
    r'''[`"'*_]{0,3}MEDIA:\s*'''
    r'''(?P<path>`[^`\n]+?`|"[^"\n]+?"|'[^'\n]+?'|'''
    r'''(?:~/|/|[A-Za-z]:[/\\])\S+?(?:[^\S\n]+\S+?)*?\.(?:''' + _EXT_ALTERNATION + r'''))'''
    r'''(?:(?=[\s`"'*_,;:)\]}\[''' + _CJK + r''']|MEDIA:|\.(?:\s|$)|$)[`"'*_]{0,3}\.?|'''
    r'''(?:\\[nrt])+(?=[\s`"'*_,;:)\]}\[''' + _CJK + r''']|MEDIA:|$))''',
    re.IGNORECASE)
_FENCED_RE = re.compile(r"(^|\n)[ \t]*(```|~~~)[^\n]*\n.*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)", re.DOTALL)
_INLINE_RE = re.compile(r"`[^`\n]+`")
_QUOTE_RE = re.compile(r"(?m)^[ \t]{0,3}>.*$")
VOICE_MARK = "[[audio_as_voice]]"
DOCUMENT_MARK = "[[as_document]]"


def _blank(text: str, spans: List[Tuple[int, int]]) -> str:
    chars = list(text)
    for start, end in spans:
        chars[start:end] = [c if c == "\n" else " " for c in chars[start:end]]
    return "".join(chars)


def _masked(text: str) -> str:
    """``text`` with code and blockquotes blanked (same length), so examples are never delivered."""
    spans = [m.span() for m in _FENCED_RE.finditer(text)]
    for m in _INLINE_RE.finditer(text):
        if re.search(r"MEDIA:\s*$", text[max(0, m.start() - 20):m.start()]):
            continue  # a backtick-quoted path inside a real tag
        spans.append(m.span())
    spans.extend(m.span() for m in _QUOTE_RE.finditer(text))
    return _blank(text, spans)


def _normalise(raw: str) -> str:
    path = str(raw or "").strip()
    if len(path) >= 2 and path[0] == path[-1] and path[0] in "`\"'":
        path = path[1:-1].strip()
    return path.lstrip("`\"'").rstrip("`\"',.;:)}]")


def extract(text: str) -> Tuple[List[Tuple[str, bool]], str]:
    """``(paths, cleaned)``: each ``(path, is_voice)`` once, in order, and the text without the tags."""
    voice = VOICE_MARK in text
    cleaned = text.replace(VOICE_MARK, "").replace(DOCUMENT_MARK, "")
    scan = _masked(cleaned)
    found: List[Tuple[str, bool]] = []
    seen = set()
    spans: List[Tuple[int, int]] = []
    for match in TAG_RE.finditer(scan):
        path = _normalise(match.group("path"))
        spans.append(match.span())
        if path and "\x00" not in path and path not in seen:
            seen.add(path)
            found.append((path, voice and posixpath.splitext(path)[1].lower() in AUDIO_EXTS))
    if spans:
        out, last = [], 0
        for start, end in spans:
            out.append(cleaned[last:start])
            last = end
        out.append(cleaned[last:])
        cleaned = re.sub(r"\n{3,}", "\n\n", "".join(out))
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned).strip()
    return found, cleaned


def displayable(streamed: str) -> str:
    """What to show of a reply still being written: complete tags removed, and a trailing line that
    may be the start of a tag held back, so ``MEDIA:/pa`` never flashes on screen."""
    _, cleaned = extract(streamed)
    last_break = cleaned.rfind("\n")
    tail = cleaned[last_break + 1:]
    stripped = tail.lstrip("`\"'*_ ")
    if stripped and ("MEDIA:".startswith(stripped[:6].upper()) or stripped.upper().startswith("MEDIA:")):
        cleaned = cleaned[:last_break + 1].rstrip() if last_break >= 0 else ""
    if "[[" in cleaned[-20:] and not cleaned.endswith("]]"):
        cut = cleaned.rfind("[[")
        if VOICE_MARK.startswith(cleaned[cut:]) or DOCUMENT_MARK.startswith(cleaned[cut:]):
            cleaned = cleaned[:cut].rstrip()
    return cleaned


def kind_of(name: str) -> str:
    ext = posixpath.splitext(name)[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    return "file"


def mime_of(name: str) -> str:
    ext = posixpath.splitext(name)[1].lower()
    return {".opus": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".webp": "image/webp",
            ".m2a": "audio/mpeg"}.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


class Registry:
    """Media the screen may ask for, by an id that reveals nothing, and a small byte cache."""

    CACHE_BYTES = 64_000_000

    def __init__(self) -> None:
        self.base = ""  # the Hermes dashboard's address, for phone-reachable download links
        self._items: Dict[str, Dict[str, Any]] = {}
        self._cache: "collections.OrderedDict[str, Tuple[bytes, str]]" = collections.OrderedDict()
        self._cached = 0

    def add(self, profile: str, path: str, voice: bool = False) -> Dict[str, Any]:
        media_id = hashlib.sha256(f"{profile}\0{path}".encode()).hexdigest()[:20]
        name = posixpath.basename(path.replace("\\", "/")) or "file"
        item = {"id": media_id, "kind": kind_of(name), "name": name, "mime": mime_of(name),
                "url": f"/media/{media_id}"}
        if voice:
            item["voice"] = True
        if self.base and item["kind"] == "file":
            from urllib.parse import urlencode

            query = {"path": path, **({"profile": profile} if profile and profile != "default" else {})}
            item["link"] = f"{self.base}/api/files/download?{urlencode(query)}"
        self._items[media_id] = {"profile": profile, "path": path, **item}
        return item

    def get(self, media_id: str) -> Optional[Dict[str, Any]]:
        return self._items.get(media_id)

    async def fetch(self, http, media_id: str) -> Tuple[bytes, str]:
        """The bytes and type of one item, from the cache or from Hermes."""
        if media_id in self._cache:
            self._cache.move_to_end(media_id)
            return self._cache[media_id]
        item = self._items.get(media_id)
        if item is None:
            raise LanternError("No such picture or file.")
        from urllib.parse import urlencode

        query = {"path": item["path"]}
        if item["profile"] and item["profile"] != "default":
            query["profile"] = item["profile"]
        response = await http.raw("GET", "/api/files/download?" + urlencode(query), timeout=60,
                                  max_bytes=100_000_000, headers={"Accept": "*/*"})
        if response.status == 404:
            raise LanternError(f"Hermes no longer has {item['name']}.")
        if response.status >= 400:
            raise LanternError(f"Hermes would not send {item['name']}: {response.detail() or response.status}")
        mime = str(response.headers.get("Content-Type") or item["mime"]).split(";")[0].strip() or item["mime"]
        if mime == "application/octet-stream":
            mime = item["mime"]
        entry = (response.body, mime)
        if len(response.body) <= self.CACHE_BYTES // 4:
            self._cache[media_id] = entry
            self._cached += len(response.body)
            while self._cached > self.CACHE_BYTES and self._cache:
                _, (old, _) = self._cache.popitem(last=False)
                self._cached -= len(old)
        return entry
