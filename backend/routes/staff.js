/**
 * ══════════════════════════════════════════════════════════
 * MINE Staff Management & Staff-Specific Booking
 * ══════════════════════════════════════════════════════════
 *
 * Routes:
 *   GET    /api/staff                        — list staff
 *   POST   /api/staff                        — create staff member
 *   PUT    /api/staff/:id                    — update staff member
 *   DELETE /api/staff/:id                    — deactivate staff
 *   GET    /api/staff/:id/availability       — available slots for staff
 *   GET    /api/staff/:id/services           — services this staff can perform
 *   POST   /api/staff/:id/services           — assign service to staff
 *   DELETE /api/staff/:id/services/:sid      — remove service from staff
 *   GET    /api/staff/bookings               — all bookings with staff info
 *   POST   /api/staff/bookings               — create booking for specific staff
 *   GET    /api/staff/schedule               — week view across all staff
 */

"use strict";

const express  = require("express");
const router   = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");

// ── Ensure tables exist ───────────────────────────────────────────────────────
function ensureTables(db) {
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN staff_id TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN staff_name TEXT`);
  } catch(e) {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS staff_availability_overrides (
      id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT DEFAULT 'unavailable',
      start_time TEXT,
      end_time TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch(e) {}
}

// ── Parse working hours ───────────────────────────────────────────────────────
function getStaffSlots(staff, date, bookedSlots, serviceDuration) {
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = days[new Date(date).getDay()];
  let hours;
  try { hours = JSON.parse(staff.working_hours || '{}'); } catch(e) { hours = {}; }
  const range = hours[dayKey];
  if (!range || range === 'off') return [];

  const [openStr, closeStr] = range.split('-');
  const [oh, om] = openStr.split(':').map(Number);
  const [ch, cm] = closeStr.split(':').map(Number);
  const openMin  = oh * 60 + om;
  const closeMin = ch * 60 + cm;
  const duration = serviceDuration || 60;
  const buffer   = staff.buffer_minutes || 0;

  const slots = [];
  for (let m = openMin; m + duration <= closeMin; m += 30) {
    const h = String(Math.floor(m / 60)).padStart(2,'0');
    const min = String(m % 60).padStart(2,'0');
    const timeStr = `${h}:${min}`;

    // Check conflict with existing bookings
    const conflict = bookedSlots.some(b => {
      const [bh, bm] = (b.time || '00:00').split(':').map(Number);
      const bStart = bh * 60 + bm;
      const bEnd   = bStart + (b.duration || 60) + buffer;
      return m < bEnd && (m + duration + buffer) > bStart;
    });

    if (!conflict) slots.push(timeStr);
  }
  return slots;
}

// ── GET /api/staff ─────────────────────────────────────────────────────────────
router.get("/", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const staff = db.prepare(`
      SELECT sp.*,
        COUNT(DISTINCT ss.service_id) as service_count,
        COUNT(DISTINCT b.id) as booking_count
      FROM staff_profiles sp
      LEFT JOIN staff_services ss ON ss.staff_id = sp.id
      LEFT JOIN bookings b ON b.staff_id = sp.id AND b.status != 'cancelled'
        AND date(b.date) >= date('now')
      WHERE sp.user_id = ?
      GROUP BY sp.id
      ORDER BY sp.name ASC
    `).all(req.userId);
    res.json({ staff });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/staff ────────────────────────────────────────────────────────────
router.post("/", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { name, email, phone, role, bio, color, working_hours } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const id = uuid();
    const defaultHours = '{"mon":"09:00-17:00","tue":"09:00-17:00","wed":"09:00-17:00","thu":"09:00-17:00","fri":"09:00-17:00","sat":"off","sun":"off"}';
    db.prepare(`INSERT INTO staff_profiles (id, user_id, name, email, phone, role, bio, color, working_hours)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, req.userId, name, email||null, phone||null, role||null, bio||null, color||'#2563EB', working_hours || defaultHours);
    const staff = db.prepare("SELECT * FROM staff_profiles WHERE id = ?").get(id);
    res.json({ success: true, staff });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUT /api/staff/:id ─────────────────────────────────────────────────────────
