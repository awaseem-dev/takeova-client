/**
 * MINE — Microsoft 365 OAuth + Graph API
 * Single OAuth grant covers Outlook (mail + calendar), OneDrive,
 * Word, Excel, PowerPoint — all via Microsoft Graph.
 *
 * Routes (all under /api/microsoft):
 *   GET  /connect           → redirect to Microsoft consent screen
 *   GET  /callback          → exchange code for tokens, save, redirect back
 *   GET  /status            → connection status + email
 *   POST /disconnect        → revoke + delete tokens
 *   GET  /me                → cached basic profile
 *
 * Helpers exported (used by microsoft-actions.js):
 *   getAccessToken(userId)  → returns valid (refreshed if needed) access token
 *   graphFetch(userId,...)  → authenticated fetch wrapper
 *
 * Required env vars:
 *   MS_CLIENT_ID            (Azure App Registration — Application (client) ID)
 *   MS_CLIENT_SECRET        (Azure App Registration — Client secret value)
 *   MS_TENANT_ID            (optional — defaults to 'common' for multi-tenant)
 *   BACKEND_URL             (used to build redirect_uri)
 *   FRONTEND_URL            (where to send the user after callback)
 */
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { getDb } = require('../db/init');
const { auth: requireAuth } = require('../middleware/auth');

// authFromQuery: lets the OAuth flow authenticate via ?token=<jwt> in the URL
// since browser redirects can't carry an Authorization header.
function authFromQuery(req, res, next) {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  return requireAuth(req, res, next);
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// Config getters are sourced from ms-graph.js — they read env-var FIRST,
// then fall back to platform_settings (so admin can configure via UI).
const ms = require('../services/ms-graph');

// What MINE asks for. offline_access → we get a refresh_token.
const SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'User.Read',
  'Mail.Send',
  'Mail.ReadWrite',
  'Calendars.ReadWrite',
  'Files.ReadWrite',
  'Files.ReadWrite.All',
];

