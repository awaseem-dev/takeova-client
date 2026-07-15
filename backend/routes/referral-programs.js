/**
 * referral-programs.js
 *
 * Handles three related but distinct programs:
 *
 * 1. TAKEOVA Platform Affiliates  — users earn % of TAKEOVA's subscription revenue
 *    by referring other businesses to sign up to MINE directly.
 *    GET  /api/affiliates/program          → user's affiliate stats + link
 *    POST /api/affiliates/payout           → request payout of earned commission
 *
 * 2. Business Affiliate Programs — users set up their OWN affiliate program
 *    so their customers/influencers can promote their business.
 *    POST /api/affiliates/setup            → create/update program settings
 *    POST /api/affiliates/invite           → invite someone to be a business affiliate
 *    GET  /api/affiliates/my-affiliates    → list of business affiliates
 *
 * 3. Agency Invite Link
 *    GET  /api/agency/invite-link          → shareable link to recruit clients
 *
 * These routes are mounted in server.js alongside the existing routes.
 */

const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const crypto  = require("crypto");

const FRONTEND_URL = process.env.FRONTEND_URL || "https://takeova.ai";

function auth(req, res, next) {
  const m = require("../middleware/auth");
  m.auth(req, res, next);
}
function agencyAuth(req, res, next) {
  const db = getDb();
  const agency = db.prepare("SELECT * FROM agencies WHERE user_id = ?").get(req.userId);
  if (!agency) return res.status(403).json({ error: "Agency account required" });
  req.agency = agency;
  next();
}
function getDb() { return require("../db/init").getDb(); }

// ─────────────────────────────────────────────────────────────────────────────
// TABLE SETUP
// ─────────────────────────────────────────────────────────────────────────────

function ensureTables(db) {
  db.exec(`
    -- Business affiliate program settings (one per user/business)
    CREATE TABLE IF NOT EXISTS biz_affiliate_programs (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT UNIQUE NOT NULL,
      commission_percent REAL    DEFAULT 15,
      cookie_days        INTEGER DEFAULT 30,
      min_payout         REAL    DEFAULT 50,
      enabled            INTEGER DEFAULT 1,
      created_at         TEXT    DEFAULT (datetime('now')),
      updated_at         TEXT    DEFAULT (datetime('now'))
    );

    -- Business affiliates (people promoting a user's business)
    CREATE TABLE IF NOT EXISTS biz_affiliates (
      id            TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,        -- the business owner
      name          TEXT NOT NULL,
      email         TEXT NOT NULL,
      code          TEXT UNIQUE NOT NULL,
      clicks        INTEGER DEFAULT 0,
      sales         INTEGER DEFAULT 0,
      revenue       REAL    DEFAULT 0,
      commission    REAL    DEFAULT 0,
      commission_paid REAL  DEFAULT 0,
      status        TEXT    DEFAULT 'pending',
      invited_at    TEXT    DEFAULT (datetime('now')),
      joined_at     TEXT
    );

    -- Ensure users table has referral_code column
    -- (safe no-op if already exists)
    CREATE TABLE IF NOT EXISTS _dummy_check_users (id TEXT);
  `);

  // Add referral_code to users if missing (safe migration)
  try {
    db.exec("ALTER TABLE users ADD COLUMN referral_code TEXT");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE users ADD COLUMN commission_earned REAL DEFAULT 0");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE users ADD COLUMN commission_paid REAL DEFAULT 0");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE users ADD COLUMN referred_by TEXT");
  } catch (_) {}

  // Ensure agencies table has invite_code column
  try {
    db.exec("ALTER TABLE agencies ADD COLUMN invite_code TEXT");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE agencies ADD COLUMN total_commission_paid REAL DEFAULT 0");
  } catch (_) {}
}

