// ─────────────────────────────────────────────────────────────────────────────
// Agency one-off invoices — ad-hoc / project-based / custom-amount invoicing
// ─────────────────────────────────────────────────────────────────────────────
// Complements the recurring monthly fee model in agency.js. Lets agencies bill
// clients for one-off work (website builds, custom projects, hourly, etc.) on
// top of (or independent of) the recurring fee.
//
// Routes (all require auth + agencyAuth):
//   POST   /api/agency/clients/:id/invoice      → create + send invoice
//   GET    /api/agency/invoices                  → list all invoices for this agency
//   GET    /api/agency/clients/:id/invoices      → list invoices for one client
//   POST   /api/agency/invoices/:invoiceId/cancel → cancel pending invoice
//   POST   /api/agency/invoices/:invoiceId/resend → re-email checkout link
//   GET    /api/agency/invoices/:invoiceId        → get single invoice details
//
// Webhook (signature-verified, no auth):
//   POST   /api/webhooks/stripe/agency-invoice    → status updates from Stripe
//
// Commission model (matches agency.js recurring fees):
//   Agency keeps 40% of invoice amount  (AGENCY_INVOICE_REVENUE_SHARE)
//   MINE keeps  60%
//   Recorded on payment success; actual payout via existing /cron/bill flow.
//
// Table:
//   agency_invoices (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     agency_id INTEGER NOT NULL,
//     agency_user_id INTEGER NOT NULL,
//     client_id INTEGER NOT NULL,             -- agency_clients.id
//     client_user_id INTEGER NOT NULL,         -- users.id
//     amount_cents INTEGER NOT NULL,
//     currency TEXT DEFAULT 'usd',
//     line_items_json TEXT NOT NULL,           -- JSON array of {description, amount_cents, qty}
//     notes TEXT,
//     due_date TEXT,                           -- ISO date string
//     status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed | cancelled | refunded
//     stripe_session_id TEXT,
//     stripe_payment_intent_id TEXT,
//     checkout_url TEXT,
//     agency_commission_cents INTEGER,         -- 40% of amount_cents (recorded on payment)
//     mine_revenue_cents INTEGER,              -- 60% of amount_cents
//     paid_at TEXT,
//     refunded_at TEXT,
//     cancelled_at TEXT,
//     created_at TEXT DEFAULT CURRENT_TIMESTAMP,
//     updated_at TEXT DEFAULT CURRENT_TIMESTAMP
//   )
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const express = require("express");
const router  = express.Router();
const { getDb } = require("../db/init");
const { auth }  = require("../middleware/auth");

// Reuse agency middleware from agency.js. Inline here to avoid circular deps.
function agencyAuth(req, res, next) {
  try {
    const db = getDb();
    const agency = db.prepare("SELECT * FROM agencies WHERE owner_user_id = ? AND status = 'active'").get(req.userId);
    if (!agency) return res.status(403).json({ error: "Not an active agency" });
    req.agency = agency;
    next();
  } catch (e) {
    res.status(500).json({ error: "Agency lookup failed" });
  }
}

// ── Constants ────────────────────────────────────────────────────────────────
const AGENCY_INVOICE_REVENUE_SHARE = 0.40;  // Agency keeps 40% of invoice amount
const MIN_INVOICE_AMOUNT_CENTS = 100;        // $1 minimum (Stripe-imposed)
const MAX_INVOICE_AMOUNT_CENTS = 99999999;   // $999,999.99 maximum

// ── Schema migration (idempotent) ────────────────────────────────────────────
function ensureInvoiceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agency_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agency_id INTEGER NOT NULL,
      agency_user_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      client_user_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT DEFAULT 'usd',
      line_items_json TEXT NOT NULL,
      notes TEXT,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id TEXT,
      stripe_payment_intent_id TEXT,
      checkout_url TEXT,
      agency_commission_cents INTEGER,
      mine_revenue_cents INTEGER,
      paid_at TEXT,
      refunded_at TEXT,
      cancelled_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Indexes for common queries
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_agency_invoices_agency  ON agency_invoices(agency_id)"); } catch(_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_agency_invoices_client  ON agency_invoices(client_id)"); } catch(_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_agency_invoices_status  ON agency_invoices(status)"); } catch(_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_agency_invoices_session ON agency_invoices(stripe_session_id)"); } catch(_) {}
}

