"""Citation formatting: APA 7, MLA 9, Chicago 17 (bibliography), BibTeX and RIS.

Pure functions over a plain record dict so they are easy to test and reuse. Names are stored
"Last, First" (MARC 100/700 style); "First Last" is also understood. ``html`` variants italicise
titles and escape everything else.
"""

from __future__ import annotations

import html as _html
import re
import unicodedata
from dataclasses import dataclass

STYLES = ("apa", "mla", "chicago", "bibtex", "ris")
STYLE_NAMES = {"apa": "APA (7th ed.)", "mla": "MLA (9th ed.)", "chicago": "Chicago (17th ed.)", "bibtex": "BibTeX", "ris": "RIS"}
RIS_TYPES = {"book": "BOOK", "ebook": "EBOOK", "audiobook": "SOUND", "dvd": "VIDEO", "serial": "JOUR", "comic": "BOOK"}
BIBTEX_TYPES = {"serial": "article", "dvd": "misc", "audiobook": "misc"}


@dataclass(frozen=True)
class Name:
    last: str
    given: str = ""

    @property
    def initials(self) -> str:
        parts = [p for p in re.split(r"[\s.]+", self.given) if p]
        return " ".join(f"{p[0]}." if not p.endswith(".") else p for p in (q.split("-")[0] for q in parts))

    @property
    def inverted(self) -> str:
        return f"{self.last}, {self.given}" if self.given else self.last

    @property
    def natural(self) -> str:
        return f"{self.given} {self.last}" if self.given else self.last


def parse_name(raw: str) -> Name:
    raw = re.sub(r"[,;:\s]+$", "", (raw or "").strip())
    if raw.endswith(".") and not re.search(r"(^|[\s.])\w\.$", raw):  # keep the dot of a trailing initial ("Brian W.")
        raw = raw[:-1]
    raw = re.sub(r",?\s*\(?\d{3,4}-(\d{3,4})?\)?$", "", raw).strip(" ,")  # drop MARC life dates
    if "," in raw:
        last, given = raw.split(",", 1)
        return Name(last.strip(), given.strip())
    bits = raw.split()
    return Name(bits[-1], " ".join(bits[:-1])) if len(bits) > 1 else Name(raw)


def _title(rec: dict) -> str:
    t = (rec.get("title") or "Untitled").strip().rstrip(" /:.")
    sub = (rec.get("subtitle") or "").strip().rstrip(" /:.")
    return f"{t}: {sub}" if sub else t


def _edition(rec: dict, suffix: str) -> str:
    ed = (rec.get("edition") or "").strip().rstrip(".")
    if not ed or re.fullmatch(r"1(st)?|first", ed, re.I):
        return ""
    ed = re.sub(r"\s*(edition|ed)$", "", ed, flags=re.I)
    return f"{ed} {suffix}"


def _end(s: str) -> str:
    s = s.strip()
    return s if s.endswith((".", "?", "!")) else f"{s}."


def _join(names: list[str], conj: str, oxford: bool = True) -> str:
    if len(names) <= 1:
        return "".join(names)
    if len(names) == 2:
        return f"{names[0]}{',' if oxford and conj == '&' else ''} {conj} {names[1]}"
    return f"{', '.join(names[:-1])}, {conj} {names[-1]}"


# ------------------------------------------------------------------ styles


def apa(rec: dict, *, html: bool = False) -> str:
    names = [parse_name(a) for a in rec.get("authors") or []]
    fmt = [f"{n.last}, {n.initials}" if n.initials else n.last for n in names]
    if len(fmt) > 20:
        fmt = [*fmt[:19], "…", fmt[-1]]
        author = ", ".join(fmt)
    else:
        author = _join(fmt, "&")
    year = f"({rec['pub_year']})" if rec.get("pub_year") else "(n.d.)"
    ed = _edition(rec, "ed.")
    title = _it(_title(rec), html) + (f" ({_e(ed, html)})" if ed else "")
    # APA moves the title into the author position when there is no author.
    parts = [f"{_e(_end(author), html)} {year}.", _end(title)] if author else [_end(title), f"{year}."]
    if rec.get("publisher"):
        parts.append(_e(_end(rec["publisher"]), html))
    return " ".join(p for p in parts if p)


def mla(rec: dict, *, html: bool = False) -> str:
    names = [parse_name(a) for a in rec.get("authors") or []]
    if not names:
        author = ""
    elif len(names) == 1:
        author = names[0].inverted
    elif len(names) == 2:
        author = f"{names[0].inverted}, and {names[1].natural}"
    else:
        author = f"{names[0].inverted}, et al"
    ed = _edition(rec, "ed.")
    tail = ", ".join(p for p in [ed, rec.get("publisher"), str(rec["pub_year"]) if rec.get("pub_year") else None] if p)
    parts = [_e(_end(author), html) if author else None, _end(_it(_title_case(_title(rec)), html)), _e(_end(tail), html) if tail else None]
    return " ".join(p for p in parts if p)


