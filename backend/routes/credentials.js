// ═══════════════════════════════════════════════════════════════════
// MINE — CREDENTIAL VAULT
//
// Encrypted per-domain credentials for the AI Browser Agent.
// Users store logins once; the Browser Agent retrieves them at task
// time. Passwords never leave the server in plaintext — they're only
// decrypted in-memory by the browser-agent runner.
//
// SECURITY MODEL:
//   - AES-256-GCM with per-record random IV
//   - Master key from CREDENTIAL_VAULT_KEY (32 bytes hex) or derived
//     from JWT_SECRET as a fallback (with a warning logged)
//   - Passwords NEVER returned to the user via API — only masked
//     metadata. The "decrypt" endpoint is internal-auth only.
//   - Every decryption is audit-logged with the task ID + timestamp
//   - Per-user record isolation via WHERE user_id = ? on every query
//
// Mounted at /api/credentials
//
// User endpoints (require user auth):
//   GET  /             — list user's credentials (masked)
//   POST /             — add a credential
//   PUT  /:id          — update label/notes/2FA settings
//   PUT  /:id/password — rotate password
//   DELETE /:id        — delete
//   GET  /audit/:id    — view usage log for a credential
//
// Internal endpoint (browser-agent runner only):
//   POST /_unlock      — decrypt and return cred for an active task
// ═══════════════════════════════════════════════════════════════════
const express = require("express");
const router  = express.Router();
const crypto  = require("crypto");
const { auth: requireAuth } = require("../middleware/auth");

function getDb(req) {
  return req.app.locals.db || require("../db/init").getDb();
}

// ─── Master key resolution ───────────────────────────────────────────
function getMasterKey() {
  const fromEnv = process.env.CREDENTIAL_VAULT_KEY;
  if (fromEnv && fromEnv.length === 64) {
    return Buffer.from(fromEnv, "hex");
  }
  // Fallback: derive from JWT_SECRET via SHA-256. Log a one-time warning
  // because operators should set a dedicated key in production.
  if (!global.__credVaultKeyWarned) {
    global.__credVaultKeyWarned = true;
    console.warn("[credentials] CREDENTIAL_VAULT_KEY not set — deriving from JWT_SECRET. Set a 32-byte hex key in production.");
  }
  return crypto.createHash("sha256").update(String(process.env.JWT_SECRET || "dev-secret")).digest();
}

// ─── Encryption helpers ──────────────────────────────────────────────
function encrypt(plain) {
  if (plain == null || plain === "") return null;
  const key = getMasterKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv) . base64(tag) . base64(ciphertext)
  return iv.toString("base64") + "." + tag.toString("base64") + "." + ct.toString("base64");
}
function decrypt(blob) {
  if (!blob) return null;
  const [ivB64, tagB64, ctB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Malformed ciphertext");
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

// ─── Domain normalization ────────────────────────────────────────────
function normDomain(d) {
  if (!d) return "";
  let s = String(d).trim().toLowerCase();
  // Strip scheme, path, query
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  // Strip port
  s = s.split(":")[0];
  return s;
}

// ─── Bank/financial blocklist ────────────────────────────────────────
// We refuse to store credentials for bank-style sites. Bank ToS typically
// prohibit credential sharing, and unauthorized transactions carry
// special legal regimes (Reg E in the US). Users should connect banks
// via Plaid/TrueLayer in the Accounting panel instead.
//
// Matches by suffix so subdomains and country variants are covered
// (e.g. 'business.chase.com' or 'chase.com.au' both match 'chase.com').
const BANK_BLOCKLIST = [
  // US banks
  "chase.com","wellsfargo.com","bankofamerica.com","bofa.com","citi.com","citibank.com",
  "usbank.com","capitalone.com","pnc.com","tdbank.com","td.com","truist.com",
  "americanexpress.com","amex.com","discover.com","schwab.com","fidelity.com",
  // UK
  "barclays.co.uk","barclays.com","hsbc.co.uk","hsbc.com","lloydsbank.com","natwest.com",
  "santander.co.uk","monzo.com","starlingbank.com","revolut.com",
  // AU / NZ
  "commbank.com.au","westpac.com.au","nab.com.au","anz.com.au","anz.co.nz","bnz.co.nz",
  "stgeorge.com.au","bankwest.com.au","macquarie.com.au","ing.com.au",
  // EU
  "deutsche-bank.com","db.com","bnpparibas.com","creditmutuel.fr","societegenerale.com",
  "ingbank.com","rabobank.com","abnamro.com",
  // CA
  "rbc.com","rbcroyalbank.com","td.com","scotiabank.com","cibc.com","bmo.com",
  // Aggregators / payment portals where ToS specifically forbid scraping
  "paypal.com","venmo.com","cash.app","zellepay.com","wise.com",
];
function isBankDomain(domain) {
  const d = normDomain(domain);
  return BANK_BLOCKLIST.some(b => d === b || d.endsWith("." + b));
}

// ─── DB schema ───────────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      domain          TEXT NOT NULL,            -- normalized e.g. 'amazon.com'
      label           TEXT,                     -- e.g. 'Amazon Seller (US)'
      username        TEXT,                     -- stored plaintext (so user can see it in UI)
      password_enc    TEXT NOT NULL,            -- AES-256-GCM, format iv.tag.ct
      totp_secret_enc TEXT,                     -- optional TOTP base32 secret
      notes_enc       TEXT,
      status          TEXT DEFAULT 'active',    -- active, paused, broken
      last_used_at    TEXT,
      use_count       INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_uc_user_domain ON user_credentials(user_id, domain, status)`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id   TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      task_id         TEXT,
      action          TEXT NOT NULL,            -- 'unlock', 'view_username', 'rotate', 'delete'
      ip              TEXT,
      at              TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_cred ON credential_audit_log(credential_id, at)`);
}

