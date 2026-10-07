"""SIP2 wire format (3M Standard Interchange Protocol, version 2.00).

A message is ``<2-digit code><fixed-length fields><variable fields>`` terminated by a carriage
return. Variable fields are ``<2-letter id><value><delimiter>`` (the delimiter is ``|`` by
default). With *error detection* enabled the message ends with ``AY<sequence digit>AZ<checksum>``
where the checksum is the 16-bit two's complement of the byte sum of everything up to and
including ``AZ``, written as four upper-case hex digits.

This module is pure (no I/O, no database) so it can be unit-tested exhaustively.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, tzinfo
from functools import lru_cache

CR = b"\r"
DEFAULT_DELIMITER = "|"
DEFAULT_ENCODING = "utf-8"
PROTOCOL_VERSION = "2.00"


class SipError(Exception):
    """Base class for wire-format problems."""


class MalformedMessage(SipError):
    """The message could not be parsed (unknown code, truncated fixed fields...)."""


class ChecksumError(SipError):
    """The AZ checksum does not match the message contents."""


# Fixed-field layouts for every message (requests SC->ACS and responses ACS->SC; the codes
# do not overlap). Each entry: code -> (name, ((field name, width), ...)).
DATE = 18
LAYOUTS: dict[str, tuple[str, tuple[tuple[str, int], ...]]] = {
    # requests
    "01": ("block_patron", (("card_retained", 1), ("transaction_date", DATE))),
    "09": ("checkin", (("no_block", 1), ("transaction_date", DATE), ("return_date", DATE))),
    "11": ("checkout", (("renewal_policy", 1), ("no_block", 1), ("transaction_date", DATE), ("nb_due_date", DATE))),
    "15": ("hold", (("hold_mode", 1), ("transaction_date", DATE))),
    "17": ("item_information", (("transaction_date", DATE),)),
    "19": ("item_status_update", (("transaction_date", DATE),)),
    "23": ("patron_status", (("language", 3), ("transaction_date", DATE))),
    "25": ("patron_enable", (("transaction_date", DATE),)),
    "29": ("renew", (("third_party_allowed", 1), ("no_block", 1), ("transaction_date", DATE), ("nb_due_date", DATE))),
    "35": ("end_patron_session", (("transaction_date", DATE),)),
    "37": ("fee_paid", (("transaction_date", DATE), ("fee_type", 2), ("payment_type", 2), ("currency_type", 3))),
    "63": ("patron_information", (("language", 3), ("transaction_date", DATE), ("summary", 10))),
    "65": ("renew_all", (("transaction_date", DATE),)),
    "93": ("login", (("uid_algorithm", 1), ("pwd_algorithm", 1))),
    "97": ("request_acs_resend", ()),
    "99": ("sc_status", (("status_code", 1), ("max_print_width", 3), ("protocol_version", 4))),
    # responses
    "10": ("checkin_response", (("ok", 1), ("resensitize", 1), ("magnetic_media", 1), ("alert", 1),
                                ("transaction_date", DATE))),
    "12": ("checkout_response", (("ok", 1), ("renewal_ok", 1), ("magnetic_media", 1), ("desensitize", 1),
                                 ("transaction_date", DATE))),
    "16": ("hold_response", (("ok", 1), ("available", 1), ("transaction_date", DATE))),
    "18": ("item_information_response", (("circulation_status", 2), ("security_marker", 2), ("fee_type", 2),
                                         ("transaction_date", DATE))),
    "20": ("item_status_update_response", (("item_properties_ok", 1), ("transaction_date", DATE))),
    "24": ("patron_status_response", (("patron_status", 14), ("language", 3), ("transaction_date", DATE))),
    "26": ("patron_enable_response", (("patron_status", 14), ("language", 3), ("transaction_date", DATE))),
    "30": ("renew_response", (("ok", 1), ("renewal_ok", 1), ("magnetic_media", 1), ("desensitize", 1),
                              ("transaction_date", DATE))),
    "36": ("end_session_response", (("end_session", 1), ("transaction_date", DATE))),
    "38": ("fee_paid_response", (("payment_accepted", 1), ("transaction_date", DATE))),
    "64": ("patron_information_response", (("patron_status", 14), ("language", 3), ("transaction_date", DATE),
                                           ("hold_items_count", 4), ("overdue_items_count", 4),
                                           ("charged_items_count", 4), ("fine_items_count", 4),
                                           ("recall_items_count", 4), ("unavailable_holds_count", 4))),
    "66": ("renew_all_response", (("ok", 1), ("renewed_count", 4), ("unrenewed_count", 4),
                                  ("transaction_date", DATE))),
    "94": ("login_response", (("ok", 1),)),
    "96": ("request_sc_resend", ()),
    "98": ("acs_status", (("online_status", 1), ("checkin_ok", 1), ("checkout_ok", 1), ("acs_renewal_policy", 1),
                          ("status_update_ok", 1), ("offline_ok", 1), ("timeout_period", 3),
                          ("retries_allowed", 3), ("datetime_sync", DATE), ("protocol_version", 4))),
}

# Variable fields whose values are secrets and must never be logged.
SECRET_FIELDS = ("CO", "AD", "AC")


@dataclass
class Message:
    code: str
    fixed: dict[str, str] = field(default_factory=dict)
    fields: list[tuple[str, str]] = field(default_factory=list)
    sequence: str | None = None
    checksum: str | None = None

    @property
    def name(self) -> str:
        return LAYOUTS.get(self.code, ("unknown", ()))[0]

    def get(self, fid: str, default: str | None = None) -> str | None:
        for k, v in self.fields:
            if k == fid:
                return v
        return default

    def get_all(self, fid: str) -> list[str]:
        return [v for k, v in self.fields if k == fid]


# ------------------------------------------------------------------ checksums


def checksum(data: bytes) -> str:
    """Two's complement of the 16-bit byte sum, as four upper-case hex digits."""
    return f"{(-sum(data)) & 0xFFFF:04X}"


