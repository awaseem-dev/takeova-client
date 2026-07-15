const express = require("express");
const { renderEmail, P } = require("../utils/email-template");
const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";
const { v4: uuid } = require("uuid");
const crypto = require("crypto");

function auth(req, res, next) { const m = require("../middleware/auth"); m.auth(req, res, next); }
function getDb() { return require("../db/init").getDb(); }
function getSetting(k) { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } }

// Strict rate limiter for affiliate auth endpoints — prevents email bombing / SendGrid cost abuse
const rateLimit = require("express-rate-limit");
const affiliateAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: "Too many attempts — please wait 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mine_affiliates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      code TEXT UNIQUE NOT NULL,
      stripe_account_id TEXT,
      payout_method TEXT DEFAULT 'stripe',
      commission_rate REAL DEFAULT 18,
      tier TEXT DEFAULT 'starter',
      clicks INTEGER DEFAULT 0,
      signups INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      revenue_generated REAL DEFAULT 0,
      commission_earned REAL DEFAULT 0,
      commission_paid REAL DEFAULT 0,
      last_payout_at TEXT,
      magic_token TEXT,
      magic_token_expires TEXT,
      session_token TEXT,
      session_expires TEXT,
      status TEXT DEFAULT 'active',
      bio TEXT DEFAULT '',
      website TEXT DEFAULT '',
      social_platform TEXT DEFAULT '',
      social_handle TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mine_affiliate_clicks (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT,
      ip TEXT,
      user_agent TEXT,
      referrer TEXT,
      landing_page TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mine_affiliate_conversions (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT,
      user_id TEXT,
      plan TEXT,
      amount REAL,
      commission REAL,
      recurring INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mine_affiliate_payouts (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT,
      amount REAL,
      method TEXT DEFAULT 'stripe',
      stripe_transfer_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ═══════════════════════════════════════════════════════════
// PUBLIC AFFILIATE SIGNUP
// Anyone can join — no TAKEOVA account needed
// ═══════════════════════════════════════════════════════════

router.post("/signup", affiliateAuthLimiter, async (req, res) => {
  try {
  const db = getDb();
  ensureTables(db);
  const { name, email, website, social_platform, social_handle } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Name and email required" });

  const existing = db.prepare("SELECT * FROM mine_affiliates WHERE email = ?").get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: "Already registered. Check your email for a login link.", code: existing.code });

  const id = uuid();
  const code = name.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 6) + crypto.randomBytes(2).toString("hex");

  db.prepare(`INSERT INTO mine_affiliates (id, name, email, code, website, social_platform, social_handle) VALUES (?,?,?,?,?,?,?)`)
    .run(id, name.trim(), email.toLowerCase().trim(), code, website || "", social_platform || "", social_handle || "");

  // Send magic link to log in
  const linkInfo = await sendMagicLink(db, id, email.toLowerCase().trim(), name.trim());

  // Dev fallback: if email couldn't be sent (no SendGrid), return login URL directly
  const response = { success: true, code, message: "Welcome! Check your email for your dashboard link." };
  if (!linkInfo.emailSent && process.env.NODE_ENV !== "production") {
    response.dev_login_url = linkInfo.loginUrl;
    response.message = "Email not configured — use the dev_login_url field to continue.";
  }
  res.json(response);
  } catch (e) {
    console.error("[/affiliates/signup]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// ═══════════════════════════════════════════════════════════
// MAGIC LINK AUTH (passwordless)
// ═══════════════════════════════════════════════════════════

router.post("/login", affiliateAuthLimiter, async (req, res) => {
  try {
  const db = getDb();
  ensureTables(db);
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const aff = db.prepare("SELECT * FROM mine_affiliates WHERE email = ?").get(email.toLowerCase().trim());
  if (!aff) return res.status(401).json({ error: "Invalid email or password." });

  const linkInfo = await sendMagicLink(db, aff.id, aff.email, aff.name);
  const response = { success: true, message: "Login link sent to " + aff.email };
  if (!linkInfo.emailSent && process.env.NODE_ENV !== "production") {
    response.dev_login_url = linkInfo.loginUrl;
    response.message = "Email not configured — use the dev_login_url field to continue.";
  }
  res.json(response);

  } catch (e) {
    console.error("[/login]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// Verify magic link token → returns full dashboard data
router.get("/verify/:token", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const aff = db.prepare("SELECT * FROM mine_affiliates WHERE magic_token = ? AND magic_token_expires > datetime('now')").get(req.params.token);
  if (!aff) return res.status(401).json({ error: "Invalid or expired link. Request a new one." });

  // Clear magic link after use (one-time)
  db.prepare("UPDATE mine_affiliates SET magic_token = NULL, magic_token_expires = NULL WHERE id = ?").run(aff.id);

  // Generate session token (valid 30 days) — stored separately so new magic links don't kill active sessions
  const sessionToken = crypto.randomBytes(32).toString("hex");
  db.prepare("UPDATE mine_affiliates SET session_token = ?, session_expires = datetime('now', '+30 days') WHERE id = ?")
    .run(sessionToken, aff.id);

  res.json({ token: sessionToken, affiliate: sanitizeAffiliate(aff) });
});

// Auth middleware for affiliate routes
function affAuth(req, res, next) {
  const token = req.headers["x-affiliate-token"] || req.query.token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const db = getDb();
  ensureTables(db);
  const aff = db.prepare("SELECT * FROM mine_affiliates WHERE session_token = ? AND session_expires > datetime('now')").get(token);
  if (!aff) return res.status(401).json({ error: "Session expired. Login again." });
  req.affiliate = aff;
  next();
}

// ═══════════════════════════════════════════════════════════
// AFFILIATE DASHBOARD API
// ═══════════════════════════════════════════════════════════

router.get("/dashboard", affAuth, (req, res) => {
  const db = getDb();
  const aff = req.affiliate;

  // Get conversions
  const conversions = db.prepare("SELECT * FROM mine_affiliate_conversions WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 50").all(aff.id);

  // Get payouts
  const payouts = db.prepare("SELECT * FROM mine_affiliate_payouts WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 20").all(aff.id);

  // Get click stats (last 30 days)
  const clicksByDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM mine_affiliate_clicks WHERE affiliate_id = ? AND created_at > datetime('now', '-30 days')
    GROUP BY date(created_at) ORDER BY day
  `).all(aff.id);

  // Get this month's stats
  const thisMonth = db.prepare(`
    SELECT COUNT(*) as conversions, SUM(amount) as revenue, SUM(commission) as commission
    FROM mine_affiliate_conversions WHERE affiliate_id = ? AND created_at > datetime('now', 'start of month')
  `).get(aff.id);

  const pendingPayout = aff.commission_earned - aff.commission_paid;
  const minPayout = 50;

  // Determine tier
  let tier = "Starter";
  let nextTier = "Bronze";
  let nextTierAt = 5;
  if (aff.conversions >= 50) { tier = "Gold"; nextTier = "Diamond"; nextTierAt = 100; }
  else if (aff.conversions >= 25) { tier = "Silver"; nextTier = "Gold"; nextTierAt = 50; }
  else if (aff.conversions >= 5) { tier = "Bronze"; nextTier = "Silver"; nextTierAt = 25; }

  // Commission rate by tier
  const tierRates = { "Starter": 18, "Bronze": 20, "Silver": 23, "Gold": 25, "Diamond": 28 };
  const commissionRate = tierRates[tier] || 18;

  res.json({
    affiliate: sanitizeAffiliate(aff),
    stats: {
      clicks: aff.clicks,
      signups: aff.signups,
      conversions: aff.conversions,
      revenueGenerated: aff.revenue_generated,
      commissionEarned: aff.commission_earned,
      commissionPaid: aff.commission_paid,
      pendingPayout,
      canCashOut: pendingPayout >= minPayout,
      minPayout,
      commissionRate,
      tier,
      nextTier,
      nextTierAt,
      thisMonth: thisMonth || { conversions: 0, revenue: 0, commission: 0 }
    },
    conversions,
    payouts,
    clicksByDay,
    links: {
      referral: `https://takeova.ai/?ref=${aff.code}`,
      signup: `https://takeova.ai/signup?ref=${aff.code}`,
      pricing: `https://takeova.ai/pricing?ref=${aff.code}`
    }
  });
});

// Update profile (name, bio, payout method)
router.put("/profile", affAuth, (req, res) => {
  const db = getDb();
  const { name, bio, website } = req.body;
  const fields = [];
  const vals = [];
  if (name) { fields.push("name = ?"); vals.push(name); }
  if (bio !== undefined) { fields.push("bio = ?"); vals.push(bio); }
  if (website !== undefined) { fields.push("website = ?"); vals.push(website); }
  if (!fields.length) return res.json({ success: true });
  vals.push(req.affiliate.id);
  db.prepare(`UPDATE mine_affiliates SET ${fields.join(",")} WHERE id = ?`).run(...vals);
  const updated = db.prepare("SELECT * FROM mine_affiliates WHERE id = ?").get(req.affiliate.id);
  res.json({ success: true, affiliate: sanitizeAffiliate(updated) });
});

// Create custom referral code
router.put("/code", affAuth, (req, res) => {
  const db = getDb();
  const { code } = req.body;
  if (!code || code.length < 3 || code.length > 20) return res.status(400).json({ error: "Code must be 3-20 characters" });
  const clean = code.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const taken = db.prepare("SELECT id FROM mine_affiliates WHERE code = ? AND id != ?").get(clean, req.affiliate.id);
  if (taken) return res.status(409).json({ error: "Code already taken" });
  db.prepare("UPDATE mine_affiliates SET code = ? WHERE id = ?").run(clean, req.affiliate.id);
  res.json({ success: true, code: clean, link: `https://takeova.ai/?ref=${clean}` });
});

// ═══════════════════════════════════════════════════════════
// STRIPE CONNECT ONBOARDING (for affiliate payouts)
// ═══════════════════════════════════════════════════════════

router.post("/connect-stripe", affAuth, async (req, res) => {
  try {
    const stripe = require("stripe")(getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY);
    const db = getDb();
    const aff = req.affiliate;

    let accountId = aff.stripe_account_id;

    if (!accountId) {
      // Create Express account
      const account = await stripe.accounts.create({
        type: "express",
        email: aff.email,
        metadata: { mine_affiliate_id: aff.id },
        capabilities: { transfers: { requested: true } }
      });
      accountId = account.id;
      db.prepare("UPDATE mine_affiliates SET stripe_account_id = ?, payout_method = 'stripe' WHERE id = ?").run(accountId, aff.id);
    }

    // Create onboarding link
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${FRONTEND_URL || "https://takeova.ai"}/affiliates/dashboard?stripe=retry`,
      return_url: `${FRONTEND_URL || "https://takeova.ai"}/affiliates/dashboard?stripe=success`,
      type: "account_onboarding"
    });

    res.json({ success: true, url: link.url });
  } catch (e) {
    console.error("[Route] Stripe setup failed: ", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Check Stripe Connect status
router.get("/connect-status", affAuth, async (req, res) => {
  const aff = req.affiliate;
  if (!aff.stripe_account_id) return res.json({ connected: false });
  try {
    const stripe = require("stripe")(getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY);
    const account = await stripe.accounts.retrieve(aff.stripe_account_id);
    res.json({
      connected: account.charges_enabled && account.payouts_enabled,
      details_submitted: account.details_submitted,
      payouts_enabled: account.payouts_enabled
    });
  } catch (e) { res.json({ connected: false }); }
});

// ═══════════════════════════════════════════════════════════
// TRACKING — Click tracking + conversion attribution
// ═══════════════════════════════════════════════════════════

// Track click (called when someone visits takeova.ai/?ref=CODE)
router.get("/track/:code", (req, res) => {
  const db = getDb();
  ensureTables(db);
  try {
    const aff = db.prepare("SELECT id FROM mine_affiliates WHERE code = ? AND status = 'active'").get(req.params.code);
    if (aff) {
      db.prepare("UPDATE mine_affiliates SET clicks = clicks + 1 WHERE id = ?").run(aff.id);
      db.prepare("INSERT INTO mine_affiliate_clicks (id, affiliate_id, ip, user_agent, referrer, landing_page) VALUES (?,?,?,?,?,?)")
        .run(uuid(), aff.id, req.ip || "", req.headers["user-agent"] || "", req.headers.referer || "", req.query.page || "/");
    }
  } catch(e) { console.error("[/track/:code]", e.message || e); }
  // Return tracking pixel (1x1 transparent gif)
  const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.setHeader("Content-Type", "image/gif");
  res.send(pixel);
});

// Record conversion (called internally when a referred user subscribes)
router.post("/conversion", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { ref_code, user_id, plan, amount } = req.body;
  const internalKey = req.headers["x-internal-key"];
  if (!((_k, _s) => _k.length > 0 && _s.length === _k.length && require("crypto").timingSafeEqual(Buffer.from(_s), Buffer.from(_k)))(process.env.INTERNAL_API_KEY || "", internalKey || "")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const aff = db.prepare("SELECT * FROM mine_affiliates WHERE code = ? AND status = 'active'").get(ref_code);
  if (!aff) return res.json({ tracked: false });

  // Self-referral fraud prevention: affiliate cannot refer themselves
  if (aff.user_id === user_id) return res.json({ tracked: false, reason: "self_referral" });

  // Idempotency: prevent double-crediting if webhook fires twice for same user
  const alreadyConverted = db.prepare("SELECT id FROM mine_affiliate_conversions WHERE affiliate_id = ? AND user_id = ?").get(aff.id, user_id);
  if (alreadyConverted) return res.json({ tracked: false, reason: "already_converted" });

  // Calculate commission based on tier
  const tierRates = { "Starter": 18, "Bronze": 20, "Silver": 23, "Gold": 25, "Diamond": 28 };
  let tier = "Starter";
  if (aff.conversions >= 100) tier = "Diamond";
  else if (aff.conversions >= 50) tier = "Gold";
  else if (aff.conversions >= 25) tier = "Silver";
  else if (aff.conversions >= 5) tier = "Bronze";
  const rate = tierRates[tier] || 18;
  const commission = (parseFloat(amount) || 0) * (rate / 100);

  db.prepare("INSERT INTO mine_affiliate_conversions (id, affiliate_id, user_id, plan, amount, commission) VALUES (?,?,?,?,?,?)")
    .run(uuid(), aff.id, user_id, plan || "", amount, commission);

  db.prepare("UPDATE mine_affiliates SET conversions = conversions + 1, signups = signups + 1, revenue_generated = revenue_generated + ?, commission_earned = commission_earned + ? WHERE id = ?")
    .run(amount, commission, aff.id);

  res.json({ tracked: true, commission, rate: rate + "%" });
});

// ═══════════════════════════════════════════════════════════
// PAYOUTS — Stripe transfers only
// ═══════════════════════════════════════════════════════════

// Request manual payout
router.post("/payout", affAuth, async (req, res) => {
  const db = getDb();
  const aff = req.affiliate;
  const pending = aff.commission_earned - aff.commission_paid;
  const minPayout = 50;

  if (pending < minPayout) return res.status(400).json({ error: `Minimum payout is $${minPayout}. You have $${pending.toFixed(2)} pending.` });

  if (!aff.stripe_account_id) {
    return res.status(400).json({ error: "Connect your Stripe account first to receive payouts." });
  }

  try {
    // Re-read fresh balance to prevent race condition / double-payout
    const fresh = db.prepare("SELECT commission_earned, commission_paid FROM mine_affiliates WHERE id = ?").get(aff.id);
    const pendingFresh = fresh.commission_earned - fresh.commission_paid;
    if (pendingFresh < minPayout) return res.status(400).json({ error: "Payout already processed or insufficient balance." });

    const stripe = require("stripe")(getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY);
    const transfer = await stripe.transfers.create({
      amount: Math.round(pendingFresh * 100),
      currency: "usd",
      destination: aff.stripe_account_id,
      description: `MINE Affiliate Payout — ${aff.name} (${aff.code})`,
      metadata: { affiliate_id: aff.id }
    });

    db.prepare("INSERT INTO mine_affiliate_payouts (id, affiliate_id, amount, method, stripe_transfer_id, status) VALUES (?,?,?,?,?,?)")
      .run(uuid(), aff.id, pendingFresh, "stripe", transfer.id, "completed");
    db.prepare("UPDATE mine_affiliates SET commission_paid = commission_paid + ?, last_payout_at = datetime('now') WHERE id = ?")
      .run(pendingFresh, aff.id);

    return res.json({ success: true, amount: pendingFresh, method: "stripe", transferId: transfer.id });
  } catch (e) {
    return console.error("[Route] Stripe payout failed: ", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Auto-payout cron (run monthly via external cron job hitting this endpoint)
router.post("/auto-payout", async (req, res) => {
  const internalKey = req.headers["x-internal-key"];
  if (!((_k, _s) => _k.length > 0 && _s.length === _k.length && require("crypto").timingSafeEqual(Buffer.from(_s), Buffer.from(_k)))(process.env.INTERNAL_API_KEY || "", internalKey || "")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const db = getDb();
  ensureTables(db);
  const minPayout = 50;
  const affiliates = db.prepare("SELECT * FROM mine_affiliates WHERE status = 'active' AND (commission_earned - commission_paid) >= ? AND stripe_account_id IS NOT NULL").all(minPayout);

  let paid = 0, failed = 0, totalAmount = 0;

  for (const aff of affiliates) {
    // Re-read fresh balance inside loop to prevent double-payout if cron overlaps
    const fresh = db.prepare("SELECT commission_earned, commission_paid FROM mine_affiliates WHERE id = ?").get(aff.id);
    const pending = fresh.commission_earned - fresh.commission_paid;
    if (pending < minPayout) continue;

    try {
      const stripe = require("stripe")(getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY);
      const transfer = await stripe.transfers.create({
        amount: Math.round(pending * 100),
        currency: "usd",
        destination: aff.stripe_account_id,
        description: `MINE Monthly Affiliate Payout — ${aff.name}`,
        metadata: { affiliate_id: aff.id, type: "auto_monthly" }
      });
      db.prepare("INSERT INTO mine_affiliate_payouts (id, affiliate_id, amount, method, stripe_transfer_id, status) VALUES (?,?,?,?,?,?)")
        .run(uuid(), aff.id, pending, "stripe", transfer.id, "completed");
      db.prepare("UPDATE mine_affiliates SET commission_paid = commission_paid + ?, last_payout_at = datetime('now') WHERE id = ?").run(pending, aff.id);
      paid++;
      totalAmount += pending;
    } catch (e) { failed++; }
  }

  res.json({ success: true, processed: affiliates.length, paid, failed, totalAmount });
});

// ═══════════════════════════════════════════════════════════
// PUBLIC AFFILIATE PORTAL PAGE (full HTML — no auth needed)
// ═══════════════════════════════════════════════════════════

router.get("/portal", (req, res) => {
  const backendUrl = BACKEND_URL || `${req.protocol}://${req.get("host")}`;
  const frontendUrl = FRONTEND_URL || "https://takeova.ai";
  res.send(getPortalHTML(backendUrl, frontendUrl));
});

// ═══════════════════════════════════════════════════════════
// LEADERBOARD (public — shows top affiliates)
// ═══════════════════════════════════════════════════════════

router.get("/leaderboard", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const top = db.prepare("SELECT name, code, conversions, revenue_generated FROM mine_affiliates WHERE status = 'active' AND conversions > 0 ORDER BY revenue_generated DESC LIMIT 20").all();
  res.json({ leaderboard: top });
});

// ─── Public referrer leaderboard ────────────────────────────────────────
// Top MINE customers (not just dedicated affiliates) by referrals this
// month. Powers the leaderboard widget in the customer dashboard's
// referrals panel. Names are masked for privacy ("Sarah K.").
//
// Returns: { period, top: [{ rank, display_name, signups, revenue }], you: {...} }
router.get("/public-leaderboard", auth, (req, res) => {
  const db = getDb();
  try {
    // Mask: first name + last initial
    function maskName(n) {
      if (!n) return "Anonymous";
      const parts = String(n).trim().split(/\s+/);
      if (parts.length === 1) return parts[0];
      return parts[0] + " " + parts[parts.length - 1].charAt(0).toUpperCase() + ".";
    }

    // Period boundaries — current month (UTC)
    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);
    const periodIso = periodStart.toISOString().slice(0, 10);

    // Top 10 — count referred users created this month + their lifetime commission
    // attributed to the referrer in users.commission_earned column
    const top = db.prepare(`
      SELECT
        u.id          AS user_id,
        u.name        AS name,
        u.referral_code AS code,
        u.commission_earned AS commission_earned,
        (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.referral_code AND r.created_at >= ?) AS signups_this_month,
        (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.referral_code) AS signups_all_time
      FROM users u
      WHERE u.referral_code IS NOT NULL
        AND (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.referral_code AND r.created_at >= ?) > 0
      ORDER BY signups_this_month DESC, commission_earned DESC
      LIMIT 10
    `).all(periodIso, periodIso);

    const ranked = top.map((row, i) => ({
      rank: i + 1,
      display_name: maskName(row.name),
      signups: row.signups_this_month || 0,
      total_signups: row.signups_all_time || 0,
      commission_earned: row.commission_earned || 0,
      is_you: row.user_id === req.userId,
    }));

    // The current user's own stats (in case they're not in the top 10)
    const me = db.prepare(`
      SELECT
        u.name, u.referral_code, u.commission_earned,
        (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.referral_code AND r.created_at >= ?) AS signups_this_month,
        (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.referral_code) AS signups_all_time
      FROM users u WHERE u.id = ?
    `).get(periodIso, req.userId) || {};

    res.json({
      period: periodStart.toISOString().slice(0, 7), // "2026-05"
      top: ranked,
      you: {
        display_name: maskName(me.name),
        signups: me.signups_this_month || 0,
        total_signups: me.signups_all_time || 0,
        commission_earned: me.commission_earned || 0,
        rank: ranked.findIndex(r => r.is_you) + 1 || null,
      },
    });
  } catch (e) {
    console.error("[/public-leaderboard]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function sanitizeAffiliate(a) {
  const { magic_token, magic_token_expires, session_token, session_expires, ...safe } = a;
  return safe;
}

function _escHtml(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function sendMagicLink(db, affiliateId, email, name) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("UPDATE mine_affiliates SET magic_token = ?, magic_token_expires = datetime('now', '+1 hour') WHERE id = ?")
    .run(token, affiliateId);

  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  const frontendUrl = FRONTEND_URL || "https://takeova.ai";
  const backendUrl = BACKEND_URL || "http://localhost:4000";
  const loginUrl = `${backendUrl}/api/affiliates/portal?token=${token}`;
  let emailSent = false;

  if (sgKey) {
    try {
      const fetch = (await import("node-fetch")).default;
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email, name }] }],
          from: { email: getSetting('EMAIL_FROM') || getSetting('FROM_EMAIL') || "affiliates@takeova.ai", name: "MINE Affiliates" },
          subject: "Your TAKEOVA Affiliate Dashboard Login Link",
          content: [{
            type: "text/html",
            value: renderEmail({
              preheader: "Your TAKEOVA affiliate dashboard login link",
              heading: `Hey ${_escHtml(name)}!`,
              bodyHtml: `<p style="${P}">Click below to access your TAKEOVA affiliate dashboard.</p>`,
              cta: { text: "Open my dashboard", url: loginUrl },
              footerNote: `This link expires in 1 hour. After logging in, your session lasts 30 days.<br>Your referral code: ${_escHtml(db.prepare("SELECT code FROM mine_affiliates WHERE id = ?").get(affiliateId)?.code || "")}`,
            })
          }]
        })
      });
      if (r.ok) emailSent = true;
      else console.error("[AFFILIATE MAGIC LINK] SendGrid responded", r.status, await r.text().catch(()=>''));
    } catch (e) { console.error("[AFFILIATE MAGIC LINK] SendGrid error:", e.message); }
  } else {
    console.warn("[AFFILIATE MAGIC LINK] SENDGRID_API_KEY not set — login email NOT sent. Configure SendGrid to deliver affiliate login links.");
  }

  return { token, loginUrl, emailSent };
}

