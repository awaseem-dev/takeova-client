/**
 * stubs.js — Catch-all for endpoints not yet implemented.
 *
 * HOW TO USE
 * ──────────
 *   In server.js, mount this AFTER all real route handlers:
 *
 *     app.use("/api/email",    require("./routes/email"));
 *     app.use("/api/outreach", require("./routes/outreach"));
 *     app.use("/api/features", require("./routes/features"));
 *     app.use("/api/ai-email", require("./routes/ai-email"));
 *     // ... all your real routes above this line ...
 *
 *     // Catch-all: anything not handled above gets a stub response
 *     app.use("/api", require("./routes/stubs"));
 *
 * WHAT IT DOES
 * ────────────
 * The dashboard wires 320 endpoints; your existing routes cover ~42
 * of them. This handler catches the remaining ~278 so the dashboard
 * can be tested end-to-end without 404 errors.
 *
 * Responses are intelligently shaped by method and URL:
 *   - GET  .csv            → CSV header row
 *   - GET  .pdf            → minimal PDF bytes
 *   - GET  /collection     → { items: [], count: 0 }
 *   - GET  /single/:id     → { id, created_at }
 *   - POST /create         → { ok: true, id: "stub_…", ...body }
 *   - PUT  /update         → { ok: true, ...body }
 *   - DELETE /remove       → { ok: true, deleted: true }
 *
 * Each hit is logged to console so you can see exactly which
 * endpoints need real implementations as users exercise them.
 *
 * ⚠️  REPLACE WITH REAL HANDLERS BEFORE SHIPPING TO PAYING USERS.
 *     Stubs will claim success for operations that don't actually
 *     happen. Check the [STUB] console lines during QA to find
 *     endpoints that still need implementing.
 */
const express = require("express");
const router = express.Router();

// Log every stub hit so the user can see which endpoints are being exercised
router.use((req, _res, next) => {
  console.log(`[STUB] ${req.method} ${req.originalUrl}`);
  next();
});

// ── CSV downloads ────────────────────────────────────────────
router.get(/\.csv$/, (req, res) => {
  const filename = req.path.split("/").pop();
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(
    "id,name,email,status,created_at\n" +
    "stub_1,Demo Person,demo@example.com,active,2026-04-21\n" +
    "stub_2,Jane Example,jane@example.com,active,2026-04-21\n"
  );
});

// ── PDF downloads ────────────────────────────────────────────
router.get(/\.pdf$/, (req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  res.send(Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "%%EOF"
  ));
});

// ── PNG (for QR codes, etc.) ────────────────────────────────
router.get(/\.png$/, (_req, res) => {
  // 1x1 transparent PNG
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=", "base64");
  res.setHeader("Content-Type", "image/png");
  res.send(png);
});

// ── GET single item (path ends with /:id) ────────────────────
// Heuristic: last segment is a dynamic id if it looks like one
router.get("*", (req, res) => {
  const parts = req.path.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  const collection = parts[parts.length - 2] || "items";

  const looksLikeId = /^[\w-]{2,}$/.test(last) && !/^(list|index|stats|all|count)$/.test(last)
                      && !isPluralCollection(last);

  if (looksLikeId) {
    return res.json({
      id: last,
      name: `Stub ${collection} ${last}`,
      created_at: new Date().toISOString(),
      status: "active"
    });
  }

  // Otherwise treat as a list endpoint
  const key = last || "items";
  return res.json({
    [key]: [],
    items: [],
    data: [],
    count: 0
  });
});

function isPluralCollection(segment) {
  // Rough heuristic: ends with 's' but isn't a plausible ID
  return /s$/.test(segment) && segment.length > 2 && !/^\d+$/.test(segment);
}

// ── POST creates a new entity ────────────────────────────────
router.post("*", (req, res) => {
  const id = "stub_" + Date.now().toString(36);
  res.json({
    ok: true,
    id,
    ...(req.body || {}),
    created_at: new Date().toISOString()
  });
});

// ── PUT / PATCH update an existing entity ────────────────────
router.put("*", (req, res) => {
  res.json({ ok: true, ...(req.body || {}), updated_at: new Date().toISOString() });
});

router.patch("*", (req, res) => {
  res.json({ ok: true, ...(req.body || {}), updated_at: new Date().toISOString() });
});

// ── DELETE removes an entity ─────────────────────────────────
router.delete("*", (_req, res) => {
  res.json({ ok: true, deleted: true });
});

// ── OPTIONS (CORS preflight passthrough) ─────────────────────
router.options("*", (_req, res) => {
  res.sendStatus(204);
});

module.exports = router;
