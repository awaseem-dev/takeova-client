const express = require("express");
const { isAdmin } = require('../utils/admin-check');
const rateLimit = require('express-rate-limit');
const nodemailer = require("nodemailer");
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

// HTML sanitizer — strips dangerous tags/attrs while allowing safe formatting
// install: npm install sanitize-html
let _sanitizeHtml;
function sanitizeEmailBody(html) {
  try {
    if (!_sanitizeHtml) _sanitizeHtml = require("sanitize-html");
    return _sanitizeHtml(html, {
      allowedTags: ["p","br","strong","em","b","i","u","ul","ol","li","a","h1","h2","h3","span","div","blockquote","pre","code"],
      allowedAttributes: {
        "a": ["href", "target", "rel"],
        "span": ["style"],
        "div": ["style"],
        "p": ["style"],
      },
      allowedSchemes: ["https", "http", "mailto"],
    });
  } catch (e) {
    // If sanitize-html is not installed, strip all HTML tags as a safe fallback
    return String(html || "").replace(/<[^>]+>/g, "");
  }
}

// Escape user-supplied strings for safe HTML interpolation
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const router = express.Router();
const emailSendLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: "Too many emails sent — slow down." } });

// Create transporter based on env config or DB settings
function getSetting(k) { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } }

function getTransporter() {
  const sgKey = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
  if (sgKey) {
    return nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 587,
      auth: { user: "apikey", pass: sgKey },
    });
  }
  const smtpHost = process.env.SMTP_HOST || getSetting("SMTP_HOST");
  if (smtpHost) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || getSetting("SMTP_PORT")) || 587,
      auth: { user: process.env.SMTP_USER || getSetting("SMTP_USER"), pass: process.env.SMTP_PASS || getSetting("SMTP_PASS") },
    });
  }
  // Not configured (no SendGrid key, no SMTP host) — signal callers to surface a clear error.
  return null;
}

// ─── SEND INVOICE EMAIL ───
function planCap(plan, key, fallback) {
  try { const C = require("./features").PLAN_CAPS || {}; const p = C[plan] || null; if (p && p[key] != null) return p[key]; } catch (_) {}
  return fallback;
}

