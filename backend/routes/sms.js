/**
 * MINE SMS Platform — 7 features
 *
 * 1. SMS Sequences       — automated multi-step SMS flows (trigger-based)
 * 2. Two-way SMS Inbox   — inbound replies stored, viewable per contact
 * 3. SMS Broadcast       — send to a contact segment at once
 * 4. Keyword Opt-in      — text a keyword to subscribe + auto-enrol
 * 5. Cart Abandonment SMS — fire 30min after abandonment (before emails)
 * 6. Appointment Reminders— booking confirmed → 48hr → 2hr → no-show follow-up
 * 7. AI SMS Copy Writer  — generate optimised sub-160-char SMS copy
 *
 * All routes auth-gated. SMS sending reuses sendOutreachSMS from outreach.js.
 */
"use strict";
const express  = require("express");
// ── Plan-cap helper (concurrent-count gates for keywords/sequences; see PLAN_CAPS) ──
function _smsPlanCap(plan, key, fallback) {
  try { const C = require("./features").PLAN_CAPS || {}; const p = C[plan] || null; if (p && p[key] !== undefined) return p[key]; } catch (_e) {}
  return fallback;
}
function _smsUserPlan(db, userId) {
  try { return (db.prepare("SELECT plan FROM users WHERE id = ?").get(userId)?.plan || "starter").toLowerCase(); } catch (_e) { return "starter"; }
}

const rateLimit = require('express-rate-limit');
const router   = express.Router();
const { v4: uuid } = require("uuid");
const { getDb }    = require("../db/init");

// ── Feature enabled check ──────────────────────────────────────────────────
function isSmsFeatureEnabled(db, userId, feature) {
  try {
    const cfg = db.prepare("SELECT * FROM sms_platform_config WHERE user_id = ?").get(userId);
    if (!cfg) return true;
    if (!cfg.sms_enabled) return false;
    return cfg[feature + "_enabled"] !== undefined ? !!cfg[feature + "_enabled"] : true;
  } catch(e) { return true; }
}

// ── Soft daily cap for auto-responses ────────────────────────────────────────
const { auth }     = require("../middleware/auth");
const { getSetting } = require("./integrations");
const { getSmsSender } = require("../utils/sms");

// ── Shared SMS send helper ───────────────────────────────────────────────────
async function sendSMS(userId, to, body) {
  if (!to || !body) return false;
  // Normalise to E.164 format for Twilio
  let clean = to.replace(/\s/g, "").replace(/[^\d+]/g, "");
  if (!clean.startsWith("+")) {
    // Default to +1 (US/Canada) if no country code — operators should pass full E.164
    clean = clean.length === 10 ? "+1" + clean : "+" + clean;
  }
  const accountSid = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const authToken  = getSetting("TWILIO_AUTH_TOKEN")  || process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return false;
  // Get user's sender name for alphanumeric ID where supported (UK/AU/EU)
  let userSenderName = null;
  try { const db = getDb(); userSenderName = db.prepare("SELECT sms_sender_name FROM users WHERE id = ?").get(userId)?.sms_sender_name || null; } catch(e) {}
  const from = getSmsSender(clean, userSenderName);
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: clean, From: from, Body: body.slice(0, 1600) }).toString(),
    });
    const d = await r.json();
    if (d.sid) {
      // Log to sms_inbox
      try {
        const db = getDb();
        ensureTables(db);
        db.prepare("INSERT INTO sms_inbox (id,user_id,contact_phone,direction,body,twilio_sid,created_at) VALUES(?,?,?,'outbound',?,?,datetime('now'))")
          .run(uuid(), userId, clean, body.slice(0, 1600), d.sid);
      } catch(e) {}
      return d.sid;
    }
    console.error("[SMS] Send failed:", d.message);
    return false;
  } catch(e) { console.error("[SMS] Send error:", e.message); return false; }
}

async function callAI(prompt, system, maxTokens = 400) {
  const Anthropic = require("@anthropic-ai/sdk");
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("AI not configured");
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6", max_tokens: maxTokens,
    system, messages: [{ role: "user", content: prompt }]
  });
  return msg.content?.[0]?.text || "";
}

function ensureTables(db) {
  db.exec(`
    -- Two-way inbox: stores all inbound + outbound SMS per user
    CREATE TABLE IF NOT EXISTS sms_inbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      contact_name TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      body TEXT,
      twilio_sid TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sms_inbox_user ON sms_inbox(user_id, contact_phone, created_at DESC);

    -- SMS sequences: reusable multi-step SMS flows
    CREATE TABLE IF NOT EXISTS sms_sequences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      steps TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Enrolled contacts in a sequence
    CREATE TABLE IF NOT EXISTS sms_sequence_enrollments (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      contact_name TEXT,
      current_step INTEGER DEFAULT 0,
      enrolled_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      status TEXT DEFAULT 'active',
      UNIQUE(sequence_id, contact_phone)
    );

    -- SMS broadcasts
    CREATE TABLE IF NOT EXISTS sms_broadcasts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT,
      message TEXT NOT NULL,
      segment TEXT DEFAULT 'all',
      status TEXT DEFAULT 'draft',
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      scheduled_at TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Keyword opt-in rules
    CREATE TABLE IF NOT EXISTS sms_keywords (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      reply TEXT NOT NULL,
      sequence_id TEXT,
      list_tag TEXT,
      active INTEGER DEFAULT 1,
      opt_in_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, keyword)
    );

    -- Appointment reminder config per user
    CREATE TABLE IF NOT EXISTS sms_reminder_config (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      confirm_msg TEXT DEFAULT 'Hi {name}! Your {service} appointment at {business} is confirmed for {date} at {time}. Reply CANCEL to cancel.',
      reminder_48h INTEGER DEFAULT 1,
      reminder_48h_msg TEXT DEFAULT 'Hi {name}, reminder: your {service} appointment is in 48 hours on {date} at {time}. See you then!',
      reminder_2h INTEGER DEFAULT 1,
      reminder_2h_msg TEXT DEFAULT 'Hi {name}, your {service} appointment is in 2 hours at {time}. We look forward to seeing you!',
      noshow_msg TEXT DEFAULT 'Hi {name}, we missed you today! Would you like to reschedule your {service} appointment? Reply YES and we will be in touch.',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Cart SMS tracking (prevent duplicate sends)
    CREATE TABLE IF NOT EXISTS sms_cart_sent (
      cart_id TEXT PRIMARY KEY,
      sent_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sms_enrollments_seq ON sms_sequence_enrollments(sequence_id, status);
    CREATE INDEX IF NOT EXISTS idx_sms_keywords_user ON sms_keywords(user_id, keyword);
  `);

  // Migrations
  try { db.exec("ALTER TABLE bookings ADD COLUMN sms_confirm_sent INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE bookings ADD COLUMN sms_48h_sent INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE bookings ADD COLUMN sms_2h_sent INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE bookings ADD COLUMN noshow_sms_sent INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS sms_platform_config (
    user_id TEXT PRIMARY KEY,
    sms_enabled INTEGER DEFAULT 1,
    broadcasts_enabled INTEGER DEFAULT 1,
    sequences_enabled INTEGER DEFAULT 1,
    reminders_enabled INTEGER DEFAULT 1,
    cart_sms_enabled INTEGER DEFAULT 1,
    keywords_enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  )`); } catch(e) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS sms_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    user_id TEXT,
    direction TEXT DEFAULT 'outbound',
    body TEXT,
    status TEXT DEFAULT 'sent',
    created_at TEXT DEFAULT (datetime('now'))
  )`); } catch(e) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS sms_appointment_config (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT UNIQUE,
    enabled INTEGER DEFAULT 1,
    reminder_hours INTEGER DEFAULT 24,
    message_template TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`); } catch(e) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS sms_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    contact_phone TEXT,
    last_message TEXT,
    last_message_at TEXT DEFAULT (datetime('now')),
    opted_out INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, contact_phone)
  )`); } catch(e) {}
}