def checksum_ok(data: bytes, value: str) -> bool:
    try:
        return (sum(data) + int(value, 16)) & 0xFFFF == 0
    except ValueError:
        return False


@lru_cache(maxsize=16)
def _trailer_re(delimiter: bytes) -> re.Pattern[bytes]:
    d = re.escape(delimiter)
    return re.compile(rb"(?:" + d + rb"?AY(?P<seq>\d))?" + d + rb"?AZ(?P<cs>[0-9A-Fa-f]{4})$")


# ------------------------------------------------------------------ parsing


def parse(raw: bytes | str, *, delimiter: str = DEFAULT_DELIMITER, encoding: str = DEFAULT_ENCODING,
          verify_checksum: bool = True) -> Message:
    """Parse one message (with or without its CR terminator).

    Raises :class:`MalformedMessage` or :class:`ChecksumError`.
    """
    data = raw if isinstance(raw, bytes) else raw.encode(encoding, errors="replace")
    # Some terminals send a leading LF left over from the previous CR LF pair.
    data = data.strip(b"\r\n\x00")
    if len(data) < 2 or not data[:2].isdigit():
        raise MalformedMessage("Message must start with a two-digit command code")
    code = data[:2].decode("ascii")
    if code not in LAYOUTS:
        raise MalformedMessage(f"Unknown message code {code}")

    sequence = cs = None
    # The trailer is pure ASCII, so it is located on the raw bytes: the checksum must be
    # computed over exactly the bytes that were transmitted (non-ASCII values included).
    m = _trailer_re(delimiter.encode(encoding)).search(data)
    if m:
        sequence = m.group("seq").decode() if m.group("seq") else None
        cs = m.group("cs").decode().upper()
        if verify_checksum:
            covered = data[: m.end() - 4]  # everything up to and including "AZ"
            if not checksum_ok(covered, cs):
                raise ChecksumError(f"Checksum mismatch (got {cs}, expected {checksum(covered)})")
        data = data[: m.start()]
    text = data.decode(encoding, errors="replace")

    name, layout = LAYOUTS[code]
    pos = 2
    fixed: dict[str, str] = {}
    for fname, width in layout:
        value = text[pos : pos + width]
        if len(value) != width:
            raise MalformedMessage(f"{name}: fixed field '{fname}' is truncated")
        fixed[fname] = value
        pos += width

    fields: list[tuple[str, str]] = []
    for token in text[pos:].split(delimiter):
        token = token.strip("\r\n")
        if not token:
            continue
        if len(token) < 2:
            raise MalformedMessage(f"{name}: invalid variable field {token!r}")
        fields.append((token[:2], token[2:]))
    return Message(code=code, fixed=fixed, fields=fields, sequence=sequence, checksum=cs)


# ------------------------------------------------------------------ formatting


def _clean(value: object, delimiter: str) -> str:
    s = "" if value is None else str(value)
    return s.replace(delimiter, " ").replace("\r", " ").replace("\n", " ")


