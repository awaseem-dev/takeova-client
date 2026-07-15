const express = require("express");
const { isAdmin } = require('../utils/admin-check');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { getSmsSender } = require("../utils/sms");
const { auth } = require("../middleware/auth");
const { getSetting } = require("./integrations");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Verify inbound webhook signatures to prevent forged reply events
function verifyWebhookSignature(req) {
  // Twilio SMS: validate X-Twilio-Signature via HMAC-SHA1
  const twilioSig = req.headers["x-twilio-signature"];
  const twilioToken = getSetting("TWILIO_AUTH_TOKEN");
  if (twilioSig && twilioToken) {
    const url = (process.env.BACKEND_URL || "http://localhost:4000") + "/api/outreach/webhook/reply";
    const params = req.body || {};
    const sortedKeys = Object.keys(params).sort();
    let str = url;
    for (const k of sortedKeys) str += k + params[k];
    const expected = crypto.createHmac("sha1", twilioToken).update(str).digest("base64");
    if (crypto.timingSafeEqual(Buffer.from(twilioSig), Buffer.from(expected))) return true;
  }
  // SendGrid Inbound Parse: validate X-Twilio-Email-Event-Webhook-Signature
  const sgSig = req.headers["x-twilio-email-event-webhook-signature"];
  const sgKey = getSetting("SENDGRID_WEBHOOK_PUBLIC_KEY");
  if (sgSig && sgKey) {
    // ECDSA P-256 verification — accept if valid
    try {
      const payload = req.rawBody || JSON.stringify(req.body);
      const verify = crypto.createVerify("SHA256");
      verify.update(payload);
      if (verify.verify({ key: sgKey, format: "pem" }, sgSig, "base64")) return true;
    } catch (_) {}
  }
  // If neither provider signature is present, allow only if no auth tokens are configured
  // (i.e., the platform hasn't set up Twilio or SendGrid — dev/test mode)
  const hasTwilio = !!getSetting("TWILIO_AUTH_TOKEN");
  const hasSendgrid = !!getSetting("SENDGRID_API_KEY");
  if (!hasTwilio && !hasSendgrid) return true; // Dev mode: no signing keys configured
  return false; // Production: reject unverified requests
}

const router = express.Router();
const outreachSendLimiter = rateLimit({ windowMs: 60000, max: 5, message: { error: "Too many send requests." } });
const outreachLimiter = rateLimit({ windowMs: 60000, max: 20, message: { error: "Too many outreach campaigns — slow down." } });
const upload = multer({
  dest: path.join(__dirname, "../uploads/lists"),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max — ~50k contacts
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const okMime = ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"].includes(file.mimetype);
    if (ext === ".csv" || okMime) cb(null, true);
    else cb(new Error("Only CSV files are accepted for contact lists"));
  },
});

// ═══════════════════════════════════════════════
// AI COLD OUTREACH ENGINE
// Upload list → AI personalises → sends email/SMS
// Pay per message: $0.005/email, $0.03/SMS
// ═══════════════════════════════════════════════

const PRICING = {
  get email() { try { return parseFloat(getSetting("OUTREACH_EMAIL_RATE")) || 0.008; } catch(e) { return 0.008; } },
  get sms() { try { return parseFloat(getSetting("OUTREACH_SMS_RATE")) || 0.03; } catch(e) { return 0.03; } },
  get whatsapp() { try { return parseFloat(getSetting("OUTREACH_WHATSAPP_RATE")) || 0.04; } catch(e) { return 0.04; } },
};

// ─── UPLOAD LIST ───
// CSV with: name, email, phone, company, notes (any extra cols become custom fields)
router.post("/list/upload", auth, upload.single("file"), async (req, res) => {
  const db = getDb();
  ensureTables(db);

  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  // Magic-byte validation — ensure file is actually text/CSV, not a renamed binary
  const { validateUploadedFile } = require("../lib/file-validator");
  const validation = validateUploadedFile(req.file.path, "text");
  if (!validation.valid) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: "Invalid file: " + validation.reason });
  }

  const { name, description } = req.body;
  const listId = uuid();
  // Guard: multer limit is 5MB but double-check before reading into memory
  if (req.file.size > 5 * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "File too large — max 5MB (~50,000 contacts)" });
  }
  const raw = fs.readFileSync(req.file.path, "utf8");

  // Parse CSV
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: "CSV needs a header row and at least one contact" });

  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
  const contacts = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    if (vals.length < 2) continue;
    const contact = {};
    headers.forEach((h, j) => { contact[h] = vals[j]?.trim() || ""; });
    // Normalise common field names
    contact._name = contact.name || contact.first_name || contact.full_name || contact.contact || "";
    contact._email = contact.email || contact.email_address || contact.mail || "";
    contact._phone = contact.phone || contact.mobile || contact.cell || contact.phone_number || "";
    contact._company = contact.company || contact.business || contact.org || contact.organisation || "";
    contacts.push(contact);
  }

  if (contacts.length === 0) return res.status(400).json({ error: "No valid contacts found in CSV" });

  // Save list
  db.prepare(`INSERT INTO outreach_lists (id, user_id, name, description, total_contacts, headers, status, created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))`)
    .run(listId, req.userId, name || "Imported List", description || "", contacts.length, JSON.stringify(headers), "ready");

  // Save contacts
  const ins = db.prepare(`INSERT INTO outreach_contacts (id, list_id, user_id, name, email, phone, company, custom_fields, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`);

  const insertMany = db.transaction((items) => {
    for (const c of items) {
      ins.run(uuid(), listId, req.userId, c._name, c._email, c._phone, c._company, JSON.stringify(c), "pending");
    }
  });
  insertMany(contacts);

  // Clean up temp file
  fs.unlinkSync(req.file.path);

  db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
    .run(req.userId, "list_uploaded", JSON.stringify({ listId, contacts: contacts.length }));

  res.json({
    success: true, listId,
    contacts: contacts.length,
    hasEmail: contacts.filter(c => c._email).length,
    hasPhone: contacts.filter(c => c._phone).length,
    headers,
    estimatedCost: {
      email: (contacts.filter(c => c._email).length * PRICING.email).toFixed(2),
      sms: (contacts.filter(c => c._phone).length * PRICING.sms).toFixed(2),
    },
  });
});

