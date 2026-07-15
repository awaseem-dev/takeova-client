// ═══════════════════════════════════════════════════════════════════
// MINE — Admin Finance Oversight + Platform Charges
//
// Mounted at /api/admin/finance — all routes require admin role.
//
// SOURCES of invoices on the platform:
//   user      → `invoices`         (user → their client, money to user's Connect)
//   agency    → `agency_invoices`  (agency → client, MINE Stripe + 60/40 split)
//   platform  → `platform_charges` (MINE → user, money to MINE Stripe direct)
//
// ENDPOINTS:
//   GET  /overview                                     — stat totals
//   GET  /invoices                                     — combined list across all 3 sources
//   GET  /invoices.csv                                 — CSV export of same
//   GET  /dunning                                      — failed payment attempts
//   POST /charges                                      — admin creates a platform charge
//   POST /charges/:id/pay-link                         — generate Stripe Checkout URL for a charge
//   POST /reminders/bulk                               — bulk-send reminders for overdue
//   POST /invoices/:source/:id/mark-paid               — admin manual mark paid
//   POST /invoices/:source/:id/remind                  — send single reminder
//   POST /invoices/:source/:id/refund                  — Stripe refund + DB update
//   POST /invoices/:source/:id/cancel                  — cancel unpaid
//
// WEBHOOK: handleStripeEvent(event) is exported. server.js's main /webhook
// dispatches checkout.session.completed events with metadata.type === 'platform_charge'
// here, marking the charge paid and recording stripe_payment_intent_id.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { auth: requireAuth } = require('../middleware/auth');

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function getDb(req) {
  return (req && req.app && req.app.locals && req.app.locals.db) || require('../db/init').getDb();
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try { return require('stripe')(process.env.STRIPE_SECRET_KEY); } catch (_) { return null; }
}

function safeAudit(db, userId, event, meta) {
  try {
    db.prepare(
      "INSERT INTO audit_log (user_id, event, meta, created_at) VALUES (?, ?, ?, datetime('now'))"
    ).run(userId || 'admin', event, JSON.stringify(meta || {}));
  } catch (_) { /* audit_log may not exist in dev */ }
}

function getEmailService() {
  if (!process.env.SENDGRID_API_KEY) return null;
  try {
    const sg = require('@sendgrid/mail');
    sg.setApiKey(process.env.SENDGRID_API_KEY);
    return sg;
  } catch (_) { return null; }
}

async function sendReminderEmail(toEmail, invoiceLabel, amount, payLink) {
  const sg = getEmailService();
  if (!sg || !toEmail) return false;
  try {
    await sg.send({
      to: toEmail,
      from: process.env.EMAIL_FROM || 'billing@takeova.ai',
      subject: 'Payment reminder: ' + invoiceLabel,
      html: '<p>Hi there,</p>'
        + '<p>This is a friendly reminder that <strong>' + invoiceLabel + '</strong> for $' + Number(amount || 0).toFixed(2) + ' is awaiting payment.</p>'
        + (payLink ? '<p><a href="' + payLink + '">Pay now →</a></p>' : '')
        + '<p>Thanks,<br>TAKEOVA</p>',
    });
    return true;
  } catch (e) { console.error('[admin-finance/reminder]', e.message); return false; }
}

