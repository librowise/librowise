// Notification centre (the bell in the staff top bar).
// Feed: GET /api/v1/ui/notifications — permission-filtered alerts (dashboard alerts, ready holds, failed
// notices, pending requests, failed jobs for admins). Read state is per user and per browser
// (localStorage "sw-notif-read:<user id>"); an item's id changes when its content changes, so a new
// count shows up as unread again. Refreshes every 2 minutes while the tab is visible.
import { $, BOOT, api, html, icon, relative } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { emptyState } from "/static/js/ui/empty.js";
import { popover } from "/static/js/ui/menu.js";

const KEY = `sw-notif-read:${BOOT.user?.id ?? "anon"}`;
const REFRESH_MS = 120_000;
const readSet = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY)) || []); } catch { return new Set(); } };
const saveRead = (ids) => { try { localStorage.setItem(KEY, JSON.stringify([...ids].slice(-300))); } catch { /* ignore */ } };

let items = [], fetchedAt = null;

/** Localised title/body for a feed item (server text is the English fallback). */
function text(it) {
  if (["overdue_spike", "budget", "holds_ratio"].includes(it.kind)) {  // dashboard alerts share the dashboard's strings
    return { title: t(`dash.alert_${it.kind}`, it.params || {}, it.title), body: t(`dash.alert_msg_${it.kind}`, it.params || {}, it.title) };
  }
  const title = t(`ui.notif.kind.${it.kind}`, it.params || {}, it.title);
  const body = it.body ? t(`ui.notif.kind.${it.kind}_body`, it.params || {}, it.body) : "";
  return { title, body };
}

function paint(root) {
  const read = readSet();
  const unread = items.filter((i) => !read.has(i.id)).length;
  const count = $(".notif-count", root), trigger = $(".notif-trigger", root);
  count.hidden = unread === 0;
  count.textContent = unread > 9 ? "9+" : String(unread);
  trigger.setAttribute("aria-label", unread ? t("ui.notif.title_unread", { count: unread }) : t("ui.notif.title"));
  const panel = $(".notif-panel", root);
  panel.innerHTML = html`<div class="notif-head"><h2>${t("ui.notif.title")}</h2>
      ${unread ? html`<button type="button" class="link-btn" data-mark-all>${t("ui.notif.mark_all")}</button>` : ""}</div>
    ${items.length ? html`<ul class="notif-list" role="list">${items.map((it) => {
      const { title, body } = text(it);
      return html`<li class="notif-item tone-${it.tone} ${read.has(it.id) ? "read" : ""}"><a href="${it.href}" data-notif="${it.id}">
        <span class="n-icon" aria-hidden="true">${icon(it.icon || "bell")}</span>
        <span><span class="n-title">${title}</span>${body ? html`<span class="n-body"> ${body}</span>` : ""}
          <span class="n-meta">${read.has(it.id) ? "" : html`<span class="sr-only">${t("ui.notif.unread")} · </span>`}${relative(it.at)}</span></span>
        <span class="n-dot" aria-hidden="true"></span></a></li>`;
    })}</ul>` : emptyState({ art: "done", compact: true, title: t("ui.notif.empty_title"), body: t("ui.notif.empty_body") })}
    <div class="notif-foot"><span>${fetchedAt ? t("ui.notif.updated", { when: relative(fetchedAt) }) : ""}</span>
      <button type="button" class="link-btn" data-refresh>${t("ui.notif.refresh")}</button></div>`;
}

async function load(root) {
  try {
    const r = await api("/ui/notifications");
    items = r.items || [];
    fetchedAt = r.generated_at;
  } catch { /* keep the previous list; the bell is non-critical */ }
  paint(root);
}

export function initNotifications() {
  const root = $("[data-notifications]");
  if (!root) return;
  const panel = $(".notif-panel", root);
  popover($(".notif-trigger", root), panel, { onOpen: () => { paint(root); $("a, button", panel)?.focus(); } });
  panel.addEventListener("click", (e) => {
    const read = readSet();
    if (e.target.closest("[data-mark-all]")) { items.forEach((i) => read.add(i.id)); saveRead(read); paint(root); $(".notif-trigger", root).focus(); return; }
    if (e.target.closest("[data-refresh]")) { load(root); return; }
    const a = e.target.closest("[data-notif]");
    if (a) { read.add(a.dataset.notif); saveRead(read); }
  });
  load(root);
  setInterval(() => { if (!document.hidden) load(root); }, REFRESH_MS);
}
