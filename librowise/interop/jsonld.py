"""schema.org JSON-LD and Open Graph metadata for OPAC record pages (server-rendered for SEO).

Follows the "schema.org for libraries" pattern: the work is a ``Book`` (or ``Movie``,
``Periodical``, ``Audiobook``...), and each branch holding copies is an ``Offer`` with
``businessFunction`` *LeaseOut*, an availability and the ``Library`` it is available at.
"""

from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Biblio, ItemStatus

SCHEMA_TYPES = {"book": "Book", "ebook": "Book", "comic": "Book", "audiobook": "Audiobook", "dvd": "Movie",
                "serial": "Periodical"}
BOOK_FORMATS = {"ebook": "https://schema.org/EBook",
                "comic": "https://schema.org/GraphicNovel", "audiobook": "https://schema.org/AudiobookFormat"}
OG_TYPES = {"book": "book", "ebook": "book", "comic": "book", "audiobook": "book", "dvd": "video.movie"}
_UNAVAILABLE = {ItemStatus.withdrawn, ItemStatus.lost}


def _person(name: str) -> dict:
    # Catalogue headings are "Surname, Forename"; schema.org wants the display form.
    parts = [p.strip() for p in name.split(",") if p.strip()]
    display = " ".join(reversed(parts[:2])) if len(parts) >= 2 else name.strip()
    return {"@type": "Person", "name": display}


def _offers(b: Biblio, currency: str) -> list[dict]:
    by_branch: dict[int, list] = defaultdict(list)
    for item in b.items:
        if item.deleted_at is None and item.status not in _UNAVAILABLE:
            by_branch[item.branch_id].append(item)
    offers = []
    for items in by_branch.values():
        branch = items[0].branch
        available = sum(1 for i in items if i.status == ItemStatus.available)
        library: dict = {"@type": "Library", "name": branch.name}
        if branch.address:
            library["address"] = branch.address
        if branch.phone:
            library["telephone"] = branch.phone
        if branch.email:
            library["email"] = branch.email
        offers.append({
            "@type": "Offer",
            "businessFunction": "http://purl.org/goodrelations/v1#LeaseOut",
            "price": "0",
            "priceCurrency": currency,
            "availability": "https://schema.org/InStock" if available else "https://schema.org/OutOfStock",
            "inventoryLevel": {"@type": "QuantitativeValue", "value": available},
            "offeredBy": library,
            "availableAtOrFrom": library,
            "sku": items[0].call_number or None,
        })
    for o in offers:
        if o["sku"] is None:
            del o["sku"]
    return offers


def record_metadata(db: Session, biblio_id: int, *, base_url: str, library_name: str) -> dict | None:
    """Everything the OPAC record template needs for SEO, or None if the record does not exist."""
    b = db.get(Biblio, biblio_id)
    if b is None or b.deleted_at is not None:
        return None
    base = base_url.rstrip("/")
    url = f"{base}/record/{b.id}"
    currency = get_settings().currency
    kind = SCHEMA_TYPES.get(b.material_type, "CreativeWork")
    ld: dict = {"@context": "https://schema.org", "@type": kind, "@id": url, "url": url, "name": b.title}
    if b.subtitle:
        ld["alternativeHeadline"] = b.subtitle
    if b.authors:
        key = "director" if kind == "Movie" else "author"
        ld[key] = [_person(a) for a in b.authors]
    if b.isbn and kind in ("Book", "Audiobook"):
        ld["isbn"] = b.isbn
    if b.issn and kind == "Periodical":
        ld["issn"] = b.issn
    if b.pub_year:
        ld["datePublished"] = str(b.pub_year)
    if b.language:
        ld["inLanguage"] = b.language
    if b.publisher:
        ld["publisher"] = {"@type": "Organization", "name": b.publisher}
    if b.edition and kind in ("Book", "Audiobook"):
        ld["bookEdition"] = b.edition
    if b.pages and kind in ("Book", "Audiobook"):
        ld["numberOfPages"] = b.pages
    if b.material_type in BOOK_FORMATS and kind in ("Book", "Audiobook"):
        ld["bookFormat"] = BOOK_FORMATS[b.material_type]
    if b.subjects:
        ld["about"] = [{"@type": "Thing", "name": s} for s in b.subjects]
        ld["keywords"] = ", ".join(b.subjects)
    if b.description:
        ld["description"] = b.description
    if b.cover_url:
        ld["image"] = b.cover_url
    if b.series:
        ld["isPartOf"] = {"@type": "CreativeWorkSeries", "name": b.series}
    if b.audience:
        ld["audience"] = {"@type": "Audience", "audienceType": b.audience.replace("_", " ")}
    offers = _offers(b, currency)
    if offers:
        ld["offers"] = offers

    who = ", ".join(_person(a)["name"] for a in (b.authors or [])[:3])
    summary = (b.description or "").strip()
    if not summary:
        bits = [f"by {who}" if who else "", str(b.pub_year) if b.pub_year else "", b.publisher or ""]
        summary = f"{b.title} " + " · ".join(x for x in bits if x) + f" — available at {library_name}."
    if len(summary) > 300:
        summary = summary[:297].rsplit(" ", 1)[0] + "…"
    og = {
        "og:type": OG_TYPES.get(b.material_type, "website"),
        "og:title": b.title + (f": {b.subtitle}" if b.subtitle else ""),
        "og:description": summary,
        "og:url": url,
        "og:site_name": library_name,
    }
    if b.cover_url:
        og["og:image"] = b.cover_url
    if og["og:type"] == "book":
        if b.isbn:
            og["book:isbn"] = b.isbn
        if b.pub_year:
            og["book:release_date"] = str(b.pub_year)
        if b.subjects:
            og["book:tag"] = b.subjects[0]
    return {"jsonld": ld, "og": og, "title": b.title, "description": summary, "canonical": url,
            "authors": [_person(a)["name"] for a in (b.authors or [])]}