// ─── GET LISTS ───
router.get("/lists", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const lists = db.prepare("SELECT * FROM outreach_lists WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ lists });
});

// ─── GET LIST CONTACTS ───
router.get("/list/:listId/contacts", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { limit, offset, status } = req.query;
  let sql = "SELECT * FROM outreach_contacts WHERE list_id = ? AND user_id = ?";
  const params = [req.params.listId, req.userId];
  if (status) { sql += " AND status = ?"; params.push(status); }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(parseInt(limit) || 50, parseInt(offset) || 0);
  const contacts = db.prepare(sql).all(...params);
  const total = db.prepare("SELECT COUNT(*) as n FROM outreach_contacts WHERE list_id = ? AND user_id = ?").get(req.params.listId, req.userId).n;
  res.json({ contacts: contacts.map(c => ({ ...c, custom_fields: JSON.parse(c.custom_fields || "{}") })), total });
});

// ─── DELETE LIST ───
router.delete("/list/:listId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("DELETE FROM outreach_contacts WHERE list_id = ? AND user_id = ?").run(req.params.listId, req.userId);
  db.prepare("DELETE FROM outreach_lists WHERE id = ? AND user_id = ?").run(req.params.listId, req.userId);
  db.prepare("DELETE FROM outreach_campaigns WHERE list_id = ? AND user_id = ?").run(req.params.listId, req.userId);
  res.json({ success: true });
});

// ─── CREATE CAMPAIGN ───
// Configure what the AI sends, set channel, set schedule
router.post("/campaign", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);

  // Pre-check usage caps for outreach
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const emailUsage = global.mineCheckUsage(db, req.userId, "outreachEmails");
    const smsUsage = global.mineCheckUsage(db, req.userId, "outreachSMS");
    if (req.body.channel !== "sms" && emailUsage.blocked) return res.status(403).json({ error: "Outreach emails not on your plan. Upgrade required.", upgrade: true });
    if (req.body.channel !== "email" && smsUsage.blocked) return res.status(403).json({ error: "SMS not on your plan. Upgrade required.", upgrade: true });
  }

  const {
    listId, name, channel, // "email", "sms", "both"
    goal, // "book_meeting", "get_reply", "drive_traffic", "promote_offer"
    context, // business context + what you're selling
    tone, // "professional", "friendly", "casual", "bold"
    followUps, // number of follow-ups (0-5)
    followUpDays, // days between follow-ups [2, 4, 7]
    schedule, // "now", "scheduled"
    scheduledTime, // ISO datetime
    senderName, // who the email comes from
    senderEmail, // reply-to email
    signature, // email signature
    offer, // special offer text
    callToAction, // CTA text / link
    excludeReplied, // don't re-contact people who replied
    dailyLimit, // max sends per day
    unsubscribeLink, // true/false
  } = req.body;

  const list = db.prepare("SELECT * FROM outreach_lists WHERE id = ? AND user_id = ?").get(listId, req.userId);
  if (!list) return res.status(404).json({ error: "List not found" });

  // Validate sender_email format if provided — prevents malformed values reaching SendGrid from header
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (senderEmail && !EMAIL_RE.test(senderEmail)) {
    return res.status(400).json({ error: "Invalid sender email address" });
  }
  // Sanitise sender_name — strip newlines to prevent header injection on non-JSON transports
  const safeSenderName = (senderName || "").replace(/[\r\n]/g, " ").slice(0, 100);

  // Count eligible contacts
  const emailCount = db.prepare("SELECT COUNT(*) as n FROM outreach_contacts WHERE list_id = ? AND user_id = ? AND email != '' AND status != 'unsubscribed'").get(listId, req.userId).n;
  const smsCount = db.prepare("SELECT COUNT(*) as n FROM outreach_contacts WHERE list_id = ? AND user_id = ? AND phone != '' AND status != 'unsubscribed'").get(listId, req.userId).n;

  const totalSends = channel === "both" ? emailCount + smsCount : channel === "email" ? emailCount : smsCount;
  const totalFollowUps = totalSends * (followUps || 0);
  const totalMessages = totalSends + totalFollowUps;
  const costPerMsg = channel === "sms" ? PRICING.sms : channel === "both" ? (PRICING.email + PRICING.sms) / 2 : PRICING.email;
  const estimatedCost = (totalMessages * costPerMsg).toFixed(2);

  const campaignId = uuid();
  db.prepare(`INSERT INTO outreach_campaigns (id, user_id, list_id, name, channel, goal, context, tone,
    follow_ups, follow_up_days, schedule, scheduled_time, sender_name, sender_email, signature,
    offer, call_to_action, daily_limit, unsubscribe_link, status, total_contacts, estimated_cost, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(campaignId, req.userId, listId, name || "Outreach Campaign", channel || "email",
      goal || "get_reply", context || "", tone || "professional",
      followUps || 0, JSON.stringify(followUpDays || [2, 5]), schedule || "now", scheduledTime || null,
      safeSenderName, senderEmail || "", signature || "",
      offer || "", callToAction || "", dailyLimit || 100, unsubscribeLink ? 1 : 0,
      schedule === "now" ? "running" : "scheduled", totalSends, estimatedCost);

  // If immediate, start sending
  if (schedule === "now" || !schedule) {
    processCampaign(db, campaignId, req.userId).catch(e => {
      console.error("Campaign error:", e.message);
      db.prepare("UPDATE outreach_campaigns SET status = 'error' WHERE id = ?").run(campaignId);
    });
  }

  res.json({
    success: true, campaignId,
    totalContacts: totalSends,
    totalMessages,
    estimatedCost,
    status: schedule === "now" ? "running" : "scheduled",
  });
});

// ─── GET CAMPAIGNS ───
router.get("/campaigns", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const campaigns = db.prepare("SELECT * FROM outreach_campaigns WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ campaigns: campaigns.map(c => ({ ...c, follow_up_days: JSON.parse(c.follow_up_days || "[]") })) });
});

// ─── CAMPAIGN STATS ───
router.get("/campaign/:id/stats", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  const campaign = db.prepare("SELECT * FROM outreach_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const sent = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE campaign_id = ? AND status = 'sent'").get(req.params.id).n;
  const delivered = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE campaign_id = ? AND status IN ('sent','opened','clicked','replied')").get(req.params.id).n;
  const opened = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE campaign_id = ? AND status IN ('opened','clicked','replied')").get(req.params.id).n;
  const clicked = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE campaign_id = ? AND status IN ('clicked','replied')").get(req.params.id).n;
  const replied = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE campaign_id = ? AND status = 'replied'").get(req.params.id).n;
  const bounced = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE campaign_id = ? AND status = 'bounced'").get(req.params.id).n;
  const unsub = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE campaign_id = ? AND status = 'unsubscribed'").get(req.params.id).n;
  const pending = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE campaign_id = ? AND status = 'pending'").get(req.params.id).n;
  const totalCost = db.prepare("SELECT SUM(cost) as n FROM outreach_messages WHERE campaign_id = ?").get(req.params.id).n || 0;

  const recentMessages = db.prepare(`SELECT * FROM outreach_messages WHERE campaign_id = ?
    ORDER BY created_at DESC LIMIT 20`).all(req.params.id);

  res.json({
    campaign,
    stats: {
      sent, delivered, opened, clicked, replied, bounced, unsubscribed: unsub, pending,
      openRate: sent > 0 ? Math.round(opened / sent * 100) : 0,
      clickRate: sent > 0 ? Math.round(clicked / sent * 100) : 0,
      replyRate: sent > 0 ? Math.round(replied / sent * 100) : 0,
      bounceRate: sent > 0 ? Math.round(bounced / sent * 100) : 0,
      totalCost: totalCost.toFixed(2),
    },
    recentMessages,
  });
});

// ─── PAUSE / RESUME / CANCEL CAMPAIGN ───
router.post("/campaign/:id/pause", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("UPDATE outreach_campaigns SET status = 'paused' WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true, status: "paused" });
});

router.post("/campaign/:id/resume", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("UPDATE outreach_campaigns SET status = 'running' WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  const campaign = db.prepare("SELECT * FROM outreach_campaigns WHERE id = ?").get(req.params.id);
  if (campaign) processCampaign(db, req.params.id, req.userId).catch(console.error);
  res.json({ success: true, status: "running" });
});

router.post("/campaign/:id/cancel", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("UPDATE outreach_campaigns SET status = 'cancelled' WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  db.prepare("UPDATE outreach_messages SET status = 'cancelled' WHERE campaign_id = ? AND status = 'pending'").run(req.params.id);
  res.json({ success: true, status: "cancelled" });
});

// ─── UNSUBSCRIBE ENDPOINT (public) ───
router.get("/unsubscribe/:token", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const msg = db.prepare("SELECT * FROM outreach_messages WHERE unsubscribe_token = ?").get(req.params.token);
  if (msg) {
    db.prepare("UPDATE outreach_contacts SET status = 'unsubscribed' WHERE id = ?").run(msg.contact_id);
    db.prepare("UPDATE outreach_messages SET status = 'unsubscribed' WHERE id = ?").run(msg.id);
  }
  res.send(`<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center"><div><h2>Unsubscribed</h2><p>You've been removed from this list and won't receive further messages.</p></div></body></html>`);
});

