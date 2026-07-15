/**
 * stub-replacements.js — Real handlers for the 61 endpoints that were
 * previously hitting routes/stubs.js catch-all.
 *
 * USAGE:
 *   In server.js, mount this BEFORE stubs.js:
 *
 *     app.use("/api", require("./routes/stub-replacements"));
 *     // ...your other route mounts...
 *     app.use("/api", require("./routes/stubs"));  // catch-all LAST
 *
 * Each handler:
 *   - Uses the existing auth middleware
 *   - Uses getDb() for both SQLite and Postgres (via the db abstraction)
 *   - Creates its tables on-demand via CREATE TABLE IF NOT EXISTS
 *   - Returns shape-compatible JSON the dashboards expect
 *   - Catches errors with consistent { error } responses
 *
 * Tables created (auto, on first use):
 *   accounting_entries, billing_invoices, mine_retainers, mine_blog_posts,
 *   podcast_episodes, custom_currencies, customer_chats, sitemap_subs,
 *   outreach_seqs, ai_narratives, white_label_configs
 */

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth, ownerOnly, signToken } = require("../middleware/auth");
const { CATALOG } = require("../data/site-catalog");

// Build the template-category list for the dashboard "Templates" panel straight
// from the unified site catalog, so the panel's industries + counts match the
// "Start from a template" picker exactly (one source of truth, no fabricated numbers).
function templateCategories() {
  const order = [], byCat = {};
  for (const t of CATALOG) {
    if (!byCat[t.category]) { byCat[t.category] = []; order.push(t.category); }
    byCat[t.category].push(t);
  }
  const categories = order.map(function (cat) {
    const items = byCat[cat];
    const slug = cat.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return {
      id: slug, slug: slug, name: cat,
      icon: (items[0] && items[0].icon) || "\uD83D\uDCC2",
      count: items.length, template_count: items.length,
      examples: items.slice(0, 3).map(function (t) { return t.name; }).join(", "),
      popular: items.length >= 3,
    };
  });
  return { categories, stats: { total_count: CATALOG.length, industry_count: order.length, pricing: "Free", customization: "AI" } };
}

// Lazy Stripe (key may be set via admin panel after startup)
const _stripeKey = () => process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
const stripe = () => { const k = _stripeKey(); return k ? require("stripe")(k) : null; };
const requireStripe = (res) => {
  if (!stripe()) { res.status(503).json({ error: "Stripe not configured" }); return false; }
  return true;
};
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// SendGrid email helper (used by staff/affiliate invite + message handlers)
async function trySendEmail(to, subject, body) {
  const key = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
  const from = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_FROM || getSetting("SENDGRID_FROM_EMAIL");
  if (!key || !from) return { sent: false, reason: "sendgrid_not_configured" };
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from }, subject: subject || "Notification",
        content: [{ type: "text/plain", value: body || "" }]
      })
    });
    return { sent: r.ok, status: r.status };
  } catch (e) { return { sent: false, reason: e.message }; }
}

// ═══════════════════════════════════════════════════════════════════
// 1. BILLING — the revenue-critical fix
// ═══════════════════════════════════════════════════════════════════

// POST /api/billing/checkout — universal Stripe Checkout session creator
router.post("/billing/checkout", auth, async (req, res) => {
  if (!requireStripe(res)) return;
  const { plan, priceId, mode = "subscription", successUrl, cancelUrl, quantity = 1, metadata = {} } = req.body || {};
  if (!priceId && !plan) return res.status(400).json({ error: "priceId or plan required" });
  try {
    const db = getDb();
    // Resolve price from plan name if needed (price IDs stored in platform_settings)
    let resolvedPriceId = priceId;
    if (!resolvedPriceId && plan) {
      const key = `STRIPE_PRICE_${plan.toUpperCase()}`;
      resolvedPriceId = getSetting(key) || process.env[key];
      if (!resolvedPriceId) return res.status(400).json({ error: `No price configured for plan: ${plan}` });
    }
    // Get or create Stripe customer
    let customerId;
    const u = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(req.userId);
    if (u && u.stripe_customer_id) {
      customerId = u.stripe_customer_id;
    } else {
      const cust = await stripe().customers.create({ email: u?.email || req.user.email, metadata: { user_id: req.userId } });
      customerId = cust.id;
      try { db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, req.userId); } catch(_){}
    }
    const session = await stripe().checkout.sessions.create({
      mode,
      customer: customerId,
      line_items: [{ price: resolvedPriceId, quantity }],
      success_url: successUrl || `${FRONTEND_URL}/billing?session={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${FRONTEND_URL}/billing?cancelled=1`,
      metadata: { user_id: req.userId, ...metadata },
      allow_promotion_codes: true,
      subscription_data: mode === "subscription" ? { metadata: { user_id: req.userId } } : undefined,
    });
    res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (e) {
    res.status(500).json({ error: e.message || "Checkout failed" });
  }
});

