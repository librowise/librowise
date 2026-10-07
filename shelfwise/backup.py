"""Database backups and restores.

* SQLite — the online backup API copies a consistent snapshot while the application keeps
  running (WAL readers and writers are not blocked), then ``PRAGMA integrity_check`` verifies it.
* PostgreSQL — ``pg_dump --format=custom`` (needs the PostgreSQL client tools on PATH), verified
  by listing the archive with ``pg_restore --list``.

Every backup gets a JSON manifest (size, SHA-256, kind, version) next to it; retention keeps the
newest ``keep`` backups. Restores verify the checksum first and, for SQLite, take a safety copy
of the current database before overwriting it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.engine import make_url

from . import __version__
from .config import get_settings

PREFIX = "shelfwise-"
SUFFIXES = {"sqlite": ".sqlite3", "postgresql": ".dump"}


class BackupError(RuntimeError):
    pass


def _url():
    return make_url(get_settings().database_url)


def _kind(url=None) -> str:
    backend = (url or _url()).get_backend_name()
    if backend not in SUFFIXES:
        raise BackupError(f"Backups are not supported for {backend} databases")
    return backend


def backup_dir(dest: str | os.PathLike | None = None) -> Path:
    path = Path(dest or get_settings().backup_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sqlite_path(url) -> Path:
    if not url.database or url.database == ":memory:":
        raise BackupError("In-memory SQLite databases cannot be backed up")
    return Path(url.database)


def _pg_env(url) -> tuple[str, dict]:
    """libpq connection string without the password (passed via PGPASSWORD, not argv)."""
    env = dict(os.environ)
    if url.password:
        env["PGPASSWORD"] = str(url.password)
    conn = url.set(drivername="postgresql", password=None).render_as_string(hide_password=False)
    return conn, env


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise BackupError(f"{name} not found on PATH — install the PostgreSQL client tools (postgresql-client)")
    return path


def verify(path: Path, kind: str | None = None) -> None:
    """Raise BackupError unless ``path`` is a readable, consistent backup."""
    path = Path(path)
    if not path.is_file():
        raise BackupError(f"{path} does not exist")
    manifest = path.with_name(path.name + ".json")
    if manifest.exists():
        meta = json.loads(manifest.read_text(encoding="utf-8"))
        if meta.get("sha256") and meta["sha256"] != _sha256(path):
            raise BackupError(f"Checksum mismatch for {path.name} — the file is corrupt or was modified")
        kind = kind or meta.get("kind")
    kind = kind or ("sqlite" if path.suffix == ".sqlite3" else "postgresql")
    if kind == "sqlite":
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            result = con.execute("PRAGMA integrity_check").fetchone()[0]
            con.execute("SELECT count(*) FROM sqlite_master").fetchone()
        except sqlite3.DatabaseError as exc:
            raise BackupError(f"{path.name} is not a valid SQLite database: {exc}") from exc
        finally:
            con.close()
        if result != "ok":
            raise BackupError(f"Integrity check failed for {path.name}: {result}")
    else:
        proc = subprocess.run([_tool("pg_restore"), "--list", str(path)], capture_output=True, text=True)
        if proc.returncode != 0 or "Archive created at" not in proc.stdout:
            raise BackupError(f"pg_restore could not read {path.name}: {proc.stderr.strip()[:500]}")


def create_backup(dest: str | os.PathLike | None = None, keep: int | None = None, *, label: str = "") -> dict:
    url = _url()
    kind = _kind(url)
    folder = backup_dir(dest)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    name = f"{PREFIX}{label + '-' if label else ''}{stamp}{SUFFIXES[kind]}"
    final = folder / name
    n = 1
    while final.exists():
        final = folder / name.replace(stamp, f"{stamp}-{n}")
        n += 1
    tmp = final.with_name(final.name + ".partial")
    try:
        if kind == "sqlite":
            src = sqlite3.connect(_sqlite_path(url).as_posix())
            dst = sqlite3.connect(tmp.as_posix())
            try:
                src.backup(dst, pages=4096)  # copies in steps; writers are only briefly paused
            finally:
                dst.close()
                src.close()
        else:
            conn, env = _pg_env(url)
            proc = subprocess.run([_tool("pg_dump"), "--format=custom", "--no-owner", "--no-privileges",
                                   "--file", str(tmp), "--dbname", conn], capture_output=True, text=True, env=env)
            if proc.returncode != 0:
                raise BackupError(f"pg_dump failed: {proc.stderr.strip()[:1000]}")
        verify(tmp, kind)
        tmp.replace(final)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    info = {"file": str(final), "name": final.name, "kind": kind, "size": final.stat().st_size,
            "sha256": _sha256(final), "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "version": __version__, "database": url.render_as_string(hide_password=True)}
    final.with_name(final.name + ".json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    info["pruned"] = prune(folder, keep if keep is not None else get_settings().backup_keep)
    return info


def list_backups(dest: str | os.PathLike | None = None) -> list[dict]:
    folder = Path(dest or get_settings().backup_dir)
    if not folder.is_dir():
        return []
    out = []
    for path in folder.iterdir():
        if not path.name.startswith(PREFIX) or path.suffix not in SUFFIXES.values():
            continue
        meta = {}
        manifest = path.with_name(path.name + ".json")
        if manifest.exists():
            try:
                meta = json.loads(manifest.read_text(encoding="utf-8"))
            except ValueError:
                meta = {}
        st = path.stat()
        out.append({"name": path.name, "size": st.st_size, "kind": meta.get("kind") or
                    ("sqlite" if path.suffix == ".sqlite3" else "postgresql"),
                    "created_at": meta.get("created_at") or datetime.fromtimestamp(st.st_mtime, UTC).isoformat(timespec="seconds"),
                    "sha256": meta.get("sha256"), "version": meta.get("version"), "has_manifest": bool(meta)})
    out.sort(key=lambda b: b["created_at"], reverse=True)
    return out


def prune(folder: Path, keep: int) -> list[str]:
    if keep <= 0:
        return []
    removed = []
    for b in list_backups(folder)[keep:]:
        if "-pre-restore-" in b["name"]:
            continue
        for p in (folder / b["name"], folder / (b["name"] + ".json")):
            p.unlink(missing_ok=True)
        removed.append(b["name"])
    return removed


def restore(file: str | os.PathLike, *, safety_backup: bool = True) -> dict:
    """Replace the current database with ``file``. Destructive — callers must confirm first."""
    path = Path(file)
    url = _url()
    kind = _kind(url)
    verify(path)
    if (kind == "sqlite") != (path.suffix == ".sqlite3"):
        raise BackupError(f"{path.name} is not a {kind} backup")
    safety = create_backup(label="pre-restore", keep=0)["file"] if safety_backup else None
    from .db import get_engine

    get_engine().dispose()  # close pooled connections before overwriting
    if kind == "sqlite":
        src = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        dst = sqlite3.connect(_sqlite_path(url).as_posix())
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
    else:
        conn, env = _pg_env(url)
        proc = subprocess.run([_tool("pg_restore"), "--clean", "--if-exists", "--no-owner", "--no-privileges",
                               "--single-transaction", "--dbname", conn, str(path)],
                              capture_output=True, text=True, env=env)
        if proc.returncode != 0:
            raise BackupError(f"pg_restore failed: {proc.stderr.strip()[:1000]}")
    return {"restored": path.name, "kind": kind, "safety_backup": safety}
