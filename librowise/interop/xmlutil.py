"""Shared XML helpers for the SRU and OAI-PMH endpoints: namespaces, Dublin Core and MARCXML."""

from __future__ import annotations

import logging
import types
import xml.etree.ElementTree as ET
from datetime import datetime

import pymarc

from ..models import Biblio
from ..services import catalog, marc

log = logging.getLogger("librowise.interop")

SRW = "http://www.loc.gov/zing/srw/"
SRW_DIAG = "http://www.loc.gov/zing/srw/diagnostic/"
SRU2 = "http://docs.oasis-open.org/ns/search-ws/sruResponse"
SRU2_DIAG = "http://docs.oasis-open.org/ns/search-ws/diagnostic"
ZR = "http://explain.z3950.org/dtd/2.0/"
MARC = "http://www.loc.gov/MARC21/slim"
DC = "http://purl.org/dc/elements/1.1/"
SRW_DC = "info:srw/schema/1/dc-schema"
OAI = "http://www.openarchives.org/OAI/2.0/"
OAI_DC = "http://www.openarchives.org/OAI/2.0/oai_dc/"
OAI_ID = "http://www.openarchives.org/OAI/2.0/oai-identifier"
XSI = "http://www.w3.org/2001/XMLSchema-instance"

MARC_SCHEMA_LOCATION = "http://www.loc.gov/MARC21/slim http://www.loc.gov/standards/marcxml/schema/MARC21slim.xsd"

for _prefix, _uri in {"srw": SRW, "diag": SRW_DIAG, "sruResponse": SRU2, "zr": ZR, "marc": MARC, "dc": DC,
                      "srw_dc": SRW_DC, "oai_dc": OAI_DC, "xsi": XSI, "oai-identifier": OAI_ID}.items():
    ET.register_namespace(_prefix, _uri)

# Material type -> DCMI type vocabulary
DCMI_TYPES = {"book": "Text", "ebook": "Text", "serial": "Text", "comic": "StillImage", "dvd": "MovingImage",
              "audiobook": "Sound"}


def q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}" if ns else tag


def sub(parent: ET.Element, ns: str, tag: str, text: object | None = None, **attrib: str) -> ET.Element:
    el = ET.SubElement(parent, q(ns, tag), attrib)
    if text is not None:
        el.text = _xml_safe(str(text))
    return el


def _xml_safe(s: str) -> str:
    """Drop characters that are illegal in XML 1.0 (stray control codes from legacy MARC data)."""
    return "".join(c for c in s if c in "\t\n\r" or ord(c) >= 0x20 and c not in "￾￿")


def tostring(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def utc_stamp(dt: datetime | None) -> str:
    """Naive UTC datetime -> ``YYYY-MM-DDThh:mm:ssZ``."""
    return (dt or datetime(1970, 1, 1)).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ Dublin Core


def dc_values(b: Biblio, record_url: str | None = None) -> list[tuple[str, str]]:
    """(element, value) pairs for simple Dublin Core."""
    out: list[tuple[str, str]] = []
    title = b.title + (f" : {b.subtitle}" if b.subtitle else "")
    out.append(("title", title))
    out += [("creator", a) for a in (b.authors or [])]
    out += [("subject", s) for s in (b.subjects or [])]
    if b.classification:
        out.append(("subject", b.classification))
    if b.description:
        out.append(("description", b.description))
    if b.publisher:
        out.append(("publisher", b.publisher))
    if b.pub_year:
        out.append(("date", str(b.pub_year)))
    out.append(("type", DCMI_TYPES.get(b.material_type, "Text")))
    out.append(("type", b.material_type))
    if b.pages:
        out.append(("format", f"{b.pages} pages"))
    if b.isbn:
        out.append(("identifier", f"URN:ISBN:{b.isbn}"))
    if b.issn:
        out.append(("identifier", f"URN:ISSN:{b.issn}"))
    if record_url:
        out.append(("identifier", record_url))
    if b.language:
        out.append(("language", b.language))
    if b.series:
        out.append(("relation", b.series))
    return out


def dc_element(b: Biblio, wrapper_ns: str, wrapper_tag: str, record_url: str | None = None,
               schema_location: str | None = None) -> ET.Element:
    root = ET.Element(q(wrapper_ns, wrapper_tag))
    if schema_location:
        root.set(q(XSI, "schemaLocation"), schema_location)
    for name, value in dc_values(b, record_url):
        sub(root, DC, name, value)
    return root


# ------------------------------------------------------------------ MARCXML


def _fallback_record(b: Biblio) -> pymarc.Record:
    shadow = types.SimpleNamespace(**{f: getattr(b, f) for f in catalog.BIBLIO_FIELDS}, id=b.id,
                                   items=b.items, marc_xml=None)
    return marc.biblio_to_record(shadow)  # type: ignore[arg-type]


def marc_element(b: Biblio) -> ET.Element:
    """The record as a namespaced ``marc:record`` element."""
    try:
        el = ET.fromstring(pymarc.record_to_xml(marc.biblio_to_record(b), namespace=True))
    except Exception:  # corrupt preserved MARCXML: rebuild from the structured fields
        log.warning("Preserved MARCXML for biblio %s is unusable; rebuilding", b.id)
        el = ET.fromstring(pymarc.record_to_xml(_fallback_record(b), namespace=True))
    el.set(q(XSI, "schemaLocation"), MARC_SCHEMA_LOCATION)
    for node in el.iter():  # control characters would make the whole response ill-formed
        if node.text:
            node.text = _xml_safe(node.text)
    return el
