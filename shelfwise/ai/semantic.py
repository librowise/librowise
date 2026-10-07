"""Local semantic index: sparse TF-IDF with concept expansion, served from an inverted index.

Scales to large catalogues: scoring only touches the postings of query terms (no dense N x V
matrix), postings are packed into typed arrays (~8 bytes each), catalogue changes are applied
incrementally, big builds run in a background thread and the built index is persisted as an
HMAC-signed snapshot that every web/worker process can load instead of rebuilding.
"""

from __future__ import annotations

import bisect
import functools
import hashlib
import heapq
import hmac
import logging
import math
import os
import pickle
import re
import threading
import time
from array import array
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Biblio

log = logging.getLogger("shelfwise.semantic")

STOPWORDS = frozenset(
    """a an and are as at be but by for from has have i in into is it its me my of on or our show
    so some something that the their them then there these they this to was were what when where
    which who will with you your find get looking look want need book books novel novels title
    titles read reading about any like give please recommend recommendations good great best""".split()
)

# Lightweight concept graph used to bridge vocabulary gaps ("space" ~ "astronomy").
CONCEPTS: dict[str, list[str]] = {
    "space": ["astronomy", "cosmos", "planets", "universe", "astronaut", "stars", "galaxy"],
    "astronomy": ["space", "cosmos", "planets", "stars", "universe"],
    "kids": ["children", "juvenile", "picture"],
    "children": ["kids", "juvenile", "childhood"],
    "teen": ["young", "adolescent", "coming"],
    "detective": ["mystery", "crime", "investigation", "murder", "sleuth"],
    "mystery": ["detective", "crime", "suspense", "whodunit"],
    "crime": ["detective", "mystery", "murder", "criminal"],
    "romance": ["love", "courtship", "marriage", "relationships"],
    "love": ["romance", "courtship", "relationships"],
    "ai": ["artificial", "intelligence", "machine", "learning", "robots", "computing"],
    "robot": ["robots", "artificial", "intelligence", "automation", "androids"],
    "computer": ["computing", "programming", "software", "algorithms"],
    "programming": ["software", "code", "computer", "algorithms", "python"],
    "war": ["military", "battle", "conflict", "soldiers"],
    "history": ["historical", "past", "civilization", "ancient"],
    "scary": ["horror", "ghost", "supernatural", "gothic"],
    "horror": ["scary", "ghost", "supernatural", "gothic", "vampires"],
    "fantasy": ["magic", "dragons", "wizards", "myth", "quest"],
    "magic": ["fantasy", "wizards", "sorcery", "enchantment"],
    "scifi": ["science", "fiction", "future", "dystopia", "space"],
    "future": ["dystopia", "science", "fiction", "utopia"],
    "money": ["economics", "finance", "wealth", "investing"],
    "economics": ["money", "markets", "finance", "trade"],
    "health": ["medicine", "wellness", "fitness", "nutrition"],
    "cooking": ["recipes", "food", "cuisine", "baking"],
    "food": ["cooking", "recipes", "cuisine", "nutrition"],
    "sea": ["ocean", "sailing", "voyage", "whaling", "maritime", "ships"],
    "ocean": ["sea", "marine", "sailing", "voyage"],
    "adventure": ["quest", "journey", "voyage", "exploration", "expedition"],
    "india": ["indian", "hindu", "bengal", "delhi", "mughal"],
    "philosophy": ["ethics", "metaphysics", "logic", "stoicism"],
    "mind": ["psychology", "brain", "consciousness", "cognition"],
    "psychology": ["mind", "behavior", "cognition", "mental"],
    "nature": ["environment", "wildlife", "ecology", "animals"],
    "climate": ["environment", "ecology", "warming", "sustainability"],
    "funny": ["humor", "humorous", "comedy", "satire", "comic", "witty"],
    "humor": ["funny", "humorous", "comedy", "satire", "witty"],
    "poems": ["poetry", "verse", "poets"],
    "poetry": ["poems", "verse", "poets"],
    "biography": ["memoir", "life", "autobiography"],
    "memoir": ["biography", "autobiography", "life"],
    "math": ["mathematics", "algebra", "geometry", "calculus"],
    "physics": ["quantum", "relativity", "mechanics", "energy"],
    "evolution": ["darwin", "natural", "selection", "species", "biology"],
}

