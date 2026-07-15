// MINE — Shopify public app: install (OAuth) + identity + Shopify Billing.
//
// Option A pricing: a Shopify merchant pays SUBSCRIPTION ONLY, entirely through
// Shopify's Billing API — base Growth plan + one recurring line per hired agent +
// a usage line for overage. No MINE platform fee is charged on their sales
// (enforced in payments.js via the origin='shopify' flag set here).
//
// Money flow: merchant → Shopify → your Partner payout. You never touch a card.
//
// HONEST STATUS: this is the backend implementation, verified at compile/logic
// level. It requires a Shopify Partner app (SHOPIFY_API_KEY / SHOPIFY_API_SECRET
// in admin settings) + an App Store listing, and must be exercised against a live
// store. The GraphQL Admin API calls are written to Shopify's documented shapes
// (appSubscriptionCreate / appUsageRecordCreate) but are not run in this sandbox.

const express = require("express");
const crypto = require("crypto");
const { v4: uuid } = require("uuid");

const router = express.Router();                 // OAuth + billing (normal JSON body)
const webhookRouter = express.Router();          // webhooks (raw body for HMAC)

function getDb() { return require("../db/init").getDb(); }
function getSetting(k) {
  try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || process.env[k] || ""; }
  catch { return process.env[k] || ""; }
}

const API_VERSION = "2024-10";
const SCOPES = () => getSetting("SHOPIFY_SCOPES") || "read_products,write_products,read_orders,read_customers,write_customers";
const APP_URL = () => (getSetting("APP_URL") || getSetting("BACKEND_URL") || "https://app.takeova.ai").replace(/\/+$/, "");
const FRONTEND_URL = () => (getSetting("FRONTEND_URL") || "https://app.takeova.ai").replace(/\/+$/, "");
const BILLING_TEST = () => String(getSetting("SHOPIFY_BILLING_TEST") || "true") !== "false"; // default test mode until you flip it live

// ── Option A pricing ────────────────────────────────────────────────────
const BASE_PLAN = { name: "MINE — Growth", amount: 129.0 };       // the plan the app sells
const PLAN_TIERS = {
  growth:     { name: "Growth",     amount: 129.0 },
  pro:        { name: "Pro",        amount: 199.0 },
  enterprise: { name: "Enterprise", amount: 399.0 },
  agency:     { name: "Agency",     amount: 999.0 },
};
function planBase(db, userId, override) {
  let key = override;
  if (!key) { try { key = (db.prepare("SELECT plan FROM users WHERE id = ?").get(userId) || {}).plan; } catch (_) {} }
  return PLAN_TIERS[key] || PLAN_TIERS.growth;
}
const AGENT_PRICES = {                                            // mirrors payments.js AI add-ons
  sales: 79, support: 79, social: 89, bookkeeper: 79, marketing: 89, voice: 99,
  growth_agent: 89, csm: 49, legal: 89, community: 79,
  prospector_agent: 79, proposal_agent: 49, cold_email_agent: 69,
};
// mine_control is INCLUDED on Growth+ (Update 24) — never billed as an add-on line.
const USAGE_CAP_DEFAULT = 200.0;                                  // merchant-approved monthly overage ceiling (USD)

function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS shopify_installs (
    shop_domain TEXT PRIMARY KEY,
    user_id TEXT,
    access_token TEXT,
    scope TEXT,
    subscription_gid TEXT,
    usage_line_gid TEXT,
    usage_cap REAL DEFAULT ${USAGE_CAP_DEFAULT},
    status TEXT DEFAULT 'pending',
    installed_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec("CREATE TABLE IF NOT EXISTS shopify_oauth_state (shop TEXT PRIMARY KEY, nonce TEXT, created_at TEXT DEFAULT (datetime('now')))");
  try { db.exec("ALTER TABLE users ADD COLUMN origin TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE shopify_installs ADD COLUMN pending_plan TEXT"); } catch (_) {}
}

