"""First-launch setup wizard API (see :mod:`librowise.services.setup`)."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import client_ip, optional_user
from ..models import Patron
from ..schemas import StrictModel
from ..security import SlidingWindowLimiter, has_permission
from ..services import audit, identity
from ..services import setup as svc

router = APIRouter(prefix="/setup", tags=["setup"])

# Every code check counts (verify and complete): 20 per address per 15 minutes. A real setup needs a handful;
# guessing one of 32^8 codes at that rate is hopeless.
SETUP_ATTEMPTS = 20
setup_limiter = SlidingWindowLimiter(SETUP_ATTEMPTS, 15 * 60, name="setup")


class LibraryIn(StrictModel):
    name: str = Field(default="", max_length=300)
    kind: str = Field(default="public", max_length=20)


class AdminIn(BaseModel):
    model_config = ConfigDict(extra="forbid")  # passwords keep their spaces
    first_name: str = Field(default="", max_length=200)
    last_name: str = Field(default="", max_length=200)
    username: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=200)
    password: str = Field(default="", max_length=256)


class BranchIn(StrictModel):
    id: int | None = None
    code: str = Field(default="", max_length=40)
    name: str = Field(default="", max_length=300)
    address: str = Field(default="", max_length=400)
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=80)


class LoansIn(StrictModel):
    loan_days: int | None = None
    max_renewals: int | None = None
    max_loans: int | None = None
    hold_pickup_days: int | None = None
    fine_per_day: int | None = Field(default=None, description="Minor currency units (paise, cents)")
    fine_cap: int | None = Field(default=None, description="Minor currency units")


class SetupIn(StrictModel):
    setup_code: str | None = Field(default=None, max_length=40, description="Required while no administrator exists")
    library: LibraryIn = Field(default_factory=LibraryIn)
    admin: AdminIn | None = None
    branches: list[BranchIn] = Field(default_factory=list, max_length=60)
    loans: LoansIn = Field(default_factory=LoansIn)
    start: str = Field(default="empty", max_length=20, description="empty | sample | import")


class CodeIn(StrictModel):
    code: str = Field(min_length=4, max_length=40)


def _can_configure(user: Patron | None) -> bool:
    return user is not None and has_permission(user, "settings:manage")


def _check_code(request: Request, db: Session, code: str | None) -> None:
    if not setup_limiter.allow(client_ip(request)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Wait a few minutes and try again.")
    if not code or not svc.check_code(db, code):
        audit.record(db, "setup_code_rejected", "settings", None, ip=client_ip(request))
        db.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, "That setup code is not right. Check the server log or run "
                                                       "`librowise setup-code`.")


@router.get("/state")
def setup_state(db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    """Where the wizard stands. Configuration details are only returned while the server is unclaimed
    (no administrator) or to an administrator."""
    current = svc.status(db)
    if current == "bootstrap":
        svc.ensure_code(db)  # a code exists for the operator to find
        db.commit()
    elif not _can_configure(user):
        return {"status": "configured" if current in ("completed", "none") else current, "allowed": False}
    return {"status": current, "allowed": True, "code_required": current == "bootstrap",
            "needs_admin": current == "bootstrap", "snapshot": svc.snapshot(db),
            "presets": [svc.preset_out(p) for p in svc.PRESETS.values()], "starts": list(svc.STARTS)}


@router.post("/verify")
def verify_code(body: CodeIn, request: Request, db: Session = Depends(get_db)):
    """Check the setup code early so the wizard can say so on its first step."""
    if svc.status(db) != "bootstrap":
        raise HTTPException(status.HTTP_409_CONFLICT, "This library already has an administrator: sign in instead.")
    _check_code(request, db, body.code)
    return {"ok": True}


@router.post("/complete")
def complete(body: SetupIn, request: Request, response: Response, db: Session = Depends(get_db),
             user: Patron | None = Depends(optional_user)):
    """Apply the whole configuration in one transaction. While no administrator exists this needs the setup
    code and creates the first administrator, who is then signed in."""
    bootstrap = svc.status(db) == "bootstrap"
    if bootstrap:
        _check_code(request, db, body.setup_code)
    elif user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in as an administrator to continue setup.")
    elif not _can_configure(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only administrators can set up the library.")
    data = body.model_dump()
    if not bootstrap:
        data["admin"] = None
    try:
        clean = svc.validate(db, data, need_admin=bootstrap)
        result = svc.apply(db, clean, None if bootstrap else user)
    except svc.SetupError as exc:
        db.rollback()
        return JSONResponse({"detail": str(exc), "field": exc.field, "code": exc.code}, status_code=422)
    signed_in = False
    if result["admin"] is not None:
        identity.complete_login(db, result["admin"], request, response, "password")
        signed_in = True
    db.commit()
    redirect = "/staff/admin#maintenance" if clean["start"] == "import" else "/staff"
    return {"ok": True, "signed_in": signed_in, "redirect": redirect, "summary": result["summary"]}


@router.post("/skip")
def skip(db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    """Stop sending an administrator to the wizard (it stays available from the notification centre)."""
    if svc.status(db) == "bootstrap":
        raise HTTPException(status.HTTP_409_CONFLICT, "Create the first administrator before skipping setup.")
    if not _can_configure(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only administrators can skip setup.")
    if svc.status(db) != "completed":
        svc.mark(db, "skipped", user)
        audit.record(db, "setup_skipped", "settings", None, actor=user)
    db.commit()
    return {"ok": True, "redirect": "/staff"}
