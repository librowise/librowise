// Librowise i18n: message lookup with plurals and locale-aware formatting.
// The server embeds the negotiated catalog (merged over English) in <script id="i18n">, so lookups are
// synchronous and work offline. Usage: t("opac.search.results", { count: 3, q: "tagore" }).

const DATA = (() => {
  try { return JSON.parse(document.getElementById("i18n")?.textContent || "{}"); } catch { return {}; }
})();

export const lang = DATA.lang || document.documentElement.lang || "en";
export const dir = DATA.dir || document.documentElement.dir || "ltr";
export const languages = DATA.languages || { en: "English" };
const messages = DATA.messages || {};

// Region-qualified locale for Intl: Indian conventions (lakh grouping, d/m/y) by default.
const REGION = { en: "en-IN", hi: "hi-IN", ur: "ur-IN", bn: "bn-IN", ta: "ta-IN", mr: "mr-IN" };
const nav = typeof navigator !== "undefined" ? navigator.language || "" : "";
export const locale = lang === "en" && /^en-/i.test(nav) ? nav : (REGION[lang] || lang);

const plurals = new Intl.PluralRules(locale);
const numberFmt = new Intl.NumberFormat(locale);

const fill = (msg, params) => String(msg).replace(/\{(\w+)\}/g, (m, k) => {
  if (!(k in params)) return m;
  const v = params[k];
  return typeof v === "number" ? numberFmt.format(v) : String(v ?? "");
});

/** Translate `key`. `params.count` selects the plural form. Unknown keys return `fallback` (or the key). */
export function t(key, params = {}, fallback) {
  let msg = messages[key];
  if (msg === undefined || msg === null) return fallback !== undefined ? fill(fallback, params) : key;
  if (typeof msg === "object") msg = msg[plurals.select(Number(params.count ?? 0))] ?? msg.other;
  return fill(msg, params);
}

/** True when the active catalog defines `key`. */
export const has = (key) => key in messages;

export const formatNumber = (v, opts) => new Intl.NumberFormat(locale, opts).format(Number(v || 0));
export const formatDate = (d, opts = { day: "numeric", month: "short", year: "numeric" }) =>
  new Intl.DateTimeFormat(locale, opts).format(d instanceof Date ? d : new Date(d));
export const formatList = (items, type = "conjunction") => {
  try { return new Intl.ListFormat(locale, { style: "long", type }).format(items); } catch { return items.join(", "); }
};

function csrf() {
  const c = document.cookie.split("; ").find((x) => x.startsWith("sw_csrf="));
  return c ? decodeURIComponent(c.split("=")[1]) : null;
}

/** Switch the UI language: remembered in a cookie and, when signed in, in the account preferences. */
export async function setLanguage(code) {
  document.cookie = `sw_lang=${encodeURIComponent(code)}; path=/; max-age=31536000; samesite=lax`;
  let signedIn = false;
  try { signedIn = !!JSON.parse(document.getElementById("boot")?.textContent || "{}").user; } catch { /* ignore */ }
  if (signedIn) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const token = csrf();
    if (token) headers["X-CSRF-Token"] = token;
    await fetch("/api/v1/auth/preferences", { method: "PATCH", headers, credentials: "same-origin",
      body: JSON.stringify({ language: code }) }).catch(() => {});
  }
  const url = new URL(location.href);
  url.searchParams.delete("lang");
  location.replace(url.toString());
}

/** Wire every <select data-lang-switch> on the page. */
export function wireLanguageSwitchers(root = document) {
  root.querySelectorAll("select[data-lang-switch]").forEach((sel) => {
    if (sel.dataset.wired) return;
    sel.dataset.wired = "1";
    sel.value = lang;
    sel.addEventListener("change", () => setLanguage(sel.value));
  });
}
