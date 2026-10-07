"""Authority control: authorised headings, see-from variants, see-also references and linking.

Headings in bibliographic records (authors, subjects, series) are linked to authorities by a
*normalised key* (Unicode diacritics, case and punctuation folded). A heading that matches a
see-from variant is rewritten to the authorised form, so the catalogue stays consistent and
renaming or merging an authority propagates to every linked record.

Subject strings with subdivisions ("Whaling -- Fiction") link to the authority of their main
heading ("Whaling") unless the whole string is itself an authorised heading. Personal names
also match on a date-less key ("Austen, Jane" ~ "Austen, Jane, 1775-1817") when unambiguous;
such matches are linked but not rewritten.

Linking runs automatically whenever a record's headings change (a SQLAlchemy ``before_flush``
hook, gated by the ``authority_auto_link`` policy) and in bulk via :func:`relink_all`
(``python -m librowise authorities relink``).
"""

from __future__ import annotations

import io
import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

import pymarc
from sqlalchemy import Text, cast, delete, event, func, or_, select
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from ..errors import Conflict, DomainError, NotFound
from ..models import Authority, AuthorityType, AuthorityVariant, Biblio, BiblioAuthority, utcnow
from . import catalog
from . import settings as settings_svc

settings_svc.DEFAULTS.setdefault(
    "authority_auto_link",
    (True, "Link record headings to authorities when records are saved, rewriting see-from variants "
           "to the authorised form"),
)

T = AuthorityType
NAME_TYPES: tuple[AuthorityType, ...] = (T.personal_name, T.corporate_name, T.meeting_name)
SUBJECT_TYPES: tuple[AuthorityType, ...] = (T.topical_subject, T.geographic, T.genre_form)
ROLE_TYPES: dict[str, tuple[AuthorityType, ...]] = {
    "author": NAME_TYPES,
    "subject": SUBJECT_TYPES + NAME_TYPES + (T.uniform_title,),
    "series": (T.uniform_title,),
}
ROLE_FIELDS = {"author": "authors", "subject": "subjects", "series": "series"}
RELATIONSHIPS = ("broader", "narrower", "related", "earlier", "later")
BROWSE_GROUPS: dict[str, tuple[AuthorityType, ...]] = {
    "authors": NAME_TYPES, "subjects": SUBJECT_TYPES, "titles": (T.uniform_title,),
}
TYPE_LABELS = {
    "personal_name": "Personal name", "corporate_name": "Corporate name", "meeting_name": "Meeting name",
    "uniform_title": "Uniform title", "topical_subject": "Topical subject", "geographic": "Geographic name",
    "genre_form": "Genre/form",
}
_SUPPRESS = "librowise.authorities.suppress_autolink"


def roles_for_type(auth_type: AuthorityType) -> tuple[str, ...]:
    return tuple(r for r, types in ROLE_TYPES.items() if auth_type in types)


# ------------------------------------------------------------------ normalisation

_FOLD = str.maketrans({"ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ł": "l", "Ł": "l",
                       "đ": "d", "Đ": "d", "ð": "d", "Ð": "d", "þ": "th", "Þ": "th", "ı": "i", "ß": "ss"})
_DATES = re.compile(r",?\s*(?:b\.|d\.|fl\.|ca\.|approximately)?\s*\d{3,4}\??(?:\s*-\s*(?:\d{3,4}\??)?)?\.?\s*$", re.I)
_SUBDIV = re.compile(r"\s*--\s*")


def normalize_heading(value: str | None) -> str:
    """Fold case, diacritics and punctuation: "Brontë, Charlotte." -> "bronte charlotte"."""
    if not value:
        return ""
    s = unicodedata.normalize("NFKD", str(value).translate(_FOLD))
    s = "".join(c for c in s if not unicodedata.combining(c)).casefold()
    s = re.sub(r"[\W_]+", " ", s)
    return " ".join(s.split())


def name_key(value: str | None) -> str:
    """Key for a name without qualifiers and dates: "Austen, Jane, 1775-1817" -> "austen jane"."""
    if not value:
        return ""
    s = re.sub(r"\([^)]*\)", " ", str(value)).strip()
    s = _DATES.sub("", s)
    return normalize_heading(s)


def split_subdivisions(heading: str) -> list[str]:
    return [p.strip() for p in _SUBDIV.split(heading or "") if p.strip()]


def clean_heading(value: str | None) -> str:
    s = " ".join(str(value or "").split()).strip(" ,;:/")
    if s.endswith(".") and not re.search(r"(\b[A-Za-z]|etc)\.$", s):
        s = s[:-1].rstrip()
    return s


def _match_key_for(auth_type: AuthorityType, heading: str) -> str | None:
    if auth_type not in NAME_TYPES:
        return None
    k = name_key(heading)
    return k if k and k != normalize_heading(heading) else None


# ------------------------------------------------------------------ resolution


@dataclass
class Match:
    authority: Authority
    heading: str  # what the record should contain
    via: str  # heading | variant | name


class Resolver:
    """Resolves record headings to live authorities.

    ``preload=True`` loads every authority once (bulk operations); otherwise each distinct
    heading costs a few indexed queries (single-record saves).
    """

    def __init__(self, db: Session, *, preload: bool = False):
        self.db = db
        self.preloaded = preload
        self._cache: dict[tuple[str, str], Match | None] = {}
        if preload:
            self.by_key: dict[str, list[Authority]] = defaultdict(list)
            self.by_variant: dict[str, list[Authority]] = defaultdict(list)
            self.by_name: dict[str, list[Authority]] = defaultdict(list)
            for a in db.scalars(select(Authority).where(Authority.deleted_at.is_(None))):
                self.by_key[a.normalized].append(a)
                if a.match_key:
                    self.by_name[a.match_key].append(a)
                for v in a.variants:
                    self.by_variant[v.normalized].append(a)

    def _candidates(self, kind: str, key: str) -> list[Authority]:
        if self.preloaded:
            return {"heading": self.by_key, "variant": self.by_variant, "name": self.by_name}[kind].get(key, [])
        live = Authority.deleted_at.is_(None)
        if kind == "heading":
            stmt = select(Authority).where(Authority.normalized == key, live)
        elif kind == "variant":
            stmt = (select(Authority).join(AuthorityVariant, AuthorityVariant.authority_id == Authority.id)
                    .where(AuthorityVariant.normalized == key, live))
        else:
            stmt = select(Authority).where(Authority.match_key == key, live)
        return list(self.db.scalars(stmt).unique())

    def _find(self, heading: str, types: tuple[AuthorityType, ...]) -> tuple[Authority, str] | None:
        key = normalize_heading(heading)
        if not key:
            return None
        for kind, k in (("heading", key), ("variant", key), ("name", name_key(heading))):
            if not k:
                continue
            cands = [a for a in self._candidates(kind, k) if a.auth_type in types]
            if kind == "name":
                cands = [a for a in cands if a.auth_type in NAME_TYPES]
                if len({a.id for a in cands}) != 1:
                    continue  # ambiguous or none: never guess between two people
            if cands:
                cands.sort(key=lambda a: (types.index(a.auth_type), a.id))
                return cands[0], kind
        return None

    def resolve(self, role: str, heading: str) -> Match | None:
        ck = (role, heading)
        if ck in self._cache:
            return self._cache[ck]
        types = ROLE_TYPES[role]
        result: Match | None = None
        found = self._find(heading, types)
        if found:
            a, via = found
            result = Match(a, heading if via == "name" else a.heading, via)
        elif role == "subject":
            parts = split_subdivisions(heading)
            if len(parts) > 1 and (found := self._find(parts[0], types)):
                a, via = found
                main = parts[0] if via == "name" else a.heading
                result = Match(a, " -- ".join([main, *parts[1:]]), via)
        self._cache[ck] = result
        return result


