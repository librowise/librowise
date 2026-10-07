"""Internationalisation: catalog completeness, negotiation, rendering and plurals."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from conftest import login

from shelfwise import i18n

ROOT = Path(i18n.__file__).resolve().parent.parent
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def _placeholders(value) -> set[str]:
    values = value.values() if isinstance(value, dict) else [value]
    return {p for v in values for p in PLACEHOLDER.findall(str(v))}


def test_shipped_languages():
    langs = i18n.languages()
    assert list(langs)[0] == "en" and "hi" in langs
    assert langs["hi"] == "हिन्दी"
    for code in langs:
        assert json.loads((ROOT / "i18n" / f"{code}.json").read_text(encoding="utf-8"))["_meta"]["name"]


@pytest.mark.parametrize("code", [c for c in i18n.languages() if c != "en"])
def test_catalog_is_complete_and_consistent(code):
    en, other = i18n.catalog("en"), i18n.catalog(code)
    missing = sorted(set(en) - set(other))
    extra = sorted(set(other) - set(en))
    assert not missing, f"{code} is missing {len(missing)} keys: {missing[:20]}"
    assert not extra, f"{code} has keys that English does not: {extra[:20]}"
    for key, value in en.items():
        assert _placeholders(other[key]) == _placeholders(value), f"{code}:{key} placeholders differ"
        if isinstance(value, dict):
            assert isinstance(other[key], dict) and "other" in other[key], f"{code}:{key} must be a plural object"
        assert str(other[key]).strip(), f"{code}:{key} is empty"


def test_every_key_used_in_templates_and_js_exists():
    en = i18n.catalog("en")
    pattern = re.compile(r"""\bt\(\s*['"]([a-z_]+(?:\.[a-z0-9_]+)+)['"]""")
    used: set[str] = set()
    for folder, glob in (("templates", "**/*.html"), ("static/js", "**/*.js")):
        for path in (ROOT / folder).glob(glob):
            used |= set(pattern.findall(path.read_text(encoding="utf-8")))
    # keys with an English fallback in code (other agents' nav entries etc.) are allowed to be absent
    optional = {k for k in used if k.startswith("nav.")} - set(en)
    missing = sorted(used - set(en) - optional)
    assert not missing, f"keys used but not in en.json: {missing}"


def test_negotiation_order():
    assert i18n.negotiate(accept_language="hi-IN,hi;q=0.9,en;q=0.8") == "hi"
    assert i18n.negotiate(accept_language="fr-FR,fr;q=0.9") == "en"
    assert i18n.negotiate(accept_language="fr;q=0.9, hi;q=0.5") == "hi"
    assert i18n.negotiate(accept_language="hi;q=0, en") == "en"
    assert i18n.negotiate(cookie="hi", accept_language="en") == "hi"
    assert i18n.negotiate(preference="en", cookie="hi", accept_language="hi") == "en"
    assert i18n.negotiate(query="hi", preference="en") == "hi"
    assert i18n.negotiate(query="xx", cookie="../../etc", accept_language="*") == "en"
    assert i18n.normalise("HI_in") == "hi" and i18n.normalise("") is None


def test_translate_plurals_and_interpolation():
    assert i18n.translate("en", "opac.search.results", count=1) == "1 result"
    assert i18n.translate("en", "opac.search.results", count=3) == "3 results"
    assert i18n.translate("hi", "opac.record.n_stars", count=1) == "1 सितारा"
    assert i18n.translate("hi", "opac.record.n_stars", count=0) == "0 सितारा"  # CLDR: Hindi 0 and 1 are "one"
    assert i18n.translate("hi", "opac.record.n_stars", count=4) == "4 सितारे"
    assert i18n.translate("hi", "opac.account.hello", name="Asha") == "नमस्ते, Asha"
    assert i18n.translate("hi", "no.such.key", "Fallback {x}", x=1) == "Fallback 1"
    assert i18n.translate("hi", "no.such.key") == "no.such.key"
    assert i18n.text_direction("ur") == "rtl" and i18n.text_direction("hi") == "ltr"


def test_pages_render_in_negotiated_language(client, lib):
    r = client.get("/", headers={"Accept-Language": "hi-IN,hi;q=0.9"})
    assert r.status_code == 200
    assert '<html lang="hi" dir="ltr"' in r.text and "अब आप क्या पढ़ेंगे?" in r.text
    assert r.headers["content-language"] == "hi"
    boot = json.loads(re.search(r'<script type="application/json" id="i18n">(.*?)</script>', r.text, re.S).group(1))
    assert boot["lang"] == "hi" and boot["messages"]["common.search"] == "खोजें"
    assert '<h1 id="hero-title">What will you read next?</h1>' in client.get("/", headers={"Accept-Language": "en"}).text
    # ?lang= switches and is remembered in a cookie
    r = client.get("/search?lang=hi")
    assert "सूची में खोजें" in r.text and client.cookies.get("sw_lang") == "hi"
    assert '<html lang="hi"' in client.get("/login").text


def test_user_preference_wins_and_staff_nav_is_translated(client, lib):
    h = login(client, "librarian")
    assert client.patch("/api/v1/auth/preferences", headers=h, json={"language": "hi"}).status_code == 200
    r = client.get("/staff", headers={"Accept-Language": "en"})
    assert '<html lang="hi"' in r.text and "डैशबोर्ड" in r.text and "परिसंचरण" in r.text
    assert "आपको देखकर अच्छा लगा" in r.text
    assert r.headers["cache-control"] == "private, no-store"


def test_language_switcher_lists_all_languages(client, lib):
    html = client.get("/").text
    assert 'data-lang-switch' in html
    for code, name in i18n.languages().items():
        assert f'value="{code}"' in html and name in html