// ─── TRACK OPEN (pixel) ───
router.get("/track/open/:msgId", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const msg = db.prepare("SELECT status FROM outreach_messages WHERE id = ?").get(req.params.msgId);
  if (msg && msg.status === "sent") {
    db.prepare("UPDATE outreach_messages SET status = 'opened', opened_at = datetime('now') WHERE id = ?").run(req.params.msgId);
  }
  // Return 1x1 transparent GIF
  const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-cache" });
  res.send(pixel);
});

// ─── TRACK CLICK ───
router.get("/track/click/:msgId", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const msg = db.prepare("SELECT * FROM outreach_messages WHERE id = ?").get(req.params.msgId);
  if (msg) {
    db.prepare("UPDATE outreach_messages SET status = 'clicked', clicked_at = datetime('now') WHERE id = ?").run(req.params.msgId);
    // Also update contact status
    db.prepare("UPDATE outreach_contacts SET status = 'engaged' WHERE id = ?").run(msg.contact_id);
  }
  // Only redirect to safe URLs stored in the message, not user-supplied query params
  const destination = msg?.redirect_url || process.env.FRONTEND_URL || "/";
  // Validate it's a relative path or http(s) URL, not javascript: or data:
  const safeUrl = /^https?:\/\/|^\//.test(destination) ? destination : "/";
  res.redirect(safeUrl);
});

