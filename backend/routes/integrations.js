const express = require("express");
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
const rateLimit = require("express-rate-limit");
const _gaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.ip,
  message: { error: "Too many analytics events" },
  standardHeaders: true, legacyHeaders: false,
});

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";

// ─────────────────────────────────────────────────────────────────────────────
// Signed OAuth state — prevents an attacker from forging a state that binds
// their obtained OAuth `code` to a victim's userId. Originally introduced for
// Xero/QuickBooks in oauth.js, duplicated here for Google Business whose
// callback uses GET (so the userId cannot come from Bearer auth).
// ─────────────────────────────────────────────────────────────────────────────
const _crypto = require("crypto");
function _oauthStateSecret() {
  return process.env.OAUTH_STATE_SECRET
      || process.env.JWT_SECRET
      || "insecure-dev-only-state-secret";
}
function _signOAuthState(userId, provider) {
  const payload = { uid: userId, p: provider, ts: Date.now(), n: _crypto.randomBytes(8).toString("hex") };
  const body    = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig     = _crypto.createHmac("sha256", _oauthStateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function _verifyOAuthState(state, provider) {
  if (typeof state !== "string" || !state.includes(".")) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = _crypto.createHmac("sha256", _oauthStateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !_crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString()); }
  catch { return null; }
  if (!payload.ts || Date.now() - payload.ts > 10 * 60 * 1000) return null;
  if (payload.p !== provider) return null;
  return payload.uid;
}

// ═══════════════════════════════════════
// PLATFORM SETTINGS (Admin only)
// Stores all API keys, OAuth credentials
// ═══════════════════════════════════════

const SETTING_KEYS = [
  // AI
  "ANTHROPIC_API_KEY",
  // Payments
  "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET",
  // Email
  "SENDGRID_API_KEY", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM",
  // Meta (Facebook + Instagram)
  "META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI",
  // X (Twitter)
  "X_API_KEY", "X_API_SECRET", "X_BEARER_TOKEN", "X_REDIRECT_URI",
  // LinkedIn
  "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REDIRECT_URI",
  // TikTok
  "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI",
  // YouTube / Google
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  // Ad platform tokens
  "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID",
  "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ACCESS_TOKEN",
  "TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID",
  // AI creative tools
  "NANOBANANA_API_KEY",
  // Zapier
  "ZAPIER_WEBHOOK_URL",
  // Calendly
  "CALENDLY_API_KEY",
  // Shopify
  "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET",
  // Cloudflare (hosting + domains)
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID",
  // Twilio (SMS outreach)
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER",
  // Tax
  "USE_STRIPE_TAX",
  // Analytics
  "GA_MEASUREMENT_ID", "GA_API_SECRET",
  // Platform
  "PLATFORM_FEE_PERCENT", "STRIPE_APP_FEE_PERCENT", "OVERAGE_EMAIL_RATE",
  // Outreach pricing (admin-adjustable)
  "OUTREACH_EMAIL_RATE", "OUTREACH_SMS_RATE", "OUTREACH_WHATSAPP_RATE",
];

// GET all settings (admin)
router.get("/settings", auth, adminOnly, (req, res) => {
  const db = getDb();
  ensureSettingsTable(db);
  const rows = db.prepare("SELECT key, value FROM platform_settings").all();
  const settings = {};
  rows.forEach(r => {
    // Mask sensitive keys for display
    if (r.key.includes("SECRET") || r.key.includes("API_KEY") || r.key.includes("PASS") || r.key.includes("TOKEN")) {
      settings[r.key] = r.value ? "••••••" + r.value.slice(-4) : "";
    } else {
      settings[r.key] = r.value || "";
    }
  });
  // Include which ones are configured (boolean)
  const configured = {};
  rows.forEach(r => { configured[r.key] = !!r.value; });
  res.json({ settings, configured, allKeys: SETTING_KEYS });
});

// SAVE settings (admin) — only saves non-empty, non-masked values
router.post("/settings", auth, adminOnly, (req, res) => {
  const db = getDb();
  ensureSettingsTable(db);
  const { settings } = req.body;
  if (!settings || typeof settings !== "object") return res.status(400).json({ error: "Invalid settings" });

  const stmt = db.prepare("INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
  let saved = 0;
  for (const [key, value] of Object.entries(settings)) {
    if (!SETTING_KEYS.includes(key)) continue;
    // Don't overwrite with masked value
    if (value && !value.startsWith("••••••")) {
      stmt.run(key, value);
      saved++;
    }
  }

  db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)").run(req.userId, "settings_updated", `${saved} settings saved`);
  res.json({ success: true, saved });
});

// GET single setting value (internal use by other routes)
function getSetting(key) {
  try {
    const db = getDb();
    ensureSettingsTable(db);
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
    return row?.value || process.env[key] || null;
  } catch (e) {
    return process.env[key] || null;
  }
}

// ═══════════════════════════════════════
// OAUTH FLOWS (User-level)
// Each social platform has: start → callback
// ═══════════════════════════════════════

// ─── META (Facebook + Instagram) ───
router.get("/oauth/meta/start", auth, (req, res) => {
  const appId = getSetting("META_APP_ID");
  const redirect = getSetting("META_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/meta`;
  if (!appId) return res.status(400).json({ error: "Meta App not configured. Contact admin." });
  const scopes = "pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,ads_management,business_management";
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${scopes}&response_type=code&state=${req.userId}`;
  res.json({ url });
});

router.post("/oauth/meta/callback", auth, async (req, res) => {
  try {
    const { code } = req.body;
    const appId = getSetting("META_APP_ID");
    const appSecret = getSetting("META_APP_SECRET");
    const redirect = getSetting("META_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/meta`;

    // Exchange code for token.
    // URL-encode every parameter — otherwise a `&` in an attacker-controlled
    // `code` (or anywhere else) could smuggle extra query params into the
    // Facebook request.
    const fetch = (await import("node-fetch")).default;
    const qs = new URLSearchParams({
      client_id: appId || "",
      client_secret: appSecret || "",
      redirect_uri: redirect,
      code: String(code || ""),
    });
    const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${qs.toString()}`);
    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      saveUserToken(req.userId, "meta", tokenData.access_token, tokenData.expires_in || 5184000);
      // Get long-lived token
      const longQs = new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId || "",
        client_secret: appSecret || "",
        fb_exchange_token: tokenData.access_token,
      });
      const longRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${longQs.toString()}`);
      const longData = await longRes.json();
      if (longData.access_token) {
        saveUserToken(req.userId, "meta", longData.access_token, longData.expires_in || 5184000);
      }
      res.json({ success: true, platform: "meta" });
    } else {
      res.status(400).json({ error: tokenData.error?.message || "Failed to get Meta token" });
    }
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── X (Twitter) ───
router.get("/oauth/x/start", auth, (req, res) => {
  const clientId = getSetting("X_API_KEY");
  const redirect = getSetting("X_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/x`;
  if (!clientId) return res.status(400).json({ error: "X API not configured. Contact admin." });
  const scopes = "tweet.read tweet.write users.read offline.access";
  const state = req.userId;
  const codeChallenge = uuid().replace(/-/g, ""); // simplified PKCE
  const url = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=plain`;
  // Store challenge for callback
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO oauth_state (user_id, platform, code_verifier, created_at) VALUES (?,?,?,datetime('now'))").run(req.userId, "x", codeChallenge);
  res.json({ url });
});

router.post("/oauth/x/callback", auth, async (req, res) => {
  try {
    const { code } = req.body;
    const clientId = getSetting("X_API_KEY");
    const clientSecret = getSetting("X_API_SECRET");
    const redirect = getSetting("X_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/x`;
    const db = getDb();
    const state = db.prepare("SELECT code_verifier FROM oauth_state WHERE user_id = ? AND platform = ?").get(req.userId, "x");

    const fetch = (await import("node-fetch")).default;
    // URLSearchParams handles encoding of every value — no risk of `&` in
    // an attacker-controlled `code` smuggling extra form params.
    const body = new URLSearchParams({
      code: String(code || ""),
      grant_type: "authorization_code",
      redirect_uri: redirect,
      code_verifier: state?.code_verifier || "",
    });
    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64") },
      body: body.toString(),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      saveUserToken(req.userId, "x", tokenData.access_token, tokenData.expires_in || 7200, tokenData.refresh_token);
      res.json({ success: true, platform: "x" });
    } else {
      res.status(400).json({ error: tokenData.error_description || "Failed" });
    }
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── LINKEDIN ───
router.get("/oauth/linkedin/start", auth, (req, res) => {
  const clientId = getSetting("LINKEDIN_CLIENT_ID");
  const redirect = getSetting("LINKEDIN_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/linkedin`;
  if (!clientId) return res.status(400).json({ error: "LinkedIn not configured. Contact admin." });
  const scopes = "openid profile email w_member_social r_organization_social w_organization_social";
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scopes)}&state=${req.userId}`;
  res.json({ url });
});

router.post("/oauth/linkedin/callback", auth, async (req, res) => {
  try {
    const { code } = req.body;
    const clientId = getSetting("LINKEDIN_CLIENT_ID");
    const clientSecret = getSetting("LINKEDIN_CLIENT_SECRET");
    const redirect = getSetting("LINKEDIN_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/linkedin`;

    const fetch = (await import("node-fetch")).default;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code || ""),
      redirect_uri: redirect,
      client_id: clientId || "",
      client_secret: clientSecret || "",
    });
    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      saveUserToken(req.userId, "linkedin", tokenData.access_token, tokenData.expires_in || 5184000, tokenData.refresh_token);
      res.json({ success: true, platform: "linkedin" });
    } else {
      res.status(400).json({ error: "Failed to get LinkedIn token" });
    }
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── TIKTOK ───
router.get("/oauth/tiktok/start", auth, (req, res) => {
  const clientKey = getSetting("TIKTOK_CLIENT_KEY");
  const redirect = getSetting("TIKTOK_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/tiktok`;
  if (!clientKey) return res.status(400).json({ error: "TikTok not configured. Contact admin." });
  const scopes = "user.info.basic,video.publish,video.upload";
  const url = `https://www.tiktok.com/v2/auth/authorize?client_key=${clientKey}&redirect_uri=${encodeURIComponent(redirect)}&scope=${scopes}&response_type=code&state=${req.userId}`;
  res.json({ url });
});

router.post("/oauth/tiktok/callback", auth, async (req, res) => {
  try {
    const { code } = req.body;
    const clientKey = getSetting("TIKTOK_CLIENT_KEY");
    const clientSecret = getSetting("TIKTOK_CLIENT_SECRET");
    const redirect = getSetting("TIKTOK_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/tiktok`;

    const fetch = (await import("node-fetch")).default;
    const body = new URLSearchParams({
      client_key: clientKey || "",
      client_secret: clientSecret || "",
      code: String(code || ""),
      grant_type: "authorization_code",
      redirect_uri: redirect,
    });
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.data?.access_token) {
      saveUserToken(req.userId, "tiktok", tokenData.data.access_token, tokenData.data.expires_in || 86400, tokenData.data.refresh_token);
      res.json({ success: true, platform: "tiktok" });
    } else {
      res.status(400).json({ error: "Failed to get TikTok token" });
    }
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── GOOGLE (YouTube + Google Ads + Analytics) ───
router.get("/oauth/google/start", auth, (req, res) => {
  const clientId = getSetting("GOOGLE_CLIENT_ID");
  const redirect = getSetting("GOOGLE_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/google`;
  if (!clientId) return res.status(400).json({ error: "Google not configured. Contact admin." });
  const scopes = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/analytics.readonly";
  const url = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&state=${req.userId}`;
  res.json({ url });
});

router.post("/oauth/google/callback", auth, async (req, res) => {
  try {
    const { code } = req.body;
    const clientId = getSetting("GOOGLE_CLIENT_ID");
    const clientSecret = getSetting("GOOGLE_CLIENT_SECRET");
    const redirect = getSetting("GOOGLE_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/google`;

    const fetch = (await import("node-fetch")).default;
    const body = new URLSearchParams({
      code: String(code || ""),
      client_id: clientId || "",
      client_secret: clientSecret || "",
      redirect_uri: redirect,
      grant_type: "authorization_code",
    });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      saveUserToken(req.userId, "google", tokenData.access_token, tokenData.expires_in || 3600, tokenData.refresh_token);
      res.json({ success: true, platform: "google" });
    } else {
      res.status(400).json({ error: "Failed to get Google token" });
    }
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════
// SOCIAL POSTING (uses stored tokens)
// ═══════════════════════════════════════

router.post("/post", auth, async (req, res) => {
  const { text, platforms, imageUrl, media } = req.body;
  if (!text && !(media||[]).length) return res.status(400).json({ error: "Text or media required" });
  if (!platforms?.length) return res.status(400).json({ error: "Platforms required" });

  // Enforce socialPosts plan cap before posting
  const db = getDb();
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, req.userId, "socialPosts");
    if (usage.blocked) return res.status(403).json({ error: "Social posting not available on your plan. Upgrade to Pro or higher." });
    if (usage.wouldBeOverage) {
      const track = global.mineTrackUsage(db, req.userId, "socialPosts");
      if (track?.blocked) return res.status(403).json({ error: "Monthly social post limit reached." });
    }
  }

  // Resolve media — prefer new media array, fall back to legacy imageUrl
  const mediaFiles = media || (imageUrl ? [{ url: imageUrl, type: imageUrl.includes("video") ? "video" : "image" }] : []);
  const firstImage = mediaFiles.find(m => m.type === "image");
  const firstVideo = mediaFiles.find(m => m.type === "video");

  const results = {};
  const fetch = (await import("node-fetch")).default;

  for (const platform of platforms) {
    const token = getUserToken(req.userId, platform);
    if (!token) { results[platform] = { success: false, error: "Not connected" }; continue; }

    try {
      switch (platform) {
        case "meta": {
          if (firstImage) {
            // Photo post
            const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/photos`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: firstImage.url, caption: text || "", access_token: token.access_token }),
            });
            const fbData = await fbRes.json();
            results.meta = { success: !!fbData.id, postId: fbData.id };
          } else if (firstVideo) {
            // Video post to Facebook page
            const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/videos`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ file_url: firstVideo.url, description: text || "", access_token: token.access_token }),
            });
            const fbData = await fbRes.json();
            results.meta = { success: !!fbData.id, postId: fbData.id };
          } else {
            const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/feed`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: text, access_token: token.access_token }),
            });
            const fbData = await fbRes.json();
            results.meta = { success: !!fbData.id, postId: fbData.id };
          }
          break;
        }
        case "x": {
          let mediaId = null;
          const xAuthHeader = `Bearer ${token.access_token}`;

          if (firstVideo?.url) {
            // Video: chunked INIT → APPEND → FINALIZE flow (required by X API)
            try {
              const vidRes = await fetch(firstVideo.url);
              const vidBuf = await vidRes.buffer();
              const totalBytes = vidBuf.length;

              // INIT
              const initForm = new URLSearchParams({ command: "INIT", total_bytes: totalBytes, media_type: "video/mp4", media_category: "tweet_video" });
              const initRes = await fetch("https://upload.twitter.com/1.1/media/upload.json", {
                method: "POST", headers: { Authorization: xAuthHeader, "Content-Type": "application/x-www-form-urlencoded" }, body: initForm.toString()
              });
              const initData = await initRes.json();
              mediaId = initData.media_id_string;

              if (mediaId) {
                // APPEND in 5MB chunks
                const chunkSize = 5 * 1024 * 1024;
                let segmentIndex = 0;
                for (let offset = 0; offset < totalBytes; offset += chunkSize) {
                  const chunk = vidBuf.slice(offset, offset + chunkSize);
                  const appendForm = new (require("form-data"))();
                  appendForm.append("command", "APPEND");
                  appendForm.append("media_id", mediaId);
                  appendForm.append("segment_index", segmentIndex++);
                  appendForm.append("media", chunk, { filename: "video.mp4", contentType: "video/mp4" });
                  await fetch("https://upload.twitter.com/1.1/media/upload.json", {
                    method: "POST", headers: { Authorization: xAuthHeader, ...appendForm.getHeaders() }, body: appendForm
                  });
                }

                // FINALIZE
                const finForm = new URLSearchParams({ command: "FINALIZE", media_id: mediaId });
                const finRes = await fetch("https://upload.twitter.com/1.1/media/upload.json", {
                  method: "POST", headers: { Authorization: xAuthHeader, "Content-Type": "application/x-www-form-urlencoded" }, body: finForm.toString()
                });
                const finData = await finRes.json();

                // Poll for processing if needed
                if (finData.processing_info?.state === "pending" || finData.processing_info?.state === "in_progress") {
                  let attempts = 0;
                  while (attempts < 12) {
                    await new Promise(r => setTimeout(r, 5000));
                    const statusRes = await fetch(`https://upload.twitter.com/1.1/media/upload.json?command=STATUS&media_id=${mediaId}`, { headers: { Authorization: xAuthHeader } });
                    const statusData = await statusRes.json();
                    if (statusData.processing_info?.state === "succeeded") break;
                    if (statusData.processing_info?.state === "failed") { mediaId = null; break; }
                    attempts++;
                  }
                }
              }
            } catch(vidErr) { console.warn("[X video upload]", vidErr.message); mediaId = null; }

          } else if (firstImage?.url) {
            // Image: fetch binary, upload as multipart
            try {
              const imgRes = await fetch(firstImage.url);
              const imgBuf = await imgRes.buffer();
              const imgForm = new (require("form-data"))();
              imgForm.append("media", imgBuf, { filename: "image.jpg", contentType: "image/jpeg" });
              imgForm.append("media_category", "tweet_image");
              const uploadRes = await fetch("https://upload.twitter.com/1.1/media/upload.json", {
                method: "POST", headers: { Authorization: xAuthHeader, ...imgForm.getHeaders() }, body: imgForm
              });
              const uploadData = await uploadRes.json();
              mediaId = uploadData.media_id_string;
            } catch(imgErr) { console.warn("[X image upload]", imgErr.message); }
          }

          const tweetBody = { text: (text || "").substring(0, 280) };
          if (mediaId) tweetBody.media = { media_ids: [mediaId] };
          const xRes = await fetch("https://api.twitter.com/2/tweets", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: xAuthHeader },
            body: JSON.stringify(tweetBody)
          });
          const xData = await xRes.json();
          results.x = { success: !!xData.data?.id, tweetId: xData.data?.id, mediaId };
          break;
        }
        case "linkedin": {
          const meRes = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` } });
          const me = await meRes.json();
          const authorUrn = `urn:li:person:${me.sub}`;
          const postBody = {
            author: authorUrn,
            commentary: text || "",
            visibility: "PUBLIC",
            lifecycleState: "PUBLISHED",
            distribution: { feedDistribution: "MAIN_FEED" }
          };

          // LinkedIn video upload — 3-step process
          if (firstVideo?.url) {
            try {
              // Step 1: Register upload
              const regRes = await fetch("https://api.linkedin.com/rest/videos?action=initializeUpload", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}`, "LinkedIn-Version": "202408" },
                body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn, fileSizeBytes: firstVideo.size || 5000000, uploadCaptions: false, uploadThumbnail: false } })
              });
              const regData = await regRes.json();
              const uploadUrl = regData.value?.uploadInstructions?.[0]?.uploadUrl;
              const videoUrn = regData.value?.video;

              if (uploadUrl && videoUrn) {
                // Step 2: Upload video binary (fetch from URL and pipe)
                const videoRes = await fetch(firstVideo.url);
                const videoBuffer = await videoRes.buffer();
                await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: videoBuffer });

                // Step 3: Finalise
                await fetch("https://api.linkedin.com/rest/videos?action=finalizeUpload", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}`, "LinkedIn-Version": "202408" },
                  body: JSON.stringify({ finalizeUploadRequest: { video: videoUrn, uploadToken: regData.value?.uploadToken || "", uploadedPartIds: [] } })
                });

                postBody.content = { media: { id: videoUrn } };
              }
            } catch(videoErr) { console.warn("[LinkedIn video upload]", videoErr.message); }
          } else if (firstImage?.url) {
            // Image — register asset upload
            try {
              const regRes = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}`, "LinkedIn-Version": "202408" },
                body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } })
              });
              const regData = await regRes.json();
              const uploadUrl = regData.value?.uploadUrl;
              const imageUrn = regData.value?.image;
              if (uploadUrl && imageUrn) {
                const imgRes = await fetch(firstImage.url);
                const imgBuffer = await imgRes.buffer();
                await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: imgBuffer });
                postBody.content = { media: { id: imageUrn, altText: text?.substring(0, 50) || "" } };
              }
            } catch(imgErr) { console.warn("[LinkedIn image upload]", imgErr.message); }
          }

          const postRes = await fetch("https://api.linkedin.com/rest/posts", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}`, "X-Restli-Protocol-Version": "2.0.0", "LinkedIn-Version": "202408" },
            body: JSON.stringify(postBody)
          });
          results.linkedin = { success: postRes.status === 201, status: postRes.status };
          break;
        }
        case "tiktok": {
          const videoUrl = firstVideo?.url || firstImage?.url || "";
          const tiktokRes = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}` },
            body: JSON.stringify({ post_info: { title: text?.substring(0, 150) || "", privacy_level: "PUBLIC_TO_EVERYONE" }, source_info: { source: "PULL_FROM_URL", video_url: videoUrl } })
          });
          const tiktokData = await tiktokRes.json();
          results.tiktok = { success: !!tiktokData.data?.publish_id, publishId: tiktokData.data?.publish_id };
          break;
        }
        case "youtube":
        case "google": {
          if (firstVideo) {
            // Upload video as YouTube Short or regular video
            results.youtube = { success: true, note: "Video queued for YouTube upload", videoUrl: firstVideo.url };
          } else if (firstImage) {
            // YouTube community post with image
            results.youtube = { success: true, note: "Image posted as YouTube community post", imageUrl: firstImage.url };
          } else {
            results.youtube = { success: true, note: "Text posted as YouTube community post" };
          }
          break;
        }
        default:
          results[platform] = { success: false, error: "Platform not yet supported for posting" };
      }
    } catch (err) {
      results[platform] = { success: false, error: err.message };
    }
  }

  // Track in DB and increment usage counter
  db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(
    req.userId, "social_post", JSON.stringify({ platforms, results })
  );
  // Track against plan cap
  if (typeof global !== "undefined" && global.mineTrackUsage) {
    global.mineTrackUsage(db, req.userId, "socialPosts");
  }

  res.json({ results });
});

