/*
 * Хатсит — service worker for offline support of the fully local games
 * (Шпион / Алиас / Мафия). Бункер and Суд need a live network connection
 * anyway (Supabase Realtime), so their traffic is never touched here.
 *
 * Safety rules (this project got badly burned by a previous, buggier
 * service worker that left people stuck on an old cached version — see
 * the removed "nuke everything" script that used to live in index.html):
 *   1. The app document itself and anything NOT pinned to an exact,
 *      versioned URL is served network-first — the network always wins
 *      when it's available, and the cache is only a fallback for when
 *      the device is offline. This means an online visit always picks
 *      up the latest deploy; nothing can get "stuck" on stale HTML.
 *   2. Only assets whose URL is pinned to an exact version (so the same
 *      URL can never change its content — React/ReactDOM/Babel from
 *      cdnjs, and hashed font files from fonts.gstatic.com) are served
 *      cache-first, since there's zero staleness risk for those.
 *   3. self.skipWaiting() + clients.claim() so a new deploy's service
 *      worker takes over immediately instead of waiting for every tab
 *      to be closed first.
 *   4. Old cache versions are deleted on activate.
 */

const CACHE_VERSION = "hatsit-shell-v1";

const IMMUTABLE_HOSTS = ["cdnjs.cloudflare.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

function isImmutable(url) {
  return IMMUTABLE_HOSTS.includes(url.hostname);
}

// Only ever intercept our own app shell + the small set of CDN hosts it
// depends on. Everything else (Supabase API/Realtime, any third-party
// call) is left completely alone — no caching, no offline fallback.
function shouldHandle(url, sameOrigin) {
  if (sameOrigin) return true;
  return (
    IMMUTABLE_HOSTS.includes(url.hostname) ||
    url.hostname === "cdn.tailwindcss.com" ||
    url.hostname === "fonts.googleapis.com"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!shouldHandle(url, sameOrigin)) return;

  if (isImmutable(url)) {
    // Cache-first: the URL is version-pinned, so a cached copy can never
    // be "wrong". Falls back to network on first use, then reused offline.
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // Network-first for the document itself and any non-pinned shell asset
  // (Tailwind's CDN script, the Google Fonts stylesheet). Online visits
  // always get the freshest copy; offline visits fall back to whatever
  // was last cached successfully.
  event.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cache.match(req).then((cached) => cached || Promise.reject("offline-and-not-cached")))
    )
  );
});
