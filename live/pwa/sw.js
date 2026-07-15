/**
 * MINE Service Worker
 *
 * Provides:
 *   - "Add to Home Screen" install eligibility (PWA criteria)
 *   - Offline fallback for the app shell
 *   - Network-first caching for API calls (always fresh, but degrades to cache)
 *   - Cache-first for static assets (instant load on repeat visits)
 *
 * Versioned cache name lets us bust on each deploy by bumping CACHE_VERSION.
 */

const CACHE_VERSION = "mine-v1";
const APP_SHELL_CACHE = "mine-shell-" + CACHE_VERSION;
const API_CACHE       = "mine-api-"   + CACHE_VERSION;

// Pre-cache the dashboard HTML on install so a returning user can open the
// app even with no connection. Other resources load lazily.
const APP_SHELL = [
  "/mine-live-dashboard.html",
  "/agency-live-dashboard.html",
  "/admin-live-dashboard.html",
  "/pwa/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) =>
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Clean up old caches from previous versions
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("mine-") && !k.endsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests. POST/PUT/DELETE always go through to network.
  if (req.method !== "GET") return;

  // Never cache:
  //   - API auth-sensitive routes
  //   - Stripe / Anthropic / external APIs
  //   - Hot real-time endpoints
  if (
    url.pathname.startsWith("/api/auth/")          ||
    url.pathname.startsWith("/api/notifications") ||
    url.pathname.startsWith("/api/payments/")     ||
    url.hostname.includes("stripe.com")           ||
    url.hostname.includes("anthropic.com")        ||
    url.hostname.includes("sendgrid.net")
  ) {
    return; // let the browser handle normally
  }

  // API routes: network-first, fall back to cache on failure (offline read).
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Cache the response for offline fallback (only 2xx)
          if (res.ok) {
            const copy = res.clone();
            caches.open(API_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then(
            (cached) =>
              cached ||
              new Response(
                JSON.stringify({ error: "offline", offline: true }),
                { status: 503, headers: { "Content-Type": "application/json" } }
              )
          )
        )
    );
    return;
  }

  // Static assets (HTML, JS, CSS, fonts, images): cache-first for speed.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cache successful responses for next time
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(APP_SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        // Final offline fallback: serve the dashboard HTML
        if (req.destination === "document") {
          return caches.match("/mine-live-dashboard.html");
        }
      });
    })
  );
});
