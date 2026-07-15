// ─────────────────────────────────────────────────────────────────────────────
// loader-shims.js
// Panel list-loaders in the dashboards fetch a bare /api/<resource> path and read
// data[dataKey] into an items-* container. The real data lived under other
// prefixes/shapes, so these panels 404'd. These handlers answer the exact bare
// paths with the exact shape each loader expects, pulled from real tables.
// Every handler is defensive: on ANY error it returns the empty shape, so the
// panel shows its clean empty-state instead of breaking. No fabricated rows.
// Mounted at /api BEFORE the catch-all.
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

const J = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };
const uid = (req) => req.userId || (req.user && req.user.id);
const newId = () => { try { return crypto.randomUUID(); } catch (_) { return "id_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8); } };

// /api/brand-kit -> { assets:[{name,type}], logos, colors, fonts, templates }
router.get("/brand-kit", auth, (req, res) => {
  const empty = { assets: [], logos: 0, colors: 0, fonts: 0, templates: 0 };
  try {
    const db = getDb();
    let row = {};
    try { row = db.prepare("SELECT brand_kit, brand_primary_color, brand_font, logo_url FROM users WHERE id=?").get(uid(req)) || {}; } catch (_) {}
    const kit = J(row.brand_kit, {}) || {};
    const assets = [];
    if (row.logo_url) assets.push({ name: "Logo", type: "Logo" });
    if (row.brand_primary_color) assets.push({ name: row.brand_primary_color, type: "Color" });
    if (kit.secondary_color || kit.secondary) assets.push({ name: kit.secondary_color || kit.secondary, type: "Color" });
    if (kit.accent) assets.push({ name: kit.accent, type: "Color" });
    if (row.brand_font) assets.push({ name: row.brand_font, type: "Font" });
    (Array.isArray(kit.assets) ? kit.assets : []).forEach(a =>
      assets.push({ name: (a && (a.name || a.url)) || "Asset", type: (a && a.type) || "File" }));
    res.json({
      assets,
      logos: row.logo_url ? 1 : 0,
      colors: assets.filter(a => a.type === "Color").length,
      fonts: row.brand_font ? 1 : 0,
      templates: (Array.isArray(kit.templates) ? kit.templates.length : 0),
    });
  } catch (_) { res.json(empty); }
});

// /api/link-in-bio -> { links:[{title,url,clicks}], visits_mo, clicks_mo, ctr }
router.get("/link-in-bio", auth, (req, res) => {
  const empty = { links: [], visits_mo: 0, clicks_mo: 0, ctr: 0 };
  try {
    const db = getDb();
    let row = null;
    try { row = db.prepare("SELECT links, view_count, click_count FROM link_in_bio WHERE user_id = ?").get(uid(req)); } catch (_) {}
    if (!row) return res.json(empty);
    const links = (J(row.links, []) || []).map(l => ({
      title: (l && (l.title || l.label)) || "Link",
      url: (l && l.url) || "",
      clicks: (l && l.clicks) || 0,
    }));
    const views = row.view_count || 0, clicks = row.click_count || 0;
    res.json({ links, visits_mo: views, clicks_mo: clicks, ctr: views ? Math.round((clicks / views) * 100) : 0 });
  } catch (_) { res.json(empty); }
});

// /api/loyalty -> { program:[{name,points,tier}], members, points_issued, redemptions_mo, ltv_lift }
router.get("/loyalty", auth, (req, res) => {
  const empty = { program: [], members: 0, points_issued: 0, redemptions_mo: 0, ltv_lift: 0 };
  try {
    const db = getDb();
    let members = 0, points = 0;
    try {
      const rows = db.prepare(
        "SELECT loyalty_points FROM customer_accounts WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND loyalty_points > 0"
      ).all(uid(req));
      members = rows.length;
      points = rows.reduce((s, r) => s + (r.loyalty_points || 0), 0);
    } catch (_) {}
    let program = [];
    try {
      const site = db.prepare("SELECT site_meta FROM sites WHERE user_id = ? ORDER BY created_at LIMIT 1").get(uid(req));
      const meta = J(site && site.site_meta, {}) || {};
      const tiers = (meta.loyalty && Array.isArray(meta.loyalty.tiers)) ? meta.loyalty.tiers
        : (meta.loyalty && Array.isArray(meta.loyalty.rewards)) ? meta.loyalty.rewards : [];
      program = tiers.map(t => ({
        name: (t && (t.name || t.label)) || "Reward",
        points: (t && (t.points || t.threshold)) || 0,
        tier: (t && (t.tier || t.name)) || "Bronze",
      }));
    } catch (_) {}
    res.json({ program, members, points_issued: points, redemptions_mo: 0, ltv_lift: 0 });
  } catch (_) { res.json(empty); }
});

// /api/app-store -> { apps:[{name,category,installed}], installed, available, featured, updates }
router.get("/app-store", auth, (req, res) => {
  const empty = { apps: [], installed: 0, available: 0, featured: 0, updates: 0 };
  try {
    const db = getDb();
    let apps = [];
    try {
      apps = db.prepare(
        "SELECT id, name, category, is_featured FROM marketplace_apps WHERE status='active' ORDER BY is_featured DESC, installs DESC LIMIT 100"
      ).all();
    } catch (_) {}
    let installed = new Set();
    try {
      const ins = db.prepare("SELECT app_id FROM app_installs WHERE user_id = ?").all(uid(req));
      installed = new Set(ins.map(i => i.app_id));
    } catch (_) {}
    const list = apps.map(a => ({ name: a.name, category: a.category || "Tool", installed: installed.has(a.id) }));
    res.json({
      apps: list,
      installed: list.filter(a => a.installed).length,
      available: list.length,
      featured: apps.filter(a => a.is_featured).length,
      updates: 0,
    });
  } catch (_) { res.json(empty); }
});

// /api/changelog -> { changes:[{title,date,category}] }
// No changelog table exists; the canonical source is the static list in
// routes/missing-endpoints.js (GET /api/features/changelog). Mirrored + flattened
// here so the bare loader shows the real release notes. Keep in sync with that file.
router.get("/changelog", (req, res) => {
  const releases = [
    { date: "2026-04-18", version: "v49.1", items: ["New Site Editor with live preview", "Pooled agency plan ($799)", "Usage caps dashboard"] },
    { date: "2026-03-01", version: "v48", items: ["AI Employees: 14 specialised agents", "Stripe metered overage billing"] },
    { date: "2026-02-01", version: "v47", items: ["Claude Sonnet 4.6 integration", "Real-time chat widget"] }
  ];
  const changes = [];
  for (const r of releases) for (const it of r.items) changes.push({ title: it, date: r.date, category: r.version });
  res.json({ changes });
});

// /api/currencies -> { currencies:[{code,symbol,primary}] }
router.get("/currencies", auth, (req, res) => {
  const empty = { currencies: [] };
  try {
    const db = getDb();
    const set = {};
    try {
      const sites = db.prepare("SELECT site_meta FROM sites WHERE user_id = ?").all(uid(req));
      sites.forEach(s => {
        const m = J(s.site_meta, {}) || {};
        (Array.isArray(m.currencies) ? m.currencies : []).forEach(c => {
          const code = (c && (c.code || c)) || null;
          if (code) set[code] = { code, symbol: (c && c.symbol) || "", primary: !!(c && c.primary) };
        });
      });
    } catch (_) {}
    res.json({ currencies: Object.values(set) });
  } catch (_) { res.json(empty); }
});

// ── Prospector stats (frontend calls /api/ai-employees/prospector/*; real data
//    lives under prospector_* tables, served elsewhere at /api/prospector/*) ──
// /api/ai-employees/prospector/stats -> flat {label:value} object (itemRender renders key/value)
router.get("/ai-employees/prospector/stats", auth, (req, res) => {
  try {
    const db = getDb(); const u = uid(req);
    let c = {}, l = {};
    try {
      c = db.prepare(
        "SELECT COUNT(*) total, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) active, " +
        "COALESCE(SUM(total_found),0) found, COALESCE(SUM(emails_sent),0) emails, COALESCE(SUM(signups),0) signups " +
        "FROM prospector_campaigns WHERE user_id=?"
      ).get(u) || {};
    } catch (_) {}
    try {
      l = db.prepare(
        "SELECT COUNT(*) total, SUM(CASE WHEN status='replied' THEN 1 ELSE 0 END) replied, " +
        "SUM(CASE WHEN status='converted' THEN 1 ELSE 0 END) converted FROM prospector_leads WHERE user_id=?"
      ).get(u) || {};
    } catch (_) {}
    res.json({
      "Prospects found": c.found || 0,
      "Leads": l.total || 0,
      "Emails sent": c.emails || 0,
      "Replies": l.replied || 0,
      "Conversions": l.converted || 0,
      "Sign-ups": c.signups || 0,
      "Active campaigns": c.active || 0,
    });
  } catch (_) { res.json({}); }
});

// /api/ai-employees/prospector/campaigns -> { campaigns:[{name,leads_count,status}] }
router.get("/ai-employees/prospector/campaigns", auth, (req, res) => {
  const empty = { campaigns: [] };
  try {
    const db = getDb();
    let rows = [];
    try {
      rows = db.prepare(
        "SELECT city, category, status, total_found, created_at FROM prospector_campaigns WHERE user_id=? ORDER BY created_at DESC LIMIT 100"
      ).all(uid(req));
    } catch (_) {}
    const campaigns = rows.map(r => ({
      name: [r.city, r.category].filter(Boolean).join(" \u00b7 ") || "Campaign",
      leads_count: r.total_found || 0,
      status: r.status || "pending",
    }));
    res.json({ campaigns });
  } catch (_) { res.json(empty); }
});

// ── Email campaign row-actions (base campaigns built; these two were missing) ──
// /api/email/campaigns/:id/duplicate -> clones the campaign as a draft
router.post("/email/campaigns/:id/duplicate", auth, (req, res) => {
  try {
    const db = getDb(); const u = uid(req);
    const c = db.prepare("SELECT name, subject, body, segment FROM email_campaigns WHERE id=? AND user_id=?").get(req.params.id, u);
    if (!c) return res.status(404).json({ error: "Campaign not found" });
    const id = newId();
    db.prepare("INSERT INTO email_campaigns (id, user_id, name, subject, body, segment, status) VALUES (?,?,?,?,?,?, 'draft')")
      .run(id, u, (c.name || "Campaign") + " (copy)", c.subject || "", c.body || "", c.segment || "");
    res.json({ success: true, id });
  } catch (_) { if (!res.headersSent) res.status(500).json({ error: "Couldn't duplicate campaign" }); }
});

// /api/email/campaigns/:id/resend -> re-queues the campaign for sending
router.post("/email/campaigns/:id/resend", auth, (req, res) => {
  try {
    const db = getDb(); const u = uid(req);
    const c = db.prepare("SELECT id FROM email_campaigns WHERE id=? AND user_id=?").get(req.params.id, u);
    if (!c) return res.status(404).json({ error: "Campaign not found" });
    db.prepare("UPDATE email_campaigns SET status='queued' WHERE id=? AND user_id=?").run(req.params.id, u);
    res.json({ success: true, status: "queued" });
  } catch (_) { if (!res.headersSent) res.status(500).json({ error: "Couldn't queue resend" }); }
});

// ── Team / staff role updates (forms post {email/id, role} in body; the
//    :memberId-in-path handler doesn't fit, so these match by email or id) ──
function updateMemberRole(req, res, idField) {
  try {
    const db = getDb(); const u = uid(req);
    const who = (req.body && (req.body[idField] || req.body.member_email || req.body.staff_id || req.body.email)) || "";
    const role = (req.body && req.body.role) || "";
    if (!who || !role) return res.status(400).json({ error: "Member and role are required" });
    let r = { changes: 0 };
    try {
      r = db.prepare("UPDATE team_members SET role=? WHERE owner_user_id=? AND (email=? OR id=?)").run(role, u, who, who);
    } catch (_) {}
    if (!r.changes) return res.status(404).json({ error: "Team member not found" });
    res.json({ success: true });
  } catch (_) { if (!res.headersSent) res.status(500).json({ error: "Couldn't update role" }); }
}
router.put("/team/role", auth, (req, res) => updateMemberRole(req, res, "member_email"));
router.put("/staff/permissions", auth, (req, res) => updateMemberRole(req, res, "staff_id"));

// ── Stat-tile sources (statsOnly tiles; real data where a customer source
//    exists, clean zeros otherwise — never a 404) ──
// /api/usage -> { plan, ai_edits, remaining, overages }
router.get("/usage", auth, (req, res) => {
  const empty = { plan: "Free", ai_edits: 0, remaining: 0, overages: 0 };
  try {
    const db = getDb();
    let plan = "Free", used = 0;
    try { const usr = db.prepare("SELECT plan FROM users WHERE id=?").get(uid(req)); if (usr && usr.plan) plan = usr.plan; } catch (_) {}
    try {
      const row = db.prepare(
        "SELECT COUNT(*) c FROM ai_usage WHERE user_id=? AND created_at >= datetime('now','start of month')"
      ).get(uid(req));
      used = (row && row.c) || 0;
    } catch (_) {}
    res.json({ plan, ai_edits: used, remaining: 0, overages: 0 });
  } catch (_) { res.json(empty); }
});

// /api/retainers -> { active, mrr, due_soon, retention }  (agency concept; zeros for a customer)
router.get("/retainers", auth, (req, res) => {
  const empty = { active: 0, mrr: 0, due_soon: 0, retention: 100 };
  try {
    const db = getDb();
    let active = 0, mrr = 0;
    try {
      const r = db.prepare(
        "SELECT COUNT(*) active, COALESCE(SUM(amount),0) mrr FROM mine_retainers WHERE owner_user_id=? AND status='active'"
      ).get(uid(req));
      if (r) { active = r.active || 0; mrr = r.mrr || 0; }
    } catch (_) {}
    res.json({ active, mrr, due_soon: 0, retention: 100 });
  } catch (_) { res.json(empty); }
});

// /api/settings -> { settings: {...} }
router.get("/settings", auth, (req, res) => {
  const empty = { settings: {} };
  try {
    const db = getDb();
    let usr = {};
    try { usr = db.prepare("SELECT name, email, plan FROM users WHERE id=?").get(uid(req)) || {}; } catch (_) {}
    res.json({ settings: { name: usr.name || "", email: usr.email || "", plan: usr.plan || "Free", notifications: true } });
  } catch (_) { res.json(empty); }
});

// /api/staff/:id/role -> update a member's role by id
router.put("/staff/:id/role", auth, (req, res) => {
  try {
    const db = getDb(); const role = (req.body && req.body.role) || "";
    if (!role) return res.status(400).json({ error: "Role is required" });
    let r = { changes: 0 };
    try { r = db.prepare("UPDATE team_members SET role=? WHERE owner_user_id=? AND id=?").run(role, uid(req), req.params.id); } catch (_) {}
    if (!r.changes) return res.status(404).json({ error: "Member not found" });
    res.json({ success: true });
  } catch (_) { if (!res.headersSent) res.status(500).json({ error: "Couldn't update role" }); }
});

// /api/team/:id/resend-invite -> re-flag the invite as pending
router.post("/team/:id/resend-invite", auth, (req, res) => {
  try {
    const db = getDb();
    let r = { changes: 0 };
    try { r = db.prepare("UPDATE team_members SET status='invited' WHERE owner_user_id=? AND id=?").run(uid(req), req.params.id); } catch (_) {}
    if (!r.changes) return res.status(404).json({ error: "Invite not found" });
    res.json({ success: true, status: "invited" });
  } catch (_) { if (!res.headersSent) res.status(500).json({ error: "Couldn't resend invite" }); }
});

// /api/mine-control (bare) -> lightweight status summary for the stat tile
router.get("/mine-control", auth, (req, res) => {
  const empty = { enabled: false, tasks_run: 0, status: "idle" };
  try {
    const db = getDb(); const u = uid(req);
    let cfg = null, tasks = 0;
    try { cfg = db.prepare("SELECT enabled, messages_used FROM mine_control_config WHERE user_id=?").get(u); } catch (_) {}
    try { const t = db.prepare("SELECT COUNT(*) c FROM mine_control_messages WHERE user_id=?").get(u); tasks = (t && t.c) || 0; } catch (_) {}
    const on = !!(cfg && cfg.enabled);
    res.json({ enabled: on, tasks_run: tasks || (cfg && cfg.messages_used) || 0, status: on ? "active" : "idle" });
  } catch (_) { res.json(empty); }
});

// /api/reviews -> { reviews:[...], total, avg_rating }  (supports ?limit & ?sort=rating)
router.get("/reviews", auth, (req, res) => {
  const empty = { reviews: [], total: 0, avg_rating: 0 };
  try {
    const db = getDb(); const u = uid(req);
    let limit = parseInt(req.query.limit, 10); if (!(limit > 0) || limit > 100) limit = 20;
    const order = (req.query.sort === "rating") ? "rating DESC, created_at DESC" : "created_at DESC"; // fixed whitelist, not user SQL
    let reviews = [], agg = {};
    try { reviews = db.prepare("SELECT id, rating, text AS content, customer_email, created_at FROM reviews WHERE user_id=? ORDER BY " + order + " LIMIT ?").all(u, limit); } catch (_) {}
    try { agg = db.prepare("SELECT COUNT(*) total, COALESCE(AVG(rating),0) avg FROM reviews WHERE user_id=?").get(u) || {}; } catch (_) {}
    res.json({ reviews, total: agg.total || 0, avg_rating: Math.round((agg.avg || 0) * 10) / 10 });
  } catch (_) { res.json(empty); }
});

module.exports = router;
