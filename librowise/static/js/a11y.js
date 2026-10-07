// Accessibility helpers shared by pages.

/**
 * ARIA tabs with a roving tabindex: ←/→ (and Home/End) move between tabs and activate them (by clicking,
 * so the page's own click handler stays the single source of behaviour). Keeps each tab's tabindex and
 * the panel's aria-labelledby in sync with aria-selected, whoever changes it.
 */
export function wireTabs(tablist, panel) {
  if (!tablist || tablist.dataset.a11yTabs) return;
  tablist.dataset.a11yTabs = "1";
  const tabs = () => [...tablist.querySelectorAll("[role=tab]")];
  const sync = () => {
    for (const tab of tabs()) {
      const on = tab.getAttribute("aria-selected") === "true";
      tab.tabIndex = on ? 0 : -1;
      if (on && panel && tab.id) panel.setAttribute("aria-labelledby", tab.id);
    }
  };
  tablist.addEventListener("keydown", (e) => {
    const list = tabs();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const rtl = getComputedStyle(tablist).direction === "rtl";
    const fwd = rtl ? "ArrowLeft" : "ArrowRight", back = rtl ? "ArrowRight" : "ArrowLeft";
    const next = { [fwd]: i + 1, [back]: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const tab = list[(next + list.length) % list.length];
    tab.focus();
    tab.click();
  });
  new MutationObserver(sync).observe(tablist, { subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
  sync();
}
