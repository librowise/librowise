"""SIP2 message handlers: map SIP requests onto the circulation services.

Every request runs in its own database session and transaction (one commit per message). The
handlers never raise: domain errors become the protocol's "not OK" responses with a screen
message (AF) the kiosk can show to the patron, and unexpected errors are logged and answered
with a generic failure so the terminal never hangs waiting for a reply.
"""

from __future__ import annotations

import ipaddress
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, tzinfo
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import db as dbmod
from ..config import get_settings
from ..errors import DomainError
from ..models import (
    AuditLog,
    Biblio,
    Branch,
    Hold,
    HoldStatus,
    Item,
    ItemStatus,
    LedgerEntry,
    LedgerKind,
    Loan,
    Patron,
    SipAccount,
    SipPatronBlock,
    utcnow,
)
from ..security import SlidingWindowLimiter, verify_password
from ..services import audit, circulation
from ..services import settings as settings_svc
from . import protocol as p

log = logging.getLogger("librowise.sip2")

# Library material type -> SIP media type (CK)
MEDIA_TYPES = {"book": "001", "comic": "001", "serial": "002", "audiobook": "006", "dvd": "006", "ebook": "000"}

# Item status -> SIP circulation status (item information response)
CIRC_STATUS = {
    ItemStatus.available: "03",
    ItemStatus.on_loan: "04",
    ItemStatus.processing: "06",
    ItemStatus.on_hold_shelf: "08",
    ItemStatus.in_transit: "10",
    ItemStatus.lost: "12",
    ItemStatus.damaged: "01",
    ItemStatus.withdrawn: "13",
}

MAX_ITEMS_IN_LIST = 200
LOGIN_FAILURES_BEFORE_DISCONNECT = 3
MAX_CONSECUTIVE_ERRORS = 5

login_limiter = SlidingWindowLimiter(20)  # login attempts per IP per minute


@dataclass
class HandlerConfig:
    delimiter: str = p.DEFAULT_DELIMITER
    encoding: str = p.DEFAULT_ENCODING
    response_timeout_tenths: int = 100  # advertised to the SC in the 98 ACS status
    retries_allowed: int = 3
    login_timeout: float = 60.0


@dataclass
class SipSession:
    """Per-connection state."""

    peer: str
    account_id: int | None = None
    login: str | None = None
    institution_id: str = ""
    location: str | None = None
    delimiter: str = p.DEFAULT_DELIMITER
    encoding: str = p.DEFAULT_ENCODING
    error_detection: bool = False
    idle_timeout: float = 600.0
    last_response: bytes | None = None
    patron_card: str | None = None
    failed_logins: int = 0
    consecutive_errors: int = 0
    messages: int = 0
    connected_at: float = field(default_factory=time.monotonic)

    @property
    def authenticated(self) -> bool:
        return self.account_id is not None

    @property
    def peer_ip(self) -> str:
        return self.peer.rsplit(":", 1)[0].strip("[]")


@dataclass
class Reply:
    code: str
    fixed: list[str]
    fields: list[tuple[str, object]] = field(default_factory=list)


@dataclass
class Ctx:
    """What a handler needs: the DB session, the (fresh) account row and the request."""

    db: Session
    session: SipSession
    account: SipAccount | None
    req: p.Message
    tz: tzinfo | None

    def now(self) -> str:
        return p.sip_datetime(utcnow(), self.tz)

    def dt(self, value: datetime | None) -> str:
        return p.sip_datetime(value, self.tz)

    def day(self, value: datetime) -> str:
        """Human-readable date in the library's time zone, for screen messages."""
        aware = value.replace(tzinfo=UTC)
        return (aware.astimezone(self.tz) if self.tz else aware).strftime("%d %b %Y")

    @property
    def ao(self) -> str:
        return self.account.institution_id if self.account else (self.req.get("AO") or "")


def _event(event: str, session: SipSession, **kw) -> None:
    extra = " ".join(f"{k}={v!r}" for k, v in kw.items() if v is not None)
    log.info("sip2 event=%s peer=%s account=%s %s", event, session.peer, session.login or "-", extra)


def _library_tz() -> tzinfo | None:
    try:
        return ZoneInfo(get_settings().timezone)
    except Exception:  # unknown zone or no tz database (Windows without tzdata)
        return None


# ------------------------------------------------------------------ failure responses


