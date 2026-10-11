"""``librowise instance ...`` - create and manage library instances (the koha-create family).

See docs/INSTALL.md. Linux as root manages system instances (PostgreSQL, systemd, Caddy/nginx);
anywhere else (no root, macOS, Windows) the same commands manage user-mode SQLite instances whose
processes the tool starts itself.
"""

from __future__ import annotations

import argparse
import json
import sys

from .common import PRODUCT, PRODUCT_TITLE, PY_MODULE, InstanceError, Layout

CMD = "instance"


def _common(dry_run: bool = True) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(add_help=False)
    if dry_run:
        p.add_argument("--dry-run", action="store_true", help="Print every action without changing anything")
    return p


def add_parser(sub) -> None:
    p = sub.add_parser(CMD, help="Create and manage library instances (like koha-create, koha-list, ...)",
                       description=f"Create and manage {PRODUCT_TITLE} instances. As root on Linux: system "
                                   "instances with PostgreSQL, systemd and an HTTPS reverse proxy. Otherwise: "
                                   "user-mode SQLite instances.")
    isub = p.add_subparsers(dest="instance_cmd", required=True, metavar="ACTION")
    dry = _common()

    c = isub.add_parser("create", parents=[dry], help="Create (or repair) an instance - like koha-create")
    c.add_argument("name", help="Instance name: lowercase letters, digits and hyphens (e.g. 'central')")
    c.add_argument("--domain", help="Public host name, e.g. catalogue.example.org (required with a reverse proxy)")
    c.add_argument("--port", type=int, help="Local port for the web server (default: first free from 8100)")
    c.add_argument("--bind", default="127.0.0.1", help="Address the web server listens on (default 127.0.0.1)")
    c.add_argument("--db", choices=["postgres", "sqlite"],
                   help="Database (default: postgres as root on Linux, sqlite otherwise)")
    c.add_argument("--db-url", help="Use an existing database instead (SQLAlchemy URL); nothing is created")
    proxy = c.add_mutually_exclusive_group()
    proxy.add_argument("--proxy", choices=["caddy", "nginx"],
                       help="Reverse proxy to configure (default caddy, with automatic HTTPS)")
    proxy.add_argument("--no-proxy", dest="proxy", action="store_const", const="none",
                       help="Do not configure a reverse proxy")
    c.add_argument("--library-name",
                   help="Your library's name, shown in the catalogue and notices (asked for if omitted)")
    c.add_argument("--admin-email", help="E-mail of the first administrator (receives a reset link if SMTP is set)")
    c.add_argument("--admin-user", default="admin", help="Login of the first administrator (default admin)")
    c.add_argument("--timezone", help="Library time zone, e.g. Europe/London (default: the host's)")
    c.add_argument("--demo-data", action="store_true", help="Load the demo catalogue, patrons and loans")
    c.add_argument("--web-workers", type=int, help="Web server processes (default 2; 1 in user mode)")
    c.add_argument("--no-start", dest="start", action="store_false", help="Do not enable/start the services")
    c.add_argument("--credentials-file", help="Write the admin credentials to this file (0600) instead of printing them")

    isub.add_parser("list", help="List instances - like koha-list").add_argument(
        "--json", action="store_true", help="Machine-readable output")
    i = isub.add_parser("info", help="Show an instance's settings, paths and status")
    i.add_argument("name")
    i.add_argument("--json", action="store_true")

    for action, text in (("enable", "Enable at boot and start"), ("disable", "Stop and disable at boot")):
        e = isub.add_parser(action, parents=[dry], help=f"{text} (like koha-enable/koha-disable)")
        e.add_argument("name")
        e.add_argument("--sip2", action="store_true", help=f"{action.capitalize()} only the SIP2 server")
    for action, text in (("start", "Start"), ("stop", "Stop"), ("restart", "Restart")):
        s = isub.add_parser(action, parents=[dry], help=f"{text} an instance's processes (web, worker, SIP2)")
        s.add_argument("names", nargs="*", metavar="NAME")
        s.add_argument("--all", action="store_true", help="All instances")

    u = isub.add_parser("upgrade", parents=[dry],
                        help="Upgrade the application (optional), migrate the schema and restart - like koha-upgrade-schema")
    u.add_argument("names", nargs="*", metavar="NAME")
    u.add_argument("--all", action="store_true", help="All instances")
    src = u.add_mutually_exclusive_group()
    src.add_argument("--version", help=f"First install this release tag (e.g. v1.1.0) from {PRODUCT}'s git repository")
    src.add_argument("--source", help="First install from this source directory or wheel")
    u.add_argument("--no-backup", dest="backup", action="store_false", help="Skip the pre-upgrade backup")
    u.add_argument("--no-restart", dest="restart", action="store_false", help="Do not restart the processes")

    b = isub.add_parser("backup", parents=[dry], help="Back up an instance's database - like koha-run-backups")
    b.add_argument("names", nargs="*", metavar="NAME")
    b.add_argument("--all", action="store_true", help="All instances")

    r = isub.add_parser("remove", parents=[dry], help="Remove an instance - like koha-remove")
    r.add_argument("name")
    r.add_argument("--purge-data", action="store_true",
                   help="Also drop the database and delete the data, logs and env file (backups are kept)")
    r.add_argument("--purge-backups", action="store_true", help="With --purge-data: delete the backups too")
    r.add_argument("-y", "--yes", action="store_true", help="Do not ask for confirmation")

    d = isub.add_parser("doctor", help="Check database, migrations, processes, ports, TLS and disk")
    d.add_argument("name")

    sh = isub.add_parser("shell", help="Run a command (or a shell) with an instance's environment - like koha-shell")
    sh.add_argument("name")
    sh.add_argument("command", nargs=argparse.REMAINDER,
                    help=f"After --: a {PRODUCT} sub-command, e.g. `-- create-admin --username jdoe --email ...`")

    sv = isub.add_parser("serve", help="Run one instance process in the foreground (containers, debugging)")
    sv.add_argument("name")
    sv.add_argument("component", nargs="?", default="web", choices=["web", "worker", "sip2"])

    # Internal: executed by the tool inside an instance's environment.
    isub.add_parser("_probe")
    ba = isub.add_parser("_bootstrap-admin")
    ba.add_argument("--username", required=True)
    ba.add_argument("--email", required=True)
    ln = isub.add_parser("_set-library-name")
    ln.add_argument("library_name")


