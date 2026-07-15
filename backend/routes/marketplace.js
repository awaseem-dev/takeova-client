const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const crypto = require("crypto");

function getDb() { return require("../db/init").getDb(); }
function auth(req, res, next) { const m = require("../middleware/auth"); m.auth(req, res, next); }

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      developer_id TEXT,
      developer_name TEXT,
      description TEXT,
      short_desc TEXT,
      icon_url TEXT,
      screenshot_urls TEXT DEFAULT '[]',
      category TEXT,
      price REAL DEFAULT 0,
      price_interval TEXT DEFAULT 'month',
      is_free INTEGER DEFAULT 1,
      is_featured INTEGER DEFAULT 0,
      installs INTEGER DEFAULT 0,
      rating REAL DEFAULT 0,
      rating_count INTEGER DEFAULT 0,
      scopes TEXT DEFAULT '[]',
      webhook_url TEXT,
      webhook_events TEXT DEFAULT '[]',
      redirect_url TEXT,
      iframe_url TEXT,
      client_id TEXT UNIQUE,
      client_secret TEXT,
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
      installed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(app_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      app_id TEXT,
      url TEXT NOT NULL,
      events TEXT DEFAULT '[]',
      secret TEXT,
      status TEXT DEFAULT 'active',
      failures INTEGER DEFAULT 0,
      last_fired TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id TEXT PRIMARY KEY,
      webhook_id TEXT,
      event TEXT,
      payload TEXT,
      response_status INTEGER,
      response_body TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS app_reviews (
      id TEXT PRIMARY KEY,
      app_id TEXT,
      user_id TEXT,
      rating INTEGER,
      review TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ═══════════════════════════════════════════════════════════
// BROWSE APPS (public)
// ═══════════════════════════════════════════════════════════

router.get("/apps", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { category, search, featured, sort } = req.query;
  let q = "SELECT id, name, slug, developer_name, short_desc, icon_url, category, price, is_free, is_featured, installs, rating, rating_count, scopes FROM marketplace_apps WHERE status = 'active'";
  const params = [];
  if (category) { q += " AND category = ?"; params.push(category); }
  if (search) { q += " AND (name LIKE ? OR description LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  if (featured === "true") { q += " AND is_featured = 1"; }
  const sortMap = { popular: "installs DESC", newest: "created_at DESC", rated: "rating DESC" };
  q += " ORDER BY " + (sortMap[sort] || "is_featured DESC, installs DESC") + " LIMIT 50";
  const apps = db.prepare(q).all(...params).map(a => ({ ...a, scopes: JSON.parse(a.scopes || "[]") }));
  res.json({ apps });
});

router.get("/apps/meta/categories", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const cats = db.prepare("SELECT category, COUNT(*) as count FROM marketplace_apps WHERE status = 'active' GROUP BY category ORDER BY count DESC").all();
  res.json({ categories: cats });
});

router.get("/apps/:idOrSlug", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const app = db.prepare("SELECT * FROM marketplace_apps WHERE (id = ? OR slug = ?) AND status = 'active'").get(req.params.idOrSlug, req.params.idOrSlug);
  if (!app) return res.status(404).json({ error: "App not found" });
  const reviews = db.prepare("SELECT ar.*, u.name as user_name FROM app_reviews ar LEFT JOIN users u ON ar.user_id = u.id WHERE ar.app_id = ? ORDER BY ar.created_at DESC LIMIT 20").all(app.id);
  // Strip sensitive credentials before returning to public callers
  const { client_secret, webhook_secret, developer_id, ...publicApp } = app;
  res.json({ app: { ...publicApp, scopes: JSON.parse(app.scopes || "[]"), webhook_events: JSON.parse(app.webhook_events || "[]"), screenshot_urls: JSON.parse(app.screenshot_urls || "[]") }, reviews });
});

// ═══════════════════════════════════════════════════════════
// INSTALL APP (OAuth flow)
// ═══════════════════════════════════════════════════════════

