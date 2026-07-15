const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const crypto = require("crypto");

function getDb() { return require("../db/init").getDb(); }
function auth(req, res, next) { const m = require("../middleware/auth"); m.auth(req, res, next); }

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_store_apps (
      id TEXT PRIMARY KEY,
      developer_id TEXT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      description TEXT,
      short_desc TEXT,
      icon_url TEXT,
      screenshot_urls TEXT DEFAULT '[]',
      category TEXT,
      webhook_url TEXT,
      redirect_url TEXT,
      client_id TEXT UNIQUE,
      client_secret TEXT,
      scopes TEXT DEFAULT '[]',
      events TEXT DEFAULT '[]',
      iframe_url TEXT,
      price_monthly REAL DEFAULT 0,
      is_free INTEGER DEFAULT 1,
      is_featured INTEGER DEFAULT 0,
      installs INTEGER DEFAULT 0,
      rating REAL DEFAULT 0,
      rating_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS app_installs (
      id TEXT PRIMARY KEY,
      app_id TEXT,
      user_id TEXT,
      access_token TEXT UNIQUE,
      scopes TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(app_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS app_developers (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT,
      email TEXT,
      website TEXT,
      api_key TEXT UNIQUE,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      app_id TEXT,
      event TEXT,
      url TEXT,
      secret TEXT,
      active INTEGER DEFAULT 1,
      failures INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id TEXT PRIMARY KEY,
      webhook_id TEXT,
      event TEXT,
      payload TEXT,
      response_status INTEGER,
      response_body TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ═══════════════════════════════════════
// BROWSE APPS (public)
// ═══════════════════════════════════════

router.get("/", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { category, search, featured, sort } = req.query;
  let query = "SELECT id, name, slug, short_desc, icon_url, category, price_monthly, is_free, is_featured, installs, rating, rating_count FROM app_store_apps WHERE status = 'approved'";
  const params = [];
  if (category) { query += " AND category = ?"; params.push(category); }
  if (search) { query += " AND (name LIKE ? OR description LIKE ?)"; params.push("%" + search + "%", "%" + search + "%"); }
  if (featured === "1") { query += " AND is_featured = 1"; }
  query += sort === "popular" ? " ORDER BY installs DESC" : sort === "rating" ? " ORDER BY rating DESC" : " ORDER BY created_at DESC";
  query += " LIMIT 50";
  res.json({ apps: db.prepare(query).all(...params) });
});

router.get("/categories", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const cats = db.prepare("SELECT category, COUNT(*) as count FROM app_store_apps WHERE status = 'approved' GROUP BY category ORDER BY count DESC").all();
  res.json({ categories: cats });
});

router.get("/app/:idOrSlug", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const app = db.prepare("SELECT * FROM app_store_apps WHERE (id = ? OR slug = ?) AND status = 'approved'").get(req.params.idOrSlug, req.params.idOrSlug);
  if (!app) return res.status(404).json({ error: "App not found" });
  app.screenshot_urls = JSON.parse(app.screenshot_urls || "[]");
  app.scopes = JSON.parse(app.scopes || "[]");
  res.json({ app });
});

// ═══════════════════════════════════════
// INSTALL / UNINSTALL APPS
// ═══════════════════════════════════════

router.post("/install/:appId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  // Shared table with marketplace.js — ensure the hash column exists.
  try { db.exec("ALTER TABLE app_installs ADD COLUMN access_token_hash TEXT"); } catch(e) {}

  const app = db.prepare("SELECT * FROM app_store_apps WHERE id = ? AND status = 'approved'").get(req.params.appId);
  if (!app) return res.status(404).json({ error: "App not found" });

  const existing = db.prepare("SELECT * FROM app_installs WHERE app_id = ? AND user_id = ?").get(app.id, req.userId);
  if (existing?.status === "active") return res.json({ already_installed: true, install: { id: existing.id, app_id: existing.app_id, user_id: existing.user_id } });

  const accessToken = "mineapp_" + crypto.randomBytes(32).toString("hex");
  const accessTokenHash = require("crypto").createHash("sha256").update(accessToken).digest("hex");
  const id = uuid();
  // Store hash only — the raw token is returned to the installer once and
  // never persisted in plaintext. Matches the marketplace.js pattern.
  db.prepare("INSERT OR REPLACE INTO app_installs (id, app_id, user_id, access_token, access_token_hash, scopes, status) VALUES (?,?,?,?,?,?,?)")
    .run(id, app.id, req.userId, "", accessTokenHash, app.scopes || "[]", "active");

  db.prepare("UPDATE app_store_apps SET installs = installs + 1 WHERE id = ?").run(app.id);

  // Register webhooks for this user
  const events = JSON.parse(app.events || "[]");
  for (const event of events) {
    const whId = uuid();
    const secret = crypto.randomBytes(16).toString("hex");
    db.prepare("INSERT INTO webhooks (id, user_id, app_id, event, url, secret) VALUES (?,?,?,?,?,?)")
      .run(whId, req.userId, app.id, event, app.webhook_url, secret);
  }

  // Notify the app's webhook — SSRF-safe: block internal addresses, require HTTPS for token delivery
  if (app.webhook_url) {
    try {
      const _wp = new URL(app.webhook_url);
      const _wh = _wp.hostname.toLowerCase();
      const isInternal = /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/.test(_wh) ||
        ["::1", "0.0.0.0", "metadata.google.internal"].includes(_wh) ||
        _wh.endsWith(".local") || _wh.endsWith(".internal");
      if (!isInternal) {
        const isHttps = _wp.protocol === "https:";
        const installPayload = isHttps
          ? { event: "app.installed", user_id: req.userId, access_token: accessToken, scopes: JSON.parse(app.scopes || "[]") }
          : { event: "app.installed", user_id: req.userId, scopes: JSON.parse(app.scopes || "[]") }; // token omitted over plain http
        fetch(app.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(installPayload)
        }).catch(() => {});
      }
    } catch (_) { /* invalid URL — skip silently */ }
  }

  res.json({ success: true, install: { id, app_id: app.id, access_token: accessToken } });
});

