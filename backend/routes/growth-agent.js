/**
 * TAKEOVA Growth Agent — $89/month add-on
 *
 * An autonomous AI agent that runs nightly, analyses your business data,
 * and TAKES ACTIONS automatically to hit your revenue goal:
 *   • Creates flash sales when revenue is behind pace
 *   • Emails lapsed customers with personalised re-engagement
 *   • Boosts loyalty points for at-risk members
 *   • Posts motivational social content when engagement drops
 *   • Chases overdue invoices automatically
 *   • Sends a morning briefing of everything it did
 *
 * Routes:
 *   GET  /api/growth-agent/status          — subscription status + last run
 *   GET  /api/growth-agent/config          — goals + toggle settings
 *   PUT  /api/growth-agent/config          — update goals/settings
 *   GET  /api/growth-agent/log             — action history
 *   POST /api/growth-agent/run-now         — manual trigger (admin / testing)
 *   POST /api/growth-agent/activate        — called by Stripe webhook on purchase
 */

"use strict";
const express    = require("express");
let _gaAiCalls = 0; // Growth Agent per-run AI-call counter (metering)
// ── Growth Agent billing constants ──────────────────────────────────────────
// Flat $89/mo subscription covers up to MONTHLY_RUN_CAP nightly runs.
// Each run may call Claude up to AI_CALL_CAP times before overage kicks in.
// Overage is billed at AI_OVERAGE_RATE per additional Claude call.
const MONTHLY_RUN_CAP   = 31;   // one run per calendar day
const AI_CALL_CAP       = 50;   // Claude calls included per run
const AI_OVERAGE_RATE   = 0.50; // $ per extra Claude call above cap
const router     = express.Router();
const { v4: uuid } = require("uuid");
const { getDb }  = require("../db/init");
const { auth, adminOnly } = require("../middleware/auth");
const { getSetting } = require("./integrations");
// Per-tenant agent outcome tracking (safe-loaded; no-op if enhancements unmounted)
let _enh; try { _enh = require("./ai-employees-enhancements"); } catch (_) { _enh = null; }
const recordOutcome = (_enh && _enh.recordOutcome) ? _enh.recordOutcome : function(){};

// ── DB setup ────────────────────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS growth_agent_config (
      user_id         TEXT PRIMARY KEY,
      enabled         INTEGER DEFAULT 1,
      monthly_goal    REAL    DEFAULT 0,
      actions_enabled TEXT    DEFAULT '["flash_sale","reengage","loyalty_boost","social_post","invoice_chase","digest"]',
      last_run_at     TEXT,
      last_run_status TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS growth_agent_log (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      run_date    TEXT NOT NULL,
      action_type TEXT NOT NULL,
      description TEXT,
      result      TEXT,
      status      TEXT DEFAULT 'success',
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ga_log_user ON growth_agent_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_ga_log_date ON growth_agent_log(run_date);
  `);
  // Migrations
  try { db.exec("ALTER TABLE growth_agent_config ADD COLUMN actions_enabled TEXT DEFAULT '[]'"); } catch(e) {}
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function callAI(prompt, system, maxTokens = 600) {
    _gaAiCalls++;
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

function logAction(db, userId, runDate, actionType, description, result, status = "success") {
  try {
    db.prepare("INSERT INTO growth_agent_log (id, user_id, run_date, action_type, description, result, status) VALUES (?,?,?,?,?,?,?)")
      .run(uuid(), userId, runDate, actionType, description, JSON.stringify(result), status);
    try { recordOutcome(uuid(), userId, 'growth', actionType, status === 'success' ? 'success' : 'failed', (result && typeof result === 'object') ? result : {}); } catch(_){}
  } catch(e) {}
}

async function autoEmail(userId, toEmail, subject, bodyHtml) {
  try {
    const db = getDb();
    const sgKey   = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    const smtpHost = getSetting("SMTP_HOST") || process.env.SMTP_HOST;
    const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "noreply@takeova.ai";
    const user    = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
    const bizName = user?.name || "MINE";

    if (sgKey) {
      const fetch = (await import("node-fetch")).default;
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${sgKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ personalizations: [{ to: [{ email: toEmail }] }], from: { email: fromEmail, name: bizName }, subject, content: [{ type: "text/html", value: bodyHtml }] })
      });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    } else if (smtpHost) {
      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: parseInt(getSetting("SMTP_PORT") || process.env.SMTP_PORT) || 587,
        auth: { user: getSetting("SMTP_USER") || process.env.SMTP_USER, pass: getSetting("SMTP_PASS") || process.env.SMTP_PASS }
      });
      await transporter.sendMail({ from: `"${bizName}" <${fromEmail}>`, to: toEmail, subject, html: bodyHtml });
    }
  } catch(e) {
    console.error("[GrowthAgent] Email failed:", e?.message);
  }
}

// ── Core agent logic — dynamic reasoning + tool-calling loop ─────────────────

// ── Web search: fetch real market context before reasoning ──────────────────
// Makes 1-2 targeted searches so Claude knows what's actually happening in the
// user's industry tonight — competitor promos, trending topics, market shifts.
async function fetchMarketContext(industry, businessName, topProducts, apiKey) {
  try {
    const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
    const productHint = topProducts?.length ? topProducts[0].name : "";
    const queries = [
      `${industry} business promotions trends ${new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" })}`,
      productHint ? `${productHint} ${industry} customer demand trends` : `small business ${industry} marketing ideas`,
    ];

    const results = [];
    for (const query of queries) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 400,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: "user", content: `Search for: ${query}. Return a 2-3 sentence summary of the most relevant findings for a small business owner. Be specific and factual.` }],
          }),
        });
        const d = await r.json();
        const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
        if (text) results.push(text);
      } catch(e) { console.error("[/growth-agent.js]", e.message || e); }
    }

    return results.length ? results.join(" | ") : null;
  } catch(e) {
    return null;
  }
}

