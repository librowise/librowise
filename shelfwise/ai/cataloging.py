"""AI-assisted cataloguing: metadata lookup by ISBN, subject headings, classification, summary."""

from __future__ import annotations

import logging
import re
from collections import Counter

import httpx
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Biblio
from ..services.catalog import normalize_isbn
from . import llm, semantic

log = logging.getLogger("shelfwise.ai")

# Coarse Dewey Decimal mapping for the local engine (keyword -> class, label)
DEWEY_RULES: list[tuple[str, str, str]] = [
    (r"programming|software|python|algorithm|computer|computing|database", "005.1", "Computer programming"),
    (r"artificial intelligence|machine learning|neural", "006.3", "Artificial intelligence"),
    (r"library|librarianship|cataloging", "020", "Library & information sciences"),
    (r"philosoph|ethic|stoic|metaphysic", "100", "Philosophy"),
    (r"psycholog|mind|cognition|behavio", "150", "Psychology"),
    (r"religio|god|bible|hindu|buddh|islam|christian", "200", "Religion"),
    (r"econom|finance|money|market|invest", "330", "Economics"),
    (r"law|legal|constitution", "340", "Law"),
    (r"politic|government|democracy", "320", "Political science"),
    (r"education|teaching|school|pedagog", "370", "Education"),
    (r"language|linguistic|grammar|dictionary", "400", "Language"),
    (r"mathemat|algebra|calculus|geometry|statistic", "510", "Mathematics"),
    (r"astronom|planet|cosmos|universe|space|galax|mars\b|moon\b", "520", "Astronomy"),
    (r"physics|quantum|relativity|mechanics", "530", "Physics"),
    (r"chemi", "540", "Chemistry"),
    (r"evolution|biolog|species|genetic|darwin", "576", "Biology & evolution"),
    (r"animal|wildlife|zoolog|birds", "590", "Animals"),
    (r"medicin|health|disease|nutrition|fitness", "610", "Medicine & health"),
    (r"engineer|technolog|electronic", "620", "Engineering"),
    (r"cook|recipe|baking|cuisine", "641.5", "Cooking"),
    (r"business|management|leadership|marketing", "658", "Management"),
    (r"art|painting|drawing|sculpture", "750", "Painting & arts"),
    (r"music|song|symphon", "780", "Music"),
    (r"sport|football|cricket|olympic|game", "796", "Sports"),
    (r"poetry|poems|verse", "821", "Poetry"),
    (r"drama|play|shakespeare|theatre", "822", "Drama"),
    (r"fiction|novel|stories|tale|mystery|detective|romance|fantasy|adventure", "823", "Fiction"),
    (r"travel|journey|geograph", "910", "Geography & travel"),
    (r"biograph|memoir|autobiograph|life of", "920", "Biography"),
    (r"history|historical|war|empire|ancient|civilization|revolution", "900", "History"),
]


def local_classify(text: str) -> tuple[str | None, str | None]:
    low = text.lower()
    for pattern, cls, label in DEWEY_RULES:
        if re.search(rf"(?:{pattern})", low):
            return cls, label
    return None, None


def local_audience(text: str) -> str:
    low = text.lower()
    if re.search(r"\b(children|picture book|juvenile|ages \d|bedtime|kids)\b", low):
        return "children"
    if re.search(r"\b(young adult|teen|teenager|coming of age|high school)\b", low):
        return "young_adult"
    return "adult"


def local_summary(description: str | None, max_sentences: int = 2) -> str | None:
    if not description:
        return None
    sentences = re.split(r"(?<=[.!?])\s+", description.strip())
    return " ".join(sentences[:max_sentences])


