"""Staff copilot: answers operational questions using read-only tools over live library data.

With Claude, the model chooses tools in an agentic loop. Without it, a local intent router
maps the question to the same tools and renders a templated answer — so the feature always
works, and the tools are identical in both modes (no raw SQL is ever generated).
"""

from __future__ import annotations

import re
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (
    Biblio,
    Branch,
    Hold,
    HoldStatus,
    Item,
    LedgerEntry,
    Loan,
    Patron,
    Role,
    utcnow,
)
from ..services import catalog, circulation
from . import insights, llm, nlsearch, recommend

# ------------------------------------------------------------------ tools


def tool_library_stats(db: Session) -> dict:
    now = utcnow()
    return {
        "titles": db.scalar(select(func.count()).select_from(Biblio).where(Biblio.deleted_at.is_(None))),
        "items": db.scalar(select(func.count()).select_from(Item).where(Item.deleted_at.is_(None))),
        "patrons": db.scalar(select(func.count()).select_from(Patron).where(Patron.deleted_at.is_(None), Patron.role == Role.patron)),
        "loans_open": db.scalar(select(func.count()).select_from(Loan).where(Loan.returned_at.is_(None))),
        "loans_overdue": db.scalar(select(func.count()).select_from(Loan).where(Loan.returned_at.is_(None), Loan.due_at < now)),
        "loans_today": db.scalar(select(func.count()).select_from(Loan).where(Loan.issued_at >= now.replace(hour=0, minute=0, second=0))),
        "holds_queued": db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.queued)),
        "holds_ready": db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.ready)),
        "fines_outstanding": round((db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0))) or 0) / 100, 2),
        "items_by_status": {s.value: n for s, n in db.execute(
            select(Item.status, func.count()).where(Item.deleted_at.is_(None)).group_by(Item.status)).all()},
    }


def tool_search_catalog(db: Session, query: str, limit: int = 8) -> dict:
    res = nlsearch.smart_search(db, query, per_page=min(limit, 20))
    avail = catalog.availability(db, res["ids"])
    return {
        "understood_as": res["parsed"],
        "total": res["total"],
        "results": [
            {"id": b.id, "title": b.title, "authors": b.authors, "year": b.pub_year,
             "available": avail[b.id]["available"], "copies": avail[b.id]["total"]}
            for b in catalog.load_biblios(db, res["ids"])
        ],
    }


def tool_overdue_loans(db: Session, branch_code: str | None = None, limit: int = 15) -> dict:
    now = utcnow()
    q = select(Loan).where(Loan.returned_at.is_(None), Loan.due_at < now).order_by(Loan.due_at)
    if branch_code:
        q = q.join(Branch, Branch.id == Loan.branch_id).where(Branch.code == branch_code.upper())
    count = db.scalar(select(func.count()).select_from(q.order_by(None).subquery()))
    loans = list(db.scalars(q.limit(limit)))
    return {
        "count": count,
        "loans": [{"title": l.item.biblio.title, "barcode": l.item.barcode,
                   "patron": l.patron.full_name if l.patron else "(anonymised)",
                   "card": l.patron.card_number if l.patron else None,
                   "days_overdue": (now - l.due_at).days} for l in loans],
    }


def tool_patron_summary(db: Session, card_or_name: str) -> dict:
    term = card_or_name.strip()
    p = db.scalar(select(Patron).where(Patron.card_number == term))
    if p is None:
        like = f"%{term}%"
        p = db.scalar(select(Patron).where(
            Patron.deleted_at.is_(None),
            (Patron.last_name.ilike(like)) | (Patron.first_name.ilike(like)) | (Patron.email.ilike(like))).limit(1))
    if p is None:
        return {"found": False}
    loans = circulation.open_loans(db, p.id)
    return {
        "found": True, "name": p.full_name, "card": p.card_number, "category": p.category.name,
        "expires_on": p.expires_on, "balance": circulation.balance(db, p.id) / 100,
        "blocks": circulation.patron_blocks(db, p),
        "loans": [{"title": l.item.biblio.title, "due": l.due_at, "overdue": l.due_at < utcnow()} for l in loans],
        "holds": [{"title": h.biblio.title, "status": h.status.value} for h in db.scalars(
            select(Hold).where(Hold.patron_id == p.id, Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES)))],
    }


