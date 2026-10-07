"""Patron notices: templates, messaging preferences and the delivery outbox.

* **Templates** (``NoticeTemplate``) are edited by staff and rendered with Jinja2's
  :class:`~jinja2.sandbox.ImmutableSandboxedEnvironment` — never the normal environment — from a context of
  plain dicts/strings (no ORM objects), so a template cannot reach Python internals or the database.
  Built-in defaults (:data:`DEFAULT_TEMPLATES`) apply until a template is customised.
* **Preferences** (``MessagePreference``): per notice type, a patron chooses ``email``, ``sms`` or ``none``.
* **Outbox**: every notice is a ``Notification`` row (``pending`` → ``sent`` | ``failed``).
  :func:`deliver_pending` sends due rows through the configured backend (console/log, SMTP, SMS webhook),
  retrying transient failures with exponential backoff.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, parseaddr
from functools import lru_cache
from typing import Any, Protocol

import httpx
from jinja2 import TemplateError
from jinja2.sandbox import ImmutableSandboxedEnvironment, SecurityError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..errors import NotFound, PolicyBlocked
from ..models import MessagePreference, NoticeTemplate, Notification, Patron, utcnow
from . import audit
from . import settings as settings_svc

log = logging.getLogger("shelfwise.notices")

CHANNELS = ("email", "sms")
PREFERENCE_CHOICES = ("email", "sms", "none")
MAX_OUTPUT = 50_000  # characters a rendered template may produce
SMS_MAX = 640

# code -> (label, patron may opt out / choose channel, description)
CODES: dict[str, tuple[str, bool, str]] = {
    "HOLD_READY": ("Hold ready for pickup", True, "A held item is waiting on the hold shelf"),
    "DUE_SOON": ("Due soon (courtesy)", True, "Sent the day before an item is due"),
    "OVERDUE": ("Overdue", True, "Sent 1, 7 and 14 days after the due date"),
    "PURCHASE_SUGGESTION_UPDATE": ("Purchase suggestion update", True, "A purchase suggestion changed status"),
    "WELCOME": ("Welcome", False, "A new account created by staff"),
    "REGISTRATION_APPROVED": ("Registration approved", False, "An OPAC self-registration was approved"),
    "REGISTRATION_REJECTED": ("Registration not approved", False, "An OPAC self-registration was rejected"),
}

_SIGN = "\n\n— {{ library.name }}"
DEFAULT_TEMPLATES: dict[tuple[str, str], tuple[str, str]] = {
    ("HOLD_READY", "email"): (
        "Your hold is ready for pickup",
        "Dear {{ patron.first_name }},\n\n“{{ biblio.title }}” is waiting for you at {{ hold.pickup_branch }}."
        "\nPlease collect it by {{ hold.pickup_by }}.{% if item.call_number %}\nCall number: {{ item.call_number }}"
        "{% endif %}" + _SIGN),
    ("HOLD_READY", "sms"): (
        "", "{{ library.name }}: “{{ biblio.title|truncate(60) }}” is ready at {{ hold.pickup_branch }} "
            "until {{ hold.pickup_by }}."),
    ("DUE_SOON", "email"): (
        "Due tomorrow",
        "Dear {{ patron.first_name }},\n\n“{{ biblio.title }}” is due back on {{ loan.due_date }}."
        "\nYou can renew it online from your account if no one is waiting for it." + _SIGN),
    ("DUE_SOON", "sms"): ("", "{{ library.name }}: “{{ biblio.title|truncate(60) }}” is due {{ loan.due_date }}."),
    ("OVERDUE", "email"): (
        "Overdue item",
        "Dear {{ patron.first_name }},\n\n“{{ biblio.title }}” was due on {{ loan.due_date }} and is now "
        "{{ loan.days_overdue }} day{{ 's' if loan.days_overdue != 1 }} overdue. Please return or renew it." + _SIGN),
    ("OVERDUE", "sms"): (
        "", "{{ library.name }}: “{{ biblio.title|truncate(60) }}” was due {{ loan.due_date }}. Please return it."),
    ("PURCHASE_SUGGESTION_UPDATE", "email"): (
        "Your purchase suggestion: {{ suggestion.status_label }}",
        "Dear {{ patron.first_name }},\n\nYour suggestion “{{ suggestion.title }}” is now: "
        "{{ suggestion.status_label }}.{% if suggestion.note %}\n\nNote from the library: {{ suggestion.note }}"
        "{% endif %}\n\nThank you for helping us build the collection." + _SIGN),
    ("PURCHASE_SUGGESTION_UPDATE", "sms"): (
        "", "{{ library.name }}: your suggestion “{{ suggestion.title|truncate(50) }}” is {{ suggestion.status_label }}."),
    ("WELCOME", "email"): (
        "Welcome to {{ library.name }}",
        "Dear {{ patron.first_name }},\n\nWelcome! Your library card number is {{ patron.card_number }}."
        "{% if patron.expires_on %} Your membership is valid until {{ patron.expires_on }}.{% endif %}"
        "\n\nSearch the catalogue, place holds and manage your loans online at any time." + _SIGN),
    ("WELCOME", "sms"): ("", "Welcome to {{ library.name }}! Your card number is {{ patron.card_number }}."),
    ("REGISTRATION_APPROVED", "email"): (
        "Your library registration is approved",
        "Dear {{ patron.first_name }},\n\nGood news — your registration has been approved and your account "
        "is now active.\nCard number: {{ patron.card_number }}\nHome branch: {{ patron.home_branch }}"
        "{% if patron.expires_on %}\nValid until: {{ patron.expires_on }}{% endif %}"
        "\n\nSign in with your email address and the password you chose." + _SIGN),
    ("REGISTRATION_APPROVED", "sms"): (
        "", "{{ library.name }}: your registration is approved. Card number {{ patron.card_number }}."),
    ("REGISTRATION_REJECTED", "email"): (
        "Your library registration",
        "Dear {{ patron.first_name }},\n\nWe were unable to approve your registration."
        "{% if registration.reason %}\nReason: {{ registration.reason }}{% endif %}"
        "\n\nPlease visit any branch with proof of address and we will be happy to help." + _SIGN),
    ("REGISTRATION_REJECTED", "sms"): (
        "", "{{ library.name }}: we could not approve your registration. Please visit a branch."),
}

SUGGESTION_LABELS = {"pending": "Under review", "accepted": "Accepted", "ordered": "Ordered",
                     "rejected": "Not accepted", "withdrawn": "Withdrawn"}


# ------------------------------------------------------------------ sandboxed rendering


class _NoticeEnvironment(ImmutableSandboxedEnvironment):
    """Sandbox that fails loudly on unsafe attribute access and refuses huge/expensive expressions."""

    intercepted_binops = frozenset({"*", "**"})

    def unsafe_undefined(self, obj: Any, attribute: str):
        raise SecurityError(f"access to attribute {attribute!r} of {type(obj).__name__!r} object is not allowed")

    def call_binop(self, context, operator, left, right):
        if operator == "**":
            raise SecurityError("the power operator is not allowed in notice templates")
        if operator == "*":
            for seq, n in ((left, right), (right, left)):
                if isinstance(seq, str | list | tuple) and isinstance(n, int) and len(seq) * n > MAX_OUTPUT:
                    raise SecurityError("expression result is too large")
        return super().call_binop(context, operator, left, right)


_env = _NoticeEnvironment(autoescape=False)  # plain text; Jinja's default whitespace handling


class TemplateProblem(PolicyBlocked):
    code = "template_error"


@lru_cache(maxsize=256)
def _compile(source: str):
    return _env.from_string(source)


def render_string(source: str, context: dict) -> str:
    """Render one template string in the sandbox. Raises :class:`TemplateProblem` on any error."""
    try:
        out = _compile(source or "").render(context)
    except SecurityError as exc:
        raise TemplateProblem(f"Blocked by the template sandbox: {exc}") from exc
    except TemplateError as exc:
        line = getattr(exc, "lineno", None)
        raise TemplateProblem(f"Template error{f' on line {line}' if line else ''}: {exc.message or exc}") from exc
    except Exception as exc:  # e.g. division by zero, bad filter argument
        raise TemplateProblem(f"Template error: {type(exc).__name__}: {exc}") from exc
    if len(out) > MAX_OUTPUT:
        raise TemplateProblem("Rendered notice is too long")
    return out


def render(subject: str, body: str, context: dict, *, channel: str = "email") -> tuple[str, str]:
    subj = " ".join(render_string(subject, context).split())[:255] if channel == "email" else ""
    text = render_string(body, context).strip()
    if channel == "sms":
        text = " ".join(text.split())[:SMS_MAX]
    return subj, text


# ------------------------------------------------------------------ plain-dict contexts


def fmt_date(v: date | datetime | None) -> str:
    return v.strftime("%d %b %Y") if v else ""


def patron_ctx(p: Patron) -> dict:
    return {"first_name": p.first_name, "last_name": p.last_name, "full_name": p.full_name,
            "card_number": p.card_number, "email": p.email or "", "phone": p.phone or "",
            "home_branch": p.home_branch.name if p.home_branch else "", "expires_on": fmt_date(p.expires_on)}


def library_ctx(db: Session) -> dict:
    return {"name": str(settings_svc.get(db, "library_name") or "")}


def biblio_ctx(b) -> dict:
    return {"id": b.id, "title": b.title, "author": "; ".join(b.authors or []), "isbn": b.isbn or ""}


def item_ctx(i) -> dict:
    return {"barcode": i.barcode, "call_number": i.call_number or "", "branch": i.branch.name if i.branch else ""}


def hold_ctx(h) -> dict:
    return {"pickup_branch": h.pickup_branch.name if h.pickup_branch else "", "pickup_by": fmt_date(h.expires_at),
            "notes": h.notes or ""}


def loan_ctx(loan, now: datetime | None = None) -> dict:
    now = now or utcnow()
    return {"due_date": fmt_date(loan.due_at), "issued_on": fmt_date(loan.issued_at), "renewals": loan.renewals,
            "days_overdue": max(0, (now.date() - loan.due_at.date()).days)}


def hold_ready_context(hold, item) -> dict:
    return {"biblio": biblio_ctx(item.biblio), "item": item_ctx(item), "hold": hold_ctx(hold)}


def loan_context(loan, now: datetime | None = None) -> dict:
    return {"biblio": biblio_ctx(loan.item.biblio), "item": item_ctx(loan.item), "loan": loan_ctx(loan, now)}


SAMPLE_PATRON = {"first_name": "Ananya", "last_name": "Iyer", "full_name": "Ananya Iyer", "card_number": "1000000001",
                 "email": "ananya@example.org", "phone": "+91 98765 43210", "home_branch": "Central Library",
                 "expires_on": "31 Dec 2027"}


def sample_context(db: Session, code: str, patron: Patron | None = None) -> dict:
    """Realistic example data for previews (optionally for a real patron)."""
    ctx: dict[str, Any] = {
        "patron": patron_ctx(patron) if patron else dict(SAMPLE_PATRON),
        "library": library_ctx(db),
        "biblio": {"id": 1, "title": "The Left Hand of Darkness", "author": "Le Guin, Ursula K.", "isbn": "9780441478125"},
        "item": {"barcode": "SW000123", "call_number": "813.54 LEG", "branch": "Central Library"},
        "hold": {"pickup_branch": "Central Library", "pickup_by": fmt_date(utcnow() + timedelta(days=7)), "notes": ""},
        "loan": {"due_date": fmt_date(utcnow() + timedelta(days=1)), "issued_on": fmt_date(utcnow() - timedelta(days=13)),
                 "renewals": 0, "days_overdue": 3 if code == "OVERDUE" else 0},
        "suggestion": {"title": "Project Hail Mary", "author": "Weir, Andy", "status": "accepted",
                       "status_label": "Accepted", "note": "We have ordered two copies."},
        "registration": {"reason": "We could not verify the address provided."},
    }
    return ctx


# ------------------------------------------------------------------ templates


def _row(db: Session, code: str, channel: str) -> NoticeTemplate | None:
    return db.scalar(select(NoticeTemplate).where(NoticeTemplate.code == code, NoticeTemplate.channel == channel))


def _check_code(code: str, channel: str) -> None:
    if code not in CODES:
        raise NotFound(f"Unknown notice code {code!r}")
    if channel not in CHANNELS:
        raise PolicyBlocked("Channel must be email or sms")


def get_template(db: Session, code: str, channel: str) -> tuple[str, str] | None:
    """(subject, body) for a code/channel, or None when that notice is switched off for the channel."""
    row = _row(db, code, channel)
    if row is not None:
        return (row.subject, row.body) if row.is_active else None
    return DEFAULT_TEMPLATES.get((code, channel))


def template_out(db: Session, code: str, channel: str) -> dict:
    row = _row(db, code, channel)
    default = DEFAULT_TEMPLATES.get((code, channel), ("", ""))
    label, configurable, description = CODES[code]
    return {"code": code, "name": label, "description": description, "patron_configurable": configurable,
            "channel": channel, "subject": row.subject if row else default[0], "body": row.body if row else default[1],
            "is_active": row.is_active if row else True, "customized": row is not None,
            "updated_at": row.updated_at if row else None}


def list_templates(db: Session) -> list[dict]:
    return [template_out(db, code, ch) for code in CODES for ch in CHANNELS]


def save_template(db: Session, code: str, channel: str, *, subject: str, body: str, is_active: bool = True,
                  actor: Patron | None = None) -> dict:
    _check_code(code, channel)
    if not body.strip():
        raise PolicyBlocked("The notice body cannot be empty")
    if channel == "email" and not subject.strip():
        raise PolicyBlocked("Email notices need a subject")
    render(subject, body, sample_context(db, code), channel=channel)  # validate before saving
    row = _row(db, code, channel)
    if row is None:
        row = NoticeTemplate(code=code, channel=channel)
        db.add(row)
    row.subject, row.body, row.is_active = subject, body, is_active
    row.updated_by_id = actor.id if actor else None
    db.flush()
    audit.record(db, "notice_template_saved", "notice_template", row.id, actor=actor, code=code, channel=channel,
                 active=is_active)
    return template_out(db, code, channel)


def reset_template(db: Session, code: str, channel: str, *, actor: Patron | None = None) -> dict:
    _check_code(code, channel)
    row = _row(db, code, channel)
    if row is not None:
        audit.record(db, "notice_template_reset", "notice_template", row.id, actor=actor, code=code, channel=channel)
        db.delete(row)
        db.flush()
    return template_out(db, code, channel)


def preview(db: Session, code: str, channel: str, subject: str, body: str, patron: Patron | None = None) -> dict:
    _check_code(code, channel)
    subj, text = render(subject, body, sample_context(db, code, patron), channel=channel)
    return {"subject": subj, "body": text}


def ensure_default_templates(db: Session) -> int:
    """Materialise the built-in templates as editable rows (idempotent). Returns rows created."""
    created = 0
    for (code, channel), (subject, body) in DEFAULT_TEMPLATES.items():
        if _row(db, code, channel) is None:
            db.add(NoticeTemplate(code=code, channel=channel, subject=subject, body=body))
            created += 1
    db.flush()
    return created


# ------------------------------------------------------------------ messaging preferences


def _default_channel(patron: Patron) -> str:
    return "email" if patron.email or not patron.phone else "sms"


def preferred_channel(db: Session, patron: Patron, code: str) -> str:
    configurable = CODES.get(code, ("", False, ""))[1]
    if configurable:
        pref = db.scalar(select(MessagePreference.channel).where(MessagePreference.patron_id == patron.id,
                                                                 MessagePreference.code == code))
        if pref in PREFERENCE_CHOICES:
            return pref
    return _default_channel(patron)


def get_preferences(db: Session, patron: Patron) -> list[dict]:
    stored = dict(db.execute(select(MessagePreference.code, MessagePreference.channel)
                             .where(MessagePreference.patron_id == patron.id)).all())
    return [{"code": code, "name": label, "description": desc, "channel": stored.get(code, _default_channel(patron))}
            for code, (label, configurable, desc) in CODES.items() if configurable]


def set_preferences(db: Session, patron: Patron, prefs: dict[str, str], *, actor: Patron | None = None) -> list[dict]:
    for code, channel in prefs.items():
        if code not in CODES or not CODES[code][1]:
            raise PolicyBlocked(f"{code} is not a configurable notice")
        if channel not in PREFERENCE_CHOICES:
            raise PolicyBlocked("Channel must be email, sms or none")
        if channel == "email" and not patron.email:
            raise PolicyBlocked("Add an email address to the account before choosing email notices")
        if channel == "sms" and not patron.phone:
            raise PolicyBlocked("Add a phone number to the account before choosing SMS notices")
        row = db.scalar(select(MessagePreference).where(MessagePreference.patron_id == patron.id,
                                                        MessagePreference.code == code))
        if row is None:
            db.add(MessagePreference(patron_id=patron.id, code=code, channel=channel))
        else:
            row.channel = channel
    db.flush()
    audit.record(db, "messaging_preferences", "patron", patron.id, actor=actor, prefs=prefs)
    return get_preferences(db, patron)


# ------------------------------------------------------------------ queueing


def _address(patron: Patron, channel: str) -> str | None:
    return (patron.email if channel == "email" else patron.phone) or None


def queue(db: Session, patron: Patron, code: str, context: dict | None = None, *, fallback_subject: str | None = None,
          fallback_body: str | None = None, channel: str | None = None) -> list[Notification]:
    """Render notice ``code`` for ``patron`` on their preferred channel and add it to the outbox.

    Returns the queued rows (empty when the patron opted out or the template is switched off).
    A broken custom template never loses a notice: the built-in default (or the caller's fallback
    text) is used instead and the problem is logged.
    """
    channel = channel or preferred_channel(db, patron, code)
    if channel == "none":
        return []
    if channel == "sms" and not patron.phone and patron.email:
        channel = "email"
    elif channel == "email" and not patron.email and patron.phone and get_template(db, code, "sms"):
        channel = "sms"
    tpl = get_template(db, code, channel)
    if tpl is None:
        if _row(db, code, channel) is not None:  # explicitly switched off
            return []
        if fallback_body is None:
            return []
        tpl = (fallback_subject or "", fallback_body)
    ctx = {"patron": patron_ctx(patron), "library": library_ctx(db), **(context or {})}
    try:
        subject, body = render(tpl[0], tpl[1], ctx, channel=channel)
    except TemplateProblem as exc:
        log.warning("notice %s/%s template failed (%s); using default text", code, channel, exc.message)
        default = DEFAULT_TEMPLATES.get((code, channel))
        try:
            subject, body = render(default[0], default[1], ctx, channel=channel) if default else ("", "")
        except TemplateProblem:
            subject, body = "", ""
        if not body:
            subject, body = fallback_subject or CODES.get(code, (code,))[0], fallback_body or ""
    n = Notification(patron_id=patron.id, channel=channel, code=code, subject=subject or CODES.get(code, (code,))[0],
                     body=body, to_address=_address(patron, channel), status="pending")
    db.add(n)
    return [n]


# ------------------------------------------------------------------ delivery backends


@dataclass
class OutgoingMessage:
    id: int
    channel: str
    to: str | None
    subject: str
    body: str
    code: str | None = None


class DeliveryError(Exception):
    def __init__(self, message: str, *, permanent: bool = False):
        super().__init__(message)
        self.permanent = permanent


class Backend(Protocol):
    name: str

    def send(self, msg: OutgoingMessage) -> None: ...

    def close(self) -> None: ...


class ConsoleBackend:
    """Development default: writes the notice to the application log instead of sending it."""

    name = "console"

    def send(self, msg: OutgoingMessage) -> None:
        log.info("[notice #%s %s → %s] %s\n%s", msg.id, msg.channel, msg.to or "(no address)", msg.subject, msg.body)

    def close(self) -> None:
        pass


class SmtpBackend:
    """Sends email through an SMTP relay (STARTTLS or implicit TLS), reusing one connection per batch."""

    name = "smtp"

    def __init__(self, settings: Settings):
        self.s = settings
        self._conn: smtplib.SMTP | None = None

    def _connect(self) -> smtplib.SMTP:
        if self._conn is None:
            s = self.s
            if s.smtp_ssl:
                conn: smtplib.SMTP = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=s.smtp_timeout,
                                                      context=ssl.create_default_context())
            else:
                conn = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=s.smtp_timeout)
                if s.smtp_starttls:
                    conn.starttls(context=ssl.create_default_context())
            if s.smtp_username:
                conn.login(s.smtp_username, s.smtp_password or "")
            self._conn = conn
        return self._conn

    def send(self, msg: OutgoingMessage) -> None:
        if not msg.to:
            raise DeliveryError("Patron has no email address", permanent=True)
        em = EmailMessage()
        name, addr = parseaddr(self.s.smtp_from)
        em["From"] = formataddr((name, addr)) if name else addr
        em["To"] = msg.to
        em["Subject"] = msg.subject
        em["Message-ID"] = make_msgid(domain=addr.split("@")[-1] if "@" in addr else None)
        em["Auto-Submitted"] = "auto-generated"
        if msg.code:
            em["X-Shelfwise-Notice"] = msg.code
        em.set_content(msg.body)
        try:
            self._connect().send_message(em)
        except smtplib.SMTPRecipientsRefused as exc:
            raise DeliveryError(f"Recipient refused: {msg.to}", permanent=True) from exc
        except (smtplib.SMTPException, OSError) as exc:
            self.close()
            raise DeliveryError(f"SMTP error: {exc}") from exc

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.quit()
            except (smtplib.SMTPException, OSError):
                pass
            self._conn = None


class SmsWebhookBackend:
    """POSTs ``{"to", "body", "notice_id", "code"}`` as JSON to an SMS gateway webhook."""

    name = "webhook"

    def __init__(self, settings: Settings):
        self.s = settings

    def send(self, msg: OutgoingMessage) -> None:
        if not self.s.sms_webhook_url:
            raise DeliveryError("SMS webhook URL is not configured (SHELFWISE_SMS_WEBHOOK_URL)")
        if not msg.to:
            raise DeliveryError("Patron has no phone number", permanent=True)
        headers = {"Authorization": f"Bearer {self.s.sms_webhook_token}"} if self.s.sms_webhook_token else {}
        try:
            r = httpx.post(self.s.sms_webhook_url, json={"to": msg.to, "body": msg.body, "notice_id": msg.id,
                                                          "code": msg.code},
                           headers=headers, timeout=self.s.sms_webhook_timeout)
        except httpx.HTTPError as exc:
            raise DeliveryError(f"SMS webhook unreachable: {exc}") from exc
        if r.status_code >= 500 or r.status_code == 429:
            raise DeliveryError(f"SMS webhook returned HTTP {r.status_code}")
        if r.status_code >= 400:
            raise DeliveryError(f"SMS webhook rejected the message (HTTP {r.status_code})", permanent=True)

    def close(self) -> None:
        pass


def default_backends(settings: Settings | None = None) -> dict[str, Backend]:
    s = settings or get_settings()
    email: Backend = SmtpBackend(s) if s.email_backend == "smtp" else ConsoleBackend()
    sms: Backend = SmsWebhookBackend(s) if s.sms_backend == "webhook" else ConsoleBackend()
    return {"email": email, "sms": sms}


def backoff(attempts: int) -> timedelta:
    """1, 2, 4, 8 … minutes, capped at six hours."""
    return timedelta(seconds=min(60 * 2 ** max(attempts - 1, 0), 6 * 3600))


def _due(now: datetime):
    return [Notification.status == "pending",
            or_(Notification.next_attempt_at.is_(None), Notification.next_attempt_at <= now)]


def deliver_pending(db: Session, limit: int = 100, *, now: datetime | None = None,
                    backends: dict[str, Backend] | None = None) -> dict:
    """Send up to ``limit`` due notices. Commits after each message so a crash never re-sends one.

    Rows are claimed one at a time with ``SELECT … FOR UPDATE SKIP LOCKED`` (PostgreSQL) so several
    workers can run concurrently. Transient failures are retried with exponential backoff until the
    ``notice_max_attempts`` policy is reached; permanent failures (no address, recipient refused) fail at once.
    """
    now = now or utcnow()
    backends = backends or default_backends()
    max_attempts = max(1, int(settings_svc.get(db, "notice_max_attempts") or 5))
    stats = {"sent": 0, "retry": 0, "failed": 0}
    seen: set[int] = set()
    try:
        for _ in range(max(0, limit)):
            stmt = select(Notification).where(*_due(now))
            if seen:
                stmt = stmt.where(Notification.id.not_in(seen))
            n = db.scalar(stmt.order_by(Notification.created_at, Notification.id).limit(1)
                          .with_for_update(skip_locked=True, of=Notification))  # lock only the notice row
            if n is None:
                break
            seen.add(n.id)
            patron = db.get(Patron, n.patron_id)
            to = n.to_address or (_address(patron, n.channel) if patron else None)
            backend = backends.get(n.channel)
            n.attempts = (n.attempts or 0) + 1
            try:
                if backend is None:
                    raise DeliveryError(f"No delivery backend for channel {n.channel!r}", permanent=True)
                backend.send(OutgoingMessage(id=n.id, channel=n.channel, to=to, subject=n.subject, body=n.body,
                                             code=n.code))
            except Exception as exc:  # any backend failure is recorded on the row, never raised
                permanent = isinstance(exc, DeliveryError) and exc.permanent
                n.last_error = str(exc)[:1000] or type(exc).__name__
                if permanent or n.attempts >= max_attempts:
                    n.status, n.next_attempt_at = "failed", None
                    stats["failed"] += 1
                else:
                    n.next_attempt_at = now + backoff(n.attempts)
                    stats["retry"] += 1
            else:
                n.status, n.sent_at, n.last_error, n.next_attempt_at, n.to_address = "sent", now, None, None, to
                stats["sent"] += 1
            db.commit()
    finally:
        for b in {id(b): b for b in backends.values()}.values():
            b.close()
    return stats


# ------------------------------------------------------------------ outbox (staff)


def notification_out(n: Notification) -> dict:
    return {"id": n.id, "code": n.code, "channel": n.channel, "subject": n.subject, "body": n.body,
            "status": n.status, "to": n.to_address, "attempts": n.attempts or 0, "last_error": n.last_error,
            "created_at": n.created_at, "sent_at": n.sent_at, "next_attempt_at": n.next_attempt_at,
            "patron": {"id": n.patron.id, "card_number": n.patron.card_number, "full_name": n.patron.full_name}
            if n.patron else None}


def outbox(db: Session, *, status: str | None = None, channel: str | None = None, code: str | None = None,
           patron_id: int | None = None, page: int = 1, per_page: int = 50) -> dict:
    stmt = select(Notification)
    if status:
        stmt = stmt.where(Notification.status == status)
    if channel:
        stmt = stmt.where(Notification.channel == channel)
    if code:
        stmt = stmt.where(Notification.code == code)
    if patron_id:
        stmt = stmt.where(Notification.patron_id == patron_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(Notification.created_at.desc(), Notification.id.desc())
                      .offset((page - 1) * per_page).limit(per_page)).all()
    counts = dict(db.execute(select(Notification.status, func.count()).group_by(Notification.status)).all())
    return {"total": total, "page": page, "counts": counts, "results": [notification_out(n) for n in rows]}


def resend(db: Session, notification_id: int, *, actor: Patron | None = None) -> Notification:
    n = db.get(Notification, notification_id)
    if n is None:
        raise NotFound("Notice not found")
    patron = db.get(Patron, n.patron_id)
    if patron is not None:
        n.to_address = _address(patron, n.channel) or n.to_address
    n.status, n.attempts, n.last_error, n.next_attempt_at, n.sent_at = "pending", 0, None, None, None
    db.flush()
    audit.record(db, "notice_resend", "notification", n.id, actor=actor)
    return n
