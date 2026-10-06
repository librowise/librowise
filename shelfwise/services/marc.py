"""MARC21 import/export (binary ISO 2709 and MARCXML).

Imports Koha exports directly: holdings in the 952 field ($p barcode, $a home branch,
$y item type, $o call number, $g price) become items. The original record is preserved as
MARCXML so nothing is lost in migration.
"""

from __future__ import annotations

import io
import re

import pymarc
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Biblio, Branch, ItemType
from . import catalog


def _sub(record: pymarc.Record, tag: str, code: str) -> str | None:
    for f in record.get_fields(tag):
        vals = f.get_subfields(code)
        if vals:
            return vals[0].strip(" /:;,.=") or None
    return None


def record_to_dict(record: pymarc.Record) -> dict:
    title = _sub(record, "245", "a") or "Untitled"
    authors = []
    for tag in ("100", "110", "700", "710"):
        for f in record.get_fields(tag):
            for a in f.get_subfields("a"):
                a = a.strip(" ,.")
                if a and a not in authors:
                    authors.append(a)
    year = None
    for tag in ("264", "260"):
        c = _sub(record, tag, "c")
        if c and (m := re.search(r"(\d{4})", c)):
            year = int(m.group(1))
            break
    if year is None and (f008 := record.get("008")) and f008.data[7:11].isdigit():
        year = int(f008.data[7:11])
    lang = None
    if (f008 := record.get("008")) and len(f008.data) >= 38:
        lang = f008.data[35:38].strip() or None
    lang = _sub(record, "041", "a") or lang
    subjects = []
    for tag in ("650", "651", "600", "655"):
        for f in record.get_fields(tag):
            parts = [v.strip(" .") for c, v in ((s.code, s.value) for s in f.subfields) if c in "avxyz"]
            if parts:
                subjects.append(" -- ".join(parts))
    pages = None
    if (p := _sub(record, "300", "a")) and (m := re.search(r"(\d+)\s*p", p)):
        pages = int(m.group(1))
    return {
        "title": title,
        "subtitle": _sub(record, "245", "b"),
        "authors": authors,
        "isbn": _sub(record, "020", "a"),
        "issn": _sub(record, "022", "a"),
        "publisher": _sub(record, "264", "b") or _sub(record, "260", "b"),
        "pub_year": year,
        "edition": _sub(record, "250", "a"),
        "language": _LANG3.get(lang, lang[:2] if lang else "en") if lang else "en",
        "subjects": subjects[:15],
        "series": _sub(record, "490", "a") or _sub(record, "830", "a"),
        "pages": pages,
        "description": _sub(record, "520", "a"),
        "classification": _sub(record, "082", "a"),
    }


_LANG3 = {"eng": "en", "hin": "hi", "fre": "fr", "fra": "fr", "spa": "es", "ger": "de", "deu": "de",
          "rus": "ru", "ita": "it", "ben": "bn", "tam": "ta", "urd": "ur", "jpn": "ja", "chi": "zh",
          "san": "sa", "mar": "mr", "tel": "te"}


def import_marc(db: Session, data: bytes, *, default_branch_id: int, default_item_type_id: int,
                dedupe_isbn: bool = True) -> dict:
    stats = {"records": 0, "created": 0, "skipped_duplicates": 0, "items": 0, "errors": []}
    if data.lstrip()[:1] == b"<":
        records = pymarc.parse_xml_to_array(io.BytesIO(data))
    else:
        records = list(pymarc.MARCReader(io.BytesIO(data), to_unicode=True, force_utf8=True,
                                         utf8_handling="replace"))
    branches = {b.code: b.id for b in db.scalars(select(Branch))}
    itypes = {t.code: t.id for t in db.scalars(select(ItemType))}
    for rec in records:
        if rec is None:
            stats["errors"].append("Unreadable record skipped")
            continue
        stats["records"] += 1
        try:
            fields = record_to_dict(rec)
            isbn = catalog.normalize_isbn(fields.get("isbn"))
            if dedupe_isbn and isbn and db.scalar(
                select(Biblio.id).where(Biblio.isbn == isbn, Biblio.deleted_at.is_(None))):
                stats["skipped_duplicates"] += 1
                continue
            fields["marc_xml"] = pymarc.record_to_xml(rec).decode("utf-8")
            biblio = catalog.create_biblio(db, fields)
            biblio.marc_xml = fields["marc_xml"]
            stats["created"] += 1
            for f952 in rec.get_fields("952"):
                barcode = (f952.get_subfields("p") or [""])[0]
                catalog.create_item(db, biblio, {
                    "barcode": barcode,
                    "branch_id": branches.get((f952.get_subfields("a") or [""])[0], default_branch_id),
                    "item_type_id": itypes.get((f952.get_subfields("y") or [""])[0], default_item_type_id),
                    "call_number": (f952.get_subfields("o") or [None])[0],
                    "price": _price((f952.get_subfields("g") or [None])[0]),
                })
                stats["items"] += 1
        except Exception as exc:  # keep going; report per-record problems
            stats["errors"].append(f"Record {stats['records']}: {exc}")
    db.flush()
    return stats


