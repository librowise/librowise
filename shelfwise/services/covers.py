"""Book cover service.

``GET /covers/{biblio_id}.{ext}`` resolves a cover in this order:

1. a cover uploaded by staff (``<media_dir>/covers/<id>.<jpg|png|webp|gif>``);
2. a cached copy of the Open Library cover for the record's ISBN (``<cache_dir>/covers/``);
3. a fresh fetch from Open Library — only to ``covers.openlibrary.org`` and its archive.org image hosts,
   over HTTPS, with a short timeout, a byte cap, image content types only and verified magic bytes;
   failures are negatively cached so a missing cover costs one request per TTL, not one per page view;
4. otherwise 404, and the browser keeps the generated gradient cover (``core.js`` ``cover()``).

Uploaded covers are validated by magic bytes and header-parsed dimensions (no image library needed),
never trusted by filename or declared content type, and SVG is rejected outright (it can carry script).
"""

from __future__ import annotations

import hashlib
import logging
import re
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from ..config import get_settings

log = logging.getLogger("shelfwise.covers")

TYPES = {"jpeg": ("image/jpeg", "jpg"), "png": ("image/png", "png"), "webp": ("image/webp", "webp"), "gif": ("image/gif", "gif")}
EXT_TO_KIND = {"jpg": "jpeg", "png": "png", "webp": "webp", "gif": "gif"}
SIZES = ("M", "L")
ALLOWED_HOSTS = ("covers.openlibrary.org", "archive.org")
ALLOWED_HOST_SUFFIXES = (".archive.org",)  # Open Library redirects cover requests to archive.org storage
MIN_SIDE, MAX_SIDE = 16, 8000
MAX_REDIRECTS = 3


class CoverError(ValueError):
    """Rejected upload (bad type, too large, corrupt)."""


@dataclass(frozen=True)
class Image:
    kind: str  # jpeg | png | webp | gif
    width: int
    height: int

    @property
    def content_type(self) -> str:
        return TYPES[self.kind][0]

    @property
    def ext(self) -> str:
        return TYPES[self.kind][1]


# ------------------------------------------------------------------ image sniffing


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    i = 2
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if marker == 0xFF:
            i += 1
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    return None


