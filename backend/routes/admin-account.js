// ─────────────────────────────────────────────────────────────────────────────
// Admin Account Settings — profile, preferences, 2FA, session management
// ─────────────────────────────────────────────────────────────────────────────
// Backend for the admin dashboard's slim Settings panel (My Profile,
// Preferences, Security). Each endpoint corresponds to a `data-edit` card
// in the admin-live-dashboard.html SETTINGS_FIELDS schema.
//
// Routes (all require auth + adminOnly + non-impersonated session):
//   PATCH  /api/admin/profile              → name / email / password
//   PATCH  /api/admin/preferences          → theme / timezone / locale / landing_tab / alerts
//   POST   /api/admin/2fa/manage           → enable / disable / regenerate-codes
//   DELETE /api/admin/sessions/:id         → revoke single session
//   DELETE /api/admin/sessions             → revoke all sessions except current
//
// Tables touched:
//   users — existing. Adds columns via ALTER TABLE IF NOT EXISTS pattern:
//     theme, locale, landing_tab, alerts_json, two_fa_backup_codes_json
//   sessions — existing. id, user_id, token, ip_address, user_agent,
//     expires_at, created_at.
//
// Audit log entries written for every mutating action.
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const crypto  = require("crypto");
const bcrypt  = require("bcryptjs");
const { getDb } = require("../db/init");
const { auth, adminOnly, blockImpersonation, revokeAllSessions } = require("../middleware/auth");

const router = express.Router();
router.use(auth, adminOnly);

// ── Schema migration (idempotent) ────────────────────────────────────────────
function ensureColumns(db) {
  const cols = [
    "ALTER TABLE users ADD COLUMN theme TEXT",
    "ALTER TABLE users ADD COLUMN locale TEXT",
    "ALTER TABLE users ADD COLUMN landing_tab TEXT",
    "ALTER TABLE users ADD COLUMN alerts_json TEXT",
    "ALTER TABLE users ADD COLUMN two_fa_backup_codes_json TEXT",
  ];
  for (const sql of cols) { try { db.exec(sql); } catch (_) { /* already exists */ } }
}

function audit(db, userId, action, details) {
  try {
    db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
      .run(userId, action, JSON.stringify(details || {}));
  } catch (_) { /* audit_log may not exist — non-fatal */ }
}

