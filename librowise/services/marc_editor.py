"""MARC editor back end: grid <-> MARCXML <-> mnemonic conversion, validation, diff and save.

The *grid* is the editor's JSON model::

    {"leader": "00000nam a2200000 i 4500",
     "fields": [{"tag": "001", "value": "42"},
                {"tag": "245", "ind1": "1", "ind2": "0", "subfields": [{"code": "a", "value": "Title"}]}]}

The *mnemonic* view is MarcEdit's text format (``=245  10$aTitle``; blanks shown as ``\\``,
literal ``$`` as ``{dollar}``). Saving stores the MARCXML on the record and re-derives the
bibliographic fields via :func:`services.marc.record_to_dict`; items are never touched.
"""

from __future__ import annotations

import difflib
import io
import re
from xml.parsers.expat import ExpatError

import pymarc
from sqlalchemy.orm import Session

from ..errors import DomainError
from ..models import Biblio, utcnow
from . import catalog, marc
from . import marc_dictionary as dictionary

DEFAULT_LEADER = "00000nam a2200000 i 4500"
_TAG = re.compile(r"^\d{3}$")
_CODE = re.compile(r"^[a-z0-9]$")
_IND = re.compile(r"^[0-9a-z ]$")
HOLDINGS_TAG = "952"
_LANG2TO3 = {"en": "eng", "hi": "hin", "fr": "fre", "es": "spa", "de": "ger", "ru": "rus", "it": "ita", "bn": "ben",
             "ta": "tam", "ur": "urd", "ja": "jpn", "zh": "chi", "sa": "san", "mr": "mar", "te": "tel"}
_TYPE_LEADER = {"dvd": ("g", "m"), "audiobook": ("i", "m"), "serial": ("a", "s"), "ebook": ("a", "m"),
                "comic": ("a", "m"), "book": ("a", "m")}


def is_control(tag: str) -> bool:
    return tag.isdigit() and tag < "010"


# ------------------------------------------------------------------ grid <-> pymarc


def record_to_grid(rec: pymarc.Record, *, drop_holdings: bool = True) -> dict:
    fields = []
    for f in rec.fields:
        if drop_holdings and f.tag == HOLDINGS_TAG:
            continue
        if f.is_control_field():
            fields.append({"tag": f.tag, "value": f.data or ""})
        else:
            fields.append({"tag": f.tag, "ind1": f.indicator1 or " ", "ind2": f.indicator2 or " ",
                           "subfields": [{"code": s.code, "value": s.value} for s in f.subfields]})
    return {"leader": str(rec.leader), "fields": fields}


def grid_to_record(grid: dict) -> pymarc.Record:
    rec = pymarc.Record(leader=_leader(grid.get("leader")), force_utf8=True)
    for f in grid.get("fields") or []:
        tag = str(f.get("tag", ""))
        if is_control(tag):
            rec.add_field(pymarc.Field(tag=tag, data=str(f.get("value") or "")))
        else:
            rec.add_field(pymarc.Field(
                tag=tag, indicators=[_ind(f.get("ind1")), _ind(f.get("ind2"))],
                subfields=[pymarc.Subfield(str(s.get("code", "")), str(s.get("value") or ""))
                           for s in f.get("subfields") or []]))
    return rec


def _leader(value) -> str:
    s = str(value or "")
    return s if len(s) == 24 else (s + DEFAULT_LEADER[len(s):])[:24]


def _ind(value) -> str:
    v = str(value if value is not None else " ")
    return " " if v in ("", "#", "\\", "_") else v[:1]


def normalize_grid(grid: dict) -> dict:
    """Canonical form of a grid (blank indicator spellings unified, unknown keys dropped)."""
    out = {"leader": str(grid.get("leader") or ""), "fields": []}
    for f in grid.get("fields") or []:
        tag = str(f.get("tag", "")).strip()
        if is_control(tag):
            out["fields"].append({"tag": tag, "value": str(f.get("value") or "")})
        else:
            out["fields"].append({"tag": tag, "ind1": _ind(f.get("ind1")), "ind2": _ind(f.get("ind2")),
                                  "subfields": [{"code": str(s.get("code", "")), "value": str(s.get("value") or "")}
                                                for s in f.get("subfields") or []]})
    return out


# ------------------------------------------------------------------ validation


