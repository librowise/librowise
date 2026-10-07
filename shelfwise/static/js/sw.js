// Shelfwise OPAC service worker (served at /sw.js so its scope is the whole site).
// Strategy: static assets cache-first, public pages network-first with an offline fallback.
// API calls, staff pages, the kiosk and anything personalised are never cached.
/* eslint-env serviceworker */

const BUILD = "__BUILD__";
const STATIC_CACHE = `sw-static-${BUILD}`;
const PAGE_CACHE = `sw-pages-${BUILD}`;
const OFFLINE_URL = "/offline";
const PRECACHE = [
  OFFLINE_URL,
  "/static/css/tokens.css?v=__VERSION__",
  "/static/css/app.css?v=__VERSION__",
  "/static/css/ui.css?v=__VERSION__",
  "/static/fonts/inter/InterVariable.woff2",
  "/static/js/ui/empty.js",
  "/static/js/ui/filters.js",
  "/static/js/ui/pagination.js",
  "/static/js/ui/tabs.js",
  "/static/js/ui/tooltip.js",
  "/static/js/ui/palette.js",
  "/static/js/theme-boot.js?v=__VERSION__",
  "/static/js/core.js",
  "/static/js/i18n.js",
  "/static/js/pwa.js",
  "/static/js/suggest.js",
  "/static/js/pages/offline.js",
  "/static/js/pages/opac-home.js",
  "/static/js/pages/opac-search.js",
  "/static/js/pages/opac-record.js",
  "/static/js/record-extras.js",
  "/static/favicon.svg",
  "/static/icons/icon.svg",
  "/static/icons/maskable.svg",
];
const NEVER = [/^\/api\//, /^\/staff/, /^\/kiosk/, /^\/sw\.js$/, /^\/login/, /^\/account/, /^\/healthz/, /^\/readyz/];
const PUBLIC_PAGES = [/^\/$/, /^\/search$/, /^\/record\/\d+$/];
const MAX_PAGES = 60;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Precache individually so one missing asset does not abort installation.
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, PAGE_CACHE]);
    for (const key of await caches.keys()) if (key.startsWith("sw-") && !keep.has(key)) await caches.delete(key);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    await self.clients.claim();
  })());
});

const cacheable = (res) => res && res.ok && res.type === "basic" && !/no-store|private/.test(res.headers.get("Cache-Control") || "");

async function trimPages(cache) {
  const keys = await cache.keys();
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(req);
}

async function networkFirst(event) {
  const { request } = event;
  const url = new URL(request.url);
  try {
    const res = (await event.preloadResponse) || (await fetch(request));
    if (cacheable(res) && PUBLIC_PAGES.some((re) => re.test(url.pathname))) {
      const cache = await caches.open(PAGE_CACHE);
      await cache.put(request, res.clone());
      trimPages(cache);
    }
    return res;
  } catch {
    const cached = await caches.match(request, { cacheName: PAGE_CACHE, ignoreVary: true });
    if (cached) return cached;
    return (await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE, ignoreVary: true })) ||
      new Response("<h1>Offline</h1>", { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: STATIC_CACHE, ignoreVary: true });
  if (cached) return cached;
  const res = await fetch(request);
  if (cacheable(res)) (await caches.open(STATIC_CACHE)).put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER.some((re) => re.test(url.pathname))) return;
  if (request.mode === "navigate") { event.respondWith(networkFirst(event)); return; }
  if (url.pathname.startsWith("/static/")) event.respondWith(cacheFirst(request));
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
