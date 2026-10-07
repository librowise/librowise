// Staff shell behaviour: collapsible sidebar (full ↔ icon rail, remembered), off-canvas sidebar on small
// screens, hub disclosure toggles, Alt+1…9 hub shortcuts, the user menu and the notification centre.
// Markup: templates/staff_base.html. Hub registry: librowise/web.py (HUBS).
import { $, $$, BOOT } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { applyAvatarHues } from "/static/js/ui/avatar.js";
import { popover } from "/static/js/ui/menu.js";
import { initNotifications } from "/static/js/ui/notifications.js";

const STORE = "sw-sidebar";
const root = document.documentElement;
const mobile = () => window.matchMedia("(max-width: 960px)").matches;

export function setRail(on) {
  if (on) root.dataset.sidebar = "rail"; else delete root.dataset.sidebar;
  try { localStorage.setItem(STORE, on ? "rail" : "full"); } catch { /* private mode */ }
  const btn = $("[data-sidebar-collapse]");
  if (btn) {
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? t("ui.shell.expand") : t("ui.shell.collapse"));
  }
}

function initSidebar() {
  const sidebar = $("#sidebar"), scrim = $(".sidebar-scrim"), opener = $("[data-sidebar-open]");
  if (!sidebar) return;
  setRail(root.dataset.sidebar === "rail");
  $("[data-sidebar-collapse]")?.addEventListener("click", () => setRail(root.dataset.sidebar !== "rail"));

  const openMobile = () => {
    sidebar.classList.add("open");
    scrim.hidden = false;
    opener?.setAttribute("aria-expanded", "true");
    (sidebar.querySelector("[aria-current]") || sidebar.querySelector("a"))?.focus();
  };
  const closeMobile = (restore = true) => {
    if (!sidebar.classList.contains("open")) return;
    sidebar.classList.remove("open");
    scrim.hidden = true;
    opener?.setAttribute("aria-expanded", "false");
    if (restore) opener?.focus();
  };
  opener?.addEventListener("click", openMobile);
  $$("[data-sidebar-close]").forEach((el) => el.addEventListener("click", () => closeMobile()));
  sidebar.addEventListener("keydown", (e) => { if (e.key === "Escape" && mobile()) closeMobile(); });
  window.matchMedia("(max-width: 960px)").addEventListener("change", (e) => { if (!e.matches) closeMobile(false); });

  // Hub disclosure: expand/collapse a hub's tab list in the full sidebar.
  sidebar.addEventListener("click", (e) => {
    const btn = e.target.closest(".hub-toggle");
    if (!btn) return;
    const sub = document.getElementById(btn.getAttribute("aria-controls"));
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    if (sub) sub.hidden = !open;
  });
}

function initKeys() {
  // Holding Alt reveals the Alt+N hints next to each hub (like menu accelerators).
  const altOff = () => delete root.dataset.altHeld;
  document.addEventListener("keydown", (e) => { if (e.key === "Alt") root.dataset.altHeld = "1"; });
  document.addEventListener("keyup", (e) => { if (e.key === "Alt") altOff(); });
  window.addEventListener("blur", altOff);
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
      const link = $(`.hub-link[data-hub-index="${e.code.slice(5)}"]`);
      if (link) { e.preventDefault(); location.href = link.href; }
    } else if (e.key === "[" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !mobile()) {
      e.preventDefault();
      setRail(root.dataset.sidebar !== "rail");
    }
  });
}

function initUserMenu() {
  const box = $("[data-menu]");
  if (!box) return;
  popover($("[data-menu-trigger]", box), $('[role="menu"]', box), { menu: true });
}

export function initShell() {
  initSidebar();
  initKeys();
  initUserMenu();
  applyAvatarHues();
  if (BOOT.user?.is_staff) initNotifications();
}
