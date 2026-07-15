// ═══════════════════════════════════════════════════════════════════
// MINE v49.1 — missing endpoint stubs
// Routes referenced by frontend buttons that didn't have backend handlers.
// These are minimal implementations — expand as features mature.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { auth: requireAuth } = require('../middleware/auth');

// ─── ACHIEVEMENTS ────────────────────────────────────────────────────
// User milestones: first site, first invoice, first customer, etc.
router.get('/achievements', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user.id;
    const achievements = db.prepare(`
      SELECT id, key, name, description, icon, claimed, claimed_at, points
      FROM user_achievements WHERE user_id = ?
      ORDER BY claimed_at DESC NULLS LAST, id ASC
    `).all(userId);
    // If table doesn't exist or empty, return default milestones
    if (!achievements.length) {
      return res.json({
        achievements: [
          { key: 'first_site', name: 'First Site Live', description: 'Publish your first site', icon: '🚀', claimed: false, points: 50 },
          { key: 'first_sale', name: 'First Sale', description: 'Make your first sale', icon: '💰', claimed: false, points: 100 },
          { key: 'first_invoice', name: 'First Invoice', description: 'Send your first invoice', icon: '🧾', claimed: false, points: 25 },
          { key: 'ten_customers', name: '10 Customers', description: 'Get your 10th customer', icon: '👥', claimed: false, points: 75 },
          { key: 'first_review', name: 'First Review', description: 'Receive your first 5-star review', icon: '⭐', claimed: false, points: 50 }
        ]
      });
    }
    res.json({ achievements });
  } catch (e) { console.error("[/achievements]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

router.post('/achievements/claim', requireAuth, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });
    const db = req.app.locals.db;
    db.prepare(`
      INSERT INTO user_achievements (user_id, key, claimed, claimed_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, key) DO UPDATE SET claimed=1, claimed_at=CURRENT_TIMESTAMP
    `).run(req.user.id, key);
    res.json({ success: true });
  } catch (e) { console.error("[/achievements/claim]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── AFFILIATES COMMISSIONS ──────────────────────────────────────────
router.get('/affiliates/commissions', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user.id;
    // Sum by status
    const rows = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END), 0) as paid,
             COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END), 0) as pending,
             COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END), 0) as approved,
             COUNT(*) as total_conversions
      FROM affiliate_conversions WHERE affiliate_user_id = ?
    `).get(userId) || {};
    const recent = db.prepare(`
      SELECT referred_email, amount, status, created_at FROM affiliate_conversions
      WHERE affiliate_user_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(userId);
    res.json({ summary: rows, recent });
  } catch (e) {
    // Tables may not exist on fresh DB
    res.json({ summary: { paid: 0, pending: 0, approved: 0, total_conversions: 0 }, recent: [] });
  }
});

router.post('/affiliates/pay-commissions', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    // Mark approved commissions as paid (admin-triggered action)
    if (req.user.role !== 'admin' && req.user.role !== 'agency') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = db.prepare(`
      UPDATE affiliate_conversions SET status='paid', paid_at=CURRENT_TIMESTAMP
      WHERE status='approved'
    `).run();
    res.json({ success: true, paid_count: result.changes });
  } catch (e) { console.error("[/affiliates/pay-commissions]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── AGENCY WHITE-LABEL CONFIG ───────────────────────────────────────
router.get('/agency/white-label', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (req.user.role !== 'agency' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Agency access required' });
    }
    const config = db.prepare(`SELECT white_label_config FROM users WHERE id = ?`).get(req.user.id);
    let parsed = {};
    try { parsed = JSON.parse(config?.white_label_config || '{}'); } catch(e) {}
    res.json({
      brand_name: parsed.brand_name || '',
      logo_url: parsed.logo_url || '',
      primary_color: parsed.primary_color || '#6366F1',
      custom_domain: parsed.custom_domain || '',
      support_email: parsed.support_email || '',
      hide_mine_branding: parsed.hide_mine_branding || false
    });
  } catch (e) { res.json({}); }
});

router.put('/agency/white-label', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'agency' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Agency access required' });
    }
    const db = req.app.locals.db;
    db.prepare(`UPDATE users SET white_label_config = ? WHERE id = ?`)
      .run(JSON.stringify(req.body), req.user.id);
    res.json({ success: true });
  } catch (e) { console.error("[/agency/white-label]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── MOBILE APP (PWA manifest + push subscriptions) ──────────────────
router.get('/mobile-app', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const pushSubs = db.prepare(`SELECT COUNT(*) as count FROM push_tokens WHERE user_id = ?`).get(req.user.id);
    res.json({
      downloads: pushSubs?.count || 0,
      rating: null, // populated when app is live on app stores
      monthly_active: 0,
      platforms: 'Web (PWA)'
    });
  } catch (e) { res.json({ downloads: 0, rating: null, monthly_active: 0, platforms: 'Web (PWA)' }); }
});