def failure(code: str, message: str, req: p.Message | None, institution: str = "", tz: tzinfo | None = None) -> Reply:
    """The protocol-correct "not OK" response for any request code."""
    now = p.sip_datetime(utcnow(), tz)
    g = (lambda f: req.get(f, "") if req else "")  # noqa: E731
    af = ("AF", message)
    ao = ("AO", institution or g("AO"))
    if code == "93":
        return Reply("94", ["0"])
    if code == "99":
        return Reply("98", ["N", "N", "N", "N", "N", "N", "000", "000", now, p.PROTOCOL_VERSION],
                     [ao, ("AM", ""), ("BX", "N" * 16), af])
    if code == "09":
        return Reply("10", ["0", "N", "U", "N", now], [ao, ("AB", g("AB")), ("AQ", ""), af])
    if code == "11":
        return Reply("12", ["0", "N", "U", "N", now], [ao, ("AA", g("AA")), ("AB", g("AB")), ("AJ", ""), ("AH", ""), af])
    if code == "15":
        return Reply("16", ["0", "N", now], [ao, ("AA", g("AA")), af])
    if code == "17":
        return Reply("18", ["01", "00", "01", now], [("AB", g("AB")), ("AJ", ""), af])
    if code == "19":
        return Reply("20", ["0", now], [("AB", g("AB")), af])
    if code in ("23", "01", "25"):
        return Reply("26" if code == "25" else "24", ["Y" * 14, "000", now],
                     [ao, ("AA", g("AA")), ("AE", ""), ("BL", "N"), af])
    if code == "29":
        return Reply("30", ["0", "N", "U", "N", now], [ao, ("AA", g("AA")), ("AB", g("AB")), ("AJ", ""), ("AH", ""), af])
    if code == "35":
        return Reply("36", ["N", now], [ao, ("AA", g("AA")), af])
    if code == "37":
        return Reply("38", ["N", now], [ao, ("AA", g("AA")), af])
    if code == "63":
        return Reply("64", ["Y" * 14, "000", now, *["0000"] * 6], [ao, ("AA", g("AA")), ("AE", ""), ("BL", "N"), af])
    if code == "65":
        return Reply("66", ["0", "0000", "0000", now], [ao, af])
    raise ValueError(f"No failure response for {code}")


# ------------------------------------------------------------------ handler