router.post("/apps/:id/install", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  // Ensure hash column exists — one-time migration.
  try { db.exec("ALTER TABLE app_installs ADD COLUMN access_token_hash TEXT"); } catch(e) {}

  const app = db.prepare("SELECT * FROM marketplace_apps WHERE id = ? AND status = 'active'").get(req.params.id);
  if (!app) return res.status(404).json({ error: "App not found" });

  // Check if already installed — if active, rotate the token rather than
  // re-returning the old one. With hash-at-rest we can't recover the raw
  // token anyway, so rotation is the correct semantic.
  const existing = db.prepare("SELECT * FROM app_installs WHERE app_id = ? AND user_id = ?").get(app.id, req.userId);

  // Generate scoped access token
  const accessToken = "mine_app_" + crypto.randomBytes(32).toString("hex");
  const accessTokenHash = require("crypto").createHash("sha256").update(accessToken).digest("hex");
  const scopes = JSON.parse(app.scopes || "[]");

  if (existing) {
    db.prepare("UPDATE app_installs SET access_token = ?, access_token_hash = ?, scopes = ?, status = 'active' WHERE id = ?")
      .run("", accessTokenHash, JSON.stringify(scopes), existing.id);
  } else {
    db.prepare("INSERT INTO app_installs (id, app_id, user_id, access_token, access_token_hash, scopes) VALUES (?,?,?,?,?,?)")
      .run(uuid(), app.id, req.userId, "", accessTokenHash, JSON.stringify(scopes));
    db.prepare("UPDATE marketplace_apps SET installs = installs + 1 WHERE id = ?").run(app.id);
  }

  // Register webhooks for this user if app has webhook_url
  const webhookEvents = JSON.parse(app.webhook_events || "[]");
  if (app.webhook_url && webhookEvents.length) {
    const existingHook = db.prepare("SELECT id FROM webhooks WHERE user_id = ? AND app_id = ?").get(req.userId, app.id);
    const secret = crypto.randomBytes(16).toString("hex");
    if (!existingHook) {
      db.prepare("INSERT INTO webhooks (id, user_id, app_id, url, events, secret) VALUES (?,?,?,?,?,?)")
        .run(uuid(), req.userId, app.id, app.webhook_url, JSON.stringify(webhookEvents), secret);
    }
  }

  res.json({ success: true, access_token: accessToken, scopes, iframe_url: app.iframe_url ? app.iframe_url + "?token=" + accessToken : null });
});

// Uninstall app
router.delete("/apps/:id/uninstall", auth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE app_installs SET status = 'uninstalled' WHERE app_id = ? AND user_id = ?").run(req.params.id, req.userId);
  db.prepare("UPDATE webhooks SET status = 'disabled' WHERE app_id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// List user's installed apps
router.get("/my-apps", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const installs = db.prepare(`
    SELECT ai.*, ma.name, ma.slug, ma.icon_url, ma.short_desc, ma.category, ma.iframe_url
    FROM app_installs ai JOIN marketplace_apps ma ON ai.app_id = ma.id
    WHERE ai.user_id = ? AND ai.status = 'active'
    ORDER BY ai.installed_at DESC
  `).all(req.userId);
  res.json({ apps: installs });
});

// ═══════════════════════════════════════════════════════════
// APP API — Third-party apps call these with their access_token
// Middleware validates token + scopes
// ═══════════════════════════════════════════════════════════

function appAuth(requiredScope) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Access token required" });
    const db = getDb();
    // Primary lookup: hashed token (SHA-256). Fallback: legacy plaintext
    // column for installs done before the hash migration. Legacy rows
    // naturally age out as apps are reinstalled.
    const tokenHash = require("crypto").createHash("sha256").update(token).digest("hex");
    const install = db.prepare(
      "SELECT ai.*, ma.name as app_name FROM app_installs ai JOIN marketplace_apps ma ON ai.app_id = ma.id WHERE (ai.access_token_hash = ? OR ai.access_token = ?) AND ai.status = 'active'"
    ).get(tokenHash, token);
    if (!install) return res.status(401).json({ error: "Invalid or revoked token" });
    const scopes = JSON.parse(install.scopes || "[]");
    if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes("*")) {
      return res.status(403).json({ error: `Missing scope: ${requiredScope}`, required: requiredScope, granted: scopes });
    }
    req.appUserId = install.user_id;
    req.appId = install.app_id;
    req.appName = install.app_name;
    next();
  };
}