router.delete("/uninstall/:appId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("UPDATE app_installs SET status = 'uninstalled' WHERE app_id = ? AND user_id = ?").run(req.params.appId, req.userId);
  db.prepare("DELETE FROM webhooks WHERE app_id = ? AND user_id = ?").run(req.params.appId, req.userId);
  db.prepare("UPDATE app_store_apps SET installs = MAX(installs - 1, 0) WHERE id = ?").run(req.params.appId);
  res.json({ success: true });
});

// My installed apps
router.get("/installed", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const installed = db.prepare(`
    SELECT ai.*, a.name, a.slug, a.icon_url, a.short_desc, a.category, a.iframe_url, a.price_monthly
    FROM app_installs ai JOIN app_store_apps a ON ai.app_id = a.id
    WHERE ai.user_id = ? AND ai.status = 'active'
  `).all(req.userId);
  res.json({ apps: installed });
});

// ═══════════════════════════════════════
// DEVELOPER PORTAL
// ═══════════════════════════════════════

router.post("/developer/register", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { name, email, website } = req.body;
  const existing = db.prepare("SELECT * FROM app_developers WHERE user_id = ?").get(req.userId);
  if (existing) return res.json({ developer: existing });
  const id = uuid();
  const apiKey = "minedev_" + crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO app_developers (id, user_id, name, email, website, api_key) VALUES (?,?,?,?,?,?)")
    .run(id, req.userId, name, email, website || "", apiKey);
  res.json({ developer: { id, name, email, api_key: apiKey } });
});

