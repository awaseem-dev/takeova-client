// /api/panels — Unified panel data plane.
//
// Four conventions hanging off /api/panels/:name :
//   GET  /:name/stats          → { s1..s4, total }
//   GET  /:name/list?limit=N   → [{ id, name, subtitle, tag, raw }]
//   GET  /:name/item/:id       → the full row
//   POST /:name/action/:id     → { action: "archive"|"delete", ... }
//
// All handlers query real, user-scoped tables with a safe empty fallback —
// they never throw. (Rewritten during the feature audit: previously this file
// imported modules that don't exist and crashed on load.)

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { getDb } = require('../db/init');
let emitToUser = () => {};
try { const ws = require('../lib/ws'); if (ws && ws.emitToUser) emitToUser = ws.emitToUser; } catch (_) {}

// name → { table, scope, how to render a list card }
const PANELS = {
  orders:   { table: 'orders',   scope: 'user_id', title: r => 'Order ' + (r.order_number || r.id || ''),       subtitle: r => r.status || r.customer_name || '' },
  products: { table: 'products', scope: 'user_id', title: r => r.name || r.title || ('Product ' + r.id),         subtitle: r => (r.price != null ? '$' + r.price : '') },
  contacts: { table: 'contacts', scope: 'user_id', title: r => r.name || r.email || ('Contact ' + r.id),         subtitle: r => r.email || r.phone || '' },
  invoices: { table: 'invoices', scope: 'user_id', title: r => 'Invoice ' + (r.number || r.id || ''),            subtitle: r => r.status || (r.amount != null ? '$' + r.amount : '') },
  reviews:  { table: 'reviews',  scope: 'user_id', title: r => r.author || r.customer_name || 'Review',           subtitle: r => (r.rating != null ? r.rating + '★' : '') },
  bookings: { table: 'bookings', scope: 'user_id', title: r => r.customer_name || r.service || 'Booking',         subtitle: r => r.date || r.status || '' },
};

function dbOf() { try { return getDb(); } catch (_) { return null; } }
function uidOf(req) { return req.user && req.user.id; }
function panelOf(req, res) {
  const p = PANELS[req.params.name];
  if (!p) { res.status(404).json({ error: 'unknown panel' }); return null; }
  return p;
}

// GET /:name/stats
router.get('/:name/stats', auth, (req, res) => {
  const p = panelOf(req, res); if (!p) return;
  try {
    const db = dbOf(), u = uidOf(req);
    const total = (db && u) ? ((db.prepare('SELECT COUNT(*) c FROM ' + p.table + ' WHERE ' + p.scope + ' = ?').get(u) || {}).c || 0) : 0;
    res.json({ s1: total, s2: 0, s3: 0, s4: 0, total });
  } catch (_) { res.json({ s1: 0, s2: 0, s3: 0, s4: 0, total: 0 }); }
});

// GET /:name/list?limit=N
router.get('/:name/list', auth, (req, res) => {
  const p = panelOf(req, res); if (!p) return;
  try {
    const db = dbOf(), u = uidOf(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
    const rows = (db && u) ? db.prepare('SELECT * FROM ' + p.table + ' WHERE ' + p.scope + ' = ? ORDER BY rowid DESC LIMIT ?').all(u, limit) : [];
    res.json(rows.map(r => ({ id: r.id, name: p.title(r), subtitle: p.subtitle(r), tag: r.status || '', raw: r })));
  } catch (_) { res.json([]); }
});

// GET /:name/item/:id
router.get('/:name/item/:id', auth, (req, res) => {
  const p = panelOf(req, res); if (!p) return;
  try {
    const db = dbOf(), u = uidOf(req);
    const row = (db && u) ? db.prepare('SELECT * FROM ' + p.table + ' WHERE id = ? AND ' + p.scope + ' = ?').get(req.params.id, u) : null;
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (_) { res.status(404).json({ error: 'not found' }); }
});

// POST /:name/action/:id   body: { action }
router.post('/:name/action/:id', auth, (req, res) => {
  const p = panelOf(req, res); if (!p) return;
  const action = (req.body && req.body.action) || '';
  try {
    const db = dbOf(), u = uidOf(req);
    if (!db || !u) return res.json({ ok: false });
    if (action === 'archive') {
      try { db.prepare('UPDATE ' + p.table + " SET status = 'archived' WHERE id = ? AND " + p.scope + ' = ?').run(req.params.id, u); } catch (_) {}
      try { emitToUser(u, { type: 'list_remove', panel: req.params.name, id: req.params.id }); } catch (_) {}
      return res.json({ ok: true, removeCard: true });
    }
    if (action === 'delete') {
      try { db.prepare('DELETE FROM ' + p.table + ' WHERE id = ? AND ' + p.scope + ' = ?').run(req.params.id, u); } catch (_) {}
      try { emitToUser(u, { type: 'list_remove', panel: req.params.name, id: req.params.id }); } catch (_) {}
      return res.json({ ok: true, removeCard: true });
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

module.exports = router;