_word = re.compile(r"[a-z0-9]+")


@functools.lru_cache(maxsize=1 << 18)  # vocabularies are small; tokenising is the build hot spot
def stem(token: str) -> str:
    for suffix in ("ies", "ing", "ed", "es", "s"):
        if token.endswith(suffix) and len(token) - len(suffix) >= 3:
            if suffix == "ies":
                return token[:-3] + "y"
            if suffix == "es" and not token.endswith(("ses", "xes", "zes", "ches", "shes")):
                return token[:-1]
            return token[: -len(suffix)]
    return token


def tokenize(text: str) -> list[str]:
    return [stem(t) for t in _word.findall(text.lower()) if t not in STOPWORDS and len(t) > 1]


_STEMMED_CONCEPTS: dict[str, tuple[str, ...]] = {
    stem(k): tuple(dict.fromkeys(stem(r) for r in v)) for k, v in CONCEPTS.items()
}


def expand(tokens: list[str]) -> Counter:
    """Query vector with concept expansion (expanded terms get a reduced weight)."""
    vec: Counter = Counter()
    for t in tokens:
        vec[t] += 1.0
    for t in list(vec):
        for related in _STEMMED_CONCEPTS.get(t, ()):
            if related not in vec:
                vec[related] += 0.35
    return vec


def biblio_text(b: Biblio) -> list[tuple[str, float]]:
    """Weighted fields used for indexing."""
    return [
        (" ".join(filter(None, [b.title, b.subtitle])), 3.0),
        (" ".join(b.authors or []), 2.0),
        (" ".join(b.subjects or []), 2.5),
        (b.series or "", 1.0),
        (b.description or "", 1.0),
    ]


def _doc_tf(title, subtitle, authors, subjects, series, description) -> Counter:
    tf: Counter = Counter()
    for text, weight in (
        (" ".join(filter(None, [title, subtitle])), 3.0),
        (" ".join(authors or []) if isinstance(authors, list) else "", 2.0),
        (" ".join(subjects or []) if isinstance(subjects, list) else "", 2.5),
        (series or "", 1.0),
        (description or "", 1.0),
    ):
        for tok in tokenize(text):
            tf[tok] += weight
    return tf


#: Max postings read per query term. Shorter lists are read completely (exact scores); for very
#: common terms only the highest-weighted documents contribute — standard impact-ordered top-k.
POSTING_BUDGET = 4000

_ROW_COLUMNS = (Biblio.id, Biblio.title, Biblio.subtitle, Biblio.authors, Biblio.subjects, Biblio.series,
                Biblio.description)


@dataclass
class _Base:
    """Immutable, compact inverted index: per term an ``array('i')`` of doc ids and an
    ``array('f')`` of L2-normalised TF-IDF weights (≈8 bytes per posting)."""

    db_key: str
    doc_ids: array  # sorted ids of indexed documents
    postings: dict[str, tuple[array, array]]
    idf: dict[str, float]
    n_docs: int
    max_updated: datetime | None
    built_at: float
    build_seconds: float = 0.0


@dataclass
class _View:
    """What queries read: the base index plus an overlay of records changed since it was built."""

    base: _Base
    tomb: frozenset[int] = frozenset()  # base docs superseded by the overlay (or deleted)
    overlay: dict[int, dict[str, float]] = field(default_factory=dict)
    overlay_postings: dict[str, list[tuple[int, float]]] = field(default_factory=dict)
    live: int = 0  # live documents represented by this view
    synced_max: datetime | None = None
    signature: tuple | None = None

    def idf(self, term: str) -> float:
        v = self.base.idf.get(term)
        return v if v is not None else math.log((1 + self.base.n_docs) / 2) + 1.0

    def has(self, term: str) -> bool:
        return term in self.base.postings or term in self.overlay_postings

    @property
    def n_docs(self) -> int:  # backwards compatibility with the old index object
        return self.live


