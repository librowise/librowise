"""Copy cataloguing: search remote SRU servers (e.g. the Library of Congress) and import
MARC records into the local catalogue.

Network access is limited to the targets an administrator configured; responses are size-capped
and parsed with the standard library's expat parser (no external entities, no DTD fetching).
"""

from __future__ import annotations

import io
import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
import pymarc
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..errors import Conflict, DomainError, NotFound
from ..models import Biblio, CopyCatTarget
from ..services import catalog, marc
from .xmlutil import MARC

log = logging.getLogger("shelfwise.copycat")

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_IMPORT_BYTES = 1024 * 1024
LOCAL_TAGS = re.compile(r"^9\d\d$")  # 9XX are local fields (Koha holdings 952, 942, 999...)

DEFAULT_TARGET = {
    "name": "Library of Congress", "url": "http://lx2.loc.gov:210/LCDB", "sru_version": "1.1",
    "record_schema": "marcxml", "title_index": "dc.title", "author_index": "dc.creator",
    "isbn_index": "bath.isbn", "timeout_seconds": 10, "enabled": True, "position": 0,
}


class RemoteError(DomainError):
    status_code = 502
    code = "remote_error"


@dataclass
class TargetInfo:
    id: int
    name: str
    url: str
    sru_version: str
    record_schema: str
    title_index: str
    author_index: str
    isbn_index: str
    timeout_seconds: int
    enabled: bool = True
    position: int = 0

    @classmethod
    def of(cls, t: CopyCatTarget) -> TargetInfo:
        return cls(**{f: getattr(t, f) for f in cls.__dataclass_fields__})


def targets(db: Session, *, enabled_only: bool = False) -> list[TargetInfo]:
    """Configured targets; the Library of Congress (id 0) when none are configured."""
    stmt = select(CopyCatTarget).order_by(CopyCatTarget.position, CopyCatTarget.id)
    if enabled_only:
        stmt = stmt.where(CopyCatTarget.enabled.is_(True))
    rows = [TargetInfo.of(t) for t in db.scalars(stmt)]
    if not rows and not db.scalar(select(CopyCatTarget.id).limit(1)):
        rows = [TargetInfo(id=0, **DEFAULT_TARGET)]
    return rows


def get_target(db: Session, target_id: int) -> TargetInfo:
    for t in targets(db, enabled_only=True):
        if t.id == target_id:
            return t
    raise NotFound("Unknown or disabled copy-cataloguing target")


# ------------------------------------------------------------------ queries


def _cql_term(term: str) -> str:
    return '"' + term.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_query(target: TargetInfo, kind: str, term: str) -> str:
    term = term.strip()
    if not term:
        raise DomainError("Enter something to search for", code="validation_error")
    if kind == "isbn":
        digits = re.sub(r"[^0-9Xx]", "", term).upper()
        if len(digits) not in (10, 13):
            raise DomainError("An ISBN has 10 or 13 digits", code="validation_error")
        return f"{target.isbn_index}={digits}"
    if kind == "author":
        return f"{target.author_index}={_cql_term(term)}"
    if kind == "title":
        return f"{target.title_index}={_cql_term(term)}"
    if kind == "cql":
        return term
    raise DomainError("Unknown search type", code="validation_error")


def search_url(target: TargetInfo, query: str, maximum: int, start: int = 1) -> str:
    params = {"version": target.sru_version, "operation": "searchRetrieve", "query": query,
              "maximumRecords": str(maximum), "startRecord": str(start), "recordSchema": target.record_schema}
    sep = "&" if "?" in target.url else "?"
    return f"{target.url}{sep}{urlencode(params)}"


def _fetch(url: str, timeout: float, client: httpx.Client | None = None) -> bytes:
    own = client is None
    client = client or httpx.Client(timeout=timeout, follow_redirects=True,
                                    headers={"User-Agent": "Shelfwise-ILS copy cataloguing (SRU client)"})
    try:
        with client.stream("GET", url, timeout=timeout) as resp:
            if resp.status_code >= 400:
                raise RemoteError(f"The remote server answered HTTP {resp.status_code}")
            chunks, size = [], 0
            for chunk in resp.iter_bytes():
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    raise RemoteError("The remote server's response is too large")
                chunks.append(chunk)
            return b"".join(chunks)
    except httpx.TimeoutException:
        raise RemoteError("The remote server did not answer in time — try again or pick another target") from None
    except httpx.HTTPError as exc:
        raise RemoteError(f"Could not reach the remote server ({type(exc).__name__})") from None
    finally:
        if own:
            client.close()


