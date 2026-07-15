const express = require("express");
const bcrypt = require("bcryptjs");

function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#x27;"); }
const { v4: uuid } = require("uuid");
const OTPAuth = require("otpauth");
const { getDb } = require("../db/init");
const { renderEmail, P } = require("../utils/email-template");
const { signToken, auth, revokeToken, blockImpersonation } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";

// ─── Strict rate limiter for auth endpoints (5 attempts per 15 min per IP) ───
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: "Too many attempts — please wait 15 minutes and try again" },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed attempts
});

// ─── Looser limiter for signup (10 per hour) ───
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many signup attempts — please try again later" },
});

const getSetting = (key) => { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(key)?.value; } catch { return null; } };

// ─── Email verification + subscription status: ensure schema columns exist ───
(function migrateEmailVerification(){
  try {
    const db = getDb();
    try { db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE users ADD COLUMN verification_token TEXT"); } catch {}
    try { db.exec("ALTER TABLE users ADD COLUMN verification_sent_at TEXT"); } catch {}
    // subscription_status: tracks Stripe subscription lifecycle
    // Values: null (no sub) | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired'
    try { db.exec("ALTER TABLE users ADD COLUMN subscription_status TEXT"); } catch {}
  } catch (e) { /* schema not yet ready; will retry on first call */ }
})();

// ─── Helper: send verification email via SendGrid ───
async function sendVerificationEmail(email, name, token) {
  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
  if (!sgKey) {
    console.warn("[verify-email] SENDGRID_API_KEY not configured — verification email skipped");
    return false;
  }
  const verifyUrl = `${BACKEND_URL}/api/auth/verify/${token}`;
  const firstName = (name || "there").split(" ")[0].replace(/[\r\n]/g, "");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: email.toLowerCase().trim() }] }],
        from: { email: fromEmail, name: "MINE" },
        subject: `Verify your email — TAKEOVA`,
        content: [{ type: "text/html", value: renderEmail({
          preheader: "Confirm your email to finish setting up TAKEOVA",
          heading: "Confirm your email",
          intro: `Hi ${esc(firstName)},`,
          bodyHtml: `<p style="${P}">Tap the button below to confirm your email and unlock everything in your TAKEOVA account.</p>`,
          cta: { text: "Verify my email", url: verifyUrl },
          footerNote: `If the button doesn't work, paste this link into your browser: ${verifyUrl}<br><br>If you didn't create a TAKEOVA account, you can safely ignore this email.`,
        }) }],
      }),
    });
    if (!r.ok) {
      console.error("[verify-email] SendGrid error", r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[verify-email] error:", e.message);
    return false;
  }
}

// ─── SIGNUP ───
// Display-name sanitizer lives in ../lib/sanitize.js (extracted so it can be unit-tested).
const { cleanName: _cleanName } = require("../lib/sanitize");

