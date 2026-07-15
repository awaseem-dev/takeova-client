const express = require("express");
const rateLimit = require('express-rate-limit');
const router = express.Router();
const aiFeatureLimiter = rateLimit({ windowMs: 60000, max: 30, message: { error: "Too many AI requests — slow down." } });
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

function getSetting(k) {
  try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; }
}

async function callClaude(prompt, apiKey, maxTokens = 1500) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }]
  });
  return msg.content?.[0]?.text || "";
}

function getApiKey() {
  return getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monthly_narratives (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, month TEXT NOT NULL,
      narrative TEXT NOT NULL, stats_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, month)
    );
    CREATE TABLE IF NOT EXISTS meeting_preps (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_email TEXT,
      booking_id TEXT, brief TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS churn_scores (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, customer_email TEXT NOT NULL,
      customer_name TEXT, risk_score INTEGER DEFAULT 0, risk_level TEXT DEFAULT 'low',
      reasons TEXT, suggested_action TEXT,
      last_scored TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, customer_email)
    );
  `);
}

// ═══════════════════════════════════════════════════════════════
// 1. MONTHLY BUSINESS NARRATOR
// ═══════════════════════════════════════════════════════════════
router.get("/monthly-narrative", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM

    // Serve cached if exists
    const cached = db.prepare("SELECT * FROM monthly_narratives WHERE user_id = ? AND month = ?").get(req.userId, month);
    if (cached) return res.json({ narrative: cached.narrative, stats: JSON.parse(cached.stats_json || "{}"), month, fresh: false });

    const apiKey = getApiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const u = global.mineCheckUsage(db, req.userId, "monthlyNarrative");
      if (u.blocked) return res.status(403).json({ error: u.cap === 0 ? "AI Business Advisor requires the Growth plan or higher." : `You've used your ${u.cap} report${u.cap===1?'':"s"} for this month. Upgrade to generate more.`, upgrade: true });
    }

    const [y, m] = month.split("-").map(Number);
    const monthStart = `${month}-01`;
    const monthEnd = new Date(y, m, 0).toISOString().slice(0, 10); // last day of month
    const prevStart = new Date(y, m - 2, 1).toISOString().slice(0, 10);
    const prevEnd = new Date(y, m - 1, 0).toISOString().slice(0, 10);

    const user = db.prepare("SELECT name, plan FROM users WHERE id = ?").get(req.userId) || {};
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? ORDER BY created_at LIMIT 1").get(req.userId) || {};

    // Revenue & orders
    const orders = db.prepare("SELECT total, created_at FROM orders WHERE user_id = ? AND date(created_at) BETWEEN ? AND ?").all(req.userId, monthStart, monthEnd);
    const prevOrders = db.prepare("SELECT total FROM orders WHERE user_id = ? AND date(created_at) BETWEEN ? AND ?").all(req.userId, prevStart, prevEnd);
    const revenue = orders.reduce((s, o) => s + (o.total || 0), 0);
    const prevRevenue = prevOrders.reduce((s, o) => s + (o.total || 0), 0);

    // Invoices
    const invoicesPaid = db.prepare("SELECT SUM(total) as t FROM invoices WHERE user_id = ? AND status = 'paid' AND (date(paid_at) BETWEEN ? AND ? OR date(created_at) BETWEEN ? AND ?)").get(req.userId, monthStart, monthEnd, monthStart, monthEnd);
    const invoicesOverdue = db.prepare("SELECT COUNT(*) as c, SUM(total) as t FROM invoices WHERE user_id = ? AND status IN ('sent','overdue') AND due_date < ?").get(req.userId, monthEnd);

    // Contacts added
    const newContacts = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND date(created_at) BETWEEN ? AND ?").get(req.userId, monthStart, monthEnd);

    // Bookings
    const bookings = db.prepare("SELECT COUNT(*) as c, SUM(price) as t FROM bookings WHERE user_id = ? AND date BETWEEN ? AND ?").get(req.userId, monthStart, monthEnd);

    // Email performance
    const emailStats = db.prepare("SELECT COUNT(*) as sent, SUM(opened) as opened, SUM(clicked) as clicked FROM email_sends WHERE user_id = ? AND date(created_at) BETWEEN ? AND ?").get(req.userId, monthStart, monthEnd) || {};

    // Reviews
    const reviews = db.prepare("SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE user_id = ? AND date(created_at) BETWEEN ? AND ?").get(req.userId, monthStart, monthEnd) || {};

    // Top product — orders.items is JSON so skip SQL GROUP BY; just count orders
    const topProduct = null;

    const monthName = new Date(y, m - 1, 1).toLocaleString("default", { month: "long" });

    const stats = {
      month: monthName + " " + y,
      businessName: site.name || user.name || "your business",
      revenue, prevRevenue,
      revenueChange: prevRevenue > 0 ? (((revenue - prevRevenue) / prevRevenue) * 100).toFixed(1) : null,
      orderCount: orders.length,
      invoicesPaid: invoicesPaid?.t || 0,
      overdueInvoices: invoicesOverdue?.c || 0,
      overdueAmount: invoicesOverdue?.t || 0,
      newContacts: newContacts?.c || 0,
      bookingCount: bookings?.c || 0,
      bookingRevenue: bookings?.t || 0,
      emailsSent: emailStats.sent || 0,
      emailOpenRate: emailStats.sent > 0 ? ((emailStats.opened / emailStats.sent) * 100).toFixed(1) : null,
      avgReviewRating: reviews?.avg ? parseFloat(reviews.avg).toFixed(1) : null,
      reviewCount: reviews?.cnt || 0,
      topProduct: null,
      topProductRevenue: 0
    };

    const prompt = `You are a sharp business analyst writing a monthly narrative summary for a small business owner.

BUSINESS: ${stats.businessName}
MONTH: ${stats.month}

DATA:
- Revenue: $${stats.revenue.toFixed(2)} (${stats.revenueChange !== null ? (stats.revenueChange > 0 ? "+" : "") + stats.revenueChange + "% vs last month" : "no comparison data"})
- Orders: ${stats.orderCount}
- Invoices collected: $${stats.invoicesPaid.toFixed(2)}
- Overdue invoices: ${stats.overdueInvoices} totalling $${stats.overdueAmount.toFixed(2)}
- New contacts added: ${stats.newContacts}
- Bookings: ${stats.bookingCount} worth $${stats.bookingRevenue.toFixed(2)}
- Emails sent: ${stats.emailsSent}${stats.emailOpenRate ? ", open rate: " + stats.emailOpenRate + "%" : ""}
- Reviews: ${stats.reviewCount}${stats.avgReviewRating ? ", avg rating: " + stats.avgReviewRating + "/5" : ""}
- Top product: ${stats.topProduct || "none"} ($${stats.topProductRevenue.toFixed(2)})

Write a 3-4 sentence narrative summary of this month. Tone: direct, honest, like a trusted CFO talking to a friend. Mention the biggest win, the biggest concern, and one specific thing to focus on next month. Use actual numbers. Do NOT use bullet points — write flowing prose only. Do NOT use generic advice. Keep it under 120 words.`;

    const narrative = await callClaude(prompt, apiKey, 400);

    db.prepare("INSERT OR REPLACE INTO monthly_narratives (id, user_id, month, narrative, stats_json) VALUES (?,?,?,?,?)")
      .run(uuid(), req.userId, month, narrative, JSON.stringify(stats));

    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "monthlyNarrative");
    res.json({ narrative, stats, month, fresh: true });
  } catch(e) {
    console.error("[AI Features] Monthly narrative error:", e?.message);
    res.status(500).json({ error: "Failed to generate narrative" });
  }
});

