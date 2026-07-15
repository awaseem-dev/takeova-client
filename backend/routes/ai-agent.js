const express = require("express");
const { renderEmail, P, H2 } = require("../utils/email-template");
const router = express.Router();
const { v4: uuid } = require("uuid");

function getDb() { return require("../db/init").getDb(); }
function auth(req, res, next) { const m = require("../middleware/auth"); m.auth(req, res, next); }
function getSetting(k) { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } }

// ─── Plan-cap guard — wraps mineCheckUsage + auto-tracks on success ───
function _capGuard(req, res, metric) {
  if (typeof global.mineCheckUsage === 'function') {
    try {
      const usage = global.mineCheckUsage(getDb(), req.userId, metric);
      if (usage && usage.blocked) {
        res.status(403).json({
          error: "You've used all your AI for this month. Upgrade to continue.",
          used: usage.used, cap: usage.cap, metric: metric, upgrade: true
        });
        return false;
      }
    } catch(_) {}
  }
  // Auto-track on success response (status < 400)
  const _orig = res.json.bind(res);
  res.json = function(payload) {
    if (res.statusCode < 400 && typeof global.mineTrackUsage === 'function') {
      try { global.mineTrackUsage(getDb(), req.userId, metric); } catch(_) {}
    }
    return _orig(payload);
  };
  return true;
}



function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_agent_insights (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT,
      category TEXT,
      title TEXT,
      description TEXT,
      severity TEXT DEFAULT 'info',
      data_json TEXT DEFAULT '{}',
      action_taken TEXT,
      action_result TEXT,
      dismissed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ai_agent_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      period TEXT,
      summary TEXT,
      metrics_json TEXT,
      insights_json TEXT,
      recommendations_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ai_agent_config (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      auto_actions INTEGER DEFAULT 0,
      daily_digest INTEGER DEFAULT 1,
      weekly_report INTEGER DEFAULT 1,
      monitored TEXT DEFAULT '["revenue","orders","traffic","email","reviews"]',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ═══════════════════════════════════════
// USER-FACING: Get insights & config
// ═══════════════════════════════════════

router.get("/insights", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const insights = db.prepare("SELECT * FROM ai_agent_insights WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT 20").all(req.userId);
  const config = db.prepare("SELECT * FROM ai_agent_config WHERE user_id = ?").get(req.userId) || { enabled: 1, auto_actions: 0, daily_digest: 1, weekly_report: 1 };
  res.json({ insights, config });
});

router.get("/reports", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const reports = db.prepare("SELECT * FROM ai_agent_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(req.userId);
  res.json({ reports: reports.map(r => ({ ...r, metrics: JSON.parse(r.metrics_json || "{}"), insights: JSON.parse(r.insights_json || "[]"), recommendations: JSON.parse(r.recommendations_json || "[]") })) });
});

router.get("/config", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const config = db.prepare("SELECT * FROM ai_agent_config WHERE user_id = ?").get(req.userId);
  if (!config) return res.json({ enabled: true, auto_actions: false, daily_digest: true, weekly_report: true, monitored: [] });
  res.json({ ...config, monitored: JSON.parse(config.monitored || "[]") });
});

router.put("/config", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { enabled, auto_actions, daily_digest, weekly_report, monitored } = req.body;
  db.prepare("INSERT OR REPLACE INTO ai_agent_config (user_id, enabled, auto_actions, daily_digest, weekly_report, monitored) VALUES (?,?,?,?,?,?)").run(req.userId, enabled ? 1 : 0, auto_actions ? 1 : 0, daily_digest ? 1 : 0, weekly_report ? 1 : 0, JSON.stringify(monitored || []));
  res.json({ success: true });
});

