"""Instance tool (``librowise instance …``): every system call is injected through FakeSystem.

The system layout is rooted in ``tmp_path`` so real files are written there; commands, ownership
changes, processes, sockets and HTTP probes are recorded instead of executed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tomllib
from datetime import timedelta
from pathlib import Path

import pytest

from shelfwise.instances import render
from shelfwise.instances.common import (
    PRODUCT,
    PY_MODULE,
    InstanceError,
    Layout,
    db_identifier,
    env_quote,
    parse_env,
    validate_name,
)
from shelfwise.instances.manager import PACKAGED_MARKER, CreateOptions, Manager
from shelfwise.instances.system import System

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOTS = Path(__file__).parent / "snapshots" / "instances"
PY = "/opt/librowise/venv/bin/python"


class FakeSystem(System):
    """Records instead of executing. ``state`` models PostgreSQL and the instance database."""

    def __init__(self, *, root: bool = True, platform: str = "linux", systemd: bool = True, busy_ports=(),
                 users=("postgres",), dry_run: bool = False):
        self.lines: list[str] = []
        super().__init__(dry_run=dry_run, verbose=True, out=self.lines.append)
        self._root, self._platform, self._systemd = root, platform, systemd
        self.busy = set(busy_ports)
        self.users = set(users)
        self.commands: list[list[str]] = []
        self.inputs: list[str | None] = []
        self.chowns: list[tuple[str, str | None, str | None]] = []
        self.spawned: list[list[str]] = []
        self.alive: set[int] = set()
        self.terminated: list[int] = []
        self.pg_roles: set[str] = set()
        self.pg_dbs: set[str] = set()
        self.admins = 0
        self.next_pid = 4000

    platform = property(lambda self: self._platform)

    def is_root(self):
        return self._root

    def has_systemd(self):
        return self._systemd

    def which(self, name):
        return f"/usr/bin/{name}"

    def user_exists(self, name):
        return name in self.users

    def environ(self):
        return {"PATH": "/usr/bin", "SHELFWISE_DATABASE_URL": "sqlite:///leak.db", "HOME": "/root"}

    def chown(self, path, owner, group, quiet=False):
        self.chowns.append((Path(path).name, owner, group))

    def port_free(self, host, port):
        return port not in self.busy

    def http_get(self, url, timeout=5.0):
        return 200, '{"status":"ok"}'

    def cert_expiry(self, host, port=443, timeout=5.0):
        return self.now() + timedelta(days=60)

    def sleep(self, seconds):
        pass

    def pid_alive(self, pid):
        return pid in self.alive

    def spawn(self, cmd, *, env, cwd, log, describe):
        if not self._act(describe):
            return 0
        self.spawned.append([str(c) for c in cmd])
        self.next_pid += 1
        self.alive.add(self.next_pid)
        return self.next_pid

    def terminate(self, pid, *, describe, timeout=20.0):
        if self._act(describe):
            self.terminated.append(pid)
            self.alive.discard(pid)

    def run(self, cmd, *, input=None, env=None, cwd=None, check=True, capture=True, mutate=True, timeout=None,
            describe=None):
        cmd = [str(c) for c in cmd]
        if mutate and not self._act(describe or "run " + " ".join(cmd)):
            return subprocess.CompletedProcess(cmd, 0, "", "")
        self.commands.append(cmd)
        self.inputs.append(input)
        if env is not None:
            assert "SHELFWISE_DATABASE_URL" not in env or env["SHELFWISE_DATABASE_URL"] != "sqlite:///leak.db"
        return subprocess.CompletedProcess(cmd, 0, self._respond(cmd, input or ""), "")

    def symlink(self, target, link):
        try:
            return super().symlink(target, link)
        except OSError:  # Windows without symlink privilege: a copy is enough for these tests
            Path(link).write_text(Path(target).read_text(encoding="utf-8"), encoding="utf-8")
            return True

    def _respond(self, cmd, sql):
        if cmd[0] == "useradd":
            self.users.add(cmd[-1])
        if "psql" in cmd:
            if sql.startswith("SELECT 1 FROM pg_roles"):
                return "1" if any(f"'{r}'" in sql for r in self.pg_roles) else ""
            if sql.startswith("SELECT 1 FROM pg_database"):
                return "1" if any(f"'{d}'" in sql for d in self.pg_dbs) else ""
            if sql.startswith("SHOW port"):
                return "5433\n"
            name = sql.split('"')[1] if '"' in sql else ""
            if sql.startswith("CREATE ROLE"):
                self.pg_roles.add(name)
            elif sql.startswith("CREATE DATABASE"):
                self.pg_dbs.add(name)
            elif sql.startswith("DROP DATABASE"):
                self.pg_dbs.discard(name)
            elif sql.startswith("DROP ROLE"):
                self.pg_roles.discard(name)
            return ""
        if "_bootstrap-admin" in cmd:
            if self.admins:
                return json.dumps({"created": False, "reason": "an administrator already exists"})
            self.admins += 1
            return "noise\n" + json.dumps({"created": True, "username": "admin", "email": "a@b.org", "emailed": False,
                                           "password": "One-Time#Passw0rd"})
        if "_probe" in cmd:
            return json.dumps({"database": True, "revision": "0001", "head": "0001", "admins": self.admins,
                               "worker_heartbeat_age": 3.0})
        if cmd[:2] == ["systemctl", "is-active"]:
            return "active\n"
        return ""

    # helpers for assertions
    def ran(self, *needle: str) -> list[list[str]]:
        return [c for c in self.commands if all(n in c for n in needle)]


@pytest.fixture()
def system_layout(tmp_path):
    return Layout.for_system(tmp_path / "root")


def make(layout, **kw) -> tuple[Manager, FakeSystem]:
    fake = FakeSystem(**kw)
    return Manager(layout, fake, python=PY), fake


def _all_text(fake: FakeSystem) -> str:
    return "\n".join(fake.lines + fake.actions + [" ".join(c) for c in fake.commands])


# ------------------------------------------------------------------ names, env files, entry point


@pytest.mark.parametrize("name", ["central", "city-library", "a1", "x", "lib-2024-main", "a" * 30])
def test_valid_names(name):
    assert validate_name(name) == name


@pytest.mark.parametrize("name", ["", "Central", "1abc", "-x", "x-", "a--b", "a_b", "a.b", "../etc", "a/b", "a b",
                                  "a" * 31, "all", "postgres", "librowise", "con", "template1", "café"])
def test_unsafe_names_are_refused(name):
    with pytest.raises(InstanceError):
        validate_name(name)


def test_db_identifier():
    assert db_identifier("city-library") == "librowise_city_library"


def test_env_quoting_round_trip():
    values = {"A": "plain", "B": '{"nightly":"0 2 * * *"}', "C": "C:\\Users\\x y\\db", "D": "", "E": '["a","b"]',
              "F": "postgresql+psycopg://u:p-_x@localhost:5432/db"}
    text = "\n".join(f"{k}={env_quote(v)}" for k, v in values.items()) + "\n# comment\nexport G=\"q\\\"x\"\n"
    parsed = parse_env(text)
    assert {k: parsed[k] for k in values} == values
    assert parsed["G"] == 'q"x'
    with pytest.raises(InstanceError):
        env_quote("it's")


def test_librowise_console_entry_point_declared():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert project["scripts"]["librowise"] == f"{PY_MODULE}.__main__:main"
    assert project["scripts"]["shelfwise"] == "shelfwise.__main__:main"  # kept for compatibility


def test_instance_command_is_registered():
    proc = subprocess.run([sys.executable, "-m", PY_MODULE, "instance", "--help"], capture_output=True, text=True,
                          cwd=ROOT)
    assert proc.returncode == 0
    for action in ("create", "list", "remove", "doctor", "upgrade", "shell"):
        assert action in proc.stdout


# ------------------------------------------------------------------ port allocation


def test_port_allocation_skips_registered_and_busy_ports(system_layout):
    m, fake = make(system_layout, busy_ports={8100, 8102})
    reg = {"instances": {"a": {"port": 8101, "sip2_port": 6001}}}
    assert m.allocate_port(reg, "127.0.0.1", (8100, 8110)) == 8103
    assert m.allocate_port(reg, "127.0.0.1", (6001, 6005)) == 6002
    assert m.allocate_port(reg, "127.0.0.1", (8100, 8110), exclude="a") == 8101
    with pytest.raises(InstanceError, match="no free port"):
        m.allocate_port(reg, "127.0.0.1", (8100, 8102))


def test_explicit_port_conflicts_are_refused(system_layout):
    m, fake = make(system_layout, busy_ports={8300})
    m.create(CreateOptions("one", domain="one.example.org", port=8200))
    with pytest.raises(InstanceError, match="already assigned"):
        m.create(CreateOptions("two", domain="two.example.org", port=8200))
    with pytest.raises(InstanceError, match="in use"):
        m.create(CreateOptions("two", domain="two.example.org", port=8300))


# ------------------------------------------------------------------ create (system mode)


def test_create_system_postgres_caddy(system_layout):
    L = system_layout
    m, fake = make(L, users={"postgres"})
    L.caddy_main.parent.mkdir(parents=True)
    L.caddy_main.write_text(":80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n", encoding="utf-8")
    res = m.create(CreateOptions("central", domain="Catalogue.Example.org", admin_email="admin@example.org",
                                 timezone="Europe/London"))

    # service account, database role and database
    assert fake.ran("useradd", "--system", PRODUCT)
    ident = db_identifier("central")
    assert ident in fake.pg_roles and ident in fake.pg_dbs

    # env file: contents and permissions
    env_path = L.env_file("central")
    env = parse_env(env_path.read_text(encoding="utf-8"))
    assert env["LIBROWISE_INSTANCE"] == "central"
    assert env["LIBROWISE_PORT"] == "8100" and env["LIBROWISE_BIND"] == "127.0.0.1"
    assert env["SHELFWISE_ENVIRONMENT"] == "production"
    assert len(env["SHELFWISE_SECRET_KEY"]) >= 64
    assert env["SHELFWISE_DATABASE_URL"].startswith(f"postgresql+psycopg://{ident}:")
    assert env["SHELFWISE_DATABASE_URL"].endswith(f"@localhost:5433/{ident}")  # port read from the server
    assert env["SHELFWISE_PUBLIC_URL"] == "https://catalogue.example.org"
    assert json.loads(env["SHELFWISE_ALLOWED_HOSTS"])[0] == "catalogue.example.org"
    assert env["SHELFWISE_COOKIE_SECURE"] == "true"
    assert env["SHELFWISE_TIMEZONE"] == "Europe/London"
    assert json.loads(env["SHELFWISE_SCHEDULES"])["backup"] == "15 1 * * *"
    assert Path(env["SHELFWISE_BACKUP_DIR"]) == L.backup_dir("central")
    assert any(a.startswith(f"write {env_path} (0640 root:librowise; secrets") for a in fake.actions)
    assert any("central.env" in n and (o, g) == ("root", "librowise") for n, o, g in fake.chowns)

    # secrets never appear in output, action log or command lines (only in stdin to psql)
    password = env["SHELFWISE_DATABASE_URL"].split(":")[2].split("@")[0]
    text = _all_text(fake)
    assert password not in text and env["SHELFWISE_SECRET_KEY"] not in text
    assert any(password in (i or "") for i in fake.inputs)

    # schema, admin, units, proxy, logrotate, services
    assert fake.ran("runuser", "-u", PRODUCT, PY, "-m", PY_MODULE, "migrate")
    assert res.admin["password"] == "One-Time#Passw0rd" and res.url == "https://catalogue.example.org"
    for unit in ("librowise-web@.service", "librowise-worker@.service", "librowise-sip2@.service", "librowise@.target"):
        assert (L.systemd_dir / unit).is_file()
    assert fake.ran("systemctl", "daemon-reload")
    assert fake.ran("systemctl", "enable", "librowise@central.target", "librowise-web@central.service",
                    "librowise-worker@central.service")
    assert fake.ran("systemctl", "restart", "librowise-web@central.service")
    site = L.caddy_site("central").read_text(encoding="utf-8")
    assert "catalogue.example.org {" in site and "reverse_proxy 127.0.0.1:8100" in site and "tls admin@example.org" in site
    assert render.caddy_import_line(L) in L.caddy_main.read_text(encoding="utf-8")
    assert "/usr/share/caddy" in L.caddy_main.with_name("Caddyfile.dpkg-orig").read_text(encoding="utf-8")
    assert fake.ran("caddy", "validate")
    assert L.logrotate.is_file()
    entry = json.loads(L.registry.read_text(encoding="utf-8"))["instances"]["central"]
    assert entry["port"] == 8100 and entry["db"] == "postgres" and entry["proxy"] == "caddy"
    assert entry["sip2_port"] == 6001 and entry["sip2"] is False


def test_create_is_idempotent(system_layout):
    L = system_layout
    m, fake = make(L)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    env_before = L.env_file("central").read_text(encoding="utf-8")
    site_before = L.caddy_site("central").read_text(encoding="utf-8")

    m2 = Manager(L, fake, python=PY)
    fake.actions.clear()
    fake.commands.clear()
    res = m2.create(CreateOptions("central"))  # domain etc. come from the registry
    assert L.env_file("central").read_text(encoding="utf-8") == env_before  # secrets are kept
    assert L.caddy_site("central").read_text(encoding="utf-8") == site_before
    assert not any(a.startswith(("write", "update")) and ".env" in a for a in fake.actions)
    assert not any("CREATE ROLE" in a or "CREATE DATABASE" in a for a in fake.actions)
    assert any("reset password of PostgreSQL role" in a for a in fake.actions)  # role password re-synced
    assert not fake.ran("useradd")
    assert not fake.ran("caddy", "validate")  # nothing changed, no reload
    assert res.admin == {"created": False, "reason": "an administrator already exists"}
    assert res.created is False
    assert list(json.loads(L.registry.read_text(encoding="utf-8"))["instances"]) == ["central"]


def test_create_keeps_operator_edits_and_adds_new_keys(system_layout):
    L = system_layout
    m, fake = make(L)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    path = L.env_file("central")
    text = path.read_text(encoding="utf-8").replace("SHELFWISE_BACKUP_KEEP=14", "SHELFWISE_BACKUP_KEEP=30")
    text = "\n".join(ln for ln in text.splitlines() if not ln.startswith("SHELFWISE_CACHE_DIR"))
    path.write_text(text + "\nSHELFWISE_EMAIL_BACKEND=smtp\n", encoding="utf-8")
    m.create(CreateOptions("central"))
    env = parse_env(path.read_text(encoding="utf-8"))
    assert env["SHELFWISE_BACKUP_KEEP"] == "30" and env["SHELFWISE_EMAIL_BACKEND"] == "smtp"
    assert env["SHELFWISE_CACHE_DIR"]  # restored


def test_create_rerun_with_conflicting_options_fails(system_layout):
    m, fake = make(system_layout)
    m.create(CreateOptions("central", domain="catalogue.example.org", port=8200))
    with pytest.raises(InstanceError, match="already exists with port 8200"):
        m.create(CreateOptions("central", port=8300))
    with pytest.raises(InstanceError, match="domain"):
        m.create(CreateOptions("central", domain="other.example.org"))
    with pytest.raises(InstanceError, match="database"):
        m.create(CreateOptions("central", db="sqlite"))


def test_create_requires_domain_for_proxy_and_root(system_layout):
    m, fake = make(system_layout)
    with pytest.raises(InstanceError, match="--domain is required"):
        m.create(CreateOptions("central"))
    m, fake = make(system_layout, root=False)
    with pytest.raises(InstanceError, match="as root"):
        m.create(CreateOptions("central", db="sqlite", proxy="none"))


def test_create_sqlite_no_proxy_without_systemd_uses_processes(system_layout):
    """The Docker smoke test path: root in a container, no systemd."""
    L = system_layout
    m, fake = make(L, systemd=False)
    m.create(CreateOptions("demo", db="sqlite", proxy="none", port=8800))
    env = parse_env(L.env_file("demo").read_text(encoding="utf-8"))
    assert env["SHELFWISE_DATABASE_URL"] == f"sqlite:///{(L.data_dir('demo') / 'librowise.db').as_posix()}"
    assert env["SHELFWISE_COOKIE_SECURE"] == "false" and env["SHELFWISE_PUBLIC_URL"] == "http://127.0.0.1:8800"
    assert not fake.ran("psql") and not fake.ran("caddy") and not fake.ran("systemctl")
    web, worker = fake.spawned
    assert web[:4] == ["runuser", "-u", PRODUCT, "--"]
    assert web[4:] == [PY, "-m", "uvicorn", f"{PY_MODULE}.app:app", "--host", "127.0.0.1", "--port", "8800",
                       "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1", "--no-access-log"]
    assert worker[4:] == [PY, "-m", PY_MODULE, "worker", "--concurrency", "2"]
    assert m.status("demo") == {"web": "active", "worker": "active"}
    m.stop(["demo"])
    assert len(fake.terminated) == 2 and m.status("demo") == {"web": "inactive", "worker": "inactive"}


def test_create_with_nginx_never_overwrites_certbot_edits(system_layout):
    L = system_layout
    m, fake = make(L)
    m.create(CreateOptions("central", domain="catalogue.example.org", proxy="nginx"))
    avail, enabled = L.nginx_site("central")
    assert "server_name catalogue.example.org;" in avail.read_text(encoding="utf-8")
    assert enabled.is_symlink() or enabled.exists()
    env = parse_env(L.env_file("central").read_text(encoding="utf-8"))
    assert env["SHELFWISE_COOKIE_SECURE"] == "false"  # plain HTTP until certbot runs
    avail.write_text(avail.read_text(encoding="utf-8") + "# managed by Certbot\n", encoding="utf-8")
    edited = avail.read_text(encoding="utf-8")
    m.create(CreateOptions("central"))
    assert avail.read_text(encoding="utf-8") == edited


def test_custom_caddyfile_gets_import_once(system_layout):
    L = system_layout
    L.caddy_main.parent.mkdir(parents=True)
    L.caddy_main.write_text("intranet.example.org {\n\trespond hi\n}\n", encoding="utf-8")
    m, fake = make(L)
    m.create(CreateOptions("a", domain="a.example.org"))
    m.create(CreateOptions("b", domain="b.example.org"))
    text = L.caddy_main.read_text(encoding="utf-8")
    assert text.startswith("intranet.example.org {") and text.count(render.caddy_import_line(L)) == 1
    assert not L.caddy_main.with_name("Caddyfile.dpkg-orig").exists()


def test_vendor_units_from_the_package_are_not_duplicated(system_layout):
    L = system_layout
    vendor = L.systemd_vendor_dirs[0]
    vendor.mkdir(parents=True)
    (vendor / "librowise-web@.service").write_text("[Service]\n", encoding="utf-8")
    m, fake = make(L)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    assert not (L.systemd_dir / "librowise-web@.service").exists()


# ------------------------------------------------------------------ dry run


def test_dry_run_changes_nothing_and_prints_the_plan(system_layout, tmp_path):
    L = system_layout
    m, fake = make(L, dry_run=True, users=set())
    m.create(CreateOptions("central", domain="catalogue.example.org", admin_email="a@example.org"))
    assert not (tmp_path / "root").exists()
    plan = "\n".join(fake.lines)
    for step in ("run useradd", f"create directory {L.data_dir('central')}", f"write {L.env_file('central')}",
                 "CREATE ROLE librowise_central LOGIN PASSWORD '********'", "CREATE DATABASE librowise_central",
                 "migrate", "create the first administrator", f"write {L.systemd_dir / 'librowise-web@.service'}",
                 f"write {L.caddy_site('central')}", "caddy validate", "systemctl enable", "systemctl restart"):
        assert step in plan, step
    assert all(line.startswith("  [dry-run] ") for line in fake.lines if "write" in line or "run " in line)
    assert not fake.ran("runuser", "-u", PRODUCT)  # nothing was executed as the service user
    assert "secrets, not shown" in plan


# ------------------------------------------------------------------ remove


def test_remove_keeps_data_by_default(system_layout):
    L = system_layout
    m, fake = make(L)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    m.remove("central")
    assert fake.ran("systemctl", "disable", "--now", "librowise-web@central.service")
    assert not L.caddy_site("central").exists()
    assert L.env_file("central").exists() and L.data_dir("central").is_dir()
    assert db_identifier("central") in fake.pg_dbs
    assert "central" not in json.loads(L.registry.read_text(encoding="utf-8"))["instances"]
    # re-adopted from the kept env file, with the same secrets
    key = parse_env(L.env_file("central").read_text(encoding="utf-8"))["SHELFWISE_SECRET_KEY"]
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    assert parse_env(L.env_file("central").read_text(encoding="utf-8"))["SHELFWISE_SECRET_KEY"] == key


def test_remove_purge_drops_database_and_files_but_keeps_backups(system_layout):
    L = system_layout
    m, fake = make(L)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    (L.backup_dir("central") / "shelfwise-20260101.dump").write_text("x", encoding="utf-8")
    m.remove("central", purge_data=True)
    assert db_identifier("central") not in fake.pg_dbs and db_identifier("central") not in fake.pg_roles
    assert not L.data_dir("central").exists() and not L.log_dir("central").exists()
    assert not L.env_file("central").exists()
    assert (L.backup_dir("central") / "shelfwise-20260101.dump").exists()
    assert L.data.is_dir() and L.etc.is_dir()  # shared roots survive


def test_remove_purge_backups(system_layout):
    L = system_layout
    m, fake = make(L, systemd=False)
    m.create(CreateOptions("demo", db="sqlite", proxy="none"))
    m.remove("demo", purge_data=True, purge_backups=True)
    assert not L.backup_dir("demo").exists() and L.backups.is_dir()
    with pytest.raises(InstanceError, match="no instance"):
        m.remove("demo")


def test_purge_safety_checks(system_layout, tmp_path):
    L = system_layout
    m, fake = make(L)
    for root in L.instance_roots():
        (root / "demo").mkdir(parents=True)
    assert m.safe_instance_dir(L.data / "demo", "demo") == (L.data / "demo").resolve()
    with pytest.raises(InstanceError):
        m.safe_instance_dir(L.data / "other", "demo")
    with pytest.raises(InstanceError):
        m.safe_instance_dir(L.data, PRODUCT)  # a root itself
    outside = tmp_path / "elsewhere" / "demo"
    outside.mkdir(parents=True)
    with pytest.raises(InstanceError, match="outside"):
        m.safe_instance_dir(outside, "demo")
    link = L.logs / "linked"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks need privileges on this platform")
    with pytest.raises(InstanceError, match="symbolic link"):
        m.safe_instance_dir(link, "linked")


# ------------------------------------------------------------------ user mode / Windows


def test_windows_user_mode(tmp_path):
    L = Layout.for_user(tmp_path / "Librowise")
    m, fake = make(L, platform="win32", root=False, systemd=False)
    with pytest.raises(InstanceError, match="not supported on Windows"):
        m.create(CreateOptions("demo", db="postgres", proxy="none"))
    with pytest.raises(InstanceError, match="Linux-only"):
        m.create(CreateOptions("demo", domain="x.example.org"))
    with pytest.raises(InstanceError, match="Linux-only"):
        m.create(CreateOptions("demo", proxy="caddy", domain="x.example.org"))
    m.create(CreateOptions("demo", bind="127.0.0.33", port=8783))
    assert not fake.ran("runuser") and not fake.ran("useradd") and not fake.chowns
    assert any(a.startswith(f"write {L.env_file('demo')} (0600; secrets") for a in fake.actions)
    env = parse_env(L.env_file("demo").read_text(encoding="utf-8"))
    assert env["SHELFWISE_DATABASE_URL"].startswith("sqlite:///") and env["LIBROWISE_WEB_WORKERS"] == "1"
    assert fake.spawned[0][fake.spawned[0].index("--host") + 1] == "127.0.0.33"


def test_linux_without_root_needs_sudo_for_postgres(tmp_path):
    m, fake = make(Layout.for_user(tmp_path / "u"), root=False, systemd=True)
    with pytest.raises(InstanceError, match="sudo"):
        m.create(CreateOptions("demo", db="postgres", proxy="none"))
    res = m.create(CreateOptions("demo", db_url="postgresql+psycopg://u:p@db.example.org/lib", proxy="none"))
    assert not fake.ran("psql") and res.name == "demo"
    assert json.loads(m.layout.registry.read_text(encoding="utf-8"))["instances"]["demo"]["db"] == "external"


# ------------------------------------------------------------------ lifecycle commands


def test_enable_sip2_and_lifecycle(system_layout):
    m, fake = make(system_layout)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    m.enable("central", sip2=True)
    assert fake.ran("systemctl", "enable", "librowise-sip2@central.service")
    assert m.components(m.get("central")) == ["web", "worker", "sip2"]
    m.stop(["central"])
    assert fake.ran("systemctl", "stop", "librowise-sip2@central.service")
    m.disable("central", sip2=True)
    assert m.get("central")["sip2"] is False and m.get("central")["enabled"] is True
    m.disable("central")
    assert m.get("central")["enabled"] is False


def test_upgrade_backs_up_migrates_and_restarts(system_layout):
    m, fake = make(system_layout)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    fake.commands.clear()
    m.upgrade(m.names(None, True), version="v1.2.0")
    pip = fake.ran("pip", "install")[0]
    assert pip[-1] == "shelfwise[postgres] @ git+https://github.com/librowise/librowise@v1.2.0"
    order = [c[c.index(PY_MODULE) + 1] if PY_MODULE in c else c[1] for c in fake.commands
             if PY_MODULE in c or c[0] == "systemctl"]
    assert order.index("backup") < order.index("migrate") < order.index("restart")


def test_upgrade_refuses_pip_on_packaged_install(system_layout):
    L = system_layout
    m, fake = make(L)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    L.prefix.mkdir(parents=True)
    (L.prefix / PACKAGED_MARKER).write_text("", encoding="utf-8")
    with pytest.raises(InstanceError, match="Debian package"):
        m.upgrade(["central"], version="v9")
    m.upgrade(["central"])  # migrate-only upgrades are fine
    with pytest.raises(InstanceError, match="--all"):
        m.names([], False)


def test_doctor_reports(system_layout):
    m, fake = make(system_layout)
    m.create(CreateOptions("central", domain="catalogue.example.org"))
    checks = {c.message.split(" ")[0]: c.status for c in m.doctor("central")}
    joined = "\n".join(f"{c.status} {c.message}" for c in m.doctor("central"))
    assert "OK database reachable" in joined and "OK schema at migration head" in joined
    assert "OK TLS certificate of catalogue.example.org expires" in joined
    assert "WARN no backups" in joined
    assert checks["web"] == "OK"
    fake.http_get = lambda url, timeout=5.0: (0, "connection refused")
    assert any(c.status == "FAIL" and "healthz" in c.message for c in m.doctor("central"))


def test_cli_list_and_errors(tmp_path, monkeypatch, capsys):
    import shelfwise.instances as cli
    from shelfwise.__main__ import main

    m, fake = make(Layout.for_user(tmp_path / "u"), root=False, systemd=False, platform="win32")
    monkeypatch.setattr(cli, "make_manager", lambda dry_run=False: m)
    assert main(["instance", "list"]) == 0
    assert "No instances" in capsys.readouterr().out
    assert main(["instance", "create", "Bad_Name", "--no-proxy"]) == 1
    assert "invalid instance name" in capsys.readouterr().err
    assert main(["instance", "create", "demo", "--no-proxy", "--port", "8790"]) == 0
    out = capsys.readouterr().out
    assert "Librowise instance 'demo' is ready." in out and "admin / One-Time#Passw0rd" in out
    assert main(["instance", "list"]) == 0
    assert "demo" in capsys.readouterr().out
    assert main(["instance", "remove", "demo", "--purge-data"]) == 1  # stdin is not a terminal
    assert "--yes" in capsys.readouterr().err
    assert main(["instance", "remove", "demo", "--purge-data", "--yes"]) == 0


# ------------------------------------------------------------------ renderer snapshots


def _rendered() -> dict[str, str]:
    L = Layout.for_system("/")
    out = {f"systemd/{k}": v for k, v in render.render_units(PY, L).items()}
    out["caddy/central.caddy"] = render.render_caddy_site("central", "catalogue.example.org", 8100, "admin@example.org")
    out["caddy/Caddyfile"] = render.render_caddy_main(L)
    out["nginx/librowise-central.conf"] = render.render_nginx_site("central", "catalogue.example.org", 8100)
    out["logrotate/librowise"] = render.render_logrotate(L)
    spec = render.EnvSpec(name="central", bind="127.0.0.1", port=8100, sip2_port=6001,
                          database_url="postgresql+psycopg://librowise_central:PW@localhost:5432/librowise_central",
                          secret_key="SECRET", metrics_token="TOKEN", public_url="https://catalogue.example.org",
                          allowed_hosts=["catalogue.example.org", "localhost", "127.0.0.1"], cookie_secure=True,
                          timezone="Europe/London", backup_dir="/var/backups/librowise/central",
                          cache_dir="/var/lib/librowise/central/cache", postgres=True)
    out["env/central.env"] = render.render_env(spec)
    return out


@pytest.mark.parametrize("key", sorted(_rendered()))
def test_render_snapshots(key):
    """Set UPDATE_SNAPSHOTS=1 to regenerate tests/snapshots/instances after an intended change."""
    text = _rendered()[key]
    path = SNAPSHOTS / key
    if os.environ.get("UPDATE_SNAPSHOTS"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
    assert path.read_text(encoding="utf-8") == text


def test_units_reference_instance_paths():
    units = render.render_units(PY, Layout.for_system("/"))
    web = units["librowise-web@.service"]
    assert "EnvironmentFile=/etc/librowise/%i.env" in web
    assert f"ExecStart={PY} -m uvicorn {PY_MODULE}.app:app --host ${{LIBROWISE_BIND}}" in web
    assert "User=librowise" in web and "ProtectSystem=strict" in web
    assert "ReadWritePaths=-/var/lib/librowise/%i -/var/backups/librowise/%i" in web
    assert f"-m {PY_MODULE} worker" in units["librowise-worker@.service"]


# ------------------------------------------------------------------ in-instance helpers (real database)


def test_bootstrap_admin_and_probe(db):
    from shelfwise.instances.bootstrap import bootstrap_admin, generate_password, probe
    from shelfwise.security import password_problems, verify_password

    for _ in range(20):
        assert not password_problems(generate_password())
    out = bootstrap_admin("admin", "Admin@Example.org")
    assert out["created"] and out["emailed"] is False and len(out["password"]) == 20
    from sqlalchemy import select

    from shelfwise.models import Patron, Role

    db.expire_all()
    user = db.scalar(select(Patron).where(Patron.card_number == "admin"))
    assert user.role == Role.admin and user.email == "admin@example.org"
    assert verify_password(user.password_hash, out["password"])
    assert bootstrap_admin("admin2", "x@example.org") == {"created": False, "reason": "an administrator already exists"}
    p = probe()
    assert p["database"] is True and p["admins"] == 1
