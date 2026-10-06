"""Local semantic index: sparse TF-IDF with concept expansion, served from an inverted index.

Scales to large catalogues because scoring only touches the postings of query terms (no dense
N x V matrix). The index is rebuilt lazily when the catalogue changes.
"""

from __future__ import annotations

import math
import re
import threading
from collections import Counter, defaultdict
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Biblio

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


@dataclass
class _Index:
    signature: tuple
    postings: dict[str, list[tuple[int, float]]]
    idf: dict[str, float]
    doc_terms: dict[int, list[tuple[str, float]]]  # top terms per doc for "more like this"
    n_docs: int


class SemanticIndex:
    def __init__(self) -> None:
        self._index: _Index | None = None
        self._lock = threading.Lock()

    @staticmethod
    def _signature(db: Session) -> tuple:
        return tuple(db.execute(
            select(func.count(Biblio.id), func.max(Biblio.updated_at)).where(Biblio.deleted_at.is_(None))
        ).one())

    def invalidate(self) -> None:
        self._index = None

    def get(self, db: Session) -> _Index:
        sig = self._signature(db)
        idx = self._index
        if idx is not None and idx.signature == sig:
            return idx
        with self._lock:
            if self._index is not None and self._index.signature == sig:
                return self._index
            self._index = self._build(db, sig)
            return self._index

    def _build(self, db: Session, sig: tuple) -> _Index:
        tf_by_doc: dict[int, Counter] = {}
        df: Counter = Counter()
        for b in db.scalars(select(Biblio).where(Biblio.deleted_at.is_(None))):
            tf: Counter = Counter()
            for text, weight in biblio_text(b):
                for tok in tokenize(text):
                    tf[tok] += weight
            tf_by_doc[b.id] = tf
            df.update(tf.keys())
        n = max(len(tf_by_doc), 1)
        idf = {t: math.log((1 + n) / (1 + d)) + 1.0 for t, d in df.items()}
        postings: dict[str, list[tuple[int, float]]] = defaultdict(list)
        doc_terms: dict[int, list[tuple[str, float]]] = {}
        for doc_id, tf in tf_by_doc.items():
            weights = {t: (1 + math.log(c)) * idf[t] for t, c in tf.items()}
            norm = math.sqrt(sum(w * w for w in weights.values())) or 1.0
            normed = {t: w / norm for t, w in weights.items()}
            for t, w in normed.items():
                postings[t].append((doc_id, w))
            doc_terms[doc_id] = sorted(normed.items(), key=lambda kv: -kv[1])[:25]
        return _Index(signature=sig, postings=dict(postings), idf=idf, doc_terms=doc_terms, n_docs=n)

    # ---------------------------------------------------------------- queries

    def _score(self, idx: _Index, qvec: Counter, exclude: set[int] | None = None) -> list[tuple[int, float]]:
        weights = {t: w * idx.idf.get(t, 0.0) for t, w in qvec.items() if t in idx.postings}
        norm = math.sqrt(sum(w * w for w in weights.values())) or 1.0
        scores: dict[int, float] = defaultdict(float)
        for t, w in weights.items():
            for doc_id, dw in idx.postings[t]:
                scores[doc_id] += (w / norm) * dw
        if exclude:
            for d in exclude:
                scores.pop(d, None)
        return sorted(scores.items(), key=lambda kv: -kv[1])

    def search(self, db: Session, query: str, limit: int = 50) -> list[tuple[int, float]]:
        idx = self.get(db)
        qvec = expand(tokenize(query))
        if not qvec:
            return []
        return self._score(idx, qvec)[:limit]

    def similar(self, db: Session, biblio_id: int, limit: int = 10) -> list[tuple[int, float]]:
        idx = self.get(db)
        terms = idx.doc_terms.get(biblio_id)
        if not terms:
            return []
        qvec = Counter({t: w for t, w in terms})
        return self._score(idx, qvec, exclude={biblio_id})[:limit]

    def similar_to_text(self, db: Session, text: str, limit: int = 10,
                        exclude: set[int] | None = None) -> list[tuple[int, float]]:
        idx = self.get(db)
        qvec = Counter(tokenize(text))
        if not qvec:
            return []
        return self._score(idx, qvec, exclude=exclude)[:limit]


index = SemanticIndex()


def reciprocal_rank_fusion(*rankings: list[int], k: int = 60) -> list[int]:
    scores: dict[int, float] = defaultdict(float)
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking):
            scores[doc_id] += 1.0 / (k + rank + 1)
    return [d for d, _ in sorted(scores.items(), key=lambda kv: -kv[1])]