// Contacts
router.get("/api/contacts", appAuth("read:contacts"), (req, res) => {
  const db = getDb();
  const contacts = db.prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.appUserId);
  res.json({ contacts });
});

router.post("/api/contacts", appAuth("write:contacts"), (req, res) => {
  const db = getDb();
  const { name, email, phone, status, notes, tags } = req.body;
  const id = uuid();
  db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, status, notes, tags, source) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, req.appUserId, name, email, phone, status || "lead", notes || "", JSON.stringify(tags || []), req.appName);
  res.json({ success: true, id });
});

// Orders
router.get("/api/orders", appAuth("read:orders"), (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT id FROM sites WHERE user_id = ? LIMIT 1").get(req.appUserId);
  if (!site) return res.json({ orders: [] });
  const orders = db.prepare("SELECT * FROM orders WHERE site_id = ? ORDER BY created_at DESC LIMIT 100").all(site.id);
  res.json({ orders });
});

router.put("/api/orders/:orderId/fulfill", appAuth("write:orders"), (req, res) => {
  const db = getDb();
  // Ownership check — verify the order belongs to the authenticated app user's sites
  const userSites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.appUserId).map(s => s.id);
  if (!userSites.length) return res.status(403).json({ error: "Order not found" });
  const order = db.prepare(
    `SELECT id FROM orders WHERE id = ? AND site_id IN (${userSites.map(() => "?").join(",")})`
  ).get(req.params.orderId, ...userSites);
  if (!order) return res.status(403).json({ error: "Order not found or access denied" });
  const { tracking_number, carrier, label_url } = req.body;
  db.prepare("UPDATE orders SET status = 'shipped', tracking_number = ?, carrier = ?, label_url = ?, updated_at = datetime('now') WHERE id = ?")
    .run(tracking_number || "", carrier || "", label_url || "", req.params.orderId);
  res.json({ success: true });
});

// Products
router.get("/api/products", appAuth("read:products"), (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT id FROM sites WHERE user_id = ? LIMIT 1").get(req.appUserId);
  if (!site) return res.json({ products: [] });
  const products = db.prepare("SELECT * FROM products WHERE site_id = ? ORDER BY created_at DESC").all(site.id);
  res.json({ products });
});

// Invoices
router.get("/api/invoices", appAuth("read:invoices"), (req, res) => {
  const db = getDb();
  const invoices = db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.appUserId);
  res.json({ invoices });
});

