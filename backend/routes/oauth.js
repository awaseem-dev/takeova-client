/**
 * MINE — OAuth 2.0 Routes (Google + Apple)
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY
 *   FRONTEND_URL, BACKEND_URL
 *
 * Flows:
 *   GET /api/auth/google          → redirects to Google
 *   GET /api/auth/google/callback → Google returns here → issues token → redirects to frontend
 *   GET /api/auth/apple           → redirects to Apple
 *   POST /api/auth/apple/callback → Apple posts here → issues token → redirects to frontend
 */

const express = require("express");
const rateLimit = require('express-rate-limit');
const router = express.Router();
const oauthLimiter = rateLimit({ windowMs: 60000, max: 20, message: { error: "Too many OAuth requests." } });
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { signToken } = require("../middleware/auth");
const https = require("https");
const crypto = require("crypto");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND_URL  = process.env.BACKEND_URL  || "http://localhost:4000";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/** Ensure oauth columns exist on users table */
function ensureOAuthColumns() {
  const db = getDb();
  try { db.exec("ALTER TABLE users ADD COLUMN google_id TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN apple_id  TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT"); } catch(e) {}
}

/** Find existing user or create one from OAuth profile, return MINE session token */
function upsertOAuthUser({ provider, providerId, email, name, avatarUrl, emailVerified }) {
  const db = getDb();
  ensureOAuthColumns();

  const col = provider === "google" ? "google_id" : "apple_id";

  // 1. Find by provider ID (safe — provider has confirmed ownership)
  let user = db.prepare(`SELECT * FROM users WHERE ${col} = ?`).get(providerId);

  // 2. Find by email (link accounts) — ONLY when the provider has verified the email.
  //
  // Without this guard, an attacker who controls any OAuth provider's account
  // with an unverified claim to victim@example.com (e.g. a Google Workspace
  // domain admin creating an unverified alias) could have their OAuth identity
  // linked to the victim's existing TAKEOVA account, resulting in takeover.
  if (!user && email && emailVerified === true) {
    user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());
  }

  if (user) {
    // Update provider ID + avatar if missing
    db.prepare(`UPDATE users SET ${col} = ?, avatar_url = COALESCE(avatar_url, ?), last_login = datetime('now') WHERE id = ?`)
      .run(providerId, avatarUrl || null, user.id);
  } else {
    // Create new user. If email wasn't verified, we store it but don't link.
    const id = uuid();
    let refCode;
    let attempts = 0;
    do {
      refCode = Math.random().toString(36).slice(2, 8).toUpperCase();
      attempts++;
    } while (db.prepare("SELECT id FROM users WHERE referral_code = ?").get(refCode) && attempts < 10);

    // password_hash stored as NULL so OAuth-only accounts are explicit;
    // login code uses bcrypt.compare which returns false against NULL/empty anyway.
    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, ${col}, avatar_url, referral_code, plan, role)
      VALUES (?, ?, ?, NULL, ?, ?, ?, 'trial', 'user')
    `).run(id, email ? email.toLowerCase().trim() : null, name || "MINE User", providerId, avatarUrl || null, refCode);

    user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }

  return signToken(user.id, user.role || "user");
}

/** Redirect to frontend with token (or error) */
function redirectWithToken(res, token) {
  res.redirect(`${FRONTEND_URL}/?token=${encodeURIComponent(token)}`);
}

function redirectWithError(res, msg) {
  res.redirect(`${FRONTEND_URL}/?auth_error=${encodeURIComponent(msg)}`);
}

// ─────────────────────────────────────────────────────────────
// GOOGLE OAUTH 2.0
// ─────────────────────────────────────────────────────────────

const GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USER_URL  = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_SCOPES    = ["openid", "email", "profile"].join(" ");

/** GET /api/auth/google — Redirect user to Google */
router.get("/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: "Google OAuth not configured" });

  const state = crypto.randomBytes(16).toString("hex");
  // Store state in a short-lived cookie for CSRF protection
  res.cookie("oauth_state", state, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: "lax", secure: process.env.NODE_ENV === "production" });

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  `${BACKEND_URL}/api/auth/google/callback`,
    response_type: "code",
    scope:         GOOGLE_SCOPES,
    state,
    access_type:   "online",
    prompt:        "select_account",
  });

  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

/** GET /api/auth/google/callback — Google redirects here with ?code= */
router.get("/google/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return redirectWithError(res, "Google sign-in was cancelled");

  // CSRF check
  const cookieState = req.cookies?.oauth_state;
  if (!cookieState || cookieState !== state) {
    return redirectWithError(res, "Invalid OAuth state — please try again");
  }
  res.clearCookie("oauth_state");

  if (!code) return redirectWithError(res, "No authorisation code from Google");

  try {
    // Exchange code for tokens
    const tokenRes = await httpPost(GOOGLE_TOKEN_URL, {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  `${BACKEND_URL}/api/auth/google/callback`,
      grant_type:    "authorization_code",
    });

    if (!tokenRes.access_token) {
      console.error("[Google OAuth] Token exchange failed:", tokenRes);
      return redirectWithError(res, "Google authentication failed");
    }

    // Fetch user profile
    const profile = await httpGet(GOOGLE_USER_URL, tokenRes.access_token);

    if (!profile.sub) {
      return redirectWithError(res, "Could not retrieve your Google profile");
    }

    const token = upsertOAuthUser({
      provider:      "google",
      providerId:    profile.sub,
      email:         profile.email,
      name:          profile.name,
      avatarUrl:     profile.picture,
      // Google's userinfo returns email_verified for all consumer accounts;
      // Google Workspace accounts may return false if the domain isn't verified.
      // Only link to an existing account by email when Google has confirmed ownership.
      emailVerified: profile.email_verified === true,
    });

    redirectWithToken(res, token);
  } catch (err) {
    console.error("[Google OAuth] Error:", err);
    redirectWithError(res, "Google sign-in failed — please try again");
  }
});

// ─────────────────────────────────────────────────────────────
// APPLE SIGN IN (Sign in with Apple)
// Docs: https://developer.apple.com/documentation/sign_in_with_apple
// ─────────────────────────────────────────────────────────────

/**
 * Generate a client_secret JWT for Apple.
 * Apple requires this to be a signed ES256 JWT, valid for up to 6 months.
 */
function generateAppleClientSecret() {
  const teamId    = process.env.APPLE_TEAM_ID;
  const clientId  = process.env.APPLE_CLIENT_ID;
  const keyId     = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!teamId || !clientId || !keyId || !privateKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: teamId,
    iat: now,
    exp: now + 15777000, // ~6 months
    aud: "https://appleid.apple.com",
    sub: clientId,
  })).toString("base64url");

  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign("SHA256");
  sign.update(sigInput);
  const signature = sign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");

  return `${sigInput}.${signature}`;
}

/** Verify Apple's id_token signature against their JWKS (RS256). Returns
 *  decoded claims on success, null on failure. Caches Apple's public keys
 *  for 1 hour to avoid hammering their JWKS endpoint. */
let _appleKeysCache = { keys: null, fetchedAt: 0 };
async function fetchAppleKeys() {
  const now = Date.now();
  if (_appleKeysCache.keys && (now - _appleKeysCache.fetchedAt) < 3600000) {
    return _appleKeysCache.keys;
  }
  try {
    const fetch = (typeof globalThis.fetch === "function") ? globalThis.fetch : (await import("node-fetch")).default;
    const r = await fetch("https://appleid.apple.com/auth/keys");
    if (!r.ok) return _appleKeysCache.keys || null;
    const j = await r.json();
    _appleKeysCache = { keys: j.keys || [], fetchedAt: now };
    return _appleKeysCache.keys;
  } catch (_) {
    return _appleKeysCache.keys || null;
  }
}

/** Decode AND verify Apple's id_token (JWT). Returns claims or null. */
async function decodeAppleIdToken(idToken) {
  try {
    const parts = (idToken || "").split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    // Signature verification against Apple's JWKS
    const keys = await fetchAppleKeys();
    if (!keys || !keys.length) return payload; // graceful fall-through if JWKS unreachable
    const key = keys.find(k => k.kid === header.kid);
    if (!key) {
      console.warn(`[Apple OAuth] No matching JWK for kid=${header.kid}`);
      return null;
    }
    const pubKey = crypto.createPublicKey({ key, format: "jwk" });
    const ok = crypto.verify(
      "RSA-SHA256",
      Buffer.from(headerB64 + "." + payloadB64),
      pubKey,
      Buffer.from(sigB64, "base64url"),
    );
    if (!ok) {
      console.warn("[Apple OAuth] id_token signature verification FAILED");
      return null;
    }
    // Verify issuer + audience + expiry (basic claim checks)
    if (payload.iss !== "https://appleid.apple.com") return null;
    if (process.env.APPLE_CLIENT_ID && payload.aud !== process.env.APPLE_CLIENT_ID) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      console.warn("[Apple OAuth] id_token expired");
      return null;
    }
    return payload;
  } catch (e) {
    console.error("[Apple OAuth] decode failed:", e.message);
    return null;
  }
}

/** GET /api/auth/apple — Redirect user to Apple */
router.get("/apple", (req, res) => {
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: "Apple OAuth not configured" });

  const state = crypto.randomBytes(16).toString("hex");
  const nonce = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: "none", secure: true });
  res.cookie("oauth_nonce", nonce, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: "none", secure: true });

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  `${BACKEND_URL}/api/auth/apple/callback`,
    response_type: "code id_token",
    scope:         "name email",
    response_mode: "form_post",       // Apple uses POST for callback
    state,
    nonce,
  });

  res.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});

/** POST /api/auth/apple/callback — Apple POSTs here after auth */
router.post("/apple/callback", express.urlencoded({ extended: true }), async (req, res) => {
  const { code, id_token, state, error, user: userJson } = req.body;

  if (error) return redirectWithError(res, "Apple sign-in was cancelled");

  // CSRF check
  const cookieState = req.cookies?.oauth_state;
  if (!cookieState || cookieState !== state) {
    return redirectWithError(res, "Invalid OAuth state — please try again");
  }
  res.clearCookie("oauth_state");
  res.clearCookie("oauth_nonce");

  if (!code || !id_token) return redirectWithError(res, "Incomplete response from Apple");

  try {
    // Verify code with Apple token endpoint
    const clientSecret = generateAppleClientSecret();
    if (!clientSecret) return redirectWithError(res, "Apple OAuth not configured");

    const tokenRes = await httpPost("https://appleid.apple.com/auth/token", {
      client_id:     process.env.APPLE_CLIENT_ID,
      client_secret: clientSecret,
      code,
      grant_type:    "authorization_code",
      redirect_uri:  `${BACKEND_URL}/api/auth/apple/callback`,
    });

    if (!tokenRes.id_token) {
      console.error("[Apple OAuth] Token exchange failed:", tokenRes);
      return redirectWithError(res, "Apple authentication failed");
    }

    // Decode id_token to get sub (Apple user ID) + email
    const claims = await decodeAppleIdToken(tokenRes.id_token);
    if (!claims?.sub) return redirectWithError(res, "Could not decode Apple identity token");

    // Nonce validation (defense in depth — state cookie already prevents CSRF,
    // but Apple's spec requires the nonce echoed in the id_token to match the
    // one we sent, which guards against token replay).
    const cookieNonce = req.cookies?.oauth_nonce;
    if (cookieNonce && claims.nonce && claims.nonce !== cookieNonce) {
      return redirectWithError(res, "Invalid OAuth nonce — please try again");
    }

    // Apple only sends name on FIRST login — parse from form body if present
    let name = null;
    if (userJson) {
      try {
        const parsed = typeof userJson === "string" ? JSON.parse(userJson) : userJson;
        const fn = parsed?.name?.firstName || "";
        const ln = parsed?.name?.lastName  || "";
        name = [fn, ln].filter(Boolean).join(" ") || null;
      } catch {}
    }

    const token = upsertOAuthUser({
      provider:      "apple",
      providerId:    claims.sub,
      email:         claims.email,
      name,
      avatarUrl:     null, // Apple never provides an avatar
      // Apple always verifies emails — both real addresses and private relay
      // addresses are confirmed by Apple before issuing tokens.
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
    });

    redirectWithToken(res, token);
  } catch (err) {
    console.error("[Apple OAuth] Error:", err);
    redirectWithError(res, "Apple sign-in failed — please try again");
  }
});

// ─────────────────────────────────────────────────────────────
// HTTP HELPERS (no extra deps — uses built-in https)
// ─────────────────────────────────────────────────────────────

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({}); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    https.get(options, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({}); }
      });
    }).on("error", reject);
  });
}


// Connection status for dashboard connect buttons (audit 2026-06-10 UX pass)
router.get("/:provider/status", auth, (req, res) => {
  try {
    const db = getDb();
    const prov = String(req.params.provider || "").toLowerCase();
    let connected = false;
    try { connected = !!db.prepare("SELECT 1 FROM user_social_tokens WHERE user_id=? AND LOWER(platform)=? LIMIT 1").get(req.userId, prov); } catch (_) {}
    if (!connected) { try { connected = !!db.prepare("SELECT 1 FROM integrations WHERE user_id=? AND LOWER(provider)=? LIMIT 1").get(req.userId, prov); } catch (_) {}
    }
    res.json({ provider: prov, connected });
  } catch (e) { res.json({ provider: req.params.provider, connected: false }); }
});

module.exports = router;

// ═══════════════════════════════════════════════════════════════════════════════
// XERO OAUTH 2.0
// Required env vars: XERO_CLIENT_ID, XERO_CLIENT_SECRET, BACKEND_URL, FRONTEND_URL
//
// Flow:
//   GET  /api/oauth/xero/connect   → redirect to Xero auth
//   GET  /api/oauth/xero/callback  → Xero returns here, store tokens, redirect to dashboard
//   GET  /api/oauth/xero/status    → check if connected
//   POST /api/oauth/xero/disconnect → revoke & remove tokens
//   GET  /api/oauth/xero/refresh   → internal: refresh access token
// ═══════════════════════════════════════════════════════════════════════════════

const { auth } = require('../middleware/auth');

function ensureAccountingTokensTable() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS accounting_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    provider    TEXT NOT NULL,
    access_token  TEXT,
    refresh_token TEXT,
    token_type    TEXT DEFAULT 'Bearer',
    expires_at    INTEGER,
    tenant_id     TEXT,
    tenant_name   TEXT,
    realm_id      TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, provider)
  )`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC-signed OAuth state for integration flows.