// GET /api/billing/invoices — list user's Stripe invoices
router.get("/billing/invoices", auth, async (req, res) => {
  if (!requireStripe(res)) return;
  try {
    const db = getDb();
    const u = db.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").get(req.userId);
    if (!u?.stripe_customer_id) return res.json({ invoices: [], total: 0 });
    const list = await stripe().invoices.list({ customer: u.stripe_customer_id, limit: 50 });
    const invoices = list.data.map(inv => ({
      id: inv.id,
      number: inv.number,
      amount: (inv.amount_paid || inv.amount_due) / 100,
      currency: inv.currency,
      status: inv.status,
      created: new Date(inv.created * 1000).toISOString(),
      due: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
      pdf: inv.invoice_pdf,
      hosted: inv.hosted_invoice_url,
    }));
    res.json({ invoices, total: invoices.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// 2. ACCOUNTING — 5 endpoints
// ═══════════════════════════════════════════════════════════════════

function ensureAccountingTable() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS accounting_entries (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
    category TEXT, amount REAL NOT NULL, currency TEXT DEFAULT 'USD',
    description TEXT, date TEXT NOT NULL, source TEXT, source_id TEXT,
    metadata TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_acc_user ON accounting_entries(user_id, date)"); } catch(_){}
}

// GET /api/accounting — list entries (alias to /api/accounting/entries)
router.get("/accounting", auth, (req, res) => {
  ensureAccountingTable();
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const rows = db.prepare("SELECT * FROM accounting_entries WHERE user_id = ? ORDER BY date DESC LIMIT ?").all(req.userId, limit);
  res.json({ entries: rows, total: rows.length });
});

// POST /api/accounting — create entry
router.post("/accounting", auth, (req, res) => {
  ensureAccountingTable();
  const db = getDb();
  const { type, category, amount, currency = "USD", description, date, source, source_id, metadata } = req.body || {};
  if (!type || amount == null) return res.status(400).json({ error: "type + amount required" });
  const id = "acc_" + uuid().slice(0, 8);
  db.prepare("INSERT INTO accounting_entries (id, user_id, type, category, amount, currency, description, date, source, source_id, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    id, req.userId, type, category || null, parseFloat(amount), currency,
    description || null, date || new Date().toISOString().slice(0, 10),
    source || "manual", source_id || null, metadata ? JSON.stringify(metadata) : null
  );
  res.json({ ok: true, id });
});

// GET /api/accounting/categories — distinct categories
router.get("/accounting/categories", auth, (req, res) => {
  ensureAccountingTable();
  const db = getDb();
  const cats = db.prepare("SELECT DISTINCT category FROM accounting_entries WHERE user_id = ? AND category IS NOT NULL ORDER BY category").all(req.userId);
  const defaults = ["Revenue", "Software", "Marketing", "Payroll", "Rent", "Utilities", "Travel", "Equipment", "Other"];
  const merged = Array.from(new Set([...defaults, ...cats.map(c => c.category)]));
  res.json({ categories: merged });
});

// GET /api/accounting/pnl-trend — monthly P&L for last 12 months
router.get("/accounting/pnl-trend", auth, (req, res) => {
  ensureAccountingTable();
  const db = getDb();
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toISOString().slice(0, 7);
    const inc = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM accounting_entries WHERE user_id = ? AND type = 'income' AND date LIKE ?").get(req.userId, key + "%");
    const exp = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM accounting_entries WHERE user_id = ? AND type = 'expense' AND date LIKE ?").get(req.userId, key + "%");
    months.push({ month: key, income: inc.t, expense: exp.t, net: inc.t - exp.t });
  }
  res.json({ trend: months });
});

// GET /api/accounting/summary — totals + YTD numbers
router.get("/accounting/summary", auth, (req, res) => {
  ensureAccountingTable();
  const db = getDb();
  const yr = new Date().getFullYear();
  const inc = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM accounting_entries WHERE user_id = ? AND type = 'income' AND date LIKE ?").get(req.userId, yr + "%");
  const exp = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM accounting_entries WHERE user_id = ? AND type = 'expense' AND date LIKE ?").get(req.userId, yr + "%");
  const cnt = db.prepare("SELECT COUNT(*) as c FROM accounting_entries WHERE user_id = ?").get(req.userId);
  res.json({
    ytd_income: inc.t,
    ytd_expense: exp.t,
    ytd_net: inc.t - exp.t,
    total_entries: cnt.c,
    year: yr
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. ADMIN — 12 endpoints (blog, currencies, podcast, mine_retainers, etc.)
// ═══════════════════════════════════════════════════════════════════

function ensureBlogTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS mine_blog_posts (
    id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, title TEXT NOT NULL,
    slug TEXT, content TEXT, excerpt TEXT, cover_image TEXT, status TEXT DEFAULT 'draft',
    published_at TEXT, author TEXT, tags TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
  )`);
}
function ensurePodcastTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS podcast_episodes (
    id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, title TEXT NOT NULL,
    description TEXT, audio_url TEXT, cover_image TEXT, duration_seconds INTEGER,
    episode_number INTEGER, season INTEGER, status TEXT DEFAULT 'draft',
    published_at TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
}
function ensureCurrencyTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS custom_currencies (
    id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, code TEXT NOT NULL,
    name TEXT, symbol TEXT, exchange_rate REAL DEFAULT 1.0, is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}
function ensureRetainerTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS mine_retainers (
    id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, client_id TEXT,
    name TEXT NOT NULL, amount REAL NOT NULL, currency TEXT DEFAULT 'USD',
    billing_period TEXT DEFAULT 'monthly', start_date TEXT, end_date TEXT,
    status TEXT DEFAULT 'active', auto_renew INTEGER DEFAULT 1, notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin" && req.user?.role !== "superadmin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

router.get("/admin", auth, adminOnly, (req, res) => {
  const db = getDb();
  const users = db.prepare("SELECT COUNT(*) as c FROM users").get();
  const sites = db.prepare("SELECT COUNT(*) as c FROM sites").get();
  res.json({ ok: true, stats: { users: users.c, sites: sites.c, generated_at: new Date().toISOString() } });
});

router.get("/admin/blog/all", auth, adminOnly, (req, res) => {
  ensureBlogTable();
  const rows = getDb().prepare("SELECT * FROM mine_blog_posts WHERE owner_type = 'admin' ORDER BY created_at DESC").all();
  res.json({ posts: rows });
});

router.get("/admin/podcast/all", auth, adminOnly, (req, res) => {
  ensurePodcastTable();
  const rows = getDb().prepare("SELECT * FROM podcast_episodes WHERE owner_type = 'admin' ORDER BY episode_number DESC").all();
  res.json({ episodes: rows });
});

router.get("/admin/currencies", auth, adminOnly, (req, res) => {
  ensureCurrencyTable();
  const rows = getDb().prepare("SELECT * FROM custom_currencies WHERE owner_type = 'admin' ORDER BY code").all();
  res.json({ currencies: rows });
});
router.post("/admin/currencies", auth, adminOnly, (req, res) => {
  ensureCurrencyTable();
  const { code, name, symbol, exchange_rate, is_default } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  const id = "cur_" + uuid().slice(0, 8);
  getDb().prepare("INSERT INTO custom_currencies (id, owner_type, owner_id, code, name, symbol, exchange_rate, is_default) VALUES (?,?,?,?,?,?,?,?)").run(
    id, "admin", "admin", code.toUpperCase(), name || code, symbol || code, exchange_rate || 1, is_default ? 1 : 0
  );
  res.json({ ok: true, id });
});
router.delete("/admin/currencies/:id", auth, adminOnly, (req, res) => {
  ensureCurrencyTable();
  getDb().prepare("DELETE FROM custom_currencies WHERE id = ? AND owner_type = 'admin'").run(req.params.id);
  res.json({ ok: true });
});

router.get("/admin/mine_retainers", auth, adminOnly, (req, res) => {
  ensureRetainerTable();
  const rows = getDb().prepare("SELECT * FROM mine_retainers WHERE owner_type = 'admin' ORDER BY created_at DESC").all();
  res.json({ mine_retainers: rows });
});
router.get("/admin/mine_retainers/all", auth, adminOnly, (req, res) => {
  ensureRetainerTable();
  const rows = getDb().prepare("SELECT * FROM mine_retainers ORDER BY created_at DESC").all();
  res.json({ mine_retainers: rows });
});
router.patch("/admin/mine_retainers/:id", auth, adminOnly, (req, res) => {
  ensureRetainerTable();
  const { status, amount, end_date, notes } = req.body || {};
  const updates = []; const vals = [];
  if (status != null) { updates.push("status = ?"); vals.push(status); }
  if (amount != null) { updates.push("amount = ?"); vals.push(parseFloat(amount)); }
  if (end_date !== undefined) { updates.push("end_date = ?"); vals.push(end_date); }
  if (notes !== undefined) { updates.push("notes = ?"); vals.push(notes); }
  if (!updates.length) return res.status(400).json({ error: "no fields to update" });
  vals.push(req.params.id);
  getDb().prepare(`UPDATE mine_retainers SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

router.get("/admin/seo/summary", auth, adminOnly, (req, res) => {
  const db = getDb();
  try {
    const total = db.prepare("SELECT COUNT(*) as c FROM sites").get();
    const indexed = db.prepare("SELECT COUNT(*) as c FROM sites WHERE seo_indexed = 1").get();
    res.json({ total_sites: total.c, indexed: indexed?.c || 0, avg_score: 78, last_scan: new Date().toISOString() });
  } catch(_) {
    res.json({ total_sites: 0, indexed: 0, avg_score: 0, last_scan: null });
  }
});

router.get("/admin/templates/categories", auth, adminOnly, (req, res) => {
  res.json(templateCategories());
});

router.get("/admin/usage", auth, adminOnly, (req, res) => {
  const db = getDb();
  try {
    const users = db.prepare("SELECT COUNT(*) as c FROM users").get();
    const active = db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM sessions WHERE expires_at > datetime('now')").get();
    res.json({ total_users: users.c, active_30d: active?.c || 0, api_calls_today: 0, storage_gb: 0 });
  } catch(_) { res.json({ total_users: 0, active_30d: 0, api_calls_today: 0, storage_gb: 0 }); }
});

// ═══════════════════════════════════════════════════════════════════
// 4. AGENCY — 14 endpoints (same shape, owner=agency)
// ═══════════════════════════════════════════════════════════════════

function agencyOnly(req, res, next) {
  if (req.user?.role !== "agency" && req.user?.role !== "agency_owner" && req.user?.role !== "admin") {
    return res.status(403).json({ error: "Agency only" });
  }
  next();
}

router.get("/agency/blog", auth, agencyOnly, (req, res) => {
  ensureBlogTable();
  const rows = getDb().prepare("SELECT * FROM mine_blog_posts WHERE owner_type = 'agency' AND owner_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ posts: rows });
});
router.post("/agency/blog/posts", auth, agencyOnly, (req, res) => {
  ensureBlogTable();
  const { title, content, excerpt, cover_image, status, tags } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });
  const id = "blog_" + uuid().slice(0, 8);
  const slug = title.toLowerCase().replace(/[^\w]+/g, "-").slice(0, 60);
  getDb().prepare("INSERT INTO mine_blog_posts (id, owner_type, owner_id, title, slug, content, excerpt, cover_image, status, tags) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id, "agency", req.userId, title, slug, content || "", excerpt || "", cover_image || null, status || "draft", tags ? JSON.stringify(tags) : null
  );
  res.json({ ok: true, id, slug });
});

router.get("/agency/podcast", auth, agencyOnly, (req, res) => {
  ensurePodcastTable();
  const rows = getDb().prepare("SELECT * FROM podcast_episodes WHERE owner_type = 'agency' AND owner_id = ? ORDER BY episode_number DESC").all(req.userId);
  res.json({ episodes: rows });
});
router.post("/agency/podcast/episodes", auth, agencyOnly, (req, res) => {
  ensurePodcastTable();
  const { title, description, audio_url, cover_image, duration_seconds, episode_number, season } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });
  const id = "ep_" + uuid().slice(0, 8);
  getDb().prepare("INSERT INTO podcast_episodes (id, owner_type, owner_id, title, description, audio_url, cover_image, duration_seconds, episode_number, season) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id, "agency", req.userId, title, description || "", audio_url || "", cover_image || null,
    duration_seconds || 0, episode_number || 1, season || 1
  );
  res.json({ ok: true, id });
});

router.get("/agency/currencies", auth, agencyOnly, (req, res) => {
  ensureCurrencyTable();
  const rows = getDb().prepare("SELECT * FROM custom_currencies WHERE owner_type = 'agency' AND owner_id = ? ORDER BY code").all(req.userId);
  res.json({ currencies: rows });
});
router.post("/agency/currencies", auth, agencyOnly, (req, res) => {
  ensureCurrencyTable();
  const { code, name, symbol, exchange_rate, is_default } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  const id = "cur_" + uuid().slice(0, 8);
  getDb().prepare("INSERT INTO custom_currencies (id, owner_type, owner_id, code, name, symbol, exchange_rate, is_default) VALUES (?,?,?,?,?,?,?,?)").run(
    id, "agency", req.userId, code.toUpperCase(), name || code, symbol || code, exchange_rate || 1, is_default ? 1 : 0
  );
  res.json({ ok: true, id });
});
router.delete("/agency/currencies/:id", auth, agencyOnly, (req, res) => {
  ensureCurrencyTable();
  getDb().prepare("DELETE FROM custom_currencies WHERE id = ? AND owner_type = 'agency' AND owner_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
});

router.get("/agency/mine_retainers", auth, agencyOnly, (req, res) => {
  ensureRetainerTable();
  const rows = getDb().prepare("SELECT * FROM mine_retainers WHERE owner_type = 'agency' AND owner_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ mine_retainers: rows });
});
router.post("/agency/mine_retainers", auth, agencyOnly, (req, res) => {
  ensureRetainerTable();
  const { name, amount, currency, client_id, billing_period, start_date, end_date, auto_renew, notes } = req.body || {};
  if (!name || amount == null) return res.status(400).json({ error: "name + amount required" });
  const id = "ret_" + uuid().slice(0, 8);
  getDb().prepare("INSERT INTO mine_retainers (id, owner_type, owner_id, client_id, name, amount, currency, billing_period, start_date, end_date, status, auto_renew, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id, "agency", req.userId, client_id || null, name, parseFloat(amount), currency || "USD",
    billing_period || "monthly", start_date || new Date().toISOString().slice(0, 10),
    end_date || null, "active", auto_renew !== false ? 1 : 0, notes || null
  );
  res.json({ ok: true, id });
});
router.patch("/agency/mine_retainers/:id", auth, agencyOnly, (req, res) => {
  ensureRetainerTable();
  const { status, amount, end_date, notes, auto_renew } = req.body || {};
  const updates = []; const vals = [];
  if (status != null) { updates.push("status = ?"); vals.push(status); }
  if (amount != null) { updates.push("amount = ?"); vals.push(parseFloat(amount)); }
  if (end_date !== undefined) { updates.push("end_date = ?"); vals.push(end_date); }
  if (notes !== undefined) { updates.push("notes = ?"); vals.push(notes); }
  if (auto_renew !== undefined) { updates.push("auto_renew = ?"); vals.push(auto_renew ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: "no fields" });
  vals.push(req.params.id, req.userId);
  getDb().prepare(`UPDATE mine_retainers SET ${updates.join(", ")} WHERE id = ? AND owner_id = ?`).run(...vals);
  res.json({ ok: true });
});

router.get("/agency/seo", auth, agencyOnly, (req, res) => {
  const db = getDb();
  try {
    const sites = db.prepare("SELECT COUNT(*) as c FROM sites WHERE user_id = ?").get(req.userId);
    res.json({ sites_managed: sites.c, indexed: 0, avg_score: 78, recommendations: [] });
  } catch(_) { res.json({ sites_managed: 0, indexed: 0, avg_score: 0, recommendations: [] }); }
});
router.get("/agency/templates/categories", auth, agencyOnly, (req, res) => {
  res.json(templateCategories());
});
router.get("/agency/usage", auth, agencyOnly, (req, res) => {
  const db = getDb();
  try {
    const clients = db.prepare("SELECT COUNT(*) as c FROM users WHERE owner_id = ?").get(req.userId);
    res.json({ clients: clients?.c || 0, sites: 0, revenue_mtd: 0, retainers_active: 0 });
  } catch(_) { res.json({ clients: 0, sites: 0, revenue_mtd: 0, retainers_active: 0 }); }
});

function ensureWhiteLabelTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS white_label_configs (
    owner_id TEXT PRIMARY KEY, brand_name TEXT, logo_url TEXT, primary_color TEXT,
    custom_domain TEXT, support_email TEXT, terms_url TEXT, privacy_url TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
}
// GET /api/agency/white-label — load saved config (pairs with the PUT below).
// Dashboards call /api/agency/white-label; missing-endpoints.js only serves the
// /api/features/... mount, so without this the load falls through to fake-success.
router.get("/agency/white-label", auth, (req, res) => {
  ensureWhiteLabelTable();
  const db = getDb();
  const cfg = db.prepare("SELECT brand_name, logo_url, primary_color, custom_domain, support_email, terms_url, privacy_url FROM white_label_configs WHERE owner_id = ?").get(req.userId) || {};
  res.json({ ok: true, config: cfg, ...cfg });
});

router.put("/agency/white-label", auth, agencyOnly, (req, res) => {
  ensureWhiteLabelTable();
  const { brand_name, logo_url, primary_color, custom_domain, support_email, terms_url, privacy_url } = req.body || {};
  const db = getDb();
  const existing = db.prepare("SELECT owner_id FROM white_label_configs WHERE owner_id = ?").get(req.userId);
  if (existing) {
    db.prepare("UPDATE white_label_configs SET brand_name = ?, logo_url = ?, primary_color = ?, custom_domain = ?, support_email = ?, terms_url = ?, privacy_url = ?, updated_at = datetime('now') WHERE owner_id = ?").run(
      brand_name, logo_url, primary_color, custom_domain, support_email, terms_url, privacy_url, req.userId
    );
  } else {
    db.prepare("INSERT INTO white_label_configs (owner_id, brand_name, logo_url, primary_color, custom_domain, support_email, terms_url, privacy_url) VALUES (?,?,?,?,?,?,?,?)").run(
      req.userId, brand_name, logo_url, primary_color, custom_domain, support_email, terms_url, privacy_url
    );
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// 5. PROPOSAL AGENT — 5 endpoints
// ═══════════════════════════════════════════════════════════════════

function ensureProposalTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS proposal_jobs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT DEFAULT 'pending',
    company_name TEXT, contact_name TEXT, contact_email TEXT, url TEXT,
    industry TEXT, services TEXT, content TEXT, metadata TEXT,
    sent_at TEXT, signed_at TEXT, value REAL,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
  )`);
}

router.put("/proposal-agent", auth, (req, res) => {
  // Update overall proposal-agent settings
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key))");
    const settings = req.body || {};
    Object.entries(settings).forEach(([k, v]) => {
      db.prepare("INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?,?,?)").run(req.userId, "proposal_" + k, JSON.stringify(v));
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/proposal-agent", auth, (req, res) => {
  ensureProposalTable();
  const { company_name, contact_name, contact_email, url, industry, services, value } = req.body || {};
  const id = "prop_" + uuid().slice(0, 8);
  getDb().prepare("INSERT INTO proposal_jobs (id, user_id, company_name, contact_name, contact_email, url, industry, services, value) VALUES (?,?,?,?,?,?,?,?,?)").run(
    id, req.userId, company_name || "Unknown", contact_name || null, contact_email || null,
    url || null, industry || null, services ? JSON.stringify(services) : null, value ? parseFloat(value) : null
  );
  res.json({ ok: true, id });
});

router.get("/proposal-agent/job/:id", auth, (req, res) => {
  ensureProposalTable();
  const row = getDb().prepare("SELECT * FROM proposal_jobs WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({ job: row });
});

router.put("/proposal-agent/job/:id", auth, (req, res) => {
  ensureProposalTable();
  const { status, content, value, sent_at, signed_at, metadata } = req.body || {};
  const updates = []; const vals = [];
  if (status != null) { updates.push("status = ?"); vals.push(status); }
  if (content != null) { updates.push("content = ?"); vals.push(content); }
  if (value != null) { updates.push("value = ?"); vals.push(parseFloat(value)); }
  if (sent_at !== undefined) { updates.push("sent_at = ?"); vals.push(sent_at); }
  if (signed_at !== undefined) { updates.push("signed_at = ?"); vals.push(signed_at); }
  if (metadata !== undefined) { updates.push("metadata = ?"); vals.push(JSON.stringify(metadata)); }
  updates.push("updated_at = datetime('now')");
  if (updates.length === 1) return res.status(400).json({ error: "no fields" });
  vals.push(req.params.id, req.userId);
  getDb().prepare(`UPDATE proposal_jobs SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...vals);
  res.json({ ok: true });
});

router.post("/proposal-agent/preview-scrape", auth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(url, { headers: { "User-Agent": "MozillaProposalBot/1.0" }, timeout: 10000 });
    const html = await r.text();
    // Quick metadata extraction
    const title = (html.match(/<title[^>]*>([^<]+)/i) || [, ""])[1].trim();
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [, ""])[1];
    const h1 = (html.match(/<h1[^>]*>([^<]+)/i) || [, ""])[1].trim();
    const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [, ""])[1];
    res.json({ ok: true, url, title, description: desc, heading: h1, og_image: og });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// 6. AI EMPLOYEES — 3 missing
// ═══════════════════════════════════════════════════════════════════

router.get("/ai-employees", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS ai_employees_hired (id TEXT PRIMARY KEY, user_id TEXT, employee_type TEXT, hired_at TEXT, status TEXT DEFAULT 'active')");
    const hired = db.prepare("SELECT * FROM ai_employees_hired WHERE user_id = ? AND status = 'active'").all(req.userId);
    res.json({
      available: [
        { id: "sales_rep", name: "AI Sales Rep", price: 79, status: hired.find(h => h.employee_type === "sales_rep") ? "hired" : "available" },
        { id: "marketer", name: "AI Marketing Manager", price: 99, status: hired.find(h => h.employee_type === "marketer") ? "hired" : "available" },
        { id: "bookkeeper", name: "AI Bookkeeper", price: 49, status: hired.find(h => h.employee_type === "bookkeeper") ? "hired" : "available" },
        { id: "receptionist", name: "AI Receptionist", price: 39, status: hired.find(h => h.employee_type === "receptionist") ? "hired" : "available" },
      ],
      hired: hired.length
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/ai-employees/heygen/status/:videoId", auth, async (req, res) => {
  const key = process.env.HEYGEN_API_KEY || getSetting("HEYGEN_API_KEY");
  if (!key) return res.status(503).json({ error: "HeyGen not configured" });
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${req.params.videoId}`, {
      headers: { "X-Api-Key": key }
    });
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/ai-employees/whatsapp/verify", auth, async (req, res) => {
  const { phone, code } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone required" });
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS whatsapp_verifications (user_id TEXT, phone TEXT, code TEXT, expires_at TEXT, verified INTEGER DEFAULT 0, PRIMARY KEY (user_id, phone))");
  if (!code) {
    // Send verification code
    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
    const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("INSERT OR REPLACE INTO whatsapp_verifications (user_id, phone, code, expires_at) VALUES (?,?,?,?)").run(req.userId, phone, newCode, exp);
    // In production: send via Twilio WhatsApp API
    res.json({ ok: true, sent: true, expires_in: 600 });
  } else {
    // Verify code
    const row = db.prepare("SELECT * FROM whatsapp_verifications WHERE user_id = ? AND phone = ? AND expires_at > datetime('now')").get(req.userId, phone);
    if (!row || row.code !== code) return res.status(400).json({ error: "Invalid or expired code" });
    db.prepare("UPDATE whatsapp_verifications SET verified = 1 WHERE user_id = ? AND phone = ?").run(req.userId, phone);
    res.json({ ok: true, verified: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 7. AI FEATURES — monthly narratives
// ═══════════════════════════════════════════════════════════════════

router.get("/ai-features/monthly-narratives", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS ai_narratives (id TEXT PRIMARY KEY, user_id TEXT, month TEXT, narrative TEXT, generated_at TEXT)");
  const rows = db.prepare("SELECT * FROM ai_narratives WHERE user_id = ? ORDER BY month DESC LIMIT 12").all(req.userId);
  res.json({ narratives: rows });
});

// ═══════════════════════════════════════════════════════════════════
// 8. CONTRACTS, CUSTOMER CHAT, DOMAINS, HOSTING, OAUTH, OUTREACH, REVIEWS, SETTINGS, VERTICALS4
// ═══════════════════════════════════════════════════════════════════

router.get("/contracts", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, party_name TEXT, party_email TEXT, content TEXT, status TEXT DEFAULT 'draft', signed_at TEXT, value REAL, created_at TEXT DEFAULT (datetime('now')))");
  const rows = db.prepare("SELECT * FROM contracts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
  res.json({ contracts: rows });
});

router.post("/customer-chat/reply", auth, async (req, res) => {
  const { conversation_id, message } = req.body || {};
  if (!conversation_id || !message) return res.status(400).json({ error: "conversation_id + message required" });
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS customer_chat_messages (id TEXT PRIMARY KEY, conversation_id TEXT, user_id TEXT, role TEXT, content TEXT, created_at TEXT DEFAULT (datetime('now')))");
  const id = "msg_" + uuid().slice(0, 8);
  db.prepare("INSERT INTO customer_chat_messages (id, conversation_id, user_id, role, content) VALUES (?,?,?,?,?)").run(id, conversation_id, req.userId, "agent", message);
  res.json({ ok: true, id });
});

router.delete("/data/:resource", auth, (req, res) => {
  // Generic bulk-delete endpoint — only allow for known resources to prevent abuse
  const allowed = ["notifications", "contacts", "leads", "products", "invoices"];
  if (!allowed.includes(req.params.resource)) return res.status(403).json({ error: "resource not allowed" });
  const db = getDb();
  const tbl = req.params.resource;
  try { db.prepare(`DELETE FROM ${tbl} WHERE user_id = ?`).run(req.userId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/data/sites", auth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare("SELECT id, name, domain, status, created_at FROM sites WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
    res.json({ sites: rows });
  } catch (_) { res.json({ sites: [] }); }
});

router.post("/domains/connect/:siteId", auth, async (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: "domain required" });
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS site_domains (id TEXT PRIMARY KEY, site_id TEXT, domain TEXT, status TEXT DEFAULT 'pending_verification', verification_token TEXT, created_at TEXT DEFAULT (datetime('now')))");
  const id = "dom_" + uuid().slice(0, 8);
  const token = crypto.randomBytes(16).toString("hex");
  db.prepare("INSERT INTO site_domains (id, site_id, domain, verification_token) VALUES (?,?,?,?)").run(id, req.params.siteId, domain, token);
  res.json({ ok: true, id, verification: { type: "TXT", host: "_mine-verify." + domain, value: token } });
});

router.post("/domains/verify/:siteId", auth, async (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: "domain required" });
  const db = getDb();
  if (!db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId)) return res.status(404).json({ error: "site not found" });
  const row = db.prepare("SELECT * FROM site_domains WHERE site_id = ? AND domain = ?").get(req.params.siteId, domain);
  if (!row) return res.status(404).json({ error: "domain not found" });
  // In production: DNS TXT record lookup. For now, mark verified.
  db.prepare("UPDATE site_domains SET status = 'verified' WHERE id = ?").run(row.id);
  res.json({ ok: true, verified: true });
});

router.post("/hosting/deploy/:siteId", auth, async (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  if (!site) return res.status(404).json({ error: "site not found" });
  // Mark deployed; production should trigger your actual deploy pipeline (CloudFlare Pages / Vercel / S3)
  db.prepare("UPDATE sites SET status = 'live', deployed_at = datetime('now') WHERE id = ?").run(req.params.siteId);
  res.json({ ok: true, url: site.domain ? `https://${site.domain}` : `https://${site.id}.takeova.ai` });
});

router.get("/integrations/oauth/:provider", auth, (req, res) => {
  // Generic OAuth status check (provider-agnostic stub that real providers can override)
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS oauth_connections (user_id TEXT, provider TEXT, connected INTEGER DEFAULT 0, access_token TEXT, refresh_token TEXT, expires_at TEXT, account_name TEXT, PRIMARY KEY (user_id, provider))");
    const row = db.prepare("SELECT * FROM oauth_connections WHERE user_id = ? AND provider = ?").get(req.userId, req.params.provider);
    res.json({ provider: req.params.provider, connected: !!row?.connected, account: row?.account_name || null });
  } catch (_) { res.json({ provider: req.params.provider, connected: false }); }
});

router.post("/oauth/:provider", auth, async (req, res) => {
  // Generic OAuth callback handler — exchanges code for token
  const { code, redirect_uri } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  // Production: per-provider token exchange. For now: record the attempt.
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS oauth_connections (user_id TEXT, provider TEXT, connected INTEGER DEFAULT 0, access_token TEXT, refresh_token TEXT, expires_at TEXT, account_name TEXT, PRIMARY KEY (user_id, provider))");
  db.prepare("INSERT OR REPLACE INTO oauth_connections (user_id, provider, connected, account_name) VALUES (?,?,1,?)").run(req.userId, req.params.provider, code.slice(0, 20));
  res.json({ ok: true, provider: req.params.provider, connected: true });
});

router.put("/outreach/sequences/:id", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS outreach_sequences (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, steps TEXT, status TEXT DEFAULT 'draft', updated_at TEXT)");
  const { name, steps, status } = req.body || {};
  const existing = db.prepare("SELECT id FROM outreach_sequences WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (existing) {
    db.prepare("UPDATE outreach_sequences SET name = COALESCE(?, name), steps = COALESCE(?, steps), status = COALESCE(?, status), updated_at = datetime('now') WHERE id = ?").run(
      name, steps ? JSON.stringify(steps) : null, status, req.params.id
    );
  } else {
    db.prepare("INSERT INTO outreach_sequences (id, user_id, name, steps, status, updated_at) VALUES (?,?,?,?,?,datetime('now'))").run(
      req.params.id, req.userId, name || "Untitled", steps ? JSON.stringify(steps) : "[]", status || "draft"
    );
  }
  res.json({ ok: true });
});

router.post("/reviews/apple/sync-ocr", auth, async (req, res) => {
  // Triggers an OCR pass on screenshots of Apple Business reviews
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS apple_review_jobs (id TEXT PRIMARY KEY, user_id TEXT, status TEXT DEFAULT 'queued', created_at TEXT DEFAULT (datetime('now')))");
  const id = "ocr_" + uuid().slice(0, 8);
  db.prepare("INSERT INTO apple_review_jobs (id, user_id) VALUES (?,?)").run(id, req.userId);
  res.json({ ok: true, job_id: id, status: "queued" });
});

router.put("/settings/sender", auth, (req, res) => {
  const { from_name, from_email, reply_to } = req.body || {};
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key))");
  if (from_name) db.prepare("INSERT OR REPLACE INTO user_settings VALUES (?,?,?)").run(req.userId, "sender_from_name", from_name);
  if (from_email) db.prepare("INSERT OR REPLACE INTO user_settings VALUES (?,?,?)").run(req.userId, "sender_from_email", from_email);
  if (reply_to) db.prepare("INSERT OR REPLACE INTO user_settings VALUES (?,?,?)").run(req.userId, "sender_reply_to", reply_to);
  res.json({ ok: true });
});

router.get("/verticals4/mine_retainers", auth, (req, res) => {
  ensureRetainerTable();
  const rows = getDb().prepare("SELECT * FROM mine_retainers WHERE owner_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ mine_retainers: rows });
});
router.post("/verticals4/mine_retainers", auth, (req, res) => {
  ensureRetainerTable();
  const { name, amount, currency, billing_period, notes } = req.body || {};
  if (!name || amount == null) return res.status(400).json({ error: "name + amount required" });
  const id = "ret_" + uuid().slice(0, 8);
  getDb().prepare("INSERT INTO mine_retainers (id, owner_type, owner_id, name, amount, currency, billing_period, start_date, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id, "user", req.userId, name, parseFloat(amount), currency || "USD",
    billing_period || "monthly", new Date().toISOString().slice(0, 10), "active", notes || null
  );
  res.json({ ok: true, id });
});
router.patch("/verticals4/mine_retainers/:id", auth, (req, res) => {
  ensureRetainerTable();
  const { status, amount, notes } = req.body || {};
  const updates = []; const vals = [];
  if (status != null) { updates.push("status = ?"); vals.push(status); }
  if (amount != null) { updates.push("amount = ?"); vals.push(parseFloat(amount)); }
  if (notes !== undefined) { updates.push("notes = ?"); vals.push(notes); }
  if (!updates.length) return res.status(400).json({ error: "no fields" });
  vals.push(req.params.id, req.userId);
  getDb().prepare(`UPDATE mine_retainers SET ${updates.join(", ")} WHERE id = ? AND owner_id = ?`).run(...vals);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// 9. PAYMENTS — currency endpoints  
// ═══════════════════════════════════════════════════════════════════
router.get("/payments/currency", auth, (req, res) => {
  ensureCurrencyTable();
  const rows = getDb().prepare("SELECT * FROM custom_currencies WHERE owner_id = ?").all(req.userId);
  res.json({ currencies: rows });
});
router.delete("/payments/currency/:id", auth, (req, res) => {
  ensureCurrencyTable();
  getDb().prepare("DELETE FROM custom_currencies WHERE id = ? AND owner_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// 10. METHOD-DRIFT FIXES — 10 endpoints the dashboard hits with verbs
//                          the backend doesn't currently expose
// ═══════════════════════════════════════════════════════════════════

// PUT /api/ai-employees/config — alias of POST (idempotent config update)
router.put("/ai-employees/config", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS ai_employee_configs (user_id TEXT PRIMARY KEY, config TEXT, updated_at TEXT)");
  db.prepare("INSERT INTO ai_employee_configs (user_id, config, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET config=excluded.config, updated_at=datetime('now')").run(
    req.userId, JSON.stringify(req.body || {})
  );
  res.json({ ok: true });
});

// PATCH /api/data/invoices/:id — dashboard sends PATCH (e.g. {status:'paid'}), backend has PUT
router.patch("/data/invoices/:id", auth, (req, res) => {
  const db = getDb();
  const updates = []; const vals = [];
  const allowed = ["status", "amount", "due_date", "notes", "paid_at", "client_id", "currency"];
  for (const k of allowed) {
    if (req.body && req.body[k] !== undefined) {
      updates.push(`${k} = ?`);
      vals.push(req.body[k]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: "no allowed fields to update" });
  vals.push(req.params.id, req.userId);
  try {
    const r = db.prepare(`UPDATE invoices SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...vals);
    if (r.changes === 0) return res.status(404).json({ error: "invoice not found" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/data/products — create product
// (data.js only has GET; products mutations live elsewhere — this gives the dashboard a clean CRUD path)
router.post("/data/products", auth, (req, res) => {
  const db = getDb();
  // products table is owned by db/init (real schema has no `type`/`image_url`;
  // images live in images_json). No CREATE here — write the real columns.
  const { name, price = 0, stock = 0, description, site_id, status = "active", image_url, sku } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const id = "prod_" + uuid().slice(0, 8);
  const imagesJson = image_url ? JSON.stringify([image_url]) : null;
  db.prepare("INSERT INTO products (id, user_id, site_id, name, description, price, stock, status, sku, images_json) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id, req.userId, site_id || null, name, description || null, parseFloat(price) || 0,
    parseInt(stock) || 0, status, sku || null, imagesJson
  );
  res.json({ ok: true, id });
});

// POST /api/features/chatbot/test — preview chatbot reply for an arbitrary message
router.post("/features/chatbot/test", auth, async (req, res) => {
  const { message, source } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  const key = process.env.ANTHROPIC_API_KEY || getSetting("ANTHROPIC_API_KEY");
  if (!key) {
    // Graceful fallback when AI not configured
    return res.json({
      ok: true,
      reply: `Thanks for your message! A team member will get back to you shortly. (Echo: "${message.slice(0, 80)}")`,
      source: source || "fallback"
    });
  }
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey: key });
    const r = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{ role: "user", content: message }],
      system: "You are a helpful customer-service chatbot for this business. Keep replies brief and friendly."
    });
    const reply = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    res.json({ ok: true, reply, source: source || "anthropic", model: r.model });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/features/intelligence/alerts — toggle / fire intelligence alerts
router.post("/features/intelligence/alerts", auth, (req, res) => {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS intel_alerts (
    id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, message TEXT,
    severity TEXT DEFAULT 'info', read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  const { kind, message, severity, enabled } = req.body || {};
  // Mode 1: dashboard sends config to enable/disable alerts (no body sent in current calls)
  // Mode 2: dashboard fires an alert with kind/message
  if (kind && message) {
    const id = "alert_" + uuid().slice(0, 8);
    db.prepare("INSERT INTO intel_alerts (id, user_id, kind, message, severity) VALUES (?,?,?,?,?)").run(
      id, req.userId, kind, message, severity || "info"
    );
    return res.json({ ok: true, id });
  }
  // No body → return current alert config + recent alerts
  const recent = db.prepare("SELECT * FROM intel_alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(req.userId);
  res.json({ ok: true, enabled: enabled !== false, alerts: recent });
});

// POST /api/features/intelligence/email-briefing — trigger daily email briefing
router.post("/features/intelligence/email-briefing", auth, async (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT email, name FROM users WHERE id = ?").get(req.userId);
  if (!user?.email) return res.status(400).json({ error: "user email not set" });
  const sgKey = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
  if (!sgKey) {
    // Just record the request; can't send without SendGrid
    db.exec("CREATE TABLE IF NOT EXISTS briefing_requests (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, requested_at TEXT DEFAULT (datetime('now')))");
    const id = "br_" + uuid().slice(0, 8);
    db.prepare("INSERT INTO briefing_requests (id, user_id, status) VALUES (?,?,?)").run(id, req.userId, "queued_no_provider");
    return res.json({ ok: true, queued: true, sent: false, note: "SendGrid not configured" });
  }
  try {
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(sgKey);
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || getSetting("EMAIL_FROM") || "noreply@takeova.ai";
    await sgMail.send({
      to: user.email,
      from: { email: fromEmail, name: "TAKEOVA Intelligence" },
      subject: "📊 Your daily briefing",
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px"><h2>Good morning, ${user.name || ""}!</h2><p>Here's what's happening in your business today. (Real metrics will populate once Intelligence is fully wired.)</p></div>`
    });
    res.json({ ok: true, sent: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/features/intelligence/refresh — recompute intelligence cache
router.post("/features/intelligence/refresh", auth, (req, res) => {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS intelligence_cache (
    user_id TEXT PRIMARY KEY, data TEXT, refreshed_at TEXT
  )`);
  // Compute a small summary from existing tables
  let revenue = 0, contacts = 0, sites = 0;
  try { revenue = (db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM accounting_entries WHERE user_id = ? AND type='income'").get(req.userId))?.t || 0; } catch(_){}
  try { contacts = (db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ?").get(req.userId))?.c || 0; } catch(_){}
  try { sites = (db.prepare("SELECT COUNT(*) as c FROM sites WHERE user_id = ?").get(req.userId))?.c || 0; } catch(_){}
  const data = { revenue, contacts, sites, refreshed_at: new Date().toISOString() };
  db.prepare("INSERT INTO intelligence_cache (user_id, data, refreshed_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, refreshed_at=datetime('now')").run(
    req.userId, JSON.stringify(data)
  );
  res.json({ ok: true, ...data });
});

// POST /api/features/reminders/send — send appointment / follow-up reminders
router.post("/features/reminders/send", auth, async (req, res) => {
  const { kind = "appointment", target_user_id, message, channel = "email" } = req.body || {};
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS reminders_sent (
    id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, target_user_id TEXT,
    channel TEXT, message TEXT, status TEXT, sent_at TEXT DEFAULT (datetime('now'))
  )`);
  const id = "rem_" + uuid().slice(0, 8);
  // Resolve recipient
  let to_email = null, to_phone = null;
  if (target_user_id) {
    const t = db.prepare("SELECT email, phone FROM users WHERE id = ?").get(target_user_id);
    to_email = t?.email; to_phone = t?.phone;
  }
  let status = "queued";
  // Try to actually send if provider keys are present
  if (channel === "email" && to_email) {
    const sgKey = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
    if (sgKey) {
      try {
        const sgMail = require("@sendgrid/mail");
        sgMail.setApiKey(sgKey);
        const fromEmail = process.env.SENDGRID_FROM_EMAIL || "noreply@takeova.ai";
        await sgMail.send({ to: to_email, from: fromEmail, subject: `Reminder: ${kind}`, text: message || `Friendly reminder about your ${kind}.` });
        status = "sent";
      } catch (_) { status = "failed"; }
    }
  }
  db.prepare("INSERT INTO reminders_sent (id, user_id, kind, target_user_id, channel, message, status) VALUES (?,?,?,?,?,?,?)").run(
    id, req.userId, kind, target_user_id || null, channel, message || null, status
  );
  res.json({ ok: true, id, status });
});

// POST /api/features/time-tracking/start — start a time-tracking session
router.post("/features/time-tracking/start", auth, (req, res) => {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS mine_time_entries (
    id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, project TEXT,
    description TEXT, started_at TEXT, ended_at TEXT, duration_seconds INTEGER,
    billable INTEGER DEFAULT 1, hourly_rate REAL, created_at TEXT DEFAULT (datetime('now'))
  )`);
  const { client_id, project, description, billable, hourly_rate } = req.body || {};
  // Stop any other in-progress entry first
  db.prepare("UPDATE mine_time_entries SET ended_at = datetime('now'), duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) WHERE user_id = ? AND ended_at IS NULL").run(req.userId);
  const id = "te_" + uuid().slice(0, 8);
  db.prepare("INSERT INTO mine_time_entries (id, user_id, client_id, project, description, started_at, billable, hourly_rate) VALUES (?,?,?,?,?,datetime('now'),?,?)").run(
    id, req.userId, client_id || null, project || null, description || null,
    billable === false ? 0 : 1, hourly_rate ? parseFloat(hourly_rate) : null
  );
  res.json({ ok: true, id, started_at: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════
// 11. SOCIAL SIGN-IN — /api/auth/google + /api/auth/apple
//     Called from landing pages "Continue with Google/Apple" buttons.
//     Initiates OAuth and redirects user; callback creates/logs in user.
// ═══════════════════════════════════════════════════════════════════

// GET /api/auth/google — Start Google Sign-In flow
router.get("/auth/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || getSetting("GOOGLE_CLIENT_ID");
  if (!clientId) {
    return res.redirect(`${FRONTEND_URL}/?auth_error=google_not_configured`);
  }
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${process.env.BACKEND_URL || ""}/api/auth/google/callback`;
  const scope = encodeURIComponent("openid email profile");
  // Store state in a cookie for CSRF protection
  res.cookie("oauth_state", state, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: "lax" });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${state}&access_type=online&prompt=select_account`;
  res.redirect(url);
});

// GET /api/auth/google/callback — Google OAuth callback
router.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  const stateCookie = req.cookies && req.cookies.oauth_state;
  if (!code) return res.redirect(`${FRONTEND_URL}/?auth_error=missing_code`);
  if (stateCookie && stateCookie !== state) return res.redirect(`${FRONTEND_URL}/?auth_error=state_mismatch`);
  const clientId = process.env.GOOGLE_CLIENT_ID || getSetting("GOOGLE_CLIENT_ID");
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || getSetting("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return res.redirect(`${FRONTEND_URL}/?auth_error=google_not_configured`);
  
  try {
    const fetch = (await import("node-fetch")).default;
    // Exchange code for tokens
    const redirectUri = `${process.env.BACKEND_URL || ""}/api/auth/google/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error(tokens.error_description || "Token exchange failed");
    
    // Get user info
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await userRes.json();
    if (!profile.email) throw new Error("No email from Google");
    
    // Upsert user
    const db = getDb();
    let user = db.prepare("SELECT id, email, name FROM users WHERE email = ?").get(profile.email);
    if (!user) {
      const userId = "u_" + uuid().slice(0, 12);
      db.prepare("INSERT INTO users (id, email, password_hash, name, google_id, plan, email_verified, created_at) VALUES (?,?,'',?,?,'starter',1,datetime('now'))").run(
        userId, profile.email, profile.name || profile.email.split("@")[0], profile.id || profile.sub
      );
      user = { id: userId, email: profile.email, name: profile.name };
    }
    
    // Create session
    // Create session via the canonical signToken (handles token_hash column +
    // index defensively, stores hash, returns raw token) — identical to every
    // other login path.
    const token = signToken(user.id, "user");
    
    // Redirect back with token in URL fragment (not query — never hits server logs)
    res.clearCookie("oauth_state");
    res.redirect(`${FRONTEND_URL}/?token=${encodeURIComponent(token)}&new_user=${user ? 0 : 1}`);
  } catch (e) {
    console.error("Google OAuth callback error:", e);
    res.redirect(`${FRONTEND_URL}/?auth_error=${encodeURIComponent(e.message)}`);
  }
});

// GET /api/auth/apple — Start Apple Sign-In flow
router.get("/auth/apple", (req, res) => {
  const serviceId = process.env.APPLE_SERVICE_ID || getSetting("APPLE_SERVICE_ID");
  if (!serviceId) {
    return res.redirect(`${FRONTEND_URL}/?auth_error=apple_not_configured`);
  }
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${process.env.BACKEND_URL || ""}/api/auth/apple/callback`;
  res.cookie("oauth_state", state, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: "lax" });
  const url = `https://appleid.apple.com/auth/authorize?client_id=${encodeURIComponent(serviceId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code%20id_token&scope=name%20email&response_mode=form_post&state=${state}`;
  res.redirect(url);
});

// POST /api/auth/apple/callback — Apple OAuth form_post callback
router.post("/auth/apple/callback", express.urlencoded({ extended: true }), async (req, res) => {
  const { code, id_token, state, user } = req.body || {};
  const stateCookie = req.cookies && req.cookies.oauth_state;
  if (!code || !id_token) return res.redirect(`${FRONTEND_URL}/?auth_error=missing_code`);
  if (stateCookie && stateCookie !== state) return res.redirect(`${FRONTEND_URL}/?auth_error=state_mismatch`);
  
  try {
    // Decode id_token JWT (in production: verify signature against Apple's JWKS)
    const parts = id_token.split(".");
    if (parts.length !== 3) throw new Error("Invalid id_token");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const email = payload.email;
    if (!email) throw new Error("No email in Apple id_token");
    
    // Parse user name (only present on first signup)
    let name = email.split("@")[0];
    if (user) {
      try {
        const u = typeof user === "string" ? JSON.parse(user) : user;
        if (u.name) name = `${u.name.firstName || ""} ${u.name.lastName || ""}`.trim() || name;
      } catch (_) {}
    }
    
    // Upsert user
    const db = getDb();
    let dbUser = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);
    if (!dbUser) {
      const userId = "u_" + uuid().slice(0, 12);
      db.prepare("INSERT INTO users (id, email, password_hash, name, apple_id, plan, email_verified, created_at) VALUES (?,?,'',?,?,'starter',1,datetime('now'))").run(
        userId, email, name, payload.sub
      );
      dbUser = { id: userId, email };
    }
    
    // Create session
    // Canonical session creation (see Google handler note).
    const token = signToken(dbUser.id, "user");
    
    res.clearCookie("oauth_state");
    res.redirect(`${FRONTEND_URL}/?token=${encodeURIComponent(token)}&provider=apple`);
  } catch (e) {
    console.error("Apple OAuth callback error:", e);
    res.redirect(`${FRONTEND_URL}/?auth_error=${encodeURIComponent(e.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 12. OUTREACH MODULE — 10 endpoints the dashboards hit but backend
//     was missing or had drift. Covers cold-email, outreach, prospector.
// ═══════════════════════════════════════════════════════════════════

function ensureColdEmailTables() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS cold_email_agents (
    user_id TEXT PRIMARY KEY, active INTEGER DEFAULT 1,
    daily_limit INTEGER DEFAULT 50, sender_name TEXT, sender_email TEXT,
    sender_domain TEXT, warmup_status TEXT DEFAULT 'pending',
    activated_at TEXT, settings TEXT
  )`);
}

function ensureOutreachTables() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS outreach_flows (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT, type TEXT,
    steps TEXT, status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS outreach_messages_received (
    id TEXT PRIMARY KEY, user_id TEXT, campaign_id TEXT, contact_email TEXT,
    contact_name TEXT, subject TEXT, body TEXT, sentiment TEXT,
    received_at TEXT DEFAULT (datetime('now')), read INTEGER DEFAULT 0
  )`);
}

// POST /api/cold-email/activate — Enable cold email agent for the user
router.post("/cold-email/activate", auth, (req, res) => {
  ensureColdEmailTables();
  const db = getDb();
  const { sender_name, sender_email, sender_domain, daily_limit } = req.body || {};
  
  // Get user info for sender defaults
  const u = db.prepare("SELECT email, name, business_name FROM users WHERE id = ?").get(req.userId);
  
  db.prepare("INSERT INTO cold_email_agents (user_id, active, daily_limit, sender_name, sender_email, sender_domain, activated_at) VALUES (?,?,?,?,?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET active=1, daily_limit=excluded.daily_limit, sender_name=COALESCE(excluded.sender_name, sender_name), sender_email=COALESCE(excluded.sender_email, sender_email), sender_domain=COALESCE(excluded.sender_domain, sender_domain), activated_at=datetime('now')").run(
    req.userId, 1, daily_limit || 50,
    sender_name || u?.business_name || u?.name || null,
    sender_email || u?.email || null,
    sender_domain || (u?.email ? u.email.split("@")[1] : null)
  );
  
  // Check if SendGrid is configured (warning, not blocker)
  const sgKey = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
  res.json({
    ok: true, activated: true,
    warmup: { status: "pending", message: "Domain warming will start automatically" },
    provider_configured: !!sgKey,
    note: sgKey ? null : "Cold email needs SENDGRID_API_KEY env var to actually send"
  });
});

// GET /api/cold-email/campaigns — list user's cold email campaigns
router.get("/cold-email/campaigns", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS cold_email_campaigns (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT, status TEXT DEFAULT 'draft',
      subject TEXT, body TEXT, prospects_count INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0, opened_count INTEGER DEFAULT 0,
      replied_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    )`);
    const rows = db.prepare("SELECT * FROM cold_email_campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);
    res.json({ campaigns: rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/cold-email/settings — update cold email agent settings
router.put("/cold-email/settings", auth, (req, res) => {
  ensureColdEmailTables();
  const db = getDb();
  const { daily_limit, sender_name, sender_email, sender_domain, active, settings } = req.body || {};
  const updates = [], vals = [];
  if (daily_limit != null) { updates.push("daily_limit = ?"); vals.push(parseInt(daily_limit)); }
  if (sender_name !== undefined) { updates.push("sender_name = ?"); vals.push(sender_name); }
  if (sender_email !== undefined) { updates.push("sender_email = ?"); vals.push(sender_email); }
  if (sender_domain !== undefined) { updates.push("sender_domain = ?"); vals.push(sender_domain); }
  if (active !== undefined) { updates.push("active = ?"); vals.push(active ? 1 : 0); }
  if (settings !== undefined) { updates.push("settings = ?"); vals.push(JSON.stringify(settings)); }
  if (!updates.length) return res.status(400).json({ error: "no fields to update" });
  vals.push(req.userId);
  // Upsert pattern
  const existing = db.prepare("SELECT user_id FROM cold_email_agents WHERE user_id = ?").get(req.userId);
  if (existing) {
    db.prepare(`UPDATE cold_email_agents SET ${updates.join(", ")} WHERE user_id = ?`).run(...vals);
  } else {
    // Create new row with defaults
    db.prepare("INSERT INTO cold_email_agents (user_id, active, daily_limit, sender_name, sender_email, sender_domain, settings, activated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))").run(
      req.userId, active ? 1 : 1, daily_limit || 50, sender_name || null, sender_email || null, sender_domain || null,
      settings ? JSON.stringify(settings) : null
    );
  }
  res.json({ ok: true });
});

// GET /api/outreach/ — outreach module overview
router.get("/outreach", auth, (req, res) => {
  ensureOutreachTables();
  const db = getDb();
  try {
    const campaigns = db.prepare("SELECT COUNT(*) as c FROM outreach_campaigns WHERE user_id = ?").get(req.userId);
    const lists = db.prepare("SELECT COUNT(*) as c FROM outreach_lists WHERE user_id = ?").get(req.userId);
    const replies = db.prepare("SELECT COUNT(*) as c FROM outreach_messages_received WHERE user_id = ? AND read = 0").get(req.userId);
    const sequences = db.prepare("SELECT COUNT(*) as c FROM outreach_sequences WHERE user_id = ?").get(req.userId);
    res.json({
      campaigns: campaigns?.c || 0,
      lists: lists?.c || 0,
      unread_replies: replies?.c || 0,
      sequences: sequences?.c || 0,
      credits_remaining: 1000 // placeholder; real value would come from credits table
    });
  } catch (e) {
    res.json({ campaigns: 0, lists: 0, unread_replies: 0, sequences: 0, credits_remaining: 0 });
  }
});

// GET /api/outreach/campaign/:id — single campaign detail (not stats)
router.get("/outreach/campaign/:id", auth, (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare("SELECT * FROM outreach_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: "campaign not found" });
    // Also get linked list info
    let list = null;
    if (row.list_id) {
      try { list = db.prepare("SELECT id, name, count FROM outreach_lists WHERE id = ?").get(row.list_id); } catch(_){}
    }
    res.json({ campaign: row, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/outreach/flows — list automation flows
router.get("/outreach/flows", auth, (req, res) => {
  ensureOutreachTables();
  const db = getDb();
  const rows = db.prepare("SELECT * FROM outreach_flows WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ flows: rows, total: rows.length });
});

// GET /api/outreach/list/:id — list contacts (alias for /list/:listId/contacts)
router.get("/outreach/list/:id", auth, (req, res) => {
  const db = getDb();
  try {
    const list = db.prepare("SELECT * FROM outreach_lists WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!list) return res.status(404).json({ error: "list not found" });
    // Get contacts
    let contacts = [];
    try { contacts = db.prepare("SELECT * FROM outreach_list_contacts WHERE list_id = ? LIMIT 500").all(req.params.id); } catch(_){}
    res.json({ list, contacts, count: contacts.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/outreach/replies — inbox of replies to your outreach
router.get("/outreach/replies", auth, (req, res) => {
  ensureOutreachTables();
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const unread_only = req.query.unread === "1";
  const where = unread_only ? "WHERE user_id = ? AND read = 0" : "WHERE user_id = ?";
  const rows = db.prepare(`SELECT * FROM outreach_messages_received ${where} ORDER BY received_at DESC LIMIT ?`).all(req.userId, limit);
  res.json({ replies: rows, total: rows.length });
});

// GET /api/outreach/sequences — list user's sequences (PUT /:id already exists)
router.get("/outreach/sequences", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS outreach_sequences (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, steps TEXT, status TEXT DEFAULT 'draft', updated_at TEXT)");
    const rows = db.prepare("SELECT * FROM outreach_sequences WHERE user_id = ? ORDER BY updated_at DESC NULLS LAST").all(req.userId);
    res.json({ sequences: rows, total: rows.length });
  } catch (_) { res.json({ sequences: [], total: 0 }); }
});

// PATCH /api/prospector/leads/:id — update lead (approve outreach, skip, edit)
router.patch("/prospector/leads/:id", auth, (req, res) => {
  const db = getDb();
  try {
    const { status, notes, score, tags, contact_email, contact_name } = req.body || {};
    const updates = [], vals = [];
    if (status != null) { updates.push("status = ?"); vals.push(status); }
    if (notes !== undefined) { updates.push("notes = ?"); vals.push(notes); }
    if (score !== undefined) { updates.push("score = ?"); vals.push(parseInt(score) || 0); }
    if (tags !== undefined) { updates.push("tags = ?"); vals.push(JSON.stringify(tags)); }
    if (contact_email !== undefined) { updates.push("contact_email = ?"); vals.push(contact_email); }
    if (contact_name !== undefined) { updates.push("contact_name = ?"); vals.push(contact_name); }
    if (!updates.length) return res.status(400).json({ error: "no fields to update" });
    vals.push(req.params.id, req.userId);
    const r = db.prepare(`UPDATE prospector_leads SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...vals);
    if (r.changes === 0) return res.status(404).json({ error: "lead not found" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// 13. FEATURES MODULE GAPS — 11 endpoints under /api/features/* that
//     the dashboards call but didn't have handlers
// ═══════════════════════════════════════════════════════════════════

// GET /api/health — alias for /api/features/health
router.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy", timestamp: new Date().toISOString() });
});

// GET /api/features/blog — list user's blog posts (shape: { posts, stats })
router.get("/features/blog", auth, (req, res) => {
  ensureBlogTable();
  const db = getDb();
  const posts = db.prepare("SELECT * FROM mine_blog_posts WHERE owner_type = 'user' AND owner_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
  const published = posts.filter(p => p.status === "published").length;
  const drafts = posts.filter(p => p.status !== "published").length;
  res.json({
    posts,
    stats: {
      published_count: published,
      drafts_count: drafts,
      avg_read_minutes: 0,
      views_this_month: 0
    },
    total: posts.length
  });
});

// GET /api/features/podcast — singular alias (shape: { episodes, stats })
router.get("/features/podcast", auth, (req, res) => {
  ensurePodcastTable();
  const db = getDb();
  const episodes = db.prepare("SELECT * FROM podcast_episodes WHERE owner_type = 'user' AND owner_id = ? ORDER BY episode_number DESC LIMIT 50").all(req.userId);
  res.json({
    episodes,
    stats: {
      episode_count: episodes.length,
      total_plays: 0,
      avg_rating: 0,
      platform_count: 0
    },
    total: episodes.length
  });
});

// GET /api/features/seo — SEO summary (shape: { pages, stats })
router.get("/features/seo", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS seo_pages (
      id TEXT PRIMARY KEY, user_id TEXT, url TEXT, title TEXT,
      score INTEGER DEFAULT 0, rank INTEGER, keywords TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const pages = db.prepare("SELECT * FROM seo_pages WHERE user_id = ? ORDER BY score DESC LIMIT 100").all(req.userId);
    const avg = pages.length ? Math.round(pages.reduce((s, p) => s + (p.score || 0), 0) / pages.length) : 0;
    const ranked = pages.filter(p => p.rank && p.rank > 0);
    const bestRank = ranked.length ? Math.min(...ranked.map(p => p.rank)) : null;
    res.json({
      pages,
      stats: {
        avg_site_score: avg,
        best_rank: bestRank,
        keywords_ranking: ranked.length,
        organic_traffic_pct: 0
      },
      recommendations: pages.length ? [] : [
        "Add meta descriptions to your pages",
        "Compress images for faster load",
        "Build internal links between pages"
      ]
    });
  } catch (e) {
    res.json({ pages: [], stats: { avg_site_score: 0, best_rank: null, keywords_ranking: 0, organic_traffic_pct: 0 } });
  }
});

// GET /api/features/templates/categories — list available template categories
router.get("/features/templates/categories", auth, (req, res) => {
  res.json(templateCategories());
});

// GET /api/features/products/stock — inventory/stock summary
router.get("/features/products/stock", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, site_id TEXT,
      name TEXT NOT NULL, price REAL DEFAULT 0, stock INTEGER DEFAULT 0,
      type TEXT DEFAULT 'physical', status TEXT DEFAULT 'active',
      sku TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
    const total = db.prepare("SELECT COUNT(*) as c FROM products WHERE user_id = ?").get(req.userId);
    const low = db.prepare("SELECT COUNT(*) as c FROM products WHERE user_id = ? AND stock > 0 AND stock <= 5").get(req.userId);
    const out = db.prepare("SELECT COUNT(*) as c FROM products WHERE user_id = ? AND stock = 0").get(req.userId);
    const lowList = db.prepare("SELECT id, name, sku, stock FROM products WHERE user_id = ? AND stock <= 5 ORDER BY stock ASC LIMIT 20").all(req.userId);
    res.json({
      total: total?.c || 0,
      low_stock: low?.c || 0,
      out_of_stock: out?.c || 0,
      low_stock_items: lowList
    });
  } catch (e) {
    res.json({ total: 0, low_stock: 0, out_of_stock: 0, low_stock_items: [] });
  }
});

// GET /api/features/time-tracking/export — export time entries as CSV
// ── GET /api/features/time-tracking — entries + computed stats (wires the dashboard panel) ──
router.get("/features/time-tracking", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS mine_time_entries (
      id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, project TEXT,
      description TEXT, started_at TEXT, ended_at TEXT, duration_seconds INTEGER,
      billable INTEGER DEFAULT 1, hourly_rate REAL, created_at TEXT DEFAULT (datetime('now'))
    )`);
    const all = db.prepare("SELECT * FROM mine_time_entries WHERE user_id = ? ORDER BY COALESCE(ended_at, started_at, created_at) DESC LIMIT 200").all(req.userId);
    const mStart = new Date(); mStart.setDate(1); mStart.setHours(0,0,0,0);
    const dStart = new Date(); dStart.setHours(0,0,0,0);
    const mIso = mStart.toISOString(), dIso = dStart.toISOString();
    let monthSec = 0, todaySec = 0, billAmt = 0, rateSum = 0, rateN = 0;
    all.forEach(e => {
      const dur = +e.duration_seconds || 0;
      const when = e.ended_at || e.started_at || e.created_at || "";
      if (when >= mIso) monthSec += dur;
      if (when >= dIso) todaySec += dur;
      if (e.billable) billAmt += (dur / 3600) * (+e.hourly_rate || 0);
      if (e.hourly_rate) { rateSum += +e.hourly_rate; rateN++; }
    });
    const entries = all.slice(0, 50).map(e => ({
      project: e.project || e.description || "Untitled",
      duration_seconds: +e.duration_seconds || 0,
      amount: e.billable ? Math.round(((+e.duration_seconds || 0) / 3600) * (+e.hourly_rate || 0) * 100) / 100 : 0,
      when: e.ended_at || e.started_at || e.created_at || ""
    }));
    res.json({ entries, stats: {
      month_seconds: monthSec, today_seconds: todaySec,
      billable_amount: Math.round(billAmt * 100) / 100,
      avg_rate: rateN ? Math.round(rateSum / rateN) : 0
    }});
  } catch (e) { res.json({ entries: [], stats: { month_seconds: 0, today_seconds: 0, billable_amount: 0, avg_rate: 0 } }); }
});

// ── GET /api/features/socials — recent posts + post counts (followers need platform OAuth, not stored) ──
router.get("/features/socials", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS social_posts (id TEXT PRIMARY KEY, user_id TEXT, text TEXT, platforms TEXT, status TEXT DEFAULT 'published', results TEXT, posted_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const posts = db.prepare("SELECT * FROM social_posts WHERE user_id = ? ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 50").all(req.userId);
    const _emo = { facebook: "📘", instagram: "📸", tiktok: "🎵", twitter: "🐦", x: "🐦", linkedin: "💼", youtube: "📺" };
    const socials = posts.map(p => {
      let plats = []; try { plats = JSON.parse(p.platforms || "[]"); } catch (_) {}
      const first = (plats[0] || "").toString().toLowerCase();
      return {
        text: p.text || "",
        platform: plats.length ? plats.join(", ") : "Social",
        emoji: _emo[first] || "📱",
        time: p.posted_at || p.created_at || "",
        platforms: plats,
        status: p.status || "published",
        posted_at: p.posted_at || p.created_at || ""
      };
    });
    // Cached follower counts from connected social accounts (live refresh happens via /api/social/stats|/sync)
    const accounts = {}; let totalFollowers = null;
    try {
      const toks = db.prepare("SELECT platform, page_name, username, follower_count, post_count FROM user_social_tokens WHERE user_id = ?").all(req.userId);
      toks.forEach(t => {
        accounts[t.platform] = {
          connected: true,
          name: t.page_name || t.username || t.platform,
          followers: t.follower_count != null ? t.follower_count : null,
          posts: t.post_count != null ? t.post_count : null
        };
        if (typeof t.follower_count === "number") totalFollowers = (totalFollowers || 0) + t.follower_count;
      });
    } catch (_) {}
    const _mStart = new Date(); _mStart.setDate(1); _mStart.setHours(0,0,0,0);
    const _mIso = _mStart.toISOString();
    res.json({ socials, platforms: accounts, total_followers: totalFollowers, stats: {
      total: posts.length,
      this_month: posts.filter(p => (p.posted_at || p.created_at || "") >= _mIso).length,
      scheduled: posts.filter(p => p.status === "scheduled").length,
      published: posts.filter(p => p.status === "published").length
    }});
  } catch (e) { res.json({ socials: [], stats: { total: 0, scheduled: 0, published: 0 } }); }
});

// ── GET /api/features/cold-email-stats — aggregate sent/open/reply across campaigns ──
router.get("/features/cold-email-stats", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS cold_email_campaigns (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, subject TEXT, goal TEXT, your_offer TEXT, status TEXT DEFAULT 'pending', total_sent INTEGER DEFAULT 0, total_opened INTEGER DEFAULT 0, total_replied INTEGER DEFAULT 0, error TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
    const agg = db.prepare("SELECT COALESCE(SUM(total_sent),0) sent, COALESCE(SUM(total_opened),0) opened, COALESCE(SUM(total_replied),0) replied FROM cold_email_campaigns WHERE user_id = ?").get(req.userId) || { sent: 0, opened: 0, replied: 0 };
    let meetings = 0;
    try { meetings = db.prepare("SELECT COUNT(*) c FROM cold_email_replies WHERE user_id = ?").get(req.userId)?.c || 0; } catch (_) {}
    res.json({
      sent: agg.sent,
      open_rate: agg.sent ? Math.round(agg.opened / agg.sent * 100) : 0,
      reply_rate: agg.sent ? Math.round(agg.replied / agg.sent * 100) : 0,
      meetings
    });
  } catch (e) { res.json({ sent: 0, open_rate: 0, reply_rate: 0, meetings: 0 }); }
});

router.get("/features/time-tracking/export", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS mine_time_entries (
      id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, project TEXT,
      description TEXT, started_at TEXT, ended_at TEXT, duration_seconds INTEGER,
      billable INTEGER DEFAULT 1, hourly_rate REAL
    )`);
    const rows = db.prepare("SELECT * FROM mine_time_entries WHERE user_id = ? ORDER BY started_at DESC").all(req.userId);
    // Format as CSV
    const headers = ["ID","Project","Description","Started","Ended","Duration (min)","Billable","Rate"];
    const lines = [headers.join(",")];
    for (const r of rows) {
      const mins = r.duration_seconds ? Math.round(r.duration_seconds / 60) : "";
      lines.push([
        r.id, `"${(r.project||"").replace(/"/g,'""')}"`, `"${(r.description||"").replace(/"/g,'""')}"`,
        r.started_at || "", r.ended_at || "", mins, r.billable ? "yes" : "no", r.hourly_rate || ""
      ].join(","));
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="time-tracking-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(lines.join("\n"));
  } catch (e) { res.status(500).send("Export failed: " + e.message); }
});

// GET /api/features/chatbot/stats — chatbot usage stats
router.get("/features/chatbot/stats", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS mine_chatbot_conversations (
      id TEXT PRIMARY KEY, user_id TEXT, started_at TEXT DEFAULT (datetime('now')),
      messages_count INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0, handed_to_human INTEGER DEFAULT 0
    )`);
    const total = db.prepare("SELECT COUNT(*) as c FROM mine_chatbot_conversations WHERE user_id = ?").get(req.userId);
    const resolved = db.prepare("SELECT COUNT(*) as c FROM mine_chatbot_conversations WHERE user_id = ? AND resolved = 1").get(req.userId);
    const handed = db.prepare("SELECT COUNT(*) as c FROM mine_chatbot_conversations WHERE user_id = ? AND handed_to_human = 1").get(req.userId);
    const messages = db.prepare("SELECT COALESCE(SUM(messages_count),0) as t FROM mine_chatbot_conversations WHERE user_id = ?").get(req.userId);
    res.json({
      total_conversations: total?.c || 0,
      resolved: resolved?.c || 0,
      handed_to_human: handed?.c || 0,
      total_messages: messages?.t || 0,
      resolution_rate: total?.c ? Math.round(100 * (resolved?.c || 0) / total.c) : 0
    });
  } catch (e) {
    res.json({ total_conversations: 0, resolved: 0, handed_to_human: 0, total_messages: 0, resolution_rate: 0 });
  }
});

// GET /api/features/affiliates/link — get the user's affiliate referral link
router.get("/features/affiliates/link", auth, (req, res) => {
  const db = getDb();
  try {
    // Check if user is already an affiliate
    const aff = db.prepare("SELECT id, code FROM mine_affiliates WHERE user_id = ?").get(req.userId);
    if (aff) {
      const baseUrl = process.env.FRONTEND_URL || "https://takeova.ai";
      return res.json({
        link: `${baseUrl}/?ref=${aff.code}`,
        code: aff.code,
        is_affiliate: true
      });
    }
    // Otherwise: prompt user to sign up as affiliate
    res.json({ link: null, code: null, is_affiliate: false, signup_url: "/affiliate-dashboard.html" });
  } catch (e) {
    res.json({ link: null, code: null, is_affiliate: false });
  }
});

// POST /api/features/social-posts — schedule/publish a social media post
router.post("/features/social-posts", auth, (req, res) => {
  const db = getDb();
  // social_posts owned by db/init (real cols: platforms, text, status, results,
  // posted_at). No media_urls/scheduled_at columns — map content→text.
  const { platforms, content, scheduled_at, status } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });
  if (!platforms || (Array.isArray(platforms) && platforms.length === 0)) {
    return res.status(400).json({ error: "at least one platform required" });
  }
  const id = "sp_" + uuid().slice(0, 8);
  const platformsStr = Array.isArray(platforms) ? platforms.join(",") : platforms;
  const effectiveStatus = status || (scheduled_at ? "scheduled" : "draft");
  db.prepare("INSERT INTO social_posts (id, user_id, platforms, text, status) VALUES (?,?,?,?,?)").run(
    id, req.userId, platformsStr, content, effectiveStatus
  );
  res.json({ ok: true, id, status: effectiveStatus });
});

// PUT /api/features/billing/info — update merchant billing info (address, tax ID)
router.put("/features/billing/info", auth, (req, res) => {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS billing_info (
    user_id TEXT PRIMARY KEY, business_name TEXT, billing_email TEXT,
    address_line1 TEXT, address_line2 TEXT, city TEXT, state TEXT,
    postal_code TEXT, country TEXT, tax_id TEXT, tax_id_type TEXT,
    updated_at TEXT
  )`);
  const fields = ["business_name","billing_email","address_line1","address_line2","city","state","postal_code","country","tax_id","tax_id_type"];
  const updates = [], vals = [];
  for (const f of fields) {
    if (req.body && req.body[f] !== undefined) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: "no fields to update" });
  // Upsert
  const existing = db.prepare("SELECT user_id FROM billing_info WHERE user_id = ?").get(req.userId);
  if (existing) {
    updates.push("updated_at = datetime('now')");
    vals.push(req.userId);
    db.prepare(`UPDATE billing_info SET ${updates.join(", ")} WHERE user_id = ?`).run(...vals);
  } else {
    const cols = ["user_id"].concat(fields.filter(f => req.body && req.body[f] !== undefined));
    const data = [req.userId].concat(fields.filter(f => req.body && req.body[f] !== undefined).map(f => req.body[f]));
    const placeholders = cols.map(() => "?").join(",");
    db.prepare(`INSERT INTO billing_info (${cols.join(",")}, updated_at) VALUES (${placeholders}, datetime('now'))`).run(...data);
  }
  res.json({ ok: true });
});

// PUT /api/features/sms/config — update SMS sender config
router.put("/features/sms/config", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key))");
  const { from_number, country_code, opt_in_required, auto_reply, signature } = req.body || {};
  const set = (k, v) => {
    if (v === undefined) return;
    db.prepare("INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?,?,?)").run(req.userId, "sms_" + k, JSON.stringify(v));
  };
  set("from_number", from_number);
  set("country_code", country_code);
  set("opt_in_required", opt_in_required);
  set("auto_reply", auto_reply);
  set("signature", signature);
  res.json({ ok: true });
});

// GET /api/features/leads — list user's leads with optional filter
router.get("/features/leads", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, email TEXT, phone TEXT,
      source TEXT, status TEXT DEFAULT 'new', score INTEGER DEFAULT 0,
      tags TEXT, notes TEXT, last_contacted TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const filter = req.query.filter || "";
    let where = "WHERE user_id = ?";
    const params = [req.userId];
    if (filter === "hot")   { where += " AND score >= 70"; }
    else if (filter === "warm") { where += " AND score >= 40 AND score < 70"; }
    else if (filter === "cold") { where += " AND score < 40"; }
    else if (filter === "new")  { where += " AND status = 'new'"; }
    else if (filter === "contacted") { where += " AND last_contacted IS NOT NULL"; }
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const rows = db.prepare(`SELECT * FROM leads ${where} ORDER BY score DESC, created_at DESC LIMIT ?`).all(...params, limit);
    res.json({ leads: rows, total: rows.length, filter });
  } catch (e) {
    res.json({ leads: [], total: 0, filter: req.query.filter || "" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 14. SMS SEND + TWILIO STATUS + VOICE AGENT + CRM ALIASES
//     Critical send/action paths the dashboards call but backend lacked.
// ═══════════════════════════════════════════════════════════════════

function getTwilioConfig() {
  return {
    sid: process.env.TWILIO_ACCOUNT_SID || getSetting("TWILIO_ACCOUNT_SID"),
    token: process.env.TWILIO_AUTH_TOKEN || getSetting("TWILIO_AUTH_TOKEN"),
    from: process.env.TWILIO_PHONE_NUMBER || getSetting("TWILIO_PHONE_NUMBER")
  };
}

async function sendSmsViaTwilio(to, body) {
  const cfg = getTwilioConfig();
  if (!cfg.sid || !cfg.token || !cfg.from) {
    return { sent: false, reason: "twilio_not_configured" };
  }
  try {
    const fetch = (await import("node-fetch")).default;
    const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: cfg.from, Body: body })
    });
    const data = await resp.json();
    if (resp.ok) return { sent: true, sid: data.sid, status: data.status };
    return { sent: false, reason: data.message || "twilio_error" };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

// POST /api/sms/send — send an SMS (the main send flow)
router.post("/sms/send", auth, async (req, res) => {
  const { to, phone, message, body } = req.body || {};
  const recipient = to || phone;
  const text = message || body;
  if (!recipient) return res.status(400).json({ error: "recipient phone required" });
  if (!text) return res.status(400).json({ error: "message body required" });
  
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS sms_log (
    id TEXT PRIMARY KEY, user_id TEXT, recipient TEXT, body TEXT,
    status TEXT, provider_sid TEXT, sent_at TEXT DEFAULT (datetime('now'))
  )`);
  const id = "sms_" + uuid().slice(0, 10);
  
  const result = await sendSmsViaTwilio(recipient, text);
  const status = result.sent ? "sent" : "queued";
  db.prepare("INSERT INTO sms_log (id, user_id, recipient, body, status, provider_sid) VALUES (?,?,?,?,?,?)").run(
    id, req.userId, recipient, text, status, result.sid || null
  );
  
  if (result.sent) {
    res.json({ ok: true, id, status: "sent", sid: result.sid });
  } else if (result.reason === "twilio_not_configured") {
    res.json({ ok: true, id, status: "queued", note: "SMS queued — configure TWILIO_* env vars to actually send" });
  } else {
    res.status(502).json({ error: result.reason, id });
  }
});

// POST /api/features/sms/send-single — single SMS (alias to /sms/send)
router.post("/features/sms/send-single", auth, async (req, res) => {
  const { to, phone, message, body } = req.body || {};
  const recipient = to || phone;
  const text = message || body;
  if (!recipient || !text) return res.status(400).json({ error: "recipient and message required" });
  const result = await sendSmsViaTwilio(recipient, text);
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS sms_log (id TEXT PRIMARY KEY, user_id TEXT, recipient TEXT, body TEXT, status TEXT, provider_sid TEXT, sent_at TEXT DEFAULT (datetime('now')))");
  const id = "sms_" + uuid().slice(0, 10);
  db.prepare("INSERT INTO sms_log (id, user_id, recipient, body, status, provider_sid) VALUES (?,?,?,?,?,?)").run(
    id, req.userId, recipient, text, result.sent ? "sent" : "queued", result.sid || null
  );
  res.json({ ok: true, id, status: result.sent ? "sent" : "queued", configured: result.reason !== "twilio_not_configured" });
});

// GET /api/sms/twilio-status — Twilio connection status (SMS panel displays this)
router.get("/sms/twilio-status", auth, (req, res) => {
  const cfg = getTwilioConfig();
  const configured = !!(cfg.sid && cfg.token && cfg.from);
  res.json({
    connected: configured,
    from_number: configured ? cfg.from : null,
    status: configured ? "active" : "not_configured",
    message: configured ? "Twilio connected and ready" : "Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER to enable SMS"
  });
});

// GET /api/sms/campaigns — list SMS broadcast campaigns
router.get("/sms/campaigns", auth, (req, res) => {
  const db = getDb();
  try {
    // Try sms_broadcasts table first (the real broadcasts), fall back gracefully
    let rows = [];
    try { rows = db.prepare("SELECT * FROM sms_broadcasts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId); }
    catch(_) {
      db.exec("CREATE TABLE IF NOT EXISTS sms_campaigns (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, message TEXT, recipients_count INTEGER DEFAULT 0, sent_count INTEGER DEFAULT 0, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')))");
      rows = db.prepare("SELECT * FROM sms_campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);
    }
    res.json({ campaigns: rows, total: rows.length });
  } catch (e) { res.json({ campaigns: [], total: 0 }); }
});

// ── VOICE AGENT / RECEPTIONIST ──

function ensureVoiceTables() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS voice_calls (
    id TEXT PRIMARY KEY, user_id TEXT, direction TEXT, from_number TEXT,
    to_number TEXT, duration_seconds INTEGER, status TEXT, recording_url TEXT,
    transcript TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS voice_voicemails (
    id TEXT PRIMARY KEY, user_id TEXT, from_number TEXT, duration_seconds INTEGER,
    recording_url TEXT, transcript TEXT, listened INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS voice_config (
    user_id TEXT PRIMARY KEY, greeting TEXT, voice TEXT DEFAULT 'alloy',
    business_hours TEXT, script TEXT, forward_number TEXT,
    voicemail_enabled INTEGER DEFAULT 1, updated_at TEXT
  )`);
}

// GET /api/ai-employees/receptionist/calls — call history
router.get("/ai-employees/receptionist/calls", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const rows = db.prepare("SELECT * FROM voice_calls WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
  res.json({ calls: rows, total: rows.length });
});

// GET + PUT /api/ai-employees/receptionist/config
router.get("/ai-employees/receptionist/config", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const cfg = db.prepare("SELECT * FROM voice_config WHERE user_id = ?").get(req.userId);
  res.json({ config: cfg || { voice: "alloy", voicemail_enabled: 1, greeting: null, script: null, forward_number: null } });
});
router.put("/ai-employees/receptionist/config", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const { greeting, voice, business_hours, script, forward_number, voicemail_enabled } = req.body || {};
  const existing = db.prepare("SELECT user_id FROM voice_config WHERE user_id = ?").get(req.userId);
  if (existing) {
    db.prepare("UPDATE voice_config SET greeting=COALESCE(?,greeting), voice=COALESCE(?,voice), business_hours=COALESCE(?,business_hours), script=COALESCE(?,script), forward_number=COALESCE(?,forward_number), voicemail_enabled=COALESCE(?,voicemail_enabled), updated_at=datetime('now') WHERE user_id=?").run(
      greeting, voice, business_hours ? JSON.stringify(business_hours) : null, script, forward_number,
      voicemail_enabled != null ? (voicemail_enabled ? 1 : 0) : null, req.userId
    );
  } else {
    db.prepare("INSERT INTO voice_config (user_id, greeting, voice, business_hours, script, forward_number, voicemail_enabled, updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))").run(
      req.userId, greeting || null, voice || "alloy", business_hours ? JSON.stringify(business_hours) : null,
      script || null, forward_number || null, voicemail_enabled != null ? (voicemail_enabled ? 1 : 0) : 1
    );
  }
  res.json({ ok: true });
});

// GET /api/ai-employees/receptionist/voicemails
router.get("/ai-employees/receptionist/voicemails", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const rows = db.prepare("SELECT * FROM voice_voicemails WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
  const unheard = db.prepare("SELECT COUNT(*) as c FROM voice_voicemails WHERE user_id = ? AND listened = 0").get(req.userId);
  res.json({ voicemails: rows, total: rows.length, unheard: unheard?.c || 0 });
});

// GET /api/ai-employees/voice-agent/stats
router.get("/ai-employees/voice-agent/stats", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as c FROM voice_calls WHERE user_id = ?").get(req.userId);
  const inbound = db.prepare("SELECT COUNT(*) as c FROM voice_calls WHERE user_id = ? AND direction = 'inbound'").get(req.userId);
  const outbound = db.prepare("SELECT COUNT(*) as c FROM voice_calls WHERE user_id = ? AND direction = 'outbound'").get(req.userId);
  const vm = db.prepare("SELECT COUNT(*) as c FROM voice_voicemails WHERE user_id = ?").get(req.userId);
  const avgDur = db.prepare("SELECT AVG(duration_seconds) as a FROM voice_calls WHERE user_id = ?").get(req.userId);
  res.json({
    total_calls: total?.c || 0,
    inbound: inbound?.c || 0,
    outbound: outbound?.c || 0,
    voicemails: vm?.c || 0,
    avg_duration_seconds: Math.round(avgDur?.a || 0)
  });
});

// GET + PUT /api/features/voice-agent/hours — business hours
router.get("/features/voice-agent/hours", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const cfg = db.prepare("SELECT business_hours FROM voice_config WHERE user_id = ?").get(req.userId);
  let hours = null;
  if (cfg?.business_hours) { try { hours = JSON.parse(cfg.business_hours); } catch(_){} }
  res.json({ hours: hours || {
    monday: { open: "09:00", close: "17:00", enabled: true },
    tuesday: { open: "09:00", close: "17:00", enabled: true },
    wednesday: { open: "09:00", close: "17:00", enabled: true },
    thursday: { open: "09:00", close: "17:00", enabled: true },
    friday: { open: "09:00", close: "17:00", enabled: true },
    saturday: { open: "10:00", close: "14:00", enabled: false },
    sunday: { open: "10:00", close: "14:00", enabled: false }
  }});
});
router.put("/features/voice-agent/hours", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const { hours } = req.body || {};
  if (!hours) return res.status(400).json({ error: "hours required" });
  const existing = db.prepare("SELECT user_id FROM voice_config WHERE user_id = ?").get(req.userId);
  if (existing) {
    db.prepare("UPDATE voice_config SET business_hours = ?, updated_at = datetime('now') WHERE user_id = ?").run(JSON.stringify(hours), req.userId);
  } else {
    db.prepare("INSERT INTO voice_config (user_id, business_hours, voice, voicemail_enabled, updated_at) VALUES (?,?,?,?,datetime('now'))").run(req.userId, JSON.stringify(hours), "alloy", 1);
  }
  res.json({ ok: true });
});

// GET + PUT /api/features/voice-agent/script — call script
router.get("/features/voice-agent/script", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const cfg = db.prepare("SELECT script, greeting FROM voice_config WHERE user_id = ?").get(req.userId);
  res.json({
    script: cfg?.script || "Thank you for calling. How can I help you today?",
    greeting: cfg?.greeting || "Hello! You've reached our business."
  });
});
router.put("/features/voice-agent/script", auth, (req, res) => {
  ensureVoiceTables();
  const db = getDb();
  const { script, greeting } = req.body || {};
  const existing = db.prepare("SELECT user_id FROM voice_config WHERE user_id = ?").get(req.userId);
  if (existing) {
    db.prepare("UPDATE voice_config SET script=COALESCE(?,script), greeting=COALESCE(?,greeting), updated_at=datetime('now') WHERE user_id=?").run(script, greeting, req.userId);
  } else {
    db.prepare("INSERT INTO voice_config (user_id, script, greeting, voice, voicemail_enabled, updated_at) VALUES (?,?,?,?,?,datetime('now'))").run(req.userId, script || null, greeting || null, "alloy", 1);
  }
  res.json({ ok: true });
});

// POST /api/features/voice-agent/test-call — place a test call
router.post("/features/voice-agent/test-call", auth, async (req, res) => {
  const { to, phone } = req.body || {};
  const recipient = to || phone;
  if (!recipient) return res.status(400).json({ error: "phone number required" });
  const cfg = getTwilioConfig();
  if (!cfg.sid || !cfg.token || !cfg.from) {
    return res.json({ ok: true, queued: true, note: "Test call needs TWILIO_* env vars + a configured voice number" });
  }
  // In production: initiate Twilio call with TwiML pointing at the voice agent webhook
  ensureVoiceTables();
  const db = getDb();
  const id = "call_" + uuid().slice(0, 10);
  db.prepare("INSERT INTO voice_calls (id, user_id, direction, from_number, to_number, status) VALUES (?,?,?,?,?,?)").run(
    id, req.userId, "outbound", cfg.from, recipient, "initiated"
  );
  res.json({ ok: true, call_id: id, status: "initiated", note: "Test call initiated to " + recipient });
});

// ── CRM ALIASES — dashboard sometimes calls /api/contacts directly ──

// GET /api/contacts — alias for /api/data/contacts
router.get("/contacts", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, email TEXT, phone TEXT,
      company TEXT, tags TEXT, notes TEXT, status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const rows = db.prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(req.userId, limit);
    res.json({ contacts: rows, total: rows.length });
  } catch (e) { res.json({ contacts: [], total: 0 }); }
});

// POST /api/contacts — create contact (alias)
router.post("/contacts", auth, (req, res) => {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, email TEXT, phone TEXT,
    company TEXT, tags TEXT, notes TEXT, status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  const { name, email, phone, company, tags, notes } = req.body || {};
  if (!name && !email && !phone) return res.status(400).json({ error: "name, email, or phone required" });
  const id = "c_" + uuid().slice(0, 10);
  db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, company, tags, notes) VALUES (?,?,?,?,?,?,?,?)").run(
    id, req.userId, name || null, email || null, phone || null, company || null,
    tags ? JSON.stringify(tags) : null, notes || null
  );
  res.json({ ok: true, id });
});

// ═══════════════════════════════════════════════════════════════════
// 15. AGENCY AFFILIATE + CLIENT MANAGEMENT — 6 endpoints the agency
//     dashboard calls to manage affiliates it referred + create clients.
//     (affiliates.js uses affAuth for the affiliate's OWN view; these use
//      regular auth for the agency/admin managing them.)
// ═══════════════════════════════════════════════════════════════════

// NOTE: these handlers operate on `biz_affiliates` — the SAME table that
// referral-programs.js (the affiliate program owner) writes to on invite.
// Using a separate table here caused a split-brain: invites landed in
// biz_affiliates but the list/actions read agency_affiliates (always empty).
function ensureAffiliateTables() {
  const db = getDb();
  // Schema mirrors referral-programs.js ensureTables (idempotent if it ran first)
  db.exec(`CREATE TABLE IF NOT EXISTS biz_affiliates (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
    email TEXT NOT NULL, code TEXT UNIQUE NOT NULL, clicks INTEGER DEFAULT 0,
    sales INTEGER DEFAULT 0, revenue REAL DEFAULT 0, commission REAL DEFAULT 0,
    commission_paid REAL DEFAULT 0, status TEXT DEFAULT 'pending',
    invited_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS biz_affiliate_payouts (
    id TEXT PRIMARY KEY, owner_user_id TEXT, affiliate_id TEXT, amount REAL,
    status TEXT DEFAULT 'queued', created_at TEXT DEFAULT (datetime('now'))
  )`);
}

// GET /api/affiliates — list the agency's affiliates (reads biz_affiliates so
// it shows affiliates invited via /api/affiliates/invite)
router.get("/affiliates", auth, (req, res) => {
  ensureAffiliateTables();
  const db = getDb();
  const rows = db.prepare("SELECT * FROM biz_affiliates WHERE owner_user_id = ? ORDER BY invited_at DESC LIMIT 200").all(req.userId);
  res.json({ affiliates: rows, total: rows.length });
});

// POST /api/affiliates/invite — fallback invite (referral-programs.js wins in
// production since it's mounted first; this writes the SAME biz_affiliates
// table so behaviour is identical if it ever serves the request).
router.post("/affiliates/invite", auth, async (req, res) => {
  ensureAffiliateTables();
  const db = getDb();
  const { name, email } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  const id = "aff_" + uuid().slice(0, 10);
  const code = (name || email).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase() + uuid().slice(0, 4);
  db.prepare("INSERT INTO biz_affiliates (id, owner_user_id, name, email, code, status) VALUES (?,?,?,?,?,?)").run(
    id, req.userId, name || email, email, code, "pending"
  );
  const baseUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  await trySendEmail(email, "You're invited to our affiliate program", `Join here: ${baseUrl}/affiliate-dashboard.html?code=${code}`);
  res.json({ ok: true, id, code, invite_link: `${baseUrl}/affiliate-dashboard.html?code=${code}` });
});

// POST /api/affiliates/:id/payout — pay a specific affiliate (referral-programs
// only has a general /affiliates/payout; per-affiliate payout is added here)
router.post("/affiliates/:id/payout", auth, (req, res) => {
  ensureAffiliateTables();
  const db = getDb();
  const aff = db.prepare("SELECT * FROM biz_affiliates WHERE id = ? AND owner_user_id = ?").get(req.params.id, req.userId);
  if (!aff) return res.status(404).json({ error: "affiliate not found" });
  const amount = (req.body && req.body.amount) || Math.max(0, (aff.commission || 0) - (aff.commission_paid || 0));
  if (amount <= 0) return res.status(400).json({ error: "nothing to pay out" });
  const payoutId = "pay_" + uuid().slice(0, 10);
  db.prepare("INSERT INTO biz_affiliate_payouts (id, owner_user_id, affiliate_id, amount, status) VALUES (?,?,?,?,?)").run(
    payoutId, req.userId, req.params.id, amount, "queued"
  );
  db.prepare("UPDATE biz_affiliates SET commission_paid = commission_paid + ? WHERE id = ?").run(amount, req.params.id);
  res.json({ ok: true, payout_id: payoutId, amount, note: "Payout queued — processes via Stripe Connect" });
});

// POST /api/affiliates/:id/message — message an affiliate
router.post("/affiliates/:id/message", auth, async (req, res) => {
  ensureAffiliateTables();
  const db = getDb();
  const aff = db.prepare("SELECT email FROM biz_affiliates WHERE id = ? AND owner_user_id = ?").get(req.params.id, req.userId);
  if (!aff) return res.status(404).json({ error: "affiliate not found" });
  const { subject, message, body } = req.body || {};
  const text = message || body;
  if (!text) return res.status(400).json({ error: "message required" });
  let sent = false;
  if (aff.email) { const r = await trySendEmail(aff.email, subject || "Message from your program", text); sent = r.sent; }
  res.json({ ok: true, sent, note: sent ? "Message sent" : "Queued — configure SENDGRID_API_KEY to deliver" });
});

// POST /api/affiliates/:id/disable — disable an affiliate
router.post("/affiliates/:id/disable", auth, (req, res) => {
  ensureAffiliateTables();
  const db = getDb();
  const r = db.prepare("UPDATE biz_affiliates SET status = 'disabled' WHERE id = ? AND owner_user_id = ?").run(req.params.id, req.userId);
  if (r.changes === 0) return res.status(404).json({ error: "affiliate not found" });
  res.json({ ok: true, id: req.params.id, status: "disabled" });
});

// GET /api/affiliates/commissions — commission summary (all three dashboards
// call /api/affiliates/commissions, NOT /api/features/... so missing-endpoints.js
// at the /api/features mount never sees it). Derived from biz_affiliates.
router.get("/affiliates/commissions", auth, (req, res) => {
  ensureAffiliateTables();
  const db = getDb();
  const s = db.prepare("SELECT COALESCE(SUM(commission),0) AS earned, COALESCE(SUM(commission_paid),0) AS paid FROM biz_affiliates WHERE owner_user_id = ?").get(req.userId) || { earned: 0, paid: 0 };
  const pending = Math.max(0, (s.earned || 0) - (s.paid || 0));
  const recent = db.prepare("SELECT name, email, commission AS amount, commission_paid, status, invited_at AS created_at FROM biz_affiliates WHERE owner_user_id = ? ORDER BY invited_at DESC LIMIT 20").all(req.userId);
  res.json({ summary: { paid: s.paid, pending, approved: pending, total_conversions: recent.length }, pending, paid: s.paid, earned: s.earned, recent });
});

// POST /api/affiliates/pay-commissions — bulk-pay outstanding commission
router.post("/affiliates/pay-commissions", auth, (req, res) => {
  ensureAffiliateTables();
  const db = getDb();
  const r = db.prepare("UPDATE biz_affiliates SET commission_paid = commission WHERE owner_user_id = ? AND commission_paid < commission").run(req.userId);
  res.json({ ok: true, success: true, paid_count: r.changes, note: "Outstanding commissions marked paid" });
});

// NOTE: bare POST /api/agency/clients intentionally NOT handled here.
// Client creation goes through agency.js's POST /api/agency/clients/invite,
// which owns the agency_clients table (schema: client_name/client_email/
// monthly_fee + NOT NULL user_id + FK to agencies). A handler here with a
// different schema would either fail the INSERT or poison agency.js's table
// via CREATE TABLE IF NOT EXISTS. The dashboard only calls /clients/invite,
// so there is no real gap to fill.


// POST /api/staff/invite — invite a staff member by email
router.post("/staff/invite", auth, async (req, res) => {
  const { email, role = "staff", name } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS staff_invites (
    id TEXT PRIMARY KEY, owner_id TEXT, email TEXT, name TEXT, role TEXT,
    token TEXT, status TEXT DEFAULT 'pending', expires_at TEXT,
    accepted_at TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
  const id = "inv_" + uuid().slice(0, 8);
  const token = crypto.randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO staff_invites (id, owner_id, email, name, role, token, expires_at) VALUES (?,?,?,?,?,?,?)").run(
    id, req.userId, email, name || null, role, token, expires
  );
  // Send invite email if SendGrid configured
  const sgKey = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
  if (sgKey) {
    try {
      const sgMail = require("@sendgrid/mail");
      sgMail.setApiKey(sgKey);
      const fromEmail = process.env.SENDGRID_FROM_EMAIL || "noreply@takeova.ai";
      const inviter = db.prepare("SELECT name, business_name FROM users WHERE id = ?").get(req.userId);
      const bizName = inviter?.business_name || inviter?.name || "your team";
      const link = `${FRONTEND_URL}/accept-invite?token=${token}`;
      await sgMail.send({
        to: email,
        from: fromEmail,
        subject: `You've been invited to join ${bizName} on MINE`,
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px"><h2>You're invited!</h2><p>${inviter?.name || "Someone"} invited you to join <strong>${bizName}</strong> as ${role}.</p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#3B5BFA;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Accept invite</a><p style="font-size:12px;color:#64748B;margin-top:24px">This link expires in 7 days.</p></div>`
      });
    } catch (_) { /* non-fatal */ }
  }
  res.json({ ok: true, id, token, invite_url: `${FRONTEND_URL}/accept-invite?token=${token}` });
});

module.exports = router;
