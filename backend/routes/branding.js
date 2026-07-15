// ═══════════════════════════════════════════════════════════════════
// MINE — Per-account branding
//
// Stores per-user/agency brand assets (favicon, logo) in the
// `user_settings` table. Used as a cascade fallback when an individual
// site doesn't specify its own favicon, and overrides the
// platform-wide default in `platform_settings`.
//
// Resolution order at site-render time (in hosting.js):
//   1. site.favicon          (per-site, set in editor)
//   2. user_settings.BRAND_FAVICON (per-user/agency, set in Brand Kit)
//   3. platform_settings.BRAND_FAVICON  (platform default, set by admin)
//   4. emoji ⚡ SVG fallback
//
// Mounted at /api/branding
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { auth: requireAuth } = require('../middleware/auth');

function getDb(req) {
  return req.app.locals.db || require('../db/init').getDb();
}

// Whitelist of branding keys we let users set. Adding new ones here
// avoids becoming a free-form key-value endpoint.
const ALLOWED = new Set([
  'BRAND_FAVICON',
  'BRAND_LOGO',
  'BRAND_PRIMARY',
  'BRAND_SECONDARY',
  'BRAND_FONT',
]);

// ─── 1. GET /api/branding/me ─────────────────────────────────────────
// Returns this user/agency's brand assets, with the platform default
// shown as a fallback so the UI can preview which value will actually
// be applied if the user clears their override.
router.get('/me', requireAuth, (req, res) => {
  try {
    const db = getDb(req);
    const userRows = db.prepare(
      "SELECT key, value FROM user_settings WHERE user_id = ? AND key IN ('BRAND_FAVICON','BRAND_LOGO','BRAND_PRIMARY','BRAND_SECONDARY','BRAND_FONT')"
    ).all(String(req.userId));
    const user = {};
    userRows.forEach(r => { user[r.key] = r.value; });

    const platformRows = db.prepare(
      "SELECT key, value FROM platform_settings WHERE key IN ('BRAND_FAVICON','BRAND_LOGO','BRAND_PRIMARY','BRAND_SECONDARY','BRAND_FONT')"
    ).all();
    const platform = {};
    platformRows.forEach(r => { platform[r.key] = r.value; });

    res.json({ user, platform_defaults: platform });
  } catch (e) {
    console.error('[branding/me get]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 2. PUT /api/branding/me ─────────────────────────────────────────
// Body: { BRAND_FAVICON?: url, BRAND_LOGO?: url, BRAND_PRIMARY?: '#hex', ... }
// Pass null/'' to clear an override (falls back to platform default).
router.put('/me', requireAuth, (req, res) => {
  try {
    const db = getDb(req);
    const updates = [];
    const cleared = [];

    for (const [key, val] of Object.entries(req.body || {})) {
      if (!ALLOWED.has(key)) continue;
      if (val === null || val === '') {
        db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = ?").run(String(req.userId), key);
        cleared.push(key);
      } else {
        // SQLite UPSERT (8.x+ syntax compatible with better-sqlite3)
        db.prepare(`
          INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
          ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
        `).run(String(req.userId), key, String(val));
        updates.push(key);
      }
    }

    res.json({ success: true, updated: updates, cleared });
  } catch (e) {
    console.error('[branding/me put]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
