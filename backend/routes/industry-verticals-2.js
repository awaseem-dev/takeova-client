"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");

async function iv2Email(userId, to, subject, html) {
  try {
    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    if (!sgKey || !to) return false;
    const from = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
    const site = getDb().prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(userId);
    const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, name: site?.name || "MINE" }, subject, content: [{ type: "text/html", value: html }] })
    });
    // Previously returned true regardless of SendGrid's response — so a 400
    // (unverified sender, bad address, rate-limit) still looked successful.
    if (!resp.ok) {
      let errBody = "";
      try { errBody = (await resp.text()).slice(0, 300); } catch(_) {}
      console.error(`[iv2Email] SendGrid ${resp.status} for ${to}: ${errBody}`);
      return false;
    }
    return true;
  } catch(e) {
    console.error(`[iv2Email] ${e.message}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  PHOTOGRAPHY & VIDEOGRAPHY — Client Proof Galleries
// ════════════════════════════════════════════════════════════════════════════

router.get("/galleries", auth, (req, res) => {
  try {
    const db = getDb();
    const galleries = db.prepare(`SELECT g.*, c.name as client_name, c.email as client_email
      FROM client_proof_galleries g LEFT JOIN contacts c ON c.id=g.contact_id
      WHERE g.user_id=? ORDER BY g.created_at DESC`).all(req.userId);
    res.json({ galleries: galleries.map(g => ({ ...g, images: JSON.parse(g.images||"[]"), client_selections: JSON.parse(g.client_selections||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/galleries", auth, async (req, res) => {
  try {
    const db = getDb();
    const { contact_id, title, job_type, delivery_date, password, watermark_text, images, notes, expires_days } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });
    const id = uuid();
    const expires = expires_days ? new Date(Date.now() + expires_days*86400000).toISOString().split("T")[0] : null;
    db.prepare(`INSERT INTO client_proof_galleries (id,user_id,contact_id,title,job_type,delivery_date,password,watermark_text,images,notes,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id||null, title, job_type||"photography", delivery_date||null, password||null, watermark_text||"", JSON.stringify(images||[]), notes||"", expires);
    // Send gallery link to client
    if (contact_id) {
      const c = db.prepare("SELECT name,email FROM contacts WHERE id=?").get(contact_id);
      if (c?.email) {
        const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(req.userId);
        const baseUrl = getSetting("FRONTEND_URL") || process.env.FRONTEND_URL || "https://takeova.ai";
        await iv2Email(req.userId, c.email, `Your photos are ready — ${title}`,
          `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px">
          <h2>Your photos are ready! 📸</h2><p>Hi ${c.name||"there"},</p>
          <p>Your proof gallery for <strong>${title}</strong> is now available to view.</p>
          <p style="margin:20px 0"><a href="${baseUrl}/gallery/${id}${password ? '?key='+password : ''}" style="display:inline-block;padding:12px 24px;background:#2563EB;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">View Your Photos →</a></p>
          ${expires ? `<p style="color:#64748B;font-size:12px">Gallery expires ${expires}</p>` : ""}
          <p style="color:#64748B;font-size:12px">— ${site?.name||"Your photographer"}</p>
          </div>`);
      }
    }
    res.json({ success: true, id, gallery_url: `/gallery/${id}` });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/galleries/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, status, images, notes, download_url, watermark_text, password } = req.body;
    db.prepare("UPDATE client_proof_galleries SET title=?,status=?,images=?,notes=?,download_url=?,watermark_text=?,password=? WHERE id=? AND user_id=?")
      .run(title, status||"proofing", JSON.stringify(images||[]), notes, download_url||null, watermark_text||"", password||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Client selects images from gallery
router.post("/galleries/:id/select", (req, res) => {
  try {
    const db = getDb();
    const { key, selections } = req.body;
    const gallery = db.prepare("SELECT * FROM client_proof_galleries WHERE id=?").get(req.params.id);
    if (!gallery) return res.status(404).json({ error: "Gallery not found" });
    if (gallery.password && gallery.password !== key) return res.status(403).json({ error: "Invalid gallery password" });
    db.prepare("UPDATE client_proof_galleries SET client_selections=?,status='selections_made' WHERE id=?").run(JSON.stringify(selections||[]), req.params.id);
    // Notify photographer
    iv2Email(gallery.user_id, null, "Client made selections", `Client has selected ${(selections||[]).length} images from ${gallery.title}`).catch(()=>{});
    res.json({ success: true, selected: (selections||[]).length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Public gallery view
router.get("/gallery/:id", (req, res) => {
  try {
    const db = getDb();
    const gallery = db.prepare("SELECT * FROM client_proof_galleries WHERE id=?").get(req.params.id);
    if (!gallery) return res.status(404).json({ error: "Gallery not found" });
    if (gallery.expires_at && new Date(gallery.expires_at) < new Date()) return res.status(410).json({ error: "Gallery has expired" });
    // Password protection — require ?key= if gallery has a password
    if (gallery.password) {
      const provided = req.query.key || req.headers["x-gallery-key"];
      if (!provided) return res.json({ title: gallery.title, has_password: true, locked: true });
      if (provided !== gallery.password) return res.status(403).json({ error: "Incorrect gallery password" });
    }
    const images = JSON.parse(gallery.images||"[]");
    const selections = JSON.parse(gallery.client_selections||"[]");
    res.json({ title: gallery.title, job_type: gallery.job_type, images, selections, has_password: !!gallery.password, watermark: gallery.watermark_text });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  TUTORS / MUSIC TEACHERS / DRIVING INSTRUCTORS — Terms & Progress
// ════════════════════════════════════════════════════════════════════════════

router.get("/tutor/terms", auth, (req, res) => {
  try {
    const db = getDb();
    // Reuse coaching_sessions table grouped by contact for term-like view
    const contacts = db.prepare(`SELECT DISTINCT c.id,c.name,c.email,
      COUNT(sn.id) as total_sessions,
      SUM(sn.duration_minutes) as total_minutes
      FROM contacts c JOIN session_notes sn ON sn.contact_id=c.id
      WHERE c.user_id=? GROUP BY c.id ORDER BY c.name`).all(req.userId);
    res.json({ students: contacts });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/tutor/term-invoice", auth, async (req, res) => {
  try {
    const db = getDb();
    const { contact_id, term_name, lessons, price_per_lesson, due_date } = req.body;
    if (!contact_id || !lessons || !price_per_lesson) return res.status(400).json({ error: "contact_id, lessons, price_per_lesson required" });
    const contact = db.prepare("SELECT * FROM contacts WHERE id=? AND user_id=?").get(contact_id, req.userId);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const total = lessons * price_per_lesson;
    const invNum = `TERM-${Date.now().toString().slice(-6)}`;
    const dueDate = due_date || new Date(Date.now()+14*86400000).toISOString().split("T")[0];
    const invId = uuid();
    const items = [{ description: `${term_name||"Term lessons"} — ${lessons} lessons × $${price_per_lesson}`, amount: total }];
    db.prepare("INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,items_json,subtotal,tax,total,status,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(invId, req.userId, invNum, contact.name, contact.email||"", JSON.stringify(items), total, 0, total, "sent", dueDate);
    if (contact.email) {
      await iv2Email(req.userId, contact.email, `Term invoice — ${invNum}`,
        `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px"><h2>Term Invoice</h2><p>Hi ${contact.name},</p><p>${term_name||"Term"}: ${lessons} lessons × $${price_per_lesson} = <strong>$${total}</strong></p><p>Due: ${dueDate}</p></div>`);
    }
    res.json({ success: true, invoice_id: invId, invoice_number: invNum, total });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Student progress notes (builds on session_notes, adds structured progress)
router.get("/tutor/progress/:contactId", auth, (req, res) => {
  try {
    const db = getDb();
    const sessions = db.prepare("SELECT * FROM session_notes WHERE user_id=? AND contact_id=? ORDER BY session_date DESC").all(req.userId, req.params.contactId);
    const goals = db.prepare("SELECT * FROM client_goals WHERE user_id=? AND contact_id=? ORDER BY created_at DESC").all(req.userId, req.params.contactId);
    const totalHours = sessions.reduce((s,e) => s+(e.duration_minutes||60), 0) / 60;
    res.json({ sessions, goals, total_hours: Math.round(totalHours*10)/10, total_sessions: sessions.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  EVENT VENUES & WEDDING VENUES — Vendors & Timelines
// ════════════════════════════════════════════════════════════════════════════

router.get("/event-vendors/:eventId", auth, (req, res) => {
  try {
    const db = getDb();
    // event_vendors might not exist — ensure it
    db.exec(`CREATE TABLE IF NOT EXISTS event_vendors (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL,
      name TEXT NOT NULL, category TEXT DEFAULT 'other',
      contact_name TEXT, email TEXT, phone TEXT,
      quote REAL, deposit REAL DEFAULT 0, deposit_paid INTEGER DEFAULT 0,
      booked INTEGER DEFAULT 0, notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const vendors = db.prepare("SELECT * FROM event_vendors WHERE user_id=? AND event_id=? ORDER BY category,name").all(req.userId, req.params.eventId);
    res.json({ vendors });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/event-vendors", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS event_vendors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT DEFAULT 'other', contact_name TEXT, email TEXT, phone TEXT, quote REAL, deposit REAL DEFAULT 0, deposit_paid INTEGER DEFAULT 0, booked INTEGER DEFAULT 0, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const { event_id, name, category, contact_name, email, phone, quote, deposit, notes } = req.body;
    // No event_id => the frontend is creating an EVENT (VenueTab saveEvent), not a vendor.
    if (!event_id) {
      db.exec(`CREATE TABLE IF NOT EXISTS event_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, client_name TEXT, client_email TEXT, client_phone TEXT, event_type TEXT DEFAULT 'event', event_date TEXT, start_time TEXT, end_time TEXT, guest_count INTEGER, venue_space TEXT, total_value REAL DEFAULT 0, deposit_paid INTEGER DEFAULT 0, status TEXT DEFAULT 'enquiry', notes TEXT, created_at TEXT DEFAULT (datetime('now')))`);
      const b = req.body;
      if (!b.name && !b.client_name) return res.json({ success: false, error: "Event name required" });
      const eid = uuid();
      db.prepare("INSERT INTO event_profiles (id,user_id,name,client_name,client_email,client_phone,event_type,event_date,start_time,end_time,guest_count,venue_space,total_value,deposit_paid,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(eid, req.userId, b.name || ((b.client_name || "Client") + "'s event"), b.client_name||"", b.client_email||"", b.client_phone||"", b.event_type||"event", b.event_date||null, b.start_time||"", b.end_time||"", parseInt(b.guest_count)||0, b.venue_space||"", parseFloat(b.total_value)||0, b.deposit_paid?1:0, b.status||"enquiry", b.notes||"");
      return res.json({ success: true, id: eid });
    }
    if (!name) return res.status(400).json({ error: "name required" });
    const id = uuid();
    db.prepare("INSERT INTO event_vendors (id,user_id,event_id,name,category,contact_name,email,phone,quote,deposit,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, event_id, name, category||"other", contact_name||"", email||"", phone||"", quote||null, deposit||0, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/event-vendors/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, category, contact_name, email, phone, quote, deposit, deposit_paid, booked, notes } = req.body;
    db.prepare("UPDATE event_vendors SET name=?,category=?,contact_name=?,email=?,phone=?,quote=?,deposit=?,deposit_paid=?,booked=?,notes=? WHERE id=? AND user_id=?")
      .run(name, category, contact_name, email, phone, quote, deposit, deposit_paid?1:0, booked?1:0, notes, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Run-of-day timeline
router.get("/event-timeline/:eventId", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS event_timeline (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL, time TEXT NOT NULL, title TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30, location TEXT, responsible TEXT, notes TEXT, completed INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    const items = db.prepare("SELECT * FROM event_timeline WHERE user_id=? AND event_id=? ORDER BY time,sort_order").all(req.userId, req.params.eventId);
    res.json({ timeline: items });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/event-timeline", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS event_timeline (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL, time TEXT NOT NULL, title TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30, location TEXT, responsible TEXT, notes TEXT, completed INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    const { event_id, time, title, duration_minutes, location, responsible, notes } = req.body;
    if (!event_id || !time || !title) return res.status(400).json({ error: "event_id, time, title required" });
    const id = uuid();
    db.prepare("INSERT INTO event_timeline (id,user_id,event_id,time,title,duration_minutes,location,responsible,notes) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, event_id, time, title, duration_minutes||30, location||"", responsible||"", notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/event-timeline/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { time, title, duration_minutes, location, responsible, notes, completed } = req.body;
    db.prepare("UPDATE event_timeline SET time=?,title=?,duration_minutes=?,location=?,responsible=?,notes=?,completed=? WHERE id=? AND user_id=?")
      .run(time, title, duration_minutes, location, responsible, notes, completed?1:0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/event-timeline/:id", auth, (req, res) => {
  try { getDb().prepare("DELETE FROM event_timeline WHERE id=? AND user_id=?").run(req.params.id, req.userId); res.json({ success: true }); }
  catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  IT SUPPORT / MSPs — SLA & Retainers
// ════════════════════════════════════════════════════════════════════════════

router.get("/retainers", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS support_retainers (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      client_name TEXT NOT NULL, plan_name TEXT NOT NULL,
      hours_included REAL DEFAULT 10, hours_used REAL DEFAULT 0,
      price_per_month REAL DEFAULT 0, billing_day INTEGER DEFAULT 1,
      sla_response_hours INTEGER DEFAULT 4, sla_resolution_hours INTEGER DEFAULT 24,
      active INTEGER DEFAULT 1, auto_invoice INTEGER DEFAULT 1,
      start_date TEXT, notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const retainers = db.prepare(`SELECT r.*, c.name as contact_name, c.email as contact_email
      FROM support_retainers r LEFT JOIN contacts c ON c.id=r.contact_id
      WHERE r.user_id=? AND r.active=1 ORDER BY r.client_name`).all(req.userId);
    res.json({ retainers });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/retainers", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS support_retainers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, client_name TEXT NOT NULL, plan_name TEXT NOT NULL, hours_included REAL DEFAULT 10, hours_used REAL DEFAULT 0, price_per_month REAL DEFAULT 0, billing_day INTEGER DEFAULT 1, sla_response_hours INTEGER DEFAULT 4, sla_resolution_hours INTEGER DEFAULT 24, active INTEGER DEFAULT 1, auto_invoice INTEGER DEFAULT 1, start_date TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const { contact_id, client_name, plan_name, hours_included, price_per_month, billing_day, sla_response_hours, sla_resolution_hours, notes } = req.body;
    if (!client_name || !plan_name) return res.status(400).json({ error: "client_name and plan_name required" });
    const id = uuid();
    db.prepare("INSERT INTO support_retainers (id,user_id,contact_id,client_name,plan_name,hours_included,price_per_month,billing_day,sla_response_hours,sla_resolution_hours,notes,start_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, client_name, plan_name, hours_included||10, price_per_month||0, billing_day||1, sla_response_hours||4, sla_resolution_hours||24, notes||"", new Date().toISOString().split("T")[0]);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Log hours against retainer
router.post("/retainers/:id/log-hours", auth, (req, res) => {
  try {
    const db = getDb();
    const { hours, description } = req.body;
    if (!hours) return res.status(400).json({ error: "hours required" });
    const retainer = db.prepare("SELECT * FROM support_retainers WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!retainer) return res.status(404).json({ error: "Retainer not found" });
    const newUsed = (retainer.hours_used||0) + hours;
    db.prepare("UPDATE support_retainers SET hours_used=? WHERE id=?").run(newUsed, req.params.id);
    const remaining = retainer.hours_included - newUsed;
    return res.json({ success: true, hours_used: newUsed, hours_remaining: remaining, over_budget: remaining < 0, warning: remaining < 2 && remaining >= 0 ? `Only ${remaining.toFixed(1)} hours remaining this month` : null });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Ticket escalation
router.post("/tickets/:id/escalate", auth, async (req, res) => {
  try {
    const db = getDb();
    const ticket = db.prepare("SELECT * FROM support_tickets WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    db.prepare("UPDATE support_tickets SET priority='urgent', escalated_at=datetime('now'), status='escalated' WHERE id=?").run(req.params.id);
    // Email client
    if (ticket.customer_email) {
      await iv2Email(req.userId, ticket.customer_email, `Your ticket has been escalated — ${ticket.subject||"Support request"}`,
        `<p>Hi ${ticket.customer_name||"there"},</p><p>Your support ticket (<strong>${ticket.subject||ticket.id.slice(0,8)}</strong>) has been escalated to priority support. Our team will respond within the next hour.</p>`);
    }
    res.json({ success: true, message: "Ticket escalated to urgent priority. Client notified." });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  AUTO MECHANICS & GARAGES — Vehicles
// ════════════════════════════════════════════════════════════════════════════

router.get("/vehicles", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS vehicle_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, rego TEXT, make TEXT, model TEXT, year INTEGER, colour TEXT, vin TEXT, engine TEXT, fuel_type TEXT DEFAULT 'petrol', odometer INTEGER, notes TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`);
    const { contact_id } = req.query;
    let q = `SELECT v.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone FROM vehicle_profiles v LEFT JOIN contacts c ON c.id=v.contact_id WHERE v.user_id=? AND v.active=1`;
    const params = [req.userId];
    if (contact_id) { q += " AND v.contact_id=?"; params.push(contact_id); }
    q += " ORDER BY v.make, v.model";
    const vehicles = db.prepare(q).all(...params);
    res.json({ vehicles });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/vehicles", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS vehicle_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, rego TEXT, make TEXT, model TEXT, year INTEGER, colour TEXT, vin TEXT, engine TEXT, fuel_type TEXT DEFAULT 'petrol', odometer INTEGER, notes TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`);
    const { contact_id, rego, make, model, year, colour, vin, engine, fuel_type, odometer, notes } = req.body;
    if (!make && !rego) return res.status(400).json({ error: "make or rego required" });
    const id = uuid();
    db.prepare("INSERT INTO vehicle_profiles (id,user_id,contact_id,rego,make,model,year,colour,vin,engine,fuel_type,odometer,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, rego||"", make||"", model||"", year||null, colour||"", vin||"", engine||"", fuel_type||"petrol", odometer||null, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/vehicles/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { rego, make, model, year, colour, vin, engine, fuel_type, odometer, notes, active } = req.body;
    db.prepare("UPDATE vehicle_profiles SET rego=?,make=?,model=?,year=?,colour=?,vin=?,engine=?,fuel_type=?,odometer=?,notes=?,active=? WHERE id=? AND user_id=?")
      .run(rego, make, model, year, colour, vin, engine, fuel_type, odometer, notes, active===false?0:1, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Vehicle service history
router.get("/vehicles/:id/history", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS vehicle_services (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, vehicle_id TEXT NOT NULL, service_date TEXT, odometer INTEGER, service_type TEXT, description TEXT, parts_used TEXT DEFAULT '[]', labour_cost REAL DEFAULT 0, parts_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, next_service_date TEXT, next_service_km INTEGER, technician TEXT, invoice_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const history = db.prepare("SELECT * FROM vehicle_services WHERE user_id=? AND vehicle_id=? ORDER BY service_date DESC").all(req.userId, req.params.id);
    res.json({ history: history.map(h => ({ ...h, parts_used: JSON.parse(h.parts_used||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/vehicles/:id/service", auth, async (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS vehicle_services (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, vehicle_id TEXT NOT NULL, service_date TEXT, odometer INTEGER, service_type TEXT, description TEXT, parts_used TEXT DEFAULT '[]', labour_cost REAL DEFAULT 0, parts_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, next_service_date TEXT, next_service_km INTEGER, technician TEXT, invoice_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const { service_date, odometer, service_type, description, parts_used, labour_cost, parts_cost, next_service_date, next_service_km, technician, create_invoice } = req.body;
    const vehicle = db.prepare("SELECT v.*, c.name as owner_name, c.email as owner_email FROM vehicle_profiles v LEFT JOIN contacts c ON c.id=v.contact_id WHERE v.id=? AND v.user_id=?").get(req.params.id, req.userId);
    if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
    const total = (labour_cost||0) + (parts_cost||0);
    const serviceId = uuid();
    const today = service_date || new Date().toISOString().split("T")[0];
    db.prepare("INSERT INTO vehicle_services (id,user_id,vehicle_id,service_date,odometer,service_type,description,parts_used,labour_cost,parts_cost,total_cost,next_service_date,next_service_km,technician) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(serviceId, req.userId, req.params.id, today, odometer||null, service_type||"service", description||"", JSON.stringify(parts_used||[]), labour_cost||0, parts_cost||0, total, next_service_date||null, next_service_km||null, technician||"");
    // Update vehicle odometer
    if (odometer) try { db.prepare("UPDATE vehicle_profiles SET odometer=? WHERE id=?").run(odometer, req.params.id); } catch(e) { console.error("[/:id/service]", e.message || e); }
    // Create invoice if requested
    let invoiceId = null;
    if (create_invoice && total > 0) {
      const invNum = `VEH-${Date.now().toString().slice(-6)}`;
      const dueDate = new Date(Date.now()+7*86400000).toISOString().split("T")[0];
      const items = [
        ...(labour_cost > 0 ? [{ description: `Labour — ${service_type||"Service"} (${vehicle.make} ${vehicle.model} ${vehicle.rego||""})`, amount: labour_cost }] : []),
        ...(parts_used||[]).map(p => ({ description: p.name, amount: (p.qty||1)*(p.price||0) })),
        ...(parts_cost > 0 && !(parts_used||[]).length ? [{ description: "Parts & materials", amount: parts_cost }] : [])
      ].filter(i => i.amount > 0);
      invoiceId = uuid();
      db.prepare("INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,items_json,subtotal,tax,total,status,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(invoiceId, req.userId, invNum, vehicle.owner_name||"Customer", vehicle.owner_email||"", JSON.stringify(items), total, 0, total, "sent", dueDate);
      if (vehicle.owner_email) {
        await iv2Email(req.userId, vehicle.owner_email, `Service invoice — ${invNum}`,
          `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px"><h2>Service Invoice ${invNum}</h2><p>Hi ${vehicle.owner_name||"there"},</p><p>Your ${vehicle.make} ${vehicle.model} ${vehicle.rego ? "("+vehicle.rego+")" : ""} has been serviced.</p><p><strong>Total: $${total.toFixed(2)}</strong> — due ${dueDate}</p>${next_service_date ? `<p>Next service due: ${next_service_date}</p>` : ""}</div>`);
      }
    }
    res.json({ success: true, service_id: serviceId, invoice_id: invoiceId });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Vehicles due for service
router.get("/vehicles/due", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS vehicle_services (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, vehicle_id TEXT NOT NULL, service_date TEXT, odometer INTEGER, service_type TEXT, description TEXT, parts_used TEXT DEFAULT '[]', labour_cost REAL DEFAULT 0, parts_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, next_service_date TEXT, next_service_km INTEGER, technician TEXT, invoice_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const today = new Date().toISOString().split("T")[0];
    const due = db.prepare(`SELECT v.*, c.name as owner_name, c.phone as owner_phone,
      vs.next_service_date, vs.next_service_km
      FROM vehicle_profiles v
      LEFT JOIN contacts c ON c.id=v.contact_id
      LEFT JOIN vehicle_services vs ON vs.id=(SELECT id FROM vehicle_services WHERE vehicle_id=v.id ORDER BY service_date DESC LIMIT 1)
      WHERE v.user_id=? AND v.active=1 AND vs.next_service_date IS NOT NULL AND vs.next_service_date<=?
      ORDER BY vs.next_service_date ASC`).all(req.userId, today);
    res.json({ due, count: due.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  CHILDCARE / NURSERIES — Children & Attendance
// ════════════════════════════════════════════════════════════════════════════

router.get("/children", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS child_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, dob TEXT, medical_notes TEXT, allergies TEXT, emergency_contact TEXT, emergency_phone TEXT, room_group TEXT DEFAULT 'main', enrolment_days TEXT DEFAULT '[]', active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`);
    const children = db.prepare(`SELECT ch.*, c.name as parent_name, c.email as parent_email, c.phone as parent_phone FROM child_profiles ch LEFT JOIN contacts c ON c.id=ch.parent_id WHERE ch.user_id=? AND ch.active=1 ORDER BY ch.name`).all(req.userId);
    res.json({ children: children.map(c => ({ ...c, enrolment_days: JSON.parse(c.enrolment_days||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/children", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS child_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, dob TEXT, medical_notes TEXT, allergies TEXT, emergency_contact TEXT, emergency_phone TEXT, room_group TEXT DEFAULT 'main', enrolment_days TEXT DEFAULT '[]', active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`);
    const { parent_id, name, dob, medical_notes, allergies, emergency_contact, emergency_phone, room_group, enrolment_days } = req.body;
    if (!name) return res.status(400).json({ error: "Child name required" });
    const id = uuid();
    db.prepare("INSERT INTO child_profiles (id,user_id,parent_id,name,dob,medical_notes,allergies,emergency_contact,emergency_phone,room_group,enrolment_days) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, parent_id||null, name, dob||null, medical_notes||"", allergies||"", emergency_contact||"", emergency_phone||"", room_group||"main", JSON.stringify(enrolment_days||[]));
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/children/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, dob, medical_notes, allergies, emergency_contact, emergency_phone, room_group, enrolment_days, active } = req.body;
    db.prepare("UPDATE child_profiles SET name=?,dob=?,medical_notes=?,allergies=?,emergency_contact=?,emergency_phone=?,room_group=?,enrolment_days=?,active=? WHERE id=? AND user_id=?")
      .run(name, dob, medical_notes, allergies, emergency_contact, emergency_phone, room_group, JSON.stringify(enrolment_days||[]), active===false?0:1, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Attendance marking
router.post("/children/attendance", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS child_attendance (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, child_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT DEFAULT 'present', check_in_time TEXT, check_out_time TEXT, notes TEXT, UNIQUE(child_id,date))`);
    const { child_id, date, status, check_in_time, check_out_time, notes } = req.body;
    if (!child_id || !date) return res.status(400).json({ error: "child_id and date required" });
    const id = uuid();
    db.prepare("INSERT OR REPLACE INTO child_attendance (id,user_id,child_id,date,status,check_in_time,check_out_time,notes) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.userId, child_id, date, status||"present", check_in_time||null, check_out_time||null, notes||"");
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/children/attendance/:date", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS child_attendance (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, child_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT DEFAULT 'present', check_in_time TEXT, check_out_time TEXT, notes TEXT, UNIQUE(child_id,date))`);
    const children = db.prepare(`SELECT ch.id,ch.name,ch.room_group,ch.allergies,ch.medical_notes,
      ca.status,ca.check_in_time,ca.check_out_time
      FROM child_profiles ch
      LEFT JOIN child_attendance ca ON ca.child_id=ch.id AND ca.date=?
      WHERE ch.user_id=? AND ch.active=1 ORDER BY ch.room_group,ch.name`).all(req.params.date, req.userId);
    const present = children.filter(c => c.status === "present").length;
    const absent = children.filter(c => c.status === "absent").length;
    res.json({ date: req.params.date, children, present, absent, not_marked: children.length - present - absent });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  MORTGAGE BROKERS / FINANCIAL ADVISORS — Documents
// ════════════════════════════════════════════════════════════════════════════

router.get("/broker-docs/:contactId", auth, (req, res) => {
  try {
    const db = getDb();
    const docs = db.prepare("SELECT * FROM broker_documents WHERE user_id=? AND contact_id=? ORDER BY created_at DESC").all(req.userId, req.params.contactId);
    res.json({ documents: docs });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/broker-docs", auth, async (req, res) => {
  try {
    const db = getDb();
    const { contact_id, title, doc_type, notes, expires_at } = req.body;
    if (!contact_id || !title) return res.status(400).json({ error: "contact_id and title required" });
    const id = uuid();
    db.prepare("INSERT INTO broker_documents (id,user_id,contact_id,title,doc_type,notes,expires_at) VALUES (?,?,?,?,?,?,?)").run(id, req.userId, contact_id, title, doc_type||"general", notes||"", expires_at||null);
    // Send request to client
    const contact = db.prepare("SELECT name,email FROM contacts WHERE id=?").get(contact_id);
    if (contact?.email) {
      const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(req.userId);
      await iv2Email(req.userId, contact.email, `Document requested — ${title}`,
        `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px"><h2>Document Requested</h2><p>Hi ${contact.name||"there"},</p><p><strong>${site?.name||"Your advisor"}</strong> has requested the following document:</p><p style="background:#f8fafc;padding:14px;border-radius:8px"><strong>${title}</strong>${doc_type&&doc_type!=="general" ? ` (${doc_type})` : ""}${notes ? "<br>"+notes : ""}</p><p>Please reply to this email with the document attached, or upload it via your client portal.</p></div>`);
    }
    res.json({ success: true, id, email_sent: !!(contact?.email) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/broker-docs/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, file_url, file_name, notes, received_at } = req.body;
    db.prepare("UPDATE broker_documents SET status=?,file_url=?,file_name=?,notes=?,received_at=? WHERE id=? AND user_id=?")
      .run(status||"requested", file_url||null, file_name||null, notes||null, received_at||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Document checklist for a deal
router.get("/broker-docs/checklist/:contactId", auth, (req, res) => {
  try {
    const db = getDb();
    const docs = db.prepare("SELECT * FROM broker_documents WHERE user_id=? AND contact_id=? ORDER BY doc_type,created_at").all(req.userId, req.params.contactId);
    const received = docs.filter(d => d.status === "received" || d.file_url).length;
    const outstanding = docs.filter(d => !d.file_url && d.status !== "received").length;
    res.json({ documents: docs, received, outstanding, total: docs.length, complete: outstanding === 0 && docs.length > 0 });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  FLORISTS & GIFT SHOPS — Deliveries & Occasion Reminders
// ════════════════════════════════════════════════════════════════════════════

router.get("/deliveries", auth, (req, res) => {
  try {
    const db = getDb();
    const { from, status } = req.query;
    const today = new Date().toISOString().split("T")[0];
    let q = "SELECT * FROM delivery_schedules WHERE user_id=?";
    const params = [req.userId];
    if (from) { q += " AND delivery_date>=?"; params.push(from); }
    else { q += " AND delivery_date>=?"; params.push(today); }
    if (status) { q += " AND status=?"; params.push(status); }
    q += " ORDER BY delivery_date ASC, delivery_time ASC LIMIT 100";
    const deliveries = db.prepare(q).all(...params);
    res.json({ deliveries });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/deliveries", auth, (req, res) => {
  try {
    const db = getDb();
    const { order_id, contact_id, recipient_name, recipient_address, recipient_phone, delivery_date, delivery_time, occasion, card_message, driver_notes, price } = req.body;
    if (!delivery_date || !recipient_address) return res.status(400).json({ error: "delivery_date and recipient_address required" });
    const id = uuid();
    db.prepare("INSERT INTO delivery_schedules (id,user_id,order_id,contact_id,recipient_name,recipient_address,recipient_phone,delivery_date,delivery_time,occasion,card_message,driver_notes,price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, order_id||null, contact_id||null, recipient_name||"", recipient_address, recipient_phone||"", delivery_date, delivery_time||null, occasion||"", card_message||"", driver_notes||"", price||0);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/deliveries/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, delivery_time, driver_notes } = req.body;
    db.prepare("UPDATE delivery_schedules SET status=?,delivery_time=?,driver_notes=? WHERE id=? AND user_id=?").run(status||"scheduled", delivery_time||null, driver_notes||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Occasion reminders
router.get("/occasion-reminders", auth, (req, res) => {
  try {
    const db = getDb();
    const reminders = db.prepare(`SELECT o.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone FROM occasion_reminders o LEFT JOIN contacts c ON c.id=o.contact_id WHERE o.user_id=? ORDER BY substr(o.occasion_date,6)`).all(req.userId);
    // Flag upcoming (within next 30 days, comparing month-day only)
    const now = new Date();
    const upcoming = reminders.filter(r => {
      const [,mm,dd] = r.occasion_date.split("-");
      const thisYear = new Date(`${now.getFullYear()}-${mm}-${dd}`);
      if (thisYear < now) thisYear.setFullYear(now.getFullYear()+1);
      const days = Math.ceil((thisYear - now) / 86400000);
      return days <= 30 && days >= 0;
    });
    res.json({ reminders, upcoming, upcoming_count: upcoming.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/occasion-reminders", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, occasion_type, occasion_date, reminder_days, auto_sms, notes } = req.body;
    if (!contact_id || !occasion_date) return res.status(400).json({ error: "contact_id and occasion_date required" });
    const id = uuid();
    db.prepare("INSERT INTO occasion_reminders (id,user_id,contact_id,occasion_type,occasion_date,reminder_days,auto_sms,notes) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id, occasion_type||"birthday", occasion_date, reminder_days||14, auto_sms?1:0, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Reset retainer hours (new month)
router.put("/retainers/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { client_name, plan_name, hours_included, price_per_month, billing_day, sla_response_hours, sla_resolution_hours, hours_used, active, notes } = req.body;
    db.prepare("UPDATE support_retainers SET client_name=?,plan_name=?,hours_included=?,price_per_month=?,billing_day=?,sla_response_hours=?,sla_resolution_hours=?,hours_used=?,active=?,notes=? WHERE id=? AND user_id=?")
      .run(client_name, plan_name, hours_included, price_per_month, billing_day||1, sla_response_hours||4, sla_resolution_hours||24, hours_used||0, active===false?0:1, notes||"", req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Today's deliveries
router.get("/deliveries/today", auth, (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const deliveries = db.prepare("SELECT * FROM delivery_schedules WHERE user_id=? AND delivery_date=? AND status NOT IN ('delivered','cancelled') ORDER BY delivery_time").all(req.userId, today);
    res.json({ deliveries, count: deliveries.length, date: today });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;

// ── ALIASES & MISSING ENDPOINTS ──────────────────────────────────────────────

// Support tickets (proxied from existing tickets table)
router.get("/support-tickets", auth, (req, res) => {
  try {
    const db = getDb();
    const tickets = db.prepare("SELECT * FROM support_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.userId);
    res.json({ tickets });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/support-tickets", auth, (req, res) => {
  try {
    const db = getDb();
    const { subject, description, customer_name, customer_email, priority, status } = req.body;
    const id = uuid();
    db.prepare("INSERT INTO support_tickets (id,user_id,subject,description,customer_name,customer_email,priority,status) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.userId, subject||"", description||"", customer_name||"", customer_email||"", priority||"normal", status||"open");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/support-tickets/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { subject, status, priority, resolution } = req.body;
    db.prepare("UPDATE support_tickets SET subject=COALESCE(?,subject), status=COALESCE(?,status), priority=COALESCE(?,priority), resolution=COALESCE(?,resolution) WHERE id=? AND user_id=?")
      .run(subject||null, status||null, priority||null, resolution||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Upcoming occasions (alias — filtered occasion-reminders)
router.get("/upcoming-occasions", auth, (req, res) => {
  try {
    const db = getDb();
    const reminders = db.prepare("SELECT o.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone FROM occasion_reminders o LEFT JOIN contacts c ON c.id=o.contact_id WHERE o.user_id=? ORDER BY substr(o.occasion_date,6)").all(req.userId);
    const now = new Date();
    const upcoming = reminders.filter(r => {
      const [,mm,dd] = r.occasion_date.split("-");
      const thisYear = new Date(`${now.getFullYear()}-${mm}-${dd}`);
      if (thisYear < now) thisYear.setFullYear(now.getFullYear()+1);
      return Math.ceil((thisYear-now)/86400000) <= 30;
    });
    res.json({ reminders: upcoming, count: upcoming.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Shoots (photography sessions — alias for galleries)
router.get("/shoots", auth, (req, res) => {
  try {
    const db = getDb();
    const galleries = db.prepare("SELECT g.*, c.name as client_name FROM client_proof_galleries g LEFT JOIN contacts c ON c.id=g.contact_id WHERE g.user_id=? ORDER BY g.created_at DESC").all(req.userId);
    res.json({ shoots: galleries.map(g => ({ ...g, images: JSON.parse(g.images||"[]") })), galleries: galleries.map(g => ({ ...g, images: JSON.parse(g.images||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/shoots", auth, (req, res) => {
  const { title, contact_id, job_type, shoot_date, notes } = req.body;
  req.body = { ...req.body, delivery_date: shoot_date };
  // delegate to galleries logic
  try {
    const db = getDb();
    const id = uuid();
    db.prepare("INSERT INTO client_proof_galleries (id,user_id,contact_id,title,job_type,delivery_date,notes) VALUES (?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, title||"New Shoot", job_type||"photography", shoot_date||null, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/shoots/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, status, notes, delivery_date } = req.body;
    db.prepare("UPDATE client_proof_galleries SET title=COALESCE(?,title), status=COALESCE(?,status), notes=COALESCE(?,notes), delivery_date=COALESCE(?,delivery_date) WHERE id=? AND user_id=?")
      .run(title||null, status||null, notes||null, delivery_date||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// SLA configs (per retainer tier)
router.get("/sla-configs", auth, (req, res) => {
  try {
    const db = getDb();
    let retainers = [];
    try { retainers = db.prepare("SELECT id, client_name, plan_name, sla_response_hours, sla_resolution_hours FROM support_retainers WHERE user_id=? AND active=1").all(req.userId); } catch(e) {}
    res.json({ configs: retainers, sla_rules: retainers.map(r => ({ id: r.id, name: r.plan_name, response_hours: r.sla_response_hours, resolution_hours: r.sla_resolution_hours })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Delivery orders (alias for deliveries — some tabs call this name)
router.get("/delivery-orders", auth, (req, res) => {
  try {
    const db = getDb();
    const deliveries = db.prepare("SELECT * FROM delivery_schedules WHERE user_id=? ORDER BY delivery_date ASC, delivery_time ASC LIMIT 200").all(req.userId);
    res.json({ orders: deliveries, deliveries });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/delivery-orders", auth, (req, res) => {
  try {
    const db = getDb();
    const { recipient_name, recipient_address, delivery_date, delivery_time, occasion, card_message, price } = req.body;
    const id = uuid();
    db.prepare("INSERT INTO delivery_schedules (id,user_id,recipient_name,recipient_address,delivery_date,delivery_time,occasion,card_message,price) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, recipient_name||"", recipient_address||"", delivery_date||"", delivery_time||null, occasion||"", card_message||"", price||0);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/delivery-orders/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;
    db.prepare("UPDATE delivery_schedules SET status=? WHERE id=? AND user_id=?").run(status||"scheduled", req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE-GAP FIXES (audit 2026-06-10) — endpoints App.jsx calls that had no handler
// ════════════════════════════════════════════════════════════════════════════

// Events list for VenueTab (GET /event-vendors?from=YYYY-MM-DD)
router.get("/event-vendors", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS event_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, client_name TEXT, client_email TEXT, client_phone TEXT, event_type TEXT DEFAULT 'event', event_date TEXT, start_time TEXT, end_time TEXT, guest_count INTEGER, venue_space TEXT, total_value REAL DEFAULT 0, deposit_paid INTEGER DEFAULT 0, status TEXT DEFAULT 'enquiry', notes TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.exec(`CREATE TABLE IF NOT EXISTS event_vendors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT DEFAULT 'other', contact_name TEXT, email TEXT, phone TEXT, quote REAL, deposit REAL DEFAULT 0, deposit_paid INTEGER DEFAULT 0, booked INTEGER DEFAULT 0, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.exec(`CREATE TABLE IF NOT EXISTS event_timeline (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL, time TEXT NOT NULL, title TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30, location TEXT, responsible TEXT, notes TEXT, completed INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    const from = req.query.from;
    const rows = from
      ? db.prepare("SELECT * FROM event_profiles WHERE user_id=? AND (event_date IS NULL OR event_date>=?) ORDER BY event_date").all(req.userId, from)
      : db.prepare("SELECT * FROM event_profiles WHERE user_id=? ORDER BY event_date").all(req.userId);
    const vc = db.prepare("SELECT COUNT(*) c FROM event_vendors WHERE user_id=? AND event_id=?");
    const tc = db.prepare("SELECT COUNT(*) c FROM event_timeline WHERE user_id=? AND event_id=?");
    res.json({ events: rows.map(e => ({ ...e, vendor_count: vc.get(req.userId, e.id).c, timeline_count: tc.get(req.userId, e.id).c })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Add a vendor to an event (VenueTab addVendor — body has `amount`, stored as quote)
router.post("/event-vendors/:id/vendors", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS event_vendors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT DEFAULT 'other', contact_name TEXT, email TEXT, phone TEXT, quote REAL, deposit REAL DEFAULT 0, deposit_paid INTEGER DEFAULT 0, booked INTEGER DEFAULT 0, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const { name, category, contact_name, email, phone, amount, quote, notes } = req.body;
    if (!name) return res.json({ success: false, error: "Vendor name required" });
    const id = uuid();
    db.prepare("INSERT INTO event_vendors (id,user_id,event_id,name,category,contact_name,email,phone,quote,notes) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, req.params.id, name, category||"other", contact_name||"", email||"", phone||"", parseFloat(amount!==undefined?amount:quote)||null, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Add a run-of-day timeline item to an event (VenueTab addTimeline — {time,title,notes})
router.post("/event-vendors/:id/timeline", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS event_timeline (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL, time TEXT NOT NULL, title TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30, location TEXT, responsible TEXT, notes TEXT, completed INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    const { time, title, notes } = req.body;
    if (!time || !title) return res.json({ success: false, error: "time and title required" });
    const id = uuid();
    db.prepare("INSERT INTO event_timeline (id,user_id,event_id,time,title,notes) VALUES (?,?,?,?,?,?)")
      .run(id, req.userId, req.params.id, time, title, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Email the gallery link to the client (PhotographyTab share)
router.post("/galleries/:id/share", auth, async (req, res) => {
  try {
    const db = getDb();
    const g = db.prepare("SELECT * FROM client_proof_galleries WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!g) return res.json({ success: false, error: "Gallery not found" });
    const c = g.contact_id ? db.prepare("SELECT name,email FROM contacts WHERE id=?").get(g.contact_id) : null;
    if (!c || !c.email) return res.json({ success: false, error: "No client email on this gallery" });
    const baseUrl = getSetting("FRONTEND_URL") || process.env.FRONTEND_URL || "https://takeova.ai";
    const sent = await iv2Email(req.userId, c.email, `Your photos are ready — ${g.title}`,
      `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px"><h2>Your photos are ready! 📸</h2><p>Hi ${c.name||"there"},</p><p>Your gallery <strong>${g.title}</strong> is ready to view.</p><p style="margin:20px 0"><a href="${baseUrl}/gallery/${g.id}${g.password ? "?key="+g.password : ""}" style="display:inline-block;padding:12px 24px;background:#2563EB;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">View Your Photos →</a></p></div>`);
    db.prepare("UPDATE client_proof_galleries SET status='shared' WHERE id=? AND user_id=?").run(g.id, req.userId);
    res.json({ success: true, sent });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Append an image to a gallery (PhotographyTab addPhoto — {url, watermarked_url})
router.post("/galleries/:id/images", auth, (req, res) => {
  try {
    const db = getDb();
    const g = db.prepare("SELECT * FROM client_proof_galleries WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!g) return res.json({ success: false, error: "Gallery not found" });
    const { url, watermarked_url } = req.body;
    if (!url) return res.json({ success: false, error: "Image url required" });
    const images = JSON.parse(g.images || "[]");
    images.push({ url, watermarked_url: watermarked_url || url, added_at: new Date().toISOString() });
    db.prepare("UPDATE client_proof_galleries SET images=? WHERE id=? AND user_id=?").run(JSON.stringify(images), g.id, req.userId);
    res.json({ success: true, image_count: images.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Gallery for a shoot (shoots ARE client_proof_galleries rows)
router.get("/shoots/:id/gallery", auth, (req, res) => {
  try {
    const db = getDb();
    const g = db.prepare("SELECT g.*, c.name as client_name, c.email as client_email FROM client_proof_galleries g LEFT JOIN contacts c ON c.id=g.contact_id WHERE g.id=? AND g.user_id=?").get(req.params.id, req.userId);
    if (!g) return res.json({ galleries: [] });
    res.json({ galleries: [{ ...g, images: JSON.parse(g.images||"[]"), client_selections: JSON.parse(g.client_selections||"[]") }] });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Create/replace the proof gallery for a shoot + email the client ({title,images,watermark,expires_days})
router.post("/shoots/:id/gallery", auth, async (req, res) => {
  try {
    const db = getDb();
    const g = db.prepare("SELECT * FROM client_proof_galleries WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!g) return res.json({ success: false, error: "Shoot not found" });
    const { title, images, watermark, expires_days } = req.body;
    const expires = expires_days ? new Date(Date.now() + expires_days*86400000).toISOString().split("T")[0] : null;
    const imgs = (images || []).map(u => typeof u === "string" ? { url: u, watermarked_url: u } : u);
    db.prepare("UPDATE client_proof_galleries SET title=COALESCE(?,title), images=?, watermark_text=?, expires_at=?, status='proofing' WHERE id=? AND user_id=?")
      .run(title||null, JSON.stringify(imgs), watermark ? "PROOF" : "", expires, g.id, req.userId);
    let sent = false;
    if (g.contact_id) {
      const c = db.prepare("SELECT name,email FROM contacts WHERE id=?").get(g.contact_id);
      if (c && c.email) {
        const baseUrl = getSetting("FRONTEND_URL") || process.env.FRONTEND_URL || "https://takeova.ai";
        sent = await iv2Email(req.userId, c.email, `Your photos are ready — ${title||g.title}`,
          `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px"><h2>Your photos are ready! 📸</h2><p>Hi ${c.name||"there"},</p><p>Your proof gallery <strong>${title||g.title}</strong> is ready (${imgs.length} photos).</p><p style="margin:20px 0"><a href="${baseUrl}/gallery/${g.id}" style="display:inline-block;padding:12px 24px;background:#2563EB;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">View Your Photos →</a></p>${expires ? `<p style="color:#64748B;font-size:12px">Gallery expires ${expires}</p>` : ""}</div>`);
      }
    }
    res.json({ success: true, sent, image_count: imgs.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Message a child's parent (ChildcareTab — {message})
router.post("/children/:id/message", auth, async (req, res) => {
  try {
    const db = getDb();
    const child = db.prepare("SELECT ch.*, c.name as parent_name, c.email as parent_email FROM child_profiles ch LEFT JOIN contacts c ON c.id=ch.parent_id WHERE ch.id=? AND ch.user_id=?").get(req.params.id, req.userId);
    if (!child) return res.json({ success: false, error: "Child not found" });
    const { message } = req.body;
    if (!message) return res.json({ success: false, error: "Message required" });
    if (!child.parent_email) return res.json({ success: false, error: "No parent email on file" });
    const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(req.userId);
    const sent = await iv2Email(req.userId, child.parent_email, `Update about ${child.name}`,
      `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px"><p>Hi ${child.parent_name||"there"},</p><p>${String(message).replace(/</g,"&lt;")}</p><p style="color:#64748B;font-size:12px">— ${site?.name||"Your childcare team"}</p></div>`);
    res.json({ success: true, sent });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// StudentsTab: POST /tutor/terms creates a STUDENT (no student_id) or a TERM (with student_id)
router.post("/tutor/terms", auth, (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    if (b.student_id) {
      db.exec(`CREATE TABLE IF NOT EXISTS tutor_terms (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, term_name TEXT, start_date TEXT, end_date TEXT, lessons_per_week INTEGER DEFAULT 1, lesson_duration INTEGER DEFAULT 60, rate_per_lesson REAL DEFAULT 0, total_lessons INTEGER DEFAULT 0, total_price REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
      const lpw = parseInt(b.lessons_per_week) || 1;
      const rate = parseFloat(b.rate_per_lesson) || 0;
      let weeks = 0;
      if (b.start_date && b.end_date) {
        const ms = new Date(b.end_date) - new Date(b.start_date);
        weeks = Math.max(1, Math.round(ms / (7*86400000)) + 1);
      }
      const total_lessons = weeks * lpw;
      const total_price = Math.round(total_lessons * rate * 100) / 100;
      const id = uuid();
      db.prepare("INSERT INTO tutor_terms (id,user_id,student_id,term_name,start_date,end_date,lessons_per_week,lesson_duration,rate_per_lesson,total_lessons,total_price) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, req.userId, b.student_id, b.term_name||"Term", b.start_date||null, b.end_date||null, lpw, parseInt(b.lesson_duration)||60, rate, total_lessons, total_price);
      return res.json({ success: true, id, total_lessons, total_price });
    }
    // create a student as a contact
    if (!b.name) return res.json({ success: false, error: "Student name required" });
    const id = uuid();
    const notes = ["subject: "+(b.subject||""), "level: "+(b.level||""), b.dob?("dob: "+b.dob):"", b.goals?("goals: "+b.goals):""].filter(Boolean).join("\n");
    db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, source, status, notes) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.userId, b.name, b.email||"", b.phone||"", "tutor", "active", notes);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Per-student terms + structured progress entries
router.get("/tutor/terms/:studentId/progress", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS tutor_terms (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, term_name TEXT, start_date TEXT, end_date TEXT, lessons_per_week INTEGER DEFAULT 1, lesson_duration INTEGER DEFAULT 60, rate_per_lesson REAL DEFAULT 0, total_lessons INTEGER DEFAULT 0, total_price REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    db.exec(`CREATE TABLE IF NOT EXISTS tutor_progress (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, session_date TEXT, subject TEXT, topic TEXT, rating INTEGER DEFAULT 3, notes TEXT, homework TEXT, next_focus TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const terms = db.prepare("SELECT * FROM tutor_terms WHERE user_id=? AND student_id=? ORDER BY created_at").all(req.userId, req.params.studentId);
    const progress = db.prepare("SELECT * FROM tutor_progress WHERE user_id=? AND student_id=? ORDER BY session_date DESC").all(req.userId, req.params.studentId);
    res.json({ terms, progress });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/tutor/terms/:studentId/progress", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS tutor_progress (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, session_date TEXT, subject TEXT, topic TEXT, rating INTEGER DEFAULT 3, notes TEXT, homework TEXT, next_focus TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const b = req.body;
    const id = uuid();
    db.prepare("INSERT INTO tutor_progress (id,user_id,student_id,session_date,subject,topic,rating,notes,homework,next_focus) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, req.params.studentId, b.session_date||new Date().toISOString().split("T")[0], b.subject||"", b.topic||"", parseInt(b.rating)||3, b.notes||"", b.homework||"", b.next_focus||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Scheduled lessons for a student (+ generator + status update)
router.get("/tutor/progress/:studentId/lessons", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS tutor_lessons (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, term_id TEXT, lesson_date TEXT NOT NULL, lesson_time TEXT, status TEXT DEFAULT 'scheduled', created_at TEXT DEFAULT (datetime('now')))`);
    const lessons = db.prepare("SELECT * FROM tutor_lessons WHERE user_id=? AND student_id=? ORDER BY lesson_date,lesson_time").all(req.userId, req.params.studentId);
    res.json({ lessons });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/tutor/progress/:studentId/lessons/generate", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS tutor_lessons (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, term_id TEXT, lesson_date TEXT NOT NULL, lesson_time TEXT, status TEXT DEFAULT 'scheduled', created_at TEXT DEFAULT (datetime('now')))`);
    const { term_id, day_of_week, lesson_time, start_date, end_date } = req.body;
    if (!start_date || !end_date) return res.json({ success: false, error: "Term needs a start and end date" });
    const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const target = DAYS.indexOf(day_of_week || "Monday");
    if (target < 0) return res.json({ success: false, error: "Invalid day of week" });
    let d = new Date(start_date + "T00:00:00");
    const end = new Date(end_date + "T00:00:00");
    if (isNaN(d) || isNaN(end)) return res.json({ success: false, error: "Invalid term dates" });
    while (d.getDay() !== target && d <= end) d.setDate(d.getDate() + 1);
    const ins = db.prepare("INSERT INTO tutor_lessons (id,user_id,student_id,term_id,lesson_date,lesson_time) VALUES (?,?,?,?,?,?)");
    let created = 0;
    while (d <= end && created < 60) {
      ins.run(uuid(), req.userId, req.params.studentId, term_id||null, d.toISOString().split("T")[0], lesson_time||"09:00");
      created++; d.setDate(d.getDate() + 7);
    }
    res.json({ success: true, lessons_created: created });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/tutor/progress/:lessonId", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS tutor_lessons (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, term_id TEXT, lesson_date TEXT NOT NULL, lesson_time TEXT, status TEXT DEFAULT 'scheduled', created_at TEXT DEFAULT (datetime('now')))`);
    db.prepare("UPDATE tutor_lessons SET status=? WHERE id=? AND user_id=?").run(req.body.status||"scheduled", req.params.lessonId, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