router.post("/send-invoice", auth, async (req, res) => {
  try {
    const { invoiceId, clientEmail, clientName, items, total, dueDate, paymentLink } = req.body;
    // Sanitize header fields against SMTP injection
    const safeClientEmail = String(clientEmail || "").replace(/[\r\n]/g, "");
    // Validate paymentLink is http/https only to prevent javascript: or data: URIs in email
    const safePaymentLink = (() => {
      try { const u = new URL(paymentLink || ""); return (u.protocol === "https:" || u.protocol === "http:") ? paymentLink : null; } catch { return null; }
    })();
    const db = getDb();
    const user = db.prepare("SELECT name, email, plan, emails_sent, email_limit FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Enforce email quota — previously /send-invoice bypassed the limit that
    // /send and /send-funnel-email check, letting users send unlimited
    // invoice emails (to arbitrary clientEmail values) without hitting their
    // plan cap or the overage billing pipeline.
    if (!isAdmin(db, req.userId) && user.emails_sent >= ((user.email_limit > 0) ? user.email_limit : planCap(user.plan, "emails", 500))) {
      return res.status(429).json({ error: "Email limit reached. Upgrade plan or purchase overage.", overLimit: true });
    }

    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    // Strip newlines from bizName — it's interpolated into the Subject header
    // below, and a site name containing CRLF would allow SMTP header injection.
    const bizName = String(site?.name || user.name || "").replace(/[\r\n]/g, "").slice(0, 120);

    const transporter = getTransporter();
    if (!transporter) return res.status(400).json({ error: "Email is not configured. Add a SendGrid API key or SMTP settings in admin settings, then try again." });
    const itemRows = (items || []).map(i => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(i.desc)}</td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(i.qty)}</td><td style="padding:8px;border-bottom:1px solid #eee">$${(i.price * i.qty).toFixed(2)}</td></tr>`).join("");

    await transporter.sendMail({
      from: { address: process.env.EMAIL_FROM || getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: bizName },
      to: safeClientEmail,
      subject: `Invoice from ${bizName}`,
      html: `
        <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">
          <h2>Invoice from ${escapeHtml(bizName)}</h2>
          <p>Hi ${escapeHtml(clientName)},</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0">
            <thead><tr style="background:#f7f8fa"><th style="padding:8px;text-align:left">Item</th><th style="padding:8px">Qty</th><th style="padding:8px">Amount</th></tr></thead>
            <tbody>${itemRows}</tbody>
            <tfoot><tr><td colspan="2" style="padding:8px;font-weight:bold">Total</td><td style="padding:8px;font-weight:bold">$${Number(total || 0).toFixed(2)}</td></tr></tfoot>
          </table>
          ${dueDate ? `<p>Due: ${escapeHtml(dueDate)}</p>` : ""}
          ${safePaymentLink ? `<a href="${safePaymentLink}" style="display:inline-block;padding:12px 24px;background:#2563EB;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">Pay Now →</a>` : ""}
          <div style="margin-top:32px;padding-top:16px;border-top:1px solid #f0f0f0;text-align:center;">
            <a href="https://takeova.ai${user.referral_code ? "?ref=" + (db.prepare("SELECT referral_code FROM users WHERE id = ?").get(req.userId)?.referral_code || "") : ""}" style="color:#999;font-size:11px;text-decoration:none;">
              Sent via <strong style="color:#2563EB;">MINE</strong> — the all-in-one AI business platform
            </a>
          </div>
        </div>
      `,
    });

    // Track
    db.prepare("UPDATE users SET emails_sent = emails_sent + 1, updated_at = datetime('now') WHERE id = ?").run(req.userId);
    // Track in usage_tracking for overage billing pipeline (was missing here)
    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "emails");
    if (invoiceId) db.prepare("UPDATE invoices SET status = 'sent' WHERE id = ?").run(invoiceId);

    // Auto-enroll in "Invoice sent" funnels
    try { autoEnrollInFunnels(db, req.userId, "Invoice sent", safeClientEmail, clientName || ""); } catch(e) {}

    res.json({ success: true });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

// ─── SEND FUNNEL EMAIL ───
router.post("/send-funnel-email", auth, async (req, res) => {
  try {
    const { to, subject, body, funnelId } = req.body;
    // Strip newlines from header fields to prevent SMTP header injection
    const safeTo = String(to || "").replace(/[\r\n]/g, "").trim();
    const safeSubject = String(subject || "").replace(/[\r\n]/g, "").trim();
    if (!safeTo || !safeSubject) return res.status(400).json({ error: "to and subject required" });
    const db = getDb();
    const user = db.prepare("SELECT name, plan, emails_sent, email_limit FROM users WHERE id = ?").get(req.userId);

    if (!isAdmin(db, req.userId) && user.emails_sent >= ((user.email_limit > 0) ? user.email_limit : planCap(user.plan, "emails", 500))) {
      return res.status(429).json({ error: "Email limit reached. Upgrade plan or purchase overage.", overLimit: true });
    }

    const transporter = getTransporter();
    if (!transporter) return res.status(400).json({ error: "Email is not configured. Add a SendGrid API key or SMTP settings in admin settings, then try again." });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || getSetting("EMAIL_FROM") || "noreply@takeova.ai",
      to: safeTo,
      subject: safeSubject,
      html: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">${sanitizeEmailBody(body)}<p style="color:#999;margin-top:20px;font-size:12px">Sent via TAKEOVA Platform</p></div>`,
    });

    db.prepare("UPDATE users SET emails_sent = emails_sent + 1 WHERE id = ?").run(req.userId);
    // Track in usage_tracking for overage billing
    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "emails");
    res.json({ success: true });
  } catch (err) {
    console.error("Funnel email error:", err);
    res.status(500).json({ error: "Failed to send" });
  }
});

// ─── FUNNEL CRUD (aliases for /data/funnels — FE calls /email/funnels) ───
router.get("/funnels", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, trigger_event TEXT, status TEXT DEFAULT 'draft', emails_json TEXT DEFAULT '[]', steps_json TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')))");
  res.json({ funnels: db.prepare("SELECT * FROM funnels WHERE user_id = ? ORDER BY created_at DESC").all(req.userId) });
});

