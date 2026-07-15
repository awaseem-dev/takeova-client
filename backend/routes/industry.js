/**
 * industry.js — Industry templates API
 *
 * ENDPOINTS
 *   GET  /api/industry/list             → all industries grouped by category
 *   GET  /api/industry/:key             → full template for one industry
 *   POST /api/industry/apply            → set user's industry, apply defaults
 *
 * USED BY
 *   - Onboarding wizard (industry picker on signup)
 *   - Settings panel (change industry later)
 *   - AI Employee setup (industry-tuned system prompts)
 *   - Site builder (industry-aware defaults)
 */

const express   = require("express");
const router    = express.Router();
const { getDb } = require("../db/init");
const { auth }  = require("../middleware/auth");
const { getIndustry, listIndustries, getCategorized } = require("../data/industry-templates");

function ensureColumn(db) {
  // Lazy-add the industry column to users table
  try { db.exec("ALTER TABLE users ADD COLUMN industry TEXT"); } catch (_) {}
}

// ──────────────────────────────────────────────────────────────────────
// GET /list — every industry grouped by category
// ──────────────────────────────────────────────────────────────────────
router.get("/list", (req, res) => {
  res.json({
    categorized: getCategorized(),
    flat:        listIndustries(),
    total:       listIndustries().length,
  });
});

// ──────────────────────────────────────────────────────────────────────
// GET /:key — full template data
// ──────────────────────────────────────────────────────────────────────
router.get("/:key", (req, res) => {
  const tpl = getIndustry(req.params.key);
  if (!tpl) return res.status(404).json({ error: "Industry not found" });
  res.json({ key: req.params.key, template: tpl });
});

// ──────────────────────────────────────────────────────────────────────
// POST /apply — set user's industry, return what was applied
// Body: { industry: "yoga_studio" }
// ──────────────────────────────────────────────────────────────────────
router.post("/apply", auth, express.json(), (req, res) => {
  const db = getDb();
  ensureColumn(db);

  const key = String(req.body?.industry || "");
  if (!key) return res.status(400).json({ error: "industry key required" });

  const tpl = getIndustry(key);
  if (!tpl) return res.status(404).json({ error: "Industry not found" });

  try {
    db.prepare("UPDATE users SET industry = ?, updated_at = datetime('now') WHERE id = ?").run(key, req.userId);
  } catch (e) {
    console.error("[industry/apply]", e.message);
    return res.status(500).json({ error: "Could not save industry" });
  }

  // Return what gets applied so the UI can show a confirmation summary
  res.json({
    success: true,
    industry: key,
    applied: {
      name: tpl.name,
      icon: tpl.icon,
      recommended_agents: Object.keys(tpl.recommended_agents || {}),
      kpis: tpl.kpis || [],
      automations: tpl.automations || [],
      compliance: tpl.compliance || [],
      site_template: tpl.site_template || {},
      tone: tpl.tone || {},
    },
  });
});

module.exports = router;
