// ═══════════════════════════════════════════════════════════════════
// MINE — AI BROWSER AGENT CONNECTIONS
//
// Three ways the Browser Agent can access a site:
//
//   1. PUBLIC      — no auth needed (competitor scanning, news, public
//                    product pages). No connection record required.
//
//   2. OAUTH       — agent re-uses a token MINE already holds because
//                    the user connected the service elsewhere
//                    (e.g. Microsoft 365 → Outlook web; social_oauth → IG/X;
//                    accounting_oauth → Xero/QuickBooks). The connections
//                    list pulls from those existing tables automatically.
//
//   3. CREDENTIALS — username/password stored encrypted (AES-256-GCM)
//                    in `browser_agent_credentials`. Used for sites
//                    that have no OAuth: supplier portals, legacy
//                    dashboards, accounting tools, banks (with great
//                    care + 2FA support).
//
// PLUS: session persistence — once the agent logs in, cookies for that
// domain are kept in `browser_agent_sessions` so subsequent runs don't
// re-prompt for 2FA / CAPTCHA every time.
//
// Mounted at /api/browser-agent/connections
// ═══════════════════════════════════════════════════════════════════
const express = require("express");
const router  = express.Router();
const crypto  = require("crypto");
const { auth: requireAuth } = require("../middleware/auth");

function getDb(req) {
  return req.app.locals.db || require("../db/init").getDb();
}

// ─── DB schema ───────────────────────────────────────────────────────
function ensureTables(db) {
  // Encrypted username/password vault for non-OAuth sites.
  // `password_ciphertext`, `iv`, and `auth_tag` together implement
  // AES-256-GCM. The encryption key is derived from an env secret +
  // the user_id, so passwords are pinned to one user even if the DB leaks.
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_agent_credentials (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      label               TEXT NOT NULL,           -- e.g. 'Acme Supplier Portal'
      site_url            TEXT NOT NULL,           -- e.g. 'https://portal.acme.com'
      username            TEXT NOT NULL,
      password_ciphertext TEXT NOT NULL,
      iv                  TEXT NOT NULL,
      auth_tag            TEXT NOT NULL,
      notes               TEXT,                    -- e.g. "Click 'Reports' tab after login"
      requires_2fa        INTEGER DEFAULT 0,
      last_used_at        TEXT,
      created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bac_user ON browser_agent_credentials(user_id)`);

  // Per-domain session jar. Cookies preserved between agent runs so the
  // agent doesn't re-login every time (avoids triggering 2FA prompts +
  // anti-bot detection).
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_agent_sessions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      domain          TEXT NOT NULL,                -- e.g. 'portal.acme.com'
      cookies_json    TEXT NOT NULL,                -- serialised cookie jar
      local_storage   TEXT,                         -- optional localStorage snapshot
      last_used_at    TEXT,
      expires_at      TEXT,
      created_at      TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bas_user_domain ON browser_agent_sessions(user_id, domain)`);
}

// ─── Encryption helpers ──────────────────────────────────────────────
function getEncryptionKey(userId) {
  const secret = process.env.CREDENTIAL_VAULT_SECRET || process.env.JWT_SECRET || "";
  if (!secret || secret.length < 16) {
    throw new Error("CREDENTIAL_VAULT_SECRET not configured (set env var to enable credential storage)");
  }
  // Pin the key to the user so cross-user leakage is structurally impossible
  return crypto.createHash("sha256").update(secret + ":" + userId).digest();
}

function encrypt(plaintext, userId) {
  const key = getEncryptionKey(userId);
  const iv  = crypto.randomBytes(12);                 // GCM standard
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return { ciphertext: enc.toString("base64"), iv: iv.toString("base64"), authTag: tag.toString("base64") };
}

