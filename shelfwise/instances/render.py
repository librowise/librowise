"""Text renderers for everything the instance tool writes: env file, systemd units, Caddy/nginx
sites and logrotate. Pure functions (no I/O) so they can be snapshot-tested and reused by
``packaging/build-deb.sh``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .common import (
    ENV_PREFIX,
    PRODUCT,
    PRODUCT_TITLE,
    PY_MODULE,
    REPO_URL,
    SERVICE_GROUP,
    SERVICE_USER,
    VAR_PREFIX,
    Layout,
    env_quote,
    json_compact,
)

DEFAULT_SCHEDULES = {
    "nightly": "0 2 * * *",
    "deliver_notices": "*/5 * * * *",
    "maintenance": "30 3 * * *",
    "backup": "15 1 * * *",  # nightly backup into the instance backup directory
}
HEADER = "Managed by `{product} instance`"


@dataclass
class EnvSpec:
    name: str
    bind: str
    port: int
    sip2_port: int
    database_url: str
    secret_key: str
    metrics_token: str
    public_url: str
    allowed_hosts: list[str]
    cookie_secure: bool
    timezone: str
    backup_dir: str
    cache_dir: str
    web_workers: int = 2
    worker_concurrency: int = 2
    postgres: bool = False
    extra: dict[str, str] = field(default_factory=dict)


def env_values(spec: EnvSpec) -> dict[str, str]:
    """All managed keys of an instance env file, in file order."""
    v: dict[str, str] = {
        f"{VAR_PREFIX}INSTANCE": spec.name,
        f"{VAR_PREFIX}BIND": spec.bind,
        f"{VAR_PREFIX}PORT": str(spec.port),
        f"{VAR_PREFIX}WEB_WORKERS": str(spec.web_workers),
        f"{VAR_PREFIX}WORKER_CONCURRENCY": str(spec.worker_concurrency),
        f"{VAR_PREFIX}SIP2_BIND": "0.0.0.0",
        f"{VAR_PREFIX}SIP2_PORT": str(spec.sip2_port),
        f"{ENV_PREFIX}ENVIRONMENT": "production",
        f"{ENV_PREFIX}SECRET_KEY": spec.secret_key,
        f"{ENV_PREFIX}DATABASE_URL": spec.database_url,
        f"{ENV_PREFIX}PUBLIC_URL": spec.public_url,
        f"{ENV_PREFIX}ALLOWED_HOSTS": json_compact(spec.allowed_hosts),
        f"{ENV_PREFIX}COOKIE_SECURE": "true" if spec.cookie_secure else "false",
        f"{ENV_PREFIX}TIMEZONE": spec.timezone,
        f"{ENV_PREFIX}LOG_FORMAT": "text",
        f"{ENV_PREFIX}RATE_LIMIT_BACKEND": "database",
        f"{ENV_PREFIX}METRICS_TOKEN": spec.metrics_token,
        f"{ENV_PREFIX}SCHEDULES": json_compact(DEFAULT_SCHEDULES),
        f"{ENV_PREFIX}BACKUP_DIR": spec.backup_dir,
        f"{ENV_PREFIX}BACKUP_KEEP": "14",
        f"{ENV_PREFIX}CACHE_DIR": spec.cache_dir,
    }
    if spec.postgres:
        v[f"{ENV_PREFIX}DB_STATEMENT_TIMEOUT_MS"] = "30000"
    v.update(spec.extra)
    return v


def render_env(spec: EnvSpec) -> str:
    vals = env_values(spec)
    lines = [
        f"# {PRODUCT_TITLE} instance '{spec.name}' - {HEADER.format(product=PRODUCT)}.",
        "# Contains secrets: keep it private (root:librowise 0640 on servers). Edit, then `"
        f"{PRODUCT} instance restart {spec.name}`.",
        f"# Every {ENV_PREFIX}* setting is documented in docs/DEPLOYMENT.md.",
        "",
    ]
    groups = [
        ("Processes (read by the systemd units and the instance tool)", VAR_PREFIX),
        ("Application settings", ENV_PREFIX),
    ]
    for title, prefix in groups:
        lines.append(f"# --- {title}")
        lines += [f"{k}={env_quote(val)}" for k, val in vals.items() if k.startswith(prefix)]
        lines.append("")
    lines += [
        "# --- E-mail (uncomment to send notices and password-reset links)",
        f"# {ENV_PREFIX}EMAIL_BACKEND=smtp",
        f"# {ENV_PREFIX}SMTP_HOST=smtp.example.org",
        f"# {ENV_PREFIX}SMTP_PORT=587",
        f"# {ENV_PREFIX}SMTP_USERNAME=",
        f"# {ENV_PREFIX}SMTP_PASSWORD=",
        f"# {ENV_PREFIX}SMTP_FROM='Library <library@example.org>'",
        "",
        "# --- AI (optional; local models are used without a key)",
        "# ANTHROPIC_API_KEY=",
        "",
    ]
    return "\n".join(lines)


# ------------------------------------------------------------------ systemd


def _p(path) -> str:
    """Server paths are POSIX even when rendering on Windows (tests, packaging)."""
    return Path(path).as_posix()


def unit_name(component: str, instance: str | None = None) -> str:
    return f"{PRODUCT}-{component}@{instance or ''}.service"


def _unit_var(key: str) -> str:
    return "${" + VAR_PREFIX + key + "}"


def component_argv(component: str, python: str, var=_unit_var) -> list[str]:
    """Command line of an instance process. ``var(KEY)`` supplies per-instance values: systemd
    placeholders (``${LIBROWISE_PORT}``) for unit files, real values for the process backend."""
    if component == "web":
        return [python, "-m", "uvicorn", f"{PY_MODULE}.app:app", "--host", var("BIND"), "--port", var("PORT"),
                "--workers", var("WEB_WORKERS"), "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1",
                "--no-access-log"]
    if component == "worker":
        return [python, "-m", PY_MODULE, "worker", "--concurrency", var("WORKER_CONCURRENCY")]
    if component == "sip2":
        return [python, "-m", PY_MODULE, "sip2", "--host", var("SIP2_BIND"), "--port", var("SIP2_PORT")]
    raise ValueError(f"unknown component {component!r}")


def _hardening(layout: Layout) -> list[str]:
    return [
        "UMask=0027",
        "NoNewPrivileges=yes",
        "PrivateTmp=yes",
        "PrivateDevices=yes",
        "ProtectSystem=strict",
        "ProtectHome=yes",
        "ProtectKernelTunables=yes",
        "ProtectKernelModules=yes",
        "ProtectControlGroups=yes",
        "RestrictSUIDSGID=yes",
        "RestrictNamespaces=yes",
        "LockPersonality=yes",
        f"ReadWritePaths=-{_p(layout.data)}/%i -{_p(layout.backups)}/%i",
    ]


def render_units(python: str, layout: Layout) -> dict[str, str]:
    """systemd template units ``librowise-{web,worker,sip2}@.service`` (instance = ``%i``)."""
    common_unit = [
        "Documentation=" + REPO_URL + "/blob/main/docs/INSTALL.md",
        "After=network-online.target postgresql.service",
        "Wants=network-online.target",
        f"ConditionPathExists={_p(layout.etc)}/%i.env",
    ]

    def service(component: str, description: str, exec_start: str, extra: list[str]) -> str:
        lines = [
            f"# {PRODUCT_TITLE} {component} - {HEADER.format(product=PRODUCT)}.",
            f"# Per-instance settings: {_p(layout.etc)}/<instance>.env",
            "[Unit]",
            f"Description={PRODUCT_TITLE} {description} (instance %i)",
            *common_unit,
            f"PartOf={PRODUCT}@%i.target",
            "",
            "[Service]",
            "Type=exec",
            f"User={SERVICE_USER}",
            f"Group={SERVICE_GROUP}",
            f"EnvironmentFile={_p(layout.etc)}/%i.env",
            "Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1",
            f"WorkingDirectory={_p(layout.data)}/%i",
            f"ExecStart={exec_start}",
            "Restart=on-failure",
            "RestartSec=5",
            *extra,
            f"StandardOutput=append:{_p(layout.logs)}/%i/{component}.log",
            "StandardError=inherit",
            f"SyslogIdentifier={PRODUCT}-{component}-%i",
            *_hardening(layout),
            "",
            "[Install]",
            f"WantedBy={PRODUCT}@%i.target",
            "",
        ]
        return "\n".join(lines)

    def cmd(component: str) -> str:
        return " ".join(component_argv(component, python))

    web = service("web", "web server", cmd("web"), ["TimeoutStopSec=30"])
    # SIGTERM lets running jobs finish before the worker exits
    worker = service("worker", "background jobs and scheduler", cmd("worker"), ["TimeoutStopSec=120", "KillMode=mixed"])
    sip2 = service("sip2", "SIP2 server", cmd("sip2"), ["TimeoutStopSec=30"])
    target = "\n".join([
        f"# {PRODUCT_TITLE} instance target - {HEADER.format(product=PRODUCT)}.",
        "[Unit]",
        f"Description={PRODUCT_TITLE} instance %i",
        "Documentation=" + REPO_URL + "/blob/main/docs/INSTALL.md",
        f"ConditionPathExists={_p(layout.etc)}/%i.env",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    ])
    return {
        unit_name("web"): web,
        unit_name("worker"): worker,
        unit_name("sip2"): sip2,
        f"{PRODUCT}@.target": target,
    }


# ------------------------------------------------------------------ reverse proxies


def render_caddy_site(name: str, domain: str, port: int, email: str | None = None) -> str:
    tls = f"\n\ttls {email}" if email else ""
    return (
        f"# {PRODUCT_TITLE} instance '{name}' - {HEADER.format(product=PRODUCT)}; local edits are overwritten.\n"
        f"{domain} {{{tls}\n"
        "\tencode zstd gzip\n"
        "\trequest_body {\n"
        "\t\tmax_size 60MB\n"
        "\t}\n"
        "\t@metrics path /metrics\n"
        "\trespond @metrics 404\n"
        f"\treverse_proxy 127.0.0.1:{port} {{\n"
        "\t\theader_up X-Request-ID {http.request.uuid}\n"
        "\t}\n"
        "}\n"
    )


def caddy_import_line(layout: Layout) -> str:
    return f"import {_p(layout.caddy_sites)}/*.caddy"


def render_caddy_main(layout: Layout) -> str:
    """Replacement for the stock Debian Caddyfile (which only serves a placeholder page on :80)."""
    return (
        f"# Caddy configuration written by `{PRODUCT} instance` (the original is kept as Caddyfile.dpkg-orig).\n"
        "# Add your own sites below; Librowise instances live in their own files.\n"
        f"{caddy_import_line(layout)}\n"
    )


def render_nginx_site(name: str, domain: str, port: int) -> str:
    upstream = f"{PRODUCT}_{name.replace('-', '_')}"
    return f"""# {PRODUCT_TITLE} instance '{name}' - {HEADER.format(product=PRODUCT)}.
# HTTPS:  sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d {domain}
# then set {ENV_PREFIX}COOKIE_SECURE=true and {ENV_PREFIX}PUBLIC_URL=https://{domain} in the instance env file and
# run `{PRODUCT} instance restart {name}`. Files edited by certbot are never overwritten.
upstream {upstream} {{
    server 127.0.0.1:{port};
    keepalive 16;
}}

server {{
    listen 80;
    listen [::]:80;
    server_name {domain};
    client_max_body_size 60m;               # MARC imports up to 50 MB
    location = /metrics {{ return 404; }}    # scrape from the host instead
    location / {{
        proxy_pass http://{upstream};
        proxy_http_version 1.1;
        proxy_set_header Connection        "";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-ID      $request_id;
        proxy_read_timeout 120s;             # AI requests can take a while
    }}
}}
"""


def render_logrotate(layout: Layout) -> str:
    return f"""# {PRODUCT_TITLE} - {HEADER.format(product=PRODUCT)}.
{_p(layout.logs)}/*.log {_p(layout.logs)}/*/*.log {{
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}}
"""