// ── HMAC ────────────────────────────────────────────────────────────────
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""), "utf8"), B = Buffer.from(String(b || ""), "utf8");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function verifyQueryHmac(query) {
  const secret = getSetting("SHOPIFY_API_SECRET"); if (!secret) return false;
  const { hmac, signature, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`).join("&");
  const digest = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  return safeEqual(digest, hmac);
}
function verifyWebhookHmac(rawBody, headerHmac) {
  const secret = getSetting("SHOPIFY_API_SECRET"); if (!secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(digest, headerHmac);
}
function cleanShop(shop) {
  const s = String(shop || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").split("/")[0];
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : "";
}

// ── Shopify Admin GraphQL ───────────────────────────────────────────────
async function shopifyGraphQL(shop, token, query) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  const json = await res.json().catch(() => ({}));
  return json;
}

// ── Billing: build line items (base + hired agents + usage), then create ──
function buildLineItemsGQL(db, userId, usageCap, planKey) {
  const money = (a) => `{ amount: ${Number(a).toFixed(2)}, currencyCode: USD }`;
  const lines = [];
  // base plan
  lines.push(`{ plan: { appRecurringPricingDetails: { price: ${money(planBase(db, userId, planKey).amount)}, interval: EVERY_30_DAYS } } }`);
  // one recurring line per active hired agent (mine_control excluded — it's included)
  let hired = [];
  try {
    hired = db.prepare("SELECT employee_id FROM ai_employee_subscriptions WHERE user_id = ? AND status = 'active'").all(userId) || [];
  } catch (_) {}
  for (const h of hired) {
    const price = AGENT_PRICES[h.employee_id];
    if (!price || h.employee_id === "mine_control") continue;
    lines.push(`{ plan: { appRecurringPricingDetails: { price: ${money(price)}, interval: EVERY_30_DAYS } } }`);
  }
  // usage line for overage (agent add-on overage + any metered usage)
  lines.push(`{ plan: { appUsagePricingDetails: { terms: "MINE usage & overage billed at plan rates", cappedAmount: ${money(usageCap || USAGE_CAP_DEFAULT)} } } }`);
  return lines.join(",\n        ");
}

async function createSubscription(db, shop) {
  ensure(db);
  const install = db.prepare("SELECT * FROM shopify_installs WHERE shop_domain = ?").get(shop);
  if (!install || !install.access_token || !install.user_id) throw new Error("install not ready");
  const returnUrl = `${APP_URL()}/api/shopify/billing/return?shop=${encodeURIComponent(shop)}`;
  const lineItems = buildLineItemsGQL(db, install.user_id, install.usage_cap, install.pending_plan);
  const mutation = `mutation {
    appSubscriptionCreate(
      name: "MINE",
      returnUrl: "${returnUrl}",
      test: ${BILLING_TEST()},
      lineItems: [
        ${lineItems}
      ]
    ) {
      userErrors { field message }
      confirmationUrl
      appSubscription { id lineItems { id plan { pricingDetails { __typename } } } }
    }
  }`;
  const out = await shopifyGraphQL(shop, install.access_token, mutation);
  const data = out && out.data && out.data.appSubscriptionCreate;
  if (!data || (data.userErrors && data.userErrors.length)) {
    throw new Error("appSubscriptionCreate: " + JSON.stringify(data && data.userErrors || out));
  }
  // capture the subscription id + the usage line id (for usage records)
  const sub = data.appSubscription || {};
  let usageLineGid = null;
  for (const li of (sub.lineItems || [])) {
    const t = li.plan && li.plan.pricingDetails && li.plan.pricingDetails.__typename;
    if (t === "AppUsagePricing") usageLineGid = li.id;
  }
  db.prepare("UPDATE shopify_installs SET subscription_gid = ?, usage_line_gid = ?, status = 'pending_approval', updated_at = datetime('now') WHERE shop_domain = ?")
    .run(sub.id || null, usageLineGid, shop);
  return { confirmationUrl: data.confirmationUrl, subscriptionGid: sub.id, usageLineGid };
}

// Recreate the subscription with the current agent set (call after hire/cancel).
// Shopify replaces the active subscription; merchant approves the new total once.
async function recreateSubscriptionForUser(db, userId) {
  ensure(db);
  const install = db.prepare("SELECT * FROM shopify_installs WHERE user_id = ?").get(userId);
  if (!install) throw new Error("no shopify install for user");
  return createSubscription(db, install.shop_domain);
}

// Post a usage charge (overage) against the merchant's usage line — same invoice,
// no per-charge approval (up to the capped amount). Called by the overage path.
async function recordOverageUsage(db, userId, amountUsd, description) {
  ensure(db);
  const install = db.prepare("SELECT * FROM shopify_installs WHERE user_id = ?").get(userId);
  if (!install || !install.usage_line_gid || !install.access_token) return { ok: false, reason: "no usage line" };
  const mutation = `mutation {
    appUsageRecordCreate(
      subscriptionLineItemId: "${install.usage_line_gid}",
      price: { amount: ${Number(amountUsd).toFixed(2)}, currencyCode: USD },
      description: ${JSON.stringify(String(description || "MINE usage").slice(0, 255))}
    ) {
      userErrors { field message }
      appUsageRecord { id }
    }
  }`;
  const out = await shopifyGraphQL(install.shop_domain, install.access_token, mutation);
  const data = out && out.data && out.data.appUsageRecordCreate;
  if (!data || (data.userErrors && data.userErrors.length)) {
    return { ok: false, reason: JSON.stringify((data && data.userErrors) || out) };
  }
  return { ok: true, id: data.appUsageRecord && data.appUsageRecord.id };
}

function isShopifyOrigin(db, userId) {
  try { return db.prepare("SELECT origin FROM users WHERE id = ?").get(userId)?.origin === "shopify"; }
  catch { return false; }
}
function getInstall(db, userId) {
  try { return db.prepare("SELECT * FROM shopify_installs WHERE user_id = ?").get(userId) || null; }
  catch { return null; }
}

// ── User provisioning on install ─────────────────────────────────────────
function provisionUser(db, shop) {
  const existing = db.prepare("SELECT user_id FROM shopify_installs WHERE shop_domain = ?").get(shop);
  if (existing && existing.user_id) {
    db.prepare("UPDATE users SET origin = 'shopify' WHERE id = ?").run(existing.user_id);
    return existing.user_id;
  }
  const id = uuid();
  const email = `shopify+${shop.replace(/\..*$/, "")}@takeova.ai`;
  const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existingUser) {
    db.prepare("UPDATE users SET origin = 'shopify', plan = 'growth' WHERE id = ?").run(existingUser.id);
    return existingUser.id;
  }
  db.prepare("INSERT INTO users (id, email, password_hash, name, plan, origin, account_status, join_date) VALUES (?,?,?,?,?,?, 'active', datetime('now'))")
    .run(id, email, "!shopify-oauth-no-password", shop.split(".")[0], "growth", "shopify");
  return id;
}

// ── Webhook registration (best-effort) ───────────────────────────────────
async function registerWebhooks(shop, token) {
  const topics = [
    ["APP_UNINSTALLED", "/api/shopify/webhooks/app_uninstalled"],
    ["APP_SUBSCRIPTIONS_UPDATE", "/api/shopify/webhooks/app_subscriptions_update"],
    ["CUSTOMERS_DATA_REQUEST", "/api/shopify/webhooks/customers_data_request"],
    ["CUSTOMERS_REDACT", "/api/shopify/webhooks/customers_redact"],
    ["SHOP_REDACT", "/api/shopify/webhooks/shop_redact"],
    ["ORDERS_CREATE", "/api/shopify/webhooks/orders_create"],
    ["ORDERS_FULFILLED", "/api/shopify/webhooks/orders_fulfilled"],
    ["CHECKOUTS_CREATE", "/api/shopify/webhooks/checkouts_create"],
    ["CHECKOUTS_UPDATE", "/api/shopify/webhooks/checkouts_update"],
  ];
  for (const [topic, path] of topics) {
    const cb = `${APP_URL()}${path}`;
    const m = `mutation { webhookSubscriptionCreate(topic: ${topic}, webhookSubscription: { callbackUrl: "${cb}", format: JSON }) { userErrors { message } webhookSubscription { id } } }`;
    try { await shopifyGraphQL(shop, token, m); } catch (_) {}
  }
}

// ─────────────────────────── OAuth ───────────────────────────────────────
router.get("/shopify/install", (req, res) => {
  const shop = cleanShop(req.query.shop);
  if (!shop) return res.status(400).send("Missing or invalid ?shop (must be your-store.myshopify.com)");
  const apiKey = getSetting("SHOPIFY_API_KEY");
  if (!apiKey) return res.status(500).send("Shopify app not configured — set SHOPIFY_API_KEY / SHOPIFY_API_SECRET in admin settings.");
  const db = getDb(); ensure(db);
  const nonce = crypto.randomBytes(16).toString("hex");
  db.prepare("INSERT INTO shopify_installs (shop_domain, status) VALUES (?, 'pending') ON CONFLICT(shop_domain) DO UPDATE SET updated_at = datetime('now')").run(shop);
  db.prepare("INSERT INTO shopify_oauth_state (shop, nonce) VALUES (?,?) ON CONFLICT(shop) DO UPDATE SET nonce = excluded.nonce, created_at = datetime('now')").run(shop, nonce);
  const redirectUri = `${APP_URL()}/api/shopify/callback`;
  const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(apiKey)}&scope=${encodeURIComponent(SCOPES())}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${nonce}`;
  res.redirect(url);
});