// ═══════════════════════════════════════════════════════════════
// 2. LEAD SCORING
// ═══════════════════════════════════════════════════════════════
router.post("/score-leads", auth, async (req, res) => {
  try {
    const db = getDb();
    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const u = global.mineCheckUsage(db, req.userId, "leadScoring");
      if (u.blocked) return res.status(403).json({ error: "Upgrade your plan to use lead scoring", cap: u.cap });
    }
    const apiKey = getApiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    // Score all contacts or a specific one
    const contactId = req.body.contactId || null;
    const contacts = contactId
      ? db.prepare("SELECT * FROM contacts WHERE id = ? AND user_id = ?").all(contactId, req.userId)
      : db.prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);

    if (!contacts.length) return res.json({ scored: 0, contacts: [] });

    const results = [];
    for (const contact of contacts) {
      // Gather signals
      const orders = db.prepare("SELECT COUNT(*) as cnt, SUM(total) as rev FROM orders WHERE user_id = ? AND (customer_email = ? OR customer_name = ?)").get(req.userId, contact.email, contact.name) || {};
      const emails = db.prepare("SELECT COUNT(*) as sent, SUM(opened) as opened, SUM(clicked) as clicked FROM email_sends WHERE user_id = ? AND recipient_email = ?").get(req.userId, contact.email) || {};
      const formSubs = db.prepare("SELECT COUNT(*) as cnt FROM form_submissions WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND data LIKE ?").get(req.userId, `%${contact.email}%`) || {};
      const bookings = db.prepare("SELECT COUNT(*) as cnt FROM bookings WHERE user_id = ? AND customer_email = ?").get(req.userId, contact.email) || {};
      const lastActivity = contact.last_activity || contact.last_seen || contact.created_at;
      const daysSinceActivity = lastActivity ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86400000) : 999;

      // Rule-based score (0-100)
      let score = 20; // base
      if ((orders.cnt || 0) > 0) score += 25;
      if ((orders.cnt || 0) > 2) score += 10;
      if ((orders.rev || 0) > 500) score += 10;
      if ((emails.sent || 0) > 0 && (emails.opened || 0) / emails.sent > 0.5) score += 10;
      if ((emails.clicked || 0) > 0) score += 8;
      if ((formSubs.cnt || 0) > 0) score += 7;
      if ((bookings.cnt || 0) > 0) score += 10;
      if (contact.status === "customer") score += 10;
      if (contact.status === "vip") score += 15;
      // Decay for inactivity
      if (daysSinceActivity > 90) score -= 15;
      if (daysSinceActivity > 180) score -= 10;
      score = Math.max(0, Math.min(100, score));

      const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";

      // Update DB
      db.prepare("UPDATE contacts SET lead_score = ?, lead_grade = ? WHERE id = ? AND user_id = ?")
        .run(score, grade, contact.id, req.userId);

      results.push({ id: contact.id, name: contact.name, email: contact.email, score, grade, orders: orders.cnt || 0, revenue: orders.rev || 0, daysSinceActivity });
    }

    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "leadScoring");
    res.json({ scored: results.length, contacts: results.sort((a, b) => b.score - a.score) });
  } catch(e) {
    console.error("[AI Features] Lead scoring error:", e?.message);
    res.status(500).json({ error: "Scoring failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// 3. CHURN PREDICTOR
// ═══════════════════════════════════════════════════════════════
router.get("/churn-risk", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const u = global.mineCheckUsage(db, req.userId, "churnRisk");
      if (u.blocked) return res.status(403).json({ error: "Upgrade your plan to use churn prediction", cap: u.cap });
    }
    const apiKey = getApiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    // Gather active subscribers and members
    const subscribers = [];
    try {
      const subs = db.prepare("SELECT customer_email, customer_name, status, total_cycles, created_at, dunning_attempt FROM product_sub_subscribers WHERE user_id = ? AND status = 'active'").all(req.userId);
      subs.forEach(s => subscribers.push({ ...s, type: "subscription" }));
    } catch {}
    try {
      const membs = db.prepare("SELECT customer_email, customer_name, status, started_at as created_at FROM membership_enrollments WHERE user_id = ? AND status = 'active'").all(req.userId);
      membs.forEach(m => subscribers.push({ ...m, type: "membership" }));
    } catch {}

    if (!subscribers.length) return res.json({ atRisk: [], total: 0 });

    const atRisk = [];
    for (const sub of subscribers) {
      const email = sub.customer_email;

      // Signals
      const emailEngagement = db.prepare("SELECT COUNT(*) as sent, SUM(opened) as opened FROM email_sends WHERE user_id = ? AND recipient_email = ? AND created_at >= datetime('now', '-60 days')").get(req.userId, email) || {};
      const lastOrder = db.prepare("SELECT created_at FROM orders WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 1").get(req.userId, email);
      const supportTickets = db.prepare("SELECT COUNT(*) as cnt FROM support_tickets WHERE user_id = ? AND customer_email = ? AND status != 'closed'").get(req.userId, email) || {};
      const reviewScore = db.prepare("SELECT AVG(rating) as avg FROM reviews WHERE user_id = ? AND customer_email = ?").get(req.userId, email);

      const daysSinceOrder = lastOrder ? Math.floor((Date.now() - new Date(lastOrder.created_at).getTime()) / 86400000) : 999;
      const openRate = emailEngagement.sent > 0 ? emailEngagement.opened / emailEngagement.sent : null;
      const lowEngagement = openRate !== null && openRate < 0.15;
      const hasOpenTickets = (supportTickets.cnt || 0) > 0;
      const lowRating = reviewScore?.avg && reviewScore.avg < 3;

      // Score risk
      let riskScore = 0;
      if (daysSinceOrder > 60) riskScore += 30;
      if (daysSinceOrder > 90) riskScore += 20;
      if (lowEngagement) riskScore += 25;
      if (openRate === null) riskScore += 10; // never opened email
      if (hasOpenTickets) riskScore += 20;
      if (lowRating) riskScore += 25;
      if ((sub.dunning_attempt || 0) > 0) riskScore += 30;

      riskScore = Math.min(100, riskScore);
      if (riskScore < 30) continue; // only surface medium+ risk

      const riskLevel = riskScore >= 70 ? "high" : riskScore >= 45 ? "medium" : "low";

      const reasons = [];
      if (daysSinceOrder > 60) reasons.push(`No purchase in ${daysSinceOrder} days`);
      if (lowEngagement) reasons.push(`Low email engagement (${Math.round(openRate * 100)}% open rate)`);
      if (openRate === null) reasons.push("Never opened emails");
      if (hasOpenTickets) reasons.push("Open support ticket");
      if (lowRating) reasons.push(`Left ${parseFloat(reviewScore.avg).toFixed(1)}★ review`);
      if ((sub.dunning_attempt || 0) > 0) reasons.push("Recent payment failure");

      // Use AI for suggested action only for high-risk
      let suggestedAction = riskLevel === "high"
        ? "Send a personal check-in email immediately and offer a loyalty discount"
        : "Re-engage with a personalised email this week";

      atRisk.push({
        email,
        name: sub.customer_name || email,
        type: sub.type,
        riskScore,
        riskLevel,
        reasons,
        suggestedAction,
        daysSinceOrder: daysSinceOrder < 999 ? daysSinceOrder : null
      });
    }

    atRisk.sort((a, b) => b.riskScore - a.riskScore);
    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "churnRisk");
    res.json({ atRisk, total: subscribers.length });
  } catch(e) {
    console.error("[AI Features] Churn risk error:", e?.message);
    res.status(500).json({ error: "Churn analysis failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// 4. AI SUPPORT TICKET HANDLER
// ═══════════════════════════════════════════════════════════════
router.post("/support-ticket-reply/:ticketId", auth, async (req, res) => {
  try {
    const db = getDb();
    const apiKey = getApiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    const ticket = db.prepare("SELECT * FROM support_tickets WHERE id = ? AND user_id = ?").get(req.params.ticketId, req.userId);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const u = global.mineCheckUsage(db, req.userId, "ticketReply");
      if (u.blocked) return res.status(403).json({ error: u.cap === 0 ? "AI ticket replies require the Growth plan or higher." : `You've used all ${u.cap} monthly AI ticket replies.`, upgrade: true });
    }

    const user = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId) || {};
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId) || {};

    // Get customer history for context
    const pastOrders = db.prepare("SELECT items, total, status, created_at FROM orders WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 5").all(req.userId, ticket.customer_email);
    const pastTickets = db.prepare("SELECT subject, status, created_at FROM support_tickets WHERE user_id = ? AND customer_email = ? AND id != ? ORDER BY created_at DESC LIMIT 3").all(req.userId, ticket.customer_email, ticket.id);

    const prompt = `You are a helpful customer support agent for ${site.name || "our business"}.

SUPPORT TICKET:
From: ${ticket.customer_name || ticket.customer_email}
Subject: ${ticket.subject || "(no subject)"}
Message: ${ticket.message}

CUSTOMER HISTORY:
${pastOrders.length ? "Past orders: " + pastOrders.map(o => `($${o.total}, ${o.status})`).join(", ") : "No previous orders"}
${pastTickets.length ? "Past tickets: " + pastTickets.map(t => t.subject).join(", ") : "First ticket"}

Classify this ticket and draft a professional, empathetic reply. Be specific, don't use generic phrases like "we understand your frustration".

Respond ONLY with valid JSON:
{
  "category": "billing|shipping|technical|refund|general|feedback",
  "priority": "urgent|high|normal|low",
  "sentiment": "frustrated|neutral|positive",
  "suggestedReply": "full reply text here",
  "internalNote": "1 sentence summary for the owner's reference",
  "requiresEscalation": false
}`;

    const text = await callClaude(prompt, apiKey, 800);
    let result;
    try {
      result = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      return res.status(500).json({ error: "AI response parse failed" });
    }

    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "ticketReply");
    res.json(result);
  } catch(e) {
    console.error("[AI Features] Ticket reply error:", e?.message);
    res.status(500).json({ error: "Failed to generate reply" });
  }
});

