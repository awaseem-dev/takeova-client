const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { getDb } = require('../db/init');
router.use(auth);
const userId = req => req.user?.id || req.user?.userId;
const mcEmail = async (to, subject, html, db, uid) => {
  try { const { sendEmail } = require('./email'); await sendEmail(to, subject, html); } catch(e) {}
};

// ── VEHICLE PARTS ────────────────────────────────────────────────────────────
router.get('/vehicles/:id/parts', auth, (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM vehicle_services WHERE id=? AND user_id=?').get(req.params.id, req.userId)) return res.status(404).json({ error: 'service not found' });
    const parts = db.prepare('SELECT * FROM vehicle_job_parts WHERE service_id=? ORDER BY id').all(req.params.id);
    res.json({ parts });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/vehicles/:id/parts', auth, (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM vehicle_services WHERE id=? AND user_id=?').get(req.params.id, req.userId)) return res.status(404).json({ error: 'service not found' });
    const { part_name, part_number, qty, unit_cost, supplier } = req.body;
    const r = db.prepare('INSERT INTO vehicle_job_parts (service_id, part_name, part_number, qty, unit_cost, supplier) VALUES (?,?,?,?,?,?)').run(req.params.id, part_name, part_number || '', qty || 1, unit_cost || 0, supplier || '');
    res.json({ success: true, id: r.lastInsertRowid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete('/vehicles/parts/:id', auth, (req, res) => {
  try {
    const db = getDb();
    // IDOR fix: a part is owned via its parent service (vehicle_job_parts.service_id -> vehicle_services.user_id).
    const part = db.prepare('SELECT service_id FROM vehicle_job_parts WHERE id = ?').get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Part not found' });
    if (!db.prepare('SELECT id FROM vehicle_services WHERE id=? AND user_id=?').get(part.service_id, req.userId)) return res.status(404).json({ error: 'Part not found' });
    db.prepare('DELETE FROM vehicle_job_parts WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get('/vehicles-due', (req, res) => {
  try {
    const db = getDb();
    const uid = userId(req);
    const today = new Date().toISOString().split('T')[0];
    // Vehicles with next_service_date overdue or within 14 days
    const due = db.prepare(`
      SELECT v.*, vs.next_service_date, vs.next_service_km, vs.service_type as last_service
      FROM vehicles v
      LEFT JOIN (
        SELECT vehicle_id, next_service_date, next_service_km, service_type,
               ROW_NUMBER() OVER (PARTITION BY vehicle_id ORDER BY id DESC) as rn
        FROM vehicle_services WHERE user_id=?
      ) vs ON vs.vehicle_id=v.id AND vs.rn=1
      WHERE v.user_id=? AND vs.next_service_date IS NOT NULL
        AND vs.next_service_date <= date('now','+14 days')
      ORDER BY vs.next_service_date
    `).all(uid, uid);
    res.json({ due });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── SLA RULES + TICKET SLA STATUS ────────────────────────────────────────────
router.get('/sla-rules', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const rules = db.prepare('SELECT * FROM sla_rules WHERE user_id=? ORDER BY priority').all(uid);
    res.json({ rules });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/sla-rules', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { name, priority, response_hours, resolution_hours } = req.body;
    const r = db.prepare('INSERT INTO sla_rules (user_id, name, priority, response_hours, resolution_hours) VALUES (?,?,?,?,?)').run(uid, name, priority || 'normal', response_hours || 4, resolution_hours || 24);
    res.json({ success: true, id: r.lastInsertRowid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── RETAINERS ─────────────────────────────────────────────────────────────────
router.get('/retainers', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const retainers = db.prepare(`
      SELECT r.*, c.name as client_name, c.email as client_email
      FROM retainers r LEFT JOIN contacts c ON c.id=r.contact_id
      WHERE r.user_id=? ORDER BY r.created_at DESC
    `).all(uid);
    res.json({ retainers });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/retainers', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { contact_id, name, monthly_fee, hours_included, start_date, notes } = req.body;
    const r = db.prepare('INSERT INTO retainers (user_id, contact_id, name, monthly_fee, hours_included, start_date, notes, status) VALUES (?,?,?,?,?,?,?,?)').run(uid, contact_id || null, name, monthly_fee || 0, hours_included || 0, start_date || new Date().toISOString().split('T')[0], notes || '', 'active');
    res.json({ success: true, id: r.lastInsertRowid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/retainers/:id/log-hours', (req, res) => {
  try {
    const db = getDb();
    const { hours, description, date } = req.body;
    db.prepare('INSERT INTO retainer_logs (retainer_id, hours, description, date) VALUES (?,?,?,?)').run(req.params.id, hours || 0, description || '', date || new Date().toISOString().split('T')[0]);
    // Update hours used
    const used = db.prepare('SELECT COALESCE(SUM(hours),0) as total FROM retainer_logs WHERE retainer_id=?').get(req.params.id);
    db.prepare('UPDATE retainers SET hours_used=? WHERE id=?').run(used.total, req.params.id);
    res.json({ success: true, hours_used: used.total });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── DOCUMENT CHECKLIST (Mortgage/Finance) ────────────────────────────────────
router.get('/doc-checklist/:contactId', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const docs = db.prepare('SELECT * FROM doc_checklist WHERE user_id=? AND contact_id=? ORDER BY id').all(uid, req.params.contactId);
    res.json({ docs });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/doc-checklist', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { contact_id, items } = req.body;
    // items is array of {name, required}
    const DEFAULT_DOCS = items || [
      { name: 'Government ID (passport/licence)', required: true },
      { name: 'Last 2 payslips', required: true },
      { name: '3 months bank statements', required: true },
      { name: 'Last 2 years tax returns', required: true },
      { name: 'Employment letter', required: false },
      { name: 'Property contract / purchase agreement', required: false },
      { name: 'Rates notice (existing property)', required: false },
      { name: 'Credit card / loan statements', required: false },
    ];
    const stmt = db.prepare('INSERT INTO doc_checklist (user_id, contact_id, doc_name, required, status) VALUES (?,?,?,?,?)');
    const ids = DEFAULT_DOCS.map(d => {
      const r = stmt.run(uid, contact_id, d.name, d.required ? 1 : 0, 'pending');
      return r.lastInsertRowid;
    });
    res.json({ success: true, count: ids.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put('/doc-checklist/:id', (req, res) => {
  try {
    const db = getDb();
    const { status, notes } = req.body;
    db.prepare('UPDATE doc_checklist SET status=?, notes=?, updated_at=datetime("now") WHERE id=?').run(status, notes || '', req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── REFERRALS ─────────────────────────────────────────────────────────────────
router.get('/referrals', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const refs = db.prepare(`
      SELECT r.*, c.name as referrer_name, c2.name as client_name
      FROM referrals r
      LEFT JOIN contacts c ON c.id=r.referrer_id
      LEFT JOIN contacts c2 ON c2.id=r.client_id
      WHERE r.user_id=? ORDER BY r.created_at DESC
    `).all(uid);
    res.json({ referrals: refs });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/referrals', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { referrer_id, client_id, source, deal_value, commission, notes } = req.body;
    const r = db.prepare('INSERT INTO referrals (user_id, referrer_id, client_id, source, deal_value, commission, notes, status) VALUES (?,?,?,?,?,?,?,?)').run(uid, referrer_id || null, client_id || null, source || '', deal_value || 0, commission || 0, notes || '', 'pending');
    res.json({ success: true, id: r.lastInsertRowid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put('/referrals/:id', (req, res) => {
  try {
    const db = getDb();
    const { status, commission_paid } = req.body;
    db.prepare('UPDATE referrals SET status=?, commission_paid=? WHERE id=?').run(status, commission_paid ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── STUDENT LESSONS (recurring per term) ─────────────────────────────────────
router.get('/students/:id/lessons', (req, res) => {
  try {
    const db = getDb();
    const lessons = db.prepare('SELECT * FROM student_lessons WHERE student_id=? ORDER BY lesson_date, lesson_time').all(req.params.id);
    res.json({ lessons });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/students/:id/lessons/generate', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { term_id, day_of_week, lesson_time, start_date, end_date } = req.body;
    // Generate weekly lessons between start_date and end_date on day_of_week
    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const targetDay = DAYS.indexOf(day_of_week);
    if (targetDay < 0) return res.status(400).json({ error: 'Invalid day_of_week' });
    const start = new Date(start_date);
    const end = new Date(end_date);
    let current = new Date(start);
    // Move to first occurrence of day_of_week
    while (current.getDay() !== targetDay) current.setDate(current.getDate() + 1);
    const stmt = db.prepare('INSERT INTO student_lessons (user_id, student_id, term_id, lesson_date, lesson_time, status) VALUES (?,?,?,?,?,?)');
    let count = 0;
    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      stmt.run(uid, req.params.id, term_id || null, dateStr, lesson_time || '09:00', 'scheduled');
      current.setDate(current.getDate() + 7);
      count++;
    }
    res.json({ success: true, lessons_created: count });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put('/student-lessons/:id', (req, res) => {
  try {
    const db = getDb();
    const { status, notes } = req.body;
    db.prepare('UPDATE student_lessons SET status=?, notes=? WHERE id=?').run(status, notes || '', req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── VENUE DATE BLOCKING ───────────────────────────────────────────────────────
router.get('/venue-availability', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });
    const existing = db.prepare("SELECT id, name, client_name, start_time, end_time, status FROM venue_events WHERE user_id=? AND event_date=? AND status NOT IN ('cancelled')").all(uid, date);
    const blocked = db.prepare("SELECT * FROM venue_blocked_dates WHERE user_id=? AND block_date=?").all(uid, date);
    res.json({ available: existing.length === 0 && blocked.length === 0, bookings: existing, blocked });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get('/venue-blocked', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const rows = db.prepare('SELECT * FROM venue_blocked_dates WHERE user_id=? ORDER BY block_date').all(uid);
    res.json({ blocked: rows });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/venue-blocked', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { block_date, reason } = req.body;
    const r = db.prepare('INSERT INTO venue_blocked_dates (user_id, block_date, reason) VALUES (?,?,?)').run(uid, block_date, reason || '');
    res.json({ success: true, id: r.lastInsertRowid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete('/venue-blocked/:id', (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM venue_blocked_dates WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PARENT MESSAGING (Childcare) ─────────────────────────────────────────────
router.post('/childcare-message', async (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { child_id, parent_email, subject, message } = req.body;
    await mcEmail(parent_email, subject || 'Update from childcare', `<p>${message}</p>`, db, uid);
    db.prepare('INSERT INTO childcare_messages (user_id, child_id, parent_email, subject, message) VALUES (?,?,?,?,?)').run(uid, child_id, parent_email, subject, message);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── FLORAL PRODUCTS / VARIANTS ────────────────────────────────────────────────
router.get('/floral-products', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const products = db.prepare('SELECT * FROM floral_products WHERE user_id=? ORDER BY name').all(uid);
    res.json({ products });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post('/floral-products', (req, res) => {
  try {
    const db = getDb(); const uid = userId(req);
    const { name, description, variants } = req.body;
    // variants: [{size, price, sku}]
    const r = db.prepare('INSERT INTO floral_products (user_id, name, description, variants) VALUES (?,?,?,?)').run(uid, name, description || '', JSON.stringify(variants || []));
    res.json({ success: true, id: r.lastInsertRowid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put('/floral-products/:id', (req, res) => {
  try {
    const db = getDb();
    const { name, description, variants } = req.body;
    db.prepare('UPDATE floral_products SET name=?, description=?, variants=? WHERE id=?').run(name, description || '', JSON.stringify(variants || []), req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete('/floral-products/:id', (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM floral_products WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