// Per-funnel enrollment + completion stats (real data from funnel_enrollments).
// Must be declared BEFORE GET /funnels/:id so "stats" isn't matched as an id.
router.get("/funnels/stats", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    db.exec("CREATE TABLE IF NOT EXISTS funnel_enrollments (id TEXT PRIMARY KEY, funnel_id TEXT, user_id TEXT, contact_email TEXT, contact_name TEXT, current_step INTEGER DEFAULT 0, status TEXT DEFAULT 'active', enrolled_at TEXT DEFAULT (datetime('now')), last_email_at TEXT, completed_at TEXT)");
    const funnels = db.prepare("SELECT id, name, status FROM funnels WHERE user_id = ? ORDER BY created_at DESC").all(uid);
    const out = funnels.map(function (f) {
      const enrolled = db.prepare("SELECT COUNT(*) AS n FROM funnel_enrollments WHERE funnel_id = ?").get(f.id).n;
      const active = db.prepare("SELECT COUNT(*) AS n FROM funnel_enrollments WHERE funnel_id = ? AND status = 'active'").get(f.id).n;
      const completed = db.prepare("SELECT COUNT(*) AS n FROM funnel_enrollments WHERE funnel_id = ? AND status = 'completed'").get(f.id).n;
      return { id: f.id, name: f.name, status: f.status, enrolled: enrolled, active: active, completed: completed };
    });
    res.json({ funnels: out });
  } catch (e) { res.status(500).json({ error: "Failed to load funnel stats" }); }
});

router.post("/funnels", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, trigger_event TEXT, status TEXT DEFAULT 'draft', emails_json TEXT DEFAULT '[]', steps_json TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')))");
  const { name, trigger, steps_json } = req.body;
  const id = uuid();
  db.prepare("INSERT INTO funnels (id, user_id, name, trigger_event, steps_json) VALUES (?,?,?,?,?)").run(id, req.userId, name, trigger || "New signup", steps_json || "[]");
  res.json({ success: true, id });
});

router.put("/funnels/:id", auth, (req, res) => {
  const db = getDb();
  const { name, trigger, status, steps_json } = req.body;
  db.prepare("UPDATE funnels SET name=?, trigger_event=?, status=?, steps_json=? WHERE id=? AND user_id=?")
    .run(name, trigger, status || "draft", steps_json || "[]", req.params.id, req.userId);
  res.json({ success: true });
});

router.delete("/funnels/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM funnels WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// ─── SEND GENERIC EMAIL ───
router.post("/send", (req, res, next) => {
  // Accept internal calls (from automations) with x-internal-key + x-user-id
  const internalKey = process.env.INTERNAL_API_KEY || "";
  const provided = req.headers["x-internal-key"] || "";
  if (internalKey.length > 0 && provided.length === internalKey.length) {
    try {
      if (require("crypto").timingSafeEqual(Buffer.from(internalKey), Buffer.from(provided))) {
        req.userId = req.headers["x-user-id"] || "system";
        return next();
      }
    } catch(e) {}
  }
  return require("../middleware/auth").auth(req, res, next);
}, async (req, res) => {
  try {
    const { to, subject, html } = req.body;
    if (!to || !subject) return res.status(400).json({ error: "to and subject required" });
    // Strip newlines from header fields to prevent SMTP header injection
    const safeTo = String(to).replace(/[\r\n]/g, "");
    const safeSubject = String(subject).replace(/[\r\n]/g, "");
    const db = getDb();
    const user = db.prepare("SELECT plan, emails_sent, email_limit FROM users WHERE id = ?").get(req.userId);
    if (!isAdmin(db, req.userId) && user.emails_sent >= ((user.email_limit > 0) ? user.email_limit : planCap(user.plan, "emails", 500))) return res.status(429).json({ error: "Email limit reached", overLimit: true });

    const transporter = getTransporter();
    if (!transporter) return res.status(400).json({ error: "Email is not configured. Add a SendGrid API key or SMTP settings in admin settings, then try again." });
    await transporter.sendMail({ from: process.env.EMAIL_FROM || getSetting("EMAIL_FROM") || "noreply@takeova.ai", to: safeTo, subject: safeSubject, html });
    db.prepare("UPDATE users SET emails_sent = emails_sent + 1 WHERE id = ?").run(req.userId);
    // Track in usage_tracking for overage billing pipeline
    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "emails");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_email TEXT, subject TEXT, type TEXT, opened INTEGER DEFAULT 0, clicked INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
      db.prepare("INSERT INTO email_log (id, user_id, to_email, subject, type) VALUES (?,?,?,?,?)").run(require("uuid").v4(), req.userId, safeTo, safeSubject, req.body.type || "manual");
    } catch(e) {}
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed to send" }); }
});