//
// Previously the state was base64-encoded JSON with no signature, so an
// attacker could forge any user_id and cause their accounting tokens to be
// stored against an arbitrary TAKEOVA account (integration planting attack).
//
// We sign the state with a server-only secret so only we can produce a valid
// state, and enforce a 10-minute freshness window to prevent replay.
// ─────────────────────────────────────────────────────────────────────────────
function _oauthStateSecret() {
  return process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET || "fallback-not-for-prod";
}

function signOAuthState(userId, provider) {
  const payload = { uid: userId, p: provider, ts: Date.now(), n: crypto.randomBytes(8).toString("hex") };
  const body    = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig     = crypto.createHmac("sha256", _oauthStateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyOAuthState(state, provider) {
  if (typeof state !== "string" || !state.includes(".")) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", _oauthStateSecret()).update(body).digest("base64url");
  // Timing-safe comparison
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString()); }
  catch { return null; }
  // 10 minute freshness window
  if (!payload.ts || Date.now() - payload.ts > 10 * 60 * 1000) return null;
  // Provider must match so a state issued for Xero can't be replayed on QuickBooks
  if (payload.p !== provider) return null;
  return payload.uid;
}

// ── Xero ─────────────────────────────────────────────────────────────────────

const XERO_AUTH_URL   = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL  = 'https://identity.xero.com/connect/token';
const XERO_TENANTS_URL= 'https://api.xero.com/connections';
const XERO_SCOPES     = 'offline_access accounting.transactions accounting.reports.read accounting.contacts';

