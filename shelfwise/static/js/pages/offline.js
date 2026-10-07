// Offline fallback page: retry the page the reader was trying to open as soon as we are back online.
export default function init() {
  const retry = () => location.reload();
  document.querySelector("[data-retry]")?.addEventListener("click", retry);
  window.addEventListener("online", retry, { once: true });
}
