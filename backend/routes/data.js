const express = require("express");
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

const router = express.Router();

// ═══ CRM CONTACTS ═══
// ── Lead scoring migration ──────────────────────────────────────────
try {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(contacts)").all().map(c => c.name);
  if (!cols.includes('lead_score'))  db.prepare("ALTER TABLE contacts ADD COLUMN lead_score INTEGER DEFAULT 0").run();
  if (!cols.includes('score_updated_at')) db.prepare("ALTER TABLE contacts ADD COLUMN score_updated_at TEXT").run();
  if (!cols.includes('total_spent'))  db.prepare("ALTER TABLE contacts ADD COLUMN total_spent REAL DEFAULT 0").run();
  if (!cols.includes('order_count'))  db.prepare("ALTER TABLE contacts ADD COLUMN order_count INTEGER DEFAULT 0").run();
  if (!cols.includes('booking_count')) db.prepare("ALTER TABLE contacts ADD COLUMN booking_count INTEGER DEFAULT 0").run();
  if (!cols.includes('last_activity')) db.prepare("ALTER TABLE contacts ADD COLUMN last_activity TEXT").run();
} catch(e) {}

// ── Lead score calculator ─────────────────────────────────────────────────
function calcLeadScore(db, contact) {
  let score = 0;

  // Profile completeness
  if (contact.email)   score += 10;
  if (contact.phone)   score += 5;
  if (contact.name && contact.name.includes(' ')) score += 3; // Has full name

  // Status
  const statusScores = { lead: 0, prospect: 8, qualified: 15, customer: 20, vip: 25 };
  score += statusScores[contact.status] || 0;

  // Order/purchase history
  try {
    const orders = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total),0) as total FROM orders WHERE user_id=? AND (customer_email=? OR customer_name=?)").get(contact.user_id, contact.email, contact.name);
    if (orders.n > 0)  score += 12;
    if (orders.n > 2)  score += 5;
    if (orders.total > 100)  score += 5;
    if (orders.total > 500)  score += 8;
    if (orders.total > 2000) score += 5;
  } catch(e) {}

  // Booking history
  try {
    const bookings = db.prepare("SELECT COUNT(*) as n FROM bookings WHERE user_id=? AND customer_email=?").get(contact.user_id, contact.email);
    if (bookings.n > 0) score += 8;
    if (bookings.n > 3) score += 4;
  } catch(e) {}

  // Email engagement
  try {
    const emails = db.prepare("SELECT SUM(opened) as opens, SUM(clicked) as clicks FROM email_sends WHERE user_id=? AND to_email=?").get(contact.user_id, contact.email);
    if (emails?.opens > 0)  score += 6;
    if (emails?.clicks > 0) score += 4;
  } catch(e) {}

  // Recent activity (last 14 days)
  try {
    const recentOrder = db.prepare("SELECT id FROM orders WHERE user_id=? AND customer_email=? AND created_at > datetime('now','-14 days')").get(contact.user_id, contact.email);
    const recentBooking = db.prepare("SELECT id FROM bookings WHERE user_id=? AND customer_email=? AND created_at > datetime('now','-14 days')").get(contact.user_id, contact.email);
    if (recentOrder || recentBooking) score += 10;
  } catch(e) {}

  // Has left a review
  try {
    const review = db.prepare("SELECT id FROM google_reviews WHERE user_id=? AND (author_name=? OR review_id LIKE ?)").get(contact.user_id, contact.name, `%${contact.email}%`);
    if (review) score += 5;
  } catch(e) {}

  return Math.min(100, Math.max(0, score));
}

router.get("/contacts", auth, (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const contacts = db.prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(req.userId, limit, offset);
  const total = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ?").get(req.userId)?.c || 0;
  res.json({ contacts, total, limit, offset, hasMore: offset + contacts.length < total });
});

// Helper: fire automations for a trigger event
async function fireAutomation(userId, trigger_type, trigger_data) {
  try {
    const fetch = (await import("node-fetch")).default;
    const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
    fetch(backendUrl + "/api/platform/automations/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": userId, "x-internal-key": process.env.INTERNAL_API_KEY || "" },
      body: JSON.stringify({ trigger_type, trigger_data })
    }).catch(() => {});
  } catch (e) { /* Non-critical, don't block */ }
}

router.post("/contacts", auth, async (req, res) => {
  const db = getDb();
  const { name, email, phone, status, notes, tags } = req.body;
  const id = uuid();
  db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, status, notes, tags_json, tags, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id, req.userId, name, email, phone, status || "lead", notes, JSON.stringify(tags || []), JSON.stringify(tags || []), "Today"
  );
  try { // funnel auto-enrollment: active funnels triggered by new contacts
    const _em = (req.body.email || "").trim().toLowerCase();
    if (_em) {
      db.exec("CREATE TABLE IF NOT EXISTS funnel_enrollments (id TEXT PRIMARY KEY, funnel_id TEXT, user_id TEXT, contact_email TEXT, contact_name TEXT, current_step INTEGER DEFAULT 0, status TEXT DEFAULT 'active', enrolled_at TEXT DEFAULT (datetime('now')), last_email_at TEXT, completed_at TEXT)");
      const _fz = db.prepare("SELECT id FROM funnels WHERE user_id=? AND status='active' AND trigger_event IN ('New signup','New contact','contact_created')").all(req.userId);
      for (const _f of _fz) {
        const _dup = db.prepare("SELECT 1 FROM funnel_enrollments WHERE funnel_id=? AND contact_email=?").get(_f.id, _em);
        if (!_dup) db.prepare("INSERT INTO funnel_enrollments (id, funnel_id, user_id, contact_email, contact_name) VALUES (?,?,?,?,?)").run(uuid(), _f.id, req.userId, _em, req.body.name || "");
      }
    }
  } catch (_e) { /* enrollment is best-effort */ }

  // Fire automation
  fireAutomation(req.userId, "new_lead", { name, email, phone, status: status || "lead" });
  // ── Intelligence: log contact_added event ──────────────────────────
  try {
    const { logEvent } = require("./intelligence");
    logEvent(db, req.userId, "contact_added", { count: 1, source: "manual" });
  } catch(e) {}
  res.json({ contact: db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) });
});

