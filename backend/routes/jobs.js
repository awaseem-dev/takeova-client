/**
 * ══════════════════════════════════════════════════════════
 * MINE Job Lifecycle — Quote → Job → Milestone → Invoice
 * ══════════════════════════════════════════════════════════
 *
 * Routes:
 *   GET    /api/jobs                         — list jobs (pipeline view)
 *   POST   /api/jobs                         — create job
 *   GET    /api/jobs/:id                     — get job detail
 *   PUT    /api/jobs/:id                     — update job
 *   PUT    /api/jobs/:id/status              — advance status
 *   DELETE /api/jobs/:id                     — delete job
 *
 *   POST   /api/jobs/:id/materials           — add material to job
 *   DELETE /api/jobs/:id/materials/:mid      — remove material
 *
 *   POST   /api/jobs/:id/milestones          — add payment milestone
 *   PUT    /api/jobs/:id/milestones/:mid/pay — mark milestone paid
 *   DELETE /api/jobs/:id/milestones/:mid     — delete milestone
 *
 *   POST   /api/jobs/:id/photos              — add photo
 *   DELETE /api/jobs/:id/photos/:pid         — delete photo
 *
 *   POST   /api/jobs/:id/invoice             — generate invoice from job
 *   POST   /api/jobs/from-quote/:quoteId     — convert quote to job
 */

"use strict";

const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");

const JOB_STATUSES = ['quoted','approved','scheduled','in_progress','completed','invoiced','paid','cancelled'];