// POST support ticket (public — no auth, customers submit these)
router.post("/support-ticket", async (req, res) => {
  try {
    const db = getDb();
    const { siteId, customerName, customerEmail, subject, message } = req.body;
    if (!customerEmail || !message) return res.status(400).json({ error: "Email and message required" });

    const site = db.prepare("SELECT id, user_id FROM sites WHERE id = ?").get(siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT,
      customer_name TEXT, customer_email TEXT, subject TEXT, message TEXT,
      status TEXT DEFAULT 'open', ai_replied INTEGER DEFAULT 0, ai_response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);

    const id = uuid();
    db.prepare("INSERT INTO support_tickets (id, user_id, site_id, customer_name, customer_email, subject, message) VALUES (?,?,?,?,?,?,?)")
      .run(id, site.user_id, site.id, customerName || "", customerEmail, subject || "", message);

    res.json({ success: true, ticketId: id });
  } catch(e) {
    console.error("[AI Features] Create ticket error:", e?.message);
    res.status(500).json({ error: "Failed to submit ticket" });
  }
});

// GET all tickets for owner
router.get("/support-tickets", auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT,
      customer_name TEXT, customer_email TEXT, subject TEXT, message TEXT,
      status TEXT DEFAULT 'open', ai_replied INTEGER DEFAULT 0, ai_response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const tickets = db.prepare("SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
    res.json({ tickets });
  } catch(e) { res.json({ tickets: [] }); }
});

