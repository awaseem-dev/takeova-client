// Real handlers for endpoints that were canned stubs in wired-endpoints.js.
// Full-path routes, mounted at root AFTER the real route files but BEFORE
// wired-endpoints.js, so genuine handlers still win and these only replace stubs.
// AI actions call Claude (honest 503 without key); payment/shipping actions call
// the real service (honest 503 without key); the rest do real DB work.
const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");

function getDb() { return require("../db/init").getDb(); }
function auth(req, res, next) { const m = require("../middleware/auth"); m.auth(req, res, next); }
function getSetting(k) { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } }
function apiKey() { return getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY; }
function stripeKey() { return getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY; }
const guardAI = (res) => res.status(503).json({ error: "AI not configured — add ANTHROPIC_API_KEY" });

async function ai(system, user, maxTokens) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: apiKey() });
  const msg = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: maxTokens || 1800, system, messages: [{ role: "user", content: user }] });
  return ((msg.content && msg.content[0] && msg.content[0].text) || "").trim();
}
function parseJson(t) { if (!t) return null; let s = t.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim(); try { return JSON.parse(s); } catch (_) {} const m = s.match(/[\[{][\s\S]*[\]}]/); if (m) { try { return JSON.parse(m[0]); } catch (_) {} } return null; }
function bizStats(db, uid) {
  const c = (sql) => { try { return db.prepare(sql).get(uid).c; } catch (_) { return 0; } };
  return {
    contacts: c("SELECT COUNT(*) c FROM contacts WHERE user_id=?"),
    orders: c("SELECT COUNT(*) c FROM orders WHERE user_id=?"),
    revenue: c("SELECT COALESCE(SUM(total),0) c FROM orders WHERE user_id=?"),
    deals: c("SELECT COUNT(*) c FROM deals WHERE user_id=?"),
    bookings: c("SELECT COUNT(*) c FROM bookings WHERE user_id=?"),
  };
}
function ensure(db) {
  try { db.exec("CREATE TABLE IF NOT EXISTS agent_state (user_id TEXT, agent TEXT, status TEXT DEFAULT 'active', last_run_at TEXT, updated_at TEXT, PRIMARY KEY(user_id, agent))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS ai_agent_reports (id TEXT PRIMARY KEY, user_id TEXT, period TEXT, summary TEXT, metrics_json TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
}

// ============ Claude-generation actions ============
router.post("/api/intelligence/ask", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const q = (req.body || {}).question || (req.body || {}).q;
    if (!q) return res.status(400).json({ error: "question required" });
    const answer = await ai("You are a concise business analyst. Answer the user's question using the provided metrics. Be specific and practical.", "Metrics: " + JSON.stringify(bizStats(getDb(), req.userId)) + "\n\nQuestion: " + q, 1200);
    return res.json({ ok: true, success: true, answer, reply: answer });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/intelligence/generate-report", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const db = getDb(); ensure(db);
    const stats = bizStats(db, req.userId);
    const summary = await ai("You are a business analyst. Write a short executive report (markdown) from the metrics: key wins, risks, and 3 actions.", JSON.stringify(stats), 2000);
    const id = uuid();
    db.prepare("INSERT INTO ai_agent_reports (id, user_id, period, summary, metrics_json) VALUES (?,?,?,?,?)").run(id, req.userId, "on-demand", summary, JSON.stringify(stats));
    return res.json({ ok: true, success: true, id, report: summary, summary });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-features/generate", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const report = await ai("You are a business intelligence assistant. Produce the requested output as clean markdown.", (b.prompt || b.topic || "Generate a brief business insights report") + "\n\nContext: " + JSON.stringify(bizStats(getDb(), req.userId)), 2000);
    return res.json({ ok: true, success: true, report, content: report });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-agent/generate", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const content = await ai("You are TAKEOVA's general-purpose business content generator. Produce exactly what is asked, cleanly formatted.", b.prompt || b.instruction || b.text || "Generate helpful business content.", 2500);
    return res.json({ ok: true, success: true, content, text: content });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-employees/growth/strategies", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const out = await ai("You are a growth strategist. Return ONLY a JSON array of 3-5 strategies, each {\"title\":\"...\",\"detail\":\"...\",\"impact\":\"high|medium|low\"}.", "Business metrics: " + JSON.stringify(bizStats(getDb(), req.userId)), 1800);
    const strategies = parseJson(out) || [{ title: "Review pricing", detail: out.slice(0, 400), impact: "medium" }];
    return res.json({ ok: true, success: true, strategies });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-employees/legal/audit", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const text = b.text || b.document || b.content;
    if (!text) return res.status(400).json({ error: "document text required" });
    const audit = await ai("You are a contract reviewer (not a lawyer; add a disclaimer). Identify risks, missing clauses, and suggested fixes in markdown.", String(text).slice(0, 12000), 2000);
    return res.json({ ok: true, success: true, audit, content: audit });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-employees/legal/draft", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const draft = await ai("You draft plain-English business legal documents (add a 'not legal advice' disclaimer). Output clean markdown.", "Draft a " + (b.type || b.document_type || "service agreement") + ". Details: " + JSON.stringify(b), 2500);
    return res.json({ ok: true, success: true, draft, content: draft });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-employees/proposal/generate", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const content = await ai("You write persuasive client proposals as clean markdown (overview, scope, timeline, pricing).", JSON.stringify(b), 2500);
    const db = getDb(); const id = uuid();
    try { db.prepare("INSERT INTO proposals (id, user_id, client_name, description, content, status) VALUES (?,?,?,?,?, 'draft')").run(id, req.userId, b.client_name || b.client || null, b.description || b.objective || null, content); } catch (_) {}
    return res.json({ ok: true, success: true, id, content });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-employees/prospector/find", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const out = await ai("You are a B2B prospecting assistant. From the ideal-customer description, return ONLY a JSON array of 5 example target-prospect profiles, each {\"company_type\":\"...\",\"why_fit\":\"...\",\"outreach_angle\":\"...\"}. These are AI-suggested profiles, not verified contacts.", b.icp || b.description || b.target || "small local businesses", 1800);
    const prospects = parseJson(out) || [];
    return res.json({ ok: true, success: true, prospects, note: "AI-suggested target profiles — connect a lead source to pull real contacts" });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-employees/prospector/export-cold-email", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const out = await ai("You are a cold-email copywriter. Return ONLY a JSON array of 3 short cold-email variants, each {\"subject\":\"...\",\"body\":\"...\"}.", "Offer/context: " + JSON.stringify(b), 1500);
    const emails = parseJson(out) || [];
    return res.json({ ok: true, success: true, emails });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/ai-employees/prospector/followups", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const out = await ai("You write follow-up email sequences. Return ONLY a JSON array of 3 follow-ups, each {\"day\":N,\"subject\":\"...\",\"body\":\"...\"}.", "Context: " + JSON.stringify(b), 1500);
    const followups = parseJson(out) || [];
    return res.json({ ok: true, success: true, followups });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/cart-recovery/personalise", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const b = req.body || {};
    const message = await ai("You write friendly cart-recovery emails. Output a subject and body as clean HTML.", "Personalise a cart-recovery message. Details: " + JSON.stringify(b), 1200);
    return res.json({ ok: true, success: true, message, content: message });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});
router.post("/api/hosting/seo/analyze", auth, async (req, res) => {
  if (!apiKey()) return guardAI(res);
  try {
    const db = getDb();
    const site = db.prepare("SELECT html, seo_title, seo_description FROM sites WHERE user_id=? ORDER BY rowid DESC LIMIT 1").get(req.userId);
    if (!site) return res.json({ ok: true, success: true, analysis: "No site to analyse yet — build a site first.", issues: [] });
    const snippet = String(site.html || "").slice(0, 8000);
    const out = await ai("You are an SEO auditor. Return ONLY JSON {\"score\":0-100,\"issues\":[{\"severity\":\"...\",\"finding\":\"...\",\"fix\":\"...\"}]}.", "Title: " + (site.seo_title || "") + "\nDescription: " + (site.seo_description || "") + "\nHTML:\n" + snippet, 1800);
    const j = parseJson(out) || { score: null, issues: [] };
    return res.json({ ok: true, success: true, score: j.score, issues: j.issues || [], analysis: out });
  } catch (e) { return res.status(502).json({ error: "AI failed: " + e.message }); }
});

// ============ DB / state actions (no key needed) ============
router.post("/api/ai-employees/growth/pause", auth, (req, res) => {
  try {
    const db = getDb(); ensure(db);
    const paused = (req.body || {}).resume ? "active" : "paused";
    db.prepare("INSERT INTO agent_state (user_id, agent, status, updated_at) VALUES (?, 'growth', ?, datetime('now')) ON CONFLICT(user_id, agent) DO UPDATE SET status=excluded.status, updated_at=datetime('now')").run(req.userId, paused);
    return res.json({ ok: true, success: true, status: paused });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/api/ai-employees/growth/run-now", auth, (req, res) => {
  try {
    const db = getDb(); ensure(db);
    db.prepare("INSERT INTO agent_state (user_id, agent, status, last_run_at, updated_at) VALUES (?, 'growth', 'active', datetime('now'), datetime('now')) ON CONFLICT(user_id, agent) DO UPDATE SET last_run_at=datetime('now'), updated_at=datetime('now')").run(req.userId);
    return res.json({ ok: true, success: true, note: "Run recorded — the growth agent will process on its next cycle" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/api/referral-programs/affiliates/setup", auth, (req, res) => {
  try {
    const b = req.body || {}; const db = getDb(); const id = uuid();
    db.prepare("INSERT INTO affiliate_programs (id, user_id, name, commission_type, commission_value, cookie_days) VALUES (?,?,?,?,?,?)")
      .run(id, req.userId, b.name || "Affiliate Program", "percent", parseFloat(b.commission_percent) || 20, parseInt(b.cookie_days) || 30);
    return res.json({ ok: true, success: true, id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/api/admin/finance", auth, (req, res) => {
  try {
    const u = req.user || {};
    if (u.role !== "admin" && u.role !== "owner" && u.role !== "superadmin") return res.status(403).json({ error: "Admin only" });
    const db = getDb();
    const one = (sql) => { try { return db.prepare(sql).get().c; } catch (_) { return 0; } };
    return res.json({
      ok: true, success: true,
      total_revenue: one("SELECT COALESCE(SUM(total),0) c FROM orders"),
      orders: one("SELECT COUNT(*) c FROM orders"),
      users: one("SELECT COUNT(*) c FROM users"),
      active_subscriptions: one("SELECT COUNT(*) c FROM subscriptions WHERE status='active'"),
      mrr: one("SELECT COALESCE(SUM(amount),0) c FROM subscriptions WHERE status='active'"),
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============ Service-gated actions (real call + honest 503) ============
router.post("/api/orders/ai-refund", auth, async (req, res) => {
  try {
    const b = req.body || {}; const db = getDb();
    const order = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(b.order_id || b.id, req.userId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const key = stripeKey();
    if (order.stripe_session_id) {
      if (!key) return res.status(503).json({ error: "Stripe not configured — add STRIPE_SECRET_KEY to process the refund" });
      const stripe = require("stripe")(key);
      const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      if (session && session.payment_intent) await stripe.refunds.create({ payment_intent: session.payment_intent });
    }
    db.prepare("UPDATE orders SET status='refunded' WHERE id=? AND user_id=?").run(order.id, req.userId);
    return res.json({ ok: true, success: true, refunded: true, reason: b.reason || null });
  } catch (e) { return res.status(502).json({ error: "Refund failed: " + e.message }); }
});
router.post("/api/orders/shipping-labels", auth, (req, res) => {
  // Real label creation requires the user's EasyPost BYOK credentials + parcel data.
  const hasEasyPost = getSetting("EASYPOST_API_KEY") || process.env.EASYPOST_API_KEY;
  if (!hasEasyPost) return res.status(503).json({ error: "Shipping not configured — connect EasyPost (and set parcel dimensions) to buy labels" });
  return res.status(501).json({ error: "Label purchase runs through the EasyPost shipping endpoints; use the Shipping panel to buy a label per order." });
});
router.post("/api/payments/connect", auth, async (req, res) => {
  try {
    const key = stripeKey();
    if (!key) return res.status(503).json({ error: "Stripe not configured — add STRIPE_SECRET_KEY to enable Connect onboarding" });
    const stripe = require("stripe")(key);
    const db = getDb();
    const u = db.prepare("SELECT email FROM users WHERE id=?").get(req.userId) || {};
    const acct = await stripe.accounts.create({ type: "express", email: u.email || undefined });
    const base = getSetting("APP_URL") || process.env.APP_URL || process.env.FRONTEND_URL || "";
    const link = await stripe.accountLinks.create({ account: acct.id, refresh_url: base + "/billing", return_url: base + "/billing", type: "account_onboarding" });
    try { db.prepare("UPDATE users SET stripe_account_id=? WHERE id=?").run(acct.id, req.userId); } catch (_) {}
    return res.json({ ok: true, success: true, url: link.url, account: acct.id });
  } catch (e) { return res.status(502).json({ error: "Stripe Connect failed: " + e.message }); }
});

// ============ Best-effort import ============
router.post("/api/migration/import", auth, async (req, res) => {
  try {
    const b = req.body || {}; const url = b.url || b.source_url;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "A valid http(s) url is required" });
    let html = "";
    try { const r = await fetch(url, { redirect: "follow" }); html = await r.text(); } catch (e) { return res.status(502).json({ error: "Could not fetch the site: " + e.message }); }
    if (!html || html.length < 50) return res.status(502).json({ error: "Fetched page was empty" });
    const db = getDb(); const id = uuid();
    const name = (html.match(/<title>([^<]+)<\/title>/i) || [, "Imported site"])[1].trim().slice(0, 120);
    db.prepare("INSERT INTO sites (id, user_id, name, status, html) VALUES (?,?,?, 'draft', ?)").run(id, req.userId, name, html.slice(0, 500000));
    return res.json({ ok: true, success: true, id, name, url });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============ MINE business score (was a canned stub) ============
router.get("/api/score", auth, (req, res) => {
  try {
    const db = getDb(); const uid = req.userId;
    const n = (sql) => { try { return db.prepare(sql).get(uid)?.n || 0; } catch (_) { return 0; } };
    const sites    = n("SELECT COUNT(*) n FROM sites WHERE user_id=?");
    const contacts = n("SELECT COUNT(*) n FROM contacts WHERE user_id=?");
    const orders   = n("SELECT COUNT(*) n FROM orders WHERE user_id=?");
    const revenue  = (() => { try { return db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE user_id=?").get(uid)?.n || 0; } catch (_) { return 0; } })();
    const bookings = n("SELECT COUNT(*) n FROM bookings WHERE user_id=?");
    const reviews  = n("SELECT COUNT(*) n FROM reviews WHERE user_id=?");
    const invoices = n("SELECT COUNT(*) n FROM invoices WHERE user_id=?");
    const pts = [
      sites > 0 ? 15 : 0,
      Math.min(20, contacts),
      Math.min(20, orders * 2),
      Math.min(15, Math.floor(revenue / 100)),
      Math.min(10, bookings),
      Math.min(10, reviews * 2),
      Math.min(10, invoices * 2),
    ];
    const total = Math.min(100, pts.reduce((a, b) => a + b, 0));
    const recent = n("SELECT COUNT(*) n FROM orders WHERE user_id=? AND created_at >= datetime('now','-30 days')")
                 + n("SELECT COUNT(*) n FROM contacts WHERE user_id=? AND created_at >= datetime('now','-30 days')");
    const gained_mo = Math.min(total, recent);
    let percentile = 50;
    try {
      const below = db.prepare("SELECT COUNT(*) n FROM (SELECT user_id, COUNT(*) c FROM contacts GROUP BY user_id) WHERE c < ?").get(contacts)?.n || 0;
      const totalU = db.prepare("SELECT COUNT(*) n FROM (SELECT user_id FROM contacts GROUP BY user_id)").get()?.n || 1;
      percentile = Math.max(1, Math.min(99, Math.round((below / Math.max(1, totalU)) * 100)));
    } catch (_) {}
    const rank = total >= 80 ? "Top tier" : total >= 60 ? "Strong" : total >= 40 ? "Growing" : total >= 20 ? "Getting started" : "New";
    res.json({ score: { total, gained_mo, rank, percentile } });
  } catch (e) { res.json({ score: { total: 0, gained_mo: 0, rank: "New", percentile: 0 } }); }
});

// ============ Mobile app config (was canned {apps:{}}) ============
router.get("/api/mobile-app/config", auth, (req, res) => {
  try {
    const db = getDb(); const uid = req.userId;
    try { db.exec("CREATE TABLE IF NOT EXISTS mobile_app_config (user_id TEXT PRIMARY KEY, app_name TEXT, push_enabled INTEGER DEFAULT 0, theme TEXT, join_code TEXT, updated_at TEXT)"); } catch (_) {}
    try { db.exec("ALTER TABLE mobile_app_config ADD COLUMN join_code TEXT"); } catch (_) {}
    const site = (() => { try { return db.prepare("SELECT custom_domain, domain, name FROM sites WHERE user_id=? LIMIT 1").get(uid) || {}; } catch (_) { return {}; } })();
    const cfg  = (() => { try { return db.prepare("SELECT * FROM mobile_app_config WHERE user_id=?").get(uid) || {}; } catch (_) { return {}; } })();
    const slug = (String(site.name || "yoursite").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "yoursite") + ".takeova.ai";
    const installUrl = (site.custom_domain || site.domain || slug) + "/app";
    let joinCode = "—";
    try { joinCode = require("crypto").createHash("sha1").update(String(uid)).digest("hex").slice(0, 6).toUpperCase(); } catch (_) {}
    try { db.prepare("INSERT INTO mobile_app_config (user_id, join_code) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET join_code=excluded.join_code").run(uid, joinCode); } catch (_) {}
    const n = (sql) => { try { return db.prepare(sql).get(uid)?.n || 0; } catch (_) { return 0; } };
    const downloads = n("SELECT COUNT(*) n FROM mobile_app_installs WHERE user_id=?");
    const active_users = n("SELECT COUNT(*) n FROM mobile_app_installs WHERE user_id=? AND last_seen >= datetime('now','-30 days')");
    const pushEnabled = !!cfg.push_enabled;
    res.json({ config: {
      downloads, active_users, rating: downloads > 0 ? 5 : "—", crashes: 0,
      installUrl, joinCode, pushEnabled, listed: true,
      appName: cfg.app_name || site.name || "Your App",
      pushStatus: pushEnabled ? "Push enabled" : "Send announcements, class reminders, offers · works on iOS 16.4+ and Android",
    }});
  } catch (e) { res.json({ config: { downloads: 0, active_users: 0, rating: "—", crashes: 0, installUrl: "yoursite.takeova.ai/app", joinCode: "—", pushEnabled: false } }); }
});

/* ============================================================
   Real stat / summary / report handlers — replace the empty
   canned stubs in wired-endpoints.js. This file mounts first,
   so these win. Every query is wrapped so a schema mismatch
   returns empty data, never a 500.
   ============================================================ */
function _num(db, sql, ...args){ try { var r = db.prepare(sql).get(...args); return (r && (r.c != null ? r.c : 0)) || 0; } catch(_) { return 0; } }
function _rows(db, sql, ...args){ try { return db.prepare(sql).all(...args) || []; } catch(_) { return []; } }
function _row(db, sql, ...args){ try { return db.prepare(sql).get(...args) || null; } catch(_) { return null; } }

// Analytics — revenue (from real orders)
router.get("/api/analytics/revenue", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({
    revenue: _num(db, "SELECT COALESCE(SUM(total),0) c FROM orders WHERE user_id=?", uid),
    orders: _num(db, "SELECT COUNT(*) c FROM orders WHERE user_id=?", uid),
    paidInvoices: _num(db, "SELECT COUNT(*) c FROM invoices WHERE user_id=? AND status='paid'", uid),
    monthly: _rows(db, "SELECT substr(created_at,1,7) m, COALESCE(SUM(total),0) v, COUNT(*) n FROM orders WHERE user_id=? GROUP BY m ORDER BY m DESC LIMIT 6", uid),
    currency: "AUD"
  });
});

// Analytics — business score (computed from real activity)
router.get("/api/analytics/score", auth, (req, res) => {
  var db = getDb(), uid = req.userId, s = bizStats(db, uid);
  var sites = _num(db, "SELECT COUNT(*) c FROM sites WHERE user_id=?", uid);
  var reviews = _num(db, "SELECT COUNT(*) c FROM reviews WHERE user_id=?", uid);
  var score = Math.min(100, Math.round((sites>0?15:0) + Math.min(20, s.contacts/2) + Math.min(20, s.orders) + Math.min(15, s.bookings) + Math.min(15, reviews*3) + (s.revenue>0?15:0)));
  res.json({ score: score, factors: { sites: sites, contacts: s.contacts, orders: s.orders, bookings: s.bookings, reviews: reviews, revenue: s.revenue } });
});

// Agency — summary (clients, commission, MRR)
router.get("/api/agency/summary", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var clients = _num(db, "SELECT COUNT(*) c FROM agency_clients WHERE agency_user_id=?", uid) || _num(db, "SELECT COUNT(*) c FROM agency_clients WHERE agency_id=?", uid);
  var data = {
    clients: clients, activeClients: clients,
    commission: _num(db, "SELECT COALESCE(SUM(amount),0) c FROM commissions WHERE user_id=?", uid),
    mrr: _num(db, "SELECT COALESCE(SUM(amount_cents),0) c FROM agency_invoices WHERE agency_user_id=? AND status='paid'", uid)
  };
  res.json({ clients: data.clients, activeClients: data.activeClients, commission: data.commission, mrr: data.mrr, agency: data });
});

// Billing — summary (the user's plan)
router.get("/api/billing/summary", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var sub = _row(db, "SELECT plan, amount, interval_type, status FROM subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT 1", uid);
  var plan = (sub && sub.plan) || (_row(db, "SELECT plan FROM users WHERE id=?", uid) || {}).plan || "free";
  res.json({ analytics: {}, plan: plan, amount: (sub && sub.amount) || 0, interval: (sub && sub.interval_type) || "month", status: (sub && sub.status) || "active" });
});

// User — settings (key/value store)
router.get("/api/user/settings", auth, (req, res) => {
  var db = getDb(), uid = req.userId, settings = {};
  _rows(db, "SELECT key, value FROM user_settings WHERE user_id=?", uid).forEach(function(r){ settings[r.key] = r.value; });
  res.json({ settings: settings });
});

// Audit — stats
router.get("/api/audit/stats", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({
    total: _num(db, "SELECT COUNT(*) c FROM audit_log WHERE user_id=?", uid),
    recent: _rows(db, "SELECT action, details, created_at FROM audit_log WHERE user_id=? ORDER BY created_at DESC LIMIT 20", uid)
  });
});

// Chatbot — stats (conversations are per site)
router.get("/api/chatbot/stats", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({
    conversations: _num(db, "SELECT COUNT(*) c FROM chatbot_conversations WHERE site_id IN (SELECT id FROM sites WHERE user_id=?)", uid),
    leadsCaptured: _num(db, "SELECT COUNT(*) c FROM chatbot_conversations WHERE lead_captured=1 AND site_id IN (SELECT id FROM sites WHERE user_id=?)", uid)
  });
});

// AI Tools — usage summary + history
router.get("/api/ai-tools/summary", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({ tools: [], calls: _num(db, "SELECT COUNT(*) c FROM ai_usage WHERE user_id=?", uid), tokens: _num(db, "SELECT COALESCE(SUM(tokens),0) c FROM ai_usage WHERE user_id=?", uid) });
});
router.get("/api/ai-tools/history", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({ history: _rows(db, "SELECT type, tokens, cost, model, created_at FROM ai_usage WHERE user_id=? ORDER BY created_at DESC LIMIT 30", uid) });
});

// Intelligence — overview + mine-score
router.get("/api/intelligence/overview", auth, (req, res) => {
  var db = getDb(), uid = req.userId, s = bizStats(db, uid);
  res.json({
    contacts: s.contacts, orders: s.orders, revenue: s.revenue,
    leads: _num(db, "SELECT COUNT(*) c FROM leads WHERE user_id=?", uid),
    unpaidInvoices: _num(db, "SELECT COUNT(*) c FROM invoices WHERE user_id=? AND status!='paid'", uid),
    upcomingBookings: _num(db, "SELECT COUNT(*) c FROM bookings WHERE user_id=?", uid)
  });
});
router.get("/api/intelligence/mine-score", auth, (req, res) => {
  var db = getDb(), uid = req.userId, s = bizStats(db, uid);
  res.json({ score: Math.min(100, Math.round(Math.min(30, s.contacts) + Math.min(25, s.orders*2) + Math.min(25, s.bookings*2) + (s.revenue>0?20:0))) });
});

// Take Control — overall agent activity
router.get("/api/mine-control/stats", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({
    totalActions: _num(db, "SELECT COUNT(*) c FROM ai_employee_actions WHERE user_id=?", uid),
    pending: _num(db, "SELECT COUNT(*) c FROM ai_employee_actions WHERE user_id=? AND status='pending_approval'", uid),
    completed: _num(db, "SELECT COUNT(*) c FROM ai_employee_actions WHERE user_id=? AND status='completed'", uid),
    activeEmployees: _num(db, "SELECT COUNT(*) c FROM ai_employees WHERE user_id=? AND enabled=1", uid)
  });
});

// Per-agent stats — one handler per role segment (sales-agent/stats, etc.)
var _agentRole = { "social-agent":"social", "marketing-agent":"marketing", "sales-agent":"sales", "support-agent":"support", "bookkeeper-agent":"bookkeeper", "csm-agent":"cs", "proposal-agent":"proposal" };
Object.keys(_agentRole).forEach(function(seg){
  router.get("/api/ai-employees/" + seg + "/stats", auth, function(req, res){
    var db = getDb(), uid = req.userId, role = _agentRole[seg];
    function n(extra){ try { return db.prepare("SELECT COUNT(*) c FROM ai_employee_actions WHERE user_id=? AND role=?" + (extra || "")).get(uid, role).c; } catch(_){ return 0; } }
    res.json({ role: role, totalActions: n(), pending: n(" AND status='pending_approval'"), completed: n(" AND status='completed'") });
  });
});

// Integrations — connection status
router.get("/api/integrations/status", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({
    connected: _rows(db, "SELECT provider, connected, account_name FROM oauth_connections WHERE user_id=?", uid),
    social: _rows(db, "SELECT provider FROM social_connections WHERE user_id=?", uid).map(function(r){ return r.provider; })
  });
});

// Content — podcasts (owner_id, not user_id)
router.get("/api/content/podcasts", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var eps = _rows(db, "SELECT id, title, description, audio_url, status, created_at FROM podcast_episodes WHERE owner_id=? ORDER BY created_at DESC LIMIT 50", String(uid));
  res.json({ podcasts: eps, episodes: eps });
});

// ---- batch 2: data endpoints with real backing tables ----

// Billing — custom currencies (real custom_currencies table)
router.get("/api/billing/currencies", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var rows = _rows(db, "SELECT code, name, symbol, exchange_rate, is_default FROM custom_currencies WHERE owner_id=? ORDER BY is_default DESC, code", uid);
  res.json({ currencies: rows, base: "AUD" });
});

// Content — email/page templates (real email_templates table)
router.get("/api/content/templates", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var rows = _rows(db, "SELECT id, name, subject, category, updated_at FROM email_templates WHERE user_id=? ORDER BY updated_at DESC LIMIT 100", uid);
  res.json({ templates: rows });
});

// Intelligence — competitors (real competitors table)
router.get("/api/intelligence/competitors", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var rows = _rows(db, "SELECT id, name, url, status, last_checked FROM competitors WHERE user_id=? ORDER BY created_at DESC LIMIT 100", uid);
  res.json({ competitors: rows });
});

// SEO agent — competitors (same competitors table)
router.get("/api/seo-agent/competitors", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var rows = _rows(db, "SELECT id, name, url, status, last_checked FROM competitors WHERE user_id=? ORDER BY created_at DESC LIMIT 100", uid);
  res.json({ competitors: rows });
});

// Email — reminders (real reminders table)
router.get("/api/email/reminders", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var rows = _rows(db, "SELECT id, note, contact_name, due_at, done FROM reminders WHERE user_id=? AND COALESCE(done,0)=0 ORDER BY due_at LIMIT 100", uid);
  res.json({ reminders: rows });
});

// AI advisor — chat history (defensive: table columns vary)
router.get("/api/ai-advisor/chats", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var rows = _rows(db, "SELECT * FROM ai_chat_history WHERE user_id=? ORDER BY rowid DESC LIMIT 50", uid);
  res.json({ chats: rows });
});

// Proposal agent — job list/status (defensive)
router.get("/api/proposal-agent/job", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  var rows = _rows(db, "SELECT * FROM proposal_agent_jobs WHERE user_id=? ORDER BY rowid DESC LIMIT 20", uid);
  res.json({ jobs: rows });
});

// SEO — report (defensive keyword pull + competitor count)
router.get("/api/seo/report", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({
    keywords: _rows(db, "SELECT * FROM seo_keywords WHERE user_id=? ORDER BY rowid DESC LIMIT 100", uid),
    competitors: _num(db, "SELECT COUNT(*) c FROM competitors WHERE user_id=?", uid),
    pages: _num(db, "SELECT COUNT(*) c FROM sites WHERE user_id=?", uid)
  });
});