router.put("/contacts/:id", auth, (req, res) => {
  const db = getDb();
  const { name, email, phone, status, notes, tags } = req.body;
  db.prepare("UPDATE contacts SET name=COALESCE(?,name), email=COALESCE(?,email), phone=COALESCE(?,phone), status=COALESCE(?,status), notes=COALESCE(?,notes), tags_json=COALESCE(?,tags_json), tags=COALESCE(?,tags) WHERE id=? AND user_id=?").run(
    name, email, phone, status, notes, tags ? JSON.stringify(tags) : null, tags ? JSON.stringify(tags) : null, req.params.id, req.userId
  );
  res.json({ contact: db.prepare("SELECT * FROM contacts WHERE id = ? AND user_id = ?").get(req.params.id, req.userId) || null });
});

router.delete("/contacts/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM contacts WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});



// POST /data/contacts/:id/score — calculate score for one contact
router.post("/contacts/:id/score", auth, (req, res) => {
  try {
    const db = getDb();
    const contact = db.prepare("SELECT * FROM contacts WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const score = calcLeadScore(db, { ...contact, user_id: req.userId });
    db.prepare("UPDATE contacts SET lead_score = ?, score_updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(score, req.params.id, req.userId);
    res.json({ success: true, id: req.params.id, lead_score: score });
  } catch(e) { console.error("[score contact]", e?.message); res.status(500).json({ error: "Scoring failed" }); }
});

// POST /data/contacts/score-all — batch score all contacts for this user
router.post("/contacts/score-all", auth, (req, res) => {
  try {
    const db = getDb();
    const contacts = db.prepare("SELECT * FROM contacts WHERE user_id = ?").all(req.userId);
    let updated = 0;
    for (const c of contacts) {
      const score = calcLeadScore(db, { ...c, user_id: req.userId });
      db.prepare("UPDATE contacts SET lead_score = ?, score_updated_at = datetime('now') WHERE id = ?").run(score, c.id);
      updated++;
    }
    // Return fresh scored contacts
    const scored = db.prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY lead_score DESC").all(req.userId);
    res.json({ success: true, updated, contacts: scored });
  } catch(e) { console.error("[score-all]", e?.message); res.status(500).json({ error: "Batch scoring failed" }); }
});

// GET /data/contacts/hot — contacts with score >= 70
router.get("/contacts/hot", auth, (req, res) => {
  try {
    const db = getDb();
    const hot = db.prepare("SELECT * FROM contacts WHERE user_id = ? AND lead_score >= 70 ORDER BY lead_score DESC LIMIT 20").all(req.userId);
    res.json({ contacts: hot });
  } catch(e) { res.json({ contacts: [] }); }
});

// ═══ FUNNELS ═══
router.get("/funnels", auth, (req, res) => {
  const db = getDb();
  const _rows = db.prepare("SELECT * FROM funnels WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  _rows.forEach(r => { r.steps = r.emails_json || "[]"; });
  res.json({ funnels: _rows });
});

router.post("/funnels", auth, (req, res) => {
  const db = getDb();
  const { name, trigger_event, emails, steps, trigger } = req.body;
  const _emails = emails || steps || [];
  const _trig = trigger_event || trigger;
  const id = uuid();
  db.prepare("INSERT INTO funnels (id, user_id, name, trigger_event, emails_json) VALUES (?,?,?,?,?)").run(
    id, req.userId, name, _trig || "New signup", JSON.stringify(_emails)
  );
  res.json({ funnel: db.prepare("SELECT * FROM funnels WHERE id = ?").get(id) });
});

router.patch("/funnels/:id", auth, (req, res) => {
  const db = getDb();
  const { name, status } = req.body;
  const trigger_event = req.body.trigger_event || req.body.trigger;
  const emails = req.body.emails || req.body.steps;
  const on_reply = req.body.on_reply;
  try { db.exec("ALTER TABLE funnels ADD COLUMN on_reply TEXT DEFAULT 'continue'"); } catch (_a) {}
  const fields = [];
  const vals = [];
  if (name) { fields.push("name=?"); vals.push(name); }
  if (trigger_event) { fields.push("trigger_event=?"); vals.push(trigger_event); }
  if (status) { fields.push("status=?"); vals.push(status); }
  if (emails) { fields.push("emails_json=?"); vals.push(JSON.stringify(emails)); }
  if (on_reply) { fields.push("on_reply=?"); vals.push(String(on_reply).slice(0,80)); }
  vals.push(req.params.id, req.userId);
  if (fields.length) db.prepare(`UPDATE funnels SET ${fields.join(",")} WHERE id=? AND user_id=?`).run(...vals);
  res.json({ funnel: db.prepare("SELECT * FROM funnels WHERE id = ? AND user_id = ?").get(req.params.id, req.userId) || null });
});

router.delete("/funnels/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM funnels WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// ═══ NOTIFICATIONS ═══
router.get("/notifications", auth, (req, res) => {
  const db = getDb();
  // Optional filters: ?type=referral_signup&limit=10
  // Used by the referral rewards UI to poll for real-time signup events.
  const type  = req.query.type;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  let rows;
  if (type) {
    rows = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT ?").all(req.userId, type, limit);
  } else {
    rows = db.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(req.userId, limit);
  }
  res.json({ notifications: rows });
});

router.patch("/notifications/:id/read", auth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

router.post("/notifications/read-all", auth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ?").run(req.userId);
  res.json({ success: true });
});

// Unread notification count (fast — used for bell badge on page load)
router.get("/notifications/unread-count", auth, (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare(
      "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0"
    ).get(req.userId);
    res.json({ count: row ? row.count : 0 });
  } catch(e) {
    res.json({ count: 0 });
  }
});


// ═══ REFERRALS ═══

// ═══ INVOICES ═══
router.get("/invoices", auth, (req, res) => {
  try {
  const db = getDb();
    const invoices = db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
    res.json({ invoices });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/invoices", auth, (req, res) => {
  try {
  const db = getDb();
    const { client, client_name, email, client_email, items_json, items, status, total, subtotal, due, due_date, number, invoice_number, pay_link, notes } = req.body;
    const id = uuid();
    const invNumber = invoice_number || number || ("INV-" + Date.now().toString(36).toUpperCase());
    const clientName = client_name || client || "";
    const clientEmail = client_email || email || "";
    const itemsData = items_json || (items ? JSON.stringify(items) : "[]");
    db.prepare("INSERT INTO invoices (id, user_id, invoice_number, client_name, client_email, items_json, subtotal, total, status, due_date, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, invNumber, clientName, clientEmail, itemsData, subtotal || total || 0, total || 0, status || "draft", due_date || due || "", notes || "");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/invoices/:id", auth, (req, res) => {
  try {
  const db = getDb();
    const { client, client_name, email, client_email, items_json, status, total, subtotal, due, due_date, notes } = req.body;
    db.prepare("UPDATE invoices SET client_name=?, client_email=?, items_json=?, subtotal=?, total=?, status=?, due_date=?, notes=? WHERE id=? AND user_id=?")
      .run(client_name||client||"", client_email||email||"", items_json||"[]", subtotal||total||0, total||0, status, due_date||due||"", notes||"", req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/invoices/:id", auth, (req, res) => {
  try {
  const db = getDb();
    db.prepare("DELETE FROM invoices WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ═══ REFERRALS ═══
router.get("/referrals", auth, (req, res) => {
  const db = getDb();
  const referrals = db.prepare("SELECT * FROM referrals WHERE referrer_id = ? ORDER BY created_at DESC").all(req.userId);
  const user = db.prepare("SELECT referral_code, referral_revenue, commission_earned FROM users WHERE id = ?").get(req.userId);
  res.json({ referrals, ...user });
});

router.post("/referrals/payout", auth, (req, res) => {
  const db = getDb();
  // Atomic payout to prevent double-spend race. Previously this did
  // SELECT → check → UPDATE which is race-vulnerable: two concurrent
  // requests (e.g. double-click) could both pass the check and both
  // issue payouts for the full amount. The atomic UPDATE returns changes=0
  // if the balance was already zeroed or was below the threshold.
  const user = db.prepare("SELECT commission_earned FROM users WHERE id = ?").get(req.userId);
  if (!user || (user.commission_earned || 0) < 50) {
    return res.status(400).json({ error: "Minimum payout is $50" });
  }
  const amount = user.commission_earned;
  // The WHERE clause guarantees we only zero it if the balance is still what
  // we think it is — prevents racing with another in-flight payout.
  const result = db.prepare(
    "UPDATE users SET commission_earned = 0 WHERE id = ? AND commission_earned = ?"
  ).run(req.userId, amount);
  if (result.changes === 0) {
    // Someone else (another tab/request) already claimed this payout.
    return res.status(409).json({ error: "Payout already processed or balance changed. Refresh and try again." });
  }
  // In production: trigger Stripe Connect payout here.
  db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
    .run(req.userId, "payout_requested", `$${amount}`);
  db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
    .run(uuid(), req.userId, "💰", `Payout of $${amount.toFixed(2)} requested. Processing within 48hrs.`, "Just now");
  res.json({ success: true, amount });
});

// ═══ SHIPPING CALCULATOR ═══
// Users configure shipping rules per site, customers get rates at checkout

// Public: Calculate shipping for a customer checkout
router.post("/shipping/calculate", (req, res) => {
  const { siteId, subtotal, weight, country, state } = req.body;
  const db = getDb();
  ensureShippingTable(db);
  const rules = db.prepare("SELECT * FROM shipping_rules WHERE site_id = ? ORDER BY sort_order").all(siteId);

  const options = rules.map(rule => {
    const zones = JSON.parse(rule.zones || "[]");
    // Check if zone matches (empty zones = worldwide)
    if (zones.length > 0 && !zones.some(z => z === country || z === state || z === "worldwide")) return null;
    // Free shipping threshold
    if (rule.free_above > 0 && subtotal >= rule.free_above) return { name: rule.name, rate: 0, freeShipping: true };
    // Weight-based
    if (rule.type === "weight") {
      const w = weight || 1;
      if (w < rule.min_weight || w > rule.max_weight) return null;
      return { name: rule.name, rate: rule.rate * w };
    }
    // Percentage
    if (rule.type === "percent") return { name: rule.name, rate: Math.round(subtotal * (rule.rate / 100) * 100) / 100 };
    // Flat rate (default)
    return { name: rule.name, rate: rule.rate };
  }).filter(Boolean);

  // If no rules, default free shipping
  if (options.length === 0) options.push({ name: "Standard Shipping", rate: 0, freeShipping: true });

  res.json({ options });
});

router.get("/shipping/:siteId", auth, (req, res) => {
  const db = getDb();
  ensureShippingTable(db);
  const rules = db.prepare("SELECT * FROM shipping_rules WHERE site_id = ? AND user_id = ? ORDER BY sort_order").all(req.params.siteId, req.userId);
  res.json({ rules });
});

router.post("/shipping/:siteId", auth, (req, res) => {
  const db = getDb();
  ensureShippingTable(db);
  const { name, type, rate, freeAbove, minWeight, maxWeight, zones } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO shipping_rules (id, site_id, user_id, name, type, rate, free_above, min_weight, max_weight, zones, sort_order, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, req.params.siteId, req.userId, name, type || "flat", rate || 0, freeAbove || 0, minWeight || 0, maxWeight || 9999, JSON.stringify(zones || []), 0);
  res.json({ success: true, id });
});

router.delete("/shipping/:ruleId", auth, (req, res) => {
  const db = getDb();
  ensureShippingTable(db);
  db.prepare("DELETE FROM shipping_rules WHERE id = ? AND user_id = ?").run(req.params.ruleId, req.userId);
  res.json({ success: true });
});

// ═══ TAX CALCULATION ═══
// Uses Stripe Tax if available, fallback to simple rate-based

// Public: Calculate tax for checkout
router.post("/tax/calculate", async (req, res) => {
  const { siteId, subtotal, country, state, shippingAmount } = req.body;
  const db = getDb();
  ensureTaxTable(db);

  // Try Stripe Tax first
  const { getSetting } = require("./integrations");
  const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
  if (stripeKey && getSetting("USE_STRIPE_TAX")) {
    try {
      const stripe = require("stripe")(stripeKey);
      const calc = await stripe.tax.calculations.create({
        currency: "usd",
        line_items: [{ amount: Math.round(subtotal * 100), reference: "order" }],
        customer_details: { address: { country: country || "US", state: state || "" }, address_source: "shipping" },
        shipping_cost: shippingAmount ? { amount: Math.round(shippingAmount * 100) } : undefined,
      });
      return res.json({
        taxAmount: calc.tax_amount_exclusive / 100,
        taxRate: calc.line_items?.data?.[0]?.tax_rate || 0,
        provider: "stripe_tax",
        breakdown: calc.tax_breakdown?.map(t => ({ name: t.tax_rate_details?.display_name, rate: t.rate, amount: t.amount / 100 })) || [],
      });
    } catch(e) { console.error("[/tax/calculate]", e.message || e); }
  }

  // Fallback: manual tax rules
  const rules = db.prepare("SELECT * FROM tax_rules WHERE site_id = ?").all(siteId);
  let totalTax = 0;
  const breakdown = [];

  for (const rule of rules) {
    if (rule.country && rule.country !== country) continue;
    if (rule.state && rule.state !== state) continue;
    const taxable = subtotal + (shippingAmount || 0);
    const amount = rule.type === "fixed" ? rule.rate : Math.round(taxable * (rule.rate / 100) * 100) / 100;
    totalTax += amount;
    breakdown.push({ name: rule.name, rate: rule.rate, amount });
  }

  res.json({ taxAmount: totalTax, provider: "manual", breakdown });
});

router.get("/tax/:siteId", auth, (req, res) => {
  const db = getDb();
  ensureTaxTable(db);
  const rules = db.prepare("SELECT * FROM tax_rules WHERE site_id = ? AND user_id = ?").all(req.params.siteId, req.userId);
  res.json({ rules });
});

router.post("/tax/:siteId", auth, (req, res) => {
  const db = getDb();
  ensureTaxTable(db);
  const { name, rate, country, state, type, inclusive } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO tax_rules (id, site_id, user_id, name, rate, country, state, type, inclusive, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, req.params.siteId, req.userId, name || "Sales Tax", rate || 0, country || "", state || "", type || "percentage", inclusive ? 1 : 0);
  res.json({ success: true, id });
});

router.delete("/tax/:ruleId", auth, (req, res) => {
  const db = getDb();
  ensureTaxTable(db);
  db.prepare("DELETE FROM tax_rules WHERE id = ? AND user_id = ?").run(req.params.ruleId, req.userId);
  res.json({ success: true });
});

// ═══ GOOGLE CALENDAR SYNC ═══
// Syncs bookings to user's Google Calendar

router.post("/calendar/sync", auth, async (req, res) => {
  const { bookingId, title, startTime, endTime, customerName, customerEmail, location } = req.body;
  const db = getDb();

  // Get user's Google OAuth token
  const token = db.prepare("SELECT access_token, refresh_token FROM user_social_tokens WHERE user_id = ? AND platform = 'google'").get(req.userId);
  if (!token?.access_token) return res.status(400).json({ error: "Connect Google Calendar first (Settings → Integrations → Google)" });

  const fetch = (await import("node-fetch")).default;

  // Refresh token if needed
  let accessToken = token.access_token;
  const { getSetting } = require("./integrations");
  const clientId = getSetting("GOOGLE_CLIENT_ID");
  const clientSecret = getSetting("GOOGLE_CLIENT_SECRET");

  if (token.refresh_token && clientId && clientSecret) {
    try {
      const tr = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=${token.refresh_token}&client_id=${clientId}&client_secret=${clientSecret}`,
      });
      const td = await tr.json();
      if (td.access_token) {
        accessToken = td.access_token;
        db.prepare("UPDATE user_social_tokens SET access_token = ? WHERE user_id = ? AND platform = 'google'").run(accessToken, req.userId);
      }
    } catch(e) { console.error("[/calendar/sync]", e.message || e); }
  }

  // Create Google Calendar event
  try {
    const event = {
      summary: title || `Booking: ${customerName}`,
      description: `Customer: ${customerName}\nEmail: ${customerEmail || "N/A"}\nBooked via MINE`,
      start: { dateTime: startTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
      end: { dateTime: endTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
      attendees: customerEmail ? [{ email: customerEmail }] : [],
      location: location || "",
      reminders: { useDefault: false, overrides: [{ method: "email", minutes: 60 }, { method: "popup", minutes: 30 }] },
    };

    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    const d = await r.json();

    if (d.id) {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "calendar_synced", JSON.stringify({ bookingId, googleEventId: d.id, customerName }));
      res.json({ success: true, eventId: d.id, link: d.htmlLink });
    } else {
      res.status(400).json({ error: d.error?.message || "Failed to create event" });
    }
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// Get upcoming calendar events
router.get("/calendar/events", auth, async (req, res) => {
  const db = getDb();
  const token = db.prepare("SELECT access_token FROM user_social_tokens WHERE user_id = ? AND platform = 'google'").get(req.userId);
  if (!token?.access_token) return res.json({ events: [], connected: false });

  const fetch = (await import("node-fetch")).default;
  try {
    const now = new Date().toISOString();
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&maxResults=20&orderBy=startTime&singleEvents=true`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const d = await r.json();
    res.json({ events: (d.items || []).map(e => ({ id: e.id, title: e.summary, start: e.start?.dateTime, end: e.end?.dateTime, link: e.htmlLink })), connected: true });
  } catch (e) { res.json({ events: [], connected: true, error: "An internal error occurred" }); }
});

function ensureShippingTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS shipping_rules (
    id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, name TEXT,
    type TEXT DEFAULT 'flat', rate REAL DEFAULT 0, free_above REAL DEFAULT 0,
    min_weight REAL DEFAULT 0, max_weight REAL DEFAULT 9999,
    zones TEXT DEFAULT '[]', sort_order INTEGER DEFAULT 0, created_at TEXT
  )`);
}

function ensureTaxTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tax_rules (
    id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, name TEXT,
    rate REAL DEFAULT 0, country TEXT, state TEXT,
    type TEXT DEFAULT 'percentage', inclusive INTEGER DEFAULT 0, created_at TEXT
  )`);
}

// ─── BLOG POSTS ───
router.get("/blog-posts", auth, (req, res) => {
  const db = getDb();
  const posts = db.prepare("SELECT * FROM blog_posts WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ posts });
});

router.post("/blog-posts", auth, (req, res) => {
  const { v4: uuid } = require("uuid");
  const db = getDb();
  const { site_id, siteId, title, content, excerpt, tags, coverImage, cover_image, status } = req.body;
  // tenant isolation: if this post attaches to a site, that site must belong to the caller
  const _targetSiteId = site_id || siteId;
  if (_targetSiteId) {
    const _owns = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(_targetSiteId, req.userId);
    if (!_owns) return res.status(404).json({ error: "Site not found" });
  }
  const id = uuid();
  // Auto-generate a URL slug from the title
  const slug = (title || "").toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) + "-" + id.slice(0, 8);
  db.prepare("INSERT INTO blog_posts (id, site_id, user_id, title, slug, content, excerpt, tags_json, cover_image, status) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id, site_id||siteId, req.userId, title, slug, content, excerpt, JSON.stringify(tags || []), cover_image||coverImage, status || "draft"
  );
  // If this is the first published post for this site, inject a Blog nav link into the site HTML
  if ((status || "draft") === "published") {
    try {
      const sid = site_id || siteId;
      const existing = db.prepare("SELECT COUNT(*) as n FROM blog_posts WHERE site_id = ? AND status = 'published'").get(sid);
      if (existing?.n <= 1) { // this is the first (or only) published post
        const site = db.prepare("SELECT html FROM sites WHERE id = ?").get(sid);
        if (site?.html && !site.html.includes('href="/blog"')) {
          // Try to append after the last existing nav <a> tag; fall back to injecting before </nav>
          let updated = site.html;
          if (updated.includes("</nav>")) {
            updated = updated.replace("</nav>", '<a href="/blog" style="margin-left:12px">Blog</a></nav>');
          } else if (updated.includes("</header>")) {
            updated = updated.replace("</header>", '<a href="/blog" style="margin-left:12px">Blog</a></header>');
          }
          if (updated !== site.html) {
            db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?").run(updated, sid);
          }
        }
      }
    } catch(e) { console.error("[/blog-posts]", e.message || e); }
  }
  res.json({ post: db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(id) });
});

router.put("/blog-posts/:id", auth, (req, res) => {
  const db = getDb();
  const { title, content, excerpt, tags, coverImage, cover_image, status } = req.body;
  db.prepare("UPDATE blog_posts SET title=?, content=?, excerpt=?, tags_json=?, cover_image=?, status=?, updated_at=datetime('now') WHERE id=? AND user_id=?").run(
    title, content, excerpt, JSON.stringify(tags || []), cover_image||coverImage, status, req.params.id, req.userId
  );
  res.json({ success: true });
});

router.delete("/blog-posts/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM blog_posts WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});


// ─── MISSING CROSS-SITE DATA ROUTES ───
// loadAllData calls these to populate top-level state

router.get("/products", auth, (req, res) => {
  const db = getDb();
  // Get all products across all user's sites
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ products: [] });
  const ph = sites.map(() => "?").join(",");
  const products = db.prepare(`SELECT * FROM products WHERE site_id IN (${ph}) ORDER BY created_at DESC`).all(...sites);
  res.json({ products });
});

// Update a product's name/description (AI description writer save — audit 2026-06-10)
router.put("/products/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
    if (!sites.length) return res.json({ success: false, error: "Product not found" });
    const ph = sites.map(() => "?").join(",");
    const { name, description } = req.body;
    const r = db.prepare(`UPDATE products SET name=COALESCE(?,name), description=COALESCE(?,description) WHERE id=? AND site_id IN (${ph})`)
      .run(name || null, description || null, req.params.id, ...sites);
    if (!r.changes) return res.json({ success: false, error: "Product not found" });
    res.json({ success: true });
  } catch (e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/courses", auth, (req, res) => {
  const db = getDb();
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ courses: [] });
  const ph = sites.map(() => "?").join(",");
  res.json({ courses: db.prepare(`SELECT * FROM courses WHERE site_id IN (${ph}) ORDER BY created_at DESC`).all(...sites) });
});

router.get("/bookings", auth, (req, res) => {
  const db = getDb();
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ bookings: [] });
  const ph = sites.map(() => "?").join(",");
  res.json({ bookings: db.prepare(`SELECT * FROM bookings WHERE site_id IN (${ph}) ORDER BY created_at DESC`).all(...sites) });
});

// ═══ EVENT TICKETING ═══

function ensureEventTables(db) {
  // Add missing columns for existing DBs (safe to run multiple times)
  try { db.exec("ALTER TABLE events ADD COLUMN start_date TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE events ADD COLUMN end_date TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE events ADD COLUMN capacity INTEGER"); } catch(e) {}
  // event_tickets: add columns from data.js schema to existing init.js table
  try { db.exec("ALTER TABLE event_tickets ADD COLUMN name TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE event_tickets ADD COLUMN description TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE event_tickets ADD COLUMN quantity INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE event_tickets ADD COLUMN sold INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE event_tickets ADD COLUMN type TEXT DEFAULT 'general'"); } catch(e) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      cover_image TEXT,
      status TEXT DEFAULT 'draft',
      capacity INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_tickets (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL DEFAULT 0,
      quantity INTEGER,
      sold INTEGER DEFAULT 0,
      type TEXT DEFAULT 'general',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_attendees (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      user_id TEXT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      quantity INTEGER DEFAULT 1,
      total_paid REAL DEFAULT 0,
      status TEXT DEFAULT 'confirmed',
      payment_intent TEXT,
      check_in_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// List all events for user
router.get("/events", auth, (req, res) => {
  const db = getDb();
  ensureEventTables(db);
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ events: [] });
  const ph = sites.map(() => "?").join(",");
  const events = db.prepare(`SELECT * FROM events WHERE site_id IN (${ph}) ORDER BY start_date ASC`).all(...sites);
  const withTickets = events.map(e => ({
    ...e,
    tickets: db.prepare("SELECT * FROM event_tickets WHERE event_id = ?").all(e.id),
    attendee_count: db.prepare("SELECT COALESCE(SUM(quantity),0) as c FROM event_attendees WHERE event_id = ? AND status != 'cancelled'").get(e.id)?.c || 0
  }));
  res.json({ events: withTickets });
});

// Create event
router.post("/events", auth, (req, res) => {
  const db = getDb();
  ensureEventTables(db);
  const { site_id, title, description, location, start_date, end_date, cover_image, capacity, status, tickets } = req.body;
  if (!title || !start_date) return res.status(400).json({ error: "Title and start date required" });
  const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(site_id, req.userId);
  if (!site) return res.status(403).json({ error: "Site not found" });
  const id = uuid();
  db.prepare("INSERT INTO events (id, site_id, user_id, title, description, location, start_date, end_date, cover_image, capacity, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, site_id, req.userId, title, description, location, start_date, end_date, cover_image, capacity, status || "draft");
  if (Array.isArray(tickets)) {
    for (const t of tickets) {
      db.prepare("INSERT INTO event_tickets (id, event_id, name, description, price, quantity, type) VALUES (?,?,?,?,?,?,?)")
        .run(uuid(), id, t.name, t.description, t.price || 0, t.quantity || null, t.type || "general");
    }
  }
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  event.tickets = db.prepare("SELECT * FROM event_tickets WHERE event_id = ?").all(id);
  res.json({ event });
});

// PUBLIC: Get event page (no auth)
router.get("/events/public/:eventId", (req, res) => {
  const db = getDb();
  ensureEventTables(db);
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND status = 'published'").get(req.params.eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  const tickets = db.prepare("SELECT *, (COALESCE(quantity,9999) - sold) as available FROM event_tickets WHERE event_id = ?").all(event.id);
  const attendee_count = db.prepare("SELECT COALESCE(SUM(quantity),0) as c FROM event_attendees WHERE event_id = ? AND status != 'cancelled'").get(event.id)?.c || 0;
  res.json({ event: { ...event, tickets, attendee_count } });
});

// PUBLIC: Register/purchase ticket (free or paid)
const _eventRegLimiter = require("express-rate-limit")({ windowMs: 15*60*1000, max: 10, standardHeaders: true, legacyHeaders: false });
router.post("/events/public/:eventId/register", _eventRegLimiter, async (req, res) => {
  const db = getDb();
  ensureEventTables(db);
  const { ticket_id, name, email, phone, quantity } = req.body;
  if (!name || !email || !ticket_id) return res.status(400).json({ error: "Name, email and ticket type required" });
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
  if (!EMAIL_RE.test(email) || email.length > 320) return res.status(400).json({ error: "Invalid email address" });
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND status = 'published'").get(req.params.eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  const ticket = db.prepare("SELECT * FROM event_tickets WHERE id = ? AND event_id = ?").get(ticket_id, event.id);
  if (!ticket) return res.status(404).json({ error: "Ticket type not found" });
  const qty = Math.min(Math.max(parseInt(quantity) || 1, 1), 10); // cap at 10 tickets per registration
  // Pre-check (fast path) — full atomic guard is below
  if (ticket.quantity !== null && (ticket.sold + qty) > ticket.quantity) return res.status(400).json({ error: "Not enough tickets available" });
  const total = ticket.price * qty;
  const attendeeId = uuid();
  // For paid tickets, create a Stripe payment intent
  let payment_intent = null;
  if (total > 0) {
    try {
      const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(event.site_id);
      const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
      if (stripeKey) {
        const fetch = (await import("node-fetch")).default;
        const piResp = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers: { "Authorization": "Bearer " + stripeKey, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ amount: Math.round(total * 100), currency: "usd", "metadata[event_id]": event.id, "metadata[attendee_id]": attendeeId, "metadata[email]": email }).toString()
        });
        const pi = await piResp.json();
        payment_intent = pi.client_secret;
      }
    } catch(e) { console.error("[/:eventId/register]", e.message || e); }
  }
  db.prepare("INSERT INTO event_attendees (id, event_id, ticket_id, name, email, phone, quantity, total_paid, status, payment_intent) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(attendeeId, event.id, ticket_id, name, email, phone, qty, total, total > 0 && payment_intent ? "pending_payment" : "confirmed", payment_intent);
  if (total === 0 || !payment_intent) {
    // Atomic increment — only proceeds if capacity still available, prevents oversell race
    const ticketUpdate = db.prepare(
      "UPDATE event_tickets SET sold = sold + ? WHERE id = ? AND (quantity IS NULL OR sold + ? <= quantity)"
    ).run(qty, ticket_id, qty);
    if (ticketUpdate.changes === 0) {
      // Clean up the attendee record we just inserted
      db.prepare("DELETE FROM event_attendees WHERE id = ?").run(attendeeId);
      return res.status(409).json({ error: "Tickets sold out — please try again" });
    }
  }
  res.json({ ok: true, attendee_id: attendeeId, requires_payment: total > 0, payment_intent, total });
});


// Update event
router.put("/events/:id", auth, (req, res) => {
  const db = getDb();
  ensureEventTables(db);
  const { title, description, location, start_date, end_date, cover_image, capacity, status } = req.body;
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  db.prepare("UPDATE events SET title=COALESCE(?,title), description=COALESCE(?,description), location=COALESCE(?,location), start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date), cover_image=COALESCE(?,cover_image), capacity=COALESCE(?,capacity), status=COALESCE(?,status) WHERE id=?")
    .run(title, description, location, start_date, end_date, cover_image, capacity, status, req.params.id);
  res.json({ event: db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id) });
});

// Delete event
router.delete("/events/:id", auth, (req, res) => {
  const db = getDb();
  ensureEventTables(db);
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  db.prepare("DELETE FROM event_tickets WHERE event_id = ?").run(req.params.id);
  db.prepare("DELETE FROM event_attendees WHERE event_id = ?").run(req.params.id);
  db.prepare("DELETE FROM events WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Get attendees for an event
router.get("/events/:id/attendees", auth, (req, res) => {
  const db = getDb();
  ensureEventTables(db);
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  res.json({ attendees: db.prepare("SELECT a.*, t.name as ticket_name, t.price as ticket_price FROM event_attendees a LEFT JOIN event_tickets t ON a.ticket_id = t.id WHERE a.event_id = ? ORDER BY a.created_at DESC").all(req.params.id) });
});

// Check in attendee
router.post("/events/:id/checkin/:attendeeId", auth, (req, res) => {
  const db = getDb();
  ensureEventTables(db);
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!event) return res.status(403).json({ error: "Not authorised" });
  db.prepare("UPDATE event_attendees SET check_in_at = datetime('now'), status = 'checked_in' WHERE id = ? AND event_id = ?")
    .run(req.params.attendeeId, req.params.id);
  res.json({ ok: true });
});

router.get("/forms", auth, (req, res) => {
  const db = getDb();
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ forms: [] });
  const ph = sites.map(() => "?").join(",");
  res.json({ forms: db.prepare(`SELECT * FROM forms WHERE site_id IN (${ph}) ORDER BY created_at DESC`).all(...sites) });
});

router.get("/memberships", auth, (req, res) => {
  const db = getDb();
  // membership_tiers is the table written by the dashboard (features.js /memberships routes)
  // Fall back to legacy `memberships` table if membership_tiers doesn't exist yet
  try {
    db.exec("CREATE TABLE IF NOT EXISTS membership_tiers (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, name TEXT, price REAL DEFAULT 0, interval TEXT DEFAULT 'monthly', perks TEXT DEFAULT '[]', podcast_access INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    const memberships = db.prepare("SELECT * FROM membership_tiers WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
    return res.json({ memberships });
  } catch(e) {
    const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
    if (!sites.length) return res.json({ memberships: [] });
    const ph = sites.map(() => "?").join(",");
    return res.json({ memberships: db.prepare(`SELECT * FROM memberships WHERE site_id IN (${ph}) ORDER BY created_at DESC`).all(...sites) });
  }
});


// ─── ANALYTICS SUMMARY (used by mobile app) ───
// Returns aggregated stats: revenue, orders, visitors, leads for a given period
router.get("/analytics", auth, (req, res) => {
  const db = getDb();
  const period = req.query.period || "7d";
  const days = period === "1d" ? 1 : period === "30d" ? 30 : 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
    const ph = sites.length ? sites.map(() => "?").join(",") : "''";
    const siteArgs = sites.length ? sites : [];

    const revenue = sites.length
      ? db.prepare(`SELECT COALESCE(SUM(total),0) as r FROM orders WHERE site_id IN (${ph}) AND created_at >= ?`).get(...siteArgs, since)?.r || 0
      : 0;
    const orders = sites.length
      ? db.prepare(`SELECT COUNT(*) as c FROM orders WHERE site_id IN (${ph}) AND created_at >= ?`).get(...siteArgs, since)?.c || 0
      : 0;
    const leads = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND created_at >= ?").get(req.userId, since)?.c || 0;

    // Visitor counts from site_analytics if available, else site views
    let visitors = 0;
    try {
      visitors = sites.length
        ? db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM site_analytics WHERE site_id IN (${ph}) AND created_at >= ?`).get(...siteArgs, since)?.c || 0
        : 0;
    } catch (e) {
      visitors = sites.length
        ? db.prepare(`SELECT COALESCE(SUM(views),0) as c FROM sites WHERE id IN (${ph})`).get(...siteArgs)?.c || 0
        : 0;
    }

    // Revenue chart — one entry per day
    const revenueChart = [];
    const dayLabels = ["Su","Mo","Tu","We","Th","Fr","Sa"];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const dayStart = d.toISOString().split("T")[0];
      const dayRevenue = sites.length
        ? db.prepare(`SELECT COALESCE(SUM(total),0) as r FROM orders WHERE site_id IN (${ph}) AND created_at >= ? AND created_at < ?`).get(...siteArgs, dayStart + "T00:00:00.000Z", dayStart + "T23:59:59.999Z")?.r || 0
        : 0;
      revenueChart.push({ label: dayLabels[d.getDay()], value: dayRevenue, highlight: i === 0 });
    }

    // Top pages
    let topPages = [];
    try {
      topPages = sites.length
        ? db.prepare(`SELECT page, COUNT(*) as views FROM site_analytics WHERE site_id IN (${ph}) AND created_at >= ? GROUP BY page ORDER BY views DESC LIMIT 5`).all(...siteArgs, since)
        : [];
    } catch (e) { topPages = []; }

    res.json({ revenue, orders, visitors, leads, revenueChart, topPages, period });
  } catch (e) {
    console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── TIME ENTRIES (frontend calls /api/data/time-entries) ──────────────────────
router.get("/time-entries", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id, invoiced, billable, limit } = req.query;
    let q = "SELECT * FROM time_entries WHERE user_id = ?";
    const params = [req.userId];
    if (contact_id) { q += " AND contact_id = ?"; params.push(contact_id); }
    if (invoiced !== undefined) { q += " AND invoiced = ?"; params.push(invoiced === 'true' ? 1 : 0); }
    if (billable !== undefined) { q += " AND billable = ?"; params.push(billable === 'true' ? 1 : 0); }
    q += ` ORDER BY date DESC, created_at DESC LIMIT ${Math.min(parseInt(limit)||200, 500)}`;
    const entries = db.prepare(q).all(...params);
    res.json({ entries });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/time-entries", auth, (req, res) => {
  try {
    const db = getDb();
    const { client_name, contact_id, description, date, duration_minutes, duration_hours, hourly_rate, billable, tags } = req.body;
    if (!description || !date) return res.status(400).json({ error: "description and date required" });
    const mins = duration_minutes || Math.round((parseFloat(duration_hours)||0) * 60) || 60;
    const id = uuid();
    db.prepare(`INSERT INTO time_entries (id,user_id,contact_id,client_name,description,date,duration_minutes,hourly_rate,billable,invoiced)
                VALUES (?,?,?,?,?,?,?,?,?,0)`)
      .run(id, req.userId, contact_id||null, client_name||"", description, date, mins, parseFloat(hourly_rate)||0, billable!==false?1:0);
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/time-entries/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { client_name, contact_id, description, date, duration_minutes, duration_hours, hourly_rate, billable } = req.body;
    const mins = duration_minutes || Math.round((parseFloat(duration_hours)||0) * 60);
    db.prepare("UPDATE time_entries SET client_name=?,contact_id=?,description=?,date=?,duration_minutes=?,hourly_rate=?,billable=? WHERE id=? AND user_id=?")
      .run(client_name, contact_id||null, description, date, mins, parseFloat(hourly_rate)||0, billable!==false?1:0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/time-entries/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM time_entries WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/time-entries/invoice", auth, async (req, res) => {
  try {
    const db = getDb();
    const { entry_ids, client_name, client_email, due_date, notes, tax_pct } = req.body;
    if (!entry_ids?.length) return res.status(400).json({ error: "entry_ids required" });
    const ph = entry_ids.map(() => '?').join(',');
    const entries = db.prepare(`SELECT * FROM time_entries WHERE id IN (${ph}) AND user_id=? AND invoiced=0`)
      .all(...entry_ids, req.userId);
    if (!entries.length) return res.status(400).json({ error: "No uninvoiced entries found" });
    const items = entries.map(e => ({
      description: `${e.description}${e.client_name ? ' — ' + e.client_name : ''} (${(e.duration_minutes/60).toFixed(1)}h @ $${e.hourly_rate}/hr)`,
      amount: Math.round((e.duration_minutes/60) * (e.hourly_rate||0) * 100) / 100
    }));
    const subtotal = items.reduce((s,i) => s + i.amount, 0);
    const tax = Math.round(subtotal * ((tax_pct||0)/100) * 100) / 100;
    const total = subtotal + tax;
    const invNum = `TIME-${Date.now().toString().slice(-6)}`;
    const dueDate = due_date || new Date(Date.now()+14*86400000).toISOString().split('T')[0];
    const invId = uuid();
    db.prepare(`INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,items_json,subtotal,tax,total,status,due_date,notes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(invId, req.userId, invNum, client_name||entries[0].client_name||"Client",
           client_email||"", JSON.stringify(items), subtotal, tax, total, 'sent', dueDate, notes||"");
    db.prepare(`UPDATE time_entries SET invoiced=1, invoice_id=? WHERE id IN (${ph})`).run(invId, ...entry_ids);
    res.json({ success: true, invoice_id: invId, invoice_number: invNum, total, entries_count: entries.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Roadmap ─────────────────────────────────────────────────────────────────
router.get("/roadmap", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare(`CREATE TABLE IF NOT EXISTS roadmap_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'feature',
      status TEXT DEFAULT 'planned',
      priority TEXT DEFAULT 'medium',
      votes INTEGER DEFAULT 0,
      target_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
    const items = db.prepare("SELECT * FROM roadmap_items WHERE user_id = ? ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, priority DESC, created_at DESC").all(req.userId);
    res.json({ items });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/roadmap", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare(`CREATE TABLE IF NOT EXISTS roadmap_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'feature',
      status TEXT DEFAULT 'planned',
      priority TEXT DEFAULT 'medium',
      votes INTEGER DEFAULT 0,
      target_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
    const { title, description, category, status, priority, target_date } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });
    const r = db.prepare("INSERT INTO roadmap_items (user_id, title, description, category, status, priority, target_date) VALUES (?, ?, ?, ?, ?, ?, ?)").run(req.userId, title, description||"", category||"feature", status||"planned", priority||"medium", target_date||null);
    res.json({ id: r.lastInsertRowid, success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/roadmap/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, description, category, status, priority, target_date, votes } = req.body;
    const fields = []; const vals = [];
    if (title !== undefined) { fields.push("title=?"); vals.push(title); }
    if (description !== undefined) { fields.push("description=?"); vals.push(description); }
    if (category !== undefined) { fields.push("category=?"); vals.push(category); }
    if (status !== undefined) { fields.push("status=?"); vals.push(status); }
    if (priority !== undefined) { fields.push("priority=?"); vals.push(priority); }
    if (target_date !== undefined) { fields.push("target_date=?"); vals.push(target_date); }
    if (votes !== undefined) { fields.push("votes=votes+1"); }
    fields.push("updated_at=CURRENT_TIMESTAMP");
    vals.push(req.params.id, req.userId);
    db.prepare(`UPDATE roadmap_items SET ${fields.join(",")} WHERE id=? AND user_id=?`).run(...vals);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/roadmap/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM roadmap_items WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});


// ── Advanced Analytics ────────────────────────────────────────────────────────
router.get("/cohort-analysis", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    // Cohort: customers grouped by signup month, retention by month
    const cohorts = db.prepare(`
      SELECT
        strftime('%Y-%m', c.created_at) as cohort_month,
        COUNT(DISTINCT c.id) as cohort_size,
        SUM(CASE WHEN julianday('now') - julianday(c.created_at) > 30 THEN 1 ELSE 0 END) as retained_30d,
        SUM(CASE WHEN julianday('now') - julianday(c.created_at) > 60 THEN 1 ELSE 0 END) as retained_60d,
        SUM(CASE WHEN julianday('now') - julianday(c.created_at) > 90 THEN 1 ELSE 0 END) as retained_90d
      FROM contacts c
      WHERE c.user_id = ? AND c.status = 'customer'
      GROUP BY cohort_month
      ORDER BY cohort_month DESC
      LIMIT 12
    `).all(uid);
    res.json({ cohorts });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/funnel-analysis", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const contacts = db.prepare("SELECT COUNT(*) as total FROM contacts WHERE user_id = ?").get(uid);
    const leads = db.prepare("SELECT COUNT(*) as total FROM contacts WHERE user_id = ? AND status IN ('lead','prospect')").get(uid);
    const customers = db.prepare("SELECT COUNT(*) as total FROM contacts WHERE user_id = ? AND status = 'customer'").get(uid);
    const orders = db.prepare("SELECT COUNT(*) as total, SUM(total) as revenue FROM orders WHERE user_id = ?").get(uid);
    res.json({
      funnel: [
        { stage: "Visitors", count: (contacts?.total || 0) * 8, icon: "👥" },
        { stage: "Leads", count: leads?.total || 0, icon: "🎯" },
        { stage: "Customers", count: customers?.total || 0, icon: "⭐" },
        { stage: "Repeat Buyers", count: Math.floor((customers?.total || 0) * 0.3), icon: "🔄" },
      ],
      revenue: orders?.revenue || 0,
      orders: orders?.total || 0
    });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/subscription-analytics", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const subs = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled FROM membership_tiers WHERE user_id = ?").get(uid);
    const mrr = db.prepare("SELECT SUM(CASE WHEN m.interval='monthly' THEN m.price WHEN m.interval='yearly' THEN m.price/12 ELSE 0 END) * COALESCE(e.cnt, 0) as mrr FROM membership_tiers m LEFT JOIN (SELECT membership_id, COUNT(*) as cnt FROM membership_enrollments GROUP BY membership_id) e ON e.membership_id = m.id WHERE m.user_id = ?").get(uid);
    res.json({
      subscriptions: subs || { total: 0, active: 0, cancelled: 0 },
      mrr: mrr?.mrr || 0,
      churn_rate: subs?.total > 0 ? Math.round((subs.cancelled / subs.total) * 100) : 0
    });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