router.post("/insights/:id/dismiss", auth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE ai_agent_insights SET dismissed = 1 WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// ═══════════════════════════════════════
// ANALYSIS ENGINE — Run for a single user
// ═══════════════════════════════════════

router.post("/analyze", auth, async (req, res) => {
  if (!_capGuard(req, res, "intelligenceRefresh")) return;
  const db = getDb();
  ensureTables(db);
  // Rate limit: max 4 manual analyses per user per day (each triggers Perplexity + DB writes)
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const recentCount = db.prepare(
      "SELECT COUNT(*) as c FROM ai_agent_insights WHERE user_id = ? AND created_at > ?"
    ).get(req.userId, todayStart.toISOString())?.c || 0;
    if (recentCount >= 40) { // 40 insights ≈ 4 full analysis runs (each generates ~10 insights)
      return res.status(429).json({ error: "Analysis limit reached for today. Check back tomorrow for fresh insights." });
    }
  } catch(e) { console.error("[/analyze]", e.message || e); }
  try {
    const insights = await runAnalysis(db, req.userId);
    res.json({ success: true, insights });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

async function runAnalysis(db, userId) {
  const insights = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString();
  const sevenDaysAgo = new Date(now - 7 * 86400000).toISOString();

  // ─── Revenue Analysis ───
  try {
    const orders30 = db.prepare("SELECT COUNT(*) as count, SUM(total) as revenue FROM orders WHERE user_id = ? AND created_at > ?").get(userId, thirtyDaysAgo);
    const orders7 = db.prepare("SELECT COUNT(*) as count, SUM(total) as revenue FROM orders WHERE user_id = ? AND created_at > ?").get(userId, sevenDaysAgo);
    const prevWeek = new Date(now - 14 * 86400000).toISOString();
    const ordersPrev7 = db.prepare("SELECT COUNT(*) as count, SUM(total) as revenue FROM orders WHERE user_id = ? AND created_at > ? AND created_at < ?").get(userId, prevWeek, sevenDaysAgo);

    if (orders7.count > 0 && ordersPrev7.count > 0) {
      const growth = ((orders7.revenue - ordersPrev7.revenue) / (ordersPrev7.revenue || 1)) * 100;
      if (growth < -20) {
        insights.push({ type: "revenue_drop", category: "revenue", title: "Revenue dropped " + Math.abs(growth).toFixed(0) + "% this week", description: `Your revenue went from $${(ordersPrev7.revenue||0).toFixed(0)} to $${(orders7.revenue||0).toFixed(0)} this week. Consider running a promotion or sending a re-engagement email.`, severity: "warning", data: { growth, current: orders7.revenue, previous: ordersPrev7.revenue } });
      } else if (growth > 30) {
        insights.push({ type: "revenue_surge", category: "revenue", title: "Revenue up " + growth.toFixed(0) + "% this week!", description: `Great performance — $${(orders7.revenue||0).toFixed(0)} this week vs $${(ordersPrev7.revenue||0).toFixed(0)} last week. Keep doing what you're doing.`, severity: "success", data: { growth } });
      }
    }
    if (orders30.count === 0) {
      insights.push({ type: "no_sales", category: "revenue", title: "No sales in 30 days", description: "You haven't had any orders this month. Consider adding new products, running email campaigns, or sharing on social media.", severity: "critical", data: {} });
    }
  } catch (e) {}

  // ─── Traffic Analysis ───
  try {
    const views7 = db.prepare("SELECT COUNT(*) as c FROM site_analytics WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND created_at > ?").get(userId, sevenDaysAgo)?.c || 0;
    const viewsPrev7 = db.prepare("SELECT COUNT(*) as c FROM site_analytics WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND created_at > ? AND created_at < ?").get(userId, prevWeek, sevenDaysAgo)?.c || 0;
    if (views7 > 0 && viewsPrev7 > 0) {
      const tGrowth = ((views7 - viewsPrev7) / (viewsPrev7 || 1)) * 100;
      if (tGrowth < -30) {
        insights.push({ type: "traffic_drop", category: "traffic", title: "Traffic dropped " + Math.abs(tGrowth).toFixed(0) + "%", description: `Site visits went from ${viewsPrev7} to ${views7}. Check if your site is loading properly and consider posting fresh content.`, severity: "warning", data: { views7, viewsPrev7 } });
      }
    }
    if (views7 === 0) {
      insights.push({ type: "no_traffic", category: "traffic", title: "No site visits this week", description: "Your site hasn't received any traffic. Share your link on social media, send an email to your contacts, or set up SEO.", severity: "warning", data: {} });
    }
  } catch (e) {}

  // ─── Email Performance ───
  try {
    const emailsSent = db.prepare("SELECT COUNT(*) as c FROM email_log WHERE user_id = ? AND created_at > ?").get(userId, sevenDaysAgo)?.c || 0;
    const emailsOpened = db.prepare("SELECT COUNT(*) as c FROM email_log WHERE user_id = ? AND created_at > ? AND opened = 1").get(userId, sevenDaysAgo)?.c || 0;
    if (emailsSent > 10) {
      const openRate = (emailsOpened / emailsSent) * 100;
      if (openRate < 15) {
        insights.push({ type: "low_open_rate", category: "email", title: "Email open rate is low (" + openRate.toFixed(0) + "%)", description: "Try more compelling subject lines, send at different times, or segment your audience for more relevant content.", severity: "warning", data: { emailsSent, emailsOpened, openRate } });
      }
    }
  } catch (e) {}

  // ─── Review Monitoring ───
  try {
    const recentReviews = db.prepare("SELECT * FROM product_reviews WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND created_at > ? ORDER BY created_at DESC").all(userId, sevenDaysAgo);
    const negative = recentReviews.filter(r => r.rating <= 2);
    if (negative.length > 0) {
      insights.push({ type: "negative_reviews", category: "reviews", title: negative.length + " negative review" + (negative.length > 1 ? "s" : "") + " this week", description: `${negative.map(r => r.name + " gave " + r.rating + " stars").join(", ")}. Respond quickly to turn these around.`, severity: "warning", data: { reviews: negative.map(r => ({ name: r.name, rating: r.rating, title: r.title })) } });
    }
    const avgRating = recentReviews.length > 0 ? recentReviews.reduce((a, r) => a + r.rating, 0) / recentReviews.length : 0;
    if (avgRating >= 4.5 && recentReviews.length >= 3) {
      insights.push({ type: "great_reviews", category: "reviews", title: "Excellent reviews (" + avgRating.toFixed(1) + " avg)", description: "Customers love what you're doing! Consider asking happy customers for referrals.", severity: "success", data: { avgRating, count: recentReviews.length } });
    }
  } catch (e) {}

  // ─── Abandoned Opportunities ───
  try {
    const unseenMessages = db.prepare("SELECT COUNT(*) as c FROM chat_messages WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND sender = 'visitor' AND read = 0").get(userId)?.c || 0;
    if (unseenMessages > 5) {
      insights.push({ type: "unread_messages", category: "engagement", title: unseenMessages + " unread customer messages", description: "You have unanswered messages from potential customers. Quick response times dramatically improve conversion rates.", severity: "critical", data: { count: unseenMessages } });
    }
  } catch (e) {}

  // ─── Product Performance ───
  try {
    const products = db.prepare("SELECT p.name, p.price, COALESCE(o.sold,0) as sold FROM products p LEFT JOIN (SELECT json_extract(value,'$.name') as name, COUNT(*) as sold FROM orders, json_each(orders.items) WHERE orders.user_id = ? AND orders.created_at > ? GROUP BY json_extract(value,'$.name')) o ON p.name = o.name WHERE p.site_id IN (SELECT id FROM sites WHERE user_id = ?) AND p.status = 'active' ORDER BY sold ASC LIMIT 5").all(userId, thirtyDaysAgo, userId);
    const zeroSales = products.filter(p => p.sold === 0);
    if (zeroSales.length > 0 && products.length > 2) {
      insights.push({ type: "stale_products", category: "products", title: zeroSales.length + " product" + (zeroSales.length > 1 ? "s" : "") + " with no sales", description: `${zeroSales.map(p => p.name).join(", ")} haven't sold in 30 days. Consider updating pricing, descriptions, or featuring them in an email campaign.`, severity: "info", data: { products: zeroSales } });
    }
  } catch (e) {}

  // ─── Booking Utilization ───
  try {
    const bookings7 = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE user_id = ? AND created_at > ?").get(userId, sevenDaysAgo)?.c || 0;
    const bookingsPrev7 = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE user_id = ? AND created_at > ? AND created_at < ?").get(userId, prevWeek, sevenDaysAgo)?.c || 0;
    if (bookings7 === 0 && bookingsPrev7 > 0) {
      insights.push({ type: "no_bookings", category: "bookings", title: "No bookings this week", description: "You had " + bookingsPrev7 + " bookings last week but none this week. Send a reminder email or offer a limited-time discount.", severity: "warning", data: { bookings7, bookingsPrev7 } });
    }
  } catch (e) {}

  // ─── Industry Benchmark Context (Perplexity) ───
  let benchmarks = null;
  try {
    const site = db.prepare('SELECT name, template FROM sites WHERE user_id = ? LIMIT 1').get(userId);
    if (site) {
      const { doResearch } = require('./ai-employees');
      const research = await doResearch(
        `Current industry benchmarks for a ${site.template || 'small business'} called "${site.name}": email open rate average, e-commerce conversion rate, average order value, customer acquisition cost, and any notable market trends or seasonal factors affecting this industry RIGHT NOW in ${new Date().toLocaleString('default',{month:'long',year:'numeric'})}. Be specific with numbers.`,
        getSetting
      );
      if (research.text) {
        benchmarks = research.text;
        insights.push({
          type: 'market_context',
          category: 'market',
          title: '📊 Industry context for ' + new Date().toLocaleString('default', { month: 'long' }),
          description: research.text.substring(0, 400) + (research.text.length > 400 ? '...' : ''),
          severity: 'info',
          data: { full: research.text, source: research.source, citations: research.citations }
        });
      }
    }
  } catch(e) { /* non-fatal — continue without benchmarks */ }

  // Save insights to DB
  for (const ins of insights) {
    db.prepare("INSERT INTO ai_agent_insights (id, user_id, type, category, title, description, severity, data_json) VALUES (?,?,?,?,?,?,?,?)")
      .run(uuid(), userId, ins.type, ins.category, ins.title, ins.description, ins.severity, JSON.stringify(ins.data || {}));
  }

  // ── Bridge (2026-06-11): file each insight's one-tap action into the Autopilot approval queue ──
  try {
    const _apdb = _apDb();
    const TYPEMAP = { chase_invoices: "chase_invoices", invoices: "chase_invoices", invoice: "chase_invoices", discount: "create_discount", create_discount: "create_discount", promo: "create_discount" };
    for (const ins of insights) {
      if (!ins || !ins.title) continue;
      const key = String(ins.type || ins.category || "").toLowerCase();
      const at = TYPEMAP[key] || "note";
      const ainput = at === "chase_invoices" ? { confirm: true } : (at === "create_discount" ? { percent_off: 15 } : {});
      const title = String(ins.title).slice(0, 90);
      const dup = _apdb.prepare("SELECT 1 FROM autopilot_actions WHERE user_id=? AND status='pending' AND title=?").get(userId, title);
      if (dup) continue;
      _apdb.prepare("INSERT INTO autopilot_actions (id,user_id,type,input_json,title,reason) VALUES (?,?,?,?,?,?)")
        .run(uuid(), userId, at, JSON.stringify(ainput), title, ("\ud83d\udcca Intelligence: " + String(ins.description || "").slice(0, 180)));
    }
  } catch (_e) { /* queue bridge is best-effort */ }

  return insights;
}

// ═══════════════════════════════════════
// WEEKLY REPORT GENERATOR
// ═══════════════════════════════════════

router.post("/generate-report", auth, async (req, res) => {
  if (!_capGuard(req, res, "monthlyNarrative")) return;
  const db = getDb();
  ensureTables(db);
  try {
    const report = await generateReport(db, req.userId);
    res.json({ success: true, report });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

async function generateReport(db, userId, precomputedInsights = null) {
  const now = new Date();
  const sevenDaysAgo = new Date(now - 7 * 86400000).toISOString();
  const prevWeek = new Date(now - 14 * 86400000).toISOString();

  const metrics = {};

  try { metrics.orders = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM orders WHERE user_id = ? AND created_at > ?").get(userId, sevenDaysAgo); } catch (e) { metrics.orders = { count: 0, revenue: 0 }; }
  try { metrics.ordersPrev = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM orders WHERE user_id = ? AND created_at > ? AND created_at < ?").get(userId, prevWeek, sevenDaysAgo); } catch (e) { metrics.ordersPrev = { count: 0, revenue: 0 }; }
  try { metrics.views = db.prepare("SELECT COUNT(*) as c FROM site_analytics WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND created_at > ?").get(userId, sevenDaysAgo)?.c || 0; } catch (e) { metrics.views = 0; }
  try { metrics.newContacts = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND created_at > ?").get(userId, sevenDaysAgo)?.c || 0; } catch (e) { metrics.newContacts = 0; }
  try { metrics.bookings = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE user_id = ? AND created_at > ?").get(userId, sevenDaysAgo)?.c || 0; } catch (e) { metrics.bookings = 0; }
  try { metrics.emailsSent = db.prepare("SELECT COUNT(*) as c FROM email_log WHERE user_id = ? AND created_at > ?").get(userId, sevenDaysAgo)?.c || 0; } catch (e) { metrics.emailsSent = 0; }
  try { metrics.reviews = db.prepare("SELECT COUNT(*) as c, COALESCE(AVG(rating),0) as avg FROM product_reviews WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND created_at > ?").get(userId, sevenDaysAgo); } catch (e) { metrics.reviews = { c: 0, avg: 0 }; }

  const revenueGrowth = metrics.ordersPrev?.revenue ? ((metrics.orders.revenue - metrics.ordersPrev.revenue) / metrics.ordersPrev.revenue * 100) : 0;

  // ── Perplexity: market context for this week ──
  let marketContext = "";
  try {
    const site = db.prepare("SELECT name, template FROM sites WHERE user_id = ? LIMIT 1").get(userId);
    if (site) {
      const { doResearch } = require("./ai-employees");
      const research = await doResearch(
        `What is happening in the ${site.template || "small business"} industry this week (${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})})? Include: any seasonal trends affecting consumer spending, relevant platform algorithm changes (Meta, Google, TikTok), economic factors impacting small businesses, and specific opportunities or threats for businesses like "${site.name}". Be concise and actionable.`,
        getSetting
      );
      if (research.text) marketContext = "\n\nMARKET CONTEXT THIS WEEK:\n" + research.text.substring(0, 1500);
    }
  } catch(e) { /* non-fatal */ }

  // Generate AI summary if available
  let summary = `This week: $${(metrics.orders?.revenue||0).toFixed(0)} revenue from ${metrics.orders?.count||0} orders. ${metrics.views||0} site visits, ${metrics.newContacts||0} new contacts, ${metrics.bookings||0} bookings.`;
  const claudeKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (claudeKey) {
    try {
      const fetch = (await import("node-fetch")).default;
      const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": claudeKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 500,
          messages: [{ role: "user", content: `You are a business analyst. Generate a concise 4-5 sentence weekly summary for a business owner. Be specific about numbers, trends, and market context. Metrics: Revenue: $${(metrics.orders?.revenue||0).toFixed(0)} (${revenueGrowth > 0 ? "+" : ""}${revenueGrowth.toFixed(0)}% vs last week), Orders: ${metrics.orders?.count||0}, Site visits: ${metrics.views||0}, New contacts: ${metrics.newContacts||0}, Bookings: ${metrics.bookings||0}, Emails sent: ${metrics.emailsSent||0}, Reviews: ${metrics.reviews?.c||0} (avg ${(metrics.reviews?.avg||0).toFixed(1)} stars). Focus on what's going well, what needs attention, and reference any relevant market context below.${marketContext}` }]
        })
      });
      const aiData = await aiResp.json();
      if (aiData.content?.[0]?.text) summary = aiData.content[0].text;
    } catch(e) { console.error("[/generate-report]", e.message || e); }
  }

  // Use pre-computed insights if provided (avoids double DB insertion when called from weekly cron)
  const insights = precomputedInsights || await runAnalysis(db, userId);
  const recommendations = insights.filter(i => i.severity !== "success").map(i => i.description).slice(0, 5);

  const reportId = uuid();
  db.prepare("INSERT INTO ai_agent_reports (id, user_id, period, summary, metrics_json, insights_json, recommendations_json) VALUES (?,?,?,?,?,?,?)")
    .run(reportId, userId, "weekly", summary, JSON.stringify(metrics), JSON.stringify(insights), JSON.stringify(recommendations));

  return { id: reportId, period: "weekly", summary, metrics, insights, recommendations };
}

// ═══════════════════════════════════════
// CRON — Run daily analysis for all users (hit via cron job)
// ═══════════════════════════════════════

router.post("/cron/daily", async (req, res) => {
  const internalKey = req.headers["x-internal-key"];
  if (!((_k, _s) => _k.length > 0 && _s.length === _k.length && require("crypto").timingSafeEqual(Buffer.from(_s), Buffer.from(_k)))(process.env.INTERNAL_API_KEY || "", internalKey || "")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const db = getDb();
  ensureTables(db);

  // Idempotency: skip if already ran today (guards against double-fire on server restart)
  try { db.exec("CREATE TABLE IF NOT EXISTS cron_log (id TEXT PRIMARY KEY, job TEXT, ran_at TEXT)"); } catch(e) {}
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const alreadyRan = db.prepare("SELECT id FROM cron_log WHERE job = 'daily' AND ran_at = ?").get(today);
  if (alreadyRan) {
    console.log("[Cron] daily already ran today, skipping");
    return res.json({ skipped: true, reason: "already_ran_today", date: today });
  }
  db.prepare("INSERT INTO cron_log (id, job, ran_at) VALUES (?,?,?)").run(require("crypto").randomUUID(), "daily", today);

  const users = db.prepare("SELECT u.id FROM users u LEFT JOIN ai_agent_config c ON u.id = c.user_id WHERE u.role = 'user' AND (c.enabled IS NULL OR c.enabled = 1)").all();
  let analyzed = 0, failed = 0;

  for (const user of users) {
    try {
      await runAnalysis(db, user.id);
      analyzed++;
      await new Promise(r => setTimeout(r, 100)); // Stagger Perplexity calls across users
    } catch (e) { failed++; }
  }

  res.json({ success: true, analyzed, failed, total: users.length });
});

router.post("/cron/weekly-reports", async (req, res) => {
  const internalKey = req.headers["x-internal-key"];
  if (!((_k, _s) => _k.length > 0 && _s.length === _k.length && require("crypto").timingSafeEqual(Buffer.from(_s), Buffer.from(_k)))(process.env.INTERNAL_API_KEY || "", internalKey || "")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const db = getDb();
  ensureTables(db);

  const users = db.prepare("SELECT u.id, u.email, u.name FROM users u LEFT JOIN ai_agent_config c ON u.id = c.user_id WHERE u.role = 'user' AND (c.weekly_report IS NULL OR c.weekly_report = 1)").all();
  let generated = 0;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (const user of users) {
    try {
      // Check competitorReports cap — skip report generation if blocked (Starter plan: 0)
      const userPlan = db.prepare("SELECT plan FROM users WHERE id = ?").get(user.id);
      const planName = userPlan?.plan || "starter";
      if (typeof global !== "undefined" && global.mineCheckUsage) {
        const check = global.mineCheckUsage(db, user.id, "competitorReports");
        if (check.blocked) continue; // skip this user — plan doesn't include weekly reports
      }

      // Run analysis once and pass to report — avoids duplicate insight insertion
      const insights = await runAnalysis(db, user.id);
      const report = await generateReport(db, user.id, insights);

      // Track usage
      if (typeof global !== "undefined" && global.mineTrackUsage) {
        global.mineTrackUsage(db, user.id, "competitorReports");
      }
      // Send email digest
      const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
      if (sgKey && user.email) {
        const fetch = (await import("node-fetch")).default;
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: user.email, name: user.name }] }],
            from: { email: `ai-agent@${process.env.MAIN_HOST||"takeova.ai"}`, name: "TAKEOVA AI Agent" },
            subject: "Your Weekly Business Report — TAKEOVA",
            content: [{ type: "text/html", value: renderEmail({
              preheader: "Your weekly business report from MINE",
              heading: `Hey ${user.name}!`,
              bodyHtml: `<p style="${P}">${report.summary}</p>` + (report.recommendations.length > 0 ? `<h2 style="${H2}">Recommendations</h2><ul style="margin:0 0 14px;padding-left:20px;color:#334155;font-size:15px;line-height:1.8;font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` + report.recommendations.map(r => '<li>' + r + '</li>').join('') + '</ul>' : ''),
              cta: { text: "View full report", url: "https://takeova.ai/dashboard" },
            }) }]
          })
        })
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
      generated++;
      await sleep(150); // Stagger API calls — prevents thundering herd on Perplexity + Anthropic
    } catch (e) {}
  }

  res.json({ success: true, generated, total: users.length });
});

// ═══════════════════════════════════════
// AUTO-ACTIONS — AI takes action automatically
// ═══════════════════════════════════════

router.post("/auto-act", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const config = db.prepare("SELECT * FROM ai_agent_config WHERE user_id = ?").get(req.userId);
  if (!config?.auto_actions) return res.json({ actions: [], message: "Auto-actions disabled" });

  const actions = [];
  const insights = db.prepare("SELECT * FROM ai_agent_insights WHERE user_id = ? AND dismissed = 0 AND action_taken IS NULL ORDER BY created_at DESC LIMIT 10").all(req.userId);

  for (const ins of insights) {
    try {
      switch (ins.type) {
        case "no_sales":
        case "revenue_drop": {
          // Auto-trigger re-engagement email if email templates exist
          const template = db.prepare("SELECT * FROM email_templates_user WHERE user_id = ? AND trigger_event = 'follow_up' LIMIT 1").get(req.userId);
          if (template) {
            actions.push({ insight_id: ins.id, action: "queued_reengagement_email", description: "Queued re-engagement email to inactive customers" });
            db.prepare("UPDATE ai_agent_insights SET action_taken = ?, action_result = ? WHERE id = ?").run("queued_email", "Re-engagement email queued", ins.id);
          }
          break;
        }
        case "negative_reviews": {
          actions.push({ insight_id: ins.id, action: "flagged_for_response", description: "Flagged negative reviews for your response" });
          db.prepare("UPDATE ai_agent_insights SET action_taken = ?, action_result = ? WHERE id = ?").run("flagged", "Reviews flagged for response", ins.id);
          break;
        }
        case "unread_messages": {
          actions.push({ insight_id: ins.id, action: "notification_sent", description: "Sent you a notification about unread messages" });
          db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)").run(uuid(), req.userId, "💬", ins.title, "Just now");
          db.prepare("UPDATE ai_agent_insights SET action_taken = ?, action_result = ? WHERE id = ?").run("notified", "Notification sent", ins.id);
          break;
        }
      }
    } catch(e) { console.error("[/auto-act]", e.message || e); }
  }

  res.json({ success: true, actions });
});