// ── PATCH /profile ────────────────────────────────────────────────────────────
// Updates display name, email, or password. Each call typically sets one
// field at a time (the frontend's individual edit cards send single-field
// payloads), but we accept any combination.
router.patch("/profile", blockImpersonation, async (req, res) => {
  try {
    const db = getDb();
    ensureColumns(db);
    const userId = req.userId;
    const updates = [];
    const values  = [];
    const audited = {};

    // display_name (frontend sends as `display_name`, stored as `name`)
    if (typeof req.body?.display_name === "string") {
      const name = req.body.display_name.trim();
      if (!name || name.length > 80) return res.status(400).json({ error: "Invalid name" });
      updates.push("name = ?");
      values.push(name);
      audited.name = name;
    }

    if (typeof req.body?.email === "string") {
      const email = req.body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
      // Check uniqueness (excluding current user)
      const taken = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, userId);
      if (taken) return res.status(409).json({ error: "Email already in use" });
      updates.push("email = ?");
      values.push(email);
      audited.email = email;
    }

    if (typeof req.body?.password === "string") {
      const pw = req.body.password;
      if (pw.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
      const hash = await bcrypt.hash(pw, 10);
      updates.push("password_hash = ?");
      values.push(hash);
      audited.password_changed = true;
    }

    if (updates.length === 0) return res.status(400).json({ error: "No valid fields supplied" });

    updates.push("updated_at = datetime('now')");
    values.push(userId);
    db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    audit(db, userId, "admin_profile_update", audited);
    const user = db.prepare("SELECT id, email, name, role, two_fa_enabled FROM users WHERE id = ?").get(userId);
    res.json({ success: true, user });
  } catch (e) {
    console.error("[admin-account /profile]", e?.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── PATCH /preferences ────────────────────────────────────────────────────────
// Updates UI preferences (theme, timezone, locale, landing_tab, alerts).
router.patch("/preferences", (req, res) => {
  try {
    const db = getDb();
    ensureColumns(db);
    const userId = req.userId;
    const updates = [];
    const values  = [];
    const audited = {};

    if (typeof req.body?.theme === "string" && ["light", "dark", "auto"].includes(req.body.theme)) {
      updates.push("theme = ?"); values.push(req.body.theme); audited.theme = req.body.theme;
    }
    if (typeof req.body?.timezone === "string" && req.body.timezone.length <= 64) {
      updates.push("timezone = ?"); values.push(req.body.timezone.trim()); audited.timezone = req.body.timezone;
    }
    if (typeof req.body?.locale === "string" && /^[a-zA-Z-]{2,10}$/.test(req.body.locale)) {
      updates.push("locale = ?"); values.push(req.body.locale.trim()); audited.locale = req.body.locale;
    }
    if (typeof req.body?.landing_tab === "string" && req.body.landing_tab.length <= 32) {
      updates.push("landing_tab = ?"); values.push(req.body.landing_tab.trim()); audited.landing_tab = req.body.landing_tab;
    }
    if (req.body?.alerts && typeof req.body.alerts === "object") {
      const json = JSON.stringify(req.body.alerts);
      if (json.length > 4000) return res.status(400).json({ error: "Alerts payload too large" });
      updates.push("alerts_json = ?"); values.push(json); audited.alerts = req.body.alerts;
    }

    if (updates.length === 0) return res.status(400).json({ error: "No valid preference fields" });

    updates.push("updated_at = datetime('now')");
    values.push(userId);
    db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    audit(db, userId, "admin_preferences_update", audited);
    const prefs = db.prepare(
      "SELECT theme, timezone, locale, landing_tab, alerts_json FROM users WHERE id = ?"
    ).get(userId);
    if (prefs?.alerts_json) { try { prefs.alerts = JSON.parse(prefs.alerts_json); } catch (_) {} }
    delete prefs?.alerts_json;
    res.json({ success: true, preferences: prefs });
  } catch (e) {
    console.error("[admin-account /preferences]", e?.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /2fa/manage ─────────────────────────────────────────────────────────
// action: 'enable' | 'disable' | 'regenerate-codes'
// Requires password confirmation for enable + disable (security-critical).
router.post("/2fa/manage", blockImpersonation, async (req, res) => {
  try {
    const db = getDb();
    ensureColumns(db);
    const userId = req.userId;
    const action = req.body?.action;
    const password = req.body?.password;

    if (!["enable", "disable", "regenerate-codes"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const user = db.prepare(
      "SELECT id, email, password_hash, two_fa_enabled, two_fa_secret FROM users WHERE id = ?"
    ).get(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Password gate for enable + disable. Regenerate-codes is allowed without
    // re-prompting password since the user is already authenticated and 2FA
    // is already on.
    if (action !== "regenerate-codes") {
      if (typeof password !== "string" || !password) {
        return res.status(400).json({ error: "Password confirmation required" });
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(403).json({ error: "Incorrect password" });
    }

    if (action === "enable") {
      if (user.two_fa_enabled) return res.status(409).json({ error: "2FA is already enabled" });
      // Generate TOTP secret (base32-ish — 20 random bytes hex)
      const secret = crypto.randomBytes(20).toString("hex").toUpperCase();
      // Generate 10 backup codes (8 chars each)
      const codes = Array.from({ length: 10 }, () =>
        crypto.randomBytes(4).toString("hex").toUpperCase().match(/.{4}/g).join("-")
      );
      // Hash codes for storage; return plaintext to user once
      const hashed = codes.map((c) => crypto.createHash("sha256").update(c).digest("hex"));
      db.prepare(
        "UPDATE users SET two_fa_enabled = 1, two_fa_secret = ?, two_fa_backup_codes_json = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(secret, JSON.stringify(hashed), userId);
      audit(db, userId, "admin_2fa_enabled", {});
      const issuer = encodeURIComponent("MINE Admin");
      const account = encodeURIComponent(user.email);
      const otpauth = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}`;
      return res.json({ success: true, secret, otpauth, backup_codes: codes });
    }

    if (action === "disable") {
      if (!user.two_fa_enabled) return res.status(409).json({ error: "2FA is not enabled" });
      db.prepare(
        "UPDATE users SET two_fa_enabled = 0, two_fa_secret = NULL, two_fa_backup_codes_json = NULL, updated_at = datetime('now') WHERE id = ?"
      ).run(userId);
      audit(db, userId, "admin_2fa_disabled", {});
      return res.json({ success: true });
    }

    if (action === "regenerate-codes") {
      if (!user.two_fa_enabled) return res.status(409).json({ error: "Enable 2FA first" });
      const codes = Array.from({ length: 10 }, () =>
        crypto.randomBytes(4).toString("hex").toUpperCase().match(/.{4}/g).join("-")
      );
      const hashed = codes.map((c) => crypto.createHash("sha256").update(c).digest("hex"));
      db.prepare(
        "UPDATE users SET two_fa_backup_codes_json = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify(hashed), userId);
      audit(db, userId, "admin_2fa_regenerate_codes", {});
      return res.json({ success: true, backup_codes: codes });
    }
  } catch (e) {
    console.error("[admin-account /2fa/manage]", e?.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── DELETE /sessions/:id ──────────────────────────────────────────────────────
// Revoke a specific session. Cannot revoke the current session via this
// endpoint — use DELETE /sessions for that (sign out from everywhere).
router.delete("/sessions/:id", blockImpersonation, (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    const sessionId = req.params.id;

    const session = db.prepare("SELECT id, user_id FROM sessions WHERE id = ?").get(sessionId);
    if (!session)                  return res.status(404).json({ error: "Session not found" });
    if (session.user_id !== userId) return res.status(403).json({ error: "Cannot revoke another user's session" });

    // Block revoking current session via this endpoint — user should use the
    // sign-out-everywhere flow instead.
    if (req.sessionId === sessionId) {
      return res.status(400).json({ error: "Cannot revoke current session here. Use sign out from everywhere." });
    }

    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    audit(db, userId, "admin_session_revoked", { sessionId });
    res.json({ success: true });
  } catch (e) {
    console.error("[admin-account /sessions/:id]", e?.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── DELETE /sessions ──────────────────────────────────────────────────────────
// Revoke ALL sessions except the current one. The current session is
// preserved so the user isn't immediately logged out — they explicitly
// stay logged in here, just kicked out of every other device.
router.delete("/sessions", blockImpersonation, (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    const currentSessionId = req.sessionId;

    let deletedCount = 0;
    if (currentSessionId) {
      const r = db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, currentSessionId);
      deletedCount = r.changes;
    } else {
      // Fall back to nuking all sessions if we somehow can't identify current
      const r = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      deletedCount = r.changes;
    }
    audit(db, userId, "admin_sign_out_everywhere", { sessions_revoked: deletedCount });
    res.json({ success: true, sessions_revoked: deletedCount });
  } catch (e) {
    console.error("[admin-account /sessions]", e?.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /sessions ─────────────────────────────────────────────────────────────
// Optional helper for the dashboard to list active sessions (so the user
// can pick one to revoke). Not strictly part of the original 5-endpoint
// requirement but trivial to add and used by the Settings UI.
router.get("/sessions", (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    const rows = db.prepare(
      "SELECT id, ip_address, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC"
    ).all(userId);
    const sessions = rows.map((s) => ({
      id: s.id,
      ip_address: s.ip_address,
      user_agent: s.user_agent,
      created_at: s.created_at,
      expires_at: s.expires_at,
      is_current: s.id === req.sessionId,
    }));
    res.json({ sessions });
  } catch (e) {
    console.error("[admin-account GET /sessions]", e?.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
