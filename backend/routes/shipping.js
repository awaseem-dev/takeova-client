/**
 * MINE Shipping — EasyPost integration
 *
 *   POST /api/features/shipping/quote          — get rate quotes for an order
 *   POST /api/features/shipping/book           — book a shipment, return label + tracking
 *   POST /api/features/shipping/cancel/:id     — refund a shipment before pickup
 *   POST /api/features/shipping/pickup         — schedule a courier pickup
 *   GET  /api/features/shipping/track/:tracking — fetch latest tracker status
 *   POST /api/features/shipping/webhook        — EasyPost status updates
 *
 * Plus a public route mounted at root (not /api):
 *   GET /track/:tracking_number  — MINE-hosted branded tracking page
 *
 * All authed endpoints use the user's per-user EasyPost API key stored in
 * user_integration_keys (encrypted with CREDENTIAL_VAULT_KEY).
 */
"use strict";

const express = require("express");
const router  = express.Router();
const crypto  = require("crypto");
const { getDb } = require("../db/init");

// ─── Plan-cap guard — wraps mineCheckUsage + auto-tracks on success ───
function _capGuard(req, res, metric) {
  if (typeof global.mineCheckUsage === 'function') {
    try {
      const usage = global.mineCheckUsage(getDb(), req.userId, metric);
      if (usage && usage.blocked) {
        res.status(403).json({
          error: "You've used all your AI for this month. Upgrade to continue.",
          used: usage.used, cap: usage.cap, metric: metric, upgrade: true
        });
        return false;
      }
    } catch(_) {}
  }
  // Auto-track on success response (status < 400)
  const _orig = res.json.bind(res);
  res.json = function(payload) {
    if (res.statusCode < 400 && typeof global.mineTrackUsage === 'function') {
      try { global.mineTrackUsage(getDb(), req.userId, metric); } catch(_) {}
    }
    return _orig(payload);
  };
  return true;
}


const { auth } = require("../middleware/auth");

function uuid() { return crypto.randomBytes(16).toString("hex"); }

// ─── Ensure shipping tables ───────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shipments (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      order_id        TEXT,
      courier         TEXT,
      service         TEXT,
      tracking_number TEXT,
      tracking_url    TEXT,
      label_url       TEXT,
      status          TEXT DEFAULT 'created',
      cost            REAL,
      currency        TEXT DEFAULT 'AUD',
      to_name         TEXT,
      to_address      TEXT,
      to_email        TEXT,
      easypost_shipment_id TEXT,
      easypost_pickup_id TEXT,
      pickup_scheduled_at TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT
    )
  `);
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_shipments_user_order ON shipments(user_id, order_id)"); } catch(_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(tracking_number)"); } catch(_) {}
  try { db.exec("ALTER TABLE shipments ADD COLUMN printed_at TEXT"); } catch(_) {}
  // Add tracking columns to orders if missing
  try { db.exec("ALTER TABLE orders ADD COLUMN tracking_number TEXT"); } catch(_) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN tracking_url TEXT"); } catch(_) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN label_url TEXT"); } catch(_) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN shipping_cost REAL"); } catch(_) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN shipping_status TEXT"); } catch(_) {}
}

// ─── Helper: get user's decrypted EasyPost key ────────────────────────────
async function getUserKey(db, userId) {
  const { getSavedKey } = require("./user-integration-keys");
  const saved = getSavedKey(db, userId, "easypost");
  if (!saved?.apiKey) return null;
  return saved.apiKey;
}

// ─── Helper: EasyPost API call ────────────────────────────────────────────
async function easypost(apiKey, method, path, body) {
  const fetch = (await import("node-fetch")).default;
  const url = "https://api.easypost.com/v2" + path;
  const opts = {
    method,
    headers: {
      "Authorization": "Basic " + Buffer.from(apiKey + ":").toString("base64"),
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || `EasyPost ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

// ─── Helper: build address payload from order fields ──────────────────────
function buildToAddress(o) {
  let shipping = {};
  try { shipping = JSON.parse(o.shipping_address || "{}"); } catch(_) {}
  const name = shipping.name || o.customer_name || o.shipping_name || "";
  return {
    name,
    street1: shipping.address1 || shipping.street || "",
    street2: shipping.address2 || "",
    city: shipping.city || "",
    state: shipping.province || shipping.state || "",
    zip: shipping.zip || shipping.postcode || "",
    country: shipping.country_code || shipping.country || "AU",
    email: shipping.email || o.customer_email || "",
    phone: shipping.phone || "",
  };
}