function getPortalHTML(backendUrl, frontendUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MINE Affiliate Program — Earn Up To 28% Recurring Commission</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Mono:wght@700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a0a0a;--card:#151515;--bd:#262626;--tx:#f5f5f5;--dm:#888;--p:#2563EB;--pl:#8B85FF;--gn:#16a34a;--yl:#eab308;}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--tx);-webkit-font-smoothing:antialiased;}
.container{max-width:900px;margin:0 auto;padding:0 20px;}

/* Hero */
.hero{padding:80px 20px 60px;text-align:center;background:radial-gradient(ellipse at top,rgba(99,91,255,.15),transparent 60%);}
.hero h1{font-family:'Space Mono',monospace;font-size:clamp(32px,5vw,52px);letter-spacing:-1px;line-height:1.1;margin-bottom:12px;}
.hero h1 span{background:linear-gradient(135deg,var(--p),var(--pl),#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.hero p{color:var(--dm);font-size:17px;max-width:540px;margin:0 auto 32px;}
.hero-stats{display:flex;justify-content:center;gap:40px;margin-bottom:40px;}
.hero-stat{text-align:center;} .hero-stat .n{font-size:32px;font-weight:700;color:var(--p);} .hero-stat .l{font-size:12px;color:var(--dm);text-transform:uppercase;letter-spacing:1px;margin-top:2px;}

/* Tiers */
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:40px auto;max-width:800px;}
.tier{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:20px;text-align:center;}
.tier .emoji{font-size:28px;margin-bottom:8px;display:block;}
.tier .name{font-weight:700;font-size:15px;margin-bottom:4px;}
.tier .rate{font-size:24px;font-weight:700;color:var(--gn);}
.tier .req{font-size:11px;color:var(--dm);margin-top:4px;}

/* Forms */
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:32px;margin-bottom:20px;}
.card h2{font-size:20px;margin-bottom:16px;}
input,select{width:100%;padding:12px 16px;background:#111;border:1px solid var(--bd);border-radius:8px;color:var(--tx);font-size:14px;font-family:inherit;outline:none;margin-bottom:12px;transition:border .2s;}
input:focus{border-color:var(--p);}
.btn{padding:14px 28px;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;width:100%;transition:transform .15s,box-shadow .15s;}
.btn-primary{background:var(--p);color:#fff;} .btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(99,91,255,.4);}
.btn-ghost{background:transparent;border:1px solid var(--bd);color:var(--tx);} .btn-ghost:hover{border-color:var(--p);}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.row{display:flex;gap:12px;} .row>*{flex:1;}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--gn);color:#fff;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;z-index:999;display:none;animation:slideUp .3s ease;}
@keyframes slideUp{from{transform:translateX(-50%) translateY(20px);opacity:0;}to{transform:translateX(-50%) translateY(0);opacity:1;}}
.error{color:#ef4444;font-size:13px;margin-bottom:8px;}

/* Dashboard */
.dash{display:none;} .dash.active{display:block;}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px;}
.stat{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px;text-align:center;}
.stat .v{font-size:24px;font-weight:700;} .stat .l{font-size:11px;color:var(--dm);text-transform:uppercase;letter-spacing:1px;margin-top:2px;}
.link-box{background:#111;border:1px solid var(--bd);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.link-box code{flex:1;font-size:13px;color:var(--pl);word-break:break-all;} .link-box button{flex-shrink:0;}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;}
th{text-align:left;padding:8px;border-bottom:2px solid var(--bd);color:var(--dm);font-size:11px;text-transform:uppercase;letter-spacing:1px;}
td{padding:8px;border-bottom:1px solid #1a1a1a;}
.badge{padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;}
.badge-gn{background:rgba(22,163,74,.15);color:var(--gn);} .badge-yl{background:rgba(234,179,8,.15);color:var(--yl);}
.badge-p{background:rgba(99,91,255,.15);color:var(--pl);}
.tabs{display:flex;gap:0;border-radius:8px;overflow:hidden;border:1px solid var(--bd);margin-bottom:16px;}
.tab{flex:1;padding:10px;text-align:center;cursor:pointer;font-size:13px;font-weight:600;background:var(--card);color:var(--dm);border:none;transition:all .2s;}
.tab.active{background:var(--p);color:#fff;}
</style></head><body>

<!-- SIGNUP/LOGIN VIEW -->
<div id="auth-view">
<div class="hero">
  <div class="container">
    <h1>Earn <span>Up To 28%</span><br>On Every Referral</h1>
    <p>Join the TAKEOVA affiliate program. Share your link, earn commission on every customer you refer — paid monthly via Stripe.</p>
    <div class="hero-stats">
      <div class="hero-stat"><div class="n">18-28%</div><div class="l">Commission</div></div>
      <div class="hero-stat"><div class="n">90 days</div><div class="l">Cookie Window</div></div>
      <div class="hero-stat"><div class="n">Monthly</div><div class="l">Auto Payouts</div></div>
    </div>
  </div>
</div>

<div class="container" style="padding-top:20px;padding-bottom:60px;">
  <div class="tiers">
    <div class="tier"><span class="emoji">🌱</span><div class="name">Starter</div><div class="rate">18%</div><div class="req">0+ sales</div></div>
    <div class="tier"><span class="emoji">🥉</span><div class="name">Bronze</div><div class="rate">20%</div><div class="req">5+ sales</div></div>
    <div class="tier"><span class="emoji">🥈</span><div class="name">Silver</div><div class="rate">23%</div><div class="req">25+ sales</div></div>
    <div class="tier"><span class="emoji">🥇</span><div class="name">Gold</div><div class="rate">25%</div><div class="req">50+ sales</div></div>
    <div class="tier"><span class="emoji">💎</span><div class="name">Diamond</div><div class="rate">28%</div><div class="req">100+ sales</div></div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:700px;margin:0 auto;">
    <div class="card" id="signup-card">
      <h2>Join the Program</h2>
      <div class="error" id="signup-error"></div>
      <input id="s-name" placeholder="Your name" />
      <input id="s-email" type="email" placeholder="Email address" />
      <input id="s-website" placeholder="Website or blog (optional)" />
      <div class="row">
        <select id="s-platform"><option value="">Platform</option><option>TikTok</option><option>Instagram</option><option>YouTube</option><option>Twitter/X</option><option>Blog</option><option>Other</option></select>
        <input id="s-handle" placeholder="@handle" />
      </div>
      <button class="btn btn-primary" id="signup-btn" onclick="handleSignup()">Create My Affiliate Account</button>
    </div>
    <div class="card" id="login-card">
      <h2>Already an Affiliate?</h2>
      <p style="color:var(--dm);font-size:13px;margin-bottom:16px;">Enter your email and we'll send you a magic login link. No password needed.</p>
      <div class="error" id="login-error"></div>
      <input id="l-email" type="email" placeholder="Your email address" />
      <button class="btn btn-ghost" id="login-btn" onclick="handleLogin()">Send Login Link</button>
      <p id="login-success" style="color:var(--gn);font-size:13px;margin-top:8px;display:none;">Check your email for your login link!</p>
    </div>
  </div>

  <div class="card" style="max-width:700px;margin:40px auto 0;">
    <h2>How It Works</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:16px;">
      <div style="text-align:center;"><div style="font-size:32px;margin-bottom:8px;">🔗</div><div style="font-weight:700;font-size:14px;">Share Your Link</div><div style="font-size:12px;color:var(--dm);margin-top:4px;">Get your unique referral link and share it anywhere — social media, blog, email</div></div>
      <div style="text-align:center;"><div style="font-size:32px;margin-bottom:8px;">📈</div><div style="font-weight:700;font-size:14px;">Track Sales</div><div style="font-size:12px;color:var(--dm);margin-top:4px;">Watch clicks, signups, and conversions in real-time from your dashboard</div></div>
      <div style="text-align:center;"><div style="font-size:32px;margin-bottom:8px;">💸</div><div style="font-weight:700;font-size:14px;">Get Paid Monthly</div><div style="font-size:12px;color:var(--dm);margin-top:4px;">Automatic payouts via Stripe on the 1st of every month</div></div>
    </div>
  </div>
</div>
</div>

<!-- DASHBOARD VIEW -->
<div id="dash-view" class="dash">
<div style="background:var(--card);border-bottom:1px solid var(--bd);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;">
  <div style="display:flex;align-items:center;gap:10px;"><span style="font-size:20px;">⛏️</span><span style="font-weight:700;">MINE</span><span style="color:var(--dm);font-size:13px;">Affiliate Dashboard</span></div>
  <div style="display:flex;align-items:center;gap:12px;"><span id="dash-name" style="font-size:13px;color:var(--dm);"></span><button class="btn btn-ghost" style="width:auto;padding:6px 14px;font-size:12px;" onclick="logout()">Log out</button></div>
</div>
<div class="container" style="padding:24px 20px 60px;">
  <div class="stat-grid" id="stats-grid"></div>

  <div class="tabs">
    <button class="tab active" onclick="showTab('links',this)">🔗 Links</button>
    <button class="tab" onclick="showTab('conversions',this)">💰 Conversions</button>
    <button class="tab" onclick="showTab('payouts',this)">💳 Payouts</button>
    <button class="tab" onclick="showTab('settings',this)">⚙️ Settings</button>
  </div>

  <div id="tab-links" class="card">
    <h2>Your Referral Links</h2>
    <p style="color:var(--dm);font-size:13px;margin-bottom:12px;">Share these links anywhere. We track clicks and attribute sales for 90 days.</p>
    <div id="ref-links"></div>
    <div style="margin-top:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Custom Code</h3>
      <div style="display:flex;gap:8px;">
        <input id="custom-code" placeholder="your-custom-code" style="margin:0;" />
        <button class="btn btn-primary" style="width:auto;padding:10px 20px;" onclick="updateCode()">Save</button>
      </div>
    </div>
  </div>

  <div id="tab-conversions" class="card" style="display:none;">
    <h2>Conversion History</h2>
    <table><thead><tr><th>Date</th><th>Plan</th><th>Revenue</th><th>Commission</th><th>Status</th></tr></thead>
    <tbody id="conv-table"></tbody></table>
  </div>

  <div id="tab-payouts" class="card" style="display:none;">
    <h2>Payouts</h2>
    <div id="payout-balance" style="margin-bottom:16px;"></div>
    <div id="payout-method-setup"></div>
    <table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
    <tbody id="payout-table"></tbody></table>
  </div>

  <div id="tab-settings" class="card" style="display:none;">
    <h2>Profile Settings</h2>
    <input id="set-name" placeholder="Your name" />
    <input id="set-bio" placeholder="Short bio (optional)" />
    <input id="set-website" placeholder="Website URL" />
    <h3 style="font-size:14px;margin:16px 0 8px;">Payout Method</h3>
    <p style="color:var(--dm);font-size:13px;margin-bottom:12px;">Connect your Stripe account to receive payouts. Stripe handles everything — bank details, identity, tax forms.</p>
    <button class="btn btn-ghost" onclick="connectStripe()">Connect Stripe Account</button>
    <div id="stripe-status" style="font-size:12px;color:var(--dm);margin-top:8px;"></div>
    <button class="btn btn-primary" style="margin-top:16px;" onclick="saveSettings()">Save Settings</button>
  </div>
</div>
</div>

<div class="toast" id="toast"></div>

<script>
var API='${backendUrl}/api/affiliates';
var token=null;
var dashData=null;

// Check URL for magic link token
(function(){
  var params=new URLSearchParams(window.location.search);
  var t=params.get('token');
  if(t)verifyToken(t);
  var saved=sessionStorage.getItem('mine_aff_token');
  if(saved&&!t)loadDashboard(saved);
})();

function toast(msg){var el=document.getElementById('toast');el.textContent=msg;el.style.display='block';setTimeout(function(){el.style.display='none';},3000);}

async function handleSignup(){
  var btn=document.getElementById('signup-btn');btn.disabled=true;btn.textContent='Creating...';
  document.getElementById('signup-error').textContent='';
  try{
    var r=await fetch(API+'/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      name:document.getElementById('s-name').value,
      email:document.getElementById('s-email').value,
      website:document.getElementById('s-website').value,
      social_platform:document.getElementById('s-platform').value,
      social_handle:document.getElementById('s-handle').value
    })});
    var d=await r.json();
    if(d.success){toast('Account created! Check your email for login link.');btn.textContent='Check Your Email ✉️';}
    else{document.getElementById('signup-error').textContent=d.error||'Failed';btn.disabled=false;btn.textContent='Create My Affiliate Account';}
  }catch(e){document.getElementById('signup-error').textContent='Network error';btn.disabled=false;btn.textContent='Create My Affiliate Account';}
}

async function handleLogin(){
  var btn=document.getElementById('login-btn');btn.disabled=true;btn.textContent='Sending...';
  document.getElementById('login-error').textContent='';
  try{
    var r=await fetch(API+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('l-email').value})});
    var d=await r.json();
    if(d.success){document.getElementById('login-success').style.display='block';btn.textContent='Link Sent ✉️';}
    else{document.getElementById('login-error').textContent=d.error||'Failed';btn.disabled=false;btn.textContent='Send Login Link';}
  }catch(e){document.getElementById('login-error').textContent='Network error';btn.disabled=false;btn.textContent='Send Login Link';}
}

