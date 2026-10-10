// Staff › My account & security — profile summary + the shared security panel (password, two-factor
// authentication, sessions, API tokens, linked accounts, sign-in history) in a settings layout with a section nav.
import { $, $$, datetime, relative } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { applyAvatarHues } from "/static/js/ui/avatar.js";
import { mountSecurity } from "/static/js/security-panel.js";

function wireNav() {
  const links = $$(".sec-nav a[data-nav]");
  const sections = () => links.map((a) => ({ a, el: document.getElementById(a.getAttribute("href").slice(1))?.closest("section") })).filter((x) => x.el);
  // Hide links to sections that are not shown (e.g. no single sign-on providers configured).
  for (const { a, el } of sections()) a.closest("li").hidden = el.classList.contains("hidden");
  const setCurrent = (a) => links.forEach((l) => (l === a ? l.setAttribute("aria-current", "true") : l.removeAttribute("aria-current")));
  if ("IntersectionObserver" in window) {
    const visible = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) visible.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
      const top = sections().filter(({ el }) => (visible.get(el) || 0) > 0)[0];
      if (top) setCurrent(top.a);
    }, { rootMargin: "-15% 0px -55% 0px", threshold: [0, 0.01, 0.5] });
    sections().forEach(({ el }) => io.observe(el));
  }
  $(".sec-nav").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-nav]");
    if (!a) return;
    const target = document.getElementById(a.getAttribute("href").slice(1));
    if (!target) return;
    e.preventDefault();
    const section = target.closest("section") || target;
    section.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    setCurrent(a);
    history.replaceState(null, "", `${location.search}${a.getAttribute("href")}`);
  });
}

export default async function init() {
  applyAvatarHues($(".sec-page"));
  const last = $("#sec-last-login time");
  if (last) { last.textContent = `${datetime(last.getAttribute("datetime"))} · ${relative(last.getAttribute("datetime"))}`; }
  const root = $("#security-root");
  const enroll = new URLSearchParams(location.search).get("enroll") === "1";
  await mountSecurity(root, { enroll, password: true, t, headingLevel: "h2" });
  root.removeAttribute("aria-busy");
  wireNav();
  // Deep link (e.g. /staff/security#sec-tok-h) — the sections only exist after mounting.
  if (location.hash) document.getElementById(location.hash.slice(1))?.closest("section")?.scrollIntoView({ block: "start" });
  // Forced enrolment: bring the two-factor card into view.
  if (enroll) $("#sec-mfa-h")?.closest("section")?.scrollIntoView({ block: "start" });
}