class Sip2Handler:
    """Stateless message processor; per-connection state lives in :class:`SipSession`."""

    def __init__(self, config: HandlerConfig | None = None,
                 session_factory: Callable[[], Session] | None = None) -> None:
        self.config = config or HandlerConfig()
        self.session_factory = session_factory or dbmod.SessionLocal
        self.tz = _library_tz()
        self.routes: dict[str, Callable[[Ctx], Reply]] = {
            "01": self.block_patron, "09": self.checkin, "11": self.checkout, "15": self.hold,
            "17": self.item_information, "19": self.item_status_update, "23": self.patron_status,
            "25": self.patron_enable, "29": self.renew, "35": self.end_patron_session, "37": self.fee_paid,
            "63": self.patron_information, "65": self.renew_all, "99": self.sc_status,
        }

    def new_session(self, peer: str) -> SipSession:
        return SipSession(peer=peer, delimiter=self.config.delimiter, encoding=self.config.encoding)

    # ---------------------------------------------------------------- entry point

    def handle(self, session: SipSession, raw: bytes) -> tuple[bytes | None, bool]:
        """Process one raw message. Returns (response bytes or None, close connection?)."""
        started = time.perf_counter()
        if not raw.strip(b"\r\n\x00 "):
            return None, False
        session.messages += 1
        try:
            req = p.parse(raw, delimiter=session.delimiter, encoding=session.encoding)
        except p.SipError as exc:
            session.consecutive_errors += 1
            _event("bad_message", session, error=str(exc), errors=session.consecutive_errors)
            close = session.consecutive_errors >= MAX_CONSECUTIVE_ERRORS
            return self._encode(session, Reply("96", []), None), close
        if session.error_detection and req.checksum is None and req.code != "97":
            session.consecutive_errors += 1
            _event("checksum_missing", session, code=req.code)
            return self._encode(session, Reply("96", []), None), session.consecutive_errors >= MAX_CONSECUTIVE_ERRORS
        session.consecutive_errors = 0
        if log.isEnabledFor(logging.DEBUG):
            log.debug("sip2 recv peer=%s %s", session.peer,
                      p.redact(raw.decode(session.encoding, "replace").strip(), session.delimiter))

        if req.code == "97":
            if session.last_response is None:
                return self._encode(session, Reply("96", []), None), False
            return session.last_response, False

        close = False
        if req.code == "93":
            reply, close = self._login(req, session)
        elif req.code in self.routes:
            reply = self._dispatch(req, session)
        else:  # a response code sent by mistake, or a message we never handle
            reply = None
        if reply is None:
            _event("unsupported", session, code=req.code)
            return self._encode(session, Reply("96", []), req), False
        out = self._encode(session, reply, req)
        session.last_response = out
        _event("message", session, code=req.code, reply=reply.code,
               ms=round((time.perf_counter() - started) * 1000, 1))
        return out, close

    def _encode(self, session: SipSession, reply: Reply, req: p.Message | None) -> bytes:
        seq = req.sequence if req is not None else None
        detect = session.error_detection or (req is not None and req.checksum is not None)
        return p.format_message(reply.code, reply.fixed, reply.fields, delimiter=session.delimiter,
                                encoding=session.encoding, sequence=seq if detect else None,
                                error_detection=detect)

    def _dispatch(self, req: p.Message, session: SipSession) -> Reply:
        db = self.session_factory()
        try:
            account = db.get(SipAccount, session.account_id) if session.account_id else None
            if account is not None and not account.is_active:
                account = None
                session.account_id = None
            ctx = Ctx(db=db, session=session, account=account, req=req, tz=self.tz)
            if account is None:
                if req.code == "99":
                    return self.sc_status(ctx)
                return failure(req.code, "Please log in to the library system first", req, tz=self.tz)
            permitted = {
                "11": account.allow_checkout, "09": account.allow_checkin, "29": account.allow_renew,
                "65": account.allow_renew, "63": account.allow_patron_info, "23": account.allow_patron_info,
                "15": account.allow_holds, "37": account.allow_fee_paid, "01": account.allow_block_patron,
                "19": False,
            }.get(req.code, True)
            if not permitted:
                return failure(req.code, "This service is not available at this terminal", req, account.institution_id, self.tz)
            reply = self.routes[req.code](ctx)
            self._tag_audit(db, session)
            db.commit()
            return reply
        except Exception:
            db.rollback()
            log.exception("sip2 handler error peer=%s code=%s", session.peer, req.code)
            return failure(req.code, "The library system could not complete this request", req, tz=self.tz)
        finally:
            db.close()

    @staticmethod
    def _tag_audit(db: Session, session: SipSession) -> None:
        """Mark audit entries written by the circulation services as coming from this terminal."""
        tag = {"via": "sip2", "sip_account": session.login, "terminal": session.location}
        entries = [o for o in list(db.new) + list(db.identity_map.values()) if isinstance(o, AuditLog)]
        for entry in entries:
            if (entry.details or {}).get("via") != "sip2":
                entry.details = {**(entry.details or {}), **{k: v for k, v in tag.items() if v}}
            entry.ip = entry.ip or session.peer_ip

    # ---------------------------------------------------------------- 93 login

    def _login(self, req: p.Message, session: SipSession) -> tuple[Reply, bool]:
        user, password = (req.get("CN") or "").strip(), req.get("CO") or ""
        if not login_limiter.allow(session.peer_ip):
            _event("login_rate_limited", session, user=user)
            return Reply("94", ["0"]), True
        db = self.session_factory()
        try:
            account = db.scalar(select(SipAccount).where(SipAccount.login == user)) if user else None
            ok = verify_password(account.password_hash if account else None, password)
            reason = None
            if req.fixed["uid_algorithm"] not in ("0", " ") or req.fixed["pwd_algorithm"] not in ("0", " "):
                ok, reason = False, "unsupported_algorithm"
            elif account is None or not ok:
                ok, reason = False, "bad_credentials"
            elif not account.is_active:
                ok, reason = False, "inactive"
            elif not _network_allowed(account.allowed_networks, session.peer_ip):
                ok, reason = False, "network_not_allowed"
            if not ok:
                session.failed_logins += 1
                audit.record(db, "sip2_login_failed", "sip_account", account.id if account else None,
                             ip=session.peer_ip, login=user[:64], reason=reason)
                db.commit()
                _event("login_failed", session, user=user, reason=reason)
                return Reply("94", ["0"]), session.failed_logins >= LOGIN_FAILURES_BEFORE_DISCONNECT
            assert account is not None
            session.account_id, session.login = account.id, account.login
            session.institution_id = account.institution_id
            session.location = req.get("CP") or account.branch.code
            session.delimiter = account.delimiter or p.DEFAULT_DELIMITER
            session.encoding = account.encoding or p.DEFAULT_ENCODING
            session.error_detection = account.error_detection
            session.idle_timeout = float(account.idle_timeout or 600)
            session.failed_logins = 0
            account.last_login_at = utcnow()
            account.last_login_ip = session.peer_ip
            audit.record(db, "sip2_login", "sip_account", account.id, ip=session.peer_ip, location=session.location)
            db.commit()
            _event("login", session, location=session.location)
            return Reply("94", ["1"]), False
        except Exception:
            db.rollback()
            log.exception("sip2 login error peer=%s", session.peer)
            return Reply("94", ["0"]), False
        finally:
            db.close()

    # ---------------------------------------------------------------- 99 SC status

    def sc_status(self, c: Ctx) -> Reply:
        a = c.account
        if c.req.fixed.get("status_code") == "2":
            _event("sc_shutting_down", c.session)
        if a is None:
            return failure("99", "Login required", c.req, tz=c.tz)
        bx = "".join(p.yn(x) for x in (
            True,                 # patron status request
            a.allow_checkout,     # checkout
            a.allow_checkin,      # checkin
            a.allow_block_patron,  # block patron
            True,                 # SC/ACS status
            True,                 # request SC/ACS resend
            True,                 # login
            a.allow_patron_info,  # patron information
            True,                 # end patron session
            a.allow_fee_paid,     # fee paid
            True,                 # item information
            False,                # item status update
            True,                 # patron enable
            a.allow_holds,        # hold
            a.allow_renew,        # renew
            a.allow_renew,        # renew all
        ))
        timeout = f"{max(0, min(self.config.response_timeout_tenths, 999)):03d}"
        retries = f"{max(0, min(self.config.retries_allowed, 999)):03d}"
        return Reply("98", ["Y", p.yn(a.allow_checkin), p.yn(a.allow_checkout), p.yn(a.allow_renew), "N", "Y",
                            timeout, retries, c.now(), p.PROTOCOL_VERSION],
                     [("AO", a.institution_id), ("AM", settings_svc.get(c.db, "library_name")),
                      ("BX", bx), ("AN", c.session.location or a.branch.code), ("AF", ""), ("AG", "")])

    # ---------------------------------------------------------------- patrons

    def _patron(self, c: Ctx) -> Patron | None:
        card = (c.req.get("AA") or "").strip()
        if not card:
            return None
        return c.db.scalar(select(Patron).where(Patron.card_number == card, Patron.deleted_at.is_(None)))

    @staticmethod
    def _password_ok(patron: Patron, req: p.Message) -> bool | None:
        """True/False when a patron password (AD) was supplied, None when it was not."""
        pw = req.get("AD")
        if not pw:
            return None
        return verify_password(patron.password_hash, pw)

    def _authorised(self, c: Ctx, patron: Patron | None) -> str | None:
        """Error message if the request may not act for this patron, else None."""
        if patron is None:
            return "Your library card was not recognised. Please ask for help at the desk."
        pw = self._password_ok(patron, c.req)
        if pw is False:
            return "Incorrect PIN or password."
        if pw is None and c.account is not None and c.account.require_patron_password:
            return "Please enter your PIN or password."
        return None

    @staticmethod
    def _sip_block(db: Session, patron_id: int) -> SipPatronBlock | None:
        return db.scalar(select(SipPatronBlock).where(SipPatronBlock.patron_id == patron_id,
                                                      SipPatronBlock.cleared_at.is_(None))
                         .order_by(SipPatronBlock.id.desc()).limit(1))

    def _status(self, c: Ctx, patron: Patron) -> tuple[str, list[str], dict]:
        """(14-char patron status, screen messages, facts) for a patron."""
        db = c.db
        blocks = circulation.patron_blocks(db, patron)
        loans = circulation.open_loans(db, patron.id)
        holds = db.scalar(select(func.count()).select_from(Hold).where(
            Hold.patron_id == patron.id, Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES))) or 0
        owed = circulation.balance(db, patron.id)
        sip_block = self._sip_block(db, patron.id)
        now = utcnow()
        overdue = [l for l in loans if l.due_at < now]
        too_many = len(loans) >= patron.category.max_loans
        blocked = bool(blocks) or sip_block is not None
        fines = owed >= patron.category.block_fine_threshold
        flags = [
            blocked or too_many,                  # 0 charge privileges denied
            blocked,                              # 1 renewal privileges denied
            blocked,                              # 2 recall privileges denied
            blocked or holds >= patron.category.max_holds,  # 3 hold privileges denied
            bool(sip_block and sip_block.card_retained),    # 4 card reported lost
            too_many,                             # 5 too many items charged
            False,                                # 6 too many items overdue
            False,                                # 7 too many renewals
            False,                                # 8 too many claims of items returned
            False,                                # 9 too many items lost
            fines,                                # 10 excessive outstanding fines
            fines,                                # 11 excessive outstanding fees
            False,                                # 12 recall overdue
            False,                                # 13 too many items billed
        ]
        messages = list(blocks)
        if sip_block is not None:
            messages.append("Your card has been blocked. Please see library staff.")
        if too_many:
            messages.append(f"You have reached your loan limit ({patron.category.max_loans}).")
        status = "".join("Y" if f else " " for f in flags)
        return status, messages, {"loans": loans, "overdue": overdue, "holds": holds, "owed": owed,
                                  "blocked": blocked}

    def _valid_patron(self, patron: Patron | None) -> bool:
        return bool(patron and patron.is_active and patron.deleted_at is None)

    def _language(self, c: Ctx) -> str:
        lang = c.req.fixed.get("language", "000")
        return lang if lang and lang.isdigit() else "000"

    def patron_status(self, c: Ctx) -> Reply:
        patron = self._patron(c)
        if patron is None:
            return failure("23", "Your library card was not recognised.", c.req, c.ao, c.tz)
        status, messages, facts = self._status(c, patron)
        pw = self._password_ok(patron, c.req)
        if pw is False or (pw is None and c.account and c.account.require_patron_password):
            status = "Y" * 14
        c.session.patron_card = patron.card_number
        return Reply("24", [status, self._language(c), c.now()], [
            ("AO", c.ao), ("AA", patron.card_number), ("AE", patron.full_name),
            ("BL", p.yn(self._valid_patron(patron))), ("CQ", None if pw is None else p.yn(pw)),
            ("BH", get_settings().currency[:3]), ("BV", p.amount(max(facts["owed"], 0))),
            ("AF", " ".join(messages) or None),
        ])

    def patron_information(self, c: Ctx) -> Reply:
        db = c.db
        patron = self._patron(c)
        if patron is None:
            return failure("63", "Your library card was not recognised.", c.req, c.ao, c.tz)
        pw = self._password_ok(patron, c.req)
        if pw is False or (pw is None and c.account and c.account.require_patron_password):
            # Never disclose loans or personal details without the right password.
            return Reply("64", ["Y" * 14, self._language(c), c.now(), *["0000"] * 6], [
                ("AO", c.ao), ("AA", patron.card_number), ("AE", ""), ("BL", "Y"), ("CQ", "N"),
                ("AF", "Incorrect PIN or password." if pw is False else "Please enter your PIN or password.")])
        status, messages, facts = self._status(c, patron)
        c.session.patron_card = patron.card_number
        holds = db.scalars(select(Hold).where(Hold.patron_id == patron.id,
                                              Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES))
                           .order_by(Hold.created_at)).all()
        ready = [h for h in holds if h.status == HoldStatus.ready]
        waiting = [h for h in holds if h.status == HoldStatus.queued]
        fine_items = outstanding_charges(db, patron.id)
        cur = get_settings().currency[:3]

        summary = c.req.fixed.get("summary", "")
        which = summary.find("Y")
        start = _int(c.req.get("BP"), 1)
        end = _int(c.req.get("BQ"), start + 49)
        start, end = max(start, 1), max(end, start)
        end = min(end, start + MAX_ITEMS_IN_LIST - 1)
        lists = {
            0: ("AS", [h.item.barcode if h.item else h.biblio.title for h in ready]),
            1: ("AT", [l.item.barcode for l in facts["overdue"]]),
            2: ("AU", [l.item.barcode for l in facts["loans"]]),
            3: ("AV", [f"{p.amount(amt)} {cur} {e.note or e.kind.value}" for e, amt in fine_items]),
            4: ("BU", []),
            5: ("CD", [h.biblio.title for h in waiting]),
        }
        item_fields: list[tuple[str, object]] = []
        if which in lists:
            fid, values = lists[which]
            item_fields = [(fid, v) for v in values[start - 1 : end]]

        fields: list[tuple[str, object]] = [
            ("AO", c.ao), ("AA", patron.card_number), ("AE", patron.full_name),
            ("BZ", p.count4(patron.category.max_holds)), ("CB", p.count4(patron.category.max_loans)),
            ("BL", p.yn(self._valid_patron(patron))), ("CQ", None if pw is None else p.yn(pw)),
            ("BH", cur), ("BV", p.amount(max(facts["owed"], 0))),
            ("CC", p.amount(patron.category.block_fine_threshold)),
            *item_fields,
            ("BD", patron.address), ("BE", patron.email), ("BF", patron.phone),
            ("PB", patron.date_of_birth.strftime("%Y%m%d") if patron.date_of_birth else None),
            ("PC", patron.category.code), ("PE", c.dt(datetime.combine(patron.expires_on, datetime.min.time()))
                                           if patron.expires_on else None),
            ("AF", " ".join(messages) or None),
        ]
        counts = [p.count4(len(ready)), p.count4(len(facts["overdue"])), p.count4(len(facts["loans"])),
                  p.count4(len(fine_items)), "0000", p.count4(len(waiting))]
        return Reply("64", [status, self._language(c), c.now(), *counts], fields)

    def end_patron_session(self, c: Ctx) -> Reply:
        c.session.patron_card = None
        return Reply("36", ["Y", c.now()], [("AO", c.ao), ("AA", c.req.get("AA", "")),
                                            ("AF", "Thank you for using the library.")])

    def block_patron(self, c: Ctx) -> Reply:
        patron = self._patron(c)
        if patron is None:
            return failure("01", "Your library card was not recognised.", c.req, c.ao, c.tz)
        retained = c.req.fixed.get("card_retained") == "Y"
        reason = (c.req.get("AL") or "Blocked by self-service terminal")[:255]
        c.db.add(SipPatronBlock(patron_id=patron.id, sip_account_id=c.account.id if c.account else None,
                                card_retained=retained, reason=reason))
        patron.is_active = False
        audit.record(c.db, "sip2_block_patron", "patron", patron.id, reason=reason, card_retained=retained)
        c.db.flush()
        status, _, _ = self._status(c, patron)
        return Reply("24", [status, "000", c.now()], [
            ("AO", c.ao), ("AA", patron.card_number), ("AE", patron.full_name), ("BL", "N"),
            ("AF", "Your card has been blocked. Please see library staff.")])

    def patron_enable(self, c: Ctx) -> Reply:
        patron = self._patron(c)
        if patron is None:
            return failure("25", "Your library card was not recognised.", c.req, c.ao, c.tz)
        pw = self._password_ok(patron, c.req)
        if pw is False:
            return failure("25", "Incorrect PIN or password.", c.req, c.ao, c.tz)
        blocks = c.db.scalars(select(SipPatronBlock).where(SipPatronBlock.patron_id == patron.id,
                                                           SipPatronBlock.cleared_at.is_(None))).all()
        message = None
        if blocks:
            for b in blocks:
                b.cleared_at = utcnow()
            patron.is_active = True
            audit.record(c.db, "sip2_patron_enable", "patron", patron.id, cleared=len(blocks))
            c.db.flush()
            message = "Your card has been re-enabled."
        elif not patron.is_active:
            message = "Your account was suspended by library staff. Please see the desk."
        status, messages, _ = self._status(c, patron)
        return Reply("26", [status, "000", c.now()], [
            ("AO", c.ao), ("AA", patron.card_number), ("AE", patron.full_name),
            ("BL", p.yn(self._valid_patron(patron))), ("CQ", None if pw is None else p.yn(pw)),
            ("AF", message or " ".join(messages) or None)])

    # ---------------------------------------------------------------- items

    def _item(self, c: Ctx) -> Item | None:
        barcode = (c.req.get("AB") or "").strip()
        if not barcode:
            return None
        return c.db.scalar(select(Item).where(Item.barcode == barcode, Item.deleted_at.is_(None)))

    @staticmethod
    def _media(item: Item) -> str:
        return MEDIA_TYPES.get(item.biblio.material_type, "000")

    @staticmethod
    def _magnetic(item: Item) -> str:
        return "U" if item.biblio.material_type in ("dvd", "audiobook") else "N"

    def _branch_by_code(self, db: Session, code: str | None) -> Branch | None:
        if not code:
            return None
        return db.scalar(select(Branch).where(Branch.code == code.strip()))

    def item_information(self, c: Ctx) -> Reply:
        item = self._item(c)
        if item is None:
            return failure("17", "Item not found", c.req, c.ao, c.tz)
        db = c.db
        loan = db.scalar(select(Loan).where(Loan.item_id == item.id, Loan.returned_at.is_(None)))
        queue = db.scalar(select(func.count()).select_from(Hold).where(
            Hold.biblio_id == item.biblio_id, Hold.status == HoldStatus.queued)) or 0
        ready = db.scalar(select(Hold).where(Hold.item_id == item.id, Hold.status == HoldStatus.ready))
        status = CIRC_STATUS.get(item.status, "01")
        return Reply("18", [status, "02", "01", c.now()], [
            ("CF", str(queue)), ("AH", c.dt(loan.due_at) if loan else None),
            ("CM", c.dt(ready.expires_at) if ready and ready.expires_at else None),
            ("AB", item.barcode), ("AJ", item.biblio.title), ("CK", self._media(item)),
            ("AQ", item.branch.code), ("AP", item.shelf_location or item.branch.code),
            ("CS", item.call_number), ("AO", c.ao),
            ("AF", item.status.value.replace("_", " ")),
        ])

    def item_status_update(self, c: Ctx) -> Reply:  # pragma: no cover - gated as unsupported
        return failure("19", "Item status update is not supported", c.req, c.ao, c.tz)

    # ---------------------------------------------------------------- checkout / renew

    def checkout(self, c: Ctx) -> Reply:
        db, req = c.db, c.req
        patron, item = self._patron(c), self._item(c)
        if (err := self._authorised(c, patron)) is not None:
            return failure("11", err, req, c.ao, c.tz)
        assert patron is not None
        if item is None:
            return failure("11", "This item was not recognised. Please take it to the desk.", req, c.ao, c.tz)
        if req.get("BI") == "Y":
            return failure("11", "Cancelling a check-in is not supported", req, c.ao, c.tz)
        no_block = req.fixed.get("no_block") == "Y"
        renewal_policy = req.fixed.get("renewal_policy") == "Y"
        when = p.parse_sip_datetime(req.fixed.get("transaction_date"), c.tz) if no_block else None
        nb_due = p.parse_sip_datetime(req.fixed.get("nb_due_date"), c.tz) if no_block else None
        renewed = False
        warnings: list[str] = []
        try:
            res = circulation.checkout(db, patron, item, branch_id=c.account.branch_id, actor=None,
                                       override=no_block, now=when, due_at=nb_due)
            loan = res.loan
            warnings = [w for w in res.warnings if not w.startswith("Overridden")]
        except DomainError as exc:
            if getattr(exc, "code", "") == "already_on_loan" and renewal_policy and c.account.allow_renew:
                loan = db.scalar(select(Loan).where(Loan.item_id == item.id, Loan.returned_at.is_(None)))
                try:
                    circulation.renew(db, loan, actor=None, override=no_block)
                except DomainError as rexc:
                    return self._checkout_failed(c, patron, item, rexc.message)
                renewed = True
            else:
                return self._checkout_failed(c, patron, item, exc.message)
        if req.get("BO") == "N":
            pass  # Librowise charges no rental fees, so there is never a fee to acknowledge.
        msg = "Renewed" if renewed else "Checked out"
        return Reply("12", ["1", p.yn(renewed), self._magnetic(item), "Y", c.now()], [
            ("AO", c.ao), ("AA", patron.card_number), ("AB", item.barcode), ("AJ", item.biblio.title),
            ("AH", c.dt(loan.due_at)), ("CK", self._media(item)), ("BK", str(loan.id)),
            ("AF", " ".join([f"{msg}. Due {c.day(loan.due_at)}.", *warnings])),
        ])

    def _checkout_failed(self, c: Ctx, patron: Patron, item: Item, message: str) -> Reply:
        c.db.rollback()
        return Reply("12", ["0", "N", self._magnetic(item), "N", c.now()], [
            ("AO", c.ao), ("AA", patron.card_number), ("AB", item.barcode), ("AJ", item.biblio.title),
            ("AH", ""), ("CK", self._media(item)), ("AF", message)])

    def renew(self, c: Ctx) -> Reply:
        db, req = c.db, c.req
        patron, item = self._patron(c), self._item(c)
        if (err := self._authorised(c, patron)) is not None:
            return failure("29", err, req, c.ao, c.tz)
        assert patron is not None
        if item is None:
            return failure("29", "Item not found", req, c.ao, c.tz)
        loan = db.scalar(select(Loan).where(Loan.item_id == item.id, Loan.returned_at.is_(None)))
        if loan is None:
            return failure("29", "This item is not checked out", req, c.ao, c.tz)
        if loan.patron_id != patron.id and req.fixed.get("third_party_allowed") != "Y":
            return failure("29", "This item is checked out to someone else", req, c.ao, c.tz)
        no_block = req.fixed.get("no_block") == "Y"
        try:
            circulation.renew(db, loan, actor=None, override=no_block)
        except DomainError as exc:
            db.rollback()
            loan = db.get(Loan, loan.id)
            return Reply("30", ["0", "N", self._magnetic(item), "U", c.now()], [
                ("AO", c.ao), ("AA", patron.card_number), ("AB", item.barcode), ("AJ", item.biblio.title),
                ("AH", c.dt(loan.due_at)), ("CK", self._media(item)), ("AF", exc.message)])
        return Reply("30", ["1", "Y", self._magnetic(item), "U", c.now()], [
            ("AO", c.ao), ("AA", patron.card_number), ("AB", item.barcode), ("AJ", item.biblio.title),
            ("AH", c.dt(loan.due_at)), ("CK", self._media(item)), ("BK", str(loan.id)),
            ("AF", f"Renewed. Due {c.day(loan.due_at)}.")])

    def renew_all(self, c: Ctx) -> Reply:
        db = c.db
        patron = self._patron(c)
        if (err := self._authorised(c, patron)) is not None:
            return failure("65", err, c.req, c.ao, c.tz)
        assert patron is not None
        renewed, failed = [], []
        for loan in circulation.open_loans(db, patron.id):
            # renew() checks every policy before it changes anything, so a refusal leaves no
            # partial state behind and the remaining loans can still be renewed.
            try:
                circulation.renew(db, loan, actor=None)
                renewed.append(loan.item.barcode)
            except DomainError:
                failed.append(loan.item.barcode)
        fields: list[tuple[str, object]] = [("AO", c.ao)]
        fields += [("BM", b) for b in renewed] + [("BN", b) for b in failed]
        fields.append(("AF", f"{len(renewed)} renewed, {len(failed)} could not be renewed."))
        return Reply("66", ["1", p.count4(len(renewed)), p.count4(len(failed)), c.now()], fields)

    # ---------------------------------------------------------------- checkin

    def checkin(self, c: Ctx) -> Reply:
        db, req, account = c.db, c.req, c.account
        item = self._item(c)
        if item is None:
            reply = failure("09", "This item was not recognised. Please take it to the desk.", req, c.ao, c.tz)
            reply.fixed[3] = "Y"  # alert
            return reply
        if req.get("BI") == "Y":
            return failure("09", "Cancelling a checkout is not supported", req, c.ao, c.tz)
        if item.status == ItemStatus.withdrawn:
            return Reply("10", ["0", "N", self._magnetic(item), "Y", c.now()], [
                ("AO", c.ao), ("AB", item.barcode), ("AQ", item.branch.code), ("AJ", item.biblio.title),
                ("AF", "This item has been withdrawn. Please take it to the desk.")])
        here = self._branch_by_code(db, req.get("AP")) or account.branch
        no_block = req.fixed.get("no_block") == "Y"
        when = p.parse_sip_datetime(req.fixed.get("return_date"), c.tz) if no_block else None
        if when is not None and when > utcnow():
            when = None
        was_on_loan = item.status == ItemStatus.on_loan
        try:
            res = circulation.checkin(db, item, branch_id=here.id, actor=None, now=when)
        except DomainError as exc:
            db.rollback()
            return failure("09", exc.message, req, c.ao, c.tz)

        ok = True
        alert, alert_type, destination = False, None, None
        hold_fields: list[tuple[str, object]] = []
        bins = account.sort_bins or {}
        sort_bin = bins.get("default")
        if res.hold is not None:
            alert = True
            local = res.hold.pickup_branch_id == here.id
            alert_type = "01" if local else "02"
            destination = res.hold.pickup_branch.code
            sort_bin = bins.get("hold", sort_bin)
            hold_fields = [("CY", res.hold.patron.card_number), ("DA", res.hold.patron.full_name)]
        elif item.branch_id != here.id:
            alert, alert_type, destination = True, "04", item.branch.code
            sort_bin = bins.get("transfer", sort_bin)
        if res.loan is None and not was_on_loan and not alert:
            ok = account.checked_in_ok
        messages = list(res.messages)
        if res.loan is None and not was_on_loan:
            messages.insert(0, "This item was not checked out.")
        elif res.loan is not None:
            messages.insert(0, "Thank you. Item returned.")
        return Reply("10", ["1" if ok else "0", "Y" if ok else "N", self._magnetic(item), p.yn(alert), c.now()], [
            ("AO", c.ao), ("AB", item.barcode), ("AQ", item.branch.code), ("AJ", item.biblio.title),
            ("CL", sort_bin), ("AA", res.loan.patron.card_number if res.loan and res.loan.patron else None),
            ("CK", self._media(item)), ("CV", alert_type), ("CT", destination), *hold_fields,
            ("AF", " ".join(messages)),
        ])

    # ---------------------------------------------------------------- holds

    def hold(self, c: Ctx) -> Reply:
        db, req = c.db, c.req
        patron = self._patron(c)
        if (err := self._authorised(c, patron)) is not None:
            return failure("15", err, req, c.ao, c.tz)
        assert patron is not None
        mode = req.fixed.get("hold_mode")
        item = self._item(c)
        biblio = item.biblio if item else None
        title_id = (req.get("AJ") or "").strip()
        if biblio is None and title_id.isdigit():
            biblio = db.get(Biblio, int(title_id))
        if biblio is None or biblio.deleted_at is not None:
            return failure("15", "Title not found", req, c.ao, c.tz)
        if mode == "+":
            pickup = self._branch_by_code(db, req.get("BS")) or patron.home_branch
            try:
                hold = circulation.place_hold(db, patron, biblio, pickup_branch_id=pickup.id, actor=None)
            except DomainError as exc:
                db.rollback()
                return failure("15", exc.message, req, c.ao, c.tz)
            available = any(i.status == ItemStatus.available and i.deleted_at is None for i in biblio.items)
            return Reply("16", ["1", p.yn(available), c.now()], [
                ("BR", str(circulation.hold_queue_position(db, hold) or 1)), ("BS", pickup.code),
                ("AO", c.ao), ("AA", patron.card_number), ("AB", item.barcode if item else None),
                ("AJ", biblio.title), ("AF", "Hold placed.")])
        if mode == "-":
            hold = db.scalar(select(Hold).where(Hold.patron_id == patron.id, Hold.biblio_id == biblio.id,
                                                Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES)))
            if hold is None:
                return failure("15", "You have no hold on this title", req, c.ao, c.tz)
            circulation.cancel_hold(db, hold, actor=None)
            return Reply("16", ["1", "N", c.now()], [("AO", c.ao), ("AA", patron.card_number),
                                                     ("AJ", biblio.title), ("AF", "Hold cancelled.")])
        return failure("15", "Changing a hold is not supported", req, c.ao, c.tz)

    # ---------------------------------------------------------------- fees

    def fee_paid(self, c: Ctx) -> Reply:
        db, req = c.db, c.req
        patron = self._patron(c)
        if (err := self._authorised(c, patron)) is not None:
            return failure("37", err, req, c.ao, c.tz)
        assert patron is not None
        amt = p.parse_amount(req.get("BV"))
        if not amt or amt <= 0:
            return failure("37", "Invalid payment amount", req, c.ao, c.tz)
        cur = req.fixed.get("currency_type", "").strip()
        if cur and cur.upper() != get_settings().currency[:3].upper():
            return failure("37", f"Currency {cur} is not accepted", req, c.ao, c.tz)
        owed = circulation.balance(db, patron.id)
        if amt > owed:
            return failure("37", "Payment is more than the amount owed", req, c.ao, c.tz)
        txn = (req.get("BK") or "")[:64]
        circulation.pay(db, patron, amt, actor=None,
                        note=f"SIP2 payment (type {req.fixed.get('payment_type')}) {txn}".strip())
        return Reply("38", ["Y", c.now()], [("AO", c.ao), ("AA", patron.card_number), ("BK", txn or None),
                                            ("AF", f"Thank you. Remaining balance {p.amount(owed - amt)}.")])


# ------------------------------------------------------------------ helpers


def outstanding_charges(db: Session, patron_id: int) -> list[tuple[LedgerEntry, int]]:
    """Charges still (partly) unpaid, with payments and waivers applied oldest-first (FIFO)."""
    entries = db.scalars(select(LedgerEntry).where(LedgerEntry.patron_id == patron_id)
                         .order_by(LedgerEntry.created_at, LedgerEntry.id)).all()
    credit = -sum(e.amount for e in entries if e.amount < 0)
    out = []
    for e in entries:
        if e.amount <= 0 or e.kind in (LedgerKind.payment, LedgerKind.waiver):
            continue
        covered = min(credit, e.amount)
        credit -= covered
        if e.amount - covered > 0:
            out.append((e, e.amount - covered))
    return out


def _int(value: str | None, default: int) -> int:
    try:
        return int((value or "").strip())
    except ValueError:
        return default


def _network_allowed(spec: str | None, ip: str) -> bool:
    if not spec or not spec.strip():
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if addr in ipaddress.ip_network(part, strict=False):
                return True
        except ValueError:
            continue
    return False