# ------------------------------------------------------------------ response parsing


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_sru_response(content: bytes) -> tuple[int, list[pymarc.Record], list[str]]:
    """(numberOfRecords, MARC records, diagnostic messages) from an SRU 1.x/2.0 response."""
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        raise RemoteError(f"The remote server returned invalid XML ({exc})") from None
    total = 0
    diagnostics: list[str] = []
    records: list[pymarc.Record] = []
    for el in root.iter():
        name = _local(el.tag)
        if name == "numberOfRecords" and el.text and el.text.strip().isdigit():
            total = int(el.text.strip())
        elif name == "diagnostic":
            parts = {_local(c.tag): (c.text or "").strip() for c in el}
            diagnostics.append(" — ".join(x for x in (parts.get("message"), parts.get("details")) if x)
                               or parts.get("uri", "Remote diagnostic"))
        elif name == "recordData":
            marc_el = next((c for c in el.iter() if _local(c.tag) == "record" and c is not el), None)
            if marc_el is None and el.text and el.text.strip().startswith("<"):  # recordPacking=string
                try:
                    inner = ET.fromstring(el.text.strip().encode("utf-8"))
                except ET.ParseError:
                    continue
                marc_el = inner if _local(inner.tag) == "record" else next(
                    (c for c in inner.iter() if _local(c.tag) == "record"), None)
            if marc_el is None:
                continue
            rec = _to_pymarc(marc_el)
            if rec is not None:
                records.append(rec)
    return total, records, diagnostics


def _to_pymarc(el: ET.Element) -> pymarc.Record | None:
    # pymarc's MARCXML reader requires the MARC21/slim namespace (or none) — normalise it.
    for node in el.iter():
        node.tag = f"{{{MARC}}}{_local(node.tag)}"
    xml = ET.tostring(el, encoding="utf-8")
    try:
        recs = pymarc.parse_xml_to_array(io.BytesIO(xml))
    except Exception:
        log.warning("Skipping an unparsable MARCXML record from a copy-cataloguing target")
        return None
    return recs[0] if recs else None


def summarize(db: Session, rec: pymarc.Record) -> dict:
    fields = marc.record_to_dict(rec)
    isbn = catalog.normalize_isbn(fields.get("isbn"))
    existing = None
    if isbn:
        existing = db.scalar(select(Biblio.id).where(Biblio.isbn == isbn, Biblio.deleted_at.is_(None)))
    preview = []
    for f in rec.get_fields():
        if f.is_control_field():
            preview.append({"tag": f.tag, "ind": "", "value": f.data})
        else:
            ind = "".join(i if i and i != " " else "_" for i in f.indicators)
            preview.append({"tag": f.tag, "ind": ind,
                            "value": " ".join(f"${s.code} {s.value}" for s in f.subfields)})
    lccn = None
    for f in rec.get_fields("010"):
        lccn = (f.get_subfields("a") or [None])[0]
    return {
        "title": fields.get("title"), "subtitle": fields.get("subtitle"), "authors": fields.get("authors") or [],
        "publisher": fields.get("publisher"), "pub_year": fields.get("pub_year"), "edition": fields.get("edition"),
        "isbn": isbn or fields.get("isbn"), "lccn": lccn.strip() if lccn else None,
        "pages": fields.get("pages"), "subjects": fields.get("subjects") or [],
        "classification": fields.get("classification"), "language": fields.get("language"),
        "existing_biblio_id": existing, "fields": preview[:80],
        "marcxml": pymarc.record_to_xml(rec, namespace=True).decode("utf-8"),
    }


def search(db: Session, target: TargetInfo, kind: str, term: str, *, maximum: int = 10, start: int = 1,
           client: httpx.Client | None = None) -> dict:
    query = build_query(target, kind, term)
    url = search_url(target, query, maximum, start)
    log.info("copycat search target=%s query=%r", target.name, query)
    content = _fetch(url, float(target.timeout_seconds), client)
    total, records, diagnostics = parse_sru_response(content)
    if diagnostics and not records:
        raise RemoteError(f"{target.name}: {diagnostics[0]}")
    return {"target": {"id": target.id, "name": target.name}, "query": query, "total": total,
            "results": [summarize(db, r) for r in records], "diagnostics": diagnostics}


# ------------------------------------------------------------------ import


def import_record(db: Session, marcxml: str, *, allow_duplicate: bool = False) -> Biblio:
    data = marcxml.encode("utf-8")
    if len(data) > MAX_IMPORT_BYTES:
        raise DomainError("The record is too large", code="validation_error")
    try:
        recs = [r for r in pymarc.parse_xml_to_array(io.BytesIO(data)) if r is not None]
    except Exception:
        raise DomainError("The MARCXML could not be read", code="validation_error") from None
    if not recs:
        raise DomainError("No MARC record found", code="validation_error")
    rec = recs[0]
    for f in list(rec.get_fields()):
        if LOCAL_TAGS.match(f.tag):
            rec.remove_field(f)
    fields = marc.record_to_dict(rec)
    isbn = catalog.normalize_isbn(fields.get("isbn"))
    if isbn and not allow_duplicate:
        existing = db.scalar(select(Biblio.id).where(Biblio.isbn == isbn, Biblio.deleted_at.is_(None)))
        if existing:
            raise Conflict("A record with this ISBN is already in the catalogue", code="duplicate_isbn",
                           details={"existing_biblio_id": existing})
    biblio = catalog.create_biblio(db, fields)
    biblio.marc_xml = pymarc.record_to_xml(rec, namespace=True).decode("utf-8")
    db.flush()
    catalog.index_biblio(db, biblio)
    return biblio
