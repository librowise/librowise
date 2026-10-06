"""OAI-PMH 2.0 data provider at ``/oai``.

* Verbs: Identify, ListMetadataFormats, ListSets, ListIdentifiers, ListRecords, GetRecord.
* Formats: ``oai_dc`` and ``marc21`` (MARCXML).
* Sets: one per material type (``book``, ``dvd``...).
* Datestamps are the record's ``updated_at`` (UTC, seconds granularity).
* Deleted records are kept (``deletedRecord=persistent``) thanks to soft deletes.
* Resumption tokens are opaque, signed and expire after 24 hours; paging is keyset-based on
  (datestamp, id), so records changing during a harvest are never skipped.

Configuration (environment): ``SHELFWISE_OAI_REPOSITORY_ID`` (default ``shelfwise.local``),
``SHELFWISE_OAI_ADMIN_EMAIL`` and ``SHELFWISE_OAI_PAGE_SIZE`` (default 100).
"""

from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..db import get_db
from ..models import Biblio, Branch, utcnow
from ..services import settings as settings_svc
from .ratelimit import check_rate
from .xmlutil import MARC, OAI, OAI_DC, OAI_ID, XSI, dc_element, marc_element, q, sub, tostring, utc_stamp

router = APIRouter(tags=["interoperability"])

O = ""  # OAI-PMH elements live in the default namespace (declared on the root element)
TOKEN_TTL = timedelta(hours=24)
MATERIAL_NAMES = {"book": "Books", "ebook": "E-books", "audiobook": "Audiobooks", "dvd": "DVDs and video",
                  "serial": "Magazines and serials", "comic": "Graphic novels"}
FORMATS = {
    "oai_dc": ("http://www.openarchives.org/OAI/2.0/oai_dc.xsd", OAI_DC),
    "marc21": ("http://www.loc.gov/standards/marcxml/schema/MARC21slim.xsd", MARC),
}
VERB_ARGS = {
    "Identify": (set(), set()),
    "ListMetadataFormats": (set(), {"identifier"}),
    "ListSets": (set(), set()),
    "ListIdentifiers": ({"metadataPrefix"}, {"from", "until", "set"}),
    "ListRecords": ({"metadataPrefix"}, {"from", "until", "set"}),
    "GetRecord": ({"identifier", "metadataPrefix"}, set()),
}
_SET_RE = re.compile(r"^[A-Za-z0-9\-_.!~*'()]+$")


def repository_id() -> str:
    return os.environ.get("SHELFWISE_OAI_REPOSITORY_ID", "shelfwise.local")


def page_size() -> int:
    try:
        return max(1, int(os.environ.get("SHELFWISE_OAI_PAGE_SIZE", "100")))
    except ValueError:
        return 100


def oai_identifier(biblio_id: int) -> str:
    return f"oai:{repository_id()}:{biblio_id}"


def _parse_identifier(identifier: str) -> int | None:
    m = re.fullmatch(rf"oai:{re.escape(repository_id())}:(\d{{1,12}})", identifier or "")
    return int(m.group(1)) if m else None


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="shelfwise.oai.resumption.v1")


class OAIError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@router.api_route("/oai", methods=["GET", "POST"], summary="OAI-PMH 2.0 data provider")
async def oai(request: Request, db: Session = Depends(get_db)):
    check_rate(request, "oai")
    pairs = list(request.query_params.multi_items())
    if request.method == "POST":
        form = await request.form()
        pairs += [(k, str(v)) for k, v in form.multi_items()]
    base = f"{str(request.base_url).rstrip('/')}/oai"
    xml = await run_in_threadpool(handle, db, pairs, base, str(request.base_url).rstrip("/"))
    return Response(xml, media_type="text/xml; charset=utf-8")


def handle(db: Session, pairs: list[tuple[str, str]], base_url: str, site: str) -> bytes:
    root = ET.Element("OAI-PMH")
    # OAI elements are written unprefixed under a default namespace declaration, the form most
    # harvesters expect (ElementTree's default_namespace option rejects unqualified attributes).
    root.set("xmlns", OAI)
    root.set(q(XSI, "schemaLocation"), f"{OAI} http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd")
    sub(root, O, "responseDate", utc_stamp(utcnow()))
    request_el = sub(root, O, "request", base_url)
    try:
        args = _validate(pairs)
        for k, v in args.items():
            request_el.set(k, v)
        verb = args.pop("verb")
        body = {
            "Identify": _identify, "ListMetadataFormats": _list_formats, "ListSets": _list_sets,
            "ListIdentifiers": _list, "ListRecords": _list, "GetRecord": _get_record,
        }[verb](db, verb, args, base_url, site)
        root.append(body)
    except OAIError as err:
        if err.code in ("badVerb", "badArgument"):
            request_el.attrib.clear()  # the spec forbids echoing attributes for these errors
        el = sub(root, O, "error", err.message)
        el.set("code", err.code)
    return tostring(root)