def format_message(code: str, fixed: list[str] | tuple[str, ...], fields: list[tuple[str, object]] = (), *,
                   delimiter: str = DEFAULT_DELIMITER, encoding: str = DEFAULT_ENCODING,
                   sequence: str | None = None, error_detection: bool = False) -> bytes:
    """Build a wire message. Fields whose value is ``None`` are omitted; fixed-field widths
    are validated against :data:`LAYOUTS` so a programming error can never emit a corrupt frame."""
    if code not in LAYOUTS:
        raise ValueError(f"Unknown message code {code}")
    layout = LAYOUTS[code][1]
    if len(fixed) != len(layout):
        raise ValueError(f"{code}: expected {len(layout)} fixed fields, got {len(fixed)}")
    for (fname, width), value in zip(layout, fixed, strict=True):
        if len(value) != width:
            raise ValueError(f"{code}: fixed field {fname} must be {width} chars, got {value!r}")
    parts = [code, *fixed]
    for fid, value in fields:
        if value is None:
            continue
        if len(fid) != 2:
            raise ValueError(f"Invalid field id {fid!r}")
        parts.append(f"{fid}{_clean(value, delimiter)}{delimiter}")
    text = "".join(parts)
    if error_detection or sequence is not None:
        text += f"AY{sequence if sequence is not None else '0'}AZ"
        body = text.encode(encoding, errors="replace")
        return body + checksum(body).encode("ascii") + CR
    return text.encode(encoding, errors="replace") + CR


def build_request(code: str, fixed: list[str], fields: list[tuple[str, object]] = (), **kw) -> bytes:
    """Alias of :func:`format_message` for SC-side (client) messages."""
    return format_message(code, fixed, fields, **kw)


def redact(text: str, delimiter: str = DEFAULT_DELIMITER) -> str:
    """Mask passwords (CO login password, AD patron password, AC terminal password) for logging."""
    d = re.escape(delimiter)
    pattern = rf"(^|{d})({'|'.join(SECRET_FIELDS)})[^{d}]*"
    head = text[:2]
    return head + re.sub(pattern, lambda m: f"{m.group(1)}{m.group(2)}***", text[2:])


# ------------------------------------------------------------------ field helpers


def yn(value: bool | None) -> str:
    return "Y" if value else "N"


def ynu(value: bool | None) -> str:
    return "U" if value is None else yn(value)


def count4(n: int) -> str:
    return f"{max(0, min(int(n), 9999)):04d}"


def amount(minor: int) -> str:
    """Integer minor units -> SIP decimal amount ("12.50")."""
    sign = "-" if minor < 0 else ""
    minor = abs(int(minor))
    return f"{sign}{minor // 100}.{minor % 100:02d}"


def parse_amount(value: str | None) -> int | None:
    """SIP decimal amount -> integer minor units (None if unparsable)."""
    if not value:
        return None
    m = re.fullmatch(r"\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*", value)
    if not m:
        return None
    return int(m.group(1)) * 100 + int((m.group(2) or "0").ljust(2, "0"))


def sip_datetime(dt: datetime | None, tz: tzinfo | None = None) -> str:
    """Naive-UTC datetime -> 18-char ``YYYYMMDDZZZZHHMMSS``. Local time (zone blank) when a
    library time zone is given, otherwise UTC (zone ``   Z``)."""
    if dt is None:
        return " " * DATE
    aware = dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt
    if tz is not None:
        local = aware.astimezone(tz)
        return local.strftime("%Y%m%d") + "    " + local.strftime("%H%M%S")
    u = aware.astimezone(UTC)
    return u.strftime("%Y%m%d") + "   Z" + u.strftime("%H%M%S")


def parse_sip_datetime(value: str | None, tz: tzinfo | None = None) -> datetime | None:
    """18-char SIP timestamp -> naive UTC datetime (None when blank or invalid)."""
    if not value or not value.strip() or len(value) < DATE:
        return None
    date_part, zone, time_part = value[:8], value[8:12], value[12:18]
    try:
        dt = datetime.strptime(date_part + time_part.replace(" ", "0"), "%Y%m%d%H%M%S")
    except ValueError:
        return None
    if zone.strip().upper() in ("Z", "UTC", "GMT"):
        return dt
    local = dt.replace(tzinfo=tz or UTC)
    return local.astimezone(UTC).replace(tzinfo=None)