// ─── Helper: from-address falls back to user's business address ────────────
async function buildFromAddress(db, userId) {
  const u = db.prepare("SELECT name, email, business_address FROM users WHERE id = ?").get(userId);
  let addr = {};
  try { addr = JSON.parse(u?.business_address || "{}"); } catch(_) {}
  return {
    name: u?.name || "Sender",
    street1: addr.street1 || addr.address || "",
    street2: addr.street2 || "",
    city: addr.city || "",
    state: addr.state || "",
    zip: addr.zip || "",
    country: addr.country || "AU",
    email: u?.email || "",
    phone: addr.phone || "",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /quote — get rate quotes for an order
// ═══════════════════════════════════════════════════════════════════════════
router.post("/quote", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const apiKey = await getUserKey(db, req.userId);
    if (!apiKey) return res.status(400).json({ error: "Connect your EasyPost account first (Integrations panel)" });

    const { order_id, weight_oz, length_in, width_in, height_in } = req.body;
    if (!order_id) return res.status(400).json({ error: "order_id required" });
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(order_id, req.userId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const to = buildToAddress(order);
    if (!to.street1 || !to.city || !to.zip) {
      return res.status(400).json({ error: "Order is missing shipping address (street, city, postcode)" });
    }
    const from = await buildFromAddress(db, req.userId);
    if (!from.street1 || !from.zip) {
      return res.status(400).json({ error: "Set your business address in Settings first" });
    }

    // Default parcel sizing — 1kg/12oz, small box. User can override.
    const parcel = {
      weight: parseFloat(weight_oz) || 12,
      length: parseFloat(length_in) || 9,
      width:  parseFloat(width_in)  || 6,
      height: parseFloat(height_in) || 4,
    };

    const shipment = await easypost(apiKey, "POST", "/shipments", {
      shipment: { to_address: to, from_address: from, parcel },
    });

    // Filter + sort rates: by service tier, lowest first
    const rates = (shipment.rates || [])
      .map(r => ({
        id: r.id,
        carrier: r.carrier,
        service: r.service,
        rate: parseFloat(r.rate),
        currency: r.currency,
        delivery_days: r.delivery_days,
        delivery_date: r.delivery_date,
        delivery_date_guaranteed: r.delivery_date_guaranteed,
      }))
      .sort((a, b) => a.rate - b.rate);

    res.json({
      shipment_id: shipment.id,
      rates,
      to: { name: to.name, city: to.city, state: to.state, zip: to.zip, country: to.country },
    });
  } catch(e) {
    console.error("[shipping/quote]", e.message);
    res.status(500).json({ error: e.message || "Failed to get shipping rates" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /book — buy a rate, produce a label
// ═══════════════════════════════════════════════════════════════════════════
router.post("/book", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const apiKey = await getUserKey(db, req.userId);
    if (!apiKey) return res.status(400).json({ error: "Connect your EasyPost account first" });

    const { shipment_id, rate_id, order_id } = req.body;
    if (!shipment_id || !rate_id || !order_id) {
      return res.status(400).json({ error: "shipment_id, rate_id, and order_id required" });
    }

    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(order_id, req.userId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Buy the rate — this charges the user's EasyPost account
    const bought = await easypost(apiKey, "POST", `/shipments/${shipment_id}/buy`, {
      rate: { id: rate_id },
    });

    const tn = bought.tracking_code;
    const labelUrl = bought.postage_label?.label_url || null;
    const carrier = bought.selected_rate?.carrier || "unknown";
    const service = bought.selected_rate?.service || "";
    const cost = parseFloat(bought.selected_rate?.rate || 0);
    const trackingUrl = bought.tracker?.public_url || null;

    // Save the shipment record
    const sid = uuid();
    const to = buildToAddress(order);
    db.prepare(`INSERT INTO shipments
      (id, user_id, order_id, courier, service, tracking_number, tracking_url, label_url,
       status, cost, currency, to_name, to_address, to_email, easypost_shipment_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
      sid, req.userId, order_id, carrier, service, tn, trackingUrl, labelUrl,
      "purchased", cost, bought.selected_rate?.currency || "AUD",
      to.name, JSON.stringify(to), to.email, bought.id
    );

    // Update order with tracking info
    db.prepare(`UPDATE orders SET
      tracking_number = ?,
      tracking_url = ?,
      label_url = ?,
      shipping_cost = ?,
      shipping_status = 'label_printed',
      fulfillment_status = COALESCE(fulfillment_status, 'fulfilled')
      WHERE id = ?`).run(tn, trackingUrl, labelUrl, cost, order_id);

    // Best-effort: send the buyer an email with the tracking link
    if (to.email) {
      try {
        const fetch = (await import("node-fetch")).default;
        const sgKey = process.env.SENDGRID_API_KEY ||
          db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value;
        if (sgKey) {
          const fromEmail = process.env.SENDGRID_FROM_EMAIL ||
            db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value ||
            "hello@takeova.ai";
          const host = process.env.FRONTEND_URL || process.env.APP_URL || "https://takeova.ai";
          const branded = `${host}/track/${tn}`;
          await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: to.email, name: to.name }] }],
              from: { email: fromEmail, name: "MINE" },
              subject: `Your order has shipped — tracking ${tn}`,
              content: [{
                type: "text/html",
                value: `<p>Hi ${to.name || "there"},</p>` +
                       `<p>Great news — your order has shipped via <b>${carrier}</b>.</p>` +
                       `<p><b>Tracking number:</b> ${tn}</p>` +
                       `<p><a href="${branded}" style="background:#2563EB;color:white;padding:10px 18px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:600">Track your package →</a></p>` +
                       `<p style="color:#666;font-size:13px;margin-top:24px">Sent via MINE</p>`,
              }],
            }),
          });
        }
      } catch(_) {}
    }

    res.json({
      shipment_id: sid,
      tracking_number: tn,
      tracking_url: trackingUrl,
      label_url: labelUrl,
      carrier,
      service,
      cost,
      branded_tracking_url: `${process.env.FRONTEND_URL || "https://takeova.ai"}/track/${tn}`,
    });
  } catch(e) {
    console.error("[shipping/book]", e.message);
    res.status(500).json({ error: e.message || "Failed to book shipment" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /cancel/:id — refund a shipment that hasn't been picked up
// ═══════════════════════════════════════════════════════════════════════════
router.post("/cancel/:id", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const apiKey = await getUserKey(db, req.userId);
    if (!apiKey) return res.status(400).json({ error: "Connect your EasyPost account first" });

    const shipment = db.prepare("SELECT * FROM shipments WHERE id = ? AND user_id = ?")
                       .get(req.params.id, req.userId);
    if (!shipment) return res.status(404).json({ error: "Shipment not found" });
    if (shipment.status === "delivered" || shipment.status === "in_transit") {
      return res.status(400).json({ error: "Cannot cancel a shipment already in transit" });
    }

    await easypost(apiKey, "POST", `/shipments/${shipment.easypost_shipment_id}/refund`);

    db.prepare("UPDATE shipments SET status = 'refunded', updated_at = datetime('now') WHERE id = ?")
      .run(shipment.id);
    db.prepare("UPDATE orders SET shipping_status = 'cancelled' WHERE id = ?").run(shipment.order_id);

    res.json({ ok: true, refunded: true });
  } catch(e) {
    console.error("[shipping/cancel]", e.message);
    res.status(500).json({ error: e.message || "Failed to cancel shipment" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /pickup — schedule a courier pickup
// ═══════════════════════════════════════════════════════════════════════════
router.post("/pickup", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const apiKey = await getUserKey(db, req.userId);
    if (!apiKey) return res.status(400).json({ error: "Connect your EasyPost account first" });

    const { shipment_id, min_datetime, max_datetime, instructions } = req.body;
    if (!shipment_id) return res.status(400).json({ error: "shipment_id required" });

    const shipment = db.prepare("SELECT * FROM shipments WHERE id = ? AND user_id = ?")
                       .get(shipment_id, req.userId);
    if (!shipment) return res.status(404).json({ error: "Shipment not found" });

    const from = await buildFromAddress(db, req.userId);
    const minDt = min_datetime || new Date(Date.now() + 60*60*1000).toISOString();
    const maxDt = max_datetime || new Date(Date.now() + 8*60*60*1000).toISOString();

    const pickup = await easypost(apiKey, "POST", "/pickups", {
      pickup: {
        address: from,
        shipment: { id: shipment.easypost_shipment_id },
        min_datetime: minDt,
        max_datetime: maxDt,
        instructions: instructions || "Parcel at front door",
        is_account_address: true,
      },
    });

    // Auto-buy the lowest-rate pickup slot
    const pickupRates = pickup.pickup_rates || [];
    let bought = pickup;
    if (pickupRates.length > 0) {
      pickupRates.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
      bought = await easypost(apiKey, "POST", `/pickups/${pickup.id}/buy`, {
        carrier: pickupRates[0].carrier,
        service: pickupRates[0].service,
      });
    }

    db.prepare("UPDATE shipments SET easypost_pickup_id = ?, pickup_scheduled_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(bought.id, minDt, shipment.id);

    res.json({
      ok: true,
      pickup_id: bought.id,
      confirmation: bought.confirmation,
      scheduled_window: { from: minDt, to: maxDt },
    });
  } catch(e) {
    console.error("[shipping/pickup]", e.message);
    res.status(500).json({ error: e.message || "Failed to schedule pickup" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /track/:tracking — fetch latest tracker status (authed, for dashboard)
// ═══════════════════════════════════════════════════════════════════════════
router.get("/track/:tracking", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const shipment = db.prepare("SELECT * FROM shipments WHERE tracking_number = ? AND user_id = ?")
                       .get(req.params.tracking, req.userId);
    if (!shipment) return res.status(404).json({ error: "Shipment not found" });

    res.json({
      tracking_number: shipment.tracking_number,
      tracking_url: shipment.tracking_url,
      status: shipment.status,
      carrier: shipment.courier,
      service: shipment.service,
      to_name: shipment.to_name,
      label_url: shipment.label_url,
      created_at: shipment.created_at,
      updated_at: shipment.updated_at,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /webhook — EasyPost status updates
// ═══════════════════════════════════════════════════════════════════════════
router.post("/webhook", express.json(), (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const payload = req.body || {};
    // EasyPost sends { description, result, ... } where result has tracker info
    const tracker = payload.result;
    if (!tracker || tracker.object !== "Tracker") return res.json({ received: true });

    const tn = tracker.tracking_code;
    const status = tracker.status; // pre_transit, in_transit, out_for_delivery, delivered, return_to_sender, failure, cancelled, error
    if (!tn || !status) return res.json({ received: true });

    db.prepare("UPDATE shipments SET status = ?, updated_at = datetime('now') WHERE tracking_number = ?")
      .run(status, tn);

    // Mirror into orders
    let orderStatus = "shipped";
    if (status === "delivered") orderStatus = "delivered";
    else if (status === "return_to_sender") orderStatus = "returned";
    else if (status === "failure" || status === "error") orderStatus = "shipping_failed";
    db.prepare("UPDATE orders SET shipping_status = ? WHERE tracking_number = ?").run(orderStatus, tn);

    res.json({ received: true });
  } catch(e) {
    console.error("[shipping/webhook]", e.message);
    res.status(500).json({ error: "webhook processing failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AI FULFILLMENT PACK — three AI-powered shipping helpers
// ═══════════════════════════════════════════════════════════════════════════

// ─── Helper: get Anthropic API key (platform setting or env) ──────────────
function _getAnthropicKey(db) {
  try {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("ANTHROPIC_API_KEY");
    return row?.value || process.env.ANTHROPIC_API_KEY;
  } catch(_) { return process.env.ANTHROPIC_API_KEY; }
}

async function _callClaude(prompt, apiKey, maxTokens = 600) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content?.[0]?.text || "";
}

// ───────────────────────────────────────────────────────────────────────────
// POST /ai-dimensions — Claude predicts package dimensions for an order
// ───────────────────────────────────────────────────────────────────────────
// Reads the order's line items + matching product info, asks Claude to
// suggest weight (oz) + length/width/height (inches), returns a single
// prediction that the shipping modal can prefill. Falls back to safe
// defaults if Claude fails — never blocks the user.
router.post("/ai-dimensions", auth, async (req, res) => {
  if (!_capGuard(req, res, "parcelDimensions")) return;
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: "order_id required" });

    const db = getDb();
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(order_id, req.userId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Build context: what items are in the order, what we know about them
    let items = [];
    try { items = JSON.parse(order.items || "[]"); } catch(_) {}
    if (items.length === 0) {
      return res.json({ weight_oz: 12, length_in: 9, width_in: 6, height_in: 4, source: "default", note: "No line items found — using small parcel default" });
    }

    // Look up saved product dimensions if MINE knows them
    const productInfo = items.map(it => {
      let stored = null;
      try {
        stored = db.prepare("SELECT name, weight_oz, length_in, width_in, height_in FROM products WHERE user_id = ? AND name = ? LIMIT 1")
                   .get(req.userId, it.name || "");
      } catch(_) {}
      return {
        name: it.name || "Item",
        qty: it.quantity || 1,
        sku: it.sku || "",
        knownDimensions: (stored && stored.weight_oz)
          ? { weight_oz: stored.weight_oz, length_in: stored.length_in, width_in: stored.width_in, height_in: stored.height_in }
          : null,
      };
    });

    // If ALL items have known dimensions, skip the AI call — sum them up directly
    const allKnown = productInfo.every(p => p.knownDimensions);
    if (allKnown) {
      const totalWeight = productInfo.reduce((s, p) => s + (p.knownDimensions.weight_oz || 0) * p.qty, 0);
      const maxL = Math.max(...productInfo.map(p => p.knownDimensions.length_in || 0));
      const maxW = Math.max(...productInfo.map(p => p.knownDimensions.width_in || 0));
      const sumH = productInfo.reduce((s, p) => s + (p.knownDimensions.height_in || 0) * p.qty, 0);
      return res.json({
        weight_oz: Math.ceil(totalWeight),
        length_in: Math.max(6, Math.ceil(maxL)),
        width_in:  Math.max(4, Math.ceil(maxW)),
        height_in: Math.max(2, Math.ceil(sumH * 0.7)), // assume some compression when stacked
        source: "saved_product_dimensions",
        note: "Calculated from saved product dimensions",
      });
    }

    // Otherwise ask Claude
    const apiKey = _getAnthropicKey(db);
    if (!apiKey) {
      return res.json({ weight_oz: 12, length_in: 9, width_in: 6, height_in: 4, source: "default", note: "Anthropic key not configured — using small parcel default" });
    }

    const itemList = productInfo.map(p =>
      `- ${p.qty}× ${p.name}` + (p.knownDimensions ? ` (known: ${p.knownDimensions.weight_oz}oz, ${p.knownDimensions.length_in}×${p.knownDimensions.width_in}×${p.knownDimensions.height_in}in)` : "")
    ).join("\n");

    const prompt = `You are a shipping logistics assistant. Given the items below, estimate the most realistic packed parcel dimensions and total weight.

Items in this order:
${itemList}

Standard Australian satchel sizes for reference:
- Small AusPost satchel: 22.5×16cm (≈8.9×6.3in), up to 500g (≈17oz)
- Medium AusPost satchel: 26×38cm (≈10.2×15in), up to 3kg (≈106oz)
- Large AusPost satchel: 36×46cm (≈14.2×18.1in), up to 5kg (≈176oz)
- Sendle small box: 21×11×6cm (≈8.3×4.3×2.4in)
- Sendle medium box: 30×20×10cm (≈11.8×7.9×3.9in)

Respond in this exact JSON format only (no other text):
{"weight_oz": <number>, "length_in": <number>, "width_in": <number>, "height_in": <number>, "reasoning": "<one-sentence why>"}

Round dimensions UP to nearest inch. Weight should be slightly over-estimated to avoid carrier surcharges.`;

    try {
      const response = await _callClaude(prompt, apiKey, 400);
      // Extract JSON from response — be lenient
      const m = response.match(/\{[\s\S]*?"weight_oz"[\s\S]*?\}/);
      if (!m) throw new Error("No JSON in Claude response");
      const parsed = JSON.parse(m[0]);
      if (!parsed.weight_oz || !parsed.length_in) throw new Error("Incomplete JSON");
      res.json({
        weight_oz: Math.max(1, Math.ceil(parsed.weight_oz)),
        length_in: Math.max(2, Math.ceil(parsed.length_in)),
        width_in:  Math.max(2, Math.ceil(parsed.width_in)),
        height_in: Math.max(1, Math.ceil(parsed.height_in)),
        source: "ai_estimated",
        note: parsed.reasoning || "AI-estimated from item names",
      });
    } catch(e) {
      console.error("[shipping/ai-dimensions] Claude failed:", e.message);
      // Safe fallback — never block the user
      res.json({
        weight_oz: 12, length_in: 9, width_in: 6, height_in: 4,
        source: "default",
        note: "AI estimation unavailable — using small parcel default. Adjust manually.",
      });
    }
  } catch(e) {
    console.error("[shipping/ai-dimensions]", e.message);
    res.json({ weight_oz: 12, length_in: 9, width_in: 6, height_in: 4, source: "default", note: "Error — using defaults" });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /packing-slip/:shipment_id.pdf — branded packing slip with AI note
// ───────────────────────────────────────────────────────────────────────────
// Generates a printable PDF with:
//   - Seller's business name as header
//   - Order details (items, qty, customer name, address)
//   - AI-generated personalized thank-you note matching the seller's brand voice
// Uses Python + reportlab (already used by MINE for invoice PDFs).
router.get("/packing-slip/:shipmentId.pdf", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const shipment = db.prepare("SELECT * FROM shipments WHERE id = ? AND user_id = ?")
                       .get(req.params.shipmentId, req.userId);
    if (!shipment) return res.status(404).send("Shipment not found");

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(shipment.order_id);
    const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(req.userId);
    let items = [];
    try { items = JSON.parse(order?.items || "[]"); } catch(_) {}
    let toAddress = {};
    try { toAddress = JSON.parse(shipment.to_address || "{}"); } catch(_) {}

    // Generate AI thank-you note (or use a simple fallback)
    let thankYouNote = `Thank you for shopping with ${user?.name || "us"}! Your order means a lot — enjoy your delivery.`;
    const apiKey = _getAnthropicKey(db);
    if (apiKey && items.length > 0) {
      try {
        const itemNames = items.map(it => `${it.quantity || 1}× ${it.name}`).join(", ");
        const prompt = `Write a SHORT (2-3 sentences, max 50 words) warm, personal thank-you note from "${user?.name || "the business"}" to the customer "${toAddress.name || "their customer"}". They ordered: ${itemNames}.

Style: friendly but professional, not overly enthusiastic. No exclamation marks more than one. No emojis. Address by first name if available. Mention the items naturally.

Respond with just the note text, no preamble.`;
        const aiText = await _callClaude(prompt, apiKey, 200);
        if (aiText && aiText.trim().length > 10 && aiText.trim().length < 400) {
          thankYouNote = aiText.trim();
        }
      } catch(_) { /* keep fallback */ }
    }

    // Build the PDF via Python + reportlab subprocess
    const { spawn } = require("child_process");
    const path = require("path");
    const fs = require("fs");
    const tmpDir = "/tmp";
    const outPath = path.join(tmpDir, `packing-slip-${shipment.id}.pdf`);

    const ctx = {
      business_name: user?.name || "Your Business",
      tracking_number: shipment.tracking_number || "",
      carrier: shipment.courier || "",
      order_number: order?.invoice_number || order?.id || "",
      customer_name: toAddress.name || "Valued Customer",
      shipping_to: [
        toAddress.street1 || "",
        toAddress.street2 || "",
        [toAddress.city, toAddress.state, toAddress.zip].filter(Boolean).join(" "),
        toAddress.country || "",
      ].filter(Boolean),
      items: items.map(it => ({ name: it.name || "Item", qty: it.quantity || 1 })),
      thank_you_note: thankYouNote,
      shipped_date: new Date().toISOString().slice(0, 10),
    };

    const pyScript = `
import json, sys
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER

ctx = json.loads(sys.argv[1])
out = sys.argv[2]
doc = SimpleDocTemplate(out, pagesize=letter, topMargin=0.5*inch, bottomMargin=0.5*inch,
                        leftMargin=0.7*inch, rightMargin=0.7*inch)
PURPLE = HexColor("#2563EB")
DARK = HexColor("#0F172A")
MUTED = HexColor("#64748B")
BORDER = HexColor("#E5E7EB")

styles = getSampleStyleSheet()
h1 = ParagraphStyle('h1', parent=styles['Heading1'], fontSize=24, textColor=DARK, fontName='Helvetica-Bold', spaceAfter=4)
h2 = ParagraphStyle('h2', parent=styles['Heading2'], fontSize=12, textColor=PURPLE, fontName='Helvetica-Bold', spaceAfter=6)
body = ParagraphStyle('body', parent=styles['BodyText'], fontSize=10, textColor=DARK, leading=14)
muted = ParagraphStyle('muted', parent=body, fontSize=9, textColor=MUTED)

story = []
story.append(Paragraph(ctx['business_name'], h1))
story.append(Paragraph(f"<font color='#64748B'>Packing slip · Shipped {ctx['shipped_date']}</font>", muted))
story.append(Spacer(1, 14))
story.append(HRFlowable(width="100%", color=BORDER, thickness=0.5))
story.append(Spacer(1, 14))

# Address + order info
addr_lines = '<br/>'.join([ctx['customer_name']] + ctx['shipping_to'])
story.append(Paragraph("<b>SHIP TO</b>", muted))
story.append(Paragraph(addr_lines, body))
story.append(Spacer(1, 10))

if ctx['tracking_number']:
    story.append(Paragraph(f"<b>TRACKING</b> · {ctx['carrier']} · <font face='Courier'>{ctx['tracking_number']}</font>", muted))
if ctx['order_number']:
    story.append(Paragraph(f"<b>ORDER</b> · #{ctx['order_number']}", muted))

story.append(Spacer(1, 16))
story.append(HRFlowable(width="100%", color=BORDER, thickness=0.5))
story.append(Spacer(1, 12))

# Items table
story.append(Paragraph("ITEMS IN THIS SHIPMENT", h2))
items_data = [["Qty", "Item"]]
for it in ctx['items']:
    items_data.append([str(it['qty']), it['name']])
t = Table(items_data, colWidths=[0.7*inch, 5.3*inch])
t.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), HexColor("#F1F5F9")),
    ('TEXTCOLOR', (0,0), (-1,0), DARK),
    ('FONT', (0,0), (-1,0), 'Helvetica-Bold', 9),
    ('FONT', (0,1), (-1,-1), 'Helvetica', 10),
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('LEFTPADDING', (0,0), (-1,-1), 10),
    ('RIGHTPADDING', (0,0), (-1,-1), 10),
    ('TOPPADDING', (0,0), (-1,-1), 8),
    ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ('GRID', (0,0), (-1,-1), 0.3, BORDER),
]))
story.append(t)
story.append(Spacer(1, 24))

# Thank-you note in a styled box
story.append(HRFlowable(width="100%", color=BORDER, thickness=0.5))
story.append(Spacer(1, 14))
note_style = ParagraphStyle('note', parent=body, fontSize=11, textColor=DARK, leading=17,
                            backColor=HexColor("#F8FAFC"), borderColor=PURPLE, borderWidth=0,
                            leftIndent=14, rightIndent=14, spaceBefore=10, spaceAfter=10,
                            borderPadding=12)
story.append(Paragraph(ctx['thank_you_note'].replace('\\n', '<br/>'), note_style))
story.append(Spacer(1, 24))

story.append(HRFlowable(width="100%", color=BORDER, thickness=0.5))
story.append(Spacer(1, 8))
story.append(Paragraph(f"<font color='#94A3B8'>Powered by MINE · {ctx['business_name']}</font>",
                       ParagraphStyle('foot', parent=muted, fontSize=8, alignment=TA_CENTER)))
doc.build(story)
print("ok")
`;

    const py = spawn("python3", ["-c", pyScript, JSON.stringify(ctx), outPath]);
    let stderrBuf = "";
    py.stderr.on("data", d => { stderrBuf += d.toString(); });
    py.on("close", code => {
      if (code !== 0) {
        console.error("[packing-slip] python failed:", stderrBuf.slice(0, 500));
        return res.status(500).send("Packing slip generation failed");
      }
      try {
        const pdfBuf = fs.readFileSync(outPath);
        try { fs.unlinkSync(outPath); } catch(_) {}
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="packing-slip-${shipment.tracking_number || shipment.id}.pdf"`);
        res.send(pdfBuf);
      } catch(e) {
        res.status(500).send("Could not read packing slip");
      }
    });
  } catch(e) {
    console.error("[shipping/packing-slip]", e.message);
    res.status(500).send("Packing slip error");
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /return-label — book a pre-paid return label
// ───────────────────────────────────────────────────────────────────────────
// Reverses the original shipment's from/to addresses and books a return
// label via EasyPost. Optional AI policy check first (if `reason` provided),
// which approves/denies based on the seller's saved return policy.
router.post("/return-label", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const apiKey = await getUserKey(db, req.userId);
    if (!apiKey) return res.status(400).json({ error: "Connect your EasyPost account first" });

    const { shipment_id, reason } = req.body;
    if (!shipment_id) return res.status(400).json({ error: "shipment_id required" });

    const shipment = db.prepare("SELECT * FROM shipments WHERE id = ? AND user_id = ?")
                       .get(shipment_id, req.userId);
    if (!shipment) return res.status(404).json({ error: "Shipment not found" });

    // ── (Optional) AI policy check ────────────────────────────────────────
    let policyDecision = null;
    if (reason) {
      const claudeKey = _getAnthropicKey(db);
      if (claudeKey) {
        try {
          const userRow = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
          const policy = db.prepare("SELECT value FROM platform_settings WHERE key = 'RETURN_POLICY_DEFAULT'").get()?.value
            || "30-day returns accepted on unused items. Refunds processed within 7 business days. Custom or sale items final.";
          const daysSinceShip = Math.floor((Date.now() - new Date(shipment.created_at).getTime()) / (1000 * 60 * 60 * 24));
          const prompt = `You are a return-request reviewer for ${userRow?.name || "a small business"}.

Return policy: "${policy}"

Customer's reason for return: "${String(reason).slice(0, 500)}"
Days since shipment: ${daysSinceShip}

Decide: approve or deny the return.
Respond in this exact JSON format only:
{"decision": "approve" or "deny", "reasoning": "<one sentence>", "customer_message": "<short polite message to send the customer>"}`;
          const aiText = await _callClaude(prompt, claudeKey, 300);
          const m = aiText.match(/\{[\s\S]*?\}/);
          if (m) {
            policyDecision = JSON.parse(m[0]);
            if (policyDecision.decision === "deny") {
              return res.json({
                approved: false,
                reasoning: policyDecision.reasoning,
                customer_message: policyDecision.customer_message,
              });
            }
          }
        } catch(_) { /* if AI fails, proceed without policy check */ }
      }
    }

    // ── Book the return label via EasyPost ────────────────────────────────
    // Strategy: fetch the original shipment, create a new shipment with
    // from/to flipped, then buy the cheapest rate.
    const origShipment = await easypost(apiKey, "GET", `/shipments/${shipment.easypost_shipment_id}`);
    if (!origShipment.to_address || !origShipment.from_address) {
      return res.status(400).json({ error: "Original shipment data unavailable" });
    }
    const returnShipment = await easypost(apiKey, "POST", "/shipments", {
      shipment: {
        to_address: origShipment.from_address,
        from_address: origShipment.to_address,
        parcel: origShipment.parcel,
        is_return: true,
      },
    });
    if (!returnShipment.rates || returnShipment.rates.length === 0) {
      return res.status(400).json({ error: "No return rates available — check the original carrier supports returns" });
    }
    returnShipment.rates.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
    const bought = await easypost(apiKey, "POST", `/shipments/${returnShipment.id}/buy`, {
      rate: { id: returnShipment.rates[0].id },
    });

    // Save the return label as a new shipment row, linked back to the original order
    const sid = uuid();
    db.prepare(`INSERT INTO shipments
      (id, user_id, order_id, courier, service, tracking_number, tracking_url, label_url,
       status, cost, currency, to_name, to_address, to_email, easypost_shipment_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
      sid, req.userId, shipment.order_id,
      bought.selected_rate?.carrier || "unknown",
      "RETURN: " + (bought.selected_rate?.service || ""),
      bought.tracking_code,
      bought.tracker?.public_url || null,
      bought.postage_label?.label_url || null,
      "return_label_created",
      parseFloat(bought.selected_rate?.rate || 0),
      bought.selected_rate?.currency || "AUD",
      origShipment.from_address.name || "",
      JSON.stringify(origShipment.from_address),
      origShipment.from_address.email || "",
      bought.id
    );

    // Email the customer the return label
    if (shipment.to_email) {
      try {
        const fetch = (await import("node-fetch")).default;
        const sgKey = process.env.SENDGRID_API_KEY ||
          db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value;
        if (sgKey) {
          const fromEmail = process.env.SENDGRID_FROM_EMAIL ||
            db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value ||
            "hello@takeova.ai";
          const customerMsg = policyDecision?.customer_message || "Here's your pre-paid return label. Just stick it on the package and drop it off at any post office or courier point.";
          await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: shipment.to_email, name: shipment.to_name || "" }] }],
              from: { email: fromEmail, name: "Returns" },
              subject: `Your return label is ready`,
              content: [{
                type: "text/html",
                value: `<p>${customerMsg}</p>` +
                       `<p><a href="${bought.postage_label?.label_url || "#"}" style="background:#2563EB;color:white;padding:10px 18px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:600">Download return label →</a></p>` +
                       `<p>Tracking number: <b>${bought.tracking_code}</b></p>`,
              }],
            }),
          });
        }
      } catch(_) {}
    }

    res.json({
      approved: true,
      shipment_id: sid,
      label_url: bought.postage_label?.label_url,
      tracking_number: bought.tracking_code,
      tracking_url: bought.tracker?.public_url,
      cost: parseFloat(bought.selected_rate?.rate || 0),
      ai_reasoning: policyDecision?.reasoning,
    });
  } catch(e) {
    console.error("[shipping/return-label]", e.message);
    res.status(500).json({ error: e.message || "Failed to create return label" });
  }
});