function maskedPassword() { return "••••••••"; }
function asPublicRow(r) {
  return {
    id: r.id, domain: r.domain, label: r.label || r.domain,
    username: r.username || "",
    has_password: !!r.password_enc,
    has_totp:     !!r.totp_secret_enc,
    has_notes:    !!r.notes_enc,
    status:       r.status || "active",
    last_used_at: r.last_used_at,
    use_count:    r.use_count || 0,
    created_at:   r.created_at,
    updated_at:   r.updated_at,
    password:     maskedPassword(),
  };
}

// ─── 1. LIST ─────────────────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const rows = db.prepare(
      "SELECT * FROM user_credentials WHERE user_id = ? ORDER BY domain ASC"
    ).all(req.userId);
    res.json({ credentials: rows.map(asPublicRow), count: rows.length });
  } catch (e) {
    console.error("[credentials/list]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── 2. ADD ──────────────────────────────────────────────────────────
router.post("/", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const { domain, label, username, password, totp_secret, notes } = req.body || {};
    if (!domain || !password) return res.status(400).json({ error: "domain + password required" });

    const norm = normDomain(domain);
    if (!norm) return res.status(400).json({ error: "Invalid domain" });

    // Refuse bank/financial domains — see BANK_BLOCKLIST comment above
    if (isBankDomain(norm)) {
      return res.status(403).json({
        error: "Banking sites cannot be added to the Browser Agent vault. Bank terms-of-service prohibit credential sharing, and unauthorized transactions carry special legal regimes. Connect your bank via Plaid in the Accounting panel instead.",
        suggested_action: "open_accounting_panel",
        bank_blocked: true,
      });
    }

    const id = crypto.randomBytes(8).toString("hex");

    db.prepare(`
      INSERT INTO user_credentials (id, user_id, domain, label, username, password_enc, totp_secret_enc, notes_enc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, req.userId, norm, label || norm, username || "",
      encrypt(password),
      totp_secret ? encrypt(totp_secret) : null,
      notes ? encrypt(notes) : null
    );

    const row = db.prepare("SELECT * FROM user_credentials WHERE id = ?").get(id);
    res.json({ success: true, credential: asPublicRow(row) });
  } catch (e) {
    console.error("[credentials/add]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── 3. UPDATE metadata (label/notes/status/totp/username) ───────────
router.put("/:id", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const row = db.prepare("SELECT * FROM user_credentials WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: "Credential not found" });

    const { label, username, notes, status, totp_secret } = req.body || {};
    const fields = [];
    const args   = [];
    if (label    !== undefined) { fields.push("label = ?");           args.push(String(label)); }
    if (username !== undefined) { fields.push("username = ?");        args.push(String(username || "")); }
    if (notes    !== undefined) { fields.push("notes_enc = ?");       args.push(notes ? encrypt(notes) : null); }
    if (status   !== undefined) { fields.push("status = ?");          args.push(["active","paused","broken"].includes(status) ? status : "active"); }
    if (totp_secret !== undefined) { fields.push("totp_secret_enc = ?"); args.push(totp_secret ? encrypt(totp_secret) : null); }
    if (!fields.length) return res.json({ success: true, unchanged: true });
    fields.push("updated_at = datetime('now')");

    args.push(req.params.id);
    db.prepare(`UPDATE user_credentials SET ${fields.join(", ")} WHERE id = ?`).run(...args);
    const updated = db.prepare("SELECT * FROM user_credentials WHERE id = ?").get(req.params.id);
    res.json({ success: true, credential: asPublicRow(updated) });
  } catch (e) {
    console.error("[credentials/update]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── 4. ROTATE password ──────────────────────────────────────────────
router.put("/:id/password", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const row = db.prepare("SELECT * FROM user_credentials WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: "Credential not found" });
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: "password required" });
    db.prepare("UPDATE user_credentials SET password_enc = ?, updated_at = datetime('now') WHERE id = ?")
      .run(encrypt(password), req.params.id);
    db.prepare("INSERT INTO credential_audit_log (credential_id, user_id, action, ip) VALUES (?, ?, 'rotate', ?)")
      .run(req.params.id, req.userId, req.ip || "");
    res.json({ success: true });
  } catch (e) {
    console.error("[credentials/rotate]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── 5. DELETE ───────────────────────────────────────────────────────
router.delete("/:id", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const row = db.prepare("SELECT id FROM user_credentials WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: "Credential not found" });
    db.prepare("DELETE FROM user_credentials WHERE id = ?").run(req.params.id);
    db.prepare("INSERT INTO credential_audit_log (credential_id, user_id, action, ip) VALUES (?, ?, 'delete', ?)")
      .run(req.params.id, req.userId, req.ip || "");
    res.json({ success: true });
  } catch (e) {
    console.error("[credentials/delete]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── 6. AUDIT LOG ────────────────────────────────────────────────────
router.get("/audit/:id", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const row = db.prepare("SELECT id FROM user_credentials WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: "Credential not found" });
    const log = db.prepare(
      "SELECT action, task_id, at, ip FROM credential_audit_log WHERE credential_id = ? ORDER BY at DESC LIMIT 100"
    ).all(req.params.id);
    res.json({ log });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 7. ADMIN STATS (admin-only, no decryption) ──────────────────────
router.get("/admin/stats", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const me = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
    if (!me || me.plan !== "admin") return res.status(403).json({ error: "Admin only" });

    const totalCount     = db.prepare("SELECT COUNT(*) AS n FROM user_credentials").get()?.n || 0;
    const activeCount    = db.prepare("SELECT COUNT(*) AS n FROM user_credentials WHERE status='active'").get()?.n || 0;
    const usersWithVault = db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM user_credentials").get()?.n || 0;
    const topDomains     = db.prepare(`
      SELECT domain, COUNT(*) AS users
      FROM user_credentials WHERE status='active'
      GROUP BY domain ORDER BY users DESC LIMIT 20
    `).all();
    const recentUnlocks  = db.prepare(`
      SELECT action, at, COUNT(*) AS n FROM credential_audit_log
      WHERE at > datetime('now', '-7 days') GROUP BY action ORDER BY n DESC
    `).all();
    res.json({ total: totalCount, active: activeCount, users_with_vault: usersWithVault, top_domains: topDomains, recent_actions: recentUnlocks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 8. INTERNAL UNLOCK — browser-agent runner only ──────────────────
// Decrypts a credential for use during an active browser task.
// Authenticated via X-Internal-Auth header matching INTERNAL_API_KEY.
// Caller must pass user_id, domain (or credential_id), and task_id.
router.post("/_unlock", (req, res) => {
  const key = req.headers["x-internal-auth"] || "";
  if (!key || key !== (process.env.INTERNAL_API_KEY || "")) return res.status(403).json({ error: "Forbidden" });
  try {
    const db = req.app.locals.db || require("../db/init").getDb();
    ensureTables(db);
    const { user_id, domain, credential_id, task_id } = req.body || {};
    if (!user_id || !task_id) return res.status(400).json({ error: "user_id + task_id required" });
    if (!domain && !credential_id) return res.status(400).json({ error: "domain or credential_id required" });

    let row;
    if (credential_id) {
      row = db.prepare("SELECT * FROM user_credentials WHERE id = ? AND user_id = ? AND status='active'").get(credential_id, user_id);
    } else {
      const norm = normDomain(domain);
      row = db.prepare("SELECT * FROM user_credentials WHERE user_id = ? AND domain = ? AND status='active' ORDER BY last_used_at DESC LIMIT 1").get(user_id, norm);
    }
    if (!row) return res.status(404).json({ error: "No credential found for that domain" });

    let password, totp;
    try { password = decrypt(row.password_enc); }
    catch (e) { return res.status(500).json({ error: "Decryption failed — vault key may have changed" }); }
    if (row.totp_secret_enc) { try { totp = decrypt(row.totp_secret_enc); } catch (_) {} }

    // Update usage stats + audit log
    db.prepare("UPDATE user_credentials SET last_used_at = datetime('now'), use_count = use_count + 1 WHERE id = ?").run(row.id);
    db.prepare("INSERT INTO credential_audit_log (credential_id, user_id, task_id, action, ip) VALUES (?, ?, ?, 'unlock', ?)")
      .run(row.id, user_id, task_id, req.ip || "");

    res.json({ username: row.username || "", password, totp_secret: totp || null, domain: row.domain, label: row.label });
  } catch (e) {
    console.error("[credentials/_unlock]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
module.exports.encrypt = encrypt;
module.exports.decrypt = decrypt;
module.exports.normDomain = normDomain;
