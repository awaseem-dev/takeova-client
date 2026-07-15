"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");
const crypto = require("crypto");

async function mvEmail(userId, to, subject, html) {
  try {
    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    if (!sgKey || !to) return false;
    const from = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
    const site = getDb().prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(userId);
    const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
    const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, name: site?.name || "MINE" }, subject, content: [{ type: "text/html", value: html }] })
    });
    if (!_sgResp.ok) {
      let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
      console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
    }
    return true;
  } catch(e) { return false; }
}

// ════════════════════════════════════════════════════════════════════════════
//  PHOTOGRAPHY & VIDEOGRAPHY
// ════════════════════════════════════════════════════════════════════════════

router.get("/galleries", auth, (req, res) => {
  try {
    const db = getDb();
    const galleries = db.prepare(`SELECT g.*, c.name as client_name, c.email as client_email,
      (SELECT COUNT(*) FROM photo_gallery_images WHERE gallery_id=g.id) as image_count,
      (SELECT COUNT(*) FROM photo_gallery_images WHERE gallery_id=g.id AND approved=1) as approved_count
      FROM photo_galleries g LEFT JOIN contacts c ON c.id=g.contact_id
      WHERE g.user_id=? ORDER BY g.created_at DESC`).all(req.userId);
    res.json({ galleries });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/galleries", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, contact_id, event_date, event_type, watermark_text,
            watermark_opacity, expires_at, download_enabled, password } = req.body;
    if (!name) return res.status(400).json({ error: "Gallery name required" });
    const id = uuid();
    const share_token = crypto.randomBytes(16).toString("hex");
    db.prepare(`INSERT INTO photo_galleries (id,user_id,contact_id,name,event_date,event_type,
               share_token,password,watermark_text,watermark_opacity,expires_at,download_enabled)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id||null, name, event_date||null, event_type||"photography",
           share_token, password||null, watermark_text||"", watermark_opacity||0.3,
           expires_at||null, download_enabled?1:0);
    res.json({ success: true, id, share_token });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/galleries/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, event_date, event_type, watermark_text, watermark_opacity,
            expires_at, download_enabled, status, password } = req.body;
    db.prepare(`UPDATE photo_galleries SET name=?,event_date=?,event_type=?,watermark_text=?,
               watermark_opacity=?,expires_at=?,download_enabled=?,status=?,password=?
               WHERE id=? AND user_id=?`)
      .run(name, event_date, event_type, watermark_text, watermark_opacity,
           expires_at, download_enabled?1:0, status||"uploading", password||null,
           req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/galleries/:id/images", auth, (req, res) => {
  try {
    const db = getDb();
    const { url, watermarked_url, caption, order_idx } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });
    const id = uuid();
    db.prepare("INSERT INTO photo_gallery_images (id,gallery_id,user_id,url,watermarked_url,caption,order_idx) VALUES (?,?,?,?,?,?,?)")
      .run(id, req.params.id, req.userId, url, watermarked_url||url, caption||"", order_idx||0);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/galleries/:id/images/:imgId", auth, (req, res) => {
  try {
    const db = getDb();
    const { approved, caption } = req.body;
    db.prepare("UPDATE photo_gallery_images SET approved=?,caption=? WHERE id=? AND user_id=?")
      .run(approved?1:0, caption||"", req.params.imgId, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Send gallery share link to client
router.post("/galleries/:id/share", auth, async (req, res) => {
  try {
    const db = getDb();
    const gallery = db.prepare("SELECT g.*,c.email,c.name as client_name FROM photo_galleries g LEFT JOIN contacts c ON c.id=g.contact_id WHERE g.id=? AND g.user_id=?").get(req.params.id, req.userId);
    if (!gallery) return res.status(404).json({ error: "Gallery not found" });
    const to = req.body.email || gallery.email;
    if (!to) return res.status(400).json({ error: "No email address for client" });
    const frontendUrl = getSetting("FRONTEND_URL") || process.env.FRONTEND_URL || "https://takeova.ai";
    const link = `${frontendUrl}/gallery/${gallery.share_token}`;
    const imageCount = db.prepare("SELECT COUNT(*) as c FROM photo_gallery_images WHERE gallery_id=? AND approved=1").get(gallery.id)?.c || 0;
    await mvEmail(req.userId, to, `Your ${gallery.event_type} gallery is ready — ${gallery.name}`,
      `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:32px 24px">
      <h2 style="color:#2563EB;margin-bottom:8px">Your gallery is ready! 📸</h2>
      <p style="color:#475569;margin-bottom:24px">Hi ${gallery.client_name||"there"},</p>
      <p style="margin-bottom:24px">Your <strong>${gallery.name}</strong> gallery is ready to view. We've curated <strong>${imageCount} photo${imageCount!==1?"s":""}</strong> for your review.</p>
      <a href="${link}" style="display:inline-block;padding:14px 28px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;margin-bottom:20px">View Gallery →</a>
      ${gallery.download_enabled ? '<p style="color:#64748B;font-size:13px">Downloads are enabled for your gallery.</p>' : ''}
      ${gallery.expires_at ? `<p style="color:#64748B;font-size:12px">Gallery available until ${gallery.expires_at}</p>` : ''}
      </div>`);
    db.prepare("UPDATE photo_galleries SET status='shared' WHERE id=?").run(gallery.id);
    res.json({ success: true, link });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Public gallery view (by share token)
router.get("/gallery/:token", (req, res) => {
  try {
    const db = getDb();
    const gallery = db.prepare("SELECT * FROM photo_galleries WHERE share_token=? AND status NOT IN ('archived')").get(req.params.token);
    if (!gallery) return res.status(404).json({ error: "Gallery not found or expired" });
    if (gallery.expires_at && new Date(gallery.expires_at) < new Date()) return res.status(410).json({ error: "Gallery has expired" });
    const { password } = req.query;
    if (gallery.password && gallery.password !== password) return res.status(401).json({ error: "Password required", password_required: true });
    const images = db.prepare("SELECT id,watermarked_url as url,url as full_url,caption,approved,order_idx FROM photo_gallery_images WHERE gallery_id=? AND approved=1 ORDER BY order_idx,created_at").all(gallery.id);
    res.json({ gallery: { id: gallery.id, name: gallery.name, event_date: gallery.event_date, event_type: gallery.event_type, download_enabled: !!gallery.download_enabled, watermark_text: gallery.watermark_text }, images });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  MUSIC TEACHERS / TUTORS / INSTRUCTORS
// ════════════════════════════════════════════════════════════════════════════

router.get("/students", auth, (req, res) => {
  try {
    const db = getDb();
    const students = db.prepare(`SELECT sp.*, c.email as parent_email, c.phone as parent_phone,
      (SELECT COUNT(*) FROM lesson_terms WHERE student_id=sp.id AND paid=0) as unpaid_terms
      FROM student_profiles sp LEFT JOIN contacts c ON c.id=sp.contact_id
      WHERE sp.user_id=? ORDER BY sp.name`).all(req.userId);
    res.json({ students });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/students", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, contact_id, subject, level, instrument, started_date, fee_per_lesson, lessons_per_week, notes } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const id = uuid();
    db.prepare(`INSERT INTO student_profiles (id,user_id,contact_id,name,subject,level,started_date,notes)
               VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id||null, name, instrument||subject||"", level||"beginner", started_date||null, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/students/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, subject, level, started_date, notes } = req.body;
    db.prepare("UPDATE student_profiles SET name=?,subject=?,level=?,started_date=?,notes=? WHERE id=? AND user_id=?")
      .run(name, subject, level, started_date, notes, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Terms — create a term and generate invoice
router.get("/students/:id/terms", auth, (req, res) => {
  try {
    const db = getDb();
    const terms = db.prepare("SELECT * FROM lesson_terms WHERE user_id=? AND student_id=? ORDER BY start_date DESC").all(req.userId, req.params.id);
    res.json({ terms });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/students/:id/terms", auth, async (req, res) => {
  try {
    const db = getDb();
    const { term_name, start_date, end_date, lessons_per_week, lesson_duration, fee_per_lesson, notes } = req.body;
    const student = db.prepare("SELECT sp.*,c.email,c.name as parent_name FROM student_profiles sp LEFT JOIN contacts c ON c.id=sp.contact_id WHERE sp.id=? AND sp.user_id=?").get(req.params.id, req.userId);
    if (!student) return res.status(404).json({ error: "Student not found" });
    // Calculate total lessons and fee
    const weeksCount = start_date && end_date ? Math.ceil((new Date(end_date)-new Date(start_date))/604800000) : 10;
    const totalLessons = weeksCount * (lessons_per_week||1);
    const totalFee = totalLessons * (fee_per_lesson||0);
    const id = uuid();
    db.prepare("INSERT INTO lesson_terms (id,user_id,student_id,term_name,start_date,end_date,lessons_per_week,lesson_duration,fee_per_lesson,total_fee,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, req.params.id, term_name||"Term", start_date||null, end_date||null, lessons_per_week||1, lesson_duration||60, fee_per_lesson||0, totalFee, notes||"");
    // Auto-create invoice
    const dueDate = start_date || new Date().toISOString().split("T")[0];
    const invNum = `TRM-${Date.now().toString().slice(-6)}`;
    const invId = uuid();
    db.prepare("INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,items_json,subtotal,tax,total,status,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(invId, req.userId, invNum, student.name, student.email||"",
           JSON.stringify([{ description: `${term_name||"Term"} — ${totalLessons} lesson${totalLessons!==1?"s":""} (${lessons_per_week||1}x/week × ${weeksCount} weeks)`, amount: totalFee }]),
           totalFee, 0, totalFee, "sent", dueDate);
    db.prepare("UPDATE lesson_terms SET invoice_id=? WHERE id=?").run(invId, id);
    if (student.email) await mvEmail(req.userId, student.email, `Invoice for ${term_name||"Term"} — ${student.name}`, `<p>Hi ${student.parent_name||"there"},</p><p>Please find your invoice for <strong>${term_name||"Term"}</strong>. Total: <strong>$${totalFee}</strong> for ${totalLessons} lessons.</p>`);
    res.json({ success: true, id, invoice_id: invId, total_fee: totalFee, total_lessons: totalLessons });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Student progress notes
router.get("/students/:id/progress", auth, (req, res) => {
  try {
    const db = getDb();
    const notes = db.prepare("SELECT * FROM student_progress_notes WHERE user_id=? AND student_id=? ORDER BY lesson_date DESC LIMIT 20").all(req.userId, req.params.id);
    res.json({ notes });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/students/:id/progress", auth, (req, res) => {
  try {
    const db = getDb();
    const { lesson_date, notes, pieces_working_on, achievements, next_goals, homework, mood } = req.body;
    if (!lesson_date) return res.status(400).json({ error: "lesson_date required" });
    const id = uuid();
    db.prepare("INSERT INTO student_progress_notes (id,user_id,student_id,lesson_date,notes,pieces_working_on,achievements,next_goals,homework,mood) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, req.params.id, lesson_date, notes||"", pieces_working_on||"", achievements||"", next_goals||"", homework||"", mood||3);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  EVENT VENUES & WEDDING VENUES
// ════════════════════════════════════════════════════════════════════════════

router.get("/venue-events", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, from } = req.query;
    let q = "SELECT ve.* FROM venue_events ve WHERE ve.user_id=?";
    const params = [req.userId];
    if (status) { q += " AND ve.status=?"; params.push(status); }
    if (from) { q += " AND ve.event_date>=?"; params.push(from); }
    q += " ORDER BY ve.event_date ASC LIMIT 50";
    const events = db.prepare(q).all(...params);
    const enriched = events.map(e => {
      const vendors = db.prepare("SELECT * FROM event_vendors WHERE event_id=?").all(e.id);
      const timeline = db.prepare("SELECT * FROM event_timeline WHERE event_id=? ORDER BY time ASC").all(e.id);
      return { ...e, vendors, timeline };
    });
    res.json({ events: enriched });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/venue-events", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, client_name, client_email, client_phone, event_type, event_date,
            start_time, end_time, guest_count, venue_space, total_value, deposit_paid, notes } = req.body;
    if (!name || !event_date) return res.status(400).json({ error: "name and event_date required" });
    // Check no other event on same date in same space
    if (venue_space) {
      const conflict = db.prepare("SELECT id FROM venue_events WHERE user_id=? AND event_date=? AND venue_space=? AND status NOT IN ('cancelled')").get(req.userId, event_date, venue_space);
      if (conflict) return res.status(409).json({ error: `${venue_space} is already booked on ${event_date}` });
    }
    const id = uuid();
    db.prepare(`INSERT INTO venue_events (id,user_id,name,client_name,client_email,client_phone,
               event_type,event_date,start_time,end_time,guest_count,venue_space,
               total_value,deposit_paid,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, name, client_name||"", client_email||"", client_phone||"",
           event_type||"event", event_date, start_time||null, end_time||null,
           guest_count||null, venue_space||"", total_value||0, deposit_paid||0, notes||"");
    // Auto-save as contact
    if (client_email) {
      try {
        const existing = db.prepare("SELECT id FROM contacts WHERE user_id=? AND email=?").get(req.userId, client_email);
        if (!existing) db.prepare("INSERT INTO contacts (id,user_id,name,email,phone,status,source) VALUES (?,?,?,?,?,?,?)").run(uuid(), req.userId, client_name||"", client_email, client_phone||"", "lead", "venue_enquiry");
      } catch(e) { console.error("[/venue-events]", e.message || e); }
    }
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/venue-events/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, client_name, client_email, event_type, event_date, start_time, end_time,
            guest_count, venue_space, total_value, deposit_paid, status, notes } = req.body;
    db.prepare(`UPDATE venue_events SET name=?,client_name=?,client_email=?,event_type=?,event_date=?,
               start_time=?,end_time=?,guest_count=?,venue_space=?,total_value=?,deposit_paid=?,
               status=?,notes=? WHERE id=? AND user_id=?`)
      .run(name, client_name, client_email, event_type, event_date, start_time, end_time,
           guest_count, venue_space, total_value, deposit_paid, status||"enquiry", notes,
           req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Vendors
router.post("/venue-events/:id/vendors", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, category, contact_name, email, phone, amount, notes } = req.body;
    const id = uuid();
    db.prepare("INSERT INTO event_vendors (id,user_id,event_id,name,category,contact_name,email,phone,amount,notes) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, req.params.id, name||"", category||"", contact_name||"", email||"", phone||"", amount||0, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Timeline
router.post("/venue-events/:id/timeline", auth, (req, res) => {
  try {
    const db = getDb();
    const { time, title, notes } = req.body;
    if (!time || !title) return res.status(400).json({ error: "time and title required" });
    const id = uuid();
    db.prepare("INSERT INTO event_timeline (id,user_id,event_id,time,title,notes) VALUES (?,?,?,?,?,?)")
      .run(id, req.userId, req.params.id, time, title, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/venue-events/:eventId/timeline/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { time, title, notes, completed } = req.body;
    db.prepare("UPDATE event_timeline SET time=?,title=?,notes=?,completed=? WHERE id=? AND user_id=?")
      .run(time, title, notes, completed?1:0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Check date availability
router.get("/venue-events/availability/:date", auth, (req, res) => {
  try {
    const db = getDb();
    const events = db.prepare("SELECT id,name,start_time,end_time,venue_space,status FROM venue_events WHERE user_id=? AND event_date=? AND status NOT IN ('cancelled')").all(req.userId, req.params.date);
    res.json({ date: req.params.date, events, available: events.length === 0 });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  IT SUPPORT / MSPs / AGENCIES
// ════════════════════════════════════════════════════════════════════════════

router.get("/retainers", auth, (req, res) => {
  try {
    const db = getDb();
    const retainers = db.prepare(`SELECT r.*, c.name as client_name, c.email as client_email
      FROM retainers r LEFT JOIN contacts c ON c.id=r.contact_id
      WHERE r.user_id=? AND r.status='active' ORDER BY r.name`).all(req.userId);
    res.json({ retainers });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/retainers", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, name, hours_per_month, monthly_fee, start_date, billing_day } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const id = uuid();
    db.prepare("INSERT INTO retainers (id,user_id,contact_id,name,hours_per_month,monthly_fee,start_date,billing_day) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, name, hours_per_month||10, monthly_fee||0, start_date||null, billing_day||1);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/retainers/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, hours_per_month, monthly_fee, used_hours, status } = req.body;
    db.prepare("UPDATE retainers SET name=?,hours_per_month=?,monthly_fee=?,used_hours=?,status=? WHERE id=? AND user_id=?")
      .run(name, hours_per_month, monthly_fee, used_hours||0, status||"active", req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Log hours against retainer
router.post("/retainers/:id/log-hours", auth, (req, res) => {
  try {
    const db = getDb();
    const { hours, description } = req.body;
    if (!hours) return res.status(400).json({ error: "hours required" });
    const retainer = db.prepare("SELECT * FROM retainers WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!retainer) return res.status(404).json({ error: "Retainer not found" });
    const newUsed = (retainer.used_hours||0) + parseFloat(hours);
    db.prepare("UPDATE retainers SET used_hours=? WHERE id=?").run(newUsed, req.params.id);
    // Also log as time entry
    try {
      db.prepare("INSERT INTO time_entries (id,user_id,contact_id,client_name,description,date,duration_minutes,hourly_rate,billable,invoiced) VALUES (?,?,?,?,?,?,?,?,0,0)")
        .run(uuid(), req.userId, retainer.contact_id, "", description||"Retainer work", new Date().toISOString().split("T")[0], Math.round(parseFloat(hours)*60), 0);
    } catch(e) {}
    const pct = Math.round((newUsed / (retainer.hours_per_month||10)) * 100);
    res.json({ success: true, used_hours: newUsed, monthly_hours: retainer.hours_per_month, pct_used: pct, warning: pct >= 80 ? `⚠️ ${pct}% of retainer hours used this month` : null });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// SLA rules
router.get("/sla-rules", auth, (req, res) => {
  try {
    const db = getDb();
    let rules = db.prepare("SELECT * FROM sla_rules WHERE user_id=? ORDER BY response_minutes").all(req.userId);
    if (!rules.length) {
      // Return defaults
      rules = [
        { priority: "critical", response_minutes: 15, resolution_hours: 2 },
        { priority: "high", response_minutes: 60, resolution_hours: 4 },
        { priority: "medium", response_minutes: 240, resolution_hours: 24 },
        { priority: "low", response_minutes: 480, resolution_hours: 72 },
      ];
    }
    res.json({ rules });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/sla-rules", auth, (req, res) => {
  try {
    const db = getDb();
    const { priority, response_minutes, resolution_hours } = req.body;
    if (!priority) return res.status(400).json({ error: "priority required" });
    const id = uuid();
    db.prepare("INSERT OR REPLACE INTO sla_rules (id,user_id,priority,response_minutes,resolution_hours) VALUES (?,?,?,?,?)")
      .run(id, req.userId, priority, response_minutes||60, resolution_hours||8);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  AUTO MECHANICS / GARAGES
// ════════════════════════════════════════════════════════════════════════════

router.get("/vehicles", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id } = req.query;
    let q = `SELECT v.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone,
             (SELECT COUNT(*) FROM vehicle_jobs WHERE vehicle_id=v.id AND status NOT IN ('completed','invoiced')) as open_jobs
             FROM vehicles v LEFT JOIN contacts c ON c.id=v.contact_id
             WHERE v.user_id=?`;
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
    const { contact_id, make, model, year, rego, color, vin, odometer, notes, wof_due, rego_due } = req.body;
    if (!make) return res.status(400).json({ error: "Make required" });
    const id = uuid();
    db.prepare("INSERT INTO vehicles (id,user_id,contact_id,make,model,year,rego,color,vin,odometer,notes,wof_due,rego_due) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, make, model||"", year||null, rego||"", color||"", vin||"", odometer||null, notes||"", wof_due||null, rego_due||null);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/vehicles/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { make, model, year, rego, color, vin, odometer, notes, wof_due, rego_due } = req.body;
    db.prepare("UPDATE vehicles SET make=?,model=?,year=?,rego=?,color=?,vin=?,odometer=?,notes=?,wof_due=?,rego_due=? WHERE id=? AND user_id=?")
      .run(make, model, year, rego, color, vin, odometer, notes, wof_due||null, rego_due||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Vehicle jobs
router.get("/vehicle-jobs", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, vehicle_id } = req.query;
    let q = `SELECT vj.*, v.make, v.model, v.year, v.rego, v.color,
             c.name as owner_name, c.email as owner_email, c.phone as owner_phone
             FROM vehicle_jobs vj
             LEFT JOIN vehicles v ON v.id=vj.vehicle_id
             LEFT JOIN contacts c ON c.id=vj.contact_id
             WHERE vj.user_id=?`;
    const params = [req.userId];
    if (status) { q += " AND vj.status=?"; params.push(status); }
    if (vehicle_id) { q += " AND vj.vehicle_id=?"; params.push(vehicle_id); }
    q += " ORDER BY vj.scheduled_date DESC LIMIT 50";
    const jobs = db.prepare(q).all(...params);
    const enriched = jobs.map(j => ({
      ...j,
      parts: db.prepare("SELECT * FROM vehicle_parts WHERE job_id=?").all(j.id)
    }));
    res.json({ jobs: enriched });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/vehicle-jobs", auth, (req, res) => {
  try {
    const db = getDb();
    const { vehicle_id, contact_id, title, description, scheduled_date, odometer_in, labour_cost, notes, wof_due, rego_due } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });
    const id = uuid();
    db.prepare("INSERT INTO vehicle_jobs (id,user_id,vehicle_id,contact_id,title,description,scheduled_date,odometer_in,labour_cost,total_cost,notes,wof_due,rego_due) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, vehicle_id||null, contact_id||null, title, description||"", scheduled_date||null, odometer_in||null, labour_cost||0, labour_cost||0, notes||"", wof_due||null, rego_due||null);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/vehicle-jobs/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, description, status, odometer_in, odometer_out, labour_cost, parts_cost, notes, wof_due, rego_due } = req.body;
    const total = (labour_cost||0) + (parts_cost||0);
    db.prepare("UPDATE vehicle_jobs SET title=?,description=?,status=?,odometer_in=?,odometer_out=?,labour_cost=?,parts_cost=?,total_cost=?,notes=?,wof_due=?,rego_due=? WHERE id=? AND user_id=?")
      .run(title, description, status||"booked", odometer_in, odometer_out, labour_cost||0, parts_cost||0, total, notes, wof_due||null, rego_due||null, req.params.id, req.userId);
    // Update vehicle odometer and WOF/rego if provided — IDOR fix: must verify ownership
    if (odometer_out && req.body.vehicle_id) {
      try {
        const ownedVeh = db.prepare("SELECT id FROM vehicles WHERE id = ? AND user_id = ?").get(req.body.vehicle_id, req.userId);
        if (ownedVeh) db.prepare("UPDATE vehicles SET odometer=? WHERE id=?").run(odometer_out, req.body.vehicle_id);
      } catch(e) { console.error("[/vehicle-jobs/:id]", e.message || e); }
    }
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/vehicle-jobs/:id/parts", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, part_number, supplier, cost_price, sell_price, quantity } = req.body;
    if (!name) return res.status(400).json({ error: "Part name required" });
    // IDOR fix: verify the vehicle job belongs to this user
    const ownedJob = db.prepare("SELECT id, labour_cost FROM vehicle_jobs WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!ownedJob) return res.status(404).json({ error: "Vehicle job not found" });
    const total_sell = (sell_price||0) * (quantity||1);
    const pid = uuid();
    db.prepare("INSERT INTO vehicle_parts (id,user_id,job_id,name,part_number,supplier,cost_price,sell_price,quantity,total_sell) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(pid, req.userId, req.params.id, name, part_number||"", supplier||"", cost_price||0, sell_price||0, quantity||1, total_sell);
    // Update job parts_cost
    const totals = db.prepare("SELECT SUM(total_sell) as t FROM vehicle_parts WHERE job_id=?").get(req.params.id);
    const job = db.prepare("SELECT labour_cost FROM vehicle_jobs WHERE id=?").get(req.params.id);
    const newParts = totals?.t || 0;
    db.prepare("UPDATE vehicle_jobs SET parts_cost=?,total_cost=? WHERE id=?").run(newParts, (job?.labour_cost||0)+newParts, req.params.id);
    res.json({ success: true, id: pid, total_sell });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Vehicles due for WOF/service
router.get("/vehicles/due", auth, (req, res) => {
  try {
    const db = getDb();
    const in30 = new Date(Date.now()+30*86400000).toISOString().split("T")[0];
    let due = [];
    try { due = db.prepare(`SELECT v.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone FROM vehicles v LEFT JOIN contacts c ON c.id=v.contact_id WHERE v.user_id=? AND (v.wof_due<=? OR v.rego_due<=?) ORDER BY COALESCE(v.wof_due, v.rego_due) ASC`).all(req.userId, in30, in30); } catch(e) {}
    res.json({ due, count: due.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Convert job to invoice
router.post("/vehicle-jobs/:id/invoice", auth, async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare(`SELECT vj.*, v.make, v.model, v.rego, c.name as client_name, c.email FROM vehicle_jobs vj LEFT JOIN vehicles v ON v.id=vj.vehicle_id LEFT JOIN contacts c ON c.id=vj.contact_id WHERE vj.id=? AND vj.user_id=?`).get(req.params.id, req.userId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const parts = db.prepare("SELECT * FROM vehicle_parts WHERE job_id=?").all(job.id);
    const items = [
      { description: `Labour — ${job.title}`, amount: job.labour_cost||0 },
      ...parts.map(p => ({ description: `${p.name}${p.part_number ? " (" + p.part_number + ")" : ""} ×${p.quantity}`, amount: p.total_sell||0 }))
    ].filter(i => i.amount > 0);
    const total = items.reduce((s,i) => s+i.amount, 0);
    const invNum = `VEH-${Date.now().toString().slice(-6)}`;
    const dueDate = new Date(Date.now()+7*86400000).toISOString().split("T")[0];
    const invId = uuid();
    db.prepare("INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,items_json,subtotal,tax,total,status,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(invId, req.userId, invNum, job.client_name||"Customer", job.email||"", JSON.stringify(items), total, 0, total, "sent", dueDate);
    db.prepare("UPDATE vehicle_jobs SET status='invoiced',invoice_id=? WHERE id=?").run(invId, job.id);
    if (job.email) await mvEmail(req.userId, job.email, `Invoice ${invNum} — ${job.make} ${job.model}`, `<p>Hi ${job.client_name||"there"},</p><p>Your invoice for <strong>${job.title}</strong> on your ${job.make} ${job.model}${job.rego ? " (" + job.rego + ")" : ""} is ready. <strong>Total: $${total.toFixed(2)}</strong></p>`);
    res.json({ success: true, invoice_id: invId, total });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  CHILDCARE / NURSERIES
// ════════════════════════════════════════════════════════════════════════════

router.get("/children", auth, (req, res) => {
  try {
    const db = getDb();
    const children = db.prepare(`SELECT ch.*, c.name as parent_name, c.email as parent_email, c.phone as parent_phone
      FROM children ch LEFT JOIN contacts c ON c.id=ch.parent_contact_id
      WHERE ch.user_id=? ORDER BY ch.child_name`).all(req.userId);
    res.json({ children });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/children", auth, (req, res) => {
  try {
    const db = getDb();
    const { child_name, date_of_birth, parent_contact_id, allergies, medical_notes, emergency_contact, room_group, enrolled_days } = req.body;
    if (!child_name) return res.status(400).json({ error: "Child name required" });
    const id = uuid();
    db.prepare("INSERT INTO children (id,user_id,parent_contact_id,child_name,date_of_birth,allergies,medical_notes,emergency_contact) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.userId, parent_contact_id||null, child_name, date_of_birth||null, allergies||"", medical_notes||"", emergency_contact||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Attendance
router.get("/attendance", auth, (req, res) => {
  try {
    const db = getDb();
    const { date, child_id } = req.query;
    const targetDate = date || new Date().toISOString().split("T")[0];
    let q = `SELECT al.*, ch.child_name FROM attendance_log al LEFT JOIN children ch ON ch.id=al.child_id WHERE al.user_id=? AND al.date=?`;
    const params = [req.userId, targetDate];
    if (child_id) { q += " AND al.child_id=?"; params.push(child_id); }
    const records = db.prepare(q).all(...params);
    // Also get all children for today's roll
    const allChildren = db.prepare("SELECT id,child_name FROM children WHERE user_id=?").all(req.userId);
    res.json({ date: targetDate, attendance: records, total_children: allChildren.length, present: records.filter(r=>r.present).length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/attendance", auth, (req, res) => {
  try {
    const db = getDb();
    const { child_id, date, check_in, check_out, present, notes } = req.body;
    if (!child_id || !date) return res.status(400).json({ error: "child_id and date required" });
    const id = uuid();
    db.prepare("INSERT OR REPLACE INTO attendance_log (id,user_id,child_id,date,check_in,check_out,present,notes) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.userId, child_id, date, check_in||null, check_out||null, present!==false?1:0, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Daily message to parent
router.post("/children/:id/message", auth, async (req, res) => {
  try {
    const db = getDb();
    const child = db.prepare("SELECT ch.*,c.email as parent_email,c.name as parent_name FROM children ch LEFT JOIN contacts c ON c.id=ch.parent_contact_id WHERE ch.id=? AND ch.user_id=?").get(req.params.id, req.userId);
    if (!child) return res.status(404).json({ error: "Child not found" });
    if (!child.parent_email) return res.status(400).json({ error: "No parent email on file" });
    const { message, activities, mood, meals } = req.body;
    const today = new Date().toISOString().split("T")[0];
    await mvEmail(req.userId, child.parent_email, `Daily update — ${child.child_name}`,
      `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px">
      <h2>Today's Update 👋</h2>
      <p>Hi ${child.parent_name||"there"},</p>
      <p>Here's how ${child.child_name} got on today (${today}).</p>
      ${mood ? `<div style="margin:12px 0"><strong>Mood:</strong> ${mood}</div>` : ""}
      ${activities ? `<div style="margin:12px 0"><strong>Activities:</strong> ${activities}</div>` : ""}
      ${meals ? `<div style="margin:12px 0"><strong>Meals:</strong> ${meals}</div>` : ""}
      ${message ? `<div style="margin:12px 0"><strong>Notes:</strong> ${message}</div>` : ""}
      </div>`);
    res.json({ success: true, sent_to: child.parent_email });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  FLORISTS & GIFT SHOPS — OCCASION REMINDERS
// ════════════════════════════════════════════════════════════════════════════

router.get("/occasions", auth, (req, res) => {
  try {
    const db = getDb();
    const { days_ahead } = req.query;
    const ahead = parseInt(days_ahead)||30;
    const today = new Date().toISOString().split("T")[0];
    const until = new Date(Date.now()+ahead*86400000).toISOString().split("T")[0];
    // Get occasions matching month/day within window (recurring annually)
    const occasions = db.prepare(`SELECT o.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone
      FROM occasions o LEFT JOIN contacts c ON c.id=o.contact_id
      WHERE o.user_id=? ORDER BY o.occasion_date`).all(req.userId);
    // Filter by upcoming in next N days (matching month-day, any year)
    const upcoming = occasions.filter(o => {
      if (!o.occasion_date) return false;
      const parts = o.occasion_date.split("-");
      const thisYear = new Date().getFullYear();
      const next = new Date(`${thisYear}-${parts[1]}-${parts[2]}`);
      if (next < new Date(today)) next.setFullYear(thisYear+1);
      const nextStr = next.toISOString().split("T")[0];
      return nextStr >= today && nextStr <= until;
    });
    res.json({ occasions, upcoming, upcoming_count: upcoming.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/occasions", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, occasion_type, occasion_date, notes } = req.body;
    if (!contact_id || !occasion_date) return res.status(400).json({ error: "contact_id and occasion_date required" });
    const id = uuid();
    db.prepare("INSERT INTO occasions (id,user_id,contact_id,occasion_type,occasion_date,notes) VALUES (?,?,?,?,?,?)")
      .run(id, req.userId, contact_id, occasion_type||"birthday", occasion_date, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Send occasion reminder to business owner (prompt to reach out to customer)
router.post("/occasions/send-reminders", auth, async (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const in7 = new Date(Date.now()+7*86400000).toISOString().split("T")[0];
    const occasions = db.prepare(`SELECT o.*,c.name as contact_name,c.email as contact_email FROM occasions o LEFT JOIN contacts c ON c.id=o.contact_id WHERE o.user_id=? AND o.reminder_sent=0`).all(req.userId);
    const due = occasions.filter(o => {
      if (!o.occasion_date) return false;
      const parts = o.occasion_date.split("-");
      const thisYear = new Date().getFullYear();
      const next = new Date(`${thisYear}-${parts[1]}-${parts[2]}`);
      if (next < new Date(today)) next.setFullYear(thisYear+1);
      return next.toISOString().split("T")[0] <= in7;
    });
    if (!due.length) return res.json({ sent: 0, message: "No upcoming occasions in the next 7 days" });
    const ownerEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM;
    if (ownerEmail) {
      const list = due.map(o => `• ${o.contact_name||o.contact_email} — ${o.occasion_type} on ${o.occasion_date}`).join("\n");
      await mvEmail(req.userId, ownerEmail, `🌸 ${due.length} upcoming occasion${due.length!==1?"s":""} this week`,
        `<div style="font-family:system-ui;max-width:520px;padding:24px"><h2>Upcoming occasions — reach out! 🌸</h2><pre style="font-size:14px;line-height:1.8">${list}</pre><p>Now's a great time to reach out to these customers with a personalised message or special offer.</p></div>`);
    }
    for (const o of due) db.prepare("UPDATE occasions SET reminder_sent=1 WHERE id=?").run(o.id);
    res.json({ sent: due.length, occasions: due.map(o => ({ contact: o.contact_name, type: o.occasion_type, date: o.occasion_date })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  MORTGAGE BROKERS / FINANCIAL ADVISORS
// ════════════════════════════════════════════════════════════════════════════

router.get("/loan-applications", auth, (req, res) => {
  try {
    const db = getDb();
    const apps = db.prepare(`SELECT la.*, c.email as contact_email, c.phone as contact_phone
      FROM loan_applications la LEFT JOIN contacts c ON c.id=la.contact_id
      WHERE la.user_id=? ORDER BY la.created_at DESC`).all(req.userId);
    const enriched = apps.map(a => ({
      ...a,
      documents: db.prepare("SELECT * FROM document_checklist WHERE contact_id=? AND user_id=?").all(a.contact_id||"", req.userId)
    }));
    res.json({ applications: enriched });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/loan-applications", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, client_name, client_email, loan_type, amount, lender, rate, status, notes } = req.body;
    if (!client_name && !contact_id) return res.status(400).json({ error: "client_name or contact_id required" });
    const id = uuid();
    db.prepare("INSERT INTO loan_applications (id,user_id,contact_id,client_name,client_email,loan_type,amount,lender,rate,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, client_name||"", client_email||"", loan_type||"home", amount||null, lender||"", rate||null, status||"enquiry", notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/loan-applications/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { loan_type, amount, lender, rate, status, notes } = req.body;
    db.prepare("UPDATE loan_applications SET loan_type=?,amount=?,lender=?,rate=?,status=?,notes=? WHERE id=? AND user_id=?")
      .run(loan_type, amount, lender, rate, status, notes, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Document checklist
router.post("/document-checklist", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, name, notes } = req.body;
    if (!contact_id || !name) return res.status(400).json({ error: "contact_id and name required" });
    const id = uuid();
    db.prepare("INSERT INTO document_checklist (id,user_id,contact_id,name,notes) VALUES (?,?,?,?,?)")
      .run(id, req.userId, contact_id, name, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/document-checklist/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, received_at, notes } = req.body;
    db.prepare("UPDATE document_checklist SET status=?,received_at=?,notes=? WHERE id=? AND user_id=?")
      .run(status||"requested", received_at||null, notes||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
