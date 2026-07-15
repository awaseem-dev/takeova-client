/**
 * ai-employees-plus.js — Backend routes for advanced AI employee features.
 *
 * Mount in server.js BEFORE the stubs.js catch-all:
 *   app.use("/api/ai-employees", require("./routes/ai-employees-plus"));
 *
 * ENDPOINTS
 *   GET  /api/ai-employees/pipeline       → Cross-agent funnel counts
 *   GET  /api/ai-employees/:id/overview   → ROI + digest combined
 *   POST /api/ai-employees/:id/chat       → Ask the agent a question
 */

const express   = require("express");
const router    = express.Router();
const { getDb } = require("../db/init");
const { auth }  = require("../middleware/auth");
const { isAdmin } = require("../utils/admin-check");
const { identityFor, publicRoster } = require("../employee-identity");

// Agent system prompts — short, role-specific, tone-matched.
// NOTE: identity + persona now live in ../employee-identity.js (single source of
// truth, shared with Take Control). This map is kept only as a legacy fallback.
const AGENT_SYSTEM_PROMPTS = {
  socialmanager:   "You are the user's AI Social Manager. You schedule posts, write captions in their voice, and reply to comments. Keep replies concise and brand-aligned.",
  receptionist:    "You are the user's AI Receptionist. You answer questions, route messages, and book appointments. Be warm and professional.",
  salesrep:        "You are the user's AI Sales Rep. You qualify leads, send follow-ups, and book demos. Be confident and consultative — never pushy.",
  supportagent:    "You are the user's AI Support Agent. You resolve issues, draft refund responses, and escalate intelligently. Be empathetic and brief.",
  bookkeeper:      "You are the user's AI Bookkeeper. You categorise expenses, reconcile transactions, and flag anomalies. Be precise and conservative.",
  marketing:       "You are the user's AI Marketing Manager. You design campaigns, optimise ads, and write copy. Be data-driven.",
  coldemail:       "You are the user's AI Cold Email Agent. You write personalised outreach in their voice, suggest sequences, and analyse reply rates.",
  prospector:      "You are the user's AI Prospector. You research businesses, find decision-makers, and qualify fit.",
  proposal:        "You are the user's AI Proposal Agent. You draft tailored proposals with pricing, scope, and timeline.",
  growth:          "You are the user's AI Growth Agent. You suggest experiments, monitor metrics, and recommend next moves. Be specific and prioritised.",
  community:       "You are the user's AI Community Engagement agent. You reply to mentions, comments, and reviews in the user's voice.",
  customersuccess: "You are the user's AI Customer Success agent. You spot at-risk customers and craft win-back messages. Be genuine.",
  legal:           "You are the user's AI Legal Employee. You draft contracts, NDAs, and policies. Always flag clauses requiring human review. You are NOT a lawyer.",
  browser_agent:   "You are the user's AI Browser Agent assistant. You explain Browser Agent capabilities, plan tasks, and clarify safety boundaries.",
};

// ──────────────────────────────────────────────────────────────
// GET /identities — name + avatar + title for every AI employee
// (single source of truth; the dashboard can render from this)
// ──────────────────────────────────────────────────────────────
router.get("/identities", (req, res) => {
  try { res.json({ employees: publicRoster() }); }
  catch (_) { res.json({ employees: [] }); }
});

