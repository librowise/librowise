"""Command-line interface: ``python -m librowise <command>``."""

from __future__ import annotations

import argparse
import getpass
import json
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="librowise", description="Librowise management")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-db", help="Create/upgrade the database schema and search index (alias of migrate)")
    sub.add_parser("migrate", help="Apply database migrations (alembic upgrade head)")
    p_mk = sub.add_parser("makemigration", help="Autogenerate a migration from model changes (developers)")
    p_mk.add_argument("-m", "--message", required=True)
    p_seed = sub.add_parser("seed", help="Load demo data (branches, rules, catalogue, patrons, history)")
    p_seed.add_argument("--patrons", type=int, default=60)
    sub.add_parser("reset", help="DROP all data and recreate empty tables")
    p_admin = sub.add_parser("create-admin", help="Create an administrator account")
    p_admin.add_argument("--username", required=True, help="Card number / login name")
    p_admin.add_argument("--email", required=True)
    p_unlock = sub.add_parser("reset-2fa", help="Break-glass: remove 2FA, clear lockout and end all sessions of an account")
    p_unlock.add_argument("--username", required=True, help="Card number or email")
    sub.add_parser("nightly", help="Run nightly jobs: notices, hold expiry, anonymisation")
    sub.add_parser("reindex", help="Rebuild the full-text search index")
    p_run = sub.add_parser("run", help="Start the web server")
    p_run.add_argument("--host", default="127.0.0.1")
    p_run.add_argument("--port", type=int, default=8000)
    p_run.add_argument("--reload", action="store_true")
    p_notices = sub.add_parser("send-notices", help="Deliver pending notices from the outbox (email/SMS)")
    p_notices.add_argument("--limit", type=int, default=200, help="Maximum notices to process")
    p_sip = sub.add_parser("sip2", help="Start the SIP2 server for self-check kiosks and gates")
    p_sip.add_argument("--host", default="127.0.0.1", help="Interface to bind (0.0.0.0 for all)")
    p_sip.add_argument("--port", type=int, default=6001)
    p_sip.add_argument("--delimiter", default="|", help="Field delimiter used before login")
    p_sip.add_argument("--encoding", default="utf-8", help="Character set used before login")
    p_sip.add_argument("--login-timeout", type=float, default=60.0, help="Seconds allowed before login")
    p_sip.add_argument("--max-connections", type=int, default=256)
    p_sip.add_argument("--certfile", help="PEM certificate to serve SIP2 over TLS")
    p_sip.add_argument("--keyfile", help="PEM private key for --certfile")
    p_sip.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])

    from .cli_ops import add_parsers as add_ops_parsers
    from .cli_ops import dispatch as ops_dispatch

    add_ops_parsers(sub)  # worker, jobs, backup, restore, generate
    p_auth = sub.add_parser("authorities", help="Authority control maintenance")
    p_auth.add_argument("action", choices=["relink", "generate"],
                        help="relink: re-derive record/authority links; generate: create authorities from catalogue headings")
    args = parser.parse_args(argv)
    if (rc := ops_dispatch(args)) is not None:
        return rc
    if args.cmd == "authorities":
        from .db import create_all, session_scope
        from .services import authorities

        create_all()
        with session_scope() as db:
            out = authorities.relink_all(db) if args.action == "relink" else authorities.generate_from_catalogue(db)
        print(json.dumps({k: v for k, v in out.items() if k != "sample"}, default=str))
        return 0

    from .db import create_all, drop_all, session_scope

    if args.cmd in ("init-db", "migrate"):
        from .migrations import upgrade

        print(json.dumps(upgrade()))
    elif args.cmd == "makemigration":
        from .migrations import make_migration

        print(make_migration(args.message) or "No changes detected.")
    elif args.cmd == "reset":
        from sqlalchemy import text

        from .db import get_engine
        from .migrations import upgrade

        drop_all()
        with get_engine().begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS alembic_version"))
        upgrade()
        print("Database reset.")
    elif args.cmd == "seed":
        from .seed import seed

        create_all()
        with session_scope() as db:
            stats = seed(db, patrons=args.patrons)
        print("Demo data loaded:", json.dumps(stats))
        print("Demo logins: admin / Librowise#Admin2026 · librarian / Librowise#Staff2026 · 1000000001 / Reader#Demo2026")
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
    elif args.cmd == "reset-2fa":
        from .services import audit, identity

        with session_scope() as db:
            user = identity.find_account(db, args.username)
            if user is None:
                print("No active account matches.", file=sys.stderr)
                return 1
            identity.disable_mfa(db, user)
            identity.unlock(user)
            n = identity.revoke_all_sessions(db, user)
            audit.record(db, "mfa_reset", "patron", user.id, via="cli", sessions_revoked=n)
        print(f"2FA removed, lockout cleared and {n} session(s) ended for {args.username}.")
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

        uvicorn.run("librowise.app:app", host=args.host, port=args.port, reload=args.reload, proxy_headers=True)
    elif args.cmd == "send-notices":
        import logging

        from .services.notices import deliver_pending

        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
        create_all()
        with session_scope() as db:
            print(json.dumps(deliver_pending(db, args.limit)))

    elif args.cmd == "sip2":
        import logging

        from .sip2.server import ServerConfig, run

        logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
        run(ServerConfig(host=args.host, port=args.port, delimiter=args.delimiter, encoding=args.encoding,
                         login_timeout=args.login_timeout, max_connections=args.max_connections,
                         certfile=args.certfile, keyfile=args.keyfile))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