// ─── POST /return-label-by-order — convenience wrapper used by the picker ─
// The picker only has the order_id available; this endpoint looks up the
// most recent original (non-return) shipment for that order and inlines the
// return-label flow.
router.post("/return-label-by-order", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const apiKey = await getUserKey(db, req.userId);
    if (!apiKey) return res.status(400).json({ error: "Connect your EasyPost account first" });

    const { order_id, reason } = req.body;
    if (!order_id) return res.status(400).json({ error: "order_id required" });

    const shipment = db.prepare(`SELECT * FROM shipments
      WHERE order_id = ? AND user_id = ? AND service NOT LIKE 'return-%'
      ORDER BY created_at DESC LIMIT 1`).get(order_id, req.userId);
    if (!shipment) {
      return res.status(404).json({ error: "No original shipment found for this order — can't book a return" });
    }

    // Fetch original shipment from EasyPost to reverse from/to
    const original = await easypost(apiKey, "GET", `/shipments/${shipment.easypost_shipment_id}`);
    if (!original.from_address || !original.to_address) {
      return res.status(400).json({ error: "Original shipment has no addresses to reverse" });
    }

    const ret = await easypost(apiKey, "POST", "/shipments", {
      shipment: {
        from_address: original.to_address,
        to_address: original.from_address,
        parcel: original.parcel,
        is_return: true,
      },
    });

    const rates = (ret.rates || []).sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
    if (!rates.length) return res.status(400).json({ error: "No return rates available" });
    const bought = await easypost(apiKey, "POST", `/shipments/${ret.id}/buy`, {
      rate: { id: rates[0].id },
    });

    const tn = bought.tracking_code;
    const labelUrl = bought.postage_label?.label_url;
    const cost = parseFloat(bought.selected_rate?.rate || 0);

    const rid = uuid();
    db.prepare(`INSERT INTO shipments
      (id, user_id, order_id, courier, service, tracking_number, tracking_url, label_url,
       status, cost, currency, to_name, to_address, to_email, easypost_shipment_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
      rid, req.userId, shipment.order_id, bought.selected_rate?.carrier || "unknown",
      "return-" + (bought.selected_rate?.service || ""),
      tn, bought.tracker?.public_url, labelUrl,
      "return_purchased", cost, bought.selected_rate?.currency || "AUD",
      shipment.to_name, shipment.to_address, shipment.to_email, bought.id
    );

    // Email buyer the label (best-effort)
    if (shipment.to_email) {
      try {
        const fetch = (await import("node-fetch")).default;
        const sgKey = process.env.SENDGRID_API_KEY ||
          db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value;
        if (sgKey) {
          const fromEmail = process.env.SENDGRID_FROM_EMAIL ||
            db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value ||
            "hello@takeova.ai";
          await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: shipment.to_email, name: shipment.to_name }] }],
              from: { email: fromEmail, name: "MINE" },
              subject: "Your return label is ready",
              content: [{ type: "text/html", value:
                `<p>Hi ${shipment.to_name || "there"},</p>` +
                `<p>Your return label is ready. Please print and attach it to your parcel, then drop off at any postal location.</p>` +
                `<p><a href="${labelUrl}" style="background:#2563EB;color:#fff;padding:11px 20px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">📄 Open return label</a></p>` +
                `<p><b>Tracking:</b> ${tn}</p>` +
                (reason ? `<p style="color:#666;font-size:13px">Reason: ${String(reason).replace(/[<>]/g,"")}</p>` : "") +
                `<p style="color:#666;font-size:13px;margin-top:24px">Once received, we'll process your refund within 3-5 business days.</p>`,
              }],
            }),
          });
        }
      } catch(_) {}
    }

    res.json({
      ok: true,
      return_label_url: labelUrl,
      return_tracking: tn,
      cost,
      emailed_to_customer: !!shipment.to_email,
    });
  } catch(e) {
    console.error("[shipping/return-label-by-order]", e.message);
    res.status(500).json({ error: e.message || "Failed to create return label" });
  }
});

