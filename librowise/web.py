"""HTML page routes. Pages are thin shells; data comes from the JSON API, so the web UI and
third-party integrations exercise exactly the same endpoints."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

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
from .security import RESTRICTED_ATTR, has_permission
from .services import settings as settings_svc

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
i18n_mod.install(templates)
# The product brand shown in the UI (sidebar wordmark, footers, manifest fallback). The library's own name
# comes from the ``library_name`` setting; code identifiers (package, env vars, cookies) are unaffected.
PRODUCT_NAME = "Librowise"
templates.env.globals["product_name"] = PRODUCT_NAME
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

# ---- staff information architecture -----------------------------------------------------------------
# STAFF_NAV lists every staff *page* (key, URL, label, icon) and drives routing. The sidebar does not show
# pages directly: it shows at most nine HUBS, and the pages of a hub appear as the hub's tab bar (rendered
# by staff_base.html from staff_shell()). To add a page: append it to STAFF_NAV, give it a permission in
# NAV_PERMISSIONS and put its key in one hub's ``tabs``. Keys that no hub claims land in a "More" hub so a
# new page is never unreachable. Detail pages (record, patron, MARC editor…) map onto their list page's
# tab through PAGE_TABS so the right hub and tab are highlighted and the breadcrumb is complete.


@dataclass(frozen=True)
class Hub:
    id: str
    label: str
    icon: str
    tabs: tuple[str, ...]


HUBS: list[Hub] = [
    Hub("home", "Home", "home", ("dashboard",)),
    Hub("circulation", "Circulation", "repeat", ("circulation", "holds", "calendar", "kiosks")),
    Hub("catalogue", "Catalogue", "book", ("catalog", "authorities", "copycat", "labels", "batch")),
    Hub("acquisitions", "Acquisitions", "cart", ("acquisitions", "serials")),
    Hub("patrons", "Patrons", "users", ("patrons", "requests", "notices")),
    Hub("courses", "Course reserves", "list", ("courses",)),
    Hub("insights", "Insights", "chart", ("reports", "analytics", "insights")),
    Hub("administration", "Administration", "settings", ("admin", "roles", "system", "interop")),
]
MAX_HUBS = 9  # Alt+1…9; enforced by tests

# Labels used on hub tabs when they differ from the page's own nav label (translated via nav.tab.<key>).
TAB_LABELS: dict[str, str] = {
    "dashboard": "Today", "circulation": "Desk", "catalog": "Records", "acquisitions": "Orders & budgets",
    "patrons": "Patrons", "requests": "Requests", "admin": "Settings", "insights": "AI insights",
    "batch": "Batch & inventory",
}

# page id → (tab key, breadcrumb label of the detail page)
PAGE_TABS: dict[str, tuple[str, str]] = {
    "staff-record": ("catalog", "Record"),
    "staff-record-edit": ("catalog", "Edit record"),
    "staff-marc-editor": ("catalog", "MARC editor"),
    "staff-patron": ("patrons", "Patron"),
    "staff-labels-print": ("labels", "Print"),
}

NAV_PERMISSIONS: dict[str, str] = {
    "dashboard": "catalog:read", "circulation": "circulation", "holds": "holds:manage", "kiosks": "kiosks:manage",
    "calendar": "calendar:manage", "catalog": "catalog:read", "copycat": "catalog:write",
    "acquisitions": "acquisitions:read", "serials": "serials:read", "courses": "courses:read",
    "patrons": "patrons:read", "requests": "patrons:approve", "notices": "notices:outbox",
    "reports": "reports:read", "analytics": "analytics:read", "insights": "reports:read",
    "roles": "patrons:manage_staff", "interop": "catalog:read", "system": "jobs:manage", "admin": "admin",
    "authorities": "catalog:read", "labels": "labels", "batch": "items:batch",
}


def _all_hubs() -> list[Hub]:
    claimed = {key for hub in HUBS for key in hub.tabs}
    orphans = tuple(key for key, *_ in STAFF_NAV if key not in claimed)
    return [*HUBS, Hub("more", "More", "list", orphans)] if orphans else list(HUBS)


def page_tab(page: str) -> tuple[str | None, str | None]:
    """(tab key, detail breadcrumb) for a staff page id such as ``staff-patrons`` or ``staff-record``."""
    if page in PAGE_TABS:
        return PAGE_TABS[page]
    key = page.removeprefix("staff-")
    return (key, None) if any(k == key for k, *_ in STAFF_NAV) else (None, None)


def staff_hubs(user: Patron | None) -> list[dict]:
    """The sidebar for ``user``: permission-filtered hubs (≤ 9, Alt+N index) with their visible tabs."""
    entries = {key: (href, label, icon) for key, href, label, icon in STAFF_NAV}
    visible = lambda key: user is not None and has_permission(user, NAV_PERMISSIONS.get(key, "catalog:read"))  # noqa: E731
    hubs = []
    for hub in _all_hubs():
        tabs = [{"key": k, "href": entries[k][0], "label": TAB_LABELS.get(k, entries[k][1]), "nav_label": entries[k][1],
                 "icon": entries[k][2]} for k in hub.tabs if k in entries and visible(k)]
        if tabs:
            hubs.append({"id": hub.id, "label": hub.label, "icon": hub.icon, "href": tabs[0]["href"], "tabs": tabs,
                         "index": len(hubs) + 1})
    return hubs


def staff_shell(user: Patron | None, page: str) -> dict:
    """Everything staff_base.html needs: hubs, the current hub/tab and the breadcrumb trail."""
    hubs = staff_hubs(user)
    tab_key, detail = page_tab(page)
    current = next((h for h in hubs if any(t["key"] == tab_key for t in h["tabs"])), None)
    tab = next((t for t in current["tabs"] if t["key"] == tab_key), None) if current else None
    crumbs = []
    if current:
        crumbs.append({"label": current["label"], "href": current["href"], "key": f"nav.hub.{current['id']}"})
        if tab and len(current["tabs"]) > 1 and tab["label"] != current["label"]:
            crumbs.append({"label": tab["label"], "href": tab["href"], "key": f"nav.tab.{tab['key']}"})
    return {"hubs": hubs, "hub": current, "tab": tab, "crumbs": crumbs, "detail": detail,
            "detail_key": f"nav.detail.{page.removeprefix('staff-').replace('-', '_')}" if detail else None}


def staff_nav_groups(user: Patron | None) -> list[dict]:
    """Backwards-compatible view of the hubs as sidebar groups (one group per hub)."""
    return [{"id": h["id"], "title": h["label"], "items": [
        {"key": t["key"], "href": t["href"], "label": t["nav_label"], "icon": t["icon"], "index": h["index"]}
        for t in h["tabs"]]} for h in staff_hubs(user)]


def _render(request: Request, template: str, page: str, user: Patron | None, db: Session, **ctx) -> HTMLResponse:
    lang = i18n_mod.request_language(request, user)
    response = templates.TemplateResponse(request, template, {
        "page": page, "user": user, "version": __version__,
        "library_name": settings_svc.get(db, "library_name"),
        "announcement": settings_svc.get(db, "opac_announcement"),
        "staff_nav": STAFF_NAV,
        "shell": staff_shell(user, page) if page.startswith("staff") else None,
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
    from .interop.jsonld import record_metadata

    # Server-rendered schema.org JSON-LD + Open Graph tags so search engines and link previews
    # see the record without running JavaScript.
    seo = record_metadata(db, biblio_id, base_url=str(request.base_url),
                          library_name=settings_svc.get(db, "library_name"))
    response = _render(request, "opac/record.html", "opac-record", user, db, biblio_id=biblio_id, seo=seo)
    if seo is None:
        response.status_code = 404
    return response


@router.get("/account", response_class=HTMLResponse)
def opac_account(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    if user is None:
        return RedirectResponse("/login?next=/account", status_code=303)
    return _render(request, "opac/account.html", "opac-account", user, db)


def _show_demo_logins() -> bool:
    """The seeded demo accounts are offered on the login page everywhere except production."""
    from .config import get_settings

    return get_settings().environment != "production"


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    demo_logins = None
    if _show_demo_logins():
        from .seed import DEMO_ACCOUNTS

        demo_logins = [(key, user_name, DEMO_ACCOUNTS[user_name])
                       for key, user_name in (("admin", "admin"), ("librarian", "librarian"), ("patron", "1000000001"))]
    return _render(request, "login.html", "login", user, db, demo_logins=demo_logins)


# ------------------------------------------------------------------ staff


def _staff(page: str, template: str):
    def view(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
        if user is None:
            return RedirectResponse(f"/login?next={request.url.path}", status_code=303)
        if getattr(user, RESTRICTED_ATTR, False):  # staff must enrol in 2FA first (security policy)
            return RedirectResponse("/staff/security?enroll=1", status_code=303)
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

# ---- circulation services ----
for _key, _path, _label, _icon in [
    ("calendar", "/staff/calendar", "Calendar", "clock"),
    ("notices", "/staff/notices", "Notices", "send"),
    ("requests", "/staff/requests", "Patron requests", "inbox"),
]:
    STAFF_NAV.insert(len(STAFF_NAV) - 1, (_key, _path, _label, _icon))  # keep Administration last
    router.add_api_route(_path, _staff(f"staff-{_key}", f"staff/{_key}.html"), methods=["GET"],
                         response_class=HTMLResponse)


@router.get("/register", response_class=HTMLResponse)
def opac_register(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    if user is not None:
        return RedirectResponse("/account", status_code=303)
    return _render(request, "opac/register.html", "opac-register", user, db,
                   registration_enabled=bool(settings_svc.get(db, "allow_self_registration")))


# ---- serials & course reserves ----
for _entry in [("serials", "/staff/serials", "Serials", "inbox"), ("courses", "/staff/courses", "Course reserves", "list")]:
    STAFF_NAV.insert(len(STAFF_NAV) - 1, _entry)  # keep Administration last
router.add_api_route("/staff/serials", _staff("staff-serials", "staff/serials.html"), methods=["GET"],
                     response_class=HTMLResponse)
router.add_api_route("/staff/serials/claims/{batch}", _staff("staff-serials", "staff/serial_claims.html"), methods=["GET"])
router.add_api_route("/staff/serials/{subscription_id}", _staff("staff-serials", "staff/serial.html"), methods=["GET"])
router.add_api_route("/staff/courses", _staff("staff-courses", "staff/courses.html"), methods=["GET"],
                     response_class=HTMLResponse)
router.add_api_route("/staff/courses/{course_id}", _staff("staff-courses", "staff/course.html"), methods=["GET"])


@router.get("/courses", response_class=HTMLResponse)
def opac_courses(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    return _render(request, "opac/courses.html", "opac-courses", user, db, path_params={})


@router.get("/courses/{course_id}", response_class=HTMLResponse)
def opac_course(course_id: int, request: Request, db: Session = Depends(get_db),
                user: Patron | None = Depends(optional_user)):
    return _render(request, "opac/courses.html", "opac-courses", user, db, path_params={"course_id": course_id})


# ------------------------------------------------------------------ identity & access

templates.env.globals["can"] = has_permission
STAFF_NAV.insert(len(STAFF_NAV) - 1, ("roles", "/staff/roles", "Roles & permissions", "shield"))
router.add_api_route("/staff/roles", _staff("staff-roles", "staff/roles.html"), methods=["GET"],
                     response_class=HTMLResponse)


@router.get("/staff/security", response_class=HTMLResponse)
def staff_security(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    """My account / Security. Reachable even while 2FA enrolment is pending (enforced by policy)."""
    if user is None:
        return RedirectResponse("/login?next=/staff/security", status_code=303)
    if not user.is_staff:
        return RedirectResponse("/account#settings", status_code=303)
    return _render(request, "staff/security.html", "staff-security", user, db, path_params={})


@router.get("/reset-password", response_class=HTMLResponse)
def reset_password_page(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    return _render(request, "reset_password.html", "reset-password", user, db)

# ---- interoperability (SRU, OAI-PMH, copy cataloguing, SIP2 administration) ----
from .interop import oai as _oai  # noqa: E402
from .interop import sru as _sru  # noqa: E402

router.include_router(_sru.router)
router.include_router(_oai.router)
STAFF_NAV.insert(len(STAFF_NAV) - 1, ("copycat", "/staff/copycat", "Copy cataloguing", "download"))
STAFF_NAV.insert(len(STAFF_NAV) - 1, ("interop", "/staff/interop", "Interoperability", "globe"))
router.add_api_route("/staff/copycat", _staff("staff-copycat", "staff/copycat.html"), methods=["GET"],
                     response_class=HTMLResponse)
router.add_api_route("/staff/interop", _staff("staff-interop", "staff/interop.html"), methods=["GET"],
                     response_class=HTMLResponse)


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
    name = settings_svc.get(db, "library_name") or PRODUCT_NAME
    tr = lambda key: i18n_mod.translate(lang, key)  # noqa: E731
    manifest = {
        "id": "/", "name": name, "short_name": name if len(name) <= 12 else (name.split()[0][:12] or "Library"),
        "description": i18n_mod.translate(lang, "meta.description", library=name),
        "lang": lang, "dir": i18n_mod.text_direction(lang),
        "start_url": "/?source=pwa", "scope": "/", "display": "standalone", "display_override": ["standalone", "minimal-ui"],
        "orientation": "any", "background_color": "#f6f7f9", "theme_color": "#4338ca", "categories": ["books", "education"],
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
        for path in sorted((BASE_DIR / name).rglob("*.json")):  # includes per-area fragments
            st = path.stat()
            digest.update(f"{name}/{path.relative_to(BASE_DIR / name).as_posix()}:{st.st_size}:{st.st_mtime_ns}".encode())
    return digest.hexdigest()[:12]


@router.get("/sw.js")
def service_worker():
    """The OPAC service worker, served from the site root so its scope covers every page."""
    source = (BASE_DIR / "static" / "js" / "sw.js").read_text(encoding="utf-8")
    source = source.replace("__BUILD__", static_build_id()).replace("__VERSION__", __version__)
    return Response(source, media_type="text/javascript; charset=utf-8",
                    headers={"Cache-Control": "no-cache, max-age=0", "Service-Worker-Allowed": "/"})


# ---- platform & operations ----
# System page: administrators only (jobs:manage). Registered after the generic staff loop so
# it gets its own permission check; the nav entry is hidden for other roles in staff_base.html.
STAFF_NAV.insert(len(STAFF_NAV) - 1, ("system", "/staff/system", "System", "clock"))


@router.get("/staff/system", response_class=HTMLResponse)
def staff_system(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    if user is None:
        return RedirectResponse(f"/login?next={request.url.path}", status_code=303)
    if not has_permission(user, "jobs:manage"):
        return RedirectResponse("/staff" if has_permission(user, "catalog:read") else "/account", status_code=303)
    return _render(request, "staff/system.html", "staff-system", user, db, path_params=request.path_params)


# ---- cataloguing: authorities, MARC editor, labels, batch tools ----

_CATALOGUING_NAV = [
    ("authorities", "/staff/authorities", "Authorities", "list"),
    ("labels", "/staff/labels", "Labels & cards", "barcode"),
    ("batch", "/staff/batch", "Batch & inventory", "filter"),
]
for _entry in _CATALOGUING_NAV:
    STAFF_NAV.insert(len(STAFF_NAV) - 1, _entry)  # keep Administration last
for _key, _path, _label, _icon in _CATALOGUING_NAV:
    router.add_api_route(_path, _staff(f"staff-{_key}", f"staff/{_key}.html"), methods=["GET"],
                         response_class=HTMLResponse)
router.add_api_route("/staff/catalog/{biblio_id}/marc", _staff("staff-marc-editor", "staff/marc_editor.html"),
                     methods=["GET"])


@router.api_route("/staff/labels/print", methods=["GET", "POST"], response_class=HTMLResponse)
async def labels_print(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    """Printable label/card sheets. Read-only, so a plain form POST (no CSRF token) is fine."""
    from starlette.concurrency import run_in_threadpool

    from .errors import DomainError
    from .services import labels as labels_svc

    if user is None:
        return RedirectResponse(f"/login?next={request.url.path}", status_code=303)
    params = dict(request.query_params)
    if request.method == "POST":
        params.update({k: v for k, v in (await request.form()).items() if isinstance(v, str)})
    needed = "patrons:read" if params.get("kind") == "patron" else "catalog:read"
    job, error = None, None
    if not (has_permission(user, "labels") and has_permission(user, needed)):
        error = "You do not have permission to print these labels."
    else:
        try:
            job = await run_in_threadpool(labels_svc.build, db, params)  # SVG rendering is CPU-bound
            db.commit()
        except DomainError as exc:
            error = exc.message
    return _render(request, "staff/labels_print.html", "staff-labels-print", user, db, job=job, error=error)


@router.get("/staff/styleguide", response_class=HTMLResponse)
def staff_styleguide(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    """Living style guide: every design-system component in every state (any staff member)."""
    return _staff("staff-styleguide", "staff/styleguide.html")(request, db, user)


# ---- book covers: uploaded → cached Open Library → 404 (the browser keeps the generated cover) ----


@router.get("/covers/{biblio_id:int}.{ext}", include_in_schema=False)
async def cover_image(biblio_id: int, ext: str, size: str = "M", v: str | None = None, db: Session = Depends(get_db)):
    from .models import Biblio
    from .services import covers

    missing = Response(status_code=404, headers={"Cache-Control": "public, max-age=3600"})
    if ext.lower() not in ("jpg", "jpeg", "png", "webp", "gif"):
        return missing
    size = size.upper() if size.upper() in covers.SIZES else "M"
    if path := covers.uploaded_path(biblio_id):
        data = path.read_bytes()
        img = covers.sniff(data)
        if img is None:  # pragma: no cover - validated on upload
            return missing
        # Versioned URLs (?v=mtime) never change; unversioned ones revalidate daily.
        cache = "public, max-age=31536000, immutable" if v else "public, max-age=86400"
        return Response(data, media_type=img.content_type, headers={"Cache-Control": cache})
    biblio = db.get(Biblio, biblio_id)
    if biblio is None or biblio.deleted_at is not None:
        return missing
    found = await covers.fetch_remote(biblio, size)
    if found is None:
        return missing
    data, img = found
    return Response(data, media_type=img.content_type, headers={"Cache-Control": "public, max-age=604800"})


@router.get("/browse", response_class=HTMLResponse)
def opac_browse(request: Request, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    return _render(request, "opac/browse.html", "opac-browse", user, db)
