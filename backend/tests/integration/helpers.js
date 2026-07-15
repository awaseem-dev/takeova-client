// tests/integration/helpers.js
// Shared setup for integration tests. These tests boot the REAL Express app against a
// throwaway SQLite DB and exercise real routes end-to-end.
//
// ─── BEFORE THESE CAN RUN, A DEV MUST DO TWO THINGS ─────────────────────────────────
// 1. Install supertest:        npm i -D supertest
// 2. Make server.js export the app WITHOUT listening on import. At the bottom of
//    server.js, change:
//          const httpServer = app.listen(PORT, () => { ... });
//    to:
//          let httpServer;
//          if (require.main === module) { httpServer = app.listen(PORT, () => { ... }); }
//          module.exports = app;
//    (Booting the listener on import would bind a real port and break supertest.)
//
// Until both are done, every integration test self-skips with a clear message — it will
// NOT fail the suite. Run with:  npm run test:all
// ─────────────────────────────────────────────────────────────────────────────────────

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

// Point the DB at a fresh temp dir BEFORE anything requires the app/db.
function useTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mine-itest-"));
  process.env.DB_PATH = dir;
  process.env.NODE_ENV = "test";
  // Minimal env so modules that read secrets at import don't crash. Add more as needed.
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
  return dir;
}

// Try to load supertest + the app. Returns null (not throw) if not wired yet,
// so callers can skip gracefully.
function loadHarness() {
  let request, app;
  try { request = require("supertest"); }
  catch { return { ok: false, reason: "supertest not installed — run: npm i -D supertest" }; }
  try { app = require("../../server"); }
  catch (e) { return { ok: false, reason: "could not import app from server.js (" + e.message + ") — see helpers.js header" }; }
  if (!app || typeof app !== "function" || typeof app.use !== "function") {
    return { ok: false, reason: "server.js did not module.exports the Express app — see helpers.js header" };
  }
  return { ok: true, request, app };
}

module.exports = { useTempDb, loadHarness };
