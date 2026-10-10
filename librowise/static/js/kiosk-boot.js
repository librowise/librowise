// Self-checkout kiosk boot (classic script, runs before first paint like theme-boot.js): switch on the kiosk's
// larger type scale and the reader's saved high-contrast choice before anything is drawn, so the screen
// doesn't jump when the page script starts.
(function () {
  var d = document.documentElement;
  d.setAttribute("data-kiosk", "");
  try {
    var prefs = JSON.parse(localStorage.getItem("sw-kiosk-prefs") || "{}");
    if (prefs.contrast) d.setAttribute("data-theme", "contrast");
  } catch (e) { /* storage blocked: defaults */ }
})();