def _validate(pairs: list[tuple[str, str]]) -> dict[str, str]:
    seen: dict[str, str] = {}
    for k, v in pairs:
        if k in seen:
            raise OAIError("badVerb" if k == "verb" else "badArgument", f"Repeated argument '{k}'")
        seen[k] = v
    verb = seen.get("verb")
    if not verb:
        raise OAIError("badVerb", "Missing verb argument")
    if verb not in VERB_ARGS:
        raise OAIError("badVerb", f"Illegal verb '{verb}'")
    required, optional = VERB_ARGS[verb]
    args = {k: v for k, v in seen.items() if k != "verb"}
    exclusive = verb in ("ListIdentifiers", "ListRecords", "ListSets")
    if exclusive and "resumptionToken" in args:
        if len(args) > 1:
            raise OAIError("badArgument", "resumptionToken is an exclusive argument")
        return {"verb": verb, **args}
    for k in args:
        if k not in required | optional:
            raise OAIError("badArgument", f"Illegal argument '{k}' for {verb}")
    for k in required:
        if not args.get(k):
            raise OAIError("badArgument", f"Missing required argument '{k}'")
    return {"verb": verb, **args}


# ------------------------------------------------------------------ verbs


def _identify(db: Session, verb: str, args: dict, base_url: str, site: str) -> ET.Element:
    el = ET.Element(q(O, verb))
    sub(el, O, "repositoryName", settings_svc.get(db, "library_name"))
    sub(el, O, "baseURL", base_url)
    sub(el, O, "protocolVersion", "2.0")
    email = os.environ.get("SHELFWISE_OAI_ADMIN_EMAIL") or db.scalar(
        select(Branch.email).where(Branch.email.is_not(None), Branch.email != "").order_by(Branch.id).limit(1))
    sub(el, O, "adminEmail", email or f"library@{repository_id()}")
    earliest = db.scalar(select(func.min(Biblio.updated_at)))
    sub(el, O, "earliestDatestamp", utc_stamp(earliest or datetime(1970, 1, 1)))
    sub(el, O, "deletedRecord", "persistent")
    sub(el, O, "granularity", "YYYY-MM-DDThh:mm:ssZ")
    desc = sub(el, O, "description")
    ident = sub(desc, OAI_ID, "oai-identifier")
    ident.set(q(XSI, "schemaLocation"), f"{OAI_ID} http://www.openarchives.org/OAI/2.0/oai-identifier.xsd")
    sub(ident, OAI_ID, "scheme", "oai")
    sub(ident, OAI_ID, "repositoryIdentifier", repository_id())
    sub(ident, OAI_ID, "delimiter", ":")
    sub(ident, OAI_ID, "sampleIdentifier", oai_identifier(1))
    return el


def _list_formats(db: Session, verb: str, args: dict, base_url: str, site: str) -> ET.Element:
    if "identifier" in args:
        bid = _parse_identifier(args["identifier"])
        if bid is None or db.get(Biblio, bid) is None:
            raise OAIError("idDoesNotExist", f"No record with identifier '{args['identifier']}'")
    el = ET.Element(q(O, verb))
    for prefix, (schema, ns) in FORMATS.items():
        fmt = sub(el, O, "metadataFormat")
        sub(fmt, O, "metadataPrefix", prefix)
        sub(fmt, O, "schema", schema)
        sub(fmt, O, "metadataNamespace", ns)
    return el


def _set_specs(db: Session) -> list[str]:
    found = {t for t in db.scalars(select(Biblio.material_type).distinct()) if t and _SET_RE.match(t)}
    return sorted(found | set(MATERIAL_NAMES))


def _list_sets(db: Session, verb: str, args: dict, base_url: str, site: str) -> ET.Element:
    if "resumptionToken" in args:
        raise OAIError("badResumptionToken", "The set list is never split; resumption tokens are not valid here")
    el = ET.Element(q(O, verb))
    for spec in _set_specs(db):
        s = sub(el, O, "set")
        sub(s, O, "setSpec", spec)
        sub(s, O, "setName", MATERIAL_NAMES.get(spec, spec.replace("_", " ").title()))
    return el


def _parse_date(value: str, *, end: bool) -> tuple[datetime, str]:
    """OAI date argument -> (naive UTC bound, granularity). ``until`` bounds are exclusive."""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            d = datetime.strptime(value, "%Y-%m-%d")
            return (d + timedelta(days=1) if end else d), "day"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
            d = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
            return (d + timedelta(seconds=1) if end else d), "seconds"
    except ValueError:
        pass
    raise OAIError("badArgument", f"Invalid date '{value}' (use YYYY-MM-DD or YYYY-MM-DDThh:mm:ssZ)")