def _dedupe(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        k = v.lower()
        if v and k not in seen:
            seen.add(k)
            out.append(v)
    return out


def link_biblio(db: Session, biblio: Biblio, resolver: Resolver, *, rewrite: bool = True) -> dict:
    """Recompute a record's authority links (and optionally rewrite variant headings).

    Returns ``{"rewritten": [(field, before, after)], "links": n}``. Works for pending records.
    """
    desired: dict[tuple[int, str], str] = {}
    rewritten: list[tuple[str, str, str]] = []
    for role in ("author", "subject"):
        attr = ROLE_FIELDS[role]
        values = list(getattr(biblio, attr) or [])
        out = []
        for v in values:
            m = resolver.resolve(role, v)
            nv = v
            if m:
                if rewrite and m.heading != v:
                    nv = m.heading
                    rewritten.append((attr, v, nv))
                desired.setdefault((m.authority.id, role), nv)
            out.append(nv)
        if rewrite and out != values:
            setattr(biblio, attr, _dedupe(out))
    if biblio.series:
        m = resolver.resolve("series", biblio.series)
        if m:
            if rewrite and m.heading != biblio.series:
                rewritten.append(("series", biblio.series, m.heading))
                biblio.series = m.heading
            desired.setdefault((m.authority.id, "series"), biblio.series)

    existing = [] if biblio.id is None else list(
        db.scalars(select(BiblioAuthority).where(BiblioAuthority.biblio_id == biblio.id)))
    by_key = {(link.authority_id, link.role): link for link in existing}
    for key, link in by_key.items():
        if key not in desired:
            db.delete(link)
        elif link.heading != desired[key][:500]:
            link.heading = desired[key][:500]
    for (auth_id, role), heading in desired.items():
        if (auth_id, role) not in by_key:
            db.add(BiblioAuthority(biblio=biblio, authority_id=auth_id, role=role, heading=heading[:500]))
    return {"rewritten": rewritten, "links": len(desired)}


def _headings_changed(obj: Biblio) -> bool:
    state = sa_inspect(obj)
    if state.pending or obj.id is None:
        return True
    return any(state.attrs[a].history.has_changes() for a in ("authors", "subjects", "series"))


@event.listens_for(Session, "before_flush")
def _auto_link_on_flush(session: Session, _flush_context, _instances) -> None:
    if session.info.get(_SUPPRESS):
        return
    targets = [o for o in (*session.new, *session.dirty)
               if isinstance(o, Biblio) and o.deleted_at is None and _headings_changed(o)]
    if not targets:
        return
    with session.no_autoflush:
        if not session.scalar(select(Authority.id).where(Authority.deleted_at.is_(None)).limit(1)):
            return
        if not settings_svc.get(session, "authority_auto_link"):
            return
        resolver = Resolver(session)
        for b in targets:
            link_biblio(session, b, resolver, rewrite=True)


class suppressed_autolink:
    """Context manager: bulk operations link explicitly, so skip the per-flush hook."""

    def __init__(self, db: Session):
        self.db = db

    def __enter__(self):
        self.prev = self.db.info.get(_SUPPRESS)
        self.db.info[_SUPPRESS] = True
        return self

    def __exit__(self, *exc):
        self.db.info[_SUPPRESS] = self.prev


def _relink(db: Session, biblios: Iterable[Biblio], resolver: Resolver, *, rewrite: bool = True) -> dict:
    stats = {"records": 0, "rewritten": 0, "links": 0}
    for b in biblios:
        res = link_biblio(db, b, resolver, rewrite=rewrite)
        stats["records"] += 1
        stats["links"] += res["links"]
        if res["rewritten"]:
            stats["rewritten"] += 1
            b.updated_at = utcnow()
            db.flush()
            catalog.index_biblio(db, b)
    db.flush()
    return stats


def relink_all(db: Session, *, rewrite: bool = True, batch: int = 500) -> dict:
    """Re-derive every link in the catalogue (idempotent). Rewrites variants to authorised forms."""
    with suppressed_autolink(db):
        db.execute(delete(BiblioAuthority).where(
            BiblioAuthority.biblio_id.in_(select(Biblio.id).where(Biblio.deleted_at.is_not(None)))))
        resolver = Resolver(db, preload=True)
        ids = list(db.scalars(select(Biblio.id).where(Biblio.deleted_at.is_(None)).order_by(Biblio.id)))
        total = {"records": 0, "rewritten": 0, "links": 0}
        for i in range(0, len(ids), batch):
            chunk = list(db.scalars(select(Biblio).where(Biblio.id.in_(ids[i:i + batch]))))
            for k, v in _relink(db, chunk, resolver, rewrite=rewrite).items():
                total[k] += v
    return total


_STOP = {"and", "the", "for", "with", "from", "fiction", "history"}


def _candidate_biblios(db: Session, headings: Iterable[str]) -> list[Biblio]:
    """Live records whose heading fields may contain one of ``headings`` (cheap LIKE pre-filter)."""
    tokens: set[str] = set()
    for h in headings:
        words = [w for w in normalize_heading(h).split() if len(w) >= 3 and w.isascii() and w not in _STOP]
        if not words:
            words = [w for w in normalize_heading(h).split() if w.isascii() and w]
        if not words:
            tokens = set()
            break
        tokens.update(w[:5] for w in words)
    stmt = select(Biblio).where(Biblio.deleted_at.is_(None))
    if tokens:
        conds = []
        for t in sorted(tokens):
            like = f"%{t}%"
            conds += [func.lower(cast(Biblio.authors, Text)).like(like),
                      func.lower(cast(Biblio.subjects, Text)).like(like),
                      func.lower(Biblio.series).like(like)]
        stmt = stmt.where(or_(*conds))
    return list(db.scalars(stmt))


def relink_for(db: Session, authorities: Iterable[Authority], *, extra_headings: Iterable[str] = (),
               extra_biblio_ids: Iterable[int] = ()) -> dict:
    """Relink records linked to, or textually matching, the given authorities."""
    auths = list(authorities)
    headings = list(extra_headings)
    ids: set[int] = set(extra_biblio_ids)
    for a in auths:
        headings.append(a.heading)
        headings.extend(v.heading for v in a.variants)
        if a.id:
            ids.update(db.scalars(select(BiblioAuthority.biblio_id).where(BiblioAuthority.authority_id == a.id)))
    with suppressed_autolink(db):
        db.flush()
        biblios = {b.id: b for b in _candidate_biblios(db, headings)} if headings else {}
        missing = [i for i in ids if i not in biblios]
        if missing:
            biblios.update({b.id: b for b in db.scalars(
                select(Biblio).where(Biblio.id.in_(missing), Biblio.deleted_at.is_(None)))})
        return _relink(db, sorted(biblios.values(), key=lambda b: b.id), Resolver(db))


# ------------------------------------------------------------------ CRUD


def get_authority(db: Session, authority_id: int) -> Authority:
    a = db.get(Authority, authority_id)
    if a is None or a.deleted_at is not None:
        raise NotFound(f"Authority {authority_id} not found")
    return a


def _check_collision(db: Session, auth_type: AuthorityType, key: str, label: str, exclude_id: int | None) -> None:
    live = [Authority.deleted_at.is_(None), Authority.auth_type == auth_type]
    if exclude_id:
        live.append(Authority.id != exclude_id)
    hit = db.scalar(select(Authority.id).where(Authority.normalized == key, *live))
    if hit:
        raise Conflict(f"“{label}” is already the authorised heading of authority #{hit}",
                       code="authority_exists", details={"authority_id": hit})
    hit = db.scalar(select(Authority.id).join(AuthorityVariant, AuthorityVariant.authority_id == Authority.id)
                    .where(AuthorityVariant.normalized == key, *live))
    if hit:
        raise Conflict(f"“{label}” is already a see-from variant of authority #{hit}",
                       code="authority_variant_exists", details={"authority_id": hit})


def _clean_variants(heading_key: str, variants: Iterable[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen = {heading_key}
    for v in variants or []:
        v = clean_heading(v)[:500]
        k = normalize_heading(v)
        if k and k not in seen:
            seen.add(k)
            out.append((v, k))
    return out


def _clean_see_also(db: Session, auth_type: AuthorityType, refs: Iterable[dict], self_key: str) -> list[dict]:
    out, seen = [], {self_key}
    for r in refs or []:
        heading = clean_heading((r or {}).get("heading"))[:500]
        key = normalize_heading(heading)
        if not key or key in seen:
            continue
        seen.add(key)
        rel = (r.get("relationship") or "related").lower()
        out.append({"heading": heading, "relationship": rel if rel in RELATIONSHIPS else "related",
                    "authority_id": _resolve_ref(db, auth_type, key)})
    return out


def _resolve_ref(db: Session, auth_type: AuthorityType, key: str) -> int | None:
    rows = db.execute(select(Authority.id, Authority.auth_type).where(
        Authority.normalized == key, Authority.deleted_at.is_(None))).all()
    if not rows:
        return None
    rows.sort(key=lambda r: (r[1] != auth_type, r[0]))
    return rows[0][0]


def _parse_type(value) -> AuthorityType:
    try:
        return AuthorityType(value)
    except ValueError:
        raise DomainError(f"Unknown authority type {value!r}", code="validation_error") from None


def create_authority(db: Session, data: dict) -> Authority:
    auth_type = _parse_type(data.get("auth_type"))
    heading = clean_heading(data.get("heading"))[:500]
    key = normalize_heading(heading)
    if not key:
        raise DomainError("A heading is required", code="validation_error")
    _check_collision(db, auth_type, key, heading, None)
    variants = _clean_variants(key, data.get("variants") or [])
    for v, k in variants:
        _check_collision(db, auth_type, k, v, None)
    a = Authority(auth_type=auth_type, heading=heading, normalized=key, match_key=_match_key_for(auth_type, heading),
                  source=(data.get("source") or "local").strip()[:32] or "local", notes=data.get("notes") or None,
                  marc_xml=data.get("marc_xml"),
                  see_also=_clean_see_also(db, auth_type, data.get("see_also") or [], key))
    a.variants = [AuthorityVariant(heading=v, normalized=k) for v, k in variants]
    db.add(a)
    db.flush()
    return a


def update_authority(db: Session, a: Authority, data: dict) -> dict:
    """Patch an authority. A heading change behaves like :func:`rename` (old form kept as a variant)."""
    old_headings = [a.heading, *(v.heading for v in a.variants)]
    if "auth_type" in data and data["auth_type"] and data["auth_type"] != a.auth_type.value:
        new_type = _parse_type(data["auth_type"])
        _check_collision(db, new_type, a.normalized, a.heading, a.id)
        a.auth_type = new_type
        a.match_key = _match_key_for(new_type, a.heading)
    renamed = None
    if data.get("heading") and normalize_heading(data["heading"]) != a.normalized:
        renamed = rename(db, a, data["heading"], keep_variant=data.get("keep_variant", True), relink=False)
    elif data.get("heading"):
        a.heading = clean_heading(data["heading"])[:500]  # same key: punctuation/case fix only
        a.match_key = _match_key_for(a.auth_type, a.heading)
    if "variants" in data and data["variants"] is not None:
        wanted = _clean_variants(a.normalized, data["variants"])
        if renamed and renamed.get("kept_variant"):
            keep = renamed["kept_variant"]
            if normalize_heading(keep) not in {k for _, k in wanted}:
                wanted.append((keep, normalize_heading(keep)))
        current = {v.normalized: v for v in a.variants}
        for v, k in wanted:
            if k not in current:
                _check_collision(db, a.auth_type, k, v, a.id)
        a.variants = [current[k] if k in current and current[k].heading == v else AuthorityVariant(heading=v, normalized=k)
                      for v, k in wanted]
    if "see_also" in data and data["see_also"] is not None:
        a.see_also = _clean_see_also(db, a.auth_type, data["see_also"], a.normalized)
    for f in ("source", "notes"):
        if f in data and data[f] is not None:
            setattr(a, f, (data[f] or "").strip()[:32] if f == "source" else (data[f] or None))
    a.updated_at = utcnow()
    db.flush()
    stats = relink_for(db, [a], extra_headings=old_headings)
    return {"renamed": renamed, "relink": stats}


def _plan_rewrites(db: Session, a: Authority, keys: set[str], new_heading: str,
                   biblios: Iterable[Biblio] | None = None) -> list[dict]:
    """Which record headings change if headings matching ``keys`` become ``new_heading``."""
    roles = roles_for_type(a.auth_type)
    if biblios is None:
        ids = list(db.scalars(select(BiblioAuthority.biblio_id).where(BiblioAuthority.authority_id == a.id)))
        biblios = db.scalars(select(Biblio).where(Biblio.id.in_(ids), Biblio.deleted_at.is_(None))) if ids else []
    plan = []
    for b in biblios:
        changes = []
        for role in roles:
            attr = ROLE_FIELDS[role]
            values = [b.series] if attr == "series" and b.series else ([] if attr == "series" else list(getattr(b, attr) or []))
            for v in values:
                after = None
                if normalize_heading(v) in keys:
                    after = new_heading
                elif role == "subject":
                    parts = split_subdivisions(v)
                    if len(parts) > 1 and normalize_heading(parts[0]) in keys:
                        after = " -- ".join([new_heading, *parts[1:]])
                if after is not None and after != v:
                    changes.append({"field": attr, "before": v, "after": after})
        if changes:
            plan.append({"biblio_id": b.id, "title": b.title, "changes": changes, "_biblio": b})
    return plan


def _apply_plan(plan: list[dict]) -> None:
    for entry in plan:
        b: Biblio = entry["_biblio"]
        for ch in entry["changes"]:
            if ch["field"] == "series":
                b.series = ch["after"]
            else:
                values = [ch["after"] if x == ch["before"] else x for x in getattr(b, ch["field"]) or []]
                setattr(b, ch["field"], _dedupe(values))
        b.updated_at = utcnow()


def _public_plan(plan: list[dict]) -> list[dict]:
    return [{k: v for k, v in e.items() if not k.startswith("_")} for e in plan]


def rename(db: Session, a: Authority, new_heading: str, *, keep_variant: bool = True, relink: bool = True) -> dict:
    """Change the authorised heading and rewrite it in every linked record (then re-index them)."""
    new_heading = clean_heading(new_heading)[:500]
    new_key = normalize_heading(new_heading)
    if not new_key:
        raise DomainError("A heading is required", code="validation_error")
    old_heading, old_key = a.heading, a.normalized
    if new_key != old_key:
        _check_collision(db, a.auth_type, new_key, new_heading, a.id)
    keys = {old_key, *(v.normalized for v in a.variants)}
    with suppressed_autolink(db):
        plan = _plan_rewrites(db, a, keys, new_heading)
        _apply_plan(plan)
        a.variants = [v for v in a.variants if v.normalized != new_key]
        kept = None
        if keep_variant and new_key != old_key and old_key not in {v.normalized for v in a.variants}:
            a.variants.append(AuthorityVariant(heading=old_heading, normalized=old_key))
            kept = old_heading
        a.heading, a.normalized = new_heading, new_key
        a.match_key = _match_key_for(a.auth_type, new_heading)
        a.updated_at = utcnow()
        db.flush()
        for e in plan:
            catalog.index_biblio(db, e["_biblio"])
    out = {"from": old_heading, "to": new_heading, "kept_variant": kept, "records": len(plan),
           "changes": _public_plan(plan)}
    if relink:
        out["relink"] = relink_for(db, [a], extra_biblio_ids=[e["biblio_id"] for e in plan])
    return out


def merge(db: Session, source: Authority, target: Authority, *, dry_run: bool = True) -> dict:
    """Merge ``source`` into ``target``: rewrite linked records, keep source forms as variants."""
    if source.id == target.id:
        raise DomainError("Choose two different authorities to merge", code="validation_error")
    if source.auth_type != target.auth_type:
        raise Conflict("Only authorities of the same type can be merged "
                       f"({TYPE_LABELS[source.auth_type.value]} vs {TYPE_LABELS[target.auth_type.value]})")
    keys = {source.normalized, *(v.normalized for v in source.variants)}
    plan = _plan_rewrites(db, source, keys, target.heading)
    target_keys = {target.normalized, *(v.normalized for v in target.variants)}
    new_variants = [(source.heading, source.normalized)] + [(v.heading, v.normalized) for v in source.variants]
    new_variants = [(h, k) for h, k in new_variants if k not in target_keys]
    usage = usage_counts(db, [source.id, target.id])
    result = {
        "source": authority_out(source, usage.get(source.id, 0)),
        "target": authority_out(target, usage.get(target.id, 0)),
        "records": len(plan), "changes": _public_plan(plan),
        "variants_added": [h for h, _ in new_variants], "dry_run": dry_run,
    }
    if dry_run:
        return result
    with suppressed_autolink(db):
        _apply_plan(plan)
        source_id = source.id
        source.variants = []
        source.deleted_at = utcnow()
        source.notes = ((source.notes or "") + f"\nMerged into authority #{target.id} ({target.heading})").strip()
        db.flush()
        seen = {target.normalized, *(v.normalized for v in target.variants)}
        for h, k in new_variants:
            if k not in seen:
                target.variants.append(AuthorityVariant(heading=h, normalized=k))
                seen.add(k)
        refs = {normalize_heading(r["heading"]) for r in target.see_also or []}
        merged_refs = list(target.see_also or [])
        for r in source.see_also or []:
            k = normalize_heading(r["heading"])
            if k not in refs and k not in seen and r.get("authority_id") != target.id:
                merged_refs.append(r)
                refs.add(k)
        target.see_also = merged_refs
        target.updated_at = utcnow()
        _repoint_references(db, source_id, target)
        db.execute(delete(BiblioAuthority).where(BiblioAuthority.authority_id == source_id))
        db.flush()
        for e in plan:
            catalog.index_biblio(db, e["_biblio"])
    result["relink"] = relink_for(db, [target], extra_biblio_ids=[e["biblio_id"] for e in plan])
    return result


def _repoint_references(db: Session, old_id: int, new: Authority | None) -> None:
    """See-also references pointing at ``old_id`` now point at ``new`` (or are unresolved)."""
    for other in db.scalars(select(Authority).where(Authority.deleted_at.is_(None))):
        refs = other.see_also or []
        if not any(r.get("authority_id") == old_id for r in refs):
            continue
        out = []
        for r in refs:
            if r.get("authority_id") == old_id:
                if new is not None and new.id != other.id:
                    r = {**r, "authority_id": new.id, "heading": new.heading}
                else:
                    r = {**r, "authority_id": None}
            out.append(r)
        other.see_also = out


def delete_authority(db: Session, a: Authority) -> None:
    n = usage_counts(db, [a.id]).get(a.id, 0)
    if n:
        raise Conflict(f"“{a.heading}” is used by {n} record(s). Merge it into another authority instead.",
                       code="authority_in_use", details={"usage": n})
    a.variants = []
    a.deleted_at = utcnow()
    db.execute(delete(BiblioAuthority).where(BiblioAuthority.authority_id == a.id))
    _repoint_references(db, a.id, None)
    db.flush()


# ------------------------------------------------------------------ queries


def usage_counts(db: Session, ids: Iterable[int]) -> dict[int, int]:
    ids = list(ids)
    if not ids:
        return {}
    rows = db.execute(
        select(BiblioAuthority.authority_id, func.count(func.distinct(BiblioAuthority.biblio_id)))
        .join(Biblio, Biblio.id == BiblioAuthority.biblio_id)
        .where(BiblioAuthority.authority_id.in_(ids), Biblio.deleted_at.is_(None))
        .group_by(BiblioAuthority.authority_id)
    ).all()
    return {a: n for a, n in rows}


def _usage_subquery():
    return (select(BiblioAuthority.authority_id.label("aid"),
                   func.count(func.distinct(BiblioAuthority.biblio_id)).label("n"))
            .join(Biblio, Biblio.id == BiblioAuthority.biblio_id)
            .where(Biblio.deleted_at.is_(None))
            .group_by(BiblioAuthority.authority_id).subquery())


def search(db: Session, q: str | None = None, *, auth_type: str | None = None, group: str | None = None,
           used: str | None = None, sort: str = "heading", page: int = 1, per_page: int = 25) -> dict:
    usage = _usage_subquery()
    n = func.coalesce(usage.c.n, 0)
    stmt = (select(Authority, n.label("usage")).outerjoin(usage, usage.c.aid == Authority.id)
            .where(Authority.deleted_at.is_(None)))
    if auth_type:
        stmt = stmt.where(Authority.auth_type == _parse_type(auth_type))
    if group in BROWSE_GROUPS:
        stmt = stmt.where(Authority.auth_type.in_(BROWSE_GROUPS[group]))
    if q and (key := normalize_heading(q)):
        like = f"%{key}%"
        stmt = stmt.where(or_(Authority.normalized.like(like), Authority.id.in_(
            select(AuthorityVariant.authority_id).where(AuthorityVariant.normalized.like(like)))))
    if used == "used":
        stmt = stmt.where(n > 0)
    elif used == "unused":
        stmt = stmt.where(n == 0)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    order = {"usage": (n.desc(), Authority.normalized), "updated": (Authority.updated_at.desc(),),
             "created": (Authority.created_at.desc(),)}.get(sort, (Authority.normalized,))
    rows = db.execute(stmt.order_by(*order).offset((page - 1) * per_page).limit(per_page)).all()
    return {"total": total, "page": page, "per_page": per_page,
            "results": [authority_out(a, u) for a, u in rows]}


def authority_out(a: Authority, usage: int | None = None, *, full: bool = False, db: Session | None = None) -> dict:
    out = {
        "id": a.id, "auth_type": a.auth_type.value, "type_label": TYPE_LABELS[a.auth_type.value],
        "heading": a.heading, "variants": [v.heading for v in a.variants], "source": a.source,
        "see_also": [{"heading": r.get("heading"), "relationship": r.get("relationship", "related"),
                      "authority_id": r.get("authority_id")} for r in (a.see_also or [])],
        "usage": usage, "updated_at": a.updated_at, "created_at": a.created_at,
    }
    if full:
        out.update(notes=a.notes, has_marc=bool(a.marc_xml), roles=list(roles_for_type(a.auth_type)))
        if db is not None:
            live = {i for i in db.scalars(select(Authority.id).where(
                Authority.id.in_([r["authority_id"] for r in out["see_also"] if r["authority_id"]]),
                Authority.deleted_at.is_(None)))} if out["see_also"] else set()
            for r in out["see_also"]:
                if r["authority_id"] not in live:
                    r["authority_id"] = _resolve_ref(db, a.auth_type, normalize_heading(r["heading"]))
    return out


def linked_records(db: Session, a: Authority, limit: int = 100) -> list[dict]:
    rows = db.execute(
        select(BiblioAuthority.role, BiblioAuthority.heading, Biblio.id, Biblio.title, Biblio.pub_year)
        .join(Biblio, Biblio.id == BiblioAuthority.biblio_id)
        .where(BiblioAuthority.authority_id == a.id, Biblio.deleted_at.is_(None))
        .order_by(Biblio.title).limit(limit)
    ).all()
    return [{"role": r, "heading": h, "biblio_id": i, "title": t, "pub_year": y} for r, h, i, t, y in rows]


def biblio_links(db: Session, biblio_id: int) -> list[dict]:
    rows = db.execute(
        select(BiblioAuthority.role, BiblioAuthority.heading, Authority.id, Authority.heading, Authority.auth_type)
        .join(Authority, Authority.id == BiblioAuthority.authority_id)
        .where(BiblioAuthority.biblio_id == biblio_id, Authority.deleted_at.is_(None))
    ).all()
    return [{"role": r, "heading": h, "authority_id": i, "authorised": ah, "auth_type": t.value}
            for r, h, i, ah, t in rows]


def _record_headings(b) -> Iterable[tuple[str, str]]:
    for a in b.authors or []:
        yield "author", a
    for s in b.subjects or []:
        yield "subject", s
    if b.series:
        yield "series", b.series


def unlinked_headings(db: Session, *, role: str | None = None, q: str | None = None, limit: int = 200) -> dict:
    """Headings in live records that resolve to no authority, most frequent first, with suggestions."""
    resolver = Resolver(db, preload=True)
    counts: Counter = Counter()
    forms: dict[tuple[str, str], Counter] = defaultdict(Counter)
    samples: dict[tuple[str, str], list[int]] = defaultdict(list)
    qk = normalize_heading(q) if q else ""
    rows = db.execute(select(Biblio.id, Biblio.authors, Biblio.subjects, Biblio.series)
                      .where(Biblio.deleted_at.is_(None))).all()
    for row in rows:
        for r, h in _record_headings(row):
            if role and r != role:
                continue
            if resolver.resolve(r, h):
                continue
            main = split_subdivisions(h)[0] if r == "subject" and split_subdivisions(h) else h
            k = normalize_heading(main)
            if not k or (qk and qk not in k):
                continue
            counts[(r, k)] += 1
            forms[(r, k)][main] += 1
            if len(samples[(r, k)]) < 5:
                samples[(r, k)].append(row.id)
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0][1]))[:limit]
    by_types: dict[tuple, dict[str, Authority]] = {}
    out = []
    for (r, k), n in top:
        heading = forms[(r, k)].most_common(1)[0][0]
        out.append({"role": r, "heading": heading, "count": n, "biblio_ids": samples[(r, k)],
                    "suggested_type": _guess_type(r, heading).value,
                    "suggestion": _suggest(resolver, ROLE_TYPES[r], k, by_types)})
    return {"total": len(counts), "results": out}


