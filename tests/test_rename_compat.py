"""The project was renamed Shelfwise → Librowise; old environment variables keep working."""

import importlib
import os


def test_legacy_shelfwise_env_vars_are_honoured(monkeypatch):
    monkeypatch.delenv("LIBROWISE_LIBRARY_COMPAT_PROBE", raising=False)
    monkeypatch.setenv("SHELFWISE_LIBRARY_COMPAT_PROBE", "legacy")
    from librowise import config

    importlib.reload(config)
    assert os.environ["LIBROWISE_LIBRARY_COMPAT_PROBE"] == "legacy"
    monkeypatch.delenv("LIBROWISE_LIBRARY_COMPAT_PROBE")


def test_new_prefix_wins_over_legacy(monkeypatch):
    monkeypatch.setenv("SHELFWISE_LIBRARY_COMPAT_PROBE2", "old")
    monkeypatch.setenv("LIBROWISE_LIBRARY_COMPAT_PROBE2", "new")
    from librowise import config

    importlib.reload(config)
    assert os.environ["LIBROWISE_LIBRARY_COMPAT_PROBE2"] == "new"


def test_console_scripts_and_brand():
    import tomllib
    from pathlib import Path

    data = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    assert data["project"]["name"] == "librowise"
    assert data["project"]["scripts"]["librowise"] == "librowise.__main__:main"