router.get("/shopify/callback", async (req, res) => {
  try {
    const shop = cleanShop(req.query.shop);
    if (!shop) return res.status(400).send("Invalid shop");
    if (!verifyQueryHmac(req.query)) return res.status(401).send("HMAC verification failed");
    const db = getDb(); ensure(db);
    const st = db.prepare("SELECT nonce FROM shopify_oauth_state WHERE shop = ?").get(shop);
    if (!st || st.nonce !== String(req.query.state || "")) return res.status(401).send("State (nonce) mismatch");

    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: getSetting("SHOPIFY_API_KEY"),
        client_secret: getSetting("SHOPIFY_API_SECRET"),
        code: String(req.query.code || ""),
      }),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tok.access_token) return res.status(400).send("Could not obtain Shopify access token");

    const userId = provisionUser(db, shop);
    db.prepare(`INSERT INTO shopify_installs (shop_domain, user_id, access_token, scope, status, updated_at)
      VALUES (?,?,?,?, 'installed', datetime('now'))
      ON CONFLICT(shop_domain) DO UPDATE SET user_id = excluded.user_id, access_token = excluded.access_token, scope = excluded.scope, status = 'installed', updated_at = datetime('now')`)
      .run(shop, userId, tok.access_token, tok.scope || SCOPES());

    registerWebhooks(shop, tok.access_token).catch(() => {});

    // Two-way sync: register product/customer/order webhooks + pull existing data.
    try {
      const SYNC = require("./shopify-sync");
      SYNC.registerSyncWebhooks(shop, tok.access_token).catch(() => {});
      SYNC.backfillFromShopify(db, shop).catch((e) => console.error("[shopify backfill]", e.message));
    } catch (e) { console.error("[shopify sync init]", e.message); }

    // Straight into Shopify's billing approval for the base plan.
    let conf = null;
    try { conf = await createSubscription(db, shop); } catch (e) { console.error("[shopify billing]", e.message); }
    if (conf && conf.confirmationUrl) return res.redirect(conf.confirmationUrl);
    return res.redirect(`${FRONTEND_URL()}/?shopify_installed=1`);
  } catch (e) {
    console.error("[shopify callback]", e.message);
    return res.status(500).send("Install failed");
  }
});