async function verifyToken(t){
  try{
    var r=await fetch(API+'/verify/'+t);var d=await r.json();
    if(d.token){token=d.token;sessionStorage.setItem('mine_aff_token',token);loadDashboard(token);window.history.replaceState({},'',window.location.pathname);}
  }catch(e) { console.error("[/leaderboard]", e.message || e); }
}

async function loadDashboard(t){
  token=t;
  try{
    var r=await fetch(API+'/dashboard',{headers:{'x-affiliate-token':token}});
    if(!r.ok){sessionStorage.removeItem('mine_aff_token');return;}
    dashData=await r.json();
    renderDashboard();
  }catch(e) { console.error("[/leaderboard]", e.message || e); }
}

function renderDashboard(){
  document.getElementById('auth-view').style.display='none';
  document.getElementById('dash-view').classList.add('active');
  var s=dashData.stats,a=dashData.affiliate;
  document.getElementById('dash-name').textContent=a.name+' ('+a.code+')';
  document.getElementById('stats-grid').innerHTML=
    '<div class="stat"><div class="v">'+s.clicks+'</div><div class="l">Clicks</div></div>'+
    '<div class="stat"><div class="v">'+s.signups+'</div><div class="l">Signups</div></div>'+
    '<div class="stat"><div class="v">'+s.conversions+'</div><div class="l">Sales</div></div>'+
    '<div class="stat"><div class="v" style="color:var(--gn)">$'+s.commissionEarned.toFixed(2)+'</div><div class="l">Earned</div></div>'+
    '<div class="stat"><div class="v" style="color:var(--yl)">$'+s.pendingPayout.toFixed(2)+'</div><div class="l">Pending</div></div>'+
    '<div class="stat"><div class="v"><span class="badge badge-p">'+s.tier+'</span></div><div class="l">'+s.commissionRate+'% Rate</div></div>';
  // Links
  var links=dashData.links;
  document.getElementById('ref-links').innerHTML=Object.entries(links).map(function(e){return '<div class="link-box"><code>'+e[1]+'</code><button class="btn btn-ghost" style="width:auto;padding:6px 12px;font-size:11px;" onclick="navigator.clipboard.writeText(\\''+e[1]+'\\');toast(\\'Copied!\\');">Copy</button></div>';}).join('');
  document.getElementById('custom-code').value=a.code;
  // Conversions
  function hesc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  document.getElementById('conv-table').innerHTML=dashData.conversions.length?dashData.conversions.map(function(c){var cs=c.status==='pending'?'pending':'paid';return '<tr><td>'+new Date(c.created_at).toLocaleDateString()+'</td><td>'+hesc(c.plan)+'</td><td>$'+(parseFloat(c.amount)||0).toFixed(2)+'</td><td style="color:var(--gn)">$'+(parseFloat(c.commission)||0).toFixed(2)+'</td><td><span class="badge '+(cs==='pending'?'badge-yl':'badge-gn')+'">'+cs+'</span></td></tr>';}).join(''):'<tr><td colspan="5" style="text-align:center;color:var(--dm);padding:20px;">No conversions yet — share your link to start earning!</td></tr>';
  // Payouts
  document.getElementById('payout-balance').innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;"><div><span style="font-size:24px;font-weight:700;color:var(--gn);">$'+s.pendingPayout.toFixed(2)+'</span><span style="color:var(--dm);font-size:13px;margin-left:8px;">available</span></div>'+(s.canCashOut?'<button class="btn btn-primary" style="width:auto;padding:10px 20px;" onclick="requestPayout()">Request Payout</button>':'<span style="color:var(--dm);font-size:12px;">Min payout: $'+s.minPayout+'</span>')+'</div>';
  document.getElementById('payout-table').innerHTML=dashData.payouts.length?dashData.payouts.map(function(p){return '<tr><td>'+new Date(p.created_at).toLocaleDateString()+'</td><td style="font-weight:700">$'+(parseFloat(p.amount)||0).toFixed(2)+'</td><td>'+hesc(p.method)+'</td><td><span class="badge badge-gn">paid</span></td></tr>';}).join(''):'<tr><td colspan="4" style="text-align:center;color:var(--dm);padding:20px;">No payouts yet</td></tr>';
  // Settings
  document.getElementById('set-name').value=a.name||'';
  document.getElementById('set-bio').value=a.bio||'';
  document.getElementById('set-website').value=a.website||'';
  checkStripeStatus();
}