router.put("/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const allowed = ['name','email','phone','role','bio','color','working_hours','active','avatar'];
    const fields = []; const vals = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k) && v !== undefined) {
        fields.push(`${k} = ?`); vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
      }
    }
    if (!fields.length) return res.json({ success: true });
    vals.push(req.params.id, req.userId);
    db.prepare(`UPDATE staff_profiles SET ${fields.join(',')} WHERE id = ? AND user_id = ?`).run(...vals);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── DELETE /api/staff/:id ──────────────────────────────────────────────────────
router.delete("/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE staff_profiles SET active = 0 WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GET /api/staff/:id/services ───────────────────────────────────────────────
router.get("/:id/services", auth, (req, res) => {
  try {
    const db = getDb();
    const services = db.prepare(`
      SELECT s.* FROM services s
      JOIN staff_services ss ON ss.service_id = s.id
      WHERE ss.staff_id = ? AND ss.user_id = ?
    `).all(req.params.id, req.userId);
    const all_services = db.prepare("SELECT * FROM services WHERE user_id = ? AND active = 1").all(req.userId);
    res.json({ services, all_services });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/staff/:id/services ──────────────────────────────────────────────
router.post("/:id/services", auth, (req, res) => {
  try {
    const db = getDb();
    const { service_id } = req.body;
    if (!service_id) return res.status(400).json({ error: "service_id required" });
    db.prepare("INSERT OR IGNORE INTO staff_services (id, staff_id, service_id, user_id) VALUES (?,?,?,?)")
      .run(uuid(), req.params.id, service_id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── DELETE /api/staff/:id/services/:sid ───────────────────────────────────────
router.delete("/:id/services/:sid", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM staff_services WHERE staff_id = ? AND service_id = ? AND user_id = ?")
      .run(req.params.id, req.params.sid, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GET /api/staff/:id/availability?date=&service_id= ─────────────────────────
router.get("/:id/availability", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { date, service_id } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });

    const staff = db.prepare("SELECT * FROM staff_profiles WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!staff) return res.status(404).json({ error: "Staff not found" });

    // Get service duration
    let duration = 60;
    if (service_id) {
      const svc = db.prepare("SELECT duration_minutes FROM services WHERE id = ?").get(service_id);
      if (svc) duration = svc.duration_minutes;
    }

    // Get existing bookings for this staff on this date
    const booked = db.prepare("SELECT time, duration FROM bookings WHERE staff_id = ? AND date = ? AND status != 'cancelled'")
      .all(req.params.id, date);

    // Check overrides (days off)
    const override = db.prepare("SELECT * FROM staff_availability_overrides WHERE staff_id = ? AND date = ? AND type = 'unavailable'")
      .get(req.params.id, date);
    if (override) return res.json({ available_slots: [], unavailable: true, reason: override.note });

    const slots = getStaffSlots(staff, date, booked, duration);
    res.json({ staff_id: req.params.id, staff_name: staff.name, date, duration, available_slots: slots });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GET /api/staff/bookings?date=&staff_id= ────────────────────────────────────
router.get("/bookings", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { date, staff_id, from, to } = req.query;
    let query = `
      SELECT b.*, sp.name as staff_name, sp.color as staff_color, s.name as service_name
      FROM bookings b
      LEFT JOIN staff_profiles sp ON sp.id = b.staff_id
      LEFT JOIN services s ON s.id = b.service_id
      WHERE b.user_id = ?
    `;
    const params = [req.userId];
    if (date)     { query += " AND b.date = ?"; params.push(date); }
    if (from)     { query += " AND b.date >= ?"; params.push(from); }
    if (to)       { query += " AND b.date <= ?"; params.push(to); }
    if (staff_id) { query += " AND b.staff_id = ?"; params.push(staff_id); }
    query += " ORDER BY b.date ASC, b.time ASC";
    const bookings = db.prepare(query).all(...params);
    res.json({ bookings });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/staff/bookings ───────────────────────────────────────────────────
router.post("/bookings", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { customer_name, customer_email, customer_phone, service_id, staff_id, date, time, notes } = req.body;
    if (!customer_name || !date || !time) return res.status(400).json({ error: "customer_name, date, time required" });

    // Validate staff exists and belongs to this user
    let staffRow = null;
    if (staff_id) {
      staffRow = db.prepare("SELECT * FROM staff_profiles WHERE id = ? AND user_id = ?").get(staff_id, req.userId);
      if (!staffRow) return res.status(400).json({ error: "Staff member not found" });
    }

    // Get service details
    let serviceRow = null; let duration = 60; let price = 0; let serviceName = req.body.service || '';
    if (service_id) {
      serviceRow = db.prepare("SELECT * FROM services WHERE id = ? AND user_id = ?").get(service_id, req.userId);
      if (serviceRow) { duration = serviceRow.duration_minutes; price = serviceRow.price; serviceName = serviceRow.name; }
    }

    // Conflict check for this staff member on this slot
    if (staff_id) {
      const [h, m] = time.split(':').map(Number);
      const startMin = h * 60 + m;
      const endMin = startMin + duration + (staffRow?.buffer_minutes || 0);
      const conflicts = db.prepare("SELECT id FROM bookings WHERE staff_id = ? AND date = ? AND status != 'cancelled'").all(staff_id, date);
      for (const c of conflicts) {
        const [ch, cm] = (c.time || '00:00').split(':').map(Number);
        const cStart = ch * 60 + cm;
        const cEnd = cStart + (c.duration || 60);
        if (startMin < cEnd && endMin > cStart) return res.status(409).json({ error: `${staffRow.name} is already booked at that time` });
      }
    }

    const id = uuid();
    db.prepare(`INSERT INTO bookings (id, user_id, service_id, service, staff_id, staff_name, customer_name, customer_email, customer_phone, date, time, duration, price, notes, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed')`).run(
        id, req.userId, service_id||null, serviceName, staff_id||null, staffRow?.name||null,
        customer_name, customer_email||null, customer_phone||null, date, time, duration, price, notes||null
    );

    // Email confirmation
    try {
      const { autoEmail } = require("./features");
      if (customer_email) {
        const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
        await autoEmail(req.userId, customer_email, `Booking confirmed${staffRow ? ` with ${staffRow.name}` : ''}`,
          `<h2>Booking Confirmed ✅</h2><p>Hi ${customer_name},</p>
          <p>Your appointment is confirmed:</p>
          <div style="background:#f7f8fa;padding:16px;border-radius:10px;margin:16px 0;font-size:14px;line-height:1.8">
            ${serviceName ? `<strong>Service:</strong> ${serviceName}<br>` : ''}
            ${staffRow ? `<strong>With:</strong> ${staffRow.name}<br>` : ''}
            <strong>Date:</strong> ${date}<br>
            <strong>Time:</strong> ${time}<br>
            ${price > 0 ? `<strong>Price:</strong> $${price}<br>` : ''}
          </div>
          <p style="color:#666;font-size:13px">Need to cancel or reschedule? Reply to this email.</p>`);
      }
    } catch(e) {}

    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    res.json({ success: true, booking });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GET /api/staff/schedule?from=&to= ─────────────────────────────────────────
router.get("/schedule", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const today = new Date().toISOString().split('T')[0];
    const from = req.query.from || today;
    const to   = req.query.to || new Date(Date.now() + 7*86400000).toISOString().split('T')[0];

    const staff = db.prepare("SELECT * FROM staff_profiles WHERE user_id = ? AND active = 1 ORDER BY name").all(req.userId);
    const bookings = db.prepare(`
      SELECT b.*, sp.name as staff_name, sp.color as staff_color, s.name as service_name
      FROM bookings b
      LEFT JOIN staff_profiles sp ON sp.id = b.staff_id
      LEFT JOIN services s ON s.id = b.service_id
      WHERE b.user_id = ? AND b.date >= ? AND b.date <= ? AND b.status != 'cancelled'
      ORDER BY b.date, b.time
    `).all(req.userId, from, to);

    // Group bookings by staff and date
    const schedule = {};
    for (const s of staff) {
      schedule[s.id] = { staff: s, bookings: bookings.filter(b => b.staff_id === s.id) };
    }
    // Unassigned bookings
    const unassigned = bookings.filter(b => !b.staff_id);

    res.json({ from, to, staff, schedule, unassigned });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/staff/:id/availability-override ──────────────────────────────────
router.post("/:id/availability-override", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { date, type, start_time, end_time, note } = req.body;
    if (!date) return res.status(400).json({ error: "date required" });
    db.prepare(`INSERT OR REPLACE INTO staff_availability_overrides (id, staff_id, user_id, date, type, start_time, end_time, note)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuid(), req.params.id, req.userId, date, type||'unavailable', start_time||null, end_time||null, note||null);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