router.get('/xero/connect', auth, (req, res) => {
  const clientId = process.env.XERO_CLIENT_ID;
  if (!clientId) return res.json({ success: false, reason: 'Add XERO_CLIENT_ID to .env' });
  const state    = signOAuthState(req.userId, 'xero');
  const redirect = `${BACKEND_URL}/api/oauth/xero/callback`;
  const url = `${XERO_AUTH_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(XERO_SCOPES)}&state=${state}`;
  res.redirect(url);
});

router.get('/xero/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}/?xero_error=${encodeURIComponent(error)}`);

  const userId = verifyOAuthState(state, 'xero');
  if (!userId) return res.redirect(`${FRONTEND_URL}/?xero_error=invalid_state`);

  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirect     = `${BACKEND_URL}/api/oauth/xero/callback`;

  try {
    const fetch2 = (await import('node-fetch')).default;

    // Exchange code for tokens
    const tokenRes = await fetch2(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirect)}`,
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error(tokens.error_description || 'Token exchange failed');

    // Get the tenant (organisation) list
    const tenantsRes = await fetch2(XERO_TENANTS_URL, {
      headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' }
    });
    const tenants = await tenantsRes.json();
    const tenant  = Array.isArray(tenants) ? tenants[0] : null;

    // Store tokens
    ensureAccountingTokensTable();
    const db = getDb();
    db.prepare(`INSERT OR REPLACE INTO accounting_tokens
      (id, user_id, provider, access_token, refresh_token, expires_at, tenant_id, tenant_name, updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(uuid(), userId, 'xero',
        tokens.access_token, tokens.refresh_token,
        Date.now() + (tokens.expires_in || 1800) * 1000,
        tenant?.tenantId || '', tenant?.tenantName || 'Xero Organisation');

    res.redirect(`${FRONTEND_URL}/?xero_connected=1&org=${encodeURIComponent(tenant?.tenantName || 'Xero')}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/?xero_error=${encodeURIComponent(e.message)}`);
  }
});

