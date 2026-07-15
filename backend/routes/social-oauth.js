/**
 * MINE — Social Platform OAuth
 * Connects Facebook/Instagram, TikTok, LinkedIn, X (Twitter), YouTube
 *
 * All tokens stored in user_social_tokens table
 * Auto-used by post_now / reply_comment in executeAction
 *
 * Routes (all under /api/social):
 *   GET  /facebook/connect     → redirects to Facebook
 *   GET  /facebook/callback    → saves token, redirects back
 *   GET  /tiktok/connect
 *   GET  /tiktok/callback
 *   GET  /linkedin/connect
 *   GET  /linkedin/callback
 *   GET  /x/connect
 *   GET  /x/callback
 *   GET  /youtube/connect
 *   GET  /youtube/callback
 *   POST /:platform/disconnect
 *   GET  /status               → all platforms at once
 *
 * Required env vars:
 *   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
 *   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
 *   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
 *   TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (YouTube uses Google OAuth)
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const { getDb }  = require('../db/init');
const { auth }   = require('../middleware/auth');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL  = process.env.BACKEND_URL  || 'http://localhost:4000';

// ─── DB ──────────────────────────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_social_tokens (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      platform      TEXT NOT NULL,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER,
      page_id       TEXT,
      page_name     TEXT,
      username      TEXT,
      scope         TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, platform)
    );
    CREATE TABLE IF NOT EXISTS social_oauth_states (
      state      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      platform   TEXT NOT NULL,
      verifier   TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Follower-stats columns (added incrementally; SQLite throws if a column already exists)
  [['follower_count','INTEGER'],['post_count','INTEGER'],['engagement_rate','REAL'],['last_synced','TEXT']].forEach(function(c){
    try { db.exec('ALTER TABLE user_social_tokens ADD COLUMN ' + c[0] + ' ' + c[1]); } catch (_) {}
  });
}

function saveToken(db, userId, platform, data) {
  ensureTables(db);
  const { v4: uuid } = require('uuid');
  db.prepare(`INSERT OR REPLACE INTO user_social_tokens
    (id, user_id, platform, access_token, refresh_token, expires_at, page_id, page_name, username, scope, updated_at)
    VALUES (COALESCE((SELECT id FROM user_social_tokens WHERE user_id=? AND platform=?),?),?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(userId, platform, uuid(),
         userId, platform,
         data.access_token, data.refresh_token || null,
         data.expires_at || null, data.page_id || null,
         data.page_name || null, data.username || null, data.scope || null);
}

// Helper: accept token in query param for redirect flows
async function authFromQuery(req, res, next) {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  const { auth: authMw } = require('../middleware/auth');
  await new Promise(resolve => authMw(req, res, resolve));
  if (!req.userId) return res.redirect(FRONTEND_URL + '/dashboard?social_error=not_authenticated');
  next();
}

// ════════════════════════════════════════════════════════
// STATUS — all platforms at once
// ════════════════════════════════════════════════════════
router.get('/status', auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare("SELECT platform, page_name, username, expires_at, updated_at FROM user_social_tokens WHERE user_id=?").all(req.userId);
  const status = {};
  for (const r of rows) {
    status[r.platform] = {
      connected: true,
      name: r.page_name || r.username || r.platform,
      expiresAt: r.expires_at,
      lastUsed: r.updated_at,
    };
  }
  res.json({ platforms: status });
});

// ════════════════════════════════════════════════════════
// DISCONNECT
// ════════════════════════════════════════════════════════
router.post('/:platform/disconnect', auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("DELETE FROM user_social_tokens WHERE user_id=? AND platform=?").run(req.userId, req.params.platform);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════
// FACEBOOK / INSTAGRAM
// Scope gives access to both FB Pages and IG Business accounts
// ════════════════════════════════════════════════════════
router.get('/facebook/connect', authFromQuery, (req, res) => {
  const appId = process.env.FACEBOOK_APP_ID;
  if (!appId) return res.status(500).json({ error: 'FACEBOOK_APP_ID not configured' });
  const db    = getDb(); ensureTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO social_oauth_states (state,user_id,platform,created_at) VALUES (?,?,?,datetime('now'))").run(state, req.userId, 'facebook');
  const params = new URLSearchParams({
    client_id:    appId,
    redirect_uri: `${BACKEND_URL}/api/social/facebook/callback`,
    scope:        'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,public_profile,pages_manage_engagement',
    state,
    response_type: 'code',
  });
  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

router.get('/facebook/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const db = getDb(); ensureTables(db);
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}&platform=facebook`);
  const stateRec = db.prepare("SELECT * FROM social_oauth_states WHERE state=? AND platform='facebook'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state&platform=facebook`);
  db.prepare("DELETE FROM social_oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;
  try {
    const fetch2 = (await import('node-fetch')).default;
    const appId     = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    // Exchange code for short-lived token
    const tokenR = await fetch2(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(BACKEND_URL+'/api/social/facebook/callback')}&code=${code}`);
    const tokenD = await tokenR.json();
    if (!tokenD.access_token) throw new Error(tokenD.error?.message || 'Token exchange failed');
    // Exchange for long-lived token (60 days)
    const llR = await fetch2(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenD.access_token}`);
    const llD = await llR.json();
    const longToken = llD.access_token || tokenD.access_token;
    // Get user pages
    const pagesR = await fetch2(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}`);
    const pagesD = await pagesR.json();
    const page   = pagesD.data?.[0];
    // Save user token (for posting to personal profile + pages)
    saveToken(db, userId, 'meta', {
      access_token: page?.access_token || longToken,
      expires_at:   Date.now() + 60 * 24 * 3600 * 1000,
      page_id:      page?.id || null,
      page_name:    page?.name || 'Facebook Page',
      scope:        tokenD.scope || '',
    });
    // Also save as 'instagram' (same token, used for IG Graph API)
    saveToken(db, userId, 'instagram', {
      access_token: page?.access_token || longToken,
      expires_at:   Date.now() + 60 * 24 * 3600 * 1000,
      page_id:      page?.id || null,
      page_name:    page?.name ? page.name + ' (Instagram)' : 'Instagram',
    });
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=facebook&name=${encodeURIComponent(page?.name||'Facebook')}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}&platform=facebook`);
  }
});

// ════════════════════════════════════════════════════════
// TIKTOK
// ════════════════════════════════════════════════════════
router.get('/tiktok/connect', authFromQuery, (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY not configured' });
  const db    = getDb(); ensureTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  db.prepare("INSERT OR REPLACE INTO social_oauth_states (state,user_id,platform,verifier,created_at) VALUES (?,?,?,?,datetime('now'))").run(state, req.userId, 'tiktok', verifier);
  const params = new URLSearchParams({
    client_key:            clientKey,
    response_type:         'code',
    scope:                 'user.info.basic,video.publish,video.upload',
    redirect_uri:          `${BACKEND_URL}/api/social/tiktok/callback`,
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params}`);
});

router.get('/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const db = getDb(); ensureTables(db);
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}&platform=tiktok`);
  const stateRec = db.prepare("SELECT * FROM social_oauth_states WHERE state=? AND platform='tiktok'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state&platform=tiktok`);
  db.prepare("DELETE FROM social_oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;
  try {
    const fetch2 = (await import('node-fetch')).default;
    const tokenR = await fetch2('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key:    process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  `${BACKEND_URL}/api/social/tiktok/callback`,
        code_verifier: stateRec.verifier,
      }).toString()
    });
    const tokenD = await tokenR.json();
    if (!tokenD.data?.access_token) throw new Error(tokenD.message || 'TikTok token exchange failed');
    const tok = tokenD.data;
    // Get user info
    const userR = await fetch2('https://open.tiktokapis.com/v2/user/info/?fields=display_name,username', {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    const userD = await userR.json();
    const username = userD.data?.user?.username || userD.data?.user?.display_name || 'TikTok Account';
    saveToken(db, userId, 'tiktok', {
      access_token:  tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at:    Date.now() + (tok.expires_in || 86400) * 1000,
      username,
      scope: tok.scope || '',
    });
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=tiktok&name=${encodeURIComponent(username)}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}&platform=tiktok`);
  }
});

// ════════════════════════════════════════════════════════
// LINKEDIN
// ════════════════════════════════════════════════════════
router.get('/linkedin/connect', authFromQuery, (req, res) => {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'LINKEDIN_CLIENT_ID not configured' });
  const db    = getDb(); ensureTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO social_oauth_states (state,user_id,platform,created_at) VALUES (?,?,?,datetime('now'))").run(state, req.userId, 'linkedin');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  `${BACKEND_URL}/api/social/linkedin/callback`,
    state,
    scope:         'openid profile email w_member_social',
  });
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

router.get('/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const db = getDb(); ensureTables(db);
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}&platform=linkedin`);
  const stateRec = db.prepare("SELECT * FROM social_oauth_states WHERE state=? AND platform='linkedin'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state&platform=linkedin`);
  db.prepare("DELETE FROM social_oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;
  try {
    const fetch2 = (await import('node-fetch')).default;
    const creds = Buffer.from(`${process.env.LINKEDIN_CLIENT_ID}:${process.env.LINKEDIN_CLIENT_SECRET}`).toString('base64');
    const tokenR = await fetch2('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
      body: new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri:`${BACKEND_URL}/api/social/linkedin/callback` }).toString()
    });
    const tokenD = await tokenR.json();
    if (!tokenD.access_token) throw new Error(tokenD.error_description || 'LinkedIn token failed');
    const meR = await fetch2('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${tokenD.access_token}` } });
    const me  = await meR.json();
    const name = me.name || me.email || 'LinkedIn Account';
    saveToken(db, userId, 'linkedin', {
      access_token: tokenD.access_token,
      expires_at: Date.now() + (tokenD.expires_in || 5184000) * 1000,
      username: name, scope: tokenD.scope || '',
    });
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=linkedin&name=${encodeURIComponent(name)}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}&platform=linkedin`);
  }
});

// ════════════════════════════════════════════════════════
// X (TWITTER) — OAuth 2.0 PKCE
// ════════════════════════════════════════════════════════
router.get('/x/connect', authFromQuery, (req, res) => {
  const clientId = process.env.TWITTER_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'TWITTER_CLIENT_ID not configured' });
  const db    = getDb(); ensureTables(db);
  const state    = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  db.prepare("INSERT OR REPLACE INTO social_oauth_states (state,user_id,platform,verifier,created_at) VALUES (?,?,?,?,datetime('now'))").run(state, req.userId, 'x', verifier);
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId,
    redirect_uri:  `${BACKEND_URL}/api/social/x/callback`,
    scope:         'tweet.read tweet.write users.read offline.access',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  res.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
});

router.get('/x/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const db = getDb(); ensureTables(db);
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}&platform=x`);
  const stateRec = db.prepare("SELECT * FROM social_oauth_states WHERE state=? AND platform='x'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state&platform=x`);
  db.prepare("DELETE FROM social_oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;
  try {
    const fetch2 = (await import('node-fetch')).default;
    const creds = Buffer.from(`${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`).toString('base64');
    const tokenR = await fetch2('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
      body: new URLSearchParams({ code, grant_type:'authorization_code', redirect_uri:`${BACKEND_URL}/api/social/x/callback`, code_verifier: stateRec.verifier }).toString()
    });
    const tokenD = await tokenR.json();
    if (!tokenD.access_token) throw new Error(tokenD.error_description || 'X token failed');
    const meR = await fetch2('https://api.twitter.com/2/users/me', { headers: { Authorization: `Bearer ${tokenD.access_token}` } });
    const me  = await meR.json();
    const username = '@' + (me.data?.username || 'x_account');
    saveToken(db, userId, 'x', {
      access_token: tokenD.access_token, refresh_token: tokenD.refresh_token,
      expires_at: Date.now() + (tokenD.expires_in || 7200) * 1000,
      username, scope: tokenD.scope || '',
    });
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=x&name=${encodeURIComponent(username)}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}&platform=x`);
  }
});

// ════════════════════════════════════════════════════════
// YOUTUBE (Google OAuth — reuses GOOGLE_CLIENT_ID)
// ════════════════════════════════════════════════════════
router.get('/youtube/connect', authFromQuery, (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });
  const db    = getDb(); ensureTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO social_oauth_states (state,user_id,platform,created_at) VALUES (?,?,?,datetime('now'))").run(state, req.userId, 'youtube');
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code',
    redirect_uri: `${BACKEND_URL}/api/social/youtube/callback`,
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline', prompt: 'consent', state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const db = getDb(); ensureTables(db);
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}&platform=youtube`);
  const stateRec = db.prepare("SELECT * FROM social_oauth_states WHERE state=? AND platform='youtube'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state&platform=youtube`);
  db.prepare("DELETE FROM social_oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;
  try {
    const fetch2 = (await import('node-fetch')).default;
    const tokenR = await fetch2('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: `${BACKEND_URL}/api/social/youtube/callback`, grant_type: 'authorization_code' }).toString()
    });
    const tokenD = await tokenR.json();
    if (!tokenD.access_token) throw new Error(tokenD.error_description || 'YouTube token failed');
    const chR = await fetch2('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${tokenD.access_token}` } });
    const chD = await chR.json();
    const channelName = chD.items?.[0]?.snippet?.title || 'YouTube Channel';
    saveToken(db, userId, 'youtube', {
      access_token: tokenD.access_token, refresh_token: tokenD.refresh_token,
      expires_at: Date.now() + (tokenD.expires_in || 3600) * 1000,
      username: channelName, scope: tokenD.scope || '',
    });
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=youtube&name=${encodeURIComponent(channelName)}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}&platform=youtube`);
  }
});

// ════════════════════════════════════════════════════════
// META ADS — read-only ads_read scope for Showdown ad-cap monitoring
// Stored under platform='meta-ads' so it doesn't collide with the
// 'meta' organic-posting token (which has different scopes).
// ════════════════════════════════════════════════════════
router.get('/meta-ads/connect', authFromQuery, (req, res) => {
  const appId = process.env.FACEBOOK_APP_ID;
  if (!appId) return res.status(500).json({ error: 'FACEBOOK_APP_ID not configured' });
  const db    = getDb(); ensureTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO social_oauth_states (state,user_id,platform,created_at) VALUES (?,?,?,datetime('now'))")
    .run(state, req.userId, 'meta-ads');
  const params = new URLSearchParams({
    client_id:    appId,
    redirect_uri: `${BACKEND_URL}/api/social/meta-ads/callback`,
    // ads_read = read-only access to ad accounts and insights.
    // business_management lets us list ad accounts attached to Business Manager.
    scope:        'ads_read,business_management',
    state,
    response_type: 'code',
  });
  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

router.get('/meta-ads/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const db = getDb(); ensureTables(db);
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}&platform=meta-ads`);
  const stateRec = db.prepare("SELECT * FROM social_oauth_states WHERE state=? AND platform='meta-ads'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state&platform=meta-ads`);
  db.prepare("DELETE FROM social_oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;
  try {
    const fetch2 = (await import('node-fetch')).default;
    const appId     = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const tokenR = await fetch2(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(BACKEND_URL+'/api/social/meta-ads/callback')}&code=${code}`);
    const tokenD = await tokenR.json();
    if (!tokenD.access_token) throw new Error(tokenD.error?.message || 'Token exchange failed');
    // Long-lived token (60 days)
    const llR = await fetch2(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenD.access_token}`);
    const llD = await llR.json();
    const longToken = llD.access_token || tokenD.access_token;
    saveToken(db, userId, 'meta-ads', {
      access_token: longToken,
      expires_at:   Date.now() + 60 * 24 * 3600 * 1000,
      scope:        tokenD.scope || 'ads_read,business_management',
    });
    // Trigger Showdown ad-account discovery if the user has an active entry.
    try { require('./showdown-ad-cap').discoverForUser?.(userId, 'meta'); } catch(_) {}
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=meta-ads&from=showdown`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}&platform=meta-ads`);
  }
});

// ════════════════════════════════════════════════════════
// GOOGLE ADS — adwords scope for Showdown ad-cap monitoring
// Reuses GOOGLE_CLIENT_ID/SECRET that YouTube also uses.
// ════════════════════════════════════════════════════════
router.get('/google-ads/connect', authFromQuery, (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });
  const db    = getDb(); ensureTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO social_oauth_states (state,user_id,platform,created_at) VALUES (?,?,?,datetime('now'))")
    .run(state, req.userId, 'google-ads');
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    redirect_uri:  `${BACKEND_URL}/api/social/google-ads/callback`,
    scope:         'https://www.googleapis.com/auth/adwords',
    access_type:   'offline',
    prompt:        'consent',  // forces refresh_token issuance every time
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google-ads/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const db = getDb(); ensureTables(db);
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}&platform=google-ads`);
  const stateRec = db.prepare("SELECT * FROM social_oauth_states WHERE state=? AND platform='google-ads'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state&platform=google-ads`);
  db.prepare("DELETE FROM social_oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;
  try {
    const fetch2 = (await import('node-fetch')).default;
    const tokenR = await fetch2('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${BACKEND_URL}/api/social/google-ads/callback`,
        grant_type:    'authorization_code',
      }).toString()
    });
    const tokenD = await tokenR.json();
    if (!tokenD.access_token) throw new Error(tokenD.error_description || 'Google Ads token exchange failed');
    saveToken(db, userId, 'google-ads', {
      access_token:  tokenD.access_token,
      refresh_token: tokenD.refresh_token,
      expires_at:    Date.now() + (tokenD.expires_in || 3600) * 1000,
      scope:         tokenD.scope || '',
    });
    try { require('./showdown-ad-cap').discoverForUser?.(userId, 'google'); } catch(_) {}
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=google-ads&from=showdown`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}&platform=google-ads`);
  }
});

// ════════════════════════════════════════════════════════
// TIKTOK ADS — TikTok Marketing API, separate app from creator API
// Requires its own client key (TIKTOK_ADS_CLIENT_KEY) — this is a
// different developer registration than the organic-posting flow.
// ════════════════════════════════════════════════════════
router.get('/tiktok-ads/connect', authFromQuery, (req, res) => {
  const appId = process.env.TIKTOK_ADS_APP_ID;
  if (!appId) return res.status(500).json({ error: 'TIKTOK_ADS_APP_ID not configured' });
  const db    = getDb(); ensureTables(db);
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO social_oauth_states (state,user_id,platform,created_at) VALUES (?,?,?,datetime('now'))")
    .run(state, req.userId, 'tiktok-ads');
  const params = new URLSearchParams({
    app_id:       appId,
    redirect_uri: `${BACKEND_URL}/api/social/tiktok-ads/callback`,
    state,
  });
  // TikTok Business OAuth lives at a different domain from the creator one
  res.redirect(`https://business-api.tiktok.com/portal/auth?${params}`);
});

router.get('/tiktok-ads/callback', async (req, res) => {
  const { auth_code, code, state, error } = req.query;
  const authCode = auth_code || code;
  const db = getDb(); ensureTables(db);
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}&platform=tiktok-ads`);
  const stateRec = db.prepare("SELECT * FROM social_oauth_states WHERE state=? AND platform='tiktok-ads'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state&platform=tiktok-ads`);
  db.prepare("DELETE FROM social_oauth_states WHERE state=?").run(state);
  const userId = stateRec.user_id;
  try {
    const fetch2 = (await import('node-fetch')).default;
    const tokenR = await fetch2('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id:     process.env.TIKTOK_ADS_APP_ID,
        secret:     process.env.TIKTOK_ADS_APP_SECRET,
        auth_code:  authCode,
      })
    });
    const tokenD = await tokenR.json();
    if (tokenD.code !== 0 || !tokenD.data?.access_token) {
      throw new Error(tokenD.message || 'TikTok Ads token exchange failed');
    }
    saveToken(db, userId, 'tiktok-ads', {
      access_token: tokenD.data.access_token,
      // TikTok Business tokens don't expire on the standard OAuth path
      expires_at:   null,
      scope:        (tokenD.data.scope || []).join(','),
    });
    try { require('./showdown-ad-cap').discoverForUser?.(userId, 'tiktok'); } catch(_) {}
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=tiktok-ads&from=showdown`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}&platform=tiktok-ads`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// FOLLOWER STATS — live fetch per platform using the stored token, cached on row
// ──────────────────────────────────────────────────────────────────────────
async function fetchFollowers(platform, row) {
  try {
    const fetch2 = (await import('node-fetch')).default;
    const tok = row.access_token;
    if (!tok) return null;
    if (platform === 'meta') {
      const r = await fetch2(`https://graph.facebook.com/v19.0/${row.page_id}?fields=followers_count,fan_count&access_token=${tok}`);
      const d = await r.json(); if (!d || d.error) return null;
      const f = (d.followers_count != null) ? d.followers_count : (d.fan_count != null ? d.fan_count : null);
      return { followers: f, posts: null };
    }
    if (platform === 'instagram') {
      const r = await fetch2(`https://graph.facebook.com/v19.0/${row.page_id}?fields=instagram_business_account{followers_count,media_count}&access_token=${tok}`);
      const d = await r.json(); const ig = d && d.instagram_business_account; if (!ig) return null;
      return { followers: ig.followers_count != null ? ig.followers_count : null, posts: ig.media_count != null ? ig.media_count : null };
    }
    if (platform === 'tiktok') {
      const r = await fetch2('https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count,video_count', { headers: { Authorization: 'Bearer ' + tok } });
      const d = await r.json(); const u = d && d.data && d.data.user; if (!u) return null;
      return { followers: u.follower_count != null ? u.follower_count : null, posts: u.video_count != null ? u.video_count : null };
    }
    if (platform === 'x' || platform === 'twitter') {
      const r = await fetch2('https://api.twitter.com/2/users/me?user.fields=public_metrics', { headers: { Authorization: 'Bearer ' + tok } });
      const d = await r.json(); const m = d && d.data && d.data.public_metrics; if (!m) return null;
      return { followers: m.followers_count != null ? m.followers_count : null, posts: m.tweet_count != null ? m.tweet_count : null };
    }
    if (platform === 'youtube') {
      const r = await fetch2('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', { headers: { Authorization: 'Bearer ' + tok } });
      const d = await r.json(); const st = d && d.items && d.items[0] && d.items[0].statistics; if (!st) return null;
      return { followers: st.subscriberCount != null ? +st.subscriberCount : null, posts: st.videoCount != null ? +st.videoCount : null };
    }
    // linkedin: organisation followers need an org URN + r_organization_social — left to a dedicated flow, not faked
    return null;
  } catch (_) { return null; }
}

// GET /api/social/stats — cached follower counts per platform (+ totals); refreshes stale rows (>6h)
router.get('/stats', auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const rows = db.prepare("SELECT * FROM user_social_tokens WHERE user_id=?").all(req.userId);
    const STALE = 6 * 3600 * 1000;
    const platforms = {}; let totalFollowers = 0; let haveAny = false;
    for (const row of rows) {
      let followers = row.follower_count, posts = row.post_count;
      const last = row.last_synced ? Date.parse(row.last_synced + 'Z') : 0;
      if (!last || (Date.now() - last) > STALE) {
        const live = await fetchFollowers(row.platform, row);
        if (live) {
          if (live.followers != null) followers = live.followers;
          if (live.posts != null) posts = live.posts;
          try { db.prepare("UPDATE user_social_tokens SET follower_count=?, post_count=?, last_synced=datetime('now') WHERE id=?")
            .run(followers != null ? followers : null, posts != null ? posts : null, row.id); } catch (_) {}
        }
      }
      platforms[row.platform] = {
        connected: true,
        name: row.page_name || row.username || row.platform,
        followers: followers != null ? followers : null,
        posts: posts != null ? posts : null
      };
      if (typeof followers === 'number') { totalFollowers += followers; haveAny = true; }
    }
    res.json({ platforms, totals: { followers: haveAny ? totalFollowers : null } });
  } catch (e) { res.json({ platforms: {}, totals: { followers: null } }); }
});

// POST /api/social/sync — force-refresh follower counts from every connected platform
router.post('/sync', auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const rows = db.prepare("SELECT * FROM user_social_tokens WHERE user_id=?").all(req.userId);
    let synced = 0;
    for (const row of rows) {
      const live = await fetchFollowers(row.platform, row);
      if (live) {
        try { db.prepare("UPDATE user_social_tokens SET follower_count=?, post_count=?, last_synced=datetime('now') WHERE id=?")
          .run(live.followers != null ? live.followers : row.follower_count, live.posts != null ? live.posts : row.post_count, row.id); synced++; } catch (_) {}
      }
    }
    res.json({ ok: true, synced });
  } catch (e) { res.json({ ok: false, synced: 0 }); }
});

module.exports = router;