async function runAgentForUser(userId, db) {
  // ── Plan-cap metering (margin protection): 1 run = 1 growthAgentRuns unit ──
  if (typeof global.mineCheckUsage === "function") {
    try {
      const _u = global.mineCheckUsage(db, userId, "growthAgentRuns");
      if (_u && _u.blocked) {
        console.log("[GrowthAgent] run blocked — growthAgentRuns cap reached for", userId);
        try { db.prepare("INSERT INTO growth_agent_log (user_id, level, message, created_at) VALUES (?, 'info', ?, datetime('now'))").run(userId, "Monthly Growth Agent run allowance reached — upgrade your plan for more."); } catch(_e){}
        return;
      }
    } catch(_e){}
  }
  _gaAiCalls = 0; // per-run AI-call counter (module-level; runs execute sequentially)
  if (typeof global.mineTrackUsage === "function") { try { global.mineTrackUsage(db, userId, "growthAgentRuns", 1); } catch(_e){} }
  const _trackGaAi = () => { if (typeof global.mineTrackUsage === "function" && _gaAiCalls > 0) { try { global.mineTrackUsage(db, userId, "growthAgentAI", _gaAiCalls); } catch(_e){} } };

  const today = new Date().toISOString().split("T")[0];
  const now   = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const actions = [];

  const cfg = db.prepare("SELECT * FROM growth_agent_config WHERE user_id = ?").get(userId);
  if (!cfg || !cfg.enabled) return [];

  // ── Daily guard: only one run per user per calendar day ──────────────────
  try {
    db.exec("CREATE TABLE IF NOT EXISTS growth_agent_log (id TEXT PRIMARY KEY, user_id TEXT, run_date TEXT, actions_json TEXT, summary TEXT, status TEXT DEFAULT \'success\', created_at TEXT DEFAULT (datetime(\'now\')))");
    const ranToday = db.prepare("SELECT 1 FROM growth_agent_log WHERE user_id = ? AND run_date = ? AND status = \'success\' LIMIT 1").get(userId, today);
    if (ranToday) {
      return [];
    }
  } catch(e) { /* table may not exist yet — proceed */ }

  // Usage tracking
  let aiCallsThisRun = 0;

  // Track monthly run cap
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const runCheck = global.mineCheckUsage(db, userId, "growthAgentRuns");
    if (runCheck.blocked) {
      return [];
    }
  }
  if (typeof global !== "undefined" && global.mineTrackUsage) {
    global.mineTrackUsage(db, userId, "growthAgentRuns");
  }

  const enabledActions = JSON.parse(cfg.actions_enabled || "[]");
  const goal = parseFloat(cfg.monthly_goal) || 0;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return [];

  // ── STEP 1: Gather all business data for the reasoning snapshot ───────────
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000).toISOString().split("T")[0];
  const sixtyDaysAgo  = new Date(Date.now() - 60 * 24 * 3600000).toISOString().split("T")[0];
  const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 3600000).toISOString().split("T")[0];

  const revenue      = db.prepare("SELECT COALESCE(SUM(total),0) as rev FROM orders WHERE user_id = ? AND DATE(created_at) >= ?").get(userId, monthStart);
  const ordersYd     = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total),0) as rev FROM orders WHERE user_id = ? AND DATE(created_at) = ?").get(userId, yesterday);
  const bookingsYd   = db.prepare("SELECT COUNT(*) as n FROM bookings WHERE user_id = ? AND date = ?").get(userId, yesterday);
  const newContacts  = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE user_id = ? AND DATE(created_at) = ?").get(userId, yesterday);
  const unpaidInv    = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total),0) as t FROM invoices WHERE user_id = ? AND status IN ('sent','unpaid','overdue')").get(userId);
  const overdueInv   = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total),0) as t FROM invoices WHERE user_id = ? AND status IN ('sent','unpaid','overdue') AND due_date < date('now') AND due_date IS NOT NULL").get(userId);
  const lapsedCount  = db.prepare(`SELECT COUNT(DISTINCT customer_email) as n FROM orders WHERE user_id = ? GROUP BY customer_email HAVING MAX(created_at) < ? AND MAX(created_at) >= ?`).all(userId, thirtyDaysAgo, sixtyDaysAgo).length;

  let atRiskLoyalty = 0;
  try {
    atRiskLoyalty = db.prepare(`SELECT COUNT(*) as n FROM customer_accounts ca LEFT JOIN orders o ON o.customer_email = ca.email AND o.user_id = ? WHERE ca.loyalty_points > 0 GROUP BY ca.id HAVING COALESCE(MAX(o.created_at), ca.created_at) < ?`).all(userId, twentyOneDaysAgo).length;
  } catch(e) {}

  let topProducts = [];
  try {
    // orders.items is stored as JSON array — extract top products from orders
      const recentOrders = db.prepare("SELECT items, total FROM orders WHERE user_id = ? AND status='paid' AND DATE(created_at) >= ?").all(userId, monthStart);
      const productMap = {};
      for (const ord of recentOrders) {
        try {
          const items = JSON.parse(ord.items || '[]');
          for (const item of items) {
            const n = item.name || item.desc || 'Product';
            if (!productMap[n]) productMap[n] = { name: n, units: 0, rev: 0 };
            productMap[n].units += (item.qty || item.quantity || 1);
            productMap[n].rev += (item.price || 0) * (item.qty || item.quantity || 1);
          }
        } catch(e) {}
      }
      topProducts = Object.values(productMap).sort((a,b) => b.rev - a.rev).slice(0, 5);
  } catch(e) {}

  let slowProducts = [];
  try {
    slowProducts = Object.values(productMap).sort((a,b) => a.units - b.units).slice(0, 5);
  } catch(e) {}

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth  = now.getDate();
  const paceTarget  = goal * (dayOfMonth / daysInMonth);
  const currentRev  = parseFloat(revenue?.rev || 0);
  const revBehindPct = paceTarget > 0 ? Math.round((1 - currentRev / paceTarget) * 100) : 0;

  const snapshot = {
    date: today,
    businessName: user.name,
    monthlyGoal: goal,
    currentMonthRevenue: currentRev,
    revenuePaceTarget: Math.round(paceTarget),
    revenueBehindByPercent: revBehindPct,
    yesterdayOrders: ordersYd?.n || 0,
    yesterdayRevenue: Number(ordersYd?.rev || 0),
    yesterdayBookings: bookingsYd?.n || 0,
    newContactsYesterday: newContacts?.n || 0,
    unpaidInvoices: { count: unpaidInv?.n || 0, total: Number(unpaidInv?.t || 0) },
    overdueInvoices: { count: overdueInv?.n || 0, total: Number(overdueInv?.t || 0) },
    lapsedCustomers30to60Days: lapsedCount,
    atRiskLoyaltyMembers: atRiskLoyalty,
    topSellingProducts: topProducts,
    slowMovingProducts: slowProducts,
    enabledActions,
  };

  // ── STEP 1b: Fetch real-world market context via web search ─────────────────
  // Runs before the reasoning step so Claude knows what's happening in the
  // user's industry tonight — not just their internal numbers.
  let marketContext = null;
  try {
    const industryLabel = (() => {
      try { return db.prepare("SELECT category FROM sites WHERE user_id = ? LIMIT 1").get(userId)?.category || "small business"; } catch(e) { return "small business"; }
    })();
    marketContext = await fetchMarketContext(industryLabel, user.name, topProducts, apiKey);
    if (marketContext) {
      snapshot.marketContext = marketContext;
    }
  } catch(e) { /* non-fatal */ }

  // ── STEP 2: Claude reasons over the snapshot, decides what to do ──────────
  // Define tools Claude can call — one per action type
  const agentTools = [
    {
      name: "run_flash_sale",
      description: "Create a flash sale discount code and email it to all customers. Use when revenue is behind monthly pace by 20%+.",
      input_schema: {
        type: "object",
        properties: {
          discount_pct: { type: "number", description: "Discount percentage (10 or 20)" },
          reason: { type: "string", description: "Why you're triggering this sale" },
          target_product: { type: "string", description: "Optional: specific product to promote (leave blank for all)" }
        },
        required: ["discount_pct", "reason"]
      }
    },
    {
      name: "reengage_lapsed_customers",
      description: "Send personalised re-engagement emails to customers who haven't bought in 30-60 days.",
      input_schema: {
        type: "object",
        properties: {
          message_angle: { type: "string", description: "The angle for the email — e.g. 'we miss you', 'exclusive offer', 'new products'" },
          reason: { type: "string", description: "Why you're sending re-engagement now" }
        },
        required: ["message_angle", "reason"]
      }
    },
    {
      name: "boost_loyalty_points",
      description: "Award bonus loyalty points to at-risk members who haven't purchased in 21+ days.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why you're running a loyalty boost now" }
        },
        required: ["reason"]
      }
    },
    {
      name: "chase_overdue_invoices",
      description: "Send chaser emails to clients with overdue unpaid invoices.",
      input_schema: {
        type: "object",
        properties: {
          urgency: { type: "string", enum: ["friendly", "firm", "urgent"], description: "Tone based on how long overdue" },
          reason: { type: "string", description: "Why you're chasing now" }
        },
        required: ["urgency", "reason"]
      }
    },
    {
      name: "send_digest",
      description: "Send the morning briefing email summarising everything the agent did and key business metrics.",
      input_schema: {
        type: "object",
        properties: {
          actions_taken: { type: "array", items: { type: "string" }, description: "List of actions taken this run" }
        },
        required: ["actions_taken"]
      }
    }
  ];

  // Filter tools to only what user has enabled
  const actionToolMap = {
    flash_sale: "run_flash_sale",
    reengage: "reengage_lapsed_customers",
    loyalty_boost: "boost_loyalty_points",
    invoice_chase: "chase_overdue_invoices",
    digest: "send_digest"
  };
  const allowedToolNames = new Set([
    ...enabledActions.map(a => actionToolMap[a]).filter(Boolean),
    "send_digest" // always allow digest
  ]);
  const filteredTools = agentTools.filter(t => allowedToolNames.has(t.name));

  // ── STEP 3: Run the tool-calling loop ─────────────────────────────────────
  const Anthropic = require("@anthropic-ai/sdk");
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are the TAKEOVA Growth Agent — an autonomous business AI that runs every night at 4am.