def _suggest(resolver: Resolver, types: tuple, key: str, cache: dict) -> dict | None:
    try:
        from rapidfuzz import fuzz, process
    except ImportError:  # pragma: no cover
        return None
    if types not in cache:
        cache[types] = {k: a for k, lst in resolver.by_key.items() for a in lst if a.auth_type in types}
    choices = cache[types]
    if not choices:
        return None
    best = process.extractOne(key, list(choices), scorer=fuzz.token_sort_ratio, score_cutoff=82)
    if not best:
        return None
    a = choices[best[0]]
    return {"authority_id": a.id, "heading": a.heading, "score": round(best[1])}


_CORPORATE = re.compile(r"\b(society|association|inc|ltd|llc|company|co|university|college|library|council|"
                        r"department|ministry|institute|organization|organisation|committee|press|museum|"
                        r"government|corporation|foundation|board|bank|agency|club|church)\b", re.I)


def _guess_type(role: str, heading: str) -> AuthorityType:
    if role == "series":
        return T.uniform_title
    if role == "author":
        return T.corporate_name if ("," not in heading and _CORPORATE.search(heading)) else T.personal_name
    if "(fictitious character)" in heading.lower() or re.search(r",\s*\d{3,4}-", heading):
        return T.personal_name
    return T.topical_subject


