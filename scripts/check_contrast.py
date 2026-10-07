"""WCAG 2.2 contrast check for the Shelfwise design tokens.

Parses ``shelfwise/static/css/tokens.css``, resolves the semantic tokens of every theme (light, dark,
sepia, high contrast) and checks each foreground/background pair the components actually use:

* 4.5:1 — body text, small text, links, badge/pill text, button labels (WCAG 1.4.3)
* 3:1   — large text, focus indicators, form-control boundaries, icons (WCAG 1.4.11)

Usage::

    python scripts/check_contrast.py           # report, exit 1 on any failure
    python scripts/check_contrast.py --verbose # list every pair

Imported by ``tests/test_design_tokens.py``. Add a pair to ``PAIRS`` whenever a component starts using
a new text/background combination.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

TOKENS = Path(__file__).resolve().parent.parent / "shelfwise" / "static" / "css" / "tokens.css"
THEMES = ("light", "dark", "sepia", "contrast")

TEXT, UI = 4.5, 3.0
# (foreground, background, minimum ratio, where it is used)
PAIRS: list[tuple[str, str, float, str]] = [
    # body copy and secondary text on every surface
    *[(fg, bg, TEXT, "text") for fg in ("text", "text-2", "muted") for bg in ("bg", "surface", "surface-2", "surface-raised")],
    ("text", "surface-3", TEXT, "text on hovered/pressed rows"),
    ("text-2", "surface-3", TEXT, "secondary text on chips/skeleton rows"),
    ("text-inverse", "surface-inverse", TEXT, "tooltips, neutral toasts"),
    # links and primary actions
    ("primary", "surface", TEXT, "links, ghost buttons"),
    ("primary", "bg", TEXT, "links on the page background"),
    ("primary", "surface-2", TEXT, "links in toolbars / table headers"),
    ("primary", "primary-soft", TEXT, "selected nav item, pressed chip, active facet"),
    ("primary-text", "primary", TEXT, "primary button label"),
    ("primary-text", "primary-2", TEXT, "primary button label (hover)"),
    ("brand-ink", "brand-1", UI, "logo glyph on the brand mark"),
    # semantic text on its soft tint (pills, alerts) and on plain surfaces (inline status text)
    *[(tone, f"{tone}-soft", TEXT, f"{tone} pill / alert") for tone in ("success", "warning", "danger", "info", "ai")],
    *[(tone, "surface", TEXT, f"{tone} inline text") for tone in ("success", "warning", "danger", "info", "ai")],
    ("accent", "accent-soft", TEXT, "announcement / accent badge"),
    ("text", "warning-soft", TEXT, "body text inside warning alerts"),
    ("text", "danger-soft", TEXT, "body text inside error alerts"),
    ("text", "primary-soft", TEXT, "text on selected rows"),
    # non-text contrast
    ("focus", "bg", UI, "focus ring"),
    ("focus", "surface", UI, "focus ring"),
    ("border-input", "surface", UI, "text field / select / checkbox boundary"),
    ("border-input", "bg", UI, "text field boundary on page background"),
    ("primary", "surface", UI, "selected tab underline, switch on"),
    ("danger", "surface", UI, "error field boundary"),
    ("muted", "surface", UI, "icons"),
]

HEX = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _blocks(css: str) -> list[tuple[str, str]]:
    """Flatten the stylesheet into (selector, declarations), unwrapping @media blocks.

    @media selectors are prefixed with ``@media …|`` so callers can tell them apart."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out: list[tuple[str, str]] = []
    i, prefix_stack, start = 0, [], 0
    selector_start = 0
    while i < len(css):
        ch = css[i]
        if ch == "{":
            selector = css[selector_start:i].strip()
            if selector.startswith("@media") or selector.startswith("@supports"):
                prefix_stack.append(selector)
                selector_start = i + 1
            elif selector.startswith("@font-face"):
                end = css.index("}", i)
                i = end
                selector_start = i + 1
            else:
                end = css.index("}", i)
                prefix = "|".join(prefix_stack)
                out.append((f"{prefix}|{selector}" if prefix else selector, css[i + 1:end]))
                i = end
                selector_start = i + 1
            start = i
        elif ch == "}":
            if prefix_stack:
                prefix_stack.pop()
            selector_start = i + 1
        i += 1
    del start
    return out


