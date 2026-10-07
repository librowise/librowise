"""HTML page routes. Pages are thin shells; data comes from the JSON API, so the web UI and
third-party integrations exercise exactly the same endpoints."""

from __future__ import annotations

import hashlib
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from . import __version__
from . import i18n as i18n_mod
from .config import BASE_DIR
from .db import get_db
from .deps import optional_user
from .models import Patron
from .security import has_permission
from .services import settings as settings_svc

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
i18n_mod.install(templates)
router = APIRouter(include_in_schema=False)

STAFF_NAV = [
    ("dashboard", "/staff", "Dashboard", "home"),
    ("circulation", "/staff/circulation", "Circulation", "repeat"),
    ("catalog", "/staff/catalog", "Catalogue", "book"),
    ("patrons", "/staff/patrons", "Patrons", "users"),
    ("holds", "/staff/holds", "Holds", "bookmark"),
    ("acquisitions", "/staff/acquisitions", "Acquisitions", "cart"),
    ("reports", "/staff/reports", "Reports", "chart"),
    ("analytics", "/staff/analytics", "Analytics", "trend"),
    ("insights", "/staff/insights", "AI Insights", "sparkle"),
    ("kiosks", "/staff/kiosks", "Kiosks", "monitor"),
    ("admin", "/staff/admin", "Administration", "settings"),
]


def _render(request: Request, template: str, page: str, user: Patron | None, db: Session, **ctx) -> HTMLResponse:
    lang = i18n_mod.request_language(request, user)
    response = templates.TemplateResponse(request, template, {
        "page": page, "user": user, "version": __version__,
        "library_name": settings_svc.get(db, "library_name"),
        "announcement": settings_svc.get(db, "opac_announcement"),
        "staff_nav": STAFF_NAV,
        "lang": lang, "dir": i18n_mod.text_direction(lang), "languages": i18n_mod.languages(),
        "i18n_boot": {"lang": lang, "dir": i18n_mod.text_direction(lang), "languages": i18n_mod.languages(),
                      "messages": i18n_mod.merged(lang)},
        **ctx,
    })
    if i18n_mod.normalise(request.query_params.get("lang")):
        response.set_cookie(i18n_mod.LANG_COOKIE, lang, max_age=31536000, samesite="lax", path="/")
    if user is not None:
        # Personalised pages must never be stored by shared caches or the offline service worker.
        response.headers["Cache-Control"] = "private, no-store"
    response.headers["Content-Language"] = lang
    response.headers["Vary"] = "Accept-Language, Cookie"
    return response


# ------------------------------------------------------------------ OPAC