def _weights(tf: Counter, idf) -> dict[str, float]:
    weights = {t: (1 + math.log(c)) * idf(t) for t, c in tf.items()}
    norm = math.sqrt(sum(w * w for w in weights.values())) or 1.0
    return {t: w / norm for t, w in weights.items()}


def build_base(db: Session, db_key: str) -> _Base:
    """Two streaming passes over the live catalogue with compact intermediate storage."""
    started = time.perf_counter()
    term_ids: dict[str, int] = {}
    df: list[int] = []
    docs: list[tuple[int, array, array]] = []
    max_updated = db.scalar(select(func.max(Biblio.updated_at)))
    stmt = select(*_ROW_COLUMNS).where(Biblio.deleted_at.is_(None)).execution_options(yield_per=2000)
    for row in db.execute(stmt):
        tf = _doc_tf(*row[1:])
        ids, counts = array("i"), array("f")
        for t, c in tf.items():
            tid = term_ids.get(t)
            if tid is None:
                tid = term_ids[t] = len(df)
                df.append(0)
            df[tid] += 1
            ids.append(tid)
            counts.append(c)
        docs.append((row[0], ids, counts))
    n = max(len(docs), 1)
    idf_by_id = [math.log((1 + n) / (1 + d)) + 1.0 for d in df]
    p_ids: list[array] = [array("i") for _ in df]
    p_w: list[array] = [array("f") for _ in df]
    for doc_id, ids, counts in docs:
        ws = [(1 + math.log(c)) * idf_by_id[t] for t, c in zip(ids, counts, strict=True)]
        norm = math.sqrt(sum(w * w for w in ws)) or 1.0
        for t, w in zip(ids, ws, strict=True):
            p_ids[t].append(doc_id)
            p_w[t].append(w / norm)
    # Impact ordering: long posting lists are stored highest weight first so queries can stop
    # after the strongest POSTING_BUDGET entries of a very common term (bounded query cost).
    for t, ids_arr in enumerate(p_ids):
        if len(ids_arr) > POSTING_BUDGET:
            ws_arr = p_w[t]
            order = sorted(range(len(ids_arr)), key=ws_arr.__getitem__, reverse=True)
            p_ids[t] = array("i", (ids_arr[k] for k in order))
            p_w[t] = array("f", (ws_arr[k] for k in order))
    terms = list(term_ids)
    doc_ids = array("i", sorted(d[0] for d in docs))
    return _Base(db_key=db_key, doc_ids=doc_ids, postings={t: (p_ids[i], p_w[i]) for i, t in enumerate(terms)},
                 idf={t: idf_by_id[i] for i, t in enumerate(terms)}, n_docs=len(docs), max_updated=max_updated,
                 built_at=time.time(), build_seconds=round(time.perf_counter() - started, 2))


# ------------------------------------------------------------------ snapshot persistence

_SNAPSHOT_VERSION = 2


def _snapshot_path(db_key: str) -> Path:
    from ..config import get_settings

    digest = hashlib.sha256(db_key.encode()).hexdigest()[:16]
    return Path(get_settings().cache_dir) / f"semantic-{digest}.idx"


def _hmac_key() -> bytes:
    from ..config import get_settings

    return hashlib.sha256(("semantic-index:" + get_settings().secret_key).encode()).digest()