router.post("/signup", signupLimiter, async (req, res) => {
  try {
    let { email, password, name, agencyCode } = req.body;
    name = _cleanName(name);
    // Read referral code from body OR cookie (set by landing page tracker)
    const referralCode = req.body.referralCode || (req.cookies && req.cookies.mine_ref) || null;
    if (!email || !password || !name) return res.status(400).json({ error: "All fields required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be 8+ characters" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Valid email required" });

    const db = getDb();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const id = uuid();
    const hash = await bcrypt.hash(password, 12);
    // Generate verification token (sent in the welcome email; user clicks to verify)
    const verifyToken = require("crypto").randomBytes(32).toString("hex");
    // Generate unique referral code — retry if collision (rare but possible)
    let refCode, attempts = 0;
    do {
      refCode = uuid().split("-")[0].toUpperCase();
      attempts++;
    } while (db.prepare("SELECT id FROM users WHERE referral_code = ?").get(refCode) && attempts < 10);

    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, referral_code, referred_by, plan, trial_ends_at, created_at, email_verified, verification_token, verification_sent_at)
      VALUES (?, ?, ?, ?, ?, ?, 'starter', NULL, datetime('now'), 0, ?, datetime('now'))
    `).run(id, email.toLowerCase().trim(), hash, name.trim(), refCode, referralCode || null, verifyToken);
  try { // auto-attach pending team invites sent to this email
    db.exec("CREATE TABLE IF NOT EXISTS team_members (id TEXT PRIMARY KEY, owner_user_id TEXT, member_user_id TEXT, email TEXT, name TEXT, role TEXT DEFAULT 'editor', status TEXT DEFAULT 'invited', invite_token TEXT, created_at TEXT DEFAULT (datetime('now')), accepted_at TEXT)");
    db.prepare("UPDATE team_members SET member_user_id=?, status='active', accepted_at=datetime('now'), invite_token=NULL WHERE LOWER(email)=? AND status='invited'").run(userId, String(email||"").toLowerCase());
  } catch (_tm) {}


    const token = signToken(id, "user");
    // NOTE: user is fetched again AFTER agencyCode linking (below) so the
    // response reflects the correct plan/is_agency_client. Placeholder here.
    let user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);

    // Log
    db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)").run(id, "signup", email);

    // Claim a site built on the landing page (guest build) into the new account, so it appears in the dashboard
    try {
      const _ct = req.body && req.body.claimToken;
      if (_ct) {
        const gb = db.prepare("SELECT * FROM guest_builds WHERE token = ? AND claimed = 0").get(String(_ct));
        if (gb && gb.html) {
          const _siteId = uuid();
          const _siteName = gb.prompt ? String(gb.prompt).slice(0, 40) : "My Website";
          db.prepare("INSERT INTO sites (id, user_id, name, template, html, status) VALUES (?,?,?,?,?,'draft')").run(_siteId, id, _siteName, gb.template_key || null, gb.html);
          db.prepare("UPDATE guest_builds SET claimed = 1, claimed_by = ? WHERE token = ?").run(id, String(_ct));
        }
      }
    } catch (e) { console.error("[signup claim]", e.message); }

    // Create welcome notification
    db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)").run(
      uuid(), id, "🎉", "Welcome to TAKEOVA! Build your first site to get started.", "Just now"
    );

    // ── Auto-create partner record so they can track referrals immediately ──
    try {
      db.exec("CREATE TABLE IF NOT EXISTS mine_partners (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, channel TEXT, audience TEXT, website TEXT, referral_code TEXT UNIQUE, clicks INTEGER DEFAULT 0, signups INTEGER DEFAULT 0, revenue_generated REAL DEFAULT 0, commission_earned REAL DEFAULT 0, commission_paid REAL DEFAULT 0, tier TEXT DEFAULT 'bronze', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')))");
      const existingPartner = db.prepare("SELECT id FROM mine_partners WHERE email=?").get(email.toLowerCase());
      if (!existingPartner) {
        db.prepare("INSERT OR IGNORE INTO mine_partners (id, name, email, referral_code, channel) VALUES (?,?,?,?,?)").run(uuid(), name, email.toLowerCase(), refCode, "mine_user");
      }
    } catch(e) { /* non-fatal */ }

    // ═══════════════════════════════════════════════════════════════════
    // TWO-SIDED REWARDS + REAL-TIME REFERRER NOTIFICATION
    //
    // When a new user signs up via a referral link, two things happen:
    //   1. The NEW user gets a "first month 50% off" credit, automatically
    //      applied when they upgrade to a paid plan.
    //   2. The ORIGINAL referrer gets an in-app notification + email
    //      RIGHT NOW (not on day 7) so they see signups in real time.
    //
    // Both nudges make TAKEOVA's referral loop materially stickier:
    //   - Two-sided rewards roughly double new-user conversion
    //     (Dropbox-style)
    //   - Real-time notifications roughly double share rate
    //     (dopamine-hit effect)
    // ═══════════════════════════════════════════════════════════════════
    if (referralCode) {
      try {
        // Lazy migration: ensure the signup_credit columns exist on users.
        try { db.exec("ALTER TABLE users ADD COLUMN signup_credit_pct INTEGER DEFAULT 0"); } catch (_) {}
        try { db.exec("ALTER TABLE users ADD COLUMN signup_credit_used INTEGER DEFAULT 0"); } catch (_) {}
        try { db.exec("ALTER TABLE users ADD COLUMN signup_credit_source TEXT"); } catch (_) {}

        // 1) Give the NEW user a 50% off first-month credit
        db.prepare(`
          UPDATE users
          SET signup_credit_pct = 50,
              signup_credit_used = 0,
              signup_credit_source = ?
          WHERE id = ?
        `).run(referralCode, id);

        // In-app welcome bonus notification for the new user
        db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)").run(
          uuid(), id, "🎁",
          "You got 50% off your first month — automatically applied when you upgrade.",
          "Just now"
        );

        // 2) Find the referrer and notify them in real time
        const referrer = db.prepare("SELECT id, name, email FROM users WHERE referral_code = ?").get(referralCode);
        if (referrer) {
          const firstName = (name || email.split("@")[0] || "Someone").split(" ")[0];
          db.prepare("INSERT INTO notifications (id, user_id, type, icon, text, time) VALUES (?, ?, ?, ?, ?, ?)").run(
            uuid(), referrer.id, "referral_signup", "🎉",
            firstName + " just signed up using your link — you'll earn commission when they upgrade.",
            "Just now"
          );

          // Bump referrer's mine_partners signup counter for dashboard analytics
          try {
            db.prepare("UPDATE mine_partners SET signups = signups + 1 WHERE referral_code = ?").run(referralCode);
          } catch (_) {}

          // Best-effort real-time email — fire and forget so it doesn't slow signup
          (async () => {
            try {
              const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
              const fromEmail = getSetting("EMAIL_FROM") || "hello@takeova.ai";
              if (!sgKey || !referrer.email) return;
              const fetch = (await import("node-fetch")).default;
              await fetch("https://api.sendgrid.com/v3/mail/send", {
                method: "POST",
                headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
                body: JSON.stringify({
                  personalizations: [{ to: [{ email: referrer.email }] }],
                  from: { email: fromEmail, name: "MINE" },
                  subject: "🎉 " + firstName + " just signed up using your link",
                  content: [{
                    type: "text/html",
                    value: `
                      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">
                        <h2 style="font-size:22px;margin:0 0 12px">🎉 You just earned a new referral</h2>
                        <p style="color:#555;line-height:1.55">
                          ${firstName} just signed up to MINE using your referral link.
                          When they upgrade to a paid plan, you'll earn recurring commission
                          every month for as long as they stay subscribed.
                        </p>
                        <div style="background:#F3F4F6;border-radius:12px;padding:16px;margin:18px 0">
                          <div style="font-size:13px;color:#6B7280;margin-bottom:6px">Quick maths</div>
                          <div style="font-size:14px;line-height:1.7">
                            <strong>If they pick Growth ($99/mo):</strong> $12.87/mo to you<br>
                            <strong>If they pick Pro ($199/mo):</strong> $25.87/mo to you<br>
                            <strong>If they pick Enterprise:</strong> custom commission
                          </div>
                        </div>
                        <p style="color:#555;line-height:1.55">
                          Share your link with one more business owner today —
                          it compounds fast.
                        </p>
                        <a href="${FRONTEND_URL || "https://takeova.ai"}/dashboard?panel=referrals"
                           style="display:inline-block;background:#6366F1;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">
                          View your referral dashboard →
                        </a>
                        <p style="font-size:12px;color:#9CA3AF;margin-top:24px">— Team TAKEOVA</p>
                      </div>`
                  }]
                })
              }).catch(() => {});
            } catch (_) { /* swallow — email failure shouldn't break signup */ }
          })();
        }
      } catch (e) {
        console.error("[signup][referral-reward]", e.message);
        // Non-fatal — signup still succeeds even if reward processing fails
      }
    }

    // ── Welcome email — skip for agency clients (they get agency onboarding email instead) ──
    const isAgencySignup = !!(agencyCode && agencyCode.trim());
    if (!isAgencySignup) try {
      const sgKey = getSetting("SENDGRID_API_KEY");
      const fromEmail = getSetting("EMAIL_FROM") || "hello@takeova.ai";
      if (sgKey) {
        const fetch = (await import("node-fetch")).default;
        const affiliateLink = `${FRONTEND_URL || "https://takeova.ai"}?ref=${refCode}`;
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: email.toLowerCase().trim() }] }],
            from: { email: fromEmail, name: "MINE" },
            subject: `Welcome to TAKEOVA, ${name.split(" ")[0].replace(/[\r\n]/g, "")}! 🚀`,
            content: [{ type: "text/html", value: `
              <div style="font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:0;">
                <div style="background:linear-gradient(135deg,#2563EB,#1D4ED8);padding:32px;text-align:center;border-radius:12px 12px 0 0;">
                  <h1 style="color:#fff;font-size:28px;margin:0;">Welcome to TAKEOVA! 🎉</h1>
                  <p style="color:rgba(255,255,255,.8);font-size:14px;margin:8px 0 0;">Your all-in-one business platform is ready.</p>
                </div>
                <div style="padding:32px;background:#fff;">
                  <p style="font-size:15px;color:#333;line-height:1.7;">Hey ${name.split(" ")[0]},</p>
                  <p style="font-size:15px;color:#333;line-height:1.7;">Your account is live. Build your first site, set up payments, and start selling — all from one dashboard.</p>

                  <div style="background:#F0F4FF;border:1px solid #C7D2FE;border-radius:12px;padding:20px;margin:20px 0;">
                    <h2 style="font-size:16px;color:#2563EB;margin:0 0 12px;">🤖 AI Employees — from Growth plan</h2>
                    <p style="font-size:13px;color:#444;line-height:1.7;margin:0 0 12px;">Upgrade to <strong>Growth ($129/mo)</strong> and hire your first AI Employee — a social manager, receptionist, sales rep or more — working for your business 24/7 automatically.</p>
                    <table style="width:100%;border-collapse:collapse;font-size:12px;color:#444;">
                      <tr>
                        <td style="padding:6px 0;border-bottom:1px solid #E5E7EB;"><strong>Starter</strong></td>
                        <td style="padding:6px 0;border-bottom:1px solid #E5E7EB;color:#DC2626;">No AI Employees</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;border-bottom:1px solid #E5E7EB;"><strong>Growth $129</strong></td>
                        <td style="padding:6px 0;border-bottom:1px solid #E5E7EB;color:#16A34A;">✓ 1 AI Employee</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;border-bottom:1px solid #E5E7EB;"><strong>Pro $199</strong></td>
                        <td style="padding:6px 0;border-bottom:1px solid #E5E7EB;color:#16A34A;">✓ Unlimited AI Employees</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;"><strong>Enterprise $399</strong></td>
                        <td style="padding:6px 0;color:#16A34A;">✓ Unlimited AI Employees</td>
                      </tr>
                    </table>
                  </div>

                  <div style="background:#F7F5FF;border-radius:14px;padding:24px;margin:24px 0;border:1.5px solid rgba(99,91,255,.2);">
                    <h2 style="font-size:18px;color:#2563EB;margin:0 0 6px;">💰 Earn money by referring others</h2>
                    <p style="font-size:13px;color:#555;line-height:1.6;margin:0 0 16px;">Every MINE user gets a referral link. Share it — earn recurring commission every month someone stays subscribed. The more you refer, the higher your rate.</p>
                    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">
                      <tr style="background:#EEF2FF;"><td style="padding:8px 10px;font-weight:700;">⭐ Starter</td><td style="padding:8px 10px;color:#6B7280;">0–4 referrals</td><td style="padding:8px 10px;font-weight:800;color:#2563EB;">18%</td></tr>
                      <tr><td style="padding:8px 10px;font-weight:700;">🥉 Bronze</td><td style="padding:8px 10px;color:#6B7280;">5–24 referrals</td><td style="padding:8px 10px;font-weight:800;color:#cd7f32;">20%</td></tr>
                      <tr style="background:#F9FAFB;"><td style="padding:8px 10px;font-weight:700;">🥈 Silver</td><td style="padding:8px 10px;color:#6B7280;">25–49 referrals</td><td style="padding:8px 10px;font-weight:800;color:#94a3b8;">23%</td></tr>
                      <tr><td style="padding:8px 10px;font-weight:700;">🥇 Gold</td><td style="padding:8px 10px;color:#6B7280;">50–99 referrals</td><td style="padding:8px 10px;font-weight:800;color:#D97706;">25%</td></tr>
                      <tr style="background:#EEF2FF;"><td style="padding:8px 10px;font-weight:700;">💎 Diamond</td><td style="padding:8px 10px;color:#6B7280;">100+ referrals</td><td style="padding:8px 10px;font-weight:800;color:#2563EB;">28%</td></tr>
                    </table>
                    <div style="background:#fff;border-radius:10px;padding:14px;border:1px solid #E8E6F0;margin-bottom:14px;">
                      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Your referral link</div>
                      <div style="font-size:15px;font-weight:700;color:#2563EB;word-break:break-all;">${affiliateLink}</div>
                    </div>
                    <p style="font-size:12px;color:#555;line-height:1.7;margin:0 0 14px;"><strong>Example:</strong> Refer 10 people on Growth ($129/mo) at Starter rate = <strong style="color:#16A34A;">$232/mo passive income</strong></p>
                    <a href="${affiliateLink}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#6366F1);color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">View Affiliate Dashboard →</a>
                    <p style="font-size:11px;color:#9CA3AF;margin-top:10px;">Min $50 payout · via Stripe Connect · commission tracks automatically</p>
                  </div>

                  <div style="text-align:center;margin:24px 0;">
                    <a href="${FRONTEND_URL || "https://takeova.ai"}" style="display:inline-block;padding:14px 32px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">Start Building →</a>
                  </div>

                  <div style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px;margin-top:24px;text-align:center;">
                    Your referral code: <strong>${refCode}</strong><br>
                    Questions? Just reply to this email.
                  </div>
                </div>
              </div>
            `}]
          })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
    } catch(e) { console.error("Welcome email error:", e.message); } // end !isAgencySignup welcome email

    // ── Schedule follow-up affiliate nudge emails (skip for agency clients) ──
    if (!isAgencySignup) try {
      // Day 3: "Have you shared your referral link?"
      // Day 7: "Your first referral could earn you $X"
      // Day 14: "Top referrers earned $X this month"
      db.exec("CREATE TABLE IF NOT EXISTS scheduled_emails (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT, send_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");

      const day3Subject = `${name.split(" ")[0]}, your referral link is waiting 💰`;
      const day3Body = `Hey ${name.split(" ")[0]},\n\nQuick reminder — you have a referral link that earns you 18-28% recurring commission on anyone who signs up — and it goes up the more you refer:\n\n${FRONTEND_URL || "https://takeova.ai"}?ref=${refCode}\n\nJust share it on your social media, in Facebook groups, or send it to business owner friends. Every signup = money in your pocket every month.\n\n— Team TAKEOVA`;

      const day7Subject = `Your first referral = $${Math.round(129 * 0.18)}/month recurring`;
      const day7Body = `Hey ${name.split(" ")[0]},\n\nDid you know? Just ONE referral on our Growth plan ($99/mo) earns you $12.87/month — every month they stay subscribed.\n\n5 referrals = $64/month passive income\n10 referrals = $129/month\n25 referrals = $322/month\n\nAll from a single share. Your link: ${FRONTEND_URL || "https://takeova.ai"}?ref=${refCode}\n\nPost it on Instagram, X, LinkedIn, TikTok — anywhere business owners hang out.\n\n— Team TAKEOVA`;

      db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at) VALUES (?,?,?,?,?,datetime('now','+3 days'))").run(uuid(), id, email, day3Subject, day3Body);
      db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at) VALUES (?,?,?,?,?,datetime('now','+7 days'))").run(uuid(), id, email, day7Subject, day7Body);
    } catch(e) {} // end !isAgencySignup affiliate nudge

    // ── Agency invite: link user to agency if signup came via an invite link ──
    if (agencyCode) {
      try {
        // Code is the first 8 chars of the agency UUID (uppercase), stored in agencies.id
        const agency = db.prepare(
          "SELECT * FROM agencies WHERE UPPER(SUBSTR(id,1,8)) = UPPER(?) AND status = 'active'"
        ).get(agencyCode.trim()) ||
        db.prepare(
          "SELECT * FROM agencies WHERE id = ? AND status = 'active'"
        ).get(agencyCode.trim());

        if (agency) {
          // Upgrade user to enterprise and tag as agency client
          db.prepare("UPDATE users SET agency_id = ?, is_agency_client = 1, plan = 'enterprise' WHERE id = ?")
            .run(agency.id, id);

          // Ensure agency_clients table exists (agency.js also creates it, belt-and-suspenders)
          // Full schema — must match ensureTables() in agency.js exactly
          db.exec(`CREATE TABLE IF NOT EXISTS agency_clients (
            id                     TEXT PRIMARY KEY,
            agency_id              TEXT NOT NULL REFERENCES agencies(id),
            user_id                TEXT NOT NULL,
            client_name            TEXT,
            client_email           TEXT,
            monthly_fee            REAL DEFAULT 500,
            status                 TEXT DEFAULT 'active',
            ai_addons              TEXT DEFAULT '[]',
            stripe_customer_id     TEXT,
            stripe_subscription_id TEXT,
            billing_start          TEXT DEFAULT (datetime('now')),
            last_billed_at         TEXT,
            created_at             TEXT DEFAULT (datetime('now')),
            updated_at             TEXT DEFAULT (datetime('now'))
          )`);

          const alreadyLinked = db.prepare(
            "SELECT id FROM agency_clients WHERE agency_id = ? AND user_id = ?"
          ).get(agency.id, id);

          if (!alreadyLinked) {
            // Use monthly_fee from request body if provided (passed via invite URL), else default
            const agencyMonthlyFee = Math.max(500, parseFloat(req.body.monthly_fee) || 500);
            db.prepare(`INSERT INTO agency_clients (id, agency_id, user_id, client_name, client_email, monthly_fee)
                        VALUES (?, ?, ?, ?, ?, ?)`)
              .run(uuid(), agency.id, id, name.trim(), email.toLowerCase().trim(), agencyMonthlyFee);
          }

          // Tag any sites this user creates later will pick up agency_id via the users.agency_id column

          // Notify the agency owner by email
          try {
            const sgKey    = (typeof getSetting === "function" && getSetting("SENDGRID_API_KEY")) || process.env.SENDGRID_API_KEY;
            const fromEmail = process.env.EMAIL_FROM || "hello@takeova.ai";
            if (sgKey) {
              const agencyUser = db.prepare("SELECT email FROM users WHERE id = ?").get(agency.user_id);
              if (agencyUser?.email) {
                const fetch2 = (...a) => import("node-fetch").then(m => m.default(...a));
                const _sgResp = await fetch2("https://api.sendgrid.com/v3/mail/send", {
                  method: "POST",
                  headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    personalizations: [{ to: [{ email: agencyUser.email }] }],
                    from: { email: fromEmail, name: "MINE" },
                    subject: `New client joined your agency: ${name.trim()}`,
                    content: [{ type: "text/html", value: `
                      <div style="font-family:system-ui;max-width:480px;margin:0 auto;padding:32px">
                        <h2>New client signed up 🎉</h2>
                        <p><strong>${name.trim()}</strong> (${email}) just joined your agency via your invite link.</p>
                        <p>They now have enterprise access. Head to your agency dashboard to manage their account and build their first site.</p>
                      </div>` }]
                  })
                });
                if (!_sgResp.ok) {
                  let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
                  console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
                }
              }
            }
          } catch(notifyErr) { /* non-fatal */ }
        }
      } catch(agErr) {
        console.error("[Agency] Signup link error:", agErr.message);
        // Non-fatal — user account still created normally
      }
    }

    // Re-fetch user to pick up any changes made by agencyCode block (plan, is_agency_client)
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);

    // Send verification email (fire-and-forget — don't block signup if SendGrid is slow/down)
    sendVerificationEmail(email.toLowerCase().trim(), name.trim(), verifyToken)
      .then(ok => { if (ok) console.log("[verify-email] sent to " + email); })
      .catch(e => console.error("[verify-email] background error:", e.message));

    const refreshToken = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + "_refresh", { expiresIn: "30d" });
    res.json({ token, refresh_token: refreshToken, user: sanitizeUser(user) });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── LOGIN ───
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());
    if (!user) {
      // Run dummy compare to prevent timing-based email enumeration
      await bcrypt.compare(password, "$2a$12$dummyhashfortimingattackprevention.padding.padding.padding");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check account lockout
    try { db.exec("ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0"); } catch(e) {}
    try { db.exec("ALTER TABLE users ADD COLUMN locked_until TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE users ADD COLUMN trial_ends_at TEXT"); } catch(e) {}
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({ error: `Account temporarily locked — try again in ${mins} minute${mins !== 1 ? "s" : ""}` });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      // Increment failure count; lock after 10 failures for 15 minutes
      const failures = (user.failed_attempts || 0) + 1;
      const lockUntil = failures >= 10 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
      db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(failures, lockUntil, user.id);
      return res.status(401).json({ error: "Invalid credentials" });
    }
    // Reset failure counter on successful password check
    db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(user.id);

    // Check 2FA
    if (user.two_fa_enabled) {
      // SECURITY: issue a short-lived signed challenge token rather than
      // echoing the raw userId. Previously /verify-2fa accepted any userId
      // + code pair, letting an attacker who knew a user ID brute-force
      // the 6-digit TOTP over time (~1 in 333k per attempt). The challenge
      // token proves the caller passed password auth.
      const challengeToken = jwt.sign(
        { uid: user.id, purpose: "2fa_challenge" },
        process.env.JWT_SECRET,
        { expiresIn: "5m" }
      );
      return res.json({ requires2FA: true, challenge: challengeToken });
    }

    const token = signToken(user.id, user.role);
    const refreshToken = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + "_refresh", { expiresIn: "30d" });

    // Update streak + last login
    db.prepare("UPDATE users SET streak = streak + 1, last_login = datetime('now'), last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(user.id);
    try { db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT"); } catch(e) {}
    db.prepare("INSERT INTO audit_log (user_id, action) VALUES (?, ?)").run(user.id, "login");

    res.json({ token, refresh_token: refreshToken, user: sanitizeUser(user) });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── EMAIL VERIFICATION ───
// User clicks the link in their email → marks them as verified, redirects to dashboard
router.get("/verify/:token", (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length !== 64) {
      return res.status(400).send(_verifyResultPage("Invalid verification link.", false));
    }
    const db = getDb();
    const user = db.prepare("SELECT id, email, email_verified FROM users WHERE verification_token = ?").get(token);
    if (!user) {
      return res.status(404).send(_verifyResultPage("This verification link is invalid or has already been used.", false));
    }
    if (user.email_verified) {
      return res.send(_verifyResultPage("Your email is already verified — you're all set!", true));
    }
    // Mark verified, clear token (one-time use)
    db.prepare("UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?").run(user.id);
    db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)").run(user.id, "email_verified", user.email);
    res.send(_verifyResultPage("Email verified successfully! You can close this tab and return to MINE.", true));
  } catch (e) {
    console.error("[verify-email] error:", e.message);
    res.status(500).send(_verifyResultPage("Something went wrong — please try again.", false));
  }
});

// User can request a new verification email (e.g. didn't receive it, expired, etc.)
router.post("/resend-verification", auth, async (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare("SELECT id, email, name, email_verified, verification_token, verification_sent_at FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

    // Rate limit: don't allow resend more than once per 60 seconds
    if (user.verification_sent_at) {
      const lastSent = new Date(user.verification_sent_at).getTime();
      const ageSec = (Date.now() - lastSent) / 1000;
      if (ageSec < 60) {
        return res.status(429).json({ error: "Please wait before requesting another email", retryAfter: Math.ceil(60 - ageSec) });
      }
    }

    // Generate new token (invalidates previous one)
    const newToken = require("crypto").randomBytes(32).toString("hex");
    db.prepare("UPDATE users SET verification_token = ?, verification_sent_at = datetime('now') WHERE id = ?").run(newToken, user.id);

    const sent = await sendVerificationEmail(user.email, user.name, newToken);
    res.json({ ok: sent, sent });
  } catch (e) {
    console.error("[resend-verification]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Helper for verify endpoint result pages
function _verifyResultPage(message, ok) {
  const icon = ok ? "✅" : "⚠️";
  const color = ok ? "#16A34A" : "#DC2626";
  const dashboardUrl = FRONTEND_URL || "https://takeova.ai";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? "Email Verified" : "Verification Failed"} — MINE</title>
  <style>body{font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.box{background:#fff;max-width:440px;width:100%;border-radius:16px;padding:48px 32px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,0.08)}.icon{font-size:64px;margin-bottom:16px}h1{font-size:24px;color:${color};margin:0 0 12px;font-weight:800}p{color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px}a{display:inline-block;padding:12px 28px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700}</style>
  </head><body><div class="box"><div class="icon">${icon}</div><h1>${ok ? "All set!" : "Hmm…"}</h1><p>${esc(message)}</p>${ok ? `<a href="${dashboardUrl}">Open MINE →</a>` : ""}</div></body></html>`;
}

// ─── VERIFY 2FA ───
router.post("/verify-2fa", authLimiter, (req, res) => {
  const { userId: legacyUserId, code, challenge } = req.body;
  if (!code) return res.status(400).json({ error: "Code required" });

  // Resolve userId from signed challenge token (preferred) or fall back to
  // legacy userId-only flow for back-compat with clients that haven't been
  // updated. New clients must send `challenge`; eventually the legacy path
  // can be removed.
  let userId = null;
  if (challenge) {
    try {
      const payload = jwt.verify(challenge, process.env.JWT_SECRET);
      if (payload.purpose !== "2fa_challenge" || !payload.uid) {
        return res.status(401).json({ error: "Invalid challenge" });
      }
      userId = payload.uid;
    } catch(e) {
      return res.status(401).json({ error: "Challenge expired — please log in again" });
    }
  } else if (legacyUserId) {
    // LEGACY PATH — kept for 1-2 release cycles while clients update.
    // NB: this path lets a caller attempt TOTP without proving password
    // knowledge. Rate-limited at 5/15min per IP, but defence in depth is
    // weaker than the challenge path. Remove once all clients send `challenge`.
    userId = legacyUserId;
  } else {
    return res.status(400).json({ error: "Challenge or userId required" });
  }

  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  // Return same error for not found / 2FA not enabled to prevent user enumeration
  if (!user || !user.two_fa_enabled || !user.two_fa_secret) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  try {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.two_fa_secret), algorithm: "SHA1", digits: 6, period: 30 });
    const valid = totp.validate({ token: code, window: 1 }) !== null;
    if (!valid) return res.status(401).json({ error: "Invalid 2FA code" });

    const token = signToken(user.id, user.role);
    const refreshToken = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + "_refresh", { expiresIn: "30d" });
    res.json({ token, refresh_token: refreshToken, user: sanitizeUser(user) });
  } catch (err) {
    res.status(400).json({ error: "2FA verification failed" });
  }
});