// PUT update ticket status
router.put("/support-tickets/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, ai_response } = req.body;
    const updates = [];
    const params = [];
    if (status) { updates.push("status = ?"); params.push(status); }
    if (ai_response !== undefined) { updates.push("ai_response = ?, ai_replied = 1"); params.push(ai_response); }
    if (!updates.length) return res.status(400).json({ error: "Nothing to update" });
    params.push(req.params.id, req.userId);
    db.prepare(`UPDATE support_tickets SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: "Update failed" }); }
});

// ═══════════════════════════════════════════════════════════════
// 5. REFUND RESPONSE DRAFTER
// ═══════════════════════════════════════════════════════════════
router.post("/draft-refund-response", auth, async (req, res) => {
  try {
    const db = getDb();
    const apiKey = getApiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    const { orderId, context } = req.body;
    if (!orderId) return res.status(400).json({ error: "orderId required" });

    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(orderId, req.userId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const u = global.mineCheckUsage(db, req.userId, "refundDraft");
      if (u.blocked) return res.status(403).json({ error: u.cap === 0 ? "AI refund response drafting requires the Growth plan or higher." : `You've used all ${u.cap} monthly refund drafts.`, upgrade: true });
    }

    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId) || {};
    const pastOrders = db.prepare("SELECT COUNT(*) as cnt, SUM(total) as ltv FROM orders WHERE user_id = ? AND customer_email = ?").get(req.userId, order.customer_email) || {};
    const refundContext = context || "Customer requested a refund";

    const prompt = `You are writing on behalf of ${site.name || "a small business"}.

ORDER:
- Customer: ${order.customer_name} (${order.customer_email})
- Product: ${order.items || "product"}
- Amount: $${order.total}
- Date: ${order.created_at?.slice(0, 10)}
- Customer LTV: $${(pastOrders.ltv || 0).toFixed(2)} across ${pastOrders.cnt || 1} orders

REFUND REASON: ${refundContext}

Generate 3 response options:
1. APPROVE — full refund, warm and apologetic
2. COUNTER — offer store credit or partial refund instead of full cash refund
3. DECLINE — polite but firm decline with clear reason

Respond ONLY with valid JSON:
{
  "approve": { "subject": "...", "body": "..." },
  "counter": { "subject": "...", "body": "...", "counterOffer": "store credit / partial amount" },
  "decline": { "subject": "...", "body": "...", "reason": "..." }
}`;

    const text = await callClaude(prompt, apiKey, 1000);
    let result;
    try {
      result = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      return res.status(500).json({ error: "Parse failed" });
    }
    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "refundDraft");
    res.json({ ...result, order: { id: order.id, customer: order.customer_name, total: order.total } });
  } catch(e) {
    console.error("[AI Features] Refund drafter error:", e?.message);
    res.status(500).json({ error: "Failed to draft response" });
  }
});