def sniff(data: bytes) -> Image | None:
    """Identify an image by its magic bytes and read its dimensions from the header."""
    try:
        if data[:3] == b"\xff\xd8\xff":
            size = _jpeg_size(data)
            return Image("jpeg", *size) if size else None
        if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
            w, h = struct.unpack(">II", data[16:24])
            return Image("png", w, h)
        if data[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", data[6:10])
            return Image("gif", w, h)
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return Image("webp", w & 0x3FFF, h & 0x3FFF)
            if chunk == b"VP8L":
                b = data[21:25]
                w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                h = 1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                return Image("webp", w, h)
            if chunk == b"VP8X":
                w = 1 + int.from_bytes(data[24:27], "little")
                h = 1 + int.from_bytes(data[27:30], "little")
                return Image("webp", w, h)
    except (struct.error, IndexError, TypeError):
        return None
    return None


def validate(data: bytes, max_bytes: int) -> Image:
    if not data:
        raise CoverError("The file is empty")
    if len(data) > max_bytes:
        raise CoverError(f"Cover images must be {max_bytes // (1024 * 1024)} MB or smaller")
    img = sniff(data)
    if img is None:
        raise CoverError("Upload a JPEG, PNG, WebP or GIF image")
    if not (MIN_SIDE <= img.width <= MAX_SIDE and MIN_SIDE <= img.height <= MAX_SIDE):
        raise CoverError(f"Images must be between {MIN_SIDE} and {MAX_SIDE} pixels on each side")
    return img


# ------------------------------------------------------------------ storage


def _media_dir() -> Path:
    return Path(get_settings().media_dir) / "covers"


def _cache_dir() -> Path:
    return Path(get_settings().cache_dir) / "covers"


def uploaded_path(biblio_id: int) -> Path | None:
    base = _media_dir()
    for ext in EXT_TO_KIND:
        p = base / f"{int(biblio_id)}.{ext}"
        if p.is_file():
            return p
    return None


def uploaded_version(biblio_id: int) -> int | None:
    p = uploaded_path(biblio_id)
    return int(p.stat().st_mtime) if p else None


def save_upload(biblio_id: int, data: bytes) -> Image:
    img = validate(data, get_settings().cover_upload_max_bytes)
    base = _media_dir()
    base.mkdir(parents=True, exist_ok=True)
    remove_upload(biblio_id)
    target = base / f"{int(biblio_id)}.{img.ext}"
    tmp = target.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(target)
    return img


def remove_upload(biblio_id: int) -> bool:
    removed = False
    for ext in EXT_TO_KIND:
        p = _media_dir() / f"{int(biblio_id)}.{ext}"
        if p.is_file():
            p.unlink()
            removed = True
    return removed


def normalise_isbn(isbn: str | None) -> str | None:
    if not isbn:
        return None
    digits = re.sub(r"[^0-9Xx]", "", isbn).upper()
    return digits if re.fullmatch(r"\d{9}[\dX]|\d{13}", digits) else None


def cover_src(biblio) -> str | None:
    """URL the browser should try for ``biblio``'s cover (None when there cannot be one)."""
    version = uploaded_version(biblio.id)
    if version:
        return f"/covers/{biblio.id}.jpg?v={version}"
    if normalise_isbn(biblio.isbn) or _allowed(biblio.cover_url or ""):
        return f"/covers/{biblio.id}.jpg"
    return None


# ------------------------------------------------------------------ remote fetch (SSRF-safe)


def _allowed(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
        return False
    return host in ALLOWED_HOSTS or any(host.endswith(s) for s in ALLOWED_HOST_SUFFIXES)


def _cache_paths(key: str) -> tuple[Path, Path]:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", key)
    return _cache_dir() / f"{safe}.img", _cache_dir() / f"{safe}.miss"


def cached(key: str) -> tuple[bytes | None, bool]:
    """(image bytes, known-missing) from the disk cache."""
    img, miss = _cache_paths(key)
    if img.is_file():
        return img.read_bytes(), False
    if miss.is_file():
        try:
            until = float(miss.read_text() or 0)
        except (OSError, ValueError):
            until = 0
        if until > time.time():
            return None, True
        miss.unlink(missing_ok=True)
    return None, False


def _remember(key: str, data: bytes | None, ttl: float) -> None:
    img, miss = _cache_paths(key)
    try:
        img.parent.mkdir(parents=True, exist_ok=True)
        if data is None:
            miss.write_text(str(time.time() + ttl))
        else:
            tmp = img.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.replace(img)
    except OSError as exc:  # pragma: no cover - read-only cache directory
        log.warning("cover cache write failed: %s", exc)


async def _download(url: str, client: httpx.AsyncClient, max_bytes: int) -> bytes | None:
    for _ in range(MAX_REDIRECTS + 1):
        if not _allowed(url):
            log.info("cover fetch refused for %s", url)
            return None
        async with client.stream("GET", url) as resp:
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location", "")
                url = str(httpx.URL(url).join(location))
                continue
            if resp.status_code != 200:
                return None
            ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            if ctype not in {v[0] for v in TYPES.values()}:
                return None
            declared = resp.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                return None
            buf = bytearray()
            async for chunk in resp.aiter_bytes():
                buf += chunk
                if len(buf) > max_bytes:
                    return None
            return bytes(buf)
    return None


def remote_url(biblio, size: str) -> str | None:
    isbn = normalise_isbn(biblio.isbn)
    if isbn:
        return f"https://covers.openlibrary.org/b/isbn/{isbn}-{size}.jpg?default=false"
    if biblio.cover_url and _allowed(biblio.cover_url):
        return biblio.cover_url
    return None


async def fetch_remote(biblio, size: str = "M", *, client: httpx.AsyncClient | None = None) -> tuple[bytes, Image] | None:
    """Cached Open Library cover for ``biblio`` (fetching it on a cache miss), or None."""
    s = get_settings()
    url = remote_url(biblio, size)
    if url is None:
        return None
    key = f"isbn-{normalise_isbn(biblio.isbn)}-{size}" if normalise_isbn(biblio.isbn) else f"url-{hashlib.sha256(url.encode()).hexdigest()[:24]}-{size}"
    data, missing = cached(key)
    if data is not None:
        img = sniff(data)
        return (data, img) if img else None
    if missing or not s.covers_remote_enabled:
        return None
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(s.covers_fetch_timeout), follow_redirects=False,
                                         headers={"User-Agent": "Shelfwise ILS cover service"})
    try:
        data = await _download(url, client, s.covers_remote_max_bytes)
    except (httpx.HTTPError, OSError) as exc:
        log.info("cover fetch failed for %s: %s", url, exc)
        _remember(key, None, min(3600, s.covers_negative_ttl))  # transient: retry within the hour
        return None
    finally:
        if own:
            await client.aclose()
    img = sniff(data) if data else None
    if img is None or img.width < MIN_SIDE or img.height < MIN_SIDE:  # Open Library's 1×1 "no cover" pixel
        _remember(key, None, s.covers_negative_ttl)
        return None
    _remember(key, data, 0)
    return data, img
