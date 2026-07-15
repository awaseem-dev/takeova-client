/**
 * MINE Crypto Payments — Coinbase Commerce integration
 *
 * Flow:
 *   1. Customer picks "Pay with Crypto" at checkout
 *   2. POST /crypto/checkout  → creates Coinbase charge (inflated by 2.5%)
 *   3. Customer pays on Coinbase-hosted page
 *   4. POST /crypto/webhook   → Coinbase confirms → mark order paid, log platform fee
 *   5. Month-end cron bills accumulated platform fees via Stripe overage invoice
 */

const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 10, keyGenerator: r => r.ip });

const PLATFORM_FEE_PCT = parseFloat(process.env.PLATFORM_FEE_PERCENT || "2.5");

// Tiered platform fee by plan — matches payments.js getFeeForPlan logic.
// Crypto checkout uses the same tiered structure as Stripe checkout for parity.
const PLAN_FEE_PERCENT_CRYPTO = {
  starter:        2.5,
  growth:         2.0,
  pro:            1.5,
  enterprise:     1.0,
  agency_client:  1.0,
  trial:          2.5,
  agency:         2.5,
};
function getFeeForPlanCrypto(plan) {
  if (!plan) return PLATFORM_FEE_PCT;
  return PLAN_FEE_PERCENT_CRYPTO[plan] !== undefined ? PLAN_FEE_PERCENT_CRYPTO[plan] : PLATFORM_FEE_PCT;
}

const COINBASE_API     = "https://api.commerce.coinbase.com";
const COINBASE_VERSION = "2018-03-22";

// ── helpers ────────────────────────────────────────────────────────────────