router.post("/api/invoices", appAuth("write:invoices"), (req, res) => {
  const db = getDb();
  const { client_name, client_email, items, total, due_date } = req.body;
  const id = uuid();
  const number = "INV-" + Date.now().toString(36).toUpperCase();
  db.prepare("INSERT INTO invoices (id, user_id, number, client_name, client_email, items_json, total, due_date, status) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, req.appUserId, number, client_name, client_email, JSON.stringify(items || []), total || 0, due_date || "", "draft");
  res.json({ success: true, id, number });
});

// Bookings
router.get("/api/bookings", appAuth("read:bookings"), (req, res) => {
  const db = getDb();
  const bookings = db.prepare("SELECT * FROM bookings WHERE user_id = ? ORDER BY date DESC LIMIT 100").all(req.appUserId);
  res.json({ bookings });
});

// Site info
router.get("/api/site", appAuth("read:site"), (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT id, name, domain, custom_domain, primary_color, secondary_color, settings_json FROM sites WHERE user_id = ? LIMIT 1").get(req.appUserId);
  res.json({ site });
});

// ═══════════════════════════════════════════════════════════
// WEBHOOK SYSTEM — Fire webhooks when events occur
// ═══════════════════════════════════════════════════════════

// This function is called by other routes when events happen
// Import and call: require("./marketplace").fireWebhooks(userId, event, data)
async function fireWebhooks(userId, event, data) {
  const db = getDb();
  try {
    ensureTables(db);
    const hooks = db.prepare("SELECT * FROM webhooks WHERE user_id = ? AND status = 'active'").all(userId);

    for (const hook of hooks) {
      const events = JSON.parse(hook.events || "[]");
      if (!events.includes(event) && !events.includes("*")) continue;

      const payload = JSON.stringify({ event, data, timestamp: Date.now(), user_id: userId });
      const signature = crypto.createHmac("sha256", hook.secret || "").update(payload).digest("hex");
      const start = Date.now();

      try {
        // Defense-in-depth SSRF check before firing.
        // Coverage matches appstore.js and features.js fireWebhooks — IPv4
        // private ranges, IPv6 loopback/ULA/link-local, cloud metadata hosts.
        try {
          const _hp = new URL(hook.url);
          const _hh = _hp.hostname.toLowerCase();
          const isPrivate = _hp.protocol !== "https:" ||
            /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(_hh) ||
            ["::1","0.0.0.0","metadata.google.internal","metadata"].includes(_hh) ||
            _hh.endsWith(".local") || _hh.endsWith(".internal") ||
            /^fe80:/.test(_hh) || /^(fc|fd)[0-9a-f]{2}:/.test(_hh);
          if (isPrivate) throw new Error("Blocked: internal webhook URL");
        } catch(ssrfErr) {
          db.prepare("UPDATE webhooks SET status = 'disabled' WHERE id = ?").run(hook.id);
          continue;
        }
        const fetch = (await import("node-fetch")).default;
        const resp = await fetch(hook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mine-Signature": signature,
            "X-Mine-Event": event
          },
          body: payload,
          timeout: 10000,
          redirect: "error",
        });

        db.prepare("INSERT INTO webhook_logs (id, webhook_id, event, payload, response_status, duration_ms) VALUES (?,?,?,?,?,?)")
          .run(uuid(), hook.id, event, payload, resp.status, Date.now() - start);
        db.prepare("UPDATE webhooks SET last_fired = datetime('now'), failures = 0 WHERE id = ?").run(hook.id);

      } catch (e) {
        const failures = (hook.failures || 0) + 1;
        db.prepare("UPDATE webhooks SET failures = ? WHERE id = ?").run(failures, hook.id);
        if (failures >= 10) {
          db.prepare("UPDATE webhooks SET status = 'disabled' WHERE id = ?").run(hook.id);
        }
        db.prepare("INSERT INTO webhook_logs (id, webhook_id, event, payload, response_status, response_body, duration_ms) VALUES (?,?,?,?,?,?,?)")
          .run(uuid(), hook.id, event, payload, 0, e.message, Date.now() - start);
      }
    }
  } catch(e) { console.error("[/api/site]", e.message || e); }
}

// User webhook management (users can also add their own webhooks without apps)
router.get("/webhooks", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const hooks = db.prepare("SELECT w.*, ma.name as app_name FROM webhooks w LEFT JOIN marketplace_apps ma ON w.app_id = ma.id WHERE w.user_id = ? ORDER BY w.created_at DESC").all(req.userId);
  res.json({ webhooks: hooks.map(h => ({ ...h, events: JSON.parse(h.events || "[]") })) });
});

router.post("/webhooks", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { url, events } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });
  // Validate webhook URL: must be https, must not target private/internal IP ranges (SSRF prevention)
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return res.status(400).json({ error: "Webhook URL must use HTTPS" });
    const hostname = parsed.hostname.toLowerCase();
    const blocked = ["localhost","127.0.0.1","0.0.0.0","::1","169.254.169.254","metadata.google.internal"];
    if (blocked.some(b => hostname === b) || hostname.endsWith(".local") || hostname.endsWith(".internal") || /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) {
      return res.status(400).json({ error: "Webhook URL cannot target internal or private addresses" });
    }
  } catch { return res.status(400).json({ error: "Invalid webhook URL" }); }
  const secret = crypto.randomBytes(16).toString("hex");
  const id = uuid();
  db.prepare("INSERT INTO webhooks (id, user_id, url, events, secret) VALUES (?,?,?,?,?)")
    .run(id, req.userId, url, JSON.stringify(events || ["*"]), secret);
  res.json({ success: true, id, secret, message: "Use this secret to verify webhook signatures" });
});