def save_snapshot(base: _Base) -> Path:
    """Persist the index (HMAC-signed) so other processes can load it instead of rebuilding."""
    path = _snapshot_path(base.db_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    terms = list(base.postings)
    payload = pickle.dumps({
        "version": _SNAPSHOT_VERSION, "db_key": base.db_key, "n_docs": base.n_docs,
        "doc_ids": base.doc_ids.tobytes(),
        "max_updated": base.max_updated, "built_at": base.built_at, "build_seconds": base.build_seconds,
        "terms": terms, "idf": array("f", (base.idf[t] for t in terms)).tobytes(),
        "ids": [base.postings[t][0].tobytes() for t in terms],
        "ws": [base.postings[t][1].tobytes() for t in terms],
    }, protocol=pickle.HIGHEST_PROTOCOL)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_bytes(hmac.new(_hmac_key(), payload, hashlib.sha256).digest() + payload)
    os.replace(tmp, path)
    return path


def load_snapshot(db_key: str) -> _Base | None:
    path = _snapshot_path(db_key)
    try:
        blob = path.read_bytes()
    except OSError:
        return None
    sig, payload = blob[:32], blob[32:]
    if not hmac.compare_digest(sig, hmac.new(_hmac_key(), payload, hashlib.sha256).digest()):
        log.warning("ignoring semantic index snapshot %s: bad signature", path)
        return None
    data = pickle.loads(payload)  # noqa: S301 - authenticated by the HMAC above
    if data.get("version") != _SNAPSHOT_VERSION or data.get("db_key") != db_key:
        return None
    idf_arr, doc_ids = array("f"), array("i")
    idf_arr.frombytes(data["idf"])
    doc_ids.frombytes(data["doc_ids"])
    postings = {}
    for t, ib, wb in zip(data["terms"], data["ids"], data["ws"], strict=True):
        ids, ws = array("i"), array("f")
        ids.frombytes(ib)
        ws.frombytes(wb)
        postings[t] = (ids, ws)
    return _Base(db_key=db_key, doc_ids=doc_ids, postings=postings, idf=dict(zip(data["terms"], idf_arr, strict=True)),
                 n_docs=data["n_docs"], max_updated=data["max_updated"], built_at=data["built_at"],
                 build_seconds=data.get("build_seconds", 0.0))


# ------------------------------------------------------------------ the index


class SemanticIndex:
    """Process-wide semantic index.

    * Small catalogues build synchronously on first use (milliseconds).
    * Large catalogues (> ``semantic_sync_build_limit`` records) load a persisted snapshot or
      build in a background thread; until then semantic results are empty and callers fall back
      to keyword ranking, so requests are never blocked by a long build.
    * Changes are applied incrementally: records updated since the last sync are re-scored into
      an overlay (and their stale postings masked). A full rebuild happens only when the overlay
      grows large or the catalogue no longer matches (hard deletes, a restored database).
    """

    OVERLAY_REBUILD_FRACTION = 0.1
    OVERLAY_REBUILD_MIN = 2000

    def __init__(self) -> None:
        self._view: _View | None = None
        self._lock = threading.Lock()
        self._building = False
        self._checked_at = 0.0
        self.last_error: str | None = None

    # ---------------------------------------------------------- state
    @staticmethod
    def _db_key(db: Session) -> str:
        return db.get_bind().url.render_as_string(hide_password=True)

    @staticmethod
    def _signature(db: Session) -> tuple:
        # Two O(1) index lookups (a combined count+max would scan the table). Soft deletes bump
        # updated_at; hard deletes/database swaps are caught by the live-count check in _sync.
        return (db.scalar(select(func.max(Biblio.id))), db.scalar(select(func.max(Biblio.updated_at))))

    @staticmethod
    def _ttl() -> float:
        from ..config import get_settings

        return 0.0 if get_settings().environment == "test" else 2.0

    def invalidate(self, hard: bool = False) -> None:
        """Force a change check on next use (``hard`` drops the index entirely)."""
        with self._lock:
            self._checked_at = 0.0
            if hard:
                self._view = None
            elif self._view is not None:
                self._view = replace(self._view, signature=None)

    def status(self) -> dict:
        v = self._view
        if v is None:
            return {"ready": False, "building": self._building, "error": self.last_error}
        return {"ready": True, "building": self._building, "docs": v.live, "terms": len(v.base.postings),
                "overlay": len(v.overlay), "built_at": v.base.built_at, "build_seconds": v.base.build_seconds,
                "error": self.last_error}

    def get(self, db: Session) -> _View | None:
        """The current view, synchronised with the catalogue (None while a first build runs)."""
        key = self._db_key(db)
        view = self._view
        if view is not None and view.base.db_key == key and view.signature is not None \
                and time.monotonic() - self._checked_at < self._ttl():
            return view
        sig = self._signature(db)
        self._checked_at = time.monotonic()
        if view is not None and view.base.db_key == key and view.signature == sig:
            return view
        with self._lock:
            view = self._view
            if view is None or view.base.db_key != key:
                view = self._initial_view(db, key)
                if view is None:
                    return None
            if view.signature != sig:
                view = self._sync(db, view, sig)
            self._view = view
            return view

    def _initial_view(self, db: Session, key: str) -> _View | None:
        from ..config import get_settings

        base = load_snapshot(key)
        if base is None:
            live = db.scalar(select(func.count()).select_from(Biblio).where(Biblio.deleted_at.is_(None))) or 0
            if live > get_settings().semantic_sync_build_limit:
                self._start_background_build()
                return None
            base = build_base(db, key)
        return _View(base=base, live=base.n_docs, synced_max=base.max_updated)

    def _sync(self, db: Session, view: _View, sig: tuple) -> _View:
        stmt = select(*_ROW_COLUMNS, Biblio.deleted_at).order_by(Biblio.updated_at)
        if view.synced_max is not None:
            stmt = stmt.where(Biblio.updated_at >= view.synced_max)
        limit = max(self.OVERLAY_REBUILD_MIN, int(view.base.n_docs * self.OVERLAY_REBUILD_FRACTION))
        rows = db.execute(stmt.limit(limit + 1)).all()
        live_now = db.scalar(select(func.count()).select_from(Biblio).where(Biblio.deleted_at.is_(None))) or 0
        if len(rows) + len(view.overlay) > limit:
            return self._rebuild(db, view, sig, live_now)
        tomb = set(view.tomb)
        overlay = dict(view.overlay)
        live = view.live
        for row in rows:
            doc_id, deleted = row[0], row[-1] is not None
            was_live = doc_id in overlay or (doc_id not in tomb and self._in_base(view.base, doc_id))
            tomb.add(doc_id)
            overlay.pop(doc_id, None)
            if not deleted:
                overlay[doc_id] = _weights(_doc_tf(*row[1:-1]), view.idf)
            live += (0 if deleted else 1) - (1 if was_live else 0)
        if live != live_now:  # hard deletes or a different database behind the same URL
            return self._rebuild(db, view, sig, live_now)
        postings: dict[str, list[tuple[int, float]]] = defaultdict(list)
        for doc_id, weights in overlay.items():
            for t, w in weights.items():
                postings[t].append((doc_id, w))
        synced_max = sig[1] if sig[1] is not None else view.synced_max
        return _View(base=view.base, tomb=frozenset(tomb), overlay=overlay, overlay_postings=dict(postings),
                     live=live, synced_max=synced_max, signature=sig)

    def _rebuild(self, db: Session, view: _View, sig: tuple, live_now: int) -> _View:
        from ..config import get_settings

        if live_now > get_settings().semantic_sync_build_limit:
            self._start_background_build()
            return replace(view, signature=sig)  # keep serving the previous index meanwhile
        base = build_base(db, view.base.db_key)
        return _View(base=base, live=base.n_docs, synced_max=base.max_updated, signature=sig)

    @staticmethod
    def _in_base(base: _Base, doc_id: int) -> bool:
        i = bisect.bisect_left(base.doc_ids, doc_id)
        return i < len(base.doc_ids) and base.doc_ids[i] == doc_id

    def _start_background_build(self) -> None:
        if self._building:
            return
        self._building = True
        threading.Thread(target=self._background_build, name="semantic-index-build", daemon=True).start()

    def _background_build(self) -> None:
        from ..db import SessionLocal

        db = SessionLocal()
        try:
            key = self._db_key(db)
            base = build_base(db, key)
            try:
                save_snapshot(base)
            except OSError as exc:  # pragma: no cover - read-only cache directory
                log.warning("could not persist semantic index snapshot: %s", exc)
            with self._lock:
                self._view = _View(base=base, live=base.n_docs, synced_max=base.max_updated)
                self._checked_at = 0.0
            self.last_error = None
            log.info("semantic index built in background: %s docs in %.1fs", base.n_docs, base.build_seconds)
        except Exception as exc:  # pragma: no cover - logged and surfaced in status()
            self.last_error = f"{type(exc).__name__}: {exc}"
            log.exception("semantic index build failed")
        finally:
            self._building = False
            db.close()

    def prefetch(self) -> None:
        """Warm the index in the background at start-up (loads a snapshot if one exists)."""

        def run():
            from ..db import SessionLocal

            db = SessionLocal()
            try:
                self.get(db)
            except Exception:  # pragma: no cover
                log.exception("semantic index prefetch failed")
            finally:
                db.close()

        threading.Thread(target=run, name="semantic-index-prefetch", daemon=True).start()

    def warm(self, db: Session) -> dict:
        """Build synchronously, persist a snapshot for other processes and install it (job handler)."""
        key = self._db_key(db)
        base = build_base(db, key)
        path = save_snapshot(base)
        with self._lock:
            self._view = _View(base=base, live=base.n_docs, synced_max=base.max_updated)
            self._checked_at = 0.0
        self.get(db)  # apply anything that changed while building
        return {"docs": base.n_docs, "terms": len(base.postings), "seconds": base.build_seconds,
                "snapshot": str(path), "snapshot_bytes": path.stat().st_size}

    # ---------------------------------------------------------- queries

    def _score(self, view: _View, qvec: Counter, exclude: set[int] | None = None) -> dict[int, float]:
        weights = {t: w * view.idf(t) for t, w in qvec.items() if view.has(t)}
        norm = math.sqrt(sum(w * w for w in weights.values())) or 1.0
        scores: dict[int, float] = defaultdict(float)
        tomb = view.tomb
        for t, w in weights.items():
            qw = w / norm
            posting = view.base.postings.get(t)
            if posting is not None:
                ids, ws = posting
                if len(ids) > POSTING_BUDGET:
                    ids, ws = ids[:POSTING_BUDGET], ws[:POSTING_BUDGET]
                if tomb:
                    for doc_id, dw in zip(ids, ws, strict=True):
                        if doc_id not in tomb:
                            scores[doc_id] += qw * dw
                else:
                    for doc_id, dw in zip(ids, ws, strict=True):
                        scores[doc_id] += qw * dw
            for doc_id, dw in view.overlay_postings.get(t, ()):
                scores[doc_id] += qw * dw
        if exclude:
            for d in exclude:
                scores.pop(d, None)
        return scores

    def _top(self, view: _View, qvec: Counter, limit: int, exclude: set[int] | None = None) -> list[tuple[int, float]]:
        return heapq.nlargest(limit, self._score(view, qvec, exclude).items(), key=lambda kv: kv[1])

    def search(self, db: Session, query: str, limit: int = 50) -> list[tuple[int, float]]:
        qvec = expand(tokenize(query))
        if not qvec:
            return []
        view = self.get(db)
        return self._top(view, qvec, limit) if view else []

    def doc_terms(self, db: Session, view: _View, biblio_id: int, top: int = 25) -> list[tuple[str, float]]:
        weights = view.overlay.get(biblio_id)
        if weights is None:
            row = db.execute(select(*_ROW_COLUMNS).where(Biblio.id == biblio_id, Biblio.deleted_at.is_(None))).first()
            if row is None:
                return []
            weights = _weights(_doc_tf(*row[1:]), view.idf)
        return heapq.nlargest(top, weights.items(), key=lambda kv: kv[1])

    def similar(self, db: Session, biblio_id: int, limit: int = 10) -> list[tuple[int, float]]:
        view = self.get(db)
        if view is None:
            return []
        terms = self.doc_terms(db, view, biblio_id)
        if not terms:
            return []
        return self._top(view, Counter(dict(terms)), limit, exclude={biblio_id})

    def similar_to_text(self, db: Session, text: str, limit: int = 10,
                        exclude: set[int] | None = None) -> list[tuple[int, float]]:
        qvec = Counter(tokenize(text))
        if not qvec:
            return []
        view = self.get(db)
        return self._top(view, qvec, limit, exclude) if view else []


index = SemanticIndex()


def reciprocal_rank_fusion(*rankings: list[int], k: int = 60) -> list[int]:
    scores: dict[int, float] = defaultdict(float)
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking):
            scores[doc_id] += 1.0 / (k + rank + 1)
    return [d for d, _ in sorted(scores.items(), key=lambda kv: -kv[1])]