def generate_from_catalogue(db: Session, *, roles: Iterable[str] = ("author", "subject", "series"),
                            min_count: int = 1, dry_run: bool = False) -> dict:
    """One-off bootstrap: create local authorities for every unauthorised heading in use."""
    roles = [r for r in roles if r in ROLE_TYPES]
    resolver = Resolver(db, preload=True)
    found: dict[tuple[AuthorityType, str], Counter] = defaultdict(Counter)
    for row in db.execute(select(Biblio.authors, Biblio.subjects, Biblio.series).where(Biblio.deleted_at.is_(None))):
        for r, h in _record_headings(row):
            if r not in roles or resolver.resolve(r, h):
                continue
            main = clean_heading(split_subdivisions(h)[0] if r == "subject" and split_subdivisions(h) else h)
            k = normalize_heading(main)
            if k:
                found[(_guess_type(r, main), k)][main] += 1
    candidates = [(t, k, forms.most_common(1)[0][0], sum(forms.values()))
                  for (t, k), forms in found.items() if sum(forms.values()) >= min_count]
    # a name seen as both author and subject should become one authority
    seen_keys: set[str] = set()
    unique = []
    for t, k, h, n in sorted(candidates, key=lambda c: (c[0] not in NAME_TYPES, c[1])):
        if (t in NAME_TYPES and k in seen_keys):
            continue
        if t in NAME_TYPES:
            seen_keys.add(k)
        unique.append((t, k, h, n))
    by_type = Counter(t.value for t, *_ in unique)
    sample = [{"auth_type": t.value, "heading": h, "count": n} for t, _, h, n in sorted(unique, key=lambda c: -c[3])[:50]]
    if dry_run:
        return {"dry_run": True, "would_create": len(unique), "by_type": dict(by_type), "sample": sample}
    with suppressed_autolink(db):
        for t, k, h, _ in unique:
            db.add(Authority(auth_type=t, heading=h[:500], normalized=k, match_key=_match_key_for(t, h),
                             source="local", notes="Generated from catalogue headings", see_also=[]))
        db.flush()
    return {"dry_run": False, "created": len(unique), "by_type": dict(by_type), "sample": sample,
            "relink": relink_all(db)}