// Generate a short unique code
function genCode(prefix, length = 6) {
  return (prefix || "") + crypto.randomBytes(length).toString("hex").toUpperCase().slice(0, length);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MINE PLATFORM AFFILIATE PROGRAM
//    Users earn recurring commission for referring businesses to MINE.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/affiliates/program
 *
 * Returns the current user's participation in the TAKEOVA affiliate program.
 * Used by the "Earn from MINE" panel in the mine dashboard.
 *
 * Response:
 *   { enrolled, referral_code, referral_link, stats, tier, rate, referrals }
 */
router.get("/affiliates/program", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  // Get or create referral code for this user
  let user = db.prepare("SELECT id, email, name, referral_code, commission_earned, commission_paid FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  // Auto-generate referral code if missing
  if (!user.referral_code) {
    let code;
    let attempts = 0;
    do {
      const base = (user.name || user.email || "user").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
      code = base + crypto.randomBytes(2).toString("hex");
      attempts++;
    } while (
      db.prepare("SELECT id FROM users WHERE referral_code = ?").get(code) &&
      attempts < 10
    );
    db.prepare("UPDATE users SET referral_code = ? WHERE id = ?").run(code, req.userId);
    user.referral_code = code;
  }

  // Count referrals
  const referrals = db.prepare(
    "SELECT id, email, name, plan, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC"
  ).all(req.userId);

  const converted = referrals.filter(r => r.plan && r.plan !== "trial");
  const earned    = parseFloat(user.commission_earned || 0);
  const paid      = parseFloat(user.commission_paid   || 0);
  const pending   = Math.max(0, earned - paid);

  // Tier logic
  const count = converted.length;
  let tier = "Starter", rate = 18;
  if      (count >= 100) { tier = "Diamond"; rate = 28; }
  else if (count >= 50)  { tier = "Gold";    rate = 25; }
  else if (count >= 25)  { tier = "Silver";  rate = 23; }
  else if (count >= 5)   { tier = "Bronze";  rate = 20; }

  const nextTierAt = count >= 100 ? null : count >= 50 ? 100 : count >= 25 ? 50 : count >= 5 ? 25 : 5;

  res.json({
    enrolled:       true,
    referral_code:  user.referral_code,
    referral_link:  `${FRONTEND_URL}?ref=${user.referral_code}`,
    tier,
    rate,
    nextTierAt,
    stats: {
      referrals:    referrals.length,
      converted:    converted.length,
      pending,
      total_earned: earned,
      total_paid:   paid,
    },
    referrals: referrals.map(r => ({
      email:       r.email,
      name:        r.name,
      plan:        r.plan,
      status:      (r.plan && r.plan !== "trial") ? "converted" : "signed_up",
      created_at:  r.created_at,
    })),
  });
});

/**
 * POST /api/affiliates/payout
 *
 * Request a payout of pending referral commission.
 * Requires Stripe Connect (falls back to queuing if not set up).
 */
router.post("/affiliates/payout", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);

  const user = db.prepare(
    "SELECT id, commission_earned, commission_paid, stripe_connect_id FROM users WHERE id = ?"
  ).get(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const pending = parseFloat(user.commission_earned || 0) - parseFloat(user.commission_paid || 0);
  if (pending < 50) {
    return res.status(400).json({ error: `Minimum payout is $50. You have $${pending.toFixed(2)} pending.` });
  }

  // Try Stripe transfer if Stripe Connect is set up
  if (user.stripe_connect_id) {
    try {
      const stripeKey = db.prepare("SELECT value FROM platform_settings WHERE key = 'STRIPE_SECRET_KEY'").get()?.value
        || process.env.STRIPE_SECRET_KEY;
      const stripe = require("stripe")(stripeKey);

      const transfer = await stripe.transfers.create({
        amount:      Math.round(pending * 100),
        currency:    "usd",
        destination: user.stripe_connect_id,
        description: `MINE Referral Commission Payout`,
        metadata:    { user_id: req.userId },
      });

      db.prepare("UPDATE users SET commission_paid = commission_paid + ? WHERE id = ?").run(pending, req.userId);

      // Log notification
      try {
        db.prepare(
          "INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)"
        ).run(uuid(), req.userId, "💸", `Referral payout of $${pending.toFixed(2)} sent via Stripe.`, "Just now");
      } catch (_) {}

      return res.json({ success: true, amount: pending, transfer_id: transfer.id });
    } catch (e) {
      console.error("[referral-payout] Stripe error:", e.message);
      // Fall through to queued payout
    }
  }

  // Queue payout (processed manually or on next cron)
  db.prepare("UPDATE users SET commission_paid = commission_paid + ? WHERE id = ?").run(pending, req.userId);
  try {
    db.prepare(
      "INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)"
    ).run(uuid(), req.userId, "💸", `Payout of $${pending.toFixed(2)} requested — processing within 2 business days.`, "Just now");
  } catch (_) {}

  res.json({ success: true, amount: pending, method: "queued" });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BUSINESS AFFILIATE PROGRAMS
//    Users set up their own affiliate program to promote their business.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/affiliates/setup
 *
 * Create or update the user's business affiliate program settings.
 * Body: { commissionPercent, cookieDays, minPayout }
 */
router.post("/affiliates/setup", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  const { commissionPercent, cookieDays, minPayout } = req.body;
  const pct  = Math.max(1, Math.min(50, parseFloat(commissionPercent) || 15));
  const days = Math.max(7, Math.min(365, parseInt(cookieDays) || 30));
  const min  = Math.max(10, parseFloat(minPayout) || 50);

  const existing = db.prepare("SELECT id FROM biz_affiliate_programs WHERE user_id = ?").get(req.userId);

  if (existing) {
    db.prepare(`
      UPDATE biz_affiliate_programs
      SET commission_percent = ?, cookie_days = ?, min_payout = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(pct, days, min, req.userId);
  } else {
    db.prepare(`
      INSERT INTO biz_affiliate_programs (id, user_id, commission_percent, cookie_days, min_payout)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), req.userId, pct, days, min);
  }

  res.json({
    success: true,
    program: {
      commission_percent: pct,
      cookie_days:        days,
      min_payout:         min,
      enabled:            1,
    },
  });
});

