// Applies saved appearance before first paint (loaded synchronously in <head>; no inline JS under CSP).
(function () {
  try {
    var d = document.documentElement;
    var p = JSON.parse(localStorage.getItem("sw-prefs") || "{}");
    if (p.theme && p.theme !== "system") d.dataset.theme = p.theme;
    if (p.density) d.dataset.density = p.density;
    if (p.font_scale) d.style.setProperty("--scale", p.font_scale);
    // Staff sidebar: "rail" (icons only) or full; remembered per browser (see /static/js/ui/shell.js).
    if (localStorage.getItem("sw-sidebar") === "rail") d.dataset.sidebar = "rail";
  } catch (e) { /* storage unavailable — defaults apply */ }
})();