function getCoinbaseKey(userId) {
  const db = getDb();
  // Per-user key stored in user_settings; fall back to global platform key
  try {
    const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'COINBASE_COMMERCE_API_KEY'").get(userId);
    if (row?.value) return row.value;
  } catch(e) {}
  return getSetting("COINBASE_COMMERCE_API_KEY") || "";
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crypto_orders (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      site_id       TEXT,
      charge_id     TEXT UNIQUE,
      charge_code   TEXT,
      order_total   REAL,
      platform_fee  REAL,
      currency      TEXT DEFAULT 'USD',
      status        TEXT DEFAULT 'pending',
      items_json    TEXT,
      customer_email TEXT,
      confirmed_at  TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_orders_user   ON crypto_orders(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_crypto_orders_charge ON crypto_orders(charge_id);
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT,
      PRIMARY KEY (user_id, key)
    );
  `);
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/crypto/checkout
// Called from the TAKEOVA site storefront when a customer picks crypto payment
// ═══════════════════════════════════════════════════════════════════════════
router.post("/checkout", checkoutLimiter, async (req, res) => {
  try {
    const { siteId, items, customerEmail, successUrl, cancelUrl } = req.body;
    if (!siteId || !items?.length) {
      return res.status(400).json({ error: "siteId and items are required" });
    }

    const db = getDb();
    ensureTables(db);

    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    // ── Check business has crypto enabled & API key set ──
    const apiKey = getCoinbaseKey(site.user_id);
    if (!apiKey) {
      return res.status(400).json({
        error: "This store hasn't set up crypto payments yet.",
        setup_required: true
      });
    }

    // ── Minimum order check (default $50 / $50) ──
    const minCryptoOrderRaw = db.prepare(
      "SELECT value FROM user_settings WHERE user_id = ? AND key = 'CRYPTO_MIN_ORDER'"
    ).get(site.user_id);
    const minOrder = parseFloat(minCryptoOrderRaw?.value || "50");

    // ── Validate prices server-side — never trust client amounts ──
    const validated = [];
    for (const item of items) {
      const dbProduct = db.prepare(
        "SELECT price, name FROM products WHERE user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1"
      ).get(site.user_id, item.name);
      if (!dbProduct) {
        return res.status(400).json({ error: `Product not found: ${item.name}` });
      }
      // Clamp quantity to a positive integer in a sane range.
      // Prevents negative quantities (would turn into a credit), fractional
      // (half-price purchases), and absurdly large values (Infinity / NaN).
      const qty = Math.max(1, Math.min(1000, Math.floor(Number(item.quantity) || 1)));
      validated.push({ ...item, price: dbProduct.price, quantity: qty });
    }

    const subtotalCents = validated.reduce(
      (s, i) => s + Math.round(i.price * 100) * i.quantity, 0
    );
    const subtotal = subtotalCents / 100;

    if (subtotal < minOrder) {
      return res.status(400).json({
        error: `Minimum order for crypto payment is ${minOrder}. Order total is ${subtotal.toFixed(2)}.`
      });
    }

    // ── Look up site owner's plan to apply the tiered platform fee ──
    // Starter 2.5% / Growth 2.0% / Pro 1.5% / Enterprise 1.0% — same as Stripe checkout.
    const ownerPlan = db.prepare("SELECT plan FROM users WHERE id = ?").get(site.user_id)?.plan;
    const feePct = getFeeForPlanCrypto(ownerPlan);

    // ── Inflate by tiered platform fee ──
    const platformFee   = Math.round(subtotal * (feePct / 100) * 100) / 100;
    const chargeAmount  = Math.round((subtotal + platformFee) * 100) / 100;

    // ── Currency from site settings ──
    let currency = "USD";
    try {
      const sm = db.prepare("SELECT site_meta FROM sites WHERE id = ?").get(siteId);
      const meta = JSON.parse(sm?.site_meta || "{}");
      if (meta.currency) currency = meta.currency.toUpperCase();
    } catch(e) {}

    // ── Create Coinbase Commerce charge ──
    const chargePayload = {
      name:         site.name || "Order",
      description:  validated.map(i => `${i.quantity || 1}x ${i.name}`).join(", "),
      local_price:  { amount: chargeAmount.toFixed(2), currency },
      pricing_type: "fixed_price",
      metadata: {
        mine_site:     siteId,
        mine_user:     site.user_id,
        platform_fee:  platformFee.toFixed(2),
        order_subtotal: subtotal.toFixed(2),
        customer_email: customerEmail || "",
        items:         JSON.stringify(validated.map(i => ({ name: i.name, price: i.price, qty: i.quantity || 1 })))
      },
      redirect_url:  successUrl  || `${process.env.FRONTEND_URL || ""}/order-complete`,
      cancel_url:    cancelUrl   || `${process.env.FRONTEND_URL || ""}/cart`
    };

    const cbRes = await fetch(`${COINBASE_API}/charges`, {
      method: "POST",
      headers: {
        "X-CC-Api-Key":  apiKey,
        "X-CC-Version":  COINBASE_VERSION,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify(chargePayload)
    });

    if (!cbRes.ok) {
      const err = await cbRes.json().catch(() => ({}));
      console.error("[Crypto] Coinbase charge creation failed:", err);
      return res.status(502).json({ error: "Failed to create crypto charge. Check your Coinbase API key." });
    }

    const cbData  = await cbRes.json();
    const charge  = cbData.data;

    // ── Log the pending crypto order ──
    const orderId = uuid();
    db.prepare(`
      INSERT INTO crypto_orders
        (id, user_id, site_id, charge_id, charge_code, order_total, platform_fee, currency, status, items_json, customer_email)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      orderId, site.user_id, siteId,
      charge.id, charge.code,
      chargeAmount, platformFee, currency,
      "pending",
      JSON.stringify(validated),
      customerEmail || ""
    );

    res.json({
      success:    true,
      charge_id:  charge.id,
      charge_code: charge.code,
      hosted_url: charge.hosted_url,          // redirect customer here
      expires_at: charge.expires_at,
      amount:     chargeAmount,
      currency,
      order_id:   orderId
    });

  } catch(e) {
    console.error("[Crypto] Checkout error:", e.message);
    res.status(500).json({ error: "An error occurred creating the crypto charge" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/crypto/status/:chargeId
// Polled by the success page to check if payment confirmed
// ═══════════════════════════════════════════════════════════════════════════
router.get("/status/:chargeId", async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);

    const order = db.prepare(
      "SELECT * FROM crypto_orders WHERE charge_id = ?"
    ).get(req.params.chargeId);

    if (!order) return res.status(404).json({ error: "Order not found" });

    // If already confirmed in our DB, return immediately
    if (order.status === "confirmed") {
      return res.json({ status: "confirmed", confirmed: true, order_total: order.order_total, currency: order.currency, confirmed_at: order.confirmed_at });
    }

    // Live check against Coinbase API — don't wait for webhook
    const apiKey = getCoinbaseKey(order.user_id);
    if (apiKey) {
      try {
        const cbRes = await fetch(`${COINBASE_API}/charges/${req.params.chargeId}`, {
          headers: {
            "X-CC-Api-Key": apiKey,
            "X-CC-Version": COINBASE_VERSION
          }
        });

        if (cbRes.ok) {
          const cbData = await cbRes.json();
          const charge = cbData.data;
          // Coinbase timeline events — most recent event drives status
          const timeline = charge.timeline || [];
          const latestStatus = timeline.length > 0
            ? timeline[timeline.length - 1].status
            : charge.pricing_type;

          const isConfirmed = ["COMPLETED", "CONFIRMED", "RESOLVED"].includes(latestStatus?.toUpperCase());
          const isFailed    = ["EXPIRED", "CANCELED", "UNRESOLVED"].includes(latestStatus?.toUpperCase());

          if (isConfirmed && order.status !== "confirmed") {
            // Mark confirmed and record everything
            db.prepare("UPDATE crypto_orders SET status = 'confirmed', confirmed_at = datetime('now') WHERE charge_id = ?").run(req.params.chargeId);

            // Log platform fee to overage_charges for month-end billing
            const period = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0");
            try {
              db.prepare(`INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status)
                VALUES (?,?,?,?,?,?,?,?)`)
                .run(require("crypto").randomUUID(), order.user_id, "crypto_platform_fee", 1, order.platform_fee, order.platform_fee, period, "pending");
            } catch(e) {}

            // Record order
            try {
              const realTotal = order.order_total - order.platform_fee;
              db.prepare(`INSERT OR IGNORE INTO orders
                (id, user_id, site_id, order_number, customer_email, total, status, payment_method, created_at)
                VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
                .run(order.id, order.user_id, order.site_id, "CRYPTO-" + (charge.code || req.params.chargeId.slice(0,8)),
                  order.customer_email, realTotal, "paid", "crypto");
            } catch(e) {}

            // Fire post-purchase automations
            try {
              const { fireAutomation } = require("./features");
              if (typeof fireAutomation === "function") {
                await fireAutomation(db, order.user_id, "order_placed", {
                  email: order.customer_email,
                  order_total: order.order_total - order.platform_fee,
                  payment: "crypto",
                  currency: order.currency
                });
              }
            } catch(e) {}

            return res.json({ status: "confirmed", confirmed: true, order_total: order.order_total, currency: order.currency, confirmed_at: new Date().toISOString() });
          }

          if (isFailed) {
            db.prepare("UPDATE crypto_orders SET status = 'expired' WHERE charge_id = ?").run(req.params.chargeId);
            return res.json({ status: "expired", confirmed: false });
          }

          // Still pending — return live Coinbase status
          return res.json({ status: "pending", confirmed: false, coinbase_status: latestStatus });
        }
      } catch(e) {
        console.error("[Crypto] Coinbase status check failed:", e.message);
      }
    }

    // Fallback: return DB status
    res.json({ status: order.status, confirmed: false });
  } catch(e) {
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/crypto/webhook
// Coinbase posts events here: charge:confirmed, charge:failed, charge:expired
// Must be raw body for signature verification
// ═══════════════════════════════════════════════════════════════════════════
// Optional webhook — bonus server-side confirmation if user sets it up
// Primary confirmation is via polling in GET /status/:chargeId
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const db = getDb();
  ensureTables(db);

  // Verify Coinbase Commerce webhook signature
  const webhookSecret = process.env.COINBASE_WEBHOOK_SECRET;
  // Fail-closed: require COINBASE_WEBHOOK_SECRET to be configured
  if (!webhookSecret) return res.status(503).json({ error: "Crypto webhook not configured" });
  if (webhookSecret) {
    const sig = req.headers["x-cc-webhook-signature"];
    if (!sig) return res.status(400).json({ error: "Missing signature" });
    try {
      const crypto = require("crypto");
      const expected = crypto.createHmac("sha256", webhookSecret).update(req.body).digest("hex");
      // Timing-safe compare — prevents side-channel signature brute-force.
      const sigBuf = Buffer.from(String(sig), "hex");
      const expBuf = Buffer.from(expected, "hex");
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    } catch(e) { return res.status(400).json({ error: "Signature verification failed" }); }
  }

  try {

    const event  = JSON.parse(req.body.toString());
    const type   = event.type;
    const charge = event.data;

    // ── Handle events ──────────────────────────────────────────────────────
    if (type === "charge:confirmed") {
      const order = db.prepare(
        "SELECT * FROM crypto_orders WHERE charge_id = ?"
      ).get(charge.id);

      if (!order || order.status === "confirmed") {
        return res.json({ received: true }); // idempotent
      }

      // Mark order confirmed
      db.prepare(
        "UPDATE crypto_orders SET status = 'confirmed', confirmed_at = datetime('now') WHERE charge_id = ?"
      ).run(charge.id);

      // ── Log platform fee as overage charge (billed month-end) ────────────
      const period = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0");
      db.prepare(`
        INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        uuid(),
        order.user_id,
        "crypto_platform_fee",
        1,
        order.platform_fee,
        order.platform_fee,
        period,
        "pending"
      );

      // ── Record order in orders table ──────────────────────────────────────
      try {
        const items = JSON.parse(order.items_json || "[]");
        const realTotal = order.order_total - order.platform_fee; // subtotal ex-fee
        db.prepare(`
          INSERT OR IGNORE INTO orders
            (id, user_id, site_id, order_number, customer_email, total, status, payment_method, created_at)
          VALUES (?,?,?,?,?,?,?,?,datetime('now'))
        `).run(
          order.id, order.user_id, order.site_id,
          "CRYPTO-" + order.charge_code,
          order.customer_email,
          realTotal,
          "paid",
          "crypto"
        );
      } catch(e) { /* orders table may have different schema — non-fatal */ }

      // ── Fire post-purchase automations ────────────────────────────────────
      try {
        const { fireAutomation } = require("./features");
        if (typeof fireAutomation === "function") {
          await fireAutomation(db, order.user_id, "order_placed", {
            email:       order.customer_email,
            order_total: order.order_total - order.platform_fee,
            payment:     "crypto",
            currency:    order.currency
          });
        }
      } catch(e) { /* non-fatal */ }

    } else if (type === "charge:failed" || type === "charge:expired") {
      db.prepare(
        "UPDATE crypto_orders SET status = ? WHERE charge_id = ?"
      ).run(type === "charge:expired" ? "expired" : "failed", charge.id);

    } else if (type === "charge:pending") {
      db.prepare(
        "UPDATE crypto_orders SET status = 'pending_confirmation' WHERE charge_id = ?"
      ).run(charge.id);
    }

    res.json({ received: true });

  } catch(e) {
    console.error("[Crypto] Webhook error:", e.message);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/crypto/settings  — get crypto config for the logged-in user
// ═══════════════════════════════════════════════════════════════════════════
router.get("/settings", auth, (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const rows = db.prepare(
      "SELECT key, value FROM user_settings WHERE user_id = ? AND key IN ('COINBASE_COMMERCE_API_KEY','COINBASE_WEBHOOK_SECRET','CRYPTO_MIN_ORDER','CRYPTO_ENABLED')"
    ).all(req.userId);
    const settings = {};
    rows.forEach(r => {
      // Mask API key
      if (r.key === "COINBASE_COMMERCE_API_KEY") {
        settings[r.key] = r.value ? "••••••" + r.value.slice(-4) : "";
        settings.coinbase_connected = !!r.value;
      } else {
        settings[r.key] = r.value;
      }
    });
    settings.platform_fee_pct = PLATFORM_FEE_PCT;

    // Stats — this month's crypto revenue and fees
    const period = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0");
    const stats = db.prepare(`
      SELECT COUNT(*) as orders, SUM(order_total - platform_fee) as revenue, SUM(platform_fee) as fees
      FROM crypto_orders WHERE user_id = ? AND status = 'confirmed'
      AND strftime('%Y-%m', confirmed_at) = ?
    `).get(req.userId, period) || {};
    settings.this_month = {
      orders:  stats.orders  || 0,
      revenue: Math.round((stats.revenue || 0) * 100) / 100,
      fees:    Math.round((stats.fees    || 0) * 100) / 100
    };

    res.json(settings);
  } catch(e) {
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/crypto/settings  — save crypto config
// ═══════════════════════════════════════════════════════════════════════════
router.post("/settings", auth, (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const { api_key, min_order, enabled } = req.body;
    const save = (key, value) => {
      if (value === undefined || value === null) return;
      // Reject masked placeholder — if the frontend round-trips the
      // display-only `••••••1234` string, we would otherwise overwrite
      // the real API key with the mask. Matches integrations.js pattern.
      if (typeof value === "string" && value.startsWith("••••••")) return;
      db.prepare(
        "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?,?,?)"
      ).run(req.userId, key, String(value));
    };
    if (api_key)        save("COINBASE_COMMERCE_API_KEY", api_key);
    if (min_order)      save("CRYPTO_MIN_ORDER",          min_order);
    if (enabled !== undefined) save("CRYPTO_ENABLED", enabled ? "1" : "0");
    res.json({ success: true });
  } catch(e) {
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/crypto/orders  — list crypto orders for dashboard
// ═══════════════════════════════════════════════════════════════════════════
router.get("/orders", auth, (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const orders = db.prepare(`
      SELECT id, charge_code, order_total, platform_fee, currency, status,
             customer_email, confirmed_at, created_at,
             (order_total - platform_fee) as subtotal
      FROM crypto_orders WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(req.userId);
    res.json({ orders });
  } catch(e) {
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

module.exports = router;