# ------------------------------------------------------------------ MARC21 authority import / export

TAG_TYPES = {"100": T.personal_name, "110": T.corporate_name, "111": T.meeting_name, "130": T.uniform_title,
             "150": T.topical_subject, "151": T.geographic, "155": T.genre_form}
TYPE_TAGS = {v: k for k, v in TAG_TYPES.items()}
_IND = {T.personal_name: ("1", " "), T.corporate_name: ("2", " "), T.meeting_name: ("2", " "),
        T.uniform_title: (" ", "0"), T.topical_subject: (" ", " "), T.geographic: (" ", " "), T.genre_form: (" ", " ")}
_W_REL = {"g": "broader", "h": "narrower", "a": "earlier", "b": "later"}
_REL_W = {v: k for k, v in _W_REL.items()}
_SOURCE_008 = {"a": "lcsh", "b": "lcshac", "c": "mesh", "d": "nal", "k": "cash", "r": "aat", "s": "sears", "v": "rvm"}
_008_SOURCE = {v: k for k, v in _SOURCE_008.items()}


def _field_heading(f: pymarc.Field) -> str:
    main, subdivisions = [], []
    for sf in f.subfields:
        value = (sf.value or "").strip()
        if not value or not sf.code.isalpha() or sf.code in "wie":
            continue
        if sf.code in "vxyz":
            subdivisions.append(clean_heading(value))
        else:
            main.append(value)
    head = clean_heading(" ".join(main))
    return " -- ".join([h for h in [head, *subdivisions] if h])


