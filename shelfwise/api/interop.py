"""Interoperability administration: SIP2 accounts, copy-cataloguing targets and the
copy-cataloguing search/import workflow."""

from __future__ import annotations

import codecs
import ipaddress

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import client_ip, require
from ..errors import NotFound
from ..interop import copycat
from ..models import Branch, CopyCatTarget, Patron, SipAccount
from ..schemas import biblio_out
from ..security import hash_password, password_problems
from ..services import audit

router = APIRouter(tags=["interoperability"])
MANAGE = require("interop:manage")  # administrators only (not granted to librarians)

ENCODINGS = ("utf-8", "ascii", "latin-1", "cp850", "cp1252", "iso-8859-15")
SORT_BIN_KEYS = ("hold", "transfer", "default")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ------------------------------------------------------------------ SIP2 accounts


class SipAccountIn(_Strict):
    login: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str | None = Field(default=None, max_length=256)
    name: str | None = Field(default=None, max_length=120)
    institution_id: str = Field(default="SHELFWISE", min_length=1, max_length=64)
    branch_id: int
    is_active: bool = True
    delimiter: str = Field(default="|", min_length=1, max_length=1)
    encoding: str = "utf-8"
    error_detection: bool = False
    idle_timeout: int = Field(default=600, ge=30, le=86400)
    allowed_networks: str | None = Field(default=None, max_length=500)
    allow_checkout: bool = True
    allow_checkin: bool = True
    allow_renew: bool = True
    allow_patron_info: bool = True
    allow_holds: bool = False
    allow_fee_paid: bool = False
    allow_block_patron: bool = True
    require_patron_password: bool = False
    checked_in_ok: bool = True
    sort_bins: dict[str, str] = Field(default_factory=dict)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("delimiter")
    @classmethod
    def _delimiter(cls, v: str) -> str:
        if v.isalnum() or v in "\r\n ":
            raise ValueError("must be a punctuation character such as |")
        return v

    @field_validator("institution_id")
    @classmethod
    def _institution(cls, v: str) -> str:
        if any(c in v for c in "|\r\n^"):
            raise ValueError("must not contain delimiter or line-break characters")
        return v

    @field_validator("encoding")
    @classmethod
    def _encoding(cls, v: str) -> str:
        v = v.lower()
        if v not in ENCODINGS:
            raise ValueError(f"must be one of {', '.join(ENCODINGS)}")
        codecs.lookup(v)
        return v

    @field_validator("allowed_networks")
    @classmethod
    def _networks(cls, v: str | None) -> str | None:
        if not v:
            return None
        parts = [p.strip() for p in v.split(",") if p.strip()]
        for p in parts:
            try:
                ipaddress.ip_network(p, strict=False)
            except ValueError:
                raise ValueError(f"'{p}' is not an IP address or CIDR network") from None
        return ", ".join(parts) or None

    @field_validator("sort_bins")
    @classmethod
    def _bins(cls, v: dict[str, str]) -> dict[str, str]:
        out = {}
        for k, val in v.items():
            if k not in SORT_BIN_KEYS:
                raise ValueError(f"keys must be among {', '.join(SORT_BIN_KEYS)}")
            val = str(val).strip()
            if len(val) > 16 or any(c in val for c in "|\r\n"):
                raise ValueError("sort bin values must be short codes")
            if val:
                out[k] = val
        return out


class SipAccountPatch(SipAccountIn):
    login: str | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.@-]+$")  # type: ignore[assignment]
    branch_id: int | None = None  # type: ignore[assignment]


def sip_out(a: SipAccount) -> dict:
    return {
        "id": a.id, "login": a.login, "name": a.name, "institution_id": a.institution_id,
        "branch": {"id": a.branch.id, "code": a.branch.code, "name": a.branch.name},
        "branch_id": a.branch_id, "is_active": a.is_active, "delimiter": a.delimiter, "encoding": a.encoding,
        "error_detection": a.error_detection, "idle_timeout": a.idle_timeout,
        "allowed_networks": a.allowed_networks, "allow_checkout": a.allow_checkout,
        "allow_checkin": a.allow_checkin, "allow_renew": a.allow_renew, "allow_patron_info": a.allow_patron_info,
        "allow_holds": a.allow_holds, "allow_fee_paid": a.allow_fee_paid,
        "allow_block_patron": a.allow_block_patron, "require_patron_password": a.require_patron_password,
        "checked_in_ok": a.checked_in_ok, "sort_bins": a.sort_bins or {}, "notes": a.notes,
        "last_login_at": a.last_login_at, "last_login_ip": a.last_login_ip, "created_at": a.created_at,
    }


def _check_password(pw: str) -> str:
    if problems := password_problems(pw):
        raise HTTPException(422, "Password " + "; ".join(problems))
    return hash_password(pw)


def _check_branch(db: Session, branch_id: int) -> None:
    if not db.get(Branch, branch_id):
        raise HTTPException(422, "Unknown branch")


@router.get("/sip/accounts")
def list_sip_accounts(db: Session = Depends(get_db), _: Patron = Depends(MANAGE)):
    return {"results": [sip_out(a) for a in db.scalars(select(SipAccount).order_by(SipAccount.login))]}


@router.post("/sip/accounts", status_code=201)
def create_sip_account(body: SipAccountIn, request: Request, db: Session = Depends(get_db),
                       user: Patron = Depends(MANAGE)):
    if not body.password:
        raise HTTPException(422, "A password is required for a new SIP account")
    _check_branch(db, body.branch_id)
    data = body.model_dump(exclude={"password"})
    acc = SipAccount(**data, password_hash=_check_password(body.password))
    db.add(acc)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A SIP account with that login already exists") from None
    audit.record(db, "create", "sip_account", acc.id, actor=user, ip=client_ip(request), login=acc.login)
    db.commit()
    return sip_out(acc)


