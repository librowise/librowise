"""SRU server (Search/Retrieve via URL) at ``/sru`` — versions 1.1, 1.2 and 2.0.

Operations: ``explain`` and ``searchRetrieve`` (CQL queries, see :mod:`.cql`).
Record schemas: MARCXML (``marcxml``) and Dublin Core (``dc``).
Errors are reported as SRU diagnostics inside an HTTP 200 response, as the standard requires.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..db import get_db
from ..services import catalog
from ..services import settings as settings_svc
from . import cql
from .ratelimit import check_rate
from .xmlutil import MARC, SRU2, SRU2_DIAG, SRW, SRW_DC, SRW_DIAG, ZR, dc_element, marc_element, q, sub, tostring

router = APIRouter(tags=["interoperability"])

DEFAULT_RECORDS = 10
MAX_RECORDS = 100
SCHEMAS = {
    "marcxml": ("info:srw/schema/1/marcxml-v1.1", "MARCXML", MARC),
    "dc": ("info:srw/schema/1/dc-v1.1", "Dublin Core", SRW_DC),
}
SCHEMA_ALIASES = {
    "marcxml": "marcxml", "marc21": "marcxml", "marc": "marcxml", "info:srw/schema/1/marcxml-v1.1": "marcxml",
    "http://www.loc.gov/marc21/slim": "marcxml", "info:srw/schema/1/marcxml-v1.1-light": "marcxml",
    "dc": "dc", "info:srw/schema/1/dc-v1.1": "dc", "http://purl.org/dc/elements/1.1/": "dc",
    "info:srw/schema/1/dc-schema": "dc",
}
KNOWN_PARAMS = {
    "operation", "version", "query", "startrecord", "maximumrecords", "recordpacking", "recordschema",
    "recordxpath", "resultsetttl", "sortkeys", "stylesheet", "querytype", "recordxmlescaping", "httpaccept",
    "responsetype", "renderedby", "extrarequestdata", "scanclause", "responseposition", "maximumterms",
}


@dataclass
class Diagnostic:
    code: int
    message: str
    details: str | None = None


class _Fatal(Exception):
    def __init__(self, diag: Diagnostic) -> None:
        self.diag = diag


def _content(xml: bytes) -> Response:
    return Response(xml, media_type="application/xml; charset=utf-8")


@router.api_route("/sru", methods=["GET", "POST"], summary="SRU 1.2/2.0 endpoint (explain, searchRetrieve)")
async def sru(request: Request, db: Session = Depends(get_db)):
    check_rate(request, "sru")
    params: dict[str, str] = {}
    pairs = list(request.query_params.multi_items())
    if request.method == "POST":
        form = await request.form()
        pairs += [(k, str(v)) for k, v in form.multi_items()]
    for k, v in pairs:
        params.setdefault(k, v)
    base = str(request.base_url).rstrip("/")
    return _content(await run_in_threadpool(handle, db, params, base, request.url.hostname or "localhost",
                                            request.url.port or (443 if request.url.scheme == "https" else 80)))


def handle(db: Session, params: dict[str, str], base: str, host: str, port: int) -> bytes:
    lower = {k.lower(): v for k, v in params.items()}
    version = lower.get("version", "").strip()
    v2 = version.startswith("2")
    if version and version not in ("1.1", "1.2", "2.0"):
        return _search_response(db, {}, base, "1.2", diag=Diagnostic(5, "Unsupported version", "1.2"))
    out_version = "2.0" if v2 else (version or "1.2")
    operation = lower.get("operation") or ("searchRetrieve" if "query" in lower else "explain")
    if operation == "explain":
        return _explain(db, base, host, port, out_version)
    if operation == "scan":
        return _search_response(db, lower, base, out_version, diag=Diagnostic(4, "Unsupported operation", "scan"))
    if operation != "searchRetrieve":
        return _search_response(db, lower, base, out_version, diag=Diagnostic(4, "Unsupported operation", operation))
    return _search_response(db, lower, base, out_version)


# ------------------------------------------------------------------ searchRetrieve


def _int_param(params: dict, name: str, default: int, minimum: int) -> int:
    raw = params.get(name.lower())
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise _Fatal(Diagnostic(6, "Unsupported parameter value", name)) from None
    if value < minimum:
        raise _Fatal(Diagnostic(6, "Unsupported parameter value", name))
    return value


def _validate(params: dict, v2: bool) -> tuple[str, str, int, int]:
    for k in params:
        if k not in KNOWN_PARAMS and not k.startswith("x-") and not k.startswith("facet"):
            raise _Fatal(Diagnostic(8, "Unsupported parameter", k))
    if params.get("stylesheet"):
        raise _Fatal(Diagnostic(110, "Stylesheets not supported"))
    if params.get("recordxpath"):
        raise _Fatal(Diagnostic(72, "XPath retrieval unsupported"))
    if params.get("sortkeys"):
        raise _Fatal(Diagnostic(80, "Sort not supported"))
    qt = params.get("querytype", "cql").lower()
    if qt not in ("cql", "searchterms"):
        raise _Fatal(Diagnostic(6, "Unsupported parameter value", "queryType"))
    if "query" not in params:
        raise _Fatal(Diagnostic(7, "Mandatory parameter not supplied", "query"))
    schema_raw = params.get("recordschema", "marcxml") or "marcxml"
    schema = SCHEMA_ALIASES.get(schema_raw.lower())
    if schema is None:
        raise _Fatal(Diagnostic(66, "Unknown schema for retrieval", schema_raw))
    escaping_param = "recordxmlescaping" if v2 else "recordpacking"
    escaping = (params.get(escaping_param) or "xml").lower()
    if escaping not in ("xml", "string"):
        if not (v2 is False and escaping in ("packed", "unpacked")):
            raise _Fatal(Diagnostic(71, "Unsupported record packing", escaping))
        escaping = "xml"
    if v2 and (params.get("recordpacking") or "packed").lower() not in ("packed", "unpacked"):
        raise _Fatal(Diagnostic(6, "Unsupported parameter value", "recordPacking"))
    start = _int_param(params, "startRecord", 1, 1)
    maximum = min(_int_param(params, "maximumRecords", DEFAULT_RECORDS, 0), MAX_RECORDS)
    return schema, escaping, start, maximum


def _search_response(db: Session, params: dict, base: str, version: str, diag: Diagnostic | None = None) -> bytes:
    v2 = version.startswith("2")
    ns, diag_ns = (SRU2, SRU2_DIAG) if v2 else (SRW, SRW_DIAG)
    root = ET.Element(q(ns, "searchRetrieveResponse"))
    sub(root, ns, "version", version)
    ids: list[int] = []
    schema = escaping = None
    start, maximum = 1, DEFAULT_RECORDS
    try:
        if diag is not None:
            raise _Fatal(diag)
        schema, escaping, start, maximum = _validate(params, v2)
        if params.get("querytype", "cql").lower() == "searchterms":
            query = " ".join(f'"{w}"' for w in params["query"].replace('"', " ").split())
        else:
            query = params["query"]
        try:
            ids = cql.evaluate(db, cql.parse(query))
        except cql.CQLError as exc:
            raise _Fatal(Diagnostic(exc.code, exc.message, exc.details)) from None
        if ids and start > len(ids):
            raise _Fatal(Diagnostic(61, "First record position out of range", str(start)))
    except _Fatal as fatal:
        sub(root, ns, "numberOfRecords", "0")
        _echo(root, ns, params, version)
        _diagnostics(root, ns, diag_ns, [fatal.diag])
        return tostring(root)

    sub(root, ns, "numberOfRecords", len(ids))
    if v2:
        sub(root, ns, "resultCountPrecision", "info:srw/vocabulary/resultCountPrecision/1/exact")
    page = ids[start - 1 : start - 1 + maximum]
    if page:
        records = sub(root, ns, "records")
        biblios = catalog.load_biblios(db, page)
        schema_id = SCHEMAS[schema][0]
        for pos, b in enumerate(biblios, start=start):
            rec = sub(records, ns, "record")
            sub(rec, ns, "recordSchema", schema_id)
            sub(rec, ns, "recordXMLEscaping" if v2 else "recordPacking", escaping)
            data = sub(rec, ns, "recordData")
            payload = marc_element(b) if schema == "marcxml" else dc_element(
                b, SRW_DC, "dc", record_url=f"{base}/record/{b.id}")
            if escaping == "string":
                data.text = ET.tostring(payload, encoding="unicode")
            else:
                data.append(payload)
            sub(rec, ns, "recordPosition", pos)
    nxt = start + len(page)
    if page and nxt <= len(ids):
        sub(root, ns, "nextRecordPosition", nxt)
    _echo(root, ns, params, version)
    return tostring(root)


def _echo(root: ET.Element, ns: str, params: dict, version: str) -> None:
    if not params:
        return
    echo = sub(root, ns, "echoedSearchRetrieveRequest")
    if not version.startswith("2"):
        sub(echo, ns, "version", version)
    for key, tag in (("query", "query"), ("startrecord", "startRecord"), ("maximumrecords", "maximumRecords"),
                     ("recordpacking", "recordPacking"), ("recordxmlescaping", "recordXMLEscaping"),
                     ("recordschema", "recordSchema")):
        if params.get(key):
            sub(echo, ns, tag, params[key])


def _diagnostics(root: ET.Element, ns: str, diag_ns: str, diags: list[Diagnostic]) -> None:
    box = sub(root, ns, "diagnostics")
    for d in diags:
        el = sub(box, diag_ns, "diagnostic")
        sub(el, diag_ns, "uri", f"info:srw/diagnostic/1/{d.code}")
        if d.details:
            sub(el, diag_ns, "details", d.details)
        sub(el, diag_ns, "message", d.message)


# ------------------------------------------------------------------ explain


def _explain(db: Session, base: str, host: str, port: int, version: str) -> bytes:
    v2 = version.startswith("2")
    ns = SRU2 if v2 else SRW
    root = ET.Element(q(ns, "explainResponse"))
    sub(root, ns, "version", version)
    rec = sub(root, ns, "record")
    sub(rec, ns, "recordSchema", "http://explain.z3950.org/dtd/2.0/")
    sub(rec, ns, "recordXMLEscaping" if v2 else "recordPacking", "xml")
    data = sub(rec, ns, "recordData")
    ex = sub(data, ZR, "explain")
    server = sub(ex, ZR, "serverInfo", protocol="SRU", version=version,
                 transport=base.split(":", 1)[0], method="GET POST")
    sub(server, ZR, "host", host)
    sub(server, ZR, "port", port)
    sub(server, ZR, "database", "sru")
    info = sub(ex, ZR, "databaseInfo")
    name = settings_svc.get(db, "library_name")
    sub(info, ZR, "title", f"{name} catalogue", lang="en", primary="true")
    sub(info, ZR, "description", f"Bibliographic records of {name}, searchable with CQL.", lang="en",
        primary="true")
    idx = sub(ex, ZR, "indexInfo")
    for setname, uri in (("cql", "info:srw/cql-context-set/1/cql-v1.2"), ("dc", "info:srw/cql-context-set/1/dc-v1.1"),
                         ("bath", "http://zing.z3950.org/cql/bath/2.0/"), ("rec", "info:srw/cql-context-set/2/rec-1.1")):
        sub(idx, ZR, "set", identifier=uri, name=setname)
    for full, title in cql.PUBLIC_INDEXES.items():
        setname, _, idxname = full.partition(".")
        index = sub(idx, ZR, "index", search="true", scan="false", sort="false")
        sub(index, ZR, "title", title, lang="en")
        sub(sub(index, ZR, "map"), ZR, "name", idxname, set=setname)
    schemas = sub(ex, ZR, "schemaInfo")
    for key, (identifier, title, _ns) in SCHEMAS.items():
        s = sub(schemas, ZR, "schema", identifier=identifier, name=key, sort="false", retrieve="true")
        sub(s, ZR, "title", title, lang="en")
    cfg = sub(ex, ZR, "configInfo")
    sub(cfg, ZR, "default", DEFAULT_RECORDS, type="numberOfRecords")
    sub(cfg, ZR, "setting", MAX_RECORDS, type="maximumRecords")
    sub(cfg, ZR, "default", "marcxml", type="recordSchema")
    for rel in ("=", "==", "exact", "all", "any", "adj", "<", ">", "<=", ">=", "<>"):
        sub(cfg, ZR, "supports", rel, type="relation")
    sub(cfg, ZR, "supports", "*", type="maskingCharacter")
    return tostring(root)