// ── Frontend AI proxy ──────────────────────────────────────────────────────
// Proxies callAI() requests from the React frontend so the Anthropic API key
// is never exposed in the client bundle.
router.post("/chat", auth, async (req, res) => {
  const Anthropic = require("@anthropic-ai/sdk");
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured" });

  const { content } = req.body;
  if (!content || !Array.isArray(content)) {
    return res.status(400).json({ error: "content array required" });
  }
  // Enforce max messages and content length to prevent abuse
  if (content.length > 50) return res.status(400).json({ error: "Too many messages" });
  // Validate roles to prevent prompt injection via messages array
  const ALLOWED_ROLES = new Set(["user", "assistant"]);
  const sanitizedContent = content.map(m => {
    if (typeof m === "string") return { role: "user", content: m };
    if (!ALLOWED_ROLES.has(m?.role)) return { role: "user", content: String(m?.content || m?.text || "") };
    return { role: m.role, content: String(m?.content || m?.text || "") };
  });
  // Enforce total character limit to prevent token abuse (~40k chars ≈ 10k tokens)
  const totalChars = sanitizedContent.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > 40000) return res.status(400).json({ error: "Message content too large" });

  // system prompt is server-controlled only — client cannot override it
  const db = getDb();
  const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(req.userId);
  const systemPrompt = `You are TAKEOVA AI, a helpful business assistant for ${user?.name || "a TAKEOVA user"}. Help with business tasks, analytics, marketing, and operational questions. Be concise and practical.`;

  // Enforce per-user rate limit: 30 AI chat calls per minute stored in-memory.
  const now = Date.now();
  router._chatLimiter = router._chatLimiter || new Map();
  const uid = req.user.id;
  const bucket = router._chatLimiter.get(uid) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60000; }
  bucket.count++;
  router._chatLimiter.set(uid, bucket);
  if (bucket.count > 30) return res.status(429).json({ error: "Too many AI requests — please wait a moment" });

  // Enforce monthly mentorChats plan cap
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, req.userId, "mentorChats");
    if (usage.blocked) {
      return res.status(403).json({
        error: "You've used all your Mentor chats for this month.",
        used: usage.used,
        cap: usage.cap,
        upgrade: true
      });
    }
  }

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: systemPrompt,
      messages: sanitizedContent,
    });

    // Track usage only on successful AI response
    if (typeof global !== "undefined" && global.mineTrackUsage) {
      global.mineTrackUsage(db, req.userId, "mentorChats");
    }

    res.json({ text: msg.content?.[0]?.text || "" });
  } catch (e) {
    console.error("AI chat error:", e.message);
    res.status(502).json({ error: "AI request failed" });
  }
})

// ─── SITE BUILDER — dedicated endpoint that uses the full system prompt ─────
// This is separate from /chat because:
//   1. System prompt comes from the client (trusted — this is for building, not chatting)
//   2. Higher token limit (8000) for complete HTML output
//   3. Uses claude-sonnet-4-6 optimised for long-form generation
// Surgical single-section editor — rewrites ONLY the selected section via Claude.
// Frontend contract: body { siteId, sectionSelector, sectionLabel, prompt };
// returns { html } (full updated page) or { use_full_rebuild: true } to fall back.
router.post("/edit-section", auth, async (req, res) => {
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured" });

  const { siteId, sectionSelector, sectionLabel, prompt } = req.body || {};
  if (!siteId || !prompt || String(prompt).trim().length < 3) {
    return res.status(400).json({ error: "siteId and prompt required" });
  }

  const db = getDb();
  const site = db.prepare("SELECT id, html FROM sites WHERE id = ? AND user_id = ?").get(siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  if (!site.html || site.html.length < 30) return res.json({ use_full_rebuild: true }); // nothing to edit yet

  // Locate the target section in the stored page HTML.
  let dom, el, sectionHtml;
  try {
    const { JSDOM } = require("jsdom");
    dom = new JSDOM(site.html);
    const doc = dom.window.document;
    if (sectionSelector) { try { el = doc.querySelector(sectionSelector); } catch (_) {} }
    if (!el && sectionLabel) {
      const id = String(sectionLabel).toLowerCase().replace(/\s+/g, "-");
      el = doc.getElementById(id);
    }
    if (!el || !el.parentNode) return res.json({ use_full_rebuild: true }); // can't isolate → let full rebuild handle
    sectionHtml = el.outerHTML;
  } catch (e) {
    return res.json({ use_full_rebuild: true });
  }

  // Too large to edit surgically (and risks token limits) → full rebuild.
  if (sectionHtml.length > 38000) return res.json({ use_full_rebuild: true });

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const sys = "You are a surgical website section editor for the TAKEOVA site builder. You are given ONE HTML section and an instruction. Rewrite ONLY that section to satisfy the instruction. Preserve the same outer element tag and its id and any data- attributes, keep the existing Tailwind / utility class conventions and the brand styling, and do not add <html>, <head>, <body>, <script>, or markdown fences. Return ONLY the raw HTML for that single section and nothing else.";
    const userMsg = "INSTRUCTION:\n" + String(prompt).slice(0, 2000) + "\n\nSECTION HTML:\n" + sectionHtml;
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: sys,
      messages: [{ role: "user", content: userMsg }],
    });
    let out = ((msg.content && msg.content[0] && msg.content[0].text) || "").trim();
    out = out.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
    if (!out || out.length < 10 || !/[<]/.test(out)) return res.json({ use_full_rebuild: true });

    el.outerHTML = out;                     // splice the rewritten section back in
    const updated = dom.serialize();
    db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(updated, siteId, req.userId);
    return res.json({ html: updated, section: sectionLabel || null });
  } catch (e) {
    console.error("[ai-agent/edit-section]", e && e.message);
    return res.status(502).json({ error: "AI unavailable", use_full_rebuild: true });
  }
});