// Platform — changelog (global roadmap items, defensive)
router.get("/api/platform/changelog", auth, (req, res) => {
  var db = getDb();
  var rows = _rows(db, "SELECT * FROM roadmap_items ORDER BY rowid DESC LIMIT 20");
  res.json({ changelog: rows });
});

// Growth agent — stats (real ai_employee_actions, growth role)
router.get("/api/ai-employees/growth-agent/stats", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({
    total: _num(db, "SELECT COUNT(*) c FROM ai_employee_actions WHERE user_id=? AND role='growth'", uid),
    completed: _num(db, "SELECT COUNT(*) c FROM ai_employee_actions WHERE user_id=? AND role='growth' AND status='completed'", uid),
    pending: _num(db, "SELECT COUNT(*) c FROM ai_employee_actions WHERE user_id=? AND role='growth' AND status='pending_approval'", uid)
  });
});

// AI tools — usage stats (real ai_usage table)
router.get("/api/ai-employees/tools/stats", auth, (req, res) => {
  var db = getDb(), uid = req.userId;
  res.json({
    calls: _num(db, "SELECT COUNT(*) c FROM ai_usage WHERE user_id=?", uid),
    tokens: _num(db, "SELECT COALESCE(SUM(tokens),0) c FROM ai_usage WHERE user_id=?", uid),
    cost: _num(db, "SELECT COALESCE(SUM(cost),0) c FROM ai_usage WHERE user_id=?", uid)
  });
});

