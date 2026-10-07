"""The single doorway to the operating system.

Every side effect of the instance tool (files, ownership, commands, processes, sockets) goes
through :class:`System`. Tests inject a subclass that records calls instead of executing them,
and ``--dry-run`` uses ``System(dry_run=True)``, which prints each mutating action instead of
performing it (read-only probes still run, so the plan reflects the real machine).
"""

from __future__ import annotations

import os
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from .common import InstanceError


def _fmt_cmd(cmd: list[str]) -> str:
    import shlex

    return " ".join(shlex.quote(str(c)) for c in cmd)


class System:
    def __init__(self, *, dry_run: bool = False, verbose: bool = True, out=None):
        self.dry_run = dry_run
        self.verbose = verbose
        self._out = out or (lambda msg: print(msg, flush=True))
        self.actions: list[str] = []  # every mutating action, in order (used by tests and --dry-run)

    # ---------------------------------------------------------------- reporting
    def say(self, msg: str) -> None:
        self._out(msg)

    def _act(self, msg: str) -> bool:
        """Record a mutating action. Returns True when it must actually be performed."""
        self.actions.append(msg)
        if self.dry_run:
            self._out(f"  [dry-run] {msg}")
            return False
        if self.verbose:
            self._out(f"  - {msg}")
        return True

    # ---------------------------------------------------------------- platform facts
    @property
    def platform(self) -> str:
        return sys.platform

    @property
    def is_windows(self) -> bool:
        return self.platform == "win32"

    @property
    def is_linux(self) -> bool:
        return self.platform.startswith("linux")

    def is_root(self) -> bool:
        return hasattr(os, "geteuid") and os.geteuid() == 0

    def has_systemd(self) -> bool:
        """True when systemd is PID 1 (not inside most containers)."""
        return self.is_linux and Path("/run/systemd/system").is_dir() and bool(self.which("systemctl"))

    def which(self, name: str) -> str | None:
        return shutil.which(name)

    def user_exists(self, name: str) -> bool:
        try:
            import pwd

            pwd.getpwnam(name)
            return True
        except (ImportError, KeyError):
            return False

    def now(self) -> datetime:
        return datetime.now(UTC)

    def environ(self) -> dict[str, str]:
        return dict(os.environ)

    # ---------------------------------------------------------------- files (reads are never faked)
    def exists(self, path: Path) -> bool:
        return Path(path).exists() or Path(path).is_symlink()

    def read_text(self, path: Path) -> str | None:
        try:
            return Path(path).read_text(encoding="utf-8")
        except (FileNotFoundError, NotADirectoryError):
            return None

    def write(self, path: Path, content: str, *, mode: int = 0o644, owner: str | None = None,
              group: str | None = None, secret: bool = False) -> bool:
        """Write ``content`` if it differs; enforce mode/ownership either way. Returns True if changed."""
        path = Path(path)
        current = self.read_text(path)
        changed = current != content
        perm = f"{mode:04o}" + (f" {owner or 'root'}:{group}" if group else "")
        if changed:
            what = "secrets, not shown" if secret else f"{len(content.splitlines())} lines"
            if self._act(f"{'update' if current is not None else 'write'} {path} ({perm}; {what})"):
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_name(f".{path.name}.tmp")
                # Create with restrictive permissions before any secret is written.
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(content)
                self._apply_perms(tmp, mode, owner, group)
                os.replace(tmp, path)
        else:
            self._apply_perms(path, mode, owner, group, quiet=True)
        return changed

    def _apply_perms(self, path: Path, mode: int, owner: str | None, group: str | None, quiet: bool = False) -> None:
        if self.dry_run:
            return
        try:
            os.chmod(path, mode)
        except OSError:
            pass
        if group or owner:
            self.chown(path, owner, group, quiet=quiet)

    def chown(self, path: Path, owner: str | None, group: str | None, quiet: bool = False) -> None:
        if self.is_windows or not self.is_root():
            return
        if not quiet and not self._act(f"chown {owner or ''}:{group or ''} {path}"):
            return
        shutil.chown(path, user=owner, group=group)

    def mkdir(self, path: Path, *, mode: int = 0o755, owner: str | None = None, group: str | None = None) -> bool:
        path = Path(path)
        if path.is_dir():
            if not self.dry_run:
                self._apply_perms(path, mode, owner, group, quiet=True)
            return False
        perm = f"{mode:04o}" + (f" {owner or 'root'}:{group}" if group or owner else "")
        if self._act(f"create directory {path} ({perm})"):
            path.mkdir(parents=True, exist_ok=True)
            self._apply_perms(path, mode, owner, group, quiet=True)
        return True

    def remove_file(self, path: Path) -> bool:
        path = Path(path)
        if not (path.exists() or path.is_symlink()):
            return False
        if self._act(f"remove {path}"):
            path.unlink()
        return True

    def remove_tree(self, path: Path) -> bool:
        path = Path(path)
        if not path.exists():
            return False
        if self._act(f"delete directory {path} and everything in it"):
            shutil.rmtree(path)
        return True

    def symlink(self, target: Path, link: Path) -> bool:
        link = Path(link)
        if link.is_symlink() and os.readlink(link) == str(target):
            return False
        if self._act(f"link {link} -> {target}"):
            if link.is_symlink() or link.exists():
                link.unlink()
            link.symlink_to(target)
        return True

    def rename(self, src: Path, dst: Path) -> None:
        if self._act(f"move {src} -> {dst}"):
            os.replace(src, dst)

    # ---------------------------------------------------------------- commands
    def run(self, cmd: list[str], *, input: str | None = None, env: dict | None = None, cwd: Path | None = None,
            check: bool = True, capture: bool = True, mutate: bool = True, timeout: float | None = None,
            describe: str | None = None) -> subprocess.CompletedProcess:
        """Run a command. ``mutate=False`` marks read-only probes that also run under --dry-run."""
        label = describe or f"run {_fmt_cmd(cmd)}"
        if mutate:
            if not self._act(label):
                return subprocess.CompletedProcess(cmd, 0, "", "")
        try:
            proc = subprocess.run([str(c) for c in cmd], input=input, env=env, cwd=cwd, text=True,
                                  capture_output=capture, timeout=timeout, check=False)
        except FileNotFoundError as exc:
            if check and not (self.dry_run and not mutate):
                raise InstanceError(f"command not found: {cmd[0]}") from exc
            return subprocess.CompletedProcess(cmd, 127, "", str(exc))
        except subprocess.TimeoutExpired as exc:
            if check:
                raise InstanceError(f"timed out after {timeout:.0f}s: {_fmt_cmd(cmd)}") from exc
            return subprocess.CompletedProcess(cmd, 124, "", "timeout")
        if check and proc.returncode != 0 and not (self.dry_run and not mutate):
            detail = ((proc.stderr or "") + (proc.stdout or "")).strip() if capture else ""
            raise InstanceError(f"command failed ({proc.returncode}): {describe or _fmt_cmd(cmd)}"
                                + (f"\n{detail[-2000:]}" if detail else ""))
        return proc

    # ---------------------------------------------------------------- background processes
    def spawn(self, cmd: list[str], *, env: dict, cwd: Path, log: Path, describe: str) -> int:
        """Start a detached background process with stdout/stderr appended to ``log``."""
        if not self._act(describe):
            return 0
        log.parent.mkdir(parents=True, exist_ok=True)
        fh = open(log, "ab")  # noqa: SIM115 - handed to the child
        kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": fh, "stderr": subprocess.STDOUT,
                        "env": env, "cwd": str(cwd)}
        if self.is_windows:
            kwargs["creationflags"] = (subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
                                       | subprocess.CREATE_NO_WINDOW)
        else:
            kwargs["start_new_session"] = True
        try:
            proc = subprocess.Popen([str(c) for c in cmd], **kwargs)
        finally:
            fh.close()
        return proc.pid

    def pid_alive(self, pid: int) -> bool:
        if pid <= 0:
            return False
        if self.is_windows:
            import ctypes

            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            code = ctypes.c_ulong()
            try:
                kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            finally:
                kernel32.CloseHandle(handle)
            return code.value == 259  # STILL_ACTIVE
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        try:  # a zombie child of ours counts as stopped
            done, _ = os.waitpid(pid, os.WNOHANG)
            return done == 0
        except ChildProcessError:
            return True

    def terminate(self, pid: int, *, describe: str, timeout: float = 20.0) -> None:
        if not self._act(describe):
            return
        if self.is_windows:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False)
        else:
            try:
                os.killpg(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and self.pid_alive(pid):
            time.sleep(0.2)
        if self.pid_alive(pid) and not self.is_windows:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    def exec_foreground(self, cmd: list[str], *, env: dict, cwd: Path) -> int:
        """Run attached to the terminal (``instance shell``/``serve``); returns the exit status."""
        if not self._act(f"run {_fmt_cmd(cmd)}"):
            return 0
        try:
            return subprocess.call([str(c) for c in cmd], env=env, cwd=str(cwd))
        except KeyboardInterrupt:
            return 130

    # ---------------------------------------------------------------- network
    def port_free(self, host: str, port: int) -> bool:
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        with socket.socket(family, socket.SOCK_STREAM) as s:
            if not self.is_windows:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
            except OSError:
                return False
        return True

    def port_open(self, host: str, port: int, timeout: float = 1.0) -> bool:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            return False

    def http_get(self, url: str, timeout: float = 5.0) -> tuple[int, str]:
        import urllib.error
        import urllib.request

        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - local health URLs
                return resp.status, resp.read(4096).decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(4096).decode("utf-8", "replace")
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            return 0, str(exc)

    def cert_expiry(self, host: str, port: int = 443, timeout: float = 5.0) -> datetime | None:
        """Expiry of the certificate ``host`` presents (verified against the system trust store)."""
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                cert = tls.getpeercert()
        not_after = cert.get("notAfter") if cert else None
        if not not_after:
            return None
        return datetime.fromtimestamp(ssl.cert_time_to_seconds(not_after), UTC)

    def disk_usage(self, path: Path):
        p = Path(path)
        while not p.exists() and p != p.parent:
            p = p.parent
        return shutil.disk_usage(p)

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)