@router.get("/", response_class=HTMLResponse)
def opac_home(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    return _render(request, "opac/home.html", "opac-home", user, db)


@router.get("/search", response_class=HTMLResponse)
def opac_search(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    return _render(request, "opac/search.html", "opac-search", user, db, q=request.query_params.get("q", ""))


@router.get("/record/{biblio_id}", response_class=HTMLResponse)
def opac_record(biblio_id: int, request: Request, db: Session = Depends(get_db),
                user: Patron | None = Depends(optional_user)):
    return _render(request, "opac/record.html", "opac-record", user, db, biblio_id=biblio_id)


@router.get("/account", response_class=HTMLResponse)
def opac_account(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    if user is None:
        return RedirectResponse("/login?next=/account", status_code=303)
    return _render(request, "opac/account.html", "opac-account", user, db)


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    return _render(request, "login.html", "login", user, db)


# ------------------------------------------------------------------ staff


def _staff(page: str, template: str):
    def view(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
        if user is None:
            return RedirectResponse(f"/login?next={request.url.path}", status_code=303)
        if not has_permission(user, "catalog:read"):
            return RedirectResponse("/account", status_code=303)
        return _render(request, template, page, user, db, path_params=request.path_params)

    return view


for _key, _path, _label, _icon in STAFF_NAV:
    router.add_api_route(_path, _staff(f"staff-{_key}", f"staff/{_key}.html"), methods=["GET"],
                         response_class=HTMLResponse)
router.add_api_route("/staff/catalog/new", _staff("staff-record-edit", "staff/record_edit.html"), methods=["GET"])
router.add_api_route("/staff/catalog/{biblio_id}", _staff("staff-record", "staff/record.html"), methods=["GET"])
router.add_api_route("/staff/catalog/{biblio_id}/edit", _staff("staff-record-edit", "staff/record_edit.html"), methods=["GET"])
router.add_api_route("/staff/patrons/{patron_id}", _staff("staff-patron", "staff/patron.html"), methods=["GET"])


# ------------------------------------------------------------------ experience: kiosk, PWA


@router.get("/kiosk", response_class=HTMLResponse)
def kiosk_page(request: Request, db: Session = Depends(get_db)):
    """Self-checkout station. Rendered without a signed-in user: the kiosk authenticates with its own
    device token and short-lived patron sessions (see api/kiosk.py), never with staff cookies."""
    response = _render(request, "kiosk.html", "kiosk", None, db)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/offline", response_class=HTMLResponse)
def offline_page(request: Request, db: Session = Depends(get_db)):
    """Fallback shown by the service worker when a page cannot be fetched (never personalised)."""
    return _render(request, "offline.html", "offline", None, db)


@router.get("/manifest.webmanifest")
def web_manifest(request: Request, db: Session = Depends(get_db)):
    lang = i18n_mod.request_language(request)
    name = settings_svc.get(db, "library_name") or "Shelfwise"
    tr = lambda key: i18n_mod.translate(lang, key)  # noqa: E731
    manifest = {
        "id": "/", "name": name, "short_name": name if len(name) <= 12 else (name.split()[0][:12] or "Library"),
        "description": i18n_mod.translate(lang, "meta.description", library=name),
        "lang": lang, "dir": i18n_mod.text_direction(lang),
        "start_url": "/?source=pwa", "scope": "/", "display": "standalone", "display_override": ["standalone", "minimal-ui"],
        "orientation": "any", "background_color": "#f6f7f9", "theme_color": "#0f766e", "categories": ["books", "education"],
        "icons": [
            {"src": "/static/icons/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"},
            {"src": "/static/icons/maskable.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": tr("pwa.shortcut_search"), "url": "/search", "icons": [{"src": "/static/icons/icon.svg", "sizes": "any"}]},
            {"name": tr("pwa.shortcut_account"), "url": "/account", "icons": [{"src": "/static/icons/icon.svg", "sizes": "any"}]},
        ],
    }
    return Response(json.dumps(manifest, ensure_ascii=False), media_type="application/manifest+json",
                    headers={"Cache-Control": "no-cache", "Vary": "Accept-Language, Cookie"})


def static_build_id() -> str:
    """Fingerprint of every static asset, so a new deploy (or edit) installs a new service worker
    whose activation deletes the previous version's caches."""
    digest = hashlib.sha256(__version__.encode())
    root = BASE_DIR / "static"
    for path in sorted(root.rglob("*")):
        if path.is_file():
            st = path.stat()
            digest.update(f"{path.relative_to(root).as_posix()}:{st.st_size}:{st.st_mtime_ns}".encode())
    for name in ("i18n",):
        for path in sorted((BASE_DIR / name).glob("*.json")):
            st = path.stat()
            digest.update(f"{name}/{path.name}:{st.st_size}:{st.st_mtime_ns}".encode())
    return digest.hexdigest()[:12]


@router.get("/sw.js")
def service_worker():
    """The OPAC service worker, served from the site root so its scope covers every page."""
    source = (BASE_DIR / "static" / "js" / "sw.js").read_text(encoding="utf-8")
    source = source.replace("__BUILD__", static_build_id()).replace("__VERSION__", __version__)
    return Response(source, media_type="text/javascript; charset=utf-8",
                    headers={"Cache-Control": "no-cache, max-age=0", "Service-Worker-Allowed": "/"})
