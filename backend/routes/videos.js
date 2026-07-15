/**
 * videos.js
 *
 * Persistent video library for MINE.
 * Handles storage, retrieval and auto-posting of generated videos.
 *
 * Flow:
 *   1. Video generated via /api/features/video/runway or /api/features/video/short-form
 *   2. Webhook / poll completion → POST /api/videos/save  (saves URL + metadata to DB)
 *   3. Download from provider URL → upload to S3 for permanent storage
 *   4. Auto-post to selected social platforms via integrations.js
 *   5. GET /api/videos → loads video library panel
 *
 * Mount in server.js:
 *   const videoRoutes = require("./routes/videos");
 *   app.use("/api/videos", videoRoutes);
 */

const express  = require("express");
const router   = express.Router();
const { v4: uuid } = require("uuid");

function auth(req, res, next) { require("../middleware/auth").auth(req, res, next); }
function getDb() { return require("../db/init").getDb(); }
function getSetting(k) {
  try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; }
  catch { return ""; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TABLE SETUP
// ─────────────────────────────────────────────────────────────────────────────

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      provider     TEXT NOT NULL,          -- "runway" | "arcads"
      type         TEXT NOT NULL,          -- "cinematic" | "ugc"
      title        TEXT,
      prompt       TEXT,                   -- prompt or script used
      provider_url TEXT,                   -- original Runway/Arcads URL (may expire)
      s3_url       TEXT,                   -- permanent S3/CDN URL
      s3_key       TEXT,
      duration     INTEGER,                -- seconds
      ratio        TEXT,                   -- "768:1280" etc
      status       TEXT DEFAULT 'ready',   -- "rendering" | "ready" | "failed"
      charge_id    TEXT,                   -- Stripe PaymentIntent ID
      amount_paid  REAL,
      platforms_posted TEXT DEFAULT '[]',  -- JSON array of platforms posted to
      views        INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_posts (
      id         TEXT PRIMARY KEY,
      video_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      platform   TEXT NOT NULL,           -- "instagram" | "tiktok" | "youtube" | "facebook"
      post_id    TEXT,                    -- platform's post ID
      status     TEXT DEFAULT 'pending',  -- "pending" | "posted" | "failed"
      error      TEXT,
      posted_at  TEXT
    );
  `);

  // ── Lazy-add agency-ownership columns to existing videos table ──────────
  // user_id = legacy creator field (kept for backwards compat)
  // owner_user_id = whose gallery the video shows in (= user_id for self-created)
  // created_by_user_id = who actually clicked Generate (agency user when reselling)
  // agency_id = which agency org created it (NULL for direct customer videos)
  // agency_visible = if true, show "Created by [Agency Name]" badge to client (default 1)
  // client_charge_amount = what the client paid (gross, agency keeps markup)
  // agency_payout_amount = how much MINE paid back to the agency via Stripe Connect
  // agency_transfer_id = Stripe Connect transfer ID for the payout
  const existingCols = db.prepare("PRAGMA table_info(videos)").all().map(c => c.name);
  const addCol = (col, sql) => {
    if (!existingCols.includes(col)) {
      try { db.exec(`ALTER TABLE videos ADD COLUMN ${sql}`); } catch (_) {}
    }
  };
  addCol('owner_user_id',         'owner_user_id TEXT');
  addCol('created_by_user_id',    'created_by_user_id TEXT');
  addCol('agency_id',             'agency_id INTEGER');
  addCol('agency_visible',        'agency_visible INTEGER DEFAULT 1');
  addCol('client_charge_amount',  'client_charge_amount REAL');
  addCol('agency_payout_amount',  'agency_payout_amount REAL');
  addCol('agency_transfer_id',    'agency_transfer_id TEXT');
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/videos
// Returns the user's video library
// ─────────────────────────────────────────────────────────────────────────────

router.get("/", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  // Show videos this user OWNS — covers two cases:
  //   1. Self-created: owner_user_id = req.userId (or legacy: user_id = req.userId)
  //   2. Agency-created for them: owner_user_id = req.userId, created_by_user_id = agency
  // Also enrich with creator info if it's agency-created and visible to client.
  const videos = db.prepare(`
    SELECT v.*,
           GROUP_CONCAT(vp.platform) as posted_platforms,
           a.name as agency_name
    FROM videos v
    LEFT JOIN video_posts vp ON vp.video_id = v.id AND vp.status = 'posted'
    LEFT JOIN agencies a ON a.id = v.agency_id
    WHERE (v.owner_user_id = ? OR (v.owner_user_id IS NULL AND v.user_id = ?))
    GROUP BY v.id
    ORDER BY v.created_at DESC
    LIMIT 50
  `).all(req.userId, req.userId);

  // Hide agency name on rows where visibility is off (white-label mode)
  videos.forEach(v => {
    if (v.agency_visible === 0) v.agency_name = null;
  });

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(amount_paid) as total_spent,
      SUM(views) as total_views,
      COUNT(CASE WHEN provider='runway' THEN 1 END) as runway_count,
      COUNT(CASE WHEN provider='arcads' THEN 1 END) as arcads_count
    FROM videos
    WHERE (owner_user_id = ? OR (owner_user_id IS NULL AND user_id = ?))
      AND status = 'ready'
  `).get(req.userId, req.userId) || {};

  res.json({ success: true, videos, stats });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/save