Your job is to analyse this business's current data and take targeted actions to protect and grow revenue.

RULES:
- Think carefully about what this data actually means before acting
- Only trigger actions that are genuinely warranted — don't run flash sales if revenue is on track
- Prioritise money at risk first (overdue invoices), then revenue recovery (flash sale if behind), then growth (re-engagement, loyalty)
- For slow-moving products, target flash sales at those specific items rather than the whole catalogue
- Always end by calling send_digest to summarise what you did
- Be decisive. If the data warrants action, take it. Don't hedge.`;

  let messages = [{
    role: "user",
    content: `Here is the business snapshot for tonight's run:\n\n${JSON.stringify(snapshot, null, 2)}\n\nAnalyse this data and take the right actions. Remember: only act where the data genuinely warrants it.`
  }];

  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    aiCallsThisRun++;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      // Extended thinking: agent reasons deeply before deciding which actions to take.
      // This is the most important call of the night — quality of reasoning here
      // directly determines revenue impact. Budget 6k tokens for thinking.
      thinking: { type: "enabled", budget_tokens: 6000 },
      system: systemPrompt,
      tools: filteredTools,
      messages
    });

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        let result;
        try {
          result = await executeGrowthTool(db, userId, user, toolUse.name, toolUse.input, today, actions, autoEmail, logAction, uuid, aiCallsThisRun);
        } catch(e) {
          result = { error: e.message };
          console.error(`[GrowthAgent] Tool ${toolUse.name} failed:`, e.message);
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      }

      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults }
      ];
      continue;
    }

    break;
  }

  // ── Bill overage AI calls ─────────────────────────────────────────────────
  if (aiCallsThisRun > AI_CALL_CAP) {
    const overageCount = aiCallsThisRun - AI_CALL_CAP;
    if (typeof global !== "undefined" && global.mineTrackUsage) {
      global.mineTrackUsage(db, userId, "growthAgentAI", overageCount);
    } else {
      // Admin bypass: skip overage tracking
      if (typeof global.mineIsAdmin === "function" && global.mineIsAdmin(db, userId)) { /* admin: no tracking */ }
      else try {
        const period = today.slice(0, 7);
        db.exec("CREATE TABLE IF NOT EXISTS overage_charges (id TEXT PRIMARY KEY, user_id TEXT, metric TEXT, quantity REAL, unit_price REAL, total REAL, period TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");
        db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period) VALUES (?,?,?,?,?,?,?)")
          .run(uuid(), userId, "growthAgentAI", overageCount, AI_OVERAGE_RATE, overageCount * AI_OVERAGE_RATE, period);
      } catch(e) {}
    }
  }

  db.prepare("UPDATE growth_agent_config SET last_run_at = datetime('now'), last_run_status = ? WHERE user_id = ?")
    .run(actions.length > 0 ? `${actions.length} actions taken` : "no actions needed", userId);

  return actions;
}

