/**
 * sw.js — MINE service worker
 *
 * Enables three things:
 *   1. PWA install ("Add to Home Screen" button on iOS/Android)
 *   2. Offline app shell — dashboard loads even with no network
 *   3. Smart caching — static assets cached, API calls always fresh
 *
 * Cache strategy:
 *   - HTML / CSS / JS / icons → cache-first (instant load)
 *   - /api/*                 → network-first (always fresh, falls back to cache)
 *   - everything else        → network-first
 *
 * On a new release: bump CACHE_VERSION and the old cache is cleared on
 * next activation, forcing all clients to refetch.
 */

const CACHE_VERSION = "mine-v1";
const APP_SHELL = [
  "./",
  "./mine-live-dashboard.html",
  "./manifest.json",
  "./icon.svg",
];

// ─── INSTALL — pre-cache the app shell ────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // addAll is "all or nothing" — if any URL 404s the install fails.
      // Use a tolerant loop instead so a missing optional asset doesn't
      // break installation.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => {
            console.warn("[sw] skipped (could not cache):", url);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

// ─── ACTIVATE — purge old caches ──────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── FETCH — route requests by type ───────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET — POST/PUT/DELETE go straight to network
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // API calls → network-first (always try live, fall back to cache only
  // if offline). Don't cache POST/PUT responses, but allow GETs to be
  // cached as a last-resort offline fallback.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only cache successful, same-origin GETs
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else (HTML/CSS/JS/images) → cache-first, network-fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => {
          // No network + no cache → return a minimal offline fallback
          if (req.mode === "navigate") {
            return new Response(
              "<!doctype html><meta charset=utf-8><title>Offline</title><body style=\"font-family:system-ui;padding:48px;text-align:center\"><h1 style=\"color:#6366F1\">Offline</h1><p>MINE will reconnect when you're back online.</p></body>",
              { headers: { "Content-Type": "text/html" } }
            );
          }
        });
    })
  );
});

// ─── MESSAGE — allow page to ask sw to skip waiting ───────────────────
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
