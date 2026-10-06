"""HTML page routes. Pages are thin shells; data comes from the JSON API, so the web UI and
third-party integrations exercise exactly the same endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from . import __version__
from .config import BASE_DIR
from .db import get_db
from .deps import optional_user
from .models import Patron
from .security import has_permission
from .services import settings as settings_svc

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
router = APIRouter(include_in_schema=False)

STAFF_NAV = [
    ("dashboard", "/staff", "Dashboard", "home"),
    ("circulation", "/staff/circulation", "Circulation", "repeat"),
    ("catalog", "/staff/catalog", "Catalogue", "book"),
    ("patrons", "/staff/patrons", "Patrons", "users"),
    ("holds", "/staff/holds", "Holds", "bookmark"),
    ("acquisitions", "/staff/acquisitions", "Acquisitions", "cart"),
    ("reports", "/staff/reports", "Reports", "chart"),
    ("insights", "/staff/insights", "AI Insights", "sparkle"),
    ("admin", "/staff/admin", "Administration", "settings"),
]


def _render(request: Request, template: str, page: str, user: Patron | None, db: Session, **ctx) -> HTMLResponse:
    return templates.TemplateResponse(request, template, {
        "page": page, "user": user, "version": __version__,
        "library_name": settings_svc.get(db, "library_name"),
        "announcement": settings_svc.get(db, "opac_announcement"),
        "staff_nav": STAFF_NAV, **ctx,
    })


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

# ---- interoperability (SRU, OAI-PMH, copy cataloguing, SIP2 administration) ----
from .interop import oai as _oai  # noqa: E402
from .interop import sru as _sru  # noqa: E402

router.include_router(_sru.router)
router.include_router(_oai.router)
STAFF_NAV.append(("copycat", "/staff/copycat", "Copy cataloguing", "download"))
STAFF_NAV.append(("interop", "/staff/interop", "Interoperability", "globe"))
router.add_api_route("/staff/copycat", _staff("staff-copycat", "staff/copycat.html"), methods=["GET"],
                     response_class=HTMLResponse)
router.add_api_route("/staff/interop", _staff("staff-interop", "staff/interop.html"), methods=["GET"],
                     response_class=HTMLResponse)
