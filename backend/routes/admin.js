const express = require("express");
const { getDb } = require("../db/init");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();


// All admin routes require auth + admin role
function planCap(plan, key, fallback) {
  try { const C = require("./features").PLAN_CAPS || {}; const p = C[plan] || null; if (p && p[key] != null) return p[key]; } catch (_) {}
  return fallback;
}

router.use(auth, adminOnly);

// ─── ALL USERS ───
router.get("/users", (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const users = db.prepare("SELECT id, email, name, role, plan, xp, streak, join_date, referral_code, emails_sent, edits_used, stripe_customer_id, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    const total = db.prepare("SELECT COUNT(*) as c FROM users").get()?.c || 0;
    res.json({ users, total, limit, offset });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

//  ALL SITES (platform-wide, with owner) 
router.get("/sites", (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);
    const sites = db.prepare("SELECT s.id, s.name, s.domain, s.status, s.created_at, s.user_id, u.email AS owner_email, u.name AS owner_name, u.plan AS owner_plan FROM sites s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC LIMIT ?").all(limit);
    const total = db.prepare("SELECT COUNT(*) as c FROM sites").get()?.c || 0;
    res.json({ sites, total });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── BAN/UNBAN USER ───
router.post("/users/:id/ban", (req, res) => {
  try {
    const db = getDb();
    // Set both columns so all downstream checks agree.
    // account_status is the canonical field; role='banned' is kept for
    // backward compatibility with older code paths.
    try { db.exec("ALTER TABLE users ADD COLUMN account_status TEXT"); } catch(e) {}
    db.prepare("UPDATE users SET role = 'banned', account_status = 'banned' WHERE id = ?").run(req.params.id);
    // Kill all active sessions immediately — don't wait for 30-day expiry
    try { db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.params.id); } catch(e) { console.error("[/:id/ban]", e.message || e); }
    // Audit log — admin actions on user accounts are sensitive
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "admin_banned_user", JSON.stringify({ targetUserId: req.params.id, reason: req.body?.reason || "" }));
    } catch(e) {}
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

router.post("/users/:id/unban", (req, res) => {
  try {
    const db = getDb();
    try { db.exec("ALTER TABLE users ADD COLUMN account_status TEXT"); } catch(e) {}
    db.prepare("UPDATE users SET role = 'user', account_status = 'active' WHERE id = ?").run(req.params.id);
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "admin_unbanned_user", JSON.stringify({ targetUserId: req.params.id }));
    } catch(e) {}
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── UPDATE USER PLAN (manual override) ───
router.patch("/users/:id/plan", (req, res) => {
  try {
    const db = getDb();
    const { plan } = req.body;
    // Whitelist — don't let an admin typo persist an unknown plan name
    const VALID_PLANS = ["starter","growth","pro","enterprise","agency","agency_client","trial"];
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}` });
    }
    // Change 16: email_limit derives from PLAN_CAPS on plan change
    const before = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.params.id);
    db.prepare("UPDATE users SET plan = ?, email_limit = ? WHERE id = ?").run(plan, planCap(plan, "emails", 500), req.params.id);
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "admin_plan_override", JSON.stringify({ targetUserId: req.params.id, from: before?.plan || null, to: plan }));
    } catch(e) {}
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── ADMIN USAGE MANAGEMENT (Gap 5 fix) ──────────────────────────────────
// GET   /admin/users/:id/usage           → see current usage for a user
// POST  /admin/users/:id/usage/reset     → reset a metric to 0 (refund-style)
// POST  /admin/users/:id/usage/credit    → grant N free units (negative usage)
// POST  /admin/users/:id/consent/clear   → clear overage consent for a metric

function currentPeriod() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

router.get("/users/:id/usage", (req, res) => {
  try {
    const db = getDb();
    const period = req.query.period || currentPeriod();
    const rows = db.prepare(
      "SELECT metric, amount FROM usage_tracking WHERE user_id = ? AND period = ? ORDER BY amount DESC"
    ).all(req.params.id, period);
    const charges = (function() {
      try {
        return db.prepare(
          "SELECT metric, SUM(total) as total, SUM(quantity) as qty FROM overage_charges WHERE user_id = ? AND period = ? GROUP BY metric"
        ).all(req.params.id, period);
      } catch(_) { return []; }
    })();
    const consents = (function() {
      try {
        return db.prepare(
          "SELECT metric, consented_at, overage_rate FROM feature_overage_consent WHERE user_id = ? AND period = ?"
        ).all(req.params.id, period);
      } catch(_) { return []; }
    })();
    const user = db.prepare("SELECT id, email, plan FROM users WHERE id = ?").get(req.params.id);
    res.json({ user, period, usage: rows, overageCharges: charges, consents });
  } catch(e) {
    console.error("[admin/usage] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/users/:id/usage/reset", (req, res) => {
  try {
    const db = getDb();
    const { metric, reason } = req.body || {};
    if (!metric) return res.status(400).json({ error: "metric required" });
    const period = req.body.period || currentPeriod();
    const before = db.prepare(
      "SELECT amount FROM usage_tracking WHERE user_id = ? AND metric = ? AND period = ?"
    ).get(req.params.id, metric, period);
    db.prepare(
      "DELETE FROM usage_tracking WHERE user_id = ? AND metric = ? AND period = ?"
    ).run(req.params.id, metric, period);
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "admin_usage_reset",
             JSON.stringify({ targetUserId: req.params.id, metric, period, previousAmount: before?.amount || 0, reason: reason || null }));
    } catch(_) {}
    res.json({ ok: true, metric, period, resetFrom: before?.amount || 0 });
  } catch(e) {
    console.error("[admin/usage/reset] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/users/:id/usage/credit", (req, res) => {
  try {
    const db = getDb();
    const { metric, units, reason } = req.body || {};
    if (!metric) return res.status(400).json({ error: "metric required" });
    const n = parseInt(units, 10);
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "units must be a positive integer" });
    const period = req.body.period || currentPeriod();
    // Granting credit = subtract from usage (down to floor 0)
    const before = db.prepare(
      "SELECT amount FROM usage_tracking WHERE user_id = ? AND metric = ? AND period = ?"
    ).get(req.params.id, metric, period);
    const newAmount = Math.max(0, (before?.amount || 0) - n);
    if (before) {
      db.prepare(
        "UPDATE usage_tracking SET amount = ? WHERE user_id = ? AND metric = ? AND period = ?"
      ).run(newAmount, req.params.id, metric, period);
    }
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "admin_usage_credit",
             JSON.stringify({ targetUserId: req.params.id, metric, period, units: n, previousAmount: before?.amount || 0, newAmount, reason: reason || null }));
    } catch(_) {}
    res.json({ ok: true, metric, period, previousAmount: before?.amount || 0, newAmount, credited: n });
  } catch(e) {
    console.error("[admin/usage/credit] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/users/:id/consent/clear", (req, res) => {
  try {
    const db = getDb();
    const { metric } = req.body || {};
    if (!metric) return res.status(400).json({ error: "metric required" });
    const period = req.body.period || currentPeriod();
    try {
      db.prepare(
        "DELETE FROM feature_overage_consent WHERE user_id = ? AND metric = ? AND period = ?"
      ).run(req.params.id, metric, period);
    } catch(_) { /* table may not exist yet */ }
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "admin_consent_clear", JSON.stringify({ targetUserId: req.params.id, metric, period }));
    } catch(_) {}
    res.json({ ok: true, metric, period });
  } catch(e) {
    console.error("[admin/consent/clear] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ─── PLATFORM STATS ───
router.get("/stats", (req, res) => {
  try {
    const db = getDb();
    const totalUsers    = db.prepare("SELECT COUNT(*) as c FROM users").get().c || 0;
    const planRows      = db.prepare("SELECT plan, COUNT(*) as count FROM users GROUP BY plan").all();
    const planBreakdown = {};
    planRows.forEach(r => planBreakdown[r.plan||'free'] = r.count);

    // Revenue — sum from orders table
    const rev30d = db.prepare("SELECT COALESCE(SUM(total_amount),0) as r FROM orders WHERE datetime(created_at)>datetime('now','-30 days')").get()?.r || 0;
    const revPrev30d = db.prepare("SELECT COALESCE(SUM(total_amount),0) as r FROM orders WHERE datetime(created_at) BETWEEN datetime('now','-60 days') AND datetime('now','-30 days')").get()?.r || 0;
    const momGrowth = revPrev30d > 0 ? Math.round((rev30d - revPrev30d)/revPrev30d*100) : 0;

    // MRR — approximate from subscriptions or paid users x avg plan price
    const proUsers   = planBreakdown['pro'] || 0;
    const entUsers   = planBreakdown['enterprise'] || 0;
    const mrr        = proUsers * 97 + entUsers * 297; // approximate

    // Videos
    const videosThisMonth = db.prepare("SELECT COUNT(*) as c FROM short_form_videos WHERE datetime(created_at)>datetime('now','-30 days')").get()?.c || 0;
    const videoRevenue30d = db.prepare("SELECT COALESCE(SUM(charged_amount),0) as r FROM ai_employee_actions WHERE action='generate_video' AND datetime(created_at)>datetime('now','-30 days')").get()?.r || 0;
    const apiSpend30d = Math.round(videoRevenue30d / 4); // 4x markup, reverse to get cost

    // New users
    const newUsersThisWeek = db.prepare("SELECT COUNT(*) as c FROM users WHERE datetime(created_at)>datetime('now','-7 days')").get()?.c || 0;

    // Gross margin
    const grossMargin = rev30d > 0 ? Math.round((rev30d - apiSpend30d) / rev30d * 100) : 0;

    res.json({
      totalUsers, planBreakdown, mrr, mrrDelta: momGrowth,
      videoRevenue30d, videosThisMonth, apiSpend30d, grossMargin,
      rev30d, newUsersThisWeek
    });
  } catch(e) {
    console.error("[admin /stats]", e?.message);
    res.status(500).json({ error: "Stats error: " + e.message });
  }
});

// ─── AUDIT LOG ───
router.get("/audit-log", (req, res) => {
  try {
    const db = getDb();
    const logs = db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100").all();
    res.json({ logs });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── SAVE PLATFORM KEYS ───
router.post("/platform-keys", auth, adminOnly, (req, res) => {
  try {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime(\'now\')))");
    const keys = req.body;
    const upsert = db.prepare("INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))");
    let saved = 0;
    for (const [k, v] of Object.entries(keys)) {
      const val = String(v || "").trim();
      // Skip [SET] sentinel — frontend echoes this back when displaying masked keys; never write it to DB
      if (val && val !== "[SET]") { upsert.run(k, val); saved++; }
    }
    res.json({ success: true, saved });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── GET PLATFORM SETTINGS (admin) ───
router.get("/settings", (req, res) => {
  const db = getDb();
  // Secret key names — return masked values so UI can show ✓/— without leaking keys over the wire
  const SECRET_KEYS = new Set([
    "STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET","SENDGRID_API_KEY","ANTHROPIC_API_KEY",
    "TWILIO_AUTH_TOKEN","META_APP_SECRET","X_API_SECRET","LINKEDIN_CLIENT_SECRET",
    "TIKTOK_CLIENT_SECRET","YOUTUBE_CLIENT_SECRET","SMTP_PASS","JWT_SECRET",
    "INTERNAL_API_KEY","CRON_SECRET","CLOUDFLARE_API_TOKEN",
    "RUNWAY_API_KEY","PERPLEXITY_API_KEY","NANOBANANA_API_KEY",
    "GOOGLE_CLIENT_SECRET","APPLE_CLIENT_SECRET","FCM_SERVER_KEY","AWS_SECRET_ACCESS_KEY",
    "GOOGLE_PLACES_API_KEY",
    "MS_CLIENT_SECRET",
    "FACEBOOK_APP_SECRET","TWITTER_CLIENT_SECRET","XERO_CLIENT_SECRET",
  ]);
  try {
    const rows = db.prepare("SELECT key, value FROM platform_settings").all();
    const settings = {};
    for (const r of rows) {
      // Return "[SET]" for secrets so the UI can show ✓ without exposing the value
      settings[r.key] = SECRET_KEYS.has(r.key) ? (r.value ? "[SET]" : "") : r.value;
    }
    res.json({ settings });
  } catch(e) { res.json({ settings: {} }); }
});

// ═══════════════════════════════════════════════════
// MINE'S OWN LEAD MAGNETS (admin only)
// ═══════════════════════════════════════════════════

router.get("/mine-lead-magnets", (req, res) => {
  try {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS mine_lead_magnets (id TEXT PRIMARY KEY, name TEXT, description TEXT, resource_url TEXT, headline TEXT, subheadline TEXT, downloads INTEGER DEFAULT 0, emails_captured INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))");
    res.json({ magnets: db.prepare("SELECT * FROM mine_lead_magnets ORDER BY created_at DESC").all() });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

router.post("/mine-lead-magnets", (req, res) => {
  try {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS mine_lead_magnets (id TEXT PRIMARY KEY, name TEXT, description TEXT, resource_url TEXT, headline TEXT, subheadline TEXT, downloads INTEGER DEFAULT 0, emails_captured INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))");
    const { name, description, resource_url, headline, subheadline } = req.body;
    const id = require("uuid").v4();
    db.prepare("INSERT INTO mine_lead_magnets (id, name, description, resource_url, headline, subheadline) VALUES (?,?,?,?,?,?)")
      .run(id, name, description || "", resource_url, headline || name, subheadline || "");
    res.json({ success: true, id });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

router.delete("/mine-lead-magnets/:id", (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM mine_lead_magnets WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

router.get("/mine-leads", (req, res) => {
  try {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS mine_leads (id TEXT PRIMARY KEY, magnet_id TEXT, email TEXT, name TEXT, source TEXT, created_at TEXT DEFAULT (datetime('now')))");
    const { magnetId } = req.query;
    const leads = magnetId
      ? db.prepare("SELECT * FROM mine_leads WHERE magnet_id = ? ORDER BY created_at DESC").all(magnetId)
      : db.prepare("SELECT * FROM mine_leads ORDER BY created_at DESC LIMIT 500").all();
    res.json({ leads });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════════════════
// MINE'S OWN SOCIAL LEAD MAGNETS (same system as users)
// Detects trigger words on TAKEOVA's social posts → auto-replies
// ═══════════════════════════════════════════════════

router.get("/mine-social-magnets", (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS mine_social_magnets (
      id TEXT PRIMARY KEY, name TEXT, resource_url TEXT, gated_page_url TEXT,
      trigger_words TEXT DEFAULT '["LINK","FREE","SEND","ME","WANT","HOW","GUIDE","TRY","DEMO","START"]',
      trigger_on TEXT DEFAULT '["comment","dm"]',
      reply_message TEXT DEFAULT 'Here you go! 🎉 {{link}}',
      dm_message TEXT DEFAULT 'Hey {{name}}! Here''s what you requested: {{link}} — Start your free trial at takeova.ai!',
      platforms TEXT DEFAULT '["instagram","facebook","tiktok","x","linkedin","youtube"]',
      post_ids TEXT DEFAULT '[]',
      capture_email INTEGER DEFAULT 1,
      follow_up_enabled INTEGER DEFAULT 1,
      follow_up_subject TEXT DEFAULT 'Here''s the resource you requested + a free trial of MINE',
      follow_up_body TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      engagements INTEGER DEFAULT 0, captures INTEGER DEFAULT 0, signups INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    res.json({ magnets: db.prepare("SELECT * FROM mine_social_magnets ORDER BY created_at DESC").all() });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

router.post("/mine-social-magnets", (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS mine_social_magnets (
      id TEXT PRIMARY KEY, name TEXT, resource_url TEXT, gated_page_url TEXT,
      trigger_words TEXT DEFAULT '["LINK","FREE","SEND","ME","WANT","HOW","GUIDE","TRY","DEMO","START"]',
      trigger_on TEXT DEFAULT '["comment","dm"]',
      reply_message TEXT DEFAULT 'Here you go! 🎉 {{link}}',
      dm_message TEXT DEFAULT 'Hey {{name}}! Here''s what you requested: {{link}}',
      platforms TEXT DEFAULT '["instagram","facebook","tiktok","x","linkedin","youtube"]',
      post_ids TEXT DEFAULT '[]',
      capture_email INTEGER DEFAULT 1,
      follow_up_enabled INTEGER DEFAULT 1,
      follow_up_subject TEXT DEFAULT 'Here''s the resource you requested',
      follow_up_body TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      engagements INTEGER DEFAULT 0, captures INTEGER DEFAULT 0, signups INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const { name, resource_url, trigger_words, trigger_on, reply_message, dm_message, platforms, post_ids, capture_email, follow_up_enabled, follow_up_subject } = req.body;
    const id = require("uuid").v4();

    // Auto-generate gated landing page URL (uses the lead magnet page we already built)
    const lmPageId = require("uuid").v4();
    db.exec("CREATE TABLE IF NOT EXISTS mine_lead_magnets (id TEXT PRIMARY KEY, name TEXT, description TEXT, resource_url TEXT, headline TEXT, subheadline TEXT, downloads INTEGER DEFAULT 0, emails_captured INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO mine_lead_magnets (id, name, description, resource_url, headline, subheadline) VALUES (?,?,?,?,?,?)")
      .run(lmPageId, name || "MINE Free Resource", "Auto-created for social lead magnet", resource_url || "", name || "Free Resource from MINE", "Enter your email to get instant access");

    const gatedUrl = `${process.env.BACKEND_URL || "http://localhost:4000"}/api/public/mine-lead-magnet/${lmPageId}`;

    db.prepare(`INSERT INTO mine_social_magnets (id, name, resource_url, gated_page_url, trigger_words, trigger_on, reply_message, dm_message, platforms, post_ids, capture_email, follow_up_enabled, follow_up_subject) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name || "MINE Lead Magnet", resource_url || "", gatedUrl,
        JSON.stringify(trigger_words || ["LINK","FREE","SEND","ME","WANT","HOW","GUIDE","TRY","DEMO","START"]),
        JSON.stringify(trigger_on || ["comment","dm"]),
        reply_message || "Here you go! 🎉 {{link}}",
        dm_message || "Hey {{name}}! Here's what you requested: {{link}} — Start your free trial at takeova.ai!",
        JSON.stringify(platforms || ["instagram","facebook","tiktok","x","linkedin","youtube"]),
        JSON.stringify(post_ids || []),
        capture_email ? 1 : 0,
        follow_up_enabled ? 1 : 0,
        follow_up_subject || "Here's the resource you requested");

    res.json({ success: true, id, gatedUrl });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

router.put("/mine-social-magnets/:id", (req, res) => {
  try {
    const db = getDb();
    const { name, resource_url, trigger_words, reply_message, dm_message, platforms, post_ids, active } = req.body;
    db.prepare("UPDATE mine_social_magnets SET name=?, resource_url=?, trigger_words=?, reply_message=?, dm_message=?, platforms=?, post_ids=?, active=? WHERE id=?")
      .run(name, resource_url, JSON.stringify(trigger_words || []), reply_message, dm_message, JSON.stringify(platforms || []), JSON.stringify(post_ids || []), active ?? 1, req.params.id);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

router.delete("/mine-social-magnets/:id", (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM mine_social_magnets WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// Stats for TAKEOVA's social magnets
router.get("/mine-social-magnets/:id/stats", (req, res) => {
  try {
    const db = getDb();
    const magnet = db.prepare("SELECT * FROM mine_social_magnets WHERE id = ?").get(req.params.id);
    if (!magnet) return res.status(404).json({ error: "Not found" });

    db.exec("CREATE TABLE IF NOT EXISTS mine_leads (id TEXT PRIMARY KEY, magnet_id TEXT, email TEXT, name TEXT, source TEXT, created_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS mine_social_engagements (id TEXT PRIMARY KEY, magnet_id TEXT, platform TEXT, username TEXT, comment_text TEXT, action_taken TEXT, created_at TEXT DEFAULT (datetime('now')))");

    const leads = db.prepare("SELECT * FROM mine_leads WHERE magnet_id = ? ORDER BY created_at DESC LIMIT 50").all(magnet.gated_page_url?.split("/").pop() || req.params.id);
    const engagements = db.prepare("SELECT * FROM mine_social_engagements WHERE magnet_id = ? ORDER BY created_at DESC LIMIT 50").all(req.params.id);

    res.json({ magnet, leads, engagements });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET /api/admin/runway-usage — monitor all Runway video generation
// (router.use(auth, adminOnly) above already gates this — no need for extra check)
router.get("/runway-usage", (req, res) => {
  try {
    const db = getDb();

    const { days = 30, user_id } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));

    let query = `
      SELECT r.*, u.email, u.business_name
      FROM runway_video_log r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.created_at >= ?
    `;
    const params = [since.toISOString()];
    if (user_id) { query += " AND r.user_id = ?"; params.push(user_id); }
    query += " ORDER BY r.created_at DESC LIMIT 200";

    const logs = db.prepare(query).all(...params);

    const summary = {
      total_videos: logs.length,
      total_charged_cents: logs.filter(l => l.status !== "failed").reduce((s, l) => s + (l.amount_charged || 0), 0),
      total_seconds: logs.filter(l => l.status !== "failed").reduce((s, l) => s + (l.duration_requested || 10), 0),
      by_status: {
        processing: logs.filter(l => l.status === "processing").length,
        completed: logs.filter(l => l.status === "completed").length,
        failed: logs.filter(l => l.status === "failed").length,
        pending: logs.filter(l => l.status === "pending").length,
      },
      by_source: logs.reduce((acc, l) => {
        const src = l.provider || "runway";
        acc[src] = (acc[src] || 0) + 1;
        return acc;
      }, {}),
      top_users: Object.entries(
        logs.reduce((acc, l) => { acc[l.email || l.user_id] = (acc[l.email || l.user_id] || 0) + 1; return acc; }, {})
      ).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([email, count]) => ({ email, count }))
    };

    res.json({ summary, logs });
  } catch(e) { console.error("[admin runway-usage]", e.message); res.status(500).json({ error: "Internal error" }); }
});

router.get("/teams", auth, adminOnly, (req,res)=>{ try{
  const db=getDb();
  db.exec("CREATE TABLE IF NOT EXISTS team_members (id TEXT PRIMARY KEY, owner_user_id TEXT, member_user_id TEXT, email TEXT, name TEXT, role TEXT DEFAULT 'editor', status TEXT DEFAULT 'invited', invite_token TEXT, created_at TEXT DEFAULT (datetime('now')), accepted_at TEXT)");
  const rows=db.prepare("SELECT t.id, t.email AS member_email, t.role, t.status, t.created_at, t.accepted_at, o.email AS owner_email, o.name AS owner_name FROM team_members t JOIN users o ON o.id=t.owner_user_id ORDER BY t.created_at DESC LIMIT 200").all();
  res.json({ teams: rows, total: rows.length });
}catch(e){ res.status(500).json({error:"Failed to load teams"}); }});

module.exports = router;


// ─── PLATFORM SETTINGS / API KEYS ───────────────────────────────────────────
// Agency owner saves platform-level API keys (stored in DB, read by getSetting())
router.post("/settings/keys", (req, res) => {
  try {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))");
    const allowed = [
      'ANTHROPIC_API_KEY','HEYGEN_API_KEY','RUNWAY_API_KEY','KLING_API_KEY','STRIPE_SECRET_KEY',
      'STRIPE_PUBLISHABLE_KEY','STRIPE_WEBHOOK_SECRET','NANOBANANA_API_KEY','SENDGRID_API_KEY','FROM_EMAIL',
      // New: image/video providers + storage
      'GEMINI_API_KEY','OPENAI_API_KEY','HF_API_KEY','HF_API_SECRET',
      'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_S3_BUCKET','AWS_REGION','AWS_S3_ENDPOINT','AWS_CLOUDFRONT_URL',
      'GEMINI_API_KEY','OPENAI_API_KEY','HF_API_KEY','HF_API_SECRET',
      'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_S3_BUCKET','AWS_REGION','AWS_S3_ENDPOINT','AWS_CLOUDFRONT_URL',
      'EMAIL_FROM','LEAD_NOTIFICATION_EMAIL','ADMIN_EMAIL','ADMIN_KEY',
      'FACEBOOK_APP_ID','FACEBOOK_APP_SECRET','TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET',
      'LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET','TWITTER_CLIENT_ID','TWITTER_CLIENT_SECRET',
      'XERO_CLIENT_ID','XERO_CLIENT_SECRET','QB_CLIENT_ID','QB_CLIENT_SECRET',
      'WHATSAPP_BUSINESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_VERIFY_TOKEN',
      'TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER',
      'FRONTEND_URL','BACKEND_URL',
    ];
    const saved = [];
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!allowed.includes(key) || !value) continue;
      db.prepare("INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES (?,?,datetime('now'))").run(key, value);
      saved.push(key);
    }
    res.json({ success: true, saved });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/settings/keys", (req, res) => {
  try {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))");
    const rows = db.prepare("SELECT key, value FROM platform_settings").all();

    const allKeys = [
      'ANTHROPIC_API_KEY','HEYGEN_API_KEY','RUNWAY_API_KEY','KLING_API_KEY','STRIPE_SECRET_KEY',
      'STRIPE_PUBLISHABLE_KEY','STRIPE_WEBHOOK_SECRET','NANOBANANA_API_KEY','SENDGRID_API_KEY','FROM_EMAIL',
      // New: image/video providers + storage
      'GEMINI_API_KEY','OPENAI_API_KEY','HF_API_KEY','HF_API_SECRET',
      'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_S3_BUCKET','AWS_REGION','AWS_S3_ENDPOINT','AWS_CLOUDFRONT_URL',
      'EMAIL_FROM','LEAD_NOTIFICATION_EMAIL','ADMIN_EMAIL','ADMIN_KEY',
      'FACEBOOK_APP_ID','FACEBOOK_APP_SECRET','TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET',
      'LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET','TWITTER_CLIENT_ID','TWITTER_CLIENT_SECRET',
      'XERO_CLIENT_ID','XERO_CLIENT_SECRET','QB_CLIENT_ID','QB_CLIENT_SECRET',
      'WHATSAPP_BUSINESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_VERIFY_TOKEN',
      'TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER',
      'FRONTEND_URL','BACKEND_URL',
    ];

    // DB values take priority over env vars
    const dbMap = {};
    for (const r of rows) { dbMap[r.key] = r.value; }

    const masked = {};
    for (const key of allKeys) {
      const val = dbMap[key] || process.env[key] || '';
      // Return masked value: first 6 chars + '...' so UI knows it's set
      masked[key] = val ? val.substring(0, 6) + '...' : '';
    }

    res.json({ settings: masked });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// API KEY CONNECTION TESTING
// Lets admin verify keys actually work by hitting each provider's API.
// Returns { ok: true } or { ok: false, error: "actual provider message" }
// ═══════════════════════════════════════════════════════════════════════════

router.post("/test-api-key", async (req, res) => {
  const { provider } = req.body || {};
  if (!provider) return res.status(400).json({ ok: false, error: "provider required" });

  function getKey(name) {
    try {
      const db = getDb();
      const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(name);
      return row?.value || process.env[name] || null;
    } catch(_) { return process.env[name] || null; }
  }

  try {
    switch (provider) {
      case "gemini": {
        const key = getKey("GEMINI_API_KEY");
        if (!key) return res.json({ ok: false, error: "GEMINI_API_KEY not set" });
        // Minimal test: list models endpoint (free, no charge)
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        if (r.ok) return res.json({ ok: true, message: "Gemini API key valid" });
        const d = await r.json().catch(() => ({}));
        return res.json({ ok: false, error: d?.error?.message || `HTTP ${r.status}` });
      }

      case "openai": {
        const key = getKey("OPENAI_API_KEY");
        if (!key) return res.json({ ok: false, error: "OPENAI_API_KEY not set" });
        // Minimal test: list models (free)
        const r = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${key}` }
        });
        if (r.ok) return res.json({ ok: true, message: "OpenAI key valid" });
        const d = await r.json().catch(() => ({}));
        return res.json({ ok: false, error: d?.error?.message || `HTTP ${r.status}` });
      }

      case "runway": {
        const key = getKey("RUNWAY_API_KEY");
        if (!key) return res.json({ ok: false, error: "RUNWAY_API_KEY not set" });
        // Runway doesn't have a list/health endpoint; we make a minimal HEAD-style request
        // The /v1/organization endpoint returns account info without consuming credits
        const r = await fetch("https://api.dev.runwayml.com/v1/organization", {
          headers: { Authorization: `Bearer ${key}`, "X-Runway-Version": "2024-11-06" }
        });
        if (r.ok) return res.json({ ok: true, message: "Runway key valid" });
        const t = await r.text().catch(() => "");
        return res.json({ ok: false, error: `HTTP ${r.status}: ${t.slice(0, 200)}` });
      }

      case "higgsfield": {
        const k = getKey("HF_API_KEY");
        const s = getKey("HF_API_SECRET");
        if (!k || !s) return res.json({ ok: false, error: "HF_API_KEY and HF_API_SECRET both required" });
        // Minimal test: try a status check on a non-existent job (cheap probe)
        // We expect 404 (not found) which proves auth works
        const r = await fetch("https://platform.higgsfield.ai/requests/test-probe-not-real/status", {
          headers: { Authorization: `Key ${k}:${s}` }
        });
        if (r.status === 401 || r.status === 403) {
          const t = await r.text().catch(() => "");
          return res.json({ ok: false, error: `Auth failed: HTTP ${r.status} — ${t.slice(0, 200)}` });
        }
        if (r.status === 404) {
          return res.json({ ok: true, message: "Higgsfield auth valid (404 on probe = expected)" });
        }
        if (r.ok) return res.json({ ok: true, message: "Higgsfield auth valid" });
        const t = await r.text().catch(() => "");
        return res.json({ ok: false, error: `HTTP ${r.status}: ${t.slice(0, 200)}` });
      }

      case "s3": {
        const key = getKey("AWS_ACCESS_KEY_ID");
        const secret = getKey("AWS_SECRET_ACCESS_KEY");
        const bucket = getKey("AWS_S3_BUCKET");
        if (!key || !secret || !bucket) {
          return res.json({ ok: false, error: "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET all required" });
        }
        try {
          const { S3Client, HeadBucketCommand } = require("@aws-sdk/client-s3");
          const region = getKey("AWS_REGION") || "us-east-1";
          const endpoint = getKey("AWS_S3_ENDPOINT");
          const config = { region, credentials: { accessKeyId: key, secretAccessKey: secret } };
          if (endpoint) { config.endpoint = endpoint; config.forcePathStyle = true; }
          const s3 = new S3Client(config);
          await s3.send(new HeadBucketCommand({ Bucket: bucket }));
          return res.json({ ok: true, message: `Bucket "${bucket}" accessible` + (endpoint ? " (via R2)" : "") });
        } catch (e) {
          return res.json({ ok: false, error: e.message || "S3 connection failed" });
        }
      }

      default:
        return res.status(400).json({ ok: false, error: `Unknown provider: ${provider}. Valid: gemini, openai, runway, higgsfield, s3` });
    }
  } catch (e) {
    console.error(`[test-api-key/${provider}]`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
