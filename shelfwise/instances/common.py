"""Names, paths and small helpers shared by the instance tool.

Everything the global ``shelfwise`` -> ``librowise`` rename has to touch lives in the constants at
the top of this module: the Python package that ``python -m`` runs, the pip distribution name and
the prefix of the application settings. All system-facing names (units, paths, user, package)
already use :data:`PRODUCT`.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

PY_MODULE = "shelfwise"  # `python -m PY_MODULE ...` and the ASGI app `PY_MODULE.app:app`
DIST_NAME = "shelfwise"  # pip distribution (pyproject [project].name)
ENV_PREFIX = "SHELFWISE_"  # application settings (shelfwise.config.Settings)
PRODUCT = "librowise"  # CLI, systemd units, paths, system user, Debian package
PRODUCT_TITLE = "Librowise"
REPO_URL = "https://github.com/librowise/librowise"
SERVICE_USER = PRODUCT
SERVICE_GROUP = PRODUCT

# Instance-tool variables in the env file. They are not application settings (no ENV_PREFIX), the
# app ignores them; systemd expands them in ExecStart and the process backend reads them too.
VAR_PREFIX = "LIBROWISE_"

WEB_PORT_RANGE = (8100, 8999)
SIP2_PORT_RANGE = (6001, 6999)
COMPONENTS = ("web", "worker", "sip2")

NAME_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
NAME_MAX = 30
RESERVED_NAMES = frozenset({
    "all", "default", "instances", "template", "template0", "template1", "postgres", "root", "www",
    "localhost", PRODUCT, PY_MODULE, "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10)),
})
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$")
EMAIL_RE = re.compile(r"^[^@\s'\"\\]+@[^@\s'\"\\]+$")
HOST_RE = re.compile(r"^(?:\d{1,3}(?:\.\d{1,3}){3}|::1?|[a-z0-9.-]+)$")


class InstanceError(RuntimeError):
    """A user-facing error: printed without a traceback, exit status 1."""


def validate_name(name: str) -> str:
    """Instance names become unit names, PostgreSQL identifiers, file and directory names."""
    if not isinstance(name, str) or not name:
        raise InstanceError("instance name is required")
    if len(name) > NAME_MAX:
        raise InstanceError(f"instance name {name!r} is too long (max {NAME_MAX} characters)")
    if not NAME_RE.match(name):
        raise InstanceError(
            f"invalid instance name {name!r}: use lowercase letters, digits and single hyphens, "
            "starting with a letter (e.g. 'central' or 'city-library')")
    if name in RESERVED_NAMES:
        raise InstanceError(f"instance name {name!r} is reserved")
    return name


def validate_domain(domain: str | None) -> str | None:
    if domain is None:
        return None
    d = domain.strip().lower().rstrip(".")
    if not DOMAIN_RE.match(d):
        raise InstanceError(f"invalid domain {domain!r} (expected a host name such as catalogue.example.org)")
    return d


def validate_email(email: str | None) -> str | None:
    if email is None:
        return None
    if not EMAIL_RE.match(email.strip()):
        raise InstanceError(f"invalid e-mail address {email!r}")
    return email.strip()


def validate_timezone(tz: str) -> str:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    if not re.match(r"^[A-Za-z0-9_+\-/]+$", tz or ""):
        raise InstanceError(f"invalid time zone {tz!r}")
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise InstanceError(f"unknown time zone {tz!r} (use an IANA name such as Europe/London)")
    return tz


def validate_bind(host: str) -> str:
    if not HOST_RE.match(host or ""):
        raise InstanceError(f"invalid bind address {host!r}")
    return host


def validate_port(port: int) -> int:
    if not 1024 <= int(port) <= 65535:
        raise InstanceError(f"port {port} is out of range (1024-65535)")
    return int(port)


def db_identifier(name: str) -> str:
    """PostgreSQL role and database name for an instance (``librowise_city_library``)."""
    return f"{PRODUCT}_{validate_name(name).replace('-', '_')}"


def detect_timezone() -> str:
    """The host's IANA time zone if it can be determined, else UTC."""
    tz = os.environ.get("TZ", "").lstrip(":")
    candidates = [tz] if tz else []
    try:
        candidates.append(Path("/etc/timezone").read_text(encoding="utf-8").strip())
    except OSError:
        pass
    try:
        target = os.readlink("/etc/localtime")
        if "zoneinfo/" in target:
            candidates.append(target.split("zoneinfo/", 1)[1])
    except OSError:
        pass
    for cand in candidates:
        try:
            return validate_timezone(cand)
        except InstanceError:
            continue
    return "UTC"