// ─── 1. OVERVIEW ─────────────────────────────────────────────────────
router.get('/overview', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = getDb(req);

    const userTotals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'paid'      THEN COALESCE(total, amount, 0) ELSE 0 END), 0) AS paid,
        COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled','void','refunded','draft') THEN COALESCE(total, amount, 0) ELSE 0 END), 0) AS outstanding,
        COALESCE(SUM(CASE WHEN status = 'refunded'  THEN COALESCE(total, amount, 0) ELSE 0 END), 0) AS refunded,
        COUNT(*) AS total_count
      FROM invoices
    `).get() || {};

    let agencyTotals = { paid: 0, outstanding: 0, refunded: 0, total_count: 0 };
    try {
      agencyTotals = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'paid'      THEN COALESCE(amount_cents, 0) ELSE 0 END) / 100.0, 0) AS paid,
          COALESCE(SUM(CASE WHEN status IN ('pending','sent') THEN COALESCE(amount_cents, 0) ELSE 0 END) / 100.0, 0) AS outstanding,
          COALESCE(SUM(CASE WHEN status = 'refunded'  THEN COALESCE(amount_cents, 0) ELSE 0 END) / 100.0, 0) AS refunded,
          COUNT(*) AS total_count
        FROM agency_invoices
      `).get() || agencyTotals;
    } catch (_) {}

    let platformTotals = { paid: 0, outstanding: 0, refunded: 0, total_count: 0 };
    try {
      platformTotals = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'paid'      THEN COALESCE(amount_cents, 0) ELSE 0 END) / 100.0, 0) AS paid,
          COALESCE(SUM(CASE WHEN status IN ('pending','sent') THEN COALESCE(amount_cents, 0) ELSE 0 END) / 100.0, 0) AS outstanding,
          COALESCE(SUM(CASE WHEN status = 'refunded'  THEN COALESCE(amount_cents, 0) ELSE 0 END) / 100.0, 0) AS refunded,
          COUNT(*) AS total_count
        FROM platform_charges
      `).get() || platformTotals;
    } catch (_) {}

    let platformFees = 0;
    try {
      const fee = db.prepare(`SELECT COALESCE(SUM(platform_fee_cents),0) AS fee FROM agency_invoices WHERE status='paid'`).get();
      platformFees = (fee?.fee || 0) / 100;
    } catch (_) {}
    platformFees += (platformTotals.paid || 0);

    let dunningOpen = 0;
    try { dunningOpen = db.prepare("SELECT COUNT(*) AS c FROM dunning_log WHERE status='pending'").get()?.c || 0; } catch (_) {}

    res.json({
      user: userTotals, agency: agencyTotals, platform: platformTotals,
      combined: {
        paid_revenue: (userTotals.paid || 0) + (agencyTotals.paid || 0) + (platformTotals.paid || 0),
        outstanding:  (userTotals.outstanding || 0) + (agencyTotals.outstanding || 0) + (platformTotals.outstanding || 0),
        refunded:     (userTotals.refunded || 0) + (agencyTotals.refunded || 0) + (platformTotals.refunded || 0),
        total_count:  (userTotals.total_count || 0) + (agencyTotals.total_count || 0) + (platformTotals.total_count || 0),
      },
      platform_fees_collected: platformFees,
      dunning_open: dunningOpen,
    });
  } catch (e) {
    console.error('[admin-finance/overview]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 2. LIST INVOICES (combined) ─────────────────────────────────────
function fetchCombinedInvoices(db, source, status, q, limit, offset) {
  const out = [];

  if (source === 'all' || source === 'user') {
    let sql = `
      SELECT
        i.id, i.user_id, i.invoice_number, i.client_name, i.client_email,
        COALESCE(i.total, i.amount, 0) AS amount,
        i.status, i.due_date, i.paid_at, i.stripe_payment_link, i.created_at,
        u.email AS owner_email
      FROM invoices i
      LEFT JOIN users u ON u.id = i.user_id
      WHERE 1=1
    `;
    const args = [];
    if (status !== 'all') {
      if (status === 'pending') sql += " AND i.status NOT IN ('paid','cancelled','void','refunded','draft')";
      else { sql += ' AND i.status = ?'; args.push(status); }
    }
    if (q) {
      sql += ' AND (LOWER(i.client_name) LIKE ? OR LOWER(i.client_email) LIKE ? OR LOWER(i.invoice_number) LIKE ? OR LOWER(u.email) LIKE ?)';
      const like = '%' + q + '%';
      args.push(like, like, like, like);
    }
    sql += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);
    try { db.prepare(sql).all(...args).forEach(r => out.push(Object.assign(r, { source: 'user' }))); }
    catch (e) { console.warn('[admin-finance/list user]', e.message); }
  }

  if (source === 'all' || source === 'agency') {
    let sql = `
      SELECT
        ai.id, ai.agency_user_id AS user_id, ai.invoice_number, ai.client_id,
        COALESCE(ai.amount_cents, 0) / 100.0 AS amount,
        ai.platform_fee_cents,
        ai.status, ai.due_date, ai.paid_at, ai.stripe_checkout_url, ai.created_at,
        u.email AS owner_email,
        c.name  AS client_name,
        c.email AS client_email
      FROM agency_invoices ai
      LEFT JOIN users u ON u.id = ai.agency_user_id
      LEFT JOIN agency_clients c ON c.id = ai.client_id
      WHERE 1=1
    `;
    const args = [];
    if (status !== 'all') {
      if (status === 'pending') sql += " AND ai.status IN ('pending','sent')";
      else { sql += ' AND ai.status = ?'; args.push(status); }
    }
    if (q) {
      sql += ' AND (LOWER(c.name) LIKE ? OR LOWER(c.email) LIKE ? OR LOWER(ai.invoice_number) LIKE ? OR LOWER(u.email) LIKE ?)';
      const like = '%' + q + '%';
      args.push(like, like, like, like);
    }
    sql += ' ORDER BY ai.created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);
    try { db.prepare(sql).all(...args).forEach(r => out.push(Object.assign(r, { source: 'agency', stripe_payment_link: r.stripe_checkout_url }))); }
    catch (e) { console.warn('[admin-finance/list agency]', e.message); }
  }

  if (source === 'all' || source === 'platform') {
    let sql = `
      SELECT
        pc.id, pc.user_id, pc.charge_number AS invoice_number,
        COALESCE(pc.amount_cents, 0) / 100.0 AS amount,
        pc.description, pc.notes,
        pc.status, pc.due_date, pc.paid_at, pc.stripe_checkout_url, pc.created_at,
        u.email AS owner_email
      FROM platform_charges pc
      LEFT JOIN users u ON u.id = pc.user_id
      WHERE 1=1
    `;
    const args = [];
    if (status !== 'all') {
      if (status === 'pending') sql += " AND pc.status IN ('pending','sent')";
      else { sql += ' AND pc.status = ?'; args.push(status); }
    }
    if (q) {
      sql += ' AND (LOWER(pc.description) LIKE ? OR LOWER(pc.charge_number) LIKE ? OR LOWER(u.email) LIKE ?)';
      const like = '%' + q + '%';
      args.push(like, like, like);
    }
    sql += ' ORDER BY pc.created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);
    try {
      db.prepare(sql).all(...args).forEach(r => out.push(Object.assign(r, {
        source: 'platform',
        client_name: 'TAKEOVA Platform',
        client_email: r.owner_email,
        stripe_payment_link: r.stripe_checkout_url,
      })));
    } catch (e) { console.warn('[admin-finance/list platform]', e.message); }
  }

  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

router.get('/invoices', requireAuth, requireAdmin, (req, res) => {
  try {
    const db     = getDb(req);
    const source = (req.query.source || 'all').toLowerCase();
    const status = (req.query.status || 'all').toLowerCase();
    const q      = String(req.query.q || '').trim().toLowerCase();
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const out = fetchCombinedInvoices(db, source, status, q, limit, offset);
    res.json({ invoices: out.slice(0, limit), total: out.length, source, status, q });
  } catch (e) {
    console.error('[admin-finance/invoices]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 2b. CSV EXPORT ──────────────────────────────────────────────────
router.get('/invoices.csv', requireAuth, requireAdmin, (req, res) => {
  try {
    const db     = getDb(req);
    const source = (req.query.source || 'all').toLowerCase();
    const status = (req.query.status || 'all').toLowerCase();
    const q      = String(req.query.q || '').trim().toLowerCase();
    const rows   = fetchCombinedInvoices(db, source, status, q, 10000, 0);

    const esc = v => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const header = 'source,id,invoice_number,owner_email,client_name,client_email,amount,status,due_date,paid_at,created_at\n';
    const body   = rows.map(r => [
      r.source, r.id, r.invoice_number || '', r.owner_email || '',
      r.client_name || '', r.client_email || '',
      Number(r.amount || 0).toFixed(2),
      r.status || '', r.due_date || '', r.paid_at || '', r.created_at || ''
    ].map(esc).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mine-invoices-' + new Date().toISOString().slice(0,10) + '.csv"');
    res.send(header + body);
  } catch (e) {
    console.error('[admin-finance/csv]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 3. DUNNING ──────────────────────────────────────────────────────
router.get('/dunning', requireAuth, requireAdmin, (req, res) => {
  try {
    const db     = getDb(req);
    const status = (req.query.status || 'pending').toLowerCase();
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    let sql = `
      SELECT d.id, d.user_id, d.type, d.attempt, d.amount, d.period,
             d.stripe_invoice_id, d.status, d.created_at,
             u.email AS user_email
      FROM dunning_log d
      LEFT JOIN users u ON u.id = d.user_id
      WHERE 1=1
    `;
    const args = [];
    if (status !== 'all') { sql += ' AND d.status = ?'; args.push(status); }
    sql += ' ORDER BY d.created_at DESC LIMIT ?';
    args.push(limit);

    let rows = [];
    try { rows = db.prepare(sql).all(...args) || []; }
    catch (e) { console.warn('[admin-finance/dunning]', e.message); }

    res.json({ dunning: rows, status });
  } catch (e) {
    console.error('[admin-finance/dunning]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 3b. USER LOOKUP (for + New Invoice modal autocomplete) ──────────
// GET /api/admin/finance/users/lookup?q=
router.get('/users/lookup', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = getDb(req);
    const q  = String(req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 2) return res.json({ users: [] });
    const like = '%' + q + '%';
    let users = [];
    try {
      users = db.prepare(`
        SELECT id, email, plan, role
        FROM users
        WHERE LOWER(email) LIKE ?
        ORDER BY email ASC LIMIT 20
      `).all(like) || [];
    } catch (e) { console.warn('[users/lookup]', e.message); }
    res.json({ users });
  } catch (e) {
    console.error('[admin-finance/users-lookup]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 4. CREATE PLATFORM CHARGE ───────────────────────────────────────
router.post('/charges', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = getDb(req);
    const { user_id, user_email, items, description, due_date, notes } = req.body || {};

    let resolvedUserId = user_id || null;
    if (!resolvedUserId && user_email) {
      const u = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(String(user_email).trim());
      if (!u) return res.status(404).json({ error: 'No user found with that email' });
      resolvedUserId = u.id;
    }
    if (!resolvedUserId) return res.status(400).json({ error: 'user_id or user_email required' });

    let amountCents = 0;
    let descSummary = description || '';
    if (Array.isArray(items) && items.length) {
      for (const it of items) {
        const qty   = parseInt(it.qty, 10) || 1;
        const price = parseFloat(it.price) || 0;
        if (qty < 1 || price <= 0) return res.status(400).json({ error: 'Invalid line item: qty must be >=1 and price must be >0' });
        amountCents += Math.round(qty * price * 100);
      }
      if (!descSummary) descSummary = items[0].description + (items.length > 1 ? ' + ' + (items.length - 1) + ' more' : '');
    } else if (description && req.body.amount) {
      amountCents = Math.round(parseFloat(req.body.amount) * 100);
    } else {
      return res.status(400).json({ error: 'items[] (or description+amount) required' });
    }
    if (amountCents <= 0) return res.status(400).json({ error: 'Amount must be > 0' });

    const chargeNum = 'PLT-' + Date.now().toString().slice(-8);
    const r = db.prepare(`
      INSERT INTO platform_charges
        (user_id, admin_user_id, charge_number, amount_cents, description, notes, status, due_date)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      resolvedUserId, req.userId, chargeNum, amountCents,
      descSummary, notes || (Array.isArray(items) ? JSON.stringify(items) : null),
      due_date || null
    );

    safeAudit(db, req.userId, 'admin_platform_charge_create', {
      charge_id: r.lastInsertRowid, user_id: resolvedUserId, amount_cents: amountCents
    });

    res.json({ id: r.lastInsertRowid, charge_number: chargeNum, amount: amountCents / 100, success: true });
  } catch (e) {
    console.error('[admin-finance/charges]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 5. GENERATE STRIPE CHECKOUT FOR A PLATFORM CHARGE ───────────────
router.post('/charges/:id/pay-link', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getDb(req);
    const stripe = getStripe();
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured (STRIPE_SECRET_KEY missing)' });

    const charge = db.prepare('SELECT * FROM platform_charges WHERE id = ?').get(req.params.id);
    if (!charge) return res.status(404).json({ error: 'Charge not found' });
    if (charge.status === 'paid')      return res.status(400).json({ error: 'Already paid' });
    if (charge.status === 'cancelled') return res.status(400).json({ error: 'Cancelled — cannot generate pay link' });

    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(charge.user_id);
    const userEmail = user?.email || null;

    const FRONTEND = process.env.FRONTEND_URL || 'https://takeova.ai';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: userEmail || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: charge.description || ('Platform Charge ' + charge.charge_number) },
          unit_amount: charge.amount_cents,
        },
        quantity: 1,
      }],
      success_url: `${FRONTEND}?platform_charge_paid=${charge.id}`,
      cancel_url:  `${FRONTEND}?platform_charge_cancelled=${charge.id}`,
      metadata: { type: 'platform_charge', platform_charge_id: String(charge.id), user_id: charge.user_id },
    });

    db.prepare('UPDATE platform_charges SET stripe_checkout_url = ?, stripe_session_id = ? WHERE id = ?')
      .run(session.url, session.id, req.params.id);

    res.json({ url: session.url, session_id: session.id });
  } catch (e) {
    console.error('[admin-finance/pay-link]', e.message);
    res.status(500).json({ error: e.message || 'Internal error' });
  }
});

