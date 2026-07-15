// ═══════════════════════════════════════════════════════════════════
// MINE — AI BROWSER AGENT
//
// Uses Claude's Computer Use API (model: claude-opus-4-8 with the
// computer_use_20241022 tool) to operate a real browser on behalf of
// the user. Drives any website: supplier portals, marketplaces,
// government sites, social platforms, dashboards.
//
// Pricing:    $79/month add-on
// Plan gate:  starter denied (minPlan: 'growth')
// Caps:       monthly task ceiling per plan (growth 50, pro 200,
//             enterprise 500, agency 1000) — enforced at run time.
//
// Routes (mounted at /api/browser-agent):
//   POST /run        — kick off a browser task
//   GET  /tasks      — list this user's tasks
//   GET  /tasks/:id  — get task status + screenshots + result
//   POST /tasks/:id/cancel  — stop a running task
//   GET  /usage      — current month's usage + cap + remaining
// ═══════════════════════════════════════════════════════════════════
const express   = require("express");
const router    = express.Router();
const crypto    = require("crypto");
const { auth: requireAuth } = require("../middleware/auth");
// Per-tenant agent outcome tracking (safe-loaded; no-op if enhancements unmounted)
let _enh; try { _enh = require("./ai-employees-enhancements"); } catch (_) { _enh = null; }
const recordOutcome = (_enh && _enh.recordOutcome) ? _enh.recordOutcome : function(){};

function getDb(req) {
  return req.app.locals.db || require("../db/init").getDb();
}