// ──────────────────────────────────────────────────────────────
// GET /:id/overview — ROI + digest for the agent detail view
// ──────────────────────────────────────────────────────────────
router.get("/:id/overview", auth, async (req, res) => {
  const empId = req.params.id;
  const db = getDb();

  try {
    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);
    const periodIso = periodStart.toISOString();

    // Lazy-create the table — resilient on first deploy.
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS agent_actions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action_type TEXT,
        summary TEXT,
        earned_amount REAL DEFAULT 0,
        saved_amount REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        metadata TEXT
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_actions_user_agent
               ON agent_actions(user_id, agent_id, created_at)`);
    } catch (_) {}

    const roiRow = db.prepare(`
      SELECT
        COALESCE(SUM(earned_amount), 0) AS earned,
        COALESCE(SUM(saved_amount),   0) AS saved,
        COUNT(*)                        AS actions
      FROM agent_actions
      WHERE user_id = ? AND agent_id = ? AND created_at >= ?
    `).get(req.userId, empId, periodIso) || { earned: 0, saved: 0, actions: 0 };

    const recent = db.prepare(`
      SELECT summary, created_at
      FROM agent_actions
      WHERE user_id = ? AND agent_id = ?
        AND created_at >= datetime('now', '-1 day')
      ORDER BY created_at DESC
      LIMIT 5
    `).all(req.userId, empId);

    const digest = recent.length
      ? recent.map(r => r.summary).filter(Boolean)
      : ["Agent is connected and monitoring.", "No actions logged in the last 24 hours."];

    const last = db.prepare(`
      SELECT created_at FROM agent_actions
      WHERE user_id = ? AND agent_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(req.userId, empId);

    res.json({
      roi: {
        earned:  Number(roiRow.earned)  || 0,
        saved:   Number(roiRow.saved)   || 0,
        actions: Number(roiRow.actions) || 0,
      },
      digest,
      last_run: last?.created_at || null,
    });
  } catch (e) {
    console.error("[ai-employees-plus][overview]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /:id/chat — conversational interface per agent
// ──────────────────────────────────────────────────────────────
router.post("/:id/chat", auth, express.json(), async (req, res) => {
  const empId   = req.params.id;
  const message = String(req.body?.message || "").trim();
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  if (!message) return res.status(400).json({ error: "message required" });

  const db = getDb();

  try {
    // Pull API key from platform settings or env
    let apiKey = process.env.ANTHROPIC_API_KEY;
    try {
      const setting = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("ANTHROPIC_API_KEY");
      if (setting?.value) apiKey = setting.value;
    } catch (_) {}

    if (!apiKey) {
      return res.json({
        reply: "Set ANTHROPIC_API_KEY in admin → API Keys to enable live agent conversations.",
        actions_suggested: [],
      });
    }

    // Pull business context for the agent
    const u = db.prepare("SELECT name, business_name, business_type FROM users WHERE id = ?").get(req.userId) || {};
    const businessContext = [
      u.name          ? `User: ${u.name}`            : null,
      u.business_name ? `Business: ${u.business_name}` : null,
      u.business_type ? `Type: ${u.business_type}`   : null,
    ].filter(Boolean).join("\n") || "No business context provided yet.";

    const who = identityFor(empId); // resolves roster ids + legacy keys to one persona
    const systemPrompt =
      who.persona +
      `\n\nYou are speaking directly with the business owner in their dashboard. Stay in character as ${who.name}. ` +
      "Refer to yourself by name when it's natural; don't break character or mention being a language model." +
      "\n\nBusiness context:\n" + businessContext +
      "\n\nKeep responses under 200 words unless the user asks for detail.";

    const messages = history
      .filter(m => m && m.role && m.content)
      .slice(-6)
      .concat([{ role: "user", content: message }]);

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
        max_tokens: 500,
        system:     systemPrompt,
        messages,
      }),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[ai-employees-plus][chat] Anthropic error:", text.slice(0, 200));
      return res.status(502).json({ error: "Agent unavailable. Try again in a moment." });
    }

    const data = await r.json();
    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

    // Log conversation as an action so overview ROI/digest reflects it
    try {
      const { v4: uuid } = require("uuid");
      db.prepare(`
        INSERT INTO agent_actions (id, user_id, agent_id, action_type, summary)
        VALUES (?, ?, ?, 'chat', ?)
      `).run(uuid(), req.userId, empId, message.slice(0, 120));
    } catch (_) {}

    res.json({
      reply: reply || "(no response)",
      actions_suggested: [],
    });
  } catch (e) {
    console.error("[ai-employees-plus][chat]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /pipeline — cross-agent funnel counts
// ──────────────────────────────────────────────────────────────
router.get("/pipeline", auth, async (req, res) => {
  const db = getDb();
  const userId = req.userId;
  const isAdminUser = isAdmin(db, userId);

  // Admin sees platform-wide; users see their own scope.
  const userPredicate = isAdminUser ? "1=1" : "user_id = ?";
  const userParams    = isAdminUser ? []    : [userId];

  function safeCount(table, where = "") {
    try {
      const full = where ? `${userPredicate} AND ${where}` : userPredicate;
      const sql = `SELECT COUNT(*) AS c FROM ${table} WHERE ${full}`;
      return db.prepare(sql).get(...userParams)?.c || 0;
    } catch (_) {
      return 0; // table not present yet on this deployment
    }
  }

  const stages = [
    {
      id:    "prospector",
      name:  "Prospected",
      count: safeCount("contacts", "(type = 'prospect' OR source = 'prospector')"),
    },
    {
      id:    "coldemail",
      name:  "Emailed",
      count: safeCount("outreach_messages", "channel = 'email' AND status IN ('sent','delivered','opened','replied')"),
    },
    {
      id:    "sales",
      name:  "In pipeline",
      count: safeCount("leads", "status IN ('qualified','engaged','negotiating')"),
    },
    {
      id:    "proposal",
      name:  "Proposed",
      count: safeCount("proposals", "status IN ('sent','viewed','awaiting')"),
    },
  ];

  res.json({ stages });
});

module.exports = router;
