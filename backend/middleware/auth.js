const { getDb } = require("../db/init");
const { v4: uuid } = require("uuid");
const crypto = require("crypto");

// Hash a session token for DB storage.
// We store only the SHA-256 hash in the sessions table.
// If the DB leaks, the raw tokens cannot be derived — the attacker only
// has hashes, not usable credentials.
// Raw tokens are 32 random bytes (256 bits of entropy) so rainbow tables
// are not a concern; no salt needed.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── Create a session token and store it in DB (30 day expiry) ──
function signToken(userId, role, ownerId = null, teamRole = null) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  // Ensure owner_id, team_role, token_hash columns exist
  try { db.exec("ALTER TABLE sessions ADD COLUMN owner_id TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN team_role TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN token_hash TEXT"); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)"); } catch(e) {}
  // Store hash in token_hash, keep raw token field blank (don't log/store plaintext)
  db.prepare("INSERT INTO sessions (id, user_id, token, token_hash, expires_at, owner_id, team_role) VALUES (?,?,?,?,?,?,?)")
    .run(uuid(), userId, "", tokenHash, expiresAt, ownerId || null, teamRole || null);
  return token;
}

// ── Auth middleware — validates session token ──
// Looks up sessions by hashed token. Falls back to plaintext column for
// legacy sessions created before the hash migration — these expire naturally
// within 30 days and can be cleaned up then.
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  const db = getDb();
  const tokenHash = hashToken(token);
  // Primary lookup: hashed column. Fallback: legacy plaintext for pre-migration sessions.
  let session = db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(tokenHash);
  if (!session) {
    session = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  }
  if (!session) return res.status(401).json({ error: "Invalid or expired token" });
  req.userId = session.user_id;
  req.sessionId = session.id;  // exposed for endpoints that need to preserve current session (e.g. /api/admin/sessions DELETE)
  req.user = db.prepare("SELECT id, email, name, role, plan, trial_ends_at, account_status FROM users WHERE id = ?").get(session.user_id);

  // ── Banned / suspended account block ──
  // Previously the admin "ban" feature set role='banned' but nothing in the
  // request pipeline ever checked for it, so banned users kept full API
  // access for up to 30 days (until their session expired). This middleware
  // runs on every authenticated request, so one check here closes the gap.
  if (req.user && (req.user.role === "banned" || req.user.account_status === "banned" || req.user.account_status === "suspended")) {
    // Kill the session so the banned user also can't replay the token
    try { db.prepare("DELETE FROM sessions WHERE user_id = ?").run(session.user_id); } catch(e) {}
    return res.status(403).json({ error: "Account suspended. Contact support." });
  }

  // Team member: if session has an owner_id, act on behalf of the owner
  if (session.owner_id) {
    // Re-verify team membership on every request — prevents revoked members from keeping access
    try {
      const stillMember = db.prepare("SELECT id FROM team_members WHERE user_id = ? AND owner_id = ? AND status = 'active'").get(session.user_id, session.owner_id);
      if (!stillMember) {
        // Team membership revoked — kill the session
        db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
        return res.status(401).json({ error: "Team access revoked. Please log in again." });
      }
    } catch(e) { /* if team_members table doesn't exist yet, skip check (legacy) */ }

    req.originalUserId = session.user_id;
    req.userId = session.owner_id;
    req.teamRole = session.team_role || "editor";
    req.isTeamMember = true;
  }

  // Track impersonation context so sensitive routes can block it
  if (session.impersonated_by) {
    req.isImpersonated = true;
    req.impersonatedBy = session.impersonated_by;
  }

  next();
};