// ─── DB schema ───────────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_agent_tasks (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      start_url       TEXT,
      status          TEXT DEFAULT 'queued',  -- queued, running, succeeded, failed, cancelled
      result_text     TEXT,
      result_data     TEXT,
      error           TEXT,
      screenshots     TEXT DEFAULT '[]',      -- JSON array of screenshot URLs
      action_count    INTEGER DEFAULT 0,
      tokens_used     INTEGER DEFAULT 0,
      is_overage      INTEGER DEFAULT 0,      -- 1 if this task exceeded the plan's monthly cap
      overage_cents   INTEGER DEFAULT 0,      -- charge in cents if overage (snapshot of rate at run time)
      billed          INTEGER DEFAULT 0,      -- 1 once included in a monthly Stripe invoice
      created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at    TEXT
    )
  `);
  // Migrate existing tables that may pre-date the overage columns
  try { db.exec("ALTER TABLE browser_agent_tasks ADD COLUMN is_overage INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE browser_agent_tasks ADD COLUMN overage_cents INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE browser_agent_tasks ADD COLUMN billed INTEGER DEFAULT 0"); } catch (_) {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_user_created ON browser_agent_tasks(user_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_overage_unbilled ON browser_agent_tasks(user_id, is_overage, billed)`);
  // Used by isHired() to check whether this user has paid for the add-on.
  // Other routes (admin-ops MRR calc, agency billing) also reference this
  // table, so we ensure it exists here for resilience.
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_addons (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      role            TEXT NOT NULL,           -- e.g. 'browser_agent', 'sales', 'support'
      status          TEXT DEFAULT 'active',   -- active, paused, cancelled
      price           INTEGER DEFAULT 0,       -- monthly price in USD
      stripe_sub_id   TEXT,
      created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
      cancelled_at    TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aa_user_role ON active_addons(user_id, role, status)`);
  // user_settings is shared with branding.js. Ensure it exists so
  // BROWSER_AGENT_OVERAGE_ENABLED can be stored without a separate route.
  db.exec("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY(user_id, key))");
  db.exec("CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT)");
}

// ─── Plan caps & gating ──────────────────────────────────────────────
const MONTHLY_CAPS = {
  growth:     50,
  pro:        200,
  enterprise: 500,
  agency:     1000,
  // starter intentionally absent (blocked)
  // trial/agency_client inherit pro caps if hired by their agency
  trial:        25,
  agency_client: 100,
  // Admin = MINE staff using MINE on their own account (dogfooding the
  // platform). No caps, no hire-check, no overage — they're driving the
  // tool to grow the product itself. Public stats exclude these users
  // so they don't pollute MRR / churn metrics.
  admin:    999999,
};

// ─── Overage pricing ─────────────────────────────────────────────────
//
// When a user hits their monthly cap, they can opt in to overage billing
// — additional tasks at a per-task rate. Defaults are set here but the
// platform admin can override via platform_settings.BROWSER_AGENT_*
// keys without a redeploy.
//
// Default rate: $2.50/task. Cost basis is ~$0.40–$1.00/task for the
// Anthropic Computer Use API + browser sandbox compute, giving a
// healthy 60–85% gross margin on every overage task. The hard cap
// stops users from accidentally generating runaway bills.
const DEFAULT_OVERAGE_RATE_CENTS = 250;            // $2.50 per overage task
const DEFAULT_OVERAGE_HARD_CAP   = 500;            // max overage tasks per month per user

function getOverageRateCents(db) {
  try {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = 'BROWSER_AGENT_OVERAGE_RATE_CENTS'").get();
    if (row && row.value) {
      const n = parseInt(row.value, 10);
      if (n > 0 && n < 100000) return n;
    }
  } catch (_) {}
  return DEFAULT_OVERAGE_RATE_CENTS;
}

// ─── Behavior controls (system prompt + safety rules) ────────────────
//
// The runner microservice gets these on every task launch. Admin can
// edit any of them via the Browser Agent panel without a redeploy.
// Resolution order: env var → platform_settings → default constant.

// Default system prompt. Compact — under 1.4k chars to keep token cost
// low on every Computer Use call (~350 tokens). Variables substituted
// at task time: {USER_NAME}, {BUSINESS_NAME}, {MAX_ACTIONS}, {USER_PROMPT}, {START_URL}.
const DEFAULT_SYSTEM_PROMPT = `You are TAKEOVA's AI Browser Agent, operating a real Chromium browser on behalf of {USER_NAME}{BUSINESS_NAME_SUFFIX}. You drive the browser via the computer-use tool to complete tasks on sites without public APIs.

PRINCIPLES

1. Efficiency. Minimum actions. Think before clicking. Extract from the current screenshot when you can rather than navigating further.

2. Authentication. If you hit a login wall, request credentials via the unlock_credential callback. Never guess passwords. For 2FA, use the stored TOTP secret.

3. SAFETY — never perform any of these without explicit user authorization in the task prompt:
   • Click Buy now / Place order / Submit payment / Confirm purchase
   • Click Send money / Wire transfer / Pay
   • Click Delete / Cancel subscription / Close account / Deactivate
   • Download or run executables (.exe, .dmg, .sh, .bat, .msi)
   • Send messages or emails to anyone not named in the task
   • Accept Terms & Conditions or contracts on the user's behalf
   If a task seems to require an action like this and the user did not explicitly say so, STOP and return status="needs_user_input".

4. Confirmation prompts. If a page says "Are you sure?" for a destructive action, abort and report back.

5. Bot detection. If you hit a CAPTCHA or "verify human" screen, STOP. Don't retry — that triggers account lockouts.

6. Budget. Maximum {MAX_ACTIONS} computer actions per task. If you can't complete in budget, return status="partial" with what you have.

OUTPUT
Respond with one JSON object only (no prose outside it):
{
  "summary": "one-sentence outcome",
  "status": "succeeded" | "partial" | "blocked" | "needs_user_input",
  "data_extracted": { ...task-specific structured data... },
  "warnings": [...]
}

TASK: {USER_PROMPT}
START_URL: {START_URL}`;

// Pattern list — string-matched against the user's prompt BEFORE sending
// to Claude. If the prompt itself asks for one of these without
// authorization context, the task is rejected outright. Cheap pre-filter
// before burning tokens.
const DEFAULT_FORBIDDEN_PATTERNS = [
  "wire transfer", "send money to", "buy and pay", "place an order and pay",
  "delete my account", "close my account", "deactivate my account",
  "cancel all subscriptions", "delete everything",
  "transfer funds", "withdraw money",
];

const DEFAULT_MAX_ACTIONS = 50;

function getSystemPromptTemplate(db) {
  if (process.env.BROWSER_AGENT_SYSTEM_PROMPT) return process.env.BROWSER_AGENT_SYSTEM_PROMPT;
  try {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = 'BROWSER_AGENT_SYSTEM_PROMPT'").get();
    if (row && row.value && row.value.length > 50) return row.value;
  } catch (_) {}
  return DEFAULT_SYSTEM_PROMPT;
}
function getForbiddenPatterns(db) {
  if (process.env.BROWSER_AGENT_FORBIDDEN_PATTERNS) {
    return process.env.BROWSER_AGENT_FORBIDDEN_PATTERNS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  try {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = 'BROWSER_AGENT_FORBIDDEN_PATTERNS'").get();
    if (row && row.value) return row.value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  } catch (_) {}
  return DEFAULT_FORBIDDEN_PATTERNS;
}
function getMaxActions(db) {
  if (process.env.BROWSER_AGENT_MAX_ACTIONS) {
    const n = parseInt(process.env.BROWSER_AGENT_MAX_ACTIONS, 10);
    if (n > 0 && n <= 500) return n;
  }
  try {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = 'BROWSER_AGENT_MAX_ACTIONS'").get();
    if (row && row.value) {
      const n = parseInt(row.value, 10);
      if (n > 0 && n <= 500) return n;
    }
  } catch (_) {}
  return DEFAULT_MAX_ACTIONS;
}

// Resolve user identity for prompt personalization.
// Returns { name, business } — both possibly empty strings.
function getUserIdentity(db, userId) {
  try {
    const row = db.prepare("SELECT name, email, business_name, role FROM users WHERE id = ?").get(userId);
    if (!row) return { name: "the user", business: "" };
    // Admin is dogfooding MINE — agent should know it's working for MINE itself
    if (row.role === "admin") {
      return { name: row.name || "the TAKEOVA team", business: row.business_name || "MINE" };
    }
    return {
      name:     row.name || (row.email ? row.email.split("@")[0] : "the user"),
      business: row.business_name || "",
    };
  } catch (_) { return { name: "the user", business: "" }; }
}

// Builds the final system prompt with variables substituted in.
// Called immediately before launching a task in the runner.
function buildSystemPrompt(db, userId, userPrompt, startUrl) {
  const tpl       = getSystemPromptTemplate(db);
  const maxAct    = getMaxActions(db);
  const identity  = getUserIdentity(db, userId);
  const bizSuffix = identity.business ? ` who runs ${identity.business}` : "";
  return tpl
    .replaceAll("{USER_NAME}", identity.name)
    .replaceAll("{BUSINESS_NAME_SUFFIX}", bizSuffix)
    .replaceAll("{BUSINESS_NAME}", identity.business || "their business")
    .replaceAll("{MAX_ACTIONS}", String(maxAct))
    .replaceAll("{USER_PROMPT}", userPrompt || "")
    .replaceAll("{START_URL}", startUrl || "(no starting URL — use search or navigate as needed)");
}

// Pattern-match the user's prompt against the forbidden list.
// Returns the matched pattern (truthy) or null.
function checkForbiddenPrompt(db, prompt) {
  const lower = String(prompt || "").toLowerCase();
  const patterns = getForbiddenPatterns(db);
  for (const p of patterns) {
    if (p && lower.includes(p)) return p;
  }
  return null;
}
function getOverageHardCap(db) {
  try {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = 'BROWSER_AGENT_OVERAGE_HARD_CAP'").get();
    if (row && row.value) {
      const n = parseInt(row.value, 10);
      if (n >= 0 && n < 100000) return n;
    }
  } catch (_) {}
  return DEFAULT_OVERAGE_HARD_CAP;
}
function isOverageEnabledForUser(db, userId) {
  try {
    const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'BROWSER_AGENT_OVERAGE_ENABLED'").get(String(userId));
    return row && row.value === 'true';
  } catch (_) { return false; }
}
function getOverageUsageThisMonth(db, userId) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(overage_cents),0) AS cents
      FROM browser_agent_tasks
      WHERE user_id = ? AND is_overage = 1
        AND substr(created_at, 1, 7) = substr(datetime('now'), 1, 7)
    `).get(userId);
    return { count: row?.n || 0, cents: row?.cents || 0 };
  } catch (_) { return { count: 0, cents: 0 }; }
}

