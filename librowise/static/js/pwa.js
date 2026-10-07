// Installable OPAC: registers the root-scoped service worker, offers an "Install app" button when the
// browser supports it, and shows a banner while the device is offline.

const installBtn = () => document.querySelector("[data-pwa-install]");
const banner = () => document.querySelector("[data-offline-banner]");
let deferredPrompt = null;

if ("serviceWorker" in navigator && window.isSecureContext && !location.pathname.startsWith("/kiosk")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) => console.warn("Service worker not registered:", e));
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn()?.classList.remove("hidden");
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  installBtn()?.classList.add("hidden");
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-pwa-install]");
  if (!btn || !deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => null);
  deferredPrompt = null;
  btn.classList.add("hidden");
});

function syncOnline() {
  const b = banner();
  if (b) b.classList.toggle("hidden", navigator.onLine);
}
window.addEventListener("online", syncOnline);
window.addEventListener("offline", syncOnline);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncOnline); else syncOnline();