// ── Trial gate — blocks API if trial expired and no paid plan ──
// Apply to any route that should be paywalled after trial
const requireActivePlan = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  const plan = req.user.plan;
  const trialEndsAt = req.user.trial_ends_at;
  const subStatus = req.user.subscription_status; // null/active/trialing/past_due/canceled/unpaid

  // Block paying customers whose payment has actually failed.
  // Note: 'incomplete' is NOT blocked — it's the brief window between Stripe Checkout
  // and the first invoice succeeding. Blocking it would lock out users mid-signup.
  if (subStatus && ["past_due","unpaid","incomplete_expired"].includes(subStatus)) {
    return res.status(402).json({
      error: "Your subscription needs attention. Please update your payment method.",
      subscriptionStatus: subStatus,
      code: "SUBSCRIPTION_INACTIVE"
    });
  }

  // Anyone actively paying (or in their card-backed Stripe trial) — allowed on ANY plan,
  // including paid Starter. This is the status-based rule (change-doc item 1).
  if (["active","trialing"].includes(subStatus)) return next();

  // Paid-tier plans with healthy-or-unset status — allowed (covers manually granted accounts).
  // 'canceled' falls through to the choose-a-plan prompt below. Starter without an active
  // subscription does NOT pass here — no free product.
  if (["growth","pro","enterprise","agency","agency_client"].includes(plan) && subStatus !== "canceled") return next();

  // Active trial on ANY plan — allowed (trial now applies to all plans, not just starter)
  if (trialEndsAt && new Date(trialEndsAt) > new Date()) return next();

  // No active trial, no paid plan — blocked
  return res.status(402).json({
    error: "A subscription is required to continue. Choose a plan to get started.",
    trialExpired: true,
    code: "TRIAL_EXPIRED"
  });
};

// ── Logout — delete session from DB ──
function revokeToken(token) {
  try {
    const db = getDb();
    const tokenHash = hashToken(token);
    db.prepare("DELETE FROM sessions WHERE token_hash = ? OR token = ?").run(tokenHash, token);
  } catch (e) { /* ignore */ }
}

// ── Revoke ALL sessions for a user (call on password change / reset) ──
function revokeAllSessions(userId) {
  try {
    const db = getDb();
    const r = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    console.log(`[Auth] Revoked ${r.changes} session(s) for user ${userId}`);
    return r.changes;
  } catch (e) { return 0; }
}

// ── Cleanup expired sessions (run periodically) ──
function cleanupSessions() {
  try {
    const db = getDb();
    const result = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    if (result.changes > 0) console.log(`[Sessions] Cleaned up ${result.changes} expired sessions`);
    // Also clean up expired password reset tokens
    try { db.prepare("DELETE FROM password_resets WHERE expires_at < datetime('now')").run(); } catch(e) {}
  } catch (e) { /* ignore */ }
}


// ── Admin-only middleware ──
const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
};

// ── Optional auth — attaches user if token present, continues either way ──
const optionalAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return next();
  try {
    const db = getDb();
    const tokenHash = hashToken(token);
    let session = db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(tokenHash);
    if (!session) {
      session = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
    }
    if (session) {
      req.userId = session.user_id;
      req.user = db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(session.user_id);
    }
  } catch (e) { /* ignore */ }
  next();
};

// Blocks impersonation sessions from sensitive operations
const blockImpersonation = (req, res, next) => {
  if (req.isImpersonated) {
    return res.status(403).json({
      error: "This action cannot be performed while managing a client's account. Exit client view first."
    });
  }
  next();
};

// ── Team role gates ──
// Blocks team members who are editors (read-only) from write operations
const editorOnly = (req, res, next) => {
  // Non-team members (account owners) always pass
  if (!req.isTeamMember) return next();
  return res.status(403).json({ error: "Editors cannot perform this action. Ask the account owner." });
};

// Blocks ALL team members from owner-only operations (billing, account deletion, etc.)
const ownerOnly = (req, res, next) => {
  if (req.isTeamMember) {
    return res.status(403).json({ error: "Only the account owner can perform this action." });
  }
  next();
};

module.exports = { auth, signToken, revokeToken, revokeAllSessions, cleanupSessions, adminOnly, optionalAuth, requireActivePlan, blockImpersonation, editorOnly, ownerOnly };