router.post("/build", auth, async (req, res) => {
  const Anthropic = require("@anthropic-ai/sdk");
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured" });

  const { system, content, model } = req.body;

  // Validate — system must start with our builder signature to prevent abuse
  if (!system || !system.startsWith("Expert web")) {
    return res.status(400).json({ error: "Invalid build request" });
  }

  // ── Override system prompt with world-class generation instructions ──
  const MINE_SYSTEM = `You are TAKEOVA AI — the world's best AI website builder for small business owners.
You generate complete, production-ready websites that look like they cost $10,000 to build.
Business owners should feel PROUD to share their site on day one. Every pixel matters.

STACK — NON-NEGOTIABLE
Always include these in <head> in this exact order:
1. <meta charset="UTF-8">
2. <meta name="viewport" content="width=device-width, initial-scale=1.0">
3. Google Fonts link (pick ONE font family appropriate to brand personality)
4. <script src="https://cdn.tailwindcss.com"></script>
5. Tailwind config with brand colors derived from business type
6. <script defer src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js"></script>

Note on the cdn.tailwindcss.com console warning: this shows "should not
be used in production" in browser dev tools. It is cosmetic-only and does
not affect site visitors (they never open dev tools). Ignore it. Using
the v4 browser CDN would require a COMPLETELY different config syntax
(@theme CSS directive, not tailwind.config = {}), so stick with this.

Tailwind config pattern (always extend, never override defaults):
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: { brand: '#HEX', 'brand-dark': '#DARKER', accent: '#HEX' },
        fontFamily: { display: ["'Font Name'", 'serif'], body: ["'Font Name'", 'sans-serif'] }
      }
    }
  }
<\/script>

LAYOUT — EVERY SECTION IS REQUIRED

1. NAV (sticky with backdrop blur):
   sticky top-0 z-50 bg-white/95 backdrop-blur-lg border-b border-gray-100

   IMPORTANT: Do NOT use Alpine.js for the mobile menu — it has race-condition
   bugs when the CDN loads after the user taps. Use the plain-JS pattern below.
   Alpine IS fine for FAQ accordions and other deferred-interaction components.

   Nav structure (logo left, desktop links + CTA right, mobile hamburger):
   <nav id="main-nav" class="sticky top-0 z-50 bg-white/95 backdrop-blur-lg border-b border-gray-100">
     <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
       <div class="flex items-center justify-between h-20">
         <a href="#top" class="font-display text-2xl font-bold text-brand">LOGO</a>
         <div class="hidden md:flex items-center gap-10">
           <a href="#..." class="text-sm font-medium">Link</a>
           ... more links ...
           <a href="#book" class="bg-brand text-white px-6 py-2.5 rounded-full text-sm font-semibold">CTA</a>
         </div>
         <button id="nav-toggle" type="button" class="md:hidden text-brand p-2 -mr-2"
                 aria-label="Toggle menu" aria-expanded="false">
           <svg id="nav-icon-open" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
           </svg>
           <svg id="nav-icon-close" class="w-6 h-6 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
           </svg>
         </button>
       </div>
       <!-- Mobile menu: STARTS hidden. MUST have solid inline background color. -->
       <div id="mobile-menu" class="hidden md:hidden absolute top-full left-0 right-0 shadow-xl border-t border-gray-100"
            style="background-color: #ffffff;">
         <div class="px-4 sm:px-6 py-4 space-y-1">
           <a href="#..." data-nav-link class="block py-3 font-medium">Link</a>
           ... all nav links with data-nav-link attribute ...
           <a href="#book" data-nav-link class="block mt-3 bg-brand text-white text-center px-6 py-3 rounded-full font-semibold">CTA</a>
         </div>
       </div>
     </div>
   </nav>

   CRITICAL rules for the mobile menu div:
   - MUST have inline style="background-color: #HEXVALUE" (not just a Tailwind class).
     This prevents the hero bleeding through if Tailwind config hasn't loaded yet.
   - MUST start with "hidden" class so it doesn't show before JS initializes.
   - MUST use "absolute top-full left-0 right-0" positioning so it overlays
     instead of pushing the hero off-screen.
   - Each nav link MUST have "data-nav-link" attribute so the script can close
     the menu when a link is tapped.

   Plain-JS menu script (paste this AFTER the </nav> tag exactly):
   <script>
   (function() {
     var btn = document.getElementById('nav-toggle');
     var menu = document.getElementById('mobile-menu');
     var iconOpen = document.getElementById('nav-icon-open');
     var iconClose = document.getElementById('nav-icon-close');
     if (!btn || !menu) return;
     function setOpen(open) {
       menu.classList.toggle('hidden', !open);
       iconOpen.classList.toggle('hidden', open);
       iconClose.classList.toggle('hidden', !open);
       btn.setAttribute('aria-expanded', String(open));
     }
     btn.addEventListener('click', function(e) {
       e.stopPropagation();
       setOpen(menu.classList.contains('hidden'));
     });
     menu.querySelectorAll('[data-nav-link]').forEach(function(link) {
       link.addEventListener('click', function() { setOpen(false); });
     });
     document.addEventListener('click', function(e) {
       var nav = document.getElementById('main-nav');
       if (nav && !nav.contains(e.target)) setOpen(false);
     });
     document.addEventListener('keydown', function(e) {
       if (e.key === 'Escape') setOpen(false);
     });
   })();
   <\/script>

2. HERO (full viewport, emotionally compelling):
   Background: full-bleed image with dark overlay OR gradient mesh — never flat color
   H1: Specific, benefit-driven, location-aware. 
     GOOD: "Sydney's Favourite Yoga Studio — Feel Stronger in 30 Days"
     BAD: "Welcome to Our Website"
   Subheadline: 1-2 sentences expanding the promise
   TWO CTAs: primary (solid brand, book/buy) + secondary (ghost/outline, learn more)
   Social proof under CTAs: star rating + number of clients served

3. TRUST BAR (full-width subtle bg, 4-5 stats):
   Icon + big number + label. Horizontal on desktop, 2-col on mobile.
   Examples: "12 Years Experience" "2,400+ Happy Clients" "★ 4.9/5 Rating" "100% Satisfaction"

4. SERVICES / FEATURES (3-6 cards):
   Grid: grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8
   Each card: inline SVG icon (brand-colored bg circle), title, 2-3 sentence description, price or CTA
   Card: bg-white rounded-2xl shadow-md hover:shadow-xl transition-all duration-300 hover:-translate-y-1 p-6 md:p-8

5. SOCIAL PROOF (3 testimonials — specific, believable):
   Each: 3-4 sentence review with specific result, person name + suburb + role, 5 stars
   Avatar: https://ui-avatars.com/api/?name=First+Last&background=e2e8f0&color=374151&size=64
   Layout: card grid md:grid-cols-3

6. PORTFOLIO / GALLERY (visual businesses — salon, restaurant, gym, trades, photography):
   6 Unsplash images in a responsive grid, hover overlay with caption

7. ABOUT (personal connection, owner story):
   Professional Unsplash portrait, name, bio, why they started, local credentials
   Warm, personal tone — not corporate

8. PRICING (3 tiers, always include):
   Names specific to business (e.g. "Single Class / Monthly / Unlimited" for yoga)
   Middle tier: ring-2 ring-brand scale-105 "Most Popular" badge
   Features list with checkmarks, CTA button on each

9. FAQ accordion (5-7 questions, business-specific):
   Alpine x-data="{active:null}" pattern, smooth x-transition

10. FINAL CTA:
    Full-width, brand gradient bg, compelling headline + single strong CTA
    Include urgency or social proof

11. FOOTER (dark bg-gray-900):
    Logo + tagline, nav links, social SVG icons, contact info, copyright

VISUAL DESIGN

COLOR STRATEGY by business type:
- Yoga/Wellness: sage green #6B8F6E + warm cream #FAF7F2
- Restaurant/Cafe: terracotta #C4622D + warm white #FFFDF8
- Salon/Beauty: dusty rose #C9737A + champagne #F5EDE8
- Gym/Fitness: electric blue #1D4ED8 + charcoal #111827
- Trades/Home: forest green #166534 + slate #475569
- Professional/Legal: navy #1E3A5F + warm gray #F9FAFB
- Tech/Digital: violet #7C3AED + deep navy #0F172A
- Retail/Shop: coral #F97316 + off-white #FAFAFA
- Childcare/Education: yellow #EAB308 + sky #0EA5E9
- Medical/Health: trust-blue #0369A1 + clean white #F8FAFC

TYPOGRAPHY PAIRINGS (load via Google Fonts):
- Luxury: Playfair Display (headings) + Lato (body)
- Modern: Space Grotesk (headings) + Inter (body)
- Friendly: Nunito (headings) + Open Sans (body)
- Professional: Merriweather (headings) + Source Sans Pro (body)
- Creative: DM Serif Display (headings) + DM Sans (body)

SPACING:
- Section padding: py-16 md:py-24
- Card padding: p-6 md:p-8
- Container: max-w-7xl mx-auto px-4 sm:px-6 lg:px-8
- Hero: min-h-screen flex items-center

ANIMATIONS:
- ALL hover elements: transition-all duration-300
- Cards: hover:-translate-y-1 hover:shadow-xl
- Buttons: hover:scale-105 active:scale-95
- Images in containers: hover:scale-105 (with overflow-hidden parent)

ICONS — inline SVG only, 24x24 viewBox, Heroicons stroke style:
- Size in cards: w-12 h-12 inside a rounded-full bg-brand/10 p-3 circle
- Common paths available for: calendar, star, check, arrow-right, phone, mail, map-pin, users, clock, award, shield, heart, sparkles, trophy

UNSPLASH IMAGES THAT WORK:
Yoga: photo-1599901860904-17e6ed7083a0, photo-1506126613408-eca07ce68773
Restaurant: photo-1517248135467-4c7edcad34c4, photo-1414235077428-338989a2e8c0
Salon: photo-1560066984-138dadb4c035, photo-1522337360788-8b13dee7a37e
Gym: photo-1534438327276-14e5300c3a48, photo-1571019613454-1cb2f99b2d8b
Trades: photo-1504307651254-35680f356dfd, photo-1581578731548-c64695cc6952
Cafe: photo-1495474472287-4d71bcdd2085, photo-1509042239860-f550ce710b93
Portrait: photo-1494790108755-2616b612b47c, photo-1472099645785-5658abf4ff4e
Format: https://images.unsplash.com/photo-[ID]?w=800&auto=format&fit=crop&q=80

MINE PAYMENT WIRING — EVERY INTERACTIVE ELEMENT MUST HAVE:

Products: <button data-mine-product="Name" data-mine-price="49.00" data-mine-type="physical">Add to Cart</button>

Bookings:
<form data-mine-booking>
  <input name="name" placeholder="Your name" required>
  <input name="email" type="email" placeholder="Email" required>
  <input name="phone" placeholder="Phone">
  <select name="service"><option>60-min Session — $120</option></select>
  <input name="date" type="date" required>
  <button data-mine-book type="submit">Book Now</button>
</form>

Courses: <button data-mine-course="id" data-mine-course-name="Name" data-mine-price="197">Enrol Now — $197</button>
Contact: <form data-mine-form>...<button type="submit">Send Message</button></form>
Cart: <button data-mine-open-cart>View Cart</button>

COPYWRITING RULES:
- Use business name everywhere: nav, hero, about, footer
- Use location: "Sydney's", "Brisbane's best", "Serving Melbourne since 2015"
- Testimonials with specific results: "I lost 8kg in 3 months" not "Great service!"
- Price everything — no "Call for quote" unless truly necessary
- Second person: "You'll feel the difference after your first session"
- Power words: Trusted, Award-winning, Local, Expert, Guaranteed, Proven

MOBILE FIRST:
- All CTAs: min-h-[44px] — thumb-reachable
- Grid always starts 1 col: grid-cols-1 md:grid-cols-2 lg:grid-cols-3
- H1 minimum text-3xl on mobile, up to text-6xl on desktop
- Images: explicit aspect ratios (aspect-video, aspect-square) with object-cover
- No horizontal scroll: overflow-x-hidden on body, max-w-full on images

CSS SAFETY NET — include in the <head>:
<style>
  /* MINE default: rounded images unless overridden */
  img:not([class*="rounded"]):not([style*="border-radius"]) {
    border-radius: 16px;
  }
  /* Icons (small square images) keep sharp */
  img.icon, img[width="24"], img[width="32"], img[width="48"] {
    border-radius: 0;
  }
</style>

IMAGE CORNER RULES — apply to EVERY <img> tag unless it's a tiny icon:
- Hero/background images: rounded-3xl shadow-2xl (or full-bleed with NO rounding if edge-to-edge)
- Feature/service section images: rounded-2xl shadow-md (16px, the default)
- Gallery/moments strips: rounded-xl (12px)
- Team photos, avatars, testimonial portraits: rounded-full (perfect circle)
- Product images: rounded-xl shadow-sm
- Blog post thumbnails: rounded-xl
- Logo/brand marks: no rounding (preserve original shape)
NEVER output a raw unstyled <img> — it should always have at least ONE of: rounded-xl, rounded-2xl, rounded-3xl, or rounded-full.
Images in containers get overflow-hidden on the container + rounded class on the IMAGE itself so group-hover:scale-105 clips correctly.

OUTPUT RULES — STRICT:
- Return ONLY the complete HTML. NOTHING else.
- Start with exactly: <!DOCTYPE html>
- End with exactly: </html>
- NO markdown fences, NO backtick code blocks
- NO explanation before or after the HTML
- NO placeholder text or TODO comments
- NO broken or made-up Tailwind classes
- All Unsplash URLs must be real ones from the list above
- All Alpine.js directives must be syntactically correct
- Site must render perfectly in an iframe from CDN scripts only

SCOPE GUARDRAIL: You build and edit WEBSITES only — pages, sections, copy, styling, forms, and small self-contained on-page widgets (e.g. a pricing calculator) that store nothing. If the user asks for application software — logins, databases, dashboards, anything that saves or processes data, mobile apps — do NOT fake it. Say plainly that a website edit cannot deliver real software, then offer the closest genuine option: a lead-capture form, an on-page estimate widget clearly labelled as an estimate, or TAKEOVA's built-in features (bookings, invoicing, products, CRM, e-commerce). Never produce an interface that looks functional but does nothing.`;



  // Validate content shape BEFORE any operations on it.
  // Previously the `.map()` below ran before this check, so an invalid
  // body produced a TypeError → 500 rather than a clean 400.
  if (!content || !Array.isArray(content)) {
    return res.status(400).json({ error: "content array required" });
  }
  if (content.length > 30) {
    return res.status(400).json({ error: "Too many messages" });
  }
  const _buildCharTotal = content.reduce((s, m) => s + String(m?.content || "").length, 0);
  if (_buildCharTotal > 60000) {
    return res.status(400).json({ error: "Build prompt too large" });
  }

  // Append business-specific MINE wiring instructions
  const mineInstructions = `

Additional context for this specific build:`;

  const enhancedContent = content.map((msg, i) =>
    i === content.length - 1 && msg.role === 'user'
      ? { ...msg, content: msg.content + mineInstructions }
      : msg
  );

  // Rate limit: 10 site builds per hour per user
  const db = getDb();
  const buildsKey = `build_${req.userId}`;
  router._buildLimiter = router._buildLimiter || new Map();
  const now = Date.now();
  const bucket = router._buildLimiter.get(buildsKey) || { count: 0, reset: now + 3600000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 3600000; }
  bucket.count++;
  router._buildLimiter.set(buildsKey, bucket);
  if (bucket.count > 10) {
    return res.status(429).json({ error: "Build rate limit reached (10/hour). Please wait." });
  }

  // Plan cap check — previously /build only tracked usage without checking
  // the cap, so a user could chain 10/hour rate-limit buckets and exceed
  // their aiBuilds plan allowance ~1400× per month.
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, req.userId, "aiBuilds");
    if (usage.blocked) {
      return res.status(403).json({
        error: "You've used all your AI site builds for this month.",
        used: usage.used,
        cap: usage.cap,
        upgrade: true
      });
    }
  }

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system: MINE_SYSTEM,
      messages: enhancedContent || content,
    });

    // Track usage
    if (typeof global !== "undefined" && global.mineTrackUsage) {
      global.mineTrackUsage(db, req.userId, "aiBuilds");
    }

    // ── Post-generation sanity check + auto-patch ──
    // Catches common AI mistakes that would otherwise ship broken UX to users.
    // Each patch is idempotent — safe to run on already-clean HTML.
    let html = msg.content?.[0]?.text || "";
    const warnings = [];

    try {
      // Catches both the plain-JS menu pattern (id="mobile-menu") AND any
      // legacy Alpine patterns (x-show="open") still lingering from older
      // generations.
      var menuRegex = /(<div[^>]*\b(id="mobile-menu"|x-show="open")[^>]*>)/g;

      // 1. Mobile menu missing solid background → text bleeds through hero
      html = html.replace(menuRegex, (m) => {
        // Already has inline bg OR a bg-* Tailwind class → fine
        if (/style="[^"]*background[^"]*"/i.test(m)) return m;
        if (/\bbg-(white|cream|gray-\d+|slate-\d+|neutral-\d+|black|[a-z]+-\d+)\b/.test(m)) return m;
        warnings.push("auto-patched: mobile menu missing solid background");
        return m.replace(/>$/, ' style="background-color:#ffffff">');
      });

      // 2. Mobile menu pushes content instead of overlaying
      html = html.replace(menuRegex, (m) => {
        if (/\b(absolute|fixed)\b/.test(m)) return m;
        warnings.push("auto-patched: mobile menu now positioned absolute");
        return m.replace(/class="([^"]*)"/, 'class="$1 absolute top-full left-0 right-0 z-40"');
      });

      // 3. Empty subject/body/alt on critical elements
      if (/<img\b(?![^>]*\balt=)/i.test(html)) {
        html = html.replace(/<img\b(?![^>]*\balt=)/gi, '<img alt=""');
        warnings.push("auto-patched: added missing alt attributes");
      }

      // 4. Common Claude slip: `<\/script>` escape sequence leaking into HTML
      //    (the escape is only needed inside a JS string, not in final HTML)
      if (html.includes("<\\/script>")) {
        html = html.replaceAll("<\\/script>", "</script>");
        warnings.push("auto-patched: unescaped </script> tags");
      }

      // 5. Validate it looks like a complete HTML document
      if (!html.includes("<html") || !html.includes("</html>")) {
        console.warn("[Build] AI returned incomplete HTML for user", req.userId);
      }
    } catch (patchErr) {
      console.error("[Build] post-gen patch error:", patchErr.message);
    }

    if (warnings.length) {
      console.log("[Build] auto-patches applied:", warnings);
    }

    // ── Auto-save version history ──
    // If the request references an existing site, snapshot the CURRENT html
    // as a version before the AI-generated version replaces it. This lets
    // the user undo a bad AI edit with a single click.
    // Skips if: no siteId (first-time build), site not found, or html unchanged.
    try {
      const siteId = req.body?.siteId || req.body?.site_id;
      if (siteId) {
        const site = db.prepare("SELECT id, html FROM sites WHERE id = ? AND user_id = ?").get(siteId, req.userId);
        if (site && site.html && site.html !== html) {
          db.exec(`CREATE TABLE IF NOT EXISTS site_versions (
            id TEXT PRIMARY KEY, site_id TEXT NOT NULL, user_id TEXT NOT NULL,
            html TEXT NOT NULL, label TEXT, source TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`);
          const { v4: vuuid } = require("uuid");
          const prompt = Array.isArray(content) && content.length
            ? String(content[content.length - 1]?.content || "").slice(0, 120)
            : "AI edit";
          db.prepare("INSERT INTO site_versions (id, site_id, user_id, html, label, source) VALUES (?,?,?,?,?,?)")
            .run(vuuid(), siteId, req.userId, site.html, "Before: " + prompt, "ai_edit");
          // Cap at 50 versions per site
          const old = db.prepare("SELECT id FROM site_versions WHERE site_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 50").all(siteId);
          if (old.length) db.prepare("DELETE FROM site_versions WHERE id IN (" + old.map(() => "?").join(",") + ")").run(...old.map(o => o.id));
        }
      }
    } catch (verErr) {
      console.error("[Build] auto-version save failed:", verErr.message);
      // Non-fatal — still return the generated HTML
    }

    res.json({ text: html });
  } catch (e) {
    console.error("[Build] AI error:", e.message);
    res.status(502).json({ error: "Build failed — please try again" });
  }
});;

