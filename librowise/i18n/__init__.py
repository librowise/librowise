"""Lightweight internationalisation.

Message catalogs are JSON files in this package (``en.json``, ``hi.json``, …). Keys are nested
objects for readability and flattened to dotted keys on load (``"opac.home.title"``). A leaf may be
a plural object keyed by CLDR plural category (``{"one": "…", "other": "…"}``) — pass ``count=n``.
Placeholders use ``{name}`` syntax.

Language negotiation order: ``?lang=`` query parameter (also remembered in a cookie) → the signed-in
user's ``preferences.language`` → the ``sw_lang`` cookie → ``Accept-Language`` → English.

Adding a language: drop ``<code>.json`` next to ``en.json`` (with ``_meta.name`` set to the
language's native name) — it is picked up automatically. Translating another page: use
``{{ t("key") }}`` in Jinja and ``t("key")`` from ``/static/js/i18n.js`` in page modules, then add
the key to every catalog (``tests/test_experience_i18n.py`` enforces completeness).
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

I18N_DIR = Path(__file__).resolve().parent
DEFAULT_LANG = "en"
LANG_COOKIE = "sw_lang"
RTL_LANGS = frozenset({"ar", "fa", "he", "ur", "ps", "sd", "ug", "yi"})
PLURAL_CATEGORIES = frozenset({"zero", "one", "two", "few", "many", "other"})
_PLACEHOLDER = re.compile(r"\{(\w+)\}")
_LANG_RE = re.compile(r"^[a-z]{2,3}$")


def _is_plural(node: Any) -> bool:
    return isinstance(node, dict) and bool(node) and "other" in node and set(node) <= PLURAL_CATEGORIES


def _flatten(node: dict, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key.startswith("_"):
            continue
        full = f"{prefix}{key}"
        if isinstance(value, dict) and not _is_plural(value):
            out.update(_flatten(value, f"{full}."))
        else:
            out[full] = value
    return out


@lru_cache
def _raw(lang: str) -> dict:
    path = I18N_DIR / f"{lang}.json"
    if not _LANG_RE.match(lang) or not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache
def catalog(lang: str) -> dict[str, Any]:
    """Flattened messages for ``lang`` (missing keys are *not* filled in — see :func:`merged`).

    Besides ``<lang>.json``, modules may ship their own catalogue fragments in
    ``i18n/<area>/<lang>.json`` (e.g. ``i18n/opac/hi.json``); they are merged in alphabetical
    order of area, so feature work never has to edit the same big file.
    """
    out = _flatten(_raw(lang))
    if _LANG_RE.match(lang):
        for frag in sorted(I18N_DIR.glob(f"*/{lang}.json")):
            out.update(_flatten(json.loads(frag.read_text(encoding="utf-8"))))
    return out


@lru_cache
def merged(lang: str) -> dict[str, Any]:
    """Messages for ``lang`` with any missing keys filled from English (what the browser receives)."""
    return {**catalog(DEFAULT_LANG), **catalog(lang)}


@lru_cache
def languages() -> dict[str, str]:
    """``{code: native name}`` for every shipped catalog, English first."""
    codes = sorted(p.stem for p in I18N_DIR.glob("*.json") if _LANG_RE.match(p.stem))
    codes.sort(key=lambda c: (c != DEFAULT_LANG, c))
    return {c: _raw(c).get("_meta", {}).get("name", c) for c in codes}


def text_direction(lang: str) -> str:
    return "rtl" if lang in RTL_LANGS else "ltr"


def plural_category(lang: str, n: float) -> str:
    """CLDR cardinal plural category for the languages we ship (other languages: one/other)."""
    if lang in ("hi", "bn", "gu", "kn", "mr", "fa", "zu"):
        return "one" if n in (0, 1) else "other"  # CLDR: i = 0 or n = 1
    if lang in ("fr", "pt"):
        return "one" if 0 <= n < 2 else "other"
    return "one" if n == 1 else "other"


def _interpolate(message: str, params: dict) -> str:
    return _PLACEHOLDER.sub(lambda m: str(params[m.group(1)]) if m.group(1) in params else m.group(0), message)


def translate(lang: str, key: str, default: str | None = None, **params: Any) -> str:
    message = catalog(lang).get(key)
    if message is None:
        message = catalog(DEFAULT_LANG).get(key)
    if message is None:
        return _interpolate(default, params) if default is not None else key
    if isinstance(message, dict):
        message = message.get(plural_category(lang, float(params.get("count", 0) or 0)), message["other"])
    return _interpolate(str(message), params)


def normalise(code: str | None) -> str | None:
    """Map ``hi-IN`` / ``HI`` / ``hi_IN`` to a shipped catalog code, or None."""
    if not code:
        return None
    base = code.strip().replace("_", "-").split("-")[0].lower()
    return base if base in languages() else None


def parse_accept_language(header: str | None) -> list[str]:
    """Language tags from an Accept-Language header, best first (q-values honoured)."""
    tags: list[tuple[float, int, str]] = []
    for i, part in enumerate((header or "").split(",")):
        bits = part.strip().split(";")
        tag = bits[0].strip()
        if not tag or tag == "*":
            continue
        q = 1.0
        for b in bits[1:]:
            b = b.strip()
            if b.startswith("q="):
                try:
                    q = float(b[2:])
                except ValueError:
                    q = 0.0
        if q > 0:
            tags.append((-q, i, tag))
    return [t for _, _, t in sorted(tags)]


def negotiate(*, query: str | None = None, preference: str | None = None, cookie: str | None = None,
              accept_language: str | None = None) -> str:
    for candidate in (query, preference, cookie):
        if code := normalise(candidate):
            return code
    for tag in parse_accept_language(accept_language):
        if code := normalise(tag):
            return code
    return DEFAULT_LANG


def request_language(request, user=None) -> str:
    """Negotiate the UI language for a Starlette request and optional signed-in user."""
    prefs = (getattr(user, "preferences", None) or {}) if user is not None else {}
    return negotiate(query=request.query_params.get("lang"), preference=prefs.get("language"),
                     cookie=request.cookies.get(LANG_COOKIE), accept_language=request.headers.get("accept-language"))


def install(templates) -> None:
    """Register ``t()`` (global) and ``|t`` (filter) on a Jinja2Templates environment.

    Both read ``lang`` from the template context, which ``web._render`` provides."""
    from jinja2 import pass_context

    @pass_context
    def t(ctx, key: str, default: str | None = None, **params: Any) -> str:
        return translate(ctx.get("lang") or DEFAULT_LANG, key, default, **params)

    templates.env.globals["t"] = t
    templates.env.filters["t"] = t
