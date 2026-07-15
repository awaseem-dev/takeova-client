// ═══════════════════════════════════════════════════════════════════════════
// Compatibility Routes — bridges between frontend-expected paths and backend
//
// The dashboards call these paths; they didn't have backend handlers before:
//   GET/POST /api/integrations/oauth/:platform/start
//   PUT      /api/outreach/sequences/:id
//   PUT      /api/settings/sender
//
// This module gives them safe handlers that either delegate to existing
// functionality or return reasonable stubs so the UI doesn't 404.
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const { getDb } = require("../db/init");

// ─── /api/integrations/oauth/:platform/start ───────────────────────────────
// Frontend uses this to trigger OAuth flow for Meta, X, LinkedIn, etc.
// We map it to /api/social/:platform/connect which already exists.
router.get("/oauth/:platform/start", auth, (req, res) => {
  const platform = req.params.platform.toLowerCase();
  const aliases = { meta: "facebook", facebook: "facebook", x: "x", twitter: "x", linkedin: "linkedin", tiktok: "tiktok" };
  const target = aliases[platform];
  if (!target) {
    return res.status(404).json({ error: "Unsupported platform: " + platform });
  }
  // Forward as a redirect so the OAuth flow proceeds
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const url = `/api/social/${target}/connect?token=${encodeURIComponent(token)}`;
  res.json({ url, platform: target, redirect: url });
});

// POST flavor (some frontend calls use POST without body)
router.post("/oauth/:platform/start", auth, (req, res) => {
  const platform = req.params.platform.toLowerCase();
  const aliases = { meta: "facebook", facebook: "facebook", x: "x", twitter: "x", linkedin: "linkedin", tiktok: "tiktok" };
  const target = aliases[platform];
  if (!target) return res.status(404).json({ error: "Unsupported platform: " + platform });
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  res.json({ url: `/api/social/${target}/connect?token=${encodeURIComponent(token)}`, platform: target });
});

// ─── /api/outreach/sequences/:id ───────────────────────────────────────────
// Frontend uses this to pause/activate outreach sequences. We don't have a
// formal "sequences" table — we have campaigns. Forward to that.
router.put("/sequences/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { active } = req.body || {};
    // Try to find a campaign with this id; toggle status
    const camp = db.prepare("SELECT * FROM email_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!camp) return res.status(404).json({ error: "Sequence not found" });
    const newStatus = active === false ? "paused" : "active";
    db.prepare("UPDATE email_campaigns SET status = ? WHERE id = ?").run(newStatus, req.params.id);
    res.json({ ok: true, id: req.params.id, status: newStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/sequences", auth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT id, name, status FROM email_campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);
    res.json({ sequences: rows });
  } catch (e) {
    res.json({ sequences: [] });
  }
});

// ─── /api/settings/sender ──────────────────────────────────────────────────
// Frontend uses this to save sender (from-email) preferences.
const settingsRouter = express.Router();

settingsRouter.put("/sender", auth, (req, res) => {
  try {
    const db = getDb();
    const { fromName, fromEmail, replyTo, signature } = req.body || {};
    // Store in user_preferences (or settings) table — flexible JSON column
    db.exec(`CREATE TABLE IF NOT EXISTS sender_settings (
      user_id TEXT PRIMARY KEY,
      from_name TEXT,
      from_email TEXT,
      reply_to TEXT,
      signature TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const exists = db.prepare("SELECT 1 FROM sender_settings WHERE user_id = ?").get(req.userId);
    if (exists) {
      db.prepare(`UPDATE sender_settings SET from_name=?, from_email=?, reply_to=?, signature=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
        .run(fromName || "", fromEmail || "", replyTo || "", signature || "", req.userId);
    } else {
      db.prepare(`INSERT INTO sender_settings (user_id, from_name, from_email, reply_to, signature) VALUES (?, ?, ?, ?, ?)`)
        .run(req.userId, fromName || "", fromEmail || "", replyTo || "", signature || "");
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

settingsRouter.get("/sender", auth, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT from_name, from_email, reply_to, signature FROM sender_settings WHERE user_id = ?").get(req.userId);
    res.json(row || { from_name: "", from_email: "", reply_to: "", signature: "" });
  } catch (e) {
    res.json({ from_name: "", from_email: "", reply_to: "", signature: "" });
  }
});

module.exports = { router, settingsRouter };