def tool_popular_titles(db: Session, days: int = 90, limit: int = 10) -> dict:
    rows = recommend.trending(db, days=days, limit=limit)
    by_id = {b.id: b for b in catalog.load_biblios(db, [b for b, _ in rows])}
    return {"days": days, "titles": [{"title": by_id[b].title, "loans": n} for b, n in rows if b in by_id]}


def tool_purchase_suggestions(db: Session) -> dict:
    return {"suggestions": insights.purchase_suggestions(db, 10)}


def tool_overdue_risk(db: Session, limit: int = 10) -> dict:
    return {"loans": insights.overdue_risk(db, limit)}


def tool_circulation_trend(db: Session, days: int = 30) -> dict:
    since = utcnow() - timedelta(days=days)
    rows = db.execute(
        select(func.date(Loan.issued_at), func.count()).where(Loan.issued_at >= since)
        .group_by(func.date(Loan.issued_at)).order_by(func.date(Loan.issued_at))
    ).all()
    return {"days": days, "checkouts_per_day": [{"date": str(d), "count": n} for d, n in rows],
            "total": sum(n for _, n in rows)}


TOOLS = {
    "library_stats": (tool_library_stats, "Current headline numbers: titles, items, patrons, open/overdue loans, holds, outstanding fines, items by status.", {}),
    "search_catalog": (tool_search_catalog, "Search the catalogue with a natural-language query; returns titles with availability.", {"query": {"type": "string"}}),
    "overdue_loans": (tool_overdue_loans, "List overdue loans, oldest first. Optionally restrict to a branch code.", {"branch_code": {"type": ["string", "null"]}}),
    "patron_summary": (tool_patron_summary, "Look up a patron by card number, name or email: loans, holds, balance and borrowing blocks.", {"card_or_name": {"type": "string"}}),
    "popular_titles": (tool_popular_titles, "Most borrowed titles over the last N days.", {"days": {"type": "integer"}}),
    "purchase_suggestions": (tool_purchase_suggestions, "Titles whose hold queues exceed available copies — candidates to buy more copies.", {}),
    "overdue_risk": (tool_overdue_risk, "Open loans most likely to be returned late, with risk factors.", {}),
    "circulation_trend": (tool_circulation_trend, "Checkouts per day over the last N days.", {"days": {"type": "integer"}}),
}


def tool_definitions() -> list[dict]:
    defs = []
    for name, (_, desc, props) in TOOLS.items():
        defs.append({
            "name": name,
            "description": desc,
            "strict": True,
            "input_schema": {"type": "object", "properties": props, "required": list(props),
                             "additionalProperties": False},
        })
    return defs


def execute(db: Session, name: str, args: dict) -> dict:
    if name not in TOOLS:
        raise ValueError(f"Unknown tool {name}")
    fn = TOOLS[name][0]
    clean = {k: v for k, v in args.items() if v is not None}
    return fn(db, **clean)


# ------------------------------------------------------------------ local engine

INTENTS: list[tuple[str, str]] = [
    (r"\b(overdue risk|likely to be late|at risk|risky)\b", "overdue_risk"),
    (r"\b(overdue|late returns?|past due)\b", "overdue_loans"),
    (r"\b(buy|purchase|order more|acquire|demand)\b", "purchase_suggestions"),
    (r"\b(popular|trending|most borrowed|top (books|titles))\b", "popular_titles"),
    (r"\b(trend|per day|daily|activity)\b", "circulation_trend"),
    (r"\b(patron|member|borrower|card)\b", "patron_summary"),
    (r"\b(stats|statistics|how many|summary|overview|dashboard|total)\b", "library_stats"),
    (r"\b(find|search|books? (about|on)|titles? (about|on)|do we have|recommend)\b", "search_catalog"),
]


def _local_answer(db: Session, question: str) -> tuple[str, list[dict]]:
    q = question.lower()
    intent = next((tool for pattern, tool in INTENTS if re.search(pattern, q)), "search_catalog")
    args: dict = {}
    if intent == "search_catalog":
        args = {"query": re.sub(r"^(find|search( for)?|do we have|show me|recommend)\s+", "", question, flags=re.I)}
    elif intent == "patron_summary":
        m = re.search(r"\b(\d{6,})\b", question) or re.search(
            r"(?:patron|member|borrower|card)\s+(?:named\s+|called\s+)?([\w@.-]+(?:\s+[A-Z][\w-]+)?)", question, re.I)
        if not m:
            return "Which patron? Give me a card number or name.", []
        args = {"card_or_name": m.group(1)}
    elif intent in ("popular_titles", "circulation_trend"):
        m = re.search(r"(\d+)\s*(day|week|month)", q)
        if m:
            mult = {"day": 1, "week": 7, "month": 30}[m.group(2)]
            args = {"days": int(m.group(1)) * mult}
    data = execute(db, intent, args)
    trace = [{"tool": intent, "input": args, "ok": True}]
    return _render(intent, data), trace


