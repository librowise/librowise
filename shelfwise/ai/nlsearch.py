"""Natural-language search: "funny books for kids about space published after 2015"."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from sqlalchemy.orm import Session

from ..services import catalog
from . import llm, semantic

LANGUAGES = {
    "english": "en", "hindi": "hi", "french": "fr", "spanish": "es", "german": "de",
    "russian": "ru", "italian": "it", "bengali": "bn", "tamil": "ta", "urdu": "ur",
    "japanese": "ja", "chinese": "zh", "sanskrit": "sa", "marathi": "mr", "telugu": "te",
}
MATERIALS = {
    "dvd": "dvd", "dvds": "dvd", "film": "dvd", "films": "dvd", "movie": "dvd", "movies": "dvd",
    "audiobook": "audiobook", "audiobooks": "audiobook", "ebook": "ebook", "ebooks": "ebook",
    "magazine": "serial", "magazines": "serial", "journal": "serial", "journals": "serial",
    "comic": "comic", "comics": "comic", "graphic": "comic",
}
AUDIENCES = [
    (r"\b(kids?|children|child|toddlers?|picture books?)\b", "children"),
    (r"\b(teens?|teenagers?|young adults?|ya)\b", "young_adult"),
]


@dataclass
class ParsedQuery:
    keywords: str
    author: str | None = None
    language: str | None = None
    material_type: str | None = None
    audience: str | None = None
    year_from: int | None = None
    year_to: int | None = None
    available_only: bool = False
    interpretation: list[str] = field(default_factory=list)
    engine: str = "local"


def parse_local(q: str) -> ParsedQuery:
    text = " " + q.strip() + " "
    notes: list[str] = []
    pq = ParsedQuery(keywords="")

    m = re.search(r"\bby\s+([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})", text)
    if m:
        pq.author = m.group(1).strip()
        text = text.replace(m.group(0), " ")
        notes.append(f"author contains “{pq.author}”")

    low = text.lower()
    if m := re.search(r"\bbetween\s+(\d{4})\s+(?:and|-|to)\s+(\d{4})\b", low):
        pq.year_from, pq.year_to = int(m.group(1)), int(m.group(2))
        low = low.replace(m.group(0), " ")
    if m := re.search(r"\b(?:after|since|from)\s+(\d{4})\b(?!s)", low):
        pq.year_from = int(m.group(1)) + (1 if "after" in m.group(0) else 0)
        low = low.replace(m.group(0), " ")
    if m := re.search(r"\bbefore\s+(\d{4})\b", low):
        pq.year_to = int(m.group(1)) - 1
        low = low.replace(m.group(0), " ")
    if m := re.search(r"\b(?:from\s+the\s+|in\s+the\s+)?(\d{3})0s\b", low):
        decade = int(m.group(1)) * 10
        pq.year_from, pq.year_to = decade, decade + 9
        low = low.replace(m.group(0), " ")
    if m := re.search(r"\b(?:recent|new|latest)\b", low):
        pq.year_from = pq.year_from or 2015
        low = low.replace(m.group(0), " ")
    if pq.year_from or pq.year_to:
        notes.append(f"published {pq.year_from or '…'}–{pq.year_to or 'now'}")

    for pattern, audience in AUDIENCES:
        if re.search(pattern, low):
            pq.audience = audience
            low = re.sub(pattern, " ", low)
            notes.append(f"audience: {audience.replace('_', ' ')}")
            break
    for name, code in LANGUAGES.items():
        if re.search(rf"\b(in\s+)?{name}\b", low):
            pq.language = code
            low = re.sub(rf"\b(in\s+)?{name}\b", " ", low)
            notes.append(f"language: {name.title()}")
            break
    for word, mtype in MATERIALS.items():
        if re.search(rf"\b{word}\b", low):
            pq.material_type = mtype
            low = re.sub(rf"\b{word}\b", " ", low)
            notes.append(f"format: {mtype}")
            break
    if re.search(r"\b(available|on the shelf|on shelf|in stock|right now)\b", low):
        pq.available_only = True
        low = re.sub(r"\b(available|on the shelf|on shelf|in stock|right now)\b", " ", low)
        notes.append("available now")

    low = re.sub(r"\b(published|written|about|on|for|of|the|that|are|is|with|some|me|i|want|to|read|books?|novels?|titles?|something|anything|find|show|good|any)\b", " ", low)
    pq.keywords = " ".join(low.split())
    pq.interpretation = notes
    return pq


_SCHEMA = {
    "type": "object",
    "properties": {
        "keywords": {"type": "string", "description": "Topic words to match against title, subject and description. Expand with close synonyms."},
        "author": {"type": ["string", "null"]},
        "language": {"type": ["string", "null"], "description": "ISO 639-1 code"},
        "material_type": {"type": ["string", "null"], "enum": ["book", "ebook", "audiobook", "dvd", "serial", "comic", None]},
        "audience": {"type": ["string", "null"], "enum": ["children", "young_adult", "adult", None]},
        "year_from": {"type": ["integer", "null"]},
        "year_to": {"type": ["integer", "null"]},
        "available_only": {"type": "boolean"},
        "interpretation": {"type": "array", "items": {"type": "string"}, "description": "Short human-readable notes on how the request was understood"},
    },
    "required": ["keywords", "author", "language", "material_type", "audience", "year_from",
                 "year_to", "available_only", "interpretation"],
    "additionalProperties": False,
}

_SYSTEM = (
    "You translate library patrons' natural-language requests into structured catalogue search "
    "parameters. Only set a filter when the request clearly implies it. Put the subject matter "
    "in `keywords`, adding a few close synonyms that would appear in subject headings."
)


def parse(q: str) -> ParsedQuery:
    data = llm.complete_json(_SYSTEM, f"Request: {q}", _SCHEMA, max_tokens=1500)
    if data:
        try:
            return ParsedQuery(**{k: data.get(k) for k in _SCHEMA["properties"]}, engine="claude")
        except TypeError:
            pass
    return parse_local(q)


def smart_search(db: Session, q: str, *, page: int = 1, per_page: int = 20) -> dict:
    """Hybrid search: parsed filters + reciprocal-rank fusion of BM25 and semantic rankings."""
    pq = parse(q)
    filters = catalog.SearchFilters(
        material_type=pq.material_type, language=pq.language, audience=pq.audience,
        author=pq.author, year_from=pq.year_from, year_to=pq.year_to,
        available_only=bool(pq.available_only),
    )
    keywords = pq.keywords.strip()
    # All matches that satisfy the structured filters (unranked if there are no keywords)
    filtered = catalog.search(db, None, filters, page=1, per_page=100000, sort="newest")
    allowed = set(filtered.ids)
    if keywords:
        bm25 = [i for i in (catalog._candidate_ids(db, keywords) or []) if i in allowed]
        # BM25 requires every term; also try any-term matches for long queries
        sem = [i for i, _ in semantic.index.search(db, keywords, limit=300) if i in allowed]
        ranked = semantic.reciprocal_rank_fusion(bm25, sem)
    else:
        ranked = filtered.ids
    start = (page - 1) * per_page
    return {
        "parsed": asdict(pq),
        "total": len(ranked),
        "ids": ranked[start : start + per_page],
        "facets": filtered.facets,
    }