router.delete("/webhooks/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM webhooks WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// Webhook logs
router.get("/webhooks/:id/logs", auth, (req, res) => {
  const db = getDb();
  // Verify the webhook belongs to the requesting user — otherwise any
  // authenticated user could read another user's webhook logs, which
  // contain full event payloads (orders, contacts, etc).
  const hook = db.prepare("SELECT id FROM webhooks WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!hook) return res.status(404).json({ error: "Webhook not found" });
  const logs = db.prepare("SELECT * FROM webhook_logs WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50").all(req.params.id);
  res.json({ logs });
});

// Available webhook events
router.get("/webhooks/events/list", (req, res) => {
  try {
    res.json({
      events: [
        { event: "order.created", description: "New order placed" },
        { event: "order.paid", description: "Order payment received" },
        { event: "order.shipped", description: "Order marked as shipped" },
        { event: "order.cancelled", description: "Order cancelled" },
        { event: "contact.created", description: "New contact added" },
        { event: "contact.updated", description: "Contact info changed" },
        { event: "invoice.created", description: "New invoice created" },
        { event: "invoice.paid", description: "Invoice payment received" },
        { event: "booking.created", description: "New booking made" },
        { event: "booking.cancelled", description: "Booking cancelled" },
        { event: "form.submitted", description: "Form submission received" },
        { event: "review.posted", description: "New review posted" },
        { event: "product.created", description: "New product added" },
        { event: "product.updated", description: "Product details changed" },
        { event: "subscription.created", description: "New subscription started" },
        { event: "subscription.cancelled", description: "Subscription cancelled" },
        { event: "chatbot.conversation", description: "Chatbot conversation completed" },
        { event: "site.published", description: "Site published/deployed" }
      ]
    });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════════════════════════
// DEVELOPER PORTAL — Register apps
// ═══════════════════════════════════════════════════════════

router.post("/developer/register", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { name, description, short_desc, icon_url, category, price, scopes, webhook_url, webhook_events, redirect_url, iframe_url } = req.body;
  if (!name) return res.status(400).json({ error: "App name required" });

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

  const id = uuid();
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
  const clientId = "mine_" + crypto.randomBytes(8).toString("hex");
  const clientSecret = "ms_" + crypto.randomBytes(32).toString("hex");

  const user = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);

  // Validate webhook_url if provided — prevent SSRF when webhooks are fired
  if (webhook_url) {
    try {
      const wParsed = new URL(webhook_url);
      if (wParsed.protocol !== "https:") return res.status(400).json({ error: "webhook_url must use HTTPS" });
      const wHost = wParsed.hostname.toLowerCase();
      const blockedHosts = ["localhost","127.0.0.1","0.0.0.0","::1","169.254.169.254","metadata.google.internal"];
      if (blockedHosts.some(b => wHost === b) || wHost.endsWith(".local") || wHost.endsWith(".internal") ||
          /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/.test(wHost)) {
        return res.status(400).json({ error: "webhook_url cannot target internal addresses" });
      }
    } catch { return res.status(400).json({ error: "Invalid webhook_url" }); }
  }

  db.prepare(`INSERT INTO marketplace_apps (id, name, slug, developer_id, developer_name, description, short_desc, icon_url, category, price, is_free, scopes, webhook_url, webhook_events, redirect_url, iframe_url, client_id, client_secret, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, slug, req.userId, user?.name || "Developer", description || "", short_desc || "", icon_url || "",
      category || "tools", price || 0, (price || 0) === 0 ? 1 : 0,
      JSON.stringify(scopes || []), webhook_url || "", JSON.stringify(webhook_events || []),
      redirect_url || "", iframe_url || "", clientId, clientSecret, "active");

  res.json({ success: true, id, slug, client_id: clientId, client_secret: clientSecret, message: "App published! It's now live in the marketplace." });
});

// Developer's apps
router.get("/developer/my-apps", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const apps = db.prepare("SELECT * FROM marketplace_apps WHERE developer_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ apps: apps.map(a => ({ ...a, scopes: JSON.parse(a.scopes || "[]"), webhook_events: JSON.parse(a.webhook_events || "[]") })) });
});

// Admin: Approve/reject apps
router.put("/admin/apps/:id/status", auth, (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { status } = req.body;
  if (!["active", "rejected", "suspended"].includes(status)) return res.status(400).json({ error: "Invalid status" });
  db.prepare("UPDATE marketplace_apps SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ success: true });
});

// App reviews
router.post("/apps/:id/review", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { rating, review } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating 1-5 required" });
  const existing = db.prepare("SELECT id FROM app_reviews WHERE app_id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (existing) {
    db.prepare("UPDATE app_reviews SET rating = ?, review = ? WHERE id = ?").run(rating, review || "", existing.id);
  } else {
    db.prepare("INSERT INTO app_reviews (id, app_id, user_id, rating, review) VALUES (?,?,?,?,?)").run(uuid(), req.params.id, req.userId, rating, review || "");
  }
  const avg = db.prepare("SELECT AVG(rating) as avg, COUNT(*) as count FROM app_reviews WHERE app_id = ?").get(req.params.id);
  db.prepare("UPDATE marketplace_apps SET rating = ?, rating_count = ? WHERE id = ?").run(Math.round((avg.avg || 0) * 10) / 10, avg.count, req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// SEED: First-party integrations
// ═══════════════════════════════════════════════════════════

router.post("/admin/seed", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });

  const apps = [
    { name: "QuickBooks", slug: "quickbooks", category: "accounting", short_desc: "Auto-sync orders, invoices, and revenue to QuickBooks. Two-way sync keeps your books always up to date.", icon_url: "📗", scopes: ["read:orders", "read:invoices", "read:contacts"], webhook_events: ["order.created", "invoice.paid", "invoice.created"], is_featured: 1, price: 9 },
    { name: "Xero Accounting", slug: "xero", category: "accounting", short_desc: "Sync invoices, payments, and expenses with Xero. Automatic reconciliation and tax categorization.", icon_url: "📒", scopes: ["read:orders", "read:invoices"], webhook_events: ["order.created", "invoice.paid"], price: 9 },
    { name: "ShipStation", slug: "shipstation", category: "shipping", short_desc: "Print shipping labels, compare carrier rates (UPS, FedEx, DHL, USPS), track packages, and auto-update order status.", icon_url: "📦", scopes: ["read:orders", "write:orders"], webhook_events: ["order.created", "order.paid"], is_featured: 1, price: 14 },
    { name: "Printful", slug: "printful", category: "shipping", short_desc: "Print-on-demand fulfilment. Design custom merch — t-shirts, mugs, posters. Printful prints and ships to your customers.", icon_url: "👕", scopes: ["read:orders", "read:products", "write:orders"], webhook_events: ["order.created"], is_featured: 1, price: 0 },
    { name: "DSers Dropshipping", slug: "dsers", category: "shipping", short_desc: "Import AliExpress products in bulk, auto-fulfil orders to suppliers, find cheaper suppliers for same products.", icon_url: "🚚", scopes: ["read:orders", "read:products", "write:orders", "write:products"], webhook_events: ["order.created"], price: 0 },
    { name: "Zapier", slug: "zapier", category: "automation", short_desc: "Connect MINE to 7,000+ apps. Trigger Zaps on new orders, contacts, bookings, form submissions, and more.", icon_url: "⚡", scopes: ["*"], webhook_events: ["*"], is_featured: 1, price: 0 },
    { name: "Google Analytics 4", slug: "google-analytics", category: "analytics", short_desc: "Deep analytics with e-commerce tracking, conversion funnels, audience segments, and attribution modelling. Auto-installs GA4 tag.", icon_url: "📊", scopes: ["read:site", "read:orders"], is_featured: 1, price: 0 },
    { name: "Facebook & Instagram Pixel", slug: "meta-pixel", category: "marketing", short_desc: "Track ad conversions, build retargeting audiences, and optimise Meta ad campaigns. Auto-fires pixel events on all pages.", icon_url: "📘", scopes: ["read:orders", "read:site", "read:products"], webhook_events: ["order.created"], is_featured: 1, price: 0 },
    { name: "TikTok Pixel", slug: "tiktok-pixel", category: "marketing", short_desc: "Track TikTok ad conversions. Auto-fires pixel events for page views, add-to-cart, and purchases.", icon_url: "🎵", scopes: ["read:orders", "read:site", "read:products"], webhook_events: ["order.created"], price: 0 },
    { name: "Google Calendar Sync", slug: "google-calendar", category: "productivity", short_desc: "Two-way sync between MINE bookings and Google Calendar. Avoid double-bookings, see all appointments in one place.", icon_url: "📅", scopes: ["read:bookings", "write:bookings"], webhook_events: ["booking.created", "booking.cancelled"], is_featured: 1, price: 0 },
    { name: "Zoom Meetings", slug: "zoom", category: "productivity", short_desc: "Auto-generate Zoom meeting links when a booking is confirmed. Works for 1-on-1 sessions and group courses.", icon_url: "🎥", scopes: ["read:bookings"], webhook_events: ["booking.created"], price: 0 },
    { name: "Slack Notifications", slug: "slack-notifications", category: "productivity", short_desc: "Push real-time alerts to your team's Slack channel — new orders, bookings, reviews, form submissions, and payments.", icon_url: "💬", scopes: ["read:orders", "read:bookings", "read:contacts"], webhook_events: ["order.created", "booking.created", "form.submitted", "review.posted", "invoice.paid"], is_featured: 1, price: 0 },
    { name: "WhatsApp Business API", slug: "whatsapp-business", category: "communication", short_desc: "Send order confirmations, booking reminders, and shipping updates to customers via WhatsApp. Two-way messaging.", icon_url: "💚", scopes: ["read:contacts", "read:orders", "read:bookings"], webhook_events: ["order.created", "booking.created", "order.shipped"], price: 12 },
    { name: "AfterShip Order Tracking", slug: "aftership", category: "shipping", short_desc: "Branded order tracking page on your site. Customers check shipping status without emailing support. Reduces support tickets 50%+.", icon_url: "🔍", scopes: ["read:orders", "write:orders"], webhook_events: ["order.shipped"], is_featured: 1, price: 0 },
    { name: "Stripe Terminal", slug: "stripe-terminal", category: "payments", short_desc: "Accept in-person card payments with Stripe card readers. Syncs transactions back to your TAKEOVA store as orders.", icon_url: "💳", scopes: ["read:orders", "write:orders", "read:products"], price: 0 },
  ];

  let created = 0;
  for (const a of apps) {
    const existing = db.prepare("SELECT id FROM marketplace_apps WHERE slug = ?").get(a.slug);
    if (!existing) {
      const id = uuid();
      const clientId = "mine_" + crypto.randomBytes(8).toString("hex");
      const clientSecret = "ms_" + crypto.randomBytes(32).toString("hex");
      db.prepare(`INSERT INTO marketplace_apps (id, name, slug, developer_id, developer_name, short_desc, icon_url, category, price, is_free, is_featured, scopes, webhook_events, client_id, client_secret, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, a.name, a.slug, req.userId, "MINE", a.short_desc, a.icon_url, a.category,
          a.price || 0, (a.price || 0) === 0 ? 1 : 0,
          a.is_featured || 0, JSON.stringify(a.scopes || []), JSON.stringify(a.webhook_events || []),
          clientId, clientSecret, "active");
      created++;
    }
  }
  res.json({ success: true, created, total: apps.length });
});

// Export fireWebhooks for use in other routes
router.fireWebhooks = fireWebhooks;
module.exports = router;
module.exports.fireWebhooks = fireWebhooks;