// ─── EMAIL TEMPLATES ───
router.get("/templates", auth, (req, res) => {
  const db = getDb();
  try {
    const templates = db.prepare("SELECT * FROM email_templates WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
    res.json({ templates });
  } catch(e) { res.json({ templates: [] }); }
});

router.post("/templates", auth, (req, res) => {
  const db = getDb();
  const { name, subject, body_html, category } = req.body;
  const id = uuid();
  db.prepare("INSERT INTO email_templates (id, user_id, name, subject, body_html, category) VALUES (?,?,?,?,?,?)").run(id, req.userId, name||"", subject||"", body_html||"", category||"general");
  res.json({ success: true, id });
});

router.put("/templates/:id", auth, (req, res) => {
  const db = getDb();
  const { name, subject, body_html, category } = req.body;
  db.prepare("UPDATE email_templates SET name=?, subject=?, body_html=?, category=? WHERE id=? AND user_id=?").run(name||"", subject||"", body_html||"", category||"general", req.params.id, req.userId);
  res.json({ success: true });
});

router.delete("/templates/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM email_templates WHERE id=? AND user_id=?").run(req.params.id, req.userId);
  res.json({ success: true });
});

module.exports = router;

// ═══════════════════════════════════════════════════════════
// FUNNEL ENGINE — Enrollment, step processing, auto-send
// ═══════════════════════════════════════════════════════════

function ensureFunnelTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS funnel_enrollments (
    id TEXT PRIMARY KEY, funnel_id TEXT, user_id TEXT,
    contact_email TEXT, contact_name TEXT,
    current_step INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
    enrolled_at TEXT DEFAULT (datetime('now')),
    last_email_at TEXT, completed_at TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_fe_funnel ON funnel_enrollments(funnel_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fe_email ON funnel_enrollments(contact_email, funnel_id)");
}

// Enroll a contact in a funnel
router.post("/funnels/:id/enroll", auth, (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const db = getDb();
  ensureFunnelTables(db);

  // Ownership check — without this, any authenticated user could enroll
  // arbitrary emails in any funnel whose ID they know. The cron that
  // processes funnel steps uses the funnel owner's identity to send, so
  // an attacker could have the victim send spam/unwanted mail to emails
  // the attacker chose, damaging the victim's sender reputation and
  // burning their email quota.
  const funnel = db.prepare("SELECT * FROM funnels WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!funnel) return res.status(404).json({ error: "Funnel not found" });

  // Check not already enrolled
  const existing = db.prepare("SELECT id FROM funnel_enrollments WHERE funnel_id = ? AND contact_email = ? AND status = 'active'").get(req.params.id, email.toLowerCase());
  if (existing) return res.json({ success: true, existing: true });

  const id = require("uuid").v4();
  db.prepare("INSERT INTO funnel_enrollments (id, funnel_id, user_id, contact_email, contact_name) VALUES (?,?,?,?,?)")
    .run(id, req.params.id, req.userId, email.toLowerCase(), name || "");

  // Schedule emails for each funnel step
  try {
    const steps = JSON.parse(funnel.steps_json || "[]");
    let delay = 0;
    steps.forEach((step, i) => {
      delay += (step.delayDays || 0) * 86400000 + (step.delayHours || 0) * 3600000 + (i === 0 ? 0 : 0);
      const sendAt = new Date(Date.now() + delay).toISOString();
      db.prepare("INSERT INTO scheduled_emails (id, user_id, to_email, to_name, subject, body, send_at, type, ref_id) VALUES (?,?,?,?,?,?,?,'funnel',?)")
        .run(require('uuid').v4(), req.userId, email.toLowerCase(), name || "", step.subject || "", step.body || "", sendAt, id);
    });
  } catch(schedErr) {}
  res.json({ success: true, enrollmentId: id });
});

// Auto-enroll when trigger event happens
function autoEnrollInFunnels(db, userId, triggerEvent, email, name) {
  try {
    ensureFunnelTables(db);
    db.exec("CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, trigger_event TEXT, status TEXT DEFAULT 'draft', emails_json TEXT DEFAULT '[]', steps_json TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')))");

    const funnels = db.prepare("SELECT * FROM funnels WHERE user_id = ? AND status = 'active' AND trigger_event = ?").all(userId, triggerEvent);
    for (const funnel of funnels) {
      const existing = db.prepare("SELECT id FROM funnel_enrollments WHERE funnel_id = ? AND contact_email = ?").get(funnel.id, email.toLowerCase());
      if (existing) continue;

      const id = require("uuid").v4();
      db.prepare("INSERT INTO funnel_enrollments (id, funnel_id, user_id, contact_email, contact_name) VALUES (?,?,?,?,?)")
        .run(id, funnel.id, userId, email.toLowerCase(), name || "");
    }
  } catch(e) {}
}

// Process funnel steps — called by cron every hour
async function processFunnelSteps(db) {
  try {
    ensureFunnelTables(db);
    db.exec("CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, trigger_event TEXT, status TEXT DEFAULT 'draft', emails_json TEXT DEFAULT '[]', steps_json TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')))");

    const activeFunnels = db.prepare("SELECT * FROM funnels WHERE status = 'active'").all();
    let sent = 0;

    for (const funnel of activeFunnels) {
      const steps = JSON.parse(funnel.steps_json || funnel.emails_json || "[]");
      if (steps.length === 0) continue;

      const enrollments = db.prepare("SELECT * FROM funnel_enrollments WHERE funnel_id = ? AND status = 'active'").all(funnel.id);

      for (const enrollment of enrollments) {
        const stepIndex = enrollment.current_step || 0;
        if (stepIndex >= steps.length) {
          // Funnel complete
          db.prepare("UPDATE funnel_enrollments SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(enrollment.id);
          continue;
        }

        const step = steps[stepIndex];
        const dayDelay = step.delay || 0;
        const enrolledAt = new Date(enrollment.enrolled_at);
        const dueAt = new Date(enrolledAt.getTime() + dayDelay * 24 * 60 * 60 * 1000);

        if (new Date() < dueAt) continue; // Not due yet

        // Check if we already sent this step (prevent double-send)
        const lastEmailAt = enrollment.last_email_at ? new Date(enrollment.last_email_at) : null;
        if (lastEmailAt && stepIndex === enrollment.current_step) {
          // Already sent this step — advance to next
          db.prepare("UPDATE funnel_enrollments SET current_step = current_step + 1 WHERE id = ?").run(enrollment.id);
          continue;
        }

        // Check unsubscribed
        try {
          const unsub = db.prepare("SELECT id FROM email_unsubscribes WHERE user_id = ? AND email = ?").get(funnel.user_id, enrollment.contact_email);
          if (unsub) { db.prepare("UPDATE funnel_enrollments SET status = 'unsubscribed' WHERE id = ?").run(enrollment.id); continue; }
        } catch(e) { console.error("[/:id/enroll]", e.message || e); }

        // Send the email
        const sgKey = getSetting("SENDGRID_API_KEY");
        const fromEmail = process.env.EMAIL_FROM || getSetting("EMAIL_FROM") || "noreply@takeova.ai";
        if (!sgKey) continue;

        // Enforce plan email cap — funnels run server-side so must check before each send
        const userLimits = db.prepare("SELECT plan, emails_sent, email_limit FROM users WHERE id = ?").get(funnel.user_id);
        if (userLimits && !isAdmin(db, funnel.user_id) && userLimits.emails_sent >= ((userLimits.email_limit > 0) ? userLimits.email_limit : planCap(userLimits.plan, "emails", 500))) {

          continue;
        }

        const site = db.prepare("SELECT name, custom_domain, domain FROM sites WHERE user_id = ? LIMIT 1").get(funnel.user_id);
        const bizName = site?.name || "Business";
        const user = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(funnel.user_id);
        const refCode = user?.referral_code || "";
        const encodedEmail = Buffer.from(enrollment.contact_email).toString("base64");
        const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
        const unsubLink = `${backendUrl}/api/features/unsubscribe/${funnel.user_id}/${encodedEmail}`;

        // Build the site URL for {{site_url}} placeholder resolution.
        // Previously only {{name}} and {{email}} were replaced, so every
        // built-in funnel template containing {{site_url}} (from
        // platform.js BUSINESS_DEFAULTS) sent customers emails with the
        // literal text "{{site_url}}" in the body — broken CTAs, broken
        // login links, broken booking links across the board.
        const siteUrl = site?.custom_domain
          ? (site.custom_domain.startsWith("http") ? site.custom_domain : "https://" + site.custom_domain)
          : site?.domain
          ? "https://" + site.domain
          : (process.env.FRONTEND_URL || "https://takeova.ai");

        const fillVars = (text) => String(text || "")
          .replace(/\{\{name\}\}/g, escapeHtml(enrollment.contact_name || "there"))
          .replace(/\{\{email\}\}/g, escapeHtml(enrollment.contact_email))
          .replace(/\{\{site_url\}\}/g, escapeHtml(siteUrl))
          .replace(/\{\{business\}\}/g, escapeHtml(bizName))
          .replace(/\{\{business_name\}\}/g, escapeHtml(bizName));

        const subject = fillVars(step.subject || "Update from " + bizName);
        const body = fillVars(step.body || step.content || "");

        try {
          const fetch = (await import("node-fetch")).default;

          // Create tracking pixel
          const trackId = require("uuid").v4();
          db.exec("CREATE TABLE IF NOT EXISTS email_tracking (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, track_id TEXT UNIQUE, opened INTEGER DEFAULT 0, opened_at TEXT, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
          db.prepare("INSERT INTO email_tracking (id, user_id, email, subject, track_id) VALUES (?,?,?,?,?)").run(require("uuid").v4(), funnel.user_id, enrollment.contact_email, subject, trackId);
          const trackPixel = `<img src="${backendUrl}/api/features/track/open/${trackId}" width="1" height="1" style="display:none" />`;

          const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: enrollment.contact_email }] }],
              from: { email: fromEmail, name: bizName },
              subject,
              content: [{ type: "text/html", value: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">${body.replace(/\n/g, "<br>")}${trackPixel}<div style="margin-top:32px;padding-top:16px;border-top:1px solid #f0f0f0;text-align:center"><a href="https://takeova.ai${refCode ? "?ref=" + refCode : ""}" style="color:#999;font-size:11px;text-decoration:none">Sent via <strong style="color:#2563EB">MINE</strong></a><br><a href="${unsubLink}" style="color:#bbb;font-size:10px;text-decoration:none">Unsubscribe</a></div></div>` }]
            })
          });

          // Only advance the funnel step, increment quota, and track usage
          // IF SendGrid actually accepted the email. Previously every send
          // was treated as successful — so a misconfigured sender domain
          // or bounced recipient made the funnel silently advance without
          // ever delivering email, while still billing the user for it.
          if (!resp.ok) {
            let errBody = "";
            try { errBody = (await resp.text()).slice(0, 300); } catch(_) {}
            console.error(`[Funnel] SendGrid ${resp.status} for ${enrollment.contact_email}: ${errBody}`);
            continue; // skip the advance/tracking block below
          }

          // Update enrollment
          db.prepare("UPDATE funnel_enrollments SET current_step = current_step + 1, last_email_at = datetime('now') WHERE id = ?").run(enrollment.id);
          db.prepare("UPDATE users SET emails_sent = emails_sent + 1 WHERE id = ?").run(funnel.user_id);
          // Track in usage_tracking for overage billing pipeline.
          // Previously only emails_sent was incremented — funnel emails that
          // pushed a user over their plan cap never triggered overage billing.
          if (typeof global !== "undefined" && global.mineTrackUsage) {
            try { global.mineTrackUsage(db, funnel.user_id, "emails"); } catch(e) {}
          }
          sent++;
        } catch(e) { console.error("[Funnel] send error:", e.message); }
      }
    }

    if (sent > 0) console.log(`[CRON] Funnel engine: sent ${sent} emails`);
  } catch(e) { console.error("Funnel engine error:", e.message); }
}