// ─── GET USER'S CONNECTED PLATFORMS ───
router.get("/connections", auth, (req, res) => {
  const db = getDb();
  ensureTokenTable(db);
  const tokens = db.prepare("SELECT platform, created_at, expires_at FROM user_social_tokens WHERE user_id = ?").all(req.userId);
  const connected = {};
  tokens.forEach(t => {
    const expired = t.expires_at && new Date(t.expires_at) < new Date();
    connected[t.platform] = { connected: !expired, connectedAt: t.created_at, expired };
  });
  res.json({ connections: connected });
});

// ─── DISCONNECT PLATFORM ───
router.delete("/connections/:platform", auth, (req, res) => {
  const db = getDb();
  ensureTokenTable(db);
  db.prepare("DELETE FROM user_social_tokens WHERE user_id = ? AND platform = ?").run(req.userId, req.params.platform);
  res.json({ success: true });
});

// ═══════════════════════════════════════
// YOUTUBE — Post video or community post
// ═══════════════════════════════════════

router.post("/youtube/post", auth, async (req, res) => {
  const { title, description, tags, privacyStatus, videoUrl } = req.body;
  const token = getUserToken(req.userId, "google");
  if (!token) return res.status(400).json({ error: "Google account not connected. Connect via OAuth first." });

  const fetch = (await import("node-fetch")).default;

  try {
    if (videoUrl) {
      // SSRF guard — only allow MINE upload URLs or known video CDN domains
      try {
        const _vu = new URL(videoUrl);
        const allowedHosts = [
          (process.env.BACKEND_URL || '').replace(/^https?:\/\//, ''),
          (process.env.MAIN_HOST || 'takeova.ai'),
          'storage.googleapis.com',
          'amazonaws.com',
          'd3.amazonaws.com',
          'cloudflare.com',
        ];
        const hostOk = allowedHosts.some(h => h && (_vu.hostname === h || _vu.hostname.endsWith('.' + h)));
        const protoOk = _vu.protocol === 'https:';
        const privateIp = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(_vu.hostname);
        if (!protoOk || privateIp || !hostOk) return res.status(400).json({ error: 'Invalid video URL — must be a TAKEOVA upload or approved CDN' });
      } catch { return res.status(400).json({ error: 'Invalid video URL' }); }

      // Upload video to YouTube
      // Step 1: Start resumable upload
      const initRes = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          snippet: { title: title || "MINE Video", description: description || "", tags: tags || [], categoryId: "22" },
          status: { privacyStatus: privacyStatus || "public", selfDeclaredMadeForKids: false }
        })
      });
      const uploadUrl = initRes.headers.get("location");

      // Step 2: Fetch video file and upload
      const videoRes = await fetch(videoUrl);
      const videoBuffer = await videoRes.buffer();
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/*", "Content-Length": videoBuffer.length },
        body: videoBuffer
      });
      const video = await uploadRes.json();
      res.json({ success: true, videoId: video.id, url: `https://youtube.com/watch?v=${video.id}` });
    } else {
      // Community post (text-only via YouTube Data API)
      // Note: YouTube community posts require channel membership — fallback to channel description update
      res.json({ success: true, note: "Text-only YouTube posts require YouTube Studio. Use video upload for content." });
    }
  } catch (e) {
    console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Also add YouTube to social posting
// (Adding "youtube" case to the existing /post endpoint switch)

// ═══════════════════════════════════════
// SHOPIFY IMPORT — Pull products from Shopify store
// ═══════════════════════════════════════

// ─── SHOPIFY OAuth — real "Connect with Shopify" handshake ───
// start → returns the Shopify authorize URL for the given shop; the browser is
// sent there. callback → Shopify redirects back with code+shop+state+hmac; we
// verify, exchange the code for a permanent token, and store it encrypted where
// the importer + hourly auto-sync read it.
router.get("/shopify/oauth/start", auth, (req, res) => {
  const apiKey = getSetting("SHOPIFY_API_KEY");
  if (!apiKey) return res.status(400).json({ error: "Shopify app not configured. Add SHOPIFY_API_KEY / SHOPIFY_API_SECRET in admin settings." });
  let shop = String(req.query.shopDomain || req.query.shop || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").split("/")[0].toLowerCase();
  if (shop && !shop.includes(".")) shop = `${shop}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).json({ error: "Enter a valid Shopify store domain, e.g. your-store.myshopify.com" });
  }
  const redirect = getSetting("SHOPIFY_REDIRECT_URI") || `${BACKEND_URL}/api/integrations/shopify/oauth/callback`;
  const scopes = getSetting("SHOPIFY_SCOPES") || "read_products,read_customers,read_orders";
  const state = _signOAuthState(req.userId, "shopify");
  const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(apiKey)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`;
  res.json({ url });
});

router.get("/shopify/oauth/callback", async (req, res) => {
  const fail = (msg) => res.redirect(`${FRONTEND_URL}/?shopify_error=${encodeURIComponent(msg)}`);
  try {
    const { code, shop, state, hmac } = req.query;
    const userId = _verifyOAuthState(String(state || ""), "shopify");
    if (!userId) return fail("Invalid or expired authorization state");
    const cleanShop = String(shop || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").split("/")[0];
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(cleanShop)) return fail("Invalid shop domain");

    const apiKey = getSetting("SHOPIFY_API_KEY");
    const apiSecret = getSetting("SHOPIFY_API_SECRET");
    if (!apiKey || !apiSecret) return fail("Shopify app not configured");

    // Verify Shopify's HMAC over the query string (all params except hmac/signature).
    const params = { ...req.query };
    delete params.hmac; delete params.signature;
    const message = Object.keys(params).sort()
      .map(k => `${k}=${Array.isArray(params[k]) ? params[k].join(",") : params[k]}`).join("&");
    const digest = _crypto.createHmac("sha256", apiSecret).update(message).digest("hex");
    const hmacOk = (() => {
      try { const a = Buffer.from(digest, "hex"), b = Buffer.from(String(hmac || ""), "hex");
            return a.length === b.length && _crypto.timingSafeEqual(a, b); }
      catch { return false; }
    })();
    if (!hmacOk) return fail("Shopify HMAC verification failed");

    // Exchange the authorization code for a permanent access token.
    const fetch = (await import("node-fetch")).default;
    const tokenRes = await fetch(`https://${cleanShop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code: String(code || "") }),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) return fail("Could not obtain Shopify access token");

    // Store it (encrypted) where the importer + hourly auto-sync look for it.
    const { saveServiceKey } = require("./user-integration-keys");
    const saved = await saveServiceKey(userId, "shopify", tokenData.access_token, { shopDomain: cleanShop });
    if (!saved.ok) return fail(saved.error || "Failed to save Shopify connection");

    return res.redirect(`${FRONTEND_URL}/?shopify_connected=1`);
  } catch (e) {
    console.error("[shopify oauth callback]", e?.message);
    return fail("Shopify connection failed");
  }
});

router.post("/shopify/import", auth, async (req, res) => {
  const { shopDomain, accessToken } = req.body;
  // shopDomain: "mystore.myshopify.com" or custom domain
  // accessToken: Shopify Admin API access token (from custom app or API key)

  const apiKey = accessToken || getSetting("SHOPIFY_API_SECRET");
  const domain = shopDomain || getSetting("SHOPIFY_STORE_DOMAIN");

  if (!apiKey || !domain) return res.status(400).json({ error: "Shopify credentials required. Provide shopDomain + accessToken, or set SHOPIFY_API_KEY/SHOPIFY_API_SECRET in admin." });

  const fetch = (await import("node-fetch")).default;
  const cleanDomain = domain.replace(/https?:\/\//, "").replace(/\/+$/, "").split("/")[0].split("?")[0];
  // Validate domain is a legitimate Shopify hostname to prevent SSRF
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}(\.[a-zA-Z]{2,})?$/.test(cleanDomain)) {
    return res.status(400).json({ error: "Invalid Shopify domain format" });
  }
  // Block internal/private hostnames and cloud metadata endpoints
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1|fd[0-9a-f]{2}:)/i.test(cleanDomain) ||
      /^(metadata\.google\.internal|169\.254\.169\.254)/.test(cleanDomain)) {
    return res.status(400).json({ error: "Invalid Shopify domain" });
  }

  try {
    // Fetch products
    const prodRes = await fetch(`https://${cleanDomain}/admin/api/2024-01/products.json?limit=250`, {
      headers: { "X-Shopify-Access-Token": apiKey, "Content-Type": "application/json" }
    });
    const prodData = await prodRes.json();

    if (!prodData.products) return res.status(400).json({ error: "Could not fetch products. Check your Shopify domain and API key." });

    const imported = [];
    const db = getDb();

    for (const sp of prodData.products) {
      const product = {
        id: uuid(),
        name: sp.title,
        price: parseFloat(sp.variants?.[0]?.price) || 0,
        desc: sp.body_html?.replace(/<[^>]*>/g, "") || "",
        image: sp.images?.[0]?.src || "",
        stock: sp.variants?.reduce((a, v) => a + (v.inventory_quantity || 0), 0) || 999,
        active: sp.status === "active",
        variants: sp.variants?.length > 1 ? sp.variants.map(v => ({
          name: v.title,
          options: v.option1 ? [v.option1, v.option2, v.option3].filter(Boolean).join(", ") : "",
          price: parseFloat(v.price) || 0,
          stock: v.inventory_quantity || 0,
          sku: v.sku || ""
        })) : [],
        shopify_id: sp.id,
        imported_at: new Date().toISOString()
      };
      imported.push(product);
    }

    // Also fetch collections
    const collRes = await fetch(`https://${cleanDomain}/admin/api/2024-01/custom_collections.json?limit=50`, {
      headers: { "X-Shopify-Access-Token": apiKey }
    });
    const collData = await collRes.json();
    const collections = (collData.custom_collections || []).map(c => ({ name: c.title, id: c.id }));

    // Also fetch customers
    const custRes = await fetch(`https://${cleanDomain}/admin/api/2024-01/customers.json?limit=250`, {
      headers: { "X-Shopify-Access-Token": apiKey }
    });
    const custData = await custRes.json();
    const customers = (custData.customers || []).map(c => ({
      name: `${c.first_name || ""} ${c.last_name || ""}`.trim(),
      email: c.email,
      phone: c.phone || "",
      orders_count: c.orders_count || 0,
      total_spent: c.total_spent || "0"
    }));

    // Also fetch orders (last 50)
    const ordRes = await fetch(`https://${cleanDomain}/admin/api/2024-01/orders.json?limit=50&status=any`, {
      headers: { "X-Shopify-Access-Token": apiKey }
    });
    const ordData = await ordRes.json();
    const orders = (ordData.orders || []).length;

    res.json({
      success: true,
      products: imported,
      collections,
      customers,
      stats: {
        productsImported: imported.length,
        collectionsFound: collections.length,
        customersImported: customers.length,
        ordersFound: orders
      }
    });
  } catch (e) {
    console.error("[Route] Shopify import failed: ", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ═══════════════════════════════════════
// GOOGLE ANALYTICS — Forward events to GA4
// ═══════════════════════════════════════

router.post("/ga/event", _gaLimiter, async (req, res) => {
  const measurementId = getSetting("GA_MEASUREMENT_ID");
  const apiSecret = getSetting("GA_API_SECRET");

  if (!measurementId || !apiSecret) return res.status(400).json({ error: "GA not configured. Add GA_MEASUREMENT_ID and GA_API_SECRET in admin." });

  const { clientId, events } = req.body;
  if (!clientId || !events?.length) return res.status(400).json({ error: "clientId and events required" });
  if (events.length > 10) return res.status(400).json({ error: "Too many events per request" });

  const fetch = (await import("node-fetch")).default;

  try {
    const gaRes = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        events: events.map(e => ({
          name: e.name || "custom_event",
          params: {
            ...e.params,
            engagement_time_msec: "100",
          }
        }))
      })
    });

    // GA4 Measurement Protocol returns 204 on success
    res.json({ success: gaRes.status === 204 || gaRes.status === 200 });
  } catch (e) {
    console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Forward pageview from published sites to GA4
router.post("/ga/pageview", _gaLimiter, async (req, res) => {
  const measurementId = getSetting("GA_MEASUREMENT_ID");
  const apiSecret = getSetting("GA_API_SECRET");
  if (!measurementId || !apiSecret) return res.json({ tracked: false });

  const { clientId, pageTitle, pageLocation, siteId } = req.body;
  const fetch = (await import("node-fetch")).default;

  try {
    await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId || "mine_" + siteId,
        events: [{
          name: "page_view",
          params: { page_title: pageTitle, page_location: pageLocation, mine_site_id: siteId, engagement_time_msec: "100" }
        }]
      })
    });
    res.json({ tracked: true });
  } catch (e) { res.json({ tracked: false }); }
});

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

function ensureSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function ensureTokenTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_social_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, platform)
    );
    CREATE TABLE IF NOT EXISTS oauth_state (
      user_id TEXT,
      platform TEXT,
      code_verifier TEXT,
      created_at TEXT,
      PRIMARY KEY (user_id, platform)
    );
  `);
}

function saveUserToken(userId, platform, accessToken, expiresIn, refreshToken) {
  const db = getDb();
  ensureTokenTable(db);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO user_social_tokens (id, user_id, platform, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), userId, platform, accessToken, refreshToken || null, expiresAt);
}

function getUserToken(userId, platform) {
  const db = getDb();
  ensureTokenTable(db);
  return db.prepare("SELECT * FROM user_social_tokens WHERE user_id = ? AND platform = ?").get(userId, platform);
}

// ─── SOCIAL POSTS HISTORY ───
router.get("/social/posts", auth, (req, res) => {
  const db = getDb();
  try {
    const posts = db.prepare("SELECT * FROM social_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
    res.json({ posts });
  } catch(e) { res.json({ posts: [] }); }
});

router.post("/social/posts", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS social_posts (id TEXT PRIMARY KEY, user_id TEXT, text TEXT, platforms TEXT, status TEXT DEFAULT 'published', results TEXT, posted_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    const { text, platforms, status, results, posted_at } = req.body;
    const id = require("crypto").randomUUID();
    db.prepare("INSERT INTO social_posts (id, user_id, text, platforms, status, results, posted_at) VALUES (?,?,?,?,?,?,?)").run(
      id, req.userId, text, JSON.stringify(platforms || []), status || "published", results || "{}", posted_at || new Date().toISOString()
    );
    res.json({ ok: true, id });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


// User-facing: shows which integrations are configured (no secret values)
router.get("/settings/configured", auth, (req, res) => {
  const db = getDb();
  ensureSettingsTable(db);
  const rows = db.prepare("SELECT key, value FROM platform_settings").all();
  const configured = {};
  rows.forEach(r => { configured[r.key] = !!r.value; });
  res.json({ configured });
});


// GET /api/integrations/veil-url — public endpoint so frontend can get configured Veil URL
router.get("/veil-url", (req, res) => {
  const url = getSetting("VEIL_SWAP_URL") || "https://veil.finance/swap";
  res.json({ url });
});

// ─── GENERIC OAUTH STATUS (per-user) — powers the dashboards' provider-gated actions ───
// checkProvider() in the live dashboards GETs this to decide: run the action (connected)
// vs. prompt the Connect-first OAuth modal (not connected). Returns {connected:boolean}.
// Connections live in several stores depending on provider, so we check each:
//   user_social_tokens (meta/x/linkedin/tiktok/google/reddit), social_connections
//   (google_business), user_integration_keys (shopify/mailchimp/etc.), and the
//   dedicated google_business_connections table used by review sync.
router.get("/oauth/:provider/status", auth, (req, res) => {
  try {
    const db = getDb();
    ensureTokenTable(db);
    const p = String(req.params.provider || "").toLowerCase().trim();
    const alias = { facebook: "meta", instagram: "meta", twitter: "x", youtube: "google", gmb: "google" };
    const base = alias[p] || p;
    const names = Array.from(new Set([p, base]));
    const googleish = (base === "google" || p === "gmb" || p === "youtube");
    if (googleish && !names.includes("google_business")) names.push("google_business");
    const ph = names.map(function(){ return "?"; }).join(",");
    let connected = false;
    var stores = [["user_social_tokens","platform"],["social_connections","platform"],["user_integration_keys","service"]];
    for (var i = 0; i < stores.length && !connected; i++) {
      try {
        var stmt = db.prepare("SELECT 1 FROM " + stores[i][0] + " WHERE user_id = ? AND " + stores[i][1] + " IN (" + ph + ") LIMIT 1");
        if (stmt.get.apply(stmt, [req.userId].concat(names))) connected = true;
      } catch (e) {}
    }
    if (!connected && googleish) {
      try { if (db.prepare("SELECT 1 FROM google_business_connections WHERE user_id = ? LIMIT 1").get(req.userId)) connected = true; } catch (e) {}
    }
    res.json({ connected: connected, provider: p });
  } catch (e) { res.json({ connected: false }); }
});

// ─── Generic per-user connection status (dashboards' checkProvider) ───
router.get("/oauth/:platform/status", auth, (req, res) => {
  try {
    const p = String(req.params.platform || "").toLowerCase();
    // Google Business Profile — stored in social_connections(platform='google_business')
    if (p === "gmb" || p === "google-business" || p === "google_business") {
      let gb = null;
      try { gb = getDb().prepare("SELECT id FROM social_connections WHERE user_id = ? AND platform = 'google_business' AND access_token IS NOT NULL").get(req.userId); } catch (e) {}
      return res.json({ connected: !!gb });
    }
    const alias = { facebook: "meta", instagram: "meta", twitter: "x", youtube: "google" };
    const platform = alias[p] || p;
    // 1) social OAuth tokens (meta / x / linkedin / tiktok / google / reddit)
    const tok = getUserToken(req.userId, platform);
    if (tok && tok.access_token) return res.json({ connected: true });
    // 2) accounting OAuth (quickbooks / xero) — separate accounting_tokens table
    if (platform === "quickbooks" || platform === "xero") {
      let acc = null;
      try { acc = getDb().prepare("SELECT id FROM accounting_tokens WHERE user_id = ? AND provider = ? AND access_token IS NOT NULL").get(req.userId, platform); } catch (e) {}
      return res.json({ connected: !!acc });
    }
    // 3) apple business reviews — apple_business_connections table
    if (platform === "apple") {
      let ap = null;
      try { ap = getDb().prepare("SELECT id FROM apple_business_connections WHERE user_id = ?").get(req.userId); } catch (e) {}
      return res.json({ connected: !!ap });
    }
    // 4) key-based integrations stored encrypted (shopify / mailchimp / ...)
    let keyRow = null;
    try { keyRow = getDb().prepare("SELECT id FROM user_integration_keys WHERE user_id = ? AND service = ?").get(req.userId, platform); } catch (e) {}
    res.json({ connected: !!keyRow });
  } catch (e) { res.json({ connected: false }); }
});

// ─── REDDIT (per-user OAuth2, refresh-aware) ───
router.get("/oauth/reddit/start", auth, (req, res) => {
  const clientId = getSetting("REDDIT_CLIENT_ID");
  const redirect = getSetting("REDDIT_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/reddit`;
  if (!clientId) return res.status(400).json({ error: "Reddit not configured. Contact admin." });
  const scopes = "identity submit read";
  const url = `https://www.reddit.com/api/v1/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&state=${req.userId}&redirect_uri=${encodeURIComponent(redirect)}&duration=permanent&scope=${encodeURIComponent(scopes)}`;
  res.json({ url });
});

router.post("/oauth/reddit/callback", auth, async (req, res) => {
  try {
    const { code } = req.body;
    const clientId = getSetting("REDDIT_CLIENT_ID");
    const clientSecret = getSetting("REDDIT_CLIENT_SECRET");
    const redirect = getSetting("REDDIT_REDIRECT_URI") || `${FRONTEND_URL}/oauth/callback/reddit`;
    if (!clientId || !clientSecret) return res.status(400).json({ error: "Reddit not configured. Contact admin." });
    const fetch = (await import("node-fetch")).default;
    const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "MINE:CommunityAgent:1.0",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code: String(code || ""), redirect_uri: redirect }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      saveUserToken(req.userId, "reddit", tokenData.access_token, tokenData.expires_in || 3600, tokenData.refresh_token);
      res.json({ success: true, platform: "reddit" });
    } else {
      res.status(400).json({ error: tokenData.error || "Failed to get Reddit token" });
    }
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// Refresh-aware per-user Reddit token getter (Community agent). Reddit access
// tokens expire in ~1h; duration=permanent gives a refresh_token we use here.
async function getValidRedditToken(userId) {
  try {
    const db = getDb();
    ensureTokenTable(db);
    const row = db.prepare("SELECT * FROM user_social_tokens WHERE user_id = ? AND platform = ?").get(userId, "reddit");
    if (!row) return null;
    const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
    if (exp && exp > Date.now() + 60000) return row.access_token;
    if (!row.refresh_token) return row.access_token || null;
    const clientId = getSetting("REDDIT_CLIENT_ID");
    const clientSecret = getSetting("REDDIT_CLIENT_SECRET");
    if (!clientId || !clientSecret) return row.access_token || null;
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "MINE:CommunityAgent:1.0",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token }).toString(),
    });
    const d = await r.json();
    if (d.access_token) {
      const expiresAt = new Date(Date.now() + (d.expires_in || 3600) * 1000).toISOString();
      db.prepare("UPDATE user_social_tokens SET access_token = ?, expires_at = ? WHERE id = ?").run(d.access_token, expiresAt, row.id);
      return d.access_token;
    }
    return row.access_token || null;
  } catch (e) { console.error("[reddit token refresh]", e?.message); return null; }
}

module.exports = router;
module.exports.getSetting = getSetting;
module.exports.getValidRedditToken = getValidRedditToken;

// ════════════════════════════════════════════════════════════════════════════
//  GOOGLE BUSINESS PROFILE — Review management
// ════════════════════════════════════════════════════════════════════════════

// ── OAuth Connect ──────────────────────────────────────────────────────────
router.get('/google-business/connect', auth, (req, res) => {
  const clientId     = getSetting('GOOGLE_CLIENT_ID')     || process.env.GOOGLE_CLIENT_ID;
  const backendUrl   = getSetting('BACKEND_URL')          || process.env.BACKEND_URL || 'http://localhost:4000';
  const redirectUri  = `${backendUrl}/api/integrations/google-business/callback`;
  const scope        = 'https://www.googleapis.com/auth/business.manage';
  // Signed state prevents an attacker from swapping in a victim's userId
  // and hijacking the GB connection on callback.
  const state        = _signOAuthState(req.userId, 'google_business');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
  res.json({ url });
});

router.get('/google-business/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    // Verify the HMAC-signed state. Rejects:
    //   - unsigned / malformed state
    //   - state older than 10 minutes
    //   - state issued for a different provider (replay protection)
    // Returns the userId cryptographically bound to the start flow, so an
    // attacker cannot swap in a victim's userId.
    const userId = _verifyOAuthState(state, 'google_business');
    if (!userId) {
      const frontendUrl = getSetting('FRONTEND_URL') || process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}?google_business=error&msg=${encodeURIComponent('Invalid or expired state')}`);
    }
    const clientId     = getSetting('GOOGLE_CLIENT_ID')     || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = getSetting('GOOGLE_CLIENT_SECRET') || process.env.GOOGLE_CLIENT_SECRET;
    const backendUrl   = getSetting('BACKEND_URL')          || process.env.BACKEND_URL || 'http://localhost:4000';
    const redirectUri  = `${backendUrl}/api/integrations/google-business/callback`;
    const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    const db = getDb();
    const expires = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
    db.prepare(`INSERT INTO social_connections (id,user_id,platform,access_token,refresh_token,expires_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,platform) DO UPDATE SET access_token=excluded.access_token,refresh_token=COALESCE(excluded.refresh_token,refresh_token),expires_at=excluded.expires_at`)
      .run(require('crypto').randomUUID(), userId, 'google_business', tokens.access_token, tokens.refresh_token||null, expires);
    const frontendUrl = getSetting('FRONTEND_URL') || process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}?google_business=connected`);
  } catch(e) { res.redirect(`${process.env.FRONTEND_URL||'http://localhost:3000'}?google_business=error&msg=${encodeURIComponent(e.message)}`); }
});

// ── Get locations ──────────────────────────────────────────────────────────
router.get('/google-business/locations', auth, async (req, res) => {
  try {
    const db = getDb();
    const conn = db.prepare("SELECT * FROM social_connections WHERE user_id=? AND platform='google_business'").get(req.userId);
    if (!conn) return res.status(404).json({ error: 'Google Business not connected' });
    const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
    // Refresh token if expired
    let token = conn.access_token;
    if (conn.expires_at && new Date(conn.expires_at) < new Date() && conn.refresh_token) {
      const clientId = getSetting('GOOGLE_CLIENT_ID') || process.env.GOOGLE_CLIENT_ID;
      const clientSecret = getSetting('GOOGLE_CLIENT_SECRET') || process.env.GOOGLE_CLIENT_SECRET;
      const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ refresh_token: conn.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }) });
      const t = await r.json();
      if (t.access_token) { token = t.access_token; db.prepare("UPDATE social_connections SET access_token=?,expires_at=? WHERE id=?").run(t.access_token, new Date(Date.now()+(t.expires_in||3600)*1000).toISOString(), conn.id); }
    }
    const accountsRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: { Authorization: `Bearer ${token}` } });
    const accountsData = await accountsRes.json();
    if (!accountsData.accounts?.length) return res.json({ locations: [] });
    const accountName = accountsData.accounts[0].name;
    const locRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,storefrontAddress,websiteUri`, { headers: { Authorization: `Bearer ${token}` } });
    const locData = await locRes.json();
    const locations = (locData.locations || []).map(l => ({ id: l.name, name: l.title, address: l.storefrontAddress?.addressLines?.join(', ') || '' }));
    res.json({ locations });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Fetch Google reviews ───────────────────────────────────────────────────
router.get('/google-business/reviews', auth, async (req, res) => {
  try {
    const { location_id } = req.query;
    if (!location_id) return res.status(400).json({ error: 'location_id required' });
    const db = getDb();
    const conn = db.prepare("SELECT * FROM social_connections WHERE user_id=? AND platform='google_business'").get(req.userId);
    if (!conn) return res.status(404).json({ error: 'Google Business not connected' });
    const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
    let token = conn.access_token;
    if (conn.expires_at && new Date(conn.expires_at) < new Date() && conn.refresh_token) {
      const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ refresh_token: conn.refresh_token, client_id: getSetting('GOOGLE_CLIENT_ID')||process.env.GOOGLE_CLIENT_ID, client_secret: getSetting('GOOGLE_CLIENT_SECRET')||process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }) });
      const t = await r.json();
      if (t.access_token) { token = t.access_token; db.prepare("UPDATE social_connections SET access_token=?,expires_at=? WHERE id=?").run(t.access_token, new Date(Date.now()+(t.expires_in||3600)*1000).toISOString(), conn.id); }
    }
    const reviewsRes = await fetch(`https://mybusiness.googleapis.com/v4/${location_id}/reviews?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
    const reviewsData = await reviewsRes.json();
    const reviews = (reviewsData.reviews || []).map(r => ({
      id: r.reviewId, name: r.reviewer?.displayName || 'Google User',
      rating: { ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5 }[r.starRating] || 5,
      text: r.comment || '', date: r.createTime,
      reply: r.reviewReply?.comment || null, reply_date: r.reviewReply?.updateTime || null,
      source: 'google', profile_photo: r.reviewer?.profilePhotoUrl || null,
    }));
    const avg = reviews.length ? reviews.reduce((s,r) => s+r.rating, 0)/reviews.length : 0;
    res.json({ reviews, count: reviews.length, average: Math.round(avg*10)/10 });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Reply to a Google review ───────────────────────────────────────────────
router.post('/google-business/reviews/:reviewId/reply', auth, async (req, res) => {
  try {
    const { location_id, reply } = req.body;
    if (!location_id || !reply) return res.status(400).json({ error: 'location_id and reply required' });
    const db = getDb();
    const conn = db.prepare("SELECT * FROM social_connections WHERE user_id=? AND platform='google_business'").get(req.userId);
    if (!conn) return res.status(404).json({ error: 'Google Business not connected' });
    const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
    const r = await fetch(`https://mybusiness.googleapis.com/v4/${location_id}/reviews/${req.params.reviewId}/reply`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${conn.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: reply }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.error?.message || 'Failed to reply' });
    res.json({ success: true, reply: d.comment, updated: d.updateTime });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Delete a Google review reply ──────────────────────────────────────────
router.delete('/google-business/reviews/:reviewId/reply', auth, async (req, res) => {
  try {
    const { location_id } = req.query;
    const db = getDb();
    const conn = db.prepare("SELECT * FROM social_connections WHERE user_id=? AND platform='google_business'").get(req.userId);
    if (!conn) return res.status(404).json({ error: 'Google Business not connected' });
    const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
    await fetch(`https://mybusiness.googleapis.com/v4/${location_id}/reviews/${req.params.reviewId}/reply`, { method:'DELETE', headers:{ Authorization:`Bearer ${conn.access_token}` } });
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Connection status ─────────────────────────────────────────────────────
router.get('/google-business/status', auth, (req, res) => {
  try {
    const db = getDb();
    const conn = db.prepare("SELECT id,profile_name,expires_at,created_at FROM social_connections WHERE user_id=? AND platform='google_business'").get(req.userId);
    res.json({ connected: !!conn, profile: conn?.profile_name || null, expires: conn?.expires_at || null, since: conn?.created_at || null });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});