def _record_source(rec: pymarc.Record) -> str:
    for f in rec.get_fields("010"):
        lccn = (f.get_subfields("a") or [""])[0].strip()
        if lccn.startswith("sh"):
            return "lcsh"
        if lccn.startswith("n"):
            return "lcnaf"
    f008 = rec.get("008")
    if f008 is not None and len(f008.data or "") > 11 and f008.data[11] in _SOURCE_008:
        return _SOURCE_008[f008.data[11]]
    for f in rec.get_fields("040"):
        if f.get_subfields("f"):
            return f.get_subfields("f")[0].strip()[:32]
    return "local"


def parse_authority_record(rec: pymarc.Record) -> dict | None:
    head_field = next((f for t in TAG_TYPES for f in rec.get_fields(t)), None)
    if head_field is None:
        return None
    auth_type = TAG_TYPES[head_field.tag]
    heading = _field_heading(head_field)
    variants = [_field_heading(f) for t in ("400", "410", "411", "430", "450", "451", "455") for f in rec.get_fields(t)]
    see_also = []
    for t in ("500", "510", "511", "530", "550", "551", "555"):
        for f in rec.get_fields(t):
            w = (f.get_subfields("w") or [""])[0]
            see_also.append({"heading": _field_heading(f), "relationship": _W_REL.get(w[:1], "related")})
    notes = []
    for t, codes in (("667", "a"), ("670", "ab"), ("680", "ia"), ("678", "a")):
        for f in rec.get_fields(t):
            text = " ".join(v.strip() for c in codes for v in f.get_subfields(c))
            if text:
                notes.append(text)
    return {"auth_type": auth_type.value, "heading": heading, "variants": [v for v in variants if v],
            "see_also": [s for s in see_also if s["heading"]], "source": _record_source(rec),
            "notes": "\n".join(notes) or None, "marc_xml": pymarc.record_to_xml(rec).decode("utf-8")}