/**
 * POST /api/affiliates/pause
 *
 * Temporarily disable the affiliate program. Existing affiliates keep their
 * historical data and pending commissions, but new clicks/signups are blocked
 * and no new commission is accrued. Re-enable by calling /affiliates/resume.
 */
router.post("/affiliates/pause", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const existing = db.prepare("SELECT id FROM biz_affiliate_programs WHERE user_id = ?").get(req.userId);
  if (!existing) return res.status(404).json({ error: "No affiliate program to pause" });
  db.prepare("UPDATE biz_affiliate_programs SET enabled = 0, updated_at = datetime('now') WHERE user_id = ?").run(req.userId);
  res.json({ success: true, enabled: 0, message: "Affiliate program paused. New referrals won't earn commission until you resume." });
});

/**
 * POST /api/affiliates/resume
 *
 * Re-enable a paused affiliate program.
 */
router.post("/affiliates/resume", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const existing = db.prepare("SELECT id FROM biz_affiliate_programs WHERE user_id = ?").get(req.userId);
  if (!existing) return res.status(404).json({ error: "No affiliate program to resume" });
  db.prepare("UPDATE biz_affiliate_programs SET enabled = 1, updated_at = datetime('now') WHERE user_id = ?").run(req.userId);
  res.json({ success: true, enabled: 1, message: "Affiliate program resumed." });
});

/**
 * DELETE /api/affiliates/program
 *
 * Permanently delete the affiliate program. Requires explicit confirmation.
 * This removes the program config but preserves historical records (affiliates,
 * conversions, payouts) for accounting/audit purposes. Pending commissions
 * must be paid out FIRST or explicitly written off.
 *
 * Body: { confirm: "DELETE", writeOffPending: false }
 */