// ─── VERIFY TOTP CODE (for 2FA-gated actions, e.g. site deploy) ───
router.post("/verify-totp", auth, (req, res) => {
  try {
    const db = getDb();
    const { code } = req.body;
    if (!code || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "6-digit code required" });
    const user = db.prepare("SELECT two_fa_secret, two_fa_enabled FROM users WHERE id = ?").get(req.userId);
    if (!user?.two_fa_secret || !user?.two_fa_enabled) {
      return res.status(400).json({ error: "2FA not configured" });
    }
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.two_fa_secret), algorithm: "SHA1", digits: 6, period: 30 });
    const valid = totp.validate({ token: code, window: 1 }) !== null;
    if (!valid) return res.status(401).json({ valid: false, error: "Invalid code" });
    res.json({ valid: true });
  } catch (err) {
    console.error("[Auth] verify-totp:", err.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ─── SETUP 2FA ───
router.post("/setup-2fa", auth, (req, res) => {
  const db = getDb();
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({ issuer: "MINE", label: req.userId, secret, algorithm: "SHA1", digits: 6, period: 30 });

  db.prepare("UPDATE users SET two_fa_secret = ? WHERE id = ?").run(secret.base32, req.userId);

  res.json({ secret: secret.base32, uri: totp.toString() });
});

// ─── CONFIRM 2FA ───
router.post("/confirm-2fa", auth, (req, res) => {
  const { code } = req.body;
  const db = getDb();
  const user = db.prepare("SELECT two_fa_secret FROM users WHERE id = ?").get(req.userId);

  try {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.two_fa_secret), algorithm: "SHA1", digits: 6, period: 30 });
    const valid = totp.validate({ token: code, window: 1 }) !== null;
    if (!valid) return res.status(401).json({ error: "Invalid code" });

    db.prepare("UPDATE users SET two_fa_enabled = 1 WHERE id = ?").run(req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: "Verification failed" });
  }
});

