/**
 * MINE — Accounting OAuth 2.0
 * Xero and QuickBooks (Intuit) OAuth flows with automatic token refresh
 *
 * Xero:
 *   XERO_CLIENT_ID, XERO_CLIENT_SECRET
 *   GET /api/accounting/xero/connect         → redirects to Xero
 *   GET /api/accounting/xero/callback        → Xero returns here, saves tokens
 *   POST /api/accounting/xero/disconnect     → removes tokens
 *   GET /api/accounting/xero/status          → returns connection status
 *
 * QuickBooks:
 *   QB_CLIENT_ID, QB_CLIENT_SECRET
 *   GET /api/accounting/quickbooks/connect   → redirects to Intuit
 *   GET /api/accounting/quickbooks/callback  → Intuit returns here, saves tokens
 *   POST /api/accounting/quickbooks/disconnect
 *   GET /api/accounting/quickbooks/status
 *
 * Token refresh happens automatically before every sync call via ensureValidToken()
 */

const express  = require('express');
const router   = express.Router();
const { getDb }   = require('../db/init');
const { auth }    = require('../middleware/auth');
const crypto      = require('crypto');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL  = process.env.BACKEND_URL  || 'http://localhost:4000';

// ─── DB SETUP ────────────────────────────────────────────────────────────────
function ensureAccountingTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounting_tokens (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      provider    TEXT NOT NULL,          -- 'xero' | 'quickbooks'
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER,              -- unix ms
      tenant_id   TEXT,                  -- Xero tenant / QB realm
      tenant_name TEXT,
      scope       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      provider    TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ─── TOKEN HELPERS ────────────────────────────────────────────────────────────
async function refreshXeroToken(db, userId) {
  const rec = db.prepare("SELECT * FROM accounting_tokens WHERE user_id=? AND provider='xero'").get(userId);
  if (!rec?.refresh_token) throw new Error('No Xero refresh token — reconnect Xero');

  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('XERO_CLIENT_ID / XERO_CLIENT_SECRET not configured');

  const fetch2 = (await import('node-fetch')).default;
  const creds  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch2('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rec.refresh_token }).toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(d.error_description || 'Xero token refresh failed');

  db.prepare(`UPDATE accounting_tokens SET access_token=?, refresh_token=COALESCE(?,refresh_token),
    expires_at=?, updated_at=datetime('now') WHERE user_id=? AND provider='xero'`)
    .run(d.access_token, d.refresh_token || null, Date.now() + (d.expires_in || 1800) * 1000, userId);

  return d.access_token;
}

async function refreshQBToken(db, userId) {
  const rec = db.prepare("SELECT * FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").get(userId);
  if (!rec?.refresh_token) throw new Error('No QuickBooks refresh token — reconnect QuickBooks');

  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('QB_CLIENT_ID / QB_CLIENT_SECRET not configured');

  const fetch2 = (await import('node-fetch')).default;
  const creds  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch2('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rec.refresh_token }).toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(d.error_description || 'QuickBooks token refresh failed');

  db.prepare(`UPDATE accounting_tokens SET access_token=?, refresh_token=COALESCE(?,refresh_token),
    expires_at=?, updated_at=datetime('now') WHERE user_id=? AND provider='quickbooks'`)
    .run(d.access_token, d.refresh_token || null, Date.now() + (d.expires_in || 3600) * 1000, userId);

  return d.access_token;
}

/** Get a valid access token — refreshes automatically if expired */
async function ensureValidToken(db, userId, provider) {
  ensureAccountingTables(db);
  const rec = db.prepare("SELECT * FROM accounting_tokens WHERE user_id=? AND provider=?").get(userId, provider);
  if (!rec) throw new Error(`${provider} not connected. Connect it in Settings → Integrations.`);

  // Refresh if expiring within 5 minutes
  const fiveMin = 5 * 60 * 1000;
  if (!rec.expires_at || Date.now() > (rec.expires_at - fiveMin)) {
    return provider === 'xero' ? await refreshXeroToken(db, userId) : await refreshQBToken(db, userId);
  }
  return rec.access_token;
}

// Export for use in ai-employees.js
module.exports.ensureValidToken = ensureValidToken;
module.exports.router = router;

// ════════════════════════════════════════════════════════════════
// XERO OAUTH FLOW
// ════════════════════════════════════════════════════════════════

// Step 1: Redirect user to Xero login
router.get('/xero/connect', async (req, res) => {
  try {
  // Auth: accept token from query param (used when redirecting to OAuth provider)
  const { auth: authMiddleware } = require('../middleware/auth');
  const tokenParam = req.query.token;
  if (tokenParam && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + tokenParam;
  }
  await new Promise((resolve) => authMiddleware(req, res, resolve));
  if (!req.userId) return res.redirect(process.env.FRONTEND_URL + '/dashboard?xero_error=not_authenticated');

  const clientId = process.env.XERO_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'XERO_CLIENT_ID not configured in .env' });

  const db    = getDb();
  ensureAccountingTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO oauth_states (state, user_id, provider, created_at) VALUES (?,?,?,datetime('now'))")
    .run(state, req.userId, 'xero');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  `${BACKEND_URL}/api/accounting/xero/callback`,
    scope:         'openid profile email accounting.transactions accounting.contacts accounting.settings offline_access',
    state,
  });
  res.redirect(`https://login.xero.com/identity/connect/authorize?${params}`);

  } catch (e) {
    console.error("[/xero/connect]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// Step 2: Xero redirects back with auth code
router.get('/xero/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const db = getDb();
  ensureAccountingTables(db);

  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?xero_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}/dashboard?xero_error=missing_code`);

  const stateRec = db.prepare("SELECT * FROM oauth_states WHERE state=? AND provider='xero'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?xero_error=invalid_state`);

  db.prepare("DELETE FROM oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;

  try {
    const fetch2 = (await import('node-fetch')).default;
    const clientId     = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    // Exchange code for tokens
    const tokenR = await fetch2('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: `${BACKEND_URL}/api/accounting/xero/callback`,
      }).toString()
    });
    const tokens = await tokenR.json();
    if (!tokens.access_token) throw new Error(tokens.error_description || 'Token exchange failed');

    // Get tenant (organisation) list
    const tenantR = await fetch2('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' }
    });
    const tenants = await tenantR.json();
    const tenant  = tenants[0]; // use first connected org

    const { v4: uuidFn } = require('uuid');
    db.prepare(`INSERT OR REPLACE INTO accounting_tokens
      (id, user_id, provider, access_token, refresh_token, expires_at, tenant_id, tenant_name, scope, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(uuidFn(), userId, 'xero', tokens.access_token, tokens.refresh_token,
        Date.now() + (tokens.expires_in || 1800) * 1000,
        tenant?.tenantId || '', tenant?.tenantName || 'Xero Organisation',
        tokens.scope || '');

    res.redirect(`${FRONTEND_URL}/dashboard?xero_connected=1&org=${encodeURIComponent(tenant?.tenantName || 'Xero')}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?xero_error=${encodeURIComponent(e.message)}`);
  }
});

// Disconnect Xero
router.post('/xero/disconnect', auth, (req, res) => {
  const db = getDb();
  ensureAccountingTables(db);
  db.prepare("DELETE FROM accounting_tokens WHERE user_id=? AND provider='xero'").run(req.userId);
  res.json({ success: true });
});

// Status check
router.get('/xero/status', auth, (req, res) => {
  const db  = getDb();
  ensureAccountingTables(db);
  const rec = db.prepare("SELECT tenant_name, expires_at, updated_at FROM accounting_tokens WHERE user_id=? AND provider='xero'").get(req.userId);
  if (!rec) return res.json({ connected: false });
  res.json({ connected: true, orgName: rec.tenant_name, expiresAt: rec.expires_at, lastSync: rec.updated_at });
});

// ════════════════════════════════════════════════════════════════
// QUICKBOOKS OAUTH FLOW
// ════════════════════════════════════════════════════════════════

router.get('/quickbooks/connect', async (req, res) => {
  try {
  const { auth: authMiddleware } = require('../middleware/auth');
  const tokenParam = req.query.token;
  if (tokenParam && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + tokenParam;
  }
  await new Promise((resolve) => authMiddleware(req, res, resolve));
  if (!req.userId) return res.redirect(process.env.FRONTEND_URL + '/dashboard?qb_error=not_authenticated');

  const clientId = process.env.QB_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'QB_CLIENT_ID not configured in .env' });

  const db    = getDb();
  ensureAccountingTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO oauth_states (state, user_id, provider, created_at) VALUES (?,?,?,datetime('now'))")
    .run(state, req.userId, 'quickbooks');

  const params = new URLSearchParams({
    client_id:     clientId,
    scope:         'com.intuit.quickbooks.accounting',
    redirect_uri:  `${BACKEND_URL}/api/accounting/quickbooks/callback`,
    response_type: 'code',
    state,
  });
  res.redirect(`https://appcenter.intuit.com/connect/oauth2?${params}`);

  } catch (e) {
    console.error("[/quickbooks/connect]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

router.get('/quickbooks/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query;
  const db = getDb();
  ensureAccountingTables(db);

  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?qb_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}/dashboard?qb_error=missing_code`);

  const stateRec = db.prepare("SELECT * FROM oauth_states WHERE state=? AND provider='quickbooks'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?qb_error=invalid_state`);

  db.prepare("DELETE FROM oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;

  try {
    const fetch2 = (await import('node-fetch')).default;
    const clientId     = process.env.QB_CLIENT_ID;
    const clientSecret = process.env.QB_CLIENT_SECRET;
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenR = await fetch2('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: `${BACKEND_URL}/api/accounting/quickbooks/callback`,
      }).toString()
    });
    const tokens = await tokenR.json();
    if (!tokens.access_token) throw new Error(tokens.error_description || 'QB token exchange failed');

    // Get company name
    let companyName = 'QuickBooks Company';
    try {
      const infoR = await fetch2(`https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' }
      });
      const info = await infoR.json();
      companyName = info.CompanyInfo?.CompanyName || companyName;
    } catch(_) { console.error("[/quickbooks/callback]", _.message || _); }

    const { v4: uuidFn } = require('uuid');
    db.prepare(`INSERT OR REPLACE INTO accounting_tokens
      (id, user_id, provider, access_token, refresh_token, expires_at, tenant_id, tenant_name, scope, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(uuidFn(), userId, 'quickbooks', tokens.access_token, tokens.refresh_token,
        Date.now() + (tokens.expires_in || 3600) * 1000,
        realmId || '', companyName, tokens.scope || '');

    res.redirect(`${FRONTEND_URL}/dashboard?qb_connected=1&org=${encodeURIComponent(companyName)}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?qb_error=${encodeURIComponent(e.message)}`);
  }
});

router.post('/quickbooks/disconnect', auth, (req, res) => {
  const db = getDb();
  ensureAccountingTables(db);
  db.prepare("DELETE FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").run(req.userId);
  res.json({ success: true });
});

router.get('/quickbooks/status', auth, (req, res) => {
  const db  = getDb();
  ensureAccountingTables(db);
  const rec = db.prepare("SELECT tenant_name, tenant_id, expires_at, updated_at FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").get(req.userId);
  if (!rec) return res.json({ connected: false });
  res.json({ connected: true, companyName: rec.tenant_name, realmId: rec.tenant_id, expiresAt: rec.expires_at, lastSync: rec.updated_at });
});

