/**
 * lookalike.js — AI Lookalike Customer Generator
 *
 * The pipeline:
 *   1. User uploads (or selects) their best customers
 *   2. AI analyses them → builds an Ideal Customer Profile (ICP)
 *   3. AI generates N candidate businesses that match the ICP
 *   4. Candidates land in `lookalike_prospects` table
 *   5. Optionally — auto-queue to AI Cold Email Agent for outreach
 *
 * ENDPOINTS
 *   POST /api/lookalike/from-customers       → generate lookalikes from a customer list
 *   GET  /api/lookalike/prospects            → list generated prospects
 *   POST /api/lookalike/prospects/:id/queue  → queue for AI Cold Email
 *   POST /api/lookalike/prospects/:id/dismiss → remove from list
 *
 * NOTE
 *   The "find matching real businesses" step uses Claude's training data
 *   to generate candidate profiles. In production this should be paired
 *   with a real B2B data provider (Apollo, Clearbit, Hunter, ZoomInfo)
 *   for verified contact info. We log the source so customers know which
 *   profiles are "AI-generated candidates" vs "verified".
 */

const express   = require("express");
const router    = express.Router();
const { getDb } = require("../db/init");
const { auth }  = require("../middleware/auth");
const { isAdmin } = require("../utils/admin-check");
const { v4: uuid } = require("uuid");

