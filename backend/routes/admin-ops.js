// ═══════════════════════════════════════════════════════════════════
// MINE v49.1 — Admin Operations
// Mission-critical admin actions: refunds, dunning overrides, churn metrics
// Wired at /api/admin/ops
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { auth: requireAuth } = require('../middleware/auth');

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ─── REFUND AN ORDER ─────────────────────────────────────────────────
// POST /api/admin/ops/refund { orderId, amount?, reason? }
router.post('/refund', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { orderId, amount, reason } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    const db = req.app.locals.db;

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'refunded') return res.status(400).json({ error: 'Already refunded' });

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const refundAmount = amount ? Math.round(amount * 100) : undefined;

    let refund = null;
    if (order.stripe_session_id) {
      try {
        const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
        if (session.payment_intent) {
          refund = await stripe.refunds.create({
            payment_intent: session.payment_intent,
            amount: refundAmount,
            reason: reason || 'requested_by_customer'
          });
        }
      } catch (e) {
        // Stripe refund failed — still mark in DB but flag it
        console.error('Stripe refund failed:', e.message);
      }
    }

    db.prepare(`UPDATE orders SET status = 'refunded', notes = COALESCE(notes, '') || ? WHERE id = ?`)
      .run(`\n[REFUNDED by ${req.user.email} at ${new Date().toISOString()}] ${reason || ''}`, orderId);

    db.prepare(`INSERT INTO audit_log (user_id, action, details, created_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(req.user.id, 'refund_order', JSON.stringify({ orderId, amount, stripe_refund_id: refund?.id }));

    res.json({ success: true, refund_id: refund?.id, stripe_refunded: !!refund });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SUSPEND A USER (emergency) ──────────────────────────────────────
// POST /api/admin/ops/suspend { userId, reason }
router.post('/suspend', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, reason } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const db = req.app.locals.db;

    db.prepare(`UPDATE users SET account_status = 'suspended', role = 'banned' WHERE id = ?`).run(userId);
    // Revoke all sessions
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);

    db.prepare(`INSERT INTO audit_log (user_id, action, details, created_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(req.user.id, 'suspend_user', JSON.stringify({ target_user: userId, reason: reason || '' }));

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── UNSUSPEND A USER ────────────────────────────────────────────────
router.post('/unsuspend', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const db = req.app.locals.db;
    db.prepare(`UPDATE users SET account_status = 'active', role = 'user' WHERE id = ?`).run(userId);
    db.prepare(`INSERT INTO audit_log (user_id, action, details, created_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(req.user.id, 'unsuspend_user', JSON.stringify({ target_user: userId }));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── OVERRIDE A USER'S PLAN (manual) ─────────────────────────────────
// POST /api/admin/ops/set-plan { userId, plan }
router.post('/set-plan', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, plan } = req.body;
    const validPlans = ['starter', 'growth', 'pro', 'enterprise', 'agency', 'trial'];
    if (!validPlans.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    const db = req.app.locals.db;
    db.prepare(`UPDATE users SET plan = ? WHERE id = ?`).run(plan, userId);
    db.prepare(`INSERT INTO audit_log (user_id, action, details, created_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(req.user.id, 'set_plan', JSON.stringify({ target_user: userId, new_plan: plan }));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CHURN METRICS (for admin dashboard) ─────────────────────────────
router.get('/churn', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = req.app.locals.db;
    // Users cancelled in last 30/60/90 days
    const cancellations = db.prepare(`
      SELECT
        SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) as last_30,
        SUM(CASE WHEN created_at >= datetime('now','-60 days') THEN 1 ELSE 0 END) as last_60,
        SUM(CASE WHEN created_at >= datetime('now','-90 days') THEN 1 ELSE 0 END) as last_90
      FROM audit_log WHERE action = 'subscription_cancelled'
    `).get() || {};

    // Active paid users
    const activeUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE plan NOT IN ('trial','free') AND account_status = 'active'`).get();
    const totalActive = activeUsers?.count || 0;

    // Monthly churn rate
    const monthlyChurnRate = totalActive ? ((cancellations.last_30 || 0) / totalActive * 100).toFixed(2) : 0;

    // Users at risk (no activity in 30+ days)
    const atRisk = db.prepare(`
      SELECT COUNT(*) as count FROM users
      WHERE account_status = 'active' AND plan NOT IN ('trial','free')
      AND (last_login IS NULL OR last_login < datetime('now','-30 days'))
    `).get();

    res.json({
      cancellations,
      total_active: totalActive,
      monthly_churn_rate: parseFloat(monthlyChurnRate),
      at_risk: atRisk?.count || 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MRR + ARR DASHBOARD (for admin overview) ────────────────────────
router.get('/mrr', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = req.app.locals.db;
    // v50 prices — keep in sync with features.js PLAN_CAPS and landing pages
    const PLAN_PRICES = { starter: 79, growth: 129, pro: 199, enterprise: 399, agency: 799, agency_client: 0 };

    // Count users by plan
    const byPlan = db.prepare(`
      SELECT plan, COUNT(*) as count FROM users
      WHERE account_status = 'active' AND plan NOT IN ('trial','free')
      GROUP BY plan
    `).all();

    let mrr = 0;
    const breakdown = {};
    for (const row of byPlan) {
      const price = PLAN_PRICES[row.plan] || 0;
      mrr += price * row.count;
      breakdown[row.plan] = { count: row.count, mrr: price * row.count };
    }

    // Add AI Employee revenue (active addons)
    try {
      const addons = db.prepare(`SELECT COUNT(*) as count, SUM(price) as total FROM active_addons WHERE status='active'`).get();
      if (addons) mrr += addons.total || 0;
    } catch(e) { /* table may not exist yet */ }

    // Overage revenue (last 30 days). Column is `total`, not `total_charge`.
    let overage30d = 0;
    try {
      const ov = db.prepare(`SELECT SUM(total) as total FROM overage_charges WHERE created_at >= datetime('now','-30 days')`).get();
      overage30d = ov?.total || 0;
    } catch(e) {}

    res.json({
      mrr: Math.round(mrr),
      arr: Math.round(mrr * 12),
      breakdown,
      overage_revenue_30d: Math.round(overage30d),
      total_revenue_run_rate: Math.round((mrr + overage30d) * 12)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FORCE RECONCILE OVERAGES (admin override if cron missed) ────────
router.post('/reconcile-overages', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (typeof global.reconcileMonthlyOverages === 'function') {
      await global.reconcileMonthlyOverages();
      res.json({ success: true, message: 'Reconciliation triggered' });
    } else {
      res.status(500).json({ error: 'Reconciliation function not available' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RECOMPILE TAILWIND for all/one site(s) ──────────────────────────
// Strips the Tailwind CDN script from published sites and replaces with
// compiled static CSS. Use when the deploy-time backfill has more sites
// to process than fit in one boot window, or to force-refresh a specific
// site. POST { siteId?: "...", limit?: 50 } — omit siteId to process all
// live CDN-using sites up to `limit` (default 50).
router.post('/recompile-tailwind', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { siteId, limit = 50 } = req.body || {};
    const db = req.app.locals.db;
    const { compileTailwind, usesTailwindCdn } = require("../utils/tailwind-compile");

    let sites;
    if (siteId) {
      const s = db.prepare("SELECT id, html FROM sites WHERE id = ?").get(siteId);
      if (!s) return res.status(404).json({ error: "Site not found" });
      sites = [s];
    } else {
      sites = db.prepare(
        "SELECT id, html FROM sites WHERE status = 'live' AND html IS NOT NULL AND length(html) > 100 ORDER BY updated_at ASC LIMIT ?"
      ).all(Math.min(limit, 200));
    }

    let compiled = 0, skipped = 0, failed = 0;
    const failures = [];
    for (const site of sites) {
      if (!site.html || !usesTailwindCdn(site.html)) { skipped++; continue; }
      if (site.html.includes('data-tw-compiled="1"')) { skipped++; continue; }
      try {
        const result = await compileTailwind(site.html, { timeoutMs: 15000 });
        if (result && result.html && !result.skipped) {
          db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?")
            .run(result.html, site.id);
          compiled++;
        } else {
          skipped++;
        }
      } catch (e) {
        failed++;
        failures.push({ siteId: site.id, error: e.message });
      }
    }

    res.json({
      success: true,
      processed: sites.length,
      compiled,
      skipped,
      failed,
      failures: failures.slice(0, 10),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── TAILWIND BACKFILL STATUS — how many sites still need compiling ───
router.get('/tailwind-status', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = req.app.locals.db;
    const { usesTailwindCdn } = require("../utils/tailwind-compile");
    const sites = db.prepare(
      "SELECT id, html FROM sites WHERE status = 'live' AND html IS NOT NULL AND length(html) > 100"
    ).all();
    let needsCompile = 0, alreadyCompiled = 0, noTailwind = 0;
    for (const s of sites) {
      if (!s.html) continue;
      if (s.html.includes('data-tw-compiled="1"')) alreadyCompiled++;
      else if (usesTailwindCdn(s.html)) needsCompile++;
      else noTailwind++;
    }
    res.json({
      total_live_sites: sites.length,
      already_compiled: alreadyCompiled,
      needs_compile: needsCompile,
      no_tailwind: noTailwind,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
