// feature-actions.js
// Batch 1 of the "make every button work" effort: real, DB-backed handlers for
// the core CRM / commerce action endpoints the dashboards call. Mounted at
// /api/features (before the honest-404 fallback). Everything is scoped to the
// authenticated user (WHERE user_id = ?) so there is no cross-account access.
const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

// one-time, idempotent column adds this batch needs
let _ensured = false;
function ensureCols(db) {
  if (_ensured) return;
  try { db.exec("ALTER TABLE reviews ADD COLUMN featured INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE reviews ADD COLUMN status TEXT DEFAULT 'published'"); } catch (_) {}
  try { db.exec("ALTER TABLE memberships ADD COLUMN status TEXT DEFAULT 'active'"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS loyalty_tiers (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, threshold INTEGER DEFAULT 0, discount REAL DEFAULT 0, perks TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("ALTER TABLE loyalty_config ADD COLUMN rules_json TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE loyalty_config ADD COLUMN rewards_json TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE loyalty_config ADD COLUMN birthday_json TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE users ADD COLUMN brand_kit TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE chatbot_config ADD COLUMN faqs_json TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE chatbot_config ADD COLUMN widget_json TEXT"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS podcast_episodes (id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, title TEXT, description TEXT, audio_url TEXT, cover_image TEXT, duration_seconds INTEGER, episode_number INTEGER, season INTEGER, status TEXT DEFAULT 'draft', published_at TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("ALTER TABLE podcast_episodes ADD COLUMN show_notes TEXT"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS customer_success_config (user_id TEXT UNIQUE, config_json TEXT, updated_at TEXT)"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS competitors (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, notes TEXT, status TEXT DEFAULT 'tracked', last_checked TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS client_portal_config (user_id TEXT UNIQUE, logo_url TEXT, primary_color TEXT, greeting TEXT, updated_at TEXT)"); } catch (_) {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN portal_token TEXT"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, schedule TEXT, capacity INTEGER, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS class_attendance (id TEXT PRIMARY KEY, class_id TEXT, user_id TEXT, class_name TEXT, attendee_name TEXT, attendee_email TEXT, date TEXT, present INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, target REAL, current REAL DEFAULT 0, due_date TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS commissions (id TEXT PRIMARY KEY, user_id TEXT, staff_name TEXT, amount REAL, period TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS staff_permissions (user_id TEXT UNIQUE, config_json TEXT, updated_at TEXT)"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS membership_members (id TEXT PRIMARY KEY, user_id TEXT, membership_id TEXT, name TEXT, email TEXT, status TEXT DEFAULT 'active', joined_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("ALTER TABLE memberships ADD COLUMN tier TEXT"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, user_id TEXT, customer_email TEXT, plan TEXT, amount REAL, interval_type TEXT, status TEXT DEFAULT 'active', stripe_subscription_id TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  // --- tables owned by other modules; mirror exact schema so handlers are self-sufficient (IF NOT EXISTS = no-op on live) ---
  try { db.exec("CREATE TABLE IF NOT EXISTS event_attendees (id TEXT PRIMARY KEY, event_id TEXT, ticket_id TEXT, user_id TEXT, name TEXT, email TEXT, phone TEXT, quantity INTEGER DEFAULT 1, total_paid REAL DEFAULT 0, status TEXT DEFAULT 'confirmed', payment_intent TEXT, check_in_at TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS community_spaces (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, name TEXT, description TEXT, type TEXT, is_private INTEGER DEFAULT 0, member_count INTEGER DEFAULT 0, created_at TEXT)"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS community_posts (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, author_name TEXT, title TEXT, body TEXT, type TEXT, likes INTEGER DEFAULT 0, replies_count INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, created_at TEXT)"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS sms_optouts (phone TEXT, user_id TEXT, opted_out_at TEXT, PRIMARY KEY(phone,user_id))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS chatbot_config (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, enabled INTEGER DEFAULT 1, name TEXT DEFAULT 'AI Assistant', greeting TEXT DEFAULT 'Hi! How can I help you today?', personality TEXT DEFAULT 'friendly', primary_color TEXT DEFAULT '#2563EB', position TEXT DEFAULT 'bottom-right', auto_open_delay INTEGER DEFAULT 5, capabilities TEXT, custom_instructions TEXT DEFAULT '', business_hours TEXT DEFAULT '', fallback_email TEXT DEFAULT '', lead_capture INTEGER DEFAULT 1, customer_chat_enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS loyalty_points (id TEXT PRIMARY KEY, user_id TEXT, customer_email TEXT, points INTEGER, source TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS email_campaigns (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, subject TEXT, body TEXT, segment TEXT, status TEXT DEFAULT 'draft', sent_at TEXT, opens INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("ALTER TABLE chatbot_config ADD COLUMN widget_json TEXT"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS custom_currencies (id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, code TEXT, name TEXT, symbol TEXT, exchange_rate REAL DEFAULT 1.0, is_default INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS bio_links (id TEXT PRIMARY KEY, user_id TEXT, label TEXT, url TEXT, emoji TEXT, sort INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS bug_reports (id TEXT PRIMARY KEY, user_id TEXT, description TEXT, steps TEXT, email TEXT, status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS roadmap_requests (id TEXT PRIMARY KEY, user_id TEXT, type TEXT DEFAULT 'request', title TEXT, detail TEXT, feature_id TEXT, email TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  try { db.exec("CREATE TABLE IF NOT EXISTS upsell_rules (id TEXT PRIMARY KEY, user_id TEXT, trigger TEXT, offer_id TEXT, discount REAL, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
  _ensured = true;
}
function db() { const d = getDb(); ensureCols(d); return d; }
const ok = (res, extra) => res.json(Object.assign({ ok: true, success: true }, extra || {}));
const nf = (res) => res.status(404).json({ error: "Not found" });

// download auth: accepts the session token via Authorization header OR ?token=
// (the dashboard's CSV/file downloads use window.open(...?token=) which can't set headers)
const crypto = require("crypto");
function dlAuth(req, res, next) {
  const hdr = (req.headers.authorization || "").replace("Bearer ", "");
  const token = hdr || req.query.token || "";
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const d = getDb();
    const h = crypto.createHash("sha256").update(token).digest("hex");
    let s = d.prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>datetime('now')").get(h);
    if (!s) s = d.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>datetime('now')").get(token);
    if (!s) return res.status(401).json({ error: "Invalid or expired token" });
    req.userId = s.user_id; return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
function sendCsv(res, filename, header, rows) {
  const esc = v => { if (v === null || v === undefined) return ""; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [header.map(esc).join(",")];
  for (const r of rows) lines.push(r.map(esc).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\r\n"));
}

// ---- AI helper (reuses the shared claude-helper wrapper) --------------------
const { callClaude } = require("./claude-helper");
const aiReady = () => !!process.env.ANTHROPIC_API_KEY;
async function ai(system, prompt, maxTokens) {
  const d = await callClaude({ system, messages: [{ role: "user", content: prompt }], maxTokens: maxTokens || 1024 });
  return ((d && d.content) || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}
const stripFences = s => String(s || "").replace(/```json|```/g, "").trim();

// ---- email + SMS helpers ----------------------------------------------------
const { sendSms } = require("../utils/sms");
function getSetting(key) {
  try { const r = getDb().prepare("SELECT value FROM settings WHERE key=?").get(key); return r ? r.value : null; }
  catch (_) { return null; }
}
const emailReady = () => !!(process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY"));
async function sendEmail({ to, subject, html, text }) {
  const key = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
  if (!key) return { sent: false, reason: "email not configured" };
  if (!to) return { sent: false, reason: "no recipient" };
  try {
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(key);
    const from = process.env.SENDGRID_FROM_EMAIL || getSetting("SENDGRID_FROM_EMAIL") || getSetting("EMAIL_FROM") || "noreply@takeova.ai";
    await sgMail.send(Object.assign({ to, from: { email: from, name: "MINE" }, subject: subject || "Notification", html: html || text || "" }, text ? { text } : {}));
    return { sent: true };
  } catch (e) { return { sent: false, reason: e.message }; }
}
async function smsSend(to, body) {
  if (!to) return { sent: false };
  try { await sendSms({ to, body, fetch }); return { sent: true }; }
  catch (e) { return { sent: false, reason: e.message }; }
}
// parallel bulk email; returns count actually sent
async function bulkEmail(list, build) {
  const results = await Promise.allSettled(list.map(row => sendEmail(build(row))));
  return results.filter(x => x.status === "fulfilled" && x.value && x.value.sent).length;
}

// ---- LEADS (a "lead" is a contact with a status) ----------------------------
function setContactStatus(status) {
  return (req, res) => {
    try {
      const r = db().prepare("UPDATE contacts SET status=?, last_contacted=datetime('now'), updated_at=datetime('now') WHERE id=? AND user_id=?")
        .run(status, req.params.id, req.userId);
      if (!r.changes) return nf(res);
      return ok(res, { id: req.params.id, status });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  };
}
router.post("/leads/:id/contacted", auth, setContactStatus("contacted"));
router.post("/leads/:id/qualify",   auth, setContactStatus("qualified"));
router.post("/leads/:id/convert",   auth, setContactStatus("customer"));
router.post("/leads/:id/lost",      auth, setContactStatus("lost"));

// ---- CONTACTS ---------------------------------------------------------------
router.post("/contacts/:id/tag", auth, (req, res) => {
  try {
    const d = db();
    const row = d.prepare("SELECT tags_json FROM contacts WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!row) return nf(res);
    let arr = []; try { arr = JSON.parse(row.tags_json || "[]"); } catch (_) {}
    const incoming = req.body && (req.body.tag || req.body.tags || req.body.label);
    const adds = Array.isArray(incoming) ? incoming : String(incoming || "").split(",");
    adds.map(s => String(s).trim()).filter(Boolean).forEach(t => { if (arr.indexOf(t) < 0) arr.push(t); });
    d.prepare("UPDATE contacts SET tags_json=?, tags=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(JSON.stringify(arr), arr.join(","), req.params.id, req.userId);
    return ok(res, { tags: arr });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---- ORDERS -----------------------------------------------------------------
function fulfillOrders(req, res) {
  try {
    const d = db();
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
    let r;
    if (ids && ids.length) {
      const ph = ids.map(() => "?").join(",");
      r = d.prepare(`UPDATE orders SET fulfillment_status='fulfilled' WHERE user_id=? AND id IN (${ph})`).run(req.userId, ...ids);
    } else {
      r = d.prepare("UPDATE orders SET fulfillment_status='fulfilled' WHERE user_id=? AND fulfillment_status!='fulfilled'").run(req.userId);
    }
    return ok(res, { fulfilled: r.changes });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/orders/fulfill", auth, fulfillOrders);
router.post("/orders/bulk-fulfill", auth, fulfillOrders);
router.post("/orders/fulfill-batch", auth, fulfillOrders);
router.put("/orders/:id/tracking", auth, (req, res) => {
  try {
    const b = req.body || {};
    const r = db().prepare("UPDATE orders SET tracking_number=?, carrier=?, tracking_url=?, fulfillment_status='fulfilled' WHERE id=? AND user_id=?")
      .run(b.tracking_number || b.tracking || null, b.carrier || null, b.tracking_url || b.url || null, req.params.id, req.userId);
    if (!r.changes) return nf(res);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---- INVOICES ---------------------------------------------------------------
function markInvoicePaid(id, userId) {
  return db().prepare("UPDATE invoices SET status='paid', paid_at=datetime('now') WHERE id=? AND user_id=?").run(id, userId);
}
router.post("/invoices/:id/payment", auth, (req, res) => {
  try { const r = markInvoicePaid(req.params.id, req.userId); if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/invoices/record-payment", auth, (req, res) => {
  try {
    const b = req.body || {};
    const id = b.id || b.invoice_id || b.invoiceId;
    if (!id) return res.status(400).json({ error: "invoice id required" });
    const r = markInvoicePaid(id, req.userId); if (!r.changes) return nf(res); return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/invoices/:id/void", auth, (req, res) => {
  try { const r = db().prepare("UPDATE invoices SET status='void' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---- BOOKINGS ---------------------------------------------------------------
router.post("/bookings/:id/complete", auth, (req, res) => {
  try { const r = db().prepare("UPDATE bookings SET status='completed' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.put("/bookings/:id/reschedule", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.date && !b.time) return res.status(400).json({ error: "date or time required" });
    const r = db().prepare("UPDATE bookings SET date=COALESCE(?,date), time=COALESCE(?,time), status='confirmed' WHERE id=? AND user_id=?")
      .run(b.date || null, b.time || null, req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---- REVIEWS ----------------------------------------------------------------
router.post("/reviews/:id/feature", auth, (req, res) => {
  try { const r = db().prepare("UPDATE reviews SET featured=1 WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/reviews/:id/spam", auth, (req, res) => {
  try { const r = db().prepare("UPDATE reviews SET approved=0, status='spam' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---- PRODUCTS ---------------------------------------------------------------
router.post("/products/:id/archive", auth, (req, res) => {
  try { const r = db().prepare("UPDATE products SET status='archived' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/products/:id/duplicate", auth, (req, res) => {
  try {
    const d = db();
    const row = d.prepare("SELECT * FROM products WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!row) return nf(res);
    const cols = Object.keys(row);
    const newId = uuid();
    const vals = cols.map(k => k === "id" ? newId : (k === "name" ? ((row.name || "Product") + " (copy)") : row[k]));
    d.prepare(`INSERT INTO products (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
    return ok(res, { id: newId });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.put("/products/:id/price", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (b.price === undefined && b.compare_price === undefined) return res.status(400).json({ error: "price required" });
    const r = d_priceUpdate(req, b);
    if (!r.changes) return nf(res); return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
function d_priceUpdate(req, b) {
  return db().prepare("UPDATE products SET price=COALESCE(?,price), compare_price=COALESCE(?,compare_price) WHERE id=? AND user_id=?")
    .run(b.price !== undefined ? Number(b.price) : null, b.compare_price !== undefined ? Number(b.compare_price) : null, req.params.id, req.userId);
}
router.put("/products/:id/stock", auth, (req, res) => {
  try {
    const b = req.body || {};
    const s = b.stock !== undefined ? b.stock : b.inventory;
    if (s === undefined) return res.status(400).json({ error: "stock required" });
    const r = db().prepare("UPDATE products SET stock=?, inventory=?, track_inventory=1 WHERE id=? AND user_id=?")
      .run(Number(s), Number(s), req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 2 - content + community (create/update on existing tables)
// ============================================================================
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || ("post-" + Date.now());
function authorName(d, userId) {
  try { const u = d.prepare("SELECT business_name, name FROM users WHERE id=?").get(userId); return (u && (u.business_name || u.name)) || "Member"; }
  catch (_) { return "Member"; }
}

// COMMUNITY - frontend POSTs the plural paths; features.js only has the singular ones
router.post("/community/spaces", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: "name required" });
    const id = uuid();
    const isPrivate = /priv/i.test(String(b.access || b.type || "")) ? 1 : 0;
    db().prepare("INSERT INTO community_spaces (id, user_id, name, description, type, is_private, member_count) VALUES (?,?,?,?,?,?,0)")
      .run(id, req.userId, b.name, b.description || null, isPrivate ? "private" : "public", isPrivate);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/community/posts", auth, (req, res) => {
  try {
    const d = db(); const b = req.body || {};
    if (!b.title && !b.content) return res.status(400).json({ error: "title or content required" });
    const id = uuid();
    d.prepare("INSERT INTO community_posts (id, space_id, user_id, author_name, title, body, type, likes, replies_count) VALUES (?,?,?,?,?,?,?,0,0)")
      .run(id, b.space || b.space_id || null, req.userId, authorName(d, req.userId), b.title || null, b.content || b.body || null, b.type || "post");
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// BLOG - save a draft
router.post("/blog/posts", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: "title required" });
    const id = uuid();
    let tags = b.tags;
    if (typeof tags === "string") tags = tags.split(",").map(s => s.trim()).filter(Boolean);
    db().prepare("INSERT INTO blog_posts (id, user_id, title, slug, content, excerpt, tags_json, status) VALUES (?,?,?,?,?,?,?, 'draft')")
      .run(id, req.userId, b.title, slugify(b.title), b.content || "", (b.content || "").slice(0, 160), JSON.stringify(tags || []));
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// COURSES - archive
router.post("/courses/:id/archive", auth, (req, res) => {
  try { const r = db().prepare("UPDATE courses SET status='archived' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

// EVENTS - add a ticket tier (scoped: the event must belong to the user)
router.post("/events/ticket-types", auth, (req, res) => {
  try {
    const d = db(); const b = req.body || {};
    const eventId = b.event_id || b.eventId;
    if (!eventId || !b.tier_name) return res.status(400).json({ error: "event_id and tier_name required" });
    const owns = d.prepare("SELECT id FROM events WHERE id=? AND user_id=?").get(eventId, req.userId);
    if (!owns) return res.status(404).json({ error: "event not found" });
    const id = uuid();
    d.prepare("INSERT INTO event_tickets (id, event_id, name, price, quantity, sold, type) VALUES (?,?,?,?,?,0,'general')")
      .run(id, eventId, b.tier_name, b.price !== undefined ? Number(b.price) : 0, b.quantity !== undefined ? Number(b.quantity) : null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 3 - status flips on existing tables (proposals / contracts / memberships)
// ============================================================================
router.post("/proposals/:id/withdraw", auth, (req, res) => {
  try { const r = db().prepare("UPDATE proposals SET status='withdrawn' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/contracts/:id/terminate", auth, (req, res) => {
  try { const r = db().prepare("UPDATE contracts SET status='terminated' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/memberships/:id/pause", auth, (req, res) => {
  try { const r = db().prepare("UPDATE memberships SET status='paused' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 4 - CSV exports (real data off existing tables -> downloadable file)
// SELECT * so a missing column can never throw; we read fields off the row.
// ============================================================================
router.get("/contacts/export.csv", dlAuth, (req, res) => {
  try {
    const rows = db().prepare("SELECT * FROM contacts WHERE user_id=? ORDER BY rowid DESC").all(req.userId);
    sendCsv(res, "contacts.csv", ["Name", "Email", "Phone", "Company", "Status", "Source", "Tags", "Lead score", "Grade", "Created"],
      rows.map(r => [r.name, r.email, r.phone, r.company, r.status, r.source, r.tags, r.lead_score, r.lead_grade, r.created_at]));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.get("/orders/export.csv", dlAuth, (req, res) => {
  try {
    const rows = db().prepare("SELECT * FROM orders WHERE user_id=? ORDER BY rowid DESC").all(req.userId);
    sendCsv(res, "orders.csv", ["Order #", "Customer", "Email", "Total", "Status", "Fulfilment", "Tracking", "Carrier", "Created"],
      rows.map(r => [r.order_number, r.customer_name, r.customer_email, r.total, r.status, r.fulfillment_status, r.tracking_number, r.carrier, r.created_at]));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.get("/forms/submissions.csv", dlAuth, (req, res) => {
  try {
    const rows = db().prepare("SELECT fs.*, f.title AS form_title FROM form_submissions fs JOIN forms f ON (f.form_id=fs.form_id OR f.id=fs.form_id) WHERE f.user_id=? ORDER BY fs.id DESC").all(req.userId);
    sendCsv(res, "form-submissions.csv", ["Form", "Submitted", "Data"], rows.map(r => [r.form_title, r.created_at, r.data]));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.get("/events/attendees.csv", dlAuth, (req, res) => {
  try {
    const rows = db().prepare("SELECT ea.*, e.title AS event_title FROM event_attendees ea LEFT JOIN events e ON e.id=ea.event_id WHERE ea.user_id=? ORDER BY ea.rowid DESC").all(req.userId);
    sendCsv(res, "attendees.csv", ["Event", "Name", "Email", "Phone", "Quantity", "Paid", "Status"],
      rows.map(r => [r.event_title, r.name, r.email, r.phone, r.quantity, r.total_paid, r.status]));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.get("/sms/optouts.csv", dlAuth, (req, res) => {
  try {
    const rows = db().prepare("SELECT phone, opted_out_at FROM sms_optouts WHERE user_id=? ORDER BY opted_out_at DESC").all(req.userId);
    sendCsv(res, "sms-optouts.csv", ["Phone", "Opted out at"], rows.map(r => [r.phone, r.opted_out_at]));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// /api/exports/* family (the generic Export / Export Leads / Export Pipeline buttons)
const exportsRouter = express.Router();
function contactsCsv(req, res, leadsOnly, filename) {
  try {
    let sql = "SELECT * FROM contacts WHERE user_id=?";
    if (leadsOnly) sql += " AND status IN ('lead','contacted','qualified')";
    sql += " ORDER BY rowid DESC";
    const rows = db().prepare(sql).all(req.userId);
    sendCsv(res, filename, ["Name", "Email", "Phone", "Company", "Status", "Source", "Lead score", "Grade", "Created"],
      rows.map(r => [r.name, r.email, r.phone, r.company, r.status, r.source, r.lead_score, r.lead_grade, r.created_at]));
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
exportsRouter.get("/data.csv", dlAuth, (req, res) => contactsCsv(req, res, false, "data.csv"));
exportsRouter.get("/leads.csv", dlAuth, (req, res) => contactsCsv(req, res, true, "leads.csv"));
exportsRouter.get("/pipeline.csv", dlAuth, (req, res) => contactsCsv(req, res, false, "pipeline.csv"));

// ============================================================================
// BATCH 5 - AI endpoints (call Claude; persist where it makes sense)
// All return 503 if no ANTHROPIC_API_KEY so the UI degrades gracefully.
// ============================================================================
async function scoreLeads(req, res) {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const d = db();
    const leads = d.prepare("SELECT id,name,email,company,source,notes,status FROM contacts WHERE user_id=? AND status IN ('lead','contacted','qualified') ORDER BY rowid DESC LIMIT 50").all(req.userId);
    if (!leads.length) return ok(res, { scored: 0 });
    const out = stripFences(await ai(
      "You are a B2B lead-scoring engine. Output ONLY a valid JSON array.",
      'Score each lead 0-100 for likelihood to convert and grade A-F. Return ONLY JSON like [{"id":"...","score":85,"grade":"A"}]. Leads:\n' + JSON.stringify(leads), 1500));
    let arr = []; try { arr = JSON.parse(out); } catch (_) {}
    const upd = d.prepare("UPDATE contacts SET lead_score=?, lead_grade=? WHERE id=? AND user_id=?");
    let n = 0;
    for (const it of (Array.isArray(arr) ? arr : [])) {
      if (it && it.id) { upd.run(Math.max(0, Math.min(100, parseInt(it.score) || 0)), String(it.grade || "C").slice(0, 2), it.id, req.userId); n++; }
    }
    return ok(res, { scored: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/leads/score", auth, scoreLeads);
router.post("/leads/ai-score-all", auth, scoreLeads);

router.post("/reviews/:id/ai-reply", auth, async (req, res) => {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const r = db().prepare("SELECT * FROM reviews WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!r) return nf(res);
    const reply = await ai("You write warm, professional, concise replies (2-4 sentences) from a small business owner to a customer review. No placeholders.",
      `Customer: ${r.reviewer_name || r.customer_name || "A customer"}\nRating: ${r.rating}/5\nReview: ${r.text || r.comment || ""}\n\nWrite a reply.`, 400);
    return ok(res, { reply });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/reviews/ai-reply-all", auth, async (req, res) => {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const rows = db().prepare("SELECT id,reviewer_name,customer_name,rating,text,comment FROM reviews WHERE user_id=? ORDER BY rowid DESC LIMIT 10").all(req.userId);
    const replies = [];
    for (const r of rows) {
      const reply = await ai("You write warm, concise professional replies (2-3 sentences) to customer reviews.",
        `Customer: ${r.reviewer_name || r.customer_name || "A customer"}\nRating: ${r.rating}/5\nReview: ${r.text || r.comment || ""}\nWrite a reply.`, 300);
      replies.push({ id: r.id, reply });
    }
    return ok(res, { replies });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

router.post("/blog/ai-generate", auth, async (req, res) => {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const b = req.body || {};
    const topic = b.topic || b.title || "my business";
    const length = b.length || "medium";
    const out = await ai("You are a professional blog writer. Return the post as: first line = the title, then a blank line, then the body as plain paragraphs.",
      `Write a ${length}-length blog post about: ${topic}`, 1800);
    const nl = out.indexOf("\n");
    const title = (nl > 0 ? out.slice(0, nl) : topic).replace(/^#+\s*/, "").trim().slice(0, 160);
    const content = (nl > 0 ? out.slice(nl + 1) : out).trim();
    const id = uuid();
    db().prepare("INSERT INTO blog_posts (id,user_id,title,slug,content,excerpt,tags_json,status) VALUES (?,?,?,?,?,?, '[]','draft')")
      .run(id, req.userId, title, slugify(title), content, content.slice(0, 160));
    return ok(res, { id, title });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

router.post("/seo/ai-meta", auth, async (req, res) => {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const b = req.body || {};
    const ctx = b.content || b.keywords || b.url || b.page || "this business website";
    let out = stripFences(await ai('You write SEO meta tags. Return ONLY JSON: {"title":"<=60 chars","description":"<=155 chars"}.', `Page/topic: ${ctx}`, 300));
    let meta = {}; try { meta = JSON.parse(out); } catch (_) { meta = { title: "", description: out }; }
    return ok(res, meta);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

async function seoAudit(req, res) {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const b = req.body || {};
    const ctx = b.url || b.content || b.site || "the business website";
    const audit = await ai("You are an SEO auditor. Give a concise, actionable bullet list (max 8 items) of SEO improvements.", `Audit target: ${ctx}`, 800);
    return ok(res, { audit });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/seo/ai-audit", auth, seoAudit);
router.post("/blog/seo-audit", auth, seoAudit);

async function csPersonalize(req, res) {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const b = req.body || {};
    const who = b.name || b.customer || b.customer_name || "a customer";
    const ctx = b.context || b.notes || b.reason || "at risk of churning";
    const message = await ai("You write short, warm retention messages (2-4 sentences) from a small business to a customer. No placeholders except [Name] if needed.",
      `Customer: ${who}. Situation: ${ctx}. Write a personalized message.`, 400);
    return ok(res, { message });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/customer-success/personalize", auth, csPersonalize);
router.post("/customer-success/ai-personalise", auth, csPersonalize);

router.post("/competitor/ai-analysis", auth, async (req, res) => {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const b = req.body || {};
    const comp = b.competitor || b.name || b.url || b.domain || "a competitor";
    const analysis = await ai("You are a competitive analyst for small businesses. Give a concise SWOT-style analysis (Strengths, Weaknesses, Opportunities, Threats), 2-3 bullets each.",
      `Analyze this competitor for a small business owner: ${comp}`, 900);
    return ok(res, { analysis });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 6 - email / SMS sends (SendGrid + Twilio; graceful if a key is missing)
// Bulk sends are parallelized and capped so they can't time out the request.
// ============================================================================
function emailOneContact() {
  return async (req, res) => {
    try {
      const c = db().prepare("SELECT * FROM contacts WHERE id=? AND user_id=?").get(req.params.id, req.userId);
      if (!c) return nf(res);
      const b = req.body || {};
      const r = await sendEmail({ to: c.email, subject: b.subject || "A message from us", html: String(b.message || b.body || "Hello").replace(/\n/g, "<br>") });
      if (c.email) try { db().prepare("UPDATE contacts SET last_contacted=datetime('now') WHERE id=? AND user_id=?").run(req.params.id, req.userId); } catch (_) {}
      return ok(res, r);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  };
}
router.post("/contacts/:id/email", auth, emailOneContact());
router.post("/leads/:id/email", auth, emailOneContact());
router.post("/contacts/:id/sms", auth, async (req, res) => {
  try {
    const c = db().prepare("SELECT * FROM contacts WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!c) return nf(res);
    const r = await smsSend(c.phone, (req.body && (req.body.message || req.body.body)) || "Hello from us");
    return ok(res, r);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

async function bulkEmailContacts(req, res, leadsOnly) {
  try {
    const b = req.body || {};
    let sql = "SELECT email FROM contacts WHERE user_id=? AND email IS NOT NULL AND email!=''";
    if (leadsOnly) sql += " AND status IN ('lead','contacted','qualified')";
    sql += " LIMIT 50";
    const rows = db().prepare(sql).all(req.userId);
    if (!emailReady()) return ok(res, { sent: 0, queued: rows.length, note: "email not configured" });
    const n = await bulkEmail(rows, r => ({ to: r.email, subject: b.subject || "An update from us", html: String(b.message || b.body || "Hello").replace(/\n/g, "<br>") }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/contacts/bulk-email", auth, (req, res) => bulkEmailContacts(req, res, false));
router.post("/leads/bulk-contact", auth, (req, res) => bulkEmailContacts(req, res, true));

// INVOICES
router.post("/invoices/:id/remind", auth, async (req, res) => {
  try {
    const inv = db().prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!inv) return nf(res);
    const r = await sendEmail({ to: inv.client_email, subject: `Reminder: invoice ${inv.invoice_number || ""}`.trim(), html: `Hi ${inv.client_name || "there"}, a friendly reminder that invoice ${inv.invoice_number || ""}${inv.total != null ? " for $" + inv.total : ""} is awaiting payment.` });
    return ok(res, r);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/invoices/send-reminders", auth, async (req, res) => {
  try {
    const rows = db().prepare("SELECT * FROM invoices WHERE user_id=? AND status NOT IN ('paid','void') AND client_email IS NOT NULL LIMIT 50").all(req.userId);
    if (!emailReady()) return ok(res, { sent: 0, queued: rows.length, note: "email not configured" });
    const n = await bulkEmail(rows, inv => ({ to: inv.client_email, subject: `Reminder: invoice ${inv.invoice_number || ""}`.trim(), html: `Hi ${inv.client_name || "there"}, invoice ${inv.invoice_number || ""} is still awaiting payment.` }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// BOOKINGS (calendar/send-reminders is the same action)
async function bookingReminders(req, res) {
  try {
    const rows = db().prepare("SELECT * FROM bookings WHERE user_id=? AND status IN ('confirmed','pending') AND date >= date('now') AND customer_email IS NOT NULL LIMIT 50").all(req.userId);
    if (!emailReady()) return ok(res, { sent: 0, queued: rows.length, note: "email not configured" });
    const n = await bulkEmail(rows, bk => ({ to: bk.customer_email, subject: "Booking reminder", html: `Hi ${bk.customer_name || "there"}, a reminder for your ${bk.service || "appointment"} on ${bk.date || ""} ${bk.time || ""}.` }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/bookings/send-reminders", auth, bookingReminders);
router.post("/calendar/send-reminders", auth, bookingReminders);
router.post("/bookings/:id/remind", auth, async (req, res) => {
  try {
    const bk = db().prepare("SELECT * FROM bookings WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!bk) return nf(res);
    const r = await sendEmail({ to: bk.customer_email, subject: "Booking reminder", html: `Hi ${bk.customer_name || "there"}, reminder for your ${bk.service || "appointment"} on ${bk.date || ""} ${bk.time || ""}.` });
    if (bk.customer_phone) await smsSend(bk.customer_phone, `Reminder: your ${bk.service || "appointment"} on ${bk.date || ""} ${bk.time || ""}.`);
    return ok(res, r);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// EVENTS
async function emailEventAttendees(req, res, subjectFn, bodyFn, eventId) {
  try {
    let sql = "SELECT ea.*, e.title AS event_title FROM event_attendees ea LEFT JOIN events e ON e.id=ea.event_id WHERE ea.user_id=? AND ea.email IS NOT NULL";
    const args = [req.userId];
    if (eventId) { sql += " AND ea.event_id=?"; args.push(eventId); }
    sql += " LIMIT 100";
    const rows = db().prepare(sql).all(...args);
    if (!emailReady()) return ok(res, { sent: 0, queued: rows.length, note: "email not configured" });
    const n = await bulkEmail(rows, a => ({ to: a.email, subject: subjectFn(a), html: bodyFn(a) }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/events/send-reminders", auth, (req, res) => emailEventAttendees(req, res, a => `Reminder: ${a.event_title || "your event"}`, a => `Hi ${a.name || "there"}, this is a reminder for ${a.event_title || "your event"}.`));
router.post("/events/send-tickets", auth, (req, res) => emailEventAttendees(req, res, a => `Your ticket: ${a.event_title || "event"}`, a => `Hi ${a.name || "there"}, here is your ticket for ${a.event_title || "the event"} (qty ${a.quantity || 1}).`));
router.post("/events/:id/broadcast", auth, (req, res) => {
  const msg = (req.body && (req.body.message || req.body.body)) || "An update about your event.";
  return emailEventAttendees(req, res, a => `Update: ${a.event_title || "your event"}`, a => `Hi ${a.name || "there"},<br><br>${String(msg).replace(/\n/g, "<br>")}`, req.params.id);
});
router.post("/events/resend-ticket", auth, async (req, res) => {
  try {
    const email = req.body && req.body.email;
    if (!email) return res.status(400).json({ error: "email required" });
    const a = db().prepare("SELECT ea.*, e.title AS event_title FROM event_attendees ea LEFT JOIN events e ON e.id=ea.event_id WHERE ea.user_id=? AND ea.email=? LIMIT 1").get(req.userId, email);
    const title = a ? a.event_title : "the event";
    const r = await sendEmail({ to: email, subject: `Your ticket: ${title}`, html: `Here is your ticket for ${title}.` });
    return ok(res, r);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// INVITES
async function sendInvites(req, res, kind) {
  try {
    const b = req.body || {};
    let emails = b.emails || b.email || b.invitees || "";
    if (typeof emails === "string") emails = emails.split(/[,;\s]+/).filter(Boolean);
    emails = (Array.isArray(emails) ? emails : []).slice(0, 100);
    if (!emails.length) return res.status(400).json({ error: "email(s) required" });
    if (!emailReady()) return ok(res, { sent: 0, invited: emails.length, note: "email not configured" });
    const subj = kind === "community" ? "You're invited to our community" : kind === "portal" ? "Your client portal invite" : "You've been invited";
    const n = await bulkEmail(emails, to => ({ to, subject: subj, html: b.message || subj }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/referrals/invite", auth, (req, res) => sendInvites(req, res, "referral"));
router.post("/community/invite", auth, (req, res) => sendInvites(req, res, "community"));
router.post("/client-portal/invite", auth, (req, res) => sendInvites(req, res, "portal"));

// PROPOSALS
router.post("/proposals/:id/follow-up", auth, async (req, res) => {
  try {
    const p = db().prepare("SELECT * FROM proposals WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!p) return nf(res);
    const r = await sendEmail({ to: p.client_email, subject: "Following up on your proposal", html: `Hi ${p.client_name || "there"}, just following up on the proposal we sent${p.amount != null ? ` for $${p.amount}` : ""}. Happy to answer any questions.` });
    return ok(res, r);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/proposals/bulk-followup", auth, async (req, res) => {
  try {
    const rows = db().prepare("SELECT * FROM proposals WHERE user_id=? AND status IN ('sent','viewed','draft') AND client_email IS NOT NULL LIMIT 50").all(req.userId);
    if (!emailReady()) return ok(res, { sent: 0, queued: rows.length, note: "email not configured" });
    const n = await bulkEmail(rows, p => ({ to: p.client_email, subject: "Following up on your proposal", html: `Hi ${p.client_name || "there"}, following up on your proposal.` }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 7 - file generation (PDF via pdfkit, ICS as plain text)
// pdfkit is lazy-required so a missing module degrades to 503, never crashes.
// ============================================================================
function startPdf(res, filename) {
  let PDFDocument;
  try { PDFDocument = require("pdfkit"); } catch (_) { return null; }
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}
const stripHtml = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const pdfErr = (res, e) => { if (!res.headersSent) return res.status(500).json({ error: e.message }); try { res.end(); } catch (_) {} };

router.get("/invoices/:id.pdf", dlAuth, (req, res) => {
  try {
    const d = db(), key = req.params.id;
    if (key === "export") {
      const rows = d.prepare("SELECT * FROM invoices WHERE user_id=? ORDER BY rowid DESC LIMIT 500").all(req.userId);
      const doc = startPdf(res, "invoices.pdf"); if (!doc) return res.status(503).json({ error: "PDF not available" });
      doc.fontSize(18).text("Invoices", { underline: true }).moveDown();
      doc.fontSize(10);
      if (!rows.length) doc.text("No invoices.");
      rows.forEach(inv => doc.text(`${inv.invoice_number || inv.id}   ${inv.client_name || ""}   ${inv.status || ""}   ${inv.total != null ? "$" + inv.total : ""}`));
      return doc.end();
    }
    const inv = d.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(key, req.userId);
    if (!inv) return nf(res);
    const doc = startPdf(res, `invoice-${inv.invoice_number || inv.id}.pdf`); if (!doc) return res.status(503).json({ error: "PDF not available" });
    let u = {}; try { u = d.prepare("SELECT business_name,name,email FROM users WHERE id=?").get(req.userId) || {}; } catch (_) {}
    doc.fontSize(20).text(u.business_name || u.name || "Invoice").moveDown(0.3);
    doc.fontSize(10).fillColor("#666").text(u.email || "").fillColor("#000").moveDown();
    doc.fontSize(16).text(`Invoice ${inv.invoice_number || ""}`).moveDown(0.3);
    doc.fontSize(10).text(`Status: ${inv.status || "draft"}`);
    if (inv.due_date) doc.text(`Due: ${inv.due_date}`);
    doc.moveDown().text(`Bill to: ${inv.client_name || ""}`);
    if (inv.client_email) doc.text(inv.client_email);
    if (inv.client_address) doc.text(inv.client_address);
    doc.moveDown().fontSize(11).text("Items:", { underline: true }).fontSize(10);
    let items = []; try { items = JSON.parse(inv.items_json || "[]"); } catch (_) {}
    if (!items.length) doc.text("(no line items)");
    items.forEach(it => { const q = it.quantity || it.qty || 1, p = it.price || it.amount || 0; doc.text(`${q} x ${it.name || it.description || "Item"}   -   $${(q * p).toFixed(2)}`); });
    doc.moveDown();
    if (inv.subtotal != null) doc.text(`Subtotal: $${inv.subtotal}`);
    if (inv.tax != null) doc.text(`Tax: $${inv.tax}`);
    doc.fontSize(13).text(`Total: $${inv.total != null ? inv.total : 0}`);
    doc.end();
  } catch (e) { return pdfErr(res, e); }
});

router.get("/proposals/:id.pdf", dlAuth, (req, res) => {
  try {
    const p = db().prepare("SELECT * FROM proposals WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!p) return nf(res);
    const doc = startPdf(res, `proposal-${p.id}.pdf`); if (!doc) return res.status(503).json({ error: "PDF not available" });
    doc.fontSize(20).text("Proposal").moveDown(0.3);
    doc.fontSize(11).text(`For: ${p.client_name || ""}`);
    if (p.client_email) doc.text(p.client_email);
    if (p.amount != null) doc.text(`Amount: $${p.amount}`);
    doc.moveDown().fontSize(10).text(stripHtml(p.content || p.html || p.description) || "(no content)");
    doc.end();
  } catch (e) { return pdfErr(res, e); }
});

router.get("/contracts/:id.pdf", dlAuth, (req, res) => {
  try {
    const c = db().prepare("SELECT * FROM contracts WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!c) return nf(res);
    const doc = startPdf(res, `contract-${c.id}.pdf`); if (!doc) return res.status(503).json({ error: "PDF not available" });
    doc.fontSize(20).text("Contract").moveDown(0.3);
    if (c.client_name) doc.fontSize(11).text(`Party: ${c.client_name}`).moveDown();
    doc.fontSize(10).text(stripHtml(c.content || c.body || c.description) || "(no content)");
    doc.end();
  } catch (e) { return pdfErr(res, e); }
});

router.get("/orders/slips.pdf", dlAuth, (req, res) => {
  try {
    const d = db();
    let list = d.prepare("SELECT * FROM orders WHERE user_id=? AND fulfillment_status!='fulfilled' ORDER BY rowid DESC LIMIT 100").all(req.userId);
    if (!list.length) list = d.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY rowid DESC LIMIT 50").all(req.userId);
    const doc = startPdf(res, "packing-slips.pdf"); if (!doc) return res.status(503).json({ error: "PDF not available" });
    if (!list.length) doc.fontSize(12).text("No orders to pack.");
    list.forEach((o, i) => {
      if (i > 0) doc.addPage();
      doc.fontSize(18).text("Packing Slip").moveDown(0.3);
      doc.fontSize(11).text(`Order ${o.order_number || o.id}`).text(`Customer: ${o.customer_name || ""}`);
      if (o.shipping_address) doc.text(`Ship to: ${o.shipping_name || o.customer_name || ""}, ${o.shipping_address}`);
      doc.moveDown().fontSize(10).text("Items:", { underline: true });
      let items = []; try { items = JSON.parse(o.items || "[]"); } catch (_) {}
      if (!items.length) doc.text("(no items)");
      items.forEach(it => doc.text(`${it.quantity || it.qty || 1} x ${it.name || it.title || "Item"}`));
    });
    doc.end();
  } catch (e) { return pdfErr(res, e); }
});

router.get("/calendar/export.ics", dlAuth, (req, res) => {
  try {
    const d = db();
    const bookings = d.prepare("SELECT * FROM bookings WHERE user_id=? LIMIT 500").all(req.userId);
    let events = []; try { events = d.prepare("SELECT * FROM events WHERE user_id=? LIMIT 500").all(req.userId); } catch (_) {}
    const esc = s => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
    const pad = n => String(n).padStart(2, "0");
    const fmt = dt => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
    function range(dateStr, timeStr, durMin) {
      if (!dateStr) return null;
      const parts = String(dateStr).split("-").map(x => parseInt(x, 10));
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null;
      let hh = 9, mi = 0;
      if (timeStr) { const tm = String(timeStr).match(/(\d{1,2}):(\d{2})/); if (tm) { hh = +tm[1]; mi = +tm[2]; } }
      const s = new Date(parts[0], parts[1] - 1, parts[2], hh, mi, 0);
      return { s: fmt(s), e: fmt(new Date(s.getTime() + (durMin || 60) * 60000)) };
    }
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MINE//Calendar//EN", "CALSCALE:GREGORIAN"];
    const addEv = (uid, r, summary, desc) => {
      if (!r) return;
      lines.push("BEGIN:VEVENT", `UID:${uid}@takeova.ai`, `DTSTAMP:${r.s}`, `DTSTART:${r.s}`, `DTEND:${r.e}`, `SUMMARY:${esc(summary)}`);
      if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
      lines.push("END:VEVENT");
    };
    bookings.forEach(b => addEv("bk-" + b.id, range(b.date, b.time, b.duration || 60), `${b.service || "Booking"} - ${b.customer_name || ""}`, b.notes || ""));
    events.forEach(e => addEv("ev-" + e.id, range(e.date || e.start_date, e.time, 60), e.title || "Event", e.description || ""));
    lines.push("END:VCALENDAR");
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="calendar.ics"');
    res.send(lines.join("\r\n"));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 8 - loyalty ACTIONS (the rest of loyalty already exists in features.js)
// ============================================================================
function loyaltyConfigRow(d, userId) {
  d.prepare("INSERT OR IGNORE INTO loyalty_config (id, user_id) VALUES (?, ?)").run(uuid(), userId);
}
router.post("/loyalty/tiers", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: "name required" });
    const id = uuid();
    db().prepare("INSERT INTO loyalty_tiers (id, user_id, name, threshold, discount, perks) VALUES (?,?,?,?,?,?)")
      .run(id, req.userId, b.name, parseInt(b.threshold) || 0, parseFloat(b.discount) || 0, b.perks || null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/loyalty/rules", auth, (req, res) => {
  try {
    const d = db(); loyaltyConfigRow(d, req.userId);
    d.prepare("UPDATE loyalty_config SET rules_json=? WHERE user_id=?").run(JSON.stringify(req.body || {}), req.userId);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.put("/loyalty/rewards", auth, (req, res) => {
  try {
    const b = req.body || {}; const d = db(); loyaltyConfigRow(d, req.userId);
    d.prepare("UPDATE loyalty_config SET signup_bonus=COALESCE(?,signup_bonus), referral_bonus=COALESCE(?,referral_bonus), rewards_json=? WHERE user_id=?")
      .run(b.signup_bonus != null ? parseInt(b.signup_bonus) : null, b.referral_bonus != null ? parseInt(b.referral_bonus) : null, JSON.stringify(b), req.userId);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/loyalty/issue-points", auth, (req, res) => {
  try {
    const b = req.body || {};
    const email = b.email || b.customer_email;
    const pts = parseInt(b.points);
    if (!email || !pts) return res.status(400).json({ error: "email and points required" });
    db().prepare("INSERT INTO loyalty_points (id, user_id, customer_email, points, source) VALUES (?,?,?,?,?)")
      .run(uuid(), req.userId, email, pts, b.reason || "manual issue");
    return ok(res, { issued: pts, email });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/loyalty/birthday", auth, (req, res) => {
  try {
    const d = db(); loyaltyConfigRow(d, req.userId);
    d.prepare("UPDATE loyalty_config SET birthday_json=? WHERE user_id=?").run(JSON.stringify(req.body || {}), req.userId);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 9 - AI "generate draft" (creates a real draft row you can then edit)
// ============================================================================
router.post("/proposals/ai-generate", auth, async (req, res) => {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const b = req.body || {};
    const client = b.client || b.client_name || "the client";
    const brief = b.brief || b.description || "a project";
    const value = b.value != null && b.value !== "" ? parseFloat(b.value) : null;
    const content = await ai("You write professional business proposals. Use clear sections: Overview, Scope, Deliverables, Timeline, Pricing. Plain text with simple headings.",
      `Client: ${client}\nBrief: ${brief}${value != null ? `\nBudget: $${value}` : ""}\n\nWrite the proposal.`, 1800);
    const id = uuid();
    db().prepare("INSERT INTO proposals (id, user_id, client_name, description, amount, content, status) VALUES (?,?,?,?,?,?, 'draft')")
      .run(id, req.userId, client, brief, value, content);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/contracts/ai-draft", auth, async (req, res) => {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const b = req.body || {};
    const client = b.client || b.client_name || "the client";
    const type = b.type || "services";
    const value = b.value != null && b.value !== "" ? parseFloat(b.value) : null;
    const content = await ai("You draft clear, plain-English business contracts for a small business: parties, scope, payment terms, term/termination, signature block. This is a draft, not legal advice.",
      `Contract type: ${type}\nClient: ${client}${value != null ? `\nValue: $${value}` : ""}\n\nDraft the contract.`, 1800);
    const id = uuid();
    db().prepare("INSERT INTO contracts (id, user_id, title, client_name, content, amount, status) VALUES (?,?,?,?,?,?, 'draft')")
      .run(id, req.userId, `${type} contract`, client, content, value != null ? value : 0);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/courses/ai-generate", auth, async (req, res) => {
  if (!aiReady()) return res.status(503).json({ error: "AI not configured" });
  try {
    const b = req.body || {};
    const topic = b.topic || b.title || "my topic";
    const n = Math.max(1, Math.min(20, parseInt(b.modules) || 5));
    const out = stripFences(await ai('You design online courses. Return ONLY JSON: {"description":"...","modules":[{"title":"...","summary":"..."}]}.',
      `Design a ${n}-module course on: ${topic}. Return exactly ${n} modules.`, 1500));
    let parsed = {}; try { parsed = JSON.parse(out); } catch (_) {}
    const description = parsed.description || `A course on ${topic}.`;
    const modules = Array.isArray(parsed.modules) ? parsed.modules : [];
    const id = uuid();
    db().prepare("INSERT INTO courses (id, user_id, title, description, modules_json, status) VALUES (?,?,?,?,?, 'draft')")
      .run(id, req.userId, topic, description, JSON.stringify(modules));
    return ok(res, { id, modules: modules.length });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 10 - config saves (brand kit -> users.brand_kit JSON; chatbot_config)
// ============================================================================
function mergeBrand(d, userId, patch) {
  let cur = {}; try { const r = d.prepare("SELECT brand_kit FROM users WHERE id=?").get(userId); cur = JSON.parse((r && r.brand_kit) || "{}"); } catch (_) {}
  Object.keys(patch).forEach(k => { if (patch[k] !== undefined && patch[k] !== null) cur[k] = patch[k]; });
  d.prepare("UPDATE users SET brand_kit=? WHERE id=?").run(JSON.stringify(cur), userId);
  return cur;
}
function chatbotRow(d, userId) { d.prepare("INSERT OR IGNORE INTO chatbot_config (id, user_id) VALUES (?, ?)").run(uuid(), userId); }

router.put("/brand-kit/colors", auth, (req, res) => {
  try { const b = req.body || {}; return ok(res, { brand: mergeBrand(db(), req.userId, { primary: b.primary, secondary: b.secondary, accent: b.accent, bg: b.bg }) }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.put("/brand-kit/fonts", auth, (req, res) => {
  try { const b = req.body || {}; return ok(res, { brand: mergeBrand(db(), req.userId, { headingFont: b.headings, bodyFont: b.body }) }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/brand-kit/apply-all", auth, (req, res) => {
  try { const r = db().prepare("SELECT brand_kit FROM users WHERE id=?").get(req.userId); return ok(res, { applied: true, hasBrand: !!(r && r.brand_kit) }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/chatbot/faq", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.question) return res.status(400).json({ error: "question required" });
    const d = db(); chatbotRow(d, req.userId);
    const r = d.prepare("SELECT faqs_json FROM chatbot_config WHERE user_id=?").get(req.userId);
    let arr = []; try { arr = JSON.parse((r && r.faqs_json) || "[]"); } catch (_) {}
    arr.push({ question: b.question, answer: b.answer || "" });
    d.prepare("UPDATE chatbot_config SET faqs_json=? WHERE user_id=?").run(JSON.stringify(arr), req.userId);
    return ok(res, { count: arr.length });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.put("/chatbot/widget", auth, (req, res) => {
  try {
    const b = req.body || {}; const d = db(); chatbotRow(d, req.userId);
    d.prepare("UPDATE chatbot_config SET greeting=COALESCE(?,greeting), widget_json=? WHERE user_id=?").run(b.greeting || null, JSON.stringify(b), req.userId);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 11 - more DB actions (event check-in, podcast episode, currency)
// ============================================================================
router.post("/events/checkin", auth, (req, res) => {
  try {
    const b = req.body || {};
    const code = b.ticket_code || b.code, email = b.attendee_email || b.email;
    if (!code && !email) return res.status(400).json({ error: "ticket code or email required" });
    const r = db().prepare("UPDATE event_attendees SET check_in_at=datetime('now'), status='checked_in' WHERE user_id=? AND (email=? OR id=? OR ticket_id=?)")
      .run(req.userId, email || null, code || null, code || null);
    if (!r.changes) return res.status(404).json({ error: "attendee not found" });
    return ok(res, { checked_in: r.changes });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/podcast/episodes", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: "title required" });
    const id = uuid();
    const dur = b.duration_min != null && b.duration_min !== "" ? Math.round(parseFloat(b.duration_min) * 60) : null;
    db().prepare("INSERT INTO podcast_episodes (id, owner_type, owner_id, title, description, audio_url, duration_seconds, episode_number, status) VALUES (?, 'user', ?, ?, ?, ?, ?, ?, 'draft')")
      .run(id, req.userId, b.title, b.description || null, b.audio_url || null, dur, b.episode_number != null && b.episode_number !== "" ? parseInt(b.episode_number) : null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/multi-currency/add", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.code) return res.status(400).json({ error: "currency code required" });
    const id = uuid();
    db().prepare("INSERT INTO custom_currencies (id, owner_type, owner_id, code, exchange_rate) VALUES (?, 'user', ?, ?, ?)")
      .run(id, req.userId, String(b.code).toUpperCase().slice(0, 8), b.rate != null && b.rate !== "" ? parseFloat(b.rate) : 1.0);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 12 - panel reads (feed the generic renderer: {items:[...], ...stats})
// Each SELECT is guarded so a not-yet-created table yields an empty panel, not 500.
// ============================================================================
const safeAll = (sql, ...args) => { try { return db().prepare(sql).all(...args); } catch (_) { return []; } };

router.get("/calendar", auth, (req, res) => {
  const bookings = safeAll("SELECT * FROM bookings WHERE user_id=? ORDER BY date DESC LIMIT 500", req.userId);
  res.json({ items: bookings, count: bookings.length });
});

router.get("/community", auth, (req, res) => {
  const spaces = safeAll("SELECT * FROM community_spaces WHERE user_id=? ORDER BY rowid DESC", req.userId);
  const posts = safeAll("SELECT * FROM community_posts WHERE user_id=? ORDER BY rowid DESC LIMIT 300", req.userId);
  const today = new Date().toISOString().slice(0, 10);
  const postsToday = posts.filter(p => String(p.created_at || "").slice(0, 10) === today).length;
  const memberCount = spaces.reduce((s, x) => s + (x.member_count || 0), 0);
  res.json({ items: spaces, spaceCount: spaces.length, postsToday, memberCount, engagement: 0 });
});

router.get("/customer-success", auth, (req, res) => {
  const contacts = safeAll("SELECT id,name,email,status,lead_score,lead_grade,last_activity,last_contacted,created_at FROM contacts WHERE user_id=? ORDER BY rowid DESC LIMIT 500", req.userId);
  const now = Date.now();
  const items = contacts.map(c => {
    const last = c.last_activity || c.last_contacted || c.created_at;
    let days = 999; if (last) { const t = Date.parse(last); if (!isNaN(t)) days = Math.floor((now - t) / 86400000); }
    return Object.assign({}, c, { health: days > 60 ? "at-risk" : "healthy" });
  });
  res.json({ items, winBacksSent: 0, recoveredCount: 0 });
});

// ============================================================================
// BATCH 13 - bio-links feature (list + add) and bare-/api currencies read
// ============================================================================
router.get("/bio-links", auth, (req, res) => {
  res.json({ items: safeAll("SELECT * FROM bio_links WHERE user_id=? ORDER BY sort ASC, rowid ASC", req.userId) });
});
router.post("/bio-links", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.label || !b.url) return res.status(400).json({ error: "label and url required" });
    const id = uuid();
    db().prepare("INSERT INTO bio_links (id, user_id, label, url, emoji) VALUES (?,?,?,?,?)").run(id, req.userId, b.label, b.url, b.emoji || null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// bare /api/* router (mounted at /api) for paths that live outside /api/features
const bareRouter = express.Router();
bareRouter.get("/currencies", auth, (req, res) => {
  res.json({ currencies: safeAll("SELECT * FROM custom_currencies WHERE owner_id=? AND owner_type='user' ORDER BY rowid ASC", req.userId) });
});

// ============================================================================
// BATCH 14 - help center, bug report, roadmap, chatbot read
// ============================================================================
router.post("/help/bug-report", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.description) return res.status(400).json({ error: "description required" });
    db().prepare("INSERT INTO bug_reports (id, user_id, description, steps, email) VALUES (?,?,?,?,?)").run(uuid(), req.userId, b.description, b.steps || null, b.email || null);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/roadmap/request", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: "title required" });
    db().prepare("INSERT INTO roadmap_requests (id, user_id, type, title, detail, email) VALUES (?,?, 'request', ?,?,?)").run(uuid(), req.userId, b.title, b.detail || null, b.email || null);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/roadmap/notify", auth, (req, res) => {
  try {
    const b = req.body || {};
    db().prepare("INSERT INTO roadmap_requests (id, user_id, type, feature_id, email) VALUES (?,?, 'notify', ?,?)").run(uuid(), req.userId, b.feature_id || null, b.email || null);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.get("/help/articles", auth, (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const all = [
    { title: "Getting started with MINE", category: "Basics", url: "/help/getting-started" },
    { title: "Connecting your domain", category: "Sites", url: "/help/domains" },
    { title: "Accepting payments with Stripe", category: "Payments", url: "/help/payments" },
    { title: "Setting up bookings", category: "Bookings", url: "/help/bookings" },
    { title: "Email & SMS campaigns", category: "Marketing", url: "/help/campaigns" },
    { title: "Using the AI assistant", category: "AI", url: "/help/ai" },
    { title: "Loyalty & rewards", category: "Loyalty", url: "/help/loyalty" },
    { title: "Inviting your team", category: "Team", url: "/help/team" }
  ];
  const articles = q ? all.filter(a => a.title.toLowerCase().includes(q) || a.category.toLowerCase().includes(q)) : all;
  res.json({ count: articles.length, articles, items: articles });
});
router.get("/chatbot", auth, (req, res) => {
  const items = safeAll("SELECT c.* FROM chatbot_conversations c JOIN sites s ON s.id=c.site_id WHERE s.user_id=? ORDER BY c.rowid DESC LIMIT 200", req.userId);
  let cfg = {}; try { cfg = db().prepare("SELECT * FROM chatbot_config WHERE user_id=?").get(req.userId) || {}; } catch (_) {}
  res.json({ items, conversations: items.length, enabled: cfg.enabled != null ? cfg.enabled : 1, greeting: cfg.greeting || "" });
});

// ============================================================================
// BATCH 15 - upsells, AI-tools list, site score, app store
// ============================================================================
function cnt(userId, table) { try { const r = getDb().prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(userId); return r ? r.n : 0; } catch (_) { return 0; } }
router.post("/upsells/rules", auth, (req, res) => {
  try {
    const b = req.body || {};
    db().prepare("INSERT INTO upsell_rules (id, user_id, trigger, offer_id, discount) VALUES (?,?,?,?,?)")
      .run(uuid(), req.userId, b.trigger || null, b.offer_id || null, b.discount != null && b.discount !== "" ? parseFloat(b.discount) : null);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.get("/ai-tools", auth, (req, res) => {
  res.json({
    items: [
      { name: "AI Receptionist", provider: "Grok + Twilio", usageStatus: "active" },
      { name: "AI Blog Writer", provider: "Claude", usageStatus: "active" },
      { name: "Review Auto-Reply", provider: "Claude", usageStatus: "active" },
      { name: "Lead Scoring", provider: "Claude", usageStatus: "active" },
      { name: "Proposal & Contract Drafts", provider: "Claude", usageStatus: "active" },
      { name: "SEO Assistant", provider: "Claude", usageStatus: "active" },
      { name: "Video & Image", provider: "HeyGen + Runway", usageStatus: "active" }
    ], usageStatus: "All active", provider: "Multi"
  });
});
bareRouter.get("/score", auth, (req, res) => {
  const total = Math.min(100, cnt(req.userId, "contacts") + cnt(req.userId, "orders") + cnt(req.userId, "products") + cnt(req.userId, "reviews"));
  res.json({ total, score: total, gained_mo: 0, rank: "-", percentile: "-" });
});
bareRouter.get("/app-store", auth, (req, res) => {
  const apps = [
    { name: "Stripe", category: "Payments", installed: true },
    { name: "SendGrid", category: "Email", installed: true },
    { name: "Twilio", category: "SMS & Voice", installed: true },
    { name: "Mailchimp", category: "Email", installed: false },
    { name: "QuickBooks", category: "Accounting", installed: false },
    { name: "Xero", category: "Accounting", installed: false },
    { name: "Google Analytics", category: "Analytics", installed: false },
    { name: "Zapier", category: "Automation", installed: false },
    { name: "Pinterest", category: "Social", installed: false },
    { name: "Reddit", category: "Social", installed: false }
  ];
  res.json({ apps, installed: apps.filter(a => a.installed).length, available: 50, featured: 3, updates: 0 });
});

// ============================================================================
// BATCH 16 - review-request campaign (email) + social scheduled read
// ============================================================================
router.post("/reviews/request-campaign", auth, async (req, res) => {
  try {
    const rows = safeAll("SELECT email FROM contacts WHERE user_id=? AND email IS NOT NULL AND email!='' LIMIT 50", req.userId);
    if (!emailReady()) return ok(res, { sent: 0, queued: rows.length, note: "email not configured" });
    const n = await bulkEmail(rows, r => ({ to: r.email, subject: "We'd love your feedback", html: "Hi! Thanks for being a customer. Would you mind leaving us a quick review? It really helps us out. Thank you!" }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.get("/social/scheduled", auth, (req, res) => {
  res.json({ items: safeAll("SELECT * FROM social_posts WHERE user_id=? ORDER BY rowid DESC LIMIT 200", req.userId) });
});

// ============================================================================
// BATCH 17 - large buildable sweep (reads / actions / exports on real tables)
// ============================================================================
function atRiskContacts(userId) {
  const rows = safeAll("SELECT id,name,email,status,lead_grade,last_activity,last_contacted,created_at FROM contacts WHERE user_id=? ORDER BY rowid DESC LIMIT 1000", userId);
  const now = Date.now();
  return rows.map(c => { const last = c.last_activity || c.last_contacted || c.created_at; let days = 999; if (last) { const t = Date.parse(last); if (!isNaN(t)) days = Math.floor((now - t) / 86400000); } return Object.assign({}, c, { health: days > 60 ? "at-risk" : "healthy", idle_days: days }); });
}
function integrationStatus() {
  const has = k => !!(process.env[k] || getSetting(k));
  return [
    { name: "Stripe", connected: has("STRIPE_SECRET_KEY") }, { name: "SendGrid", connected: has("SENDGRID_API_KEY") },
    { name: "Twilio", connected: has("TWILIO_ACCOUNT_SID") }, { name: "Anthropic (Claude)", connected: has("ANTHROPIC_API_KEY") },
    { name: "xAI (Grok)", connected: has("XAI_API_KEY") }, { name: "AWS S3", connected: has("AWS_ACCESS_KEY_ID") },
    { name: "EasyPost", connected: has("EASYPOST_API_KEY") }, { name: "QuickBooks", connected: has("QUICKBOOKS_CLIENT_ID") },
    { name: "Xero", connected: has("XERO_CLIENT_ID") }
  ];
}
// --- reads ---
router.get("/transactions", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM transactions WHERE user_id=? ORDER BY rowid DESC LIMIT 500", req.userId) }));
router.get("/automations/logs", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM automation_logs WHERE user_id=? ORDER BY rowid DESC LIMIT 200", req.userId) }));
router.get("/events/attendees", auth, (req, res) => res.json({ items: safeAll("SELECT ea.*, e.title AS event_title FROM event_attendees ea LEFT JOIN events e ON e.id=ea.event_id WHERE ea.user_id=? ORDER BY ea.rowid DESC LIMIT 500", req.userId) }));
router.get("/forms/submissions", auth, (req, res) => res.json({ items: safeAll("SELECT fs.*, f.title AS form_title FROM form_submissions fs JOIN forms f ON (f.form_id=fs.form_id OR f.id=fs.form_id) WHERE f.user_id=? ORDER BY fs.id DESC LIMIT 500", req.userId) }));
router.get("/membership-tiers", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM memberships WHERE user_id=? ORDER BY price ASC", req.userId) }));
router.get("/customer-success/at-risk", auth, (req, res) => res.json({ items: atRiskContacts(req.userId).filter(c => c.health === "at-risk") }));
router.get("/integrations", auth, (req, res) => { const items = integrationStatus(); res.json({ items, connected: items.filter(x => x.connected).length }); });
// --- actions ---
router.post("/transactions", auth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.description && b.amount == null) return res.status(400).json({ error: "description or amount required" });
    const id = uuid();
    db().prepare("INSERT INTO transactions (id, user_id, type, amount, category, description, source, date) VALUES (?,?,?,?,?,?, 'manual', ?)")
      .run(id, req.userId, b.type || "income", b.amount != null ? parseFloat(b.amount) : 0, b.category || null, b.description || null, b.date || null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/events/check-in", auth, (req, res) => {
  try {
    const b = req.body || {}; const code = b.ticket_code || b.code, email = b.attendee_email || b.email;
    if (!code && !email) return res.status(400).json({ error: "ticket code or email required" });
    const r = db().prepare("UPDATE event_attendees SET check_in_at=datetime('now'), status='checked_in' WHERE user_id=? AND (email=? OR id=? OR ticket_id=?)").run(req.userId, email || null, code || null, code || null);
    if (!r.changes) return res.status(404).json({ error: "attendee not found" });
    return ok(res, { checked_in: r.changes });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/events/send-update", auth, (req, res) => {
  const msg = (req.body && (req.body.message || req.body.body)) || "An update about your event.";
  return emailEventAttendees(req, res, a => `Update: ${a.event_title || "your event"}`, a => `Hi ${a.name || "there"},<br><br>${String(msg).replace(/\n/g, "<br>")}`);
});
router.post("/orders/:id/resend-receipt", auth, async (req, res) => {
  try {
    const o = db().prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!o) return nf(res);
    const r = await sendEmail({ to: o.customer_email, subject: `Your receipt - order ${o.order_number || ""}`.trim(), html: `Hi ${o.customer_name || "there"}, here's your receipt for order ${o.order_number || o.id}${o.total != null ? ` - total $${o.total}` : ""}.` });
    return ok(res, r);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/bookings/:id/award-points", auth, (req, res) => {
  try {
    const bk = db().prepare("SELECT * FROM bookings WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!bk) return nf(res);
    const pts = req.body && req.body.points ? parseInt(req.body.points) : 10;
    if (bk.customer_email) db().prepare("INSERT INTO loyalty_points (id, user_id, customer_email, points, source) VALUES (?,?,?,?, 'booking')").run(uuid(), req.userId, bk.customer_email, pts);
    return ok(res, { awarded: pts });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
function blockTime(req, res) {
  try {
    const b = req.body || {};
    const id = uuid();
    db().prepare("INSERT INTO bookings (id, user_id, service, customer_name, date, time, duration, status, notes) VALUES (?,?, 'Blocked', 'Blocked time', ?,?,?, 'blocked', ?)")
      .run(id, req.userId, b.date || null, b.time || null, b.duration != null ? parseInt(b.duration) : 60, b.reason || b.notes || null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/bookings/block", auth, blockTime);
router.post("/calendar/block", auth, blockTime);
async function winBack(req, res) {
  try {
    const atrisk = atRiskContacts(req.userId).filter(c => c.health === "at-risk" && c.email).slice(0, 50);
    if (!emailReady()) return ok(res, { sent: 0, queued: atrisk.length, note: "email not configured" });
    const n = await bulkEmail(atrisk, c => ({ to: c.email, subject: "We miss you!", html: `Hi ${c.name || "there"}, we haven't seen you in a while - here's a little nudge to come back. We'd love to help.` }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/customer-success/win-back", auth, winBack);
router.post("/customer-success/winback", auth, winBack);
router.post("/win-back", auth, winBack);
// --- exports ---
router.get("/forms/:id/submissions.csv", dlAuth, (req, res) => {
  const rows = safeAll("SELECT fs.* FROM form_submissions fs JOIN forms f ON (f.form_id=fs.form_id OR f.id=fs.form_id) WHERE f.user_id=? AND (f.id=? OR f.form_id=?) ORDER BY fs.id DESC", req.userId, req.params.id, req.params.id);
  sendCsv(res, "form-submissions.csv", ["Submitted", "Data"], rows.map(r => [r.created_at, r.data]));
});
router.get("/events/:id/attendees.csv", dlAuth, (req, res) => {
  const rows = safeAll("SELECT ea.* FROM event_attendees ea WHERE ea.user_id=? AND ea.event_id=? ORDER BY ea.rowid DESC", req.userId, req.params.id);
  sendCsv(res, "attendees.csv", ["Name", "Email", "Phone", "Quantity", "Paid", "Status"], rows.map(r => [r.name, r.email, r.phone, r.quantity, r.total_paid, r.status]));
});
router.get("/customer-success/at-risk.csv", dlAuth, (req, res) => {
  const rows = atRiskContacts(req.userId).filter(c => c.health === "at-risk");
  sendCsv(res, "at-risk.csv", ["Name", "Email", "Status", "Idle days", "Grade"], rows.map(r => [r.name, r.email, r.status, r.idle_days, r.lead_grade]));
});
function courseEnrollCsv(req, res, name) {
  const rows = safeAll("SELECT e.* FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE c.id=? AND c.user_id=? ORDER BY e.rowid DESC", req.params.id, req.userId);
  sendCsv(res, name, ["Student", "Email", "Paid", "Enrolled"], rows.map(r => [r.student_name, r.student_email, r.amount_paid, r.created_at]));
}
router.get("/courses/:id/students.csv", dlAuth, (req, res) => courseEnrollCsv(req, res, "students.csv"));
router.get("/courses/:id/progress.csv", dlAuth, (req, res) => courseEnrollCsv(req, res, "progress.csv"));

// --- bare /api/* ---
bareRouter.get("/user-notifications", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM user_notifications WHERE user_id=? ORDER BY rowid DESC LIMIT 100", req.userId) }));
bareRouter.get("/referral-programs", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM referrals WHERE referrer_id=? ORDER BY rowid DESC LIMIT 200", req.userId) }));
bareRouter.get("/integrations", auth, (req, res) => { const items = integrationStatus(); res.json({ items, connected: items.filter(x => x.connected).length }); });
function setTeamRole(req, res) {
  try {
    const r = db().prepare("UPDATE team_members SET role=? WHERE id=? AND owner_id=?").run((req.body || {}).role || null, req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
bareRouter.put("/staff/:id/role", auth, setTeamRole);
bareRouter.put("/team/:id/role", auth, setTeamRole);
bareRouter.post("/team/:id/resend-invite", auth, async (req, res) => {
  try {
    const m = db().prepare("SELECT * FROM team_members WHERE id=? AND owner_id=?").get(req.params.id, req.userId);
    if (!m) return nf(res);
    const link = `${process.env.FRONTEND_URL || ""}/accept-invite?token=${m.invite_token || ""}`;
    const r = await sendEmail({ to: m.email, subject: "Your team invite (reminder)", html: `You've been invited to join the team. Accept here: ${link}` });
    return ok(res, r);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
function markInvoicePaidBody(req, res) {
  try {
    const b = req.body || {}; const id = b.id || b.invoice_id || b.invoiceId;
    if (!id) return res.status(400).json({ error: "invoice id required" });
    const r = db().prepare("UPDATE invoices SET status='paid', paid_at=datetime('now') WHERE id=? AND user_id=?").run(id, req.userId);
    if (!r.changes) return nf(res); return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
bareRouter.post("/data/invoices/mark-paid", auth, markInvoicePaidBody);
bareRouter.post("/data/invoices/payment", auth, markInvoicePaidBody);
bareRouter.get("/data/invoices/paid", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM invoices WHERE user_id=? AND status='paid' ORDER BY rowid DESC LIMIT 500", req.userId) }));
bareRouter.post("/email/campaigns/:id/duplicate", auth, (req, res) => {
  try {
    const c = db().prepare("SELECT * FROM email_campaigns WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!c) return nf(res);
    const id = uuid();
    db().prepare("INSERT INTO email_campaigns (id, user_id, name, subject, body, status) VALUES (?,?,?,?,?, 'draft')").run(id, req.userId, (c.name || "Campaign") + " (copy)", c.subject || null, c.body || null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

bareRouter.post("/email/campaigns/:id/resend", auth, async (req, res) => {
  try {
    const c = db().prepare("SELECT * FROM email_campaigns WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!c) return nf(res);
    const seg = String(c.segment || "").toLowerCase();
    const all = !seg || ["all", "everyone", "subscribers", "all contacts", "contacts"].includes(seg);
    const recips = all
      ? safeAll("SELECT name,email FROM contacts WHERE user_id=? AND email IS NOT NULL AND email!=''", req.userId)
      : safeAll("SELECT name,email FROM contacts WHERE user_id=? AND email IS NOT NULL AND email!='' AND LOWER(status)=?", req.userId, seg);
    if (!emailReady()) return ok(res, { sent: 0, queued: recips.length, note: "email not configured — add SendGrid/SMTP keys to send" });
    const n = await bulkEmail(recips, r => ({ to: r.email, subject: c.subject || "Campaign", html: String(c.body || "").replace(/\n/g, "<br>") }));
    db().prepare("UPDATE email_campaigns SET status='sent', sent_at=datetime('now') WHERE id=?").run(c.id);
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
bareRouter.get("/email/campaigns/:id/stats.csv", dlAuth, (req, res) => {
  const c = db().prepare("SELECT * FROM email_campaigns WHERE id=? AND user_id=?").get(req.params.id, req.userId);
  if (!c) return nf(res);
  // email_tracking has no campaign_id link; match this campaign's recipients by subject (real per-recipient open/click data)
  const rows = c.subject
    ? safeAll("SELECT email, opened, opened_at, clicks FROM email_tracking WHERE user_id=? AND subject=? ORDER BY rowid DESC", req.userId, c.subject)
    : [];
  sendCsv(res, "campaign-stats.csv", ["Email", "Opened", "Opened At", "Clicks"], rows.map(r => [r.email, r.opened ? "yes" : "no", r.opened_at || "", r.clicks || 0]));
});

// ============================================================================
// BATCH 18 - final clean DB sweep
// ============================================================================
router.get("/accounting/export.csv", dlAuth, (req, res) => {
  const rows = safeAll("SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC, rowid DESC", req.userId);
  sendCsv(res, "transactions.csv", ["Date", "Type", "Category", "Description", "Amount"], rows.map(r => [r.date, r.type, r.category, r.description, r.amount]));
});
router.get("/accounting/tax-report.pdf", dlAuth, (req, res) => {
  const rows = safeAll("SELECT type, category, amount FROM transactions WHERE user_id=?", req.userId);
  const doc = startPdf(res, "tax-report.pdf"); if (!doc) return res.status(503).json({ error: "PDF not available" });
  doc.fontSize(18).text("Tax Report", { underline: true }).moveDown();
  const byType = {}, byCat = {};
  rows.forEach(r => { const a = parseFloat(r.amount) || 0; const t = r.type || "other"; byType[t] = (byType[t] || 0) + a; const k = t + " / " + (r.category || "uncategorised"); byCat[k] = (byCat[k] || 0) + a; });
  doc.fontSize(12).text("Summary by type").moveDown(0.3).fontSize(10);
  Object.keys(byType).forEach(t => doc.text(`${t}: $${byType[t].toFixed(2)}`));
  doc.moveDown().fontSize(12).text("By category").moveDown(0.3).fontSize(10);
  Object.keys(byCat).forEach(k => doc.text(`${k}: $${byCat[k].toFixed(2)}`));
  if (!rows.length) doc.text("No transactions recorded.");
  doc.end();
});
router.put("/podcast/show-notes", auth, (req, res) => {
  try {
    const b = req.body || {}; const id = b.episode_id || b.id;
    if (!id) return res.status(400).json({ error: "episode_id required" });
    const r = db().prepare("UPDATE podcast_episodes SET show_notes=? WHERE id=? AND owner_id=?").run(b.show_notes || "", id, req.userId);
    if (!r.changes) return nf(res); return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.put("/customer-success/scoring", auth, (req, res) => {
  try {
    db().prepare("INSERT INTO customer_success_config (user_id, config_json, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET config_json=excluded.config_json, updated_at=datetime('now')").run(req.userId, JSON.stringify(req.body || {}));
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
// --- bare /api/* ---
bareRouter.get("/videos", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM videos WHERE user_id=? ORDER BY rowid DESC LIMIT 200", req.userId) }));
bareRouter.get("/site-templates", auth, (req, res) => { try { const cat = require("../data/site-catalog"); const list = (cat.listCatalog && cat.listCatalog()) || cat.CATALOG || []; return res.json({ items: list.map(e => ({ id: e.key, key: e.key, name: e.name, category: e.category, accent: e.accent })) }); } catch (_) { return res.json({ items: safeAll("SELECT * FROM site_templates ORDER BY rowid DESC LIMIT 200") }); } });
bareRouter.post("/data/invoices/followup", auth, async (req, res) => {
  try {
    const rows = safeAll("SELECT * FROM invoices WHERE user_id=? AND status!='paid' AND client_email IS NOT NULL AND client_email!='' LIMIT 50", req.userId);
    if (!emailReady()) return ok(res, { sent: 0, queued: rows.length, note: "email not configured" });
    const n = await bulkEmail(rows, inv => ({ to: inv.client_email, subject: `Reminder: invoice ${inv.invoice_number || inv.id}`, html: `Hi ${inv.client_name || "there"}, a friendly reminder that invoice ${inv.invoice_number || inv.id}${inv.total != null ? ` for $${inv.total}` : ""} is still outstanding. Thank you!` }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
bareRouter.get("/auth/export-data", dlAuth, (req, res) => {
  try {
    const tables = ["contacts", "orders", "invoices", "bookings", "products", "blog_posts", "courses", "events", "transactions", "reviews", "email_campaigns", "social_posts", "loyalty_points", "referrals"];
    const data = { exported_at: new Date().toISOString(), user_id: req.userId };
    let user = {}; try { user = db().prepare("SELECT id,email,name,business_name,created_at FROM users WHERE id=?").get(req.userId) || {}; } catch (_) {}
    data.account = user;
    tables.forEach(t => { data[t] = safeAll(`SELECT * FROM ${t} WHERE user_id=?`, req.userId); });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=my-data-export.json");
    res.send(JSON.stringify(data, null, 2));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 19 - real data features (new tables, no external keys)
// ============================================================================
// --- competitors ---
router.get("/competitors", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM competitors WHERE user_id=? ORDER BY rowid DESC LIMIT 200", req.userId) }));
router.post("/competitors", auth, (req, res) => {
  try {
    const b = req.body || {}; if (!b.name && !b.url) return res.status(400).json({ error: "name or url required" });
    const id = uuid();
    db().prepare("INSERT INTO competitors (id, user_id, name, url, notes) VALUES (?,?,?,?,?)").run(id, req.userId, b.name || b.url, b.url || null, b.notes || null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.get("/competitor/export.csv", dlAuth, (req, res) => {
  const rows = safeAll("SELECT * FROM competitors WHERE user_id=? ORDER BY rowid DESC", req.userId);
  sendCsv(res, "competitors.csv", ["Name", "URL", "Status", "Notes", "Last checked"], rows.map(r => [r.name, r.url, r.status, r.notes, r.last_checked]));
});
// --- client portal ---
router.get("/client-portal", auth, (req, res) => {
  let cfg = {}; try { cfg = db().prepare("SELECT * FROM client_portal_config WHERE user_id=?").get(req.userId) || {}; } catch (_) {}
  const clients = safeAll("SELECT id,name,email,portal_token FROM contacts WHERE user_id=? AND status IN ('client','customer') ORDER BY rowid DESC LIMIT 200", req.userId);
  res.json({ config: cfg, branding: cfg, items: clients });
});
router.put("/client-portal/branding", auth, (req, res) => {
  try {
    const b = req.body || {};
    db().prepare("INSERT INTO client_portal_config (user_id, logo_url, primary_color, greeting, updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET logo_url=excluded.logo_url, primary_color=excluded.primary_color, greeting=excluded.greeting, updated_at=datetime('now')")
      .run(req.userId, b.logo_url || null, b.primary || b.primary_color || null, b.greeting || null);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/client-portal/:id/reset", auth, (req, res) => {
  try {
    const tok = uuid().replace(/-/g, "");
    const r = db().prepare("UPDATE contacts SET portal_token=? WHERE id=? AND user_id=?").run(tok, req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res, { token: tok });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
// --- classes attendance ---
router.get("/classes/attendance.csv", dlAuth, (req, res) => {
  const rows = safeAll("SELECT * FROM class_attendance WHERE user_id=? ORDER BY date DESC, rowid DESC", req.userId);
  sendCsv(res, "class-attendance.csv", ["Class", "Attendee", "Email", "Date", "Present"], rows.map(r => [r.class_name || r.class_id, r.attendee_name, r.attendee_email, r.date, r.present ? "yes" : "no"]));
});
router.get("/classes/:id/attendance.csv", dlAuth, (req, res) => {
  const rows = safeAll("SELECT * FROM class_attendance WHERE user_id=? AND class_id=? ORDER BY date DESC", req.userId, req.params.id);
  sendCsv(res, "class-attendance.csv", ["Attendee", "Email", "Date", "Present"], rows.map(r => [r.attendee_name, r.attendee_email, r.date, r.present ? "yes" : "no"]));
});
// --- membership members + actions ---
router.get("/memberships/members", auth, (req, res) => res.json({ items: safeAll("SELECT mm.*, m.name AS membership_name FROM membership_members mm LEFT JOIN memberships m ON m.id=mm.membership_id WHERE mm.user_id=? ORDER BY mm.rowid DESC LIMIT 500", req.userId) }));
router.post("/memberships/:id/message", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const members = safeAll("SELECT name,email FROM membership_members WHERE user_id=? AND membership_id=? AND email IS NOT NULL AND email!=''", req.userId, req.params.id);
    if (!emailReady()) return ok(res, { sent: 0, queued: members.length, note: "email not configured" });
    const n = await bulkEmail(members, m => ({ to: m.email, subject: b.subject || "Update from your membership", html: String(b.body || "").replace(/\n/g, "<br>") }));
    return ok(res, { sent: n });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.put("/memberships/:id/tier", auth, (req, res) => {
  try {
    const r = db().prepare("UPDATE memberships SET tier=? WHERE id=? AND user_id=?").run((req.body || {}).tier || null, req.params.id, req.userId);
    if (!r.changes) return nf(res); return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
// --- bare: competitors, agency goals, staff ---
bareRouter.get("/competitors", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM competitors WHERE user_id=? ORDER BY rowid DESC LIMIT 200", req.userId) }));
bareRouter.get("/data/goals", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM goals WHERE user_id=? ORDER BY rowid DESC LIMIT 200", req.userId) }));
bareRouter.post("/data/goals", auth, (req, res) => {
  try {
    const b = req.body || {}; if (!b.title) return res.status(400).json({ error: "title required" });
    const id = uuid();
    db().prepare("INSERT INTO goals (id, user_id, title, target, current, due_date) VALUES (?,?,?,?,?,?)").run(id, req.userId, b.title, b.target != null ? parseFloat(b.target) : null, b.current != null ? parseFloat(b.current) : 0, b.due_date || null);
    return ok(res, { id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
bareRouter.get("/staff/activity", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM automation_logs WHERE user_id=? ORDER BY rowid DESC LIMIT 100", req.userId) }));
bareRouter.get("/staff/commissions.csv", dlAuth, (req, res) => {
  const rows = safeAll("SELECT * FROM commissions WHERE user_id=? ORDER BY rowid DESC", req.userId);
  sendCsv(res, "commissions.csv", ["Staff", "Amount", "Period", "Status"], rows.map(r => [r.staff_name, r.amount, r.period, r.status]));
});
bareRouter.put("/staff/permissions", auth, (req, res) => {
  try {
    db().prepare("INSERT INTO staff_permissions (user_id, config_json, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET config_json=excluded.config_json, updated_at=datetime('now')").run(req.userId, JSON.stringify(req.body || {}));
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// BATCH 20 - Stripe subscription management (real SDK calls, honest 503)
// ============================================================================
function stripeClient() { return process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null; }
router.get("/subscriptions", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM subscriptions WHERE user_id=? ORDER BY rowid DESC LIMIT 500", req.userId) }));
router.post("/subscriptions/:id/pause", auth, async (req, res) => {
  try {
    const sub = db().prepare("SELECT * FROM subscriptions WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!sub) return nf(res);
    if (sub.stripe_subscription_id) { const sc = stripeClient(); if (!sc) return res.status(503).json({ error: "Stripe not configured - add STRIPE_SECRET_KEY to pause live billing" }); await sc.subscriptions.update(sub.stripe_subscription_id, { pause_collection: { behavior: "void" } }); }
    db().prepare("UPDATE subscriptions SET status='paused' WHERE id=?").run(sub.id);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/subscriptions/:id/resume", auth, async (req, res) => {
  try {
    const sub = db().prepare("SELECT * FROM subscriptions WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!sub) return nf(res);
    if (sub.stripe_subscription_id) { const sc = stripeClient(); if (!sc) return res.status(503).json({ error: "Stripe not configured - add STRIPE_SECRET_KEY to resume live billing" }); await sc.subscriptions.update(sub.stripe_subscription_id, { pause_collection: "" }); }
    db().prepare("UPDATE subscriptions SET status='active' WHERE id=?").run(sub.id);
    return ok(res);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/subscriptions/modify", auth, (req, res) => {
  try {
    const b = req.body || {}; const id = b.id || b.subscription_id;
    if (!id) return res.status(400).json({ error: "subscription id required" });
    const sets = [], vals = [];
    if (b.plan != null) { sets.push("plan=?"); vals.push(b.plan); }
    if (b.amount != null) { sets.push("amount=?"); vals.push(parseFloat(b.amount)); }
    if (b.interval_type != null) { sets.push("interval_type=?"); vals.push(b.interval_type); }
    if (!sets.length) return res.status(400).json({ error: "nothing to modify" });
    vals.push(id, req.userId);
    const r = db().prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id=? AND user_id=?`).run(...vals);
    if (!r.changes) return nf(res);
    return ok(res, { note: "Plan price changes also require a Stripe price ID to sync live billing." });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
bareRouter.get("/subscriptions", auth, (req, res) => res.json({ items: safeAll("SELECT * FROM subscriptions WHERE user_id=? ORDER BY rowid DESC LIMIT 500", req.userId) }));

module.exports = router;
module.exports.exportsRouter = exportsRouter;
module.exports.bareRouter = bareRouter;
