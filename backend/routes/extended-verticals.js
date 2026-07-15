"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");

async function evEmail(userId, to, subject, html) {
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
    const { contact_id } = req.query;
    let q = "SELECT g.*, c.name as client_name, c.email as client_email FROM photography_galleries g LEFT JOIN contacts c ON c.id=g.contact_id WHERE g.user_id=?";
    const params = [req.userId];
    if (contact_id) { q += " AND g.contact_id=?"; params.push(contact_id); }
    q += " ORDER BY g.created_at DESC";
    const galleries = db.prepare(q).all(...params);
    res.json({ galleries: galleries.map(g => ({ ...g, photos: JSON.parse(g.photos||"[]"), selected_photos: JSON.parse(g.selected_photos||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/galleries", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, name, description, photos, watermark, watermark_text, expires_days, password } = req.body;
    if (!name) return res.status(400).json({ error: "Gallery name required" });
    const id = uuid();
    const expires = expires_days ? new Date(Date.now() + parseInt(expires_days)*86400000).toISOString().split("T")[0] : null;
    db.prepare(`INSERT INTO photography_galleries (id,user_id,contact_id,name,description,photos,watermark,watermark_text,expires_at,password,status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id||null, name, description||"",
           JSON.stringify(photos||[]), watermark!==false?1:0,
           watermark_text||"PROOF - Not for distribution", expires, password||null, "draft");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/galleries/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, description, photos, status, watermark, watermark_text, expires_at, password } = req.body;
    db.prepare("UPDATE photography_galleries SET name=?,description=?,photos=?,status=?,watermark=?,watermark_text=?,expires_at=?,password=? WHERE id=? AND user_id=?")
      .run(name, description, JSON.stringify(photos||[]), status||"draft", watermark!==false?1:0, watermark_text, expires_at||null, password||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Send gallery link to client
router.post("/galleries/:id/send", auth, async (req, res) => {
  try {
    const db = getDb();
    const gallery = db.prepare("SELECT g.*, c.email as client_email, c.name as client_name FROM photography_galleries g LEFT JOIN contacts c ON c.id=g.contact_id WHERE g.id=? AND g.user_id=?").get(req.params.id, req.userId);
    if (!gallery) return res.status(404).json({ error: "Gallery not found" });
    if (!gallery.client_email && !req.body.email) return res.status(400).json({ error: "No client email" });
    const to = req.body.email || gallery.client_email;
    const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(req.userId);
    const BACKEND = process.env.BACKEND_URL || "http://localhost:4000";
    const galleryUrl = `${BACKEND}/api/extended/gallery/${gallery.id}${gallery.password ? "?pw=" + encodeURIComponent(gallery.password) : ""}`;
    db.prepare("UPDATE photography_galleries SET status='sent' WHERE id=?").run(gallery.id);
    await evEmail(req.userId, to, `Your photos are ready — ${gallery.name}`,
      `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#2563EB">Your Photos Are Ready! 📸</h2>
      <p>Hi ${gallery.client_name||"there"},</p>
      <p>Your gallery "<strong>${gallery.name}</strong>" is ready to view.</p>
      <p style="margin:20px 0"><a href="${galleryUrl}" style="display:inline-block;padding:14px 28px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">View Your Gallery →</a></p>
      ${gallery.expires_at ? `<p style="color:#94A3B8;font-size:12px">Gallery expires: ${gallery.expires_at}</p>` : ""}
      <p style="color:#64748B;font-size:13px">Watermarked proofs are shown. Full resolution files will be delivered after selection.</p>
      </div>`);
    res.json({ success: true, sent_to: to });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Public gallery view (client-facing)
router.get("/gallery/:id", (req, res) => {
  try {
    const db = getDb();
    const gallery = db.prepare("SELECT * FROM photography_galleries WHERE id=?").get(req.params.id);
    if (!gallery) return res.status(404).send("<h1>Gallery not found</h1>");
    if (gallery.expires_at && new Date(gallery.expires_at) < new Date()) return res.status(410).send("<h1>This gallery has expired</h1>");
    if (gallery.password && req.query.pw !== gallery.password) {
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gallery Access</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa}form{background:#fff;padding:32px;border-radius:16px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.1)}input{display:block;width:100%;padding:10px;border:1px solid #E2E8F0;border-radius:8px;margin:12px 0}button{width:100%;padding:12px;background:#2563EB;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer}</style></head><body><form method="get"><h2>🔒 Gallery Access</h2><p>Enter the password to view this gallery</p><input type="password" name="pw" placeholder="Password"/><button>View Gallery</button></form></body></html>`);
    }
    const photos = JSON.parse(gallery.photos||"[]");
    // Log view
    try { db.prepare("UPDATE photography_galleries SET client_viewed_at=datetime('now') WHERE id=? AND client_viewed_at IS NULL").run(gallery.id); } catch(e) { console.error("[/gallery/:id]", e.message || e); }
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${gallery.name}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#111;color:#fff;min-height:100vh}
.header{padding:20px 24px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center}
h1{font-size:18px;font-weight:700}.count{font-size:13px;color:#94A3B8}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:4px;padding:4px}
.photo{position:relative;aspect-ratio:3/2;overflow:hidden;cursor:pointer;background:#1a1a1a}
img{width:100%;height:100%;object-fit:cover;transition:transform .2s}
.photo:hover img{transform:scale(1.03)}
.watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.wm{color:rgba(255,255,255,.35);font-size:14px;font-weight:700;transform:rotate(-30deg);white-space:nowrap;text-shadow:1px 1px 2px rgba(0,0,0,.5);letter-spacing:2px;text-transform:uppercase}
.sel{position:absolute;top:8px;right:8px;width:28px;height:28px;border-radius:14px;border:2px solid #fff;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px}
.sel.checked{background:#2563EB;border-color:#2563EB}
.footer{position:sticky;bottom:0;background:#1a1a2e;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #333}
.submit-btn{padding:12px 28px;background:#2563EB;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:14px;font-family:inherit}
</style></head><body>
<div class="header"><h1>📸 ${gallery.name}</h1><span class="count">${photos.length} photos</span></div>
<div class="grid" id="grid">
${photos.map((p, i) => `<div class="photo" onclick="toggle(${i})">
  <img src="${p.url||p}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22200%22><rect fill=%22%23333%22 width=%22300%22 height=%22200%22/><text x=%2250%%22 y=%2250%%22 fill=%22%23666%22 font-size=%2220%22 text-anchor=%22middle%22 dy=%22.3em%22>Photo ${i+1}</text></svg>'"/>
  ${gallery.watermark ? `<div class="watermark"><div class="wm">${gallery.watermark_text||"PROOF"}</div></div>` : ""}
  <div class="sel" id="sel${i}">✓</div>
</div>`).join("")}
</div>
<div class="footer">
  <span id="selCount" style="color:#94A3B8;font-size:14px">0 photos selected</span>
  <button class="submit-btn" onclick="submitSelections()">Submit Selections</button>
</div>
<script>
const selected = new Set();
function toggle(i) {
  if (selected.has(i)) { selected.delete(i); document.getElementById('sel'+i).classList.remove('checked'); }
  else { selected.add(i); document.getElementById('sel'+i).classList.add('checked'); }
  document.getElementById('selCount').textContent = selected.size + ' photo' + (selected.size!==1?'s':'') + ' selected';
}
async function submitSelections() {
  if (selected.size === 0) { alert('Please select at least one photo'); return; }
  const r = await fetch('/api/extended/galleries/${gallery.id}/selections', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ selections: [...selected] })
  });
  if (r.ok) { document.querySelector('.footer').innerHTML = '<p style="color:#22C55E;font-weight:700">✅ Selections submitted! Your photographer will be in touch.</p>'; }
}
</script></body></html>`);
  } catch(e) { res.status(500).send("<h1>Error</h1>"); }
});

// Submit photo selections
router.post("/galleries/:id/selections", async (req, res) => {
  try {
    const db = getDb();
    const gallery = db.prepare("SELECT * FROM photography_galleries WHERE id=?").get(req.params.id);
    if (!gallery) return res.status(404).json({ error: "Not found" });
    const photos = JSON.parse(gallery.photos||"[]");
    const selectedPhotos = (req.body.selections||[]).map(i => photos[i]).filter(Boolean);
    db.prepare("UPDATE photography_galleries SET selected_photos=?,client_selections_at=datetime('now') WHERE id=?").run(JSON.stringify(selectedPhotos), gallery.id);
    // Notify photographer
    const site = db.prepare("SELECT name, user_id FROM sites WHERE user_id=? LIMIT 1").get(gallery.user_id);
    const owner = db.prepare("SELECT email FROM users WHERE id=?").get(gallery.user_id);
    if (owner?.email) {
      await evEmail(gallery.user_id, owner.email, `Gallery selections received — ${gallery.name}`,
        `<p>Your client has selected ${selectedPhotos.length} photos from <strong>${gallery.name}</strong>. Log in to MINE to review and deliver the finals.</p>`);
    }
    res.json({ success: true, selections_count: selectedPhotos.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  TUTORS / MUSIC TEACHERS / DRIVING INSTRUCTORS
// ════════════════════════════════════════════════════════════════════════════

router.get("/students", auth, (req, res) => {
  try {
    const db = getDb();
    const students = db.prepare("SELECT s.*, c.email, c.phone as contact_phone FROM student_profiles s LEFT JOIN contacts c ON c.id=s.contact_id WHERE s.user_id=? AND s.active=1 ORDER BY s.name").all(req.userId);
    res.json({ students });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/students", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, name, email, phone, subject, level, dob, goals, notes } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const id = uuid();
    db.prepare("INSERT INTO student_profiles (id,user_id,contact_id,name,email,phone,subject,level,dob,goals,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, name, email||"", phone||"", subject||"", level||"", dob||null, goals||"", notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/students/:id/progress", auth, (req, res) => {
  try {
    const db = getDb();
    const progress = db.prepare("SELECT * FROM student_progress WHERE user_id=? AND student_id=? ORDER BY session_date DESC LIMIT 20").all(req.userId, req.params.id);
    const terms = db.prepare("SELECT * FROM term_enrolments WHERE user_id=? AND student_id=? ORDER BY start_date DESC").all(req.userId, req.params.id);
    res.json({ progress, terms });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/students/:id/progress", auth, (req, res) => {
  try {
    const db = getDb();
    const { session_date, subject, topic, rating, notes, homework, next_focus } = req.body;
    if (!session_date) return res.status(400).json({ error: "session_date required" });
    const id = uuid();
    db.prepare("INSERT INTO student_progress (id,user_id,student_id,session_date,subject,topic,rating,notes,homework,next_focus) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, req.params.id, session_date, subject||"", topic||"", rating||3, notes||"", homework||"", next_focus||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/term-enrolments", auth, async (req, res) => {
  try {
    const db = getDb();
    const { student_id, term_name, start_date, end_date, lessons_per_week, lesson_duration, rate_per_lesson } = req.body;
    if (!student_id || !term_name) return res.status(400).json({ error: "student_id and term_name required" });
    const student = db.prepare("SELECT * FROM student_profiles WHERE id=? AND user_id=?").get(student_id, req.userId);
    if (!student) return res.status(404).json({ error: "Student not found" });
    // Calculate total lessons and price
    let totalLessons = 0;
    if (start_date && end_date) {
      const weeks = Math.ceil((new Date(end_date) - new Date(start_date)) / (7*86400000));
      totalLessons = weeks * (lessons_per_week||1);
    }
    const totalPrice = totalLessons * (rate_per_lesson||0);
    const id = uuid();
    db.prepare(`INSERT INTO term_enrolments (id,user_id,student_id,term_name,start_date,end_date,lessons_per_week,lesson_duration,rate_per_lesson,total_lessons,total_price,status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, student_id, term_name, start_date||null, end_date||null,
           lessons_per_week||1, lesson_duration||60, rate_per_lesson||0, totalLessons, totalPrice, "active");
    // Create invoice for the term
    if (totalPrice > 0 && student.email) {
      const invId = uuid();
      const invNum = `TERM-${Date.now().toString().slice(-6)}`;
      const dueDate = start_date || new Date().toISOString().split("T")[0];
      db.prepare("INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,items_json,subtotal,tax,total,status,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(invId, req.userId, invNum, student.name, student.email,
             JSON.stringify([{ description: `${term_name} — ${totalLessons} lessons × ${lesson_duration}min @ $${rate_per_lesson}`, amount: totalPrice }]),
             totalPrice, 0, totalPrice, "sent", dueDate);
      db.prepare("UPDATE term_enrolments SET invoice_id=? WHERE id=?").run(invId, id);
      await evEmail(req.userId, student.email, `Invoice for ${term_name}`,
        `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px"><h2>Term Invoice ${invNum}</h2><p>Hi ${student.name},</p><p>${term_name}: ${totalLessons} lessons × $${rate_per_lesson} = <strong>$${totalPrice}</strong></p><p>Due: ${dueDate}</p></div>`);
    }
    res.json({ success: true, id, total_lessons: totalLessons, total_price: totalPrice });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  EVENT VENUES
// ════════════════════════════════════════════════════════════════════════════

router.get("/event-vendors/:eventId", auth, (req, res) => {
  try {
    const db = getDb();
    const vendors = db.prepare("SELECT * FROM event_vendors WHERE user_id=? AND event_id=? ORDER BY category,name").all(req.userId, req.params.eventId);
    res.json({ vendors });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/event-vendors", auth, (req, res) => {
  try {
    const db = getDb();
    const { event_id, name, category, contact_name, email, phone, contract_status, cost, deposit_paid, notes } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const id = uuid();
    db.prepare("INSERT INTO event_vendors (id,user_id,event_id,name,category,contact_name,email,phone,contract_status,cost,deposit_paid,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, event_id||null, name, category||"other", contact_name||"", email||"", phone||"", contract_status||"enquired", cost||0, deposit_paid||0, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/event-vendors/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, category, contract_status, cost, deposit_paid, notes, confirmed } = req.body;
    db.prepare("UPDATE event_vendors SET name=?,category=?,contract_status=?,cost=?,deposit_paid=?,notes=?,confirmed=? WHERE id=? AND user_id=?")
      .run(name, category, contract_status, cost, deposit_paid, notes, confirmed?1:0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/event-timeline/:eventId", auth, (req, res) => {
  try {
    const db = getDb();
    const items = db.prepare("SELECT * FROM event_timelines WHERE user_id=? AND event_id=? ORDER BY time").all(req.userId, req.params.eventId);
    res.json({ timeline: items });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/event-timeline", auth, (req, res) => {
  try {
    const db = getDb();
    const { event_id, time, title, description, location, responsible, duration_minutes, category } = req.body;
    if (!event_id || !time || !title) return res.status(400).json({ error: "event_id, time, title required" });
    const id = uuid();
    db.prepare("INSERT INTO event_timelines (id,user_id,event_id,time,title,description,location,responsible,duration_minutes,category) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, event_id, time, title, description||"", location||"", responsible||"", duration_minutes||30, category||"general");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/event-timeline/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { time, title, description, location, responsible, duration_minutes, completed } = req.body;
    db.prepare("UPDATE event_timelines SET time=?,title=?,description=?,location=?,responsible=?,duration_minutes=?,completed=? WHERE id=? AND user_id=?")
      .run(time, title, description, location, responsible, duration_minutes, completed?1:0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/event-timeline/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM event_timelines WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  IT SUPPORT / MSPs
// ════════════════════════════════════════════════════════════════════════════

router.get("/retainers", auth, (req, res) => {
  try {
    const db = getDb();
    const retainers = db.prepare(`SELECT r.*, c.name as client_name, c.email as client_email
      FROM support_retainers r LEFT JOIN contacts c ON c.id=r.contact_id
      WHERE r.user_id=? AND r.status='active' ORDER BY c.name`).all(req.userId);
    res.json({ retainers });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/retainers", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, name, hours_per_month, rate_per_hour, sla_response_hours, sla_resolution_hours, billing_day } = req.body;
    if (!contact_id || !name) return res.status(400).json({ error: "contact_id and name required" });
    const monthly = (hours_per_month||10) * (rate_per_hour||0);
    const id = uuid();
    db.prepare(`INSERT INTO support_retainers (id,user_id,contact_id,name,hours_per_month,rate_per_hour,monthly_price,sla_response_hours,sla_resolution_hours,billing_day,started_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(id, req.userId, contact_id, name, hours_per_month||10, rate_per_hour||0, monthly, sla_response_hours||24, sla_resolution_hours||72, billing_day||1);
    res.json({ success: true, id, monthly_price: monthly });
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
    const newHours = (retainer.hours_used_this_month||0) + parseFloat(hours);
    db.prepare("UPDATE support_retainers SET hours_used_this_month=? WHERE id=?").run(newHours, retainer.id);
    // Add time entry
    const tid = uuid();
    try {
      db.prepare("INSERT INTO time_entries (id,user_id,contact_id,client_name,description,date,duration_minutes,hourly_rate,billable,invoiced) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(tid, req.userId, retainer.contact_id, null, description||"Retainer support", new Date().toISOString().split("T")[0],
             Math.round(parseFloat(hours)*60), retainer.rate_per_hour||0, 0, 1);
    } catch(e) {}
    const remaining = retainer.hours_per_month - newHours;
    return res.json({ success: true, hours_used: newHours, hours_remaining: Math.max(0, remaining), overage: remaining < 0 ? Math.abs(remaining) : 0 });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Reset monthly hours (run on billing day)
router.post("/retainers/:id/reset-month", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE support_retainers SET hours_used_this_month=0 WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  AUTO MECHANICS
// ════════════════════════════════════════════════════════════════════════════

router.get("/vehicles", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id } = req.query;
    let q = `SELECT v.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone
             FROM vehicle_profiles v LEFT JOIN contacts c ON c.id=v.contact_id
             WHERE v.user_id=? AND v.active=1`;
    const params = [req.userId];
    if (contact_id) { q += " AND v.contact_id=?"; params.push(contact_id); }
    q += " ORDER BY v.make, v.model";
    const vehicles = db.prepare(q).all(...params);
    const today = new Date().toISOString().split("T")[0];
    res.json({ vehicles: vehicles.map(v => ({ ...v, wof_overdue: v.wof_due && v.wof_due < today, rego_overdue: v.rego_due && v.rego_due < today, service_overdue: v.service_due && v.service_due < today })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/vehicles", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, rego, make, model, year, color, vin, engine, fuel_type, odometer, wof_due, rego_due, service_due, service_interval_km, notes } = req.body;
    if (!rego) return res.status(400).json({ error: "Registration number required" });
    const id = uuid();
    db.prepare(`INSERT INTO vehicle_profiles (id,user_id,contact_id,rego,make,model,year,color,vin,engine,fuel_type,odometer,wof_due,rego_due,service_due,service_interval_km,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id||null, rego.toUpperCase(), make||"", model||"", year||null, color||"", vin||"", engine||"", fuel_type||"petrol", odometer||null, wof_due||null, rego_due||null, service_due||null, service_interval_km||10000, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/vehicles/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { make, model, year, color, vin, engine, fuel_type, odometer, wof_due, rego_due, service_due, notes } = req.body;
    db.prepare("UPDATE vehicle_profiles SET make=?,model=?,year=?,color=?,vin=?,engine=?,fuel_type=?,odometer=?,wof_due=?,rego_due=?,service_due=?,notes=? WHERE id=? AND user_id=?")
      .run(make, model, year, color, vin, engine, fuel_type, odometer, wof_due, rego_due, service_due, notes, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/vehicles/due", auth, (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const next30 = new Date(Date.now()+30*86400000).toISOString().split("T")[0];
    const due = db.prepare(`SELECT v.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone
      FROM vehicle_profiles v LEFT JOIN contacts c ON c.id=v.contact_id
      WHERE v.user_id=? AND v.active=1 AND (
        (v.wof_due IS NOT NULL AND v.wof_due<=?) OR
        (v.rego_due IS NOT NULL AND v.rego_due<=?) OR
        (v.service_due IS NOT NULL AND v.service_due<=?)
      ) ORDER BY COALESCE(v.wof_due,v.rego_due,v.service_due) ASC`).all(req.userId, next30, next30, next30);
    res.json({ due, count: due.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/vehicles/:id/history", auth, (req, res) => {
  try {
    const db = getDb();
    const history = db.prepare("SELECT * FROM vehicle_service_history WHERE vehicle_id=? AND user_id=? ORDER BY service_date DESC").all(req.params.id, req.userId);
    res.json({ history });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/vehicles/:id/service", auth, (req, res) => {
  try {
    const db = getDb();
    const { service_date, odometer, description, parts_cost, labour_cost, technician } = req.body;
    if (!service_date || !description) return res.status(400).json({ error: "service_date and description required" });
    // IDOR fix: verify the vehicle profile belongs to this user
    const ownedVehicle = db.prepare("SELECT id FROM vehicle_profiles WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!ownedVehicle) return res.status(404).json({ error: "Vehicle not found" });
    const total = (parts_cost||0) + (labour_cost||0);
    const id = uuid();
    db.prepare("INSERT INTO vehicle_service_history (id,user_id,vehicle_id,service_date,odometer,description,parts_cost,labour_cost,total_cost,technician) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, req.params.id, service_date, odometer||null, description, parts_cost||0, labour_cost||0, total, technician||"");
    // Update odometer and service_due on vehicle
    if (odometer) db.prepare("UPDATE vehicle_profiles SET odometer=? WHERE id=?").run(odometer, req.params.id);
    res.json({ success: true, id, total });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Parts inventory
router.get("/parts", auth, (req, res) => {
  try {
    const db = getDb();
    const parts = db.prepare("SELECT * FROM parts_inventory WHERE user_id=? ORDER BY name").all(req.userId);
    res.json({ parts });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/parts", auth, (req, res) => {
  try {
    const db = getDb();
    const { part_number, name, description, category, supplier, cost_price, sell_price, markup_pct, stock_qty, min_stock, location } = req.body;
    if (!name) return res.status(400).json({ error: "Part name required" });
    const sell = sell_price || Math.round((cost_price||0) * (1 + ((markup_pct||30)/100)) * 100) / 100;
    const id = uuid();
    db.prepare("INSERT INTO parts_inventory (id,user_id,part_number,name,description,category,supplier,cost_price,sell_price,markup_pct,stock_qty,min_stock,location) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, part_number||"", name, description||"", category||"", supplier||"", cost_price||0, sell, markup_pct||30, stock_qty||0, min_stock||0, location||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/parts/:id/stock", auth, (req, res) => {
  try {
    const db = getDb();
    const { adjustment, reason } = req.body;
    db.prepare("UPDATE parts_inventory SET stock_qty=MAX(0,stock_qty+?) WHERE id=? AND user_id=?").run(parseInt(adjustment)||0, req.params.id, req.userId);
    const part = db.prepare("SELECT name, stock_qty, min_stock FROM parts_inventory WHERE id=?").get(req.params.id);
    res.json({ success: true, new_qty: part?.stock_qty, low_stock: part && part.stock_qty <= part.min_stock });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  CHILDCARE
// ════════════════════════════════════════════════════════════════════════════

router.get("/children", auth, (req, res) => {
  try {
    const db = getDb();
    const children = db.prepare(`SELECT ch.*, c.name as parent_name, c.email as parent_email, c.phone as parent_phone
      FROM child_profiles ch LEFT JOIN contacts c ON c.id=ch.parent_contact_id
      WHERE ch.user_id=? AND ch.status='enrolled' ORDER BY ch.name`).all(req.userId);
    res.json({ children });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/children", auth, (req, res) => {
  try {
    const db = getDb();
    const { parent_contact_id, name, dob, gender, room_group, allergies, medical_notes, dietary_notes, emergency_contact, emergency_phone, start_date, immunisation_status } = req.body;
    if (!name) return res.status(400).json({ error: "Child name required" });
    const id = uuid();
    db.prepare(`INSERT INTO child_profiles (id,user_id,parent_contact_id,name,dob,gender,room_group,allergies,medical_notes,dietary_notes,emergency_contact,emergency_phone,start_date,immunisation_status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, parent_contact_id||null, name, dob||null, gender||"", room_group||"", allergies||"", medical_notes||"", dietary_notes||"", emergency_contact||"", emergency_phone||"", start_date||new Date().toISOString().split("T")[0], immunisation_status||"up-to-date");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/attendance/:date", auth, (req, res) => {
  try {
    const db = getDb();
    const records = db.prepare(`SELECT ca.*, ch.name as child_name, ch.room_group, ch.allergies, ch.medical_notes
      FROM child_attendance ca RIGHT JOIN child_profiles ch ON ch.id=ca.child_id
      WHERE ch.user_id=? AND ch.status='enrolled' AND (ca.date=? OR ca.date IS NULL)
      ORDER BY ch.room_group, ch.name`).all(req.userId, req.params.date);
    const total = records.length;
    const present = records.filter(r => r.check_in && !r.absent).length;
    res.json({ records, date: req.params.date, total_enrolled: total, present, absent: total - present });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/attendance", auth, (req, res) => {
  try {
    const db = getDb();
    const { child_id, date, check_in, check_out, checked_in_by, checked_out_by, absent, absent_reason, notes } = req.body;
    if (!child_id || !date) return res.status(400).json({ error: "child_id and date required" });
    const id = uuid();
    db.prepare(`INSERT OR REPLACE INTO child_attendance (id,user_id,child_id,date,check_in,check_out,checked_in_by,checked_out_by,absent,absent_reason,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, child_id, date, check_in||null, check_out||null, checked_in_by||"", checked_out_by||"", absent?1:0, absent_reason||"", notes||"");
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  MORTGAGE BROKERS
// ════════════════════════════════════════════════════════════════════════════

router.get("/mortgages", auth, (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    let q = `SELECT m.*, c.name as client_name, c.email as client_email FROM mortgage_applications m LEFT JOIN contacts c ON c.id=m.contact_id WHERE m.user_id=?`;
    const params = [req.userId];
    if (status) { q += " AND m.status=?"; params.push(status); }
    q += " ORDER BY m.created_at DESC";
    const apps = db.prepare(q).all(...params);
    res.json({ applications: apps.map(a => ({ ...a, documents: JSON.parse(a.documents||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/mortgages", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, application_type, loan_amount, property_value, lender, product, interest_rate, term_years, notes } = req.body;
    if (!contact_id) return res.status(400).json({ error: "contact_id required" });
    const id = uuid();
    db.prepare(`INSERT INTO mortgage_applications (id,user_id,contact_id,application_type,loan_amount,property_value,lender,product,interest_rate,term_years,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id, application_type||"purchase", loan_amount||0, property_value||0, lender||"", product||"", interest_rate||null, term_years||30, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/mortgages/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, stage, lender, product, interest_rate, settlement_date, compliance_checked, privacy_consent, notes, internal_notes, documents } = req.body;
    db.prepare(`UPDATE mortgage_applications SET status=?,stage=?,lender=?,product=?,interest_rate=?,settlement_date=?,compliance_checked=?,privacy_consent=?,notes=?,internal_notes=?,documents=?,updated_at=datetime('now') WHERE id=? AND user_id=?`)
      .run(status, stage, lender, product, interest_rate, settlement_date, compliance_checked?1:0, privacy_consent?1:0, notes, internal_notes, JSON.stringify(documents||[]), req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  FLORISTS & GIFT SHOPS
// ════════════════════════════════════════════════════════════════════════════

router.get("/floral-orders", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, from } = req.query;
    let q = `SELECT fo.*, c.name as client_name, c.email as client_email FROM floral_orders fo LEFT JOIN contacts c ON c.id=fo.contact_id WHERE fo.user_id=?`;
    const params = [req.userId];
    if (status) { q += " AND fo.status=?"; params.push(status); }
    if (from) { q += " AND fo.delivery_date>=?"; params.push(from); }
    q += " ORDER BY fo.delivery_date ASC, fo.delivery_time ASC";
    const orders = db.prepare(q).all(...params);
    res.json({ orders });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/floral-orders", auth, async (req, res) => {
  try {
    const db = getDb();
    const { contact_id, occasion, arrangement_type, size, flowers, colors, message, delivery_date, delivery_time, delivery_address, delivery_type, price, florist_notes } = req.body;
    if (!delivery_date) return res.status(400).json({ error: "delivery_date required" });
    const id = uuid();
    db.prepare(`INSERT INTO floral_orders (id,user_id,contact_id,occasion,arrangement_type,size,flowers,colors,message,delivery_date,delivery_time,delivery_address,delivery_type,price,florist_notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id||null, occasion||"", arrangement_type||"", size||"medium", flowers||"", colors||"", message||"", delivery_date, delivery_time||"", delivery_address||"", delivery_type||"delivery", price||0, florist_notes||"");
    // Auto-set occasion reminder for next year
    if (occasion && contact_id && delivery_date) {
      const nextYear = new Date(delivery_date);
      nextYear.setFullYear(nextYear.getFullYear()+1);
      nextYear.setDate(nextYear.getDate()-14); // 2 weeks before
      try {
        db.prepare("INSERT OR IGNORE INTO occasion_reminders (id,user_id,contact_id,occasion,reminder_date) VALUES (?,?,?,?,?)")
          .run(uuid(), req.userId, contact_id, occasion, nextYear.toISOString().split("T")[0]);
      } catch(e) {}
    }
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/floral-orders/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, florist_notes, price } = req.body;
    db.prepare("UPDATE floral_orders SET status=?,florist_notes=?,price=? WHERE id=? AND user_id=?").run(status, florist_notes, price, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Upcoming occasion reminders
router.get("/occasion-reminders", auth, (req, res) => {
  try {
    const db = getDb();
    const next30 = new Date(Date.now()+30*86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const reminders = db.prepare(`SELECT r.*, c.name as client_name, c.email as client_email, c.phone as client_phone
      FROM occasion_reminders r LEFT JOIN contacts c ON c.id=r.contact_id
      WHERE r.user_id=? AND r.sent=0 AND r.reminder_date>=? AND r.reminder_date<=?
      ORDER BY r.reminder_date`).all(req.userId, today, next30);
    res.json({ reminders, count: reminders.length });
  } catch(e) { res.json({ reminders: [], count: 0 }); }
});

module.exports = router;