// ─── WEBHOOK: RECEIVE REPLIES ───
// SendGrid inbound parse or Twilio webhook
router.post("/webhook/reply", async (req, res) => {
  try {
  // Verify request authenticity before processing
  if (!verifyWebhookSignature(req)) {
    return res.status(403).json({ error: "Invalid webhook signature" });
  }
  const db = getDb();
  ensureTables(db);
  const { from, text, to, type } = req.body; // type: "email" or "sms"

  // ── Funnel reply branching (2026-06-11): replies to reply+<enrollmentId>@EMAIL_FROM_DOMAIN ──
  try {
    if (type !== "sms") {
      const _m = String(to || "").match(/reply\+([a-zA-Z0-9-]{8,})@/);
      if (_m) {
        const enr = db.prepare("SELECT * FROM funnel_enrollments WHERE id = ?").get(_m[1]);
        if (enr) {
          try { db.exec("ALTER TABLE funnel_enrollments ADD COLUMN replied INTEGER DEFAULT 0"); } catch (_a) {}
          try { db.exec("ALTER TABLE funnel_enrollments ADD COLUMN replied_at TEXT"); } catch (_a) {}
          db.prepare("UPDATE funnel_enrollments SET replied = 1, replied_at = datetime('now') WHERE id = ?").run(enr.id);
          try { db.exec("ALTER TABLE funnel_enrollments ADD COLUMN reply_text TEXT"); } catch (_a) {}
          try { db.prepare("UPDATE funnel_enrollments SET reply_text = ? WHERE id = ?").run(String(text || "").slice(0, 4000), enr.id); } catch (_t) {}
          try { // ping the in-app bell, same as outreach replies
            const fname = ((db.prepare("SELECT name FROM funnels WHERE id = ?").get(enr.funnel_id) || {}).name) || "your funnel";
            db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,datetime('now'))")
              .run(require("uuid").v4(), enr.user_id, "\ud83d\udcac", (from + " replied to \u201c" + fname + "\u201d: " + String(text || "").slice(0, 90)));
          } catch (_n) {}
          try { // thread it into the Unified Inbox (email channel is subject-level by design)
            db.prepare("INSERT INTO email_log (id, user_id, to_email, subject, type) VALUES (?,?,?,?,?)")
              .run(require("uuid").v4(), enr.user_id, enr.contact_email, ("\u21a9 Reply: " + String(text || "").replace(/\s+/g, " ").slice(0, 80)), "funnel_reply");
          } catch (_il) {}
          let onr = "continue";
          try { onr = (db.prepare("SELECT on_reply FROM funnels WHERE id = ?").get(enr.funnel_id) || {}).on_reply || "continue"; } catch (_o) {}
          if (onr === "stop") {
            db.prepare("UPDATE funnel_enrollments SET status = 'stopped_reply' WHERE id = ?").run(enr.id);
          } else if (onr && onr.indexOf("enroll:") === 0) {
            db.prepare("UPDATE funnel_enrollments SET status = 'stopped_reply' WHERE id = ?").run(enr.id);
            const tgt = onr.slice(7);
            const ok = db.prepare("SELECT id FROM funnels WHERE id = ? AND user_id = ?").get(tgt, enr.user_id);
            const dup = ok && db.prepare("SELECT 1 FROM funnel_enrollments WHERE funnel_id = ? AND contact_email = ?").get(tgt, enr.contact_email);
            if (ok && !dup) db.prepare("INSERT INTO funnel_enrollments (id, funnel_id, user_id, contact_email, contact_name) VALUES (?,?,?,?,?)").run(require("uuid").v4(), tgt, enr.user_id, enr.contact_email, enr.contact_name || "");
          }
          try { // forward the human's words to the owner's real inbox
            if (process.env.SENDGRID_API_KEY) {
              const sg = require("@sendgrid/mail"); sg.setApiKey(process.env.SENDGRID_API_KEY);
              const owner = db.prepare("SELECT email, sender_email FROM users WHERE id = ?").get(enr.user_id) || {};
              const dest = owner.sender_email || owner.email;
              if (dest) await sg.send({ to: dest, from: { email: process.env.EMAIL_FROM || "noreply@takeova.ai", name: "MINE Funnels" }, reply_to: { email: from }, subject: "Funnel reply from " + from, html: String(text || "").slice(0, 9000).replace(/\n/g, "<br>") });
            }
          } catch (_f) {}
          return res.json({ success: true, funnel_reply: true });
        }
      }
    }
  } catch (_fr) { /* fall through to outreach handling */ }


  // Find the contact by email or phone
  const contact = type === "sms"
    ? db.prepare("SELECT * FROM outreach_contacts WHERE phone = ? OR phone = ?").get(from, from.replace(/^\+/, ""))
    : db.prepare("SELECT * FROM outreach_contacts WHERE email = ?").get(from);

  if (contact) {
    db.prepare("UPDATE outreach_contacts SET status = 'replied' WHERE id = ?").run(contact.id);
    const msg = db.prepare("SELECT * FROM outreach_messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1").get(contact.id);
    if (msg) {
      db.prepare("UPDATE outreach_messages SET status = 'replied', replied_at = datetime('now'), reply_text = ? WHERE id = ?").run(text, msg.id);
    }

    // Notify the user
    db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
      .run(uuid(), contact.user_id, "💬", `${contact.name || from} replied to your outreach: "${(text || "").slice(0, 100)}"`, "Just now");

    // Trigger AI Sales Rep if enabled
    const salesAgent = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND role = 'sales' AND enabled = 1").get(contact.user_id);
    if (salesAgent) {
      // The AI employee trigger system will handle the follow-up
      const fetch = (await import("node-fetch")).default;
      fetch(`${process.env.BACKEND_URL || "http://localhost:4000"}/ai-employees/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY || "", "x-internal-user-id": contact.user_id },
        body: JSON.stringify({ event: "lead_replied", data: { contact, replyText: text } }),
      }).catch(() => {});
    }
  }

  res.json({ received: true });

  } catch (e) {
    console.error("[/webhook/reply]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// ─── CREDITS / BALANCE ───
router.get("/credits", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT outreach_credits FROM users WHERE id = ?").get(req.userId);
  const spent = db.prepare("SELECT SUM(cost) as n FROM outreach_messages WHERE user_id = ?").get(req.userId).n || 0;
  const totalSent = db.prepare("SELECT COUNT(*) as n FROM outreach_messages WHERE user_id = ? AND status != 'pending' AND status != 'cancelled'").get(req.userId).n;
  res.json({
    credits: user?.outreach_credits || 0,
    spent: spent.toFixed(2),
    totalSent,
    pricing: PRICING,
  });
});

// ─── ADD CREDITS ───
// Called after Stripe payment for credits
// NOTE: /credits/add must ONLY be called from the Stripe webhook after a verified payment.
// Protect with INTERNAL_API_KEY so no user can self-assign credits directly.
router.post("/credits/add", (req, res) => {
  const internalKey = req.headers["x-internal-key"];
  if (!((_k, _s) => _k.length > 0 && _s.length === _k.length && require("crypto").timingSafeEqual(Buffer.from(_s), Buffer.from(_k)))(process.env.INTERNAL_API_KEY || "", internalKey || "")) {
    return res.status(403).json({ error: "Forbidden — must be called from payment webhook" });
  }
  const db = getDb();
  ensureTables(db);
  const { userId, amount } = req.body;
  if (!userId || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: "userId and positive amount required" });
  }
  db.prepare("UPDATE users SET outreach_credits = COALESCE(outreach_credits, 0) + ? WHERE id = ?").run(amount, userId);
  db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(userId, "credits_purchased", JSON.stringify({ amount }));
  res.json({ success: true, newBalance: db.prepare("SELECT outreach_credits FROM users WHERE id = ?").get(userId).outreach_credits });
});

// ═══════════════════════════════════════════════
// CAMPAIGN PROCESSOR
// ═══════════════════════════════════════════════

async function processCampaign(db, campaignId, userId) {
  const campaign = db.prepare("SELECT * FROM outreach_campaigns WHERE id = ?").get(campaignId);
  if (!campaign || campaign.status !== "running") return;

  const contacts = db.prepare(`SELECT * FROM outreach_contacts WHERE list_id = ? AND user_id = ? AND status NOT IN ('unsubscribed','bounced')`)
    .all(campaign.list_id, userId);

  const dailyLimit = campaign.daily_limit || 100;
  let sentToday = 0;
  const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";

  for (const contact of contacts) {
    if (sentToday >= dailyLimit) break;

    // Check campaign hasn't been paused/cancelled
    const current = db.prepare("SELECT status FROM outreach_campaigns WHERE id = ?").get(campaignId);
    if (current.status !== "running") break;

    // Check credits
    const user = db.prepare("SELECT outreach_credits FROM users WHERE id = ?").get(userId);
    const cost = campaign.channel === "sms" ? PRICING.sms : PRICING.email;
    if (!isAdmin(db, userId) && (user.outreach_credits || 0) < cost) {
      db.prepare("UPDATE outreach_campaigns SET status = 'paused_no_credits' WHERE id = ?").run(campaignId);
      db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
        .run(uuid(), userId, "⚠️", "Outreach campaign paused — insufficient credits. Add more to continue.", "Just now");
      break;
    }

    // Check if already messaged in this campaign
    const existing = db.prepare("SELECT id FROM outreach_messages WHERE campaign_id = ? AND contact_id = ? AND follow_up_number = 0").get(campaignId, contact.id);
    if (existing) continue;

    // Generate personalised message with AI
    const message = await generateMessage(campaign, contact, 0);

    if (message) {
      const msgId = uuid();
      const unsubToken = uuid();

      // Send via appropriate channel
      let sent = false;
      if ((campaign.channel === "email" || campaign.channel === "both") && contact.email) {
        sent = await sendOutreachEmail(userId, contact.email, message.subject, message.body, msgId, unsubToken, campaign, backendUrl);
      }
      if ((campaign.channel === "sms" || campaign.channel === "both") && contact.phone) {
        sent = await sendOutreachSMS(userId, contact.phone, message.smsBody || message.body.replace(/<[^>]*>/g, "").slice(0, 160));
      }

      // Log message
      db.prepare(`INSERT INTO outreach_messages (id, campaign_id, contact_id, user_id, channel, subject, body, status, cost, follow_up_number, unsubscribe_token, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
        .run(msgId, campaignId, contact.id, userId, campaign.channel, message.subject || "", message.body || "", sent ? "sent" : "failed", cost, 0, unsubToken);

      // Deduct credits and track plan usage
      if (sent) {
        db.prepare("UPDATE users SET outreach_credits = outreach_credits - ? WHERE id = ?").run(cost, userId);
        db.prepare("UPDATE outreach_contacts SET status = 'contacted', last_contacted = datetime('now') WHERE id = ?").run(contact.id);
        // Track against plan caps so dashboard usage meter is accurate
        if (typeof global !== "undefined" && global.mineTrackUsage) {
          if (campaign.channel === "email" || campaign.channel === "both") global.mineTrackUsage(db, userId, "outreachEmails");
          if (campaign.channel === "sms" || campaign.channel === "both") global.mineTrackUsage(db, userId, "outreachSMS");
        }
        sentToday++;
      }
    }

    // Rate limit: small delay between sends
    await new Promise(r => setTimeout(r, 500));
  }

  // Check if all contacts are done
  const remaining = db.prepare("SELECT COUNT(*) as n FROM outreach_contacts WHERE list_id = ? AND status = 'pending'").get(campaign.list_id).n;
  if (remaining === 0) {
    db.prepare("UPDATE outreach_campaigns SET status = 'completed' WHERE id = ?").run(campaignId);
  }

  // Schedule follow-ups
  if (campaign.follow_ups > 0) {
    scheduleFollowUps(db, campaignId, userId);
  }
}

function scheduleFollowUps(db, campaignId, userId) {
  const campaign = db.prepare("SELECT * FROM outreach_campaigns WHERE id = ?").get(campaignId);
  const followUpDays = JSON.parse(campaign.follow_up_days || "[2,5]");

  // Find contacts that were sent to but haven't replied
  const contacted = db.prepare(`SELECT DISTINCT c.* FROM outreach_contacts c
    JOIN outreach_messages m ON m.contact_id = c.id
    WHERE m.campaign_id = ? AND c.status IN ('contacted','engaged') AND c.status != 'replied'`)
    .all(campaignId);

  for (let fuNum = 1; fuNum <= campaign.follow_ups; fuNum++) {
    const delay = followUpDays[fuNum - 1] || followUpDays[followUpDays.length - 1] || 3;

    for (const contact of contacted) {
      // Check if follow-up already exists
      const exists = db.prepare("SELECT id FROM outreach_messages WHERE campaign_id = ? AND contact_id = ? AND follow_up_number = ?")
        .get(campaignId, contact.id, fuNum);
      if (exists) continue;

      // Schedule it
      const scheduledFor = new Date(Date.now() + delay * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO outreach_messages (id, campaign_id, contact_id, user_id, channel, status, follow_up_number, scheduled_for, created_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
        .run(uuid(), campaignId, contact.id, userId, campaign.channel, "scheduled", fuNum, scheduledFor);
    }
  }
}

// ─── CRON: PROCESS SCHEDULED FOLLOW-UPS ───
router.post("/cron/followups", auth, async (req, res) => {
  try {

    const db = getDb();
    ensureTables(db);

    const due = db.prepare(`SELECT m.*, c.name, c.email, c.phone, c.company, c.custom_fields
      FROM outreach_messages m JOIN outreach_contacts c ON m.contact_id = c.id
      WHERE m.user_id = ? AND m.status = 'scheduled' AND datetime(m.scheduled_for) <= datetime('now')
      LIMIT 50`)
      .all(req.userId);

    let processed = 0;
    const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";

    for (const msg of due) {
      const campaign = db.prepare("SELECT * FROM outreach_campaigns WHERE id = ?").get(msg.campaign_id);
      if (!campaign || campaign.status !== "running") continue;

      // Check contact hasn't replied or unsubscribed since
      const contact = db.prepare("SELECT * FROM outreach_contacts WHERE id = ?").get(msg.contact_id);
      if (!contact || contact.status === "replied" || contact.status === "unsubscribed") {
        db.prepare("UPDATE outreach_messages SET status = 'skipped' WHERE id = ?").run(msg.id);
        continue;
      }

      // Check credits
      const user = db.prepare("SELECT outreach_credits FROM users WHERE id = ?").get(req.userId);
      const cost = campaign.channel === "sms" ? PRICING.sms : PRICING.email;
      if (!isAdmin(db, req.userId) && (user.outreach_credits || 0) < cost) break;

      // Generate follow-up message
      const message = await generateMessage(campaign, contact, msg.follow_up_number);
      if (!message) continue;

      let sent = false;
      if ((campaign.channel === "email" || campaign.channel === "both") && contact.email) {
        sent = await sendOutreachEmail(req.userId, contact.email, message.subject, message.body, msg.id, msg.unsubscribe_token || uuid(), campaign, backendUrl);
      }
      if ((campaign.channel === "sms" || campaign.channel === "both") && contact.phone) {
        sent = await sendOutreachSMS(req.userId, contact.phone, message.smsBody || message.body.replace(/<[^>]*>/g, "").slice(0, 160));
      }

      db.prepare("UPDATE outreach_messages SET subject = ?, body = ?, status = ?, cost = ? WHERE id = ?")
        .run(message.subject || "", message.body || "", sent ? "sent" : "failed", cost, msg.id);

      if (sent) {
        db.prepare("UPDATE users SET outreach_credits = outreach_credits - ? WHERE id = ?").run(cost, req.userId);
        // Track against plan caps
        if (typeof global !== "undefined" && global.mineTrackUsage) {
          if (campaign.channel === "email" || campaign.channel === "both") global.mineTrackUsage(db, req.userId, "outreachEmails");
          if (campaign.channel === "sms" || campaign.channel === "both") global.mineTrackUsage(db, req.userId, "outreachSMS");
        }
        processed++;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    res.json({ processed });

  } catch(e) {
    console.error("[Route]", e?.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════════
// AI MESSAGE GENERATION
// ═══════════════════════════════════════════════

async function generateMessage(campaign, contact, followUpNumber) {
  const anthropicKey = getSetting("ANTHROPIC_API_KEY");
  const customFields = JSON.parse(contact.custom_fields || "{}");

  const followUpContext = followUpNumber > 0
    ? `\nThis is follow-up #${followUpNumber}. The previous message got no reply. Be shorter, change the angle, add urgency. Don't repeat the same pitch — try a different hook.`
    : "";

  const goalInstructions = {
    book_meeting: "Your goal is to get them to book a meeting/call. Include a booking link or suggest specific times.",
    get_reply: "Your goal is to get a reply. Ask a question they'll want to answer. Be curious about their business.",
    drive_traffic: "Your goal is to drive them to visit a specific URL. Make the link irresistible.",
    promote_offer: "Your goal is to promote a specific offer. Lead with value, then present the offer.",
  };

  const prompt = `You are an expert cold outreach AI. Write a ${campaign.channel === "sms" ? "cold SMS" : "cold email"} for a sales campaign.

CONTEXT:
${campaign.context || "No additional context provided."}

RECIPIENT:
Name: ${contact.name || "there"}
Email: ${contact.email || "N/A"}
Company: ${contact.company || "N/A"}
${Object.entries(customFields).filter(([k,v]) => v && !k.startsWith("_")).map(([k,v]) => `${k}: ${v}`).join("\n")}

GOAL: ${goalInstructions[campaign.goal] || "Get a response."}
TONE: ${campaign.tone || "professional"}
OFFER: ${campaign.offer || "N/A"}
CTA: ${campaign.call_to_action || "N/A"}
SENDER: ${campaign.sender_name || "N/A"}
${followUpContext}

${campaign.channel === "sms" ? `Write a concise SMS (max 160 chars). No subject line needed.` : `Write a personalised cold email. Reference their name/company specifically.`}

${campaign.unsubscribe_link ? "Include [UNSUBSCRIBE] placeholder at the end for the unsubscribe link." : ""}

Respond ONLY in JSON:
{
  "subject": "email subject line (skip for SMS)",
  "body": "the full email body in HTML (or plain text for SMS)",
  "smsBody": "SMS version under 160 chars (only if SMS channel)"
}`;

  if (!anthropicKey) {
    // Fallback template
    const name = contact.name || "there";
    return {
      subject: `Quick question, ${String(name || "").replace(/[\r\n]/g, "")}`,
      body: `<p>Hi ${name},</p><p>${campaign.context || "I wanted to reach out about an opportunity."}</p><p>${campaign.offer || ""}</p><p>${campaign.call_to_action || "Would love to chat."}</p><p>${campaign.signature || ""}</p>`,
      smsBody: `Hi ${name}, ${(campaign.context || "Quick question for you").slice(0, 100)}. ${campaign.call_to_action || "Reply YES to learn more."}`,
    };
  }

  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 1000,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const d = await r.json();
    const text = d.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(jsonMatch[0]);
      // Append signature
      if (campaign.signature && parsed.body) {
        parsed.body += `<br><br>${campaign.signature.replace(/\n/g, "<br>")}`;
      }
      return parsed;
    }
  } catch (e) {
    console.error("AI generation error:", e.message);
  }

  return null;
}

// ═══════════════════════════════════════════════
// SEND FUNCTIONS
// ═══════════════════════════════════════════════

async function sendOutreachEmail(userId, to, subject, body, msgId, unsubToken, campaign, backendUrl) {
  // Validate recipient email to prevent sending to malformed addresses from CSV imports
  const EMAIL_VALID = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
  if (!to || !EMAIL_VALID.test(to) || to.length > 320) {

    return false;
  }
  const sgKey = getSetting("SENDGRID_API_KEY");
  const fromEmail = campaign.sender_email || getSetting("EMAIL_FROM") || "noreply@takeova.ai";
  const fromName = campaign.sender_name || "MINE";

  // Add tracking pixel + click tracking + unsubscribe
  const trackingPixel = `<img src="${backendUrl}/api/outreach/track/open/${msgId}" width="1" height="1" style="display:none"/>`;
  const unsubLink = campaign.unsubscribe_link
    ? `<p style="font-size:11px;color:#999;margin-top:20px"><a href="${backendUrl}/api/outreach/unsubscribe/${unsubToken}" style="color:#999">Unsubscribe</a></p>`
    : "";

  // Replace [UNSUBSCRIBE] placeholder
  let finalBody = body.replace("[UNSUBSCRIBE]", unsubLink ? `<a href="${backendUrl}/api/outreach/unsubscribe/${unsubToken}">unsubscribe</a>` : "");
  finalBody = `<div style="font-family:system-ui;max-width:600px;margin:0 auto">${finalBody}${unsubLink}${trackingPixel}</div>`;

  if (sgKey) {
    try {
      const fetch = (await import("node-fetch")).default;
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${sgKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail, name: fromName },
          reply_to: { email: campaign.sender_email || fromEmail },
          subject,
          content: [{ type: "text/html", value: finalBody }],
        }),
      });
      return r.status >= 200 && r.status < 300;
    } catch (e) { console.error("Email send error:", e.message); }
  }
  return false;
}

async function sendOutreachSMS(userId, to, body) {
  const twilioSid = getSetting("TWILIO_ACCOUNT_SID");
  const twilioAuth = getSetting("TWILIO_AUTH_TOKEN");
  const twilioFrom = getSetting("TWILIO_PHONE_NUMBER");

  if (!twilioSid || !twilioAuth || !twilioFrom) return false;

  // Get business name for SMS signature
  let bizName = "";
  try {
    const db = getDb();
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(userId);
    if (site?.name) bizName = site.name;
    else {
      const user = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
      bizName = user?.name || "";
    }
  } catch(e) {}

  const smsSignature = bizName ? `\n— ${bizName} (via ${process.env.MAIN_HOST||"takeova.ai"})` : `\n— via ${process.env.MAIN_HOST||"takeova.ai"}`;

  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: (()=>{
        // Use alphanumeric sender where supported
        let senderName=null;try{senderName=getDb().prepare("SELECT sms_sender_name FROM users WHERE id=?").get(userId)?.sms_sender_name||null;}catch(e){}
        const from=getSmsSender(to,senderName);
        return `To=${encodeURIComponent(to)}&From=${encodeURIComponent(from)}&Body=${encodeURIComponent(body + smsSignature)}`;
      })(),
    });
    const d = await r.json();
    return !!d.sid;
  } catch (e) { console.error("SMS send error:", e.message); }
  return false;
}

// ═══════════════════════════════════════════════
// DB TABLES
// ═══════════════════════════════════════════════

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outreach_lists (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT, description TEXT,
      total_contacts INTEGER DEFAULT 0, headers TEXT, status TEXT DEFAULT 'ready',
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS outreach_contacts (
      id TEXT PRIMARY KEY, list_id TEXT, user_id TEXT,
      name TEXT, email TEXT, phone TEXT, company TEXT, custom_fields TEXT,
      status TEXT DEFAULT 'pending', last_contacted TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS outreach_campaigns (
      id TEXT PRIMARY KEY, user_id TEXT, list_id TEXT, name TEXT,
      channel TEXT DEFAULT 'email', goal TEXT, context TEXT, tone TEXT,
      follow_ups INTEGER DEFAULT 0, follow_up_days TEXT DEFAULT '[2,5]',
      schedule TEXT, scheduled_time TEXT,
      sender_name TEXT, sender_email TEXT, signature TEXT,
      offer TEXT, call_to_action TEXT,
      daily_limit INTEGER DEFAULT 100, unsubscribe_link INTEGER DEFAULT 1,
      status TEXT DEFAULT 'draft', total_contacts INTEGER DEFAULT 0,
      estimated_cost TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS outreach_messages (
      id TEXT PRIMARY KEY, campaign_id TEXT, contact_id TEXT, user_id TEXT,
      channel TEXT, subject TEXT, body TEXT, status TEXT DEFAULT 'pending',
      cost REAL DEFAULT 0, follow_up_number INTEGER DEFAULT 0,
      unsubscribe_token TEXT, scheduled_for TEXT,
      opened_at TEXT, clicked_at TEXT, replied_at TEXT, reply_text TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_contacts_list ON outreach_contacts(list_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_messages_campaign ON outreach_messages(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_messages_status ON outreach_messages(status);
  `);
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

// ─── Export for server.js cron ───
async function processAllFollowUps(db) {
  try {
    const due = db.prepare(`SELECT m.*, c.name, c.email, c.phone, c.company, c.custom_fields
      FROM outreach_messages m JOIN outreach_contacts c ON m.contact_id = c.id
      WHERE m.status = 'scheduled' AND datetime(m.scheduled_for) <= datetime('now')
      LIMIT 100`).all();

    const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
    for (const msg of due) {
      try {
        const campaign = db.prepare("SELECT * FROM outreach_campaigns WHERE id = ?").get(msg.campaign_id);
        if (!campaign || campaign.status !== "running") continue;

        const contact = db.prepare("SELECT * FROM outreach_contacts WHERE id = ?").get(msg.contact_id);
        if (!contact || contact.status === "replied" || contact.status === "unsubscribed") {
          db.prepare("UPDATE outreach_messages SET status = 'skipped' WHERE id = ?").run(msg.id);
          continue;
        }

        const user = db.prepare("SELECT outreach_credits FROM users WHERE id = ?").get(msg.user_id);
        const cost = campaign.channel === "sms" ? PRICING.sms : PRICING.email;
        if ((user?.outreach_credits || 0) < cost) continue;

        const message = await generateMessage(campaign, contact, msg.follow_up_number);
        if (!message) continue;

        let sent = false;
        if ((campaign.channel === "email" || campaign.channel === "both") && contact.email)
          sent = await sendOutreachEmail(msg.user_id, contact.email, message.subject, message.body, msg.id, msg.unsubscribe_token || require("uuid").v4(), campaign, backendUrl);
        if ((campaign.channel === "sms" || campaign.channel === "both") && contact.phone)
          sent = await sendOutreachSMS(msg.user_id, contact.phone, message.smsBody || message.body.replace(/<[^>]*>/g,"").slice(0,160));

        db.prepare("UPDATE outreach_messages SET subject=?, body=?, status=?, cost=? WHERE id=?")
          .run(message.subject||"", message.body||"", sent?"sent":"failed", cost, msg.id);
        if (sent) {
          db.prepare("UPDATE users SET outreach_credits = outreach_credits - ? WHERE id = ?").run(cost, msg.user_id);
          if (typeof global !== "undefined" && global.mineTrackUsage) {
            if (campaign.channel === "email" || campaign.channel === "both") global.mineTrackUsage(db, msg.user_id, "outreachEmails");
            if (campaign.channel === "sms" || campaign.channel === "both") global.mineTrackUsage(db, msg.user_id, "outreachSMS");
          }
        }
        await new Promise(r => setTimeout(r, 300));
      } catch(e) { console.error("[/cron/followups]", e.message || e); }
    }
    if (due.length > 0) console.log(`[CRON] Processed ${due.length} outreach follow-ups`);
  } catch(e) { console.error("[CRON] Outreach follow-up error:", e.message); }
}

module.exports = router;
module.exports.processAllFollowUps = processAllFollowUps;
module.exports.processCampaign = processCampaign;

// ─── INTERNAL: Send single SMS (used by automation engine) ───
router.post("/sms/send", (req, res, next) => {
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
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: "to and message required" });

  // ── Toll-fraud protection ────────────────────────────────────────────────
  // Without this, a user could point /sms/send at a premium-rate number they
  // control (e.g., +1-900-xxx, +44-9xxx, +33-89xxx, satellite prefixes like
  // +8816xxx). Twilio bills us the high rate ($0.50–$2+/msg), but the user
  // pays only the standard outreach rate — the delta lands in the attacker's
  // pocket. We block the well-known premium/satellite/personal-numbering
  // ranges here. Normal mobile + landline numbers are unaffected.
  // Reference: ITU-T E.164 country codes + per-country premium ranges.
  const cleanTo = String(to).replace(/[^+\d]/g, "");
  if (!cleanTo.startsWith("+") || cleanTo.length < 8 || cleanTo.length > 16) {
    return res.status(400).json({ error: "Phone number must be in E.164 format (e.g. +14155551234)" });
  }
  const premiumPrefixes = [
    // Global premium-rate / audiotext ranges
    "+1900", "+1976",                               // US/CA premium
    "+44871", "+44872", "+44873",                   // UK premium-rate 87x
    "+449",                                         // UK "9" premium/directory
    "+339",                                         // France premium
    "+49900",                                       // Germany premium
    "+39899",                                       // Italy premium
    "+35590", "+35591",                             // Finland/Cyprus premium
    // International Premium Rate Service (IPRS) country codes — no real country
    "+882", "+883",                                 // International networks
    "+979",                                         // Universal Premium Rate
    // Satellite — $5+/msg typical
    "+8816", "+8817",                               // Iridium
    "+870",                                         // Inmarsat
    "+8810", "+8811", "+8812", "+8813",             // Global Mobile Satellite
  ];
  if (premiumPrefixes.some(p => cleanTo.startsWith(p))) {
    return res.status(400).json({ error: "Destination number is a premium-rate or satellite number and is not allowed." });
  }

  // Check outreachSMS plan cap
  if (req.userId && req.userId !== "system" && typeof global !== "undefined" && global.mineCheckUsage) {
    const db = require("../db/init").getDb();
    const capCheck = global.mineCheckUsage(db, req.userId, "outreachSMS");
    if (capCheck.blocked) return res.status(403).json({ error: capCheck.cap === 0 ? "SMS outreach not available on your plan. Upgrade to Growth or higher." : "Monthly SMS outreach limit reached. Overage will be charged.", upgrade: capCheck.cap === 0 });
    if (global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "outreachSMS");
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!accountSid || !authToken || !from) return res.status(503).json({ error: "SMS not configured — add Twilio credentials" });
  try {
    const fetch = (await import("node-fetch")).default;
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: { "Authorization": "Basic " + Buffer.from(accountSid + ":" + authToken).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: cleanTo, From: from, Body: message }).toString()
    });
    const d = await resp.json();
    if (d.sid) res.json({ success: true, sid: d.sid });
    else res.status(400).json({ error: d.message || "SMS send failed" });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});
