// Shared building blocks for the public catalogue pages (home, record, account, courses, auth pages):
// book cards and scrollable shelves with skeletons of the same geometry, humanised labels for codes,
// and the password strength meter used by registration, password reset and account settings.
import { $, $$, authors, cover, html, icon, raw } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

// ------------------------------------------------------------------ humanised values (never show raw codes)

const LANGS = ["en", "hi", "bn", "fr", "es", "de", "ta", "ur"];
const FORMATS = ["book", "ebook", "audiobook", "dvd", "serial", "comic"];
export const FORMAT_ICON = { book: "book", ebook: "monitor", audiobook: "volume", dvd: "monitor", serial: "layers", comic: "image" };

/** Language name for an ISO code: our catalogue's names first, then the browser's Intl names. */
export function langName(code) {
  if (!code) return "";
  if (LANGS.includes(code)) return t(`lang.${code}`);
  try { return new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "language" }).of(code) || code; } catch { return code; }
}
export const formatName = (v) => (FORMATS.includes(v) ? t(`format.${v}`) : (v ? String(v).replace(/_/g, " ") : ""));
export const audienceName = (v) => (v ? t(`opac.record.audience_${v}`, {}, String(v).replace(/_/g, " ")) : "");

// ------------------------------------------------------------------ book cards & shelves

/** A cover + title + author card linking to the record. The cover is decorative (its text repeats the title). */
export const bookCard = (b) => html`<a class="book-card" href="/record/${b.id}">
  <div aria-hidden="true">${cover(b)}</div><span class="t">${b.title}</span><span class="a">${authors(b.authors) || " "}</span></a>`;

/** Placeholder card with exactly the geometry of bookCard (no layout shift when data arrives). */
export const skeletonCard = () => html`<div class="book-card" aria-hidden="true"><div class="cover skeleton"></div>
  <span class="t"><span class="skeleton sk-line" style="display:block;height:.85em;margin:.2em 0;width:92%"></span><span class="skeleton sk-line" style="display:block;height:.85em;margin:.35em 0;width:58%"></span></span>
  <span class="a"><span class="skeleton sk-line" style="display:block;height:.8em;margin:.25em 0;width:46%"></span></span></div>`;

export const skeletonShelf = (n = 8) => html`<section class="shelf" aria-hidden="true"><div class="section-head"><h2><span class="skeleton" style="display:inline-block;height:1.1em;width:11rem;vertical-align:middle"></span></h2></div>
  <div class="shelf-scroller"><div class="shelf-row">${Array.from({ length: n }, skeletonCard)}</div></div></section>`;

let shelfSeq = 0;
/**
 * A titled, horizontally scrollable row of cards with pointer scroll buttons and a fade edge.
 * Keyboard users simply Tab through the cards (the row scrolls focused cards into view).
 */
export function shelf({ title, sub = "", href = "", hrefLabel = "", items = [], card = bookCard, extra = "", id }) {
  const hid = id || `shelf-h-${++shelfSeq}`;
  return html`<section class="shelf" aria-labelledby="${hid}">
    <div class="section-head"><div><h2 id="${hid}">${title}</h2>${sub ? html`<p class="sub">${sub}</p>` : ""}</div>
      ${extra}${href ? html`<a class="see-all" href="${href}">${hrefLabel || t("opac.home.browse_all")}<span class="sr-only">: ${title}</span>${icon("arrow-right")}</a>` : ""}</div>
    <div class="shelf-scroller">
      <div class="shelf-nav prev" aria-hidden="true"><button type="button" class="btn" tabindex="-1" data-shelf-step="-1">${icon("chevron-left")}</button></div>
      <div class="shelf-row">${items.map(card)}</div>
      <div class="shelf-nav next" aria-hidden="true"><button type="button" class="btn" tabindex="-1" data-shelf-step="1">${icon("chevron")}</button></div>
    </div></section>`;
}

const rtl = () => document.documentElement.dir === "rtl";
function syncShelf(scroller) {
  const row = $(".shelf-row", scroller);
  if (!row) return;
  const max = row.scrollWidth - row.clientWidth;
  const pos = Math.abs(row.scrollLeft);
  scroller.classList.toggle("overflowing", max > 4);
  scroller.classList.toggle("at-end", pos >= max - 4);
  const prev = $("[data-shelf-step='-1']", scroller), next = $("[data-shelf-step='1']", scroller);
  if (prev) prev.disabled = pos < 4;
  if (next) next.disabled = pos >= max - 4;
}

