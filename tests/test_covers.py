"""Cover service: uploads (validated by content), serving, Open Library fetching with SSRF guards and caching."""

from __future__ import annotations

import struct
import zlib

import httpx
import pytest
from conftest import login

from shelfwise.config import get_settings
from shelfwise.services import covers


def png(w: int = 60, h: int = 90) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x80\x40\x20" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def jpeg(w: int = 120, h: int = 180) -> bytes:
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, h, w, 1) + b"\x01\x11\x00"
    return b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + sof + b"\xff\xd9"


@pytest.fixture()
def cover_env(engine, tmp_path, monkeypatch):
    monkeypatch.setenv("SHELFWISE_MEDIA_DIR", str(tmp_path / "media"))
    monkeypatch.setenv("SHELFWISE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("SHELFWISE_COVERS_REMOTE_ENABLED", "true")
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


@pytest.fixture()
def remote(monkeypatch):
    """Route the cover service's outbound HTTP through a mock transport; records every request."""
    calls: list[str] = []
    state = {"handler": lambda req: httpx.Response(404)}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return state["handler"](request)

    real = httpx.AsyncClient
    monkeypatch.setattr(covers.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    return calls, state


# ------------------------------------------------------------------ sniffing & validation


def test_sniff_reads_type_and_dimensions():
    assert covers.sniff(png(60, 90)) == covers.Image("png", 60, 90)
    assert covers.sniff(jpeg(120, 180)) == covers.Image("jpeg", 120, 180)
    assert covers.sniff(b"GIF89a" + struct.pack("<HH", 40, 50) + b"\x00" * 10) == covers.Image("gif", 40, 50)
    assert covers.sniff(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>") is None
    assert covers.sniff(b"\x89PNG\r\n\x1a\n") is None  # truncated
    with pytest.raises(covers.CoverError):
        covers.validate(png(4, 4), 10_000)  # too small to be a cover
    with pytest.raises(covers.CoverError):
        covers.validate(png(), 100)  # over the byte limit


def test_isbn_normalisation_blocks_injection():
    assert covers.normalise_isbn("978-0-14-143951-8") == "9780141439518"
    assert covers.normalise_isbn("0-19-852663-X") == "019852663X"
    assert covers.normalise_isbn("../../etc/passwd") is None
    assert covers.normalise_isbn("123") is None


# ------------------------------------------------------------------ upload API + serving


def test_upload_replace_serve_and_delete(client, lib, make_book, cover_env):
    b, _ = make_book("Covered", isbn=None)
    staff = login(client, "librarian")
    assert client.get(f"/covers/{b.id}.jpg").status_code == 404  # no upload, no ISBN → generated cover

    r = client.post(f"/api/v1/biblios/{b.id}/cover", files={"file": ("x.png", png(), "image/png")}, headers=staff)
    assert r.status_code == 201, r.text
    assert r.json()["type"] == "image/png" and r.json()["cover"].startswith(f"/covers/{b.id}.jpg?v=")
    served = client.get(r.json()["cover"])
    assert served.status_code == 200 and served.headers["content-type"] == "image/png" and served.content == png()
    assert "immutable" in served.headers["cache-control"] and served.headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/api/v1/biblios/{b.id}", headers=staff).json()["cover"] == r.json()["cover"]

    # replacing with a JPEG removes the PNG
    assert client.post(f"/api/v1/biblios/{b.id}/cover", files={"file": ("y.jpg", jpeg(), "image/jpeg")}, headers=staff).status_code == 201
    assert sorted(p.name for p in (cover_env / "media" / "covers").iterdir()) == [f"{b.id}.jpg"]
    assert client.get(f"/covers/{b.id}.png").headers["content-type"] == "image/jpeg"  # content decides, not the URL

    assert client.delete(f"/api/v1/biblios/{b.id}/cover", headers=staff).status_code == 204
    assert client.delete(f"/api/v1/biblios/{b.id}/cover", headers=staff).status_code == 404
    assert client.get(f"/covers/{b.id}.jpg").status_code == 404


@pytest.mark.parametrize("name,data,ctype", [
    ("evil.svg", b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "image/svg+xml"),
    ("fake.png", b"MZ\x90\x00 definitely not an image", "image/png"),
    ("empty.jpg", b"", "image/jpeg"),
    ("tiny.png", png(5, 5), "image/png"),
])
def test_upload_rejects_non_images(client, lib, make_book, cover_env, name, data, ctype):
    b, _ = make_book("Rejects")
    staff = login(client, "librarian")
    r = client.post(f"/api/v1/biblios/{b.id}/cover", files={"file": (name, data, ctype)}, headers=staff)
    assert r.status_code == 422
    assert not (cover_env / "media" / "covers").exists() or not any((cover_env / "media" / "covers").iterdir())


def test_upload_size_limit_and_permissions(client, lib, make_book, cover_env, monkeypatch):
    b, _ = make_book("Limits")
    monkeypatch.setenv("SHELFWISE_COVER_UPLOAD_MAX_BYTES", "2000")
    get_settings.cache_clear()
    staff = login(client, "librarian")
    big = png(400, 600)
    assert len(big) > 2000
    assert client.post(f"/api/v1/biblios/{b.id}/cover", files={"file": ("big.png", big, "image/png")}, headers=staff).status_code == 422
    reader = login(client, "reader1")
    assert client.post(f"/api/v1/biblios/{b.id}/cover", files={"file": ("x.png", png(), "image/png")}, headers=reader).status_code == 403
    assert client.post("/api/v1/biblios/999999/cover", files={"file": ("x.png", png(), "image/png")}, headers=staff).status_code == 404


# ------------------------------------------------------------------ Open Library fetch (mocked network)


def test_remote_cover_fetched_via_allowed_redirect_and_cached(client, lib, make_book, cover_env, remote):
    calls, state = remote
    b, _ = make_book("Remote", isbn="978-0-14-143951-8")
    image = jpeg(180, 270)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "covers.openlibrary.org":
            assert req.url.path in ("/b/isbn/9780141439518-M.jpg", "/b/isbn/9780141439518-L.jpg") and req.url.params["default"] == "false"
            return httpx.Response(302, headers={"location": "https://ia800100.us.archive.org/x/0012-M.jpg"})
        return httpx.Response(200, content=image, headers={"content-type": "image/jpeg"})

    state["handler"] = handler
    r = client.get(f"/covers/{b.id}.jpg")
    assert r.status_code == 200 and r.content == image and r.headers["content-type"] == "image/jpeg"
    assert len(calls) == 2
    assert client.get(f"/covers/{b.id}.jpg").content == image and len(calls) == 2  # served from the disk cache
    assert client.get(f"/covers/{b.id}.jpg?size=L").status_code == 200 and calls[-2].endswith("-L.jpg?default=false")


@pytest.mark.parametrize("location", [
    "http://169.254.169.254/latest/meta-data/",  # cloud metadata (SSRF)
    "https://127.0.0.1/admin",
    "http://ia800100.us.archive.org/plain-http.jpg",  # downgrade to http
    "https://evil.example.org/cover.jpg",
    "https://archive.org.evil.example/cover.jpg",
    "https://user:pw@archive.org/cover.jpg",
])
def test_remote_redirects_outside_allowlist_are_refused(client, lib, make_book, cover_env, remote, location):
    calls, state = remote
    b, _ = make_book("SSRF", isbn="9780141439518")
    state["handler"] = lambda req: httpx.Response(302, headers={"location": location})
    assert client.get(f"/covers/{b.id}.jpg").status_code == 404
    assert len(calls) == 1  # the disallowed target was never contacted
    client.get(f"/covers/{b.id}.jpg")
    assert len(calls) == 1  # negatively cached


@pytest.mark.parametrize("response", [
    httpx.Response(200, content=b"<html>not an image</html>", headers={"content-type": "text/html"}),
    httpx.Response(200, content=b"<svg/>", headers={"content-type": "image/svg+xml"}),
    httpx.Response(200, content=b"GIF89a\x01\x00\x01\x00" + b"\x00" * 20, headers={"content-type": "image/gif"}),  # 1×1 "no cover"
    httpx.Response(200, content=b"\xff\xd8\xff" + b"\x00" * 50, headers={"content-type": "image/jpeg"}),  # corrupt
    httpx.Response(200, content=b"\x00" * (3 * 1024 * 1024), headers={"content-type": "image/jpeg"}),  # over the cap
    httpx.Response(404),
])
def test_remote_bad_responses_fall_back(client, lib, make_book, cover_env, remote, response):
    calls, state = remote
    b, _ = make_book("Bad remote", isbn="9780141439518")
    state["handler"] = lambda req: response
    assert client.get(f"/covers/{b.id}.jpg").status_code == 404
    assert client.get(f"/covers/{b.id}.jpg").status_code == 404 and len(calls) == 1


def test_remote_timeouts_and_disabled_lookup(client, lib, make_book, cover_env, remote, monkeypatch):
    calls, state = remote
    b, _ = make_book("Slow", isbn="9780141439518")

    def boom(req):
        raise httpx.ConnectTimeout("too slow", request=req)

    state["handler"] = boom
    assert client.get(f"/covers/{b.id}.jpg").status_code == 404
    other, _ = make_book("Offline", isbn="9780060934347")
    monkeypatch.setenv("SHELFWISE_COVERS_REMOTE_ENABLED", "false")
    get_settings.cache_clear()
    n = len(calls)
    assert client.get(f"/covers/{other.id}.jpg").status_code == 404 and len(calls) == n
    assert client.get("/covers/999999.jpg").status_code == 404
    assert client.get(f"/covers/{b.id}.exe").status_code == 404


def test_cover_field_in_search_results(client, lib, make_book, cover_env):
    with_isbn, _ = make_book("Has ISBN", isbn="9780141439518")
    without, _ = make_book("No ISBN")
    results = {r["id"]: r for r in client.get("/api/v1/search", params={"q": "isbn"}).json()["results"]}
    results.update({r["id"]: r for r in client.get("/api/v1/search", params={"q": "no"}).json()["results"]})
    assert results[with_isbn.id]["cover"] == f"/covers/{with_isbn.id}.jpg"
    assert results[without.id]["cover"] is None
