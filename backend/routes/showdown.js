const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const crypto = require("crypto");
const { auth, adminOnly } = require("../middleware/auth");

function getDb() { return require("../db/init").getDb(); }
function getSetting(k) { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } }
function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function clientIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || ""; }

const FRONTEND_URL = process.env.FRONTEND_URL || "https://takeova.ai";
const BACKEND_URL  = process.env.BACKEND_URL  || "http://localhost:4000";

// ─── Email + helper functions ─────────────────────────────────────────────
// These were previously missing and every showdown endpoint that touched
// email would crash with a ReferenceError at runtime. Restored here using
// the SendGrid API pattern used elsewhere in the codebase.

// Generic email sender. Signature matches the callsites in this file:
//   sendEmail({ to, subject, html })
// SendGrid primary, silent no-op if no API key configured (same pattern as autoEmail).
async function sendEmail({ to, subject, html }) {
  if (!to || !subject) return false;
  const cleanSubject = String(subject).replace(/[\r\n]/g, " ").slice(0, 200);
  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  const fromEmail = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
  if (sgKey) {
    try {
      const fetch = (await import("node-fetch")).default;
      const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail, name: "MINE" },
          subject: cleanSubject,
          content: [{ type: "text/html", value: html || "" }],
        }),
      });
      return resp.ok;
    } catch (e) {
      console.error("[Showdown sendEmail] SendGrid error:", e.message);
      return false;
    }
  }
  // No provider configured — don't throw, just skip. Admin must set up email.
  return false;
}