// ── Tool executor — called by the agent loop ──────────────────────────────────
async function executeGrowthTool(db, userId, user, toolName, input, today, actions, autoEmail, logAction, uuid, aiCallsThisRun) {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  if (toolName === "run_flash_sale") {
    const discountPct = Math.min(Math.max(Math.round(input.discount_pct), 5), 30); // clamp 5-30%
    const code = `FLASH${discountPct}${Date.now().toString().slice(-4)}`;

    // Write targeted copy using AI
    const copy = await callAI(
      `Business: ${user.name}. ${input.reason}. ${input.target_product ? `Promoting: ${input.target_product}.` : "All products."}`,
      `You are a conversion copywriter. Write a flash sale email. Return JSON only: {"subject":"...","body":"..."}`,
      400
    );
    aiCallsThisRun++;
    const parsed = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(copy.replace(/```json|```/g, "").trim());

    try {
      db.exec("CREATE TABLE IF NOT EXISTS discount_codes (id TEXT PRIMARY KEY, user_id TEXT, code TEXT UNIQUE, type TEXT, value REAL, uses_remaining INTEGER, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')))");
      db.prepare("INSERT OR IGNORE INTO discount_codes (id, user_id, code, type, value, uses_remaining, expires_at) VALUES (?,?,?,?,?,?,?)")
        .run(uuid(), userId, code, "percent", discountPct, 50, new Date(Date.now() + 48 * 3600000).toISOString().split("T")[0]);
    } catch(e) {}

    const customers = db.prepare("SELECT DISTINCT customer_email FROM orders WHERE user_id = ? AND customer_email IS NOT NULL AND customer_email != '' GROUP BY customer_email").all(userId);
    let sent = 0;
    for (const c of customers.slice(0, 100)) {
      if (!c.customer_email) continue;
      await autoEmail(userId, c.customer_email, parsed.subject,
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#2563EB">⚡ Flash Sale — ${discountPct}% Off${input.target_product ? ` on ${input.target_product}` : ""}</h2>
          <p>${parsed.body}</p>
          <p><strong>Code: <span style="background:#2563EB;color:#fff;padding:4px 10px;border-radius:6px;font-size:18px">${code}</span></strong></p>
          <p style="color:#94A3B8;font-size:12px">Expires in 48 hours. Limited to first 50 uses.</p>
        </div>`);
      sent++;
    }
    logAction(db, userId, today, "flash_sale", input.reason, { code, emailsSent: sent, discountPct, targetProduct: input.target_product || "all" });
    actions.push({ type: "flash_sale", detail: `${discountPct}% flash sale sent to ${sent} customers (code: ${code})${input.target_product ? ` — targeting ${input.target_product}` : ""}` });
    return { success: true, emailsSent: sent, code };
  }

  if (toolName === "reengage_lapsed_customers") {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000).toISOString().split("T")[0];
    const sixtyDaysAgo  = new Date(Date.now() - 60 * 24 * 3600000).toISOString().split("T")[0];
    const lapsed = db.prepare(`
      SELECT customer_email, customer_name, MAX(created_at) as last_order, COUNT(*) as order_count, SUM(total) as total_spent
      FROM orders WHERE user_id = ?
      GROUP BY customer_email
      HAVING last_order < ? AND last_order >= ? AND customer_email IS NOT NULL
      LIMIT 30
    `).all(userId, thirtyDaysAgo, sixtyDaysAgo);

    let sent = 0;
    for (const c of lapsed.slice(0, 20)) {
      const reCopy = await callAI(
        `Customer: ${c.customer_name || c.customer_email}. Last ordered: ${c.last_order}. Orders: ${c.order_count}. Spent: $${c.total_spent}. Business: ${user.name}. Angle: ${input.message_angle}.`,
        `Write a warm, personal re-engagement email. Sound human, not like marketing. Return JSON: {"subject":"...","opening":"...","cta":"..."}`,
        300
      );
      aiCallsThisRun++;
      const re = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(reCopy.replace(/```json|```/g, "").trim());
      await autoEmail(userId, c.customer_email, re.subject,
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <p>Hi ${c.customer_name || "there"},</p>
          <p>${re.opening}</p>
          <p>${re.cta}</p>
          <p>— ${user.name}</p>
        </div>`);
      sent++;
    }
    logAction(db, userId, today, "reengage", input.reason, { count: sent, angle: input.message_angle });
    actions.push({ type: "reengage", detail: `${sent} lapsed customer re-engagement emails sent (${input.message_angle})` });
    return { success: true, emailsSent: sent };
  }

  if (toolName === "boost_loyalty_points") {
    const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 3600000).toISOString().split("T")[0];
    let atRisk = [];
    try {
      atRisk = db.prepare(`
        SELECT ca.id, ca.email, ca.name, ca.loyalty_points, ca.total_spent
        FROM customer_accounts ca
        LEFT JOIN orders o ON o.customer_email = ca.email AND o.user_id = ?
        WHERE ca.loyalty_points > 0
        GROUP BY ca.id
        HAVING COALESCE(MAX(o.created_at), ca.created_at) < ?
        LIMIT 20
      `).all(userId, twentyOneDaysAgo);
    } catch(e) {}

    let boosted = 0;
    for (const c of atRisk) {
      const bonusPoints = Math.max(50, Math.round(c.loyalty_points * 0.1));
      db.prepare("UPDATE customer_accounts SET loyalty_points = loyalty_points + ? WHERE id = ?").run(bonusPoints, c.id);
      try {
        db.prepare("INSERT INTO loyalty_transactions (id, customer_id, type, points, balance_after, created_at) VALUES (?,?,?,?,?,datetime('now'))")
          .run(uuid(), c.id, "agent_bonus", bonusPoints, c.loyalty_points + bonusPoints);
      } catch(e) {}
      if (c.email) {
        await autoEmail(userId, c.email, `🎁 ${bonusPoints} bonus points added to your account!`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#2563EB">🎁 ${bonusPoints} bonus points!</h2>
            <p>Hi ${c.name || "there"}, we've added <strong>${bonusPoints} loyalty points</strong> to your account — use them on your next order.</p>
            <p>You now have <strong>${c.loyalty_points + bonusPoints} points</strong>.</p>
          </div>`);
      }
      boosted++;
    }
    logAction(db, userId, today, "loyalty_boost", input.reason, { count: boosted });
    if (boosted > 0) actions.push({ type: "loyalty_boost", detail: `Loyalty bonus awarded to ${boosted} at-risk customers` });
    return { success: true, boosted };
  }

  if (toolName === "chase_overdue_invoices") {
    const overdue = db.prepare(`
      SELECT * FROM invoices WHERE user_id = ?
      AND status IN ('sent','unpaid','overdue')
      AND due_date < date('now') AND due_date IS NOT NULL AND due_date != ''
      AND reminder_sent IS NOT NULL
      AND (COALESCE(last_chased_at, date(reminder_sent)) < date('now', '-3 days'))
      LIMIT 15
    `).all(userId);

    let chased = 0;
    for (const inv of overdue) {
      if (!inv.client_email) continue;
      const daysOverdue = Math.floor((Date.now() - new Date(inv.due_date)) / 86400000);
      const tone = input.urgency === "urgent" || daysOverdue > 14 ? "urgent" : input.urgency === "firm" || daysOverdue > 7 ? "firm" : "friendly";
      const subject = tone === "urgent"
        ? `URGENT: Invoice #${inv.invoice_number} is ${daysOverdue} days overdue — immediate payment required`
        : tone === "firm"
        ? `Invoice #${inv.invoice_number} — Payment now ${daysOverdue} days overdue`
        : `Friendly reminder: Invoice #${inv.invoice_number} is due`;
      const body = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <p>Hi ${inv.client_name || "there"},</p>
        <p>Invoice <strong>#${inv.invoice_number}</strong> for <strong>$${Number(inv.total).toFixed(2)}</strong> was due on ${inv.due_date} and remains unpaid (${daysOverdue} days overdue).</p>
        ${tone === "urgent" ? "<p><strong>Please arrange payment immediately to avoid further action.</strong></p>" : tone === "firm" ? "<p>Please arrange payment at your earliest convenience.</p>" : "<p>If you've already sent payment, please ignore this message.</p>"}
        <p>Thank you, ${user.name}</p>
      </div>`;
      await autoEmail(userId, inv.client_email, subject, body);
      try { db.exec("ALTER TABLE invoices ADD COLUMN last_chased_at TEXT"); } catch(e) {}
      db.prepare("UPDATE invoices SET last_chased_at = date('now'), status = 'overdue' WHERE id = ?").run(inv.id);
      chased++;
    }
    logAction(db, userId, today, "invoice_chase", `${input.reason} — tone: ${input.urgency}`, { count: chased });
    if (chased > 0) actions.push({ type: "invoice_chase", detail: `${chased} overdue invoice chasers sent (${input.urgency} tone)` });
    return { success: true, chased };
  }

  if (toolName === "send_digest") {
    try {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
      const ordersYd    = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total),0) as rev FROM orders WHERE user_id = ? AND DATE(created_at) = ?").get(userId, yesterday);
      const bookingsYd  = db.prepare("SELECT COUNT(*) as n FROM bookings WHERE user_id = ? AND date = ?").get(userId, yesterday);
      const newContacts = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE user_id = ? AND DATE(created_at) = ?").get(userId, yesterday);
      const unpaidInv   = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total),0) as t FROM invoices WHERE user_id = ? AND status IN ('sent','unpaid','overdue')").get(userId);

      const actionSummary = actions.length > 0
        ? `<h3 style="color:#2563EB">🤖 What your Growth Agent did tonight:</h3><ul>${actions.map(a => `<li>${a.detail}</li>`).join("")}</ul>`
        : `<p style="color:#64748B">No automated actions needed — your business is on track!</p>`;

      const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#0F0E1A">☀️ Good morning, ${user.name?.split(" ")[0] || "there"}!</h2>
        <p style="color:#64748B">Here's your TAKEOVA Growth Agent briefing for ${today}.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="padding:10px;background:#F8F8FC"><strong>📦 Yesterday's orders</strong></td><td style="padding:10px;font-weight:700;color:#2563EB">${ordersYd?.n || 0} ($${Number(ordersYd?.rev || 0).toFixed(2)})</td></tr>
          <tr><td style="padding:10px"><strong>📅 Bookings</strong></td><td style="padding:10px;font-weight:700;color:#2563EB">${bookingsYd?.n || 0}</td></tr>
          <tr><td style="padding:10px;background:#F8F8FC"><strong>👥 New contacts</strong></td><td style="padding:10px;font-weight:700;color:#2563EB">${newContacts?.n || 0}</td></tr>
          <tr><td style="padding:10px"><strong>💳 Unpaid invoices</strong></td><td style="padding:10px;font-weight:700;color:${(unpaidInv?.n || 0) > 0 ? "#DC2626" : "#16A34A"}">${unpaidInv?.n || 0} ($${Number(unpaidInv?.t || 0).toFixed(2)})</td></tr>
        </table>
        ${actionSummary}
        <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}/dashboard" style="display:inline-block;background:#2563EB;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600">Open MINE →</a>
      </div>`;

      await autoEmail(userId, user.email, `☀️ Growth Agent Briefing — ${today}`, html);
      logAction(db, userId, today, "digest", "Morning briefing sent", { actionsCount: actions.length });
    } catch(e) { logAction(db, userId, today, "digest", "Failed", { error: e.message }, "error"); }
    return { success: true };
  }

  return { error: `Unknown tool: ${toolName}` };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Status + subscription check
router.get("/status", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const cfg = db.prepare("SELECT * FROM growth_agent_config WHERE user_id = ?").get(req.userId);
  const recentLog = db.prepare("SELECT * FROM growth_agent_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(req.userId);
  res.json({
    active: !!cfg?.enabled,
    config: cfg || null,
    recentActions: recentLog,
  });
});

// Get config
router.get("/config", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  let cfg = db.prepare("SELECT * FROM growth_agent_config WHERE user_id = ?").get(req.userId);
  if (!cfg) {
    db.prepare("INSERT OR IGNORE INTO growth_agent_config (user_id) VALUES (?)").run(req.userId);
    cfg = db.prepare("SELECT * FROM growth_agent_config WHERE user_id = ?").get(req.userId);
  }
  res.json({ config: cfg });
});

// Update config
router.put("/config", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { enabled, monthly_goal, actions_enabled } = req.body;
  if (monthly_goal !== undefined && (isNaN(monthly_goal) || monthly_goal < 0))
    return res.status(400).json({ error: "Invalid monthly goal" });
  const allowed = ["flash_sale","reengage","loyalty_boost","social_post","invoice_chase","digest"];
  const safeActions = Array.isArray(actions_enabled) ? actions_enabled.filter(a => allowed.includes(a)) : null;

  db.prepare(`INSERT INTO growth_agent_config (user_id, enabled, monthly_goal, actions_enabled, updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      enabled = COALESCE(excluded.enabled, enabled),
      monthly_goal = COALESCE(excluded.monthly_goal, monthly_goal),
      actions_enabled = COALESCE(excluded.actions_enabled, actions_enabled),
      updated_at = datetime('now')
  `).run(
    req.userId,
    enabled !== undefined ? (enabled ? 1 : 0) : null,
    monthly_goal !== undefined ? parseFloat(monthly_goal) : null,
    safeActions ? JSON.stringify(safeActions) : null
  );
  res.json({ success: true });
});