def validate(grid: dict) -> tuple[list[dict], list[dict]]:
    """Return ``(errors, warnings)``; each item has ``field``/``subfield`` indexes and a message."""
    errors: list[dict] = []
    warnings: list[dict] = []

    def err(msg, field=None, subfield=None, part=None):
        errors.append({"field": field, "subfield": subfield, "part": part, "message": msg})

    def warn(msg, field=None, subfield=None, part=None):
        warnings.append({"field": field, "subfield": subfield, "part": part, "message": msg})

    leader = str(grid.get("leader") or "")
    if len(leader) != 24:
        err(f"Leader must be exactly 24 characters (has {len(leader)})", part="leader")
    elif not leader.isascii():
        err("Leader may contain ASCII characters only", part="leader")
    elif leader[9] != "a":
        warn("Leader/09 should be 'a' (Unicode); records are always stored as UTF-8", part="leader")
    fields = grid.get("fields") or []
    if not isinstance(fields, list):
        err("Fields must be a list")
        return errors, warnings
    seen: dict[str, int] = {}
    has_title = False
    for i, f in enumerate(fields):
        tag = str((f or {}).get("tag", ""))
        if not _TAG.match(tag):
            err(f"Tag “{tag}” must be three digits", i, part="tag")
            continue
        seen[tag] = seen.get(tag, 0) + 1
        if is_control(tag):
            if f.get("subfields"):
                err(f"Control field {tag} cannot have subfields", i)
            if any(f.get(k) not in (None, "", " ") for k in ("ind1", "ind2")):
                err(f"Control field {tag} cannot have indicators", i)
            value = str(f.get("value") or "")
            if not value:
                err(f"Control field {tag} is empty", i, part="value")
            if tag == "008" and value and len(value) != 40:
                warn(f"008 is usually 40 characters (has {len(value)})", i, part="value")
            continue
        for k in ("ind1", "ind2"):
            v = _ind(f.get(k))
            if not _IND.match(v):
                err(f"{tag} {('first' if k == 'ind1' else 'second')} indicator must be a digit, lowercase letter or blank",
                    i, part=k)
        subs = f.get("subfields") or []
        if not subs:
            err(f"Field {tag} needs at least one subfield", i)
        for j, s in enumerate(subs):
            code = str((s or {}).get("code", ""))
            if not _CODE.match(code):
                err(f"{tag}: subfield code “{code}” must be a single lowercase letter or digit", i, j, "code")
            if not str(s.get("value") or "").strip():
                err(f"{tag} ${code or '?'} is empty", i, j, "value")
        if tag == "245" and any(str(s.get("code")) == "a" and str(s.get("value") or "").strip() for s in subs):
            has_title = True
        if tag == HOLDINGS_TAG:
            warn("952 holdings are not stored with the record — manage items on the record page", i)
    if not has_title:
        err("A 245 field with a non-empty $a (title) is required", part="245")
    for tag, n in seen.items():
        if n > 1 and not dictionary.repeatable(tag):
            warn(f"{tag} ({dictionary.label(tag)}) is not repeatable but occurs {n} times")
    return errors, warnings


def _raise_invalid(errors: list[dict]) -> None:
    raise DomainError(errors[0]["message"] if len(errors) == 1 else f"{len(errors)} problems in the record",
                      code="marc_invalid", details={"errors": errors})


# ------------------------------------------------------------------ text formats

_ENC = {"{": "{lcub}", "}": "{rcub}", "$": "{dollar}"}
_DEC = {"{lcub}": "{", "{rcub}": "}", "{dollar}": "$", "{bsol}": "\\"}
_ENC_RE = re.compile(r"[{}$]")
_DEC_RE = re.compile(r"\{(?:lcub|rcub|dollar|bsol)\}")


def _enc(value: str) -> str:
    return _ENC_RE.sub(lambda m: _ENC[m.group(0)], value)


def _dec(value: str) -> str:
    return _DEC_RE.sub(lambda m: _DEC[m.group(0)], value)


def _enc_fixed(value: str) -> str:
    return _enc(value).replace("\\", "{bsol}").replace(" ", "\\")


def _dec_fixed(value: str) -> str:
    return _dec(value.replace("\\", " "))


def to_mnemonic(grid: dict) -> str:
    lines = [f"=LDR  {_enc_fixed(str(grid.get('leader') or ''))}"]
    for f in grid.get("fields") or []:
        tag = str(f.get("tag", ""))
        if is_control(tag):
            lines.append(f"={tag}  {_enc_fixed(str(f.get('value') or ''))}")
        else:
            ind = "".join("\\" if _ind(f.get(k)) == " " else _ind(f.get(k)) for k in ("ind1", "ind2"))
            subs = "".join(f"${s.get('code', '')}{_enc(str(s.get('value') or ''))}" for s in f.get("subfields") or [])
            lines.append(f"={tag}  {ind}{subs}")
    return "\n".join(lines) + "\n"


_LINE = re.compile(r"^=(LDR|\w{3})\s{1,2}(.*)$")


