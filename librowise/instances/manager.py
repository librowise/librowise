"""Instance lifecycle: create, list, info, enable/disable, start/stop, upgrade, backup, remove, doctor.

One *instance* is one library: its own database, env file, data/backup/log directories, port,
processes (web, worker, optional SIP2) and reverse-proxy site - the same model as Koha's
``koha-create``. All side effects go through :class:`~.system.System`.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import render
from .common import (
    COMPONENTS,
    DIST_NAME,
    ENV_PREFIX,
    LEGACY_ENV_PREFIX,
    PRODUCT,
    PRODUCT_TITLE,
    PY_MODULE,
    REPO_URL,
    SERVICE_GROUP,
    SERVICE_USER,
    SIP2_PORT_RANGE,
    VAR_PREFIX,
    WEB_PORT_RANGE,
    InstanceError,
    Layout,
    db_identifier,
    detect_timezone,
    parse_env,
    validate_bind,
    validate_domain,
    validate_email,
    validate_name,
    validate_port,
    validate_timezone,
    with_legacy_keys,
)
from .system import System

PACKAGED_MARKER = ".installed-by-dpkg"  # in the prefix of a Debian-package installation


@dataclass
class CreateOptions:
    name: str
    domain: str | None = None
    port: int | None = None
    bind: str = "127.0.0.1"
    db: str | None = None  # postgres | sqlite (default: postgres in system mode, sqlite otherwise)
    db_url: str | None = None
    proxy: str | None = None  # caddy | nginx | none (default: caddy in system mode, none otherwise)
    admin_email: str | None = None
    admin_user: str = "admin"
    timezone: str | None = None
    demo_data: bool = False
    start: bool = True
    web_workers: int | None = None
    credentials_file: str | None = None


@dataclass
class Check:
    status: str  # OK | WARN | FAIL | INFO
    message: str


@dataclass
class CreateResult:
    name: str
    url: str
    local_url: str
    admin: dict = field(default_factory=dict)
    created: bool = True


def _utcnow() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def connect_host(bind: str) -> str:
    if bind in ("0.0.0.0", ""):
        return "127.0.0.1"
    if bind == "::":
        return "::1"
    return bind


def _url_host(host: str) -> str:
    return f"[{host}]" if ":" in host else host


class Manager:
    def __init__(self, layout: Layout, system: System | None = None, *, python: str | None = None):
        self.layout = layout
        self.sys = system or System()
        self.python = python or sys.executable
        # --dry-run never writes, so the plan keeps the registry and env files it *would* write here.
        self._dry_registry: dict | None = None
        self._dry_env: dict[str, dict[str, str]] = {}

    # ================================================================ registry
    def load_registry(self) -> dict:
        if self.sys.dry_run and self._dry_registry is not None:
            return json.loads(json.dumps(self._dry_registry))
        text = self.sys.read_text(self.layout.registry)
        if not text:
            return {"version": 1, "instances": {}}
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise InstanceError(f"{self.layout.registry} is not valid JSON: {exc}") from exc
        data.setdefault("instances", {})
        return data

    def save_registry(self, reg: dict) -> None:
        if self.sys.dry_run:
            self._dry_registry = json.loads(json.dumps(reg))
        self.sys.write(self.layout.registry, json.dumps(reg, indent=2, sort_keys=True) + "\n", mode=0o644)

    def get(self, name: str) -> dict:
        validate_name(name)
        entry = self.load_registry()["instances"].get(name)
        if entry is None:
            raise InstanceError(f"no instance named {name!r} (see `{PRODUCT} instance list`)")
        return entry

    def names(self, names: list[str] | None, all_: bool) -> list[str]:
        if all_:
            found = sorted(self.load_registry()["instances"])
            if not found:
                raise InstanceError("no instances exist yet")
            return found
        if not names:
            raise InstanceError("name an instance or pass --all")
        for n in names:
            self.get(n)
        return names

    @staticmethod
    def used_ports(reg: dict, exclude: str | None = None) -> set[int]:
        ports: set[int] = set()
        for n, e in reg["instances"].items():
            if n != exclude:
                ports.update(p for p in (e.get("port"), e.get("sip2_port")) if p)
        return ports

    def allocate_port(self, reg: dict, bind: str, rng: tuple[int, int], *, exclude: str | None = None,
                      also_taken: set[int] | frozenset = frozenset()) -> int:
        taken = self.used_ports(reg, exclude) | set(also_taken)
        for port in range(rng[0], rng[1] + 1):
            if port not in taken and self.sys.port_free(bind, port):
                return port
        raise InstanceError(f"no free port in {rng[0]}-{rng[1]}; pass --port")

    # ================================================================ environment & processes
    def env_values(self, name: str) -> dict[str, str]:
        if self.sys.dry_run and name in self._dry_env:
            return dict(self._dry_env[name])
        text = self.sys.read_text(self.layout.env_file(name))
        if text is None:
            raise InstanceError(f"{self.layout.env_file(name)} is missing")
        return with_legacy_keys(parse_env(text))

    def child_env(self, name: str, values: dict[str, str] | None = None) -> dict[str, str]:
        """Process environment for an instance: the caller's minus any settings, plus the env file."""
        base = {k: v for k, v in self.sys.environ().items()
                if not k.startswith((ENV_PREFIX, VAR_PREFIX, LEGACY_ENV_PREFIX)) and k != "ANTHROPIC_API_KEY"}
        if values is None and self.sys.dry_run and not self.sys.exists(self.layout.env_file(name)):
            values = self._dry_env.get(name, {})
        base.update(values if values is not None else self.env_values(name))
        base.update({"PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"})
        src = _source_root()
        if src:  # running from a source checkout (not installed): children must import the same code
            base["PYTHONPATH"] = os.pathsep.join(filter(None, [str(src), base.get("PYTHONPATH", "")]))
        return base

    def as_service_user(self, cmd: list[str]) -> list[str]:
        if self.layout.system and self.sys.is_root():
            return ["runuser", "-u", SERVICE_USER, "--", *cmd]
        return cmd

    def app_cmd(self, *args: str) -> list[str]:
        return [self.python, "-m", PY_MODULE, *args]

    def run_app(self, name: str, *args: str, check: bool = True, capture: bool = True, mutate: bool = True,
                describe: str | None = None, values: dict | None = None):
        return self.sys.run(self.as_service_user(self.app_cmd(*args)), env=self.child_env(name, values),
                            cwd=self._cwd(name), check=check, capture=capture, mutate=mutate,
                            describe=describe or f"{PRODUCT} {' '.join(args)}  (instance {name})")

    def _cwd(self, name: str) -> Path | None:
        d = self.layout.data_dir(name)
        return d if d.is_dir() else None

    def backend(self) -> str:
        return "systemd" if self.layout.system and self.sys.has_systemd() else "process"

    @staticmethod
    def components(entry: dict) -> list[str]:
        return ["web", "worker"] + (["sip2"] if entry.get("sip2") else [])

    def _owner(self) -> tuple[str | None, str | None]:
        return (SERVICE_USER, SERVICE_GROUP) if self.layout.system else (None, None)

    # ================================================================ create
    def _resolve_defaults(self, o: CreateOptions) -> CreateOptions:
        validate_name(o.name)
        o.domain = validate_domain(o.domain)
        o.admin_email = validate_email(o.admin_email)
        o.bind = validate_bind(o.bind or "127.0.0.1")
        if o.port is not None:
            validate_port(o.port)
        o.timezone = validate_timezone(o.timezone) if o.timezone else detect_timezone()
        if o.db_url:
            if o.db not in (None, "external", "postgres", "sqlite"):
                raise InstanceError("--db-url cannot be combined with this --db value")
            o.db = "external"
        o.db = o.db or ("postgres" if self.layout.system else "sqlite")
        if o.proxy is None and o.domain and not self.layout.system:
            o.proxy = "caddy"  # a domain means "publish it": fail below unless --no-proxy says otherwise
        o.proxy = o.proxy or ("caddy" if self.layout.system else "none")
        if self.sys.is_windows or not self.layout.system:
            where = "on Windows" if self.sys.is_windows else "without root"
            if o.db == "postgres":
                raise InstanceError(f"--db postgres creates a PostgreSQL role and database, which is not supported {where}"
                                    + ("" if self.sys.is_windows else " (run with sudo)")
                                    + "; use --db sqlite, or --db-url for an existing database")
            if o.proxy != "none":
                raise InstanceError(f"reverse-proxy setup (Caddy/nginx with HTTPS) is Linux-only and needs root; it is "
                                    f"not available {where}. Pass --no-proxy")
        if o.proxy != "none" and not o.domain:
            raise InstanceError("--domain is required to configure the reverse proxy (or pass --no-proxy)")
        if o.proxy != "none" and o.bind not in ("127.0.0.1", "::1", "localhost"):
            raise InstanceError("behind a reverse proxy the web server binds to 127.0.0.1; drop --bind or pass --no-proxy")
        if o.web_workers is None:
            o.web_workers = 1 if (self.sys.is_windows or not self.layout.system) else 2
        return o

    def _urls(self, o: CreateOptions, port: int) -> tuple[str, str]:
        local = f"http://{_url_host(connect_host(o.bind))}:{port}"
        if o.proxy == "caddy":
            return f"https://{o.domain}", local
        if o.proxy == "nginx":
            return f"http://{o.domain}", local
        return local, local

    def create(self, o: CreateOptions) -> CreateResult:
        validate_name(o.name)
        reg = self.load_registry()
        entry = reg["instances"].get(o.name)
        if entry:  # re-run: explicit options must agree with the instance, the rest come from it
            self._check_conflicts(entry, o)
            o.domain = o.domain or entry.get("domain")
            o.proxy = o.proxy or entry.get("proxy")
            o.db = o.db or entry.get("db")
            o.bind = entry.get("bind", o.bind)
            o.admin_email = o.admin_email or entry.get("admin_email")
        o = self._resolve_defaults(o)
        name, L = o.name, self.layout
        env_path = L.env_file(name)
        existing_env = with_legacy_keys(parse_env(self.sys.read_text(env_path) or ""))             if self.sys.exists(env_path) else None
        if existing_env is not None and existing_env.get(f"{VAR_PREFIX}INSTANCE", name) != name:
            raise InstanceError(f"{env_path} belongs to another instance")
        if entry:
            self.sys.say(f"Instance '{name}' already exists - verifying and repairing its configuration.")
        elif existing_env is not None:
            self.sys.say(f"Found {env_path} without a registry entry - re-adopting instance '{name}'.")
        else:
            self.sys.say(f"Creating {PRODUCT_TITLE} instance '{name}' ({L.mode} mode, "
                         f"{o.db} database, {'no proxy' if o.proxy == 'none' else o.proxy}).")
        if L.system and not self.sys.is_root() and not self.sys.dry_run:
            raise InstanceError("system-wide instances must be created as root (use sudo)")

        # ---- ports
        if entry:
            port, sip2_port = entry["port"], entry.get("sip2_port") or 0
        elif existing_env is not None and existing_env.get(f"{VAR_PREFIX}PORT"):
            port = int(existing_env[f"{VAR_PREFIX}PORT"])
            sip2_port = int(existing_env.get(f"{VAR_PREFIX}SIP2_PORT") or 0)
        else:
            if o.port:
                if o.port in self.used_ports(reg):
                    raise InstanceError(f"port {o.port} is already assigned to another instance")
                if not self.sys.port_free(o.bind, o.port):
                    raise InstanceError(f"port {o.port} on {o.bind} is in use by another program")
                port = o.port
            else:
                port = self.allocate_port(reg, o.bind, WEB_PORT_RANGE)
            sip2_port = 0
        if not sip2_port:
            sip2_port = self.allocate_port(reg, "127.0.0.1", SIP2_PORT_RANGE, exclude=name, also_taken={port})

        # ---- base layout and service account
        self._ensure_base()
        owner, group = self._owner()
        data_dir, log_dir, backup_dir = L.data_dir(name), L.log_dir(name), L.backup_dir(name)
        self.sys.mkdir(data_dir, mode=0o750, owner=owner, group=group)
        self.sys.mkdir(data_dir / "cache", mode=0o750, owner=owner, group=group)
        self.sys.mkdir(backup_dir, mode=0o750, owner=owner, group=group)
        self.sys.mkdir(log_dir, mode=0o750, owner="root" if L.system else None, group=group)

        # ---- database
        pg_managed = False
        if existing_env is not None and existing_env.get(f"{ENV_PREFIX}DATABASE_URL"):
            database_url = existing_env[f"{ENV_PREFIX}DATABASE_URL"]
            if o.db == "postgres" and database_url.startswith("postgresql") and (entry or {}).get("db") != "external":
                pg_managed = True
                self._ensure_postgres(name, _password_from_url(database_url))
        elif o.db == "sqlite":
            database_url = f"sqlite:///{(data_dir / f'{PRODUCT}.db').as_posix()}"
        elif o.db == "external":
            database_url = o.db_url or ""
        else:
            pg_managed = True
            password = secrets.token_urlsafe(32)
            pg_port = self._ensure_postgres(name, password)
            ident = db_identifier(name)
            database_url = f"postgresql+psycopg://{ident}:{password}@localhost:{pg_port}/{ident}"

        # ---- env file
        public_url, local_url = self._urls(o, port)
        hosts = ["*"]
        if o.domain:
            hosts = [o.domain, "localhost", "127.0.0.1"]
            if connect_host(o.bind) not in hosts:
                hosts.append(connect_host(o.bind))
        spec = render.EnvSpec(
            name=name, bind=o.bind, port=port, sip2_port=sip2_port, database_url=database_url,
            secret_key=secrets.token_urlsafe(64), metrics_token=secrets.token_urlsafe(32), public_url=public_url,
            allowed_hosts=hosts, cookie_secure=o.proxy == "caddy", timezone=o.timezone,
            backup_dir=str(backup_dir), cache_dir=str(data_dir / "cache"), web_workers=o.web_workers,
            postgres=database_url.startswith("postgresql"),
        )
        self._write_env(name, spec, existing_env)
        values = render.env_values(spec) if existing_env is None else {**render.env_values(spec), **existing_env}
        if self.sys.dry_run:
            self._dry_env[name] = values

        # ---- registry (before slow steps, so a failure leaves a removable instance)
        now = _utcnow()
        entry = {
            **(entry or {}),
            "name": name, "port": port, "sip2_port": sip2_port, "bind": o.bind, "domain": o.domain,
            "proxy": o.proxy if not entry else entry.get("proxy", o.proxy),
            "db": "postgres" if pg_managed else ("sqlite" if database_url.startswith("sqlite") else "external"),
            "url": public_url if not entry else entry.get("url", public_url),
            "created": (entry or {}).get("created", now), "updated": now,
            "enabled": (entry or {}).get("enabled", True), "sip2": (entry or {}).get("sip2", False),
            "admin_email": o.admin_email or (entry or {}).get("admin_email"),
        }
        reg["instances"][name] = entry
        self.save_registry(reg)

        # ---- schema, demo data, first administrator
        self.sys.say("Applying database migrations...")
        self.run_app(name, "migrate", values=values)
        if o.demo_data and not entry.get("demo_data"):
            self.sys.say("Loading demo data...")
            self.run_app(name, "seed", values=values)
            entry["demo_data"] = True
            self.save_registry(reg)
        admin = self._bootstrap_admin(name, o, values)

        # ---- services, proxy, log rotation
        self._install_units()
        if L.logrotate is not None and L.system:
            self.sys.write(L.logrotate, render.render_logrotate(L), mode=0o644)
        if o.proxy == "caddy":
            self._configure_caddy(name, o.domain, port, o.admin_email)
        elif o.proxy == "nginx":
            self._configure_nginx(name, o.domain, port)
        if o.start and entry.get("enabled", True):
            self.enable(name, quiet=True)
            self.start([name], restart=True)
        if o.credentials_file and admin.get("password"):
            self.sys.write(Path(o.credentials_file),
                           f"url={public_url}\nusername={admin['username']}\npassword={admin['password']}\n",
                           mode=0o600, secret=True)
        return CreateResult(name=name, url=entry["url"], local_url=local_url, admin=admin, created=existing_env is None)

    def _check_conflicts(self, entry: dict, o: CreateOptions) -> None:
        problems = []
        if o.port and o.port != entry.get("port"):
            problems.append(f"port {entry.get('port')} (requested {o.port})")
        if o.domain and o.domain != entry.get("domain"):
            problems.append(f"domain {entry.get('domain')} (requested {o.domain})")
        kind = entry.get("db")
        if o.db and kind and o.db != kind and not (o.db == "postgres" and kind == "external"):
            problems.append(f"database {kind} (requested {o.db})")
        if o.db_url and kind != "external":
            problems.append(f"database {kind} (requested --db-url)")
        if o.proxy and o.proxy != entry.get("proxy", o.proxy):
            problems.append(f"proxy {entry.get('proxy')} (requested {o.proxy})")
        if problems:
            raise InstanceError(f"instance '{o.name}' already exists with " + ", ".join(problems)
                                + f"; edit {self.layout.env_file(o.name)} or remove the instance first")

    def _ensure_base(self) -> None:
        L = self.layout
        if L.system:
            if not self.sys.user_exists(SERVICE_USER):
                nologin = "/usr/sbin/nologin"
                self.sys.run(["useradd", "--system", "--user-group", "--home-dir", str(L.data), "--no-create-home",
                              "--shell", nologin, "--comment", f"{PRODUCT_TITLE} ILS", SERVICE_USER])
            self.sys.mkdir(L.etc, mode=0o755)
            self.sys.mkdir(L.data, mode=0o755, owner=SERVICE_USER, group=SERVICE_GROUP)
            self.sys.mkdir(L.logs, mode=0o755)
            self.sys.mkdir(L.backups, mode=0o750, owner="root", group=SERVICE_GROUP)
        else:
            for d in (L.etc, L.data, L.logs, L.backups, L.run):
                self.sys.mkdir(d, mode=0o700)

    def _write_env(self, name: str, spec: render.EnvSpec, existing: dict | None) -> None:
        path = self.layout.env_file(name)
        mode, owner, group = (0o640, "root", SERVICE_GROUP) if self.layout.system else (0o600, None, None)
        if existing is None:
            self.sys.write(path, render.render_env(spec), mode=mode, owner=owner, group=group, secret=True)
            return
        # Keep the operator's edits and the existing secrets; only add keys introduced since.
        current = self.sys.read_text(path) or ""
        missing = {k: v for k, v in render.env_values(spec).items() if k not in existing}
        if missing:
            from .common import env_quote

            addition = "\n# --- Added by a newer `" + PRODUCT + " instance create`\n" + \
                "\n".join(f"{k}={env_quote(v)}" for k, v in missing.items()) + "\n"
            current = current.rstrip("\n") + "\n" + addition
        self.sys.write(path, current, mode=mode, owner=owner, group=group, secret=True)

    # ---------------------------------------------------------------- PostgreSQL
    def _psql(self, sql: str, *, mutate: bool = True, describe: str | None = None, check: bool = True):
        cmd = ["runuser", "-u", "postgres", "--", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt", "-d", "postgres",
               "-f", "-"]
        return self.sys.run(cmd, input=sql, mutate=mutate, describe=describe, check=check)

    def _pg_exists(self, catalog: str, column: str, value: str) -> bool:
        proc = self._psql(f"SELECT 1 FROM {catalog} WHERE {column} = {_sql_literal(value)};", mutate=False,
                          check=False)
        return proc.returncode == 0 and proc.stdout.strip() == "1"

    def _ensure_postgres(self, name: str, password: str) -> int:
        """Create (or repair) the instance's role and database; returns the server port."""
        if not self.sys.which("psql") and not self.sys.dry_run:
            raise InstanceError("PostgreSQL is not installed (apt install postgresql), or use --db sqlite / --db-url")
        ident = db_identifier(name)
        q = _sql_ident(ident)
        if self._pg_exists("pg_roles", "rolname", ident):
            self._psql(f"ALTER ROLE {q} WITH LOGIN PASSWORD {_sql_literal(password)};",
                       describe=f"psql: reset password of PostgreSQL role {ident} (from the instance env file)")
        else:
            self._psql(f"CREATE ROLE {q} WITH LOGIN PASSWORD {_sql_literal(password)};",
                       describe=f"psql: CREATE ROLE {ident} LOGIN PASSWORD '********'")
        if not self._pg_exists("pg_database", "datname", ident):
            self._psql(f"CREATE DATABASE {q} OWNER {q} ENCODING 'UTF8' TEMPLATE template0;",
                       describe=f"psql: CREATE DATABASE {ident} OWNER {ident}")
            self._psql(f"REVOKE CONNECT, TEMPORARY ON DATABASE {q} FROM PUBLIC;",
                       describe=f"psql: REVOKE CONNECT ON DATABASE {ident} FROM PUBLIC")
        proc = self._psql("SHOW port;", mutate=False, check=False)
        try:
            return int(proc.stdout.strip())
        except (ValueError, AttributeError):
            return 5432

    def _drop_postgres(self, name: str) -> None:
        q = _sql_ident(db_identifier(name))
        self._psql(f"DROP DATABASE IF EXISTS {q} WITH (FORCE);", describe=f"psql: DROP DATABASE {db_identifier(name)}")
        self._psql(f"DROP ROLE IF EXISTS {q};", describe=f"psql: DROP ROLE {db_identifier(name)}")

    # ---------------------------------------------------------------- admin
    def _bootstrap_admin(self, name: str, o: CreateOptions, values: dict) -> dict:
        email = o.admin_email or f"{o.admin_user}@{o.domain or 'localhost'}"
        proc = self.run_app(name, "instance", "_bootstrap-admin", "--username", o.admin_user, "--email", email,
                            values=values, describe=f"create the first administrator '{o.admin_user}' (if none exists)")
        return _last_json(proc.stdout) or {}

    # ---------------------------------------------------------------- systemd units
    def _vendor_units(self) -> bool:
        return any((d / render.unit_name("web")).exists() for d in self.layout.systemd_vendor_dirs)

    def _install_units(self) -> None:
        if not (self.layout.system and self.layout.systemd_dir):
            return
        if self._vendor_units():
            return  # shipped by the Debian package
        changed = False
        for unit, text in render.render_units(self.python, self.layout).items():
            changed |= self.sys.write(self.layout.systemd_dir / unit, text, mode=0o644)
        if changed and self.sys.has_systemd():
            self.sys.run(["systemctl", "daemon-reload"])

    def _systemctl(self, *args: str, check: bool = True, mutate: bool = True):
        return self.sys.run(["systemctl", *args], check=check, mutate=mutate)

    # ---------------------------------------------------------------- reverse proxies
    def _configure_caddy(self, name: str, domain: str, port: int, email: str | None) -> None:
        L = self.layout
        if not self.sys.which("caddy") and not self.sys.dry_run:
            raise InstanceError("Caddy is not installed (see docs/INSTALL.md), or pass --proxy nginx / --no-proxy")
        self.sys.mkdir(L.caddy_sites, mode=0o755)
        changed = self.sys.write(L.caddy_site(name), render.render_caddy_site(name, domain, port, email), mode=0o644)
        changed |= self._ensure_caddy_import()
        if changed:
            self.sys.run(["caddy", "validate", "--config", str(L.caddy_main), "--adapter", "caddyfile"],
                         describe="caddy validate (check the new site)")
            self._reload_proxy("caddy")

    def _ensure_caddy_import(self) -> bool:
        L = self.layout
        text = self.sys.read_text(L.caddy_main)
        line = render.caddy_import_line(L)
        if text is not None and line in text:
            return False
        if text is None or _is_stock_caddyfile(text):
            if text is not None:
                backup = L.caddy_main.with_name("Caddyfile.dpkg-orig")
                if not self.sys.exists(backup):
                    self.sys.write(backup, text, mode=0o644)
            return self.sys.write(L.caddy_main, render.render_caddy_main(L), mode=0o644)
        return self.sys.write(L.caddy_main, text.rstrip("\n") + f"\n\n# {PRODUCT_TITLE} instances\n{line}\n", mode=0o644)

    def _configure_nginx(self, name: str, domain: str, port: int) -> None:
        if not self.sys.which("nginx") and not self.sys.dry_run:
            raise InstanceError("nginx is not installed (apt install nginx), or use the default Caddy proxy")
        avail, enabled = self.layout.nginx_site(name)
        current = self.sys.read_text(avail)
        if current is not None and "managed by Certbot" in current:
            self.sys.say(f"  {avail} was edited by certbot - leaving it unchanged")
            changed = False
        else:
            changed = self.sys.write(avail, render.render_nginx_site(name, domain, port), mode=0o644)
        changed |= self.sys.symlink(avail, enabled)
        if changed:
            self.sys.run(["nginx", "-t"], describe="nginx -t (check the new site)")
            self._reload_proxy("nginx")

    def _reload_proxy(self, service: str) -> None:
        if self.sys.has_systemd():
            active = self._systemctl("is-active", "--quiet", service, check=False, mutate=False).returncode == 0
            self._systemctl("reload" if active else "restart", service)
        else:
            self.sys.say(f"  (no systemd: reload {service} yourself)")

    # ================================================================ services
    def enable(self, name: str, *, sip2: bool = False, quiet: bool = False) -> None:
        reg = self.load_registry()
        entry = reg["instances"].get(name) or self.get(name)
        entry["enabled"] = True
        if sip2:
            entry["sip2"] = True
        self.save_registry(reg)
        if self.backend() == "systemd":
            units = [f"{PRODUCT}@{name}.target"] + [render.unit_name(c, name) for c in self.components(entry)]
            self._systemctl("enable", *units)
        if not quiet:
            self.start([name])

    def disable(self, name: str, *, sip2: bool = False) -> None:
        reg = self.load_registry()
        entry = reg["instances"].get(name) or self.get(name)
        comps = ["sip2"] if sip2 else list(COMPONENTS)
        if sip2:
            entry["sip2"] = False
        else:
            entry["enabled"] = False
        self.save_registry(reg)
        if self.backend() == "systemd":
            units = [render.unit_name(c, name) for c in comps] + ([] if sip2 else [f"{PRODUCT}@{name}.target"])
            self._systemctl("disable", "--now", *units, check=False)
        else:
            for c in comps:
                self._proc_stop(name, c)

    def start(self, names: list[str], *, restart: bool = False, wait: bool = True) -> None:
        for name in names:
            entry = self.get(name)
            comps = self.components(entry)
            if self.backend() == "systemd":
                self._systemctl("restart" if restart else "start", *[render.unit_name(c, name) for c in comps])
            else:
                for c in comps:
                    if restart:
                        self._proc_stop(name, c)
                    self._proc_start(name, c)
            if wait and not self.sys.dry_run:
                self.wait_healthy(name, entry)

    def stop(self, names: list[str]) -> None:
        for name in names:
            self.get(name)
            if self.backend() == "systemd":
                self._systemctl("stop", *[render.unit_name(c, name) for c in COMPONENTS], check=False)
            else:
                for c in reversed(COMPONENTS):
                    self._proc_stop(name, c)

    def restart(self, names: list[str]) -> None:
        self.start(names, restart=True)

    def status(self, name: str, entry: dict | None = None) -> dict[str, str]:
        entry = entry or self.get(name)
        out = {}
        for c in self.components(entry):
            if self.backend() == "systemd":
                proc = self._systemctl("is-active", render.unit_name(c, name), check=False, mutate=False)
                out[c] = (proc.stdout or "").strip() or "unknown"
            else:
                out[c] = "active" if self.sys.pid_alive(self._read_pid(name, c)) else "inactive"
        return out

    def health_url(self, name: str, entry: dict | None = None, path: str = "/healthz") -> str:
        entry = entry or self.get(name)
        return f"http://{_url_host(connect_host(entry.get('bind', '127.0.0.1')))}:{entry['port']}{path}"

    def wait_healthy(self, name: str, entry: dict, timeout: float = 60.0) -> bool:
        url = self.health_url(name, entry)
        waited = 0.0
        while waited < timeout:
            status, _ = self.sys.http_get(url, timeout=3)
            if status == 200:
                self.sys.say(f"  {name}: web is up ({url})")
                return True
            self.sys.sleep(1.0)
            waited += 1.0
        self.sys.say(f"  {name}: web did not answer {url} within {timeout:.0f}s - check {self.layout.log_dir(name)}")
        return False

    # ---------------------------------------------------------------- process backend (no systemd)
    def _pidfile(self, name: str, component: str) -> Path:
        return self.layout.run / f"{name}-{component}.pid"

    def _read_pid(self, name: str, component: str) -> int:
        try:
            return int((self.sys.read_text(self._pidfile(name, component)) or "0").strip() or 0)
        except ValueError:
            return 0

    def component_command(self, name: str, component: str, values: dict[str, str] | None = None) -> list[str]:
        values = values if values is not None else self.env_values(name)

        def var(key: str) -> str:
            v = values.get(VAR_PREFIX + key)
            if v is None:
                raise InstanceError(f"{VAR_PREFIX}{key} is missing from {self.layout.env_file(name)}")
            return v

        return render.component_argv(component, self.python, var)

    def _proc_start(self, name: str, component: str) -> None:
        pid = self._read_pid(name, component)
        if self.sys.pid_alive(pid):
            self.sys.say(f"  {name}-{component} already running (pid {pid})")
            return
        self.sys.mkdir(self.layout.run, mode=0o755 if self.layout.system else 0o700)
        values = self.env_values(name)
        cmd = self.as_service_user(self.component_command(name, component, values))
        pid = self.sys.spawn(cmd, env=self.child_env(name, values), cwd=self.layout.data_dir(name),
                             log=self.layout.log_dir(name) / f"{component}.log",
                             describe=f"start {name}-{component} in the background")
        if pid:
            self.sys.write(self._pidfile(name, component), f"{pid}\n", mode=0o644)

    def _proc_stop(self, name: str, component: str) -> None:
        pid = self._read_pid(name, component)
        if pid and self.sys.pid_alive(pid):
            self.sys.terminate(pid, describe=f"stop {name}-{component} (pid {pid})")
        self.sys.remove_file(self._pidfile(name, component))

    # ================================================================ upgrade & backup
    def packaged(self) -> bool:
        return (self.layout.prefix / PACKAGED_MARKER).exists() or (Path(sys.prefix).parent / PACKAGED_MARKER).exists()

    def upgrade(self, names: list[str], *, version: str | None = None, source: str | None = None,
                backup: bool = True, restart: bool = True) -> None:
        if version or source:
            if self.packaged():
                raise InstanceError(f"{PRODUCT_TITLE} was installed from the Debian package - upgrade it with "
                                    f"`apt install ./{PRODUCT}_<version>_<arch>.deb` (or apt upgrade), then run "
                                    f"`{PRODUCT} instance upgrade --all`")
            if source:
                p = Path(source)
                spec = f"{p.resolve()}[postgres]" if p.is_dir() else str(p.resolve()) if p.exists() else source
            else:
                spec = f"{DIST_NAME}[postgres] @ git+{REPO_URL}@{version}"
            self.sys.say(f"Upgrading the application in {sys.prefix}...")
            self.sys.run([self.python, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check", spec],
                         capture=False)
        for name in names:
            self.get(name)
            self.sys.say(f"Upgrading instance '{name}'...")
            if backup:
                self.backup([name])
            self.run_app(name, "migrate", capture=False)
            if restart:
                self.start([name], restart=True)

    def backup(self, names: list[str]) -> None:
        for name in names:
            self.get(name)
            self.run_app(name, "backup", capture=False, describe=f"{PRODUCT} backup  (instance {name})")

    # ================================================================ remove
    def safe_instance_dir(self, path: Path, name: str) -> Path:
        """Refuse to delete anything that is not exactly <instance root>/<name> (no symlinks)."""
        p = Path(path)
        if p.is_symlink():
            raise InstanceError(f"refusing to delete {p}: it is a symbolic link")
        rp = p.resolve()
        if rp.name != name:
            raise InstanceError(f"refusing to delete {p}: not an instance directory")
        roots = {r.resolve() for r in self.layout.instance_roots()}
        if rp.parent not in roots or rp in roots or len(rp.parts) < 3:
            raise InstanceError(f"refusing to delete {p}: outside the {PRODUCT} data directories")
        return rp

    def remove(self, name: str, *, purge_data: bool = False, purge_backups: bool = False) -> None:
        validate_name(name)
        L = self.layout
        reg = self.load_registry()
        entry = reg["instances"].get(name)
        if entry is None and not self.sys.exists(L.env_file(name)):
            raise InstanceError(f"no instance named {name!r}")
        entry = entry or {"name": name, "port": 0}
        self.sys.say(f"Removing instance '{name}'{' and all its data' if purge_data else ''}...")
        # 1. processes
        if self.backend() == "systemd":
            units = [render.unit_name(c, name) for c in COMPONENTS] + [f"{PRODUCT}@{name}.target"]
            self._systemctl("disable", "--now", *units, check=False)
        else:
            for c in COMPONENTS:
                self._proc_stop(name, c)
        # 2. reverse proxy
        if L.caddy_sites and self.sys.exists(L.caddy_site(name)):
            self.sys.remove_file(L.caddy_site(name))
            if self.sys.which("caddy"):
                self._reload_proxy("caddy")
        site = L.nginx_site(name)
        if site and any(self.sys.exists(p) for p in site):
            for p in reversed(site):
                self.sys.remove_file(p)
            if self.sys.which("nginx"):
                self._reload_proxy("nginx")
        # 3. data
        if purge_data:
            env = parse_env(self.sys.read_text(L.env_file(name)) or "")
            url = env.get(f"{ENV_PREFIX}DATABASE_URL", "")
            if entry.get("db") == "postgres" and url.startswith("postgresql"):
                self._drop_postgres(name)
            for d in (L.data_dir(name), L.log_dir(name)) + ((L.backup_dir(name),) if purge_backups else ()):
                if self.sys.exists(d):
                    self.sys.remove_tree(self.safe_instance_dir(d, name))
            self.sys.remove_file(L.env_file(name))
        reg["instances"].pop(name, None)
        self.save_registry(reg)
        if purge_data:
            kept = [] if purge_backups else [str(L.backup_dir(name))]
            self.sys.say(f"Instance '{name}' removed with its data." +
                         (f" Backups kept in {kept[0]}." if kept and self.sys.exists(Path(kept[0])) else ""))
        else:
            self.sys.say(f"Instance '{name}' removed. Data kept: {L.env_file(name)}, {L.data_dir(name)}"
                         + (", the PostgreSQL database" if entry.get("db") == "postgres" else "")
                         + f" and {L.backup_dir(name)}. Re-create it with `{PRODUCT} instance create {name}`"
                         f" or delete everything with `{PRODUCT} instance remove {name} --purge-data`.")

    # ================================================================ doctor
    def probe(self, name: str) -> dict:
        proc = self.run_app(name, "instance", "_probe", check=False, mutate=False)
        data = _last_json(proc.stdout)
        if data is None:
            return {"database": False, "error": ((proc.stderr or "") + (proc.stdout or "")).strip()[-300:]
                    or f"exit status {proc.returncode}"}
        return data

    def doctor(self, name: str) -> list[Check]:
        L = self.layout
        checks: list[Check] = []
        entry = self.get(name)
        env_path = L.env_file(name)
        # configuration
        if not self.sys.exists(env_path):
            return [Check("FAIL", f"env file {env_path} is missing")]
        checks.append(Check("OK", f"configuration {env_path}"))
        if L.system and not self.sys.is_windows:
            st = env_path.stat()
            if st.st_mode & 0o007:
                checks.append(Check("FAIL", f"{env_path} is readable by everyone (chmod 0640 it)"))
        values = self.env_values(name)
        if values.get(f"{ENV_PREFIX}SECRET_KEY", "") in ("", "change-me", "dev-only-change-me"):
            checks.append(Check("FAIL", f"{ENV_PREFIX}SECRET_KEY is not set"))
        # database & migrations
        p = self.probe(name)
        if p.get("database"):
            checks.append(Check("OK", "database reachable"))
            rev, head = p.get("revision"), p.get("head")
            if rev and rev == head:
                checks.append(Check("OK", f"schema at migration head ({head})"))
            else:
                checks.append(Check("FAIL", f"schema at {rev or 'nothing'}, code expects {head} - run "
                                            f"`{PRODUCT} instance upgrade {name}`"))
            if p.get("admins") == 0:
                checks.append(Check("WARN", f"no administrator account - `{PRODUCT} instance shell {name} -- "
                                            f"create-admin --username admin --email you@example.org`"))
        else:
            checks.append(Check("FAIL", f"database unreachable: {p.get('error', 'unknown error')}"))
        # services
        for comp, state in self.status(name, entry).items():
            ok = state == "active"
            checks.append(Check("OK" if ok else ("WARN" if not entry.get("enabled", True) else "FAIL"),
                                f"{comp} process {state}" + ("" if ok else f" (`{PRODUCT} instance start {name}`)")))
        age = p.get("worker_heartbeat_age")
        if p.get("database") and "worker" in self.status(name, entry):
            if age is None or age > 120:
                checks.append(Check("WARN", "no recent worker heartbeat - schedules (notices, backups) are not running"))
        # ports / HTTP
        status, body = self.sys.http_get(self.health_url(name, entry), timeout=5)
        if status == 200:
            checks.append(Check("OK", f"web answers on {self.health_url(name, entry)}"))
        else:
            checks.append(Check("FAIL", f"{self.health_url(name, entry)} -> {status or body[:120]}"))
            if not self.sys.port_free(entry.get("bind", "127.0.0.1"), entry["port"]) and status == 0:
                checks.append(Check("WARN", f"port {entry['port']} is taken by another program"))
        rstatus, rbody = self.sys.http_get(self.health_url(name, entry, "/readyz"), timeout=5)
        if status == 200:
            checks.append(Check("OK" if rstatus == 200 else "FAIL", f"/readyz -> {rstatus}"
                                + ("" if rstatus == 200 else f" {rbody[:160]}")))
        # reverse proxy & TLS
        proxy, domain = entry.get("proxy", "none"), entry.get("domain")
        if proxy == "caddy" and domain:
            if not self.sys.exists(L.caddy_site(name)):
                checks.append(Check("FAIL", f"Caddy site {L.caddy_site(name)} is missing"))
            checks.append(self._tls_check(domain))
        elif proxy == "nginx" and domain:
            avail, enabled = L.nginx_site(name)
            if not self.sys.exists(enabled):
                checks.append(Check("FAIL", f"nginx site {enabled} is missing"))
            checks.append(self._tls_check(domain, optional=True))
        # disk & backups
        for label, path in (("data", L.data_dir(name)), ("backups", L.backup_dir(name))):
            try:
                du = self.sys.disk_usage(path)
            except OSError as exc:
                checks.append(Check("WARN", f"cannot read free space of {path}: {exc}"))
                continue
            free_gb, pct = du.free / 1e9, du.free / du.total * 100 if du.total else 0
            level = "FAIL" if free_gb < 0.5 else "WARN" if (free_gb < 2 or pct < 10) else "OK"
            checks.append(Check(level, f"{label} disk: {free_gb:.1f} GB free ({pct:.0f}%) at {path}"))
        checks.append(self._backup_check(name))
        return checks

    def _tls_check(self, domain: str, optional: bool = False) -> Check:
        try:
            expiry = self.sys.cert_expiry(domain)
        except Exception as exc:  # unreachable, self-signed, no HTTPS yet
            return Check("INFO" if optional else "WARN", f"TLS certificate of {domain}: {type(exc).__name__}: {exc}")
        if expiry is None:
            return Check("WARN", f"TLS certificate of {domain}: no expiry date")
        days = (expiry - self.sys.now()).total_seconds() / 86400
        level = "FAIL" if days < 0 else "WARN" if days < 14 else "OK"
        return Check(level, f"TLS certificate of {domain} expires {expiry:%Y-%m-%d} ({days:.0f} days)")

    def _backup_check(self, name: str) -> Check:
        d = self.layout.backup_dir(name)
        try:
            files = [p for p in d.iterdir() if p.name.startswith(f"{PY_MODULE}-") and not p.name.endswith(".json")]
        except OSError:
            files = []
        if not files:
            return Check("WARN", f"no backups in {d} yet (nightly at 01:15 by the worker; `{PRODUCT} instance backup {name}`)")
        newest = max(files, key=lambda p: p.stat().st_mtime)
        age_h = (self.sys.now().timestamp() - newest.stat().st_mtime) / 3600
        return Check("OK" if age_h < 48 else "WARN", f"newest backup {newest.name} ({age_h:.0f} h old)")


# ------------------------------------------------------------------ helpers


def _source_root() -> Path | None:
    """The checkout directory when the package is imported from source rather than installed."""
    root = Path(__file__).resolve().parents[2]
    if (root / "pyproject.toml").is_file() and not any(
            part in ("site-packages", "dist-packages") for part in Path(__file__).resolve().parts):
        return root
    return None


def _sql_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _password_from_url(url: str) -> str:
    from sqlalchemy.engine import make_url

    return str(make_url(url).password or "")


def _is_stock_caddyfile(text: str) -> bool:
    """The placeholder Caddyfile shipped by the caddy Debian package (serves /usr/share/caddy on :80)."""
    meaningful = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    return ":80 {" in meaningful and any("/usr/share/caddy" in ln for ln in meaningful) and len(meaningful) <= 6


def _last_json(text: str | None) -> dict | None:
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                return None
    return None