// Action log
router.get("/log", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { limit = 50, offset = 0 } = req.query;
  const rows = db.prepare("SELECT * FROM growth_agent_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(req.userId, Math.min(parseInt(limit) || 50, 200), parseInt(offset) || 0);
  const total = db.prepare("SELECT COUNT(*) as n FROM growth_agent_log WHERE user_id = ?").get(req.userId)?.n || 0;
  res.json({ log: rows, total });
});

// Manual run (admin can trigger for any user; owner can trigger for themselves)
router.post("/run-now", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureTables(db);
    const cfg = db.prepare("SELECT * FROM growth_agent_config WHERE user_id = ?").get(req.userId);
    if (!cfg) return res.status(403).json({ error: "Growth Agent not activated on your account" });
    res.json({ message: "Growth Agent running in background — check the log in a few seconds." });
    setImmediate(async () => {
      try { await runAgentForUser(req.userId, db); }
      catch(e) { console.error("[GrowthAgent] Manual run failed:", e.message); }
    });
  } catch(e) {
    console.error("[GrowthAgent] run-now error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Activation endpoint — called by Stripe webhook in payments.js
// Called from the Stripe webhook when a user purchases the Growth Agent add-on.
// Gated by INTERNAL_API_KEY (timing-safe) — without this gate any internet
// caller could flip the agent on for an arbitrary user ID, consuming TAKEOVA's
// Anthropic credits and potentially spamming their customers.
router.post("/activate", (req, res) => {
  const expected = process.env.INTERNAL_API_KEY || "";
  const provided = req.headers["x-internal-key"] || "";
  if (!expected || provided.length !== expected.length ||
      !require("crypto").timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(403).json({ error: "Forbidden — internal only" });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const db = getDb();
  ensureTables(db);
  const existing = db.prepare("SELECT user_id FROM growth_agent_config WHERE user_id = ?").get(userId);
  if (existing) {
    db.prepare("UPDATE growth_agent_config SET enabled = 1, updated_at = datetime('now') WHERE user_id = ?").run(userId);
  } else {
    db.prepare("INSERT INTO growth_agent_config (user_id, enabled) VALUES (?,1)").run(userId);
  }
  res.json({ success: true });
  _trackGaAi();
});

// Export runAgentForUser for the nightly cron in server.js
module.exports = router;
module.exports.runAgentForUser = runAgentForUser;
module.exports.ensureTables = ensureTables;