def from_mnemonic(text: str) -> tuple[dict, list[dict]]:
    """Parse MarcEdit mnemonic text. Returns ``(grid, errors)``; errors carry 1-based line numbers."""
    grid: dict = {"leader": DEFAULT_LEADER, "fields": []}
    errors: list[dict] = []
    for n, raw in enumerate((text or "").splitlines(), start=1):
        line = raw.rstrip("\r\n")
        if not line.strip():
            continue
        m = _LINE.match(line)
        if not m:
            errors.append({"line": n, "message": f"Line {n}: expected “=TAG  …” (e.g. =245  10$aTitle)"})
            continue
        tag, rest = m.group(1), m.group(2)
        if tag == "LDR":
            grid["leader"] = _dec_fixed(rest)
        elif is_control(tag):
            grid["fields"].append({"tag": tag, "value": _dec_fixed(rest)})
        else:
            if len(rest) < 2 or "$" not in rest:
                errors.append({"line": n, "message": f"Line {n}: {tag} needs two indicators and at least one $subfield"})
                continue
            ind, body = rest[:2], rest[2:]
            if not body.startswith("$"):
                errors.append({"line": n, "message": f"Line {n}: subfield data must start with $ after the indicators"})
                continue
            subs = []
            for chunk in body.split("$")[1:]:
                if not chunk:
                    errors.append({"line": n, "message": f"Line {n}: empty subfield ($$)"})
                    continue
                subs.append({"code": chunk[0], "value": _dec(chunk[1:])})
            grid["fields"].append({"tag": tag, "ind1": _ind(ind[0]), "ind2": _ind(ind[1]), "subfields": subs})
    return grid, errors


def to_xml(grid: dict) -> str:
    rec = grid_to_record(grid)
    xml = pymarc.record_to_xml(rec, namespace=True).decode("utf-8")
    return _pretty(xml)


def _pretty(xml: str) -> str:
    try:
        from xml.dom import minidom

        return minidom.parseString(xml).toprettyxml(indent="  ", encoding=None).split("\n", 1)[1].strip() + "\n"
    except ExpatError:  # pragma: no cover
        return xml


def from_xml(text: str) -> dict:
    try:
        records = pymarc.parse_xml_to_array(io.BytesIO((text or "").encode("utf-8")))
    except Exception as exc:  # expat / SAX errors
        raise DomainError(f"Not valid MARCXML: {exc}", code="marc_invalid") from None
    records = [r for r in records if r is not None]
    if len(records) != 1:
        raise DomainError(f"Expected exactly one MARCXML record, found {len(records)}", code="marc_invalid")
    return record_to_grid(records[0], drop_holdings=False)


def convert(grid: dict | None, text: str | None, src: str, dst: str) -> dict:
    """Convert between ``grid``, ``mnemonic`` and ``xml``. Returns ``{grid, text, errors}``."""
    errors: list[dict] = []
    if src == "grid":
        g = normalize_grid(grid or {})
    elif src == "mnemonic":
        g, errors = from_mnemonic(text or "")
    elif src == "xml":
        g = from_xml(text or "")
    else:
        raise DomainError(f"Unknown format {src!r}", code="validation_error")
    out: dict = {"grid": g, "errors": errors}
    if dst == "mnemonic":
        out["text"] = to_mnemonic(g)
    elif dst == "xml":
        out["text"] = to_xml(g)
    return out


# ------------------------------------------------------------------ biblio integration


def _generated_record(b: Biblio) -> pymarc.Record:
    rec = marc.biblio_to_record(b)
    t6, t7 = _TYPE_LEADER.get(b.material_type or "book", ("a", "m"))
    rec.leader = pymarc.Leader(DEFAULT_LEADER[:6] + t6 + t7 + DEFAULT_LEADER[8:])
    entered = (b.created_at or utcnow()).strftime("%y%m%d")
    year = f"{b.pub_year:04d}" if b.pub_year else "    "
    lang = _LANG2TO3.get(b.language or "en", (b.language or "und")[:3].ljust(3))
    f008 = (entered + ("s" if b.pub_year else "n") + year + "    " + "xx " + " " * 17 + lang + " d")[:40].ljust(40)
    pos = next((i for i, f in enumerate(rec.fields) if f.tag > "008"), len(rec.fields))
    rec.fields.insert(pos, pymarc.Field(tag="008", data=f008))
    return rec


def source_record(b: Biblio) -> tuple[pymarc.Record, str]:
    if b.marc_xml:
        try:
            recs = [r for r in pymarc.parse_xml_to_array(io.BytesIO(b.marc_xml.encode("utf-8"))) if r is not None]
            if recs:
                return recs[0], "stored"
        except Exception:
            pass
    return _generated_record(b), "generated"