function showTab(id,el){
  document.querySelectorAll('[id^="tab-"]').forEach(function(t){t.style.display='none';});
  document.getElementById('tab-'+id).style.display='block';
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
  el.classList.add('active');
}

async function connectStripe(){
  try{var r=await fetch(API+'/connect-stripe',{method:'POST',headers:{'x-affiliate-token':token}});var d=await r.json();
  if(d.url)window.location.href=d.url;else toast(d.error||'Failed');}catch(e){toast('Error');}
}

async function checkStripeStatus(){
  try{var r=await fetch(API+'/connect-status',{headers:{'x-affiliate-token':token}});var d=await r.json();
  document.getElementById('stripe-status').textContent=d.connected?'✅ Stripe connected — payouts enabled':'⚠️ Stripe not connected yet. Connect to receive payouts.';}catch(e) { console.error("[/leaderboard]", e.message || e); }
}

async function updateCode(){
  var code=document.getElementById('custom-code').value;
  try{var r=await fetch(API+'/code',{method:'PUT',headers:{'Content-Type':'application/json','x-affiliate-token':token},body:JSON.stringify({code:code})});
  var d=await r.json();if(d.success){toast('Code updated to: '+d.code);loadDashboard(token);}else toast(d.error||'Failed');}catch(e){toast('Error');}
}

