"""A small CQL (Contextual Query Language) parser and evaluator for the SRU server.

Supported: search clauses with indexes and relations (``=``, ``==``, ``exact``, ``all``,
``any``, ``adj`` and ``< > <= >= <>`` on dates), boolean ``and`` / ``or`` / ``not``,
parentheses, quoted terms with backslash escapes and right-truncation (``term*``).

Text clauses are compiled to SQLite FTS5 MATCH expressions built only from ``\\w+`` tokens,
always passed as bound parameters; structured indexes use ORM comparisons. User text is never
interpolated into SQL.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from sqlalchemy import String, cast, func, or_, select, text
from sqlalchemy.orm import Session

from ..db import fts_available
from ..models import Biblio
from ..services import catalog
from ..services.marc import _LANG3

MAX_HITS_PER_CLAUSE = 20000


class CQLError(Exception):
    """Maps onto an SRU diagnostic (``info:srw/diagnostic/1/<code>``)."""

    def __init__(self, code: int, message: str, details: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


# ------------------------------------------------------------------ AST


@dataclass
class Clause:
    index: str | None
    relation: str | None
    term: str
    modifiers: list[str] = field(default_factory=list)


@dataclass
class Boolean:
    op: str
    left: Clause | Boolean
    right: Clause | Boolean
    modifiers: list[str] = field(default_factory=list)


Node = Clause | Boolean

# ------------------------------------------------------------------ lexer

_SYMBOL_RELATIONS = ("==", "<>", "<=", ">=", "=", "<", ">")
_WORD_RELATIONS = {"all", "any", "adj", "exact", "within", "encloses"}
_BOOLEANS = {"and", "or", "not", "prox"}
_TOKEN_RE = re.compile(r'\s*(?:(?P<quoted>"(?:\\.|[^"\\])*")|(?P<sym>==|<>|<=|>=|[=<>()/])|(?P<word>[^\s()=<>"/]+))')


@dataclass
class Tok:
    kind: str  # quoted | sym | word
    value: str


def tokenize(query: str) -> list[Tok]:
    out: list[Tok] = []
    pos = 0
    query = query.rstrip()
    while pos < len(query):
        m = _TOKEN_RE.match(query, pos)
        if not m or m.end() == pos:  # e.g. an unterminated quotation mark
            raise CQLError(10, "Query syntax error", f"Unexpected character at position {pos + 1}")
        pos = m.end()
        if m.group("quoted") is not None:
            raw = m.group("quoted")[1:-1]
            out.append(Tok("quoted", re.sub(r"\\(.)", r"\1", raw)))
        elif m.group("sym") is not None:
            out.append(Tok("sym", m.group("sym")))
        elif m.group("word") is not None:
            out.append(Tok("word", m.group("word")))
    return out


# ------------------------------------------------------------------ parser


class _Parser:
    def __init__(self, tokens: list[Tok]) -> None:
        self.toks = tokens
        self.i = 0

    def peek(self, offset: int = 0) -> Tok | None:
        j = self.i + offset
        return self.toks[j] if j < len(self.toks) else None

    def take(self) -> Tok:
        t = self.peek()
        if t is None:
            raise CQLError(10, "Query syntax error", "Unexpected end of query")
        self.i += 1
        return t

    def is_bool(self, t: Tok | None) -> bool:
        return t is not None and t.kind == "word" and t.value.lower() in _BOOLEANS

    def is_relation(self, t: Tok | None) -> bool:
        return t is not None and ((t.kind == "sym" and t.value in _SYMBOL_RELATIONS)
                                  or (t.kind == "word" and t.value.lower() in _WORD_RELATIONS))

    def parse(self) -> Node:
        if not self.toks:
            raise CQLError(27, "Empty term unsupported", "The query is empty")
        node = self.scoped()
        t = self.peek()
        if t is not None:
            if t.kind == "word" and t.value.lower() == "sortby":
                raise CQLError(80, "Sort not supported")
            raise CQLError(10, "Query syntax error", f"Unexpected '{t.value}'")
        return node

    def scoped(self) -> Node:
        left = self.clause()
        while self.is_bool(self.peek()):
            op = self.take().value.lower()
            mods = self.modifiers()
            right = self.clause()
            left = Boolean(op, left, right, mods)
        return left

    def modifiers(self) -> list[str]:
        mods = []
        while (t := self.peek()) is not None and t.kind == "sym" and t.value == "/":
            self.take()
            name = self.take()
            if name.kind == "sym":
                raise CQLError(10, "Query syntax error", "Invalid modifier")
            mod = name.value.lower()
            nxt = self.peek()
            if nxt is not None and nxt.kind == "sym" and nxt.value in _SYMBOL_RELATIONS:
                self.take()
                mod += nxt.value + self.take().value
            mods.append(mod)
        return mods

    def term(self) -> str:
        t = self.take()
        if t.kind == "sym":
            raise CQLError(10, "Query syntax error", f"Expected a search term, found '{t.value}'")
        return t.value

    def clause(self) -> Node:
        t = self.peek()
        if t is None:
            raise CQLError(10, "Query syntax error", "Unexpected end of query")
        if t.kind == "sym" and t.value == "(":
            self.take()
            node = self.scoped()
            close = self.peek()
            if close is None or close.kind != "sym" or close.value != ")":
                raise CQLError(13, "Invalid or unsupported use of parentheses", "Missing closing parenthesis")
            self.take()
            return node
        if t.kind == "sym":
            raise CQLError(10, "Query syntax error", f"Unexpected '{t.value}'")
        first = self.take()
        if first.kind == "word" and self.is_relation(self.peek()):
            rel = self.take().value.lower()
            mods = self.modifiers()
            return Clause(first.value, rel, self.term(), mods)
        if first.kind == "word" and self.is_bool(first) and self.peek() is None:
            raise CQLError(10, "Query syntax error", f"Dangling boolean '{first.value}'")
        return Clause(None, None, first.value)


def parse(query: str) -> Node:
    return _Parser(tokenize(query)).parse()


# ------------------------------------------------------------------ indexes

TEXT_COLUMNS = {"any": None, "title": "title", "authors": "authors", "subjects": "subjects",
                "publisher": "publisher", "description": "description", "series": "series"}

INDEXES: dict[str, str] = {
    "cql.serverchoice": "any", "cql.anywhere": "any", "cql.keywords": "any", "dc.anywhere": "any",
    "cql.allrecords": "all",
    "dc.title": "title", "bath.title": "title", "title": "title",
    "dc.creator": "authors", "dc.author": "authors", "dc.contributor": "authors", "bath.name": "authors",
    "bath.author": "authors", "bath.personalname": "authors", "author": "authors", "creator": "authors",
    "dc.subject": "subjects", "bath.subject": "subjects", "subject": "subjects",
    "dc.publisher": "publisher", "publisher": "publisher",
    "dc.description": "description",
    "dc.relation": "series", "bath.seriestitle": "series",
    "bath.isbn": "isbn", "isbn": "isbn",
    "bath.issn": "issn", "issn": "issn",
    "dc.identifier": "identifier",
    "dc.date": "year", "date": "year",
    "dc.language": "language",
    "dc.type": "type",
    "rec.id": "id",
}

PUBLIC_INDEXES = {  # advertised in explain: name -> title
    "cql.serverChoice": "Keyword (all fields)", "cql.anywhere": "Anywhere", "cql.allRecords": "All records",
    "dc.title": "Title", "dc.creator": "Author / creator", "dc.subject": "Subject", "dc.publisher": "Publisher",
    "dc.description": "Description", "dc.date": "Publication year", "dc.identifier": "Identifier (ISBN/ISSN)",
    "dc.language": "Language", "dc.type": "Material type", "bath.isbn": "ISBN", "bath.issn": "ISSN",
    "rec.id": "Record number",
}

_TEXT_RELATIONS = {"=", "==", "exact", "all", "any", "adj"}
_EXACT_RELATIONS = {"=", "==", "exact"}
_DATE_RELATIONS = {"=", "==", "<", ">", "<=", ">=", "<>"}
_IGNORABLE_MODIFIERS = {"relevant", "cql.relevant", "ignorecase", "cql.ignorecase", "string", "cql.string",
                        "word", "cql.word", "unmasked", "cql.unmasked", "masked", "cql.masked"}


# ------------------------------------------------------------------ evaluation


def evaluate(db: Session, node: Node) -> list[int]:
    """Ordered list of matching biblio ids (relevance order of the first text clause)."""
    if isinstance(node, Boolean):
        if node.modifiers:
            raise CQLError(46, "Unsupported boolean modifier", node.modifiers[0])
        if node.op == "prox":
            raise CQLError(37, "Unsupported boolean operator", "prox")
        left = evaluate(db, node.left)
        right = evaluate(db, node.right)
        rs = set(right)
        if node.op == "and":
            return [i for i in left if i in rs]
        if node.op == "or":
            ls = set(left)
            return left + [i for i in right if i not in ls]
        return [i for i in left if i not in rs]  # not
    return _clause(db, node)


def _clause(db: Session, c: Clause) -> list[int]:
    index = (c.index or "cql.serverchoice").lower()
    kind = INDEXES.get(index)
    if kind is None:
        raise CQLError(16, "Unsupported index", c.index)
    relation = c.relation or "="
    for mod in c.modifiers:
        if mod.split("=")[0] not in _IGNORABLE_MODIFIERS:
            raise CQLError(20, "Unsupported relation modifier", mod)
    term = c.term.strip()
    if kind == "all":
        return list(db.scalars(select(Biblio.id).where(Biblio.deleted_at.is_(None)).order_by(Biblio.id)))
    if term == "" and relation not in ("<>",):
        raise CQLError(27, "Empty term unsupported")
    if kind in TEXT_COLUMNS:
        if relation not in _TEXT_RELATIONS:
            raise CQLError(19, "Unsupported relation", relation)
        return _text(db, TEXT_COLUMNS[kind], relation, term)
    if kind == "year":
        if relation not in _DATE_RELATIONS:
            raise CQLError(19, "Unsupported relation", relation)
        m = re.match(r"^(\d{4})", term)
        if not m:
            raise CQLError(36, "Term in invalid format for index or relation", term)
        y = int(m.group(1))
        col = Biblio.pub_year
        cond = {"=": col == y, "==": col == y, "<": col < y, ">": col > y, "<=": col <= y, ">=": col >= y,
                "<>": col != y}[relation]
        return _ids(db, cond)
    if relation not in _EXACT_RELATIONS | {"any"}:
        raise CQLError(19, "Unsupported relation", relation)
    values = term.split() if relation == "any" else [term]
    if kind in ("isbn", "issn", "identifier"):
        conds = []
        for v in values:
            v = re.sub(r"^(urn:)?(isbn|issn)[:\s]*", "", v, flags=re.I)
            norm = catalog.normalize_isbn(v)
            plain = re.sub(r"[^0-9Xx]", "", v).upper()
            cands = {x for x in (v, norm, plain) if x}
            if kind in ("isbn", "identifier"):
                conds.append(Biblio.isbn.in_(cands))
            if kind in ("issn", "identifier"):
                conds.append(Biblio.issn.in_(cands | {f"{plain[:4]}-{plain[4:]}"} if len(plain) == 8 else cands))
        return _ids(db, or_(*conds))
    if kind == "id":
        ids = [int(v) for v in values if v.isdigit()]
        if not ids:
            raise CQLError(36, "Term in invalid format for index or relation", term)
        return _ids(db, Biblio.id.in_(ids))
    if kind == "language":
        codes = {_LANG3.get(v.lower(), v.lower())[:8] for v in values}
        return _ids(db, Biblio.language.in_(codes))
    if kind == "type":
        return _ids(db, Biblio.material_type.in_({v.lower() for v in values}))
    raise CQLError(16, "Unsupported index", c.index)  # pragma: no cover


def _ids(db: Session, cond) -> list[int]:
    return list(db.scalars(select(Biblio.id).where(Biblio.deleted_at.is_(None), cond)
                           .order_by(Biblio.id).limit(MAX_HITS_PER_CLAUSE)))


def _words(term: str) -> list[tuple[str, bool]]:
    """Split a CQL term into (token, prefix?) pairs; ``*`` at the end of a word truncates."""
    out = []
    for word in term.split():
        prefix = word.endswith("*")
        toks = catalog._TOKEN.findall(word.replace("*", " ").replace("?", " ").lower())
        for j, t in enumerate(toks):
            out.append((t, prefix and j == len(toks) - 1))
    return out


def fts_expression(column: str | None, relation: str, term: str) -> str | None:
    """Compile a clause into an FTS5 expression made only of quoted ``\\w+`` tokens."""
    words = _words(term)
    if not words:
        return None
    if relation in ("adj", "==", "exact"):
        phrase = " ".join(t for t, _ in words)
        expr = f'"{phrase}"' + ("*" if words[-1][1] else "")
    else:
        joiner = " OR " if relation == "any" else " AND "
        expr = joiner.join(f'"{t}"' + ("*" if p else "") for t, p in words)
    return f"{{{column}}} : ({expr})" if column else f"({expr})"


def _text(db: Session, column: str | None, relation: str, term: str) -> list[int]:
    if fts_available(db.get_bind()):
        expr = fts_expression(column, relation, term)
        if expr is None:
            return []
        rows = db.execute(
            text(f"SELECT rowid FROM biblio_fts WHERE biblio_fts MATCH :m "
                 f"ORDER BY bm25(biblio_fts, {catalog.FTS_WEIGHTS}) LIMIT :lim"),
            {"m": expr, "lim": MAX_HITS_PER_CLAUSE},
        ).all()
        return [r[0] for r in rows]
    # Portable fallback (no FTS5): case-insensitive substring matching on the mapped columns.
    cols = {
        None: [Biblio.title, Biblio.subtitle, cast(Biblio.authors, String), cast(Biblio.subjects, String),
               Biblio.description, Biblio.publisher, Biblio.isbn, Biblio.series],
        "title": [Biblio.title, Biblio.subtitle], "authors": [cast(Biblio.authors, String)],
        "subjects": [cast(Biblio.subjects, String)], "publisher": [Biblio.publisher],
        "description": [Biblio.description], "series": [Biblio.series],
    }[column]
    words = [t for t, _ in _words(term)]
    if not words:
        return []

    def has(word: str):
        return or_(*[func.lower(c).contains(word, autoescape=True) for c in cols])

    if relation in ("adj", "==", "exact"):
        cond = has(" ".join(words))
    elif relation == "any":
        cond = or_(*[has(w) for w in words])
    else:
        from sqlalchemy import and_

        cond = and_(*[has(w) for w in words])
    return _ids(db, cond)