@router.patch("/sip/accounts/{account_id}")
def update_sip_account(account_id: int, body: SipAccountPatch, request: Request, db: Session = Depends(get_db),
                       user: Patron = Depends(MANAGE)):
    acc = db.get(SipAccount, account_id)
    if acc is None:
        raise NotFound("SIP account not found")
    changes = body.model_dump(exclude_unset=True)
    password = changes.pop("password", None)
    if changes.get("branch_id") is not None:
        _check_branch(db, changes["branch_id"])
    for k, v in changes.items():
        if v is None and k in ("login", "branch_id"):
            continue
        setattr(acc, k, v)
    if password:
        acc.password_hash = _check_password(password)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A SIP account with that login already exists") from None
    audit.record(db, "update", "sip_account", acc.id, actor=user, ip=client_ip(request),
                 fields=sorted(changes), password_changed=bool(password) or None)
    db.commit()
    return sip_out(acc)


@router.delete("/sip/accounts/{account_id}")
def delete_sip_account(account_id: int, request: Request, db: Session = Depends(get_db),
                       user: Patron = Depends(MANAGE)):
    acc = db.get(SipAccount, account_id)
    if acc is None:
        raise NotFound("SIP account not found")
    login = acc.login
    db.delete(acc)
    audit.record(db, "delete", "sip_account", account_id, actor=user, ip=client_ip(request), login=login)
    db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ copy-cataloguing targets


class TargetIn(_Strict):
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=8, max_length=500, pattern=r"^https?://[^\s]+$")
    sru_version: str = Field(default="1.1", pattern=r"^(1\.1|1\.2|2\.0)$")
    record_schema: str = Field(default="marcxml", min_length=1, max_length=64)
    title_index: str = Field(default="dc.title", pattern=r"^[A-Za-z][\w.-]{0,39}$")
    author_index: str = Field(default="dc.creator", pattern=r"^[A-Za-z][\w.-]{0,39}$")
    isbn_index: str = Field(default="bath.isbn", pattern=r"^[A-Za-z][\w.-]{0,39}$")
    timeout_seconds: int = Field(default=10, ge=1, le=60)
    enabled: bool = True
    position: int = Field(default=0, ge=0, le=1000)


class TargetPatch(TargetIn):
    name: str | None = Field(default=None, min_length=1, max_length=120)  # type: ignore[assignment]
    url: str | None = Field(default=None, min_length=8, max_length=500, pattern=r"^https?://[^\s]+$")  # type: ignore[assignment]


def target_out(t) -> dict:
    return {k: getattr(t, k) for k in ("id", "name", "url", "sru_version", "record_schema", "title_index",
                                       "author_index", "isbn_index", "timeout_seconds", "enabled", "position")}


@router.get("/copycat/targets")
def list_targets(db: Session = Depends(get_db), _: Patron = Depends(require("catalog:write"))):
    return {"results": [target_out(t) for t in copycat.targets(db)]}


@router.post("/copycat/targets", status_code=201)
def create_target(body: TargetIn, request: Request, db: Session = Depends(get_db), user: Patron = Depends(MANAGE)):
    t = CopyCatTarget(**body.model_dump())
    db.add(t)
    db.flush()
    audit.record(db, "create", "copycat_target", t.id, actor=user, ip=client_ip(request), url=t.url)
    db.commit()
    return target_out(t)


@router.patch("/copycat/targets/{target_id}")
def update_target(target_id: int, body: TargetPatch, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(MANAGE)):
    t = db.get(CopyCatTarget, target_id)
    if t is None:
        raise NotFound("Target not found")
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    for k, v in changes.items():
        setattr(t, k, v)
    audit.record(db, "update", "copycat_target", t.id, actor=user, ip=client_ip(request), fields=sorted(changes))
    db.commit()
    return target_out(t)


@router.delete("/copycat/targets/{target_id}")
def delete_target(target_id: int, request: Request, db: Session = Depends(get_db), user: Patron = Depends(MANAGE)):
    t = db.get(CopyCatTarget, target_id)
    if t is None:
        raise NotFound("Target not found")
    db.delete(t)
    audit.record(db, "delete", "copycat_target", target_id, actor=user, ip=client_ip(request))
    db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ copy-cataloguing workflow


@router.get("/copycat/search")
def copycat_search(q: str = Query(min_length=1, max_length=300),
                   kind: str = Query(default="title", pattern="^(title|isbn|author|cql)$"),
                   target_id: int = Query(default=0, ge=0), max: int = Query(default=10, ge=1, le=50),
                   start: int = Query(default=1, ge=1, le=100000),
                   db: Session = Depends(get_db), _: Patron = Depends(require("catalog:write"))):
    target = copycat.get_target(db, target_id)
    return copycat.search(db, target, kind, q, maximum=max, start=start)


class ImportIn(_Strict):
    marcxml: str = Field(min_length=20, max_length=1_000_000)
    target_id: int | None = None
    allow_duplicate: bool = False


@router.post("/copycat/import", status_code=201)
def copycat_import(body: ImportIn, request: Request, db: Session = Depends(get_db),
                   user: Patron = Depends(require("catalog:write"))):
    biblio = copycat.import_record(db, body.marcxml, allow_duplicate=body.allow_duplicate)
    source = None
    if body.target_id is not None:
        source = next((t.name for t in copycat.targets(db) if t.id == body.target_id), None)
    audit.record(db, "copycat_import", "biblio", biblio.id, actor=user, ip=client_ip(request),
                 title=biblio.title[:120], source=source)
    db.commit()
    from ..ai import semantic

    semantic.index.invalidate()
    return biblio_out(biblio, full=True)