def suggest_local(db: Session, data: dict) -> dict:
    text = " ".join(
        str(x) for x in [data.get("title"), data.get("subtitle"), data.get("description"),
                         " ".join(data.get("subjects") or [])] if x
    )
    exclude = {data["id"]} if data.get("id") else set()
    neighbours = semantic.index.similar_to_text(db, text, limit=8, exclude=exclude)
    subject_votes: Counter = Counter()
    class_votes: Counter = Counter()
    for bid, score in neighbours:
        b = db.get(Biblio, bid)
        if not b:
            continue
        for s in b.subjects or []:
            subject_votes[s] += score
        if b.classification:
            class_votes[b.classification] += score
    existing = {s.lower() for s in data.get("subjects") or []}
    top_vote = max(subject_votes.values(), default=0)
    # Keep only headings with real consensus among neighbours (>= 40% of the strongest vote).
    subjects = [s for s, v in subject_votes.most_common(10)
                if s.lower() not in existing and v >= 0.4 * top_vote][:5]
    cls, label = local_classify(text)
    if class_votes:
        best, votes = class_votes.most_common(1)[0]
        if votes >= 0.35 * sum(class_votes.values()) or not cls:
            cls, label = best, label if cls and cls[:3] == best[:3] else "From similar records"
    return {
        "engine": "local",
        "subjects": subjects,
        "classification": cls,
        "classification_label": label,
        "audience": local_audience(text),
        "summary": local_summary(data.get("description")),
        "keywords": [t for t, _ in Counter(semantic.tokenize(text)).most_common(8)],
        "similar_records": [bid for bid, _ in neighbours[:5]],
    }


_SCHEMA = {
    "type": "object",
    "properties": {
        "subjects": {"type": "array", "items": {"type": "string"}, "description": "3-6 Library of Congress style subject headings"},
        "classification": {"type": "string", "description": "Dewey Decimal number, e.g. 823.912"},
        "classification_label": {"type": "string"},
        "audience": {"type": "string", "enum": ["children", "young_adult", "adult"]},
        "summary": {"type": "string", "description": "Neutral 2-3 sentence catalogue summary without spoilers"},
        "keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["subjects", "classification", "classification_label", "audience", "summary", "keywords"],
    "additionalProperties": False,
}


def suggest(db: Session, data: dict) -> dict:
    local = suggest_local(db, data)
    record = "\n".join(
        f"{k}: {v}" for k, v in data.items()
        if k in ("title", "subtitle", "authors", "publisher", "pub_year", "description", "subjects", "isbn") and v
    )
    ai = llm.complete_json(
        "You are an expert cataloguing librarian. Suggest subject headings, a Dewey Decimal "
        "classification, target audience and a short neutral summary for the record. If the "
        "record is sparse, rely on your knowledge of the work when you recognise it.",
        record,
        _SCHEMA,
    )
    if ai:
        ai["engine"] = "claude"
        ai["similar_records"] = local["similar_records"]
        return ai
    return local


def lookup_isbn(isbn: str) -> dict | None:
    """Fetch bibliographic data from Open Library (no API key needed)."""
    norm = normalize_isbn(isbn)
    if not norm or not get_settings().metadata_lookup_enabled:
        return None
    url = "https://openlibrary.org/api/books"
    try:
        r = httpx.get(url, params={"bibkeys": f"ISBN:{norm}", "format": "json", "jscmd": "data"}, timeout=8)
        r.raise_for_status()
        data = r.json().get(f"ISBN:{norm}")
    except (httpx.HTTPError, ValueError) as exc:
        log.info("ISBN lookup failed for %s: %s", norm, exc)
        return None
    if not data:
        return None
    year = None
    if m := re.search(r"(\d{4})", data.get("publish_date", "")):
        year = int(m.group(1))
    return {
        "isbn": norm,
        "title": data.get("title"),
        "subtitle": data.get("subtitle"),
        "authors": [a.get("name") for a in data.get("authors", []) if a.get("name")],
        "publisher": ", ".join(p.get("name", "") for p in data.get("publishers", [])) or None,
        "pub_year": year,
        "pages": data.get("number_of_pages"),
        "subjects": [s.get("name") for s in data.get("subjects", [])[:8] if s.get("name")],
        "cover_url": (data.get("cover") or {}).get("medium"),
        "source": "openlibrary",
    }