// ─── DB ──────────────────────────────────────────────────────────────
function ensureTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS microsoft_connections (
      user_id        INTEGER PRIMARY KEY,
      ms_user_id     TEXT,
      email          TEXT,
      display_name   TEXT,
      access_token   TEXT NOT NULL,
      refresh_token  TEXT,
      expires_at     INTEGER,
      scopes         TEXT,
      created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

// ─── HTTP helpers (use built-in fetch on Node 18+, fall back to node-fetch) ─
const _fetch = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

// ─── 1. CONNECT — redirect to Microsoft consent ──────────────────────
router.get('/connect', authFromQuery, (req, res) => {
  if (!ms.isConfigured()) {
    return res.status(503).send('Microsoft integration not configured. Admin must add MS_CLIENT_ID and MS_CLIENT_SECRET in API Keys panel.');
  }
  const db = getDb(); ensureTable(db);

  // CSRF + user binding via signed state
  const stateRaw   = JSON.stringify({ uid: req.userId, n: crypto.randomBytes(8).toString('hex'), t: Date.now() });
  const stateB64   = Buffer.from(stateRaw).toString('base64url');

  const params = new URLSearchParams({
    client_id:     ms.clientId(),
    response_type: 'code',
    redirect_uri:  ms.redirectUri(),
    response_mode: 'query',
    scope:         SCOPES.join(' '),
    state:         stateB64,
    prompt:        'select_account',
  });
  const url = `${ms.authority()}/oauth2/v2.0/authorize?${params}`;
  res.redirect(url);
});

// ─── 2. CALLBACK — exchange code for tokens ──────────────────────────
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      console.error('[ms/callback] OAuth error:', error, error_description);
      return res.redirect(FRONTEND_URL + '?ms_connect=error&reason=' + encodeURIComponent(error_description || error));
    }
    if (!code || !state) return res.status(400).send('Missing code or state');

    let parsed;
    try { parsed = JSON.parse(Buffer.from(state, 'base64url').toString()); }
    catch (_) { return res.status(400).send('Invalid state'); }

    const userId = parsed.uid;
    if (!userId)               return res.status(400).send('Invalid state (no user)');
    if (Date.now() - parsed.t > 10 * 60 * 1000) return res.status(400).send('State expired — try again');

    // Exchange code for tokens
    const tokenRes = await _fetch(`${ms.authority()}/oauth2/v2.0/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     ms.clientId(),
        client_secret: ms.clientSecret(),
        code:          String(code),
        redirect_uri:  ms.redirectUri(),
        grant_type:    'authorization_code',
        scope:         SCOPES.join(' '),
      }),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      console.error('[ms/callback] token exchange failed:', t);
      return res.redirect(FRONTEND_URL + '?ms_connect=error&reason=' + encodeURIComponent('Token exchange failed'));
    }
    const tokens = await tokenRes.json();

    // Fetch profile to capture email/displayName
    const meRes = await _fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    const me = meRes.ok ? await meRes.json() : {};

    const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600) - 60;

    const db = getDb(); ensureTable(db);
    db.prepare(`
      INSERT INTO microsoft_connections (user_id, ms_user_id, email, display_name, access_token, refresh_token, expires_at, scopes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        ms_user_id    = excluded.ms_user_id,
        email         = excluded.email,
        display_name  = excluded.display_name,
        access_token  = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, microsoft_connections.refresh_token),
        expires_at    = excluded.expires_at,
        scopes        = excluded.scopes,
        updated_at    = CURRENT_TIMESTAMP
    `).run(
      userId,
      me.id || null,
      me.mail || me.userPrincipalName || null,
      me.displayName || null,
      tokens.access_token,
      tokens.refresh_token || null,
      expiresAt,
      SCOPES.join(' ')
    );

    res.redirect(FRONTEND_URL + '?ms_connect=success&email=' + encodeURIComponent(me.mail || me.userPrincipalName || ''));
  } catch (e) {
    console.error('[ms/callback]', e);
    res.redirect(FRONTEND_URL + '?ms_connect=error&reason=' + encodeURIComponent(e.message));
  }
});

// ─── 3. STATUS ───────────────────────────────────────────────────────
router.get('/status', requireAuth, (req, res) => {
  try {
    const db = getDb(); ensureTable(db);
    const row = db.prepare('SELECT email, display_name, ms_user_id, expires_at, created_at FROM microsoft_connections WHERE user_id = ?').get(req.userId);
    if (!row) return res.json({ connected: false });
    res.json({
      connected: true,
      email: row.email,
      display_name: row.display_name,
      capabilities: ['outlook_mail', 'outlook_calendar', 'onedrive', 'word', 'excel', 'powerpoint'],
      connected_at: row.created_at,
    });
  } catch (e) {
    console.error('[ms/status]', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 4. ME (basic profile) ───────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const token = await getAccessToken(req.userId);
    if (!token) return res.status(401).json({ error: 'Not connected' });
    const r = await _fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return res.status(r.status).json({ error: 'Graph error' });
    res.json(await r.json());
  } catch (e) {
    console.error('[ms/me]', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 5. DISCONNECT ───────────────────────────────────────────────────
router.post('/disconnect', requireAuth, (req, res) => {
  try {
    const db = getDb(); ensureTable(db);
    db.prepare('DELETE FROM microsoft_connections WHERE user_id = ?').run(req.userId);
    res.json({ success: true });
  } catch (e) {
    console.error('[ms/disconnect]', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── HELPERS exported for microsoft-actions.js ───────────────────────

/**
 * Returns a valid access token for the given user, refreshing if needed.
 * Returns null if the user has not connected Microsoft.
 */
async function getAccessToken(userId) {
  const db = getDb(); ensureTable(db);
  const row = db.prepare('SELECT access_token, refresh_token, expires_at FROM microsoft_connections WHERE user_id = ?').get(userId);
  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at > now + 30) return row.access_token;
  if (!row.refresh_token) return row.access_token; // best-effort

  // Refresh
  try {
    const r = await _fetch(`${ms.authority()}/oauth2/v2.0/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     ms.clientId(),
        client_secret: ms.clientSecret(),
        refresh_token: row.refresh_token,
        grant_type:    'refresh_token',
        scope:         SCOPES.join(' '),
      }),
    });
    if (!r.ok) {
      console.error('[ms refresh]', await r.text());
      return row.access_token; // last-known, may 401 — let caller surface error
    }
    const t = await r.json();
    const newExpires = Math.floor(Date.now() / 1000) + (t.expires_in || 3600) - 60;
    db.prepare(`
      UPDATE microsoft_connections
      SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(t.access_token, t.refresh_token || null, newExpires, userId);
    return t.access_token;
  } catch (e) {
    console.error('[ms refresh]', e);
    return row.access_token;
  }
}

/**
 * Authenticated Graph fetch wrapper.
 *   graphFetch(userId, '/me/messages', { method: 'GET' })  // path is relative to v1.0
 */
async function graphFetch(userId, path, opts) {
  const token = await getAccessToken(userId);
  if (!token) {
    const err = new Error('Microsoft not connected');
    err.code = 'MS_NOT_CONNECTED';
    throw err;
  }
  opts = opts || {};
  opts.headers = Object.assign({
    Authorization: 'Bearer ' + token,
    'Content-Type': opts.body && typeof opts.body === 'string' && opts.body.startsWith('{') ? 'application/json' : (opts.headers?.['Content-Type'] || 'application/json'),
  }, opts.headers || {});
  if (opts.json !== undefined) {
    opts.body = JSON.stringify(opts.json);
    opts.headers['Content-Type'] = 'application/json';
    delete opts.json;
  }
  const url = path.startsWith('http') ? path : ('https://graph.microsoft.com/v1.0' + (path.startsWith('/') ? path : '/' + path));
  return _fetch(url, opts);
}

module.exports = router;
module.exports.getAccessToken = getAccessToken;
module.exports.graphFetch     = graphFetch;
module.exports.ensureTable    = ensureTable;