// Format elapsed seconds as "Xm Ys"
function fmt(seconds) {
  const s = parseInt(seconds || 0, 10);
  if (!s) return "0s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}

// Verification email body — sent when a user submits a challenge entry.
function verifyEmailHtml(name, verifyUrl, elapsedSeconds) {
  const safeName = esc(name || "there");
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px">
    <h2 style="color:#2563EB;margin-bottom:8px">Verify your TAKEOVA $1M Challenge entry</h2>
    <p style="color:#334155;line-height:1.6">Hi ${safeName}, we received your Challenge entry with an elapsed time of <strong>${fmt(elapsedSeconds)}</strong>.</p>
    <p style="color:#334155;line-height:1.6">Click the button below to confirm your submission:</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${verifyUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#818CF8);color:#fff;text-decoration:none;border-radius:10px;font-weight:700">Verify my entry →</a>
    </p>
    <p style="color:#94A3B8;font-size:12px">This link expires in 24 hours.</p>
  </div>`;
}

// Admin notification when a new entry is verified.
function adminNotifyHtml(entry) {
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <h3>New verified Showdown entry</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <tr><td style="padding:6px 12px;color:#64748B">Name</td><td style="padding:6px 12px"><strong>${esc(entry.name || "")}</strong></td></tr>
      <tr><td style="padding:6px 12px;color:#64748B">Email</td><td style="padding:6px 12px">${esc(entry.email || "")}</td></tr>
      <tr><td style="padding:6px 12px;color:#64748B">Elapsed</td><td style="padding:6px 12px">${fmt(entry.elapsed_seconds)}</td></tr>
      <tr><td style="padding:6px 12px;color:#64748B">Competitor</td><td style="padding:6px 12px">${esc(entry.competitor_url || "")}</td></tr>
      <tr><td style="padding:6px 12px;color:#64748B">MINE URL</td><td style="padding:6px 12px">${esc(entry.mine_url || "")}</td></tr>
      <tr><td style="padding:6px 12px;color:#64748B">Preference</td><td style="padding:6px 12px">${esc(entry.payout_preference || "")}</td></tr>
    </table>
    <p style="margin-top:20px;color:#64748B;font-size:13px">Review in admin → Showdown to approve or decline.</p>
  </div>`;
}

// HTML response page after user clicks the verify link.
function verifyPage(title, message, ok) {
  const color = ok ? "#10B981" : "#EF4444";
  const icon = ok ? "✓" : "✗";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#F8FAFC;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#fff;padding:40px;border-radius:16px;max-width:440px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.icon{font-size:48px;color:${color};margin-bottom:16px}
h1{margin:0 0 12px;color:#0F172A;font-size:22px}
p{margin:0;color:#475569;line-height:1.6}
a{display:inline-block;margin-top:24px;padding:12px 28px;background:#2563EB;color:#fff;text-decoration:none;border-radius:10px;font-weight:700}</style></head>
<body><div class="box"><div class="icon">${icon}</div><h1>${esc(title)}</h1><p>${esc(message)}</p>
<a href="${FRONTEND_URL}">Back to MINE →</a></div></body></html>`;
}

// Winner email — the $500 (or whatever payout) claim link.
async function sendWinnerEmail(entry, claimUrl) {
  const safeName = esc(entry.name || "there");
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px">
    <h2 style="color:#10B981;margin-bottom:8px">🏆 You beat us! Claim your $500</h2>
    <p style="color:#334155;line-height:1.6">Hi ${safeName}, your TAKEOVA $1M Challenge entry has been approved.</p>
    <p style="color:#334155;line-height:1.6">Click below to claim your payout — you'll be asked for ${entry.payout_preference === "credit" ? "your TAKEOVA account details for credit" : "your payment details"}.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${claimUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#10B981,#059669);color:#fff;text-decoration:none;border-radius:10px;font-weight:700">Claim your prize →</a>
    </p>
    <p style="color:#94A3B8;font-size:12px">This claim link is single-use. Contact support if you run into any issues.</p>
  </div>`;
  return sendEmail({
    to: entry.email,
    subject: "🏆 You won the TAKEOVA $1M Challenge — claim your $500",
    html,
  });
}

// Loss email HTML — "thanks for entering, here's a trial extension" vibe.
function lossEmailHtml(entry, notes) {
  const safeName = esc(entry.name || "there");
  const safeNotes = notes ? `<div style="background:#F1F5F9;padding:12px 16px;border-radius:8px;margin:16px 0;color:#475569;font-size:14px">${esc(notes)}</div>` : "";
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px">
    <h2 style="color:#2563EB;margin-bottom:8px">Thanks for entering the TAKEOVA $1M Challenge</h2>
    <p style="color:#334155;line-height:1.6">Hi ${safeName}, your entry didn't win this round — but thanks for taking the challenge.</p>
    ${safeNotes}
    <p style="color:#334155;line-height:1.6">Your free MINE trial is still active. Try the full platform while you're here:</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${FRONTEND_URL}" style="display:inline-block;padding:12px 28px;background:#2563EB;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">Open MINE →</a>
    </p>
    <p style="color:#94A3B8;font-size:12px">Keep building.</p>
  </div>`;
}

// Extend a user's trial to 14 days if they entered the Showdown.
// No-op if they're already on a paid plan or already have 14+ days.
async function extendTrialTo14Days(user) {
  if (!user?.id) return;
  if (user.plan && user.plan !== "trial") return; // paid plan — leave alone
  const db = getDb();
  const fourteenDays = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  // Only extend if current trial_ends_at is sooner than 14 days from now
  const existing = user.trial_ends_at ? new Date(user.trial_ends_at).getTime() : 0;
  const target = new Date(fourteenDays).getTime();
  if (existing < target) {
    db.prepare("UPDATE users SET trial_ends_at = ? WHERE id = ?").run(fourteenDays, user.id);
  }
}

// ── Init once at module load, not per-request ──
(function initTables() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS showdown_pool (
    id INTEGER PRIMARY KEY DEFAULT 1,
    total_pool INTEGER DEFAULT 1000000,
    paid_out INTEGER DEFAULT 0,
    winners INTEGER DEFAULT 0,
    month_number INTEGER DEFAULT 1,
    month_started_at TEXT DEFAULT (datetime('now')),
    monthly_entries INTEGER DEFAULT 0,
    monthly_winners INTEGER DEFAULT 0
  )`);
  // Init pool row
  // Add new columns if they don't exist (migration)
  try { db.exec("ALTER TABLE showdown_pool ADD COLUMN month_number INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE showdown_pool ADD COLUMN month_started_at TEXT DEFAULT (datetime('now'))"); } catch(e) {}
  try { db.exec("ALTER TABLE showdown_pool ADD COLUMN monthly_entries INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE showdown_pool ADD COLUMN monthly_winners INTEGER DEFAULT 0"); } catch(e) {}
  // ── Ad-cap columns (per Made by MINE 2.0 §7) — added in v2; safe to re-run ──
  try { db.exec("ALTER TABLE showdown_entries ADD COLUMN ad_cap_excluded_month TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE showdown_entries ADD COLUMN ad_meta_account_id TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE showdown_entries ADD COLUMN ad_google_customer_id TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE showdown_entries ADD COLUMN ad_tiktok_advertiser_id TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE showdown_entries ADD COLUMN ad_spend_last_synced_at TEXT"); } catch(e) {}
  try {
    const _pr = db.prepare("SELECT id FROM showdown_pool WHERE id = 1").get();
    if (!_pr) db.prepare("INSERT INTO showdown_pool (id, total_pool, paid_out, winners) VALUES (1, 1000000, 0, 0)").run();
  } catch(e) { console.error("[/showdown.js]", e.message || e); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS showdown_entries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      platforms_used TEXT NOT NULL,
      competitor_url TEXT NOT NULL,
      mine_url TEXT,
      payout_preference TEXT DEFAULT 'cash',
      timer_id TEXT,
      started_at TEXT,
      submitted_at TEXT,
      elapsed_seconds INTEGER,
      mine_trial_activated INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending_verification',
      verified_at TEXT,
      review_result TEXT,
      reviewed_at TEXT,
      reviewer_notes TEXT,
      claim_token TEXT UNIQUE,
      stripe_payment_link TEXT,
      paid_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS showdown_timers (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ip TEXT,
      used INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS showdown_verify_tokens (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_showdown_entries_email  ON showdown_entries(email);
    CREATE INDEX IF NOT EXISTS idx_showdown_entries_status ON showdown_entries(status);
    CREATE INDEX IF NOT EXISTS idx_showdown_entries_claim  ON showdown_entries(claim_token);
    CREATE INDEX IF NOT EXISTS idx_showdown_timers_ip      ON showdown_timers(ip, started_at);
    CREATE INDEX IF NOT EXISTS idx_showdown_verify_token   ON showdown_verify_tokens(token);
  `);
})();

// ═══════════════════════════════════════════
// PUBLIC ROUTES  (mounted at /api/showdown)
// ═══════════════════════════════════════════

// POST /api/showdown/start-timer
router.post("/start-timer", auth, (req, res) => {
  const db = getDb();
  const id  = uuid();
  const now = new Date().toISOString();
  const ip  = clientIp(req);

  // Rate limit: max 10 timer starts per IP per hour
  const recent = db.prepare(
    "SELECT COUNT(*) as n FROM showdown_timers WHERE ip = ? AND started_at > datetime('now','-1 hour')"
  ).get(ip);
  if (recent.n >= 10) return res.status(429).json({ error: "Too many timer starts from this address. Try again later." });

  db.prepare("INSERT INTO showdown_timers (id, started_at, ip) VALUES (?,?,?)").run(id, now, ip);
  res.json({ success: true, timer_id: id, started_at: now });
});

// POST /api/showdown/enter
router.post("/enter", async (req, res) => {
  try {
  const db = getDb();
  const { name, email, platforms_used, competitor_url, mine_url, payout_preference, timer_id } = req.body;

  if (!name || !email || !platforms_used || !competitor_url || !timer_id)
    return res.status(400).json({ error: "All fields are required." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Valid email required." });
  // SSRF protection — competitor URL must be a real public HTTPS URL
  try {
    const parsed = new URL(competitor_url);
    if (parsed.protocol !== "https:")
      return res.status(400).json({ error: "Competitor URL must start with https://" });
    const host = parsed.hostname.toLowerCase();
    const blocked = ["localhost","127.0.0.1","0.0.0.0","::1","169.254","10.","192.168.","172.16."];
    if (blocked.some(b => host.includes(b)))
      return res.status(400).json({ error: "Invalid URL." });
  } catch(e) {
    return res.status(400).json({ error: "Invalid competitor URL." });
  }

  // Check pool still has capacity
  const pool = db.prepare("SELECT * FROM showdown_pool WHERE id = 1").get();
  // ── Showdown eligibility: 6-month programme, 2,000 total winner cap ──────
  const SHOWDOWN_MAX_WINNERS = 5000;
  const SHOWDOWN_MONTHS = 6;
  if (pool && pool.winners >= SHOWDOWN_MAX_WINNERS)
    return res.status(400).json({ error: "The TAKEOVA Showdown has reached its 2,000 winner cap. Follow us for the next season." });
  if (pool && pool.month_number > SHOWDOWN_MONTHS)
    return res.status(400).json({ error: "The TAKEOVA Showdown season has ended. Follow us for the next season." });

  // Validate competitor URL
  if (!/^https:\/\/.{4,}/.test(competitor_url))
    return res.status(400).json({ error: "Competitor URL must start with https://" });
  if (/https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(competitor_url))
    return res.status(400).json({ error: "Competitor URL must be a publicly accessible domain." });

  // Validate timer
  const timer = db.prepare("SELECT * FROM showdown_timers WHERE id = ? AND used = 0").get(timer_id);
  if (!timer) return res.status(400).json({ error: "Invalid or already-used timer. Start a new clock." });

  const elapsedSeconds = Math.floor((Date.now() - new Date(timer.started_at).getTime()) / 1000);
  if (elapsedSeconds > 30 * 60) {
    const over = Math.floor((elapsedSeconds - 1800) / 60);
    return res.status(400).json({ error: `Your 30-minute window expired ${over} minute${over !== 1 ? "s" : ""} ago.` });
  }

  // One active entry per email — losses allow re-entry, wins/pending/in-review do not
  const existing = db.prepare("SELECT id, status, review_result FROM showdown_entries WHERE email = ?").get(email.toLowerCase());
  if (existing) {
    if (existing.status === "pending_verification")
      return res.status(400).json({ error: "An entry from this email is awaiting verification. Check your inbox." });
    if (existing.review_result === "win" || ["reviewed","paid","claim_submitted"].includes(existing.status))
      return res.status(400).json({ error: "This email has already won or has an active entry. One entry per person per round." });
    // Previous loss — allow re-entry (delete old entry so DB unique constraint on email doesn't block)
    db.prepare("DELETE FROM showdown_entries WHERE id=?").run(existing.id);
  }

  db.prepare("UPDATE showdown_timers SET used = 1 WHERE id = ?").run(timer_id);

  const entryId    = uuid();
  const verifyToken = crypto.randomBytes(32).toString("hex");
  const expiresAt  = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Auto-create TAKEOVA account or extend trial
  let trialActivated = 0;
  let tempPassword = null;
  try {
    const existingUser = db.prepare("SELECT id, trial_ends_at FROM users WHERE email = ?").get(email.toLowerCase());
    if (existingUser) {
      // Extend trial by 14 days from now
      const trialEnd = new Date(Math.max(Date.now(), new Date(existingUser.trial_ends_at || 0).getTime()) + 14 * 24 * 60 * 60 * 1000);
      db.prepare("UPDATE users SET trial_ends_at = ? WHERE id = ?").run(trialEnd.toISOString(), existingUser.id);
      trialActivated = 1;
    } else {
      // Create new TAKEOVA account with temp password
      const bcrypt = require("bcryptjs");
      const { v4: uuidv4 } = require("uuid");
      const crypto2 = require("crypto");
      tempPassword = crypto2.randomBytes(8).toString("hex"); // 16-char hex password
      const passwordHash = await bcrypt.hash(tempPassword, 12);
      const newUserId = uuidv4();
      const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        "INSERT INTO users (id, email, password_hash, name, plan, trial_ends_at, created_at) VALUES (?,?,?,?,'starter',?,datetime('now'))"
      ).run(newUserId, email.toLowerCase(), passwordHash, name.slice(0,120), trialEnd);
      // Send welcome email with set-password link
      try {
        const setPassToken = crypto2.randomBytes(32).toString("hex");
        // Store only the SHA-256 hash — the raw token goes in the email link.
        const setPassTokenHash = require("crypto").createHash("sha256").update(setPassToken).digest("hex");
        const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare("INSERT INTO password_resets (id, user_id, token, expires_at) VALUES (?,?,?,?)").run(uuidv4(), newUserId, setPassTokenHash, tokenExpiry);
        const setPassUrl = `${FRONTEND_URL}?reset_token=${setPassToken}&new_account=1`;
        await sendEmail({
          to: email,
          subject: "Welcome to TAKEOVA — activate your free 14-day trial",
          html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
            <h2 style="color:#2563EB;font-size:24px;margin-bottom:8px;">Your TAKEOVA trial is ready! 🎉</h2>
            <p style="color:#334155;line-height:1.7;">You entered the TAKEOVA $1M Challenge and we've created your free 14-day trial account — no credit card required.</p>
            <p style="color:#334155;line-height:1.7;">Set your password to log in and start exploring:</p>
            <a href="${setPassUrl}" style="display:inline-block;margin:20px 0;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#818CF8);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">Set Password & Start Trial →</a>
            <p style="color:#94A3B8;font-size:12px;line-height:1.6;">This link expires in 7 days. Your trial starts now and gives you full access to all MINE features for 14 days.</p>
          </div>`
        });
      } catch(emailErr) { console.error("[Showdown] welcome email:", emailErr.message); }
      trialActivated = 1;
    }
  } catch(e) { console.error("[Showdown] Account creation error:", e.message); }

  db.prepare(`INSERT INTO showdown_entries
    (id, name, email, platforms_used, competitor_url, mine_url, payout_preference, timer_id, started_at, submitted_at, elapsed_seconds, mine_trial_activated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(entryId, name.slice(0,120), email.toLowerCase().slice(0,200),
      (Array.isArray(platforms_used) ? platforms_used : [platforms_used]).join(", ").slice(0,200),
      competitor_url.slice(0,500), (mine_url||"").slice(0,500),
      payout_preference === "credit" ? "credit" : "cash",
      timer_id, timer.started_at, new Date().toISOString(), elapsedSeconds, trialActivated);

  db.prepare("INSERT INTO showdown_verify_tokens (id, entry_id, token, expires_at) VALUES (?,?,?,?)")
    .run(uuid(), entryId, verifyToken, expiresAt);

  const verifyUrl = `${BACKEND_URL}/api/showdown/verify/${verifyToken}`;
  // Email: verify entry + welcome if new account
  const emailHtml = tempPassword
    ? `${verifyEmailHtml(name, verifyUrl, elapsedSeconds)}
      <div style="margin-top:24px;padding:20px;background:#F0F4FF;border-radius:12px;border-left:4px solid #2563EB;">
        <p style="font-weight:700;margin-bottom:8px;">Your TAKEOVA account has been created!</p>
        <p style="margin-bottom:4px;">Email: <strong>${email}</strong></p>
        <p style="margin-bottom:12px;">Temporary password: <strong style="font-family:monospace;font-size:16px;">${tempPassword}</strong></p>
        <p style="color:#64748B;font-size:13px;">Sign in at <a href="${process.env.FRONTEND_URL || 'https://takeova.ai'}">takeova.ai</a> and change your password in settings.</p>
      </div>`
    : verifyEmailHtml(name, verifyUrl, elapsedSeconds);

  await sendEmail({
    to: email,
    subject: tempPassword ? "Your TAKEOVA account + Challenge entry" : "Verify your TAKEOVA $1M Challenge entry",
    html: emailHtml
  }).catch(e => console.error("[Showdown] verify email failed:", e.message));

  db.prepare("UPDATE showdown_pool SET monthly_entries = monthly_entries + 1 WHERE id = 1").run();
  res.json({ success: true, newAccount: trialActivated === 1 });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// GET /api/showdown/verify/:token
router.get("/verify/:token", async (req, res) => {
  try {
  const db = getDb();
  const row = db.prepare("SELECT * FROM showdown_verify_tokens WHERE token = ? AND used = 0").get(req.params.token);
  if (!row) return res.send(verifyPage("Invalid link", "This link has already been used or is invalid.", false));
  if (new Date(row.expires_at) < new Date()) return res.send(verifyPage("Link expired", "This link expired after 24 hours. Please re-submit your entry.", false));

  db.prepare("UPDATE showdown_entries SET status='pending_review', verified_at=datetime('now') WHERE id=?").run(row.entry_id);
  db.prepare("UPDATE showdown_verify_tokens SET used=1 WHERE id=?").run(row.id);

  const entry = db.prepare("SELECT * FROM showdown_entries WHERE id=?").get(row.entry_id);

  // Extend to 14-day trial for any TAKEOVA account with this email
  const mineUser = db.prepare("SELECT id, stripe_subscription_id, plan, trial_ends_at FROM users WHERE email=?").get(entry.email);
  if (mineUser) {
    await extendTrialTo14Days(mineUser).catch(e => console.error("[Showdown] trial extend failed:", e.message));
  }

  // Notify admin
  const adminEmail = getSetting("ADMIN_EMAIL") || getSetting("EMAIL_FROM");
  if (adminEmail) {
    sendEmail({
      to: adminEmail,
      subject: `New Showdown entry — ${entry.name} (${entry.platform}) — ${fmt(entry.elapsed_seconds)}`,
      html: adminNotifyHtml(entry)
    }).catch(() => {});
  }

  res.send(verifyPage("Entry verified! ✓", "Your store has been submitted for review. We'll email you within 24 hours.", true));
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// GET /api/showdown/leaderboard
router.get("/leaderboard", (req, res) => {
  const entries = getDb().prepare(`
    SELECT name, platform, review_result, payout_preference, reviewed_at, elapsed_seconds
    FROM showdown_entries
    WHERE status IN ('reviewed','paid','claim_submitted')
    ORDER BY
      CASE WHEN review_result='win' THEN 0 ELSE 1 END ASC,
      CASE WHEN review_result='win' THEN elapsed_seconds ELSE 9999999 END ASC,
      reviewed_at ASC
    LIMIT 50
  `).all();
  res.json({ entries });
});

// GET /api/showdown/claim/:token  — winner payout claim page
router.get("/claim/:token", (req, res) => {
  const entry = getDb().prepare("SELECT * FROM showdown_entries WHERE claim_token=?").get(req.params.token);
  if (!entry || entry.review_result !== "win")
    return res.send(verifyPage("Invalid claim link", "This payout link is invalid or has expired.", false));
  if (entry.paid_at)
    return res.send(verifyPage("Already claimed", "This prize has already been claimed. Check your bank — it should have arrived.", true));
  res.send(claimPage(entry));
});

// POST /api/showdown/claim/:token  — winner submits payout details
// NOTE: Stripe does not support paying arbitrary recipients without Stripe Connect.
// This endpoint records the winner's payout info and triggers an admin alert.
// To automate payouts, enable Stripe Connect and use stripe.transfers.create.
router.post("/claim/:token", async (req, res) => {
  try {
  const db = getDb();
  const entry = db.prepare("SELECT * FROM showdown_entries WHERE claim_token=?").get(req.params.token);
  if (!entry || entry.review_result !== "win")
    return res.status(400).json({ error: "Invalid or ineligible claim link." });
  if (entry.paid_at || entry.status === "claim_submitted")
    return res.status(400).json({ error: "This prize has already been claimed. Our team will be in touch within 48 hours." });

  const { payout_method } = req.body; // "stripe_connect" or "credit"

  if (entry.payout_preference === "credit" || payout_method === "credit") {
    // Apply 1 year free to their TAKEOVA account
    try {
      const user = db.prepare("SELECT id, trial_ends_at, plan FROM users WHERE email = ?").get(entry.email);
      if (user) {
        const base = Math.max(Date.now(), new Date(user.trial_ends_at || 0).getTime());
        const newExpiry = new Date(base + 365 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare("UPDATE users SET trial_ends_at = ?, plan = COALESCE(plan, 'growth') WHERE id = ?").run(newExpiry, user.id);
      }
    } catch(e) { console.error("[/claim/:token]", e.message || e); }
    db.prepare("UPDATE showdown_entries SET status='paid', paid_at=datetime('now') WHERE claim_token=?").run(req.params.token);
    return res.json({ success: true, method: "credit", message: "1 year free applied to your TAKEOVA account!" });
  }

  // Cash payout via Stripe Connect
  try {
    const stripe = require("stripe")(getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY);
    if (!stripe) return res.status(503).json({ error: "Payment system not configured" });

    // Create Stripe Express account for the winner
    const account = await stripe.accounts.create({
      type: "express",
      email: entry.email,
      capabilities: { transfers: { requested: true } },
      metadata: { showdown_entry: entry.id, winner_name: entry.name }
    });

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `\${FRONTEND_URL}/showdown.html?claim=\${req.params.token}&refresh=1`,
      return_url: `\${FRONTEND_URL}/showdown.html?claim=\${req.params.token}&onboarded=1`,
      type: "account_onboarding"
    });

    db.prepare("UPDATE showdown_entries SET status='claim_submitted', stripe_payment_link=? WHERE claim_token=?")
      .run(account.id, req.params.token);

    return res.json({ success: true, method: "stripe_connect", onboarding_url: accountLink.url });
  } catch(stripeErr) {
    console.error("[Showdown] Stripe Connect error:", stripeErr.message);
    // Fallback — mark for manual payment
    db.prepare("UPDATE showdown_entries SET status='claim_submitted' WHERE claim_token=?").run(req.params.token);
    return res.json({ success: true, method: "manual", message: "We'll process your $500 payment within 48 hours." });
  }
  } catch(e) {
    console.error("[Showdown] claim error:", e.message);
    res.status(500).json({ error: "Claim failed. Please try again or contact support." });
  }
});


router.get("/admin/entries", auth, adminOnly, (req, res) => {
  res.json({ entries: getDb().prepare("SELECT * FROM showdown_entries ORDER BY created_at DESC").all() });
});

// POST /api/showdown/admin/review/:id   body: { result: 'win'|'loss', notes }
router.post("/admin/review/:id", auth, adminOnly, async (req, res) => {
  try {
  const db = getDb();
  const { result, notes } = req.body;
  if (!["win","loss"].includes(result)) return res.status(400).json({ error: "result must be win or loss" });

  const entry = db.prepare("SELECT * FROM showdown_entries WHERE id=?").get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  if (["reviewed","paid","claim_submitted"].includes(entry.status)) return res.status(400).json({ error: "Entry has already been reviewed or paid." });

  db.prepare("UPDATE showdown_entries SET status='reviewed', review_result=?, reviewed_at=datetime('now'), reviewer_notes=? WHERE id=?")
    .run(result, notes || "", req.params.id);
  // Decrement prize pool on win + initiate payout
  if (result === "win") {
    db.prepare("UPDATE showdown_pool SET paid_out = paid_out + 500, winners = winners + 1, monthly_winners = monthly_winners + 1 WHERE id = 1").run();

    const winEntry = db.prepare("SELECT * FROM showdown_entries WHERE id = ?").get(req.params.id);
    const claimToken = require("crypto").randomBytes(32).toString("hex");
    db.prepare("UPDATE showdown_entries SET claim_token = ? WHERE id = ?").run(claimToken, req.params.id);
    const claimUrl = `${process.env.FRONTEND_URL || "https://takeova.ai"}/showdown/claim/${claimToken}`;

    {
      // Cash payout — generate Stripe Connect onboarding link
      let payoutLink = claimUrl;
      try {
        const stripe = require("stripe")(getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY);
        if (stripe && winEntry?.email) {
          // Create a Stripe Connect Express account for the winner
          const acct = await stripe.accounts.create({
            type: "express",
            email: winEntry.email,
            capabilities: { transfers: { requested: true } },
            metadata: { showdown_entry: req.params.id, winner_name: winEntry.name }
          });
          const acctLink = await stripe.accountLinks.create({
            account: acct.id,
            refresh_url: claimUrl,
            return_url: `${process.env.FRONTEND_URL || "https://takeova.ai"}/showdown/claim/${claimToken}?connected=1`,
            type: "account_onboarding"
          });
          // Save connect account id
          db.prepare("UPDATE showdown_entries SET stripe_payment_link = ? WHERE id = ?").run(acct.id, req.params.id);
          payoutLink = acctLink.url;
        }
      } catch(se) { console.error("[Showdown] Stripe Connect error:", se.message); }

      // Email winner with payout link
      await sendEmail({
        to: winEntry.email,
        subject: "🏆 You won the TAKEOVA Challenge — Claim your $500!",
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#2563EB;">You won! 🎉</h2>
          <p>Congratulations ${winEntry.name}! A judge reviewed your entry and you beat us.</p>
          <p>Click the button below to claim your <strong>$500</strong>. You'll be asked to connect your bank account via Stripe — it takes about 2 minutes.</p>
          <a href="${payoutLink}" style="display:inline-block;padding:14px 32px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;margin:16px 0;">Claim My $500 →</a>
          <p style="color:#64748B;font-size:12px;">Link expires in 7 days. If you have issues, reply to this email.</p>
        </div>`
      }).catch(() => {});
    }
  }

  if (result === "win") {
    // Generate unique claim token — stored cleanly in its own column
    const claimToken = crypto.randomBytes(24).toString("hex");
    db.prepare("UPDATE showdown_entries SET claim_token=? WHERE id=?").run(claimToken, req.params.id);
    const claimUrl = `${BACKEND_URL}/api/showdown/claim/${claimToken}`;
    db.prepare("UPDATE showdown_entries SET stripe_payment_link=? WHERE id=?").run(claimUrl, req.params.id);

    await sendWinnerEmail({ ...entry, claim_token: claimToken }, claimUrl)
      .catch(e => console.error("[Showdown] winner email failed:", e.message));

    res.json({ success: true, claim_url: claimUrl });
  } else {
    await sendEmail({
      to: entry.email,
      subject: "TAKEOVA Challenge result — thanks for entering",
      html: lossEmailHtml(entry, notes)
    }).catch(() => {});
    res.json({ success: true });
  }
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// POST /api/showdown/admin/paid/:id
router.post("/admin/paid/:id", auth, adminOnly, async (req, res) => {
  try {
  const db = getDb();
  const entry = db.prepare("SELECT * FROM showdown_entries WHERE id=?").get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  if (entry.status === "paid") return res.status(400).json({ error: "Already marked as paid." });

  // If Stripe Connect account exists, trigger the $500 transfer
  let stripeTransferDone = false;
  if (entry.stripe_payment_link && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require("stripe")(getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY);
      await stripe.transfers.create({
        amount: 50000, // $500.00 in cents
        currency: "usd",
        destination: entry.stripe_payment_link,
        description: `TAKEOVA $1M Challenge winner payout — \${entry.name}`,
        metadata: { entry_id: entry.id, winner_email: entry.email }
      });
      stripeTransferDone = true;
    } catch(se) {
      console.error("[Showdown] Stripe transfer failed:", se.message);
    }
  }

  db.prepare("UPDATE showdown_entries SET status='paid', paid_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ success: true, stripeTransfer: stripeTransferDone });
  } catch(e) {
    console.error("[Showdown] admin/paid error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/showdown/admin/select-monthly-winners
// Called at end of each month — marks top 5% of that month's entries as winners
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/select-monthly-winners", auth, adminOnly, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const pool = db.prepare("SELECT * FROM showdown_pool WHERE id = 1").get();
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    const TOTAL_CAP   = 2000;
    const WIN_PERCENT = 0.05; // top 5%
    const remaining   = TOTAL_CAP - pool.winners;

    if (remaining <= 0)
      return res.status(400).json({ error: "2,000 winner cap reached — Showdown is complete." });
    if (pool.month_number > 6)
      return res.status(400).json({ error: "6-month programme complete." });

    const monthStart = pool.month_started_at;

    // ── Fair ranking: daily average revenue (GMV since monthStart ÷ days since entry) ──
    // Pre-entry orders count — rewards users already active on MINE before entering
    // Divided by days since entry — levels the field for late joiners
    // e.g. existing user enters day 15 with strong month history → high daily avg
    //      new user enters day 15 → their GMV / 15 days vs day-1 user's GMV / 30 days
    const candidates = db.prepare(`
      SELECT se.*,
        COALESCE((SELECT SUM(total) FROM orders
          WHERE user_id = (SELECT id FROM users WHERE email = se.email LIMIT 1)
          AND created_at >= ?), 0) as gmv_total,
        MAX(1, CAST(
          (julianday('now') - julianday(se.created_at))
        AS INTEGER)) as days_active
      FROM showdown_entries se
      WHERE se.created_at >= ?
        AND se.status NOT IN ('reviewed','paid','claim_submitted')
        AND (se.review_result IS NULL OR se.review_result != 'win')
        AND (se.ad_cap_excluded_month IS NULL
             OR se.ad_cap_excluded_month != strftime('%Y-%m','now'))
    `).all(monthStart, monthStart).map(e => ({
      ...e,
      gmv: e.gmv_total,
      daily_avg: e.days_active > 0 ? e.gmv_total / e.days_active : 0
    })).sort((a, b) => b.daily_avg - a.daily_avg);

    if (candidates.length === 0)
      return res.json({ message: "No eligible entries this month", winners: 0 });

    const winnerCount = Math.min(
      Math.max(1, Math.floor(candidates.length * WIN_PERCENT)),
      remaining
    );
    const winners = candidates.slice(0, winnerCount);
    let processed = 0;

    for (const entry of winners) {
      try {
        db.prepare(`UPDATE showdown_entries SET status='reviewed', review_result='win',
          reviewed_at=datetime('now'), reviewer_notes=? WHERE id=?`)
          .run(`Auto Month ${pool.month_number}: top ${(WIN_PERCENT*100).toFixed(0)}% by daily avg (${winnerCount}/${candidates.length}). GMV: $${Math.round(entry.gmv)} over ${entry.days_active} days ($${entry.daily_avg.toFixed(2)}/day)`, entry.id);

        db.prepare("UPDATE showdown_pool SET paid_out = paid_out + 500, winners = winners + 1, monthly_winners = monthly_winners + 1 WHERE id = 1").run();

        const claimToken = require("crypto").randomBytes(32).toString("hex");
        const claimUrl = `\${process.env.FRONTEND_URL || "https://takeova.ai"}/showdown-claim?token=\${claimToken}`;
        db.prepare("UPDATE showdown_entries SET claim_token=? WHERE id=?").run(claimToken, entry.id);

        const sgKey = getSetting("SENDGRID_API_KEY");
        const fromEmail = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
        if (sgKey && entry.email) {
          const fetch = (await import("node-fetch")).default;
          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { Authorization: `Bearer \${sgKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: entry.email }] }],
              from: { email: fromEmail, name: "MINE" },
              subject: "🏆 You won the TAKEOVA Showdown — Claim your $500!",
              content: [{ type: "text/html", value: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
                <h2>🏆 Congratulations \${entry.name}!</h2>
                <p>You placed in the <strong>top 5%</strong> of all MINE stores this month and won <strong>$500 cash</strong>.</p>
                <p>Month \${pool.month_number} results — you ranked in the top \${winnerCount} of \${candidates.length} stores with $\${entry.daily_avg.toFixed(2)}/day average revenue over \${entry.days_active} days.</p>
                <a href="\${claimUrl}" style="display:inline-block;background:linear-gradient(135deg,#F59E0B,#EC4899);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;margin:16px 0;">Claim My $500 →</a>
                <p style="color:#64748B;font-size:12px;">Link expires in 7 days.</p>
              </div>` }]
            })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
        }
        processed++;
      } catch(e) {}
    }

    db.prepare(`UPDATE showdown_pool SET
      month_number = month_number + 1,
      month_started_at = datetime('now'),
      monthly_entries = 0,
      monthly_winners = 0
      WHERE id = 1`).run();

    res.json({
      success: true,
      month: pool.month_number,
      candidates: candidates.length,
      winners_selected: processed,
      win_percentage: "5%",
      pool_remaining: remaining - processed,
      total_winners_to_date: pool.winners + processed,
    });
  } catch(e) {
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

// GET /api/showdown/stats — public stats
router.get("/stats", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const pool = db.prepare("SELECT * FROM showdown_pool WHERE id = 1").get();
    res.json({
      month_number:     pool?.month_number   || 1,
      total_winners:    pool?.winners        || 0,
      monthly_winners:  pool?.monthly_winners || 0,
      monthly_entries:  pool?.monthly_entries || 0,
      remaining_spots:  Math.max(0, 5000 - (pool?.winners || 0)),
      prize_per_winner: 200,
      win_percentage:   5,
      months_remaining: Math.max(0, 6 - ((pool?.month_number || 1) - 1)),
      pool_remaining:   Math.max(0, 1000000 - (pool?.paid_out || 0)),
    });
  } catch(e) {
    res.json({ month_number: 1, total_winners: 0, remaining_spots: 5000, win_percentage: 5 });
  }
});

module.exports = router;