router.delete("/affiliates/program", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  // Hard confirmation required (prevents accidental clicks)
  if (req.body.confirm !== "DELETE") {
    return res.status(400).json({ error: "Type 'DELETE' in the confirm field to proceed." });
  }

  const program = db.prepare("SELECT * FROM biz_affiliate_programs WHERE user_id = ?").get(req.userId);
  if (!program) return res.status(404).json({ error: "No affiliate program found" });

  // Check for pending commissions owed to affiliates
  const pendingRow = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(commission - commission_paid), 0) as pending_amount
    FROM biz_affiliates
    WHERE owner_user_id = ? AND (commission - commission_paid) > 0
  `).get(req.userId);

  if (pendingRow.count > 0 && !req.body.writeOffPending) {
    return res.status(409).json({
      error: "Cannot delete — unpaid commissions exist",
      pending_affiliates: pendingRow.count,
      pending_amount: pendingRow.pending_amount,
      hint: "Pay out all affiliates first, OR pass { writeOffPending: true } to delete anyway (not recommended — may breach contracts)."
    });
  }

  // Soft delete: mark program deleted but keep historical data
  db.prepare("DELETE FROM biz_affiliate_programs WHERE user_id = ?").run(req.userId);
  // Mark all affiliates as removed (don't delete their historical records)
  db.prepare("UPDATE biz_affiliates SET status = 'program_deleted' WHERE owner_user_id = ?").run(req.userId);

  res.json({
    success: true,
    message: "Affiliate program deleted. Historical records preserved for accounting.",
    affiliates_marked_removed: db.prepare("SELECT COUNT(*) as c FROM biz_affiliates WHERE owner_user_id = ? AND status = 'program_deleted'").get(req.userId).c
  });
});

/**
 * GET /api/affiliates/program-settings
 *
 * Returns the user's business affiliate program config.
 */
router.get("/affiliates/program-settings", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  const program = db.prepare("SELECT * FROM biz_affiliate_programs WHERE user_id = ?").get(req.userId);
  const affiliates = program
    ? db.prepare("SELECT * FROM biz_affiliates WHERE owner_user_id = ? ORDER BY invited_at DESC").all(req.userId)
    : [];

  res.json({ program: program || null, affiliates });
});

/**
 * POST /api/affiliates/invite
 *
 * Invite someone to be an affiliate for the user's business.
 * Body: { name, email, commission_rate? }
 */
router.post("/affiliates/invite", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);

  const { name, email, commission_rate } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Name and email required" });

  // Check program exists
  const program = db.prepare("SELECT * FROM biz_affiliate_programs WHERE user_id = ?").get(req.userId);
  if (!program) return res.status(400).json({ error: "Set up your affiliate program first" });

  // Check for existing invite
  const existing = db.prepare(
    "SELECT id FROM biz_affiliates WHERE owner_user_id = ? AND email = ?"
  ).get(req.userId, email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: "Already invited" });

  const id   = uuid();
  const code = genCode("", 8);
  const rate = commission_rate || program.commission_percent;

  db.prepare(`
    INSERT INTO biz_affiliates (id, owner_user_id, name, email, code)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.userId, name.trim(), email.toLowerCase().trim(), code);

  // Send invite email via SendGrid if configured
  const sgKey = db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value
    || process.env.SENDGRID_API_KEY;

  if (sgKey) {
    try {
      const ownerUser = db.prepare("SELECT name, email FROM users WHERE id = ?").get(req.userId);
      const fromEmail = db.prepare("SELECT value FROM platform_settings WHERE key = 'FROM_EMAIL'").get()?.value
        || "noreply@takeova.ai";
      const inviteUrl = `${FRONTEND_URL}/affiliate-join?code=${code}&from=${encodeURIComponent(ownerUser?.name || "A business")}`;

      const fetch = (await import("node-fetch")).default;
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: email.toLowerCase().trim(), name: name.trim() }] }],
          from: { email: fromEmail, name: ownerUser?.name || "MINE" },
          subject: `You've been invited to promote ${ownerUser?.name || "a business"} — earn ${rate}% commission`,
          content: [{
            type: "text/html",
            value: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
              <h2>Hi ${name.split(" ")[0]}! 👋</h2>
              <p><strong>${ownerUser?.name || "A business owner"}</strong> has invited you to join their affiliate program.</p>
              <ul style="line-height:2;">
                <li>Earn <strong>${rate}%</strong> commission on every sale you refer</li>
                <li>Tracked automatically — no spreadsheets</li>
                <li>Paid out monthly via Stripe</li>
              </ul>
              <a href="${inviteUrl}" style="display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0;">Accept Invitation →</a>
              <p style="font-size:12px;color:#999;margin-top:24px;">Your unique affiliate code: <strong>${code}</strong></p>
            </div>`,
          }],
        }),
      });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    } catch (e) {
      console.error("[affiliate-invite] Email failed:", e.message);
    }
  }

  res.json({ success: true, code, message: `Invite sent to ${email}` });
});

/**
 * GET /api/affiliates/my-affiliates
 *
 * Returns the list of people promoting the user's business.
 */
router.get("/affiliates/my-affiliates", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const affiliates = db.prepare(
    "SELECT * FROM biz_affiliates WHERE owner_user_id = ? ORDER BY invited_at DESC"
  ).all(req.userId);
  res.json({ affiliates });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. AGENCY INVITE LINK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/agency/invite-link
 *
 * Returns the agency's shareable client signup link.
 * Automatically generates and saves a unique invite code if not set.
 *
 * Response:
 *   { invite_link, code, agency_name, stats: { clients, commission_paid } }
 */
router.get("/agency/invite-link", auth, agencyAuth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  let agency = req.agency;

  // Auto-generate invite code if missing
  if (!agency.invite_code) {
    const code = genCode("", 6);
    db.prepare("UPDATE agencies SET invite_code = ? WHERE id = ?").run(code, agency.id);
    agency.invite_code = code;
  }

  const agencyName  = agency.agency_name || agency.name || "My Agency";
  const inviteLink  = `${FRONTEND_URL}/agency-invite.html?code=${agency.invite_code}&agency=${encodeURIComponent(agencyName)}`;

  // Client count
  let clientCount = 0;
  try {
    clientCount = db.prepare("SELECT COUNT(*) as n FROM agency_clients WHERE agency_id = ?").get(agency.id)?.n || 0;
  } catch (_) {}

  res.json({
    invite_link:  inviteLink,
    code:         agency.invite_code,
    agency_name:  agencyName,
    stats: {
      clients:          clientCount,
      commission_paid:  parseFloat(agency.total_commission_paid || 0),
    },
  });
});

/**
 * POST /api/agency/invite-link/regenerate
 *
 * Generate a new invite code (invalidates the old one).
 */
router.post("/agency/invite-link/regenerate", auth, agencyAuth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  const code       = genCode("", 6);
  const agencyName = req.agency.agency_name || req.agency.name || "My Agency";

  db.prepare("UPDATE agencies SET invite_code = ? WHERE id = ?").run(code, req.agency.id);

  res.json({
    success:      true,
    invite_link:  `${FRONTEND_URL}/agency-invite.html?code=${code}&agency=${encodeURIComponent(agencyName)}`,
    code,
  });
});

module.exports = router;