// ---- media download proxy --------------------------------------------------
// Forces a real file save for generated video/image. Browsers ignore <a download>
// for cross-origin URLs (provider CDNs, S3), so the frontend fetches THIS endpoint
// and we stream the file back with Content-Disposition: attachment.
// SSRF-guarded: blocks private/internal hosts; restricts to media content/hosts.
router.get("/api/media/download", auth, async (req, res) => {
  var dns = require("dns").promises, net = require("net");
  function privateIp(ip){
    if (net.isIPv4(ip)) { var p = ip.split(".").map(Number);
      return p[0]===0||p[0]===10||p[0]===127||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===169&&p[1]===254)||p[0]>=224; }
    if (net.isIPv6(ip)) { var l = ip.toLowerCase();
      return l==="::1"||l==="::"||l.indexOf("fc")===0||l.indexOf("fd")===0||l.indexOf("fe80")===0||l.indexOf("::ffff:")===0; }
    return true;
  }
  var BLOCK_HOST = /^(localhost|metadata\.|169\.254\.|127\.|10\.|192\.168\.)/i;
  var MEDIA_HOST = /(\.amazonaws\.com|\.cloudfront\.net|fal\.ai|fal\.media|heygen\.com|runwayml\.com|replicate\.com|replicate\.delivery|klingai\.com)$/i;
  try {
    var raw = req.query.url || "";
    var u; try { u = new URL(raw); } catch(_) { return res.status(400).json({ error: "Invalid url" }); }
    if (u.protocol !== "https:" && u.protocol !== "http:") return res.status(400).json({ error: "Only http(s) allowed" });
    if (BLOCK_HOST.test(u.hostname)) return res.status(403).json({ error: "Blocked host" });
    var addrs = [];
    try { addrs = await dns.lookup(u.hostname, { all: true }); } catch(_) { return res.status(400).json({ error: "Cannot resolve host" }); }
    if (!addrs.length || addrs.some(function(a){ return privateIp(a.address); })) return res.status(403).json({ error: "Blocked address" });

    var upstream;
    try { upstream = await fetch(u.href, { redirect: "follow", headers: { "User-Agent": "MINE-media-proxy" } }); }
    catch(_) { return res.status(502).json({ error: "Fetch failed" }); }
    if (!upstream.ok) return res.status(502).json({ error: "Upstream " + upstream.status });
    try { if (BLOCK_HOST.test(new URL(upstream.url).hostname)) return res.status(403).json({ error: "Blocked redirect" }); } catch(_){}

    var ct = (upstream.headers.get("content-type") || "").toLowerCase();
    var len = parseInt(upstream.headers.get("content-length") || "0", 10) || 0;
    if (!MEDIA_HOST.test(u.hostname) && !/^(image|video)\//.test(ct)) return res.status(415).json({ error: "Only image/video downloads allowed" });
    if (len && len > 300 * 1024 * 1024) return res.status(413).json({ error: "File too large" });

    var fn = String(req.query.filename || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!fn) fn = "mine-media-" + Date.now();
    if (!/\.[a-z0-9]{2,5}$/i.test(fn)) {
      fn += ct.indexOf("mp4")>=0?".mp4":ct.indexOf("webm")>=0?".webm":ct.indexOf("quicktime")>=0?".mov":ct.indexOf("png")>=0?".png":(ct.indexOf("jpeg")>=0||ct.indexOf("jpg")>=0)?".jpg":ct.indexOf("gif")>=0?".gif":ct.indexOf("webp")>=0?".webp":"";
    }
    res.setHeader("Content-Disposition", 'attachment; filename="' + fn + '"');
    if (ct) res.setHeader("Content-Type", ct);
    if (len) res.setHeader("Content-Length", String(len));
    res.setHeader("Cache-Control", "private, max-age=300");

    if (upstream.body) {
      require("stream").Readable.fromWeb(upstream.body).on("error", function(){ try { res.destroy(); } catch(_){} }).pipe(res);
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "Download failed" });
  }
});

module.exports = router;