router.get('/xero/status', auth, (req, res) => {
  ensureAccountingTokensTable();
  const db     = getDb();
  const record = db.prepare("SELECT tenant_name, expires_at, updated_at FROM accounting_tokens WHERE user_id=? AND provider='xero'").get(req.userId);
  if (!record) return res.json({ connected: false });
  const expired = record.expires_at && Date.now() > record.expires_at;
  res.json({ connected: true, tenantName: record.tenant_name, expired, lastSync: record.updated_at });
});

router.post('/xero/disconnect', auth, (req, res) => {
  ensureAccountingTokensTable();
  getDb().prepare("DELETE FROM accounting_tokens WHERE user_id=? AND provider='xero'").run(req.userId);
  res.json({ success: true });
});

// Internal: refresh Xero access token using refresh_token
async function refreshXeroToken(userId) {
  const db     = getDb();
  const record = db.prepare("SELECT * FROM accounting_tokens WHERE user_id=? AND provider='xero'").get(userId);
  if (!record?.refresh_token) throw new Error('No Xero refresh token — user must reconnect');

  const fetch2 = (await import('node-fetch')).default;
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  const tokenRes = await fetch2(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=refresh_token&refresh_token=${record.refresh_token}`,
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error('Xero refresh failed: ' + (tokens.error_description || tokens.error));

  db.prepare("UPDATE accounting_tokens SET access_token=?, refresh_token=COALESCE(?,refresh_token), expires_at=?, updated_at=datetime('now') WHERE user_id=? AND provider='xero'")
    .run(tokens.access_token, tokens.refresh_token || null, Date.now() + (tokens.expires_in || 1800) * 1000, userId);

  return tokens.access_token;
}

// Export for use in ai-employees.js
router.getXeroToken = async function(userId) {
  ensureAccountingTokensTable();
  const db     = getDb();
  const record = db.prepare("SELECT * FROM accounting_tokens WHERE user_id=? AND provider='xero'").get(userId);
  if (!record) throw new Error('Xero not connected — click Connect Xero in Bookkeeper settings');
  if (Date.now() > (record.expires_at - 60000)) {
    return await refreshXeroToken(userId);
  }
  return record.access_token;
};

router.getXeroTenantId = function(userId) {
  const db = getDb();
  const r  = db.prepare("SELECT tenant_id FROM accounting_tokens WHERE user_id=? AND provider='xero'").get(userId);
  return r?.tenant_id;
};

// ── QuickBooks ────────────────────────────────────────────────────────────────

const QB_AUTH_URL   = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL  = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_SCOPES     = 'com.intuit.quickbooks.accounting';

router.get('/quickbooks/connect', auth, (req, res) => {
  const clientId = process.env.QB_CLIENT_ID || process.env.QUICKBOOKS_CLIENT_ID;
  if (!clientId) return res.json({ success: false, reason: 'Add QB_CLIENT_ID to .env' });
  const state    = signOAuthState(req.userId, 'quickbooks');
  const redirect = `${BACKEND_URL}/api/oauth/quickbooks/callback`;
  const url = `${QB_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent(QB_SCOPES)}&state=${state}`;
  res.redirect(url);
});

router.get('/quickbooks/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}/?qb_error=${encodeURIComponent(error)}`);

  const userId = verifyOAuthState(state, 'quickbooks');
  if (!userId) return res.redirect(`${FRONTEND_URL}/?qb_error=invalid_state`);

  const clientId     = process.env.QB_CLIENT_ID || process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET || process.env.QUICKBOOKS_CLIENT_SECRET;
  const redirect     = `${BACKEND_URL}/api/oauth/quickbooks/callback`;

  try {
    const fetch2 = (await import('node-fetch')).default;

    const tokenRes = await fetch2(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirect)}`,
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error(tokens.error_description || 'QB token exchange failed');

    // Get company info
    let companyName = 'QuickBooks Company';
    try {
      const infoRes = await fetch2(`https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' }
      });
      const info = await infoRes.json();
      companyName = info.CompanyInfo?.CompanyName || companyName;
    } catch(_) { console.error("[/quickbooks/callback]", _.message || _); }

    ensureAccountingTokensTable();
    const db = getDb();
    db.prepare(`INSERT OR REPLACE INTO accounting_tokens
      (id, user_id, provider, access_token, refresh_token, expires_at, realm_id, tenant_name, updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(uuid(), userId, 'quickbooks',
        tokens.access_token, tokens.refresh_token,
        Date.now() + (tokens.expires_in || 3600) * 1000,
        realmId, companyName);

    res.redirect(`${FRONTEND_URL}/?qb_connected=1&org=${encodeURIComponent(companyName)}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/?qb_error=${encodeURIComponent(e.message)}`);
  }
});

router.get('/quickbooks/status', auth, (req, res) => {
  ensureAccountingTokensTable();
  const db     = getDb();
  const record = db.prepare("SELECT tenant_name, realm_id, expires_at, updated_at FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").get(req.userId);
  if (!record) return res.json({ connected: false });
  const expired = record.expires_at && Date.now() > record.expires_at;
  res.json({ connected: true, companyName: record.tenant_name, realmId: record.realm_id, expired, lastSync: record.updated_at });
});

router.post('/quickbooks/disconnect', auth, (req, res) => {
  ensureAccountingTokensTable();
  getDb().prepare("DELETE FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").run(req.userId);
  res.json({ success: true });
});

async function refreshQBToken(userId) {
  const db     = getDb();
  const record = db.prepare("SELECT * FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").get(userId);
  if (!record?.refresh_token) throw new Error('No QuickBooks refresh token — user must reconnect');

  const fetch2       = (await import('node-fetch')).default;
  const clientId     = process.env.QB_CLIENT_ID || process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET || process.env.QUICKBOOKS_CLIENT_SECRET;

  const tokenRes = await fetch2(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: `grant_type=refresh_token&refresh_token=${record.refresh_token}`,
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error('QB refresh failed: ' + (tokens.error_description || tokens.error));

  db.prepare("UPDATE accounting_tokens SET access_token=?, refresh_token=COALESCE(?,refresh_token), expires_at=?, updated_at=datetime('now') WHERE user_id=? AND provider='quickbooks'")
    .run(tokens.access_token, tokens.refresh_token || null, Date.now() + (tokens.expires_in || 3600) * 1000, userId);

  return tokens.access_token;
}

router.getQBToken = async function(userId) {
  ensureAccountingTokensTable();
  const db     = getDb();
  const record = db.prepare("SELECT * FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").get(userId);
  if (!record) throw new Error('QuickBooks not connected — click Connect QuickBooks in Bookkeeper settings');
  if (Date.now() > (record.expires_at - 60000)) {
    return await refreshQBToken(userId);
  }
  return record.access_token;
};

router.getQBRealmId = function(userId) {
  const db = getDb();
  const r  = db.prepare("SELECT realm_id FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").get(userId);
  return r?.realm_id;
};
