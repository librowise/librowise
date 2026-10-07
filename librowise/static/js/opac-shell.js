// Public catalogue shell behaviour (loaded by opac_base.html on every OPAC page):
// • phone menu: below 820px the navigation and tools collapse behind a disclosure button (Esc, outside
//   click and resizing to desktop close it; focus returns to the button);
// • account menu: WAI-ARIA menu button for signed-in readers (ui/menu.js popover);
// • compact header search with search-as-you-type suggestions;
// • a hairline shadow under the sticky header once the page has scrolled.
import { $ } from "/static/js/core.js";
import { popover } from "/static/js/ui/menu.js";
import { attachSuggest } from "/static/js/suggest.js";

const PHONE = window.matchMedia("(max-width: 820px)");

function phoneMenu(header) {
  const btn = $("[data-opac-menu]", header), panel = $("#opac-menu", header);
  if (!btn || !panel) return;
  const set = (open, { focus = false } = {}) => {
    header.toggleAttribute("data-menu-open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      document.addEventListener("pointerdown", outside, true);
      if (focus) panel.querySelector("a, button, select")?.focus();
    } else {
      document.removeEventListener("pointerdown", outside, true);
    }
  };
  const outside = (e) => { if (!header.contains(e.target)) set(false); };
  btn.addEventListener("click", () => set(btn.getAttribute("aria-expanded") !== "true", { focus: false }));
  header.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && header.hasAttribute("data-menu-open")) {
      e.preventDefault();
      set(false);
      btn.focus();
    }
  });
  // Leaving the panel with Tab closes it (the panel sits between the menu button and the end tools).
  panel.addEventListener("focusout", (e) => {
    if (PHONE.matches && header.hasAttribute("data-menu-open") && e.relatedTarget && !panel.contains(e.relatedTarget) && e.relatedTarget !== btn) set(false);
  });
  PHONE.addEventListener("change", () => set(false));
}

function accountMenu(header) {
  const trigger = $("[data-account-menu]", header), panel = $("#oh-account-menu", header);
  if (trigger && panel) popover(trigger, panel, { menu: true });
}

function scrolled(header) {
  let raf = 0;
  const update = () => { raf = 0; header.toggleAttribute("data-scrolled", window.scrollY > 4); };
  window.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
  update();
}

const header = $("[data-opac-header]");
if (header) {
  phoneMenu(header);
  accountMenu(header);
  scrolled(header);
  const q = $("#oh-q", header);
  if (q) attachSuggest(q);
}