def chicago(rec: dict, *, html: bool = False) -> str:
    names = [parse_name(a) for a in rec.get("authors") or []]
    if len(names) > 10:
        names = names[:7]
        listed = [names[0].inverted, *[n.natural for n in names[1:]]]
        author = ", ".join(listed) + ", et al"
    else:
        listed = [n.inverted if i == 0 else n.natural for i, n in enumerate(names)]
        author = listed[0] if len(listed) == 1 else (f"{listed[0]} and {listed[1]}" if len(listed) == 2 else _join(listed, "and"))
    ed = _edition(rec, "ed.")
    tail = ", ".join(p for p in [rec.get("publisher"), str(rec["pub_year"]) if rec.get("pub_year") else "n.d."] if p)
    parts = [_e(_end(author), html) if author else None, _end(_it(_title_case(_title(rec)), html)),
             _e(_end(ed), html) if ed else None, _e(_end(tail), html)]
    return " ".join(p for p in parts if p)


_BIB_ESC = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_"}


def _bib(s: str) -> str:
    return "".join(_BIB_ESC.get(c, c) for c in s)


def bibtex_key(rec: dict) -> str:
    names = [parse_name(a) for a in rec.get("authors") or []]
    last = names[0].last if names else "anon"
    word = next((w for w in re.findall(r"\w+", rec.get("title") or "") if w.lower() not in {"the", "a", "an", "of"}), "untitled")
    key = f"{last}{rec.get('pub_year') or 'nd'}{word}"
    key = unicodedata.normalize("NFKD", key).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]", "", key).lower() or f"record{rec.get('id', '')}"


def bibtex(rec: dict, *, html: bool = False) -> str:
    kind = BIBTEX_TYPES.get(rec.get("material_type") or "book", "book")
    fields = [("author", " and ".join(_bib(parse_name(a).inverted) for a in rec.get("authors") or [])),
              ("title", "{" + _bib(_title(rec)) + "}"), ("edition", _bib(rec.get("edition") or "")),
              ("publisher", _bib(rec.get("publisher") or "")), ("year", str(rec.get("pub_year") or "")),
              ("isbn", rec.get("isbn") or ""), ("url", rec.get("url") or "")]
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields if v)
    out = f"@{kind}{{{bibtex_key(rec)},\n{body}\n}}"
    return _html.escape(out) if html else out


def ris(rec: dict, *, html: bool = False) -> str:
    lines = [("TY", RIS_TYPES.get(rec.get("material_type") or "book", "BOOK"))]
    lines += [("AU", parse_name(a).inverted) for a in rec.get("authors") or []]
    lines += [("TI", _title(rec)), ("PY", str(rec.get("pub_year") or "")), ("ET", rec.get("edition") or ""),
              ("PB", rec.get("publisher") or ""), ("SN", rec.get("isbn") or ""), ("LA", rec.get("language") or ""),
              ("UR", rec.get("url") or "")]
    lines += [("KW", s) for s in rec.get("subjects") or []]
    lines.append(("ER", ""))
    out = "\r\n".join(f"{tag}  - {val}" for tag, val in lines if val or tag == "ER") + "\r\n"
    return _html.escape(out) if html else out


FORMATTERS = {"apa": apa, "mla": mla, "chicago": chicago, "bibtex": bibtex, "ris": ris}


def cite(rec: dict, style: str) -> dict:
    fn = FORMATTERS[style]
    return {"style": style, "name": STYLE_NAMES[style], "text": fn(rec), "html": fn(rec, html=True)}


# ------------------------------------------------------------------ helpers


def _e(s: str, html: bool) -> str:
    return _html.escape(s, quote=False) if html else s


def _it(s: str, html: bool) -> str:
    return f"<i>{_html.escape(s, quote=False)}</i>" if html else s


_SMALL = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "up", "via"}


def _title_case(s: str) -> str:
    """Headline-style capitalisation (MLA/Chicago); words already capitalised are left alone."""
    words = s.split(" ")
    out = []
    for i, w in enumerate(words):
        prev = words[i - 1] if i else ""
        if i and w.lower() in _SMALL and not prev.endswith(":") and i != len(words) - 1:
            out.append(w.lower() if w.islower() or w.istitle() else w)
        else:
            out.append(w[:1].upper() + w[1:] if w[:1].islower() else w)
    return " ".join(out)
