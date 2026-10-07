// Printable label sheet: wire the toolbar (CSP forbids inline handlers).
import { $ } from "/static/js/core.js";

export default function init() {
  const sheets = $("#main.label-sheets");
  $("#print-outlines")?.addEventListener("change", (e) => sheets?.classList.toggle("print-outlines", e.target.checked));
  $("#print-now")?.addEventListener("click", () => window.print());
  if (new URLSearchParams(location.search).get("autoprint") === "1" && sheets) setTimeout(() => window.print(), 300);
}