def make_manager(dry_run: bool = False):
    from .manager import Manager
    from .system import System

    system = System(dry_run=dry_run)
    layout = Layout.for_system() if (system.is_linux and system.is_root()) else Layout.for_user()
    return Manager(layout, system)


def dispatch(args: argparse.Namespace) -> int:
    cmd = args.instance_cmd
    if cmd == "_probe":
        from .bootstrap import probe

        print(json.dumps(probe(), default=str))
        return 0
    if cmd == "_set-library-name":
        from .bootstrap import set_library_name

        print(json.dumps(set_library_name(args.library_name)))
        return 0
    if cmd == "_bootstrap-admin":
        from .bootstrap import bootstrap_admin

        print(json.dumps(bootstrap_admin(args.username, args.email)))
        return 0
    try:
        return _dispatch(args)
    except InstanceError as exc:
        print(f"{PRODUCT}: error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


def _dispatch(args: argparse.Namespace) -> int:
    from .manager import CreateOptions

    cmd = args.instance_cmd
    dry = getattr(args, "dry_run", False)
    m = make_manager(dry)
    if dry:
        print(f"Dry run ({m.layout.mode} mode, {m.backend()} services): nothing will be changed.")

    if cmd == "create":
        opts = CreateOptions(
            name=args.name, domain=args.domain, port=args.port, bind=args.bind, db=args.db, db_url=args.db_url,
            proxy=args.proxy, library_name=_library_name(args, m), admin_email=args.admin_email, admin_user=args.admin_user, timezone=args.timezone,
            demo_data=args.demo_data, start=args.start, web_workers=args.web_workers,
            credentials_file=args.credentials_file)
        res = m.create(opts)
        _print_created(m, res, args, dry)
        return 0
    if cmd == "list":
        return _list(m, args.json)
    if cmd == "info":
        return _info(m, args.name, args.json)
    if cmd == "enable":
        m.enable(args.name, sip2=args.sip2)
        return 0
    if cmd == "disable":
        m.disable(args.name, sip2=args.sip2)
        return 0
    if cmd in ("start", "stop", "restart"):
        names = m.names(args.names, args.all)
        {"start": m.start, "stop": m.stop, "restart": m.restart}[cmd](names)
        if cmd != "stop":
            for n in names:
                print(f"{n}: " + ", ".join(f"{k} {v}" for k, v in m.status(n).items()))
        return 0
    if cmd == "upgrade":
        m.upgrade(m.names(args.names, args.all), version=args.version, source=args.source, backup=args.backup,
                  restart=args.restart)
        return 0
    if cmd == "backup":
        m.backup(m.names(args.names, args.all))
        return 0
    if cmd == "remove":
        if args.purge_backups and not args.purge_data:
            raise InstanceError("--purge-backups requires --purge-data")
        if args.purge_data and not (args.yes or dry):
            if not sys.stdin.isatty():
                raise InstanceError("--purge-data deletes the database and files permanently; add --yes to confirm")
            try:
                answer = input(f"This permanently deletes the database and data of '{args.name}'. "
                               f"Type the instance name to confirm: ")
            except EOFError:
                raise InstanceError("no confirmation received; add --yes to confirm --purge-data")
            if answer.strip() != args.name:
                print("Aborted.")
                return 1
        m.remove(args.name, purge_data=args.purge_data, purge_backups=args.purge_backups)
        return 0
    if cmd == "doctor":
        checks = m.doctor(args.name)
        for ch in checks:
            print(f"[{ch.status:^4}] {ch.message}")
        failed = sum(ch.status == "FAIL" for ch in checks)
        print(f"{args.name}: {'healthy' if not failed else f'{failed} problem(s) found'}")
        return 1 if failed else 0
    if cmd == "shell":
        return _shell(m, args.name, args.command)
    if cmd == "serve":
        m.get(args.name)
        values = m.env_values(args.name)
        cmd_ = m.as_service_user(m.component_command(args.name, args.component, values))
        return m.sys.exec_foreground(cmd_, env=m.child_env(args.name, values), cwd=m.layout.data_dir(args.name))
    raise InstanceError(f"unknown action {cmd}")


def _library_name(args: argparse.Namespace, m) -> str | None:
    """The library's name: from --library-name, else asked for interactively when creating a new instance.

    There is deliberately no built-in default; repairing an existing instance keeps its current name.
    """
    from .common import validate_name

    validate_name(args.name)  # report a bad instance name before asking anything
    name = " ".join((args.library_name or "").split())
    if name:
        return name
    if m.load_registry()["instances"].get(args.name):
        return None
    if sys.stdin.isatty() and not getattr(args, "dry_run", False):
        while not name:
            try:
                name = " ".join(input("Library name (shown in the catalogue and notices): ").split())
            except EOFError:
                break
        if name:
            return name
    if args.demo_data:
        return None  # the demo data names it "Demo Library"
    raise InstanceError("give your library's name with --library-name \"...\" (it is shown in the catalogue and notices)")


def _print_created(m, res, args, dry: bool) -> None:
    L, name = m.layout, res.name
    if dry:
        print(f"\nDry run complete: {len(m.sys.actions)} action(s) would be performed for instance '{name}'.")
        return
    entry = m.get(name)
    print()
    print(f"{PRODUCT_TITLE} instance '{name}' is ready.")
    print(f"  URL:       {res.url}" + (f"   (local: {res.local_url})" if res.local_url != res.url else ""))
    print(f"  Config:    {L.env_file(name)}")
    print(f"  Data:      {L.data_dir(name)}")
    print(f"  Backups:   {L.backup_dir(name)}  (nightly at 01:15 by the worker)")
    print(f"  Logs:      {L.log_dir(name)}")
    print(f"  Services:  {m.backend()} - " + ", ".join(m.components(entry)))
    admin = res.admin or {}
    if admin.get("created"):
        if admin.get("emailed"):
            print(f"  Admin:     {admin['username']} - a password-reset link was e-mailed to {admin['email']}")
        elif args.credentials_file:
            print(f"  Admin:     {admin['username']} - password written to {args.credentials_file}")
        else:
            print(f"  Admin:     {admin['username']} / {admin['password']}")
            print("             (shown once - sign in and change it under My account)")
    elif admin.get("reason"):
        print(f"  Admin:     not created ({admin['reason']})")
    if entry.get("demo_data"):
        print("  Demo data: admin / Librowise#Admin2026 - demo passwords are public; do not use in production")
    if entry.get("proxy") == "nginx":
        print(f"  HTTPS:     sudo certbot --nginx -d {entry['domain']}  (see the comment in the nginx site)")
    if admin.get("created") and not entry.get("demo_data"):
        print(f"  Next:      sign in at {res.url.rstrip('/')}/staff - the setup wizard adds branches and lending rules")
    print(f"Check it:   {PRODUCT} instance doctor {name}")


def _list(m, as_json: bool) -> int:
    reg = m.load_registry()["instances"]
    if as_json:
        print(json.dumps(reg, indent=2, sort_keys=True))
        return 0
    if not reg:
        print(f"No instances. Create one with `{PRODUCT} instance create NAME`.")
        _hint_system(m)
        return 0
    print(f"{'NAME':<20} {'STATUS':<10} {'DB':<9} {'PORT':<6} URL")
    for name, e in sorted(reg.items()):
        st = m.status(name, e)
        state = "running" if all(v == "active" for v in st.values()) else (
            "partial" if any(v == "active" for v in st.values()) else ("stopped" if e.get("enabled", True) else "disabled"))
        print(f"{name:<20} {state:<10} {e.get('db', '?'):<9} {e.get('port', ''):<6} {e.get('url', '')}")
    return 0


def _hint_system(m) -> None:
    if m.layout.mode == "user" and m.sys.is_linux:
        sysreg = Layout.for_system().registry
        if sysreg.exists():
            print(f"System instances are registered in {sysreg}; run with sudo to manage them.")


def _info(m, name: str, as_json: bool) -> int:
    e = m.get(name)
    L = m.layout
    info = {**e, "mode": L.mode, "env_file": str(L.env_file(name)), "data_dir": str(L.data_dir(name)),
            "backup_dir": str(L.backup_dir(name)), "log_dir": str(L.log_dir(name)), "services": m.backend(),
            "status": m.status(name, e), "health_url": m.health_url(name, e)}
    if as_json:
        print(json.dumps(info, indent=2, sort_keys=True, default=str))
        return 0
    for k in ("name", "url", "domain", "proxy", "db", "bind", "port", "sip2", "sip2_port", "enabled", "mode",
              "services", "status", "env_file", "data_dir", "backup_dir", "log_dir", "health_url", "created", "updated"):
        print(f"{k + ':':<12} {info.get(k)}")
    return 0


def _shell(m, name: str, command: list[str]) -> int:
    import os
    from pathlib import Path

    m.get(name)
    values = m.env_values(name)
    env = m.child_env(name, values)
    env["PATH"] = os.pathsep.join([str(Path(m.python).parent), env.get("PATH", "")])
    if command and command[0] == "--":
        command = command[1:]
    if command:
        cmd = m.as_service_user(m.app_cmd(*command))
    elif m.sys.is_windows:
        cmd = [os.environ.get("COMSPEC", "cmd.exe")]
    else:
        cmd = m.as_service_user(["/bin/bash"] if m.layout.system else [os.environ.get("SHELL", "/bin/sh")])
        print(f"Shell with instance '{name}' settings (exit to leave). Run `python -m {PY_MODULE} ...` for commands.")
    return m.sys.exec_foreground(cmd, env=env, cwd=m.layout.data_dir(name))
