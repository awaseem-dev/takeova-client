/**
 * MINE — Microsoft Graph Service
 *
 * Wraps Graph API calls for Outlook (mail + calendar), OneDrive (files), Word,
 * Excel, and PowerPoint. Used by routes/microsoft-actions.js and routes/microsoft-oauth.js.
 *
 * Required env:
 *   MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT (default: 'common'),
 *   BACKEND_URL (used to build the redirect URI)
 *
 * Token storage: microsoft_connections table (one row per user).
 *
 * Public functions:
 *   getAuthUrl(state)                              → consent URL
 *   exchangeCodeForTokens(code)                    → tokens
 *   refreshAccessToken(refreshToken)               → new access token
 *   getStoredConnection(db, userId)                → row from microsoft_connections
 *   saveConnection(db, userId, tokens, profile)    → upsert row
 *   deleteConnection(db, userId)                   → row removed
 *   getValidAccessToken(db, userId)                → access token, auto-refreshed
 *
 *   sendEmail(token, {to, subject, body, cc?, bcc?})
 *   listEmails(token, {limit?, search?, unread?})
 *   listCalendarEvents(token, {start?, end?, limit?})
 *   createCalendarEvent(token, {subject, start, end, attendees?, body?, location?})
 *   listOneDriveFiles(token, {path?, search?})
 *   downloadOneDriveFile(token, fileId)
 *   uploadOneDriveFile(token, {filename, content, parentPath?, contentType?})
 *   readExcelRange(token, fileId, sheet, range)
 *   writeExcelRange(token, fileId, sheet, range, values)
 *   getMyProfile(token)
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// TENANT + AUTHORITY are now provided by tenant() / authority() getters
// so admin can change them via the API Keys panel without a redeploy.

// Single combined scope set — one consent screen, all features.
// `offline_access` is required for refresh tokens.
const SCOPES = [
  'offline_access',
  'openid', 'profile', 'email', 'User.Read',
  // Outlook
  'Mail.Read', 'Mail.Send', 'Mail.ReadWrite',
  'Calendars.ReadWrite',
  // OneDrive + Office files
  'Files.ReadWrite', 'Files.ReadWrite.All',
  // Sites (sometimes required for Excel/Word workbook APIs depending on tenant)
  'Sites.ReadWrite.All',
].join(' ');

// ─── Config (env-var first, falls back to admin platform_settings table) ───
//
// This allows the platform owner to enter Azure App credentials via the
// Admin → API Keys panel WITHOUT a redeploy.
function _readSetting(key) {
  try {
    const { getDb } = require('../db/init');
    const db = getDb();
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
    return row && row.value ? row.value : '';
  } catch (_) { return ''; }
}
function clientId()      { return process.env.MS_CLIENT_ID     || _readSetting('MS_CLIENT_ID'); }
function clientSecret()  { return process.env.MS_CLIENT_SECRET || _readSetting('MS_CLIENT_SECRET'); }
function tenant()        { return process.env.MS_TENANT_ID     || _readSetting('MS_TENANT_ID') || process.env.MS_TENANT || 'common'; }
function backendUrl()    { return process.env.BACKEND_URL      || _readSetting('BACKEND_URL') || 'http://localhost:4000'; }
function authority()     { return `https://login.microsoftonline.com/${tenant()}`; }
function redirectUri()   { return backendUrl().replace(/\/$/, '') + '/api/microsoft/callback'; }
function isConfigured()  { return !!(clientId() && clientSecret()); }

// ─── DB schema ───────────────────────────────────────────────────────────────
function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS microsoft_connections (
      user_id        TEXT PRIMARY KEY,
      access_token   TEXT,
      refresh_token  TEXT,
      expires_at     INTEGER,
      ms_user_id     TEXT,
      display_name   TEXT,
      email          TEXT,
      tenant_id      TEXT,
      scope          TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    )
  `);
}

// ─── OAuth flow ──────────────────────────────────────────────────────────────
function getAuthUrl(state) {
  if (!clientId()) throw new Error('MS_CLIENT_ID not configured');
  const params = new URLSearchParams({
    client_id:     clientId(),
    response_type: 'code',
    redirect_uri:  redirectUri(),
    response_mode: 'query',
    scope:         SCOPES,
    state:         state || '',
    prompt:        'select_account',
  });
  return `${authority()}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  if (!clientId() || !clientSecret()) throw new Error('Microsoft OAuth not configured');
  const body = new URLSearchParams({
    client_id:     clientId(),
    client_secret: clientSecret(),
    code,
    redirect_uri:  redirectUri(),
    grant_type:    'authorization_code',
    scope:         SCOPES,
  });
  const r = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Token exchange failed: ' + (d.error_description || d.error || r.status));
  return d; // { access_token, refresh_token, expires_in, scope, id_token, ... }
}

async function refreshAccessToken(refreshToken) {
  if (!refreshToken) throw new Error('No refresh token');
  const body = new URLSearchParams({
    client_id:     clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
    scope:         SCOPES,
  });
  const r = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Token refresh failed: ' + (d.error_description || d.error || r.status));
  return d;
}

// ─── Connection storage ──────────────────────────────────────────────────────
function getStoredConnection(db, userId) {
  ensureTable(db);
  return db.prepare('SELECT * FROM microsoft_connections WHERE user_id = ?').get(userId);
}

function saveConnection(db, userId, tokens, profile) {
  ensureTable(db);
  const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600);
  db.prepare(`
    INSERT INTO microsoft_connections (user_id, access_token, refresh_token, expires_at, ms_user_id, display_name, email, tenant_id, scope, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at,
      ms_user_id    = excluded.ms_user_id,
      display_name  = excluded.display_name,
      email         = excluded.email,
      tenant_id     = excluded.tenant_id,
      scope         = excluded.scope,
      updated_at    = datetime('now')
  `).run(
    userId,
    tokens.access_token || null,
    tokens.refresh_token || null,
    expiresAt,
    profile?.id || null,
    profile?.displayName || null,
    profile?.mail || profile?.userPrincipalName || null,
    profile?.tenantId || null,
    tokens.scope || SCOPES,
  );
}

function deleteConnection(db, userId) {
  ensureTable(db);
  db.prepare('DELETE FROM microsoft_connections WHERE user_id = ?').run(userId);
}

async function getValidAccessToken(db, userId) {
  const row = getStoredConnection(db, userId);
  if (!row) throw new Error('Not connected to Microsoft 365');
  const now = Math.floor(Date.now() / 1000);
  // Refresh if within 60s of expiry
  if (row.expires_at && row.expires_at - now > 60) return row.access_token;
  if (!row.refresh_token) throw new Error('Token expired and no refresh token; reconnect required');
  const fresh = await refreshAccessToken(row.refresh_token);
  // Update stored tokens (refresh_token may be the same; access_token + expires_at change)
  saveConnection(db, userId, fresh, {
    id:                row.ms_user_id,
    displayName:       row.display_name,
    mail:              row.email,
    userPrincipalName: row.email,
    tenantId:          row.tenant_id,
  });
  return fresh.access_token;
}

// ─── Graph helpers ───────────────────────────────────────────────────────────
async function gFetch(token, path, opts) {
  opts = opts || {};
  opts.headers = Object.assign(
    { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    opts.headers || {}
  );
  if (opts.json !== undefined) {
    opts.body = JSON.stringify(opts.json);
    opts.headers['Content-Type'] = 'application/json';
    delete opts.json;
  }
  const url = path.startsWith('http') ? path : (GRAPH_BASE + path);
  const r = await fetch(url, opts);
  // Some Graph endpoints return 204 with no body
  if (r.status === 204) return { ok: true };
  let body = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { body = await r.json(); } catch (_) {}
  } else {
    try { body = await r.arrayBuffer(); } catch (_) {}
  }
  if (!r.ok) {
    const msg = body && body.error ? (body.error.message || JSON.stringify(body.error)) : ('HTTP ' + r.status);
    const e = new Error('Graph error: ' + msg);
    e.status = r.status;
    e.graphBody = body;
    throw e;
  }
  return body;
}

// ─── Profile ─────────────────────────────────────────────────────────────────
async function getMyProfile(token) {
  return gFetch(token, '/me');
}

// ─── Outlook: Mail ───────────────────────────────────────────────────────────
async function sendEmail(token, { to, subject, body, cc, bcc, isHtml }) {
  const toArr  = Array.isArray(to)  ? to  : (to  ? [to]  : []);
  const ccArr  = Array.isArray(cc)  ? cc  : (cc  ? [cc]  : []);
  const bccArr = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);
  if (!toArr.length || !subject) throw new Error('to and subject are required');

  const payload = {
    message: {
      subject:        subject,
      body: {
        contentType: isHtml === false ? 'Text' : 'HTML',
        content:     body || '',
      },
      toRecipients:  toArr.map(addr  => ({ emailAddress: { address: addr } })),
      ccRecipients:  ccArr.map(addr  => ({ emailAddress: { address: addr } })),
      bccRecipients: bccArr.map(addr => ({ emailAddress: { address: addr } })),
    },
    saveToSentItems: true,
  };
  return gFetch(token, '/me/sendMail', { method: 'POST', json: payload });
}

async function listEmails(token, { limit = 20, search, unread } = {}) {
  const params = new URLSearchParams();
  params.set('$top', String(Math.min(limit, 50)));
  params.set('$orderby', 'receivedDateTime desc');
  params.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments');
  if (search)              params.set('$search', `"${search}"`);
  else if (unread === true) params.set('$filter', 'isRead eq false');
  const d = await gFetch(token, `/me/messages?${params.toString()}`);
  return d.value || [];
}

// ─── Outlook: Calendar ───────────────────────────────────────────────────────
async function listCalendarEvents(token, { start, end, limit = 20 } = {}) {
  // calendarView requires startDateTime + endDateTime
  const startISO = start || new Date().toISOString();
  const endISO   = end   || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    startDateTime: startISO,
    endDateTime:   endISO,
    '$top':        String(Math.min(limit, 50)),
    '$orderby':    'start/dateTime',
    '$select':     'id,subject,start,end,location,attendees,bodyPreview,organizer,isAllDay,onlineMeetingUrl',
  });
  const d = await gFetch(token, `/me/calendarView?${params.toString()}`);
  return d.value || [];
}

async function createCalendarEvent(token, { subject, start, end, attendees, body, location, isOnlineMeeting }) {
  if (!subject || !start || !end) throw new Error('subject, start, end are required');
  const attArr = (attendees || []).map(addr =>
    typeof addr === 'string'
      ? { emailAddress: { address: addr }, type: 'required' }
      : { emailAddress: { address: addr.email, name: addr.name }, type: addr.type || 'required' }
  );
  const payload = {
    subject,
    start:    { dateTime: start, timeZone: 'UTC' },
    end:      { dateTime: end,   timeZone: 'UTC' },
    body:     body ? { contentType: 'HTML', content: body } : undefined,
    location: location ? { displayName: location } : undefined,
    attendees: attArr.length ? attArr : undefined,
    isOnlineMeeting: !!isOnlineMeeting,
    onlineMeetingProvider: isOnlineMeeting ? 'teamsForBusiness' : undefined,
  };
  return gFetch(token, '/me/events', { method: 'POST', json: payload });
}

// ─── OneDrive ────────────────────────────────────────────────────────────────
async function listOneDriveFiles(token, { path, search } = {}) {
  if (search) {
    const d = await gFetch(token, `/me/drive/root/search(q='${encodeURIComponent(search)}')?$top=25`);
    return d.value || [];
  }
  const segment = path ? `:/${encodeURIComponent(path)}:/children` : '/children';
  const d = await gFetch(token, `/me/drive/root${segment}?$top=50&$orderby=lastModifiedDateTime desc`);
  return d.value || [];
}

async function downloadOneDriveFile(token, fileId) {
  // Microsoft returns a 302 redirect to the file content; fetch in browser-style follows it
  const url = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/content`;
  const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw new Error('Download failed: HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadOneDriveFile(token, { filename, content, parentPath, contentType }) {
  if (!filename || !content) throw new Error('filename and content are required');
  // Path-based PUT for small files (< 4 MB Graph limit). Larger files would need uploadSession.
  const fullPath = (parentPath ? parentPath.replace(/^\/|\/$/g, '') + '/' : '') + filename;
  const url = `${GRAPH_BASE}/me/drive/root:/${encodeURIComponent(fullPath).replace(/%2F/g, '/')}:/content`;
  const r = await fetch(url, {
    method:  'PUT',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  contentType || 'application/octet-stream',
    },
    body: content,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Upload failed: ' + (d?.error?.message || r.status));
  return d;
}

// ─── Excel ───────────────────────────────────────────────────────────────────
async function readExcelRange(token, fileId, sheet, range) {
  const path = `/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets/${encodeURIComponent(sheet)}/range(address='${encodeURIComponent(range)}')`;
  const d = await gFetch(token, path);
  return d.values; // 2D array of cell values
}

async function writeExcelRange(token, fileId, sheet, range, values) {
  const path = `/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets/${encodeURIComponent(sheet)}/range(address='${encodeURIComponent(range)}')`;
  return gFetch(token, path, { method: 'PATCH', json: { values } });
}

async function listExcelSheets(token, fileId) {
  const d = await gFetch(token, `/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets`);
  return d.value || [];
}

module.exports = {
  // OAuth
  SCOPES, getAuthUrl, exchangeCodeForTokens, refreshAccessToken,
  // Storage
  ensureTable, getStoredConnection, saveConnection, deleteConnection, getValidAccessToken,
  // Graph
  getMyProfile,
  sendEmail, listEmails,
  listCalendarEvents, createCalendarEvent,
  listOneDriveFiles, downloadOneDriveFile, uploadOneDriveFile,
  readExcelRange, writeExcelRange, listExcelSheets,
  // Config (env-or-DB) — used by microsoft-oauth.js so admin can configure via UI
  clientId, clientSecret, tenant, authority, redirectUri, backendUrl, isConfigured,
};