function ensureTables(db) {
  try { db.exec(`ALTER TABLE jobs ADD COLUMN project_name TEXT`); } catch(e) {}
  try { db.exec(`ALTER TABLE jobs ADD COLUMN client_name TEXT`); } catch(e) {}
  try { db.exec(`ALTER TABLE jobs ADD COLUMN client_email TEXT`); } catch(e) {}
  try { db.exec(`ALTER TABLE jobs ADD COLUMN tags TEXT`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_job_materials_job ON job_materials(job_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_job_milestones_job ON job_milestones(job_id)`); } catch(e) {}
}

function calcJobTotal(db, jobId) {
  const mats = db.prepare("SELECT COALESCE(SUM(total_cost),0) as t FROM job_materials WHERE job_id = ?").get(jobId);
  return mats?.t || 0;
}

// ── GET /api/jobs ──────────────────────────────────────────────────────────────
router.get("/", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { status, from, to, contact_id } = req.query;
    let query = `
      SELECT j.*,
        c.name as contact_name, c.email as contact_email, c.phone as contact_phone,
        (SELECT COUNT(*) FROM job_milestones WHERE job_id = j.id) as milestone_count,
        (SELECT COUNT(*) FROM job_milestones WHERE job_id = j.id AND status = 'paid') as milestones_paid,
        (SELECT COUNT(*) FROM job_photos WHERE job_id = j.id) as photo_count,
        (SELECT COALESCE(SUM(total_cost),0) FROM job_materials WHERE job_id = j.id) as materials_total
      FROM jobs j
      LEFT JOIN contacts c ON c.id = j.contact_id
      WHERE j.user_id = ?
    `;
    const params = [req.userId];
    if (status)     { query += " AND j.status = ?"; params.push(status); }
    if (contact_id) { query += " AND j.contact_id = ?"; params.push(contact_id); }
    if (from)       { query += " AND j.scheduled_date >= ?"; params.push(from); }
    if (to)         { query += " AND j.scheduled_date <= ?"; params.push(to); }
    query += " ORDER BY j.created_at DESC";
    const jobs = db.prepare(query).all(...params);

    // Pipeline counts
    const pipeline = {};
    for (const s of JOB_STATUSES) {
      pipeline[s] = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total_cost),0) as v FROM jobs WHERE user_id = ? AND status = ?").get(req.userId, s);
    }

    res.json({ jobs, pipeline });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/jobs ─────────────────────────────────────────────────────────────
router.post("/", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { title, description, contact_id, client_name, client_email, scheduled_date, scheduled_time,
            address, labour_cost, total_cost, deposit_pct, notes, tags, status } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });

    // Auto-fill client name from contact if not provided
    let finalClientName = client_name;
    let finalClientEmail = client_email;
    if (contact_id && !finalClientName) {
      const contact = db.prepare("SELECT name, email FROM contacts WHERE id = ? AND user_id = ?").get(contact_id, req.userId);
      if (contact) { finalClientName = contact.name; finalClientEmail = finalClientEmail || contact.email; }
    }

    const id = uuid();
    db.prepare(`INSERT INTO jobs (id, user_id, title, description, contact_id, client_name, client_email,
      status, scheduled_date, scheduled_time, address, labour_cost, total_cost, deposit_pct, notes, tags)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, req.userId, title, description||null, contact_id||null, finalClientName||null, finalClientEmail||null,
      status||'quoted', scheduled_date||null, scheduled_time||null, address||null,
      labour_cost||0, total_cost||0, deposit_pct||0, notes||null, tags||null
    );
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    res.json({ success: true, job });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GET /api/jobs/:id ──────────────────────────────────────────────────────────
router.get("/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare(`
      SELECT j.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone
      FROM jobs j LEFT JOIN contacts c ON c.id = j.contact_id
      WHERE j.id = ? AND j.user_id = ?
    `).get(req.params.id, req.userId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const materials  = db.prepare("SELECT * FROM job_materials WHERE job_id = ? ORDER BY created_at").all(req.params.id);
    const milestones = db.prepare("SELECT * FROM job_milestones WHERE job_id = ? ORDER BY due_date").all(req.params.id);
    const photos     = db.prepare("SELECT * FROM job_photos WHERE job_id = ? ORDER BY created_at DESC").all(req.params.id);

    res.json({ job, materials, milestones, photos });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUT /api/jobs/:id ──────────────────────────────────────────────────────────
router.put("/:id", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const allowed = ['title','description','contact_id','client_name','client_email','status',
                     'scheduled_date','scheduled_time','completed_date','address','location_notes',
                     'labour_cost','materials_cost','total_cost','deposit_pct','deposit_paid','notes','internal_notes','tags'];
    const fields = []; const vals = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k) && v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
    }
    if (!fields.length) return res.json({ success: true });
    fields.push("updated_at = datetime('now')");
    vals.push(req.params.id, req.userId);
    db.prepare(`UPDATE jobs SET ${fields.join(',')} WHERE id = ? AND user_id = ?`).run(...vals);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUT /api/jobs/:id/status ───────────────────────────────────────────────────
router.put("/:id/status", auth, (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;
    if (!JOB_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${JOB_STATUSES.join(', ')}` });
    const extra = status === 'completed' ? ", completed_date = date('now')" : '';
    db.prepare(`UPDATE jobs SET status = ?${extra}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(status, req.params.id, req.userId);
    res.json({ success: true, status });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── DELETE /api/jobs/:id ───────────────────────────────────────────────────────
router.delete("/:id", auth, (req, res) => {
  try {
    const db = getDb();
    // Verify ownership BEFORE deleting children (IDOR fix)
    const owned = db.prepare("SELECT id FROM jobs WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!owned) return res.status(404).json({ error: "Job not found" });
    db.prepare("DELETE FROM jobs WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    db.prepare("DELETE FROM job_materials WHERE job_id = ?").run(req.params.id);
    db.prepare("DELETE FROM job_milestones WHERE job_id = ?").run(req.params.id);
    db.prepare("DELETE FROM job_photos WHERE job_id = ?").run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/jobs/:id/materials ───────────────────────────────────────────────
router.post("/:id/materials", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, quantity, unit, unit_cost, supplier } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const qty = parseFloat(quantity) || 1;
    const cost = parseFloat(unit_cost) || 0;
    const total = qty * cost;
    const id = uuid();
    db.prepare(`INSERT INTO job_materials (id, job_id, user_id, name, quantity, unit, unit_cost, total_cost, supplier)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, req.params.id, req.userId, name, qty, unit||null, cost, total, supplier||null);
    // Recalculate job materials total
    const mTotal = calcJobTotal(db, req.params.id);
    db.prepare("UPDATE jobs SET materials_cost = ?, updated_at = datetime('now') WHERE id = ?").run(mTotal, req.params.id);
    const material = db.prepare("SELECT * FROM job_materials WHERE id = ?").get(id);
    res.json({ success: true, material, materials_total: mTotal });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── DELETE /api/jobs/:id/materials/:mid ───────────────────────────────────────
router.delete("/:id/materials/:mid", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM job_materials WHERE id = ? AND job_id = ? AND user_id = ?").run(req.params.mid, req.params.id, req.userId);
    const mTotal = calcJobTotal(db, req.params.id);
    db.prepare("UPDATE jobs SET materials_cost = ?, updated_at = datetime('now') WHERE id = ?").run(mTotal, req.params.id);
    res.json({ success: true, materials_total: mTotal });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/jobs/:id/milestones ──────────────────────────────────────────────
router.post("/:id/milestones", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, amount, due_date } = req.body;
    if (!title || !amount) return res.status(400).json({ error: "title and amount required" });
    const id = uuid();
    db.prepare("INSERT INTO job_milestones (id, job_id, user_id, title, amount, due_date) VALUES (?,?,?,?,?,?)")
      .run(id, req.params.id, req.userId, title, parseFloat(amount), due_date||null);
    const milestone = db.prepare("SELECT * FROM job_milestones WHERE id = ?").get(id);
    res.json({ success: true, milestone });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUT /api/jobs/:id/milestones/:mid/pay ─────────────────────────────────────
router.put("/:id/milestones/:mid/pay", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE job_milestones SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND job_id = ? AND user_id = ?")
      .run(req.params.mid, req.params.id, req.userId);
    // Check if all milestones paid — if so advance job to paid
    const total   = db.prepare("SELECT COUNT(*) as n FROM job_milestones WHERE job_id = ?").get(req.params.id)?.n;
    const paid    = db.prepare("SELECT COUNT(*) as n FROM job_milestones WHERE job_id = ? AND status = 'paid'").get(req.params.id)?.n;
    if (total > 0 && paid === total) {
      db.prepare("UPDATE jobs SET status = 'paid', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    }
    res.json({ success: true, all_paid: paid === total });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── DELETE /api/jobs/:id/milestones/:mid ──────────────────────────────────────
router.delete("/:id/milestones/:mid", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM job_milestones WHERE id = ? AND job_id = ? AND user_id = ?").run(req.params.mid, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/jobs/:id/photos ──────────────────────────────────────────────────
router.post("/:id/photos", auth, (req, res) => {
  try {
    const db = getDb();
    const { url, type, caption } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    const id = uuid();
    db.prepare("INSERT INTO job_photos (id, job_id, user_id, url, type, caption) VALUES (?,?,?,?,?,?)")
      .run(id, req.params.id, req.userId, url, type||'progress', caption||null);
    res.json({ success: true, photo: db.prepare("SELECT * FROM job_photos WHERE id = ?").get(id) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── DELETE /api/jobs/:id/photos/:pid ──────────────────────────────────────────
router.delete("/:id/photos/:pid", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM job_photos WHERE id = ? AND job_id = ? AND user_id = ?").run(req.params.pid, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/jobs/:id/invoice — Generate invoice from job ────────────────────
router.post("/:id/invoice", auth, async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.invoice_id) return res.status(409).json({ error: "Invoice already generated for this job", invoice_id: job.invoice_id });

    const materials  = db.prepare("SELECT * FROM job_materials WHERE job_id = ?").all(req.params.id);
    const milestones = db.prepare("SELECT * FROM job_milestones WHERE job_id = ?").all(req.params.id);

    // Build invoice line items
    const items = [];
    if (job.labour_cost > 0) items.push({ description: "Labour", amount: job.labour_cost });
    for (const m of materials) items.push({ description: m.name, quantity: m.quantity, unit_cost: m.unit_cost, amount: m.total_cost });
    if (!items.length) items.push({ description: job.title, amount: job.total_cost || 0 });

    const total = items.reduce((s, i) => s + (i.amount || 0), 0);
    const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
    const dueDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    const invoiceId = uuid();

    db.prepare(`INSERT INTO invoices (id, user_id, invoice_number, client_name, client_email, items_json, subtotal, tax, total, status, due_date, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        invoiceId, req.userId, invoiceNumber,
        job.client_name || job.contact_id, job.client_email,
        JSON.stringify(items), total, 0, total, 'sent', dueDate,
        `Invoice for: ${job.title}`
    );

    // Link invoice to job and advance status
    db.prepare("UPDATE jobs SET invoice_id = ?, status = 'invoiced', updated_at = datetime('now') WHERE id = ?").run(invoiceId, req.params.id);

    // Email invoice if we have a client email
    if (job.client_email) {
      try {
        const { autoEmail } = require("./features");
        const itemsHtml = items.map(i => `<tr><td style="padding:8px;border-bottom:1px solid #f0f0f0">${i.description}</td><td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:right">$${(i.amount||0).toFixed(2)}</td></tr>`).join('');
        await autoEmail(req.userId, job.client_email, `Invoice ${invoiceNumber} — $${total.toFixed(2)}`,
          `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:24px">
            <h2>Invoice ${invoiceNumber}</h2>
            <p>Hi ${job.client_name || 'there'},</p>
            <p>Please find your invoice for <strong>${job.title}</strong>:</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0">${itemsHtml}
              <tr><td style="padding:12px 8px;font-weight:700">Total</td><td style="padding:12px 8px;text-align:right;font-weight:700">$${total.toFixed(2)}</td></tr>
            </table>
            <p style="color:#666;font-size:13px">Due: ${dueDate}</p>
          </div>`);
      } catch(e) {}
    }

    res.json({ success: true, invoice_id: invoiceId, invoice_number: invoiceNumber, total });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/jobs/from-quote/:quoteId — Convert quote to job ────────────────
router.post("/from-quote/:quoteId", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    // Quotes are stored in invoices table with status='draft' or in a separate quotes concept
    // Try to find it as an invoice with status quote
    const quote = db.prepare("SELECT * FROM invoices WHERE id = ? AND user_id = ?").get(req.params.quoteId, req.userId);
    if (!quote) return res.status(404).json({ error: "Quote not found" });

    const id = uuid();
    db.prepare(`INSERT INTO jobs (id, user_id, title, client_name, client_email, quote_id, total_cost, status)
      VALUES (?,?,?,?,?,?,?,?)`).run(
        id, req.userId,
        `Job: ${quote.client_name || 'Client'}`,
        quote.client_name, quote.client_email,
        quote.id, quote.total, 'approved'
    );
    // Mark quote as approved
    db.prepare("UPDATE invoices SET status = 'approved' WHERE id = ?").run(quote.id);
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    res.json({ success: true, job });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
