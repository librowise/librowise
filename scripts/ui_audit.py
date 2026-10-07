"""Shelfwise UI audit: every page x role x theme x viewport, with screenshots, axe-core and Web Vitals.

What it does
------------
* Signs in once per role (anonymous, patron, librarian, admin) through ``POST /api/v1/auth/login`` and
  reuses the session cookies for every visit.
* Visits every HTML page. The page list is declared in ``PAGES`` below and cross-checked against the
  routes registered in ``shelfwise/web.py`` (uncovered routes are listed in the report so the table
  never silently rots). Dynamic pages use real ids looked up through the JSON API (a record, a patron,
  a serial subscription, a claim batch, courses) and a kiosk device token minted for the audit.
* Renders each page in the light / dark / sepia / contrast themes (``sw-prefs`` in localStorage, then
  enforced on ``<html data-theme>``) at 1440x900 (desktop) and 390x844 (mobile), and captures a
  full-page screenshot.
* Records console errors, uncaught exceptions, failed requests (4xx/5xx and network failures), CSP
  violations (CSP stays *enforced*: the harness injects axe through an init script, which CSP does not
  govern), horizontal overflow, elements that spill out of the viewport or their own box, images
  without ``alt``, unlabeled form controls, unnamed buttons/links, duplicate ids and heading issues.
* Runs axe-core (WCAG 2.0/2.1/2.2 A + AA tags) on every visit; the script is fetched once from the npm
  registry tarball, verified against the registry's sha512 integrity and cached under
  ``var/ui-audit/.cache`` (git-ignored).
* Measures TTFB, FCP, LCP (PerformanceObserver), CLS, DOM size, request count and transfer size.
* Optional i18n pass (``--langs hi,ur``): renders each page in Hindi/Urdu and lists visible UI strings
  that are still Latin-script (a heuristic; book data is excluded where it can be recognised).
* Writes ``var/ui-audit/report.json`` and ``var/ui-audit/index.html`` (thumbnail grid per page with
  the issues inline) and exits non-zero on serious/critical axe violations, console/page errors or 5xx
  responses (configurable with ``--fail-on`` / ``--no-fail``).

Running it
----------
Against a server you started yourself::

    python scripts/ui_audit.py --base-url http://127.0.0.31:8781

Or let the script seed a throw-away SQLite database and run the server for you::

    python scripts/ui_audit.py --serve

Useful flags: ``--pages circ,record`` (substring filter on page ids), ``--themes light,dark``,
``--viewports desktop``, ``--roles librarian``, ``--concurrency 6``, ``--no-axe``,
``--no-screenshots``, ``--langs none``, ``--browser chromium`` (CI) / ``--browser msedge`` (default on
Windows when Edge is installed). Needs ``pip install playwright`` (in the ``dev`` extra); with
``--browser chromium`` also ``python -m playwright install chromium``.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "var" / "ui-audit"
DEFAULT_BASE = "http://127.0.0.31:8781"
AXE_VERSION = "4.14.0"

THEMES = ("light", "dark", "sepia", "contrast")
VIEWPORTS = {"desktop": (1440, 900), "mobile": (390, 844)}
ROLES = ("anonymous", "patron", "librarian", "admin")
AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
IMPACT_RANK = {"minor": 1, "moderate": 2, "serious": 3, "critical": 4}
# Scripts each language is expected to render in (used by the untranslated-string heuristic).
LANG_SCRIPTS = {"hi": "ऀ-ॿ", "ur": "؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿"}


# ------------------------------------------------------------------ page catalogue


@dataclass
class Page:
    """One audited screen. ``path`` may contain ``{placeholders}`` filled from the seeded ids."""

    id: str
    family: str
    path: str
    role: str = "librarian"  # staff pages escalate to admin automatically when the librarian is redirected
    route: str | None = None  # the web.py route template this page covers (defaults to path sans query/hash)
    actions: list[tuple] = field(default_factory=list)  # ("click"|"fill"|"press"|"wait"|"wait_for", ...)
    themes: tuple[str, ...] | None = None  # restrict (e.g. rate-limited sign-ins)
    viewports: tuple[str, ...] | None = None
    note: str = ""


def _staff(id_: str, family: str, path: str, **kw) -> Page:
    return Page(id_, family, path, **kw)


PAGES: list[Page] = [
    # ---- OPAC
    Page("opac-home", "OPAC", "/", "anonymous"),
    Page("opac-home-patron", "OPAC", "/", "patron", note="signed-in header"),
    Page("opac-search", "OPAC", "/search", "anonymous", note="no query"),
    Page("opac-search-results", "OPAC", "/search?q=holmes", "anonymous", route="/search"),
    Page("opac-search-empty", "OPAC", "/search?q=zzqxjv", "anonymous", route="/search", note="zero results"),
    Page("opac-record", "OPAC", "/record/{biblio_id}", "anonymous"),
    Page("opac-record-patron", "OPAC", "/record/{biblio_id}", "patron"),
    Page("opac-record-hold-dialog", "OPAC", "/record/{biblio_id}", "patron",
         actions=[("wait_for", "#place-hold"), ("click", "#place-hold"), ("wait_for", "dialog[open]")]),
    Page("opac-record-404", "OPAC", "/record/999999", "anonymous", route="/record/{biblio_id}", note="missing record"),
    Page("opac-browse", "OPAC", "/browse", "anonymous"),
    Page("opac-browse-subjects", "OPAC", "/browse", "anonymous",
         actions=[("click", "#tab-subjects"), ("wait", 600)]),
    Page("opac-courses", "OPAC", "/courses", "anonymous"),
    Page("opac-course", "OPAC", "/courses/{opac_course_id}", "anonymous", route="/courses/{course_id}"),
    Page("opac-register", "OPAC", "/register", "anonymous"),
    Page("login", "OPAC", "/login", "anonymous"),
    Page("login-validation", "OPAC", "/login", "anonymous", note="submitted empty",
         actions=[("click", "form button[type=submit], form .btn.primary"), ("wait", 400)]),
    Page("reset-password", "OPAC", "/reset-password", "anonymous"),
    Page("offline", "OPAC", "/offline", "anonymous"),
    *[Page(f"opac-account-{tab}", "OPAC", f"/account#{tab}", "patron", route="/account")
      for tab in ("loans", "holds", "foryou", "lists", "history", "charges", "suggestions", "settings")],
    # ---- Front desk
    _staff("staff-dashboard", "Front desk", "/staff"),
    _staff("staff-palette", "Front desk", "/staff", route="/staff", note="command palette (Ctrl+K)",
           actions=[("press", "Control+k"), ("wait_for", "dialog.palette"), ("fill", "dialog.palette input", "over")]),
    _staff("staff-appearance", "Front desk", "/staff", route="/staff", note="appearance dialog",
           actions=[("click", "[data-appearance]"), ("wait_for", "dialog[open]")]),
    _staff("staff-copilot", "Front desk", "/staff", route="/staff", note="AI copilot drawer",
           actions=[("click", "[data-open-copilot]"), ("wait", 500)]),
    _staff("staff-mobile-nav", "Front desk", "/staff", route="/staff", viewports=("mobile",), note="sidebar open",
           actions=[("click", ".menu-toggle"), ("wait", 400)]),
    _staff("staff-circulation", "Front desk", "/staff/circulation"),
    _staff("staff-circulation-patron", "Front desk", "/staff/circulation?patron=1000000001",
           route="/staff/circulation", note="patron loaded for checkout", actions=[("wait", 800)]),
    _staff("staff-circulation-checkin", "Front desk", "/staff/circulation#checkin", route="/staff/circulation"),
    _staff("staff-circulation-transfer", "Front desk", "/staff/circulation#transfer", route="/staff/circulation"),
    *[_staff(f"staff-holds-{tab}", "Front desk", f"/staff/holds#{tab}", route="/staff/holds")
      for tab in ("queue", "pull", "ready")],
    _staff("staff-holds-new", "Front desk", "/staff/holds#new", route="/staff/holds", note="place-hold dialog"),
    _staff("staff-calendar", "Front desk", "/staff/calendar"),
    _staff("staff-kiosks", "Front desk", "/staff/kiosks"),
    Page("kiosk-setup", "Front desk", "/kiosk", "anonymous", note="no device token"),
    Page("kiosk-welcome", "Front desk", "/kiosk", "kiosk", route="/kiosk", note="device token set"),
    Page("kiosk-session", "Front desk", "/kiosk", "kiosk", route="/kiosk", note="patron signed in",
         themes=("light", "contrast"),  # the kiosk sign-in limiter allows 8 attempts per card per minute
         actions=[("wait_for", "#k-card"), ("fill", "#k-card", "{patron_card}"),
                  ("fill", "#k-password", "{patron_password}"), ("press_on", "#k-password", "Enter"),
                  ("wait_for", "#k-barcode"), ("wait", 600)]),
    # ---- Collection
    _staff("staff-catalog", "Collection", "/staff/catalog"),
    _staff("staff-catalog-search", "Collection", "/staff/catalog?q=holmes", route="/staff/catalog"),
    _staff("staff-record", "Collection", "/staff/catalog/{biblio_id}"),
    _staff("staff-record-edit", "Collection", "/staff/catalog/{biblio_id}/edit"),
    _staff("staff-record-new", "Collection", "/staff/catalog/new"),
    _staff("staff-marc-editor", "Collection", "/staff/catalog/{biblio_id}/marc"),
    _staff("staff-marc-editor-text", "Collection", "/staff/catalog/{biblio_id}/marc", route="/staff/catalog/{biblio_id}/marc",
           actions=[("click", "#tab-mnemonic"), ("wait", 500)]),
    _staff("staff-authorities", "Collection", "/staff/authorities"),
    _staff("staff-authorities-unlinked", "Collection", "/staff/authorities#unlinked", route="/staff/authorities"),
    _staff("staff-labels", "Collection", "/staff/labels"),
    _staff("staff-labels-print", "Collection", "/staff/labels/print?kind=item&source=recent&days=3650",
           route="/staff/labels/print"),
    *[_staff(f"staff-batch-{tab}", "Collection", f"/staff/batch#{tab}", route="/staff/batch")
      for tab in ("modify", "delete", "inventory")],
    _staff("staff-copycat", "Collection", "/staff/copycat"),
    _staff("staff-acquisitions", "Collection", "/staff/acquisitions"),
    *[_staff(f"staff-serials-{tab}", "Collection", f"/staff/serials#{tab}", route="/staff/serials")
      for tab in ("subs", "late", "history", "renewals")],
    _staff("staff-serial", "Collection", "/staff/serials/{subscription_id}"),
    _staff("staff-serial-claims", "Collection", "/staff/serials/claims/{claim_batch}", route="/staff/serials/claims/{batch}"),
    _staff("staff-courses", "Collection", "/staff/courses"),
    _staff("staff-course", "Collection", "/staff/courses/{course_id}"),
    # ---- People
    _staff("staff-patrons", "People", "/staff/patrons"),
    _staff("staff-patrons-new", "People", "/staff/patrons#new", route="/staff/patrons", note="register dialog"),
    _staff("staff-patron", "People", "/staff/patrons/{patron_id}"),
    _staff("staff-requests", "People", "/staff/requests"),
    _staff("staff-requests-suggestions", "People", "/staff/requests#suggestions", route="/staff/requests"),
    _staff("staff-notices", "People", "/staff/notices"),
    _staff("staff-notices-outbox", "People", "/staff/notices#outbox", route="/staff/notices"),
    *[_staff(f"staff-roles-{tab}", "People", f"/staff/roles#{tab}", route="/staff/roles", role="admin")
      for tab in ("roles", "staff", "sso")],
    _staff("staff-security", "People", "/staff/security"),
    # ---- Insights
    _staff("staff-reports", "Insights", "/staff/reports"),
    _staff("staff-reports-weeding", "Insights", "/staff/reports#weeding", route="/staff/reports"),
    _staff("staff-analytics", "Insights", "/staff/analytics"),
    _staff("staff-insights", "Insights", "/staff/insights"),
    # ---- Admin
    *[_staff(f"staff-admin-{tab}", "Admin", f"/staff/admin#{tab}", route="/staff/admin", role="admin")
      for tab in ("branches", "item-types", "categories", "rules", "settings", "audit", "system")],
    _staff("staff-system", "Admin", "/staff/system", role="admin"),
    *[_staff(f"staff-interop-{tab}", "Admin", f"/staff/interop#{tab}", route="/staff/interop")
      for tab in ("sip", "targets", "endpoints")],
]

# Routes in web.py that are not HTML pages a person looks at.
NON_PAGE_ROUTES = {"/manifest.webmanifest", "/sw.js", "/sru", "/oai"}


# ------------------------------------------------------------------ browser-side probes

COLLECTOR_JS = r"""
(() => {
  if (window.__swAudit) return;
  const A = window.__swAudit = { csp: [], lcp: 0, lcpEl: "", cls: 0 };
  const describe = (el) => {
    if (!el || !el.tagName) return "";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList && el.classList.length) s += "." + [...el.classList].slice(0, 3).join(".");
    return s;
  };
  document.addEventListener("securitypolicyviolation", (e) => A.csp.push({
    directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber,
    sample: (e.sample || "").slice(0, 120) }));
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { A.lcp = e.startTime; A.lcpEl = describe(e.element); } })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) { /* unsupported */ }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) A.cls += e.value; })
      .observe({ type: "layout-shift", buffered: true });
  } catch (e) { /* unsupported */ }
})();
"""

THEME_JS = r"""
((theme) => {
  try {
    const p = JSON.parse(localStorage.getItem("sw-prefs") || "{}");
    p.theme = theme;
    localStorage.setItem("sw-prefs", JSON.stringify(p));
  } catch (e) { /* opaque origin (about:blank) */ }
})(%s);
"""

PROBE_JS = r"""
(theme) => {
  const out = {};
  const d = document.documentElement;
  // Logged-in users' saved preferences override localStorage; force the audited theme (not persisted).
  out.theme_before = d.dataset.theme || "system";
  if (theme && d.dataset.theme !== theme) d.dataset.theme = theme;
  out.title = document.title;
  out.html_lang = d.lang; out.dir = d.dir;
  out.h1 = [...document.querySelectorAll("h1")].filter((h) => h.offsetParent !== null).map((h) => h.innerText.trim()).filter(Boolean).slice(0, 3);
  out.scroll_width = d.scrollWidth; out.inner_width = window.innerWidth; out.doc_height = d.scrollHeight;
  out.h_overflow = d.scrollWidth > window.innerWidth + 1;

  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const sel = (el) => {
    if (!el || !el.tagName) return "";
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + n.id); break; }
      const cls = [...n.classList].filter((c) => !/^(open|active|hidden)$/.test(c)).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const clipsX = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
    }
    return false;
  };
  // Elements poking out of the viewport horizontally (and not inside a scroll/clip container).
  const offenders = [];
  const all = [...document.body.querySelectorAll("*")];
  out.dom_nodes = all.length;
  for (const el of all) {
    if (offenders.length >= 15) break;
    if (el.closest("svg, .sr-only, .skip-link, dialog:not([open]), [hidden], .drawer:not(.open), .toasts, details:not([open]) > :not(summary)")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Fully off to the left is the visually-hidden idiom (e.g. honeypots); only flag what widens or cuts the page.
    if ((r.right > window.innerWidth + 1 || (r.left < -1 && r.right > 0)) && !clipsX(el) && vis(el)) {
      if (offenders.some((o) => o.el.contains(el))) continue;
      offenders.push({ el, sel: sel(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    }
  }
  out.offscreen = offenders.map(({ el, ...o }) => o);
  // Text that spills out of its own box (overflow: visible but content wider than the element).
  const spills = [];
  for (const el of all) {
    if (spills.length >= 15) break;
    if (!el.firstChild || el.closest("svg, pre, code, .sr-only, [hidden], details:not([open]) > :not(summary)")) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || el.clientWidth === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "visible" || cs.display === "inline") continue;
    if (el.scrollWidth > el.clientWidth + 2 && vis(el)) {
      spills.push({ sel: sel(el), text: el.innerText.trim().slice(0, 60), box: el.clientWidth, content: el.scrollWidth });
    }
  }
  out.spills = spills;

  // Lightweight a11y checks (complement axe; cheap to read in the report).
  const name = (el) => (el.getAttribute("aria-label") || "").trim() || (el.getAttribute("title") || "").trim() ||
    (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim() ||
    (el.innerText || "").trim() || [...el.querySelectorAll("img[alt]")].map((i) => i.alt).join(" ").trim();
  out.img_no_alt = [...document.querySelectorAll("img:not([alt])")].filter(vis).map(sel).slice(0, 10);
  out.unlabeled = [...document.querySelectorAll("input, select, textarea")]
    .filter((el) => !["hidden", "submit", "button", "reset", "image"].includes(el.type) && vis(el))
    .filter((el) => !(el.labels && [...el.labels].some((l) => l.innerText.trim())) && !el.getAttribute("aria-label")
      && !el.getAttribute("aria-labelledby") && !el.getAttribute("title"))
    .map((el) => ({ sel: sel(el), placeholder: el.getAttribute("placeholder") || "" })).slice(0, 15);
  out.unnamed_controls = [...document.querySelectorAll("button, a[href], [role=button], [role=tab]")]
    .filter((el) => vis(el) && !el.closest("details:not([open]) > :not(summary)") && !name(el)).map(sel).slice(0, 15);
  const ids = {};
  for (const el of document.querySelectorAll("[id]")) ids[el.id] = (ids[el.id] || 0) + 1;
  out.duplicate_ids = Object.entries(ids).filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`).slice(0, 15);
  const hs = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(vis).map((h) => +h.tagName[1]);
  out.h1_count = hs.filter((l) => l === 1).length;
  out.heading_skips = hs.filter((l, i) => i > 0 && l > hs[i - 1] + 1).length;
  out.inline_styles = document.querySelectorAll("[style]").length;
  out.error_toasts = [...document.querySelectorAll(".toast.error")].map((t) => t.innerText.trim()).slice(0, 5);
  out.error_boxes = [...document.querySelectorAll(".error-box, .alert.error, .callout.error, [role=alert]")]
    .filter(vis).map((t) => t.innerText.trim().slice(0, 140)).filter(Boolean).slice(0, 5);

  // Design inventory: which component variants this page actually renders.
  const count = (els, key) => { const m = {}; for (const el of els) { const k = key(el); if (k) m[k] = (m[k] || 0) + 1; } return m; };
  const cls = (el, keep) => [...el.classList].filter(keep).sort().join(".");
  out.inventory = {
    buttons: count([...document.querySelectorAll("button, a.btn, [role=button]")].filter(vis),
      (el) => (el.tagName.toLowerCase() === "a" ? "a" : "button") + (cls(el, (c) => !/^(hidden|open|active)$/.test(c)) ? "." + cls(el, (c) => !/^(hidden|open|active)$/.test(c)) : "")),
    tables: count([...document.querySelectorAll("table")].filter(vis), (el) => "table" + (el.className ? "." + cls(el, () => true) : "") +
      (el.closest(".table-wrap, .card") ? " in " + (el.closest(".table-wrap") ? ".table-wrap" : ".card") : "")),
    badges: count([...document.querySelectorAll(".badge, .chip, .pill, .tag")].filter(vis), (el) => cls(el, () => true)),
    empty_states: count([...document.querySelectorAll(".empty")].filter(vis), (el) => cls(el, () => true)),
    page_head: document.querySelector(".page-head") ? [...document.querySelector(".page-head").children].map((c) => c.tagName.toLowerCase() + (c.className ? "." + [...c.classList].join(".") : "")).join(" + ") : "(none)",
    forms: count([...document.querySelectorAll("form")].filter(vis), (el) => "form" + (el.className ? "." + cls(el, () => true) : "")),
    dialogs: count([...document.querySelectorAll("dialog[open], .drawer.open, [role=dialog]")].filter(vis), (el) => el.tagName.toLowerCase() + (el.className ? "." + cls(el, () => true) : "")),
    tabs: count([...document.querySelectorAll("[role=tablist]")].filter(vis), (el) => cls(el, () => true) || "(no class)"),
  };

  // Performance basics (Lighthouse-style).
  const nav = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const res = performance.getEntriesByType("resource");
  const A = window.__swAudit || {};
  out.metrics = {
    ttfb_ms: nav ? Math.round(nav.responseStart) : null,
    fcp_ms: fcp ? Math.round(fcp.startTime) : null,
    lcp_ms: A.lcp ? Math.round(A.lcp) : null, lcp_element: A.lcpEl || "",
    cls: A.cls !== undefined ? Math.round(A.cls * 1000) / 1000 : null,
    dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load_ms: nav ? Math.round(nav.loadEventEnd) : null,
    requests: res.length + 1,
    transfer_kb: Math.round(((nav ? nav.transferSize : 0) + res.reduce((s, r) => s + (r.transferSize || 0), 0)) / 1024),
  };
  out.csp = A.csp || [];
  return out;
}
"""

I18N_JS = r"""
(range) => {
  const native = new RegExp("[" + range + "]");
  const chrome = "h1, h2, h3, h4, label, button, th, legend, summary, caption, option, nav a, .btn, [role=tab], " +
    ".page-head .sub, .empty, .hint, .nav-section-title, .badge, .toast, .muted, .small, p";
  const isData = (el) => el.closest(".cover, .book, .result, .shelf-row, .record-main, td, .mono, code, pre, " +
    "[data-i18n-skip], .brand, .avatar, kbd, .kbd-hint, .lang-switch, .sidebar-footer, footer.site, dialog.palette ul");
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const found = new Map();
  const add = (text, where) => {
    text = (text || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 120 || native.test(text) || !/[A-Za-z]{3,}/.test(text)) return;
    if (/^[A-Z0-9 .,:#/+()·-]+$/.test(text) && text.length < 6) return;  // codes like "ISBN", "MARC"
    if (!found.has(text)) found.set(text, where);
  };
  for (const el of document.querySelectorAll(chrome)) {
    if (!vis(el) || isData(el)) continue;
    // own text only, so a translated container does not hide untranslated children (and vice versa)
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
    add(own, el.tagName.toLowerCase());
  }
  for (const el of document.querySelectorAll("[placeholder], [aria-label], [title]")) {
    if (isData(el)) continue;
    for (const a of ["placeholder", "aria-label", "title"]) if (el.hasAttribute(a)) add(el.getAttribute(a), "@" + a);
  }
  return [...found.entries()].slice(0, 80).map(([text, where]) => ({ text, where }));
}
"""

AXE_RUN_JS = r"""
async (opts) => {
  if (!window.axe) return { error: "axe not loaded" };
  const r = await window.axe.run(document, opts);
  return {
    violations: r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, help_url: v.helpUrl,
      tags: v.tags.filter((t) => /^wcag|^best/.test(t)), count: v.nodes.length,
      nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 220),
        summary: (n.failureSummary || "").slice(0, 400) })),
    })),
    incomplete: r.incomplete.length, passes: r.passes.length,
  };
}
"""


# ------------------------------------------------------------------ helpers


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch_axe(cache: Path, version: str = AXE_VERSION) -> str:
    """axe.min.js from the npm registry tarball, verified against the registry's sha512 integrity."""
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"axe-core-{version}.min.js"
    if target.exists():
        return target.read_text(encoding="utf-8")
    meta = json.load(urllib.request.urlopen(f"https://registry.npmjs.org/axe-core/{version}", timeout=60))
    tarball = urllib.request.urlopen(meta["dist"]["tarball"], timeout=120).read()
    algo, _, expected = meta["dist"]["integrity"].partition("-")
    if algo != "sha512" or base64.b64encode(hashlib.sha512(tarball).digest()).decode() != expected:
        raise SystemExit("axe-core tarball failed its integrity check")
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as tar:
        source = tar.extractfile("package/axe.min.js").read().decode("utf-8")  # type: ignore[union-attr]
    target.write_text(source, encoding="utf-8")
    return source


def demo_credentials() -> dict[str, tuple[str, str]]:
    """Seeded demo accounts (shelfwise/seed.py); override with SW_AUDIT_<ROLE>_USER / _PASSWORD."""
    try:
        sys.path.insert(0, str(ROOT))
        from shelfwise.seed import DEMO_ACCOUNTS
    except Exception:  # noqa: BLE001 - the audit can run against a remote server without the package
        DEMO_ACCOUNTS = {}
    defaults = {"admin": "admin", "librarian": "librarian", "patron": "1000000001"}
    creds = {}
    for role, user in defaults.items():
        user = os.environ.get(f"SW_AUDIT_{role.upper()}_USER", user)
        password = os.environ.get(f"SW_AUDIT_{role.upper()}_PASSWORD", DEMO_ACCOUNTS.get(user, ""))
        creds[role] = (user, password)
    return creds


def web_routes() -> list[str]:
    """GET routes registered by shelfwise/web.py (for the coverage check)."""
    try:
        sys.path.insert(0, str(ROOT))
        from shelfwise.web import router
    except Exception as exc:  # noqa: BLE001
        log(f"  (route coverage skipped: {exc})")
        return []
    out = []
    for r in router.routes:
        methods = getattr(r, "methods", None) or set()
        if "GET" in methods and getattr(r, "path", None):
            out.append(r.path)
    return sorted(set(out))


def page_route(p: Page) -> str:
    return p.route or re.split(r"[?#]", p.path)[0]


def slug(*parts: str) -> str:
    return "__".join(re.sub(r"[^a-z0-9-]+", "-", x.lower()).strip("-") for x in parts)


# ------------------------------------------------------------------ server management (--serve)


class Server:
    def __init__(self, base_url: str, out: Path):
        self.base_url, self.out, self.proc = base_url, out, None

    def __enter__(self):
        m = re.match(r"https?://([^:/]+):(\d+)", self.base_url)
        if not m:
            raise SystemExit("--serve needs a base URL with host and port")
        host, port = m.groups()
        env = dict(os.environ)
        if "SHELFWISE_DATABASE_URL" not in env:
            db = self.out / ".cache" / "audit.db"
            db.parent.mkdir(parents=True, exist_ok=True)
            for suffix in ("", "-wal", "-shm"):
                Path(f"{db}{suffix}").unlink(missing_ok=True)
            env["SHELFWISE_DATABASE_URL"] = f"sqlite:///{db.as_posix()}"
        env.setdefault("SHELFWISE_ENVIRONMENT", "development")
        seeded = subprocess.run([sys.executable, "-m", "shelfwise", "seed"], cwd=ROOT, env=env,
                                capture_output=True, text=True)
        log("  seed: " + (seeded.stdout.strip().splitlines() or [seeded.stderr.strip()[-200:]])[0])
        self.log_file = open(self.out / "server.log", "w", encoding="utf-8")  # noqa: SIM115
        self.proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "shelfwise.app:app", "--host", host, "--port", port],
                                     cwd=ROOT, env=env, stdout=self.log_file, stderr=subprocess.STDOUT)
        for _ in range(120):
            try:
                urllib.request.urlopen(f"{self.base_url}/healthz", timeout=2)
                return self
            except Exception:  # noqa: BLE001
                if self.proc.poll() is not None:
                    raise SystemExit(f"server exited early; see {self.out / 'server.log'}") from None
                time.sleep(0.5)
        raise SystemExit("server did not become healthy in 60s")

    def __exit__(self, *exc):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.log_file.close()


# ------------------------------------------------------------------ the audit


class Audit:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.base = args.base_url.rstrip("/")
        self.out: Path = args.out
        self.shots = self.out / "shots"
        self.results: list[dict] = []
        self.states: dict[str, dict] = {}
        self.ids: dict[str, Any] = {}
        self.escalated: dict[str, str] = {}
        self.axe_source = ""
        self.creds = demo_credentials()

    # -- set-up ------------------------------------------------------------------------------------

    async def login_states(self, browser) -> None:
        for role in ("admin", "anonymous", "patron", "librarian"):  # admin first: it resolves the ids
            ctx = await browser.new_context(base_url=self.base, service_workers="block")
            if role != "anonymous":
                user, password = self.creds[role]
                r = await ctx.request.post("/api/v1/auth/login", data={"username": user, "password": password})
                if not r.ok:
                    raise SystemExit(f"login failed for {role} ({user}): HTTP {r.status} {await r.text()}")
                body = await r.json()
                if body.get("mfa_required"):
                    raise SystemExit(f"{role} account requires 2FA; use an account without it for the audit")
            self.states[role] = await ctx.storage_state()
            if role == "admin":
                await self.resolve_ids(ctx)
            if role == "librarian":
                await self.detect_escalation(ctx)
            await ctx.close()
        self.states["kiosk"] = self.states["anonymous"]

    async def resolve_ids(self, ctx) -> None:
        async def get(path: str) -> Any:
            r = await ctx.request.get(f"/api/v1{path}")
            return await r.json() if r.ok else {}

        first = lambda d, key="id": ((d or {}).get("results") or [{}])[0].get(key)  # noqa: E731
        patron_card = self.creds["patron"][0]
        self.ids = {
            "biblio_id": first(await get("/search?q=holmes")) or first(await get("/search?q=the")) or 1,
            "patron_id": first(await get(f"/patrons?q={patron_card}")) or 1,
            "subscription_id": first(await get("/serials/subscriptions")) or 1,
            "claim_batch": first(await get("/serials/claims"), "batch") or "none",
            "course_id": first(await get("/courses")) or 1,
            "opac_course_id": first(await get("/courses/public")) or 1,
            "patron_card": patron_card,
            "patron_password": self.creds["patron"][1],
        }
        # A kiosk device for the audit (tokens are only shown once, so rotate an existing one).
        devices = (await get("/kiosk/devices")).get("results") or []
        mine = next((d for d in devices if d["name"] == "UI audit kiosk"), None)
        csrf = next((c["value"] for c in await ctx.cookies() if c["name"] == "sw_csrf"), "")
        headers = {"X-CSRF-Token": csrf}
        if mine:
            r = await ctx.request.post(f"/api/v1/kiosk/devices/{mine['id']}/rotate", headers=headers)
        else:
            branch = (await get("/auth/me")).get("home_branch", {}).get("id", 1)
            r = await ctx.request.post("/api/v1/kiosk/devices", headers=headers,
                                       data={"name": "UI audit kiosk", "branch_id": branch})
        self.ids["kiosk_token"] = (await r.json()).get("token", "") if r.ok else ""
        if not self.ids["kiosk_token"]:
            log(f"  ! could not mint a kiosk token (HTTP {r.status}); kiosk pages will show the setup screen")
        log("  ids: " + ", ".join(f"{k}={v}" for k, v in self.ids.items() if "password" not in k and k != "kiosk_token"))

    async def detect_escalation(self, ctx) -> None:
        """Staff pages the librarian cannot open are audited as admin (recorded in the report)."""
        for p in PAGES:
            if p.role != "librarian":
                continue
            r = await ctx.request.get(self.url(p).split("#")[0], max_redirects=0)
            if 300 <= r.status < 400:
                self.escalated[p.id] = r.headers.get("location", "")
                p.role = "admin"

    def url(self, p: Page) -> str:
        return self.base + p.path.format(**self.ids)

    # -- visiting ----------------------------------------------------------------------------------

    async def visit(self, ctx, p: Page, theme: str, viewport: str, lang: str | None) -> dict:
        key = slug(p.id, lang or theme, viewport)
        rec: dict[str, Any] = {"page": p.id, "family": p.family, "role": p.role, "path": p.path.format(**self.ids),
                               "theme": theme, "viewport": viewport, "lang": lang or "en", "note": p.note,
                               "console_errors": [], "page_errors": [], "network": [], "screenshot": None}
        page = await ctx.new_page()
        if p.role == "kiosk" and self.ids.get("kiosk_token"):
            await page.add_init_script(f"try{{localStorage.setItem('sw-kiosk-token',{json.dumps(self.ids['kiosk_token'])})}}catch(e){{}}")
        if p.id == "kiosk-setup":
            await page.add_init_script("try{localStorage.removeItem('sw-kiosk-token')}catch(e){}")

        def on_console(msg):
            if msg.type == "error":
                text = msg.text
                if text.startswith("Failed to load resource"):
                    return  # reported (with its URL) under network
                rec["console_errors"].append(text[:500])

        def on_response(resp):
            if resp.status >= 400:
                rec["network"].append({"status": resp.status, "method": resp.request.method,
                                       "url": resp.url.replace(self.base, "")[:200]})

        def on_failed(req):
            failure = req.failure or ""
            if "ERR_ABORTED" in failure:
                return  # navigations away / cancelled fetches
            rec["network"].append({"status": 0, "method": req.method, "url": req.url.replace(self.base, "")[:200],
                                   "error": failure})

        page.on("console", on_console)
        page.on("pageerror", lambda e: rec["page_errors"].append(str(e)[:500]))
        page.on("response", on_response)
        page.on("requestfailed", on_failed)
        started = time.perf_counter()
        try:
            resp = await page.goto(self.url(p), wait_until="load", timeout=45000)
            rec["status"] = resp.status if resp else None
            try:
                await page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:  # noqa: BLE001 - polling pages never go idle
                rec["note"] = (rec["note"] + " · never network-idle").strip(" ·")
            for action in p.actions:
                await self.act(page, action)
            if p.actions:
                try:
                    await page.wait_for_load_state("networkidle", timeout=5000)
                except Exception:  # noqa: BLE001
                    pass
            await page.wait_for_timeout(350)
            await page.evaluate("document.fonts && document.fonts.ready")
            rec["final_path"] = page.url.replace(self.base, "")
            rec.update(await page.evaluate(PROBE_JS, theme if not lang else "light"))
            if lang:
                rec["untranslated"] = await page.evaluate(I18N_JS, LANG_SCRIPTS.get(lang, "\u0080-￿"))
            if not self.args.no_axe and not lang:
                rec["axe"] = await page.evaluate(AXE_RUN_JS, {"runOnly": {"type": "tag", "values": self.axe_tags},
                                                               "resultTypes": ["violations"]})
            if not self.args.no_screenshots:
                path = self.shots / f"{key}.jpg"
                await page.screenshot(path=str(path), full_page=True, type="jpeg", quality=70, animations="disabled",
                                      timeout=60000)
                rec["screenshot"] = path.relative_to(self.out).as_posix()
        except Exception as exc:  # noqa: BLE001 - one broken page must not stop the audit
            rec["harness_error"] = f"{type(exc).__name__}: {str(exc)[:400]}"
        finally:
            rec["elapsed_s"] = round(time.perf_counter() - started, 2)
            await page.close()
        return rec

    async def act(self, page, action: tuple) -> None:
        kind, *rest = action
        fmt = lambda s: s.format(**self.ids) if isinstance(s, str) else s  # noqa: E731
        if kind == "click":
            await page.locator(rest[0]).first.click(timeout=8000)
        elif kind == "fill":
            await page.locator(rest[0]).first.fill(fmt(rest[1]), timeout=8000)
        elif kind == "press":
            await page.keyboard.press(rest[0])
        elif kind == "press_on":
            await page.locator(rest[0]).first.press(rest[1], timeout=8000)
        elif kind == "wait":
            await page.wait_for_timeout(rest[0])
        elif kind == "wait_for":
            await page.locator(rest[0]).first.wait_for(state="visible", timeout=10000)
        else:
            raise ValueError(f"unknown action {kind}")

    async def run_combo(self, browser, role: str, theme: str, viewport: str, lang: str | None, pages: list[Page]) -> None:
        w, h = VIEWPORTS[viewport]
        mobile = viewport == "mobile"
        ctx = await browser.new_context(
            base_url=self.base, storage_state=self.states[role], viewport={"width": w, "height": h},
            device_scale_factor=1, is_mobile=mobile, has_touch=mobile, service_workers="block",
            color_scheme="dark" if theme == "dark" else "light", reduced_motion="reduce", locale="en-IN",
            timezone_id="Asia/Kolkata")
        await ctx.add_init_script(COLLECTOR_JS)
        await ctx.add_init_script(THEME_JS % json.dumps(theme))
        if lang:
            await ctx.add_cookies([{"name": "sw_lang", "value": lang, "url": self.base}])
        elif not self.args.no_axe:
            await ctx.add_init_script(self.axe_source)
        for p in pages:
            rec = await self.visit(ctx, p, theme, viewport, lang)
            self.results.append(rec)
            self.progress(rec)
        await ctx.close()

    def progress(self, rec: dict) -> None:
        self.done += 1
        axe = rec.get("axe") or {}
        bad = sum(1 for v in axe.get("violations", []) if IMPACT_RANK.get(v["impact"], 0) >= 3)
        flags = []
        if rec.get("harness_error"):
            flags.append("HARNESS " + rec["harness_error"][:80])
        if rec["console_errors"] or rec["page_errors"]:
            flags.append(f"js-errors={len(rec['console_errors']) + len(rec['page_errors'])}")
        if bad:
            flags.append(f"axe-serious={bad}")
        if rec.get("h_overflow"):
            flags.append("h-overflow")
        if rec.get("untranslated"):
            flags.append(f"untranslated={len(rec['untranslated'])}")
        log(f"  [{self.done}/{self.total}] {rec['page']} {rec['lang'] if rec['lang'] != 'en' else rec['theme']}/"
            f"{rec['viewport']} {rec['elapsed_s']}s {' '.join(flags)}")

    async def run(self) -> int:
        from playwright.async_api import async_playwright

        self.out.mkdir(parents=True, exist_ok=True)
        if self.shots.exists() and not self.args.keep_shots:
            shutil.rmtree(self.shots)
        self.shots.mkdir(parents=True, exist_ok=True)
        self.axe_tags = AXE_TAGS + (["best-practice"] if self.args.best_practice else [])
        if not self.args.no_axe:
            self.axe_source = fetch_axe(self.out / ".cache", self.args.axe_version)
        selected = [p for p in PAGES if not self.args.pages or any(s in p.id for s in self.args.pages)]
        async with async_playwright() as pw:
            launch = {"headless": not self.args.headed}
            if self.args.browser == "msedge":
                launch["channel"] = "msedge"
            browser = await pw.chromium.launch(**launch)
            log(f"Browser: {self.args.browser} {browser.version} · base {self.base}")
            await self.login_states(browser)
            combos = []
            for role in sorted({p.role for p in selected}):
                if role != "kiosk" and role not in self.args.roles:
                    continue
                for viewport in self.args.viewports:
                    for theme in self.args.themes:
                        pages = [p for p in selected if p.role == role and (p.themes is None or theme in p.themes)
                                 and (p.viewports is None or viewport in p.viewports)]
                        if pages:
                            combos.append((role, theme, viewport, None, pages))
                    for lang in self.args.langs:
                        pages = [p for p in selected if p.role == role and not p.actions
                                 and (p.viewports is None or viewport in p.viewports)]
                        if pages and viewport == "desktop":
                            combos.append((role, "light", viewport, lang, pages))
            self.total, self.done = sum(len(c[4]) for c in combos), 0
            log(f"{len(selected)} pages · {len(combos)} contexts · {self.total} visits")
            sem = asyncio.Semaphore(self.args.concurrency)

            async def worker(combo):
                async with sem:
                    await self.run_combo(browser, *combo)

            started = time.perf_counter()
            await asyncio.gather(*(worker(c) for c in combos))
            await browser.close()
        summary = self.summarise(selected, time.perf_counter() - started)
        (self.out / "report.json").write_text(json.dumps(summary | {"results": self.results}, indent=1, ensure_ascii=False),
                                              encoding="utf-8")
        (self.out / "index.html").write_text(render_html(summary, self.results), encoding="utf-8")
        log(f"\nReport: {self.out / 'index.html'}")
        log(json.dumps(summary["totals"], indent=1))
        if self.args.no_fail:
            return 0
        return 1 if summary["failures"] else 0

    # -- summary -----------------------------------------------------------------------------------

    def summarise(self, selected: list[Page], elapsed: float) -> dict:
        threshold = IMPACT_RANK[self.args.fail_on] if self.args.fail_on != "none" else 99
        rules: dict[str, dict] = {}
        failures = []
        for r in self.results:
            for v in (r.get("axe") or {}).get("violations", []):
                agg = rules.setdefault(v["id"], {"id": v["id"], "impact": v["impact"], "help": v["help"],
                                                 "help_url": v["help_url"], "pages": set(), "nodes": 0, "visits": 0})
                agg["pages"].add(r["page"])
                agg["nodes"] += v["count"]
                agg["visits"] += 1
                if IMPACT_RANK.get(v["impact"], 0) >= threshold:
                    failures.append(f"axe {v['impact']} {v['id']} on {r['page']} ({r['theme']}/{r['viewport']})")
            if r["console_errors"] or r["page_errors"]:
                failures.append(f"JS errors on {r['page']} ({r['theme']}/{r['viewport']}): "
                                f"{(r['page_errors'] + r['console_errors'])[0][:120]}")
            if any(n["status"] >= 500 for n in r["network"]):
                failures.append(f"5xx on {r['page']}: {[n['url'] for n in r['network'] if n['status'] >= 500][:3]}")
            if r.get("harness_error"):
                failures.append(f"harness error on {r['page']} ({r['theme']}/{r['viewport']}): {r['harness_error'][:120]}")
        routes = web_routes()
        covered = {page_route(p) for p in PAGES}
        uncovered = [r for r in routes if r not in covered and r not in NON_PAGE_ROUTES and not r.startswith("/static")]
        by_impact: dict[str, int] = {}
        for agg in rules.values():
            by_impact[agg["impact"]] = by_impact.get(agg["impact"], 0) + 1
        en = [r for r in self.results if r["lang"] == "en"]
        totals = {
            "pages": len(selected), "visits": len(self.results), "elapsed_s": round(elapsed, 1),
            "axe_rules_violated": len(rules), "axe_rules_by_impact": by_impact,
            "visits_with_js_errors": sum(1 for r in self.results if r["console_errors"] or r["page_errors"]),
            "visits_with_network_errors": sum(1 for r in self.results if r["network"]),
            "visits_with_h_overflow": sum(1 for r in en if r.get("h_overflow")),
            "visits_with_csp_violations": sum(1 for r in self.results if r.get("csp")),
            "visits_with_unlabeled_controls": sum(1 for r in en if r.get("unlabeled")),
            "harness_errors": sum(1 for r in self.results if r.get("harness_error")),
            "untranslated_strings": sum(len(r.get("untranslated") or []) for r in self.results),
            "failures": len(failures),
        }
        return {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "base_url": self.base, "browser": self.args.browser,
            "axe_version": None if self.args.no_axe else self.args.axe_version, "axe_tags": self.axe_tags,
            "themes": self.args.themes, "viewports": self.args.viewports, "langs": self.args.langs,
            "ids": {k: v for k, v in self.ids.items() if k not in ("kiosk_token", "patron_password")},
            "escalated_to_admin": self.escalated, "uncovered_routes": uncovered, "totals": totals,
            "axe_rules": sorted(({**a, "pages": sorted(a["pages"])} for a in rules.values()),
                                key=lambda a: (-IMPACT_RANK.get(a["impact"], 0), -len(a["pages"]))),
            "failures": failures[:500], "pages_meta": [asdict(p) for p in selected],
        }


# ------------------------------------------------------------------ HTML report

REPORT_CSS = """
:root{--bg:#f6f7f9;--fg:#1f2328;--muted:#59636e;--card:#fff;--line:#d1d9e0;--bad:#b42318;--warn:#a15c07;--ok:#1a7f37;--chip:#eef1f4}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--card:#151b23;--line:#30363d;--bad:#ff7b72;--warn:#e3b341;--ok:#3fb950;--chip:#212830}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:20px 24px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2}
h1{margin:0 0 4px;font-size:20px}h2{font-size:17px;margin:28px 0 10px}h3{margin:0;font-size:15px}
main{padding:0 24px 48px;max-width:1700px}.muted{color:var(--muted)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.totals{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-top:12px}
.tot{background:var(--chip);border-radius:8px;padding:8px 10px}.tot b{display:block;font-size:20px}
table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.chip{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--chip);font-size:12px;margin:1px}
.critical,.serious,.bad{color:#fff;background:var(--bad)}.moderate,.warn{color:#000;background:#f5c451}.minor{background:var(--chip)}
section.page{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;margin-top:10px}
figure{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg)}
figure img{display:block;width:100%;height:240px;object-fit:cover;object-position:top}
figure.mobile img{object-fit:contain;background:#0002}
figcaption{padding:6px 8px;font-size:12px}details{margin-top:8px}summary{cursor:pointer;font-weight:600}
ul.issues{margin:6px 0;padding-left:18px}ul.issues li{margin:2px 0}code{font-size:12px;word-break:break-all}
input[type=search]{padding:6px 10px;border:1px solid var(--line);border-radius:6px;min-width:260px;background:var(--card);color:var(--fg)}
.hidden{display:none}
"""

REPORT_JS = """
const q=document.getElementById('q'),only=document.getElementById('only');
function apply(){const s=q.value.toLowerCase();for(const sec of document.querySelectorAll('section.page')){
const hit=!s||sec.dataset.search.includes(s);const iss=!only.checked||sec.dataset.issues!=='0';sec.classList.toggle('hidden',!(hit&&iss));}}
q.addEventListener('input',apply);only.addEventListener('change',apply);
"""


def _e(v: Any) -> str:
    return html.escape(str(v), quote=True)


def visit_issues(r: dict) -> list[str]:
    """Human-readable issue lines for one visit (HTML)."""
    out = []
    if r.get("harness_error"):
        out.append(f"<span class='chip bad'>harness</span> {_e(r['harness_error'])}")
    if r.get("final_path") and re.split(r"[?#]", r["final_path"])[0] != re.split(r"[?#]", r["path"])[0]:
        out.append(f"<span class='chip warn'>redirect</span> → <code>{_e(r['final_path'])}</code>")
    for e in r["page_errors"] + r["console_errors"]:
        out.append(f"<span class='chip bad'>js</span> <code>{_e(e[:300])}</code>")
    for n in r["network"][:6]:
        out.append(f"<span class='chip {'bad' if n['status'] >= 500 or n['status'] == 0 else 'warn'}'>{n['status'] or 'fail'}</span> "
                   f"{_e(n['method'])} <code>{_e(n['url'])}</code>")
    for c in r.get("csp") or []:
        out.append(f"<span class='chip bad'>csp</span> {_e(c['directive'])} <code>{_e(c['blocked'])}</code>")
    for v in (r.get("axe") or {}).get("violations", []):
        targets = ", ".join(n["target"] for n in v["nodes"][:3])
        out.append(f"<span class='chip {_e(v['impact'])}'>{_e(v['impact'])}</span> <a href='{_e(v['help_url'])}'>{_e(v['id'])}</a> "
                   f"×{v['count']} — {_e(v['help'])} <code>{_e(targets[:200])}</code>")
    if r.get("h_overflow"):
        out.append(f"<span class='chip warn'>overflow</span> page {r['scroll_width']}px wide in a {r['inner_width']}px viewport")
    for o in (r.get("offscreen") or [])[:5]:
        out.append(f"<span class='chip warn'>off-screen</span> <code>{_e(o['sel'])}</code> right edge {o['right']}px")
    for s in (r.get("spills") or [])[:5]:
        out.append(f"<span class='chip warn'>spill</span> <code>{_e(s['sel'])}</code> “{_e(s['text'])}” {s['content']}px in {s['box']}px")
    for u in r.get("unlabeled") or []:
        out.append(f"<span class='chip warn'>no label</span> <code>{_e(u['sel'])}</code>"
                   + (f" (placeholder only: “{_e(u['placeholder'])}”)" if u["placeholder"] else ""))
    for u in r.get("unnamed_controls") or []:
        out.append(f"<span class='chip warn'>no name</span> <code>{_e(u)}</code>")
    for u in r.get("img_no_alt") or []:
        out.append(f"<span class='chip warn'>no alt</span> <code>{_e(u)}</code>")
    if r.get("duplicate_ids"):
        out.append(f"<span class='chip warn'>dup ids</span> {_e(', '.join(r['duplicate_ids']))}")
    if r.get("lang", "en") == "en" and r.get("h1_count") is not None and r["h1_count"] != 1:
        out.append(f"<span class='chip minor'>h1</span> {r['h1_count']} visible h1 elements")
    for t in (r.get("error_toasts") or []) + (r.get("error_boxes") or []):
        out.append(f"<span class='chip warn'>error shown</span> {_e(t)}")
    m = r.get("metrics") or {}
    if (m.get("lcp_ms") or 0) > 2500 or (m.get("cls") or 0) > 0.1:
        out.append(f"<span class='chip warn'>vitals</span> LCP {m.get('lcp_ms')}ms · CLS {m.get('cls')}")
    if r.get("untranslated"):
        sample = "; ".join(u["text"] for u in r["untranslated"][:12])
        out.append(f"<span class='chip warn'>{len(r['untranslated'])} untranslated</span> {_e(sample)}")
    return out


def render_html(summary: dict, results: list[dict]) -> str:
    t = summary["totals"]
    parts = [f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
             f"<title>Shelfwise UI audit</title><style>{REPORT_CSS}</style></head><body>"
             f"<header><h1>Shelfwise UI audit</h1><div class='muted'>{_e(summary['generated_at'])} · {_e(summary['base_url'])} · "
             f"{_e(summary['browser'])} · axe-core {_e(summary['axe_version'])} ({_e(', '.join(summary['axe_tags']))})</div>"
             f"<div class='row' style='margin-top:10px'><input id='q' type='search' placeholder='Filter pages (id, path, family)…' aria-label='Filter pages'>"
             f"<label><input type='checkbox' id='only'> only pages with issues</label></div></header><main>"]
    parts.append("<div class='totals'>" + "".join(
        f"<div class='tot'><b>{_e(v if not isinstance(v, dict) else ', '.join(f'{k}:{n}' for k, n in v.items()) or 0)}</b>"
        f"<span class='muted'>{_e(k.replace('_', ' '))}</span></div>" for k, v in t.items()) + "</div>")
    if summary["failures"]:
        parts.append(f"<details><summary>{len(summary['failures'])} blocking failures (exit status)</summary><ul class='issues'>"
                     + "".join(f"<li>{_e(f)}</li>" for f in summary["failures"][:300]) + "</ul></details>")
    parts.append("<h2>axe-core rules violated</h2><table><tr><th>Rule</th><th>Impact</th><th>Pages</th><th>Visits</th><th>Nodes</th><th>Help</th></tr>")
    for a in summary["axe_rules"]:
        parts.append(f"<tr><td><a href='{_e(a['help_url'])}'>{_e(a['id'])}</a></td><td><span class='chip {_e(a['impact'])}'>{_e(a['impact'])}</span></td>"
                     f"<td>{_e(', '.join(a['pages']))}</td><td>{a['visits']}</td><td>{a['nodes']}</td><td>{_e(a['help'])}</td></tr>")
    parts.append("</table>")
    if summary["uncovered_routes"]:
        parts.append("<h2>Routes not in the audit's page table</h2><p>" + " ".join(
            f"<code>{_e(r)}</code>" for r in summary["uncovered_routes"]) + "</p>")
    if summary["escalated_to_admin"]:
        parts.append("<p class='muted'>Audited as admin because the librarian is redirected: " + _e(
            ", ".join(f"{k} → {v}" for k, v in summary["escalated_to_admin"].items())) + "</p>")
    by_page: dict[str, list[dict]] = {}
    for r in results:
        by_page.setdefault(r["page"], []).append(r)
    order = {p["id"]: i for i, p in enumerate(summary["pages_meta"])}
    family = None
    for pid in sorted(by_page, key=lambda k: order.get(k, 999)):
        visits = sorted(by_page[pid], key=lambda r: (r["lang"], r["viewport"], THEMES.index(r["theme"]) if r["theme"] in THEMES else 9))
        first = visits[0]
        if first["family"] != family:
            family = first["family"]
            parts.append(f"<h2>{_e(family)}</h2>")
        # Deduplicate issue lines across themes/viewports, remembering where each appeared.
        seen: dict[str, list[str]] = {}
        for r in visits:
            for line in visit_issues(r):
                seen.setdefault(line, []).append(f"{r['lang'] if r['lang'] != 'en' else r['theme']}/{r['viewport']}")
        m = next((r.get("metrics") for r in visits if r.get("metrics") and r["theme"] == "light"), None) or {}
        perf = (f"TTFB {m.get('ttfb_ms')}ms · FCP {m.get('fcp_ms')}ms · LCP {m.get('lcp_ms')}ms ({_e(m.get('lcp_element'))}) · "
                f"CLS {m.get('cls')} · {m.get('requests')} req · {m.get('transfer_kb')} KB · {first.get('dom_nodes')} nodes") if m else ""
        search = f"{pid} {first['path']} {first['family']} {first['note']}".lower()
        parts.append(f"<section class='page' id='{_e(pid)}' data-search='{_e(search)}' data-issues='{len(seen)}'>"
                     f"<h3>{_e(pid)} <span class='muted'>· <code>{_e(first['path'])}</code> · {_e(first['role'])}"
                     f"{' · ' + _e(first['note']) if first['note'] else ''}</span></h3><div class='muted small'>{perf}</div>")
        if seen:
            parts.append(f"<details {'open' if len(seen) < 12 else ''}><summary>{len(seen)} distinct issues</summary><ul class='issues'>"
                         + "".join(f"<li>{line} <span class='muted'>[{_e(', '.join(where) if len(where) < 10 else 'all variants')}]</span></li>"
                                   for line, where in seen.items()) + "</ul></details>")
        parts.append("<div class='grid'>")
        for r in visits:
            label = f"{r['lang'] if r['lang'] != 'en' else r['theme']} · {r['viewport']}"
            axe_bad = sum(1 for v in (r.get("axe") or {}).get("violations", []) if IMPACT_RANK.get(v["impact"], 0) >= 3)
            badges = (f"<span class='chip serious'>axe {axe_bad}</span>" if axe_bad else "") + \
                     (f"<span class='chip bad'>js {len(r['console_errors']) + len(r['page_errors'])}</span>" if r["console_errors"] or r["page_errors"] else "") + \
                     ("<span class='chip warn'>overflow</span>" if r.get("h_overflow") else "")
            img = (f"<a href='{_e(r['screenshot'])}'><img loading='lazy' src='{_e(r['screenshot'])}' alt='{_e(pid + ' ' + label)}'></a>"
                   if r.get("screenshot") else "<div style='height:240px' class='muted'>no screenshot</div>")
            parts.append(f"<figure class='{_e(r['viewport'])}'>{img}<figcaption>{_e(label)} {badges}</figcaption></figure>")
        parts.append("</div></section>")
    parts.append(f"</main><script>{REPORT_JS}</script></body></html>")
    return "".join(parts)


# ------------------------------------------------------------------ CLI


def default_browser() -> str:
    if sys.platform == "win32":
        for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
            if base and (Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe").exists():
                return "msedge"
    return "chromium"


def main(argv: list[str] | None = None) -> int:
    csv = lambda s: [x.strip() for x in s.split(",") if x.strip() and x.strip() != "none"]  # noqa: E731
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default=os.environ.get("SW_AUDIT_BASE_URL", DEFAULT_BASE))
    ap.add_argument("--serve", action="store_true", help="seed a throw-away SQLite DB and run the server for the audit")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--pages", type=csv, default=[], help="comma-separated substrings of page ids")
    ap.add_argument("--themes", type=csv, default=list(THEMES))
    ap.add_argument("--viewports", type=csv, default=list(VIEWPORTS))
    ap.add_argument("--roles", type=csv, default=list(ROLES))
    ap.add_argument("--langs", type=csv, default=["hi", "ur"], help="i18n pass languages ('none' to skip)")
    ap.add_argument("--browser", choices=["msedge", "chromium"], default=default_browser())
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--axe-version", default=AXE_VERSION)
    ap.add_argument("--best-practice", action="store_true", help="also run axe best-practice rules")
    ap.add_argument("--no-axe", action="store_true")
    ap.add_argument("--no-screenshots", action="store_true")
    ap.add_argument("--keep-shots", action="store_true", help="do not clear old screenshots first")
    ap.add_argument("--fail-on", choices=["critical", "serious", "moderate", "minor", "none"], default="serious")
    ap.add_argument("--no-fail", action="store_true", help="always exit 0 (report only)")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args(argv)
    bad = [x for x in args.themes if x not in THEMES] + [x for x in args.viewports if x not in VIEWPORTS] + \
        [x for x in args.roles if x not in ROLES]
    if bad:
        ap.error(f"unknown theme/viewport/role: {bad}")
    audit = Audit(args)
    if args.serve:
        args.out.mkdir(parents=True, exist_ok=True)
        with Server(audit.base, args.out):
            return asyncio.run(audit.run())
    return asyncio.run(audit.run())


if __name__ == "__main__":
    sys.exit(main())
