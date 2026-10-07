// Avatars: initials on a deterministic hue derived from the name (stable across pages and sessions).
//   avatar("Asha Rao")            → <span class="avatar sm" …>AR</span>
//   avatar(name, { size: "md", src: photoUrl })
// Sizes: xs (24px) · sm (32px) · md (40px) · default 48px · lg (64px). Text contrast ≥ 4.5:1 on every hue.
import { html, initials } from "/static/js/core.js";

export const hue = (name = "") => [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11) % 360;

export function avatar(name, { size = "sm", src = null, label = null } = {}) {
  const text = initials(name);
  return html`<span class="avatar ${size}" style="--h:${hue(name)}" ${label ? html`role="img" aria-label="${label}"` : html`aria-hidden="true"`}>${
    src ? html`<img src="${src}" alt="">` : text}</span>`;
}

/** Colour server-rendered avatars that carry `data-avatar="Full Name"`. */
export function applyAvatarHues(root = document) {
  root.querySelectorAll("[data-avatar]").forEach((el) => el.style.setProperty("--h", hue(el.dataset.avatar)));
}