// Shopify redirects here after the merchant approves the charge.
router.get("/shopify/billing/return", (req, res) => {
  try {
    const shop = cleanShop(req.query.shop);
    const db = getDb(); ensure(db);
    if (shop) {
      const _inst = db.prepare("SELECT user_id, pending_plan FROM shopify_installs WHERE shop_domain = ?").get(shop);
      db.prepare("UPDATE shopify_installs SET status = 'active', updated_at = datetime('now') WHERE shop_domain = ?").run(shop);
      if (_inst && _inst.pending_plan && _inst.user_id) {
        try { db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(_inst.pending_plan, _inst.user_id); } catch (_) {}
        try { db.prepare("UPDATE shopify_installs SET pending_plan = NULL WHERE shop_domain = ?").run(shop); } catch (_) {}
      }
    }
  } catch (_) {}
  res.redirect(`${FRONTEND_URL()}/?shopify_active=1`);
});

// Embedded app calls this when the merchant hires/cancels an agent → recreate the
// subscription with the new line set; client redirects to the returned confirmationUrl.
router.post("/shopify/billing/recreate", async (req, res) => {
  try {
    const db = getDb(); ensure(db);
    const m = require("../middleware/auth");
    m.auth(req, res, async () => {
      try {
        if (!isShopifyOrigin(db, req.userId)) return res.status(400).json({ error: "Not a Shopify-billed account" });
        const conf = await recreateSubscriptionForUser(db, req.userId);
        res.json({ confirmationUrl: conf.confirmationUrl });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────── Webhooks (raw body) ─────────────────────────
function rawJson(req) { try { return JSON.parse(req.body.toString("utf8")); } catch { return {}; } }
webhookRouter.use(express.raw({ type: "*/*", limit: "2mb" }));
function webhookGuard(req, res) {
  const ok = verifyWebhookHmac(req.body, req.get("X-Shopify-Hmac-Sha256"));
  if (!ok) { res.status(401).send("hmac"); return false; }
  return true;
}

webhookRouter.post("/app_uninstalled", (req, res) => {
  if (!webhookGuard(req, res)) return;
  try {
    const shop = cleanShop(req.get("X-Shopify-Shop-Domain"));
    const db = getDb(); ensure(db);
    const row = db.prepare("SELECT user_id FROM shopify_installs WHERE shop_domain = ?").get(shop);
    db.prepare("UPDATE shopify_installs SET status = 'uninstalled', access_token = NULL, updated_at = datetime('now') WHERE shop_domain = ?").run(shop);
    // Revoke access (entitlement gone) without deleting their data.
    if (row && row.user_id) db.prepare("UPDATE users SET account_status = 'paused' WHERE id = ?").run(row.user_id);
  } catch (_) {}
  res.sendStatus(200);
});

webhookRouter.post("/app_subscriptions_update", (req, res) => {
  if (!webhookGuard(req, res)) return;
  try {
    const shop = cleanShop(req.get("X-Shopify-Shop-Domain"));
    const body = rawJson(req);
    const sub = body.app_subscription || {};
    const statusMap = { ACTIVE: "active", CANCELLED: "cancelled", FROZEN: "frozen", DECLINED: "declined", EXPIRED: "expired", PENDING: "pending_approval" };
    const db = getDb(); ensure(db);
    const st = statusMap[String(sub.status || "").toUpperCase()] || "active";
    db.prepare("UPDATE shopify_installs SET status = ?, updated_at = datetime('now') WHERE shop_domain = ?").run(st, shop);
    const row = db.prepare("SELECT user_id FROM shopify_installs WHERE shop_domain = ?").get(shop);
    if (row && row.user_id) {
      db.prepare("UPDATE users SET account_status = ? WHERE id = ?").run(st === "active" ? "active" : "paused", row.user_id);
    }
  } catch (_) {}
  res.sendStatus(200);
});

// Mandatory GDPR webhooks — must exist + verify HMAC to pass App Store review.
webhookRouter.post("/customers_data_request", (req, res) => {
  if (!webhookGuard(req, res)) return;
  // MINE does not store a Shopify shopper's personal data beyond what the merchant
  // syncs into their own account; nothing to assemble here. Acknowledge.
  res.sendStatus(200);
});
webhookRouter.post("/customers_redact", (req, res) => {
  if (!webhookGuard(req, res)) return;
  res.sendStatus(200);
});
webhookRouter.post("/shop_redact", (req, res) => {
  if (!webhookGuard(req, res)) return;
  try {
    const shop = cleanShop(req.get("X-Shopify-Shop-Domain"));
    const db = getDb(); ensure(db);
    db.prepare("UPDATE shopify_installs SET access_token = NULL, status = 'redacted', updated_at = datetime('now') WHERE shop_domain = ?").run(shop);
  } catch (_) {}
  res.sendStatus(200);
});

// ─────────────────────── Embedded admin (App Bridge) ─────────────────────
// Session-token auth: App Bridge mints a JWT signed (HS256) with the app secret.
// We verify it and resolve shop -> install -> MINE user. No MINE login needed —
// the merchant is authenticated by Shopify.
function b64urlToStr(x) { return Buffer.from(String(x).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
function verifySessionToken(token) {
  try {
    const secret = getSetting("SHOPIFY_API_SECRET"); const apiKey = getSetting("SHOPIFY_API_KEY");
    if (!secret || !token) return null;
    const parts = String(token).split("."); if (parts.length !== 3) return null;
    const [h, pl, sig] = parts;
    const expected = crypto.createHmac("sha256", secret).update(h + "." + pl).digest("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (!safeEqual(expected, sig)) return null;
    const payload = JSON.parse(b64urlToStr(pl));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > Number(payload.exp)) return null;
    if (payload.nbf && now < Number(payload.nbf) - 5) return null;
    if (apiKey && payload.aud && payload.aud !== apiKey) return null;
    return cleanShop(String(payload.dest || "").replace(/^https?:\/\//, "")) || null;
  } catch { return null; }
}
function requireSessionToken(req, res, next) {
  const a = req.get("Authorization") || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : String(req.query.id_token || "");
  const shop = verifySessionToken(token);
  if (!shop) return res.status(401).json({ error: "Invalid or missing Shopify session token" });
  const db = getDb(); ensure(db);
  const install = db.prepare("SELECT * FROM shopify_installs WHERE shop_domain = ?").get(shop);
  if (!install || !install.user_id) return res.status(401).json({ error: "No install for shop" });
  req.shop = shop; req.install = install; req.shopifyUserId = install.user_id; req._db = db;
  next();
}

// Agents shown in the embedded grid (prices mirror payments.js). mine_control is
// included on Growth+ and is shown as such, never as an add-on.
const ADMIN_AGENTS = [
  { id: "support", name: "AI Support Agent", price: 79, desc: "24/7 support replies and live chat" },
  { id: "sales", name: "AI Sales Rep", price: 79, desc: "Follows up leads via email/SMS/WhatsApp" },
  { id: "social", name: "AI Social Manager", price: 89, desc: "Writes and schedules posts across platforms" },
  { id: "marketing", name: "AI Marketing Manager", price: 89, desc: "Campaigns, ad copy, funnel optimisation" },
  { id: "csm", name: "AI Customer Success", price: 49, desc: "Churn prevention and win-backs" },
  { id: "community", name: "Community Engagement", price: 79, desc: "Replies on Reddit and X to drive traffic" },
  { id: "voice", name: "AI Receptionist", price: 99, desc: "Answers calls, books appointments" },
  { id: "bookkeeper", name: "AI Bookkeeper", price: 79, desc: "Categorises transactions, flags anomalies" },
  { id: "legal", name: "AI Legal Employee", price: 89, desc: "Drafts and reviews contracts" },
  { id: "cold_email_agent", name: "AI Cold Email Agent", price: 69, desc: "Researches prospects and writes emails" },
  { id: "prospector_agent", name: "Prospector Agent", price: 79, desc: "Finds businesses, builds demos, outreach" },
  { id: "proposal_agent", name: "AI Proposal Agent", price: 49, desc: "Generates personalised proposals" },
  { id: "growth_agent", name: "TAKEOVA Growth Agent", price: 89, desc: "Daily analysis and growth tasks" },
];

// Embedded entry — set your Shopify App URL to {APP_URL}/api/shopify/admin
router.get("/shopify/admin", (req, res) => {
  const shop = cleanShop(req.query.shop) || "";
  res.removeHeader("X-Frame-Options"); // must be frameable by the admin
  res.set("Content-Security-Policy", `frame-ancestors https://${shop || "*.myshopify.com"} https://admin.shopify.com;`);
  res.type("html").send(adminHTML());
});

router.get("/shopify/admin/state", requireSessionToken, (req, res) => {
  const db = req._db;
  let active = [];
  try { active = (db.prepare("SELECT employee_id FROM ai_employee_subscriptions WHERE user_id = ? AND status = 'active'").all(req.shopifyUserId) || []).map(r => r.employee_id); } catch (_) {}
  let wa = false;
  try { wa = !!db.prepare("SELECT whatsapp_verified FROM mine_control_config WHERE user_id = ?").get(req.shopifyUserId)?.whatsapp_verified; } catch (_) {}
  let planKey = "growth";
  try { planKey = (db.prepare("SELECT plan FROM users WHERE id = ?").get(req.shopifyUserId) || {}).plan || "growth"; } catch (_) {}
  if (!PLAN_TIERS[planKey]) planKey = "growth";
  res.json({
    shop: req.shop,
    subscription: req.install.status,
    currentPlan: planKey,
    base: { name: PLAN_TIERS[planKey].name, price: PLAN_TIERS[planKey].amount },
    plans: Object.keys(PLAN_TIERS).map(k => ({ id: k, name: PLAN_TIERS[k].name, price: PLAN_TIERS[k].amount, current: k === planKey })),
    mineControlIncluded: true,
    whatsappConnected: wa,
    agents: ADMIN_AGENTS.map(a => Object.assign({}, a, { active: active.includes(a.id) })),
  });
});

router.post("/shopify/admin/hire", requireSessionToken, async (req, res) => {
  try {
    const db = req._db; const employee_id = String((req.body && req.body.employee_id) || "");
    const meta = ADMIN_AGENTS.find(a => a.id === employee_id);
    if (!meta) return res.status(400).json({ error: "Unknown agent" });
    const ex = db.prepare("SELECT id FROM ai_employee_subscriptions WHERE user_id = ? AND employee_id = ?").get(req.shopifyUserId, employee_id);
    const subId = (ex && ex.id) ? ex.id : uuid();
    db.prepare("INSERT OR REPLACE INTO ai_employee_subscriptions (id, user_id, employee_id, employee_name, monthly_fee, status, hired_at) VALUES (?,?,?,?,?, 'active', datetime('now'))")
      .run(subId, req.shopifyUserId, employee_id, meta.name, meta.price);
    const conf = await recreateSubscriptionForUser(db, req.shopifyUserId);
    res.json({ confirmationUrl: conf.confirmationUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/shopify/admin/cancel", requireSessionToken, async (req, res) => {
  try {
    const db = req._db; const employee_id = String((req.body && req.body.employee_id) || "");
    db.prepare("UPDATE ai_employee_subscriptions SET status = 'cancelled' WHERE user_id = ? AND employee_id = ?").run(req.shopifyUserId, employee_id);
    const conf = await recreateSubscriptionForUser(db, req.shopifyUserId);
    res.json({ confirmationUrl: conf.confirmationUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/shopify/admin/change-plan", requireSessionToken, async (req, res) => {
  try {
    const db = req._db;
    const plan = String((req.body && req.body.plan) || "").toLowerCase();
    if (!PLAN_TIERS[plan]) return res.status(400).json({ error: "Unknown plan" });
    db.prepare("UPDATE shopify_installs SET pending_plan = ? WHERE user_id = ?").run(plan, req.shopifyUserId);
    const conf = await recreateSubscriptionForUser(db, req.shopifyUserId);
    res.json({ confirmationUrl: conf.confirmationUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/shopify/admin/dashboard-link", requireSessionToken, (req, res) => {
  try {
    const { signToken } = require("../middleware/auth");
    const db = req._db; let role = "user";
    try { role = db.prepare("SELECT role FROM users WHERE id = ?").get(req.shopifyUserId)?.role || "user"; } catch (_) {}
    const token = signToken(req.shopifyUserId, role);
    res.json({ url: FRONTEND_URL() + "/?mine_sso=" + encodeURIComponent(token) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function adminHTML() {
  const apiKey = getSetting("SHOPIFY_API_KEY");
  const dash = FRONTEND_URL();
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="shopify-api-key" content="${apiKey}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>MINE</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
button,a{touch-action:manipulation}
:root{--p:#4F46E5;--p2:#6366F1;--gn:#16A34A;--rd:#DC2626;--tx:#111827;--mt:#6B7280;--dm:#9CA3AF;--bd:#F3F4F6;--bd2:#E5E7EB;--bg:#F9FAFB;--bg2:#FFFFFF;--sh:0 1px 2px rgba(15,23,42,.04),0 4px 16px rgba(15,23,42,.08);--gr:linear-gradient(135deg,#4F46E5,#6366F1);}
html,body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:18px 20px 40px}
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px 2px 20px}
.logo{font-weight:900;font-size:21px;background:var(--gr);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-.4px;line-height:1}
.logo-sub{font-size:10px;color:var(--dm);font-weight:600;margin-top:3px;text-transform:uppercase;letter-spacing:.6px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:20px;font-size:11px;font-weight:600}
.pill.ok{background:rgba(22,163,74,.09);color:#15803D}.pill.warn{background:rgba(217,119,6,.1);color:#B45309}
.pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.sr{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.sc{background:var(--bg2);border-radius:12px;padding:14px 16px;box-shadow:var(--sh)}
.sn{font-size:22px;font-weight:800;letter-spacing:-.8px;margin-bottom:3px;line-height:1}
.sn.txt{font-size:15px;letter-spacing:-.2px}
.sl{font-size:10px;color:var(--dm);font-weight:600;text-transform:uppercase;letter-spacing:.6px}
.intro{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:rgba(79,70,229,.03);border:1px solid rgba(79,70,229,.1);border-radius:12px;padding:14px 16px;margin-bottom:20px}
.intro .it{flex:1;min-width:200px}.intro .ip{font-size:14px;font-weight:700;letter-spacing:-.2px}.intro .is{font-size:12px;color:var(--mt);margin-top:2px}
.tag-inc{display:inline-flex;align-items:center;gap:5px;margin-top:7px;padding:3px 9px;border-radius:5px;font-size:10.5px;font-weight:600;background:rgba(22,163,74,.08);color:#15803D}
.stitle{font-size:11px;font-weight:600;color:var(--dm);text-transform:uppercase;letter-spacing:.7px;margin:4px 2px 12px}
.list{display:flex;flex-direction:column;gap:8px}
.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:6px}
@media(max-width:768px){.plans{grid-template-columns:1fr 1fr}}
.plan{background:var(--bg2);border:1px solid var(--bd2);border-radius:12px;padding:14px;text-align:center;box-shadow:var(--sh)}
.plan.cur{border-color:var(--p);box-shadow:0 0 0 1px var(--p)}
.pl-name{font-weight:700;font-size:13px;margin-bottom:4px}
.pl-price{font-weight:800;font-size:18px;letter-spacing:-.4px;color:var(--tx)}
.pl-price span{font-size:11px;font-weight:600;color:var(--dm)}
.pl-badge{display:inline-block;margin-top:8px;font-size:10.5px;font-weight:600;color:var(--p)}
.pl-btn{margin-top:8px;width:100%;background:var(--p);color:#fff;border:none;border-radius:8px;padding:7px 0;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.pl-btn:hover{background:#4338CA}.pl-btn:active{transform:scale(.97)}
.arow{display:flex;align-items:center;gap:12px;background:var(--bg2);border-radius:12px;padding:13px 15px;box-shadow:var(--sh);transition:background .2s}
.arow.on{background:rgba(79,70,229,.045)}
.ric{font-size:18px;flex-shrink:0;width:38px;height:38px;display:flex;align-items:center;justify-content:center;background:var(--bg);border-radius:9px;transition:background .2s}
.arow.on .ric{background:#fff}
.rinfo{flex:1;min-width:0}.rn{font-size:13.5px;font-weight:600;letter-spacing:-.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rs{font-size:11.5px;color:var(--dm);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.price{flex-shrink:0;font-size:13px;font-weight:700;color:var(--tx);text-align:right}.price span{font-size:10.5px;font-weight:600;color:var(--dm)}
.right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.atag{display:none;padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:600;background:rgba(22,163,74,.08);color:#15803D}
.arow.on .atag{display:inline-flex}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:all .15s;white-space:nowrap}
.bp{background:var(--p);color:#fff;box-shadow:0 4px 12px rgba(79,70,229,.28)}.bp:hover{background:#4338CA}.bp:active{transform:scale(.97)}
.bgh{background:transparent;border:1.5px solid var(--bd2);color:var(--mt)}.bgh:hover{border-color:#F1C7C1;color:var(--rd);background:#FEF2F2}.bgh:active{transform:scale(.97)}
.cta{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:8px;font-size:12.5px;font-weight:600;color:#fff;text-decoration:none;background:var(--gr);box-shadow:0 4px 12px rgba(79,70,229,.28);border:none;cursor:pointer;font-family:inherit}.cta:active{transform:scale(.98)}
.loading{padding:40px;text-align:center;color:var(--dm);font-size:13px}
@media(max-width:768px){.sr{grid-template-columns:1fr 1fr;gap:8px}.sc{padding:12px 14px}.sn{font-size:18px}.sn.txt{font-size:14px}.intro .it{min-width:0;flex-basis:100%}.cta{width:100%;justify-content:center}}
</style></head>
<body>
<div class="wrap">
  <div class="bar"><div><div class="logo">MINE</div><div class="logo-sub">for Shopify</div></div><span id="status"></span></div>
  <div id="app"><div class="loading">Loading your TAKEOVA workspace…</div></div>
</div>
<script>
var DASH=${JSON.stringify(dash)};
var EMOJI={support:"💬",sales:"📈",social:"📣",marketing:"🎯",csm:"🤝",community:"👥",voice:"☎️",bookkeeper:"📊",legal:"⚖️",cold_email_agent:"✉️",prospector_agent:"🔭",proposal_agent:"📄",growth_agent:"🚀"};
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
async function idToken(){try{return await shopify.idToken();}catch(e){return "";}}
async function api(path,opts){opts=opts||{};var t=await idToken();var h=Object.assign({"Authorization":"Bearer "+t,"Content-Type":"application/json"},opts.headers||{});var r=await fetch(path,Object.assign({},opts,{headers:h}));return r.json();}
function money(n){return "$"+Math.round(n);}
function render(s){
  var on=s.subscription==="active";
  document.getElementById("status").innerHTML='<span class="pill '+(on?"ok":"warn")+'"><span class="dot"></span> '+(on?"Subscription active":"Subscription "+esc(s.subscription||"pending"))+'</span>';
  var base=(s.base&&s.base.price)||129,active=0,total=base,wa=s.whatsappConnected;
  (s.agents||[]).forEach(function(a){if(a.active){active++;total+=a.price;}});
  var h='';
  h+='<div class="sr">';
  h+='<div class="sc"><div class="sn" style="color:var(--tx)">'+money(base)+'</div><div class="sl">Base plan</div></div>';
  h+='<div class="sc"><div class="sn" style="color:var(--gn)">'+active+'</div><div class="sl">Agents active</div></div>';
  h+='<div class="sc"><div class="sn" style="color:var(--p)">'+money(total)+'</div><div class="sl">Monthly total</div></div>';
  h+='<div class="sc"><div class="sn txt" style="color:'+(wa?"var(--gn)":"var(--dm)")+'">'+(wa?"Connected":"Not set")+'</div><div class="sl">WhatsApp</div></div>';
  h+='</div>';
  h+='<div class="intro"><div class="it"><div class="ip">'+esc((s.base&&s.base.name)||"TAKEOVA Growth")+'</div><div class="is">Billed monthly through Shopify</div>';
  if(s.mineControlIncluded!==false)h+='<span class="tag-inc">✓ Take Control (WhatsApp) included</span>';
  h+='</div><button class="cta" onclick="openDash()">Open full dashboard →</button></div>';
  h+='<div class="stitle">Your plan</div><div class="plans">';
  (s.plans||[]).forEach(function(pl){ h+='<div class="plan'+(pl.current?" cur":"")+'"><div class="pl-name">'+esc(pl.name)+'</div><div class="pl-price">$'+pl.price+'<span>/mo</span></div>'+(pl.current?'<span class="pl-badge">Current plan</span>':'<button class="pl-btn" onclick="changePlan(\''+esc(pl.id)+'\')">Switch</button>')+'</div>'; });
  h+='</div>';
  h+='<div class="stitle">AI employees</div><div class="list" id="list"></div>';
  document.getElementById("app").innerHTML=h;
  var list=document.getElementById("list");
  (s.agents||[]).forEach(function(a){
    var r=document.createElement("div");r.className="arow"+(a.active?" on":"");
    r.innerHTML='<span class="ric">'+(EMOJI[a.id]||"🤖")+'</span><div class="rinfo"><div class="rn">'+esc(a.name)+'</div><div class="rs">'+esc(a.desc||"")+'</div></div><span class="price">$'+a.price+'<span>/mo</span></span><div class="right"><span class="atag">Active</span></div>';
    var btn=document.createElement("button");
    btn.className="btn "+(a.active?"bgh":"bp");btn.textContent=a.active?"Remove":"Add";
    btn.onclick=function(){act(a.active?"cancel":"hire",a.id,btn);};
    r.querySelector(".right").appendChild(btn);
    list.appendChild(r);
  });
}
async function act(kind,id,btn){
  btn.disabled=true;var old=btn.textContent;btn.textContent="…";
  try{
    var r=await api("/api/shopify/admin/"+kind,{method:"POST",body:JSON.stringify({employee_id:id})});
    if(r&&r.confirmationUrl){open(r.confirmationUrl,"_top");return;}
    btn.disabled=false;btn.textContent=old;alert((r&&r.error)||"Could not update your plan. Please try again.");
  }catch(e){btn.disabled=false;btn.textContent=old;alert("Network error. Please try again.");}
}
async function openDash(){var r=await api("/api/shopify/admin/dashboard-link");if(r&&r.url){open(r.url,"_top");}}
async function changePlan(plan){var r=await api("/api/shopify/admin/change-plan",{method:"POST",body:JSON.stringify({plan:plan})});if(r&&r.confirmationUrl){open(r.confirmationUrl,"_top");}else{alert((r&&r.error)||"Could not change plan. Please try again.");}}
async function load(){
  try{
    var s=await api("/api/shopify/admin/state");
    if(s&&s.error){document.getElementById("app").innerHTML='<div class="loading">Could not load — reopen MINE from your Shopify admin.</div>';return;}
    render(s);
  }catch(e){document.getElementById("app").innerHTML='<div class="loading">Failed to load.</div>';}
}
load();
</script>
</body></html>`;
}

module.exports = {
  router,
  webhookRouter,
  // helpers used by the rest of the app
  recordOverageUsage,
  recreateSubscriptionForUser,
  isShopifyOrigin,
  getInstall,
  ensure,
};