// Called when a video finishes rendering (from poll or webhook).
// Downloads the video, uploads to S3, saves to DB.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/save", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);

  const {
    provider,      // "runway" | "arcads"
    providerUrl,   // temporary URL from provider
    prompt,        // prompt or script
    duration,
    ratio,
    chargeId,
    amountPaid,
    autoPost,      // array: ["instagram","tiktok","youtube"]
    title
  } = req.body;

  if (!providerUrl) return res.status(400).json({ error: "providerUrl required" });

  const id    = uuid();
  const type  = provider === "runway" ? "cinematic" : "ugc";
  const label = title || (provider === "runway" ? "Runway Cinematic Video" : "Arcads UGC Video");

  // Try to download + upload to S3 for permanent storage
  let s3Url  = null;
  let s3Key  = null;

  try {
    const { isS3Enabled, uploadToS3 } = require("../utils/s3");

    if (isS3Enabled()) {
      const fetch2 = (await import("node-fetch")).default;
      const response = await fetch2(providerUrl);
      if (response.ok) {
        const buffer  = Buffer.from(await response.arrayBuffer());
        s3Key  = `videos/${req.userId}/${id}.mp4`;
        s3Url  = await uploadToS3(buffer, s3Key, "video/mp4");
      }
    }
  } catch (e) {
    console.error("[Videos] S3 upload failed:", e.message);
    // Not fatal — we still save the provider URL as fallback
  }

  // Save to DB
  db.prepare(`
    INSERT INTO videos (id, user_id, provider, type, title, prompt, provider_url, s3_url, s3_key, duration, ratio, status, charge_id, amount_paid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
  `).run(id, req.userId, provider, type, label, prompt || "", providerUrl, s3Url, s3Key, duration || null, ratio || null, chargeId || null, amountPaid || null);

  const videoUrl = s3Url || providerUrl;

  // Auto-post to platforms if requested
  const platforms = Array.isArray(autoPost) ? autoPost : [];
  const postResults = [];

  for (const platform of platforms) {
    try {
      const postResult = await postVideoToPlatform(db, req.userId, id, videoUrl, label, prompt, platform);
      postResults.push(postResult);
    } catch (e) {
      console.error(`[Videos] Auto-post to ${platform} failed:`, e.message);
      db.prepare("INSERT INTO video_posts (id, video_id, user_id, platform, status, error) VALUES (?,?,?,?,'failed',?)")
        .run(uuid(), id, req.userId, platform, e.message);
      postResults.push({ platform, success: false, error: e.message });
    }
  }

  // Update platforms_posted
  const posted = postResults.filter(p => p.success).map(p => p.platform);
  if (posted.length) {
    db.prepare("UPDATE videos SET platforms_posted = ? WHERE id = ?").run(JSON.stringify(posted), id);
  }

  res.json({
    success: true,
    video: { id, url: videoUrl, s3: !!s3Url, provider, type, title: label },
    posted: postResults,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/:id/post
// Manually post an existing video to a platform
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/post", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);

  const video = db.prepare("SELECT * FROM videos WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!video) return res.status(404).json({ error: "Video not found" });

  const { platform } = req.body;
  if (!platform) return res.status(400).json({ error: "platform required" });

  const videoUrl = video.s3_url || video.provider_url;

  try {
    const result = await postVideoToPlatform(db, req.userId, video.id, videoUrl, video.title, video.prompt, platform);

    // Update platforms_posted list
    let posted = [];
    try { posted = JSON.parse(video.platforms_posted || "[]"); } catch (_) {}
    if (!posted.includes(platform)) posted.push(platform);
    db.prepare("UPDATE videos SET platforms_posted = ? WHERE id = ?").run(JSON.stringify(posted), video.id);

    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/videos/:id
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/:id", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);

  const video = db.prepare("SELECT * FROM videos WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!video) return res.status(404).json({ error: "Not found" });

  // Delete from S3 if stored there
  if (video.s3_key) {
    try {
      const { deleteFromS3 } = require("../utils/s3");
      await deleteFromS3(video.s3_key);
    } catch (_) {}
  }

  db.prepare("DELETE FROM video_posts WHERE video_id = ?").run(video.id);
  db.prepare("DELETE FROM videos WHERE id = ?").run(video.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM POSTING HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function postVideoToPlatform(db, userId, videoId, videoUrl, title, caption, platform) {
  // Get the user's OAuth token for this platform
  const token = db.prepare(
    "SELECT access_token, account_id FROM oauth_tokens WHERE user_id = ? AND platform = ?"
  ).get(userId, platform);

  if (!token) {
    throw new Error(`${platform} not connected. Connect it in Settings → Integrations.`);
  }

  const fetch2 = (await import("node-fetch")).default;
  let postId = null;

  if (platform === "instagram" || platform === "facebook") {
    // Meta Video API — upload as Reel
    const igAccountId = token.account_id;
    // Step 1: Create container
    const containerRes = await fetch2(
      `https://graph.facebook.com/v19.0/${igAccountId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "REELS",
          video_url:  videoUrl,
          caption:    caption || title || "",
          access_token: token.access_token,
        }),
      }
    );
    const container = await containerRes.json();
    if (!container.id) throw new Error(container.error?.message || "Instagram container creation failed");

    // Step 2: Wait briefly then publish
    await new Promise(r => setTimeout(r, 4000));
    const publishRes = await fetch2(
      `https://graph.facebook.com/v19.0/${igAccountId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: container.id, access_token: token.access_token }),
      }
    );
    const published = await publishRes.json();
    postId = published.id;
    if (!postId) throw new Error(published.error?.message || "Instagram publish failed");

  } else if (platform === "tiktok") {
    // TikTok Video Upload API
    const uploadRes = await fetch2("https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        post_info: {
          title:           caption || title || "",
          privacy_level:   "PUBLIC_TO_EVERYONE",
          disable_duet:    false,
          disable_comment: false,
          disable_stitch:  false,
        },
        source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
      }),
    });
    const upload = await uploadRes.json();
    postId = upload.data?.publish_id;
    if (!postId) throw new Error(upload.error?.message || "TikTok upload failed");

  } else if (platform === "youtube") {
    // YouTube Data API v3 — upload video
    const ytRes = await fetch2(
      `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
      {
        method: "POST",
        headers: {
          Authorization:   `Bearer ${token.access_token}`,
          "Content-Type":  "application/json",
          "X-Upload-Content-Type": "video/mp4",
        },
        body: JSON.stringify({
          snippet: {
            title:       title || "Video",
            description: caption || "",
            tags:        ["mine", "shorts"],
            categoryId:  "22",
          },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
        }),
      }
    );
    // Get resumable upload URL
    const uploadUrl = ytRes.headers.get("location");
    if (!uploadUrl) throw new Error("YouTube: could not get upload URL");

    // Download video and upload to YouTube
    const fetch3 = (await import("node-fetch")).default;
    const vidRes = await fetch3(videoUrl);
    const vidBuffer = Buffer.from(await vidRes.arrayBuffer());

    const finalRes = await fetch3(uploadUrl, {
      method:  "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Length": String(vidBuffer.length) },
      body:    vidBuffer,
    });
    const ytData = await finalRes.json();
    postId = ytData.id;
    if (!postId) throw new Error("YouTube upload failed");
  }

  // Log the post
  db.prepare(`
    INSERT INTO video_posts (id, video_id, user_id, platform, post_id, status, posted_at)
    VALUES (?, ?, ?, ?, ?, 'posted', datetime('now'))
  `).run(uuid(), videoId, userId, platform, postId || "");

  return { success: true, platform, postId };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/videos/agency-list
// Returns videos the agency has created on behalf of clients, grouped by client.
// Used in the agency dashboard's video panel.
// Auth: requires user to belong to an agency (req.agencyId set by upstream middleware,
// or fall back to looking up the user's agency membership).
// ─────────────────────────────────────────────────────────────────────────────

router.get("/agency-list", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  // Resolve which agency the requesting user belongs to.
  // Check explicit agency_id on req (if upstream middleware set it), otherwise
  // look up via agency_users membership.
  let agencyId = req.agencyId || null;
  if (!agencyId) {
    try {
      const row = db.prepare("SELECT agency_id FROM agency_users WHERE user_id = ? LIMIT 1").get(req.userId);
      if (row && row.agency_id) agencyId = row.agency_id;
    } catch (_) {
      // agency_users table may not exist for non-agency installs — that's fine
    }
  }

  if (!agencyId) {
    return res.json({ success: true, videos: [], stats: {}, by_client: [] });
  }

  const videos = db.prepare(`
    SELECT v.*, u.email as client_email, u.business_name as client_name
    FROM videos v
    LEFT JOIN users u ON u.id = v.owner_user_id
    WHERE v.agency_id = ?
    ORDER BY v.created_at DESC
    LIMIT 100
  `).all(agencyId);

  // Group by client for the per-client breakdown UI
  const clientMap = {};
  videos.forEach(v => {
    const key = v.owner_user_id || 'unknown';
    if (!clientMap[key]) {
      clientMap[key] = {
        user_id:      v.owner_user_id,
        client_name:  v.client_name || v.client_email || 'Unknown client',
        client_email: v.client_email,
        video_count:  0,
        total_charged: 0,
        total_payout:  0,
      };
    }
    clientMap[key].video_count++;
    clientMap[key].total_charged += Number(v.client_charge_amount || 0);
    clientMap[key].total_payout  += Number(v.agency_payout_amount || 0);
  });

  const by_client = Object.values(clientMap).sort((a, b) => b.video_count - a.video_count);

  const stats = {
    total_videos:  videos.length,
    total_charged: videos.reduce((s, v) => s + Number(v.client_charge_amount || 0), 0),
    total_payout:  videos.reduce((s, v) => s + Number(v.agency_payout_amount  || 0), 0),
    unique_clients: by_client.length,
  };

  res.json({ success: true, videos, stats, by_client });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/create-for-client
// Agency creates a video on behalf of a client. The video appears in the
// client's gallery (owner_user_id = client). Billing follows Option B:
// the client is charged the marked-up rate (4× MINE base by default), MINE keeps
// the base, and the markup is paid back to the agency via Stripe Connect.
//
// Body: { client_id, prompt/script/etc (same as normal video creation), agency_visible? }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/create-for-client", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);

  const { client_id, agency_visible } = req.body || {};
  if (!client_id) return res.status(400).json({ error: "client_id required" });

  // Resolve requesting user's agency
  let agencyId = req.agencyId || null;
  if (!agencyId) {
    try {
      const row = db.prepare("SELECT agency_id FROM agency_users WHERE user_id = ? LIMIT 1").get(req.userId);
      if (row && row.agency_id) agencyId = row.agency_id;
    } catch (_) {}
  }
  if (!agencyId) return res.status(403).json({ error: "Not an agency user" });

  // Verify the agency manages this client
  let isClient = false;
  try {
    isClient = !!db.prepare("SELECT 1 FROM agency_clients WHERE agency_id = ? AND user_id = ? LIMIT 1").get(agencyId, client_id);
  } catch (_) {}
  if (!isClient) return res.status(403).json({ error: "Client not managed by your agency" });

  // Pass through to the normal video generation logic with ownership overrides.
  // The actual provider call (HeyGen/Higgsfield) happens elsewhere — here we
  // just record the agency context so the downstream billing/save logic picks
  // up `owner_user_id`, `agency_id`, `agency_visible` correctly.
  req._videoContext = {
    owner_user_id:      client_id,
    created_by_user_id: req.userId,
    agency_id:          agencyId,
    agency_visible:     agency_visible === false ? 0 : 1,
  };

  // Return the context so the frontend can pass it to /generate or /save.
  // (Frontend then calls the standard generation endpoint with these flags.)
  res.json({ success: true, context: req._videoContext });
});

module.exports = router;
