// Unified Inbox — merges a contact's messages across SMS, WhatsApp, email and
// website-chat into one time-ordered thread. Contacts are matched by phone
// (SMS/WhatsApp) and email (email/chat). Read-only (no sending) in this version.
//
// Channel data sources (graceful if a table is absent):
//   sms        → sms_inbox       (contact_phone, body, direction, created_at)   [two-way]
//   whatsapp   → whatsapp_messages (contact_phone, body, direction, created_at) [two-way, populated by inbound webhook once added]
//   email      → email_log       (to_email, subject, created_at)                [outbound, subject-level only]
//   chat       → chat_messages   (visitor_email, message, sender, created_at)   [two-way, scoped via the user's sites]
const express = require("express");
const router = express.Router();
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

// last-9-digits phone key — format/country agnostic, applied consistently to
// both sides so the same number matches across +61.../04... variants.
const phoneKey = s => (s || "").toString().replace(/\D/g, "").slice(-9);
const emailKey = s => (s || "").toString().trim().toLowerCase();
// run a query but never let one missing table break the whole inbox
const safe = fn => { try { return fn() || []; } catch (e) { return []; } };

function userSiteIds(db, uid) {
  return safe(() => db.prepare("SELECT id FROM sites WHERE user_id = ?").all(uid)).map(s => s.id);
}

// GET /api/inbox/threads — one entry per contact (or anonymous handle), newest first
router.get("/threads", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;

    const contacts = safe(() => db.prepare("SELECT id,name,email,phone FROM contacts WHERE user_id = ?").all(uid));
    const byPhone = {}, byEmail = {};
    contacts.forEach(c => { if (c.phone) byPhone[phoneKey(c.phone)] = c; if (c.email) byEmail[emailKey(c.email)] = c; });

    const threads = {}; // key -> thread
    function add(contact, msg) {
      const key = (contact && contact.id) ? "c:" + contact.id
        : (msg.phone ? "p:" + phoneKey(msg.phone) : (msg.email ? "e:" + emailKey(msg.email) : "x:" + (msg.name || "unknown")));
      let t = threads[key];
      if (!t) {
        t = threads[key] = {
          contact_id: (contact && contact.id) || null,
          name: (contact && contact.name) || msg.name || msg.phone || msg.email || "Unknown",
          email: (contact && contact.email) || msg.email || null,
          phone: (contact && contact.phone) || msg.phone || null,
          channels: {}, count: 0, unread: 0, last_message: "", last_channel: "", last_at: ""
        };
      }
      t.channels[msg.channel] = true;
      t.count++;
      if (msg.unread) t.unread++;
      if (!t.last_at || String(msg.created_at) > String(t.last_at)) {
        t.last_at = msg.created_at; t.last_message = (msg.body || "").slice(0, 120); t.last_channel = msg.channel;
      }
    }

    // SMS
    safe(() => db.prepare("SELECT contact_phone,contact_name,body,direction,created_at,read FROM sms_inbox WHERE user_id = ?").all(uid))
      .forEach(m => add(byPhone[phoneKey(m.contact_phone)],
        { channel: "sms", body: m.body, created_at: m.created_at, name: m.contact_name, phone: m.contact_phone, unread: (m.direction === "inbound" && !m.read) }));

    // WhatsApp (empty until inbound webhook persists messages)
    safe(() => db.prepare("SELECT contact_phone,contact_name,body,direction,created_at FROM whatsapp_messages WHERE user_id = ?").all(uid))
      .forEach(m => add(byPhone[phoneKey(m.contact_phone)],
        { channel: "whatsapp", body: m.body, created_at: m.created_at, name: m.contact_name, phone: m.contact_phone, unread: (m.direction === "inbound") }));

    // Email (outbound, subject-level)
    safe(() => db.prepare("SELECT to_email,subject,type,created_at FROM email_log WHERE user_id = ?").all(uid))
      .forEach(m => add(byEmail[emailKey(m.to_email)],
        { channel: "email", body: (m.subject || m.type || "Email"), created_at: m.created_at, email: m.to_email, unread: 0 }));

    // Website chat (scoped via the user's sites)
    const siteIds = userSiteIds(db, uid);
    if (siteIds.length) {
      const ph = siteIds.map(() => "?").join(",");
      safe(() => db.prepare("SELECT visitor_email,visitor_name,message,sender,created_at,read FROM chat_messages WHERE site_id IN (" + ph + ")").all(...siteIds))
        .forEach(m => add((m.visitor_email && byEmail[emailKey(m.visitor_email)]),
          { channel: "chat", body: m.message, created_at: m.created_at, name: m.visitor_name, email: m.visitor_email, unread: (m.sender === "visitor" && !m.read) }));
    }

    const list = Object.keys(threads).map(k => {
      const t = threads[k]; t.channels = Object.keys(t.channels); return t;
    }).sort((a, b) => String(b.last_at || "").localeCompare(String(a.last_at || "")));

    res.json({ threads: list, count: list.length });
  } catch (e) {
    res.status(500).json({ error: "Failed to load inbox" });
  }
});

// GET /api/inbox/threads/:contactId — full merged thread for one contact
router.get("/threads/:contactId", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const c = safe(() => { const r = db.prepare("SELECT id,name,email,phone FROM contacts WHERE id = ? AND user_id = ?").get(req.params.contactId, uid); return r ? [r] : []; })[0];
    if (!c) return res.status(404).json({ error: "Contact not found" });

    const msgs = [];
    if (c.phone) {
      const pk = phoneKey(c.phone);
      safe(() => db.prepare("SELECT body,direction,created_at FROM sms_inbox WHERE user_id = ? AND replace(replace(replace(replace(contact_phone,'+',''),'-',''),' ',''),'(','') LIKE ?").all(uid, "%" + pk))
        .forEach(m => msgs.push({ channel: "sms", direction: m.direction, body: m.body, created_at: m.created_at }));
      safe(() => db.prepare("SELECT body,direction,created_at FROM whatsapp_messages WHERE user_id = ? AND replace(replace(replace(replace(contact_phone,'+',''),'-',''),' ',''),'(','') LIKE ?").all(uid, "%" + pk))
        .forEach(m => msgs.push({ channel: "whatsapp", direction: m.direction, body: m.body, created_at: m.created_at }));
    }
    if (c.email) {
      const ek = emailKey(c.email);
      safe(() => db.prepare("SELECT subject,type,created_at FROM email_log WHERE user_id = ? AND lower(to_email) = ?").all(uid, ek))
        .forEach(m => msgs.push({ channel: "email", direction: "outbound", body: (m.subject || m.type || "Email"), created_at: m.created_at }));
      const siteIds = userSiteIds(db, uid);
      if (siteIds.length) {
        const ph = siteIds.map(() => "?").join(",");
        safe(() => db.prepare("SELECT message,sender,created_at FROM chat_messages WHERE site_id IN (" + ph + ") AND lower(visitor_email) = ?").all(...siteIds, ek))
          .forEach(m => msgs.push({ channel: "chat", direction: (m.sender === "visitor" ? "inbound" : "outbound"), body: m.message, created_at: m.created_at }));
      }
    }
    msgs.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    res.json({ contact: c, messages: msgs, count: msgs.length });
  } catch (e) {
    res.status(500).json({ error: "Failed to load thread" });
  }
});

module.exports = router;