// ─── GET /print-queue — list shipments with unprinted labels ──────────────
router.get("/print-queue", auth, (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const rows = db.prepare(`SELECT
        s.id, s.order_id, s.courier, s.service, s.tracking_number, s.label_url,
        s.to_name, s.cost, s.created_at, o.order_number
      FROM shipments s
      LEFT JOIN orders o ON o.id = s.order_id
      WHERE s.user_id = ?
        AND s.label_url IS NOT NULL
        AND s.label_url != ''
        AND s.printed_at IS NULL
        AND s.status NOT IN ('refunded', 'cancelled')
      ORDER BY s.created_at DESC
      LIMIT 50`).all(req.userId);
    res.json({ queue: rows, count: rows.length });
  } catch(e) {
    console.error("[shipping/print-queue]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /:id/mark-printed — flag a shipment as printed ──────────────────
router.post("/:id/mark-printed", auth, (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const r = db.prepare(`UPDATE shipments SET printed_at = datetime('now'), updated_at = datetime('now')
                          WHERE id = ? AND user_id = ?`).run(req.params.id, req.userId);
    if (r.changes === 0) return res.status(404).json({ error: "Shipment not found" });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /mark-printed-bulk — flag multiple shipments printed in one call ─
router.post("/mark-printed-bulk", auth, (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.json({ ok: true, updated: 0 });
    const stmt = db.prepare("UPDATE shipments SET printed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?");
    let count = 0;
    for (const id of ids) {
      try { if (stmt.run(id, req.userId).changes > 0) count++; } catch(_) {}
    }
    res.json({ ok: true, updated: count });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;