// Try to read getSetting from integrations (fallback to env var)
function getStripeKey() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  try {
    const { getSetting } = require("./integrations");
    return getSetting("STRIPE_SECRET_KEY") || null;
  } catch (_) {
    return null;
  }
}

// ── POST /clients/:id/invoice — create + send invoice ────────────────────────
router.post("/clients/:id/invoice", auth, agencyAuth, async (req, res) => {
  try {
    const db = getDb();
    ensureInvoiceTables(db);

    const clientRow = db.prepare(
      "SELECT ac.*, u.email AS user_email, u.name AS user_name, u.stripe_customer_id AS user_stripe_id " +
      "  FROM agency_clients ac LEFT JOIN users u ON u.id = ac.user_id " +
      " WHERE ac.id = ? AND ac.agency_id = ? AND ac.status = 'active'"
    ).get(req.params.id, req.agency.id);
    if (!clientRow) return res.status(404).json({ error: "Client not found" });

    // ── Validate body ──
    const { line_items, notes, due_date, currency } = req.body || {};
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ error: "line_items must be a non-empty array" });
    }

    // Compute amount + sanitize line items
    let amountCents = 0;
    const cleanItems = [];
    for (const raw of line_items) {
      const desc = (raw && typeof raw.description === "string") ? raw.description.trim().slice(0, 200) : "";
      const qty  = Math.max(1, parseInt(raw && raw.qty, 10) || 1);
      const unit = parseInt(raw && raw.amount_cents, 10);
      if (!desc || !Number.isFinite(unit) || unit <= 0) {
        return res.status(400).json({ error: "Each line item needs description and positive amount_cents" });
      }
      const lineTotal = unit * qty;
      amountCents += lineTotal;
      cleanItems.push({ description: desc, amount_cents: unit, qty, line_total_cents: lineTotal });
    }
    if (amountCents < MIN_INVOICE_AMOUNT_CENTS || amountCents > MAX_INVOICE_AMOUNT_CENTS) {
      return res.status(400).json({ error: `Total must be between $${MIN_INVOICE_AMOUNT_CENTS/100} and $${MAX_INVOICE_AMOUNT_CENTS/100}` });
    }

    const cleanNotes = typeof notes === "string" ? notes.trim().slice(0, 1000) : "";
    const cleanDueDate = (typeof due_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(due_date)) ? due_date.slice(0, 10) : null;
    const cleanCurrency = (typeof currency === "string" && /^[a-z]{3}$/i.test(currency)) ? currency.toLowerCase() : "usd";

    // ── Create DB row first (so we have an ID to put in Stripe metadata) ──
    const insertResult = db.prepare(`
      INSERT INTO agency_invoices
        (agency_id, agency_user_id, client_id, client_user_id, amount_cents, currency, line_items_json, notes, due_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      req.agency.id, req.userId, clientRow.id, clientRow.user_id,
      amountCents, cleanCurrency, JSON.stringify(cleanItems),
      cleanNotes || null, cleanDueDate
    );
    const invoiceId = insertResult.lastInsertRowid;

    // ── Stripe Checkout Session ──
    const stripeKey = getStripeKey();
    if (!stripeKey) {
      // Mark as draft if Stripe isn't configured — agency can still see/track it locally
      db.prepare("UPDATE agency_invoices SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(invoiceId);
      return res.status(500).json({ error: "Stripe not configured — invoice saved as draft" });
    }
    const stripe = require("stripe")(stripeKey);

    // Ensure Stripe customer
    let stripeCustomerId = clientRow.stripe_customer_id || clientRow.user_stripe_id;
    if (!stripeCustomerId) {
      const cu = await stripe.customers.create({
        email: clientRow.client_email || clientRow.user_email,
        name:  clientRow.client_name  || clientRow.user_name,
        metadata: {
          mine_user_id:    String(clientRow.user_id || ""),
          mine_agency_id:  String(req.agency.id),
        },
      });
      stripeCustomerId = cu.id;
      db.prepare("UPDATE agency_clients SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, clientRow.id);
      db.prepare("UPDATE users           SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, clientRow.user_id);
    }

    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
    const session = await stripe.checkout.sessions.create({
      mode:                 "payment",
      payment_method_types: ["card"],
      customer:             stripeCustomerId,
      success_url:          `${frontendUrl}/?invoice_paid=${invoiceId}`,
      cancel_url:           `${frontendUrl}/?invoice_cancelled=${invoiceId}`,
      line_items: cleanItems.map(it => ({
        price_data: {
          currency:    cleanCurrency,
          unit_amount: it.amount_cents,
          product_data: { name: it.description.slice(0, 250) },
        },
        quantity: it.qty,
      })),
      metadata: {
        type:                 "agency_invoice",
        mine_invoice_id:      String(invoiceId),
        mine_agency_id:       String(req.agency.id),
        mine_agency_user_id:  String(req.userId),
        mine_client_id:       String(clientRow.id),
        mine_client_user_id:  String(clientRow.user_id || ""),
      },
      payment_intent_data: {
        metadata: {
          type:                 "agency_invoice",
          mine_invoice_id:      String(invoiceId),
          mine_agency_id:       String(req.agency.id),
        },
        description: `Agency invoice #${invoiceId}` + (cleanNotes ? ` — ${cleanNotes.slice(0, 80)}` : ""),
      },
    });

    db.prepare(`
      UPDATE agency_invoices
         SET stripe_session_id = ?, checkout_url = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(session.id, session.url, invoiceId);

    res.json({
      invoice_id:    invoiceId,
      checkout_url:  session.url,
      session_id:    session.id,
      amount_cents:  amountCents,
      currency:      cleanCurrency,
      status:        "pending",
    });
  } catch (e) {
    console.error("[agency-invoices] create error:", e.message);
    res.status(500).json({ error: "Could not create invoice" });
  }
});

// ── GET /invoices — list all for this agency ─────────────────────────────────
router.get("/invoices", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb();
    ensureInvoiceTables(db);
    const status = (req.query && typeof req.query.status === "string") ? req.query.status : null;
    let sql = `
      SELECT ai.*, ac.client_name, ac.client_email, u.name AS client_user_name
        FROM agency_invoices ai
        LEFT JOIN agency_clients ac ON ac.id = ai.client_id
        LEFT JOIN users u ON u.id = ai.client_user_id
       WHERE ai.agency_id = ?
    `;
    const params = [req.agency.id];
    if (status && ["pending","paid","failed","cancelled","refunded","draft"].includes(status)) {
      sql += " AND ai.status = ?"; params.push(status);
    }
    sql += " ORDER BY ai.created_at DESC LIMIT 500";
    const rows = db.prepare(sql).all(...params).map(parseInvoiceRow);
    res.json({ invoices: rows, count: rows.length });
  } catch (e) {
    console.error("[agency-invoices] list error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── GET /clients/:id/invoices — list for one client ──────────────────────────
router.get("/clients/:id/invoices", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb();
    ensureInvoiceTables(db);
    const rows = db.prepare(`
      SELECT ai.*, ac.client_name, ac.client_email
        FROM agency_invoices ai
        LEFT JOIN agency_clients ac ON ac.id = ai.client_id
       WHERE ai.agency_id = ? AND ai.client_id = ?
       ORDER BY ai.created_at DESC LIMIT 200
    `).all(req.agency.id, req.params.id).map(parseInvoiceRow);
    res.json({ invoices: rows, count: rows.length });
  } catch (e) {
    console.error("[agency-invoices] client list error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── GET /invoices/:invoiceId — single invoice ────────────────────────────────
router.get("/invoices/:invoiceId", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb();
    ensureInvoiceTables(db);
    const row = db.prepare(`
      SELECT ai.*, ac.client_name, ac.client_email
        FROM agency_invoices ai
        LEFT JOIN agency_clients ac ON ac.id = ai.client_id
       WHERE ai.id = ? AND ai.agency_id = ?
    `).get(req.params.invoiceId, req.agency.id);
    if (!row) return res.status(404).json({ error: "Invoice not found" });
    res.json(parseInvoiceRow(row));
  } catch (e) {
    console.error("[agency-invoices] get error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── POST /invoices/:invoiceId/cancel ─────────────────────────────────────────
router.post("/invoices/:invoiceId/cancel", auth, agencyAuth, async (req, res) => {
  try {
    const db = getDb();
    ensureInvoiceTables(db);
    const row = db.prepare(
      "SELECT * FROM agency_invoices WHERE id = ? AND agency_id = ?"
    ).get(req.params.invoiceId, req.agency.id);
    if (!row) return res.status(404).json({ error: "Invoice not found" });
    if (row.status !== "pending" && row.status !== "draft") {
      return res.status(400).json({ error: `Cannot cancel invoice in status '${row.status}'` });
    }

    // Best-effort expire the Stripe session (may already be expired/paid)
    if (row.stripe_session_id) {
      const stripeKey = getStripeKey();
      if (stripeKey) {
        try {
          const stripe = require("stripe")(stripeKey);
          await stripe.checkout.sessions.expire(row.stripe_session_id);
        } catch (e) { /* non-fatal */ }
      }
    }

    db.prepare(`
      UPDATE agency_invoices
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(row.id);
    res.json({ ok: true, invoice_id: row.id, status: "cancelled" });
  } catch (e) {
    console.error("[agency-invoices] cancel error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── POST /invoices/:invoiceId/resend — regenerate checkout link ──────────────
// Stripe sessions expire after 24h; this creates a fresh one for the same invoice.
router.post("/invoices/:invoiceId/resend", auth, agencyAuth, async (req, res) => {
  try {
    const db = getDb();
    ensureInvoiceTables(db);
    const row = db.prepare(
      "SELECT * FROM agency_invoices WHERE id = ? AND agency_id = ?"
    ).get(req.params.invoiceId, req.agency.id);
    if (!row) return res.status(404).json({ error: "Invoice not found" });
    if (row.status !== "pending" && row.status !== "draft") {
      return res.status(400).json({ error: `Cannot resend invoice in status '${row.status}'` });
    }
    const stripeKey = getStripeKey();
    if (!stripeKey) return res.status(500).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);

    const items = JSON.parse(row.line_items_json || "[]");
    const clientRow = db.prepare(
      "SELECT ac.*, u.stripe_customer_id AS user_stripe_id FROM agency_clients ac LEFT JOIN users u ON u.id = ac.user_id WHERE ac.id = ?"
    ).get(row.client_id);
    if (!clientRow) return res.status(404).json({ error: "Client missing — cannot resend" });

    const stripeCustomerId = clientRow.stripe_customer_id || clientRow.user_stripe_id;
    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

    const session = await stripe.checkout.sessions.create({
      mode:                 "payment",
      payment_method_types: ["card"],
      customer:             stripeCustomerId || undefined,
      success_url:          `${frontendUrl}/?invoice_paid=${row.id}`,
      cancel_url:           `${frontendUrl}/?invoice_cancelled=${row.id}`,
      line_items: items.map(it => ({
        price_data: {
          currency:    row.currency || "usd",
          unit_amount: it.amount_cents,
          product_data: { name: String(it.description || "").slice(0, 250) },
        },
        quantity: it.qty || 1,
      })),
      metadata: {
        type:            "agency_invoice",
        mine_invoice_id: String(row.id),
        mine_agency_id:  String(req.agency.id),
      },
      payment_intent_data: {
        metadata: { type: "agency_invoice", mine_invoice_id: String(row.id), mine_agency_id: String(req.agency.id) },
        description: `Agency invoice #${row.id} (resent)`,
      },
    });

    db.prepare(`
      UPDATE agency_invoices
         SET stripe_session_id = ?, checkout_url = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(session.id, session.url, row.id);

    res.json({ ok: true, checkout_url: session.url, session_id: session.id });
  } catch (e) {
    console.error("[agency-invoices] resend error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook — invoked from server.js's main /api/webhooks/stripe handler.
// Exported so the main webhook router can dispatch agency-invoice events here
// after signature verification. We still expose a router endpoint as a fallback
// for setups that route per-feature webhooks.
// ─────────────────────────────────────────────────────────────────────────────
function handleStripeEvent(event) {
  const db = getDb();
  ensureInvoiceTables(db);
  try {
    const obj  = event && event.data && event.data.object;
    const meta = (obj && obj.metadata) || {};
    if (meta.type !== "agency_invoice") return false;  // not ours
    const invoiceId = parseInt(meta.mine_invoice_id, 10);
    if (!invoiceId) return false;

    const row = db.prepare("SELECT * FROM agency_invoices WHERE id = ?").get(invoiceId);
    if (!row) return false;

    if (event.type === "checkout.session.completed" || event.type === "payment_intent.succeeded") {
      const piId = obj.payment_intent || obj.id;
      const amt  = obj.amount_total || obj.amount_received || obj.amount || row.amount_cents;
      const commission = Math.floor(amt * AGENCY_INVOICE_REVENUE_SHARE);
      const mineCut    = amt - commission;
      db.prepare(`
        UPDATE agency_invoices
           SET status = 'paid',
               stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
               agency_commission_cents = ?,
               mine_revenue_cents = ?,
               paid_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('pending','draft')
      `).run(piId || null, commission, mineCut, invoiceId);
      return true;
    }

    if (event.type === "payment_intent.payment_failed" || event.type === "checkout.session.expired") {
      db.prepare(`
        UPDATE agency_invoices
           SET status = 'failed', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'
      `).run(invoiceId);
      return true;
    }

    if (event.type === "charge.refunded") {
      db.prepare(`
        UPDATE agency_invoices
           SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(invoiceId);
      return true;
    }
    return false;
  } catch (e) {
    console.error("[agency-invoices] webhook dispatch error:", e.message);
    return false;
  }
}

// Standalone webhook endpoint — verifies signature itself. The main /api/webhooks/stripe
// handler in server.js can ALSO call handleStripeEvent() directly after its own verify;
// either approach works.
router.post("/webhooks/stripe/agency-invoice", express.raw({ type: "application/json" }), (req, res) => {
  const stripeKey = getStripeKey();
  const whSecret  = process.env.STRIPE_WEBHOOK_SECRET || (() => {
    try { const { getSetting } = require("./integrations"); return getSetting("STRIPE_WEBHOOK_SECRET"); } catch(_) { return null; }
  })();
  if (!stripeKey || !whSecret) return res.status(500).json({ error: "Stripe webhook not configured" });

  let event;
  try {
    const stripe = require("stripe")(stripeKey);
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], whSecret);
  } catch (e) {
    return res.status(400).json({ error: "Invalid signature: " + e.message });
  }
  handleStripeEvent(event);
  res.json({ received: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseInvoiceRow(row) {
  if (!row) return null;
  const items = (() => {
    try { return JSON.parse(row.line_items_json || "[]"); } catch (_) { return []; }
  })();
  return {
    id:                       row.id,
    agency_id:                row.agency_id,
    client_id:                row.client_id,
    client_name:              row.client_name || row.client_user_name || "",
    client_email:             row.client_email || "",
    amount_cents:             row.amount_cents,
    currency:                 row.currency,
    line_items:               items,
    notes:                    row.notes || "",
    due_date:                 row.due_date,
    status:                   row.status,
    checkout_url:             row.checkout_url,
    stripe_session_id:        row.stripe_session_id,
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    agency_commission_cents:  row.agency_commission_cents,
    mine_revenue_cents:       row.mine_revenue_cents,
    paid_at:                  row.paid_at,
    refunded_at:              row.refunded_at,
    cancelled_at:             row.cancelled_at,
    created_at:               row.created_at,
    updated_at:               row.updated_at,
  };
}

module.exports = router;
module.exports.handleStripeEvent = handleStripeEvent;
module.exports.ensureInvoiceTables = ensureInvoiceTables;