function decrypt(ciphertextB64, ivB64, authTagB64, userId) {
  const key = getEncryptionKey(userId);
  const iv  = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(authTagB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
}

// ─── 1. GET /list — list all sites this user has connected ──────────
// Returns both credential-based connections AND OAuth-based ones
// (pulled from existing MINE OAuth tables) so the user sees one
// unified "what can my agent access" picture.
router.get("/list", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);

    // 1. Credential-based (vault)
    const creds = db.prepare(`
      SELECT id, label, site_url, username, requires_2fa, last_used_at, created_at
      FROM browser_agent_credentials WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.userId);

    // 2. OAuth-based — discover from existing connection tables.
    //    Each returns a uniform shape: { provider, account, scopes }.
    const oauth = [];
    function safeQuery(label, sql, ...args) {
      try { return db.prepare(sql).all(...args).map(r => ({ ...r, provider_label: label })); }
      catch (_) { return []; }
    }

    // Microsoft 365 (Outlook + OneDrive + Office)
    safeQuery("Microsoft 365",
      "SELECT email AS account, display_name FROM microsoft_connections WHERE user_id = ?",
      req.userId
    ).forEach(r => oauth.push({
      provider:        "microsoft",
      provider_label:  "Microsoft 365 (Outlook, Word, Excel, PowerPoint, OneDrive)",
      account:         r.account || r.display_name || "",
      via:             "oauth",
    }));

    // Social platforms (FB, IG, X, TikTok, LinkedIn, YouTube, etc.)
    safeQuery("Social",
      "SELECT platform, profile_name, profile_id FROM social_connections WHERE user_id = ? AND platform != 'microsoft'",
      req.userId
    ).forEach(r => oauth.push({
      provider:        r.platform,
      provider_label:  r.platform.charAt(0).toUpperCase() + r.platform.slice(1),
      account:         r.profile_name || r.profile_id || "",
      via:             "oauth",
    }));

    // Accounting (Xero / QuickBooks)
    safeQuery("Accounting",
      "SELECT provider, tenant_name FROM accounting_connections WHERE user_id = ?",
      req.userId
    ).forEach(r => oauth.push({
      provider:        r.provider,
      provider_label:  r.provider === "xero" ? "Xero" : r.provider === "quickbooks" ? "QuickBooks" : r.provider,
      account:         r.tenant_name || "",
      via:             "oauth",
    }));

    res.json({
      credentials: creds.map(c => ({ ...c, has_password: true })),  // never echo passwords
      oauth_connections: oauth,
      total: creds.length + oauth.length,
    });
  } catch (e) {
    console.error("[browser-agent-connections/list]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 2. POST /credentials — add a credential entry ──────────────────
// Body: { label, site_url, username, password, notes?, requires_2fa? }
router.post("/credentials", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const { label, site_url, username, password, notes, requires_2fa } = req.body || {};
    if (!label || !site_url || !username || !password) {
      return res.status(400).json({ error: "label, site_url, username, and password are required" });
    }
    if (!/^https?:\/\//.test(site_url)) {
      return res.status(400).json({ error: "site_url must start with http:// or https://" });
    }

    const { ciphertext, iv, authTag } = encrypt(String(password), req.userId);
    const id = crypto.randomBytes(8).toString("hex");
    db.prepare(`
      INSERT INTO browser_agent_credentials
      (id, user_id, label, site_url, username, password_ciphertext, iv, auth_tag, notes, requires_2fa)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.userId, label, site_url, username, ciphertext, iv, authTag, notes || null, requires_2fa ? 1 : 0);

    res.json({ success: true, id, label, site_url, username });
  } catch (e) {
    console.error("[browser-agent-connections/add]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 3. PUT /credentials/:id — update a credential ──────────────────
router.put("/credentials/:id", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const existing = db.prepare(
      "SELECT id FROM browser_agent_credentials WHERE id = ? AND user_id = ?"
    ).get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: "Not found" });

    const { label, site_url, username, password, notes, requires_2fa } = req.body || {};
    const updates = [];
    const args    = [];
    if (label != null)        { updates.push("label = ?");        args.push(label); }
    if (site_url != null)     { updates.push("site_url = ?");     args.push(site_url); }
    if (username != null)     { updates.push("username = ?");     args.push(username); }
    if (notes != null)        { updates.push("notes = ?");        args.push(notes); }
    if (requires_2fa != null) { updates.push("requires_2fa = ?"); args.push(requires_2fa ? 1 : 0); }
    if (password) {
      const enc = encrypt(String(password), req.userId);
      updates.push("password_ciphertext = ?", "iv = ?", "auth_tag = ?");
      args.push(enc.ciphertext, enc.iv, enc.authTag);
    }
    if (!updates.length) return res.status(400).json({ error: "No fields to update" });

    updates.push("updated_at = datetime('now')");
    args.push(req.params.id, req.userId);
    db.prepare(`UPDATE browser_agent_credentials SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...args);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 4. DELETE /credentials/:id ──────────────────────────────────────
router.delete("/credentials/:id", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    db.prepare("DELETE FROM browser_agent_credentials WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    // Also drop any persisted session for this site's domain so the
    // next run forces a fresh login (no stale cookies linked to old creds)
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 5. GET /credentials/:id/reveal — internal use by runner only ────
//
// SECURITY: only the browser-runner microservice should ever hit this
// endpoint. It exchanges the internal API key for the decrypted
// password, which the runner uses ONCE to log in, then immediately
// discards. Never call this from frontend code.
router.get("/credentials/:id/reveal", (req, res) => {
  const internalKey = req.headers["x-internal-auth"] || "";
  if (!internalKey || internalKey !== (process.env.INTERNAL_API_KEY || "")) {
    return res.status(403).json({ error: "Forbidden — internal use only" });
  }
  try {
    const db = req.app.locals.db || require("../db/init").getDb(); ensureTables(db);
    const row = db.prepare("SELECT * FROM browser_agent_credentials WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const password = decrypt(row.password_ciphertext, row.iv, row.auth_tag, row.user_id);
    db.prepare("UPDATE browser_agent_credentials SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    res.json({
      id:       row.id,
      label:    row.label,
      site_url: row.site_url,
      username: row.username,
      password,
      notes:    row.notes,
      requires_2fa: !!row.requires_2fa,
    });
  } catch (e) {
    console.error("[browser-agent-connections/reveal]", e.message);
    res.status(500).json({ error: "Decryption failed — verify CREDENTIAL_VAULT_SECRET hasn't changed" });
  }
});

// ─── 6. POST /sessions — runner saves a cookie jar after login ───────
// Internal endpoint. After the runner successfully logs into a site,
// it posts the cookie jar here. Next time a task targets the same
// domain, the runner fetches these cookies and skips the login.
router.post("/sessions", (req, res) => {
  const internalKey = req.headers["x-internal-auth"] || "";
  if (internalKey !== (process.env.INTERNAL_API_KEY || "")) return res.status(403).json({ error: "Forbidden" });
  try {
    const db = req.app.locals.db || require("../db/init").getDb(); ensureTables(db);
    const { user_id, domain, cookies_json, local_storage, expires_at } = req.body || {};
    if (!user_id || !domain || !cookies_json) return res.status(400).json({ error: "user_id, domain, cookies_json required" });

    // UPSERT (uses the unique index on (user_id, domain))
    db.prepare(`
      INSERT INTO browser_agent_sessions (id, user_id, domain, cookies_json, local_storage, expires_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, domain) DO UPDATE SET
        cookies_json = excluded.cookies_json,
        local_storage = excluded.local_storage,
        expires_at   = excluded.expires_at,
        last_used_at = datetime('now')
    `).run(crypto.randomBytes(8).toString("hex"), user_id, domain, cookies_json, local_storage || null, expires_at || null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 7. GET /sessions/:userId/:domain — runner fetches saved session ─
router.get("/sessions/:userId/:domain", (req, res) => {
  const internalKey = req.headers["x-internal-auth"] || "";
  if (internalKey !== (process.env.INTERNAL_API_KEY || "")) return res.status(403).json({ error: "Forbidden" });
  try {
    const db = req.app.locals.db || require("../db/init").getDb(); ensureTables(db);
    const row = db.prepare(
      "SELECT * FROM browser_agent_sessions WHERE user_id = ? AND domain = ?"
    ).get(req.params.userId, req.params.domain);
    if (!row) return res.status(404).json({ error: "No session" });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 8. DELETE /sessions — user clears all saved sessions (logout) ───
router.delete("/sessions", requireAuth, (req, res) => {
  try {
    const db = getDb(req); ensureTables(db);
    const r = db.prepare("DELETE FROM browser_agent_sessions WHERE user_id = ?").run(req.userId);
    res.json({ success: true, removed: r.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