/** Wire every shelf inside `root` (idempotent). */
export function wireShelves(root = document) {
  $$(".shelf-scroller", root).forEach((scroller) => {
    if (scroller.dataset.wired) return;
    scroller.dataset.wired = "1";
    const row = $(".shelf-row", scroller);
    if (!row) return;
    row.addEventListener("scroll", () => syncShelf(scroller), { passive: true });
    scroller.addEventListener("click", (e) => {
      const b = e.target.closest("[data-shelf-step]");
      if (!b) return;
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.scrollBy({ left: Number(b.dataset.shelfStep) * (rtl() ? -1 : 1) * row.clientWidth * 0.85, behavior: smooth ? "smooth" : "auto" });
    });
    if ("ResizeObserver" in window) new ResizeObserver(() => syncShelf(scroller)).observe(row);
    syncShelf(scroller);
  });
}

/** Busy state for a submit button whose errors the caller shows inline (unlike core.withBusy, no toast). */
export async function busy(btn, fn) {
  const spin = btn && !btn.querySelector(":scope > .spinner");
  if (spin) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.insertAdjacentHTML("afterbegin", `<span class="spinner" aria-hidden="true"></span>`);
  }
  try { return await fn(); } finally {
    if (spin) { btn.querySelector(":scope > .spinner")?.remove(); btn.disabled = false; btn.removeAttribute("aria-busy"); }
  }
}

// ------------------------------------------------------------------ passwords: show/hide + strength meter

const COMMON = new Set(["password123", "librarian1", "qwertyuiop", "1234567890", "password1!", "iloveyou12", "welcome123"]);

/** Mirrors the server policy (security.password_problems) and adds a strength estimate for the meter. */
export function passwordCheck(pw, personal = []) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const lower = pw.toLowerCase();
  const personalHit = personal.filter((s) => s && s.length >= 3).some((s) => lower.includes(String(s).toLowerCase()));
  const rules = { length: pw.length >= 10, classes: classes >= 3, common: !!pw && !COMMON.has(lower), personal: !!pw && !personalHit };
  let score = 0;
  if (pw) {
    score = 1;
    if (rules.length && rules.classes) score = 2;
    if (score === 2 && pw.length >= 12) score = 3;
    if (score === 3 && pw.length >= 15 && classes === 4) score = 4;
    if (!rules.common || !rules.personal) score = 1;
  }
  return { ok: rules.length && rules.classes && rules.common, rules, score };
}

/** Markup for the meter; place right after the password field and call wirePasswordMeter(). */
export const passwordMeter = (id) => html`<div class="pw-meter" id="${id}-meter" data-score="0" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  <div class="pw-verdict" id="${id}-verdict" aria-live="polite"></div>
  <ul class="pw-rules" id="${id}-rules">
    ${["length", "classes", "personal"].map((r) => html`<li data-rule="${r}">${icon("check-circle", "ok")}${icon("x-circle", "no")}<span>${t(`opac.pw.rule_${r}`)}</span><span class="sr-only" data-state></span></li>`)}
  </ul>`;

export function wirePasswordMeter(input, { personal = () => [] } = {}) {
  const id = input.id;
  const meter = document.getElementById(`${id}-meter`), verdict = document.getElementById(`${id}-verdict`), rules = document.getElementById(`${id}-rules`);
  let last = -1;
  const update = () => {
    const r = passwordCheck(input.value, personal());
    meter.dataset.score = String(r.score);
    $$("[data-rule]", rules).forEach((li) => {
      const met = !!r.rules[li.dataset.rule] && !!input.value;
      li.classList.toggle("met", met);
      $("[data-state]", li).textContent = met ? t("opac.pw.met") : t("opac.pw.not_met");
    });
    // Announce the verdict only when it changes, not on every keystroke.
    if (r.score !== last) {
      last = r.score;
      verdict.textContent = input.value ? t(`opac.pw.score_${r.score}`) : "";
    }
  };
  input.addEventListener("input", update);
  update();
  return () => passwordCheck(input.value, personal());
}

const svg = (d) => raw(`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`);
const EYE = svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>');
const EYE_OFF = svg('<path d="M3 3l18 18M10.6 5.1A9.6 9.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.4 9.4 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>');

/** Show/hide buttons: <button data-pw-toggle="input-id">. Idempotent, document-wide. */
export function wirePasswordToggles(root = document) {
  $$("[data-pw-toggle]", root).forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.pwToggle);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", String(show));
      btn.innerHTML = html`${show ? EYE_OFF : EYE}<span class="sr-only">${t("opac.pw.show")}</span>`;
    });
  });
}
export const pwToggle = (inputId) => html`<button type="button" class="btn ghost pw-toggle" data-pw-toggle="${inputId}" aria-pressed="false"
  title="${t("opac.pw.show")}">${EYE}<span class="sr-only">${t("opac.pw.show")}</span></button>`;
