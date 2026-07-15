// ═══════════════════════════════════════════════════════════════════════════
// Path-compatibility middleware
//
// Several dashboard buttons call an endpoint under a "logical" prefix, but the
// real handler lives under a different prefix (most commonly inside features.js
// at /api/features/...). Rather than editing three large dashboard files (and
// risking parity drift), we rewrite req.url to the real path BEFORE any route
// is matched. The owning routers never see the original path, so this is safe
// even where a prefix is already mounted (e.g. /api/reviews, /api/email).
//
// Every target below was verified to exist in the backend. Method is preserved
// (we only touch the path). Query strings are preserved.
//
// Generated as part of the whole-backend wiring audit (May 2026).
// ═══════════════════════════════════════════════════════════════════════════

// Exact path → real path (handlers confirmed present in the named file)
const EXACT = {
  "/api/analytics/summary":                  "/api/features/analytics/summary",        // features.js
  "/api/orders/returns":                     "/api/features/orders/returns",           // features.js
  "/api/chat/conversations":                 "/api/features/chat/conversations",       // features.js
  "/api/reviews/request":                    "/api/features/reviews/request",          // features.js
  "/api/email/broadcast":                    "/api/features/email/broadcast",          // features.js
  "/api/accounting/transactions":            "/api/features/accounting/transactions",  // features.js
  "/api/onboarding/status":                  "/api/platform/onboarding/status",        // platform.js
  "/api/social/posts":                       "/api/integrations/social/posts",         // integrations.js
  "/api/ai-employees/prospector/campaigns":  "/api/prospector/campaigns",              // prospector.js
  "/api/ai-employees/prospector/stats":      "/api/prospector/stats",                  // prospector.js
  "/api/users/me":                           "/api/auth/me",                           // auth.js (sanitizeUser)
  "/api/auth/export-data":                   "/api/auth/account/export",               // auth.js (GDPR export)
  "/api/intelligence/refresh":               "/api/ai-agent/intelligence/refresh",     // ai-agent.js (real on-demand refresh; was 404 on agency)
};

function rewritePath(path) {
  const exact = EXACT[path];
  if (exact) return exact;

  // /api/team/*  →  /api/features/team/*   (features.js owns the team handlers:
  //   POST /team/invite, PUT /team/:memberId/role, DELETE /team/:memberId, …)
  if (path === "/api/team" || path.startsWith("/api/team/")) {
    return "/api/features" + path.slice(4); // strip "/api"
  }

  // /api/data/lead-magnets/*  →  /api/features/lead-magnets/*   (features.js)
  if (path === "/api/data/lead-magnets" || path.startsWith("/api/data/lead-magnets/")) {
    return "/api/features" + path.slice("/api/data".length); // → /api/features/lead-magnets/...
  }

  // /api/staff/:id/role  →  /api/features/team/:id/role   (features.js; staff.js
  //   has no /:id/role route, so nothing here is shadowed)
  const staffRole = path.match(/^\/api\/staff\/([^/]+)\/role$/);
  if (staffRole) return "/api/features/team/" + staffRole[1] + "/role";

  return null;
}

module.exports = function pathCompat(req, res, next) {
  try {
    const qi = req.url.indexOf("?");
    const path = qi === -1 ? req.url : req.url.slice(0, qi);
    const query = qi === -1 ? "" : req.url.slice(qi);
    const rewritten = rewritePath(path);
    if (rewritten) req.url = rewritten + query;
  } catch (_) { /* never block a request on a rewrite error */ }
  next();
};

module.exports.rewritePath = rewritePath; // exported for tests