def _list(db: Session, verb: str, args: dict, base_url: str, site: str) -> ET.Element:
    if "resumptionToken" in args:
        try:
            state = _serializer().loads(args["resumptionToken"], max_age=int(TOKEN_TTL.total_seconds()))
        except (BadSignature, SignatureExpired):
            raise OAIError("badResumptionToken", "The resumption token is invalid or has expired") from None
        if not isinstance(state, dict) or state.get("verb") != verb:
            raise OAIError("badResumptionToken", "The resumption token does not belong to this request")
        prefix, frm, until, setspec = state["p"], state.get("f"), state.get("u"), state.get("s")
        after = (datetime.fromisoformat(state["t"]), int(state["i"]))
        cursor, total = int(state["c"]), int(state["n"])
    else:
        prefix = args["metadataPrefix"]
        frm, until, setspec = args.get("from"), args.get("until"), args.get("set")
        after, cursor, total = None, 0, None
    if prefix not in FORMATS:
        raise OAIError("cannotDisseminateFormat", f"Metadata format '{prefix}' is not supported")

    conds = []
    granularity = set()
    if frm:
        lo, g = _parse_date(frm, end=False)
        granularity.add(g)
        conds.append(Biblio.updated_at >= lo)
    if until:
        hi, g = _parse_date(until, end=True)
        granularity.add(g)
        conds.append(Biblio.updated_at < hi)
    if len(granularity) > 1:
        raise OAIError("badArgument", "'from' and 'until' must have the same granularity")
    if frm and until and _parse_date(frm, end=False)[0] >= _parse_date(until, end=True)[0]:
        raise OAIError("badArgument", "'from' must not be later than 'until'")
    if setspec:
        if setspec not in _set_specs(db):
            raise OAIError("noRecordsMatch", f"Unknown set '{setspec}'")
        conds.append(Biblio.material_type == setspec)
    if total is None:
        total = db.scalar(select(func.count()).select_from(Biblio).where(*conds)) or 0
    stmt = select(Biblio).where(*conds)
    if after is not None:
        stmt = stmt.where(or_(Biblio.updated_at > after[0], and_(Biblio.updated_at == after[0], Biblio.id > after[1])))
    size = page_size()
    rows = list(db.scalars(stmt.order_by(Biblio.updated_at, Biblio.id).limit(size + 1)))
    if not rows and cursor == 0:
        raise OAIError("noRecordsMatch", "No records match the request")
    more = len(rows) > size
    rows = rows[:size]

    el = ET.Element(q(O, verb))
    for b in rows:
        if verb == "ListIdentifiers":
            _header(el, b)
        else:
            _record(el, b, prefix, site)
    if more or cursor > 0:
        token_el = sub(el, O, "resumptionToken")
        token_el.set("completeListSize", str(max(total, cursor + len(rows))))
        token_el.set("cursor", str(cursor))
        if more:
            last = rows[-1]
            token_el.text = _serializer().dumps({
                "verb": verb, "p": prefix, "f": frm, "u": until, "s": setspec,
                "t": last.updated_at.isoformat(), "i": last.id, "c": cursor + len(rows), "n": total})
            token_el.set("expirationDate", utc_stamp(utcnow() + TOKEN_TTL))
    return el


def _get_record(db: Session, verb: str, args: dict, base_url: str, site: str) -> ET.Element:
    bid = _parse_identifier(args["identifier"])
    b = db.get(Biblio, bid) if bid is not None else None
    if b is None:
        raise OAIError("idDoesNotExist", f"No record with identifier '{args['identifier']}'")
    if args["metadataPrefix"] not in FORMATS:
        raise OAIError("cannotDisseminateFormat", f"Metadata format '{args['metadataPrefix']}' is not supported")
    el = ET.Element(q(O, verb))
    _record(el, b, args["metadataPrefix"], site)
    return el


# ------------------------------------------------------------------ record serialisation


def _header(parent: ET.Element, b: Biblio) -> ET.Element:
    h = sub(parent, O, "header")
    if b.deleted_at is not None:
        h.set("status", "deleted")
    sub(h, O, "identifier", oai_identifier(b.id))
    sub(h, O, "datestamp", utc_stamp(b.updated_at))
    if b.material_type and _SET_RE.match(b.material_type):
        sub(h, O, "setSpec", b.material_type)
    return h


def _record(parent: ET.Element, b: Biblio, prefix: str, site: str) -> None:
    rec = sub(parent, O, "record")
    _header(rec, b)
    if b.deleted_at is not None:
        return  # deleted records carry only a header
    md = sub(rec, O, "metadata")
    if prefix == "marc21":
        md.append(marc_element(b))
    else:
        md.append(dc_element(b, OAI_DC, "dc", record_url=f"{site}/record/{b.id}",
                             schema_location=f"{OAI_DC} http://www.openarchives.org/OAI/2.0/oai_dc.xsd"))
