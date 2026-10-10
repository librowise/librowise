// Circulation desk boot (classic script, runs before first paint like theme-boot.js): record the desk mode
// from the URL hash (#checkin, #renew, #transfer) on <html>, so the server-rendered page already shows the
// right scan form and nothing jumps when the page script starts.
(function () {
  var m = (location.hash || "").slice(1);
  if (["checkout", "checkin", "renew", "transfer"].indexOf(m) < 0) m = "checkout";
  document.documentElement.setAttribute("data-desk-mode", m);
})();
