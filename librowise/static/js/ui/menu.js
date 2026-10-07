// Popover & menu behaviour shared by the user menu, the notification centre and table menus.
//
//   const pop = popover(trigger, panel, { onOpen, onClose, menu: true });
//   pop.open(); pop.close(); pop.toggle();
//
// • trigger gets aria-expanded; panel toggles the `hidden` attribute.
// • Escape and outside clicks close it and return focus to the trigger.
// • menu: true adds WAI-ARIA menu keyboard support (↑/↓/Home/End move between items, typeahead).

const ITEM = '[role^="menuitem"]:not([disabled]), .menu-lang select';

export function popover(trigger, panel, { onOpen, onClose, menu = false } = {}) {
  let isOpen = false;
  const items = () => [...panel.querySelectorAll(ITEM)].filter((el) => el.offsetParent !== null);
  const outside = (e) => { if (!panel.contains(e.target) && !trigger.contains(e.target)) close(false); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (!menu) return;
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[n]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? list[0] : list.at(-1))?.focus();
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key.length === 1 && /\S/.test(e.key) && document.activeElement?.tagName !== "SELECT") {
      const k = e.key.toLowerCase();
      const next = [...list.slice(i + 1), ...list.slice(0, i + 1)].find((el) => el.textContent.trim().toLowerCase().startsWith(k));
      next?.focus();
    }
  };
  function open() {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    panel.addEventListener("keydown", onKey);
    onOpen?.();
    if (menu) requestAnimationFrame(() => items()[0]?.focus());
  }
  function close(restore = true) {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    panel.removeEventListener("keydown", onKey);
    onClose?.();
    if (restore) trigger.focus();
  }
  trigger.addEventListener("click", () => (isOpen ? close() : open()));
  trigger.addEventListener("keydown", (e) => {
    if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp") && !isOpen) { e.preventDefault(); open(); }
  });
  // Choosing a menu item closes the menu (links navigate, buttons run their handlers first).
  if (menu) panel.addEventListener("click", (e) => { if (e.target.closest('[role^="menuitem"]')) close(false); });
  return { open, close, toggle: () => (isOpen ? close() : open()), get isOpen() { return isOpen; } };
}