def _price(v: str | None) -> int | None:
    if not v:
        return None
    try:
        return int(round(float(re.sub(r"[^\d.]", "", v)) * 100))
    except ValueError:
        return None


def biblio_to_record(b: Biblio) -> pymarc.Record:
    if b.marc_xml:
        try:
            recs = pymarc.parse_xml_to_array(io.BytesIO(b.marc_xml.encode()))
            if recs:
                return recs[0]
        except Exception:
            pass
    r = pymarc.Record(force_utf8=True)
    S = pymarc.Subfield
    r.add_field(pymarc.Field(tag="001", data=str(b.id)))
    if b.isbn:
        r.add_field(pymarc.Field(tag="020", indicators=[" ", " "], subfields=[S("a", b.isbn)]))
    if b.classification:
        r.add_field(pymarc.Field(tag="082", indicators=["0", "4"], subfields=[S("a", b.classification)]))
    if b.authors:
        r.add_field(pymarc.Field(tag="100", indicators=["1", " "], subfields=[S("a", b.authors[0])]))
    t = [S("a", b.title)] + ([S("b", b.subtitle)] if b.subtitle else [])
    r.add_field(pymarc.Field(tag="245", indicators=["1", "0"], subfields=t))
    if b.edition:
        r.add_field(pymarc.Field(tag="250", indicators=[" ", " "], subfields=[S("a", b.edition)]))
    pub = ([S("b", b.publisher)] if b.publisher else []) + ([S("c", str(b.pub_year))] if b.pub_year else [])
    if pub:
        r.add_field(pymarc.Field(tag="264", indicators=[" ", "1"], subfields=pub))
    if b.pages:
        r.add_field(pymarc.Field(tag="300", indicators=[" ", " "], subfields=[S("a", f"{b.pages} pages")]))
    if b.series:
        r.add_field(pymarc.Field(tag="490", indicators=["0", " "], subfields=[S("a", b.series)]))
    if b.description:
        r.add_field(pymarc.Field(tag="520", indicators=[" ", " "], subfields=[S("a", b.description)]))
    for s in b.subjects or []:
        r.add_field(pymarc.Field(tag="650", indicators=[" ", "0"], subfields=[S("a", s)]))
    for a in (b.authors or [])[1:]:
        r.add_field(pymarc.Field(tag="700", indicators=["1", " "], subfields=[S("a", a)]))
    for item in b.items:
        if item.deleted_at is None:
            r.add_field(pymarc.Field(tag="952", indicators=[" ", " "], subfields=[
                S("a", item.branch.code), S("p", item.barcode), S("y", item.item_type.code),
                S("o", item.call_number or "")]))
    return r


def export(db: Session, biblios: list[Biblio], fmt: str = "xml") -> bytes:
    records = [biblio_to_record(b) for b in biblios]
    if fmt == "mrc":
        return b"".join(r.as_marc() for r in records)
    out = io.BytesIO()
    writer = pymarc.XMLWriter(out)
    for r in records:
        writer.write(r)
    writer.close(close_fh=False)
    return out.getvalue()