def _decls(body: str) -> dict[str, str]:
    out = {}
    for part in body.split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            k = k.strip()
            if k.startswith("--"):
                out[k[2:]] = v.strip()
    return out


def theme_tokens(css: str | None = None) -> dict[str, dict[str, str]]:
    """Raw (unresolved) token values per theme."""
    css = css if css is not None else TOKENS.read_text(encoding="utf-8")
    blocks = _blocks(css)
    base: dict[str, str] = {}
    themes: dict[str, dict[str, str]] = {t: {} for t in THEMES if t != "light"}
    media_dark: dict[str, str] = {}
    for selector, body in blocks:
        if selector == ":root":
            base.update(_decls(body))
        for t in themes:
            if selector == f':root[data-theme="{t}"]':
                themes[t].update(_decls(body))
        if selector.startswith("@media (prefers-color-scheme: dark)|") and selector.endswith(":root:not([data-theme])"):
            media_dark.update(_decls(body))
    out = {"light": dict(base)}
    for t, overrides in themes.items():
        out[t] = {**base, **overrides}
    out["_media_dark"] = {**base, **media_dark}
    return out


def _hex(value: str) -> tuple[float, float, float]:
    v = value.lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    return tuple(int(v[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def resolve(tokens: dict[str, str], name: str, depth: int = 0) -> tuple[float, float, float]:
    """Resolve a token to sRGB (0–1). Supports hex, var() and color-mix(in srgb, a p%, b)."""
    if depth > 10:
        raise ValueError(f"reference cycle at --{name}")
    value = tokens[name].strip()
    return _color(tokens, value, depth)


def _color(tokens: dict[str, str], value: str, depth: int) -> tuple[float, float, float]:
    value = value.strip()
    if HEX.match(value):
        return _hex(value)
    m = re.fullmatch(r"var\(--([\w-]+)\)", value)
    if m:
        return resolve(tokens, m.group(1), depth + 1)
    m = re.fullmatch(r"color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)\)", value)
    if m:
        a, pct, b = _color(tokens, m.group(1), depth + 1), float(m.group(2)) / 100, _color(tokens, m.group(3), depth + 1)
        return tuple(x * pct + y * (1 - pct) for x, y in zip(a, b, strict=True))  # type: ignore[return-value]
    raise ValueError(f"cannot resolve colour {value!r}")


def luminance(rgb: tuple[float, float, float]) -> float:
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def ratio(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def check(verbose: bool = False, css: str | None = None) -> list[str]:
    """Return a list of failure messages (empty = all pairs pass)."""
    all_tokens = theme_tokens(css)
    failures: list[str] = []
    dark, media = all_tokens["dark"], all_tokens["_media_dark"]
    for key in sorted(set(dark) | set(media)):
        if dark.get(key) != media.get(key):
            failures.append(f"dark: --{key} differs between [data-theme=dark] ({dark.get(key)}) "
                            f"and the prefers-color-scheme block ({media.get(key)})")
    for theme in THEMES:
        tokens = all_tokens[theme]
        for fg, bg, minimum, use in PAIRS:
            r = ratio(resolve(tokens, fg), resolve(tokens, bg))
            ok = r + 1e-9 >= minimum
            line = f"{theme:8} {('ok' if ok else 'FAIL'):4} {r:5.2f}:1 (min {minimum}) --{fg} on --{bg}  [{use}]"
            if verbose:
                print(line)
            if not ok:
                failures.append(line)
    return failures


def main(argv: list[str]) -> int:
    failures = check(verbose="--verbose" in argv or "-v" in argv)
    if failures:
        print(f"{len(failures)} contrast failure(s):")
        for f in failures:
            print("  " + f)
        return 1
    print(f"All {len(PAIRS)} token pairs pass WCAG 2.2 AA in {len(THEMES)} themes.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