// View enrollments for a funnel
router.get("/funnels/:id/enrollments", auth, (req, res) => {
  const db = getDb();
  ensureFunnelTables(db);
  const enrollments = db.prepare("SELECT * FROM funnel_enrollments WHERE funnel_id = ? AND user_id = ? ORDER BY enrolled_at DESC LIMIT 100").all(req.params.id, req.userId);
  res.json({ enrollments });
});

module.exports.autoEnrollInFunnels = autoEnrollInFunnels;
module.exports.processFunnelSteps = processFunnelSteps;
// ─── FUNNEL ENGINE (2026-06-11): advances enrollments, sends due steps ───
async function _runFunnelEngine(db, onlyUser) {
  ensureFunnelTables(db);
  try { db.exec("ALTER TABLE funnels ADD COLUMN on_reply TEXT DEFAULT 'continue'"); } catch (_a1) {}
  try { db.exec("ALTER TABLE funnel_enrollments ADD COLUMN replied INTEGER DEFAULT 0"); } catch (_a2) {}
  try { db.exec("ALTER TABLE funnel_enrollments ADD COLUMN replied_at TEXT"); } catch (_a3) {}
  if (!process.env.SENDGRID_API_KEY) return { sent: 0, completed: 0, failed: 0, error: "SENDGRID_API_KEY not configured" };
  const sgMail = require("@sendgrid/mail"); sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const fromEmail = process.env.EMAIL_FROM || "noreply@takeova.ai";
  const fromName = process.env.SENDGRID_FROM_NAME || "MINE";
  let rows = db.prepare("SELECT e.*, f.emails_json AS _steps, f.status AS _fstatus FROM funnel_enrollments e JOIN funnels f ON f.id = e.funnel_id WHERE e.status = 'active'" + (onlyUser ? " AND e.user_id = ?" : "")).all(...(onlyUser ? [onlyUser] : []));
  let sent = 0, completed = 0, failed = 0;
  for (const e of rows.slice(0, 400)) {
    try {
      if (e._fstatus !== "active") continue;
      let steps = []; try { steps = JSON.parse(e._steps || "[]"); } catch (_p) {}
      if (e.current_step >= steps.length) {
        db.prepare("UPDATE funnel_enrollments SET status='completed', completed_at=datetime('now') WHERE id=?").run(e.id); completed++; continue;
      }
      const st = steps[e.current_step] || {};
      const delayDays = Number(st.delay_days != null ? st.delay_days : (st.delay || 0)) || 0;
      const base = Date.parse(e.last_email_at || e.enrolled_at || 0);
      if (Date.now() - base < delayDays * 86400000) continue;
      const owner = db.prepare("SELECT sender_email, email FROM users WHERE id = ?").get(e.user_id) || {};
      const nm = e.contact_name || "there";
      const subj = String(st.subject || "Hello").replace(/{{\s*name\s*}}/gi, nm).slice(0, 180);
      const bodyTxt = String(st.body || "").replace(/{{\s*name\s*}}/gi, nm).slice(0, 12000);
      await sgMail.send({
        to: e.contact_email,
        from: { email: fromEmail, name: fromName },
        reply_to: { email: (process.env.EMAIL_FROM_DOMAIN ? ("reply+" + e.id + "@" + process.env.EMAIL_FROM_DOMAIN) : (owner.sender_email || owner.email || (process.env.EMAIL_FROM || "noreply@takeova.ai"))) },
        subject: subj,
        html: bodyTxt.replace(/\n/g, "<br>")
      });
      const nxt = e.current_step + 1;
      if (nxt >= steps.length) db.prepare("UPDATE funnel_enrollments SET current_step=?, last_email_at=datetime('now'), status='completed', completed_at=datetime('now') WHERE id=?").run(nxt, e.id);
      else db.prepare("UPDATE funnel_enrollments SET current_step=?, last_email_at=datetime('now') WHERE id=?").run(nxt, e.id);
      sent++;
    } catch (_se) { failed++; }
  }
  return { sent, completed, failed };
}
router.post("/funnels/run", async (req, res) => {
  try {
    const sec = req.query.secret || req.headers["x-cron-secret"];
    if (!process.env.CRON_SECRET || sec !== process.env.CRON_SECRET) return res.status(403).json({ error: "Forbidden" });
    res.json(await _runFunnelEngine(getDb()));
  } catch (e) { res.status(500).json({ error: "Funnel run failed" }); }
});
router.post("/funnels/run-mine", auth, async (req, res) => {
  try { res.json(await _runFunnelEngine(getDb(), req.userId)); }
  catch (e) { res.status(500).json({ error: "Funnel run failed" }); }
});

module.exports.getTransporter = getTransporter;