// ── Soft daily cap for auto-responses (prevents cost blowout from spam) ───────
function checkAutoResponseCap(db, userId, limit = 200) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const count = db.prepare(`
      SELECT COUNT(*) as n FROM sms_messages
      WHERE user_id = ? AND direction = 'outbound' AND DATE(created_at) = ?
    `).get(userId, today)?.n || 0;
    if (count >= limit) {

      return false; // Caller should check return value
    }
    return true;
  } catch(e) { return true; } // Fail open — don't block on DB error
}

// ════════════════════════════════════════════════════════════════════════════
// 1. SMS SEQUENCES — create, edit, delete, enrol
// ════════════════════════════════════════════════════════════════════════════

router.get("/sequences", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const seqs = db.prepare("SELECT * FROM sms_sequences WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
    const counts = db.prepare("SELECT sequence_id, COUNT(*) as n FROM sms_sequence_enrollments WHERE user_id = ? AND status='active' GROUP BY sequence_id").all(req.userId);
    const countMap = Object.fromEntries(counts.map(c => [c.sequence_id, c.n]));
    res.json({ sequences: seqs.map(s => ({ ...s, steps: JSON.parse(s.steps||"[]"), activeEnrollments: countMap[s.id] || 0 })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/sequences", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { name, trigger, steps } = req.body;
    if (!isSmsFeatureEnabled(db, req.userId, "sequences")) return res.status(403).json({ error: "SMS sequences are disabled. Enable in SMS → Settings." });
      // ── Plan gate: concurrent sequence cap (smsSequences) ──
      const _sqPlan = _smsUserPlan(db, req.userId);
      const _sqCap = _smsPlanCap(_sqPlan, "smsSequences", 3);
      const _sqCur = db.prepare("SELECT COUNT(*) AS n FROM sms_sequences WHERE user_id = ?").get(req.userId).n;
      if (_sqCur >= _sqCap) return res.status(403).json({ error: `Your plan includes ${_sqCap} SMS sequences. Upgrade for more.`, code: "PLAN_LIMIT", requiresUpgrade: true, used: _sqCur, cap: _sqCap });
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });
    const VALID_TRIGGERS = ["manual","booking_confirmed","order_placed","contact_added","keyword","form_submitted","cart_abandoned","membership_started"];
    if (!VALID_TRIGGERS.includes(trigger)) return res.status(400).json({ error: "Invalid trigger" });
    if (!Array.isArray(steps) || steps.length === 0) return res.status(400).json({ error: "At least one step required" });
    // Validate steps
    for (const s of steps) {
      if (!s.message?.trim()) return res.status(400).json({ error: "Each step needs a message" });
      if (s.message.length > 1600) return res.status(400).json({ error: "Message too long (max 1600 chars)" });
      if (typeof s.delay_hours !== "number" || s.delay_hours < 0) return res.status(400).json({ error: "Invalid delay" });
    }
    const id = uuid();
    db.prepare("INSERT INTO sms_sequences (id, user_id, name, trigger, steps) VALUES (?,?,?,?,?)").run(id, req.userId, name.trim().slice(0,120), trigger, JSON.stringify(steps));
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/sequences/:id", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { name, trigger, steps, status } = req.body;
    const seq = db.prepare("SELECT id FROM sms_sequences WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!seq) return res.status(404).json({ error: "Not found" });
    if (steps !== undefined && Array.isArray(steps)) {
      for (const s of steps) {
        if (!s.message?.trim()) return res.status(400).json({ error: "Each step needs a message" });
      }
    }
    db.prepare("UPDATE sms_sequences SET name=COALESCE(?,name), trigger=COALESCE(?,trigger), steps=COALESCE(?,steps), status=COALESCE(?,status), updated_at=datetime('now') WHERE id=?")
      .run(name?.trim().slice(0,120)||null, trigger||null, steps?JSON.stringify(steps):null, status||null, req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/sequences/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM sms_sequences WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    db.prepare("UPDATE sms_sequence_enrollments SET status='cancelled' WHERE sequence_id = ?").run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Manually enrol a contact in a sequence
router.post("/sequences/:id/enrol", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { phone, name } = req.body;
    if (!phone?.trim()) return res.status(400).json({ error: "Phone required" });
    const seq = db.prepare("SELECT * FROM sms_sequences WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!seq) return res.status(404).json({ error: "Sequence not found" });
    const steps = JSON.parse(seq.steps||"[]");
    if (steps.length === 0) return res.status(400).json({ error: "Sequence has no steps" });
    const cleanPhone = phone.trim();
    db.prepare("INSERT OR IGNORE INTO sms_sequence_enrollments (id,sequence_id,user_id,contact_phone,contact_name) VALUES(?,?,?,?,?)").run(uuid(), seq.id, req.userId, cleanPhone, name?.trim()||"");
    // Send step 0 immediately if delay is 0
    if (steps[0].delay_hours === 0) {
      await sendSMS(req.userId, cleanPhone, steps[0].message);
      db.prepare("UPDATE sms_sequence_enrollments SET current_step=1 WHERE sequence_id=? AND contact_phone=?").run(seq.id, cleanPhone);
    }
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Get enrollments for a sequence
router.get("/sequences/:id/enrollments", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const rows = db.prepare("SELECT * FROM sms_sequence_enrollments WHERE sequence_id=? AND user_id=? ORDER BY enrolled_at DESC LIMIT 100").all(req.params.id, req.userId);
    res.json({ enrollments: rows });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. TWO-WAY SMS INBOX
// ════════════════════════════════════════════════════════════════════════════

router.get("/inbox", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    // Get conversations grouped by contact phone
    const convos = db.prepare(`
      SELECT contact_phone, contact_name,
        MAX(created_at) as last_message_at,
        SUM(CASE WHEN direction='inbound' AND read=0 THEN 1 ELSE 0 END) as unread,
        (SELECT body FROM sms_inbox si2 WHERE si2.user_id=si.user_id AND si2.contact_phone=si.contact_phone ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT direction FROM sms_inbox si3 WHERE si3.user_id=si.user_id AND si3.contact_phone=si.contact_phone ORDER BY created_at DESC LIMIT 1) as last_direction
      FROM sms_inbox si WHERE user_id=?
      GROUP BY contact_phone ORDER BY last_message_at DESC LIMIT 50
    `).all(req.userId);
    res.json({ conversations: convos });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/inbox/:phone", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const phone = decodeURIComponent(req.params.phone);
    const msgs = db.prepare("SELECT * FROM sms_inbox WHERE user_id=? AND contact_phone=? ORDER BY created_at ASC LIMIT 200").all(req.userId, phone);
    // Mark inbound as read
    db.prepare("UPDATE sms_inbox SET read=1 WHERE user_id=? AND contact_phone=? AND direction='inbound'").run(req.userId, phone);
    res.json({ messages: msgs });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/inbox/:phone/reply", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const phone = decodeURIComponent(req.params.phone);
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Message required" });
    if (message.length > 1600) return res.status(400).json({ error: "Message too long" });
    // Respect opt-out
    const _optOut = db.prepare("SELECT opted_out FROM sms_conversations WHERE user_id = ? AND contact_phone = ?").get(req.userId, phone);
    if (_optOut?.opted_out) return res.status(400).json({ error: "This contact has opted out of SMS messages." });
    // Track against smsBroadcastSends cap (manual replies count as outbound SMS)
    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "smsBroadcastSends");
    // Soft daily cap (100 replies/day)
    if (typeof checkAutoResponseCap === "function") checkAutoResponseCap(db, req.userId);
    const sid = await sendSMS(req.userId, phone, message.trim());
    if (!sid) return res.status(503).json({ error: "SMS not configured or send failed" });
    res.json({ success: true, sid });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Twilio inbound webhook — receives SMS replies from customers
// Set as Messaging webhook URL on your Twilio number
router.post("/inbound", async (req, res) => {
  try {
    // Verify Twilio signature
    const twilioAuth = process.env.TWILIO_AUTH_TOKEN || getSetting("TWILIO_AUTH_TOKEN");
    if (twilioAuth) {
      try {
        const twilio = require("twilio");
        const requestUrl = (process.env.BACKEND_URL || "http://localhost:4000") + "/api/sms/inbound";
        const sig = req.headers["x-twilio-signature"] || "";
        if (!twilio.validateRequest(twilioAuth, sig, requestUrl, req.body))
          return res.status(403).type("text/xml").send("<Response/>");
      } catch(e) { console.error("[/inbound]", e.message || e); }
    }

    res.type("text/xml").send("<Response/>"); // Respond to Twilio immediately

    const { From, To, Body } = req.body;
    if (!From || !Body) return;

    setImmediate(async () => {
      try {
        const db = getDb(); ensureTables(db);
        const upperBody = Body.trim().toUpperCase();

        // Find which user owns this Twilio number
        const numberOwner = db.prepare("SELECT user_id FROM user_voice_numbers WHERE phone_number = ?").get(To)
          || db.prepare("SELECT id as user_id FROM users WHERE id IN (SELECT user_id FROM user_voice_numbers) LIMIT 1").get();
        if (!numberOwner) return;
        const userId = numberOwner.user_id;

        // Store inbound message
        const contactName = (() => {
          try {
            const c = db.prepare("SELECT name FROM contacts WHERE user_id=? AND phone=? LIMIT 1").get(userId, From);
            return c?.name || null;
          } catch(e) { return null; }
        })();

        db.prepare("INSERT INTO sms_inbox (id,user_id,contact_phone,contact_name,direction,body,created_at) VALUES(?,?,?,?,'inbound',?,datetime('now'))")
          .run(uuid(), userId, From, contactName, Body.trim().slice(0,1600));

        // Check for STOP / UNSTOP
        if (upperBody === "STOP" || upperBody === "UNSUBSCRIBE") {
          db.prepare("UPDATE sms_sequence_enrollments SET status='cancelled' WHERE contact_phone=? AND user_id=?").run(From, userId);
          try { db.prepare("INSERT OR REPLACE INTO sms_optouts (phone, user_id, opted_out_at) VALUES(?,?,datetime('now'))").run(From, userId); } catch(e) { console.error("[/inbound]", e.message || e); }
          return;
        }
        if (upperBody === "START" || upperBody === "YES") {
          try { db.prepare("DELETE FROM sms_optouts WHERE phone=? AND user_id=?").run(From, userId); } catch(e) { console.error("[/inbound]", e.message || e); }
        }

        // Check keyword opt-in
        const keyword = db.prepare("SELECT * FROM sms_keywords WHERE user_id=? AND UPPER(keyword)=? AND active=1").get(userId, upperBody);
        if (keyword) {
          // Soft daily cap (100/day) — logs warning, doesn't block reactive replies
          checkAutoResponseCap(db, userId);
          // Send keyword reply
          await sendSMS(userId, From, keyword.reply);
          keyword.opt_in_count = (keyword.opt_in_count||0) + 1;
          db.prepare("UPDATE sms_keywords SET opt_in_count=opt_in_count+1 WHERE id=?").run(keyword.id);
          // Add to contacts with tag
          try {
            const existing = db.prepare("SELECT id, tags FROM contacts WHERE user_id=? AND phone=?").get(userId, From);
            if (existing) {
              const tags = JSON.parse(existing.tags||"[]");
              if (!tags.includes(keyword.list_tag) && keyword.list_tag) {
                tags.push(keyword.list_tag);
                db.prepare("UPDATE contacts SET tags=? WHERE id=?").run(JSON.stringify(tags), existing.id);
              }
            } else {
              db.prepare("INSERT INTO contacts (id,user_id,phone,source,tags,created_at) VALUES(?,?,?,'sms_keyword',?,datetime('now'))").run(uuid(), userId, From, JSON.stringify(keyword.list_tag ? [keyword.list_tag] : []));
            }
          } catch(e) { console.error("[/inbound]", e.message || e); }
          // Enrol in sequence if configured
          if (keyword.sequence_id) {
            const seq = db.prepare("SELECT * FROM sms_sequences WHERE id=?").get(keyword.sequence_id);
            if (seq) {
              db.prepare("INSERT OR IGNORE INTO sms_sequence_enrollments (id,sequence_id,user_id,contact_phone) VALUES(?,?,?,?)").run(uuid(), keyword.sequence_id, userId, From);
            }
          }
        }
      } catch(e) { console.error("[SMS Inbound]", e.message); }
    });
  } catch(e) { console.error("[SMS Inbound outer]", e.message); res.type("text/xml").send("<Response/>"); }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. SMS BROADCAST
// ════════════════════════════════════════════════════════════════════════════

router.get("/broadcasts", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const broadcasts = db.prepare("SELECT * FROM sms_broadcasts WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(req.userId);
    res.json({ broadcasts });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/broadcasts", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { name, message, segment, send_now } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Message required" });
    if (!isSmsFeatureEnabled(db, req.userId, "broadcasts")) return res.status(403).json({ error: "SMS broadcasts are disabled. Enable in SMS → Settings." });
    // Cap check — uses the same helpers the rest of the platform uses.
    // The earlier reference to `checkSmsCapAndTrack` (never defined) crashed this endpoint.
    if (typeof global !== "undefined" && global.mineCheckUsage) {
      // ── Monthly broadcast-count meter (smsBroadcast) ──
      if (typeof global.mineCheckUsage === "function") {
        const _bc = global.mineCheckUsage(db, req.userId, "smsBroadcast");
        if (_bc && _bc.blocked) return res.status(403).json({ error: "Monthly SMS broadcast allowance reached. Upgrade for more.", code: "PLAN_LIMIT", requiresUpgrade: true, used: _bc.used, cap: _bc.cap });
      }
      const usage = global.mineCheckUsage(db, req.userId, "smsBroadcastSends");
      if (usage.blocked) return res.status(403).json({ error: "SMS broadcasts are not available on your plan." });
      if (usage.wouldBeOverage) {
        // Allow overage by tracking; mineTrackUsage returns blocked only if cap is hard-blocked
        const track = global.mineTrackUsage(db, req.userId, "smsBroadcastSends");
        if (track?.blocked) return res.status(403).json({ error: "Monthly SMS broadcast limit reached." });
      } else {
        global.mineTrackUsage(db, req.userId, "smsBroadcastSends");
      }
    }
    if (message.length > 1600) return res.status(400).json({ error: "SMS message too long (max 1600 chars)" });

    // Segment: all | tag:tagname | plan:starter
    let contacts = [];
    try {
      if (!segment || segment === "all") {
        contacts = db.prepare("SELECT phone, name FROM contacts WHERE user_id=? AND phone IS NOT NULL AND phone != ''").all(req.userId);
      } else if (segment.startsWith("tag:")) {
        const tag = segment.slice(4);
        contacts = db.prepare("SELECT phone, name FROM contacts WHERE user_id=? AND phone!='' AND (tags LIKE ? OR tags_json LIKE ?)").all(req.userId, `%${tag}%`, `%${tag}%`);
      }
    } catch(e) {}

    const id = uuid();
    db.prepare("INSERT INTO sms_broadcasts (id,user_id,name,message,segment,status) VALUES(?,?,?,?,?,'draft')").run(id, req.userId, name?.trim().slice(0,120)||"Broadcast", message.trim(), segment||"all");
    if (typeof global.mineTrackUsage === "function") { try { global.mineTrackUsage(db, req.userId, "smsBroadcast", 1); } catch(_e){} }

    if (send_now) {
      res.json({ success: true, id, total: contacts.length });
      setImmediate(async () => {
        let sent = 0, failed = 0;
        const optouts = (() => { try { return new Set(db.prepare("SELECT phone FROM sms_optouts WHERE user_id=?").all(req.userId).map(r => r.phone)); } catch(e) { return new Set(); } })();
        for (const c of contacts) {
          if (optouts.has(c.phone)) continue;
          const ok = await sendSMS(req.userId, c.phone, message.trim());
          if (ok) sent++; else failed++;
          await new Promise(r => setTimeout(r, 50)); // rate limit 20/sec
        }
        db.prepare("UPDATE sms_broadcasts SET status='sent',sent_count=?,failed_count=?,sent_at=datetime('now') WHERE id=?").run(sent, failed, id);
      });
    } else {
      res.json({ success: true, id, total: contacts.length });
    }
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/broadcasts/:id", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { name, message, segment } = req.body;
    const b = db.prepare("SELECT id,status FROM sms_broadcasts WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!b) return res.status(404).json({ error: "Not found" });
    if (b.status === "sent") return res.status(400).json({ error: "Cannot edit a sent broadcast" });
    if (message && message.length > 1600) return res.status(400).json({ error: "Too long" });
    db.prepare("UPDATE sms_broadcasts SET name=COALESCE(?,name),message=COALESCE(?,message),segment=COALESCE(?,segment) WHERE id=?").run(name?.trim()||null, message?.trim()||null, segment||null, req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/broadcasts/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM sms_broadcasts WHERE id=? AND user_id=? AND status='draft'").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. KEYWORD OPT-IN
// ════════════════════════════════════════════════════════════════════════════

router.get("/keywords", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const keywords = db.prepare("SELECT * FROM sms_keywords WHERE user_id=? ORDER BY created_at DESC").all(req.userId);
    res.json({ keywords });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/keywords", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { keyword, reply, sequence_id, list_tag } = req.body;
    if (!keyword?.trim()) return res.status(400).json({ error: "Keyword required" });
    if (!reply?.trim()) return res.status(400).json({ error: "Auto-reply message required" });
    if (reply.length > 160) return res.status(400).json({ error: "Reply must be under 160 chars" });
      // ── Plan gate: concurrent keyword cap (smsKeywords) ──
      const _kwPlan = _smsUserPlan(db, req.userId);
      const _kwCap = _smsPlanCap(_kwPlan, "smsKeywords", 5);
      const _kwCur = db.prepare("SELECT COUNT(*) AS n FROM sms_keywords WHERE user_id = ?").get(req.userId).n;
      if (_kwCur >= _kwCap) return res.status(403).json({ error: `Your plan includes ${_kwCap} SMS keywords. Upgrade for more.`, code: "PLAN_LIMIT", requiresUpgrade: true, used: _kwCur, cap: _kwCap });
    const clean = keyword.trim().toUpperCase().replace(/\s+/g,"").slice(0,30);
    const RESERVED_TCPA = ["STOP","START","HELP","CANCEL","QUIT","END","UNSTOP","YES","STOPALL"];
    if (RESERVED_TCPA.includes(clean)) return res.status(400).json({ error: `"${clean}" is a reserved TCPA keyword and cannot be used` });
    const id = uuid();
    db.prepare("INSERT INTO sms_keywords (id,user_id,keyword,reply,sequence_id,list_tag) VALUES(?,?,?,?,?,?)").run(id, req.userId, clean, reply.trim(), sequence_id||null, list_tag?.trim().slice(0,50)||null);
    res.json({ success: true, id });
  } catch(e) {
    if (e.message?.includes("UNIQUE")) return res.status(409).json({ error: "That keyword already exists" });
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.put("/keywords/:id", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { reply, sequence_id, list_tag, active } = req.body;
    if (reply !== undefined && reply.length > 160) return res.status(400).json({ error: "Reply must be under 160 chars" });
    db.prepare("UPDATE sms_keywords SET reply=COALESCE(?,reply),sequence_id=COALESCE(?,sequence_id),list_tag=COALESCE(?,list_tag),active=COALESCE(?,active),updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(reply?.trim()||null, sequence_id||null, list_tag?.trim()||null, active!==undefined?+active:null, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/keywords/:id", auth, (req, res) => {
  try {
    getDb().prepare("DELETE FROM sms_keywords WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
// 5. CART ABANDONMENT SMS (triggered by cron, config here)
// ════════════════════════════════════════════════════════════════════════════
// Cron hook exported for server.js to call
async function sendCartAbandonmentSMS(db) {
  try {
    ensureTables(db);
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const twoHoursAgo   = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const carts = db.prepare(`
      SELECT ac.*, u.id as owner_id
      FROM abandoned_carts ac
      JOIN sites s ON ac.site_id = s.id
      JOIN users u ON s.user_id = u.id
      WHERE ac.created_at < ? AND ac.created_at > ?
        AND ac.recovered = 0
        AND (ac.customer_email IS NOT NULL OR ac.email IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM sms_cart_sent scs WHERE scs.cart_id = ac.id)
    `).all(thirtyMinsAgo, twoHoursAgo);

    for (const cart of carts) {
      const phone = cart.customer_phone || cart.phone;
      if (!phone) continue;
      const optout = (() => { try { return db.prepare("SELECT 1 FROM sms_optouts WHERE phone=? AND user_id=?").get(phone, cart.owner_id); } catch(e) { return null; } })();
      if (optout) continue;

      const items = (() => { try { return JSON.parse(cart.items||"[]"); } catch(e) { return []; } })();
      const topItem = items[0]?.name || "your items";
      const cartUrl = `${process.env.FRONTEND_URL||"https://takeova.ai"}/cart`;

      // Generate personalised message with Claude if API key available
      let msg;
      try {
        const { personaliseMessage } = require("../utils/personalise");
        const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(cart.owner_id);
        const result = await personaliseMessage({
          scenario: "cart_recovery",
          customer: {
            name: cart.customer_name || "there",
            cart_items: items.map(i=>i.name).join(", "),
          },
          business: { name: site?.name || "the store" },
          channel: "sms",
          tone: "friendly",
        });
        msg = (result.body + " " + cartUrl).slice(0, 160);
      } catch(e) {
        // Fallback to template
        msg = `Hey! You left ${topItem}${items.length > 1 ? ` + ${items.length-1} more` : ""} in your cart. Still interested? ${cartUrl}`.slice(0,160);
      }

      await sendSMS(cart.owner_id, phone, msg);
      db.prepare("INSERT OR IGNORE INTO sms_cart_sent (cart_id) VALUES(?)").run(cart.id);
    }
    if (carts.length > 0) console.log(`[SMS Cart] Sent ${carts.length} cart abandonment SMS`);
  } catch(e) { console.error("[SMS Cart] Cron error:", e.message); }
}

// ════════════════════════════════════════════════════════════════════════════
// 6. APPOINTMENT REMINDER CONFIG + CRON HOOK
// ════════════════════════════════════════════════════════════════════════════

router.get("/reminders/config", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    let cfg = db.prepare("SELECT * FROM sms_reminder_config WHERE user_id=?").get(req.userId);
    if (!cfg) {
      db.prepare("INSERT OR IGNORE INTO sms_reminder_config (user_id) VALUES(?)").run(req.userId);
      cfg = db.prepare("SELECT * FROM sms_reminder_config WHERE user_id=?").get(req.userId);
    }
    res.json({ config: cfg });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/reminders/config", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { enabled, confirm_msg, reminder_48h, reminder_48h_msg, reminder_2h, reminder_2h_msg, noshow_msg } = req.body;
    // Validate message lengths
    for (const [key, val] of [["confirm_msg",confirm_msg],["reminder_48h_msg",reminder_48h_msg],["reminder_2h_msg",reminder_2h_msg],["noshow_msg",noshow_msg]]) {
      if (val !== undefined && val.length > 320) return res.status(400).json({ error: `${key} too long (max 320 chars)` });
    }
    db.prepare(`INSERT INTO sms_reminder_config (user_id,enabled,confirm_msg,reminder_48h,reminder_48h_msg,reminder_2h,reminder_2h_msg,noshow_msg,updated_at)
      VALUES(?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        enabled=COALESCE(excluded.enabled,enabled),
        confirm_msg=COALESCE(excluded.confirm_msg,confirm_msg),
        reminder_48h=COALESCE(excluded.reminder_48h,reminder_48h),
        reminder_48h_msg=COALESCE(excluded.reminder_48h_msg,reminder_48h_msg),
        reminder_2h=COALESCE(excluded.reminder_2h,reminder_2h),
        reminder_2h_msg=COALESCE(excluded.reminder_2h_msg,reminder_2h_msg),
        noshow_msg=COALESCE(excluded.noshow_msg,noshow_msg),
        updated_at=datetime('now')
    `).run(req.userId, enabled!==undefined?+enabled:null, confirm_msg?.slice(0,320)||null, reminder_48h!==undefined?+reminder_48h:null, reminder_48h_msg?.slice(0,320)||null, reminder_2h!==undefined?+reminder_2h:null, reminder_2h_msg?.slice(0,320)||null, noshow_msg?.slice(0,320)||null);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Cron hook: runs every 15min to send appointment reminders
async function sendAppointmentReminders(db) {
  try {
    ensureTables(db);
    const now   = new Date();
    const in48h = new Date(now.getTime() + 48 * 3600000);
    const in2h  = new Date(now.getTime() + 2 * 3600000);
    const nowStr   = now.toISOString().slice(0,16);
    const in48str  = in48h.toISOString().slice(0,10);
    const in2str   = in2h.toISOString().slice(0,16);

    // Get all bookings needing reminders
    const bookings = db.prepare(`
      SELECT b.*, u.id as owner_id, u.name as biz_name,
        rc.enabled, rc.confirm_msg, rc.reminder_48h, rc.reminder_48h_msg, rc.reminder_2h, rc.reminder_2h_msg, rc.noshow_msg
      FROM bookings b
      JOIN users u ON b.user_id = u.id
      LEFT JOIN sms_reminder_config rc ON rc.user_id = b.user_id
      WHERE b.status = 'confirmed' AND b.customer_phone IS NOT NULL AND b.customer_phone != ''
        AND (rc.enabled IS NULL OR rc.enabled = 1)
    `).all();

    function fillTemplate(template, booking, bizName) {
      return (template || "")
        .replace(/{name}/g, booking.customer_name || "there")
        .replace(/{service}/g, booking.service || "appointment")
        .replace(/{business}/g, bizName || "us")
        .replace(/{date}/g, booking.date || "")
        .replace(/{time}/g, booking.time || "")
        .slice(0, 320);
    }

    for (const b of bookings) {
      const phone = b.customer_phone;
      const optout = (() => { try { return db.prepare("SELECT 1 FROM sms_optouts WHERE phone=? AND user_id=?").get(phone, b.owner_id); } catch(e) { return null; } })();
      if (optout) continue;

      // Confirmation (if not yet sent — for new bookings)
      if (!b.sms_confirm_sent && b.confirm_msg !== undefined) {
        const msg = fillTemplate(b.confirm_msg, b, b.biz_name);
        if (await sendSMS(b.owner_id, phone, msg)) {
          db.prepare("UPDATE bookings SET sms_confirm_sent=1 WHERE id=?").run(b.id);
        }
      }

      // 48-hour reminder
      if (!b.sms_48h_sent && b.reminder_48h !== 0 && b.date === in48str) {
        const msg = fillTemplate(b.reminder_48h_msg, b, b.biz_name);
        if (await sendSMS(b.owner_id, phone, msg)) {
          db.prepare("UPDATE bookings SET sms_48h_sent=1 WHERE id=?").run(b.id);
        }
      }

      // 2-hour reminder
      if (!b.sms_2h_sent && b.reminder_2h !== 0) {
        const apptTime = `${b.date}T${b.time || "00:00"}`;
        if (apptTime.slice(0,13) === in2str.slice(0,13)) {
          const msg = fillTemplate(b.reminder_2h_msg, b, b.biz_name);
          if (await sendSMS(b.owner_id, phone, msg)) {
            db.prepare("UPDATE bookings SET sms_2h_sent=1 WHERE id=?").run(b.id);
          }
        }
      }

      // No-show (appointment was 2hrs ago, status still confirmed)
      const apptTs = new Date(`${b.date}T${b.time || "09:00"}`).getTime();
      const twoHrsAgo = now.getTime() - 2 * 3600000;
      if (!b.noshow_sms_sent && apptTs < twoHrsAgo && apptTs > twoHrsAgo - 3600000) {
        const msg = fillTemplate(b.noshow_msg, b, b.biz_name);
        if (await sendSMS(b.owner_id, phone, msg)) {
          db.prepare("UPDATE bookings SET noshow_sms_sent=1 WHERE id=?").run(b.id);
        }
      }
    }
  } catch(e) { console.error("[SMS Reminders] Cron error:", e.message); }
}

// ════════════════════════════════════════════════════════════════════════════
// 7. AI SMS COPY WRITER
// ════════════════════════════════════════════════════════════════════════════

router.post("/ai-copy", auth, async (req, res) => {
  try {
    const { goal, businessName, audience, tone, charLimit } = req.body;
    if (!goal?.trim()) return res.status(400).json({ error: "Goal required" });
    const maxChars = Math.min(parseInt(charLimit) || 160, 1600);
    const text = await callAI(
      `Business: ${String(businessName||"").trim().slice(0,80)}\nGoal: ${goal.trim().slice(0,200)}\nAudience: ${String(audience||"customers").trim().slice(0,100)}\nTone: ${String(tone||"friendly").trim()}\nMax characters: ${maxChars}`,
      `You are an expert SMS copywriter. Write exactly 5 SMS message variants for the stated goal.
Rules: each message must be under ${maxChars} characters, include a clear CTA, no emojis unless tone is casual, no link placeholders.
Return JSON only — array of 5 strings: ["msg1","msg2","msg3","msg4","msg5"]`,
      600
    );
    const msgs = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g,"").trim());
    if (!Array.isArray(msgs)) throw new Error("Invalid AI response");
    const validated = msgs.map(m => ({
      message: String(m).slice(0, maxChars),
      chars: String(m).length,
      segments: Math.ceil(String(m).length / 160)
    }));
    res.json({ variants: validated });
  } catch(e) {
    console.error("[SMS AI Copy]", e.message);
    res.status(502).json({ error: "AI unavailable" });
  }
});

// Opt-out list management
router.get("/optouts", auth, (req, res) => {
  try {
    const db = getDb();
    try { db.exec("CREATE TABLE IF NOT EXISTS sms_optouts (phone TEXT, user_id TEXT, opted_out_at TEXT, PRIMARY KEY(phone,user_id))"); } catch(e) {}
    const list = db.prepare("SELECT phone, opted_out_at FROM sms_optouts WHERE user_id=? ORDER BY opted_out_at DESC").all(req.userId);
    res.json({ optouts: list });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/optouts/:phone", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM sms_optouts WHERE phone=? AND user_id=?").run(decodeURIComponent(req.params.phone), req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// SMS stats
router.get("/stats", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const period = req.query.period || "30d";
    const since  = period === "7d" ? "datetime('now','-7 days')" : period === "24h" ? "datetime('now','-1 day')" : "datetime('now','-30 days')";
    const sent     = db.prepare(`SELECT COUNT(*) as n FROM sms_inbox WHERE user_id=? AND direction='outbound' AND created_at > ${since}`).get(req.userId)?.n || 0;
    const received = db.prepare(`SELECT COUNT(*) as n FROM sms_inbox WHERE user_id=? AND direction='inbound' AND created_at > ${since}`).get(req.userId)?.n || 0;
    const optouts  = (() => { try { return db.prepare("SELECT COUNT(*) as n FROM sms_optouts WHERE user_id=?").get(req.userId)?.n || 0; } catch(e) { return 0; } })();
    const sequences = db.prepare("SELECT COUNT(*) as n FROM sms_sequences WHERE user_id=? AND status='active'").get(req.userId)?.n || 0;
    const enrolled  = db.prepare("SELECT COUNT(*) as n FROM sms_sequence_enrollments WHERE user_id=? AND status='active'").get(req.userId)?.n || 0;
    res.json({ sent, received, optouts, sequences, enrolled });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});


// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 5: CART ABANDONMENT SMS
// ════════════════════════════════════════════════════════════════════════════════

router.get("/cart-sms/config", auth, (req, res) => {
  try {
    const db = getDb();
    ensureSmsTables(db);
    try { db.exec("CREATE TABLE IF NOT EXISTS sms_cart_config (user_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, delay_minutes INTEGER DEFAULT 30, message TEXT DEFAULT 'Hey {name}! You left something behind. Your cart is waiting: {cart_url}')"); } catch(e) {}
    let cfg = db.prepare("SELECT * FROM sms_cart_config WHERE user_id = ?").get(req.userId);
    if (!cfg) {
      db.prepare("INSERT OR IGNORE INTO sms_cart_config (user_id) VALUES (?)").run(req.userId);
      cfg = db.prepare("SELECT * FROM sms_cart_config WHERE user_id = ?").get(req.userId);
    }
    res.json({ config: cfg || { enabled: 1, delay_minutes: 30, message: "Hey {name}! You left something behind. Your cart is waiting: {cart_url}" } });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/cart-sms/config", auth, (req, res) => {
  try {
    const db = getDb();
    try { db.exec("CREATE TABLE IF NOT EXISTS sms_cart_config (user_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, delay_minutes INTEGER DEFAULT 30, message TEXT)"); } catch(e) {}
    const { enabled, delay_minutes, message } = req.body;
    if (message && message.length > 320) return res.status(400).json({ error: "Message max 320 chars" });
    db.prepare("INSERT INTO sms_cart_config (user_id, enabled, delay_minutes, message) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, delay_minutes=excluded.delay_minutes, message=excluded.message")
      .run(req.userId, enabled ? 1 : 0, Math.max(5, Math.min(1440, parseInt(delay_minutes) || 30)), message ? message.slice(0,320) : "Hey {name}! You left something behind. Your cart is waiting: {cart_url}");
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Called internally by server.js cart recovery cron
router.post("/cart-sms/send", auth, async (req, res) => {
  res.json({ received: true });
  const { userId, phone, name, cartUrl } = req.body;
  if (!userId || !phone) return;
  setImmediate(async () => {
    try {
      const db = getDb();
      let cfg = null;
      try { cfg = db.prepare("SELECT * FROM sms_cart_config WHERE user_id = ?").get(userId); } catch(e) {}
      if (!cfg?.enabled) return;
      const opted = db.prepare("SELECT opted_out FROM sms_conversations WHERE user_id = ? AND contact_phone = ?").get(userId, phone);
      if (opted?.opted_out) return;
      // Cart SMS daily soft cap (200/day)
      if (!checkCartSmsCap(db, userId)) {

        return;
      }
      const msg = interpolate(cfg.message || "Hey {name}! Your cart is waiting: {cart_url}", { name: name || "there", cart_url: cartUrl || "" });
      await sendSMS(userId, phone, msg);
      // Log in inbox
      const existing = db.prepare("SELECT id FROM sms_conversations WHERE user_id = ? AND contact_phone = ?").get(userId, phone);
      const convId = existing?.id || require("uuid").v4();
      if (!existing) db.prepare("INSERT INTO sms_conversations (id, user_id, contact_phone, last_message, last_message_at) VALUES (?,?,?,?,datetime('now'))").run(convId, userId, phone, msg.slice(0,200));
      else db.prepare("UPDATE sms_conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?").run(msg.slice(0,200), convId);
      db.prepare("INSERT INTO sms_messages (id, conversation_id, user_id, direction, body) VALUES (?,?,?,?,?)").run(require("uuid").v4(), convId, userId, "outbound", msg);
    } catch(e) { console.error("[SMS cart]", e.message); }
  });
});


// POST /reminders/send — called internally by server.js cron
router.post("/reminders/send", auth, async (req, res) => {
  res.json({ received: true });
  const { userId, bookingId, phone, name, service, date, time, type } = req.body;
  if (!userId || !phone || !type) return;
  setImmediate(async () => {
    try {
      const db = getDb();
      ensureSmsTables(db);
      const cfg = db.prepare("SELECT * FROM sms_reminder_config WHERE user_id = ?").get(userId);
      if (!cfg || !cfg.enabled) return;
      if (!isSmsFeatureEnabled(db, userId, "reminders")) return;
      // Appointment reminders are pay-per-use at $0.02/SMS — no included allowance
      if (typeof global !== "undefined" && global.mineTrackUsage) {
        global.mineTrackUsage(db, userId, "smsReminderSends");
      }
      const opted = db.prepare("SELECT opted_out FROM sms_conversations WHERE user_id = ? AND contact_phone = ?").get(userId, phone);
      if (opted?.opted_out) return;
      const vars = { name: name || "there", service: service || "your appointment", date: date || "", time: time || "" };
      const msgMap = { confirmation: cfg.send_confirmation ? cfg.confirmation_msg : null, reminder_24h: cfg.send_24h ? cfg.reminder_24h_msg : null, reminder_1h: cfg.send_1h ? cfg.reminder_1h_msg : null, followup: cfg.send_followup ? cfg.followup_msg : null };
      const msgTemplate = msgMap[type];
      if (!msgTemplate) return;
      const msg = interpolate(msgTemplate, vars);
      await sendSMS(userId, phone, msg);
      // Log in inbox
      const existing = db.prepare("SELECT id FROM sms_conversations WHERE user_id = ? AND contact_phone = ?").get(userId, phone);
      const convId = existing?.id || uuid();
      if (!existing) db.prepare("INSERT INTO sms_conversations (id, user_id, contact_phone, last_message, last_message_at) VALUES (?,?,?,?,datetime('now'))").run(convId, userId, phone, msg.slice(0,200));
      else db.prepare("UPDATE sms_conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?").run(msg.slice(0,200), convId);
      db.prepare("INSERT INTO sms_messages (id, conversation_id, user_id, direction, body) VALUES (?,?,?,?,?)").run(uuid(), convId, userId, "outbound", msg);
    } catch(e) { console.error("[SMS reminder send]", type, e.message); }
  });
});

// ── SMS Config — global on/off + per-feature toggles ────────────────────────
router.get("/config", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    let cfg = db.prepare("SELECT * FROM sms_platform_config WHERE user_id = ?").get(req.userId);
    if (!cfg) {
      db.prepare("INSERT OR IGNORE INTO sms_platform_config (user_id) VALUES (?)").run(req.userId);
      cfg = db.prepare("SELECT * FROM sms_platform_config WHERE user_id = ?").get(req.userId);
    }
    const period = new Date().toISOString().slice(0,7);
    const usage = {};
    for (const metric of ["smsBroadcastSends","smsSequenceSends","smsReminderSends","outreachSMS"]) {
      try { const row = db.prepare("SELECT amount FROM usage_tracking WHERE user_id=? AND metric=? AND period=?").get(req.userId, metric, period); usage[metric] = row?.amount || 0; } catch(e) { usage[metric] = 0; }
    }
    res.json({ config: cfg || {sms_enabled:1,broadcasts_enabled:1,sequences_enabled:1,reminders_enabled:1,cart_sms_enabled:1,keywords_enabled:1}, usage });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/config", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { sms_enabled, broadcasts_enabled, sequences_enabled, reminders_enabled, cart_sms_enabled, keywords_enabled } = req.body;
    db.prepare(`INSERT INTO sms_platform_config (user_id,sms_enabled,broadcasts_enabled,sequences_enabled,reminders_enabled,cart_sms_enabled,keywords_enabled,updated_at)
      VALUES (?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        sms_enabled=COALESCE(excluded.sms_enabled,sms_enabled),
        broadcasts_enabled=COALESCE(excluded.broadcasts_enabled,broadcasts_enabled),
        sequences_enabled=COALESCE(excluded.sequences_enabled,sequences_enabled),
        reminders_enabled=COALESCE(excluded.reminders_enabled,reminders_enabled),
        cart_sms_enabled=COALESCE(excluded.cart_sms_enabled,cart_sms_enabled),
        keywords_enabled=COALESCE(excluded.keywords_enabled,keywords_enabled),
        updated_at=datetime('now')
    `).run(req.userId,
      sms_enabled!==undefined?(sms_enabled?1:0):null,
      broadcasts_enabled!==undefined?(broadcasts_enabled?1:0):null,
      sequences_enabled!==undefined?(sequences_enabled?1:0):null,
      reminders_enabled!==undefined?(reminders_enabled?1:0):null,
      cart_sms_enabled!==undefined?(cart_sms_enabled?1:0):null,
      keywords_enabled!==undefined?(keywords_enabled?1:0):null
    );
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
module.exports.sendAppointmentReminders = sendAppointmentReminders;
module.exports.sendCartAbandonmentSMS   = sendCartAbandonmentSMS;
module.exports.ensureTables             = ensureTables;
const smsInboundLimiter = rateLimit({ windowMs: 60000, max: 100, message: { error: "Too many requests." } });
