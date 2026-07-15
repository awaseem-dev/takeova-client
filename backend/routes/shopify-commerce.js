// MINE — Shopify commerce webhooks → WhatsApp (via Take Control's number).
//
// Order confirmations, shipping updates, and abandoned-cart recovery.
//
// WhatsApp rule: business-INITIATED messages (which all of these are) must use a
// PRE-APPROVED template — you cannot send freeform business-initiated messages.
// So these send WhatsApp *template* messages through the platform number
// (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN, same as Take Control).
//
// The merchant must create + get approval for three templates in WhatsApp Manager.
// Names are configurable (defaults shown); expected body variables:
//   order_confirmation : {{1}} first name  {{2}} order #     {{3}} total
//   shipping_update    : {{1}} first name  {{2}} order #     {{3}} tracking/url
//   abandoned_cart     : {{1}} first name  {{2}} recovery url
//
// HONEST: written to documented Shopify webhook + WhatsApp Cloud API shapes;
// verified at compile/load level only — not run against a live store or Meta.
// Sending to a shopper also needs WhatsApp opt-in + the app's "protected customer
// data" access approved in the Partner dashboard (phone is protected PII).

const express = require("express");
const crypto = require("crypto");

const webhookRouter = express.Router();
webhookRouter.use(express.raw({ type: "*/*", limit: "2mb" }));

function getDb() { return require("../db/init").getDb(); }
function getSetting(k) {
  try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || process.env[k] || ""; }
  catch { return process.env[k] || ""; }
}

const GRAPH = "v19.0";
const TPL = {
  order: () => getSetting("SHOPIFY_TPL_ORDER") || "order_confirmation",
  shipping: () => getSetting("SHOPIFY_TPL_SHIPPING") || "shipping_update",
  recovery: () => getSetting("SHOPIFY_TPL_RECOVERY") || "abandoned_cart",
};
const TPL_LANG = () => getSetting("SHOPIFY_TPL_LANG") || "en_US";
const RECOVERY_DELAY_MIN = () => parseInt(getSetting("SHOPIFY_RECOVERY_DELAY_MIN") || "45", 10);
const RECOVERY_EXPIRE_HRS = 24;

function ensureCommerce(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS shopify_abandoned_checkouts (
    token TEXT PRIMARY KEY,
    shop_domain TEXT,
    user_id TEXT,
    phone TEXT,
    customer_name TEXT,
    recovery_url TEXT,
    currency TEXT,
    total REAL,
    status TEXT DEFAULT 'open',
    recovery_sent INTEGER DEFAULT 0,
    recovery_sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
}

// ── HMAC (raw body, base64) — same scheme as the billing webhooks ──
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""), "utf8"), B = Buffer.from(String(b || ""), "utf8");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function verifyHmac(rawBody, headerHmac) {
  const secret = getSetting("SHOPIFY_API_SECRET"); if (!secret) return false;
  const d = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(d, headerHmac);
}
function cleanShop(shop) {
  const s = String(shop || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").split("/")[0];
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : "";
}
function guard(req, res) {
  if (!verifyHmac(req.body, req.get("X-Shopify-Hmac-Sha256"))) { res.status(401).send("hmac"); return false; }
  return true;
}
function body(req) { try { return JSON.parse(req.body.toString("utf8")); } catch { return {}; } }

function installForShop(db, shop) { try { return db.prepare("SELECT * FROM shopify_installs WHERE shop_domain = ?").get(shop) || null; } catch { return null; } }
function digitsPhone(p) { return String(p || "").replace(/[^\d]/g, ""); }
function pickPhone(o) {
  const p = (o && (o.phone || (o.customer && o.customer.phone) || (o.shipping_address && o.shipping_address.phone) || (o.billing_address && o.billing_address.phone))) || "";
  return digitsPhone(p);
}
function firstName(o) {
  const n = (o && o.customer && (o.customer.first_name || o.customer.firstName)) || (o && o.shipping_address && o.shipping_address.first_name) || "";
  return String(n || "there");
}

// ── WhatsApp Cloud API (template send) ──
async function waSend(payload) {
  const phoneId = getSetting("WHATSAPP_PHONE_NUMBER_ID");
  const token = getSetting("WHATSAPP_ACCESS_TOKEN");
  if (!phoneId || !token) return { ok: false, reason: "WhatsApp not configured" };
  try {
    const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
    const r = await fetch(`https://graph.facebook.com/${GRAPH}/${phoneId}/messages`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ messaging_product: "whatsapp" }, payload)),
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.error) return { ok: false, reason: j.error.message || "send error" };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}
function sendTemplate(to, name, params) {
  return waSend({
    to, type: "template",
    template: {
      name, language: { code: TPL_LANG() },
      components: [{ type: "body", parameters: (params || []).map(t => ({ type: "text", text: String(t).slice(0, 1024) })) }],
    },
  });
}