// ─── GET PROFILE ───
router.get("/me", auth, (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: sanitizeUser(user) });
});

// ─── UPDATE PROFILE ───
router.put("/profile", auth, async (req, res) => {
  try {
  const { name, email, currentPassword } = req.body;
  const db = getDb();
  const fields = [];
  const vals = [];
  if (name) { fields.push("name = ?"); vals.push(_cleanName(name)); }
  if (email) {
    const newEmail = email.toLowerCase().trim();
    // Require current password to change email — prevents account takeover via stolen session
    if (!currentPassword) return res.status(400).json({ error: "Current password required to change email" });
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.userId);
    const bcrypt = require("bcryptjs");
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(403).json({ error: "Incorrect password" });
    // Ensure new email is not already taken
    const existing = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(newEmail, req.userId);
    if (existing) return res.status(409).json({ error: "Email already in use" });
    fields.push("email = ?"); vals.push(newEmail);
  }
  if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
  fields.push("updated_at = datetime('now')");
  vals.push(req.userId);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  res.json({ user: sanitizeUser(user) });

  } catch (e) {
    console.error("[/profile]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// ─── UPDATE PROFILE (PATCH) ───
router.patch("/me", auth, (req, res) => {
  const { name, avatar, avatar_url, bio, phone, timezone, outreach_display_name, sms_sender_name, sender_email, currency, currency_symbol} = req.body;
  const db = getDb();
  // Ensure columns exist
  try { db.exec("ALTER TABLE users ADD COLUMN outreach_display_name TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN sms_sender_name TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN sender_email TEXT"); } catch(e) {}
  const fields = [];
  const vals = [];
  if (name !== undefined) { fields.push("name = ?"); vals.push(_cleanName(name)); }
  if (bio !== undefined) { fields.push("bio = ?"); vals.push(bio); }
  if (phone !== undefined) { fields.push("phone = ?"); vals.push(phone); }
  if (timezone !== undefined) { fields.push("timezone = ?"); vals.push(timezone); }
  if (currency !== undefined) { fields.push("currency = ?"); vals.push(currency); }
  if (currency_symbol !== undefined) { fields.push("currency_symbol = ?"); vals.push(currency_symbol); }
  if (outreach_display_name !== undefined) { fields.push("outreach_display_name = ?"); vals.push(outreach_display_name.slice(0, 80)); }
  if (sender_email !== undefined) {
    // Basic format check — must contain @ and a dot after
    const cleanEmail = (sender_email || "").trim().toLowerCase();
    if (cleanEmail && (!cleanEmail.includes("@") || !cleanEmail.includes("."))) {
      return res.status(400).json({ error: "Invalid sender email format" });
    }
    fields.push("sender_email = ?"); vals.push(cleanEmail || null);
  }
  if (sms_sender_name !== undefined) {
    // Sanitise: letters/numbers only, max 11 chars, must start with letter
    const clean = sms_sender_name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 11);
    const safe = /^[a-zA-Z]/.test(clean) ? clean : clean.slice(1); // strip leading digit if any
    fields.push("sms_sender_name = ?");
    vals.push(safe || null);
  }
  const avatarVal = avatar ?? avatar_url;
  if (avatarVal !== undefined) { fields.push("avatar = ?"); vals.push(avatarVal); }
  if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
  fields.push("updated_at = datetime('now')");
  vals.push(req.userId);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  res.json({ user: sanitizeUser(user) });
});

function sanitizeUser(u) {
  const { password_hash, two_fa_secret, stripe_customer_id, stripe_connect_id, failed_attempts, locked_until, ...safe } = u;
  // Ensure currency defaults
  if (!safe.currency) safe.currency = 'USD';
  if (!safe.currency_symbol) safe.currency_symbol = '$';
  return {
    ...safe,
    // camelCase aliases for frontend compatibility
    twoFAEnabled: !!u.two_fa_enabled,
    emailVerified: !!u.email_verified,
    subscriptionStatus: u.subscription_status || null,
    editsUsed: u.edits_used || 0,
    emailsSent: u.emails_sent || 0,
    emailLimit: u.email_limit || 500,
    referralCode: u.referral_code || "",
    referralRevenue: u.referral_revenue || 0,
    commissionEarned: u.commission_earned || 0,
    joinDate: u.join_date || u.created_at?.split("T")[0] || "",
    stripeCustomerId: u.stripe_customer_id || "",
    stripeSubscriptionId: u.stripe_subscription_id || "",
    referredBy: u.referred_by || null,
    promoUsed: u.promo_used || null,
    lastLogin: u.last_login || null,
    trialEndsAt: u.trial_ends_at || null,
    // Starter: blocked if trial expired and no card. Paid plans: never blocked by trial.
    trialExpired: u.plan === 'starter' && u.trial_ends_at
      ? new Date(u.trial_ends_at) < new Date()
      : false,
    onTrial: u.plan === 'starter' && u.trial_ends_at
      ? new Date(u.trial_ends_at) > new Date()
      : false,
    trialDays: u.trial_ends_at && u.created_at
      ? Math.round((new Date(u.trial_ends_at) - new Date(u.created_at)) / (1000*60*60*24)) >= 10 ? 14 : 3
      : 3,
    // How long was this trial? Used to show correct message on expiry
    trialDays: (() => {
      if (!u.trial_ends_at || !u.created_at) return 3;
      const created = new Date(u.created_at);
      const ends = new Date(u.trial_ends_at);
      const days = Math.round((ends - created) / (1000 * 60 * 60 * 24));
      return days >= 10 ? 14 : 3;
    })(),
  };
}

// ─── Mobile Push: Register device token ───
router.post("/device-token", auth, (req, res) => {
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: "Token required" });
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS device_tokens (id TEXT PRIMARY KEY, user_id TEXT, token TEXT, platform TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, token))`);
  try {
    db.prepare("INSERT OR REPLACE INTO device_tokens (id, user_id, token, platform) VALUES (?,?,?,?)").run(require("uuid").v4(), req.userId, token, platform || "unknown");
    res.json({ success: true });
  } catch (e) { res.json({ success: true }); }
});

// ─── Send push notification to a user (internal helper) ───
router.post("/push", auth, async (req, res) => {
  const { userId, title, body, data } = req.body;
  // Only admins can push to other users; regular users can only push to themselves
  const targetUser = (userId && req.user?.role === "admin") ? userId : req.userId;
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS push_tokens (id TEXT PRIMARY KEY, user_id TEXT, token TEXT UNIQUE, platform TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const tokens = db.prepare("SELECT token, platform FROM push_tokens WHERE user_id = ?").all(targetUser);
    if (!tokens.length) return res.json({ sent: 0 });

    // Send via FCM (Firebase Cloud Messaging) — works for both iOS and Android
    const fcmKey = process.env.FCM_SERVER_KEY;
    if (fcmKey) {
      const fetch = (await import("node-fetch")).default;
      for (const t of tokens) {
        await fetch("https://fcm.googleapis.com/fcm/send", {
          method: "POST",
          headers: { "Authorization": "key=" + fcmKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            to: t.token,
            notification: { title, body, sound: "default", badge: "1" },
            data: data || {}
          })
        }).catch(() => {});
      }
    }
    res.json({ sent: tokens.length });
  } catch (e) { res.json({ sent: 0, error: "Failed to send" }); }
});

// ─── MOBILE PUSH TOKEN ───
router.post("/push-token", auth, (req, res) => {
  const db = getDb();
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: "Token required" });
  db.exec("CREATE TABLE IF NOT EXISTS push_tokens (id TEXT PRIMARY KEY, user_id TEXT, token TEXT UNIQUE, platform TEXT, created_at TEXT DEFAULT (datetime('now')))");
  db.prepare("INSERT OR REPLACE INTO push_tokens (id, user_id, token, platform) VALUES (?,?,?,?)")
    .run(require("uuid").v4(), req.userId, token, platform || "unknown");
  res.json({ success: true });
});

// Get user's push tokens (for sending notifications)
router.get("/push-tokens", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS push_tokens (id TEXT PRIMARY KEY, user_id TEXT, token TEXT UNIQUE, platform TEXT, created_at TEXT DEFAULT (datetime('now')))");
    const tokens = db.prepare("SELECT * FROM push_tokens WHERE user_id = ?").all(req.userId);
    res.json({ tokens });
  } catch (e) { res.json({ tokens: [] }); }
});

// ── Forgot Password ──
router.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const db = getDb();
  const { v4: uuid } = require("uuid");

  // Always return success to prevent email enumeration
  res.json({ success: true, message: "If an account exists, a reset link has been sent" });

  try {
    const user = db.prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?)").get(email.trim());
    if (!user) return; // Don't reveal if email exists

    // Create reset token.
    // We store only the SHA-256 hash in the DB — the raw token goes into
    // the email and never touches our DB in plaintext. If the DB leaks,
    // pending resets are not directly usable.
    // The `token` column (UNIQUE NOT NULL from the original schema) now
    // holds the hash rather than the raw token. Lookup on the reset
    // endpoint hashes the incoming token and compares.
    db.exec("CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    // Invalidate any existing unused reset tokens for this user before issuing a new one
    db.prepare("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0").run(user.id);
    const token = require("crypto").randomBytes(32).toString("hex"); // 256-bit cryptographically secure token
    const tokenHash = require("crypto").createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    db.prepare("INSERT INTO password_resets (id, user_id, token, expires_at) VALUES (?,?,?,?)")
      .run(uuid(), user.id, tokenHash, expiresAt);

    // Send reset email
    const sgKey = getSetting("SENDGRID_API_KEY");
    const fromEmail = getSetting("EMAIL_FROM") || getSetting("SENDGRID_FROM_EMAIL") || "hello@takeova.ai";
    const frontendUrl = FRONTEND_URL || "https://takeova.ai";
    const resetUrl = `${frontendUrl}?reset_token=${token}`;

    if (sgKey) {
      const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: user.email }] }],
          from: { email: fromEmail, name: "MINE" },
          subject: "Reset your TAKEOVA password",
          content: [{ type: "text/html", value: renderEmail({
            preheader: "Reset your TAKEOVA password — this link expires in 1 hour",
            heading: "Reset your password",
            intro: `Hi ${esc(user.name || "there")},`,
            bodyHtml: `<p style="${P}">Click the button below to reset your password. This link expires in 1 hour.</p>`,
            cta: { text: "Reset password", url: resetUrl },
            footerNote: `If you didn't request this, you can safely ignore this email — your password won't change.<br>Link expires: ${new Date(expiresAt).toLocaleString()}`,
          }) }]
        })
      });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    }
  } catch (e) { console.error("Password reset error:", e.message); }
});

// ── Reset Password (verify token + set new password) ──
router.post("/reset-password", authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and password required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    // Token column now stores the SHA-256 hash of the raw token. Hash the
    // incoming token and look up by hash. Keep a plaintext fallback for any
    // legacy pre-migration rows until they expire.
    const tokenHash = require("crypto").createHash("sha256").update(token).digest("hex");
    const reset = db.prepare(
      "SELECT * FROM password_resets WHERE (token = ? OR token = ?) AND used = 0 AND datetime(expires_at) > datetime('now')"
    ).get(tokenHash, token);
    if (!reset) return res.status(400).json({ error: "Reset link is invalid or has expired" });

    // Hash new password and update
    // bcryptjs already imported at top
    const hash = await bcrypt.hash(password, 12);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, reset.user_id);
    db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(reset.id);

    // Invalidate all existing sessions for security
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.user_id);

    res.json({ success: true, message: "Password updated — please log in" });
  } catch (e) {
    console.error("Reset password error:", e.message);
    res.status(500).json({ error: "Could not reset password" });
  }
});

// ─── CHANGE PASSWORD (logged-in user) ───
// Verifies the current password, then sets a new one. Reuses the same bcrypt
// scheme (cost 12) as signup/reset so existing logins keep working. Registered
// at both /change-password and /password for dashboard compatibility.
router.post(["/change-password", "/password"], authLimiter, auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are both required" });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    const db = getDb();
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    const valid = await bcrypt.compare(currentPassword, user.password_hash || "");
    if (!valid) return res.status(403).json({ error: "Current password is incorrect" });
    const sameAsOld = await bcrypt.compare(newPassword, user.password_hash || "");
    if (sameAsOld) return res.status(400).json({ error: "New password must be different from the current one" });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, req.userId);
    res.json({ success: true, message: "Password updated" });
  } catch (e) {
    console.error("[/change-password]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── Change password (authenticated; verifies current password) ──
router.post("/change-password", auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    if (String(new_password).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    const db = getDb();
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.userId);
    if (!user || !user.password_hash) {
      return res.status(404).json({ error: "Account not found" });
    }
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      return res.status(403).json({ error: "Current password is incorrect" });
    }
    const hash = await bcrypt.hash(new_password, 12);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, req.userId);
    res.json({ success: true, message: "Password changed" });
  } catch (e) {
    console.error("[Auth] change-password", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't change password — please try again" });
  }
});

// ── Logout ──
router.post("/logout", auth, (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  revokeToken(token);
  res.json({ success: true });
});


// ─── DISABLE 2FA ───
router.post("/disable-2fa", auth, (req, res) => {
  const db = getDb();
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Current 2FA code required to disable" });
  const user = db.prepare("SELECT two_fa_secret, two_fa_enabled FROM users WHERE id = ?").get(req.userId);
  if (!user?.two_fa_enabled) return res.status(400).json({ error: "2FA is not enabled" });
  try {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.two_fa_secret), algorithm: "SHA1", digits: 6, period: 30 });
    const valid = totp.validate({ token: code, window: 1 }) !== null;
    if (!valid) return res.status(401).json({ error: "Invalid 2FA code" });
    db.prepare("UPDATE users SET two_fa_enabled = 0, two_fa_secret = NULL WHERE id = ?").run(req.userId);
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: "Verification failed" }); }
});

// ── GDPR: Account deletion (right to erasure) ─────────────────────────────────
// blockImpersonation: agencies cannot delete a client's account while managing it
router.delete("/account", auth, blockImpersonation, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    const { password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    // Verify password before deletion
    const bcrypt = require("bcryptjs");
    const valid = await bcrypt.compare(password||"", user.password_hash||"");
    if (!valid) return res.status(400).json({ error: "Password incorrect. Provide your password to confirm account deletion." });
    // Anonymise/delete user data
    const tables = ["contacts","invoices","bookings","deals","products","sites","sms_messages",
      "ai_employees","time_entries","support_tickets","reviews","social_posts","notifications"];
    for (const tbl of tables) {
      try { db.prepare(`DELETE FROM ${tbl} WHERE user_id=?`).run(userId); } catch(e) { console.error("[/account]", e.message || e); }
    }
    db.prepare("UPDATE users SET email=?,name='Deleted User',password_hash='',deleted_at=datetime('now') WHERE id=?")
      .run(`deleted_${userId}@mine.deleted`, userId);
    res.json({ success: true, message: "Account and all associated data have been deleted." });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── GDPR: Data export ────────────────────────────────────────────────────────
router.get("/account/export", auth, (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    const user = db.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").get(userId);
    const contacts = db.prepare("SELECT * FROM contacts WHERE user_id=?").all(userId);
    const invoices = db.prepare("SELECT * FROM invoices WHERE user_id=?").all(userId);
    const bookings = db.prepare("SELECT * FROM bookings WHERE user_id=?").all(userId);
    const sites = db.prepare("SELECT id,name,domain,status,created_at FROM sites WHERE user_id=?").all(userId);
    const orders = (() => { try { return db.prepare("SELECT * FROM orders WHERE user_id=?").all(userId); } catch(e) { return []; } })();
    const products = (() => { try { return db.prepare("SELECT * FROM products WHERE user_id=?").all(userId); } catch(e) { return []; } })();
    const courses = (() => { try { return db.prepare("SELECT * FROM courses WHERE user_id=?").all(userId); } catch(e) { return []; } })();
    const events = (() => { try { return db.prepare("SELECT * FROM events WHERE user_id=?").all(userId); } catch(e) { return []; } })();
    const export_data = {
      exported_at: new Date().toISOString(),
      account: user,
      contacts, invoices, bookings, sites, orders, products, courses, events,
      note: "This export contains your TAKEOVA platform data as required by GDPR Article 20."
    };
    res.setHeader("Content-Disposition", 'attachment; filename="mine-data-export-' + userId + '.json"');
    res.json(export_data);
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});


// ─── REFRESH TOKEN ───────────────────────────────────────────────────────────
// Clients should call this when they get a 401 to get a new access token
router.post("/refresh", async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: "refresh_token required" });
  try {
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + "_refresh");
    const db = getDb();
    const user = db.prepare("SELECT id, role, account_status FROM users WHERE id=?").get(decoded.id);
    if (!user || user.account_status === "banned") return res.status(401).json({ error: "Invalid token" });
    // Issue new short-lived access token (15min) + new refresh token (30 days)
    const accessToken  = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "15m" });
    const newRefresh   = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + "_refresh", { expiresIn: "30d" });
    res.json({ token: accessToken, refresh_token: newRefresh });
  } catch(e) {
    res.status(401).json({ error: "Token expired or invalid — please log in again" });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SIGN-IN (OAuth 2.0)
//   GET /api/auth/google           -> redirects to Google consent
//   GET /api/auth/google/callback  -> creates/finds the user, issues a JWT,
//                                     redirects back with #mine_token=<jwt>
// Requires env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. In Google Cloud, add
//   {BACKEND_URL}/api/auth/google/callback  as an authorized redirect URI.
// ─────────────────────────────────────────────────────────────────────────────
function _googleCfg() {
  return {
    id: process.env.GOOGLE_CLIENT_ID || "",
    secret: process.env.GOOGLE_CLIENT_SECRET || "",
    callback: (process.env.BACKEND_URL || BACKEND_URL).replace(/\/$/, "") + "/api/auth/google/callback",
  };
}
function _safeGoogleRedirect(raw) {
  try {
    if (!raw) return null;
    var u = new URL(String(raw));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    var origins = [process.env.FRONTEND_URL, process.env.BACKEND_URL, FRONTEND_URL, BACKEND_URL]
      .filter(Boolean).map(function (x) { try { return new URL(x).origin; } catch (_) { return null; } }).filter(Boolean);
    var extra = (process.env.GOOGLE_REDIRECT_ALLOWLIST || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (origins.indexOf(u.origin) !== -1 || u.hostname === "localhost" ||
        extra.some(function (d) { return u.hostname === d || u.hostname.endsWith("." + d); })) {
      return u.href;
    }
  } catch (_) {}
  return null;
}

router.get("/google", function (req, res) {
  var jwt = require("jsonwebtoken");
  var crypto = require("crypto");
  var cfg = _googleCfg();
  if (!cfg.id || !cfg.secret) {
    return res.status(503).send("Google sign-in is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the backend, then add " + cfg.callback + " as an authorized redirect URI in Google Cloud.");
  }
  var origin = _safeGoogleRedirect(req.query.redirect) || process.env.FRONTEND_URL || FRONTEND_URL;
  var state = jwt.sign({ origin: origin, nonce: crypto.randomBytes(8).toString("hex"), purpose: "google_oauth" }, process.env.JWT_SECRET, { expiresIn: "10m" });
  var params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.id,
    redirect_uri: cfg.callback,
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state: state,
  });
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
});

router.get("/google/callback", async function (req, res) {
  var jwt = require("jsonwebtoken");
  var crypto = require("crypto");
  var cfg = _googleCfg();
  function fail(msg) { return res.status(400).send("Google sign-in failed: " + msg + ". Please try again or use email and password."); }
  try {
    var code = req.query.code;
    var state = req.query.state;
    if (!code || !state) return fail("missing authorization code");
    var origin = process.env.FRONTEND_URL || FRONTEND_URL;
    try {
      var st = jwt.verify(String(state), process.env.JWT_SECRET);
      if (st.purpose !== "google_oauth") return fail("invalid sign-in state");
      origin = st.origin || origin;
    } catch (_) { return fail("the sign-in link expired — please try again"); }

    var fetch = (await import("node-fetch")).default;
    var tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code), client_id: cfg.id, client_secret: cfg.secret,
        redirect_uri: cfg.callback, grant_type: "authorization_code",
      }).toString(),
    });
    var tok = await tokenRes.json();
    if (!tok || !tok.access_token) return fail("could not verify with Google");

    var infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: "Bearer " + tok.access_token },
    });
    var profile = await infoRes.json();
    var email = String((profile && profile.email) || "").toLowerCase().trim();
    if (!email) return fail("Google did not return an email address");
    var name = (profile && profile.name) || email.split("@")[0];
    var gid = (profile && profile.id) || null;

    var db = getDb();
    var user = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(email);
    if (!user) {
      var id = uuid();
      var refCode, attempts = 0;
      do { refCode = uuid().split("-")[0].toUpperCase(); attempts++; }
      while (db.prepare("SELECT id FROM users WHERE referral_code = ?").get(refCode) && attempts < 10);
      var unusable = crypto.randomBytes(24).toString("hex"); // no usable password — Google sign-in only
      db.prepare(
        "INSERT INTO users (id, email, password_hash, name, referral_code, plan, trial_ends_at, created_at, email_verified, google_id) " +
        "VALUES (?, ?, ?, ?, ?, 'starter', NULL, datetime('now'), 1, ?)"
      ).run(id, email, unusable, name, refCode, gid);
      try { db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)").run(id, "signup_google", email); } catch (_) {}
      try { db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)").run(uuid(), id, "", "Welcome to TAKEOVA! Build your first site to get started.", "Just now"); } catch (_) {}
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    } else if (gid && !user.google_id) {
      try { db.prepare("UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?").run(gid, user.id); } catch (_) {}
    }

    var token = signToken(user.id, user.role || "user");
    try { db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id); } catch (_) {}

    // Dashboards return to themselves; landing pages go to the customer dashboard.
    var dest = origin;
    if (!/dashboard/i.test(origin)) {
      dest = process.env.DASHBOARD_URL || ((process.env.FRONTEND_URL || FRONTEND_URL).replace(/\/$/, "") + "/mine-all-in-one-dashboard.html");
    }
    var sep = dest.indexOf("#") >= 0 ? "&" : "#";
    return res.redirect(dest + sep + "mine_token=" + encodeURIComponent(token));
  } catch (e) {
    console.error("[Auth] google callback:", e && e.message);
    return res.status(500).send("Google sign-in failed. Please try again or use email and password.");
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// SIGN IN WITH APPLE (OAuth 2.0 / OIDC)
//   GET  /api/auth/apple           -> redirects to Apple authorization
//   POST /api/auth/apple/callback  -> (form_post) creates/finds the user, issues
//                                     a JWT, redirects back with #mine_token=<jwt>
// Requires env: APPLE_TEAM_ID, APPLE_CLIENT_ID (your Service ID, e.g.
//   com.mine.signin), APPLE_KEY_ID, APPLE_PRIVATE_KEY (contents of the .p8 file).
//   In the Apple Developer portal, add {BACKEND_URL}/api/auth/apple/callback as a
//   Return URL on the Service ID. Apple's client_secret is a short-lived ES256 JWT
//   generated below (NOT a static secret).
// ─────────────────────────────────────────────────────────────────────────────
function _appleCfg() {
  return {
    teamId: process.env.APPLE_TEAM_ID || "",
    clientId: process.env.APPLE_CLIENT_ID || "",            // Apple Service ID
    keyId: process.env.APPLE_KEY_ID || "",
    privateKey: (process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    callback: (process.env.BACKEND_URL || BACKEND_URL).replace(/\/$/, "") + "/api/auth/apple/callback",
  };
}
function _appleClientSecret(cfg) {
  var jwt = require("jsonwebtoken");
  var now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: cfg.teamId, iat: now, exp: now + 3600, aud: "https://appleid.apple.com", sub: cfg.clientId },
    cfg.privateKey,
    { algorithm: "ES256", keyid: cfg.keyId }
  );
}

router.get("/apple", function (req, res) {
  var jwt = require("jsonwebtoken");
  var crypto = require("crypto");
  var cfg = _appleCfg();
  if (!cfg.teamId || !cfg.clientId || !cfg.keyId || !cfg.privateKey) {
    return res.status(503).send("Sign in with Apple is not configured yet. Set APPLE_TEAM_ID, APPLE_CLIENT_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY on the backend, then add " + cfg.callback + " as a Return URL on your Apple Service ID.");
  }
  var origin = _safeGoogleRedirect(req.query.redirect) || process.env.FRONTEND_URL || FRONTEND_URL;
  var state = jwt.sign({ origin: origin, nonce: crypto.randomBytes(8).toString("hex"), purpose: "apple_oauth" }, process.env.JWT_SECRET, { expiresIn: "10m" });
  var params = new URLSearchParams({
    response_type: "code",
    response_mode: "form_post",   // Apple posts back to the callback (required for name/email scope)
    client_id: cfg.clientId,
    redirect_uri: cfg.callback,
    scope: "name email",
    state: state,
  });
  res.redirect("https://appleid.apple.com/auth/authorize?" + params.toString());
});

router.post("/apple/callback", async function (req, res) {
  var jwt = require("jsonwebtoken");
  var crypto = require("crypto");
  var cfg = _appleCfg();
  function fail(msg) { return res.status(400).send("Sign in with Apple failed: " + msg + ". Please try again or use email and password."); }
  try {
    var code = req.body && req.body.code;
    var state = req.body && req.body.state;
    if (!code || !state) return fail("missing authorization code");
    var origin = process.env.FRONTEND_URL || FRONTEND_URL;
    try {
      var st = jwt.verify(String(state), process.env.JWT_SECRET);
      if (st.purpose !== "apple_oauth") return fail("invalid sign-in state");
      origin = st.origin || origin;
    } catch (_) { return fail("the sign-in link expired — please try again"); }

    // Apple sends the user's name ONLY on the first authorization, as a JSON `user` field.
    var appleName = null;
    try {
      if (req.body.user) {
        var u = JSON.parse(req.body.user);
        if (u && u.name) appleName = [u.name.firstName, u.name.lastName].filter(Boolean).join(" ").trim() || null;
      }
    } catch (_) {}

    var fetch = (await import("node-fetch")).default;
    var clientSecret = _appleClientSecret(cfg);
    var tokenRes = await fetch("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        client_id: cfg.clientId,
        client_secret: clientSecret,
        redirect_uri: cfg.callback,
      }).toString(),
    });
    var tok = await tokenRes.json();
    if (!tok || !tok.id_token) return fail("could not verify with Apple");

    // Verify the id_token against Apple's public keys, then read email + Apple user id.
    var claims = null;
    try {
      var header = JSON.parse(Buffer.from(String(tok.id_token).split(".")[0], "base64").toString("utf8"));
      var keysRes = await fetch("https://appleid.apple.com/auth/keys");
      var keys = ((await keysRes.json()) || {}).keys || [];
      var jwk = keys.find(function (k) { return k.kid === header.kid; });
      if (!jwk) return fail("could not verify Apple token");
      var pem = crypto.createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "pem" });
      claims = jwt.verify(String(tok.id_token), pem, { algorithms: ["RS256"], audience: cfg.clientId, issuer: "https://appleid.apple.com" });
    } catch (e) { return fail("Apple token verification failed"); }

    var email = String((claims && claims.email) || "").toLowerCase().trim();
    var aid = (claims && claims.sub) || null;
    if (!email) return fail("Apple did not return an email address");
    var name = appleName || email.split("@")[0];

    var db = getDb();
    var user = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(email);
    if (!user) {
      var id = uuid();
      var refCode, attempts = 0;
      do { refCode = uuid().split("-")[0].toUpperCase(); attempts++; }
      while (db.prepare("SELECT id FROM users WHERE referral_code = ?").get(refCode) && attempts < 10);
      var unusable = crypto.randomBytes(24).toString("hex"); // no usable password — Apple sign-in only
      db.prepare(
        "INSERT INTO users (id, email, password_hash, name, referral_code, plan, trial_ends_at, created_at, email_verified, apple_id) " +
        "VALUES (?, ?, ?, ?, ?, 'starter', NULL, datetime('now'), 1, ?)"
      ).run(id, email, unusable, name, refCode, aid);
      try { db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)").run(id, "signup_apple", email); } catch (_) {}
      try { db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)").run(uuid(), id, "", "Welcome to TAKEOVA! Build your first site to get started.", "Just now"); } catch (_) {}
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    } else if (aid && !user.apple_id) {
      try { db.prepare("UPDATE users SET apple_id = ?, email_verified = 1 WHERE id = ?").run(aid, user.id); } catch (_) {}
    }

    var token = signToken(user.id, user.role || "user");
    try { db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id); } catch (_) {}

    // Dashboards return to themselves; landing pages go to the customer dashboard.
    var dest = origin;
    if (!/dashboard/i.test(origin)) {
      dest = process.env.DASHBOARD_URL || ((process.env.FRONTEND_URL || FRONTEND_URL).replace(/\/$/, "") + "/mine-all-in-one-dashboard.html");
    }
    var sep = dest.indexOf("#") >= 0 ? "&" : "#";
    return res.redirect(dest + sep + "mine_token=" + encodeURIComponent(token));
  } catch (e) {
    console.error("[Auth] apple callback:", e && e.message);
    return res.status(500).send("Sign in with Apple failed. Please try again or use email and password.");
  }
});

module.exports = router;