def editor_payload(b: Biblio) -> dict:
    rec, origin = source_record(b)
    holdings = len(rec.get_fields(HOLDINGS_TAG))
    return {"biblio_id": b.id, "title": b.title, "origin": origin, "grid": record_to_grid(rec),
            "holdings_fields": holdings, "items": len([i for i in b.items if i.deleted_at is None]),
            "updated_at": b.updated_at}


_DERIVED = ("title", "subtitle", "authors", "isbn", "issn", "publisher", "pub_year", "edition", "language",
            "subjects", "series", "pages", "description", "classification")


def derive_fields(rec: pymarc.Record) -> dict:
    fields = marc.record_to_dict(rec)
    subjects = []
    for tag in ("650", "651", "600", "655"):
        for f in rec.get_fields(tag):
            parts = [s.value.strip(" .") for s in f.subfields if s.code in "avxyz" and s.value.strip(" .")]
            if parts:
                subjects.append(" -- ".join(parts))
    fields["subjects"] = subjects[:50]
    summary = next((v.strip() for f in rec.get_fields("520") for v in f.get_subfields("a") if v.strip()), None)
    fields["description"] = summary  # keep the summary's own punctuation
    f008 = rec.get("008")
    if not rec.get_fields("041") and (f008 is None or len(f008.data or "") < 38 or not f008.data[35:38].strip()):
        fields.pop("language", None)  # nothing coded: keep the record's current language
    if fields.get("isbn"):
        fields["isbn"] = catalog.normalize_isbn(fields["isbn"]) or fields["isbn"]
    return {k: v for k, v in fields.items() if k in _DERIVED}


def _prepare(grid: dict) -> tuple[pymarc.Record, list[dict]]:
    grid = normalize_grid(grid)
    errors, warnings = validate(grid)
    if errors:
        _raise_invalid(errors)
    grid["fields"] = [f for f in grid["fields"] if f["tag"] != HOLDINGS_TAG]
    stamp = utcnow().strftime("%Y%m%d%H%M%S.0")
    if any(f["tag"] == "005" for f in grid["fields"]):
        for f in grid["fields"]:
            if f["tag"] == "005":
                f["value"] = stamp
    else:
        pos = next((i for i, f in enumerate(grid["fields"]) if f["tag"] > "005"), len(grid["fields"]))
        grid["fields"].insert(pos, {"tag": "005", "value": stamp})
    return grid_to_record(grid), warnings


def _diff_lines(old: str, new: str, context: int = 2) -> list[dict]:
    a, b = old.splitlines(), new.splitlines()
    out: list[dict] = []
    for group in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_grouped_opcodes(context):
        if out:
            out.append({"op": "skip", "text": "…"})
        for op, i1, i2, j1, j2 in group:
            if op == "equal":
                out += [{"op": " ", "text": t} for t in a[i1:i2]]
            if op in ("delete", "replace"):
                out += [{"op": "-", "text": t} for t in a[i1:i2]]
            if op in ("insert", "replace"):
                out += [{"op": "+", "text": t} for t in b[j1:j2]]
    return out


def _cmp(v):
    return [x for x in v] if isinstance(v, list) else (v if v not in ("", None) else None)


def preview(b: Biblio, grid: dict) -> dict:
    """Validate and diff a proposed record against what is stored, without saving anything."""
    norm = normalize_grid(grid)
    errors, warnings = validate(norm)
    current, _ = source_record(b)
    old = record_to_grid(current)
    # 005 is restamped on save and 952 is never stored, so neither is part of the comparison
    skip = (HOLDINGS_TAG, "005")
    kept = {**norm, "fields": [f for f in norm["fields"] if f["tag"] not in skip]}
    old = {**old, "fields": [f for f in old["fields"] if f["tag"] not in skip]}
    out = {"errors": errors, "warnings": warnings, "marc_diff": _diff_lines(to_mnemonic(old), to_mnemonic(kept)),
           "field_changes": []}
    if not errors:
        for k, v in derive_fields(grid_to_record(kept)).items():
            before = getattr(b, k)
            if _cmp(before) != _cmp(v):
                out["field_changes"].append({"field": k, "before": before, "after": v})
    out["unchanged"] = not out["field_changes"] and not any(d["op"] in ("+", "-") for d in out["marc_diff"])
    return out


def save(db: Session, b: Biblio, grid: dict) -> dict:
    """Store the record's MARCXML and re-derive the bibliographic fields (items untouched)."""
    rec, warnings = _prepare(grid)
    fields = derive_fields(rec)
    before = {k: getattr(b, k) for k in fields}
    catalog.update_biblio(db, b, fields)  # flush -> authority auto-link; re-indexes FTS
    b.marc_xml = pymarc.record_to_xml(rec).decode("utf-8")
    db.flush()
    changed = sorted(k for k in fields if _cmp(before[k]) != _cmp(getattr(b, k)))
    return {"warnings": warnings, "changed_fields": changed}
