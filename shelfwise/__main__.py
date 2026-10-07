"""Command-line interface: ``python -m shelfwise <command>``."""

from __future__ import annotations

import argparse
import getpass
import json
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="shelfwise", description="Shelfwise ILS management")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-db", help="Create database tables and search index")
    p_seed = sub.add_parser("seed", help="Load demo data (branches, rules, catalogue, patrons, history)")
    p_seed.add_argument("--patrons", type=int, default=60)
    sub.add_parser("reset", help="DROP all data and recreate empty tables")
    p_admin = sub.add_parser("create-admin", help="Create an administrator account")
    p_admin.add_argument("--username", required=True, help="Card number / login name")
    p_admin.add_argument("--email", required=True)
    sub.add_parser("nightly", help="Run nightly jobs: notices, hold expiry, anonymisation")
    sub.add_parser("reindex", help="Rebuild the full-text search index")
    p_run = sub.add_parser("run", help="Start the web server")
    p_run.add_argument("--host", default="127.0.0.1")
    p_run.add_argument("--port", type=int, default=8000)
    p_run.add_argument("--reload", action="store_true")
    from .cli_ops import add_parsers as add_ops_parsers
    from .cli_ops import dispatch as ops_dispatch

    add_ops_parsers(sub)  # worker, jobs, backup, restore, generate
    args = parser.parse_args(argv)
    if (rc := ops_dispatch(args)) is not None:
        return rc

    from .db import create_all, drop_all, session_scope

    if args.cmd == "init-db":
        create_all()
        print("Database initialised.")
    elif args.cmd == "reset":
        drop_all()
        create_all()
        print("Database reset.")
    elif args.cmd == "seed":
        from .seed import seed

        create_all()
        with session_scope() as db:
            stats = seed(db, patrons=args.patrons)
        print("Demo data loaded:", json.dumps(stats))
        print("Demo logins: admin / Shelfwise#Admin2026 · librarian / Shelfwise#Staff2026 · 1000000001 / Reader#Demo2026")
    elif args.cmd == "create-admin":
        from sqlalchemy import select

        from .models import Branch, Patron, PatronCategory, Role
        from .security import hash_password, password_problems

        create_all()
        pw = getpass.getpass("Password: ")
        if problems := password_problems(pw):
            print("Password " + "; ".join(problems), file=sys.stderr)
            return 1
        with session_scope() as db:
            branch = db.scalar(select(Branch).limit(1)) or Branch(code="MAIN", name="Main Library")
            cat = db.scalar(select(PatronCategory).where(PatronCategory.code == "STAFF")) or PatronCategory(code="STAFF", name="Staff")
            db.add_all([branch, cat])
            db.flush()
            db.add(Patron(card_number=args.username, email=args.email.lower(), first_name="Admin", last_name=args.username,
                          role=Role.admin, category_id=cat.id, home_branch_id=branch.id, password_hash=hash_password(pw)))
        print(f"Administrator {args.username} created.")
    elif args.cmd == "nightly":
        from .services.circulation import run_nightly

        with session_scope() as db:
            print(json.dumps(run_nightly(db)))
    elif args.cmd == "reindex":
        from .services.catalog import reindex_all

        with session_scope() as db:
            print(f"Indexed {reindex_all(db)} records.")
    elif args.cmd == "run":
        import uvicorn

        uvicorn.run("shelfwise.app:app", host=args.host, port=args.port, reload=args.reload, proxy_headers=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