// ─── 6. MARK PAID (manual, any source) ───────────────────────────────
router.post('/invoices/:source/:id/mark-paid', requireAuth, requireAdmin, (req, res) => {
  try {
    const { source, id } = req.params;
    if (!['user', 'agency', 'platform'].includes(source)) return res.status(400).json({ error: 'Invalid source' });
    const db = getDb(req);

    const tableMap = { user: 'invoices', agency: 'agency_invoices', platform: 'platform_charges' };
    const table    = tableMap[source];
    const inv = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status === 'paid')      return res.status(400).json({ error: 'Already paid' });
    if (inv.status === 'cancelled') return res.status(400).json({ error: 'Cancelled — cannot mark paid' });
    if (inv.status === 'refunded')  return res.status(400).json({ error: 'Refunded — cannot mark paid' });

    db.prepare(`UPDATE ${table} SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(id);
    safeAudit(db, req.userId, 'admin_invoice_mark_paid', { source, invoice_id: id, reason: req.body?.reason || null });
    res.json({ success: true, source, invoice_id: id });
  } catch (e) {
    console.error('[admin-finance/mark-paid]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 7. SEND REMINDER (single) ───────────────────────────────────────
router.post('/invoices/:source/:id/remind', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { source, id } = req.params;
    if (!['user', 'agency', 'platform'].includes(source)) return res.status(400).json({ error: 'Invalid source' });
    const db = getDb(req);

    let toEmail, label, amount, payLink, isPlatform = false;
    if (source === 'user') {
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      toEmail = inv.client_email; label = inv.invoice_number || ('INV-' + inv.id);
      amount  = parseFloat(inv.total || inv.amount) || 0;
      payLink = inv.stripe_payment_link;
    } else if (source === 'agency') {
      const inv = db.prepare(`SELECT ai.*, c.email AS client_email FROM agency_invoices ai LEFT JOIN agency_clients c ON c.id = ai.client_id WHERE ai.id = ?`).get(id);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      toEmail = inv.client_email; label = inv.invoice_number || ('AGY-' + inv.id);
      amount  = (inv.amount_cents || 0) / 100;
      payLink = inv.stripe_checkout_url;
    } else {
      const inv = db.prepare(`SELECT pc.*, u.email AS user_email FROM platform_charges pc LEFT JOIN users u ON u.id = pc.user_id WHERE pc.id = ?`).get(id);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      toEmail = inv.user_email; label = inv.charge_number || ('PLT-' + inv.id);
      amount  = (inv.amount_cents || 0) / 100;
      payLink = inv.stripe_checkout_url;
      isPlatform = true;
    }

    if (!toEmail) return res.status(400).json({ error: 'No email to send reminder to' });
    const ok = await sendReminderEmail(toEmail, label, amount, payLink);

    if (isPlatform) {
      try { db.prepare(`UPDATE platform_charges SET last_reminder_at = datetime('now') WHERE id = ?`).run(id); } catch (_) {}
    }

    safeAudit(db, req.userId, 'admin_invoice_remind', { source, invoice_id: id, sent: ok, to: toEmail });
    res.json({ success: ok, sent_to: toEmail, email_configured: !!getEmailService() });
  } catch (e) {
    console.error('[admin-finance/remind]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 8. BULK REMINDERS (overdue) ─────────────────────────────────────
router.post('/reminders/bulk', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getDb(req);
    const today = new Date().toISOString().slice(0, 10);

    const overdue = [];
    try {
      db.prepare(`SELECT id, client_email AS email, invoice_number, COALESCE(total, amount, 0) AS amount, stripe_payment_link AS link
                  FROM invoices WHERE status NOT IN ('paid','cancelled','void','refunded','draft') AND due_date IS NOT NULL AND due_date < ?`).all(today)
        .forEach(r => overdue.push(Object.assign(r, { source: 'user' })));
    } catch (_) {}
    try {
      db.prepare(`SELECT ai.id, c.email, ai.invoice_number, ai.amount_cents, ai.stripe_checkout_url AS link
                  FROM agency_invoices ai LEFT JOIN agency_clients c ON c.id = ai.client_id
                  WHERE ai.status IN ('pending','sent') AND ai.due_date IS NOT NULL AND ai.due_date < ?`).all(today)
        .forEach(r => overdue.push({ id: r.id, email: r.email, invoice_number: r.invoice_number, amount: (r.amount_cents||0)/100, link: r.link, source: 'agency' }));
    } catch (_) {}
    try {
      db.prepare(`SELECT pc.id, u.email, pc.charge_number AS invoice_number, pc.amount_cents, pc.stripe_checkout_url AS link
                  FROM platform_charges pc LEFT JOIN users u ON u.id = pc.user_id
                  WHERE pc.status IN ('pending','sent') AND pc.due_date IS NOT NULL AND pc.due_date < ?`).all(today)
        .forEach(r => overdue.push({ id: r.id, email: r.email, invoice_number: r.invoice_number, amount: (r.amount_cents||0)/100, link: r.link, source: 'platform' }));
    } catch (_) {}

    let sent = 0, skipped = 0;
    for (const row of overdue) {
      if (!row.email) { skipped++; continue; }
      const ok = await sendReminderEmail(row.email, row.invoice_number || '#' + row.id, row.amount || 0, row.link);
      if (ok) sent++; else skipped++;
    }

    safeAudit(db, req.userId, 'admin_bulk_reminders', { found: overdue.length, sent, skipped });
    res.json({ success: true, found: overdue.length, sent, skipped, email_configured: !!getEmailService() });
  } catch (e) {
    console.error('[admin-finance/bulk-reminders]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 9. REFUND ───────────────────────────────────────────────────────
router.post('/invoices/:source/:id/refund', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { source, id } = req.params;
    const { reason, amount } = req.body || {};
    if (!['user', 'agency', 'platform'].includes(source)) return res.status(400).json({ error: 'Invalid source' });

    const db     = getDb(req);
    const stripe = getStripe();

    const tableMap = { user: 'invoices', agency: 'agency_invoices', platform: 'platform_charges' };
    const table    = tableMap[source];
    const inv = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    if (inv.status === 'refunded') return res.status(400).json({ error: 'Already refunded' });
    if (inv.status !== 'paid')     return res.status(400).json({ error: 'Only paid invoices can be refunded' });

    const paymentIntentId = inv.stripe_payment_intent_id || (source === 'user' ? inv.stripe_invoice_id : null);
    let stripeRefundId = null;
    if (stripe && paymentIntentId) {
      try {
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          amount: amount ? Math.round(amount * 100) : undefined,
          reason: 'requested_by_customer',
          metadata: { admin_user_id: req.userId, admin_reason: reason || '' },
        });
        stripeRefundId = refund.id;
      } catch (e) { console.error('[admin-finance/refund stripe]', e.message); }
    }

    const refundedAtCol = source === 'platform' ? ", refunded_at = datetime('now')" : '';
    db.prepare(`UPDATE ${table} SET status='refunded'${refundedAtCol} WHERE id=?`).run(id);
    safeAudit(db, req.userId, 'admin_invoice_refund', { source, invoice_id: id, reason, stripe_refund_id: stripeRefundId, amount });
    res.json({ success: true, stripe_refund_id: stripeRefundId, source, invoice_id: id });
  } catch (e) {
    console.error('[admin-finance/refund]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 10. CANCEL ──────────────────────────────────────────────────────
router.post('/invoices/:source/:id/cancel', requireAuth, requireAdmin, (req, res) => {
  try {
    const { source, id } = req.params;
    const { reason } = req.body || {};
    if (!['user', 'agency', 'platform'].includes(source)) return res.status(400).json({ error: 'Invalid source' });

    const db = getDb(req);
    const tableMap = { user: 'invoices', agency: 'agency_invoices', platform: 'platform_charges' };
    const table    = tableMap[source];
    const inv = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status === 'paid')      return res.status(400).json({ error: 'Cannot cancel a paid invoice — refund instead' });
    if (inv.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });

    const cancelledAtCol = source === 'platform' ? ", cancelled_at = datetime('now')" : '';
    db.prepare(`UPDATE ${table} SET status='cancelled'${cancelledAtCol} WHERE id=?`).run(id);
    safeAudit(db, req.userId, 'admin_invoice_cancel', { source, invoice_id: id, reason });
    res.json({ success: true, source, invoice_id: id });
  } catch (e) {
    console.error('[admin-finance/cancel]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 11. WEBHOOK HANDLER ────────────────────────────────────────────
function handleStripeEvent(event) {
  try {
    if (!event || !event.type) return false;
    if (event.type !== 'checkout.session.completed') return false;
    const session = event.data?.object || {};
    const meta    = session.metadata || {};
    if (meta.type !== 'platform_charge' || !meta.platform_charge_id) return false;

    const db = require('../db/init').getDb();
    db.prepare(`UPDATE platform_charges
                SET status='paid', paid_at=datetime('now'), stripe_payment_intent_id=?
                WHERE id = ? AND status NOT IN ('paid','refunded')`)
      .run(session.payment_intent || null, meta.platform_charge_id);
    return true;
  } catch (e) {
    console.error('[admin-finance/webhook]', e.message);
    return false;
  }
}

module.exports = router;
module.exports.handleStripeEvent = handleStripeEvent;
