const express = require('express');
const router = express.Router();
const { getDb } = require('../db/init');
const { auth } = require('../middleware/auth');

function ensureTables(db) {
  // Students / Tutors
  db.exec(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, contact_id INTEGER,
    name TEXT, email TEXT, phone TEXT, parent_name TEXT, parent_phone TEXT,
    dob TEXT, subject TEXT, current_level TEXT, goal TEXT,
    lesson_day TEXT, lesson_time TEXT, lesson_duration_mins INTEGER DEFAULT 60,
    rate_per_lesson REAL, rate_per_term REAL, term_lessons INTEGER DEFAULT 10,
    active INTEGER DEFAULT 1, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, student_id INTEGER,
    date TEXT, time TEXT, duration_mins INTEGER DEFAULT 60,
    status TEXT DEFAULT 'scheduled', topic TEXT,
    homework TEXT, progress_notes TEXT, rating INTEGER,
    term_number TEXT, invoiced INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS student_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, student_id INTEGER,
    date TEXT, area TEXT, level_before TEXT, level_after TEXT,
    notes TEXT, next_focus TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Childcare
  db.exec(`CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT,
    name TEXT, dob TEXT, age_months INTEGER,
    parent1_name TEXT, parent1_phone TEXT, parent1_email TEXT,
    parent2_name TEXT, parent2_phone TEXT,
    emergency_contact TEXT, emergency_phone TEXT,
    medical_notes TEXT, allergies TEXT, medications TEXT,
    dietary TEXT, nap_schedule TEXT, room TEXT,
    enrollment_date TEXT, active INTEGER DEFAULT 1, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, child_id INTEGER,
    date TEXT, check_in TEXT, check_out TEXT,
    checked_in_by TEXT, checked_out_by TEXT,
    notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, child_id INTEGER,
    date TEXT, meals TEXT, naps TEXT, mood TEXT, activities TEXT,
    bowels TEXT, notes TEXT, sent_to_parent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Florists / Retail
  db.exec(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT,
    description TEXT, category TEXT, base_price REAL,
    active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, product_id INTEGER,
    name TEXT, size TEXT, colour TEXT, price REAL, sku TEXT,
    stock_qty INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, contact_id INTEGER,
    product_id INTEGER, variant_id INTEGER,
    recipient_name TEXT, recipient_address TEXT, recipient_phone TEXT,
    delivery_date TEXT, delivery_time TEXT,
    occasion TEXT, card_message TEXT,
    status TEXT DEFAULT 'pending', price REAL, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS occasion_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, contact_id INTEGER,
    occasion TEXT, date TEXT, send_reminder_days_before INTEGER DEFAULT 7,
    last_sent TEXT, active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

router.use((req, res, next) => {
  try { ensureTables(getDb()); } catch(e) {}
  next();
});

// ── STUDENTS / TUTORS ─────────────────────────────────────────────────────
router.get('/students', auth, (req, res) => {
  const rows = getDb().prepare("SELECT s.*, (SELECT COUNT(*) FROM lessons WHERE student_id=s.id) as total_lessons FROM students s WHERE s.user_id=? AND s.active=1 ORDER BY s.name").all(req.user.id);
  res.json(rows);
});
router.post('/students', auth, (req, res) => {
  const db = getDb();
  const { name, email, phone, parent_name, parent_phone, dob, subject, current_level, goal, lesson_day, lesson_time, lesson_duration_mins, rate_per_lesson, rate_per_term, term_lessons, notes } = req.body;
  const r = db.prepare("INSERT INTO students (user_id,name,email,phone,parent_name,parent_phone,dob,subject,current_level,goal,lesson_day,lesson_time,lesson_duration_mins,rate_per_lesson,rate_per_term,term_lessons,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(req.user.id, name, email, phone, parent_name, parent_phone, dob, subject, current_level, goal, lesson_day, lesson_time, lesson_duration_mins||60, rate_per_lesson, rate_per_term, term_lessons||10, notes);
  try {
    const ex = db.prepare("SELECT id FROM contacts WHERE user_id=? AND (email=? OR name=?)").get(req.user.id, email||'__', name);
    if (!ex) db.prepare("INSERT INTO contacts (user_id,name,email,phone,source,tags) VALUES (?,?,?,?,'students','student')").run(req.user.id, parent_name||name, email, parent_phone||phone);
  } catch(e) { console.error("[/students]", e.message || e); }
  res.json({ id: r.lastInsertRowid });
});
router.put('/students/:id', auth, (req, res) => {
  const { current_level, goal, rate_per_lesson, rate_per_term, notes, active } = req.body;
  getDb().prepare("UPDATE students SET current_level=COALESCE(?,current_level), goal=COALESCE(?,goal), rate_per_lesson=COALESCE(?,rate_per_lesson), rate_per_term=COALESCE(?,rate_per_term), notes=COALESCE(?,notes), active=COALESCE(?,active) WHERE id=? AND user_id=?").run(current_level, goal, rate_per_lesson, rate_per_term, notes, active!=null?active:null, req.params.id, req.user.id);
  res.json({ ok: true });
});

// Generate term schedule (weekly recurring lessons)
router.post('/students/:id/schedule-term', auth, (req, res) => {
  const db = getDb();
  const student = db.prepare("SELECT * FROM students WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!student) return res.status(404).json({ error: 'Not found' });
  const { start_date, num_lessons, term_number } = req.body;
  const n = num_lessons || student.term_lessons || 10;
  const created = [];
  let current = new Date(start_date);
  for (let i = 0; i < n; i++) {
    const dateStr = current.toISOString().split('T')[0];
    const r = db.prepare("INSERT INTO lessons (user_id,student_id,date,time,duration_mins,term_number) VALUES (?,?,?,?,?,?)").run(req.user.id, student.id, dateStr, student.lesson_time, student.lesson_duration_mins||60, term_number||'');
    created.push({ id: r.lastInsertRowid, date: dateStr });
    current.setDate(current.getDate() + 7);
  }
  res.json({ created, count: created.length });
});

// Lessons
router.get('/students/:id/lessons', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM lessons WHERE student_id=? AND user_id=? ORDER BY date DESC LIMIT 50").all(req.params.id, req.user.id);
  res.json(rows);
});
router.post('/students/:id/lessons', auth, (req, res) => {
  const { date, time, duration_mins, topic, term_number } = req.body;
  const r = getDb().prepare("INSERT INTO lessons (user_id,student_id,date,time,duration_mins,topic,term_number) VALUES (?,?,?,?,?,?,?)").run(req.user.id, req.params.id, date, time, duration_mins||60, topic, term_number);
  res.json({ id: r.lastInsertRowid });
});
router.put('/lessons/:id', auth, (req, res) => {
  const { status, topic, homework, progress_notes, rating } = req.body;
  getDb().prepare("UPDATE lessons SET status=COALESCE(?,status), topic=COALESCE(?,topic), homework=COALESCE(?,homework), progress_notes=COALESCE(?,progress_notes), rating=COALESCE(?,rating) WHERE id=? AND user_id=?").run(status, topic, homework, progress_notes, rating, req.params.id, req.user.id);
  res.json({ ok: true });
});
// Invoice a full term
router.post('/students/:id/invoice-term', auth, (req, res) => {
  const db = getDb();
  const student = db.prepare("SELECT * FROM students WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!student) return res.status(404).json({ error: 'Not found' });
  const { term_number } = req.body;
  const lessons = term_number
    ? db.prepare("SELECT * FROM lessons WHERE student_id=? AND user_id=? AND term_number=? AND invoiced=0").all(student.id, req.user.id, term_number)
    : db.prepare("SELECT * FROM lessons WHERE student_id=? AND user_id=? AND status='completed' AND invoiced=0").all(student.id, req.user.id);
  if (!lessons.length) return res.status(400).json({ error: 'No uninvoiced lessons found' });
  const total = student.rate_per_term || (lessons.length * (student.rate_per_lesson||0));
  const invoiceId = `INV-${Date.now()}`;
  const desc = `${student.subject||'Lessons'} — ${term_number||'Term'} (${lessons.length} lessons)`;
  try {
    db.prepare("INSERT INTO invoices (user_id,contact_name,contact_email,invoice_number,items,total,status,due_date) VALUES (?,?,?,?,?,?,'sent',date('now','+14 days'))").run(req.user.id, student.parent_name||student.name, student.email, invoiceId, JSON.stringify([{description:desc,qty:lessons.length,rate:student.rate_per_lesson||0,total}]), total);
    db.prepare(`UPDATE lessons SET invoiced=1 WHERE id IN (${lessons.map(()=>'?').join(',')})`).run(...lessons.map(l=>l.id));
  } catch(e) { console.error("[/:id/invoice-term]", e.message || e); }
  res.json({ invoice_id: invoiceId, lessons_invoiced: lessons.length, total });
});

// Student progress
router.get('/students/:id/progress', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM student_progress WHERE student_id=? AND user_id=? ORDER BY date DESC").all(req.params.id, req.user.id);
  res.json(rows);
});
router.post('/students/:id/progress', auth, (req, res) => {
  const { area, level_before, level_after, notes, next_focus } = req.body;
  const r = getDb().prepare("INSERT INTO student_progress (user_id,student_id,date,area,level_before,level_after,notes,next_focus) VALUES (?,?,date('now'),?,?,?,?,?)").run(req.user.id, req.params.id, area, level_before, level_after, notes, next_focus);
  res.json({ id: r.lastInsertRowid });
});
// Today's lessons
router.get('/lessons/today', auth, (req, res) => {
  const rows = getDb().prepare("SELECT l.*,s.name as student_name,s.subject,s.parent_name,s.parent_phone FROM lessons l JOIN students s ON l.student_id=s.id WHERE l.user_id=? AND l.date=date('now') ORDER BY l.time").all(req.user.id);
  res.json(rows);
});

// ── CHILDREN / CHILDCARE ────────────────────────────────────────────────────
router.get('/children', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM children WHERE user_id=? AND active=1 ORDER BY name").all(req.user.id);
  res.json(rows);
});
router.post('/children', auth, (req, res) => {
  const db = getDb();
  const { name, dob, parent1_name, parent1_phone, parent1_email, parent2_name, parent2_phone, emergency_contact, emergency_phone, medical_notes, allergies, medications, dietary, room, enrollment_date, notes } = req.body;
  const ageMs = dob ? Date.now()-new Date(dob).getTime() : 0;
  const age_months = Math.floor(ageMs/(30.44*86400000));
  const r = db.prepare("INSERT INTO children (user_id,name,dob,age_months,parent1_name,parent1_phone,parent1_email,parent2_name,parent2_phone,emergency_contact,emergency_phone,medical_notes,allergies,medications,dietary,room,enrollment_date,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(req.user.id, name, dob, age_months, parent1_name, parent1_phone, parent1_email, parent2_name, parent2_phone, emergency_contact, emergency_phone, medical_notes, allergies, medications, dietary, room, enrollment_date, notes);
  res.json({ id: r.lastInsertRowid });
});
router.put('/children/:id', auth, (req, res) => {
  const { room, medical_notes, allergies, notes, active } = req.body;
  getDb().prepare("UPDATE children SET room=COALESCE(?,room), medical_notes=COALESCE(?,medical_notes), allergies=COALESCE(?,allergies), notes=COALESCE(?,notes), active=COALESCE(?,active) WHERE id=? AND user_id=?").run(room, medical_notes, allergies, notes, active!=null?active:null, req.params.id, req.user.id);
  res.json({ ok: true });
});

// Attendance
router.get('/attendance', auth, (req, res) => {
  const { date } = req.query;
  const d = date || new Date().toISOString().split('T')[0];
  const rows = getDb().prepare("SELECT a.*,c.name,c.room,c.parent1_phone FROM attendance a JOIN children c ON a.child_id=c.id WHERE a.user_id=? AND a.date=? ORDER BY a.check_in").all(req.user.id, d);
  res.json(rows);
});
router.post('/attendance/checkin', auth, (req, res) => {
  const db = getDb();
  const { child_id, checked_in_by, notes } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const time = new Date().toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'});
  const ex = db.prepare("SELECT id FROM attendance WHERE child_id=? AND date=? AND user_id=?").get(child_id, today, req.user.id);
  if (ex) return res.status(409).json({ error: 'Already checked in today' });
  const r = db.prepare("INSERT INTO attendance (user_id,child_id,date,check_in,checked_in_by,notes) VALUES (?,?,?,?,?,?)").run(req.user.id, child_id, today, time, checked_in_by, notes);
  res.json({ id: r.lastInsertRowid, check_in: time });
});
router.post('/attendance/checkout', auth, (req, res) => {
  const db = getDb();
  const { child_id, checked_out_by } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const time = new Date().toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'});
  db.prepare("UPDATE attendance SET check_out=?, checked_out_by=? WHERE child_id=? AND date=? AND user_id=?").run(time, checked_out_by, child_id, today, req.user.id);
  res.json({ ok: true, check_out: time });
});
router.get('/attendance/summary', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as n FROM children WHERE user_id=? AND active=1").get(req.user.id).n;
  const in_today = db.prepare("SELECT COUNT(*) as n FROM attendance WHERE user_id=? AND date=? AND check_in IS NOT NULL AND check_out IS NULL").get(req.user.id, today).n;
  const checked_out = db.prepare("SELECT COUNT(*) as n FROM attendance WHERE user_id=? AND date=? AND check_out IS NOT NULL").get(req.user.id, today).n;
  res.json({ total_enrolled: total, currently_in: in_today, checked_out_today: checked_out, absent: total-in_today-checked_out });
});

// Daily reports
router.post('/children/:id/daily-report', auth, (req, res) => {
  const { meals, naps, mood, activities, bowels, notes } = req.body;
  const r = getDb().prepare("INSERT INTO daily_reports (user_id,child_id,date,meals,naps,mood,activities,bowels,notes) VALUES (?,?,date('now'),?,?,?,?,?,?)").run(req.user.id, req.params.id, meals, naps, mood, activities, bowels, notes);
  res.json({ id: r.lastInsertRowid });
});
router.get('/children/:id/daily-reports', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM daily_reports WHERE child_id=? AND user_id=? ORDER BY date DESC LIMIT 10").all(req.params.id, req.user.id);
  res.json(rows);
});

// ── PRODUCTS / FLORIST / RETAIL ──────────────────────────────────────────────
router.get('/products', auth, (req, res) => {
  const db = getDb();
  const prods = db.prepare("SELECT * FROM products WHERE user_id=? AND active=1 ORDER BY category,name").all(req.user.id);
  const variants = db.prepare("SELECT * FROM product_variants WHERE user_id=? AND active=1").all(req.user.id);
  const varsByProd = {};
  variants.forEach(v => { if (!varsByProd[v.product_id]) varsByProd[v.product_id]=[]; varsByProd[v.product_id].push(v); });
  res.json(prods.map(p => ({ ...p, variants: varsByProd[p.id]||[] })));
});
router.post('/products', auth, (req, res) => {
  const { name, description, category, base_price } = req.body;
  const r = getDb().prepare("INSERT INTO products (user_id,name,description,category,base_price) VALUES (?,?,?,?,?)").run(req.user.id, name, description, category, base_price);
  res.json({ id: r.lastInsertRowid });
});
router.post('/products/:id/variants', auth, (req, res) => {
  const { name, size, colour, price, sku, stock_qty } = req.body;
  const r = getDb().prepare("INSERT INTO product_variants (user_id,product_id,name,size,colour,price,sku,stock_qty) VALUES (?,?,?,?,?,?,?,?)").run(req.user.id, req.params.id, name, size, colour, price, sku, stock_qty||0);
  res.json({ id: r.lastInsertRowid });
});
router.put('/products/:id/variants/:vid', auth, (req, res) => {
  const { stock_qty, price } = req.body;
  getDb().prepare("UPDATE product_variants SET stock_qty=COALESCE(?,stock_qty), price=COALESCE(?,price) WHERE id=? AND user_id=?").run(stock_qty, price, req.params.vid, req.user.id);
  res.json({ ok: true });
});
router.delete('/products/:id', auth, (req, res) => {
  getDb().prepare("UPDATE products SET active=0 WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Deliveries
router.get('/deliveries', auth, (req, res) => {
  const db = getDb();
  const { date } = req.query;
  const rows = date
    ? db.prepare("SELECT d.*,p.name as product_name FROM deliveries d LEFT JOIN products p ON d.product_id=p.id WHERE d.user_id=? AND d.delivery_date=? ORDER BY d.delivery_time").all(req.user.id, date)
    : db.prepare("SELECT d.*,p.name as product_name FROM deliveries d LEFT JOIN products p ON d.product_id=p.id WHERE d.user_id=? AND d.delivery_date >= date('now') AND d.status != 'delivered' ORDER BY d.delivery_date,d.delivery_time LIMIT 50").all(req.user.id);
  res.json(rows);
});
router.post('/deliveries', auth, (req, res) => {
  const db = getDb();
  const { contact_id, product_id, variant_id, recipient_name, recipient_address, recipient_phone, delivery_date, delivery_time, occasion, card_message, price } = req.body;
  const r = db.prepare("INSERT INTO deliveries (user_id,contact_id,product_id,variant_id,recipient_name,recipient_address,recipient_phone,delivery_date,delivery_time,occasion,card_message,price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(req.user.id, contact_id, product_id, variant_id, recipient_name, recipient_address, recipient_phone, delivery_date, delivery_time, occasion, card_message, price);
  res.json({ id: r.lastInsertRowid });
});
router.put('/deliveries/:id', auth, (req, res) => {
  const { status, notes } = req.body;
  getDb().prepare("UPDATE deliveries SET status=COALESCE(?,status), notes=COALESCE(?,notes) WHERE id=? AND user_id=?").run(status, notes, req.params.id, req.user.id);
  res.json({ ok: true });
});

// Occasion reminders
router.get('/occasion-reminders', auth, (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT o.*,c.name as contact_name,c.email FROM occasion_reminders o JOIN contacts c ON o.contact_id=c.id WHERE o.user_id=? AND o.active=1 ORDER BY o.date").all(req.user.id);
  res.json(rows);
});
router.post('/occasion-reminders', auth, (req, res) => {
  const { contact_id, occasion, date, send_reminder_days_before } = req.body;
  const r = getDb().prepare("INSERT INTO occasion_reminders (user_id,contact_id,occasion,date,send_reminder_days_before) VALUES (?,?,?,?,?)").run(req.user.id, contact_id, occasion, date, send_reminder_days_before||7);
  res.json({ id: r.lastInsertRowid });
});
// Occasions coming up in next 30 days
router.get('/occasion-reminders/upcoming', auth, (req, res) => {
  const rows = getDb().prepare(`SELECT o.*,c.name as contact_name,c.email,c.phone FROM occasion_reminders o JOIN contacts c ON o.contact_id=c.id WHERE o.user_id=? AND o.active=1
    AND (strftime('%m-%d',o.date) BETWEEN strftime('%m-%d',date('now')) AND strftime('%m-%d',date('now','+30 days')))
    ORDER BY strftime('%m-%d',o.date)`).all(req.user.id);
  res.json(rows);
});

module.exports = router;
