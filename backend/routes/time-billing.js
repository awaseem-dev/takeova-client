/**
 * ══════════════════════════════════════════════════════════
 * MINE Time Tracking — Wired to Invoice Billing
 * ══════════════════════════════════════════════════════════
 *
 * Routes:
 *   GET    /api/time                         — list time entries
 *   POST   /api/time                         — log time entry
 *   PUT    /api/time/:id                     — update entry
 *   DELETE /api/time/:id                     — delete entry
 *   GET    /api/time/unbilled                — unbilled time by client
 *   POST   /api/time/invoice                 — create invoice from unbilled time
 *   GET    /api/time/summary                 — hours + value by client/period
 *   POST   /api/time/:id/start-timer         — start live timer
 *   PUT    /api/time/:id/stop-timer          — stop timer, save duration
 */

"use strict";

const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");

function ensureTables(db) {
  try {
    db.exec(`ALTER TABLE time_entries ADD COLUMN job_id TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE time_entries ADD COLUMN timer_started_at TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE time_entries ADD COLUMN tags TEXT`);
  } catch(e) {}
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_time_user_billed ON time_entries(user_id, billable, invoiced)`);
  } catch(e) {}
}

// ── GET /api/time ──────────────────────────────────────────────────────────────
router.get("/", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { contact_id, job_id, invoiced, from, to, billable } = req.query;
    let q = `
      SELECT te.*, c.name as contact_name, j.title as job_title
      FROM time_entries te
      LEFT JOIN contacts c ON c.id = te.contact_id
      LEFT JOIN jobs j ON j.id = te.job_id
      WHERE te.user_id = ?
    `;
    const params = [req.userId];
    if (contact_id)       { q += " AND te.contact_id = ?"; params.push(contact_id); }
    if (job_id)           { q += " AND te.job_id = ?"; params.push(job_id); }
    if (invoiced !== undefined) { q += " AND te.invoiced = ?"; params.push(invoiced === 'true' ? 1 : 0); }
    if (billable !== undefined) { q += " AND te.billable = ?"; params.push(billable === 'true' ? 1 : 0); }
    if (from)             { q += " AND te.date >= ?"; params.push(from); }
    if (to)               { q += " AND te.date <= ?"; params.push(to); }
    q += " ORDER BY te.date DESC, te.created_at DESC";
    const entries = db.prepare(q).all(...params);

    // Summary stats
    const totalHours = entries.reduce((s, e) => s + (e.duration_minutes || 0), 0) / 60;
    const billableValue = entries.filter(e => e.billable && !e.invoiced).reduce((s, e) => s + ((e.duration_minutes / 60) * (e.hourly_rate || 0)), 0);

    res.json({ entries, total_hours: Math.round(totalHours * 100) / 100, unbilled_value: Math.round(billableValue * 100) / 100 });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/time ─────────────────────────────────────────────────────────────
router.post("/", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { contact_id, client_name, description, date, duration_minutes, hourly_rate, billable, job_id, tags } = req.body;
    if (!description) return res.status(400).json({ error: "description required" });

    // Auto-fill client name from contact
    let finalClientName = client_name;
    if (contact_id && !finalClientName) {
      const c = db.prepare("SELECT name FROM contacts WHERE id = ? AND user_id = ?").get(contact_id, req.userId);
      if (c) finalClientName = c.name;
    }

    // Default hourly rate from settings
    const defaultRate = parseFloat(getSetting("DEFAULT_HOURLY_RATE")) || 0;

    const id = uuid();
    db.prepare(`INSERT INTO time_entries (id, user_id, contact_id, client_name, description, date, duration_minutes, hourly_rate, billable, invoiced, job_id, tags)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`).run(
        id, req.userId,
        contact_id||null, finalClientName||null, description,
        date || new Date().toISOString().split('T')[0],
        parseInt(duration_minutes) || 0,
        parseFloat(hourly_rate) || defaultRate,
        billable !== false ? 1 : 0,
        job_id||null, tags||null
    );
    const entry = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
    res.json({ success: true, entry });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUT /api/time/:id ──────────────────────────────────────────────────────────
router.put("/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const allowed = ['contact_id','client_name','description','date','duration_minutes','hourly_rate','billable','job_id','tags'];
    const fields = []; const vals = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k) && v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
    }
    if (!fields.length) return res.json({ success: true });
    vals.push(req.params.id, req.userId);
    db.prepare(`UPDATE time_entries SET ${fields.join(',')} WHERE id = ? AND user_id = ?`).run(...vals);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── DELETE /api/time/:id ───────────────────────────────────────────────────────
router.delete("/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const entry = db.prepare("SELECT * FROM time_entries WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!entry) return res.status(404).json({ error: "Entry not found" });
    if (entry.invoiced) return res.status(400).json({ error: "Cannot delete invoiced time entry" });
    db.prepare("DELETE FROM time_entries WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GET /api/time/unbilled — grouped by client ────────────────────────────────
router.get("/unbilled", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const entries = db.prepare(`
      SELECT te.*, c.name as contact_name, c.email as contact_email
      FROM time_entries te
      LEFT JOIN contacts c ON c.id = te.contact_id
      WHERE te.user_id = ? AND te.billable = 1 AND te.invoiced = 0
      ORDER BY te.client_name, te.date DESC
    `).all(req.userId);

    // Group by client
    const byClient = {};
    for (const e of entries) {
      const key = e.contact_id || e.client_name || 'Unknown';
      if (!byClient[key]) byClient[key] = {
        contact_id: e.contact_id, client_name: e.client_name || e.contact_name || 'Unknown',
        contact_email: e.contact_email, entries: [], total_minutes: 0, total_value: 0
      };
      byClient[key].entries.push(e);
      byClient[key].total_minutes += (e.duration_minutes || 0);
      byClient[key].total_value += ((e.duration_minutes / 60) * (e.hourly_rate || 0));
    }

    const clients = Object.values(byClient).map(c => ({
      ...c,
      total_hours: Math.round((c.total_minutes / 60) * 100) / 100,
      total_value: Math.round(c.total_value * 100) / 100
    }));

    const grandTotal = clients.reduce((s, c) => s + c.total_value, 0);
    res.json({ clients, grand_total: Math.round(grandTotal * 100) / 100, entry_count: entries.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/time/invoice — Create invoice from unbilled time ────────────────
router.post("/invoice", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { contact_id, client_name, entry_ids, include_detail, message } = req.body;

    // Get the specific entries or all unbilled for this client
    let entries;
    if (entry_ids && entry_ids.length) {
      const placeholders = entry_ids.map(() => '?').join(',');
      entries = db.prepare(`SELECT * FROM time_entries WHERE id IN (${placeholders}) AND user_id = ? AND billable = 1 AND invoiced = 0`)
        .all(...entry_ids, req.userId);
    } else if (contact_id) {
      entries = db.prepare("SELECT * FROM time_entries WHERE contact_id = ? AND user_id = ? AND billable = 1 AND invoiced = 0")
        .all(contact_id, req.userId);
    } else {
      return res.status(400).json({ error: "Provide entry_ids or contact_id" });
    }

    if (!entries.length) return res.status(400).json({ error: "No unbilled entries found" });

    // Get client info
    let clientName = client_name;
    let clientEmail = null;
    if (!clientName && contact_id) {
      const c = db.prepare("SELECT name, email FROM contacts WHERE id = ? AND user_id = ?").get(contact_id, req.userId);
      if (c) { clientName = c.name; clientEmail = c.email; }
    }
    if (!clientName) clientName = entries[0].client_name || 'Client';

    // Build invoice line items
    const items = [];
    if (include_detail !== false) {
      // One line per entry
      for (const e of entries) {
        const hours = (e.duration_minutes / 60);
        items.push({
          description: `${e.description} (${e.date} — ${hours.toFixed(2)}h @ $${e.hourly_rate}/hr)`,
          amount: Math.round(hours * e.hourly_rate * 100) / 100
        });
      }
    } else {
      // Summary line
      const totalMinutes = entries.reduce((s, e) => s + (e.duration_minutes || 0), 0);
      const totalHours = totalMinutes / 60;
      const avgRate = entries.reduce((s, e) => s + (e.hourly_rate || 0), 0) / entries.length;
      items.push({
        description: `Professional services — ${totalHours.toFixed(2)} hours`,
        amount: Math.round(totalHours * avgRate * 100) / 100
      });
    }

    const total = items.reduce((s, i) => s + (i.amount || 0), 0);
    const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
    const dueDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    const invoiceId = uuid();

    db.prepare(`INSERT INTO invoices (id, user_id, invoice_number, client_name, client_email, items_json, subtotal, tax, total, status, due_date, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        invoiceId, req.userId, invoiceNumber, clientName, clientEmail,
        JSON.stringify(items), total, 0, total, 'sent', dueDate,
        message || null
    );

    // Mark all entries as invoiced
    const entryIds = entries.map(e => e.id);
    const ph = entryIds.map(() => '?').join(',');
    db.prepare(`UPDATE time_entries SET invoiced = 1, invoice_id = ? WHERE id IN (${ph})`).run(invoiceId, ...entryIds);

    // Send invoice email
    if (clientEmail) {
      try {
        const { autoEmail } = require("./features");
        const period = `${entries[entries.length-1].date} to ${entries[0].date}`;
        const itemsHtml = items.map(i => `<tr><td style="padding:8px 4px;border-bottom:1px solid #f0f0f0;font-size:13px">${i.description}</td><td style="padding:8px 4px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:13px">$${(i.amount||0).toFixed(2)}</td></tr>`).join('');
        await autoEmail(req.userId, clientEmail, `Invoice ${invoiceNumber} — $${total.toFixed(2)}`,
          `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:24px">
            <h2 style="color:#2563EB">Invoice ${invoiceNumber}</h2>
            <p>Hi ${clientName},</p>
            ${message ? `<p>${message}</p>` : `<p>Please find your invoice for work completed ${period}:</p>`}
            <table style="width:100%;border-collapse:collapse;margin:20px 0">
              ${itemsHtml}
              <tr><td style="padding:12px 4px;font-weight:700;border-top:2px solid #E2E8F0">Total</td>
                  <td style="padding:12px 4px;text-align:right;font-weight:700;border-top:2px solid #E2E8F0">$${total.toFixed(2)}</td></tr>
            </table>
            <p style="color:#666;font-size:13px">Payment due: ${dueDate}</p>
            ${message ? '' : '<p style="color:#666;font-size:13px">Please reply to this email with any questions.</p>'}
          </div>`);
      } catch(e) {}
    }

    res.json({ success: true, invoice_id: invoiceId, invoice_number: invoiceNumber, total, entries_billed: entries.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GET /api/time/summary ──────────────────────────────────────────────────────
router.get("/summary", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { from, to, period } = req.query;
    let dateFrom = from;
    let dateTo   = to;

    if (period === 'week') {
      const now = new Date();
      const day = now.getDay();
      dateFrom = new Date(now - day * 86400000).toISOString().split('T')[0];
      dateTo   = new Date(now + (6-day) * 86400000).toISOString().split('T')[0];
    } else if (period === 'month') {
      const now = new Date();
      dateFrom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
      dateTo   = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().split('T')[0];
    }

    const where = dateFrom ? `AND te.date >= '${dateFrom}' AND te.date <= '${dateTo}'` : '';

    const byClient = db.prepare(`
      SELECT
        COALESCE(c.name, te.client_name, 'No client') as client,
        te.contact_id,
        COUNT(*) as entries,
        SUM(te.duration_minutes) as total_minutes,
        SUM(CASE WHEN te.billable = 1 AND te.invoiced = 0 THEN (te.duration_minutes / 60.0) * te.hourly_rate ELSE 0 END) as unbilled_value,
        SUM(CASE WHEN te.invoiced = 1 THEN (te.duration_minutes / 60.0) * te.hourly_rate ELSE 0 END) as invoiced_value
      FROM time_entries te
      LEFT JOIN contacts c ON c.id = te.contact_id
      WHERE te.user_id = ? ${where}
      GROUP BY COALESCE(te.contact_id, te.client_name)
      ORDER BY total_minutes DESC
    `).all(req.userId);

    const totals = byClient.reduce((s, c) => ({
      minutes: s.minutes + (c.total_minutes||0),
      unbilled: s.unbilled + (c.unbilled_value||0),
      invoiced: s.invoiced + (c.invoiced_value||0)
    }), { minutes: 0, unbilled: 0, invoiced: 0 });

    res.json({
      period: period || 'all',
      from: dateFrom, to: dateTo,
      by_client: byClient.map(c => ({ ...c, total_hours: Math.round((c.total_minutes/60)*100)/100 })),
      totals: {
        hours: Math.round((totals.minutes/60)*100)/100,
        unbilled_value: Math.round(totals.unbilled*100)/100,
        invoiced_value: Math.round(totals.invoiced*100)/100
      }
    });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/time/:id/start-timer — Begin live timer ─────────────────────────
router.post("/:id/start-timer", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const now = new Date().toISOString();
    // Check no other timer running
    const running = db.prepare("SELECT id FROM time_entries WHERE user_id = ? AND timer_started_at IS NOT NULL").get(req.userId);
    if (running) return res.status(409).json({ error: "Another timer is already running. Stop it first.", running_id: running.id });
    db.prepare("UPDATE time_entries SET timer_started_at = ? WHERE id = ? AND user_id = ?").run(now, req.params.id, req.userId);
    res.json({ success: true, timer_started_at: now });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUT /api/time/:id/stop-timer — Stop timer and accumulate minutes ──────────
router.put("/:id/stop-timer", auth, (req, res) => {
  try {
    const db = getDb();
    const entry = db.prepare("SELECT * FROM time_entries WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!entry) return res.status(404).json({ error: "Entry not found" });
    if (!entry.timer_started_at) return res.status(400).json({ error: "Timer not running for this entry" });

    const started = new Date(entry.timer_started_at);
    const elapsed = Math.round((Date.now() - started.getTime()) / 60000); // minutes
    const newTotal = (entry.duration_minutes || 0) + elapsed;

    db.prepare("UPDATE time_entries SET duration_minutes = ?, timer_started_at = NULL WHERE id = ? AND user_id = ?")
      .run(newTotal, req.params.id, req.userId);

    res.json({ success: true, elapsed_minutes: elapsed, total_minutes: newTotal, total_hours: Math.round((newTotal/60)*100)/100 });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GET /api/time/running — Check if a timer is active ───────────────────────
router.get("/running", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const running = db.prepare(`
      SELECT te.*, c.name as contact_name
      FROM time_entries te
      LEFT JOIN contacts c ON c.id = te.contact_id
      WHERE te.user_id = ? AND te.timer_started_at IS NOT NULL
      LIMIT 1
    `).get(req.userId);
    if (!running) return res.json({ running: false });
    const elapsed = Math.round((Date.now() - new Date(running.timer_started_at).getTime()) / 60000);
    res.json({ running: true, entry: running, elapsed_minutes: elapsed });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