def _render(intent: str, d: dict) -> str:
    if intent == "library_stats":
        return (f"The collection has **{d['titles']:,} titles** and **{d['items']:,} items** for "
                f"**{d['patrons']:,} patrons**. There are **{d['loans_open']} loans out**, "
                f"**{d['loans_overdue']} overdue**, {d['loans_today']} checkouts today, "
                f"{d['holds_queued']} holds queued and {d['holds_ready']} waiting for pickup. "
                f"Outstanding charges total **{d['fines_outstanding']:,.2f}**.")
    if intent == "overdue_loans":
        if not d["count"]:
            return "Good news — nothing is overdue right now."
        lines = [f"- *{l['title']}* — {l['patron']} ({l['days_overdue']} days)" for l in d["loans"][:10]]
        return f"**{d['count']} loans are overdue.** Oldest first:\n" + "\n".join(lines)
    if intent == "overdue_risk":
        if not d["loans"]:
            return "No open loans to assess."
        lines = [f"- *{l['title']}* — {l['patron']}: **{l['level']}** risk ({l['risk']:.0%})" for l in d["loans"][:8]]
        return "Loans most likely to come back late:\n" + "\n".join(lines)
    if intent == "purchase_suggestions":
        if not d["suggestions"]:
            return "No title currently has more than two holds per copy."
        lines = [f"- *{s['title']}*: {s['holds']} holds / {s['copies']} copies → buy {s['suggested_copies']}" for s in d["suggestions"]]
        return "Titles where demand exceeds supply:\n" + "\n".join(lines)
    if intent == "popular_titles":
        if not d["titles"]:
            return f"No loans in the last {d['days']} days."
        lines = [f"{i}. *{t['title']}* — {t['loans']} loans" for i, t in enumerate(d["titles"], 1)]
        return f"Most borrowed in the last {d['days']} days:\n" + "\n".join(lines)
    if intent == "circulation_trend":
        return f"{d['total']} checkouts over the last {d['days']} days across {len(d['checkouts_per_day'])} active days."
    if intent == "patron_summary":
        if not d.get("found"):
            return "I couldn't find that patron."
        loans = "\n".join(f"- *{l['title']}* due {l['due']:%d %b}{' **(overdue)**' if l['overdue'] else ''}" for l in d["loans"]) or "- none"
        blocks = "; ".join(d["blocks"]) or "none"
        return (f"**{d['name']}** ({d['card']}, {d['category']}) — balance {d['balance']:.2f}, "
                f"blocks: {blocks}.\nLoans:\n{loans}")
    if intent == "search_catalog":
        if not d["results"]:
            return "No matching titles found."
        lines = [f"- *{r['title']}* ({r['year'] or 'n.d.'}) — {r['available']}/{r['copies']} available" for r in d["results"]]
        notes = ", ".join(d["understood_as"].get("interpretation") or [])
        head = f"Found **{d['total']}** titles" + (f" ({notes})" if notes else "") + ":"
        return head + "\n" + "\n".join(lines)
    return str(d)


SYSTEM = (
    "You are the Librowise library copilot for library staff. Answer using the tools, which "
    "read live data from the integrated library system. Be concise and specific, use Markdown "
    "lists for multiple items, and never invent titles, patrons or numbers that the tools did "
    "not return. Patron data is confidential: only share it in answer to a direct staff question."
)


def ask(db: Session, question: str, history: list[dict] | None = None) -> dict:
    messages = [*(history or [])[-8:], {"role": "user", "content": question}]
    result = llm.run_tool_loop(SYSTEM, messages, tool_definitions(), lambda n, a: execute(db, n, a))
    if result is not None:
        text, trace = result
        return {"answer": text, "trace": trace, "engine": "claude"}
    text, trace = _local_answer(db, question)
    return {"answer": text, "trace": trace, "engine": "local"}