def import_marc(db: Session, data: bytes) -> dict:
    stats = {"records": 0, "created": 0, "updated": 0, "skipped": 0, "errors": [], "warnings": []}
    if data.lstrip()[:1] == b"<":
        records = pymarc.parse_xml_to_array(io.BytesIO(data))
    else:
        records = list(pymarc.MARCReader(io.BytesIO(data), to_unicode=True, force_utf8=True, utf8_handling="replace"))
    with suppressed_autolink(db):
        for rec in records:
            stats["records"] += 1
            if rec is None:
                stats["errors"].append(f"Record {stats['records']}: unreadable")
                continue
            try:
                parsed = parse_authority_record(rec)
                if parsed is None or not normalize_heading(parsed["heading"]):
                    stats["skipped"] += 1
                    stats["warnings"].append(f"Record {stats['records']}: no 1XX heading (100/110/111/130/150/151/155)")
                    continue
                t = AuthorityType(parsed["auth_type"])
                key = normalize_heading(parsed["heading"])
                existing = db.scalar(select(Authority).where(Authority.auth_type == t, Authority.normalized == key,
                                                             Authority.deleted_at.is_(None)))
                if existing is None:
                    variants = []
                    for v in parsed["variants"]:
                        try:
                            _check_collision(db, t, normalize_heading(v), v, None)
                            variants.append(v)
                        except Conflict as exc:
                            stats["warnings"].append(f"Record {stats['records']}: {exc.message}; variant skipped")
                    create_authority(db, {**parsed, "variants": variants})
                    stats["created"] += 1
                else:
                    have = {v.normalized for v in existing.variants} | {existing.normalized}
                    for v in parsed["variants"]:
                        k = normalize_heading(v)
                        if k and k not in have:
                            try:
                                _check_collision(db, t, k, v, existing.id)
                            except Conflict as exc:
                                stats["warnings"].append(f"Record {stats['records']}: {exc.message}; variant skipped")
                                continue
                            existing.variants.append(AuthorityVariant(heading=clean_heading(v)[:500], normalized=k))
                            have.add(k)
                    refs = {normalize_heading(r["heading"]) for r in existing.see_also or []}
                    extra = [r for r in parsed["see_also"] if normalize_heading(r["heading"]) not in refs]
                    if extra:
                        existing.see_also = list(existing.see_also or []) + _clean_see_also(db, t, extra, key)
                    existing.marc_xml = existing.marc_xml or parsed["marc_xml"]
                    if existing.source == "local" and parsed["source"] != "local":
                        existing.source = parsed["source"]
                    existing.updated_at = utcnow()
                    stats["updated"] += 1
                db.flush()
            except Exception as exc:  # keep going; report per-record problems
                stats["errors"].append(f"Record {stats['records']}: {getattr(exc, 'message', exc)}")
    stats["relink"] = relink_all(db)
    return stats


def _heading_subfields(auth_type: AuthorityType, heading: str) -> list[pymarc.Subfield]:
    S = pymarc.Subfield
    parts = split_subdivisions(heading) or [heading]
    main, rest = parts[0], parts[1:]
    subs: list[pymarc.Subfield] = []
    m = re.match(r"^(.*?),\s*((?:b\.\s*|d\.\s*|ca\.\s*)?\d{3,4}\??-?(?:\d{3,4}\??)?)$", main)
    if auth_type == T.personal_name and m:
        subs += [S("a", m.group(1) + ","), S("d", m.group(2))]
    else:
        subs.append(S("a", main))
    subs += [S("x", p) for p in rest]
    return subs


def authority_to_record(a: Authority) -> pymarc.Record:
    S = pymarc.Subfield
    r = pymarc.Record(force_utf8=True, leader="00000nz  a2200000n  4500")
    tag = TYPE_TAGS[a.auth_type]
    ind = _IND[a.auth_type]
    names_or_titles = a.auth_type in NAME_TYPES or a.auth_type == T.uniform_title
    src = _008_SOURCE.get(a.source, "n" if names_or_titles else "z")
    f008 = ((a.created_at or utcnow()).strftime("%y%m%d") + "nn|az" + src + "nn"
            + ("a" if names_or_titles else "b") + "a" + ("a" if a.auth_type == T.uniform_title else "b") + "n"
            + " " * 10 + " a a" + ("a" if a.auth_type == T.personal_name else "n") + "a" + " " * 4 + " d")
    r.add_field(pymarc.Field(tag="001", data=str(a.id)))
    r.add_field(pymarc.Field(tag="005", data=(a.updated_at or utcnow()).strftime("%Y%m%d%H%M%S.0")))
    r.add_field(pymarc.Field(tag="008", data=f008))
    f040 = [S("a", "Librowise"), S("b", "eng"), S("c", "Librowise")]
    if src == "z" and a.source:
        f040.append(S("f", a.source))
    r.add_field(pymarc.Field(tag="040", indicators=[" ", " "], subfields=f040))
    r.add_field(pymarc.Field(tag=tag, indicators=list(ind), subfields=_heading_subfields(a.auth_type, a.heading)))
    for v in a.variants:
        r.add_field(pymarc.Field(tag=str(int(tag) + 300), indicators=list(ind),
                                 subfields=_heading_subfields(a.auth_type, v.heading)))
    for ref in a.see_also or []:
        subs = []
        if ref.get("relationship") in _REL_W:
            subs.append(S("w", _REL_W[ref["relationship"]]))
        subs += _heading_subfields(a.auth_type, ref["heading"])
        r.add_field(pymarc.Field(tag=str(int(tag) + 400), indicators=list(ind), subfields=subs))
    if a.notes:
        for line in a.notes.splitlines():
            if line.strip():
                r.add_field(pymarc.Field(tag="667", indicators=[" ", " "], subfields=[S("a", line.strip())]))
    return r