# ------------------------------------------------------------------ layout


@dataclass(frozen=True)
class Layout:
    """Where an installation keeps its files.

    ``system`` (Linux, root): FHS paths under /etc, /var/lib, /var/log, /var/backups, managed with
    systemd and a reverse proxy. ``user`` (any OS, no root): everything under one directory -
    ``~/.local/share/librowise`` on Linux/macOS, ``%LOCALAPPDATA%\\Librowise`` on Windows - with
    SQLite and processes started by the tool itself.
    """

    mode: str
    etc: Path
    data: Path
    logs: Path
    backups: Path
    run: Path
    prefix: Path
    systemd_dir: Path | None = None
    systemd_vendor_dirs: tuple[Path, ...] = ()
    caddy_main: Path | None = None
    caddy_sites: Path | None = None
    nginx_available: Path | None = None
    nginx_enabled: Path | None = None
    logrotate: Path | None = None

    @property
    def system(self) -> bool:
        return self.mode == "system"

    @property
    def registry(self) -> Path:
        return self.etc / "instances.json"

    def env_file(self, name: str) -> Path:
        return self.etc / f"{name}.env"

    def data_dir(self, name: str) -> Path:
        return self.data / name

    def log_dir(self, name: str) -> Path:
        return self.logs / name

    def backup_dir(self, name: str) -> Path:
        return self.backups / name

    def caddy_site(self, name: str) -> Path | None:
        return self.caddy_sites / f"{name}.caddy" if self.caddy_sites else None

    def nginx_site(self, name: str) -> tuple[Path, Path] | None:
        if not (self.nginx_available and self.nginx_enabled):
            return None
        return self.nginx_available / f"{PRODUCT}-{name}.conf", self.nginx_enabled / f"{PRODUCT}-{name}.conf"

    def instance_roots(self) -> tuple[Path, ...]:
        """Directories under which per-instance directories may be deleted (purge safety)."""
        return (self.data, self.logs, self.backups)

    @classmethod
    def for_system(cls, root: Path | str = "/") -> Layout:
        r = Path(root)
        return cls(
            mode="system",
            etc=r / "etc" / PRODUCT,
            data=r / "var" / "lib" / PRODUCT,
            logs=r / "var" / "log" / PRODUCT,
            backups=r / "var" / "backups" / PRODUCT,
            run=r / "run" / PRODUCT,
            prefix=r / "opt" / PRODUCT,
            systemd_dir=r / "etc" / "systemd" / "system",
            systemd_vendor_dirs=(r / "lib" / "systemd" / "system", r / "usr" / "lib" / "systemd" / "system"),
            caddy_main=r / "etc" / "caddy" / "Caddyfile",
            caddy_sites=r / "etc" / "caddy" / f"{PRODUCT}.d",
            nginx_available=r / "etc" / "nginx" / "sites-available",
            nginx_enabled=r / "etc" / "nginx" / "sites-enabled",
            logrotate=r / "etc" / "logrotate.d" / PRODUCT,
        )

    @classmethod
    def for_user(cls, base: Path | str | None = None) -> Layout:
        b = Path(base) if base else user_base()
        return cls(mode="user", etc=b / "etc", data=b / "data", logs=b / "log", backups=b / "backups",
                   run=b / "run", prefix=b)


def user_base() -> Path:
    """Base directory of a user-mode installation (``LIBROWISE_HOME`` overrides it)."""
    if os.environ.get("LIBROWISE_HOME"):
        return Path(os.environ["LIBROWISE_HOME"]).expanduser()
    if sys.platform == "win32":
        root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(root) / PRODUCT_TITLE
    xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(xdg) / PRODUCT


# ------------------------------------------------------------------ env files

_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def parse_env(text: str) -> dict[str, str]:
    """Parse a systemd EnvironmentFile / dotenv file (KEY=value, 'single' or "double" quoted)."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = _ENV_LINE.match(raw)
        if not m:
            continue
        key, value = m.groups()
        if len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1]
        elif len(value) >= 2 and value[0] == value[-1] == '"':
            value = re.sub(r'\\(["\\$`])', r"\1", value[1:-1])
        out[key] = value
    return out


def env_quote(value: str) -> str:
    """Quote a value so that systemd, bash (`set -a; . file`) and python-dotenv agree on it."""
    if value == "" or re.fullmatch(r"[A-Za-z0-9_@%+=:,./\-]+", value):
        return value
    if "'" in value or "\n" in value:
        raise InstanceError(f"value cannot be written to an env file: {value!r}")
    return f"'{value}'"


def json_compact(value) -> str:
    return json.dumps(value, separators=(",", ":"))
