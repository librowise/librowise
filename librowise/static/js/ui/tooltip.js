// Tooltips: add `data-tip="Text"` to any focusable element. Shown on hover (after a short delay) and on
// keyboard focus, dismissed with Escape (WCAG 1.4.13), positioned to stay on screen, and exposed to
// assistive technology through aria-describedby. Icon-only buttons still need their own aria-label —
// a tooltip describes, it does not name.

let tip, current, timer, seq = 0;

function ensure() {
  if (tip) return tip;
  tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  tip.id = "sw-tooltip";
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function place(el) {
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const below = r.top < t.height + 12;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? r.bottom + 8 : r.top - t.height - 8}px`;
}

export function showTip(el) {
  const text = el.dataset.tip;
  if (!text) return;
  ensure();
  current = el;
  tip.textContent = text;
  tip.hidden = false;
  tip.id = `sw-tooltip-${++seq}`;
  const prev = el.getAttribute("aria-describedby") || "";
  if (!prev.includes("sw-tooltip")) el.setAttribute("aria-describedby", `${prev} ${tip.id}`.trim());
  else el.setAttribute("aria-describedby", prev.replace(/sw-tooltip-\d+/, tip.id));
  place(el);
}

export function hideTip() {
  clearTimeout(timer);
  if (!tip || tip.hidden) return;
  tip.hidden = true;
  if (current) {
    const rest = (current.getAttribute("aria-describedby") || "").replace(/\s*sw-tooltip-\d+/, "").trim();
    if (rest) current.setAttribute("aria-describedby", rest); else current.removeAttribute("aria-describedby");
  }
  current = null;
}

export function initTooltips(root = document) {
  if (root.__swTips) return;
  root.__swTips = true;
  root.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el || el === current) return;
    clearTimeout(timer);
    timer = setTimeout(() => showTip(el), 350);
  });
  root.addEventListener("pointerout", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el && !el.contains(e.relatedTarget)) hideTip();
  });
  root.addEventListener("focusin", (e) => { const el = e.target.closest?.("[data-tip]"); if (el && el.matches(":focus-visible")) showTip(el); });
  root.addEventListener("focusout", hideTip);
  root.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
  window.addEventListener("scroll", hideTip, { passive: true, capture: true });
}