async function saveSettings(){
  try{await fetch(API+'/profile',{method:'PUT',headers:{'Content-Type':'application/json','x-affiliate-token':token},body:JSON.stringify({
    name:document.getElementById('set-name').value,
    bio:document.getElementById('set-bio').value,
    website:document.getElementById('set-website').value
  })});toast('Settings saved!');}catch(e){toast('Error');}
}

async function requestPayout(){
  try{var r=await fetch(API+'/payout',{method:'POST',headers:{'x-affiliate-token':token}});var d=await r.json();
  if(d.success){toast('Payout of $'+d.amount.toFixed(2)+' sent via '+d.method+'!');loadDashboard(token);}else toast(d.error||'Failed');}catch(e){toast('Error');}
}

function logout(){token=null;sessionStorage.removeItem('mine_aff_token');document.getElementById('auth-view').style.display='block';document.getElementById('dash-view').classList.remove('active');}
</script></body></html>`;
}


// ─── OWNER-FACING AFFILIATE PROGRAM SUMMARY ───
// Uses normal JWT auth (not affiliate magic token)
router.get("/program-summary", auth, (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    // Look up this user's own affiliate record (if they signed up as a platform affiliate)
    const user = db.prepare("SELECT email FROM users WHERE id = ?").get(req.userId);
    const aff = user ? db.prepare("SELECT * FROM mine_affiliates WHERE email = ?").get(user.email) : null;
    if (!aff) return res.json({ success: true, enrolled: false, stats: null });
    const clicks = db.prepare("SELECT COUNT(*) as n FROM mine_affiliate_clicks WHERE affiliate_id = ?").get(aff.id)?.n || 0;
    const conversions = db.prepare("SELECT * FROM mine_affiliate_conversions WHERE affiliate_id = ?").all(aff.id);
    const totalEarnings = conversions.reduce((s, c) => s + (c.commission || 0), 0);
    res.json({ success: true, enrolled: true, affiliate: { ...aff, referral_link: `https://takeova.ai?ref=${aff.code}` }, stats: { clicks, conversions: conversions.length, totalEarnings, pendingPayout: aff.commission_earned - aff.commission_paid } });
  } catch(e) {
    res.json({ success: true, enrolled: false, stats: null });
  }
});

module.exports = router;
module.exports.getPortalHTML = getPortalHTML;