// ── receivers (ack fast, then do work) ──
webhookRouter.post("/orders_create", async (req, res) => {
  if (!guard(req, res)) return;
  res.sendStatus(200);
  try {
    const db = getDb(); ensureCommerce(db);
    const shop = cleanShop(req.get("X-Shopify-Shop-Domain"));
    const o = body(req);
    const tok = o.checkout_token || (o.checkout_id != null ? String(o.checkout_id) : null);
    if (tok) { try { db.prepare("UPDATE shopify_abandoned_checkouts SET status='converted', updated_at=datetime('now') WHERE token=?").run(String(tok)); } catch (_) {} }
    const inst = installForShop(db, shop); if (!inst || !inst.user_id) return;
    const phone = pickPhone(o); if (!phone) return;
    const num = o.name || ("#" + (o.order_number || o.number || ""));
    const total = ((o.currency || "") + " " + (o.total_price || o.current_total_price || "")).trim();
    await sendTemplate(phone, TPL.order(), [firstName(o), num, total]);
  } catch (e) { console.error("[shopify orders_create]", e.message); }
});

webhookRouter.post("/orders_fulfilled", async (req, res) => {
  if (!guard(req, res)) return;
  res.sendStatus(200);
  try {
    const db = getDb();
    const shop = cleanShop(req.get("X-Shopify-Shop-Domain"));
    const o = body(req);
    const inst = installForShop(db, shop); if (!inst || !inst.user_id) return;
    const phone = pickPhone(o); if (!phone) return;
    const num = o.name || ("#" + (o.order_number || o.number || ""));
    let track = "";
    try { const f = (o.fulfillments && o.fulfillments[0]) || {}; track = f.tracking_url || (f.tracking_urls && f.tracking_urls[0]) || f.tracking_number || ""; } catch (_) {}
    await sendTemplate(phone, TPL.shipping(), [firstName(o), num, track || "your order is on the way"]);
  } catch (e) { console.error("[shopify orders_fulfilled]", e.message); }
});

function upsertCheckout(req) {
  const db = getDb(); ensureCommerce(db);
  const shop = cleanShop(req.get("X-Shopify-Shop-Domain"));
  const c = body(req);
  const tok = c.token || (c.id != null ? String(c.id) : null); if (!tok) return;
  const inst = installForShop(db, shop); const uid = inst ? inst.user_id : null;
  db.prepare(`INSERT INTO shopify_abandoned_checkouts (token, shop_domain, user_id, phone, customer_name, recovery_url, currency, total, status, updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'open', datetime('now'))
    ON CONFLICT(token) DO UPDATE SET phone=excluded.phone, customer_name=excluded.customer_name, recovery_url=excluded.recovery_url, currency=excluded.currency, total=excluded.total, updated_at=datetime('now')`)
    .run(String(tok), shop, uid, pickPhone(c), firstName(c), c.abandoned_checkout_url || "", c.currency || c.presentment_currency || "", parseFloat(c.total_price || 0) || 0);
}
webhookRouter.post("/checkouts_create", (req, res) => { if (!guard(req, res)) return; res.sendStatus(200); try { upsertCheckout(req); } catch (e) { console.error("[shopify checkouts_create]", e.message); } });
webhookRouter.post("/checkouts_update", (req, res) => { if (!guard(req, res)) return; res.sendStatus(200); try { upsertCheckout(req); } catch (e) { console.error("[shopify checkouts_update]", e.message); } });

// ── abandoned-cart recovery scheduler ──
let _timer = null;
async function processRecoveries(db) {
  ensureCommerce(db);
  const delayMin = RECOVERY_DELAY_MIN();
  try { db.prepare("UPDATE shopify_abandoned_checkouts SET status='expired', updated_at=datetime('now') WHERE status='open' AND created_at < datetime('now','-" + RECOVERY_EXPIRE_HRS + " hours')").run(); } catch (_) {}
  let due = [];
  try { due = db.prepare("SELECT * FROM shopify_abandoned_checkouts WHERE status='open' AND recovery_sent=0 AND phone IS NOT NULL AND phone<>'' AND created_at <= datetime('now','-" + delayMin + " minutes')").all() || []; } catch (_) {}
  for (const c of due) {
    try {
      const r = await sendTemplate(c.phone, TPL.recovery(), [c.customer_name || "there", c.recovery_url || ""]);
      db.prepare("UPDATE shopify_abandoned_checkouts SET recovery_sent=1, recovery_sent_at=datetime('now'), status='recovery_sent', updated_at=datetime('now') WHERE token=?").run(c.token);
      if (!r.ok) console.error("[shopify recovery]", c.token, r.reason);
    } catch (e) { console.error("[shopify recovery]", e.message); }
  }
}
function startRecoveryScheduler(db) {
  if (_timer) return;
  const everyMs = Math.max(1, parseInt(getSetting("SHOPIFY_RECOVERY_POLL_MIN") || "5", 10)) * 60000;
  _timer = setInterval(() => { processRecoveries(db).catch(() => {}); }, everyMs);
  if (_timer.unref) _timer.unref();
}

module.exports = { webhookRouter, ensureCommerce, startRecoveryScheduler, processRecoveries };
