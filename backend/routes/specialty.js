const express = require('express');
const router = express.Router();
const { getDb } = require('../db/init');
const { auth } = require('../middleware/auth');

// ── DB SETUP ────────────────────────────────────────────────────────────────
function ensureSpecialtyTables(db) {
  // Photography
  db.exec(`CREATE TABLE IF NOT EXISTS photo_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, description TEXT,
    price REAL, deposit_amount REAL, duration_hours REAL, deliverables TEXT,
    includes_raw INTEGER DEFAULT 0, turnaround_days INTEGER DEFAULT 14,
    active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS photo_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, package_id INTEGER,
    client_name TEXT, client_email TEXT, client_phone TEXT,
    shoot_date TEXT, shoot_time TEXT, location TEXT,
    status TEXT DEFAULT 'enquiry', deposit_paid INTEGER DEFAULT 0, deposit_amount REAL,
    total_amount REAL, contract_sent INTEGER DEFAULT 0, contract_signed INTEGER DEFAULT 0,
    contract_text TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS proof_galleries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, booking_id INTEGER,
    name TEXT, client_email TEXT, password TEXT,
    watermarked INTEGER DEFAULT 1, download_enabled INTEGER DEFAULT 0,
    expires_at TEXT, view_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS gallery_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, gallery_id INTEGER, user_id TEXT,
    filename TEXT, url TEXT, watermark_url TEXT, selected INTEGER DEFAULT 0,
    client_note TEXT, sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Vehicles / Auto Mechanic
  db.exec(`CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, contact_id INTEGER,
    rego TEXT, make TEXT, model TEXT, year INTEGER, colour TEXT,
    vin TEXT, odometer INTEGER, fuel_type TEXT,
    wof_due TEXT, rego_due TEXT, service_due_date TEXT, service_due_km INTEGER,
    notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS vehicle_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, vehicle_id INTEGER,
    service_type TEXT, description TEXT, odometer_at_service INTEGER,
    date TEXT, cost_labour REAL, cost_parts REAL,
    invoice_id TEXT, technician TEXT, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS parts_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT,
    part_number TEXT, name TEXT, description TEXT, brand TEXT,
    cost_price REAL, sell_price REAL, markup_percent REAL DEFAULT 40,
    stock_qty INTEGER DEFAULT 0, reorder_level INTEGER DEFAULT 2,
    location TEXT, supplier TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS job_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, job_id INTEGER,
    part_id INTEGER, part_name TEXT, part_number TEXT,
    qty INTEGER DEFAULT 1, cost_price REAL, sell_price REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Event Venues
  db.exec(`CREATE TABLE IF NOT EXISTS venue_spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT,
    capacity INTEGER, description TEXT, hourly_rate REAL, day_rate REAL,
    features TEXT, active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS venue_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, space_id INTEGER,
    event_name TEXT, event_type TEXT,
    client_name TEXT, client_email TEXT, client_phone TEXT,
    event_date TEXT, start_time TEXT, end_time TEXT,
    guest_count INTEGER, status TEXT DEFAULT 'enquiry',
    deposit_paid INTEGER DEFAULT 0, deposit_amount REAL, total_amount REAL,
    notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS venue_vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, venue_booking_id INTEGER,
    vendor_type TEXT, vendor_name TEXT, vendor_contact TEXT,
    confirmed INTEGER DEFAULT 0, amount REAL, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_of_day (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, venue_booking_id INTEGER,
    time TEXT, item TEXT, responsible_party TEXT, duration_mins INTEGER,
    sort_order INTEGER DEFAULT 0, done INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // IT Support / MSP
  db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, contact_id INTEGER,
    subject TEXT, description TEXT, priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'open', assigned_to TEXT,
    sla_hours INTEGER DEFAULT 4, sla_due TEXT, escalated INTEGER DEFAULT 0,
    retainer_id INTEGER, resolution TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS support_retainers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, contact_id INTEGER,
    name TEXT, hours_per_month REAL, price_per_month REAL,
    hours_used REAL DEFAULT 0, rollover INTEGER DEFAULT 0,
    billing_day INTEGER DEFAULT 1, active INTEGER DEFAULT 1,
    start_date TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ticket_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, user_id TEXT,
    note TEXT, time_spent_mins INTEGER DEFAULT 0, status_change TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

router.use((req, res, next) => {
  try { ensureSpecialtyTables(getDb()); } catch(e) {}
  next();
});

// ── PHOTO PACKAGES ──────────────────────────────────────────────────────────
router.get('/photo-packages', auth, (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM photo_packages WHERE user_id=? AND active=1 ORDER BY price").all(req.user.id);
  res.json(rows);
});
router.post('/photo-packages', auth, (req, res) => {
  const db = getDb();
  const { name, description, price, deposit_amount, duration_hours, deliverables, includes_raw, turnaround_days } = req.body;
  const r = db.prepare("INSERT INTO photo_packages (user_id,name,description,price,deposit_amount,duration_hours,deliverables,includes_raw,turnaround_days) VALUES (?,?,?,?,?,?,?,?,?)").run(req.user.id, name, description, price, deposit_amount, duration_hours, deliverables, includes_raw?1:0, turnaround_days||14);
  res.json({ id: r.lastInsertRowid });
});
router.delete('/photo-packages/:id', auth, (req, res) => {
  getDb().prepare("UPDATE photo_packages SET active=0 WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── PHOTO BOOKINGS ──────────────────────────────────────────────────────────
router.get('/photo-bookings', auth, (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT pb.*, pp.name as package_name FROM photo_bookings pb LEFT JOIN photo_packages pp ON pb.package_id=pp.id WHERE pb.user_id=? ORDER BY pb.shoot_date DESC").all(req.user.id);
  res.json(rows);
});
router.post('/photo-bookings', auth, (req, res) => {
  const db = getDb();
  const { package_id, client_name, client_email, client_phone, shoot_date, shoot_time, location, total_amount, deposit_amount, notes } = req.body;
  const r = db.prepare("INSERT INTO photo_bookings (user_id,package_id,client_name,client_email,client_phone,shoot_date,shoot_time,location,total_amount,deposit_amount,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(req.user.id, package_id, client_name, client_email, client_phone, shoot_date, shoot_time, location, total_amount, deposit_amount, notes);
  // Save to CRM
  try {
    const ex = db.prepare("SELECT id FROM contacts WHERE user_id=? AND email=?").get(req.user.id, client_email);
    if (!ex && client_email) db.prepare("INSERT INTO contacts (user_id,name,email,phone,source,tags) VALUES (?,?,?,?,'photo_booking','photography')").run(req.user.id, client_name, client_email, client_phone);
  } catch(e) { console.error("[/photo-bookings]", e.message || e); }
  res.json({ id: r.lastInsertRowid });
});
router.put('/photo-bookings/:id', auth, (req, res) => {
  const db = getDb();
  const { status, deposit_paid, contract_sent, contract_signed, notes } = req.body;
  db.prepare("UPDATE photo_bookings SET status=COALESCE(?,status), deposit_paid=COALESCE(?,deposit_paid), contract_sent=COALESCE(?,contract_sent), contract_signed=COALESCE(?,contract_signed), notes=COALESCE(?,notes) WHERE id=? AND user_id=?").run(status, deposit_paid!=null?deposit_paid:null, contract_sent!=null?contract_sent:null, contract_signed!=null?contract_signed:null, notes, req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── PROOF GALLERIES ──────────────────────────────────────────────────────────
router.get('/galleries', auth, (req, res) => {
  const db = getDb();
  const galleries = db.prepare("SELECT g.*, (SELECT COUNT(*) FROM gallery_photos WHERE gallery_id=g.id) as photo_count FROM proof_galleries g WHERE g.user_id=? ORDER BY g.created_at DESC").all(req.user.id);
  res.json(galleries);
});
router.post('/galleries', auth, (req, res) => {
  const db = getDb();
  const { booking_id, name, client_email, password, watermarked, download_enabled, expires_at } = req.body;
  const r = db.prepare("INSERT INTO proof_galleries (user_id,booking_id,name,client_email,password,watermarked,download_enabled,expires_at) VALUES (?,?,?,?,?,?,?,?)").run(req.user.id, booking_id, name, client_email, password, watermarked?1:0, download_enabled?1:0, expires_at);
  res.json({ id: r.lastInsertRowid });
});
router.get('/galleries/:id/photos', auth, (req, res) => {
  const db = getDb();
  const g = db.prepare("SELECT * FROM proof_galleries WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const photos = db.prepare("SELECT * FROM gallery_photos WHERE gallery_id=? ORDER BY sort_order,id").all(req.params.id);
  res.json({ gallery: g, photos });
});
router.post('/galleries/:id/photos', auth, (req, res) => {
  const db = getDb();
  const { url, watermark_url, filename } = req.body;
  const maxOrder = db.prepare("SELECT MAX(sort_order) as m FROM gallery_photos WHERE gallery_id=?").get(req.params.id);
  const r = db.prepare("INSERT INTO gallery_photos (gallery_id,user_id,url,watermark_url,filename,sort_order) VALUES (?,?,?,?,?,?)").run(req.params.id, req.user.id, url, watermark_url, filename, (maxOrder.m||0)+1);
  res.json({ id: r.lastInsertRowid });
});
router.put('/galleries/:id', auth, (req, res) => {
  const { download_enabled, name, expires_at } = req.body;
  getDb().prepare("UPDATE proof_galleries SET download_enabled=COALESCE(?,download_enabled), name=COALESCE(?,name), expires_at=COALESCE(?,expires_at) WHERE id=? AND user_id=?").run(download_enabled!=null?download_enabled:null, name, expires_at, req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── VEHICLES ────────────────────────────────────────────────────────────────
router.get('/vehicles', auth, (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT v.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone FROM vehicles v LEFT JOIN contacts c ON v.contact_id=c.id WHERE v.user_id=? ORDER BY v.created_at DESC").all(req.user.id);
  res.json(rows);
});
router.post('/vehicles', auth, (req, res) => {
  const db = getDb();
  const { contact_id, rego, make, model, year, colour, vin, odometer, fuel_type, wof_due, rego_due, service_due_date, service_due_km, notes } = req.body;
  const r = db.prepare("INSERT INTO vehicles (user_id,contact_id,rego,make,model,year,colour,vin,odometer,fuel_type,wof_due,rego_due,service_due_date,service_due_km,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(req.user.id, contact_id, rego, make, model, year, colour, vin, odometer, fuel_type, wof_due, rego_due, service_due_date, service_due_km, notes);
  res.json({ id: r.lastInsertRowid });
});
router.put('/vehicles/:id', auth, (req, res) => {
  const { odometer, wof_due, rego_due, service_due_date, service_due_km, notes } = req.body;
  getDb().prepare("UPDATE vehicles SET odometer=COALESCE(?,odometer), wof_due=COALESCE(?,wof_due), rego_due=COALESCE(?,rego_due), service_due_date=COALESCE(?,service_due_date), service_due_km=COALESCE(?,service_due_km), notes=COALESCE(?,notes) WHERE id=? AND user_id=?").run(odometer, wof_due, rego_due, service_due_date, service_due_km, notes, req.params.id, req.user.id);
  res.json({ ok: true });
});
router.get('/vehicles/due', auth, (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const in30 = new Date(Date.now()+30*864e5).toISOString().split('T')[0];
  const rows = db.prepare(`SELECT v.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone,
    CASE WHEN v.wof_due <= ? THEN 'wof' WHEN v.rego_due <= ? THEN 'rego' WHEN v.service_due_date <= ? THEN 'service' END as due_type
    FROM vehicles v LEFT JOIN contacts c ON v.contact_id=c.id
    WHERE v.user_id=? AND (v.wof_due <= ? OR v.rego_due <= ? OR v.service_due_date <= ?)
    ORDER BY COALESCE(v.wof_due,v.rego_due,v.service_due_date)
  `).all(in30, in30, in30, req.user.id, in30, in30, in30);
  res.json(rows);
});

// Vehicle service history
router.get('/vehicles/:id/history', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM vehicle_services WHERE vehicle_id=? AND user_id=? ORDER BY date DESC").all(req.params.id, req.user.id);
  res.json(rows);
});
router.post('/vehicles/:id/history', auth, (req, res) => {
  const db = getDb();
  const { service_type, description, odometer_at_service, date, cost_labour, cost_parts, technician, notes } = req.body;
  const r = db.prepare("INSERT INTO vehicle_services (user_id,vehicle_id,service_type,description,odometer_at_service,date,cost_labour,cost_parts,technician,notes) VALUES (?,?,?,?,?,?,?,?,?,?)").run(req.user.id, req.params.id, service_type, description, odometer_at_service, date, cost_labour, cost_parts, technician, notes);
  // Update last odometer on vehicle
  if (odometer_at_service) db.prepare("UPDATE vehicles SET odometer=? WHERE id=? AND user_id=?").run(odometer_at_service, req.params.id, req.user.id);
  res.json({ id: r.lastInsertRowid });
});

// Parts inventory
router.get('/parts', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM parts_inventory WHERE user_id=? ORDER BY name").all(req.user.id);
  res.json(rows);
});
router.post('/parts', auth, (req, res) => {
  const db = getDb();
  const { part_number, name, description, brand, cost_price, sell_price, markup_percent, stock_qty, reorder_level, location, supplier } = req.body;
  const sellP = sell_price || (cost_price * (1 + (markup_percent||40)/100));
  const r = db.prepare("INSERT INTO parts_inventory (user_id,part_number,name,description,brand,cost_price,sell_price,markup_percent,stock_qty,reorder_level,location,supplier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(req.user.id, part_number, name, description, brand, cost_price, sellP, markup_percent||40, stock_qty||0, reorder_level||2, location, supplier);
  res.json({ id: r.lastInsertRowid });
});
router.put('/parts/:id', auth, (req, res) => {
  const { stock_qty, sell_price, cost_price } = req.body;
  getDb().prepare("UPDATE parts_inventory SET stock_qty=COALESCE(?,stock_qty), sell_price=COALESCE(?,sell_price), cost_price=COALESCE(?,cost_price) WHERE id=? AND user_id=?").run(stock_qty, sell_price, cost_price, req.params.id, req.user.id);
  res.json({ ok: true });
});
router.get('/parts/low-stock', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM parts_inventory WHERE user_id=? AND stock_qty <= reorder_level ORDER BY stock_qty").all(req.user.id);
  res.json(rows);
});

// ── VENUE SPACES ─────────────────────────────────────────────────────────────
router.get('/venue-spaces', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM venue_spaces WHERE user_id=? AND active=1 ORDER BY name").all(req.user.id);
  res.json(rows);
});
router.post('/venue-spaces', auth, (req, res) => {
  const { name, capacity, description, hourly_rate, day_rate, features } = req.body;
  const r = getDb().prepare("INSERT INTO venue_spaces (user_id,name,capacity,description,hourly_rate,day_rate,features) VALUES (?,?,?,?,?,?,?)").run(req.user.id, name, capacity, description, hourly_rate, day_rate, features);
  res.json({ id: r.lastInsertRowid });
});

// Venue bookings
router.get('/venue-bookings', auth, (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT vb.*, vs.name as space_name FROM venue_bookings vb LEFT JOIN venue_spaces vs ON vb.space_id=vs.id WHERE vb.user_id=? ORDER BY vb.event_date DESC").all(req.user.id);
  res.json(rows);
});
router.post('/venue-bookings', auth, (req, res) => {
  const db = getDb();
  const { space_id, event_name, event_type, client_name, client_email, client_phone, event_date, start_time, end_time, guest_count, deposit_amount, total_amount, notes } = req.body;
  // Check for date conflicts on same space
  if (space_id && event_date) {
    const conflict = db.prepare("SELECT id FROM venue_bookings WHERE user_id=? AND space_id=? AND event_date=? AND status NOT IN ('cancelled')").get(req.user.id, space_id, event_date);
    if (conflict) return res.status(409).json({ error: 'Space already booked on that date' });
  }
  const r = db.prepare("INSERT INTO venue_bookings (user_id,space_id,event_name,event_type,client_name,client_email,client_phone,event_date,start_time,end_time,guest_count,deposit_amount,total_amount,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(req.user.id, space_id, event_name, event_type, client_name, client_email, client_phone, event_date, start_time, end_time, guest_count, deposit_amount, total_amount, notes);
  try {
    const ex = db.prepare("SELECT id FROM contacts WHERE user_id=? AND email=?").get(req.user.id, client_email);
    if (!ex && client_email) db.prepare("INSERT INTO contacts (user_id,name,email,phone,source,tags) VALUES (?,?,?,?,'venue','events')").run(req.user.id, client_name, client_email, client_phone);
  } catch(e) { console.error("[/venue-bookings]", e.message || e); }
  res.json({ id: r.lastInsertRowid });
});
router.put('/venue-bookings/:id', auth, (req, res) => {
  const { status, deposit_paid, total_amount, notes } = req.body;
  getDb().prepare("UPDATE venue_bookings SET status=COALESCE(?,status), deposit_paid=COALESCE(?,deposit_paid), total_amount=COALESCE(?,total_amount), notes=COALESCE(?,notes) WHERE id=? AND user_id=?").run(status, deposit_paid!=null?deposit_paid:null, total_amount, notes, req.params.id, req.user.id);
  res.json({ ok: true });
});
// Venue calendar (all bookings with date blocking view)
router.get('/venue-bookings/calendar', auth, (req, res) => {
  const { month, year } = req.query;
  const db = getDb();
  const rows = month && year
    ? db.prepare("SELECT vb.*,vs.name as space_name FROM venue_bookings vb LEFT JOIN venue_spaces vs ON vb.space_id=vs.id WHERE vb.user_id=? AND strftime('%m',vb.event_date)=? AND strftime('%Y',vb.event_date)=? ORDER BY vb.event_date").all(req.user.id, month.padStart(2,'0'), year)
    : db.prepare("SELECT vb.*,vs.name as space_name FROM venue_bookings vb LEFT JOIN venue_spaces vs ON vb.space_id=vs.id WHERE vb.user_id=? AND vb.event_date >= date('now') AND vb.status NOT IN ('cancelled') ORDER BY vb.event_date").all(req.user.id);
  res.json(rows);
});

// Vendors & run-of-day
router.get('/venue-bookings/:id/vendors', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM venue_vendors WHERE venue_booking_id=? AND user_id=? ORDER BY vendor_type").all(req.params.id, req.user.id);
  res.json(rows);
});
router.post('/venue-bookings/:id/vendors', auth, (req, res) => {
  const { vendor_type, vendor_name, vendor_contact, confirmed, amount, notes } = req.body;
  const r = getDb().prepare("INSERT INTO venue_vendors (user_id,venue_booking_id,vendor_type,vendor_name,vendor_contact,confirmed,amount,notes) VALUES (?,?,?,?,?,?,?,?)").run(req.user.id, req.params.id, vendor_type, vendor_name, vendor_contact, confirmed?1:0, amount, notes);
  res.json({ id: r.lastInsertRowid });
});
router.put('/venue-vendors/:id', auth, (req, res) => {
  const { confirmed, notes } = req.body;
  getDb().prepare("UPDATE venue_vendors SET confirmed=COALESCE(?,confirmed), notes=COALESCE(?,notes) WHERE id=? AND user_id=?").run(confirmed!=null?confirmed:null, notes, req.params.id, req.user.id);
  res.json({ ok: true });
});
router.get('/venue-bookings/:id/timeline', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM run_of_day WHERE venue_booking_id=? AND user_id=? ORDER BY sort_order,time").all(req.params.id, req.user.id);
  res.json(rows);
});
router.post('/venue-bookings/:id/timeline', auth, (req, res) => {
  const { time, item, responsible_party, duration_mins } = req.body;
  const db = getDb();
  const maxOrder = db.prepare("SELECT MAX(sort_order) as m FROM run_of_day WHERE venue_booking_id=?").get(req.params.id);
  const r = db.prepare("INSERT INTO run_of_day (user_id,venue_booking_id,time,item,responsible_party,duration_mins,sort_order) VALUES (?,?,?,?,?,?,?)").run(req.user.id, req.params.id, time, item, responsible_party, duration_mins, (maxOrder.m||0)+1);
  res.json({ id: r.lastInsertRowid });
});
router.put('/run-of-day/:id', auth, (req, res) => {
  const { done, time, item } = req.body;
  getDb().prepare("UPDATE run_of_day SET done=COALESCE(?,done), time=COALESCE(?,time), item=COALESCE(?,item) WHERE id=? AND user_id=?").run(done!=null?done:null, time, item, req.params.id, req.user.id);
  res.json({ ok: true });
});
router.delete('/run-of-day/:id', auth, (req, res) => {
  getDb().prepare("DELETE FROM run_of_day WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── IT SUPPORT / MSP ─────────────────────────────────────────────────────────
router.get('/tickets', auth, (req, res) => {
  const db = getDb();
  const { status, priority } = req.query;
  let q = "SELECT t.*, c.name as client_name, c.company FROM support_tickets t LEFT JOIN contacts c ON t.contact_id=c.id WHERE t.user_id=?";
  const args = [req.user.id];
  if (status) { q += " AND t.status=?"; args.push(status); }
  if (priority) { q += " AND t.priority=?"; args.push(priority); }
  q += " ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.created_at DESC";
  res.json(db.prepare(q).all(...args));
});
router.post('/tickets', auth, (req, res) => {
  const db = getDb();
  const { contact_id, subject, description, priority, sla_hours, retainer_id } = req.body;
  const slaH = sla_hours || (priority==='critical'?1:priority==='high'?4:priority==='low'?48:8);
  const slaDue = new Date(Date.now() + slaH*3600000).toISOString();
  const r = db.prepare("INSERT INTO support_tickets (user_id,contact_id,subject,description,priority,sla_hours,sla_due,retainer_id) VALUES (?,?,?,?,?,?,?,?)").run(req.user.id, contact_id, subject, description, priority||'medium', slaH, slaDue, retainer_id);
  res.json({ id: r.lastInsertRowid, sla_due: slaDue });
});
router.put('/tickets/:id', auth, (req, res) => {
  const { status, assigned_to, resolution, priority, escalated } = req.body;
  getDb().prepare("UPDATE support_tickets SET status=COALESCE(?,status), assigned_to=COALESCE(?,assigned_to), resolution=COALESCE(?,resolution), priority=COALESCE(?,priority), escalated=COALESCE(?,escalated), updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").run(status, assigned_to, resolution, priority, escalated!=null?escalated:null, req.params.id, req.user.id);
  res.json({ ok: true });
});
router.get('/tickets/:id/updates', auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM ticket_updates WHERE ticket_id=? AND user_id=? ORDER BY created_at DESC").all(req.params.id, req.userId);
  res.json(rows);
});
router.post('/tickets/:id/updates', auth, (req, res) => {
  const { note, time_spent_mins, status_change } = req.body;
  const db = getDb();
  const r = db.prepare("INSERT INTO ticket_updates (ticket_id,user_id,note,time_spent_mins,status_change) VALUES (?,?,?,?,?)").run(req.params.id, req.user.id, note, time_spent_mins||0, status_change);
  if (status_change) db.prepare("UPDATE support_tickets SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").run(status_change, req.params.id, req.user.id);
  res.json({ id: r.lastInsertRowid });
});
// SLA breach report
router.get('/tickets/sla-breach', auth, (req, res) => {
  const rows = getDb().prepare("SELECT t.*, c.name as client_name FROM support_tickets t LEFT JOIN contacts c ON t.contact_id=c.id WHERE t.user_id=? AND t.status NOT IN ('resolved','closed') AND t.sla_due < datetime('now') ORDER BY t.sla_due").all(req.user.id);
  res.json(rows);
});

// Retainers
router.get('/retainers', auth, (req, res) => {
  const rows = getDb().prepare("SELECT r.*, c.name as client_name, c.company FROM support_retainers r LEFT JOIN contacts c ON r.contact_id=c.id WHERE r.user_id=? ORDER BY r.name").all(req.user.id);
  res.json(rows);
});
router.post('/retainers', auth, (req, res) => {
  const { contact_id, name, hours_per_month, price_per_month, rollover, billing_day, start_date, notes } = req.body;
  const r = getDb().prepare("INSERT INTO support_retainers (user_id,contact_id,name,hours_per_month,price_per_month,rollover,billing_day,start_date,notes) VALUES (?,?,?,?,?,?,?,?,?)").run(req.user.id, contact_id, name, hours_per_month, price_per_month, rollover?1:0, billing_day||1, start_date, notes);
  res.json({ id: r.lastInsertRowid });
});
router.put('/retainers/:id', auth, (req, res) => {
  const { hours_used, active } = req.body;
  getDb().prepare("UPDATE support_retainers SET hours_used=COALESCE(?,hours_used), active=COALESCE(?,active) WHERE id=? AND user_id=?").run(hours_used, active!=null?active:null, req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
