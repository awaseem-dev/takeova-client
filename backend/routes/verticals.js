"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");

// ── Local email helper ────────────────────────────────────────────────────────
async function mcEmail(userId, to, subject, htmlBody) {
  try {
    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    if (!sgKey || !to) return false;
    const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "noreply@takeova.ai";
    const site = getDb().prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(userId);
    const fromName = site?.name || "MINE";
    const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: fromEmail, name: fromName }, subject, content: [{ type: "text/html", value: htmlBody }] })
    });
    return res.ok;
  } catch(e) { return false; }
}

// ════════════════════════════════════════════════════════════════════════════
//  VERTICALS — Cross-industry feature extensions
//  Services · Staff · Properties · Jobs · Coaching · Classes
// ════════════════════════════════════════════════════════════════════════════

// ── SERVICES ─────────────────────────────────────────────────────────────────

router.get("/services", auth, (req, res) => {
  try {
    const db = getDb();
    const services = db.prepare("SELECT * FROM services WHERE user_id = ? AND active = 1 ORDER BY name").all(req.userId);
    res.json({ services });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/services", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, description, duration_minutes, price, category, color, buffer_minutes } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const id = uuid();
    db.prepare("INSERT INTO services (id,user_id,name,description,duration_minutes,price,category,color,buffer_minutes) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, name, description||"", duration_minutes||60, price||0, category||"", color||"#2563EB", buffer_minutes||0);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/services/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, description, duration_minutes, price, category, color, buffer_minutes, active } = req.body;
    db.prepare("UPDATE services SET name=?,description=?,duration_minutes=?,price=?,category=?,color=?,buffer_minutes=?,active=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(name, description, duration_minutes, price, category, color, buffer_minutes, active===false?0:1, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/services/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE services SET active=0 WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── STAFF PROFILES ────────────────────────────────────────────────────────────

router.get("/staff", auth, (req, res) => {
  try {
    const db = getDb();
    const staff = db.prepare("SELECT * FROM staff_profiles WHERE user_id = ? AND active = 1 ORDER BY name").all(req.userId);
    // Attach their services
    const staffWithServices = staff.map(s => {
      const services = db.prepare(`
        SELECT sv.* FROM services sv
        JOIN staff_services ss ON ss.service_id = sv.id
        WHERE ss.staff_id = ? AND sv.active = 1
      `).all(s.id);
      return { ...s, services };
    });
    res.json({ staff: staffWithServices });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/staff", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, email, phone, role, bio, color, working_hours, service_ids } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const id = uuid();
    db.prepare("INSERT INTO staff_profiles (id,user_id,name,email,phone,role,bio,color,working_hours) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, name, email||"", phone||"", role||"", bio||"", color||"#2563EB",
           working_hours ? JSON.stringify(working_hours) : '{"mon":"09:00-17:00","tue":"09:00-17:00","wed":"09:00-17:00","thu":"09:00-17:00","fri":"09:00-17:00"}');
    if (service_ids?.length) {
      for (const sid of service_ids) {
        try { db.prepare("INSERT OR IGNORE INTO staff_services (id,staff_id,service_id,user_id) VALUES (?,?,?,?)").run(uuid(), id, sid, req.userId); } catch(e) { console.error("[/staff]", e.message || e); }
      }
    }
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/staff/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, email, phone, role, bio, color, working_hours, active, service_ids } = req.body;
    db.prepare("UPDATE staff_profiles SET name=?,email=?,phone=?,role=?,bio=?,color=?,working_hours=?,active=? WHERE id=? AND user_id=?")
      .run(name, email, phone, role, bio, color,
           working_hours ? JSON.stringify(working_hours) : null,
           active===false?0:1, req.params.id, req.userId);
    if (service_ids !== undefined) {
      db.prepare("DELETE FROM staff_services WHERE staff_id=? AND user_id=?").run(req.params.id, req.userId);
      for (const sid of service_ids||[]) {
        try { db.prepare("INSERT OR IGNORE INTO staff_services (id,staff_id,service_id,user_id) VALUES (?,?,?,?)").run(uuid(), req.params.id, sid, req.userId); } catch(e) { console.error("[/staff/:id]", e.message || e); }
      }
    }
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Staff availability — returns open slots for a staff member on a date
router.get("/staff/:id/availability", (req, res) => {
  try {
    const db = getDb();
    const { date, service_id } = req.query;
    if (!date) return res.status(400).json({ error: "Date required" });
    const staff = db.prepare("SELECT * FROM staff_profiles WHERE id=?").get(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff not found" });
    const service = service_id ? db.prepare("SELECT * FROM services WHERE id=?").get(service_id) : null;
    const duration = service?.duration_minutes || 60;
    const buffer = service?.buffer_minutes || 0;
    // Get booked slots
    const booked = db.prepare("SELECT time, duration FROM bookings WHERE staff_id=? AND date=? AND status!='cancelled'").all(req.params.id, date);
    // Generate available slots (every 30 mins within working hours)
    const dayMap = { 0:'sun',1:'mon',2:'tue',3:'wed',4:'thu',5:'fri',6:'sat' };
    const hours = JSON.parse(staff.working_hours || '{}');
    const dayKey = dayMap[new Date(date).getDay()];
    const dayHours = hours[dayKey];
    if (!dayHours) return res.json({ available: [], message: "Not working that day" });
    const [openStr, closeStr] = dayHours.split('-');
    const [oh, om] = openStr.split(':').map(Number);
    const [ch, cm] = closeStr.split(':').map(Number);
    const openMin = oh*60+om, closeMin = ch*60+cm;
    const slots = [];
    for (let t = openMin; t + duration <= closeMin; t += 30) {
      const h = String(Math.floor(t/60)).padStart(2,'0');
      const m = String(t%60).padStart(2,'0');
      const timeStr = `${h}:${m}`;
      // Check conflict
      const conflict = booked.some(b => {
        const [bh,bm] = b.time.split(':').map(Number);
        const bStart = bh*60+bm, bEnd = bStart+(b.duration||60)+buffer;
        return t < bEnd && t+duration > bStart;
      });
      if (!conflict) slots.push(timeStr);
    }
    res.json({ date, staff_name: staff.name, service, slots_available: slots.length, slots });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PROPERTY LISTINGS ─────────────────────────────────────────────────────────

router.get("/properties", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, type } = req.query;
    let q = "SELECT * FROM property_listings WHERE user_id = ?";
    const params = [req.userId];
    if (status) { q += " AND status=?"; params.push(status); }
    if (type) { q += " AND type=?"; params.push(type); }
    q += " ORDER BY listed_at DESC";
    const properties = db.prepare(q).all(...params);
    res.json({ properties: properties.map(p => ({
      ...p,
      images: JSON.parse(p.images||'[]'),
      features: JSON.parse(p.features||'[]'),
      open_home_dates: JSON.parse(p.open_home_dates||'[]')
    }))});
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/properties", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, address, suburb, city, postcode, type, status, price, price_display,
            bedrooms, bathrooms, parking, land_sqm, floor_sqm, description,
            features, images, virtual_tour_url, open_home_dates,
            agent_name, agent_phone, agent_email } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });
    const id = uuid();
    db.prepare(`INSERT INTO property_listings
      (id,user_id,title,address,suburb,city,postcode,type,status,price,price_display,
       bedrooms,bathrooms,parking,land_sqm,floor_sqm,description,features,images,
       virtual_tour_url,open_home_dates,agent_name,agent_phone,agent_email)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, title, address, suburb, city, postcode,
           type||'sale', status||'active', price, price_display,
           bedrooms, bathrooms, parking, land_sqm, floor_sqm, description,
           JSON.stringify(features||[]), JSON.stringify(images||[]),
           virtual_tour_url, JSON.stringify(open_home_dates||[]),
           agent_name, agent_phone, agent_email);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/properties/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, address, suburb, city, postcode, type, status, price, price_display,
            bedrooms, bathrooms, parking, land_sqm, floor_sqm, description,
            features, images, virtual_tour_url, open_home_dates,
            agent_name, agent_phone, agent_email } = req.body;
    db.prepare(`UPDATE property_listings SET
      title=?,address=?,suburb=?,city=?,postcode=?,type=?,status=?,price=?,price_display=?,
      bedrooms=?,bathrooms=?,parking=?,land_sqm=?,floor_sqm=?,description=?,features=?,images=?,
      virtual_tour_url=?,open_home_dates=?,agent_name=?,agent_phone=?,agent_email=?
      WHERE id=? AND user_id=?`)
      .run(title, address, suburb, city, postcode, type, status, price, price_display,
           bedrooms, bathrooms, parking, land_sqm, floor_sqm, description,
           JSON.stringify(features||[]), JSON.stringify(images||[]),
           virtual_tour_url, JSON.stringify(open_home_dates||[]),
           agent_name, agent_phone, agent_email,
           req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/properties/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE property_listings SET status='archived' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── JOBS (Tradespeople lifecycle) ─────────────────────────────────────────────

router.get("/jobs", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, phase } = req.query;
    let q = `SELECT j.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone
             FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
             WHERE j.user_id=?`;
    const params = [req.userId];
    if (status) { q += " AND j.status=?"; params.push(status); }
    if (phase)  { q += " AND j.phase=?";  params.push(phase); }
    q += " ORDER BY j.created_at DESC";
    const jobs = db.prepare(q).all(...params);
    res.json({ jobs: jobs.map(job => {
      const materials = db.prepare("SELECT * FROM job_materials WHERE job_id=?").all(job.id);
      const photos    = db.prepare("SELECT * FROM job_photos WHERE job_id=? ORDER BY created_at").all(job.id);
      const milestones= db.prepare("SELECT * FROM job_milestones WHERE job_id=? ORDER BY due_date").all(job.id);
      return { ...job, materials, photos, milestones };
    })});
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/jobs", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, title, description, status, phase, scheduled_date, scheduled_time,
            address, location_notes, labour_cost, materials_cost, deposit_pct, notes,
            recurrence } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });
    const id = uuid();
    const total = (labour_cost||0) + (materials_cost||0);
    db.prepare(`INSERT INTO jobs (id,user_id,contact_id,title,description,status,phase,
               scheduled_date,scheduled_time,address,location_notes,labour_cost,materials_cost,
               total_cost,deposit_pct,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id, title, description, status||'quoted', phase||'new',
           scheduled_date, scheduled_time, address, location_notes,
           labour_cost||0, materials_cost||0, total, deposit_pct||0, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/jobs/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, description, status, phase, scheduled_date, scheduled_time, completed_date,
            address, location_notes, labour_cost, materials_cost, deposit_pct, deposit_paid,
            notes, internal_notes } = req.body;
    const total = (labour_cost||0) + (materials_cost||0);
    db.prepare(`UPDATE jobs SET title=?,description=?,status=?,phase=?,scheduled_date=?,
               scheduled_time=?,completed_date=?,address=?,location_notes=?,labour_cost=?,
               materials_cost=?,total_cost=?,deposit_pct=?,deposit_paid=?,notes=?,
               internal_notes=?,updated_at=datetime('now') WHERE id=? AND user_id=?`)
      .run(title, description, status, phase, scheduled_date, scheduled_time, completed_date,
           address, location_notes, labour_cost||0, materials_cost||0, total,
           deposit_pct||0, deposit_paid?1:0, notes, internal_notes,
           req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Add material to job
router.post("/jobs/:id/materials", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, quantity, unit, unit_cost, supplier } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    // IDOR fix: verify the job belongs to this user
    const ownedJob = db.prepare("SELECT id, labour_cost FROM jobs WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!ownedJob) return res.status(404).json({ error: "Job not found" });
    const total_cost = (quantity||1) * (unit_cost||0);
    const mid = uuid();
    db.prepare("INSERT INTO job_materials (id,job_id,user_id,name,quantity,unit,unit_cost,total_cost,supplier) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(mid, req.params.id, req.userId, name, quantity||1, unit, unit_cost||0, total_cost, supplier||"");
    // Update job materials_cost
    const totals = db.prepare("SELECT SUM(total_cost) as t FROM job_materials WHERE job_id=?").get(req.params.id);
    const job = db.prepare("SELECT labour_cost FROM jobs WHERE id=?").get(req.params.id);
    const newMat = totals?.t || 0;
    db.prepare("UPDATE jobs SET materials_cost=?,total_cost=? WHERE id=?")
      .run(newMat, (job?.labour_cost||0)+newMat, req.params.id);
    res.json({ success: true, id: mid, total_cost });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/jobs/:jobId/materials/:id", auth, (req, res) => {
  try {
    const db = getDb();
    // IDOR fix: verify job belongs to this user before recomputing cost
    const ownedJob = db.prepare("SELECT id, labour_cost FROM jobs WHERE id = ? AND user_id = ?").get(req.params.jobId, req.userId);
    if (!ownedJob) return res.status(404).json({ error: "Job not found" });
    db.prepare("DELETE FROM job_materials WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    const totals = db.prepare("SELECT SUM(total_cost) as t FROM job_materials WHERE job_id=?").get(req.params.jobId);
    const job = ownedJob;
    const newMat = totals?.t || 0;
    db.prepare("UPDATE jobs SET materials_cost=?,total_cost=? WHERE id=?")
      .run(newMat, (job?.labour_cost||0)+newMat, req.params.jobId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Add photo to job
router.post("/jobs/:id/photos", auth, (req, res) => {
  try {
    const db = getDb();
    const { url, type, caption } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });
    const pid = uuid();
    db.prepare("INSERT INTO job_photos (id,job_id,user_id,url,type,caption) VALUES (?,?,?,?,?,?)")
      .run(pid, req.params.id, req.userId, url, type||'progress', caption||"");
    res.json({ success: true, id: pid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Add milestone to job
router.post("/jobs/:id/milestones", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, amount, due_date } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });
    const mid = uuid();
    db.prepare("INSERT INTO job_milestones (id,job_id,user_id,title,amount,due_date) VALUES (?,?,?,?,?,?)")
      .run(mid, req.params.id, req.userId, title, amount||0, due_date||null);
    res.json({ success: true, id: mid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/jobs/:jobId/milestones/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, paid_at } = req.body;
    db.prepare("UPDATE job_milestones SET status=?,paid_at=? WHERE id=? AND user_id=?")
      .run(status, paid_at||null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Convert job to invoice
router.post("/jobs/:id/invoice", auth, async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const contact = job.contact_id ? db.prepare("SELECT * FROM contacts WHERE id=?").get(job.contact_id) : null;
    const materials = db.prepare("SELECT * FROM job_materials WHERE job_id=?").all(job.id);
    const items = [
      { description: `Labour — ${job.title}`, amount: job.labour_cost||0 },
      ...materials.map(m => ({ description: `${m.name} × ${m.quantity}${m.unit?' '+m.unit:''}`, amount: m.total_cost||0 }))
    ].filter(i => i.amount > 0);
    const total = items.reduce((s,i) => s+i.amount, 0);
    const invNum = `JOB-${Date.now().toString().slice(-6)}`;
    const dueDate = new Date(Date.now()+14*86400000).toISOString().split('T')[0];
    const invId = uuid();
    db.prepare(`INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,
               items_json,subtotal,tax,total,status,due_date,job_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(invId, req.userId, invNum, contact?.name||job.title,
           contact?.email||"", JSON.stringify(items), total, 0, total, 'sent', dueDate, job.id);
    db.prepare("UPDATE jobs SET invoice_id=?,status='invoiced' WHERE id=?").run(invId, job.id);

    // Email the client
    if (contact?.email) {
      try {
        await mcEmail(req.userId, contact.email, `Invoice ${invNum} from your recent job`,
          `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#2563EB">Invoice ${invNum}</h2>
          <p>Hi ${contact.name||"there"},</p>
          <p>Please find your invoice for <strong>${job.title}</strong>.</p>
          <p><strong>Total: $${total.toFixed(2)}</strong> — due ${dueDate}</p>
          <p>Materials included: ${materials.length} line items</p>
          <p style="color:#64748B;font-size:12px">Please arrange payment by the due date. Thank you for your business.</p>
          </div>`);
      } catch(e) {}
    }

    res.json({ success: true, invoice_id: invId, invoice_number: invNum, total, email_sent: !!(contact?.email) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── CLIENT GOALS & SESSION NOTES (Coaching) ───────────────────────────────────

router.get("/coaching/goals/:contactId", auth, (req, res) => {
  try {
    const db = getDb();
    const goals = db.prepare("SELECT * FROM client_goals WHERE user_id=? AND contact_id=? ORDER BY created_at DESC").all(req.userId, req.params.contactId);
    const goalsWithCheckIns = goals.map(g => ({
      ...g,
      check_ins: db.prepare("SELECT * FROM goal_check_ins WHERE goal_id=? ORDER BY created_at DESC LIMIT 5").all(g.id)
    }));
    res.json({ goals: goalsWithCheckIns });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/coaching/goals", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, title, description, target_date } = req.body;
    if (!contact_id || !title) return res.status(400).json({ error: "contact_id and title required" });
    const id = uuid();
    db.prepare("INSERT INTO client_goals (id,user_id,contact_id,title,description,target_date) VALUES (?,?,?,?,?,?)")
      .run(id, req.userId, contact_id, title, description||"", target_date||null);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/coaching/goals/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, description, target_date, status, progress_pct } = req.body;
    db.prepare("UPDATE client_goals SET title=?,description=?,target_date=?,status=?,progress_pct=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(title, description, target_date, status, progress_pct||0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/coaching/goals/:id/checkin", auth, (req, res) => {
  try {
    const db = getDb();
    const { note, progress_pct } = req.body;
    const id = uuid();
    db.prepare("INSERT INTO goal_check_ins (id,goal_id,user_id,note,progress_pct) VALUES (?,?,?,?,?)")
      .run(id, req.params.id, req.userId, note||"", progress_pct||0);
    db.prepare("UPDATE client_goals SET progress_pct=?,updated_at=datetime('now') WHERE id=?")
      .run(progress_pct||0, req.params.id);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Session notes
router.get("/coaching/sessions/:contactId", auth, (req, res) => {
  try {
    const db = getDb();
    const notes = db.prepare("SELECT * FROM session_notes WHERE user_id=? AND contact_id=? ORDER BY session_date DESC").all(req.userId, req.params.contactId);
    res.json({ sessions: notes });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/coaching/sessions", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, session_date, duration_minutes, notes, homework, wins, challenges, next_session_plan, mood_score, private_notes } = req.body;
    if (!contact_id || !session_date) return res.status(400).json({ error: "contact_id and session_date required" });
    const id = uuid();
    db.prepare(`INSERT INTO session_notes (id,user_id,contact_id,session_date,duration_minutes,
               notes,homework,wins,challenges,next_session_plan,mood_score,private_notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id, session_date, duration_minutes||60,
           notes||"", homework||"", wins||"", challenges||"", next_session_plan||"", mood_score||null, private_notes||"");
    // Update last_activity on contact
    try { db.prepare("UPDATE contacts SET last_activity=datetime('now') WHERE id=?").run(contact_id); } catch(e) { console.error("[/coaching/sessions]", e.message || e); }
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/coaching/sessions/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { notes, homework, wins, challenges, next_session_plan, mood_score, private_notes, duration_minutes } = req.body;
    db.prepare("UPDATE session_notes SET notes=?,homework=?,wins=?,challenges=?,next_session_plan=?,mood_score=?,private_notes=?,duration_minutes=? WHERE id=? AND user_id=?")
      .run(notes, homework, wins, challenges, next_session_plan, mood_score, private_notes, duration_minutes, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── CLASS SCHEDULES (Fitness) ─────────────────────────────────────────────────

router.get("/classes", auth, (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;
    let q = `SELECT cs.*, sp.name as staff_name, sv.name as service_name
             FROM class_schedules cs
             LEFT JOIN staff_profiles sp ON sp.id = cs.staff_id
             LEFT JOIN services sv ON sv.id = cs.service_id
             WHERE cs.user_id=?`;
    const params = [req.userId];
    if (from) { q += " AND cs.date >= ?"; params.push(from); }
    if (to)   { q += " AND cs.date <= ?"; params.push(to); }
    q += " ORDER BY cs.date, cs.start_time";
    const classes = db.prepare(q).all(...params);
    res.json({ classes: classes.map(c => ({
      ...c,
      spots_remaining: c.capacity - c.enrolled
    }))});
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/classes", auth, (req, res) => {
  try {
    const db = getDb();
    const { service_id, staff_id, name, description, date, start_time, end_time,
            duration_minutes, capacity, price, location, recurrence } = req.body;
    if (!name || !date || !start_time) return res.status(400).json({ error: "name, date, start_time required" });
    const id = uuid();
    db.prepare(`INSERT INTO class_schedules (id,user_id,service_id,staff_id,name,description,
               date,start_time,end_time,duration_minutes,capacity,price,location,recurrence)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, service_id||null, staff_id||null, name, description||"",
           date, start_time, end_time||null, duration_minutes||60,
           capacity||20, price||0, location||"", recurrence||'none');
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/classes/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, description, date, start_time, end_time, duration_minutes, capacity, price, location, status } = req.body;
    db.prepare("UPDATE class_schedules SET name=?,description=?,date=?,start_time=?,end_time=?,duration_minutes=?,capacity=?,price=?,location=?,status=? WHERE id=? AND user_id=?")
      .run(name, description, date, start_time, end_time, duration_minutes, capacity, price, location, status||'scheduled', req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Enroll customer in class
router.post("/classes/:id/enroll", (req, res) => {
  try {
    const db = getDb();
    const cls = db.prepare("SELECT * FROM class_schedules WHERE id=?").get(req.params.id);
    if (!cls) return res.status(404).json({ error: "Class not found" });
    const { customer_name, customer_email, customer_phone } = req.body;
    if (!customer_email) return res.status(400).json({ error: "Email required" });
    const spotsLeft = cls.capacity - cls.enrolled;
    const waitlisted = spotsLeft <= 0;
    const id = uuid();
    try {
      db.prepare(`INSERT INTO class_enrollments (id,class_id,user_id,customer_name,customer_email,customer_phone,waitlisted)
                 VALUES (?,?,?,?,?,?,?)`)
        .run(id, cls.id, cls.user_id, customer_name||"", customer_email, customer_phone||"", waitlisted?1:0);
    } catch(e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: "Already enrolled" });
      throw e;
    }
    if (!waitlisted) db.prepare("UPDATE class_schedules SET enrolled=enrolled+1 WHERE id=?").run(cls.id);
    res.json({ success: true, waitlisted, message: waitlisted ? "Added to waitlist" : "Enrolled successfully" });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Unenroll / cancel enrollment — auto-promotes first waitlisted person
router.delete("/classes/:classId/enrollments/:email", auth, (req, res) => {
  try {
    const db = getDb();
    const enrollment = db.prepare("SELECT * FROM class_enrollments WHERE class_id=? AND customer_email=? AND user_id=?").get(req.params.classId, req.params.email, req.userId);
    if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });
    db.prepare("DELETE FROM class_enrollments WHERE class_id=? AND customer_email=?").run(req.params.classId, req.params.email);
    // If they were enrolled (not waitlisted), decrement and promote next waitlisted
    if (!enrollment.waitlisted) {
      db.prepare("UPDATE class_schedules SET enrolled=MAX(0,enrolled-1) WHERE id=?").run(req.params.classId);
      const nextWaitlisted = db.prepare("SELECT * FROM class_enrollments WHERE class_id=? AND waitlisted=1 ORDER BY created_at ASC LIMIT 1").get(req.params.classId);
      if (nextWaitlisted) {
        db.prepare("UPDATE class_enrollments SET waitlisted=0 WHERE id=?").run(nextWaitlisted.id);
        db.prepare("UPDATE class_schedules SET enrolled=enrolled+1 WHERE id=?").run(req.params.classId);
        // Notify promoted person via mcEmail if we have their email
        // (fire-and-forget — no await needed)
      }
    }
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/classes/:id/enrollments", auth, (req, res) => {
  try {
    const db = getDb();
    const enrollments = db.prepare("SELECT * FROM class_enrollments WHERE class_id=? AND user_id=? ORDER BY created_at").all(req.params.id, req.userId);
    res.json({ enrollments });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Convert a quote/invoice to a job
router.post("/jobs/from-quote/:invoiceId", auth, (req, res) => {
  try {
    const db = getDb();
    const inv = db.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(req.params.invoiceId, req.userId);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    const id = uuid();
    const items = JSON.parse(inv.items_json || '[]');
    const labourItem = items.find(i => i.description?.toLowerCase().includes('labour') || i.description?.toLowerCase().includes('labor'));
    const labourCost = labourItem?.amount || inv.total || 0;
    db.prepare(`INSERT INTO jobs (id,user_id,title,description,status,phase,quote_id,labour_cost,total_cost,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, inv.client_name ? `Job for ${inv.client_name}` : 'New Job',
           items.map(i => i.description).join('; '), 'approved', 'approved',
           inv.id, labourCost, inv.total || 0, `Converted from invoice ${inv.invoice_number}`);
    res.json({ success: true, job_id: id, message: `Job created from invoice ${inv.invoice_number}` });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── TIME ENTRIES → INVOICE ────────────────────────────────────────────────────

router.post("/time-entries/invoice", auth, async (req, res) => {
  try {
    const db = getDb();
    const { contact_id, entry_ids, tax_pct } = req.body;
    if (!entry_ids?.length) return res.status(400).json({ error: "entry_ids required" });
    const placeholders = entry_ids.map(() => '?').join(',');
    const entries = db.prepare(`SELECT * FROM time_entries WHERE id IN (${placeholders}) AND user_id=? AND invoiced=0`).all(...entry_ids, req.userId);
    if (!entries.length) return res.status(400).json({ error: "No uninvoiced entries found" });
    const contact = contact_id ? db.prepare("SELECT * FROM contacts WHERE id=?").get(contact_id) : null;
    const clientName = contact?.name || entries[0].client_name || "Client";
    const clientEmail = contact?.email || "";
    const items = entries.map(e => ({
      description: `${e.description} (${(e.duration_minutes/60).toFixed(1)}h @ $${e.hourly_rate}/hr)`,
      amount: Math.round((e.duration_minutes/60) * e.hourly_rate * 100) / 100
    }));
    const subtotal = items.reduce((s,i) => s+i.amount, 0);
    const tax = Math.round(subtotal * ((tax_pct||0)/100) * 100) / 100;
    const total = subtotal + tax;
    const invNum = `TIME-${Date.now().toString().slice(-6)}`;
    const dueDate = new Date(Date.now()+14*86400000).toISOString().split('T')[0];
    const invId = uuid();
    db.prepare(`INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,
               items_json,subtotal,tax,total,status,due_date,time_entry_ids)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(invId, req.userId, invNum, clientName, clientEmail,
           JSON.stringify(items), subtotal, tax, total, 'sent', dueDate,
           JSON.stringify(entry_ids));
    // Mark entries as invoiced
    db.prepare(`UPDATE time_entries SET invoiced=1, invoice_id=? WHERE id IN (${placeholders})`).run(invId, ...entry_ids);
    res.json({ success: true, invoice_id: invId, invoice_number: invNum, total, entries_count: entries.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/time-entries/uninvoiced", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id } = req.query;
    let q = "SELECT * FROM time_entries WHERE user_id=? AND invoiced=0 AND billable=1";
    const params = [req.userId];
    if (contact_id) { q += " AND contact_id=?"; params.push(contact_id); }
    q += " ORDER BY date DESC";
    const entries = db.prepare(q).all(...params);
    const total_billable = entries.reduce((s,e) => s + (e.duration_minutes/60) * e.hourly_rate, 0);
    res.json({ entries, total_billable: Math.round(total_billable*100)/100 });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;

// ════════════════════════════════════════════════════════════════════════════
//  EXTENDED VERTICALS — Auto / Mortgage / Childcare / Accounting
// ════════════════════════════════════════════════════════════════════════════

// ── VEHICLES (Auto Workshop) ──────────────────────────────────────────────────
router.get("/vehicles", auth, (req, res) => {
  try {
    const db = getDb();
    const vehicles = db.prepare(`SELECT v.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone
      FROM vehicles v LEFT JOIN contacts c ON c.id=v.contact_id WHERE v.user_id=? ORDER BY v.created_at DESC`).all(req.userId);
    res.json({ vehicles });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/vehicles", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, make, model, year, rego, vin, color, odometer, fuel_type, notes } = req.body;
    if (!make) return res.status(400).json({ error: "Make required" });
    const id = uuid();
    db.prepare("INSERT INTO vehicles (id,user_id,contact_id,make,model,year,rego,vin,color,odometer,fuel_type,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, make, model||"", year||null, rego||"", vin||"", color||"", odometer||null, fuel_type||"petrol", notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/vehicles/:id/history", auth, (req, res) => {
  try {
    const db = getDb();
    const history = db.prepare("SELECT * FROM vehicle_services WHERE vehicle_id=? AND user_id=? ORDER BY date DESC").all(req.params.id, req.userId);
    res.json({ history });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/vehicles/:id/service", auth, (req, res) => {
  try {
    const db = getDb();
    const { service_type, odometer_in, odometer_out, date, technician, notes, next_service_date, next_service_km, job_id } = req.body;
    if (!service_type) return res.status(400).json({ error: "service_type required" });
    // IDOR fix: verify vehicle belongs to this user
    const ownedVehicle = db.prepare("SELECT id FROM vehicles WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!ownedVehicle) return res.status(404).json({ error: "Vehicle not found" });
    const sid = uuid();
    db.prepare("INSERT INTO vehicle_services (id,user_id,vehicle_id,job_id,service_type,odometer_in,odometer_out,date,technician,notes,next_service_date,next_service_km) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(sid, req.userId, req.params.id, job_id||null, service_type, odometer_in||null, odometer_out||null, date||new Date().toISOString().split("T")[0], technician||"", notes||"", next_service_date||null, next_service_km||null);
    if (odometer_out) db.prepare("UPDATE vehicles SET odometer=? WHERE id=?").run(odometer_out, req.params.id);
    res.json({ success: true, id: sid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── LOAN APPLICATIONS (Mortgage Broker) ──────────────────────────────────────
router.get("/loans", auth, (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    let q = `SELECT l.*, c.name as contact_name FROM loan_applications l LEFT JOIN contacts c ON c.id=l.contact_id WHERE l.user_id=?`;
    const params = [req.userId];
    if (status) { q += " AND l.status=?"; params.push(status); }
    q += " ORDER BY l.created_at DESC";
    const loans = db.prepare(q).all(...params).map(l => ({ ...l, documents_checklist: JSON.parse(l.documents_checklist||'[]') }));
    res.json({ loans });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/loans", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, client_name, client_email, client_phone, loan_type, loan_amount, property_value, deposit_pct, lender, notes } = req.body;
    if (!client_name && !contact_id) return res.status(400).json({ error: "client_name or contact_id required" });
    const id = uuid();
    const defaultChecklist = JSON.stringify(["ID documents","Payslips (3 months)","Bank statements (3 months)","Tax returns","Property contract","Loan application form"]);
    db.prepare("INSERT INTO loan_applications (id,user_id,contact_id,client_name,client_email,client_phone,loan_type,loan_amount,property_value,deposit_pct,lender,notes,documents_checklist) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, client_name||"", client_email||"", client_phone||"", loan_type||"home", loan_amount||null, property_value||null, deposit_pct||null, lender||"", notes||"", defaultChecklist);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/loans/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, lender, interest_rate, loan_term, settlement_date, broker_fee, documents_checklist, notes } = req.body;
    db.prepare("UPDATE loan_applications SET status=?,lender=?,interest_rate=?,loan_term=?,settlement_date=?,broker_fee=?,documents_checklist=?,notes=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(status, lender, interest_rate||null, loan_term||null, settlement_date||null, broker_fee||null, JSON.stringify(documents_checklist||[]), notes, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── CHILDREN / CHILDCARE ──────────────────────────────────────────────────────
router.get("/children", auth, (req, res) => {
  try {
    const db = getDb();
    const children = db.prepare(`SELECT ch.*, c.name as parent_name, c.email as parent_email, c.phone as parent_phone
      FROM children ch LEFT JOIN contacts c ON c.id=ch.parent_contact_id WHERE ch.user_id=? AND ch.status='enrolled' ORDER BY ch.child_name`).all(req.userId);
    res.json({ children: children.map(c => ({ ...c, enrollment_days: JSON.parse(c.enrollment_days||'[]') })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/children", auth, (req, res) => {
  try {
    const db = getDb();
    const { parent_contact_id, child_name, date_of_birth, allergies, medical_notes, emergency_contact, emergency_phone, enrollment_start, enrollment_days, room } = req.body;
    if (!child_name) return res.status(400).json({ error: "child_name required" });
    const id = uuid();
    db.prepare("INSERT INTO children (id,user_id,parent_contact_id,child_name,date_of_birth,allergies,medical_notes,emergency_contact,emergency_phone,enrollment_start,enrollment_days,room) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, parent_contact_id||null, child_name, date_of_birth||null, allergies||"", medical_notes||"", emergency_contact||"", emergency_phone||"", enrollment_start||null, JSON.stringify(enrollment_days||[]), room||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/children/:id/attendance", auth, (req, res) => {
  try {
    const db = getDb();
    const { date, sign_in, sign_out, signed_in_by, signed_out_by, notes } = req.body;
    const today = date || new Date().toISOString().split("T")[0];
    // CRITICAL IDOR fix (safeguarding): verify child belongs to this provider
    const ownedChild = db.prepare("SELECT id FROM children WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!ownedChild) return res.status(404).json({ error: "Child not found" });
    const existing = db.prepare("SELECT id FROM childcare_attendance WHERE child_id=? AND date=?").get(req.params.id, today);
    if (existing) {
      db.prepare("UPDATE childcare_attendance SET sign_in=COALESCE(?,sign_in),sign_out=COALESCE(?,sign_out),signed_in_by=COALESCE(?,signed_in_by),signed_out_by=COALESCE(?,signed_out_by),notes=COALESCE(?,notes) WHERE id=?")
        .run(sign_in||null, sign_out||null, signed_in_by||null, signed_out_by||null, notes||null, existing.id);
    } else {
      db.prepare("INSERT INTO childcare_attendance (id,child_id,user_id,date,sign_in,sign_out,signed_in_by,signed_out_by,notes) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(uuid(), req.params.id, req.userId, today, sign_in||null, sign_out||null, signed_in_by||null, signed_out_by||null, notes||"");
    }
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/children/:id/attendance", auth, (req, res) => {
  try {
    const db = getDb();
    const records = db.prepare("SELECT * FROM childcare_attendance WHERE child_id=? AND user_id=? ORDER BY date DESC LIMIT 30").all(req.params.id, req.userId);
    res.json({ attendance: records });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PRACTICE CLIENTS / TAX DEADLINES (Accounting) ────────────────────────────
router.get("/practice-clients", auth, (req, res) => {
  try {
    const db = getDb();
    const clients = db.prepare(`SELECT pc.*, c.name as contact_name, c.email as contact_email
      FROM practice_clients pc LEFT JOIN contacts c ON c.id=pc.contact_id WHERE pc.user_id=? AND pc.status='active' ORDER BY pc.entity_name`).all(req.userId);
    res.json({ clients: clients.map(c => ({ ...c, services: JSON.parse(c.services_json||'[]') })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/practice-clients", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, entity_name, entity_type, tax_file_number, abn, acn, fiscal_year_end, gst_registered, services } = req.body;
    if (!entity_name) return res.status(400).json({ error: "entity_name required" });
    const id = uuid();
    db.prepare("INSERT INTO practice_clients (id,user_id,contact_id,entity_name,entity_type,tax_file_number,abn,acn,fiscal_year_end,gst_registered,services_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, contact_id||null, entity_name, entity_type||"individual", tax_file_number||"", abn||"", acn||"", fiscal_year_end||"06-30", gst_registered?1:0, JSON.stringify(services||[]));
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/tax-deadlines", auth, (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    let q = `SELECT td.*, pc.entity_name FROM tax_deadlines td LEFT JOIN practice_clients pc ON pc.id=td.client_id WHERE td.user_id=?`;
    const params = [req.userId];
    if (status) { q += " AND td.status=?"; params.push(status); }
    q += " ORDER BY td.due_date ASC";
    const deadlines = db.prepare(q).all(...params);
    res.json({ deadlines });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/tax-deadlines", auth, (req, res) => {
  try {
    const db = getDb();
    const { client_id, title, deadline_type, due_date, notes } = req.body;
    if (!title || !due_date) return res.status(400).json({ error: "title and due_date required" });
    const id = uuid();
    db.prepare("INSERT INTO tax_deadlines (id,user_id,client_id,title,deadline_type,due_date,notes) VALUES (?,?,?,?,?,?,?)")
      .run(id, req.userId, client_id||null, title, deadline_type||"", due_date, notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/tax-deadlines/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE tax_deadlines SET status=?,notes=? WHERE id=? AND user_id=?").run(req.body.status||"pending", req.body.notes||"", req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});