// ─── BRAND KIT ───────────────────────────────────────────────────────
router.get('/brand-kit', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const brand = db.prepare(`SELECT brand_kit FROM users WHERE id = ?`).get(req.user.id);
    let parsed = {};
    try { parsed = JSON.parse(brand?.brand_kit || '{}'); } catch(e) {}
    res.json({
      primary_color: parsed.primary_color || '#2563EB',
      secondary_color: parsed.secondary_color || '#1E40AF',
      font_family: parsed.font_family || 'Inter',
      logo_url: parsed.logo_url || '',
      tagline: parsed.tagline || ''
    });
  } catch (e) { res.json({}); }
});

router.put('/brand-kit', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    db.prepare(`UPDATE users SET brand_kit = ? WHERE id = ?`)
      .run(JSON.stringify(req.body), req.user.id);
    res.json({ success: true });
  } catch (e) { console.error("[/brand-kit]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

router.post('/brand/apply-all', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    // Apply brand kit to all user's sites
    const brand = db.prepare(`SELECT brand_kit FROM users WHERE id = ?`).get(req.user.id);
    const parsed = JSON.parse(brand?.brand_kit || '{}');
    const sites = db.prepare(`SELECT id, html FROM sites WHERE user_id = ?`).all(req.user.id);
    let updated = 0;
    for (const site of sites) {
      let html = site.html || '';
      if (parsed.primary_color) {
        html = html.replace(/#2563EB/gi, parsed.primary_color);
      }
      db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(html, site.id);
      updated++;
    }
    res.json({ success: true, updated });
  } catch (e) { console.error("[/brand/apply-all]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── CHANGELOG ───────────────────────────────────────────────────────
router.get('/changelog', async (req, res) => {
  // Public changelog — no auth needed
  res.json({
    entries: [
      { date: '2026-04-18', version: 'v49.1', items: ['New Site Editor with live preview', 'Pooled agency plan ($799)', 'Usage caps dashboard'] },
      { date: '2026-03-01', version: 'v48', items: ['AI Employees: 14 specialised agents', 'Stripe metered overage billing'] },
      { date: '2026-02-01', version: 'v47', items: ['Claude Sonnet 4.6 integration', 'Real-time chat widget'] }
    ]
  });
});

router.post('/changelog/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const db = req.app.locals.db;
    db.prepare(`INSERT OR IGNORE INTO changelog_subscribers (email, subscribed_at) VALUES (?, CURRENT_TIMESTAMP)`)
      .run(email);
    res.json({ success: true });
  } catch (e) { console.error("[/changelog/subscribe]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── ALERTS (system notifications) ───────────────────────────────────
router.get('/alerts', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const alerts = db.prepare(`
      SELECT id, type, message, severity, created_at, read
      FROM user_alerts WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).all(req.user.id);
    res.json({ alerts });
  } catch (e) { res.json({ alerts: [] }); }
});

// ─── SEARCH ──────────────────────────────────────────────────────────
router.get('/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });
    const db = req.app.locals.db;
    const results = [];
    // Search contacts, products, invoices
    const contacts = db.prepare(`SELECT id, name, email FROM contacts WHERE user_id = ? AND (name LIKE ? OR email LIKE ?) LIMIT 10`)
      .all(req.user.id, `%${q}%`, `%${q}%`);
    contacts.forEach(c => results.push({ type: 'contact', id: c.id, title: c.name || c.email, url: `/crm/${c.id}` }));
    const products = db.prepare(`SELECT id, name FROM products WHERE user_id = ? AND name LIKE ? LIMIT 10`).all(req.user.id, `%${q}%`);
    products.forEach(p => results.push({ type: 'product', id: p.id, title: p.name, url: `/products/${p.id}` }));
    res.json({ results });
  } catch (e) { res.json({ results: [] }); }
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────
// Used by load balancers, uptime monitoring, Docker healthcheck
router.get('/health', (req, res) => {
  const checks = { status: 'ok', version: 'v49.1', time: new Date().toISOString() };
  try {
    // DB check — if this fails, server is unhealthy
    const db = req.app.locals.db;
    const result = db.prepare('SELECT 1 as ok').get();
    checks.db = result?.ok === 1 ? 'ok' : 'error';
  } catch (e) {
    checks.db = 'error';
    checks.status = 'degraded';
  }
  // Optional dependency checks (don't fail healthcheck if these are degraded)
  checks.anthropic_configured = !!process.env.ANTHROPIC_API_KEY;
  checks.stripe_configured = !!process.env.STRIPE_SECRET_KEY;
  checks.email_configured = !!process.env.SENDGRID_API_KEY;
  const statusCode = checks.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(checks);
});

module.exports = router;