router.post("/developer/create-app", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const dev = db.prepare("SELECT * FROM app_developers WHERE user_id = ?").get(req.userId);
  if (!dev) return res.status(403).json({ error: "Register as developer first" });

  const { name, description, short_desc, icon_url, screenshot_urls, category, webhook_url, redirect_url, scopes, events, iframe_url, price_monthly } = req.body;

  // ─── Block apps that duplicate TAKEOVA's native features ───
  const BLOCKED_CATEGORIES = ["email marketing","email","crm","chatbot","chat","reviews","review","forms","form builder","seo","landing pages","page builder","invoicing","invoice","bookings","booking","memberships","membership","subscriptions","loyalty","rewards","referrals","affiliate","courses","course","community","blog","website builder","funnel","funnels","social proof","popup","popups","lead capture","automation"];
  const BLOCKED_KEYWORDS = ["email marketing","email campaign","email automation","newsletter","crm","customer relationship","chatbot","ai chat","live chat","review collection","review management","form builder","seo tool","seo audit","page builder","landing page","invoice generator","booking system","appointment","scheduling","membership","subscription","loyalty program","rewards program","referral program","affiliate","course creator","community platform","blog","funnel builder","popup","lead magnet"];

  const catLower = (category || "").toLowerCase().trim();
  const nameLower = (name || "").toLowerCase();
  const descLower = ((description || "") + " " + (short_desc || "")).toLowerCase();

  const blockedCat = BLOCKED_CATEGORIES.find(bc => catLower === bc || catLower.includes(bc));
  if (blockedCat) {
    return res.status(403).json({ error: `Apps in the "${blockedCat}" category are not allowed. MINE already has this feature built in natively. Build apps that integrate with external services instead.` });
  }

  const blockedKeyword = BLOCKED_KEYWORDS.find(bk => nameLower.includes(bk) || descLower.includes(bk));
  if (blockedKeyword) {
    return res.status(403).json({ error: `Apps that provide "${blockedKeyword}" functionality are not allowed. MINE already has this built in. Build apps that connect MINE to external services (shipping, accounting, analytics, etc.) instead.` });
  }

  // Validate webhook_url and redirect_url to prevent SSRF attacks
  const SSRF_BLOCKED = ["localhost","127.0.0.1","0.0.0.0","::1","169.254.169.254","metadata.google.internal"];
  for (const urlField of [webhook_url, redirect_url, iframe_url].filter(Boolean)) {
    try {
      const parsedUrl = new URL(urlField);
      const hostname = parsedUrl.hostname.toLowerCase();
      if (!["http:","https:"].includes(parsedUrl.protocol)) throw new Error("invalid protocol");
      if (SSRF_BLOCKED.some(b => hostname === b) || hostname.endsWith(".local") || hostname.endsWith(".internal") || /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) {
        return res.status(400).json({ error: "App URLs cannot target internal or private addresses" });
      }
    } catch {
      return res.status(400).json({ error: `Invalid URL in app registration: ${urlField}` });
    }
  }

  const id = uuid();
  const slug = (name || "app").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
  const clientId = "mine_" + crypto.randomBytes(16).toString("hex");
  const clientSecret = "minesec_" + crypto.randomBytes(32).toString("hex");

  db.prepare(`INSERT INTO app_store_apps (id, developer_id, name, slug, description, short_desc, icon_url, screenshot_urls, category, webhook_url, redirect_url, client_id, client_secret, scopes, events, iframe_url, price_monthly, is_free, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, dev.id, name, slug, description || "", short_desc || "", icon_url || "", JSON.stringify(screenshot_urls || []),
      category || "general", webhook_url || "", redirect_url || "", clientId, clientSecret,
      JSON.stringify(scopes || []), JSON.stringify(events || []), iframe_url || "",
      price_monthly || 0, (price_monthly || 0) === 0 ? 1 : 0, "pending");

  res.json({ success: true, app: { id, slug, client_id: clientId, client_secret: clientSecret }, message: "App submitted for review. It will appear in the marketplace once approved by an admin." });
});

router.get("/developer/my-apps", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const dev = db.prepare("SELECT id FROM app_developers WHERE user_id = ?").get(req.userId);
  if (!dev) return res.json({ apps: [] });
  const apps = db.prepare("SELECT * FROM app_store_apps WHERE developer_id = ? ORDER BY created_at DESC").all(dev.id);
  res.json({ apps });
});

// ═══════════════════════════════════════
// OAUTH — Apps request access to user data
// ═══════════════════════════════════════

router.post("/oauth/token", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { client_id, client_secret, user_access_token } = req.body;

  const app = db.prepare("SELECT * FROM app_store_apps WHERE client_id = ? AND client_secret = ?").get(client_id, client_secret);
  if (!app) return res.status(401).json({ error: "Invalid credentials" });

  // Hash the supplied token and look up by hash (legacy plaintext fallback).
  // Echo the SUPPLIED token back rather than the DB value — with hash-only
  // storage the DB column is empty anyway, and this preserves semantics
  // during the migration window.
  const tokenHash = require("crypto").createHash("sha256").update(user_access_token || "").digest("hex");
  const install = db.prepare(
    "SELECT * FROM app_installs WHERE (access_token_hash = ? OR access_token = ?) AND app_id = ? AND status = 'active'"
  ).get(tokenHash, user_access_token, app.id);
  if (!install) return res.status(403).json({ error: "App not installed by this user" });

  res.json({ access_token: user_access_token, scopes: JSON.parse(install.scopes || "[]"), user_id: install.user_id, app_id: app.id });
});

// App API middleware — validates app access tokens
function appAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token?.startsWith("mineapp_")) return res.status(401).json({ error: "Invalid app token" });
  const db = getDb();
  ensureTables(db);
  // Primary lookup: hash. Fallback: legacy plaintext column.
  const tokenHash = require("crypto").createHash("sha256").update(token).digest("hex");
  const install = db.prepare(
    "SELECT * FROM app_installs WHERE (access_token_hash = ? OR access_token = ?) AND status = 'active'"
  ).get(tokenHash, token);
  if (!install) return res.status(401).json({ error: "Invalid or revoked token" });
  req.userId = install.user_id;
  req.appId = install.app_id;
  req.appScopes = JSON.parse(install.scopes || "[]");
  next();
}

// Scoped data endpoints for apps
router.get("/api/contacts", appAuth, (req, res) => {
  if (!req.appScopes.includes("read:contacts")) return res.status(403).json({ error: "Missing scope: read:contacts" });
  const db = getDb();
  const contacts = db.prepare("SELECT * FROM contacts WHERE user_id = ?").all(req.userId).slice(0,500);
  res.json({ contacts });
});

router.get("/api/orders", appAuth, (req, res) => {
  if (!req.appScopes.includes("read:orders")) return res.status(403).json({ error: "Missing scope: read:orders" });
  const db = getDb();
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ orders: [] });
  const orders = db.prepare(`SELECT * FROM orders WHERE site_id IN (${sites.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 100`).all(...sites);
  res.json({ orders });
});

router.get("/api/products", appAuth, (req, res) => {
  if (!req.appScopes.includes("read:products")) return res.status(403).json({ error: "Missing scope: read:products" });
  const db = getDb();
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).slice(0,500).map(s => s.id);
  if (!sites.length) return res.json({ products: [] });
  const products = db.prepare(`SELECT * FROM products WHERE site_id IN (${sites.map(() => "?").join(",")}) ORDER BY created_at DESC`).all(...sites);
  res.json({ products });
});

router.get("/api/invoices", appAuth, (req, res) => {
  if (!req.appScopes.includes("read:invoices")) return res.status(403).json({ error: "Missing scope: read:invoices" });
  const db = getDb();
  const invoices = db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
  res.json({ invoices });
});

router.get("/api/bookings", appAuth, (req, res) => {
  if (!req.appScopes.includes("read:bookings")) return res.status(403).json({ error: "Missing scope: read:bookings" });
  const db = getDb();
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ bookings: [] });
  const bookings = db.prepare(`SELECT * FROM bookings WHERE site_id IN (${sites.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 100`).all(...sites);
  res.json({ bookings });
});

// Write endpoint — apps can push data back
router.post("/api/orders/:orderId/fulfill", appAuth, (req, res) => {
  if (!req.appScopes.includes("write:orders")) return res.status(403).json({ error: "Missing scope: write:orders" });
  const db = getDb();
  // Ownership check: verify the order belongs to the authenticated user's sites
  const userSites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!userSites.length) return res.status(403).json({ error: "Order not found" });
  const order = db.prepare(
    `SELECT id FROM orders WHERE id = ? AND site_id IN (${userSites.map(() => "?").join(",")})`
  ).get(req.params.orderId, ...userSites);
  if (!order) return res.status(403).json({ error: "Order not found or access denied" });
  const { tracking_number, carrier, label_url } = req.body;
  db.prepare("UPDATE orders SET status = 'shipped', tracking_number = ?, carrier = ?, label_url = ? WHERE id = ?")
    .run(tracking_number || "", carrier || "", label_url || "", req.params.orderId);
  res.json({ success: true });
});

// ═══════════════════════════════════════
// WEBHOOK SYSTEM — Fire events to installed apps
// ═══════════════════════════════════════

// This function is called from other route files when events happen
// Export it so features.js, platform.js etc can use it
async function fireWebhooks(userId, event, data) {
  try {
    const db = getDb();
    ensureTables(db);
    const hooks = db.prepare("SELECT * FROM webhooks WHERE user_id = ? AND event = ? AND active = 1").all(userId, event);

    for (const hook of hooks) {
      const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString(), user_id: userId });
      const signature = crypto.createHmac("sha256", hook.secret).update(payload).digest("hex");

      // Defense-in-depth SSRF check before firing.
      // Hooks here come from approved-app webhook_url fields, but a
      // compromised or malicious approved app could point them inside
      // TAKEOVA's own network. Matches marketplace.js fireWebhooks guard.
      try {
        const _hp = new URL(hook.url);
        const _hh = _hp.hostname.toLowerCase();
        const isPrivate = _hp.protocol !== "https:" ||
          /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(_hh) ||
          ["::1","0.0.0.0","metadata.google.internal","metadata"].includes(_hh) ||
          _hh.endsWith(".local") || _hh.endsWith(".internal") ||
          /^fe80:/.test(_hh) || /^(fc|fd)[0-9a-f]{2}:/.test(_hh);
        if (isPrivate) {
          db.prepare("UPDATE webhooks SET active = 0 WHERE id = ?").run(hook.id);
          continue;
        }
      } catch (_) {
        db.prepare("UPDATE webhooks SET active = 0 WHERE id = ?").run(hook.id);
        continue;
      }

      try {
        const resp = await fetch(hook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mine-Signature": signature,
            "X-Mine-Event": event
          },
          body: payload,
          timeout: 10000,
          redirect: "error", // a 302 to a private IP would bypass the pre-check
        });
        db.prepare("INSERT INTO webhook_logs (id, webhook_id, event, payload, response_status, created_at) VALUES (?,?,?,?,?,datetime('now'))")
          .run(uuid(), hook.id, event, payload.substring(0, 2000), resp.status);
        if (!resp.ok) {
          db.prepare("UPDATE webhooks SET failures = failures + 1 WHERE id = ?").run(hook.id);
          if (hook.failures >= 10) db.prepare("UPDATE webhooks SET active = 0 WHERE id = ?").run(hook.id);
        } else {
          db.prepare("UPDATE webhooks SET failures = 0 WHERE id = ?").run(hook.id);
        }
      } catch (e) {
        db.prepare("UPDATE webhooks SET failures = failures + 1 WHERE id = ?").run(hook.id);
      }
    }
  } catch(e) { console.error("[/:orderId/fulfill]", e.message || e); }
}

// Manual webhook test
router.post("/webhooks/test", auth, (req, res) => {
  const { event, data } = req.body;
  fireWebhooks(req.userId, event || "test.event", data || { test: true });
  res.json({ success: true, message: "Webhook fired" });
});

// View webhook logs
router.get("/webhooks/logs", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const hooks = db.prepare("SELECT id FROM webhooks WHERE user_id = ?").all(req.userId).map(h => h.id);
  if (!hooks.length) return res.json({ logs: [] });
  const logs = db.prepare(`SELECT * FROM webhook_logs WHERE webhook_id IN (${hooks.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 50`).all(...hooks);
  res.json({ logs });
});

// ═══════════════════════════════════════
// ADMIN — approve/reject apps
// ═══════════════════════════════════════

router.get("/admin/pending", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const apps = db.prepare("SELECT * FROM app_store_apps WHERE status = 'pending' ORDER BY created_at DESC").all();
  res.json({ apps });
});

router.put("/admin/:appId/approve", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  db.prepare("UPDATE app_store_apps SET status = 'approved' WHERE id = ?").run(req.params.appId);
  res.json({ success: true });
});

router.put("/admin/:appId/reject", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  db.prepare("UPDATE app_store_apps SET status = 'rejected' WHERE id = ?").run(req.params.appId);
  res.json({ success: true });
});

// Seed first-party apps
router.post("/admin/seed", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });

  const apps = [
    { name: "QuickBooks", slug: "quickbooks", category: "accounting", short_desc: "Auto-sync orders, invoices, and revenue to QuickBooks. Two-way sync keeps books up to date.", icon_url: "📗", scopes: ["read:orders", "read:invoices", "read:contacts"], events: ["order.created", "invoice.paid", "invoice.created"], is_featured: 1 },
    { name: "Xero Accounting", slug: "xero", category: "accounting", short_desc: "Sync invoices, payments, and expenses with Xero. Automatic reconciliation and tax categorization.", icon_url: "📒", scopes: ["read:orders", "read:invoices"], events: ["order.created", "invoice.paid"] },
    { name: "ShipStation", slug: "shipstation", category: "shipping", short_desc: "Print shipping labels, compare carrier rates (UPS, FedEx, DHL, USPS), track packages, auto-update orders.", icon_url: "📦", scopes: ["read:orders", "write:orders"], events: ["order.created", "order.paid"], is_featured: 1 },
    { name: "Printful", slug: "printful", category: "shipping", short_desc: "Print-on-demand fulfilment. Design custom merch — Printful prints and ships to your customers.", icon_url: "👕", scopes: ["read:orders", "read:products", "write:orders"], events: ["order.created"], is_featured: 1 },
    { name: "DSers Dropshipping", slug: "dsers", category: "shipping", short_desc: "Import AliExpress products in bulk, auto-fulfil orders to suppliers, find cheaper alternatives.", icon_url: "🚚", scopes: ["read:orders", "read:products", "write:orders", "write:products"], events: ["order.created"] },
    { name: "Zapier", slug: "zapier", category: "automation", short_desc: "Connect MINE to 7,000+ apps. Trigger Zaps on orders, contacts, bookings, form submissions, and more.", icon_url: "⚡", scopes: ["read:contacts", "read:orders", "read:products", "read:bookings", "read:invoices"], events: ["order.created", "contact.created", "booking.created", "invoice.paid", "form.submitted"], is_featured: 1 },
    { name: "Google Analytics 4", slug: "google-analytics", category: "analytics", short_desc: "Deep analytics with e-commerce tracking, conversion funnels, audience segments, and attribution modelling.", icon_url: "📊", scopes: ["read:site", "read:orders"], events: ["site.published"], is_featured: 1 },
    { name: "Facebook & Instagram Pixel", slug: "meta-pixel", category: "marketing", short_desc: "Track Meta ad conversions, build retargeting audiences. Auto-fires pixel events on all published pages.", icon_url: "📘", scopes: ["read:orders", "read:site", "read:products"], events: ["order.created"], is_featured: 1 },
    { name: "TikTok Pixel", slug: "tiktok-pixel", category: "marketing", short_desc: "Track TikTok ad conversions. Auto-fires pixel events for page views, add-to-cart, and purchases.", icon_url: "🎵", scopes: ["read:orders", "read:site", "read:products"], events: ["order.created"] },
    { name: "Google Calendar Sync", slug: "google-calendar", category: "productivity", short_desc: "Two-way sync between MINE bookings and Google Calendar. Avoid double-bookings.", icon_url: "📅", scopes: ["read:bookings", "write:bookings"], events: ["booking.created", "booking.cancelled"], is_featured: 1 },
    { name: "Zoom Meetings", slug: "zoom-meetings", category: "productivity", short_desc: "Auto-generate Zoom meeting links when a booking is confirmed. Works for 1-on-1 and group sessions.", icon_url: "🎥", scopes: ["read:bookings"], events: ["booking.created"] },
    { name: "Slack Notifications", slug: "slack-notifications", category: "productivity", short_desc: "Push real-time alerts to your team's Slack — orders, bookings, reviews, form submissions, payments.", icon_url: "💬", scopes: ["read:orders", "read:bookings", "read:contacts"], events: ["order.created", "booking.created", "form.submitted", "review.posted", "invoice.paid"], is_featured: 1 },
    { name: "WhatsApp Business API", slug: "whatsapp-business", category: "communication", short_desc: "Send order confirmations, booking reminders, and shipping updates to customers via WhatsApp.", icon_url: "💚", scopes: ["read:contacts", "read:orders", "read:bookings"], events: ["order.created", "booking.created", "order.shipped"] },
    { name: "AfterShip Order Tracking", slug: "aftership", category: "shipping", short_desc: "Branded order tracking page on your site. Customers check shipping status without emailing support.", icon_url: "🔍", scopes: ["read:orders", "write:orders"], events: ["order.shipped"], is_featured: 1 },
    { name: "Stripe Terminal", slug: "stripe-terminal", category: "payments", short_desc: "Accept in-person card payments with Stripe card readers. Syncs transactions back to your TAKEOVA store.", icon_url: "💳", scopes: ["read:orders", "write:orders", "read:products"], events: [] },
  ];

  let created = 0;
  for (const a of apps) {
    const existing = db.prepare("SELECT id FROM app_store_apps WHERE slug = ?").get(a.slug);
    if (!existing) {
      db.prepare(`INSERT INTO app_store_apps (id, name, slug, short_desc, icon_url, category, scopes, events, is_free, is_featured, status) VALUES (?,?,?,?,?,?,?,?,1,?,?)`)
        .run(uuid(), a.name, a.slug, a.short_desc, a.icon_url, a.category, JSON.stringify(a.scopes), JSON.stringify(a.events), a.is_featured || 0, "approved");
      created++;
    }
  }
  res.json({ success: true, created, total: apps.length });
});

module.exports = router;
module.exports.fireWebhooks = fireWebhooks;