def export(authorities: Iterable[Authority], fmt: str = "xml") -> bytes:
    records = [authority_to_record(a) for a in authorities]
    if fmt == "mrc":
        return b"".join(r.as_marc() for r in records)
    out = io.BytesIO()
    writer = pymarc.XMLWriter(out)
    for r in records:
        writer.write(r)
    writer.close(close_fh=False)
    return out.getvalue()


# ------------------------------------------------------------------ OPAC browse


def browse(db: Session, group: str = "authors", start: str = "", *, after: str | None = None,
           before: str | None = None, limit: int = 30, used_only: bool = True) -> dict:
    """Alphabetical heading index with see (variant) and see-also references and record counts.

    ``start`` jumps to the first heading at or after a text; ``after``/``before`` are the opaque
    cursors returned as ``next``/``prev`` for paging forwards/backwards.
    """
    types = BROWSE_GROUPS.get(group)
    if types is None:
        raise DomainError("Unknown browse index", code="validation_error")
    usage = _usage_subquery()
    n = func.coalesce(usage.c.n, 0)
    fwd = before is None
    h_stmt = (select(Authority, n.label("usage")).outerjoin(usage, usage.c.aid == Authority.id)
              .where(Authority.deleted_at.is_(None), Authority.auth_type.in_(types)))
    v_stmt = (select(AuthorityVariant, Authority, n.label("usage"))
              .join(Authority, Authority.id == AuthorityVariant.authority_id)
              .outerjoin(usage, usage.c.aid == Authority.id)
              .where(Authority.deleted_at.is_(None), Authority.auth_type.in_(types)))
    if used_only:
        h_stmt, v_stmt = h_stmt.where(n > 0), v_stmt.where(n > 0)

    def bound(col):
        if before is not None:
            return col < before
        if after is not None:
            return col > after
        return col >= normalize_heading(start)

    order = (lambda c: c) if fwd else (lambda c: c.desc())
    h_stmt = h_stmt.where(bound(Authority.normalized)).order_by(order(Authority.normalized))
    v_stmt = v_stmt.where(bound(AuthorityVariant.normalized)).order_by(order(AuthorityVariant.normalized))
    entries = []
    for a, u in db.execute(h_stmt.limit(limit + 1)).all():
        entries.append((a.normalized, 0, {"kind": "heading", "id": a.id, "heading": a.heading,
                                           "auth_type": a.auth_type.value, "count": u, "_a": a}))
    for v, a, u in db.execute(v_stmt.limit(limit + 1)).all():
        entries.append((v.normalized, 1, {"kind": "see", "heading": v.heading,
                                           "see": {"id": a.id, "heading": a.heading, "count": u}}))
    entries.sort(key=lambda e: (e[0], e[1]), reverse=not fwd)
    more = len(entries) > limit
    entries = entries[:limit]
    if not fwd:
        entries.reverse()
    keys = [k for k, _, _ in entries]
    refs = [r for _, _, e in entries if e["kind"] == "heading" for r in (e["_a"].see_also or [])]
    # see-also targets are resolved at read time: the target may have been created (or merged) later
    ref_keys = {normalize_heading(r["heading"]) for r in refs}
    by_key: dict[str, int] = {}
    stored = {r["authority_id"] for r in refs if r.get("authority_id")}
    live_ids = set(db.scalars(select(Authority.id).where(Authority.id.in_(stored), Authority.deleted_at.is_(None)))) \
        if stored else set()
    if ref_keys:
        for aid, k, _t in db.execute(select(AuthorityVariant.authority_id, AuthorityVariant.normalized, Authority.auth_type)
                                     .join(Authority).where(AuthorityVariant.normalized.in_(ref_keys),
                                                            Authority.deleted_at.is_(None))).all():
            by_key.setdefault(k, aid)
        for aid, k, t in db.execute(select(Authority.id, Authority.normalized, Authority.auth_type).where(
                Authority.normalized.in_(ref_keys), Authority.deleted_at.is_(None))).all():
            if k not in by_key or t in types:
                by_key[k] = aid
    counts = usage_counts(db, {*by_key.values(), *live_ids})
    shown = {e["id"] for _, _, e in entries if e["kind"] == "heading"} | {e["see"]["id"] for _, _, e in entries
                                                                         if e["kind"] == "see"}
    roles: dict[int, set[str]] = defaultdict(set)
    if shown:
        for aid, role in db.execute(select(BiblioAuthority.authority_id, BiblioAuthority.role).distinct()
                                    .where(BiblioAuthority.authority_id.in_(shown))).all():
            roles[aid].add(role)
    for _, _, e in entries:
        target = e if e["kind"] == "heading" else e["see"]
        target["roles"] = sorted(roles.get(target["id"], ()))
    out = []
    for _, _, e in entries:
        if e["kind"] == "heading":
            a = e.pop("_a")
            e["see_also"] = []
            for r in a.see_also or []:
                rid = r.get("authority_id") if r.get("authority_id") in live_ids else by_key.get(normalize_heading(r["heading"]))
                e["see_also"].append({"heading": r["heading"], "relationship": r.get("relationship", "related"),
                                      "id": rid, "count": counts.get(rid, 0)})
        out.append(e)
    exact = None
    key = normalize_heading(start)
    if key and after is None and before is None:
        hit = db.scalars(select(Authority).where(Authority.deleted_at.is_(None), Authority.auth_type.in_(types),
                                                 Authority.normalized == key)).first()
        if hit:
            exact = {"kind": "heading", "id": hit.id, "heading": hit.heading}
        else:
            v = db.execute(select(AuthorityVariant, Authority).join(Authority).where(
                Authority.deleted_at.is_(None), Authority.auth_type.in_(types),
                AuthorityVariant.normalized == key)).first()
            if v:
                exact = {"kind": "see", "heading": v[0].heading, "see": {"id": v[1].id, "heading": v[1].heading}}
    has_next = bool(keys) and (more if fwd else True)
    has_prev = bool(keys) and (more if not fwd else bool(after is not None or key))
    return {"group": group, "start": start, "entries": out, "exact": exact,
            "next": keys[-1] if has_next else None, "prev": keys[0] if has_prev else None}


def browse_entry(db: Session, authority_id: int) -> dict:
    a = get_authority(db, authority_id)
    out = authority_out(a, usage_counts(db, [a.id]).get(a.id, 0), full=True, db=db)
    out.pop("notes", None)
    out.pop("has_marc", None)
    return out