// ═══════════════════════════════════════════════════════════════
// 6. EMAIL SUBJECT LINE OPTIMIZER
// ═══════════════════════════════════════════════════════════════
router.post("/optimize-subject", auth, async (req, res) => {
  try {
    const db = getDb();
    const apiKey = getApiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    const { subject, bodyPreview, audience, goal } = req.body;
    if (!subject && !bodyPreview) return res.status(400).json({ error: "subject or bodyPreview required" });

    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const u = global.mineCheckUsage(db, req.userId, "subjectOptimize");
      if (u.blocked) return res.status(403).json({ error: u.cap === 0 ? "Subject line optimization is available on Starter (3/mo) and higher." : `You've used all ${u.cap} monthly subject optimizations.`, upgrade: true });
    }

    // Pull historical open rates for context
    const topSubjects = db.prepare("SELECT subject, opened, created_at FROM email_sends WHERE user_id = ? AND opened = 1 AND subject IS NOT NULL ORDER BY created_at DESC LIMIT 10").all(req.userId);

    const prompt = `You are an email marketing expert. Generate 5 high-performing subject line variants.

ORIGINAL SUBJECT: ${subject || "(none)"}
EMAIL PREVIEW: ${bodyPreview?.slice(0, 300) || "(not provided)"}
TARGET AUDIENCE: ${audience || "general subscribers"}
GOAL: ${goal || "engagement / opens"}
${topSubjects.length ? "PAST SUBJECTS THAT GOT OPENS: " + topSubjects.map(s => s.subject).join(", ") : ""}

Rules:
- Each variant uses a different psychological trigger (curiosity, urgency, personalization, benefit, social proof)
- Max 50 characters each
- No spam trigger words (free, guarantee, act now, !!!)
- No clickbait that doesn't match the email content

Respond ONLY with valid JSON:
{
  "variants": [
    { "subject": "...", "trigger": "curiosity|urgency|personalization|benefit|social_proof", "reasoning": "why this works", "predictedOpenRate": "estimated %" },
    ...
  ],
  "winner": "index of recommended variant (0-4)",
  "tips": ["1-2 specific tips for this email"]
}`;

    const text = await callClaude(prompt, apiKey, 800);
    let result;
    try {
      result = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      return res.status(500).json({ error: "Parse failed" });
    }
    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "subjectOptimize");
    res.json(result);
  } catch(e) {
    console.error("[AI Features] Subject optimizer error:", e?.message);
    res.status(500).json({ error: "Optimization failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// 7. COURSE CONTENT GENERATOR
// ═══════════════════════════════════════════════════════════════
router.post("/generate-course-content", auth, async (req, res) => {
  try {
    const db = getDb();
    const apiKey = getApiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    const { courseTitle, targetAudience, modules, style } = req.body;
    if (!courseTitle || !modules?.length) return res.status(400).json({ error: "courseTitle and modules required" });
    if (modules.length > 10) return res.status(400).json({ error: "Maximum 10 modules per generation" });

    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const u = global.mineCheckUsage(db, req.userId, "courseContent");
      if (u.blocked) return res.status(403).json({ error: u.cap === 0 ? "AI course content generation requires the Growth plan or higher." : `You've used all ${u.cap} monthly course content generations.`, upgrade: true });
    }

    const prompt = `You are an expert instructional designer. Generate complete course content.

COURSE TITLE: ${courseTitle}
TARGET AUDIENCE: ${targetAudience || "general learners"}
TEACHING STYLE: ${style || "practical and engaging"}
MODULES TO GENERATE:
${modules.map((m, i) => `${i + 1}. ${m.title}${m.description ? " — " + m.description : ""}`).join("\n")}

For EACH module generate:
- lesson_text: 200-300 word lesson content (engaging, practical, with examples)
- key_takeaways: 3 bullet points
- quiz: 2 multiple choice questions with 4 options each and correct answer
- assignment: 1 practical assignment students can complete

Respond ONLY with valid JSON:
{
  "modules": [
    {
      "title": "...",
      "lesson_text": "...",
      "key_takeaways": ["...", "...", "..."],
      "quiz": [
        { "question": "...", "options": ["a","b","c","d"], "answer": 0 },
        { "question": "...", "options": ["a","b","c","d"], "answer": 2 }
      ],
      "assignment": { "title": "...", "instructions": "...", "deliverable": "..." }
    }
  ]
}`;

    const text = await callClaude(prompt, apiKey, 3000);
    let result;
    try {
      result = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      return res.status(500).json({ error: "Content parse failed — try fewer modules" });
    }
    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "courseContent");
    res.json(result);
  } catch(e) {
    console.error("[AI Features] Course content error:", e?.message);
    res.status(500).json({ error: "Generation failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// 8. MEETING PREP BRIEF
// ═══════════════════════════════════════════════════════════════
router.get("/meeting-prep/:bookingId", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const apiKey = getApiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    const booking = db.prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?").get(req.params.bookingId, req.userId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const u = global.mineCheckUsage(db, req.userId, "meetingPrep");
      if (u.blocked) return res.status(403).json({ error: u.cap === 0 ? "Meeting prep briefs require the Growth plan or higher." : `You've used all ${u.cap} monthly meeting prep briefs.`, upgrade: true });
    }

    const email = booking.customer_email;
    const user = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId) || {};
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId) || {};

    // Gather everything about this customer
    const contact = db.prepare("SELECT * FROM contacts WHERE user_id = ? AND email = ?").get(req.userId, email);
    const orders = db.prepare("SELECT items, total, status, created_at FROM orders WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 10").all(req.userId, email);
    const invoices = db.prepare("SELECT total, status, due_date FROM invoices WHERE user_id = ? AND client_email = ? ORDER BY created_at DESC LIMIT 5").all(req.userId, email);
    const pastBookings = db.prepare("SELECT service, date, notes, status FROM bookings WHERE user_id = ? AND customer_email = ? AND id != ? ORDER BY date DESC LIMIT 5").all(req.userId, email, req.params.bookingId);
    const emails = db.prepare("SELECT subject, opened, clicked, created_at FROM email_sends WHERE user_id = ? AND recipient_email = ? ORDER BY created_at DESC LIMIT 5").all(req.userId, email);
    const review = db.prepare("SELECT rating, text AS content FROM reviews WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 1").get(req.userId, email);
    const tickets = db.prepare("SELECT subject, status, message FROM support_tickets WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 3").all(req.userId, email);

    const totalSpend = orders.reduce((s, o) => s + (o.total || 0), 0) + invoices.filter(i => i.status === "paid").reduce((s, i) => s + (i.total || 0), 0);

    const prompt = `You are preparing a one-page meeting brief for a business owner named ${user.name || "the owner"} at ${site.name || "their business"}.

UPCOMING MEETING:
- With: ${booking.customer_name} (${email})
- Service: ${booking.service || "session"}
- Date/Time: ${booking.date} ${booking.time || ""}
- Notes on booking: ${booking.notes || "none"}

CUSTOMER PROFILE:
- Total spend: $${totalSpend.toFixed(2)}
- Orders: ${orders.length}
- Past sessions: ${pastBookings.length} (${pastBookings.map(b => b.service).filter(Boolean).slice(0, 3).join(", ") || "none"})
- Last email: ${emails[0] ? `"${emails[0].subject}" (${emails[0].opened ? "opened" : "not opened"})` : "none sent"}
- Review: ${review ? `${review.rating}★ — "${review.content?.slice(0, 100)}"` : "no review"}
- Open tickets: ${tickets.filter(t => t.status !== "closed").map(t => t.subject).join(", ") || "none"}
- Contact notes: ${contact?.notes || "none"}

Write a concise meeting prep brief with these sections:
1. WHO THEY ARE (2-3 sentences on this customer's relationship and value)
2. WHAT TO EXPECT (what they likely want from this session based on history)
3. WATCH OUT FOR (any concerns, unresolved issues, or sensitivities)
4. TALKING POINTS (3 specific things worth mentioning — upsell opportunities, follow-ups, appreciation)

Keep it under 200 words total. Be specific and practical, not generic.`;

    const brief = await callClaude(prompt, apiKey, 600);

    // Cache it
    db.prepare("INSERT INTO meeting_preps (id, user_id, contact_email, booking_id, brief) VALUES (?,?,?,?,?)")
      .run(uuid(), req.userId, email, req.params.bookingId, brief);

    if (typeof global !== "undefined" && global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "meetingPrep");
    res.json({
      brief,
      customer: {
        name: booking.customer_name,
        email,
        totalSpend,
        ordersCount: orders.length,
        pastSessionsCount: pastBookings.length,
        reviewRating: review?.rating || null
      },
      booking: { service: booking.service, date: booking.date, time: booking.time }
    });
  } catch(e) {
    console.error("[AI Features] Meeting prep error:", e?.message);
    res.status(500).json({ error: "Failed to generate brief" });
  }
});


// ── POST /api/ai-features/advisor-insights ─────────────────────────────────────
// Takes the narrative + stats and returns structured opportunities/risks/focus
router.post("/advisor-insights", auth, async (req, res) => {
  try {
    const { narrative, stats } = req.body;
    if (!narrative) return res.status(400).json({ error: "Narrative required" });

    const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "AI not configured" });

    const prompt = `Based on this business performance narrative and stats, extract structured insights.

NARRATIVE: ${narrative}

STATS:
- Revenue: $${(stats.revenue||0).toFixed(2)} (${stats.revenueChange ? (stats.revenueChange > 0 ? '+' : '') + stats.revenueChange + '% vs last month' : 'no comparison'})
- Orders: ${stats.orderCount || 0}
- Bookings: ${stats.bookingCount || 0}
- New contacts: ${stats.newContacts || 0}
- Email open rate: ${stats.emailOpenRate || 'N/A'}%
- Avg review rating: ${stats.avgReviewRating || 'N/A'}

Respond ONLY with valid JSON in this exact format:
{
  "opportunities": ["specific opportunity 1", "specific opportunity 2", "specific opportunity 3"],
  "risks": ["specific risk 1", "specific risk 2"],
  "focus": "One clear, specific sentence about what to focus on next month with a concrete action."
}

Be specific and use actual numbers from the data. No generic advice.`;

    const fetch = (await import("node-fetch")).default;
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500,
        messages: [{ role: "user", content: prompt }] })
    });
    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(clean);
    res.json(parsed);
  } catch(e) {
    console.error("[Advisor Insights]", e?.message);
    res.status(500).json({ error: "Failed to generate insights" });
  }
});

// ── GET /api/ai-features/advisor-history ──────────────────────────────────────
// Returns past monthly narratives for the user
router.get("/advisor-history", auth, (req, res) => {
  try {
    const db = getDb();
    const reports = db.prepare(
      "SELECT month, narrative, stats_json, created_at FROM monthly_narratives WHERE user_id = ? ORDER BY month DESC LIMIT 12"
    ).all(req.userId);
    res.json({ reports: reports.map(r => ({
      month: r.month,
      narrative: r.narrative,
      stats: (() => { try { return JSON.parse(r.stats_json || "{}"); } catch(e) { return {}; } })(),
      created_at: r.created_at
    }))});
  } catch(e) {
    res.json({ reports: [] });
  }
});

module.exports = router;