function getUserPlan(db, userId) {
  try { return (db.prepare("SELECT plan FROM users WHERE id = ?").get(userId)?.plan || "starter").toLowerCase(); }
  catch (_) { return "starter"; }
}

// Centralised admin role check — same helper used by email.js,
// site-editor.js, and any other gating point. Admin (role='admin')
// bypasses caps, plan gates, and addon billing across the platform.
const { isAdmin } = require("../utils/admin-check");

function isHired(db, userId) {
  // Admin: always hired, no $79/mo charge
  if (isAdmin(db, userId)) return true;
  // browser_agent must be hired (paid $79 add-on) OR included in their plan
  try {
    // Plans that get it included
    const plan = getUserPlan(db, userId);
    if (plan === "enterprise" || plan === "agency") return true;

    // Or, check active_addons table for browser_agent hire
    const row = db.prepare(
      "SELECT 1 FROM active_addons WHERE user_id = ? AND role = 'browser_agent' AND status = 'active' LIMIT 1"
    ).get(userId);
    return !!row;
  } catch (_) { return false; }
}

function planCap(plan) {
  return MONTHLY_CAPS[plan] || 0;
}

function getUsageThisMonth(db, userId) {
  // Count completed tasks (queued/running/cancelled don't count) in the
  // current billing month. Simple approach: calendar month UTC.
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM browser_agent_tasks
      WHERE user_id = ? AND status IN ('succeeded','failed','running','queued')
        AND substr(created_at, 1, 7) = substr(datetime('now'), 1, 7)
    `).get(userId);
    return row?.n || 0;
  } catch (_) { return 0; }
}

// Returns { ok, reason, plan, cap, used, remaining, overage, overage_rate_cents, overage_used, overage_hard_cap }
function preflight(db, userId) {
  ensureTables(db);

  // ─── Admin bypass ─────────────────────────────────────────────────
  // Platform admin (role='admin') gets unlimited use of every agent at
  // no cost. They're running MINE itself — capping them would be silly.
  // Returns a synthetic check object with admin flag so callers can
  // surface "admin mode" in the UI if they want.
  if (isAdmin(db, userId)) {
    return {
      ok: true, admin: true, plan: "admin",
      cap: Infinity, used: 0, remaining: Infinity,
      overage: false, overage_rate_cents: 0,
      overage_used: 0, overage_hard_cap: Infinity,
      overage_enabled: false,
    };
  }

  const plan = getUserPlan(db, userId);
  if (plan === "starter") {
    return { ok: false, reason: "Starter plan does not include the AI Browser Agent. Upgrade to Growth or higher, or contact admin.", plan, cap: 0, used: 0, remaining: 0 };
  }
  const cap = planCap(plan);
  if (!cap) {
    return { ok: false, reason: `Plan '${plan}' has no Browser Agent allowance configured.`, plan, cap: 0, used: 0, remaining: 0 };
  }
  if (!isHired(db, userId)) {
    return { ok: false, reason: "AI Browser Agent not active. Hire it for $79/month from your AI Employees panel.", plan, cap, used: 0, remaining: cap, needs_hire: true };
  }

  const used         = getUsageThisMonth(db, userId);
  const overageRate  = getOverageRateCents(db);
  const overageHard  = getOverageHardCap(db);
  const overageOptIn = isOverageEnabledForUser(db, userId);
  const overageUsage = getOverageUsageThisMonth(db, userId);

  // Within plan cap → run as included task
  if (used < cap) {
    return { ok: true, plan, cap, used, remaining: cap - used,
             overage: false, overage_rate_cents: overageRate,
             overage_used: overageUsage.count, overage_hard_cap: overageHard,
             overage_enabled: overageOptIn };
  }

  // At/above plan cap — overage path
  if (!overageOptIn) {
    return { ok: false,
             reason: `Monthly cap of ${cap} browser tasks reached on the ${plan} plan. Enable overage billing at $${(overageRate/100).toFixed(2)} per extra task to keep working, or wait for the cap to reset on the 1st.`,
             plan, cap, used, remaining: 0,
             overage_available: true, overage_rate_cents: overageRate, overage_hard_cap: overageHard };
  }
  if (overageUsage.count >= overageHard) {
    return { ok: false,
             reason: `Overage hard cap of ${overageHard} extra tasks reached this month — safety limit to prevent runaway billing. Contact support to raise it, or wait for the cap to reset on the 1st.`,
             plan, cap, used, remaining: 0,
             overage: true, overage_used: overageUsage.count, overage_hard_cap: overageHard,
             overage_charges_cents: overageUsage.cents };
  }

  // Approved overage run
  return { ok: true, plan, cap, used, remaining: 0,
           overage: true, overage_rate_cents: overageRate,
           overage_used: overageUsage.count, overage_hard_cap: overageHard,
           overage_enabled: true, overage_charges_cents: overageUsage.cents };
}

// ─── Computer Use call wrapper ───────────────────────────────────────
//
// This wraps the Anthropic Computer Use loop. Claude returns tool_use
// blocks (e.g. screenshot, click, type) which the runtime executes
// against a real browser, screenshots the result, and sends back. The
// loop continues until Claude returns a final text answer.
//
// For initial deployment we delegate the browser execution to a
// separate microservice (configurable via BROWSER_AGENT_RUNNER_URL).
// If no runner is configured, the agent fails gracefully with a clear
// message rather than burning tokens with no browser to drive.
async function runComputerUseTask({ prompt, startUrl, apiKey, runnerUrl, taskId, db, userId }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  if (!runnerUrl) throw new Error("BROWSER_AGENT_RUNNER_URL not configured — browser execution sandbox missing");

  // Build the system prompt (personalized with user/business) + load
  // configured limits. The runner forwards system_prompt as the
  // `system` parameter on every Anthropic API call.
  const systemPrompt   = buildSystemPrompt(db, userId, prompt, startUrl);
  const maxActions     = getMaxActions(db);
  const forbiddenPatterns = getForbiddenPatterns(db);

  // Internal callback URL the runner uses to fetch credentials at task
  // time (POST /api/credentials/_unlock with X-Internal-Auth).
  const backendUrl = (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, "");

  // Hand off to the runner microservice which spins up a sandboxed
  // browser, runs Claude's Computer Use loop, and returns final result.
  // Keeps long-running browser sessions out of the main API process.
  const fetch = (typeof globalThis.fetch === "function") ? globalThis.fetch : (await import("node-fetch")).default;
  const r = await fetch(runnerUrl.replace(/\/$/, "") + "/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Auth": process.env.INTERNAL_API_KEY || "" },
    body: JSON.stringify({
      task_id:           taskId,
      user_id:           userId,
      anthropic_key:     apiKey,
      model:             "claude-opus-4-8",
      max_actions:       maxActions,
      system_prompt:     systemPrompt,
      forbidden_patterns: forbiddenPatterns,
      credential_unlock_url: backendUrl + "/api/credentials/_unlock",
      internal_auth_header:  process.env.INTERNAL_API_KEY || "",
      prompt,
      start_url:         startUrl || null,
      tools: [{
        type: "computer_20241022",
        name: "computer",
        display_width_px:  1280,
        display_height_px: 800,
        display_number:    1,
      }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("Runner failed: HTTP " + r.status + " " + t.slice(0, 200));
  }
  return await r.json();
}

// ─── 1. POST /run — start a browser task ─────────────────────────────
// ─── Browser Agent add-on subscription ($79/mo) ─────────────────────────
// Free for Admin / Enterprise / Agency (see isHired). For every other plan this
// is the purchase path: it writes the active_addons row that isHired() checks.
// Mirrors the SEO Agent pattern: real Stripe subscription when configured,
// self-hosted (no-charge) activation otherwise.
const BROWSER_PRICE_PER_MONTH = 79;
const BROWSER_PRICE_ID = process.env.STRIPE_BROWSER_AGENT_PRICE_ID || ""; // optional: pin to a specific Stripe Price; otherwise created from BROWSER_PRICE_PER_MONTH

// Ensure a recurring monthly Stripe Price exists for the add-on. Uses the env Price
// ID when set; otherwise finds/creates one from BROWSER_PRICE_PER_MONTH so billing
// works without any env var. Cached in-process.
let _browserPriceId = null;
async function ensureBrowserPrice(stripe) {
  if (BROWSER_PRICE_ID) return BROWSER_PRICE_ID;
  if (_browserPriceId) return _browserPriceId;
  const cents = BROWSER_PRICE_PER_MONTH * 100;
  const products = await stripe.products.list({ limit: 100 });
  let product = products.data.find(p => p.metadata && p.metadata.mine_addon === "browser_agent");
  if (!product) product = await stripe.products.create({ name: "AI Web Hands (Browser Agent)", metadata: { mine_addon: "browser_agent" } });
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find(p => p.unit_amount === cents && p.recurring && p.recurring.interval === "month");
  if (!price) price = await stripe.prices.create({ product: product.id, unit_amount: cents, currency: "usd", recurring: { interval: "month" } });
  _browserPriceId = price.id;
  return _browserPriceId;
}

router.get("/subscription", requireAuth, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM active_addons WHERE user_id = ? AND role = 'browser_agent' ORDER BY created_at DESC LIMIT 1").get(req.userId);
    res.json({
      hired: isHired(db, req.userId),
      includedInPlan: ["enterprise", "agency"].includes(getUserPlan(db, req.userId)) || isAdmin(db, req.userId),
      subscription: row || null,
      pricePerMonth: BROWSER_PRICE_PER_MONTH
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/subscribe", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM active_addons WHERE user_id = ? AND role = 'browser_agent' AND status = 'active'").get(req.userId);
    if (existing) return res.json({ success: true, alreadySubscribed: true });
    if (["enterprise", "agency"].includes(getUserPlan(db, req.userId)) || isAdmin(db, req.userId)) {
      return res.json({ success: true, includedInPlan: true });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      // No Stripe configured at all (test / self-hosted mode) — activate without charge
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO active_addons (id, user_id, role, status, price, stripe_sub_id) VALUES (?, ?, 'browser_agent', 'active', ?, NULL)")
        .run(id, req.userId, BROWSER_PRICE_PER_MONTH);
      return res.json({ success: true, mode: "self-hosted", subscriptionId: id });
    }

    const stripe = require("stripe")(stripeKey);
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name || user.email });
      customerId = customer.id;
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, req.userId);
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: await ensureBrowserPrice(stripe) }],
      metadata: { user_id: req.userId, addon: "browser-agent" }
    });

    const id = crypto.randomUUID();
    const status = (subscription.status === "active" || subscription.status === "trialing") ? "active" : "pending";
    db.prepare("INSERT INTO active_addons (id, user_id, role, status, price, stripe_sub_id) VALUES (?, ?, 'browser_agent', ?, ?, ?)")
      .run(id, req.userId, status, BROWSER_PRICE_PER_MONTH, subscription.id);

    res.json({ success: true, subscriptionId: id, stripeStatus: subscription.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/unsubscribe", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM active_addons WHERE user_id = ? AND role = 'browser_agent' AND status = 'active'").get(req.userId);
    if (!row) return res.status(404).json({ error: "No active subscription" });
    if (row.stripe_sub_id && process.env.STRIPE_SECRET_KEY) {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.update(row.stripe_sub_id, { cancel_at_period_end: true });
    }
    db.prepare("UPDATE active_addons SET status='cancelled', cancelled_at = datetime('now') WHERE id = ?").run(row.id);
    res.json({ success: true, message: "Browser Agent add-on cancelled." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/run", requireAuth, async (req, res) => {
  try {
    const db = getDb(req);
    const check = preflight(db, req.userId);
    if (!check.ok) return res.status(402).json(check);

    const { prompt, start_url, schedule } = req.body || {};
    if (!prompt || typeof prompt !== "string" || prompt.length < 5) {
      return res.status(400).json({ error: "Prompt required (min 5 chars)" });
    }

    // Cheap pre-flight: reject prompts containing forbidden patterns
    // (wire transfers, account deletions, etc.) before burning tokens
    // on a task the agent would refuse anyway.
    const blockedPattern = checkForbiddenPrompt(db, prompt);
    if (blockedPattern) {
      return res.status(400).json({
        error: `Task contains a forbidden pattern ("${blockedPattern}") that the Browser Agent will not perform automatically. Rephrase the request, perform this action yourself, or contact admin if you believe this is in error.`,
        blocked_pattern: blockedPattern,
      });
    }

    const taskId = crypto.randomBytes(8).toString("hex");
    const isOverage   = check.overage ? 1 : 0;
    const overageCost = check.overage ? (check.overage_rate_cents || 0) : 0;
    db.prepare(`
      INSERT INTO browser_agent_tasks (id, user_id, prompt, start_url, status, is_overage, overage_cents)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)
    `).run(taskId, req.userId, prompt, start_url || null, isOverage, overageCost);

    // Fire-and-forget — the runner microservice handles the actual
    // browser session. It posts back to /api/browser-agent/_callback
    // when the task completes.
    const apiKey    = process.env.ANTHROPIC_API_KEY;
    const runnerUrl = process.env.BROWSER_AGENT_RUNNER_URL;

    runComputerUseTask({ prompt, startUrl: start_url, apiKey, runnerUrl, taskId, db, userId: req.userId })
      .then(result => {
        db.prepare(`
          UPDATE browser_agent_tasks
          SET status='succeeded', result_text=?, result_data=?, screenshots=?,
              action_count=?, tokens_used=?, completed_at=datetime('now'), updated_at=datetime('now')
          WHERE id=?
        `).run(
          result.text || "",
          JSON.stringify(result.data || {}),
          JSON.stringify(result.screenshots || []),
          result.action_count || 0,
          result.tokens_used || 0,
          taskId
        );
        try {
          var _bst = (result && result.status) || 'succeeded';
          var _boc = _bst === 'succeeded' ? 'success' : (_bst === 'blocked' ? 'failed' : 'no_response');
          recordOutcome(taskId, req.userId, 'browser_agent', 'automate_workflow', _boc, { task_id: taskId, status: _bst, actions: result.action_count || 0 });
        } catch(_){}
      })
      .catch(err => {
        console.error("[browser-agent run]", err.message);
        db.prepare(`
          UPDATE browser_agent_tasks SET status='failed', error=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?
        `).run(err.message.slice(0, 500), taskId);
        try { recordOutcome(taskId, req.userId, 'browser_agent', 'automate_workflow', 'failed', { task_id: taskId, error: String(err.message||'').slice(0,200) }); } catch(_){}
      });

    res.json({
      task_id: taskId, status: "queued",
      plan: check.plan, used: check.used + 1, cap: check.cap,
      overage: !!check.overage,
      overage_rate_cents: check.overage ? check.overage_rate_cents : null,
      overage_used: check.overage_used,
      overage_hard_cap: check.overage_hard_cap,
      message: check.overage
        ? `Overage task — billed at $${((check.overage_rate_cents||0)/100).toFixed(2)}. Used ${check.overage_used + 1}/${check.overage_hard_cap} overage tasks this month.`
        : `Task ${check.used + 1}/${check.cap} for the month.`,
    });
  } catch (e) {
    console.error("[browser-agent/run]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── 2. GET /tasks — list user's tasks ───────────────────────────────
router.get("/tasks", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const rows = db.prepare(`
      SELECT id, prompt, start_url, status, action_count, tokens_used, created_at, completed_at
      FROM browser_agent_tasks WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 100
    `).all(req.userId);
    res.json({ tasks: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 3. GET /tasks/:id — detailed task view ──────────────────────────
router.get("/tasks/:id", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const row = db.prepare("SELECT * FROM browser_agent_tasks WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: "Task not found" });
    try { row.screenshots = JSON.parse(row.screenshots || "[]"); } catch(_) { row.screenshots = []; }
    try { row.result_data = JSON.parse(row.result_data || "{}"); } catch(_) { row.result_data = {}; }
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 4. POST /tasks/:id/cancel ───────────────────────────────────────
router.post("/tasks/:id/cancel", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const row = db.prepare("SELECT * FROM browser_agent_tasks WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!row)                              return res.status(404).json({ error: "Task not found" });
    if (!["queued","running"].includes(row.status)) return res.status(400).json({ error: "Task not cancellable in status " + row.status });
    db.prepare("UPDATE browser_agent_tasks SET status='cancelled', completed_at=datetime('now') WHERE id=?").run(row.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 5. GET /usage — show user their current cap status ──────────────
router.get("/usage", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const plan = getUserPlan(db, req.userId);
    const cap  = planCap(plan);
    const used = getUsageThisMonth(db, req.userId);
    const hired = isHired(db, req.userId);
    const overageRate     = getOverageRateCents(db);
    const overageHard     = getOverageHardCap(db);
    const overageOptIn    = isOverageEnabledForUser(db, req.userId);
    const overageUsage    = getOverageUsageThisMonth(db, req.userId);
    const overageAvailable = overageHard - overageUsage.count;

    res.json({
      plan,
      hired,
      cap,
      used,
      remaining: Math.max(0, cap - used),
      addon_price_usd: 79,
      min_plan: "growth",
      // Overage details
      overage: {
        enabled:           overageOptIn,
        rate_cents:        overageRate,
        rate_display_usd:  (overageRate / 100).toFixed(2),
        used_this_month:   overageUsage.count,
        hard_cap:          overageHard,
        remaining:         Math.max(0, overageAvailable),
        unbilled_cents:    overageUsage.cents,
        unbilled_usd:      (overageUsage.cents / 100).toFixed(2),
      },
      blocked_reason: plan === "starter" ? "Starter plan does not include the AI Browser Agent."
                     : !hired ? "AI Browser Agent not active — hire for $79/month."
                     : (used >= cap && !overageOptIn) ? `Monthly cap reached. Enable overage at $${(overageRate/100).toFixed(2)}/task to keep working.`
                     : (used >= cap && overageUsage.count >= overageHard) ? "Overage hard cap reached this month."
                     : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 5a. POST /overage/enable — opt in to overage billing ────────────
router.post("/overage/enable", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    db.prepare(`
      INSERT INTO user_settings (user_id, key, value) VALUES (?, 'BROWSER_AGENT_OVERAGE_ENABLED', 'true')
      ON CONFLICT(user_id, key) DO UPDATE SET value = 'true'
    `).run(String(req.userId));
    res.json({ success: true, enabled: true, rate_cents: getOverageRateCents(db), hard_cap: getOverageHardCap(db) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 5b. POST /overage/disable — opt out ─────────────────────────────
router.post("/overage/disable", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = 'BROWSER_AGENT_OVERAGE_ENABLED'").run(String(req.userId));
    res.json({ success: true, enabled: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 5c. POST /overage/process-cycle — admin/cron monthly billing ────
// Aggregates all unbilled overage tasks per user, creates a Stripe
// invoice item for the total, and marks the tasks billed. Designed to
// run on the 1st of each month via cron. Idempotent: re-running won't
// double-bill (only tasks with billed=0 are charged).
router.post("/overage/process-cycle", async (req, res) => {
  const internalKey = req.headers["x-internal-auth"] || "";
  if (!internalKey || internalKey !== (process.env.INTERNAL_API_KEY || "")) return res.status(403).json({ error: "Forbidden" });
  try {
    const db = req.app.locals.db || require("../db/init").getDb();
    ensureTables(db);

    // Stripe is optional — if not configured, just mark tasks as
    // processed and let the admin reconcile manually.
    let stripe = null;
    if (process.env.STRIPE_SECRET_KEY) {
      try { stripe = require("stripe")(process.env.STRIPE_SECRET_KEY); } catch (_) {}
    }

    // Aggregate per user
    const rows = db.prepare(`
      SELECT user_id, COUNT(*) AS task_count, SUM(overage_cents) AS total_cents
      FROM browser_agent_tasks
      WHERE is_overage = 1 AND billed = 0
        AND status IN ('succeeded','failed')
      GROUP BY user_id HAVING total_cents > 0
    `).all();

    const results = [];
    for (const r of rows) {
      let invoiceItemId = null, stripeError = null;
      // Look up Stripe customer id
      const u = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(r.user_id);
      if (stripe && u && u.stripe_customer_id) {
        try {
          const item = await stripe.invoiceItems.create({
            customer:    u.stripe_customer_id,
            amount:      r.total_cents,
            currency:    "usd",
            description: `Browser Agent overage — ${r.task_count} tasks × $${(r.total_cents / r.task_count / 100).toFixed(2)}`,
            metadata:    { user_id: r.user_id, task_count: String(r.task_count), source: "browser_agent_overage" },
          });
          invoiceItemId = item.id;
        } catch (e) { stripeError = e.message; }
      }
      // Mark tasks billed even if Stripe failed — admin can replay via /admin
      db.prepare(`UPDATE browser_agent_tasks SET billed = 1 WHERE user_id = ? AND is_overage = 1 AND billed = 0`).run(r.user_id);
      results.push({ user_id: r.user_id, task_count: r.task_count, total_cents: r.total_cents, invoice_item_id: invoiceItemId, error: stripeError });
    }
    res.json({ processed: results.length, results });
  } catch (e) {
    console.error("[browser-agent/overage/process-cycle]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 6. POST /_callback — runner microservice posts results here ─────
// (Optional alternative to the inline promise chain above.)
router.post("/_callback", (req, res) => {
  const internalKey = req.headers["x-internal-auth"] || "";
  if (internalKey !== (process.env.INTERNAL_API_KEY || "")) return res.status(403).json({ error: "Forbidden" });
  try {
    const db = req.app.locals.db || require("../db/init").getDb();
    const { task_id, status, result_text, result_data, screenshots, action_count, tokens_used, error } = req.body || {};
    if (!task_id || !status) return res.status(400).json({ error: "task_id + status required" });
    db.prepare(`
      UPDATE browser_agent_tasks
      SET status=?, result_text=?, result_data=?, screenshots=?, action_count=?, tokens_used=?, error=?,
          completed_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(status, result_text || null, JSON.stringify(result_data || {}), JSON.stringify(screenshots || []),
           action_count || 0, tokens_used || 0, error || null, task_id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.MONTHLY_CAPS         = MONTHLY_CAPS;
module.exports.preflight            = preflight;
module.exports.buildSystemPrompt    = buildSystemPrompt;
module.exports.checkForbiddenPrompt = checkForbiddenPrompt;
module.exports.getMaxActions        = getMaxActions;
module.exports.getForbiddenPatterns = getForbiddenPatterns;