function getSetting(key) {
  try {
    const db = getDb();
    return db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key)?.value;
  } catch (_) { return null; }
}

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lookalike_prospects (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    seed_label    TEXT,
    business_name TEXT NOT NULL,
    website       TEXT,
    industry      TEXT,
    size_estimate TEXT,
    location      TEXT,
    why_match     TEXT,
    contact_name  TEXT,
    contact_role  TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    source        TEXT DEFAULT 'ai_generated',
    confidence    REAL DEFAULT 0.6,
    status        TEXT DEFAULT 'new',
    queued_to     TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lookalike_user_status
           ON lookalike_prospects(user_id, status)`);
}

// ──────────────────────────────────────────────────────────────────────
// POST /from-customers — main entry point
// Body: { seed_customers: [{name, industry, location, size}], count?, region? }
// ──────────────────────────────────────────────────────────────────────
router.post("/from-customers", auth, express.json(), async (req, res) => {
  const db = getDb();
  ensureTables(db);

  const seeds  = Array.isArray(req.body?.seed_customers) ? req.body.seed_customers : [];
  const count  = Math.min(Math.max(parseInt(req.body?.count, 10) || 25, 1), 100);
  const region = String(req.body?.region || "").slice(0, 80);

  if (!seeds.length) return res.status(400).json({ error: "seed_customers required (your existing best customers to find lookalikes of)" });

  // ── Plan cap check ─────────────────────────────────────────────────
  // Admin bypasses; starter blocked; growth=5/mo, pro=25, enterprise=100, agency=200
  if (typeof global.mineCheckUsage === "function") {
    const check = global.mineCheckUsage(db, req.userId, "lookalikeGenerations");
    if (check.blocked) {
      return res.status(403).json({
        error: check.cap === 0
          ? "Lookalike Customer Generator is a Growth-plan feature. Upgrade to unlock."
          : `You've used your ${check.cap} lookalike generations this month. Upgrade for more, or wait until next billing cycle.`,
        plan: check.plan,
        cap: check.cap,
        current: check.current,
        upgrade_required: check.cap === 0,
      });
    }
  }

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  // Build the ICP prompt for Claude
  const seedSummary = seeds.slice(0, 10).map((s, i) =>
    `${i+1}. ${s.name || "Customer"} — ${s.industry || "unknown industry"}` +
    (s.location ? `, ${s.location}` : "") +
    (s.size     ? `, ${s.size}`     : "")
  ).join("\n");

  const prompt = `You are TAKEOVA's Lookalike Customer Generator. The user wants ${count} businesses that look like their best existing customers.

THEIR BEST CUSTOMERS (sample of ${seeds.length}):
${seedSummary}

${region ? `Focus the search on: ${region}\n` : ""}

Generate ${count} candidate businesses that share key attributes with the seeds above.
For each, return:
  - business_name
  - industry (be specific — e.g. "Pilates studio" not "Fitness")
  - size_estimate (e.g. "5-10 staff", "Solo founder", "50+ staff")
  - location (city/region — must be plausible for this business type)
  - why_match (one sentence explaining the lookalike fit)
  - contact_role (likely decision-maker title — "Owner", "Marketing Manager", etc.)
  - confidence (0.0-1.0 — how confident you are this is a real existing business)

OUTPUT STRICT JSON ONLY:
{
  "icp_summary": "1-2 sentences describing the Ideal Customer Profile we're targeting",
  "prospects": [
    { "business_name": "...", "industry": "...", "size_estimate": "...", "location": "...", "why_match": "...", "contact_role": "...", "confidence": 0.0 },
    ...
  ]
}

NO PROSE, NO MARKDOWN FENCES. ONLY VALID JSON.

IMPORTANT: do NOT invent fake-looking contact emails or phone numbers. Leave those blank — they need to be enriched by a B2B data provider separately.`;

  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         apiKey,
        "content-type":      "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 4000,
        messages:   [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: "Claude API error: " + t.slice(0, 200) });
    }
    const data = await r.json();
    const raw  = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const clean = raw.replace(/```json|```/g, "").trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (_) {
      return res.status(502).json({ error: "Could not parse Claude response as JSON", raw: clean.slice(0, 300) });
    }

    const prospects = Array.isArray(parsed.prospects) ? parsed.prospects : [];
    if (!prospects.length) return res.status(502).json({ error: "No prospects generated" });

    // Insert each into DB
    const insertStmt = db.prepare(`
      INSERT INTO lookalike_prospects
        (id, user_id, seed_label, business_name, website, industry, size_estimate,
         location, why_match, contact_name, contact_role, contact_email, contact_phone,
         source, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_generated', ?, 'new')
    `);

    const seedLabel = `Lookalike batch ${new Date().toISOString().slice(0,16)}`;
    const inserted = [];
    for (const p of prospects.slice(0, count)) {
      const pid = uuid();
      insertStmt.run(
        pid, req.userId, seedLabel,
        String(p.business_name || "").slice(0, 200),
        null,
        String(p.industry || "").slice(0, 100),
        String(p.size_estimate || "").slice(0, 50),
        String(p.location || "").slice(0, 100),
        String(p.why_match || "").slice(0, 500),
        null,
        String(p.contact_role || "").slice(0, 100),
        null, null,
        Math.max(0, Math.min(1, Number(p.confidence) || 0.6))
      );
      inserted.push({ id: pid, ...p });
    }

    res.json({
      success: true,
      icp_summary: parsed.icp_summary || "",
      generated: inserted.length,
      prospects: inserted,
    });

    // Track usage after successful generation
    if (typeof global.mineTrackUsage === "function") {
      try { global.mineTrackUsage(db, req.userId, "lookalikeGenerations", 1); } catch (_) {}
    }
  } catch (e) {
    console.error("[lookalike/from-customers]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /prospects — list user's lookalike prospects
// ──────────────────────────────────────────────────────────────────────
router.get("/prospects", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const status = req.query.status;
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

  let rows;
  if (status) {
    rows = db.prepare(
      "SELECT * FROM lookalike_prospects WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
    ).all(req.userId, status, limit);
  } else {
    rows = db.prepare(
      "SELECT * FROM lookalike_prospects WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(req.userId, limit);
  }
  res.json({ prospects: rows });
});

// ──────────────────────────────────────────────────────────────────────
// POST /prospects/:id/queue — queue prospect for AI Cold Email
// ──────────────────────────────────────────────────────────────────────
router.post("/prospects/:id/queue", auth, express.json(), async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const p = db.prepare("SELECT * FROM lookalike_prospects WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: "Prospect not found" });
  if (!p.contact_email) {
    return res.status(400).json({
      error: "Prospect has no verified email. Enrich it first (Apollo, Hunter, etc.) before queueing for outreach.",
      need_enrichment: true,
    });
  }

  // Mark queued — actual outreach happens via the existing AI Cold Email Agent
  db.prepare("UPDATE lookalike_prospects SET status = 'queued', queued_to = 'cold_email', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

  // Insert into contacts so it appears in the user's CRM
  try {
    db.prepare(`INSERT OR IGNORE INTO contacts
      (id, user_id, name, email, phone, company, type, source, tags, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'prospect', 'lookalike',  ?, ?, datetime('now'))`)
      .run(uuid(), req.userId, p.contact_name || p.business_name, p.contact_email, p.contact_phone || null, p.business_name, p.industry || null, p.why_match || null);
  } catch (_) { /* contacts table may not exist on bare deploy */ }

  res.json({ success: true });
});

// ──────────────────────────────────────────────────────────────────────
// POST /prospects/:id/dismiss
// ──────────────────────────────────────────────────────────────────────
router.post("/prospects/:id/dismiss", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("UPDATE lookalike_prospects SET status = 'dismissed', updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

module.exports = router;