// ══════════════════════════════════════════════════════════════
// MINE INTELLIGENCE — proactive daily insights engine
// ══════════════════════════════════════════════════════════════

function ensureIntelligenceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intelligence_insights (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      insights TEXT DEFAULT '[]',
      generated_at TEXT DEFAULT (datetime('now')),
      email_sent INTEGER DEFAULT 0,
      push_sent INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subscription TEXT NOT NULL,
      type TEXT DEFAULT 'web',
      platform TEXT DEFAULT 'web',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// Generate insights for a single user — called by cron and on-demand
async function generateInsightsForUser(db, userId, apiKey) {
  const today = new Date().toISOString().slice(0, 10);

  // Gather cross-platform data
  const site = db.prepare("SELECT * FROM sites WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId);
  const user = db.prepare("SELECT name, email, plan FROM users WHERE id = ?").get(userId);
  if (!site || !user) return null;

  const orders = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(userId);
  const invoices = db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").all(userId);
  const contacts = db.prepare("SELECT COUNT(*) as cnt FROM contacts WHERE user_id = ?").get(userId);
  const reviews = db.prepare("SELECT * FROM reviews WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(userId);
  const tickets = db.prepare("SELECT * FROM support_tickets WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 10").all(userId).catch?.() || [];
  const emailStats = db.prepare("SELECT SUM(sent) as sent, SUM(opened) as opened, SUM(clicked) as clicked FROM email_sends WHERE user_id = ? AND sent_at >= datetime('now', '-7 days')").get(userId) || {};
  const abandonedCarts = db.prepare("SELECT COUNT(*) as cnt FROM abandoned_carts WHERE user_id = ? AND recovered = 0").get(userId) || { cnt: 0 };
  const overdueInvoices = invoices.filter(i => i.status === "overdue" || (i.status === "sent" && i.due_date && i.due_date < today));
  const recentRevenue7 = orders.filter(o => o.created_at >= new Date(Date.now() - 7 * 86400000).toISOString()).reduce((s, o) => s + (o.total || 0), 0);
  const recentRevenuePrev7 = orders.filter(o => { const d = new Date(o.created_at); return d < new Date(Date.now() - 7 * 86400000) && d >= new Date(Date.now() - 14 * 86400000); }).reduce((s, o) => s + (o.total || 0), 0);
  const unrespondedReviews = reviews.filter(r => !r.reply && !r.owner_reply);

  const dataSnapshot = {
    businessName: site.name,
    ownerName: user.name,
    plan: user.plan,
    revenue7Days: recentRevenue7.toFixed(2),
    revenuePrev7Days: recentRevenuePrev7.toFixed(2),
    revenueChange: recentRevenuePrev7 > 0 ? (((recentRevenue7 - recentRevenuePrev7) / recentRevenuePrev7) * 100).toFixed(1) : null,
    totalOrders7Days: orders.filter(o => o.created_at >= new Date(Date.now() - 7 * 86400000).toISOString()).length,
    overdueInvoices: overdueInvoices.length,
    overdueAmount: overdueInvoices.reduce((s, i) => s + (i.total || 0), 0).toFixed(2),
    abandonedCarts: abandonedCarts.cnt,
    totalContacts: contacts?.cnt || 0,
    emailOpenRate: emailStats.sent > 0 ? ((emailStats.opened / emailStats.sent) * 100).toFixed(1) : null,
    emailClickRate: emailStats.sent > 0 ? ((emailStats.clicked / emailStats.sent) * 100).toFixed(1) : null,
    unrespondedReviews: unrespondedReviews.length,
    avgReviewRating: reviews.length > 0 ? (reviews.reduce((s, r) => s + (r.rating || 5), 0) / reviews.length).toFixed(1) : null,
    openSupportTickets: tickets.length,
    siteViews: site.views || 0,
    date: today
  };

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const prompt = `You are TAKEOVA Intelligence, a proactive AI business advisor. Analyse this business data and generate exactly 3 specific, actionable insights for today.

BUSINESS DATA:
${JSON.stringify(dataSnapshot, null, 2)}

Rules:
- Each insight must reference SPECIFIC numbers from the data
- Each must be something the owner wouldn't automatically notice themselves
- Prioritise by revenue impact — highest first
- Each insight needs a concrete one-tap action they can take RIGHT NOW
- Do NOT generate generic advice like "consider emailing your list"
- If data is sparse, focus on what IS there — don't make things up

Respond ONLY with valid JSON, no markdown:
{
  "insights": [
    {
      "id": "unique-id-1",
      "priority": "high|medium|low",
      "category": "revenue|engagement|retention|operations|growth",
      "icon": "single emoji",
      "headline": "Short punchy headline (max 8 words)",
      "detail": "2-3 sentences with specific numbers explaining why this matters today",
      "action": {
        "label": "Short action button label",
        "tab": "the dashboard tab to navigate to (e.g. invoices, reviews, email, crm, orders, funnels)",
        "description": "Exactly what to do when they get there"
      },
      "impact": "Estimated impact e.g. Recover $X or Save Y hours/week"
    }
  ]
}`;

  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }]
    });

    const text = msg.content?.[0]?.text || "";
    const parsed = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
    return parsed.insights || [];
  } catch (e) {
    console.error("[Intelligence] AI parse error:", e.message);
    return [];
  }
}

// GET today's insights (or generate on-demand)
// GET today's insights — returns cached if available (free, no cap)
router.get("/intelligence", auth, async (req, res) => {
  const db = getDb();
  ensureIntelligenceTables(db);
  const today = new Date().toISOString().slice(0, 10);

  // Always return cached if available — reading cached costs nothing, no cap check needed
  const cached = db.prepare("SELECT * FROM intelligence_insights WHERE user_id = ? AND date = ?").get(req.userId, today);
  if (cached && cached.insights) {
    return res.json({ insights: (function(s){try{return JSON.parse(s);}catch(_){return {};}})(cached.insights), date: today, fresh: false });
  }

  // No cache yet — this is the automatic first generation of the day (also free, no cap)
  const getSetting = (k) => { try { return db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } };
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured" });

  const insights = await generateInsightsForUser(db, req.userId, apiKey);
  if (!insights || insights.length === 0) return res.json({ insights: [], date: today, fresh: true });

  const id = require("uuid").v4();
  db.prepare("INSERT OR REPLACE INTO intelligence_insights (id, user_id, date, insights) VALUES (?,?,?,?)")
    .run(id, req.userId, today, JSON.stringify(insights));

  res.json({ insights, date: today, fresh: true });
});

// POST /intelligence/refresh — on-demand re-generation, plan-capped
router.post("/intelligence/refresh", auth, async (req, res) => {
  const db = getDb();
  ensureIntelligenceTables(db);

  // Check plan cap — Starter gets 0 on-demand refreshes
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, req.userId, "intelligenceRefresh");
    if (usage.blocked) {
      return res.status(403).json({
        error: usage.cap === 0
          ? "On-demand briefing refresh is not available on your current plan. Upgrade to Growth or higher."
          : `You've used all ${usage.cap} briefing refreshes for this month.`,
        used: usage.used,
        cap: usage.cap,
        upgrade: true
      });
    }
  }

  const getSetting = (k) => { try { return db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } };
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured" });

  const insights = await generateInsightsForUser(db, req.userId, apiKey);
  if (!insights || insights.length === 0) return res.status(500).json({ error: "Could not generate insights" });

  // Overwrite today's cached insights
  const today = new Date().toISOString().slice(0, 10);
  const id = require("uuid").v4();
  db.prepare("INSERT OR REPLACE INTO intelligence_insights (id, user_id, date, insights) VALUES (?,?,?,?)")
    .run(id, req.userId, today, JSON.stringify(insights));

  // Track usage only on success
  if (typeof global !== "undefined" && global.mineTrackUsage) {
    global.mineTrackUsage(db, req.userId, "intelligenceRefresh");
  }

  res.json({ insights, date: today, fresh: true });
});

// GET full history
router.get("/intelligence/history", auth, (req, res) => {
  const db = getDb();
  ensureIntelligenceTables(db);
  const rows = db.prepare("SELECT * FROM intelligence_insights WHERE user_id = ? ORDER BY date DESC LIMIT 30").all(req.userId);
  res.json({ history: rows.map(r => ({ ...r, insights: JSON.parse(r.insights || "[]") })) });
});

// POST push subscription
router.post("/intelligence/push-subscribe", auth, (req, res) => {
  const db = getDb();
  ensureIntelligenceTables(db);
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: "subscription required" });
  const id = require("uuid").v4();
  db.prepare("INSERT OR REPLACE INTO push_subscriptions (id, user_id, subscription) VALUES (?,?,?)")
    .run(id, req.userId, JSON.stringify(subscription));
  res.json({ success: true });
});

// DELETE push subscription
router.delete("/intelligence/push-subscribe", auth, (req, res) => {
  const db = getDb();
  ensureIntelligenceTables(db);
  db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND type = 'web'").run(req.userId);
  res.json({ success: true });
});

// POST Expo (mobile) push token — registers native iOS/Android push token
router.post("/intelligence/push-token", auth, (req, res) => {
  const db = getDb();
  ensureIntelligenceTables(db);
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });
  const id = require("uuid").v4();
  // Upsert by user+platform so re-registration updates rather than duplicates
  db.prepare(`
    INSERT INTO push_subscriptions (id, user_id, subscription, type, platform)
    VALUES (?,?,?,'expo',?)
    ON CONFLICT(id) DO UPDATE SET subscription = excluded.subscription
  `).run(id, req.userId, token, platform || "unknown");
  // Also check by subscription value to avoid duplicates from the same device
  const existing = db.prepare("SELECT id FROM push_subscriptions WHERE user_id = ? AND subscription = ? AND type = 'expo'").get(req.userId, token);
  if (!existing) {
    db.prepare("INSERT INTO push_subscriptions (id, user_id, subscription, type, platform) VALUES (?,?,?,'expo',?)")
      .run(id, req.userId, token, platform || "unknown");
  }
  res.json({ success: true });
});

// Export for cron
router.generateInsightsForUser = generateInsightsForUser;
router.ensureIntelligenceTables = ensureIntelligenceTables;


// ═══════════════════════════════════════════════════════════════════════
// IMAGE MANAGEMENT — used by Site Editor's Image Manager modal
// ═══════════════════════════════════════════════════════════════════════

function ensureImageTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      site_id TEXT,
      url TEXT NOT NULL,
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      kind TEXT DEFAULT 'upload',
      prompt TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_site_images_user ON site_images(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_images_site ON site_images(site_id);
  `);
}

// POST /api/ai-agent/image/upload-url — Request a presigned S3 URL for direct upload
router.post("/image/upload-url", auth, async (req, res) => {
  try {
    const { filename, mimeType, siteId } = req.body || {};
    if (!filename || !mimeType) {
      return res.status(400).json({ error: "filename and mimeType required" });
    }
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) {
      return res.status(400).json({ error: "Unsupported image type" });
    }

    const s3 = require("../utils/s3");
    const key = `sites/${req.user.id}/${siteId || "misc"}/${uuid()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    // If S3 is configured, get a real presigned URL
    if (s3.isS3Enabled && s3.isS3Enabled()) {
      const uploadUrl = await s3.getSignedUrl(key, mimeType, "putObject");
      const finalUrl = s3.getFileUrl ? s3.getFileUrl(key) : uploadUrl.split("?")[0];
      return res.json({ uploadUrl, finalUrl, key });
    }

    // Fallback: return a local upload URL that the /register endpoint will fake-accept
    const finalUrl = `${req.protocol}://${req.get("host")}/uploads/${key}`;
    return res.json({
      uploadUrl: finalUrl,
      finalUrl,
      key,
      local: true
    });
  } catch (e) {
    console.error("image/upload-url error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai-agent/image/register — Save image reference after upload
router.post("/image/register", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureImageTables(db);
    const { url, siteId, kind, sizeBytes, filename, prompt } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });

    const id = uuid();
    db.prepare(`
      INSERT INTO site_images (id, user_id, site_id, url, filename, size_bytes, kind, prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, siteId || null, url, filename || null, sizeBytes || 0, kind || "upload", prompt || null);

    res.json({ ok: true, id, url });
  } catch (e) {
    console.error("image/register error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai-agent/image/library — List user's uploaded images  
router.get("/image/library", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureImageTables(db);
    const { siteId } = req.query || {};
    const rows = siteId
      ? db.prepare("SELECT * FROM site_images WHERE user_id=? AND (site_id=? OR site_id IS NULL) ORDER BY created_at DESC LIMIT 100").all(req.user.id, siteId)
      : db.prepare("SELECT * FROM site_images WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.user.id);
    res.json({ images: rows });
  } catch (e) {
    console.error("image/library error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ai-agent/image/library/:id — Delete an image from the user's library
// Also removes from image_library (ad creator results) if present
router.delete("/image/library/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const id = req.params.id;
    // Try both tables — site_images (standalone) and image_library (ad creator)
    let deleted = 0;
    try {
      const r1 = db.prepare("DELETE FROM site_images WHERE id = ? AND user_id = ?").run(id, req.user.id);
      deleted += r1.changes || 0;
    } catch (_) {}
    try {
      const r2 = db.prepare("DELETE FROM image_library WHERE id = ? AND user_id = ?").run(id, req.user.id);
      deleted += r2.changes || 0;
    } catch (_) {}
    if (deleted === 0) {
      return res.status(404).json({ ok: false, error: "image not found or not owned by user" });
    }
    res.json({ ok: true, deleted });
  } catch (e) {
    console.error("image/library/:id DELETE:", e.message);
    res.status(500).json({ error: "delete failed" });
  }
});

// POST /api/ai-agent/image/generate — AI image generation
router.post("/image/generate", auth, async (req, res) => {
  try {
    let { prompt, aspectRatio, siteId, referenceImageUrl, quality, soulId } = req.body || {};
    if(!soulId){ try{ const _bs=require("../db/init").getDb().prepare("SELECT soul_id FROM brand_souls WHERE user_id=?").get(req.userId); if(_bs&&_bs.soul_id) soulId=_bs.soul_id; }catch(_e){} }
    if (!prompt || prompt.length < 3) {
      return res.status(400).json({ error: "prompt required (min 3 chars)" });
    }

    // ── Hybrid-C cap enforcement ─────────────────────────────────────────────
    // Premium path (soulId or quality=premium) → soulImages cap.
    // Everything else → standard images cap.
    const db = getDb();
    if (global.mineEnforceCapWithConsent) {
      const isPremium = soulId || quality === "premium" || quality === "soul";
      const capMetric = isPremium ? "soulImages" : "images";
      const capCheck = global.mineEnforceCapWithConsent(db, req.userId, capMetric);
      if (!capCheck.ok) {
        if (capCheck.locked) {
          return res.status(403).json({
            ok: false, locked: true, feature: capMetric,
            reason: capCheck.reason, plan: capCheck.plan, upgrade_required: true
          });
        }
        if (capCheck.capReached) {
          return res.status(402).json({
            ok: false, capReached: true, feature: capMetric,
            cap: capCheck.cap, used: capCheck.used, overageRate: capCheck.rate,
            message: `You've used all ${capCheck.cap} ${capMetric} this month. Continue at $${(capCheck.rate || 0).toFixed(2)} each?`,
            requiresConsent: true
          });
        }
      }
    }

    // Provider chain:
    //   • Higgsfield Soul (if soulId provided OR quality='premium', and HF configured)
    //   • Nano Banana 2 (Gemini) — default for everything else
    //   • DALL-E 3 (fallback if Gemini fails)
    //   • Unsplash (last resort, not really AI)
    const geminiKey  = getSetting("gemini_api_key")    || process.env.GEMINI_API_KEY;
    const openaiKey  = getSetting("openai_api_key")    || process.env.OPENAI_API_KEY;
    const apiKey     = getSetting("replicate_api_key") || process.env.REPLICATE_API_KEY; // reserved for future

    let imageUrl = null;
    let provider = null;

    // ── 0. Higgsfield Soul — used for character consistency (Soul ID) or premium quality ─
    // Engage only when explicitly requested: caller passes soulId or quality='premium'.
    // Default flow stays on Nano Banana for cost-efficiency.
    const hfProvider = require("./higgsfield-provider");
    const wantsHiggsfield = (soulId || quality === "premium" || quality === "soul") && hfProvider.isEnabled();
    if (wantsHiggsfield) {
      try {
        const soulResult = await hfProvider.generateSoulImage({
          prompt,
          aspectRatio: aspectRatio || "1:1",
          quality: quality === "premium" ? "hd" : "standard",
          soulId: soulId || null,
          referenceImageUrl: referenceImageUrl || null,
        });
        if (soulResult.ok && soulResult.url) {
          imageUrl = soulResult.url;
          provider = soulResult.provider; // "higgsfield-soul"
          // Track Higgsfield usage for cap + overage billing
          try {
            const featuresRouter = require("./features");
            if (featuresRouter && typeof featuresRouter.trackUsage === "function") {
              featuresRouter.trackUsage(getDb(), req.userId, "soulImages", 1);
            }
          } catch (trackErr) { console.warn("[image/generate] soulImages tracking failed:", trackErr.message); }
        } else if (soulResult.jobId) {
          // Soul returned an async job — caller will need to poll, but our existing
          // endpoint doesn't support polling for images. For now, fall through to
          // synchronous providers. TODO: add async image polling endpoint.
          console.warn("Higgsfield Soul queued (async not yet supported), falling through");
        }
      } catch (err) {
        console.warn("Higgsfield Soul failed:", err.message);
      }
    }

    // ── 1. Prefer Google Nano Banana 2 (Gemini 3.1 Flash Image) ───────────────
    // Better quality, native image-to-image support, character consistency.
    // Endpoint: generativelanguage.googleapis.com
    // Model: gemini-3.1-flash-image-preview (Nano Banana 2 — current as of Feb 2026)
    // Cost: ~$0.10 per 2K image (vs DALL-E 3 $0.04 standard / $0.08 HD).
    // Supports image-to-image: pass referenceImageUrl to keep product/character.
    if (!imageUrl && geminiKey) {
      try {
        // Build multimodal payload — Gemini returns inline base64 image data
        const parts = [{ text: prompt.slice(0, 2000) }];
        if (referenceImageUrl) {
          // Fetch reference and pass as inline base64 (image-to-image mode)
          try {
            const refResp = await fetch(referenceImageUrl);
            if (refResp.ok) {
              const buf = Buffer.from(await refResp.arrayBuffer());
              parts.push({
                inline_data: {
                  mime_type: refResp.headers.get("content-type") || "image/jpeg",
                  data: buf.toString("base64")
                }
              });
            }
          } catch (_) { /* ignore ref fetch failure, fall through to text-only */ }
        }

        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: {
                responseModalities: ["IMAGE"],
                // Aspect ratio hint via prompt — Gemini doesn't take explicit aspect param
              }
            })
          }
        );
        const data = await r.json();

        // Extract the base64 image from response parts
        const respParts = data?.candidates?.[0]?.content?.parts || [];
        const imgPart = respParts.find(p => p.inline_data || p.inlineData);
        if (imgPart) {
          const inlineData = imgPart.inline_data || imgPart.inlineData;
          const mime = inlineData.mime_type || inlineData.mimeType || "image/png";
          const b64 = inlineData.data;
          // Store as data URL (small images) OR upload to R2/S3 if configured
          // For now keep simple — return data URL, frontend will display directly
          imageUrl = `data:${mime};base64,${b64}`;
          provider = "nano-banana-2";
        } else if (data?.error) {
          console.warn("Nano Banana 2 error:", data.error.message || data.error);
        }
      } catch (err) {
        console.warn("Nano Banana 2 generation failed:", err.message);
      }
    }

    // ── 2. Fallback: OpenAI DALL-E 3 ──────────────────────────────────────────
    if (!imageUrl && openaiKey) {
      try {
        const r = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`
          },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt: prompt.slice(0, 1000),
            size: aspectRatio === "16:9" ? "1792x1024" : aspectRatio === "9:16" ? "1024x1792" : "1024x1024",
            n: 1
          })
        });
        const data = await r.json();
        if (data?.data?.[0]?.url) {
          imageUrl = data.data[0].url;
          provider = "dall-e-3";
        }
      } catch (err) {
        console.warn("DALL-E generation failed:", err.message);
      }
    }

    // ── 3. Last resort: Unsplash (stock photo, not AI) ────────────────────────
    if (!imageUrl) {
      const keyword = encodeURIComponent(prompt.split(/\s+/).slice(0, 3).join(" "));
      imageUrl = `https://source.unsplash.com/1024x768/?${keyword}`;
      provider = "unsplash-fallback";
    }

    // Register the generated image
    ensureImageTables(db);
    const id = uuid();
    db.prepare(`
      INSERT INTO site_images (id, user_id, site_id, url, kind, prompt)
      VALUES (?, ?, ?, ?, 'ai-generated', ?)
    `).run(id, req.user.id, siteId || null, imageUrl, prompt);

    // ── Track usage — premium uses soulImages, otherwise images ───────────────
    try {
      if (global.mineTrackUsage) {
        const wasPremium = (soulId || quality === "premium" || quality === "soul") && provider && provider.startsWith("higgsfield");
        const metric = wasPremium ? "soulImages" : "images";
        global.mineTrackUsage(db, req.userId, metric, 1);
      }
    } catch(_) {}

    res.json({ ok: true, id, url: imageUrl, prompt, provider });
  } catch (e) {
    console.error("image/generate error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// HIGGSFIELD SOUL ID — Brand model / character consistency management
// Lets users register a "brand person" once and use them in all generations.
// Requires HF_API_KEY + HF_API_SECRET env vars.
// ═══════════════════════════════════════════════════════════════════

// POST /api/ai-agent/soul-id/create — Register a Soul ID from reference images
// Body: { name, referenceImages: [url1, url2, ...] }  (need 3+ photos of same subject)
router.post("/soul-id/create", auth, async (req, res) => {
  try {
    const hfProvider = require("./higgsfield-provider");
    if (!hfProvider.isEnabled()) {
      return res.status(503).json({ error: "Higgsfield not configured. Set HF_API_KEY + HF_API_SECRET to enable Soul ID." });
    }
    const { name, referenceImages } = req.body || {};
    if (!name || !Array.isArray(referenceImages) || referenceImages.length < 3) {
      return res.status(400).json({ error: "name + at least 3 reference image URLs required" });
    }

    // ── Hybrid-C cap enforcement (brandModels) ───────────────────────────────
    const db = getDb();
    if (global.mineEnforceCapWithConsent) {
      const capCheck = global.mineEnforceCapWithConsent(db, req.userId, "brandModels");
      if (!capCheck.ok) {
        if (capCheck.locked) {
          return res.status(403).json({
            ok: false, locked: true, feature: "brandModels",
            reason: "Brand model training is not included on your plan. Upgrade to unlock.",
            plan: capCheck.plan, upgrade_required: true
          });
        }
        if (capCheck.capReached) {
          return res.status(402).json({
            ok: false, capReached: true, feature: "brandModels",
            cap: capCheck.cap, used: capCheck.used, overageRate: capCheck.rate,
            message: `You've trained all ${capCheck.cap} brand models this month. Train another at $${(capCheck.rate || 0).toFixed(2)}?`,
            requiresConsent: true
          });
        }
      }
    }

    const result = await hfProvider.createSoulId({ name, referenceImages });
    if (!result.ok) return res.status(500).json({ error: result.error });

    // Persist to local DB so user can list/manage their Soul IDs
    try {
      db.exec("CREATE TABLE IF NOT EXISTS soul_ids (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, hf_soul_id TEXT, status TEXT, created_at TEXT)");
      db.prepare("INSERT INTO soul_ids (id, user_id, name, hf_soul_id, status, created_at) VALUES (?,?,?,?,?,datetime('now'))")
        .run("sid_" + Date.now() + "_" + Math.random().toString(36).slice(2,8), req.userId, name, result.soulId, result.status || "training");
    } catch (dbErr) { console.warn("soul_ids persist:", dbErr.message); }

    // Track brandModels usage — auto-bills overage if past cap (consent already collected above)
    try {
      if (global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "brandModels", 1);
    } catch (trackErr) { console.warn("[soul-id/create] brandModels tracking failed:", trackErr.message); }

    res.json({ ok: true, soulId: result.soulId, status: result.status, message: "Soul ID training started. Usually ready in 5-15 minutes." });
  } catch (e) {
    console.error("soul-id/create:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai-agent/soul-id/list — User's Soul IDs
router.get("/soul-id/list", auth, async (req, res) => {
  try {
    const db = getDb();
    let rows = [];
    try {
      rows = db.prepare("SELECT id, name, hf_soul_id, status, created_at FROM soul_ids WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
    } catch (_) { /* table may not exist yet */ }
    res.json({ soulIds: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// AD CREATOR — Product-aware ad image generation (Phase 2)
// Uses image-to-image with the user's actual product photo as reference.
// Style + platform presets become structured prompt context.
// ═══════════════════════════════════════════════════════════════════

// Style preset definitions — translate dropdown picks into prompt context
const AD_STYLE_PRESETS = {
  hero: {
    name: "Hero shot",
    promptCtx: "centered composition, dramatic studio lighting, premium feel, clean background, hero product shot, advertising photography, sharp focus, professional retoucher quality",
  },
  lifestyle: {
    name: "Lifestyle scene",
    promptCtx: "in-use lifestyle scenario, soft natural daylight, candid authentic moment, real-world environment, aspirational but relatable, warm color grading",
  },
  ugc: {
    name: "UGC casual",
    promptCtx: "phone camera quality, slight grain, casual angle, authentic user-generated content style, natural unposed feel, soft shadows, vlogger aesthetic",
  },
  holiday: {
    name: "Holiday / Seasonal",
    promptCtx: "festive seasonal props, warm holiday atmosphere, twinkling lights or seasonal decor in soft focus, cozy mood, gift-giving vibe",
  },
  minimal: {
    name: "Minimalist",
    promptCtx: "minimalist composition, single subject, lots of negative space, muted color palette, gallery-quality, editorial design feel",
  },
};

// Platform aspect ratio + composition hints
const AD_PLATFORM_PRESETS = {
  "ig-feed": { name: "Instagram Feed", aspectRatio: "4:5", ctx: "vertical 4:5 mobile-first composition, scroll-stopping visual hook, subject in upper third" },
  "ig-story": { name: "Story / Reel", aspectRatio: "9:16", ctx: "vertical 9:16 full-screen mobile, eye-line centered, headline-safe top zone, action-safe bottom zone" },
  "fb-ad":    { name: "Facebook ad", aspectRatio: "1.91:1", ctx: "horizontal 1.91:1 landscape, headline space top-left, eye-line on right third, ad-platform-safe" },
  "square":   { name: "Square post", aspectRatio: "1:1", ctx: "square 1:1 balanced composition, evenly weighted visual elements" },
  "youtube":  { name: "YouTube thumbnail", aspectRatio: "16:9", ctx: "horizontal 16:9 thumbnail composition, bold and clickable, high contrast, room for overlay text" },
};

// POST /api/ai-agent/image/generate-ad
// Body: { productId, adStyle, platform, brief?, variantCount?, soulId? }
router.post("/image/generate-ad", auth, async (req, res) => {
  try {
    const db = getDb();
    const { productId, adStyle, platform, brief, variantCount, soulId } = req.body || {};

    // Validate inputs
    if (!productId) return res.status(400).json({ error: "productId required" });
    const style = AD_STYLE_PRESETS[adStyle || "lifestyle"];
    const plat  = AD_PLATFORM_PRESETS[platform || "ig-feed"];
    if (!style) return res.status(400).json({ error: "invalid adStyle. Allowed: " + Object.keys(AD_STYLE_PRESETS).join(", ") });
    if (!plat)  return res.status(400).json({ error: "invalid platform. Allowed: " + Object.keys(AD_PLATFORM_PRESETS).join(", ") });

    const n = Math.min(Math.max(parseInt(variantCount) || 4, 1), 6); // 1-6 variants

    // ── Look up product (must belong to user) ─────────────────────────────────
    // Products are linked via site_id → sites.user_id. Verify ownership.
    const product = db.prepare(`
      SELECT p.id, p.name, p.description, p.category, p.images_json, p.price
      FROM products p
      JOIN sites s ON s.id = p.site_id
      WHERE p.id = ? AND s.user_id = ?
    `).get(productId, req.userId);
    if (!product) return res.status(404).json({ error: "Product not found or not yours" });

    // ── Extract first image from images_json as reference ────────────────────
    let referenceImageUrl = null;
    if (product.images_json) {
      try {
        const imgs = JSON.parse(product.images_json);
        if (Array.isArray(imgs) && imgs.length > 0) {
          referenceImageUrl = typeof imgs[0] === "string" ? imgs[0] : imgs[0].url || imgs[0].src;
        }
      } catch (_) { /* malformed JSON, generate without reference */ }
    }
    if (!referenceImageUrl) {
      return res.status(400).json({ error: "Product has no images. Add a product photo first to generate ads." });
    }

    // ── Build the full prompt ────────────────────────────────────────────────
    const productLabel = product.name + (product.description ? " — " + product.description.slice(0, 200) : "");
    const userBrief = (brief && typeof brief === "string") ? brief.slice(0, 300) : "";
    const fullPrompt = [
      `Product ad photo for: ${productLabel}.`,
      style.promptCtx,
      plat.ctx,
      userBrief ? `Additional direction: ${userBrief}` : "",
      "Keep the exact product from the reference image — same shape, color, packaging, branding. Place it in a new scene matching the style above.",
    ].filter(Boolean).join(" ");

    // ── Generate N variants in parallel ──────────────────────────────────────
    // Each variant gets the same prompt; provider randomness yields different results.
    const geminiKey = getSetting("gemini_api_key") || process.env.GEMINI_API_KEY;
    const openaiKey = getSetting("openai_api_key") || process.env.OPENAI_API_KEY;
    const hfProvider = require("./higgsfield-provider");
    const s3util = require("../utils/s3");

    if (!geminiKey && !openaiKey && !hfProvider.isEnabled()) {
      return res.status(503).json({ error: "No image provider configured. Set GEMINI_API_KEY (Nano Banana), HF_API_KEY+HF_API_SECRET (Higgsfield Soul), or OPENAI_API_KEY (DALL-E 3)." });
    }

    // ── Hybrid-C cap enforcement ─────────────────────────────────────────────
    // soulId path uses Higgsfield Soul → counts against soulImages cap.
    // Non-soul path uses Nano Banana/DALL-E → counts against generic images cap.
    // For each variant generated, we'll consume 1 unit; pre-check here that the
    // batch wouldn't exceed cap, and return capReached to surface the consent modal.
    if (global.mineEnforceCapWithConsent) {
      const capMetric = soulId ? "soulImages" : "images";
      // Lightweight pre-check — only blocks if user is ALREADY over cap and has no consent.
      // (We don't block partial overflow mid-batch; mineTrackUsage handles per-variant overage.)
      const capCheck = global.mineEnforceCapWithConsent(db, req.userId, capMetric);
      if (!capCheck.ok) {
        if (capCheck.locked) {
          return res.status(403).json({
            ok: false,
            locked: true,
            feature: capMetric,
            reason: capCheck.reason || `${capMetric} not on your plan`,
            plan: capCheck.plan,
            upgrade_required: true
          });
        }
        if (capCheck.capReached) {
          return res.status(402).json({
            ok: false,
            capReached: true,
            feature: capMetric,
            cap: capCheck.cap,
            used: capCheck.used,
            overageRate: capCheck.rate,
            message: `You've used all ${capCheck.cap} ${capMetric} this month. Continue at $${(capCheck.rate || 0).toFixed(2)} each?`,
            requiresConsent: true
          });
        }
      }
    }

    // ── Charge customer for the batch BEFORE generating ──────────────────────
    // Pricing: $0.20/variant × n = $0.80 for 4 variants (default).
    // If Stripe is not configured, generation runs free (dev/test mode).
    const AD_VARIANT_PRICE = 0.20;
    const batchTotal = AD_VARIANT_PRICE * n;
    let chargeId = null;
    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;

    if (stripeKey) {
      const userRow = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(req.userId);
      if (!userRow?.stripe_customer_id) {
        return res.status(402).json({
          error: "No payment method on file. Add a card in billing settings before generating ads.",
          needsPaymentMethod: true,
        });
      }
      // ── Admin bypass: owner uses free, costs route to company API accounts ─
      const _isAdminAd = (typeof global.mineIsAdmin === "function") && global.mineIsAdmin(db, req.userId);
      if (_isAdminAd) { chargeId = "admin_free_ad_" + Date.now(); }
      else try {
        const stripe = require("stripe")(stripeKey);
        // Idempotency key: user + product + hour-bucket. Retries within same hour
        // hit same key and Stripe returns the cached PI rather than double-charging.
        const idemKey = `ad_${req.userId}_${productId}_${Math.floor(Date.now() / 3600000)}_${n}`;
        const pi = await stripe.paymentIntents.create({
          amount: Math.round(batchTotal * 100),
          currency: "usd",
          customer: userRow.stripe_customer_id,
          payment_method_types: ["card"],
          confirm: true,
          off_session: true,
          description: `MINE Ad Creator — ${n} variants of "${product.name}"`,
          metadata: { user_id: req.userId, metric: "adBatches", product_id: String(productId), variants: n, price: batchTotal },
        }, { idempotencyKey: idemKey });
        if (pi.status !== "succeeded") {
          return res.status(402).json({ error: "Payment did not succeed. Check billing settings.", paymentStatus: pi.status });
        }
        chargeId = pi.id;
        // Record in overage_charges if table exists (matches Runway pattern)
        try {
          const period = new Date().toISOString().slice(0, 7);
          const chargeUuid = "ad_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
          db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status, stripe_invoice_item_id) VALUES (?,?,?,?,?,?,?,'paid',?)")
            .run(chargeUuid, req.userId, "adBatches", n, AD_VARIANT_PRICE, batchTotal, period, chargeId);
        } catch (_) { /* table may not exist, that's fine */ }
      } catch (stripeErr) {
        if (stripeErr.code === "card_declined" || stripeErr.code === "authentication_required") {
          return res.status(402).json({ error: "Card declined. Update your payment method in billing.", code: stripeErr.code });
        }
        return res.status(402).json({ error: "Payment error: " + stripeErr.message });
      }
    }

    // Reuse the existing image generation by calling the route function directly
    // would be cleanest, but it's wrapped in middleware. Instead inline the
    // generation logic here for the parallel batch.
    async function genOne() {
      // ── Path A: Higgsfield Soul (when soulId provided for brand consistency) ──
      if (soulId && hfProvider.isEnabled()) {
        try {
          const aspectMap = { "16:9": "16:9", "9:16": "9:16", "4:5": "4:5", "1:1": "1:1", "1.91:1": "16:9" };
          const soulResult = await hfProvider.generateSoulImage({
            prompt: fullPrompt.slice(0, 2000),
            aspectRatio: aspectMap[plat.aspectRatio] || "1:1",
            quality: "standard",
            soulId,
            referenceImageUrl,
          });
          if (soulResult.ok && soulResult.url) {
            // Track Higgsfield usage for cap + overage billing
            try {
              const featuresRouter = require("./features");
              if (featuresRouter && typeof featuresRouter.trackUsage === "function") {
                featuresRouter.trackUsage(getDb(), req.userId, "soulImages", 1, { skipOverageBilling: true }); // ad batch already charged inline (adBatches) — count image usage, don't double-bill the soulImages overage
              }
            } catch (trackErr) { console.warn("[ad-creator] soulImages tracking failed:", trackErr.message); }
            return { url: soulResult.url, provider: "higgsfield-soul" };
          }
        } catch (e) {
          console.warn("[ad-creator] soul variant failed, falling through:", e.message);
        }
      }

      // ── Path B: Nano Banana (default for image-to-image) ────────────────────
      if (geminiKey) {
        try {
          const parts = [{ text: fullPrompt.slice(0, 2000) }];
          // Fetch reference and add as inline image
          try {
            const refResp = await fetch(referenceImageUrl);
            if (refResp.ok) {
              const buf = Buffer.from(await refResp.arrayBuffer());
              parts.push({
                inline_data: {
                  mime_type: refResp.headers.get("content-type") || "image/jpeg",
                  data: buf.toString("base64"),
                },
              });
            }
          } catch (_) { /* fall back to text-only generation */ }

          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${geminiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { responseModalities: ["IMAGE"] },
              }),
            }
          );
          const d = await r.json();
          // Gemini returns base64 inline image data — upload to S3 for persistent URL.
          const cand = d?.candidates?.[0]?.content?.parts || [];
          const imgPart = cand.find(p => p.inline_data || p.inlineData);
          if (imgPart) {
            const inline = imgPart.inline_data || imgPart.inlineData;
            const mime = inline.mime_type || inline.mimeType || "image/png";
            const ext = (mime.split("/")[1] || "png").replace("jpeg", "jpg");

            // If S3/R2 configured, upload for persistent URL. Otherwise return data URL.
            if (s3util.isS3Enabled && s3util.isS3Enabled()) {
              try {
                const key = `ad-images/${req.userId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                const publicUrl = await s3util.uploadBase64ToS3(inline.data, key, mime);
                return { url: publicUrl, provider: "nano-banana-2" };
              } catch (s3err) {
                console.warn("[ad-creator] S3 upload failed, returning data URL:", s3err.message);
                return { url: `data:${mime};base64,${inline.data}`, provider: "nano-banana-2", warning: "Not saved to library (S3 unavailable)" };
              }
            }
            // No S3 — return as data URL (visible but not persisted)
            return { url: `data:${mime};base64,${inline.data}`, provider: "nano-banana-2", warning: "Not saved to library (S3 not configured)" };
          }
        } catch (e) {
          console.warn("[ad-creator] nano banana variant failed:", e.message);
        }
      }

      // ── Path C: DALL-E 3 fallback (no reference image — text-only) ──────────
      if (openaiKey) {
        try {
          const sizeMap = { "9:16": "1024x1792", "16:9": "1792x1024", "4:5": "1024x1024", "1:1": "1024x1024", "1.91:1": "1792x1024" };
          const r = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
            body: JSON.stringify({
              model: "dall-e-3",
              prompt: fullPrompt.slice(0, 1000),
              size: sizeMap[plat.aspectRatio] || "1024x1024",
              n: 1,
            }),
          });
          const d = await r.json();
          if (d?.data?.[0]?.url) return { url: d.data[0].url, provider: "dall-e-3" };
        } catch (e) {
          console.warn("[ad-creator] dall-e variant failed:", e.message);
        }
      }
      return null;
    }

    const variants = await Promise.all(Array.from({ length: n }, () => genOne()));
    const successful = variants.filter(v => v && v.url);

    if (!successful.length) {
      // ⚠ Generation failed AFTER charge — issue refund attempt
      if (chargeId && stripeKey) {
        try {
          const stripe = require("stripe")(stripeKey);
          await stripe.refunds.create({ payment_intent: chargeId, reason: "requested_by_customer" });
          console.log("[ad-creator] refunded chargeId after total failure:", chargeId);
        } catch (refErr) { console.warn("[ad-creator] refund failed:", refErr.message); }
      }
      return res.status(502).json({ error: "All variants failed to generate. Your card was refunded. Try again." });
    }

    // ── Save successful variants to image_library with product tag ───────────
    try {
      db.exec("CREATE TABLE IF NOT EXISTS image_library (id TEXT PRIMARY KEY, user_id TEXT, url TEXT, prompt TEXT, provider TEXT, product_id TEXT, ad_style TEXT, platform TEXT, charge_id TEXT, created_at TEXT)");
      // Add charge_id column if missing
      try {
        const cols = db.prepare("PRAGMA table_info(image_library)").all().map(c => c.name);
        if (!cols.includes("charge_id")) db.exec("ALTER TABLE image_library ADD COLUMN charge_id TEXT");
      } catch (_) {}
      const insert = db.prepare("INSERT INTO image_library (id, user_id, url, prompt, provider, product_id, ad_style, platform, charge_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))");
      successful.forEach((v, i) => {
        const id = "ad_" + Date.now() + "_" + i + "_" + Math.random().toString(36).slice(2, 6);
        // Only persist http URLs (data URLs are too large for SQLite)
        if (!v.url.startsWith("data:")) {
          insert.run(id, req.userId, v.url, fullPrompt.slice(0, 500), v.provider, productId, adStyle, platform, chargeId);
        }
      });
    } catch (libErr) { console.warn("[ad-creator] library save:", libErr.message); }

    // ── Track usage (1 unit per successful variant) — auto-bills overage ─────
    try {
      if (global.mineTrackUsage && successful.length > 0) {
        // soulId branch consumes soulImages; everything else consumes images
        const usageMetric = soulId ? "soulImages" : "images";
        for (let i = 0; i < successful.length; i++) {
          global.mineTrackUsage(db, req.userId, usageMetric, 1);
        }
      }
    } catch(usageErr) { console.warn("[ad-creator] usage tracking:", usageErr.message); }

    res.json({
      ok: true,
      variants: successful,
      product: { id: product.id, name: product.name },
      style: style.name,
      platform: plat.name,
      promptUsed: fullPrompt,
      requested: n,
      delivered: successful.length,
      chargeId,
      totalCharged: chargeId ? batchTotal : 0,
      currency: "usd",
      warnings: successful.filter(v => v.warning).map(v => v.warning),
    });
  } catch (e) {
    console.error("image/generate-ad:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai-agent/image/ad-presets — frontend asks for available styles + platforms
router.get("/image/ad-presets", auth, (req, res) => {
  res.json({
    styles: Object.entries(AD_STYLE_PRESETS).map(([k, v]) => ({ id: k, name: v.name })),
    platforms: Object.entries(AD_PLATFORM_PRESETS).map(([k, v]) => ({ id: k, name: v.name, aspectRatio: v.aspectRatio })),
  });
});

// POST /api/ai-agent/image/replace — Swap an image in a site's HTML with optional style
router.post("/image/replace", auth, async (req, res) => {
  try {
    const db = getDb();
    const { siteId, oldSrc, newSrc, style } = req.body || {};
    if (!siteId || !oldSrc || !newSrc) {
      return res.status(400).json({ error: "siteId, oldSrc, newSrc required" });
    }

    // Load current site HTML
    const site = db.prepare("SELECT * FROM sites WHERE id=? AND user_id=?").get(siteId, req.user.id);
    if (!site) return res.status(404).json({ error: "Site not found" });

    let html = site.html || "";
    if (!html) return res.status(400).json({ error: "Site has no HTML to edit" });

    // Replace the old src with the new one
    // Also apply optional inline style (border-radius, box-shadow)
    const defaultStyle = "border-radius:16px"; // TAKEOVA's rounded default
    const applyStyle = style || defaultStyle;

    // Match both <img src="..." ...> and replace the tag entirely with the new src + style
    const escOld = oldSrc.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const imgRegex = new RegExp(`(<img[^>]*)src=["']${escOld}["']([^>]*)>`, "gi");

    let replaceCount = 0;
    html = html.replace(imgRegex, (match, before, after) => {
      replaceCount++;
      // Strip any existing style attr (so we apply fresh)
      let cleaned = (before + after).replace(/\s*style=["'][^"']*["']/gi, "");
      // Ensure no double class — just append inline style
      return `${cleaned.trimEnd()} src="${newSrc}" style="${applyStyle}">`;
    });

    if (replaceCount === 0) {
      // Fallback: try simpler substring replacement
      if (html.includes(oldSrc)) {
        html = html.replace(oldSrc, newSrc);
        replaceCount = 1;
      }
    }

    // Save back
    db.prepare("UPDATE sites SET html=?, updated_at=datetime('now') WHERE id=?").run(html, siteId);

    res.json({
      ok: true,
      html,
      replaced: replaceCount,
      style: applyStyle
    });
  } catch (e) {
    console.error("image/replace error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Brand Soul persistence (2026-06-11): saved Soul ID auto-applies to premium image generation ───
router.get("/soul-id/current", auth, (req, res) => {
  try {
    const db = require("../db/init").getDb();
    db.prepare("CREATE TABLE IF NOT EXISTS brand_souls (user_id TEXT PRIMARY KEY, soul_id TEXT, name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
    const row = db.prepare("SELECT soul_id, name, created_at FROM brand_souls WHERE user_id=?").get(req.userId);
    res.json({ soul: row || null });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});
router.post("/soul-id/save", auth, (req, res) => {
  try {
    const { soulId, name } = req.body || {};
    if (!soulId) return res.json({ success: false, error: "soulId required" });
    const db = require("../db/init").getDb();
    db.prepare("CREATE TABLE IF NOT EXISTS brand_souls (user_id TEXT PRIMARY KEY, soul_id TEXT, name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
    db.prepare("INSERT OR REPLACE INTO brand_souls (user_id, soul_id, name) VALUES (?,?,?)").run(req.userId, String(soulId), String(name || "Brand"));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── AUTOPILOT (2026-06-11): AI proposes concrete moves; owner approves; mine-control's production tools execute ───
function _apDb(){ const db=require("../db/init").getDb(); db.prepare("CREATE TABLE IF NOT EXISTS autopilot_actions (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, input_json TEXT, title TEXT, reason TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, executed_at TEXT)").run(); return db; }
router.post("/autopilot/scan", auth, async (req, res) => {
  try {
    const db=_apDb(); const u=req.userId; const M={};
    try{ const r=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM invoices WHERE user_id=? AND status NOT IN ('paid','draft','void')").get(u); M.unpaid_invoices=r.c; M.unpaid_total=Math.round(r.s); }catch(e){}
    try{ const r=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE user_id=? AND created_at>=datetime('now','-7 day')").get(u); M.orders_7d=r.c; M.revenue_7d=Math.round(r.s); }catch(e){}
    try{ M.leads_7d=db.prepare("SELECT COUNT(*) c FROM leads WHERE user_id=? AND created_at>=datetime('now','-7 day')").get(u).c; }catch(e){}
    try{ M.contacts=db.prepare("SELECT COUNT(*) c FROM contacts WHERE user_id=?").get(u).c; }catch(e){}
    const Anthropic=require("@anthropic-ai/sdk"); const client=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY});
    const sys='You are MINE Autopilot. Given business metrics, return ONLY a JSON array (max 3) of high-impact next moves. Each item: {"type":"chase_invoices"|"create_discount"|"note","title":"short imperative","reason":"one concrete sentence tied to the metrics","input":{}}. Rules: chase_invoices ONLY if unpaid_invoices>0, with input {"confirm":true}. create_discount only when it would plausibly lift slow sales, input {"percent_off":<5-20>,"code":"<LETTERS+2 digits>"}. note = pure advice, input {}. No markdown, no prose outside the JSON.';
    const msg=await client.messages.create({model:"claude-sonnet-4-6",max_tokens:700,system:sys,messages:[{role:"user",content:"Metrics: "+JSON.stringify(M)}]});
    let txt=(msg.content&&msg.content[0]&&msg.content[0].text||"").trim().replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
    let acts=[]; try{ acts=JSON.parse(txt); }catch(e){ acts=[]; }
    if(!Array.isArray(acts)) acts=[];
    const { v4: uuid }=require("uuid"); const out=[];
    for(const a of acts.slice(0,3)){
      if(!a||!a.type||!["chase_invoices","create_discount","note"].includes(a.type)) continue;
      const dup=db.prepare("SELECT 1 FROM autopilot_actions WHERE user_id=? AND type=? AND status='pending'").get(u,a.type);
      if(dup) continue;
      const id=uuid();
      db.prepare("INSERT INTO autopilot_actions (id,user_id,type,input_json,title,reason) VALUES (?,?,?,?,?,?)").run(id,u,a.type,JSON.stringify(a.input||{}),String(a.title||a.type).slice(0,90),String(a.reason||"").slice(0,200));
      out.push(id);
    }
    res.json({ success:true, created:out.length, metrics:M });
  } catch(e){ console.error("[autopilot/scan]",e.message); res.status(500).json({error:"Scan failed: "+e.message}); }
});
router.get("/autopilot", auth, (req,res)=>{ try{
  const db=_apDb();
  const pending=db.prepare("SELECT * FROM autopilot_actions WHERE user_id=? AND status='pending' ORDER BY created_at DESC LIMIT 6").all(req.userId);
  const recent=db.prepare("SELECT * FROM autopilot_actions WHERE user_id=? AND status!='pending' ORDER BY executed_at DESC LIMIT 5").all(req.userId);
  res.json({ pending, recent });
}catch(e){ res.status(500).json({error:"An internal error occurred"}); }});
router.post("/autopilot/:id/approve", auth, async (req,res)=>{ try{
  const db=_apDb();
  const row=db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND user_id=? AND status='pending'").get(req.params.id, req.userId);
  if(!row) return res.json({ success:false, error:"Action not found or already handled" });
  let status="executed", result="";
  if(row.type==="note"){ result="Noted."; }
  else {
    try { const mc=require("./mine-control"); const out=await mc.executeTool(db, req.userId, row.type, JSON.parse(row.input_json||"{}"));
      result=typeof out==="string"?out:JSON.stringify(out); }
    catch(e){ status="failed"; result=e.message; }
  }
  db.prepare("UPDATE autopilot_actions SET status=?, result=?, executed_at=datetime('now') WHERE id=?").run(status, String(result).slice(0,800), row.id);
  res.json({ success: status==="executed", status, result: String(result).slice(0,300) });
}catch(e){ console.error("[autopilot/approve]",e.message); res.status(500).json({error:"An internal error occurred"}); }});
router.post("/autopilot/:id/dismiss", auth, (req,res)=>{ try{
  const db=_apDb();
  db.prepare("UPDATE autopilot_actions SET status='dismissed', executed_at=datetime('now') WHERE id=? AND user_id=? AND status='pending'").run(req.params.id, req.userId);
  res.json({ success:true });
}catch(e){ res.status(500).json({error:"An internal error occurred"}); }});

// 🔗 RELAY: trigger a multi-agent play (gated by Autopilot autonomy)
router.get("/relay/plays", auth, (req, res) => {
  try {
    const mc = require("./mine-control");
    const plays = Object.keys(mc.RELAY_PLAYS || {});
    const labels = {
      new_customer_welcome: "New customer → invoice + welcome design",
      winback_with_design: "At-risk customer → design + send win-back",
      seasonal_campaign: "Seasonal → design + post + email campaign",
      recover_revenue: "Recover revenue → chase overdue money",
      reengage_and_quote: "Warm lead → follow up + draft a quote"
    };
    const db = getDb(); const userId = req.userId;
    const CORE = new Set(["mine_control","coo","bookkeeper"]);
    const hiredRoles = new Set();
    try { db.prepare("SELECT role FROM ai_employees WHERE user_id=? AND enabled=1").all(userId).forEach(r=>hiredRoles.add(r.role)); } catch(_e) {}
    const agentsFor = (id) => { try { const steps = mc.RELAY_PLAYS[id]({}); return [...new Set(steps.map(s=>s.agent))]; } catch(_e) { return []; } };
    res.json({ plays: plays.map(p => {
      const agents = agentsFor(p);
      const missing = agents.filter(a => !CORE.has(a) && !hiredRoles.has(a));
      return { id: p, label: labels[p] || p, agents, missing, ready: missing.length === 0 };
    }) });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});
router.post("/relay/run", auth, async (req, res) => {
  try {
    const db = getDb(); const userId = req.userId;
    const { play, ctx } = req.body || {};
    if (!play) return res.status(400).json({ error: "play required" });
    // autonomy from the user's autopilot/owner setting (reuse ai-employees engine if present)
    let mode = "queued";
    try {
      const ai = require("./ai-employees");
      const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? ORDER BY (role='mine_control') DESC LIMIT 1").get(userId);
      const m = ai.getAutonomyMode ? ai.getAutonomyMode(emp || {}) : "suggest";
      mode = (m === "auto") ? "auto" : "queued";
    } catch(_e) {}
    const mc = require("./mine-control");
    const out = await mc.runRelay(db, userId, play, ctx || {}, mode);
    res.json(out);
  } catch (e) { console.error("[relay/run]", e.message); res.status(500).json({ error: "Relay failed: " + e.message }); }
});

module.exports = router;
