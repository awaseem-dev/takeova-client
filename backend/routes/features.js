const crypto = require('crypto');
const express = require("express");
const { renderEmail, P } = require("../utils/email-template");
const { v4: uuid } = require("uuid");

function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#x27;"); }
const { getDb } = require("../db/init");
const { getSmsSender } = require("../utils/sms");
const { auth, optionalAuth, ownerOnly } = require("../middleware/auth");
const { getSetting } = require("./integrations");

// Truncate user-supplied strings before they enter AI prompts.
// Prevents cost attacks where a malicious user sends 100KB+ inputs to inflate API bills.
function aiStr(s, max = 500) {
  if (s == null) return "";
  return String(s).slice(0, max);
}


// ── WhatsApp footer helper — adds "Chat on WhatsApp" to transactional emails ──
// Returns an HTML snippet if user has Take Control customer mode on, else empty string
function getWhatsAppEmailFooter(db, userId) {
  try {
    const mc = db.prepare("SELECT wa_business_code, customer_mode_enabled FROM mine_control_config WHERE user_id = ? AND enabled = 1").get(userId);
    if (!mc?.wa_business_code || !mc?.customer_mode_enabled) return "";
    const { getSetting } = require("../db/init");
    const waNum = (getSetting("WHATSAPP_BUSINESS_NUMBER") || process.env.WHATSAPP_BUSINESS_NUMBER || "").replace(/\D/g, "");
    if (!waNum) return "";
    const waLink = `https://wa.me/${waNum}?text=${encodeURIComponent("START-" + mc.wa_business_code)}`;
    return `<div style="margin-top:28px;padding-top:20px;border-top:1px solid #f0f0f0;text-align:center;">
  <p style="font-size:12px;color:#94A3B8;margin-bottom:10px;">Need help? Chat with us instantly on WhatsApp</p>
  <a href="${waLink}" style="display:inline-flex;align-items:center;gap:8px;padding:10px 20px;background:#25D366;color:#fff;border-radius:24px;font-weight:700;font-size:13px;text-decoration:none;">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.552 4.116 1.52 5.845L.057 23.887a.5.5 0 0 0 .617.611l6.154-1.612A11.942 11.942 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.9 0-3.681-.528-5.2-1.446l-.373-.221-3.865 1.013 1.03-3.763-.245-.389A9.954 9.954 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
    Chat on WhatsApp
  </a>
</div>`;
  } catch(e) { return ""; }
}

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";

// Webhook fire helper — notify marketplace apps of events
async function fireWebhooks(userId, event, data) {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS webhook_logs (
      id TEXT PRIMARY KEY, webhook_id TEXT, user_id TEXT, event TEXT, payload TEXT,
      url TEXT, status TEXT, response_code INTEGER, retry_count INTEGER DEFAULT 0,
      next_retry_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
    try { db.exec("ALTER TABLE webhook_logs ADD COLUMN user_id TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE webhook_logs ADD COLUMN payload TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE webhook_logs ADD COLUMN url TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE webhook_logs ADD COLUMN retry_count INTEGER DEFAULT 0"); } catch(e) {}
    try { db.exec("ALTER TABLE webhook_logs ADD COLUMN next_retry_at TEXT"); } catch(e) {}
    const hooks = db.prepare("SELECT w.url, w.secret FROM webhooks w JOIN app_installs ai ON w.app_install_id = ai.id WHERE ai.user_id = ? AND ai.status = 'active' AND w.events LIKE ?").all(userId, "%" + event + "%");
    for (const hook of hooks) {
      // Defense-in-depth SSRF check before firing.
      // Without this, a compromised/malicious app's webhook_url could point
      // inside TAKEOVA's own network (metadata, admin APIs, Redis, etc).
      // Matches the guards in marketplace.js and appstore.js fireWebhooks.
      try {
        const _hp = new URL(hook.url);
        const _hh = _hp.hostname.toLowerCase();
        const isPrivate = _hp.protocol !== "https:" ||
          /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(_hh) ||
          ["::1","0.0.0.0","metadata.google.internal","metadata"].includes(_hh) ||
          _hh.endsWith(".local") || _hh.endsWith(".internal") ||
          /^fe80:/.test(_hh) || /^(fc|fd)[0-9a-f]{2}:/.test(_hh);
        if (isPrivate) continue;
      } catch (_) { continue; }

      const payload = JSON.stringify({ event, data, timestamp: Date.now() });
      const sig = require("crypto").createHmac("sha256", hook.secret || "mine").update(payload).digest("hex");
      const ctrl=new AbortController();setTimeout(()=>ctrl.abort(),5000);fetch(hook.url,{signal:ctrl.signal, method: "POST", headers: { "Content-Type": "application/json", "X-Mine-Signature": sig, "X-Mine-Event": event }, body: payload, redirect: "error" }).then(async resp => {
          const code = resp.status;
          if (code < 200 || code >= 300) {
            // Log failure for retry
            const logId = require('uuid').v4();
            db.prepare(`INSERT INTO webhook_logs (id,user_id,event,payload,url,status,response_code,retry_count,next_retry_at) VALUES (?,?,?,?,?,?,?,1,datetime('now','+5 minutes'))`)
              .run(logId, userId, event, payload, hook.url, 'failed', code);
          }
        }).catch(err => {
          // Network error / timeout — log for retry
          try {
            const logId = require('uuid').v4();
            db.prepare(`INSERT INTO webhook_logs (id,user_id,event,payload,url,status,response_code,retry_count,next_retry_at) VALUES (?,?,?,?,?,?,?,1,datetime('now','+5 minutes'))`)
              .run(logId, userId, event, payload, hook.url, 'error', 0);
          } catch(e) {}
        });
    }
  } catch (e) { /* webhooks/apps tables may not exist yet */ }
}

async function fireAutomation(userId, trigger_type, trigger_data) {
  try {
    const fetch = (await import("node-fetch")).default;
    fetch((BACKEND_URL || "http://localhost:4000") + "/api/platform/automations/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": process.env.INTERNAL_API_KEY || "",
        "x-user-id": userId
      },
      body: JSON.stringify({ trigger_type, trigger_data })
    }).catch(() => {});
  } catch (e) { }
}

// ═══════════════════════════════════════════════════════
// 1. COMMUNITY / FORUMS / DISCUSSION BOARDS
// Replaces: Skool ($129/mo), Circle ($89/mo)
// ═══════════════════════════════════════════════════════

router.post("/community/space", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { siteId, name, description, type, isPrivate } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO community_spaces (id, site_id, user_id, name, description, type, is_private, member_count, created_at)
    VALUES (?,?,?,?,?,?,?,0,datetime('now'))`).run(id, siteId, req.userId, name, description || "", type || "discussion", isPrivate ? 1 : 0);
  res.json({ success: true, id });
});

router.get("/community/spaces/:siteId", (req, res) => {
  const db = getDb(); ensureTables(db);
  res.json({ spaces: db.prepare("SELECT * FROM community_spaces WHERE site_id = ? AND is_private = 0 ORDER BY created_at DESC").all(req.params.siteId) });
});

// ─── GET /api/onboarding/quickstats — fast "is account empty?" check ──────
// Used by the dashboard empty-state script to decide whether to show fake
// demo numbers or em-dash placeholders. Cheap query, no joins.
router.get("/onboarding/quickstats", auth, (req, res) => {
  const db = getDb();
  try {
    const sites    = db.prepare("SELECT COUNT(*) AS n FROM sites WHERE user_id = ?").get(req.userId)?.n || 0;
    const contacts = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?").get(req.userId)?.n || 0;
    const orders   = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ?").get(req.userId)?.n || 0;
    const revRow   = db.prepare("SELECT COALESCE(SUM(total), 0) AS rev FROM orders WHERE user_id = ? AND status = 'paid'").get(req.userId);
    res.json({
      sites, contacts, orders,
      revenue: parseFloat(revRow?.rev || 0),
      isNew: sites === 0 && contacts === 0 && orders === 0,
    });
  } catch(e) {
    console.error("[quickstats]", e.message);
    res.json({ sites: 0, contacts: 0, orders: 0, revenue: 0, isNew: true });
  }
});

// ─── GET /availability — which features have their backend deps configured ──
// Returns booleans the frontend can use to hide/disable UI for features that
// would otherwise 100% fail. No auth required — these are availability flags,
// not user-specific data. Cached aggressively by the frontend.
router.get("/availability", (req, res) => {
  // Helper to check env vars OR platform_settings DB-stored secrets
  const isSet = (key) => {
    try {
      if (process.env[key] && process.env[key].trim()) return true;
      const db = getDb();
      const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
      return !!(row && row.value && String(row.value).trim());
    } catch(_) { return !!process.env[key]; }
  };

  res.json({
    // Web Hands needs the runner microservice. Without it, every task fails.
    web_hands: isSet("BROWSER_AGENT_RUNNER_URL") && isSet("ANTHROPIC_API_KEY"),
    // Higgsfield premium image/video. Without both, Soul/DoP/brand models can't run.
    higgsfield: isSet("HF_API_KEY") && isSet("HF_API_SECRET"),
    // Nano Banana for images
    nano_banana: isSet("GEMINI_API_KEY"),
    // DALL-E 3 fallback
    dalle: isSet("OPENAI_API_KEY"),
    // Runway video
    runway: isSet("RUNWAY_API_KEY"),
    // HeyGen UGC
    heygen: isSet("HEYGEN_API_KEY"),
    // S3/R2 file storage
    file_storage: isSet("AWS_ACCESS_KEY_ID") && isSet("AWS_S3_BUCKET"),
    // Stripe billing
    stripe: isSet("STRIPE_SECRET_KEY"),
  });
});

router.post("/community/post", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { spaceId, title, body, type } = req.body;
  // Enforce content length limits
  if (!title || typeof title !== "string" || title.trim().length === 0) return res.status(400).json({ error: "Post title is required" });
  if (title.length > 200) return res.status(400).json({ error: "Title too long (max 200 characters)" });
  if (body && body.length > 10000) return res.status(400).json({ error: "Post body too long (max 10,000 characters)" });
  if (!spaceId) return res.status(400).json({ error: "spaceId is required" });
  const id = uuid();
  db.prepare(`INSERT INTO community_posts (id, space_id, user_id, author_name, title, body, type, likes, replies_count, pinned, created_at)
    VALUES (?,?,?,?,?,?,?,0,0,0,datetime('now'))`).run(id, spaceId, req.userId, req.user?.name || "User", title.trim(), (body || "").trim(), type || "discussion");
  res.json({ success: true, id });
});

router.get("/community/posts/:spaceId", (req, res) => {
  const db = getDb(); ensureTables(db);
  const { sort, limit, offset } = req.query;
  // sort is whitelisted — user input never reaches SQL directly
  const order = sort === "popular" ? "likes DESC" : sort === "oldest" ? "created_at ASC" : "pinned DESC, created_at DESC";
  const safeLimit = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);
  res.json({ posts: db.prepare(`SELECT * FROM community_posts WHERE space_id = ? ORDER BY ${order} LIMIT ? OFFSET ?`).all(req.params.spaceId, safeLimit, safeOffset) });
});

router.post("/community/reply", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { postId, body } = req.body;
  // Enforce content length limits
  if (!body || typeof body !== "string" || body.trim().length === 0) return res.status(400).json({ error: "Reply body is required" });
  if (body.length > 5000) return res.status(400).json({ error: "Reply too long (max 5,000 characters)" });
  if (!postId) return res.status(400).json({ error: "postId is required" });
  const id = uuid();
  db.prepare(`INSERT INTO community_replies (id, post_id, user_id, author_name, body, likes, created_at)
    VALUES (?,?,?,?,?,0,datetime('now'))`).run(id, postId, req.userId, req.user?.name || "User", body.trim());
  db.prepare("UPDATE community_posts SET replies_count = replies_count + 1 WHERE id = ?").run(postId);
  res.json({ success: true, id });
});

router.get("/community/replies/:postId", (req, res) => {
  const db = getDb(); ensureTables(db);
  res.json({ replies: db.prepare("SELECT * FROM community_replies WHERE post_id = ? ORDER BY created_at ASC").all(req.params.postId) });
});

router.post("/community/like/:postId", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  // Prevent duplicate likes — one like per user per post
  db.exec("CREATE TABLE IF NOT EXISTS community_likes (post_id TEXT, user_id TEXT, PRIMARY KEY(post_id, user_id))");
  try {
    db.prepare("INSERT INTO community_likes (post_id, user_id) VALUES (?,?)").run(req.params.postId, req.userId);
    db.prepare("UPDATE community_posts SET likes = likes + 1 WHERE id = ?").run(req.params.postId);
    res.json({ success: true, liked: true });
  } catch(e) {
    // UNIQUE constraint failed — already liked
    res.json({ success: true, liked: false, message: "Already liked" });
  }
});

// ═══════════════════════════════════════════════════════
// 2. CLIENT PORTAL
// Customers log in, see orders, courses, invoices, bookings
// Replaces: Dubsado, HoneyBook
// ═══════════════════════════════════════════════════════

// Rate limiter: max 5 magic link requests per IP per 15 min — prevents SendGrid email bombing
const rateLimit = require("express-rate-limit");
const portalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many login attempts — please wait 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for unauthenticated cart saves (prevents abandoned-cart spam)
const cartSaveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  keyGenerator: (req) => req.ip + ":" + (req.body?.siteId || ""),
  message: { error: "Too many cart saves from this IP, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for unauthenticated review submissions (prevents fake review flooding)
const reviewSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => req.ip,
  message: { error: "Too many reviews submitted from this IP, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for unauthenticated cart abandon (prevents email spam)
const cartAbandonLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  keyGenerator: (req) => req.ip + ":" + (req.body?.siteId || ""),
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});
// Rate limiter for team invite acceptance (prevents mass account creation via leaked invite tokens)
const acceptInviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // 5 account creations per IP per hour
  keyGenerator: (req) => req.ip,
  message: { error: "Too many invite acceptances from this IP — please wait an hour" },
  standardHeaders: true,
  legacyHeaders: false,
});


// Rate limiter for unauthenticated form submission notify (prevents email spam)
const formNotifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  keyGenerator: (req) => req.ip + ":" + (req.body?.siteId || ""),
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for public subscription endpoint (prevents subscription spam / Stripe abuse)
const subscribePublicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => req.ip + ":" + (req.body?.site_id || ""),
  message: { error: "Too many subscription attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const _CART_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


router.post("/portal/login", portalLoginLimiter, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { email, siteId } = req.body;
    if (!email || !siteId) return res.status(400).json({ error: "Email and siteId required" });

    const site = db.prepare("SELECT user_id, name FROM sites WHERE id = ?").get(siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    let client = db.prepare("SELECT * FROM portal_clients WHERE email = ? AND site_id = ?").get(email, siteId);
    if (!client) {
      const id = uuid();
      const token = crypto.randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
      db.prepare(`INSERT INTO portal_clients (id, site_id, email, name, token, token_expires, created_at) VALUES (?,?,?,?,?,?,datetime('now'))`)
        .run(id, siteId, email, email.split("@")[0], token, expires);
      client = { id, token, email };
    } else {
      const token = crypto.randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      db.prepare("UPDATE portal_clients SET token = ?, token_expires = ? WHERE id = ?").run(token, expires, client.id);
      client = { ...client, token };
    }

    // Send magic link by email — never return token in response
    try {
      const sgKey = db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value || process.env.SENDGRID_API_KEY;
      const fromEmail = db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value || process.env.EMAIL_FROM || "noreply@takeova.ai";
      const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
      const loginLink = `${backendUrl}/features/portal/verify?token=${client.token}&siteId=${siteId}`;
      if (sgKey) {
        const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email }] }],
            from: { email: fromEmail, name: site.name || "Client Portal" },
            subject: `Your login link for ${(site.name || "Client Portal").replace(/[\r\n]/g, "")}`,
            content: [{ type: "text/html", value: `<p>Click the link below to log in. It expires in 15 minutes.</p><p><a href="${loginLink}">Log in to your portal</a></p>` }]
          })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
    } catch(e) { /* email failure non-fatal */ }

    // Never return token — always require email verification
    res.json({ success: true, message: "Check your email for a login link." });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Verify portal magic link token
router.get("/portal/verify", (req, res) => {
  const db = getDb(); ensureTables(db);
  const { token, siteId } = req.query;
  if (!token) return res.status(400).json({ error: "Token required" });
  const client = db.prepare("SELECT * FROM portal_clients WHERE token = ? AND site_id = ? AND (token_expires IS NULL OR token_expires > datetime('now'))").get(token, siteId);
  if (!client) return res.status(401).json({ error: "Invalid or expired link. Please request a new one." });
  // Issue a longer-lived session token
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  db.prepare("UPDATE portal_clients SET token = ?, token_expires = ? WHERE id = ?").run(sessionToken, sessionExpires, client.id);
  res.json({ success: true, token: sessionToken });
});

router.get("/portal/dashboard", (req, res) => {
  const db = getDb(); ensureTables(db);
  const token = req.headers.authorization?.replace("Bearer ", "");
  const client = db.prepare("SELECT * FROM portal_clients WHERE token = ? AND (token_expires IS NULL OR token_expires > datetime('now'))").get(token);
  if (!client) return res.status(401).json({ error: "Invalid session" });

  const orders = db.prepare("SELECT * FROM orders WHERE customer_email = ? ORDER BY created_at DESC LIMIT 20").all(client.email);
  const invoices = db.prepare("SELECT * FROM invoices WHERE client_email = ? ORDER BY created_at DESC LIMIT 20").all(client.email);
  const courses = db.prepare(`SELECT c.*, e.progress, e.completed FROM courses c
    JOIN enrollments e ON e.course_id = c.id WHERE e.student_email = ?`).all(client.email);
  const bookings = db.prepare("SELECT * FROM bookings WHERE customer_email = ? AND datetime(date || ' ' || time) >= datetime('now') ORDER BY date ASC").all(client.email);

  res.json({ client: { name: client.name, email: client.email }, orders, invoices, courses, bookings });
});

// ═══════════════════════════════════════════════════════
// 3. LIVE CHAT WIDGET
// Embeddable chat for user's sites, AI auto-replies
// Replaces: Intercom ($74/mo), Crisp, Tawk.to
// ═══════════════════════════════════════════════════════

router.post("/chat/message", (req, res) => {
  const db = getDb(); ensureTables(db);
  const { siteId, visitorId, visitorName, visitorEmail, message } = req.body;

  // Input validation — prevent storage abuse
  if (!siteId || typeof siteId !== "string") return res.status(400).json({ error: "siteId required" });
  if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });
  if (message.length > 2000) return res.status(400).json({ error: "Message too long (max 2000 characters)" });
  if (visitorName && visitorName.length > 100) return res.status(400).json({ error: "Name too long" });
  if (visitorEmail && visitorEmail.length > 254) return res.status(400).json({ error: "Email too long" });

  const id = uuid();
  const vid = (typeof visitorId === "string" && visitorId.length <= 64) ? visitorId : uuid();
  const safeName = (visitorName || "Visitor").slice(0, 100).replace(/[\r\n]/g, "");
  const safeEmail = (visitorEmail || "").slice(0, 254).replace(/[\r\n]/g, "");

  db.prepare(`INSERT INTO chat_messages (id, site_id, visitor_id, visitor_name, visitor_email, message, sender, read, created_at)
    VALUES (?,?,?,?,?,?,?,0,datetime('now'))`).run(id, siteId, vid, safeName, safeEmail, message.slice(0, 2000), "visitor");

  // (Removed: dead __AI_PENDING__ stub. AI chat lives at /api/platform/chatbot/:siteId/chat
  // which is unified with the Support Agent + KB. This endpoint is owner-reply only now.)

  res.json({ success: true, messageId: id, visitorId: vid });
});

router.get("/chat/messages/:siteId/:visitorId", (req, res) => {
  const db = getDb(); ensureTables(db);
  res.json({ messages: db.prepare("SELECT * FROM chat_messages WHERE site_id = ? AND visitor_id = ? AND message != '__AI_PENDING__' ORDER BY created_at ASC").all(req.params.siteId, req.params.visitorId) });
});

// Owner views all conversations
router.get("/chat/conversations", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ conversations: [] });
  const placeholders = sites.map(() => "?").join(",");
  const convos = db.prepare(`SELECT visitor_id, visitor_name, visitor_email, site_id, MAX(created_at) as last_message,
    COUNT(*) as message_count, SUM(CASE WHEN read = 0 AND sender = 'visitor' THEN 1 ELSE 0 END) as unread
    FROM chat_messages WHERE site_id IN (${placeholders}) GROUP BY visitor_id ORDER BY last_message DESC`).all(...sites);
  res.json({ conversations: convos });
});

// Owner replies
router.post("/chat/reply", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { siteId, visitorId, message } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO chat_messages (id, site_id, visitor_id, message, sender, read, created_at)
    VALUES (?,?,?,?,?,0,datetime('now'))`).run(id, siteId, visitorId, message, "owner");
  // Mark visitor messages as read
  db.prepare("UPDATE chat_messages SET read = 1 WHERE site_id = ? AND visitor_id = ? AND sender = 'visitor'").run(siteId, visitorId);
  res.json({ success: true, id });
});

// ═══════════════════════════════════════════════════════
// 4. ABANDONED CART RECOVERY
// Auto-email when someone adds to cart but doesn't checkout
// ═══════════════════════════════════════════════════════

router.post("/cart/save", cartSaveLimiter, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { siteId, email, items, cartTotal } = req.body;
  if (!email || !items?.length) return res.status(400).json({ error: "Email and items required" });
  const id = uuid();
  db.prepare(`INSERT OR REPLACE INTO abandoned_carts (id, site_id, customer_email, items, cart_total, recovered, reminder_sent, reminder_count, created_at, updated_at)
    VALUES (?,?,?,?,?,0,0,0,datetime('now'),datetime('now'))`)
    .run(id, siteId, email, JSON.stringify(items), cartTotal || 0);
  res.json({ success: true, cartId: id });
});

router.post("/cart/recovered", (req, res) => {
  const db = getDb(); ensureTables(db);
  const { email, siteId } = req.body;
  db.prepare("UPDATE abandoned_carts SET recovered = 1 WHERE customer_email = ? AND site_id = ? AND recovered = 0").run(email, siteId);
  res.json({ success: true });
});

// Cron: send abandoned cart emails (call every hour)
router.post("/cart/cron", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    // Find carts abandoned > 1 hour ago, not recovered, < 3 reminders sent
    const carts = db.prepare(`SELECT ac.*, s.user_id FROM abandoned_carts ac
      JOIN sites s ON s.id = ac.site_id
      WHERE ac.recovered = 0 AND ac.reminder_count < 3
      AND datetime(ac.updated_at, '+1 hour') <= datetime('now')
      AND s.user_id = ? LIMIT 50`).all(req.userId);

    let sent = 0;
    for (const cart of carts) {
      const items = JSON.parse(cart.items || "[]");
      const itemList = items.map(i => `${i.name || "Item"} — $${(i.price || 0).toFixed(2)}`).join("<br>");
      const subject = cart.reminder_count === 0 ? "You left something behind..." : cart.reminder_count === 1 ? "Still interested?" : "Last chance — your cart expires soon";
      const cartUrl = cart.cart_url || "";

      // Send recovery email
      if (cart.customer_email) {
        try {
          await autoEmail(req.userId, cart.customer_email, subject,
            `<h2 style="color:#1e293b">You left something in your cart 🛒</h2>
            <p>Hi${cart.customer_name ? " " + esc(cart.customer_name) : ""},</p>
            <p>You were so close! Here's what's waiting for you:</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0">
              ${itemList}
              <div style="font-weight:700;font-size:16px;margin-top:12px;color:#2563EB">Total: $${(cart.cart_total || 0).toFixed(2)}</div>
            </div>
            ${cartUrl ? `<div style="text-align:center;margin:20px 0"><a href="${cartUrl}" style="display:inline-block;padding:14px 28px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Complete Your Order →</a></div>` : ""}
            <p style="color:#94a3b8;font-size:12px">Your cart is saved and ready when you are.</p>`
          );
        } catch(e) { console.error("[Cart Recovery] email failed:", e.message); }

        // Fire cart_abandoned automation
        fireAutomation(req.userId, "cart_abandoned", {
          email: cart.customer_email,
          name: cart.customer_name || "",
          cartTotal: cart.cart_total || 0,
          items: cart.items || "[]",
          cartUrl
        });
      }

      db.prepare("UPDATE abandoned_carts SET reminder_sent = 1, reminder_count = reminder_count + 1, updated_at = datetime('now') WHERE id = ?").run(cart.id);
      sent++;
    }
    res.json({ sent });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

router.get("/cart/abandoned", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId).map(s => s.id);
  if (!sites.length) return res.json({ carts: [], stats: {} });
  const ph = sites.map(() => "?").join(",");
  const carts = db.prepare(`SELECT * FROM abandoned_carts WHERE site_id IN (${ph}) ORDER BY created_at DESC LIMIT 50`).all(...sites);
  const total = db.prepare(`SELECT COUNT(*) as n FROM abandoned_carts WHERE site_id IN (${ph})`).get(...sites).n;
  const recovered = db.prepare(`SELECT COUNT(*) as n FROM abandoned_carts WHERE site_id IN (${ph}) AND recovered = 1`).get(...sites).n;
  res.json({ carts, stats: { total, recovered, recoveryRate: total > 0 ? Math.round(recovered / total * 100) : 0 } });
});

// ═══════════════════════════════════════════════════════
// 5. ORDER MANAGEMENT (fulfillment + tracking)
// ═══════════════════════════════════════════════════════

router.post("/orders", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { siteId, customerName, customerEmail, items, total, shippingAddress } = req.body;
  const id = uuid();
  const orderNumber = "ORD-" + Date.now().toString(36).toUpperCase();
  db.prepare(`INSERT INTO orders (id, site_id, user_id, order_number, customer_name, customer_email, items, total, shipping_address, status, fulfillment_status, tracking_number, tracking_url, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, siteId, req.userId, orderNumber, customerName, customerEmail, JSON.stringify(items), total, JSON.stringify(shippingAddress || {}), "paid", "unfulfilled", "", "", "");

  
  // Decrement stock for each purchased item
  try{
    const parsedItems=JSON.parse(JSON.stringify(items||[]));
    parsedItems.forEach(item=>{
      if(item.productId||item.id){
        db.prepare("UPDATE products SET stock=MAX(0,COALESCE(stock,0)-?) WHERE id=? AND site_id=?")
          .run(item.qty||item.quantity||1, item.productId||item.id, siteId);
      }
    });
  }catch(stockErr){}
  // Fire automation triggers
  fireAutomation(req.userId, "purchase_completed", { email: customerEmail, name: customerName, amount: total, orderNumber, items });
  // Fire webhooks for marketplace apps
  fireWebhooks(req.userId, "order.created", { id, orderNumber, customerName, customerEmail, items, total, siteId });

  // Auto-create CRM contact from order
  if (customerEmail) {
    const existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(req.userId, customerEmail);
    if (!existing) {
      db.prepare("INSERT INTO contacts (id, user_id, name, email, status, notes, tags_json, last_seen, source) VALUES (?,?,?,?,?,?,?,datetime('now'),?)")
        .run(uuid(), req.userId, customerName || "", customerEmail, "customer", "Order " + orderNumber + " — $" + total, '["customer","order"]', "Checkout");
    } else {
      db.prepare("UPDATE contacts SET status = 'customer', notes = COALESCE(notes,'') || '\n' || ?, last_seen = datetime('now') WHERE id = ?")
        .run("Order " + orderNumber + " — $" + total, existing.id);
    }
  }

  res.json({ success: true, id, orderNumber });
});

router.get("/orders", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { status, fulfillment, limit, offset } = req.query;
  let sql = "SELECT * FROM orders WHERE user_id = ?";
  const params = [req.userId];
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (fulfillment) { sql += " AND fulfillment_status = ?"; params.push(fulfillment); }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(parseInt(limit) || 50, parseInt(offset) || 0);
  res.json({ orders: db.prepare(sql).all(...params) });
});

router.post("/orders/:id/fulfill", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { trackingNumber, trackingUrl, carrier, notifyCustomer } = req.body;
    // Validate trackingUrl to only allow http/https — prevents javascript: or data: URIs in email links
    const safeTrackingUrl = (() => {
      if (!trackingUrl) return "";
      try { const u = new URL(trackingUrl); return (u.protocol === "https:" || u.protocol === "http:") ? trackingUrl : ""; } catch { return ""; }
    })();
    db.prepare(`UPDATE orders SET fulfillment_status = 'fulfilled', status = 'shipped', tracking_number = ?, tracking_url = ?, notes = COALESCE(notes,'') || ? WHERE id = ? AND user_id = ?`)
      .run(trackingNumber || "", safeTrackingUrl, `\nFulfilled ${new Date().toISOString()} via ${carrier || "manual"}`, req.params.id, req.userId);

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.json({ success: true });

    // Always notify customer when shipping
    if (order.customer_email) {
      try {
        const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
        const bizName = site?.name || "Store";
        const user = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(req.userId);
        const refCode = user?.referral_code || "";

        // Build tracking URL from carrier if not provided
        let trackUrl = safeTrackingUrl || "";
        if (!trackUrl && trackingNumber && carrier) {
          const urls = { usps: "https://tools.usps.com/go/TrackConfirmAction?tLabels=", ups: "https://www.ups.com/track?tracknum=", fedex: "https://www.fedex.com/fedextrack/?trknbr=", dhl: "https://www.dhl.com/en/express/tracking.html?AWB=", auspost: "https://auspost.com.au/mypost/track/#/details/", royalmail: "https://www3.royalmail.com/track-your-item#/tracking-results/" };
          trackUrl = (urls[carrier.toLowerCase()] || "") + encodeURIComponent(trackingNumber);
        }

        const sgKey = getSetting("SENDGRID_API_KEY");
        const fromEmail = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
        if (sgKey) {
          const fetch = (await import("node-fetch")).default;
          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: order.customer_email }] }],
              from: { email: fromEmail, name: bizName },
              subject: `Your order from ${bizName} has shipped! 📦`,
              content: [{ type: "text/html", value: `
                <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
                  <h2>Your order has shipped! 📦</h2>
                  <p>Hi ${order.customer_name || order.shipping_name || "there"},</p>
                  <p>Great news — your order <strong>#${order.order_number}</strong> from ${bizName} is on its way!</p>
                  ${trackingNumber ? `<div style="background:#f7f8fa;padding:16px;border-radius:8px;margin:16px 0">
                    <strong>Tracking Number:</strong> ${esc(trackingNumber)}${carrier ? " (" + esc(carrier.toUpperCase()) + ")" : ""}
                    ${trackUrl ? `<br><br><a href="${trackUrl}" style="display:inline-block;padding:10px 20px;background:#2563EB;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Track Your Package →</a>` : ""}
                  </div>` : "<p>We'll send tracking details once available.</p>"}
                  ${order.shipping_address ? (() => { try { const a = JSON.parse(order.shipping_address); return `<div style="font-size:13px;color:#666;margin-top:12px"><strong>Delivering to:</strong><br>${order.shipping_name || ""}<br>${a.line1 || ""}${a.line2 ? ", " + a.line2 : ""}<br>${a.city || ""}, ${a.state || ""} ${a.postal_code || ""}</div>`; } catch(e) { return ""; } })() : ""}
                  <p style="color:#666;font-size:13px;margin-top:16px">Questions about your order? Just reply to this email.</p>
                  ${getWhatsAppEmailFooter(db, req.userId)}
                  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #f0f0f0;text-align:center">
                    <a href="https://takeova.ai${refCode ? "?ref=" + refCode : ""}" style="color:#999;font-size:11px;text-decoration:none">Sent via <strong style="color:#2563EB">MINE</strong></a>
                  </div>
                </div>` }]
            })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
        }

        // Also send SMS if we have their phone
        try {
          const customer = db.prepare("SELECT phone FROM customer_accounts WHERE email = ?").get(order.customer_email);
          if (customer?.phone) {
            const twilioSid = getSetting("TWILIO_ACCOUNT_SID");
            const twilioAuth = getSetting("TWILIO_AUTH_TOKEN");
            const twilioFrom = getSetting("TWILIO_PHONE_NUMBER");
            if (twilioSid && twilioAuth && twilioFrom) {
              const fetch2 = (await import("node-fetch")).default;
              await fetch2(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
                method: "POST",
                headers: { Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
                body: (()=>{
                  // Use alphanumeric sender where supported
                  let senderName=null;try{senderName=getDb().prepare("SELECT sms_sender_name FROM users WHERE id=?").get(order.user_id)?.sms_sender_name||null;}catch(e){}
                  const from=getSmsSender(customer.phone,senderName);
                  return `To=${encodeURIComponent(customer.phone)}&From=${encodeURIComponent(from)}&Body=${encodeURIComponent(`${bizName}: Your order #${order.order_number} has shipped! ${trackUrl ? "Track it: " + trackUrl : ""}`)}`
                })()
              });
            }
          }
        } catch(e) {}

      } catch(e) { console.error("Shipping notification error:", e.message); }
    }

    // Internal notification
    db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
      .run(uuid(), req.userId, "📦", `Order ${order.order_number} fulfilled${trackingNumber ? ". Tracking: " + trackingNumber : ""}`, "Just now");

    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

router.post("/orders/:id/delivered", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    db.prepare("UPDATE orders SET status = 'delivered', fulfillment_status = 'delivered' WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (order?.customer_email) {
      try {
        const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
        const bizName = site?.name || "Store";
        const sgKey = getSetting("SENDGRID_API_KEY");
        const fromEmail = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
        if (sgKey) {
          const fetch = (await import("node-fetch")).default;
          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: order.customer_email }] }],
              from: { email: fromEmail, name: bizName },
              subject: `Your order from ${bizName} has been delivered! 🎉`,
              content: [{ type: "text/html", value: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
                <h2>Order Delivered! 🎉</h2>
                <p>Hi ${esc(order.customer_name || "there")},</p>
                <p>Your order <strong>#${order.order_number}</strong> from ${bizName} has been delivered.</p>
                <p>We hope you love it! If you have any questions or issues, just reply to this email.</p>
                <p style="margin-top:20px;color:#666;font-size:13px">Enjoying your purchase? We'd love a review! ⭐</p>
              </div>` }]
            })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
        }
      } catch(e) {}
    }
    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

router.post("/orders/:id/refund", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { amount, reason } = req.body;
  db.prepare("UPDATE orders SET status = 'refunded', notes = COALESCE(notes,'') || ? WHERE id = ? AND user_id = ?")
    .run(`\nRefunded $${amount || "full"}: ${reason || "Customer request"}`, req.params.id, req.userId);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// 6. TEAM SEATS / MULTI-USER ACCESS
// ═══════════════════════════════════════════════════════

router.post("/team/invite", auth, async (req, res) => {
  const db = getDb(); ensureTables(db);
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  // Check not already a member
  const existing = db.prepare("SELECT id FROM team_members WHERE owner_id = ? AND email = ?").get(req.userId, email);
  if (existing) return res.status(400).json({ error: "This person is already on your team" });
  const id = uuid(); const token = uuid();
  const owner = db.prepare("SELECT name, email FROM users WHERE id = ?").get(req.userId);
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  db.prepare(`INSERT INTO team_members (id, owner_id, email, role, status, invite_token, created_at)
    VALUES (?,?,?,?,?,?,datetime('now'))`).run(id, req.userId, email, role || "editor", "pending", token);
  // Send invite email
  try {
    await autoEmail(req.userId, email,
      `You've been invited to join ${owner?.name || "a TAKEOVA account"}`,
      `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:32px 24px">
        <div style="font-size:24px;font-weight:800;margin-bottom:8px">You're invited! 🎉</div>
        <p style="color:#475569;margin-bottom:24px">${owner?.name || "Someone"} has invited you to collaborate on their TAKEOVA account as a <strong>${role || "editor"}</strong>.</p>
        <a href="${frontendUrl}/accept-invite?token=${token}" style="display:inline-block;padding:14px 28px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">Accept Invitation →</a>
        <p style="color:#94A3B8;font-size:12px;margin-top:24px">If you weren't expecting this, you can ignore this email.</p>
      </div>`
    );
  } catch(e) { /* non-fatal — invite still created */ }
  res.json({ success: true, id, message: `Invite sent to ${email}` });
});

router.get("/team", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  res.json({ members: db.prepare("SELECT id, email, role, status, created_at FROM team_members WHERE owner_id = ?").all(req.userId) });
});

router.post("/team/accept/:token", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const invite = db.prepare("SELECT * FROM team_members WHERE invite_token = ? AND status = 'pending'").get(req.params.token);
  if (!invite) return res.status(404).json({ error: "Invalid or expired invite" });
  db.prepare("UPDATE team_members SET status = 'active', member_user_id = ? WHERE id = ?").run(req.userId, invite.id);
  res.json({ success: true, ownerId: invite.owner_id, role: invite.role });
});

router.delete("/team/:memberId", auth, ownerOnly, (req, res) => {
  const db = getDb(); ensureTables(db);
  db.prepare("DELETE FROM team_members WHERE id = ? AND owner_id = ?").run(req.params.memberId, req.userId);
  res.json({ success: true });
});

router.put("/team/:memberId/role", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  db.prepare("UPDATE team_members SET role = ? WHERE id = ? AND owner_id = ?").run(req.body.role, req.params.memberId, req.userId);
  res.json({ success: true });
});

// Team member login — validates invite token, issues a scoped JWT
router.post("/team/accept-invite", acceptInviteLimiter, async (req, res) => {
  try {

      const db = getDb(); ensureTables(db);
      const { token, password } = req.body;
      if (!token) return res.status(400).json({ error: "Token required" });
      const invite = db.prepare("SELECT * FROM team_members WHERE invite_token = ? AND status = 'pending'").get(token);
      if (!invite) return res.status(404).json({ error: "Invalid or expired invite link" });
      // Create or find user account for the invitee
      const { v4: uuidv4 } = require("uuid");
      const bcrypt = require("bcryptjs");
      let member = db.prepare("SELECT id FROM users WHERE email = ?").get(invite.email);
      if (!member) {
        const memberId = uuidv4();
        const hash = password ? await bcrypt.hash(password, 12) : await bcrypt.hash(uuidv4(), 12);
        db.prepare("INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
          .run(memberId, invite.email, invite.email.split("@")[0], hash, "user", "team_member");
        member = { id: memberId };
      }
      db.prepare("UPDATE team_members SET status = 'active', member_user_id = ? WHERE id = ?").run(member.id, invite.id);
      // Issue session token scoped to owner's account
      const { signToken } = require("../middleware/auth");
      const teamToken = signToken(member.id, "user", invite.owner_id, invite.role);
      res.json({ success: true, token: teamToken, role: invite.role, ownerId: invite.owner_id });

  } catch(e) {
    console.error("[Route Error]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Team member: get which owner account I belong to
router.get("/team/my-access", auth, (req, res) => {
  if (!req.isTeamMember) return res.json({ isTeamMember: false });
  res.json({ isTeamMember: true, teamRole: req.teamRole, ownerId: req.userId });
});

// ═══════════════════════════════════════════════════════
// 7. WORKFLOW AUTOMATION (if X then Y)
// Replaces: Zapier ($20/mo), Make
// ═══════════════════════════════════════════════════════

router.post("/automations", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { name, trigger, conditions, actions, enabled } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO automations (id, user_id, name, trigger_event, conditions, actions, enabled, run_count, last_run, created_at)
    VALUES (?,?,?,?,?,?,?,0,NULL,datetime('now'))`)
    .run(id, req.userId, name, trigger, JSON.stringify(conditions || []), JSON.stringify(actions || []), enabled ? 1 : 0);
  res.json({ success: true, id });
});

router.get("/automations", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const autos = db.prepare("SELECT * FROM automations WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ automations: autos.map(a => ({ ...a, conditions: JSON.parse(a.conditions || "[]"), actions: JSON.parse(a.actions || "[]") })) });
});

router.put("/automations/:id", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { name, trigger, conditions, actions, enabled } = req.body;
  db.prepare("UPDATE automations SET name=?, trigger_event=?, conditions=?, actions=?, enabled=? WHERE id=? AND user_id=?")
    .run(name, trigger, JSON.stringify(conditions || []), JSON.stringify(actions || []), enabled ? 1 : 0, req.params.id, req.userId);
  res.json({ success: true });
});

router.delete("/automations/:id", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  db.prepare("DELETE FROM automations WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// Process automation triggers (called internally when events happen)
router.post("/automations/trigger", async (req, res) => {
  try {
    // Internal-only route — must provide x-internal-key header
    const internalKey = req.headers["x-internal-key"];
    if (!((_k, _s) => _k.length > 0 && _s.length === _k.length && require("crypto").timingSafeEqual(Buffer.from(_s), Buffer.from(_k)))(process.env.INTERNAL_API_KEY || "", internalKey || "")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const db = getDb(); ensureTables(db);
    const { event, userId, data } = req.body;

    const autos = db.prepare("SELECT * FROM automations WHERE user_id = ? AND trigger_event = ? AND enabled = 1").all(userId, event);
    const results = [];

    for (const auto of autos) {
      const conditions = JSON.parse(auto.conditions || "[]");
      const actions = JSON.parse(auto.actions || "[]");

      // Check conditions
      let pass = true;
      for (const cond of conditions) {
        const val = data[cond.field];
        if (cond.op === "equals" && val !== cond.value) pass = false;
        if (cond.op === "contains" && !String(val).includes(cond.value)) pass = false;
        if (cond.op === "greater_than" && Number(val) <= Number(cond.value)) pass = false;
        if (cond.op === "less_than" && Number(val) >= Number(cond.value)) pass = false;
        if (cond.op === "not_empty" && !val) pass = false;
      }

      if (!pass) continue;

      // Execute actions
      for (const action of actions) {
        try {
          switch (action.type) {
            case "send_email": break; // Handled by email routes
            case "add_tag": db.prepare("UPDATE contacts SET tags_json = json_insert(COALESCE(tags_json,'[]'), '$[#]', ?) WHERE id = ? AND user_id = ?").run(action.tag, data.contactId, userId); break;
            case "move_pipeline": db.prepare("UPDATE contacts SET status = ? WHERE id = ? AND user_id = ?").run(action.status, data.contactId, userId); break;
            case "create_task": db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)").run(uuid(), userId, "📋", action.text || "New task from automation", "Just now"); break;
            case "send_webhook": {
              // Validate webhook URL is a public https endpoint (prevent SSRF to internal services)
              let webhookUrl;
              try {
                webhookUrl = new URL(action.url);
                if (webhookUrl.protocol !== "https:") throw new Error("HTTPS required");
                // Block internal/private IP ranges
                const host = webhookUrl.hostname;
                if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "::1") {
                  throw new Error("Internal URLs not allowed");
                }
              } catch(urlErr) {
                results.push({ automation: auto.name, action: action.type, success: false, error: `Invalid webhook URL` });
                continue;
              }
              const fetch = (await import("node-fetch")).default;
              fetch(webhookUrl.href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).catch(() => {});
              break;
            }
            case "update_field": {
              // Allowlist contact fields to prevent SQL injection via action.field
              const ALLOWED_CONTACT_FIELDS = ["name","email","phone","status","notes","company","address","tags_json"];
              const field = action.field;
              if (!ALLOWED_CONTACT_FIELDS.includes(field)) {
                results.push({ automation: auto.name, action: action.type, success: false, error: `Invalid field: ${field}` });
                continue;
              }
              db.prepare(`UPDATE contacts SET ${field} = ? WHERE id = ? AND user_id = ?`).run(action.value, data.contactId, userId);
              break;
            }
            case "notify": db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)").run(uuid(), userId, "🔔", action.message || `Automation triggered: ${auto.name}`, "Just now"); break;
          }
          results.push({ automation: auto.name, action: action.type, success: true });
        } catch (e) { console.error("[Automation] action failed:", e.message); results.push({ automation: auto.name, action: action.type, success: false, error: "Action failed" }); }
      }

      db.prepare("UPDATE automations SET run_count = run_count + 1, last_run = datetime('now') WHERE id = ?").run(auto.id);
    }

    res.json({ triggered: results.length, results });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════════════════
// 8. DEAL VALUES + LEAD SCORING IN CRM
// ═══════════════════════════════════════════════════════

router.post("/crm/deal", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { contactId, title, value, currency, stage, probability, expectedClose, notes } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO deals (id, user_id, contact_id, title, value, currency, stage, probability, expected_close, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, req.userId, contactId, title || "New Deal", value || 0, currency || "USD", stage || "lead", probability || 20, expectedClose || "", notes || "");
  res.json({ success: true, id });
});

router.get("/crm/deals", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { stage } = req.query;
  let sql = "SELECT d.*, c.name as contact_name, c.email as contact_email FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.user_id = ?";
  const params = [req.userId];
  if (stage) { sql += " AND d.stage = ?"; params.push(stage); }
  sql += " ORDER BY d.value DESC";
  res.json({ deals: db.prepare(sql).all(...params) });
});

router.put("/crm/deal/:id", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { stage, value, probability, notes } = req.body;
  if (stage) db.prepare("UPDATE deals SET stage = ? WHERE id = ? AND user_id = ?").run(stage, req.params.id, req.userId);
  if (value !== undefined) db.prepare("UPDATE deals SET value = ? WHERE id = ? AND user_id = ?").run(value, req.params.id, req.userId);
  if (probability !== undefined) db.prepare("UPDATE deals SET probability = ? WHERE id = ? AND user_id = ?").run(probability, req.params.id, req.userId);
  if (notes) db.prepare("UPDATE deals SET notes = COALESCE(notes,'') || '\n' || ? WHERE id = ? AND user_id = ?").run(notes, req.params.id, req.userId);
  res.json({ success: true });
});

router.get("/crm/pipeline", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const stages = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
  const pipeline = {};
  stages.forEach(s => {
    const deals = db.prepare("SELECT * FROM deals WHERE user_id = ? AND stage = ?").all(req.userId, s);
    pipeline[s] = { count: deals.length, totalValue: deals.reduce((sum, d) => sum + (d.value || 0), 0), deals };
  });
  const weighted = db.prepare("SELECT SUM(value * probability / 100.0) as n FROM deals WHERE user_id = ? AND stage NOT IN ('won','lost')").get(req.userId).n || 0;
  res.json({ pipeline, weightedValue: Math.round(weighted * 100) / 100 });
});

// Lead scoring
router.post("/crm/score", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { contactId } = req.body;
  const contact = db.prepare("SELECT * FROM contacts WHERE id = ? AND user_id = ?").get(contactId, req.userId);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  let score = 0;
  // Email provided: +10
  if (contact.email) score += 10;
  // Phone provided: +10
  if (contact.phone) score += 10;
  // Has company: +5
  if (contact.company) score += 5;
  // Has deals
  const deals = db.prepare("SELECT COUNT(*) as n, SUM(value) as v FROM deals WHERE contact_id = ?").get(contactId);
  if (deals.n > 0) score += 15;
  if (deals.v > 1000) score += 10;
  // Has bookings
  const bookings = db.prepare("SELECT COUNT(*) as n FROM bookings WHERE customer_email = ?").get(contact.email || "").n;
  if (bookings > 0) score += 20;
  // Has orders
  const orders = db.prepare("SELECT COUNT(*) as n FROM orders WHERE customer_email = ?").get(contact.email || "").n;
  if (orders > 0) score += 20;
  // Was contacted
  if (contact.status === "contacted" || contact.last_contacted) score += 5;
  // Replied to outreach
  if (contact.status === "replied") score += 15;

  const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";
  db.prepare("UPDATE contacts SET lead_score = ?, lead_grade = ? WHERE id = ?").run(score, grade, contactId);
  res.json({ score, grade, contactId });
});

// ═══════════════════════════════════════════════════════
// 9. PRODUCT REVIEWS (verified buyers)
// ═══════════════════════════════════════════════════════

router.post("/reviews", reviewSubmitLimiter, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { productId, siteId, name, email, rating, title, body } = req.body;
  // Check if verified buyer
  const order = db.prepare("SELECT id FROM orders WHERE customer_email = ? AND items LIKE ?").get(email, `%${productId}%`);
  const id = uuid();
  db.prepare(`INSERT INTO product_reviews (id, product_id, site_id, name, email, rating, title, body, verified_purchase, status, helpful_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'))`)
    .run(id, productId, siteId, name, email, Math.min(5, Math.max(1, rating)), title || "", body || "", order ? 1 : 0, "pending");
  // Fire automation trigger — get user_id from site
  const siteOwner = db.prepare("SELECT user_id FROM sites WHERE id = ?").get(siteId);
  if (siteOwner) { fireAutomation(siteOwner.user_id, "review_posted", { name, email, rating, title, productId }); fireWebhooks(siteOwner.user_id, "review.created", { name, email, rating, title, productId }); }
  res.json({ success: true, id, verified: !!order });
});

// /reviews/list must come BEFORE /reviews/:productId to avoid shadowing
router.get("/reviews/list", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, customer_name TEXT, customer_email TEXT, rating INTEGER, comment TEXT, approved INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))");
// Change 9: schema-drift ALTERs for reviews
try { db.exec("ALTER TABLE reviews ADD COLUMN flag_for_human INTEGER DEFAULT 0"); } catch(_){}
  const reviews = db.prepare("SELECT * FROM reviews WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
  res.json({ reviews });
});

router.get("/reviews/:productId", (req, res) => {
  const db = getDb(); ensureTables(db);
  const reviews = db.prepare("SELECT * FROM product_reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC").all(req.params.productId);
  const avg = db.prepare("SELECT AVG(rating) as avg, COUNT(*) as count FROM product_reviews WHERE product_id = ? AND status = 'approved'").get(req.params.productId);
  res.json({ reviews, average: Math.round((avg.avg || 0) * 10) / 10, count: avg.count });
});

router.post("/reviews/:id/approve", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  // Only the site owner can approve reviews on their sites
  db.prepare("UPDATE product_reviews SET status = 'approved' WHERE id = ? AND site_id IN (SELECT id FROM sites WHERE user_id = ?)").run(req.params.id, req.userId);
  res.json({ success: true });
});

router.post("/reviews/:id/reject", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  db.prepare("UPDATE product_reviews SET status = 'rejected' WHERE id = ? AND site_id IN (SELECT id FROM sites WHERE user_id = ?)").run(req.params.id, req.userId);
  res.json({ success: true });
});

router.post("/reviews/:id/reply", auth, (req, res) => {
  try {
    const db = getDb();
    const { reply } = req.body;
    if (!reply || typeof reply !== "string" || reply.trim().length < 2) return res.status(400).json({ error: "Reply text required" });
    // Works for both reviews (user-level) and product_reviews (site-level)
    const r1 = db.prepare("UPDATE reviews SET owner_reply = ?, owner_reply_at = datetime('now') WHERE id = ? AND user_id = ?").run(reply.trim(), req.params.id, req.userId);
    const r2 = r1.changes === 0
      ? db.prepare("UPDATE product_reviews SET owner_reply = ?, owner_reply_at = datetime('now') WHERE id = ? AND site_id IN (SELECT id FROM sites WHERE user_id = ?)").run(reply.trim(), req.params.id, req.userId)
      : { changes: 0 };
    if (r1.changes + r2.changes === 0) return res.status(404).json({ error: "Review not found" });
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message); res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════════════════════
// 10. PAYMENT PLANS / INSTALLMENTS
// ═══════════════════════════════════════════════════════

router.post("/payment-plans", auth, (req, res) => {
  try {
  const db = getDb(); ensureTables(db);
    const { productId, siteId, totalAmount, installments, intervalDays, name } = req.body;
    const id = uuid();
    const perPayment = Math.ceil(totalAmount / installments * 100) / 100;
    db.prepare(`INSERT INTO payment_plans (id, user_id, site_id, product_id, name, total_amount, installments, per_payment, interval_days, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(id, req.userId, siteId, productId || "", name || "Payment Plan", totalAmount, installments, perPayment, intervalDays || 30, "active");
    res.json({ success: true, id, perPayment });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.get("/payment-plans", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  res.json({ plans: db.prepare("SELECT * FROM payment_plans WHERE user_id = ? ORDER BY created_at DESC").all(req.userId) });
});

// Customer enrolls in payment plan
router.post("/payment-plans/:planId/enroll", (req, res) => {
  try {
  const db = getDb(); ensureTables(db);
    const { customerEmail, customerName } = req.body;
    const plan = db.prepare("SELECT * FROM payment_plans WHERE id = ?").get(req.params.planId);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    const id = uuid();
    db.prepare(`INSERT INTO payment_plan_enrollments (id, plan_id, user_id, customer_email, customer_name, payments_made, next_payment_date, status, created_at)
      VALUES (?,?,?,?,?,0,datetime('now','+' || ? || ' days'),?,datetime('now'))`)
      .run(id, plan.id, plan.user_id, customerEmail, customerName, plan.interval_days, "active");
    res.json({ success: true, enrollmentId: id, firstPayment: plan.per_payment, totalPayments: plan.installments });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ═══════════════════════════════════════════════════════
// 11. COURSE QUIZZES / ASSESSMENTS
// ═══════════════════════════════════════════════════════

router.get("/courses/:courseId/quizzes", (req, res) => {
  const db = getDb(); ensureTables(db);
  const quizzes = db.prepare("SELECT * FROM course_quizzes WHERE course_id = ?").all(req.params.courseId);
  res.json({ quizzes: quizzes.map(q => ({ ...q, questions: JSON.parse(q.questions || "[]") })) });
});

router.post("/quiz/:quizId/submit", (req, res) => {
  const db = getDb(); ensureTables(db);
  const { studentEmail, answers } = req.body;
  const quiz = db.prepare("SELECT * FROM course_quizzes WHERE id = ?").get(req.params.quizId);
  if (!quiz) return res.status(404).json({ error: "Quiz not found" });

  const questions = JSON.parse(quiz.questions || "[]");
  let correct = 0;
  questions.forEach((q, i) => { if (answers[i] === q.correct) correct++; });
  const score = questions.length > 0 ? Math.round(correct / questions.length * 100) : 0;
  const passed = score >= (quiz.passing_score || 70);

  const id = uuid();
  db.prepare(`INSERT INTO quiz_attempts (id, quiz_id, student_email, answers, score, passed, created_at)
    VALUES (?,?,?,?,?,?,datetime('now'))`).run(id, req.params.quizId, studentEmail, JSON.stringify(answers), score, passed ? 1 : 0);

  res.json({ score, passed, correct, total: questions.length });
});

// ═══════════════════════════════════════════════════════
// 12. CONTRACTS & E-SIGNATURES
// ═══════════════════════════════════════════════════════

router.post("/contracts", auth, (req, res) => {
  const db = getDb(); ensureTables(db);

  // Cap check
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const check = global.mineCheckUsage(db, req.userId, "contracts");
    if (check.blocked) return res.status(403).json({ error: "You've reached your contract limit. Upgrade your plan to create more.", cap: check.cap, upgrade: true });
  }

  const { title, body, clientEmail, clientName, expiresAt } = req.body;
  const id = uuid();
  const signToken = uuid();
  db.prepare(`INSERT INTO contracts (id, user_id, title, body, client_email, client_name, sign_token, status, expires_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, req.userId, title || "Contract", body || "", clientEmail, clientName || "", signToken, "pending", expiresAt || null);

  // Track usage
  let isOverage = false;
  if (typeof global !== "undefined" && global.mineTrackUsage) {
    const t = global.mineTrackUsage(db, req.userId, "contracts");
    isOverage = t?.isOverage || false;
    if (isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
  }

  res.json({ success: true, id, signUrl: `${FRONTEND_URL || ""}/sign/${signToken}`, isOverage });
});

router.get("/contracts", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  res.json({ contracts: db.prepare("SELECT * FROM contracts WHERE user_id = ? ORDER BY created_at DESC").all(req.userId) });
});

router.get("/contracts/sign/:token", (req, res) => {
  const db = getDb(); ensureTables(db);
  const contract = db.prepare("SELECT id, title, body, content, client_name, status, expires_at FROM contracts WHERE sign_token = ?").get(req.params.token);
  if (contract) contract.body = contract.body || contract.content || "";
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (contract.status === "signed") return res.json({ ...contract, alreadySigned: true });
  if (contract.expires_at && new Date(contract.expires_at) < new Date()) return res.status(410).json({ error: "Contract expired" });
  res.json(contract);
});

router.post("/contracts/sign/:token", async (req, res) => {
  const db = getDb(); ensureTables(db);
  const { signatureName, signatureData, agreedToTerms } = req.body;
  if (!agreedToTerms) return res.status(400).json({ error: "Must agree to terms" });

  const contract = db.prepare("SELECT * FROM contracts WHERE sign_token = ? AND status = 'pending'").get(req.params.token);
  if (!contract) return res.status(404).json({ error: "Contract not found or already signed" });

  db.prepare("UPDATE contracts SET status = 'signed', signed_at = datetime('now'), signature_name = ?, signature_data = ?, signed_ip = ? WHERE id = ?")
    .run(signatureName || "", signatureData || "", req.ip, contract.id);

  db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
    .run(uuid(), contract.user_id, "✍️", `${contract.client_name || "Client"} signed "${contract.title}"`, "Just now");

  // Send email notification to owner — fire-and-forget
  try {
    const owner = db.prepare("SELECT email, name FROM users WHERE id = ?").get(contract.user_id);
    if (owner?.email) {
      await autoEmail(contract.user_id, owner.email,
        `Contract signed — ${String(contract.title || "Agreement").replace(/[\r\n]/g, "")}`,
        `<h2>Contract Signed! ✅</h2>
        <p>Great news — <strong>${esc(signatureName || contract.signer_name || "the client")}</strong> has signed your contract: <strong>${esc(contract.title || "Agreement")}</strong>.</p>
        <p>Signed at: ${new Date().toLocaleString()}</p>
        <p>You can view the signed contract in your TAKEOVA dashboard.</p>`
      ).catch(() => {});
    }
  } catch(e) {}

  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// 13. COACHING PIPELINE (session notes)
// ═══════════════════════════════════════════════════════

router.post("/coaching/session", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { clientId, clientName, clientEmail, date, duration, notes, goals, homework, nextSession } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO coaching_sessions (id, user_id, client_id, client_name, client_email, date, duration_min, notes, goals, homework, next_session, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, req.userId, clientId || "", clientName, clientEmail || "", date || new Date().toISOString(), duration || 60, notes || "", JSON.stringify(goals || []), homework || "", nextSession || "");
  res.json({ success: true, id });
});

router.get("/coaching/sessions", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { clientId } = req.query;
  let sql = "SELECT * FROM coaching_sessions WHERE user_id = ?";
  const params = [req.userId];
  if (clientId) { sql += " AND client_id = ?"; params.push(clientId); }
  sql += " ORDER BY date DESC";
  res.json({ sessions: db.prepare(sql).all(...params).map(s => ({ ...s, goals: JSON.parse(s.goals || "[]") })) });
});

router.get("/coaching/client/:email", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const sessions = db.prepare("SELECT * FROM coaching_sessions WHERE user_id = ? AND client_email = ? ORDER BY date DESC").all(req.userId, req.params.email);
  const totalHours = sessions.reduce((sum, s) => sum + (s.duration_min || 0), 0) / 60;
  res.json({ sessions: sessions.map(s => ({ ...s, goals: JSON.parse(s.goals || "[]") })), totalHours, totalSessions: sessions.length });
});

// ═══════════════════════════════════════════════════════
// 14. RECURRING APPOINTMENTS
// ═══════════════════════════════════════════════════════

router.post("/bookings/recurring", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { serviceId, customerName, customerEmail, day, time, frequency, startDate, endDate } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO recurring_bookings (id, user_id, service_id, customer_name, customer_email, day_of_week, time, frequency, start_date, end_date, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, req.userId, serviceId || "", customerName, customerEmail || "", day, time, frequency || "weekly", startDate || new Date().toISOString().slice(0, 10), endDate || "", "active");
  fireAutomation(req.userId, "booking_created", { name: customerName, email: customerEmail, service: serviceId, day, time }); fireWebhooks(req.userId, "booking.created", { customerName, customerEmail, serviceId, day, time });
  // Auto-create CRM contact from booking
  if (customerEmail) {
    const existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(req.userId, customerEmail);
    if (!existing) {
      db.prepare("INSERT INTO contacts (id, user_id, name, email, status, notes, tags_json, last_seen, source) VALUES (?,?,?,?,?,?,?,datetime('now'),?)")
        .run(uuid(), req.userId, customerName || "", customerEmail, "lead", "Booked: " + (day || "") + " " + (time || ""), '["booking"]', "Booking");
    } else {
      db.prepare("UPDATE contacts SET notes = COALESCE(notes,'') || '\n' || ?, last_seen = datetime('now') WHERE id = ?")
        .run("Booking: " + (day || "") + " " + (time || ""), existing.id);
    }
  }
  res.json({ success: true, id });
});

router.get("/bookings/recurring", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  res.json({ recurring: db.prepare("SELECT * FROM recurring_bookings WHERE user_id = ? AND status = 'active' ORDER BY day_of_week").all(req.userId).slice(0, 200) });
});

router.delete("/bookings/recurring/:id", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  db.prepare("UPDATE recurring_bookings SET status = 'cancelled' WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// 15. GROUP BOOKINGS
// ═══════════════════════════════════════════════════════

router.post("/bookings/group", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { serviceId, title, date, time, maxAttendees, price, description } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO group_bookings (id, user_id, service_id, title, date, time, max_attendees, current_attendees, price, description, status, created_at)
    VALUES (?,?,?,?,?,?,?,0,?,?,?,datetime('now'))`)
    .run(id, req.userId, serviceId || "", title, date, time, maxAttendees || 10, price || 0, description || "", "open");
  res.json({ success: true, id });
});

router.post("/bookings/group/:id/join", (req, res) => {
  const db = getDb(); ensureTables(db);
  const { name, email } = req.body;
  const booking = db.prepare("SELECT * FROM group_bookings WHERE id = ?").get(req.params.id);
  if (!booking) return res.status(404).json({ error: "Not found" });
  if (booking.current_attendees >= booking.max_attendees) return res.status(400).json({ error: "Class is full" });

  // Atomic increment with capacity guard — prevents race condition double-booking
  const joinResult = db.prepare(
    "UPDATE group_bookings SET current_attendees = current_attendees + 1 WHERE id = ? AND current_attendees < max_attendees"
  ).run(req.params.id);
  if (joinResult.changes === 0) return res.status(400).json({ error: "Class is full — no spots remaining" });
  db.prepare(`INSERT INTO group_booking_attendees (id, group_booking_id, name, email, created_at) VALUES (?,?,?,?,datetime('now'))`)
    .run(uuid(), req.params.id, name, email);
  fireAutomation(booking.user_id, "booking_created", { name, email, service: booking.title, date: booking.date, time: booking.time });
  // Auto-create CRM contact from group booking
  if (email) {
    const existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(booking.user_id, email);
    if (!existing) {
      db.prepare("INSERT INTO contacts (id, user_id, name, email, status, notes, tags_json, last_seen, source) VALUES (?,?,?,?,?,?,?,datetime('now'),?)")
        .run(uuid(), booking.user_id, name || "", email, "lead", "Group booking: " + booking.title + " on " + booking.date, '["booking","group"]', "Group Booking");
    }
  }
  res.json({ success: true, spotsRemaining: booking.max_attendees - booking.current_attendees - 1 });
});

router.get("/bookings/group", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  res.json({ bookings: db.prepare("SELECT * FROM group_bookings WHERE user_id = ? ORDER BY date ASC").all(req.userId) });
});

// ═══════════════════════════════════════════════════════
// 16. WAITLIST / PRE-LAUNCH PAGES
// ═══════════════════════════════════════════════════════

router.post("/waitlist", (req, res) => {
  const db = getDb(); ensureTables(db);
  const { siteId, email, name, source } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const existing = db.prepare("SELECT id FROM waitlist_entries WHERE site_id = ? AND email = ?").get(siteId, email);
  if (existing) return res.json({ success: true, alreadyJoined: true });
  const id = uuid();
  const position = (db.prepare("SELECT COUNT(*) as n FROM waitlist_entries WHERE site_id = ?").get(siteId).n || 0) + 1;
  db.prepare(`INSERT INTO waitlist_entries (id, site_id, email, name, source, position, status, created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(id, siteId, email, name || "", source || "direct", position, "waiting");
  res.json({ success: true, position, id });
});

router.get("/waitlist/:siteId", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  if (!db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId)) return res.status(404).json({ error: "site not found" });
  const entries = db.prepare("SELECT * FROM waitlist_entries WHERE site_id = ? ORDER BY position ASC").all(req.params.siteId);
  res.json({ entries, total: entries.length });
});

router.post("/waitlist/:siteId/notify", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { count } = req.body;
  if (!db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId)) return res.status(404).json({ error: "site not found" });
  const entries = db.prepare("SELECT * FROM waitlist_entries WHERE site_id = ? AND status = 'waiting' ORDER BY position ASC LIMIT ?").all(req.params.siteId, count || 10);
  entries.forEach(e => {
    db.prepare("UPDATE waitlist_entries SET status = 'notified' WHERE id = ?").run(e.id);
  });
  res.json({ notified: entries.length, entries });
});

// ═══════════════════════════════════════════════════════
// DB TABLES
// ═══════════════════════════════════════════════════════

function ensureTables(db) {
  // Migrate existing portal_clients table to add token_expires if missing
  try { db.exec("ALTER TABLE portal_clients ADD COLUMN token_expires TEXT"); } catch(e) {}
  // Migrate automations table
  try { db.exec("ALTER TABLE automations ADD COLUMN trigger_event TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE automations ADD COLUMN conditions TEXT DEFAULT '[]'"); } catch(e) {}
  try { db.exec("ALTER TABLE automations ADD COLUMN actions TEXT DEFAULT '[]'"); } catch(e) {}
  try { db.exec("ALTER TABLE automations ADD COLUMN enabled INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE automations ADD COLUMN run_count INTEGER DEFAULT 0"); } catch(e) {}
  // Migrate contracts table
  try { db.exec("ALTER TABLE contracts ADD COLUMN sign_token TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE contracts ADD COLUMN body TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE contracts ADD COLUMN signature_data TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE contracts ADD COLUMN signature_name TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE contracts ADD COLUMN expires_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE contracts ADD COLUMN signed_ip TEXT"); } catch(e) {}
  // Migrate reviews table
  try { db.exec("ALTER TABLE reviews ADD COLUMN customer_name TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE reviews ADD COLUMN customer_email TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE reviews ADD COLUMN approved INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE reviews ADD COLUMN comment TEXT"); } catch(e) {}
  // Migrate funnels table
  try { db.exec("ALTER TABLE funnels ADD COLUMN trigger_event TEXT"); } catch(e) {}
  // Migrate proposals table
  try { db.exec("ALTER TABLE proposals ADD COLUMN services TEXT DEFAULT '[]'"); } catch(e) {}
  try { db.exec("ALTER TABLE proposals ADD COLUMN html TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE proposals ADD COLUMN follow_up_count INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE proposals ADD COLUMN opened_at TEXT"); } catch(e) {}
  db.exec(`
    -- Community
    CREATE TABLE IF NOT EXISTS community_spaces (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, name TEXT, description TEXT, type TEXT, is_private INTEGER DEFAULT 0, member_count INTEGER DEFAULT 0, created_at TEXT);
    CREATE TABLE IF NOT EXISTS community_posts (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, author_name TEXT, title TEXT, body TEXT, type TEXT, likes INTEGER DEFAULT 0, replies_count INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, created_at TEXT);
    CREATE TABLE IF NOT EXISTS community_replies (id TEXT PRIMARY KEY, post_id TEXT, user_id TEXT, author_name TEXT, body TEXT, likes INTEGER DEFAULT 0, created_at TEXT);
    -- Client portal
    CREATE TABLE IF NOT EXISTS portal_clients (id TEXT PRIMARY KEY, site_id TEXT, email TEXT, name TEXT, token TEXT, token_expires TEXT, created_at TEXT);
    -- Chat
    CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, site_id TEXT, visitor_id TEXT, visitor_name TEXT, visitor_email TEXT, message TEXT, sender TEXT, read INTEGER DEFAULT 0, created_at TEXT);
    -- Abandoned carts
    CREATE TABLE IF NOT EXISTS abandoned_carts (id TEXT PRIMARY KEY, site_id TEXT, email TEXT, items TEXT, cart_total REAL, recovered INTEGER DEFAULT 0, reminder_sent INTEGER DEFAULT 0, reminder_count INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    -- Orders (extended)
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, order_number TEXT, customer_name TEXT, customer_email TEXT, items TEXT, total REAL, shipping_name TEXT, shipping_address TEXT, status TEXT DEFAULT 'paid', fulfillment_status TEXT DEFAULT 'unfulfilled', tracking_number TEXT, tracking_url TEXT, carrier TEXT, label_url TEXT, stripe_session_id TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    -- Team
    CREATE TABLE IF NOT EXISTS team_members (id TEXT PRIMARY KEY, owner_id TEXT, member_user_id TEXT, email TEXT, role TEXT, status TEXT, invite_token TEXT, created_at TEXT);
    -- Automations
    CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, trigger_event TEXT, conditions TEXT, actions TEXT, enabled INTEGER DEFAULT 0, run_count INTEGER DEFAULT 0, last_run TEXT, created_at TEXT);
    -- Deals
    CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, user_id TEXT, contact_id TEXT, title TEXT, value REAL DEFAULT 0, currency TEXT, stage TEXT, probability INTEGER DEFAULT 20, expected_close TEXT, notes TEXT, created_at TEXT);
    -- Reviews
    CREATE TABLE IF NOT EXISTS product_reviews (id TEXT PRIMARY KEY, product_id TEXT, site_id TEXT, name TEXT, email TEXT, rating INTEGER, title TEXT, body TEXT, verified_purchase INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', helpful_count INTEGER DEFAULT 0, owner_reply TEXT, owner_reply_at TEXT, created_at TEXT);
    -- Payment plans
    CREATE TABLE IF NOT EXISTS payment_plans (id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT, product_id TEXT, name TEXT, total_amount REAL, installments INTEGER, per_payment REAL, interval_days INTEGER DEFAULT 30, status TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS payment_plan_enrollments (id TEXT PRIMARY KEY, plan_id TEXT, user_id TEXT, customer_email TEXT, customer_name TEXT, payments_made INTEGER DEFAULT 0, next_payment_date TEXT, status TEXT, created_at TEXT);
    -- Quizzes
    CREATE TABLE IF NOT EXISTS course_quizzes (id TEXT PRIMARY KEY, course_id TEXT, lesson_id TEXT, user_id TEXT, title TEXT, questions TEXT, passing_score INTEGER DEFAULT 70, created_at TEXT);
    CREATE TABLE IF NOT EXISTS quiz_attempts (id TEXT PRIMARY KEY, quiz_id TEXT, student_email TEXT, answers TEXT, score INTEGER, passed INTEGER, created_at TEXT);
    -- Contracts
    CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, body TEXT, client_email TEXT, client_name TEXT, sign_token TEXT, status TEXT, signature_name TEXT, signature_data TEXT, signed_at TEXT, signed_ip TEXT, expires_at TEXT, created_at TEXT);
    -- Coaching
    CREATE TABLE IF NOT EXISTS coaching_sessions (id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, client_name TEXT, client_email TEXT, date TEXT, duration_min INTEGER, notes TEXT, goals TEXT, homework TEXT, next_session TEXT, created_at TEXT);
    -- Recurring bookings
    CREATE TABLE IF NOT EXISTS recurring_bookings (id TEXT PRIMARY KEY, user_id TEXT, service_id TEXT, customer_name TEXT, customer_email TEXT, day_of_week TEXT, time TEXT, frequency TEXT, start_date TEXT, end_date TEXT, status TEXT, created_at TEXT);
    -- Group bookings
    CREATE TABLE IF NOT EXISTS group_bookings (id TEXT PRIMARY KEY, user_id TEXT, service_id TEXT, title TEXT, date TEXT, time TEXT, max_attendees INTEGER, current_attendees INTEGER DEFAULT 0, price REAL, description TEXT, status TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS group_booking_attendees (id TEXT PRIMARY KEY, group_booking_id TEXT, name TEXT, email TEXT, created_at TEXT);
    -- Waitlist
    CREATE TABLE IF NOT EXISTS waitlist_entries (id TEXT PRIMARY KEY, site_id TEXT, email TEXT, name TEXT, source TEXT, position INTEGER, status TEXT, created_at TEXT);
    -- Enrollments (for client portal)
    CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, progress INTEGER DEFAULT 0, completed INTEGER DEFAULT 0, created_at TEXT);
    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_community_posts_space ON community_posts(space_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_site ON chat_messages(site_id, visitor_id);
    CREATE INDEX IF NOT EXISTS idx_deals_user ON deals(user_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_id);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(user_id, trigger_event);
  `);
}


// GET /api/features/video/status/:taskId — poll Arcads video render status
router.get("/video/status/:taskId", auth, async (req, res) => {
  // Arcads removed — use /video/heygen-status/:taskId for HeyGen videos
  return res.status(410).json({
    status: "error",
    error: "Arcads has been discontinued. Use HeyGen for UGC/avatar videos via /api/features/video/heygen-status/:taskId"
  });
});


// GET /api/features/video/avatars — returns HeyGen avatars (Arcads deprecated)
router.get("/video/avatars", auth, async (req, res) => {
  try {
    const heygenKey = getSetting("HEYGEN_API_KEY") || process.env.HEYGEN_API_KEY;
    if (!heygenKey) {
      // Return generic default options if no HeyGen key
      return res.json({ avatars: [
        { id: "auto", name: "Auto Select", desc: "System picks the best match", style: "auto", thumbnail: null },
        { id: "lifestyle_female", name: "Lifestyle Female", desc: "Casual, energetic female presenter", style: "lifestyle" },
        { id: "lifestyle_male", name: "Lifestyle Male", desc: "Casual, energetic male presenter", style: "lifestyle" },
        { id: "professional_female", name: "Professional Female", desc: "Smart, polished female presenter", style: "professional" },
        { id: "professional_male", name: "Professional Male", desc: "Smart, polished male presenter", style: "professional" },
      ], source: "defaults" });
    }
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://api.heygen.com/v2/avatars", {
      headers: { "X-Api-Key": heygenKey }
    });
    const d = await r.json();
    const avatars = (d.data?.avatars || d.avatars || []).slice(0, 20).map(a => ({
      id: a.avatar_id || a.id,
      name: a.avatar_name || a.name,
      desc: a.gender || "",
      style: "heygen",
      thumbnail: a.preview_image_url || a.thumbnail || null,
    }));
    res.json({ avatars: [{ id: "auto", name: "Auto Select", desc: "HeyGen picks the best match" }, ...avatars], source: "heygen" });
  } catch(e) {
    res.json({ avatars: [
      { id: "auto", name: "Auto Select", desc: "System picks the best match" },
      { id: "lifestyle_female", name: "Lifestyle Female", desc: "Casual female presenter", style: "lifestyle" },
      { id: "lifestyle_male", name: "Lifestyle Male", desc: "Casual male presenter", style: "lifestyle" },
      { id: "professional_female", name: "Professional Female", desc: "Polished female presenter", style: "professional" },
      { id: "professional_male", name: "Professional Male", desc: "Polished male presenter", style: "professional" },
    ], source: "fallback" });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// LEAD NURTURE FACTORY — 4-agent AI-powered campaign builder
// POST /api/features/outreach/nurture
// ANALYZER → STRATEGIST → COMPOSER → SCHEDULER
// ─────────────────────────────────────────────────────────────────────────────
router.post("/outreach/nurture", auth, async (req, res) => {
  const { contactIds, campaignName, goal, businessContext } = req.body;
  if (!contactIds?.length) return res.status(400).json({ error: "No contacts provided" });

  const db = getDb();
  const userId = req.userId;

  // Check outreachEmails cap
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, userId, "outreachEmails");
    if (usage.blocked) return res.status(403).json({ error: "Outreach email limit reached for your plan." });
  }

  const anthropicKey = getSetting("ANTHROPIC_API_KEY");
  if (!anthropicKey) return res.status(503).json({ error: "Anthropic API key required" });

  // Load contacts
  const contacts = db.prepare(`
    SELECT id, name, email, phone, company, notes, tags, status, created_at,
           (SELECT COUNT(*) FROM orders WHERE user_id = ? AND customer_email = contacts.email) as order_count,
           (SELECT SUM(total) FROM orders WHERE user_id = ? AND customer_email = contacts.email) as total_spend
    FROM contacts WHERE user_id = ? AND id IN (${contactIds.map(() => "?").join(",")})
  `).all(userId, userId, userId, ...contactIds);

  if (!contacts.length) return res.status(404).json({ error: "No contacts found" });

  // Load business context
  const site = db.prepare("SELECT name, data FROM sites WHERE user_id = ? LIMIT 1").get(userId);
  const siteData = (() => { try { return JSON.parse(site?.data || "{}"); } catch(e) { return {}; } })();
  const products = (siteData.products || []).slice(0, 10).map(p => `${p.name} ($${p.price})`).join(", ");

  async function nfClaude(system, user, maxTok = 500) {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTok, system, messages: [{ role: "user", content: user }] })
    });
    const d = await r.json();
    return d.content?.[0]?.text || "";
  }

  const results = { analyzed: 0, sequences_created: 0, emails_queued: 0, contacts_processed: [] };

  for (const contact of contacts) {
    try {
      // ── AGENT 1: ANALYZER — score, segment, identify pain point ─────────────
      const analysisRaw = await nfClaude(
        `You are a lead analyst. Score this contact and identify their likely pain point and best offer.
Business: ${site?.name || "unknown"}, Products: ${products || "various"}
Respond ONLY in JSON:
{"score":1-100,"segment":"hot|warm|cold","pain_point":"one specific likely pain","best_offer":"product or service name","follow_up_urgency":"24h|3days|1week","personalization_angle":"what makes this contact unique"}`,
        `Contact: ${contact.name}, Company: ${contact.company || "n/a"}, Tags: ${contact.tags || "none"}, Notes: ${contact.notes || "none"}, Orders: ${contact.order_count || 0}, Total spend: $${contact.total_spend || 0}`
      );
      let analysis = { score: 50, segment: "warm", pain_point: "efficiency", best_offer: products.split(",")[0] || "our service", follow_up_urgency: "3days", personalization_angle: contact.name };
      try { analysis = { ...analysis, ...JSON.parse(analysisRaw) }; } catch(e) {}
      results.analyzed++;

      // ── AGENT 2: STRATEGIST — pick sequence template and timing ─────────────
      const strategyRaw = await nfClaude(
        `You are a campaign strategist. Design the email sequence for this lead.
Goal: ${goal || "book a call"}, Segment: ${analysis.segment}, Urgency: ${analysis.follow_up_urgency}
Respond ONLY in JSON:
{"sequence_name":"","steps":3,"day_delays":[0,3,7],"angles":["intro","value","urgency"],"subject_lines":["subject1","subject2","subject3"]}`,
        `Lead analysis: ${JSON.stringify(analysis)}`
      );
      let strategy = { steps: 3, day_delays: [0, 3, 7], angles: ["intro", "value", "urgency"], subject_lines: ["Following up", "One more thought", "Last note"] };
      try { strategy = { ...strategy, ...JSON.parse(strategyRaw) }; } catch(e) {}

      // ── AGENT 3: COMPOSER — write each email personalised ────────────────────
      const emails = [];
      for (let i = 0; i < Math.min(strategy.steps, 3); i++) {
        const emailBody = await nfClaude(
          `Write email ${i + 1} of ${strategy.steps} for this nurture sequence.
Angle: ${strategy.angles[i] || "value"}. Max 120 words. No fluff. Personalised to this contact.
Business: ${site?.name || "us"}. Product/offer: ${analysis.best_offer}.
Pain point to address: ${analysis.pain_point}.
CTA: ${goal || "book a call"}. Sign off naturally.
DO NOT use [brackets] for personalisation — write the actual content.`,
          `Contact name: ${contact.name}, Company: ${contact.company || ""}, Personalisation angle: ${analysis.personalization_angle}`
        , 300);
        emails.push({ subject: strategy.subject_lines[i] || `Following up — ${site?.name}`, body: emailBody, delay_days: strategy.day_delays[i] || i * 3 });
      }

      // ── AGENT 4: SCHEDULER — queue emails in outreach system ─────────────────
      const { v4: uid } = require("uuid");
      const campaignId = uid();
      db.exec(`CREATE TABLE IF NOT EXISTS outreach_campaigns (
        id TEXT PRIMARY KEY, user_id TEXT, name TEXT, goal TEXT, status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS outreach_emails (
        id TEXT PRIMARY KEY, campaign_id TEXT, user_id TEXT, contact_id TEXT,
        to_email TEXT, subject TEXT, body TEXT, delay_days INTEGER DEFAULT 0,
        status TEXT DEFAULT 'queued', scheduled_at TEXT, sent_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);

      db.prepare("INSERT OR IGNORE INTO outreach_campaigns (id, user_id, name, goal) VALUES (?,?,?,?)")
        .run(campaignId, userId, campaignName || `Nurture — ${new Date().toLocaleDateString()}`, goal || "book a call");

      for (const email of emails) {
        const sendAt = new Date(Date.now() + email.delay_days * 86400000).toISOString();
        db.prepare("INSERT INTO outreach_emails (id, campaign_id, user_id, contact_id, to_email, subject, body, delay_days, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(uid(), campaignId, userId, contact.id, contact.email, email.subject, email.body, email.delay_days, sendAt);
        results.emails_queued++;
        if (typeof global !== "undefined" && global.mineTrackUsage) {
          global.mineTrackUsage(db, userId, "outreachEmails");
        }
      }

      // Update contact with segment tag
      db.prepare("UPDATE contacts SET tags = tags || ?, status = CASE WHEN ? = 'hot' THEN 'qualified' ELSE status END, last_activity = datetime('now') WHERE id = ?")
        .run(",nurture-" + analysis.segment, analysis.segment, contact.id);

      results.sequences_created++;
      results.contacts_processed.push({ id: contact.id, name: contact.name, segment: analysis.segment, score: analysis.score, emails_queued: emails.length });
    } catch(e) { /* skip failed contact, continue */ }
  }

  res.json({ success: true, ...results });
});


// ══════════════════════════════════════════════════════════════
// ROI SUMMARY — monthly savings & activity report
// ══════════════════════════════════════════════════════════════
router.get("/roi/summary", auth, (req, res) => {
  const db = getDb();
  try {
    const userId = req.userId;
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const lastMonthStart = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString();
    const lastMonthEnd = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString();

    // AI employee actions this month
    let aiActionsCount = 0, aiActionsLastMonth = 0;
    try {
      aiActionsCount = db.prepare("SELECT COUNT(*) as c FROM ai_employee_actions WHERE user_id = ? AND status IN ('completed','auto_executed') AND created_at >= ?").get(userId, monthStart)?.c || 0;
      aiActionsLastMonth = db.prepare("SELECT COUNT(*) as c FROM ai_employee_actions WHERE user_id = ? AND status IN ('completed','auto_executed') AND created_at >= ? AND created_at < ?").get(userId, lastMonthStart, lastMonthEnd)?.c || 0;
    } catch(e) {}

    // Tickets resolved by AI
    let ticketsHandled = 0;
    try { ticketsHandled = db.prepare("SELECT COUNT(*) as c FROM support_tickets WHERE user_id = ? AND status = 'resolved' AND resolved_by = 'ai' AND created_at >= ?").get(userId, monthStart)?.c || 0; } catch(e) {}

    // Emails sent (funnels + outreach + AI)
    let emailsSent = 0;
    try { emailsSent = db.prepare("SELECT COUNT(*) as c FROM email_tracking WHERE user_id = ? AND created_at >= ?").get(userId, monthStart)?.c || 0; } catch(e) {}

    // Community replies posted
    let communityReplies = 0;
    try { communityReplies = db.prepare("SELECT COUNT(*) as c FROM community_replies WHERE user_id = ? AND posted = 1 AND created_at >= ?").get(userId, monthStart)?.c || 0; } catch(e) {}

    // Reviews responded to
    let reviewReplies = 0;
    try { reviewReplies = db.prepare("SELECT COUNT(*) as c FROM reviews WHERE user_id = ? AND reply IS NOT NULL AND reply != '' AND updated_at >= ?").get(userId, monthStart)?.c || 0; } catch(e) {}

    // Invoices chased by AI
    let invoicesChased = 0;
    try { invoicesChased = db.prepare("SELECT COUNT(*) as c FROM scheduled_emails WHERE user_id = ? AND subject LIKE '%invoice%' AND status = 'sent' AND created_at >= ?").get(userId, monthStart)?.c || 0; } catch(e) {}

    // New leads captured this month
    let newLeads = 0;
    try { newLeads = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND created_at >= ?").get(userId, monthStart)?.c || 0; } catch(e) {}

    // Revenue this month
    let revenueThisMonth = 0, revenueLastMonth = 0;
    try {
      revenueThisMonth = db.prepare("SELECT COALESCE(SUM(total),0) as r FROM orders WHERE user_id = ? AND created_at >= ?").get(userId, monthStart)?.r || 0;
      revenueLastMonth = db.prepare("SELECT COALESCE(SUM(total),0) as r FROM orders WHERE user_id = ? AND created_at >= ? AND created_at < ?").get(userId, lastMonthStart, lastMonthEnd)?.r || 0;
    } catch(e) {}

    // ── ROI Calculation ──────────────────────────────────────────
    // Human equivalent costs (conservative estimates):
    // Virtual assistant: $25/hr, 20 mins per task = $8.33/task
    // Social media manager: $35/hr, 30 mins per post
    // Customer support: $20/hr, 15 mins per ticket = $5/ticket
    // Email marketing: $30/hr, 10 mins per email = $5/email
    // Community management: $25/hr, 15 mins per reply
    // Bookkeeper: $50/hr — weekly report = $50

    const TASK_VALUES = {
      aiAction: 8.33,       // $25/hr virtual assistant, ~20 min/task
      ticket: 5.00,         // $20/hr support agent, ~15 min/ticket
      emailSent: 0.50,      // automation value per email
      communityReply: 6.25, // $25/hr, ~15 min/reply
      reviewReply: 4.00,    // ~10 min at $25/hr
      invoiceChased: 8.00,  // ~20 min at $25/hr
    };

    const moneySaved = Math.round(
      (aiActionsCount * TASK_VALUES.aiAction) +
      (ticketsHandled * TASK_VALUES.ticket) +
      (emailsSent * TASK_VALUES.emailSent) +
      (communityReplies * TASK_VALUES.communityReply) +
      (reviewReplies * TASK_VALUES.reviewReply) +
      (invoicesChased * TASK_VALUES.invoiceChased)
    );

    const hoursSaved = Math.round(
      (aiActionsCount * 20 + ticketsHandled * 15 + communityReplies * 15 + reviewReplies * 10 + invoicesChased * 20) / 60
    );

    const revenueGrowth = revenueLastMonth > 0
      ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
      : null;

    // Crypto revenue this month
    let cryptoRevenue = 0, cryptoOrders = 0;
    try {
      const cryptoStats = db.prepare(
        "SELECT COUNT(*) as n, COALESCE(SUM(order_total - platform_fee),0) as rev FROM crypto_orders WHERE user_id = ? AND status = 'confirmed' AND created_at >= ?"
      ).get(userId, monthStart);
      cryptoRevenue = Math.round(cryptoStats?.rev || 0);
      cryptoOrders  = cryptoStats?.n || 0;
    } catch(e) {}

    res.json({
      moneySaved,
      hoursSaved,
      aiActionsCount,
      aiActionsLastMonth,
      ticketsHandled,
      emailsSent,
      communityReplies,
      reviewReplies,
      invoicesChased,
      newLeads,
      revenueThisMonth: Math.round(revenueThisMonth),
      revenueLastMonth: Math.round(revenueLastMonth),
      revenueGrowth,
      cryptoRevenue,
      cryptoOrders,
      month: new Date().toLocaleString("default", { month: "long" }),
    });
  } catch(e) {
    res.json({ moneySaved: 0, hoursSaved: 0, aiActionsCount: 0, newLeads: 0 });
  }
});


// Monthly ROI Report — sent on the 1st of each month
async function sendMonthlyROIReport(db) {
  try {
    const users = db.prepare("SELECT id, email, name, plan FROM users WHERE plan IS NOT NULL").all();
    const lastMonthStart = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString();
    const lastMonthEnd   = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString();
    const lastMonthName  = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toLocaleString("default", { month: "long" });

    for (const user of users) {
      try {
        const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(user.id);
        const bizName = site?.name || "your business";

        let aiActions = 0, emailsSent = 0, newLeads = 0, revenue = 0, communityReplies = 0;
        try { aiActions = db.prepare("SELECT COUNT(*) as c FROM ai_employee_actions WHERE user_id = ? AND status IN ('completed','auto_executed') AND created_at >= ? AND created_at < ?").get(user.id, lastMonthStart, lastMonthEnd)?.c || 0; } catch(e) {}
        try { emailsSent = db.prepare("SELECT COUNT(*) as c FROM email_tracking WHERE user_id = ? AND created_at >= ? AND created_at < ?").get(user.id, lastMonthStart, lastMonthEnd)?.c || 0; } catch(e) {}
        try { newLeads = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND created_at >= ? AND created_at < ?").get(user.id, lastMonthStart, lastMonthEnd)?.c || 0; } catch(e) {}
        try { revenue = db.prepare("SELECT COALESCE(SUM(total),0) as r FROM orders WHERE user_id = ? AND created_at >= ? AND created_at < ?").get(user.id, lastMonthStart, lastMonthEnd)?.r || 0; } catch(e) {}
        try { communityReplies = db.prepare("SELECT COUNT(*) as c FROM community_replies WHERE user_id = ? AND posted = 1 AND created_at >= ? AND created_at < ?").get(user.id, lastMonthStart, lastMonthEnd)?.c || 0; } catch(e) {}
        let cryptoOrders = 0;
        try { cryptoOrders = db.prepare("SELECT COUNT(*) as c FROM crypto_orders WHERE user_id = ? AND status = 'confirmed' AND created_at >= ? AND created_at < ?").get(user.id, lastMonthStart, lastMonthEnd)?.c || 0; } catch(e) {}

        if (aiActions === 0 && emailsSent === 0 && newLeads === 0) continue;

        const moneySaved = Math.round(aiActions * 8.33 + emailsSent * 0.50 + communityReplies * 6.25);
        const hoursSaved = Math.round((aiActions * 20 + communityReplies * 15) / 60);

        const firstName = user.name?.split(" ")[0] || "there";
        await autoEmail(user.id, user.email,
          `Your ${lastMonthName} report — MINE saved you $${moneySaved.toLocaleString()}`,
          `<div style="font-family:system-ui;max-width:580px;margin:0 auto;padding:24px;">
            <div style="text-align:center;margin-bottom:28px;">
              <div style="font-size:36px;margin-bottom:8px;">📊</div>
              <h1 style="font-size:22px;font-weight:800;margin:0 0 6px;">${lastMonthName} in Review</h1>
              <p style="color:#64748B;margin:0;font-size:14px;">${bizName} — powered by MINE</p>
            </div>
            <div style="background:linear-gradient(135deg,#2563EB,#7C3AED);border-radius:16px;padding:24px;text-align:center;color:#fff;margin-bottom:20px;">
              <div style="font-size:13px;opacity:.8;margin-bottom:4px;">MINE SAVED YOU</div>
              <div style="font-size:48px;font-weight:900;line-height:1;">$${moneySaved.toLocaleString()}</div>
              <div style="font-size:13px;opacity:.8;margin-top:4px;">in ${lastMonthName} · ${hoursSaved} hours of work handled automatically</div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
              ${aiActions > 0 ? `<div style="background:#F8F9FF;border-radius:12px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:800;color:#2563EB;">${aiActions}</div><div style="font-size:12px;color:#64748B;margin-top:4px;">AI tasks completed</div></div>` : ""}
              ${newLeads > 0 ? `<div style="background:#F0FDF4;border-radius:12px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:800;color:#16A34A;">${newLeads}</div><div style="font-size:12px;color:#64748B;margin-top:4px;">new leads captured</div></div>` : ""}
              ${emailsSent > 0 ? `<div style="background:#FFFBEB;border-radius:12px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:800;color:#D97706;">${emailsSent}</div><div style="font-size:12px;color:#64748B;margin-top:4px;">emails sent automatically</div></div>` : ""}
              ${revenue > 0 ? `<div style="background:#FFF7F0;border-radius:12px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:800;color:#EA580C;">$${Math.round(revenue).toLocaleString()}</div><div style="font-size:12px;color:#64748B;margin-top:4px;">revenue processed</div></div>` : ""}
            </div>
            <div style="text-align:center;margin:24px 0;">
              <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}?tab=dashboard" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">View Full Dashboard →</a>
            </div>
            ${cryptoOrders > 0 ? `<div style="background:#0F172A;border-radius:12px;padding:16px;text-align:center;margin:0 0 20px;">
              <div style="font-size:13px;font-weight:700;color:#A5B4FC;margin-bottom:4px;">₿ You received crypto payments this month</div>
              <div style="font-size:12px;color:rgba(255,255,255,.5);margin-bottom:12px;">Convert to USDC privately with no KYC under $10k</div>
              <a href="${getSetting('VEIL_SWAP_URL') || 'https://veil.finance/swap'}" target="_blank" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">Swap with Veil ↗</a>
            </div>` : ""}
            <p style="color:#94A3B8;font-size:11px;text-align:center;margin-top:20px;">MINE · <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}?tab=settings" style="color:#94A3B8;">Manage notifications</a></p>
          </div>`
        );
      } catch(e) { console.error(`[ROI Report] Failed for ${user.email}:`, e.message); }
    }
  } catch(e) { console.error("[ROI Report] Error:", e.message); }
}
module.exports.sendMonthlyROIReport = sendMonthlyROIReport;


// Day 3 / Day 7 onboarding email sequences
async function sendOnboardingSequence(db) {
  try {
    const now = new Date();
    const users3 = db.prepare("SELECT id, email, name FROM users WHERE datetime(created_at, '+3 days') <= datetime('now') AND datetime(created_at, '+4 days') > datetime('now') AND plan IS NOT NULL").all();
    const users7 = db.prepare("SELECT id, email, name FROM users WHERE datetime(created_at, '+7 days') <= datetime('now') AND datetime(created_at, '+8 days') > datetime('now') AND plan IS NOT NULL").all();

    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

    for (const user of users3) {
      try {
        const firstName = user.name?.split(" ")[0] || "there";
        const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(user.id);
        const hasSite = !!site;
        const hasLeads = (db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ?").get(user.id)?.c || 0) > 0;

        await autoEmail(user.id, user.email,
          "Day 3 — here's what to set up next in MINE",
          `<div style="font-family:system-ui;max-width:580px;margin:0 auto;padding:24px;">
            <h2 style="font-weight:800;font-size:20px;">Hey ${firstName} 👋</h2>
            <p style="color:#334155;line-height:1.7;">You're 3 days in. ${hasSite ? "Your site is live ✅" : "Your site isn't live yet — let's fix that first."} Here's what to tackle next:</p>
            <div style="display:flex;flex-direction:column;gap:12px;margin:20px 0;">
              ${!hasSite ? `<div style="background:#FFF7F0;border-left:4px solid #EA580C;border-radius:8px;padding:14px;"><strong>🌐 Publish your site</strong><p style="margin:4px 0 0;font-size:13px;color:#64748B;">Takes 5 minutes. AI builds it from a description.</p></div>` : ""}
              ${!hasLeads ? `<div style="background:#F0F4FF;border-left:4px solid #2563EB;border-radius:8px;padding:14px;"><strong>👥 Connect your first leads</strong><p style="margin:4px 0 0;font-size:13px;color:#64748B;">Import a CSV or paste a form on your site to start capturing contacts automatically.</p></div>` : ""}
              <div style="background:#F0FDF4;border-left:4px solid #16A34A;border-radius:8px;padding:14px;"><strong>🤖 Hire your first AI employee</strong><p style="margin:4px 0 0;font-size:13px;color:#64748B;">The AI Sales Rep starts following up your leads automatically. Takes 2 minutes to configure.</p></div>
              <div style="background:#FFF7F0;border-left:4px solid #F59E0B;border-radius:8px;padding:14px;"><strong>📧 Set up an email funnel</strong><p style="margin:4px 0 0;font-size:13px;color:#64748B;">A simple 3-email welcome sequence runs forever and converts leads on autopilot.</p></div>
            </div>
            <a href="${frontendUrl}?tab=dashboard" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;">Go to Dashboard →</a>
          </div>`
        );
      } catch(e) {}
    }

    for (const user of users7) {
      try {
        const firstName = user.name?.split(" ")[0] || "there";
        const aiActions = db.prepare("SELECT COUNT(*) as c FROM ai_employee_actions WHERE user_id = ? AND created_at >= datetime('now','-7 days')").get(user.id)?.c || 0;
        const revenue = db.prepare("SELECT COALESCE(SUM(total),0) as r FROM orders WHERE user_id = ? AND created_at >= datetime('now','-7 days')").get(user.id)?.r || 0;

        await autoEmail(user.id, user.email,
          "One week in — here's what MINE has done for you",
          `<div style="font-family:system-ui;max-width:580px;margin:0 auto;padding:24px;">
            <h2 style="font-weight:800;font-size:20px;">One week with MINE 🎉</h2>
            <p style="color:#334155;line-height:1.7;">Hey ${firstName}, you've been on MINE for a week. Here's a quick look at what's happened:</p>
            ${aiActions > 0 ? `<div style="background:linear-gradient(135deg,#2563EB,#7C3AED);border-radius:12px;padding:20px;color:#fff;text-align:center;margin:16px 0;"><div style="font-size:36px;font-weight:900;">${aiActions}</div><div style="font-size:14px;opacity:.85;">AI tasks completed automatically</div></div>` : ""}
            ${revenue > 0 ? `<div style="background:#F0FDF4;border-radius:12px;padding:16px;text-align:center;margin-bottom:16px;"><div style="font-size:28px;font-weight:800;color:#16A34A;">$${Math.round(revenue).toLocaleString()}</div><div style="font-size:12px;color:#64748B;">revenue in your first week</div></div>` : ""}
            <p style="color:#334155;line-height:1.7;">The businesses that get the most from MINE have all 3 of these running in week 1: their site live, at least one AI employee active, and a welcome email funnel set up.</p>
            <p style="color:#334155;line-height:1.7;"><strong>Need help with any of these?</strong> Reply to this email — we respond same day.</p>
            <a href="${frontendUrl}?tab=dashboard" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;">Open My Dashboard →</a>
          </div>`
        );
      } catch(e) {}
    }
  } catch(e) { console.error("[Onboarding Sequence] Error:", e.message); }
}
module.exports.sendOnboardingSequence = sendOnboardingSequence;

// 7-day and 14-day re-engagement emails for inactive users
async function sendReEngagementEmails(db) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

    // 7-day inactive — "here's what your AI did while you were away"
    const inactive7 = db.prepare(`
      SELECT u.id, u.email, u.name FROM users u
      WHERE u.plan IS NOT NULL
      AND datetime(u.last_login_at, '+7 days') <= datetime('now')
      AND datetime(u.last_login_at, '+8 days') > datetime('now')
    `).all();

    for (const user of inactive7) {
      try {
        const firstName = user.name?.split(" ")[0] || "there";
        const aiActions = db.prepare("SELECT COUNT(*) as c FROM ai_employee_actions WHERE user_id = ? AND created_at >= datetime('now','-7 days') AND status IN ('completed','auto_executed')").get(user.id)?.c || 0;
        const newLeads  = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND created_at >= datetime('now','-7 days')").get(user.id)?.c || 0;
        const emails    = db.prepare("SELECT COUNT(*) as c FROM email_tracking WHERE user_id = ? AND created_at >= datetime('now','-7 days')").get(user.id)?.c || 0;

        if (aiActions === 0 && newLeads === 0 && emails === 0) continue;

        await autoEmail(user.id, user.email,
          `Here's what MINE did while you were away`,
          `<div style="font-family:system-ui;max-width:580px;margin:0 auto;padding:24px;">
            <h2 style="font-weight:800;font-size:20px;">Hey ${firstName}, your AI hasn't stopped working 🤖</h2>
            <p style="color:#334155;line-height:1.7;">You haven't logged in for a week — but MINE kept going. Here's what happened while you were away:</p>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:20px 0;">
              <div style="background:#F8F9FF;border-radius:12px;padding:14px;text-align:center;"><div style="font-size:26px;font-weight:800;color:#2563EB;">${aiActions}</div><div style="font-size:11px;color:#64748B;">AI tasks done</div></div>
              <div style="background:#F0FDF4;border-radius:12px;padding:14px;text-align:center;"><div style="font-size:26px;font-weight:800;color:#16A34A;">${newLeads}</div><div style="font-size:11px;color:#64748B;">new leads</div></div>
              <div style="background:#FFFBEB;border-radius:12px;padding:14px;text-align:center;"><div style="font-size:26px;font-weight:800;color:#D97706;">${emails}</div><div style="font-size:11px;color:#64748B;">emails sent</div></div>
            </div>
            <a href="${frontendUrl}?tab=dashboard" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;">See What's Waiting For Me →</a>
          </div>`
        );
      } catch(e) {}
    }

    // 14-day inactive — personal outreach tone
    const inactive14 = db.prepare(`
      SELECT u.id, u.email, u.name FROM users u
      WHERE u.plan IS NOT NULL
      AND datetime(u.last_login_at, '+14 days') <= datetime('now')
      AND datetime(u.last_login_at, '+15 days') > datetime('now')
    `).all();

    for (const user of inactive14) {
      try {
        const firstName = user.name?.split(" ")[0] || "there";
        await autoEmail(user.id, user.email,
          `Quick check in — everything OK?`,
          `<div style="font-family:system-ui;max-width:580px;margin:0 auto;padding:24px;">
            <h2 style="font-weight:800;font-size:20px;">Hey ${firstName} 👋</h2>
            <p style="color:#334155;line-height:1.7;">I noticed you haven't logged into MINE in a couple of weeks. Wanted to check in personally — is there anything we can help with?</p>
            <p style="color:#334155;line-height:1.7;">A lot of our users who get stuck at this point just need 15 minutes with someone who can walk through their setup. If that's useful, just reply to this email and we'll get something booked.</p>
            <p style="color:#334155;line-height:1.7;">Or if there's something specific MINE isn't doing that you need, let me know — we're building features every week and your feedback shapes what comes next.</p>
            <div style="display:flex;gap:12px;margin:20px 0;flex-wrap:wrap;">
              <a href="${frontendUrl}?tab=dashboard" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;">Back to MINE →</a>
              <a href="mailto:hello@takeova.ai?subject=Help with TAKEOVA" style="display:inline-block;padding:12px 24px;background:#F8F9FF;color:#2563EB;border:1px solid #2563EB;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;">Book a Setup Call</a>
            </div>
            <p style="color:#94A3B8;font-size:12px;margin-top:20px;">— The TAKEOVA team</p>
          </div>`
        );
      } catch(e) {}
    }
  } catch(e) { console.error("[Re-engagement] Error:", e.message); }
}
module.exports.sendReEngagementEmails = sendReEngagementEmails;


// ── Claude Personalised Message Generator (POST /api/features/personalise) ─────
router.post("/personalise", auth, async (req, res) => {
  try {
    const { scenario, customer, channel, tone } = req.body;
    if (!scenario) return res.status(400).json({ error: "scenario required" });
    const db = getDb(); ensureTables(db);
    const user = db.prepare("SELECT name FROM users WHERE id=?").get(req.userId);
    const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(req.userId);
    const { personaliseMessage } = require('../utils/personalise');
    const result = await personaliseMessage({
      scenario,
      customer: customer || {},
      business: { name: site?.name || user?.name || "My Business" },
      channel: channel || "sms",
      tone: tone || "friendly",
    });
    res.json({ success: true, message: result });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});


// ── Momentum Score (GET /api/features/mine-score) ────────────────────────────────
router.get("/mine-score", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const uid = req.userId;
    const refresh = req.query.refresh === "1";

    // Calculate score from real data
    const site       = db.prepare("SELECT * FROM sites WHERE user_id=? LIMIT 1").get(uid);
    const contacts   = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE user_id=?").get(uid)?.n || 0;
    const invoices   = db.prepare("SELECT COUNT(*) as n FROM invoices WHERE user_id=?").get(uid)?.n || 0;
    const bookings   = db.prepare("SELECT COUNT(*) as n FROM bookings WHERE user_id=?").get(uid)?.n || 0;
    const reviews    = db.prepare("SELECT COUNT(*) as n, AVG(rating) as avg FROM reviews WHERE user_id=?").get(uid) || {n:0,avg:0};
    const campaigns  = db.prepare("SELECT COUNT(*) as n FROM email_sends WHERE user_id=?").get(uid)?.n || 0;
    const revenue    = db.prepare("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE user_id=? AND status='paid'").get(uid)?.t || 0;
    const hasLogo    = site?.logo ? 1 : 0;
    const hasSeo     = site?.seo_json && site.seo_json !== "{}" ? 1 : 0;
    try { db.exec("CREATE TABLE IF NOT EXISTS sms_sequences (id TEXT PRIMARY KEY, user_id TEXT, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')))"); } catch(e) {}
    const hasAutomation = db.prepare("SELECT COUNT(*) as n FROM sms_sequences WHERE user_id=? AND status='active'").get(uid)?.n || 0;
    const openTickets = db.prepare("SELECT COUNT(*) as n FROM support_tickets WHERE user_id=? AND status='open'").get(uid)?.n || 0;

    // Factor scores (0-100)
    const factors = [
      {
        name: "Profile & Branding",
        icon: "🎨",
        score: Math.min(100, (hasLogo?40:0) + (site?.name?20:0) + (hasSeo?40:0)),
        tip: !hasLogo ? "Add a logo to your site" : !hasSeo ? "Add SEO meta tags" : ""
      },
      {
        name: "Revenue & Invoicing",
        icon: "💰",
        score: Math.min(100, Math.round((invoices>0?30:0) + (revenue>1000?30:0) + (revenue>5000?20:0) + (revenue>10000?20:0))),
        tip: invoices===0 ? "Send your first invoice" : revenue<1000 ? "Keep building towards $1,000 revenue" : ""
      },
      {
        name: "Customer Base",
        icon: "👥",
        score: Math.min(100, Math.round((contacts>0?20:0) + (contacts>10?20:0) + (contacts>50?20:0) + (contacts>100?20:0) + (contacts>500?20:0))),
        tip: contacts<10 ? "Add more contacts to your CRM" : ""
      },
      {
        name: "Bookings & Scheduling",
        icon: "📅",
        score: Math.min(100, Math.round((bookings>0?40:0) + (bookings>10?30:0) + (bookings>50?30:0))),
        tip: bookings===0 ? "Set up your booking system" : ""
      },
      {
        name: "Reviews & Reputation",
        icon: "⭐",
        score: Math.min(100, Math.round((reviews.n>0?30:0) + (reviews.n>5?30:0) + ((reviews.avg||0)>=4?40:0))),
        tip: reviews.n===0 ? "Request reviews from your customers" : (reviews.avg||0)<4 ? "Respond to reviews to improve your rating" : ""
      },
      {
        name: "Email & Marketing",
        icon: "📧",
        score: Math.min(100, Math.round((campaigns>0?50:0) + (campaigns>5?30:0) + (campaigns>20?20:0))),
        tip: campaigns===0 ? "Send your first email campaign" : ""
      },
      {
        name: "Automations",
        icon: "⚡",
        score: Math.min(100, Math.round((hasAutomation>0?50:0) + (hasAutomation>2?30:0) + (hasAutomation>5?20:0))),
        tip: !hasAutomation ? "Set up at least one automation" : ""
      },
      {
        name: "Support",
        icon: "🎫",
        score: Math.min(100, openTickets===0?100:openTickets<=2?70:openTickets<=5?40:20),
        tip: openTickets>0 ? `You have ${openTickets} open support tickets` : ""
      },
    ];

    const score = Math.round(factors.reduce((a,f)=>a+f.score,0)/factors.length);

    // Cache in user settings
    try {
      db.prepare("INSERT OR REPLACE INTO platform_settings (key,value) VALUES (?,?)").run("mine_score_"+uid, JSON.stringify({score,factors,updated:new Date().toISOString()}));
    } catch(e) { console.error("[/mine-score]", e.message || e); }

    res.json({ success: true, score, factors });
  } catch(e) {
    console.error("[MineScore]", e.message);
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});


// ── Memberships GET (GET /api/features/memberships) ──────────────────────────
router.get("/memberships", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const siteId = req.query.site_id;
    const memberships = siteId
      ? db.prepare("SELECT * FROM memberships WHERE user_id=? AND site_id=? ORDER BY price ASC").all(req.userId, siteId)
      : db.prepare("SELECT * FROM memberships WHERE user_id=? ORDER BY price ASC").all(req.userId);
    const parsed = memberships.map(m => ({
      ...m,
      perks: (() => { try { return JSON.parse(m.perks||"[]"); } catch(e) { return []; } })(),
      access: (() => { try { return JSON.parse(m.access_json||"[]"); } catch(e) { return []; } })(),
    }));
    res.json({ memberships: parsed });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;

// Expose helpers for other routes (ai-agent.js etc) that need to track Higgsfield usage
router.trackUsage = trackUsage;

// ═══════════════════════════════════════
// FEATURE 2: AI SHORT-FORM VIDEO GENERATOR
// ═══════════════════════════════════════
// ── SALES COPY GENERATOR ──────────────────────────────────────────────────────
// Plans: Starter 3/mo, Growth 10/mo, Pro 30/mo, Enterprise unlimited. Overage $2/gen.

router.post("/copy/generate", auth, async (req, res) => {
  try {
    const { copyType, product, offer, tone, targetAudience, brandName, extra } = req.body;
    const db = getDb();
    const userId = req.userId;

    // Cap check
    const usage = typeof global !== "undefined" && global.mineCheckUsage
      ? global.mineCheckUsage(db, userId, "salesCopy")
      : { blocked: false, wouldBeOverage: false, used: 0, cap: 3 };

    if (usage.blocked) {
      return res.status(403).json({
        error: "You've used all your sales copy generations this month.",
        used: usage.used, cap: usage.cap,
        upgrade: true,
        overageAvailable: true,
        overagePrice: 2.00
      });
    }

    const anthropicKey = getSetting("ANTHROPIC_API_KEY");
    if (!anthropicKey) return res.status(400).json({ error: "Anthropic API key not configured" });

    // Track usage (allows overage with $2 charge)
    let isOverage = false;
    if (typeof global !== "undefined" && global.mineTrackUsage) {
      const t = global.mineTrackUsage(db, userId, "salesCopy");
      isOverage = t.isOverage;
      if (isOverage) res.setHeader("X-Overage-Charge", "2.00");
    }

    const copyTypePrompts = {
      facebook: `Write a Facebook/Instagram ad. Return JSON: { "headline": "short punchy headline", "primary": "main ad body text (2-3 sentences, conversational)", "cta": "call to action button text", "hook": "first line to stop the scroll" }`,
      tiktok: `Write a TikTok/Reels caption. Return JSON: { "hook": "first line to stop scroll (curious/bold)", "caption": "full caption text (casual, Gen Z friendly)", "hashtags": ["tag1","tag2","tag3","tag4","tag5"], "cta": "call to action" }`,
      google: `Write a Google Search Ad. Return JSON: { "headline1": "max 30 chars", "headline2": "max 30 chars", "headline3": "max 30 chars", "description1": "max 90 chars", "description2": "max 90 chars", "displayUrl": "example.com/path" }`,
      email: `Write email subject lines and preview text. Return JSON: { "subjects": ["subject 1", "subject 2", "subject 3"], "previewTexts": ["preview 1", "preview 2", "preview 3"], "bodyOpener": "first 2 sentences of email body" }`,
      product: `Write a product description. Return JSON: { "title": "product title/headline", "short": "1-sentence tagline", "description": "2-3 paragraph product description with benefits", "bullets": ["benefit 1", "benefit 2", "benefit 3", "benefit 4"], "seo": "SEO-optimised meta description (155 chars max)" }`,
      sms: `Write SMS/push notification copy. Return JSON: { "sms": "SMS under 160 chars with link placeholder [LINK]", "push_title": "push notification title under 50 chars", "push_body": "push notification body under 100 chars", "urgency_variant": "alternative urgent version" }`
    };

    const toneGuide = { professional: "professional and trustworthy", casual: "casual and friendly", hype: "hyped, energetic and trendy", luxury: "premium, aspirational and exclusive", funny: "witty, light-hearted and fun" };

    const fetch = (await import("node-fetch")).default;
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 800,
        temperature: 0,
          messages: [{ role: "user", content: `You are an expert direct-response copywriter. Write high-converting sales copy.

  Brand: ${aiStr(brandName, 100) || "the business"}
  Product/Offer: ${aiStr(product || offer, 300) || "their product"}
  Target audience: ${aiStr(targetAudience, 200) || "general consumers"}
  Tone: ${toneGuide[tone] || "friendly and professional"}
  Extra notes: ${aiStr(extra, 300) || "none"}

  ${copyTypePrompts[copyType] || copyTypePrompts.facebook}

  Return ONLY valid JSON. No preamble, no markdown.` }]
        })
      });
      const data = await r.json();
      const text = data.content?.[0]?.text || "";
      try {
        const m = text.match(/\{[\s\S]*\}/);
        const parsed = m ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(m[0]) : {};

        // Save to copy history
        db.exec("CREATE TABLE IF NOT EXISTS sales_copy_history (id TEXT PRIMARY KEY, user_id TEXT, copy_type TEXT, product TEXT, result TEXT, is_overage INTEGER, created_at TEXT)");
        const { v4: uuidv4 } = await import("uuid");
        db.prepare("INSERT INTO sales_copy_history VALUES (?,?,?,?,?,?,datetime('now'))")
          .run(uuidv4(), userId, copyType, product || offer || "", JSON.stringify(parsed), isOverage ? 1 : 0);

        res.json({ success: true, copy: parsed, copyType, isOverage, overageCharge: isOverage ? 2.00 : 0, used: (usage.used || 0) + 1, cap: usage.cap });
      } catch(e) {
        res.json({ success: true, copy: { raw: text }, copyType, isOverage });
      }
    } catch(e) {
      console.error("[Route] Sales copy error:", e?.message);
      res.status(500).json({ error: "Copy generation failed" });
    }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Get sales copy history
router.get("/copy/history", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS sales_copy_history (id TEXT PRIMARY KEY, user_id TEXT, copy_type TEXT, product TEXT, result TEXT, is_overage INTEGER, created_at TEXT)");
    const rows = db.prepare("SELECT * FROM sales_copy_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(req.userId);
    res.json({ history: rows.map(r => ({ ...r, result: JSON.parse(r.result || "{}") })) });
  } catch(e) { res.json({ history: [] }); }
});

// ── SALES COPY GENERATOR END ──────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════
// RUNWAY — Cinematic AI Video Generation ($25/video)
// Gen-3 Alpha API — brand videos, Reels, TikToks, YouTube Shorts
// ═══════════════════════════════════════════════════════════════════

// Generic "Generate AI Video" entry (card-tap fallback) — routes to the real Runway cinematic pipeline.
router.post("/video/generate", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const plat = String(b.platform || "").toLowerCase();
    const ratio = /reel|tiktok|short|9:16|vertical|portrait/.test(plat) ? "768:1280" : "1280:768";
    let dur = parseInt(String(b.duration || "").replace(/\D/g, "")) || 10;
    if (dur < 5) dur = 5; if (dur > 45) dur = 45; // /video/runway snaps to 5/10/15/30/45
    const fetch2 = (await import("node-fetch")).default;
    const port = process.env.PORT || 4000;
    const r = await fetch2("http://localhost:" + port + "/api/features/video/runway", {
      method: "POST",
      headers: { "Authorization": req.headers.authorization || "", "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: b.prompt || b.description || "", duration: dur, ratio: ratio })
    });
    return res.status(r.status).json(await r.json());
  } catch (e) { return res.status(500).json({ error: "Video generation failed: " + e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stitched cinematic (>15s) — generate N≤15s Kling clips, ffmpeg-concatenate.
// Single clips cap at 15s, so 30s = 2 clips, 45s = 3 clips. Each clip is an
// async Kling job; once all complete we download, concat, upload, return URL.
// (Requires ffmpeg on the host — confirmed available for this deployment.)
// ═══════════════════════════════════════════════════════════════════════════
function ensureCinematicJobsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cinematic_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT DEFAULT 'processing',
    total_seconds INTEGER,
    segments TEXT,
    final_url TEXT,
    charge_id TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
}

async function startStitchedCinematic({ db, userId, prompt, durSec, ar, referenceImageUrl, chargeId }) {
  const klingProvider = require("./kling-provider");
  if (!klingProvider.isEnabled()) {
    return { success: false, error: "Long-form (>15s) cinematic video needs a Kling API key — add it in Admin → API Keys." };
  }
  ensureCinematicJobsTable(db);
  const { v4: uuid } = require("uuid");
  // Split into ≤15s segments (30 → [15,15]; 45 → [15,15,15]).
  const segLens = [];
  let remaining = durSec;
  while (remaining > 0) { const s = Math.min(15, remaining); segLens.push(s); remaining -= s; }
  const segments = [];
  for (let i = 0; i < segLens.length; i++) {
    const segPrompt = `${prompt || "Cinematic scene"} — part ${i + 1} of ${segLens.length}, continuous shot, consistent style`;
    const k = (referenceImageUrl && i === 0)
      ? await klingProvider.generateImageToVideo({ prompt: segPrompt, duration: segLens[i], aspectRatio: ar, referenceImageUrl })
      : await klingProvider.generateTextToVideo({ prompt: segPrompt, duration: segLens[i], aspectRatio: ar });
    if (!k.ok || !(k.requestId || k.url)) {
      return { success: false, error: "Failed to start clip " + (i + 1) + ": " + (k.error || "unknown") };
    }
    segments.push({ requestId: k.requestId || null, url: k.url || null, status: k.url ? "completed" : "processing", seconds: segLens[i] });
  }
  // Clip-based cap counting (Model B): 1 unit = one ≤15s clip → 30s counts 2, 45s counts 3.
  try { trackUsage(db, userId, "cinematicVideos", segLens.length); } catch (_) {}
  const jobId = "cine_" + uuid().replace(/-/g, "");
  db.prepare("INSERT INTO cinematic_jobs (id, user_id, status, total_seconds, segments, charge_id) VALUES (?,?,?,?,?,?)")
    .run(jobId, userId, "processing", durSec, JSON.stringify(segments), chargeId || null);
  return {
    success: true, taskId: jobId, composite: true, segments: segLens.length,
    status: "processing", pollUrl: "/api/features/video/runway-status/" + jobId,
    chargeId, message: `Generating ${segLens.length} clips for your ${durSec}s video, then stitching…`
  };
}

async function pollStitchedCinematic(db, jobId, userId) {
  ensureCinematicJobsTable(db);
  const klingProvider = require("./kling-provider");
  const job = db.prepare("SELECT * FROM cinematic_jobs WHERE id = ?").get(jobId);
  if (!job) return { status: "failed", url: null, error: "job not found" };
  if (userId && job.user_id !== userId) return { status: "failed", url: null, error: "not authorized" };
  if (job.final_url) return { status: "complete", url: job.final_url, progress: 100, provider: "kling-stitched" };
  if (job.status === "failed") return { status: "failed", url: null, error: job.error || "stitch failed" };

  let segments = [];
  try { segments = JSON.parse(job.segments || "[]"); } catch (_) { segments = []; }
  let allDone = true, anyFailed = false;
  for (const s of segments) {
    if (s.url) continue;
    if (!s.requestId) { allDone = false; continue; }
    const pr = await klingProvider.pollJob(s.requestId);
    if (pr.ok && pr.status === "completed" && pr.url) { s.url = pr.url; s.status = "completed"; }
    else if (pr.ok && pr.status === "failed") { s.status = "failed"; anyFailed = true; }
    else { allDone = false; }
  }
  db.prepare("UPDATE cinematic_jobs SET segments = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(segments), jobId);

  if (anyFailed) {
    db.prepare("UPDATE cinematic_jobs SET status = 'failed', error = 'a clip failed to generate' WHERE id = ?").run(jobId);
    return { status: "failed", url: null, error: "a clip failed to generate" };
  }
  if (!allDone) {
    const done = segments.filter(s => s.url).length;
    return { status: "processing", url: null, progress: Math.round((done / Math.max(1, segments.length)) * 90), provider: "kling-stitched" };
  }
  try {
    const finalUrl = await stitchVideos(segments.map(s => s.url), jobId);
    db.prepare("UPDATE cinematic_jobs SET status = 'completed', final_url = ?, updated_at = datetime('now') WHERE id = ?").run(finalUrl, jobId);
    return { status: "complete", url: finalUrl, progress: 100, provider: "kling-stitched" };
  } catch (e) {
    db.prepare("UPDATE cinematic_jobs SET status = 'failed', error = ? WHERE id = ?").run(String(e.message || e), jobId);
    return { status: "failed", url: null, error: "stitching failed: " + (e.message || e) };
  }
}

// Download clips, concat with ffmpeg (re-encode for safety), upload, return URL.
async function stitchVideos(urls, jobId) {
  const fs = require("fs"); const os = require("os"); const path = require("path");
  const { execFile } = require("child_process");
  const execFileP = require("util").promisify(execFile);
  const fetch2 = (await import("node-fetch")).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine_"));
  try {
    const files = [];
    for (let i = 0; i < urls.length; i++) {
      const resp = await fetch2(urls[i]);
      if (!resp.ok) throw new Error("download failed for clip " + (i + 1));
      const buf = Buffer.from(await resp.arrayBuffer());
      const fp = path.join(dir, `seg${i}.mp4`);
      fs.writeFileSync(fp, buf);
      files.push(fp);
    }
    const listPath = path.join(dir, "list.txt");
    fs.writeFileSync(listPath, files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    const outPath = path.join(dir, "final.mp4");
    await execFileP("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", outPath], { maxBuffer: 1024 * 1024 * 64 });
    const finalBuf = fs.readFileSync(outPath);
    const { uploadToS3 } = require("../utils/s3");
    return await uploadToS3(finalBuf, `cinematic/${jobId}.mp4`, "video/mp4");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

router.post("/video/runway", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    // ── Inputs read ONCE, up front. (Previously `prompt` was referenced in the
    //    charge block BELOW its `const {…} = req.body`, a temporal-dead-zone
    //    ReferenceError that threw for every non-admin user and blocked the
    //    cinematic-video charge entirely.) ──
    let { prompt, ratio, style, referenceImageUrl } = req.body || {};
    // ── Per-second pricing — single source of truth ($0.50/sec). Clamp to what a
    //    single clip can actually produce today (Runway ~10s / Higgsfield DoP ~5s).
    //    >10s (15/30/45) unlocks once the multi-clip stitch pipeline is added. ──
    let durSec = parseInt(String((req.body && req.body.duration) || "").replace(/\D/g, "")) || 10;
    if (durSec < 5) durSec = 5;
    // Allowed ladder: 5/10/15 = single Kling clip, 30/45 = stitched. Snap to nearest.
    const _ALLOWED_DUR = [5, 10, 15, 30, 45];
    if (!_ALLOWED_DUR.includes(durSec)) {
      durSec = _ALLOWED_DUR.reduce((a, b) => (Math.abs(b - durSec) < Math.abs(a - durSec) ? b : a), 45);
    }
    const duration = durSec;
    const CINEMATIC_RATE_PER_SEC = 0.50;
    const cinematicPrice = Math.round(durSec * CINEMATIC_RATE_PER_SEC * 100) / 100;
    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;

    // ── Hybrid-C cap enforcement (cinematicVideos) ───────────────────────────
    // Check BEFORE charging the card so we don't take money then bounce on cap.
    let capCheck = null;
    if (global.mineEnforceCapWithConsent) {
      capCheck = global.mineEnforceCapWithConsent(db, userId, "cinematicVideos");
      if (!capCheck.ok) {
        if (capCheck.locked) {
          return res.status(403).json({
            ok: false, locked: true, feature: "cinematicVideos",
            reason: "Cinematic video is not included on your plan. Upgrade to unlock.",
            plan: capCheck.plan, upgrade_required: true
          });
        }
        if (capCheck.capReached) {
          return res.status(402).json({
            ok: false, capReached: true, feature: "cinematicVideos",
            cap: capCheck.cap, used: capCheck.used, overageRate: 0.50, overageUnit: "second",
            message: `You've used all ${capCheck.cap} cinematic videos included this month. Continue at $0.50/sec (this ${durSec}s clip = $${(durSec * 0.50).toFixed(2)})?`,
            requiresConsent: true
          });
        }
      }
    }

    // Within plan cap → included in subscription (free). Over cap (consent on
    // file) → paid per-second. If the cap system is unavailable, default to
    // charging so we never silently give videos away.
    const isPaidOverage = capCheck ? !!capCheck.overage : true;

    if (!stripeKey && isPaidOverage) return res.status(503).json({ error: "Payment processing not configured." });

    const userRow = db.prepare("SELECT stripe_customer_id, email, name FROM users WHERE id = ?").get(userId);
    if (isPaidOverage && !userRow?.stripe_customer_id) {
      return res.status(402).json({ error: "No payment method on file. Please add a card in billing settings.", needsPaymentMethod: true });
    }

    // ── Admin bypass: owner uses free, costs route to company API accounts ─
    const _isAdminRunway = (typeof global.mineIsAdmin === "function") && global.mineIsAdmin(db, userId);
    // ── Charge card immediately ───────────────────────────────────────────────
    let chargeId = null;
    if (_isAdminRunway) {
      chargeId = "admin_free_runway_" + Date.now();
    } else if (!isPaidOverage) {
      // Within plan cap — included in the subscription, no charge.
      chargeId = "included_" + Date.now();
    } else { try {
      const stripe = require("stripe")(stripeKey);
      // Idempotency: tied to user + prompt hash + 5min window. Same prompt
      // retried within 5min hits cached PI; legit second generation gets new key.
      const promptHash = require("crypto").createHash("md5").update(String(prompt || "")).digest("hex").slice(0, 8);
      const idemKey = `runway_${userId}_${promptHash}_${Math.floor(Date.now() / 300000)}`;
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(cinematicPrice * 100),
        currency: "usd",
        customer: userRow.stripe_customer_id,
        payment_method_types: ["card"],
        confirm: true,
        off_session: true,
        description: `MINE Cinematic Video (${durSec}s @ $${CINEMATIC_RATE_PER_SEC.toFixed(2)}/sec) — ${userRow.email}`,
        metadata: { user_id: userId, metric: "runwayVideos", price: cinematicPrice, seconds: durSec, rate: CINEMATIC_RATE_PER_SEC }
      }, { idempotencyKey: idemKey });
      if (pi.status !== "succeeded") {
        return res.status(402).json({ error: "Payment failed. Check your card details in billing.", paymentStatus: pi.status });
      }
      chargeId = pi.id;
      const period = new Date().toISOString().slice(0, 7);
      const { v4: chargeUuid } = require("uuid");
      db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status, stripe_invoice_item_id) VALUES (?,?,?,?,?,?,?,'paid',?)")
        .run(chargeUuid(), userId, "runwayVideos", 1, cinematicPrice, cinematicPrice, period, chargeId);
    } catch (stripeErr) {
      if (stripeErr.code === "card_declined" || stripeErr.code === "authentication_required") {
        return res.status(402).json({ error: "Card declined. Update your payment method in billing.", code: stripeErr.code });
      }
      return res.status(402).json({ error: "Payment error: " + stripeErr.message });
    } }  // close else-block for admin bypass

    // ── Call Runway Gen-3 Alpha API ───────────────────────────────────────────
    // If user provides a reference image AND Higgsfield is enabled, route to
    // HF DoP (image-to-video, cheaper, 99% margin). Otherwise use Runway text-to-video.
    // (prompt/duration/ratio/style/referenceImageUrl already read at top of handler.)
    const hfProvider = require("./higgsfield-provider");
    const klingProvider = require("./kling-provider");
    const ar = ratio === "768:1280" ? "9:16" : "16:9";

    // ── >15s → multi-clip stitch pipeline (Kling segments + ffmpeg concat) ──
    // Brand Face default: feature the user's saved Soul in videos unless a reference is given or explicitly disabled
    if (!referenceImageUrl && b.useBrandFace !== false) {
      try {
        const _bs = require("../db/init").getDb().prepare("SELECT soul_id FROM brand_souls WHERE user_id=?").get(req.userId);
        if (_bs && _bs.soul_id && hfProvider.isEnabled()) {
          const _still = await hfProvider.generateSoulImage({ prompt: String(prompt||"") + ", cinematic key frame", aspectRatio: (typeof ar==="string"&&ar.indexOf("768:1280")>-1)?"9:16":"16:9", quality: "premium", soulId: _bs.soul_id });
          if (_still && _still.ok && _still.url) referenceImageUrl = _still.url;
        }
      } catch (_e) { console.warn("[BrandFace] soul keyframe failed:", _e.message); }
    }
    if (durSec > 15) {
      return res.json(await startStitchedCinematic({ db, userId, prompt, durSec, ar, referenceImageUrl, chargeId }));
    }

    // ── Path B: Kling is PRIMARY for ≤15s (true text-to-video / image-to-video).
    //    Runway (text) and Higgsfield DoP (image) remain automatic fallbacks. ──
    if (klingProvider.isEnabled()) {
      try {
        const k = referenceImageUrl
          ? await klingProvider.generateImageToVideo({ prompt: prompt || "Cinematic camera movement", duration: durSec, aspectRatio: ar, referenceImageUrl })
          : await klingProvider.generateTextToVideo({ prompt: prompt || "Cinematic scene", duration: durSec, aspectRatio: ar });
        if (k.ok && (k.url || k.requestId)) {
          try { trackUsage(getDb(), req.userId, "cinematicVideos", 1); } catch(_) {}
          if (k.url) return res.json({ success: true, videoUrl: k.url, provider: "kling", chargeId, message: "Cinematic video generated (Kling)" });
          return res.json({ success: true, taskId: k.requestId, provider: "kling", status: "processing", pollUrl: "/api/features/video/runway-status/" + k.requestId + "?p=kling", chargeId, message: "Cinematic video processing (Kling, 30–90s)" });
        }
        console.warn("[Kling] failed, falling back to HF/Runway:", k.error);
      } catch (ke) { console.warn("[Kling] error, falling back:", ke.message); }
    }

    // ── Try Higgsfield DoP first when reference image is present ─────────────
    if (referenceImageUrl && hfProvider.isEnabled()) {
      try {
        const hfResult = await hfProvider.generateKlingVideo({
          prompt: prompt || "Cinematic camera movement",
          duration: duration || 5,
          aspectRatio: ratio === "768:1280" ? "9:16" : "16:9",
          referenceImageUrl,
        });
        if (hfResult.ok && (hfResult.url || hfResult.requestId)) {
          // HF returns either a finished URL or a job ID for polling
          try { trackUsage(getDb(), req.userId, "cinematicVideos", 1); } catch(_) {}
          if (hfResult.url) {
            return res.json({
              success: true, videoUrl: hfResult.url, provider: "higgsfield-dop",
              chargeId, message: "Cinematic video generated (Higgsfield DoP)"
            });
          }
          // Returned job ID — frontend should poll
          return res.json({
            success: true, taskId: hfResult.requestId, provider: "higgsfield-dop",
            status: "processing", pollUrl: "/api/features/video/runway-status/" + hfResult.requestId + "?p=hf",
            chargeId, message: "Cinematic video processing (Higgsfield DoP, 30-60s)"
          });
        }
        console.warn("[video/runway] HF DoP failed, falling back to Runway:", hfResult.error);
      } catch (hfErr) {
        console.warn("[video/runway] HF DoP exception, falling back to Runway:", hfErr.message);
      }
    }

    // Generate enhanced prompt via Claude if short
    let finalPrompt = prompt || "";
    if (finalPrompt.length < 30) {
      try {
        const Anthropic = require("@anthropic-ai/sdk");
        const claude = new Anthropic({ apiKey: getSetting("ANTHROPIC_API_KEY") });
        const pr = await claude.messages.create({
          model: "claude-sonnet-4-6", max_tokens: 200,
          messages: [{ role: "user", content: `Write a cinematic video prompt for Runway Gen-3 for: "${finalPrompt}". Describe camera movement, lighting, mood, style. 1-2 sentences. No dialogue.` }]
        });
        finalPrompt = pr.content[0]?.text || finalPrompt;
      } catch (e) { /* use original */ }
    }

    const runwayKey = getSetting("RUNWAY_API_KEY") || process.env.RUNWAY_API_KEY;
    if (!runwayKey) return res.json({ success: false, error: "Runway not configured. Add RUNWAY_API_KEY in settings.", chargeId });

    // Runway Gen-3 Alpha Turbo endpoint
    const fetch2 = (await import("node-fetch")).default;

    try {
      const rr = await fetch2("https://api.dev.runwayml.com/v1/image_to_video", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runwayKey}`,
          "Content-Type": "application/json",
          "X-Runway-Version": "2024-11-06"
        },
        body: JSON.stringify({
          model: "gen3a_turbo",
          promptText: finalPrompt,
          duration: duration || 10,        // 5 or 10 seconds
          ratio: ratio || "1280:768",       // landscape default, use "768:1280" for Reels
          watermark: false
        })
      });
      const rd = await rr.json();
      const taskId = rd.id;
      if (!taskId) return res.json({ success: false, error: rd.message || rd.error || "Runway failed to start", chargeId });
      // Track cinematicVideos usage — Runway and Higgsfield both count toward same cap
      try { trackUsage(getDb(), req.userId, "cinematicVideos", 1); }
      catch (trackErr) { console.warn("[Runway] usage tracking failed:", trackErr.message); }
      res.json({ success: true, taskId, pollUrl: `/api/features/video/runway-status/${taskId}?p=runway`, chargeId, provider: "runway", prompt: finalPrompt });
    } catch (e) {
      res.json({ success: false, error: "Runway API error", chargeId });
    }
  } catch (e) {
    console.error("[Runway]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Poll video status (Runway OR Higgsfield Kling — auto-detect by task ID format)
router.get("/video/runway-status/:taskId", auth, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const p = String(req.query.p || "").toLowerCase();
    const klingProvider = require("./kling-provider");
    const hfProvider = require("./higgsfield-provider");

    // Composite (stitched >15s) jobs are tracked in our own DB.
    if (String(taskId).startsWith("cine_")) {
      return res.json(await pollStitchedCinematic(getDb(), taskId, req.userId));
    }

    // Kling (Path B primary): explicit ?p=kling, or no hint + Kling enabled.
    if ((p === "kling" || !p) && klingProvider.isEnabled()) {
      const kr = await klingProvider.pollJob(taskId);
      if (kr.ok) {
        const status = kr.status === "completed" ? "complete" : kr.status === "failed" ? "failed" : "processing";
        if (p === "kling" || status !== "failed" || kr.url) {
          return res.json({ status, url: kr.url || null, progress: kr.progress || 0, provider: "kling" });
        }
      } else if (p === "kling") {
        return res.json({ status: "processing", url: null, progress: 0, provider: "kling" });
      }
    }

    // Higgsfield DoP.
    if ((p === "hf" || !p) && hfProvider.isEnabled()) {
      const hfResult = await hfProvider.pollJob(taskId);
      if (hfResult.ok) {
        const status = hfResult.status === "completed" ? "complete"
                     : hfResult.status === "failed"    ? "failed"
                     : "processing";
        if (p === "hf" || status !== "failed" || hfResult.url) {
          return res.json({ status, url: hfResult.url || null, progress: hfResult.progress || 0, provider: "higgsfield-kling" });
        }
      }
    }

    // Runway (explicit ?p=runway, or final fallback).
    const runwayKey = getSetting("RUNWAY_API_KEY") || process.env.RUNWAY_API_KEY;
    if (!runwayKey) return res.json({ status: "processing", url: null, progress: 0, provider: "none" });
    const fetch2 = (await import("node-fetch")).default;
    const r = await fetch2(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${runwayKey}`, "X-Runway-Version": "2024-11-06" }
    });
    const d = await r.json();
    const status = d.status === "SUCCEEDED" ? "complete" : d.status === "FAILED" ? "failed" : "processing";
    res.json({ status, url: d.output?.[0] || null, progress: d.progress || 0, provider: "runway" });
  } catch (e) {
    res.json({ status: "error", error: "An internal error occurred" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// HIGGSFIELD CINEMATIC — DoP image-to-video for product/scene animation
// Different from /video/runway: takes a reference image + prompt, animates it.
// Lets users upload a product photo (or pick from their library) and get a
// cinematic 5s clip with camera motion / scene animation.
// Falls back gracefully if HF not configured.
// ═══════════════════════════════════════════════════════════════════

router.post("/video/higgsfield-cinematic", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    const HF_VIDEO_PRICE = 5.00; // Lower than Runway $25 — DoP wholesale cost is ~$1-3
    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    const hfProvider = require("./higgsfield-provider");

    // ── Validate inputs ──────────────────────────────────────────────────────
    const { prompt, referenceImageUrl, aspectRatio } = req.body || {};
    if (!prompt || prompt.length < 3) {
      return res.status(400).json({ error: "prompt required (min 3 chars)" });
    }
    if (!referenceImageUrl) {
      return res.status(400).json({
        error: "referenceImageUrl required. DoP is image-to-video — pick an image from your library or upload one first.",
      });
    }

    // ── Check Higgsfield availability before charging ────────────────────────
    if (!hfProvider.isEnabled()) {
      return res.status(503).json({
        error: "Higgsfield not configured. Set HF_API_KEY + HF_API_SECRET in env to enable DoP cinematic video.",
        provider: "higgsfield-dop",
      });
    }

    // ── Charge customer BEFORE generating (same pattern as Runway) ──────────
    let chargeId = null;
    if (stripeKey) {
      const userRow = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(userId);
      if (!userRow?.stripe_customer_id) {
        return res.status(402).json({
          error: "No payment method on file. Add a card in billing settings.",
          needsPaymentMethod: true,
        });
      }
      // ── Admin bypass: owner uses free, costs route to company API accounts ─
      const _isAdminHF = (typeof global.mineIsAdmin === "function") && global.mineIsAdmin(db, userId);
      if (_isAdminHF) {
        chargeId = "admin_free_hf_" + Date.now();
      } else try {
        const stripe = require("stripe")(stripeKey);
        const promptHash = require("crypto").createHash("md5").update(String(prompt || "")).digest("hex").slice(0, 8);
        const idemKey = `hfvid_${userId}_${promptHash}_${Math.floor(Date.now() / 300000)}`;
        const pi = await stripe.paymentIntents.create({
          amount: Math.round(HF_VIDEO_PRICE * 100),
          currency: "usd",
          customer: userRow.stripe_customer_id,
          payment_method_types: ["card"],
          confirm: true,
          off_session: true,
          description: `MINE Higgsfield Cinematic — ${userRow.email}`,
          metadata: { user_id: userId, metric: "higgsfieldVideos", price: HF_VIDEO_PRICE },
        }, { idempotencyKey: idemKey });
        if (pi.status !== "succeeded") {
          return res.status(402).json({ error: "Payment failed. Check billing settings.", paymentStatus: pi.status });
        }
        chargeId = pi.id;
        try {
          const period = new Date().toISOString().slice(0, 7);
          const { v4: chargeUuid } = require("uuid");
          db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status, stripe_invoice_item_id) VALUES (?,?,?,?,?,?,?,'paid',?)")
            .run(chargeUuid(), userId, "higgsfieldVideos", 1, HF_VIDEO_PRICE, HF_VIDEO_PRICE, period, chargeId);
        } catch (_) { /* table may not exist */ }
      } catch (stripeErr) {
        if (stripeErr.code === "card_declined" || stripeErr.code === "authentication_required") {
          return res.status(402).json({ error: "Card declined. Update your payment method.", code: stripeErr.code });
        }
        return res.status(402).json({ error: "Payment error: " + stripeErr.message });
      }
    }

    // ── Enhance prompt for cinematic motion via Claude (optional) ───────────
    let finalPrompt = prompt;
    if (finalPrompt.length < 30) {
      try {
        const Anthropic = require("@anthropic-ai/sdk");
        const claude = new Anthropic({ apiKey: getSetting("ANTHROPIC_API_KEY") });
        const pr = await claude.messages.create({
          model: "claude-sonnet-4-6", max_tokens: 200,
          messages: [{ role: "user", content: `Write a cinematic camera-movement prompt for an AI video model animating a still image. Subject: "${finalPrompt}". Describe camera movement (dolly, push-in, orbit, etc), lighting changes, and mood. 1-2 sentences. No dialogue.` }]
        });
        finalPrompt = pr.content[0]?.text || finalPrompt;
      } catch (e) { /* use original */ }
    }

    // ── Call Higgsfield DoP ──────────────────────────────────────────────────
    try {
      const hfResult = await hfProvider.generateKlingVideo({
        prompt: finalPrompt,
        duration: 5,
        aspectRatio: aspectRatio || "16:9",
        referenceImageUrl,
      });

      // If we got a final URL synchronously (rare) or just a job ID (typical)
      if (hfResult.ok && hfResult.url) {
        // Track cinematicVideos usage for cap + overage billing
        try { trackUsage(getDb(), req.userId, "cinematicVideos", 1); }
        catch (trackErr) { console.warn("[higgsfield-cinematic] usage tracking failed:", trackErr.message); }
        return res.json({
          success: true,
          status: "complete",
          url: hfResult.url,
          chargeId,
          provider: "higgsfield-dop",
          prompt: finalPrompt,
        });
      }
      if (hfResult.ok && hfResult.requestId) {
        // Track cinematicVideos usage when the job is accepted (sent to HF, will burn credits)
        try { trackUsage(getDb(), req.userId, "cinematicVideos", 1); }
        catch (trackErr) { console.warn("[higgsfield-cinematic] usage tracking failed:", trackErr.message); }
        return res.json({
          success: true,
          status: "processing",
          taskId: hfResult.requestId,
          pollUrl: `/api/features/video/runway-status/${hfResult.requestId}`,
          chargeId,
          provider: "higgsfield-dop",
          prompt: finalPrompt,
        });
      }

      // ── If HF call failed AFTER charge — refund ────────────────────────────
      if (chargeId && stripeKey) {
        try {
          const stripe = require("stripe")(stripeKey);
          await stripe.refunds.create({ payment_intent: chargeId, reason: "requested_by_customer" });
          console.log("[higgsfield-cinematic] refunded after failure:", chargeId);
        } catch (refErr) { console.warn("[higgsfield-cinematic] refund failed:", refErr.message); }
      }
      return res.status(502).json({
        success: false,
        error: hfResult.error || "Higgsfield generation failed. Your card was refunded.",
        chargeId,
      });
    } catch (e) {
      console.error("[higgsfield-cinematic]", e.message);
      // Refund on exception too
      if (chargeId && stripeKey) {
        try {
          const stripe = require("stripe")(stripeKey);
          await stripe.refunds.create({ payment_intent: chargeId, reason: "requested_by_customer" });
        } catch (_) {}
      }
      return res.status(500).json({ success: false, error: "Server error. Card refunded if charged." });
    }
  } catch (e) {
    console.error("[higgsfield-cinematic outer]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// GET /api/features/video/higgsfield-status — check if HF is configured (frontend uses this to show/hide the card)
router.get("/video/higgsfield-status", auth, (req, res) => {
  const hfProvider = require("./higgsfield-provider");
  res.json({ enabled: hfProvider.isEnabled() });
});

// ═══════════════════════════════════════════════════════════════════
// UGC VIDEO ADS (DEPRECATED — was Arcads, now HeyGen $0.25/sec with $1 minimum)
// See /api/features/video/heygen for the live HeyGen integration.
// ═══════════════════════════════════════════════════════════════════

// Creates Reels/TikToks/Shorts from product photos + AI script

router.post("/video/short-form", auth, async (req, res) => {
  // Arcads has been removed from MINE. UGC/short-form videos are now generated via HeyGen.
  // Frontend should POST to /api/features/video/heygen instead of this endpoint.
  return res.status(410).json({
    success: false,
    error: "Arcads has been discontinued. Use /api/features/video/heygen for UGC videos.",
    redirect: "/api/features/video/heygen"
  });
});



// Get user's generated short-form videos
router.get("/video/short-form", auth, (req, res) => {
  const db = getDb();
  try {
    const videos = db.prepare("SELECT * FROM short_form_videos WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").all(req.userId);
    res.json({ videos: videos.map(v => ({ ...v, script: JSON.parse(v.script || "{}"), platforms: JSON.parse(v.platforms || "[]") })) });
  } catch(e) { res.json({ videos: [] }); }
});

router.delete("/video/short-form/:id", auth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("DELETE FROM short_form_videos WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    res.json({ ok: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════
// FEATURE 3: EMBEDDED CUSTOMER ANALYTICS
// ═══════════════════════════════════════
// Customers see their own order history, spend tracking, loyalty points on published sites

const _customerAuthLimiter = require("express-rate-limit")({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 OTP attempts per IP per 15 min
  keyGenerator: (req) => req.ip + ":" + (req.body?.email || ""),
  message: { error: "Too many login attempts — please wait 15 minutes" },
  standardHeaders: true, legacyHeaders: false,
});
router.post("/customer-portal/auth", _customerAuthLimiter, async (req, res) => {
  try {
    const { siteId, email, code } = req.body;
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS customer_accounts (id TEXT PRIMARY KEY, site_id TEXT, email TEXT UNIQUE, name TEXT, phone TEXT, total_spent REAL DEFAULT 0, order_count INTEGER DEFAULT 0, loyalty_points INTEGER DEFAULT 0, created_at TEXT, last_login TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS customer_orders (id TEXT PRIMARY KEY, customer_id TEXT, site_id TEXT, items TEXT, total REAL, status TEXT, created_at TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS customer_auth_codes (email TEXT, code TEXT, expires TEXT)");

    if (!code) {
      // Send magic link / OTP
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare("INSERT OR REPLACE INTO customer_auth_codes VALUES (?,?,datetime('now','+10 minutes'))").run(email, otp);
      // Send via email
      const sgKey = getSetting("SENDGRID_API_KEY");
      if (sgKey) {
        const fetch = (await import("node-fetch")).default;
        const site = db.prepare("SELECT name FROM sites WHERE id = ?").get(siteId);
        const bizName = site?.name || "Your account";
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({ personalizations: [{ to: [{ email }] }], from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: bizName }, subject: `${bizName} — Your login code`, content: [{ type: "text/plain", value: `Your login code for ${bizName} is: ${otp}\n\nThis code expires in 10 minutes.` }] })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
      res.json({ sent: true });
    } else {
      // Verify code
      const valid = db.prepare("SELECT * FROM customer_auth_codes WHERE email = ? AND code = ? AND datetime(expires) > datetime('now')").get(email, code);
      if (!valid) {
        // Count failed attempts and invalidate OTP after 5 failures
        try {
          db.exec("ALTER TABLE customer_auth_codes ADD COLUMN failures INTEGER DEFAULT 0");
        } catch(e) {}
        db.prepare("UPDATE customer_auth_codes SET failures = COALESCE(failures,0) + 1 WHERE email = ?").run(email);
        const row = db.prepare("SELECT failures FROM customer_auth_codes WHERE email = ?").get(email);
        if (row && row.failures >= 5) {
          db.prepare("DELETE FROM customer_auth_codes WHERE email = ?").run(email);
          return res.status(401).json({ error: "Too many failed attempts — request a new code" });
        }
        return res.status(401).json({ error: "Invalid or expired code" });
      }

      // Find or create customer
      let customer = db.prepare("SELECT * FROM customer_accounts WHERE email = ? AND site_id = ?").get(email, siteId);
      if (!customer) {
        const id = uuid();
        db.prepare("INSERT INTO customer_accounts (id, site_id, email, name, created_at) VALUES (?,?,?,?,datetime('now'))").run(id, siteId, email, email.split("@")[0]);
        customer = db.prepare("SELECT * FROM customer_accounts WHERE id = ?").get(id);
      }
      const sessionToken = require("crypto").randomBytes(32).toString("hex");
      try { db.exec("ALTER TABLE customer_accounts ADD COLUMN session_token TEXT"); } catch(e) {}
      db.prepare("UPDATE customer_accounts SET last_login = datetime('now'), session_token = ? WHERE id = ?").run(sessionToken, customer.id);
      db.prepare("DELETE FROM customer_auth_codes WHERE email = ?").run(email);

      // Get their data
      const orders = db.prepare("SELECT * FROM customer_orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50").all(customer.id);
      res.json({
        sessionToken,
        customer: { id: customer.id, name: customer.name, email: customer.email, totalSpent: customer.total_spent, orderCount: customer.order_count, loyaltyPoints: customer.loyalty_points },
        orders: orders.map(o => ({ ...o, items: JSON.parse(o.items || "[]") }))
      });
    }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Customer dashboard data (embedded in published site) — requires OTP session
router.get("/customer-portal/:customerId", async (req, res) => {
  const db = getDb();
  try {
    // Require a valid OTP-issued session: customer ID must match the auth token email
    const authHeader = req.headers.authorization?.replace("Bearer ", "");
    if (!authHeader) return res.status(401).json({ error: "Authentication required" });
    const customer = db.prepare("SELECT * FROM customer_accounts WHERE id = ?").get(req.params.customerId);
    if (!customer) return res.status(404).json({ error: "Not found" });
    // Validate that the bearer token belongs to this customer's account
    // (token stored in customer_auth_codes is cleared on use; we use customer id as session proof)
    // Simple approach: token must equal customer.session_token if set, else reject
    if (!customer.session_token || !authHeader) return res.status(403).json({ error: "Forbidden" });
    try {
      const a = Buffer.from(customer.session_token); const b = Buffer.from(authHeader);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: "Forbidden" });
    } catch(e) { return res.status(403).json({ error: "Forbidden" }); }

    // Orders
    const orders = db.prepare("SELECT * FROM customer_orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20").all(customer.id);
    const monthlySpend = db.prepare("SELECT strftime('%Y-%m', created_at) as month, SUM(total) as total FROM customer_orders WHERE customer_id = ? GROUP BY month ORDER BY month DESC LIMIT 12").all(customer.id);

    // Courses — enrolled courses with progress
    let courses = [];
    try {
      courses = db.prepare(`SELECT c.id, c.name, c.modules_json, e.progress, e.completed, e.created_at as enrolled_at
        FROM courses c JOIN enrollments e ON e.course_id = c.id
        WHERE e.student_email = ? ORDER BY e.created_at DESC`).all(customer.email);
      courses = courses.map(c => ({ ...c, modules: JSON.parse(c.modules_json || "[]"), modules_json: undefined }));
    } catch(e) {}

    // Memberships — active memberships
    let memberships = [];
    try {
      memberships = db.prepare(`SELECT m.name, m.level, me.status, me.started_at, me.expires_at
        FROM membership_tiers m JOIN membership_enrollments me ON me.membership_id = m.id
        WHERE me.customer_email = ? AND me.status = 'active' ORDER BY me.started_at DESC`).all(customer.email);
    } catch(e) {}

    // Bookings — upcoming appointments
    let bookings = [];
    try {
      bookings = db.prepare("SELECT * FROM bookings WHERE customer_email = ? AND datetime(date || ' ' || time) >= datetime('now') ORDER BY date ASC LIMIT 10").all(customer.email);
    } catch(e) {}

    // Community — member profile
    let communityPosts = [];
    try {
      communityPosts = db.prepare("SELECT id, title, body, likes, replies_count, created_at FROM community_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(customer.id);
    } catch(e) {}

    // Contracts — signed contracts
    let contracts = [];
    try {
      contracts = db.prepare("SELECT id, title, status, amount, signed_at, created_at FROM contracts WHERE client_email = ? ORDER BY created_at DESC LIMIT 10").all(customer.email);
    } catch(e) {}

    // Subscriptions — active recurring billing
    let subscriptions = [];
    try {
      subscriptions = db.prepare("SELECT * FROM payment_plan_enrollments WHERE customer_email = ? AND status = 'active' ORDER BY created_at DESC").all(customer.email);
    } catch(e) {}

    res.json({
      customer: { name: customer.name, email: customer.email, totalSpent: customer.total_spent, orderCount: customer.order_count, loyaltyPoints: customer.loyalty_points, memberSince: customer.created_at },
      orders: orders.map(o => ({ ...o, items: JSON.parse(o.items || "[]") })),
      monthlySpend,
      courses,
      memberships,
      bookings,
      communityPosts,
      contracts,
      subscriptions,
      loyaltyTier: customer.total_spent > 1000 ? "Gold" : customer.total_spent > 500 ? "Silver" : "Bronze",
      nextReward: customer.loyalty_points >= 100 ? "Redeem $10 off!" : `${100 - customer.loyalty_points} points to next reward`,
      // Tell frontend which sections to show based on what data exists
      sections: {
        orders: orders.length > 0,
        courses: courses.length > 0,
        memberships: memberships.length > 0,
        bookings: bookings.length > 0,
        community: communityPosts.length > 0,
        contracts: contracts.length > 0,
        subscriptions: subscriptions.length > 0,
        loyalty: customer.loyalty_points > 0 || customer.total_spent > 0
      }
    });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


// ═══════════════════════════════════════
// LOYALTY PROGRAM — configurable points, tiers, milestones, redemption
// ═══════════════════════════════════════

function ensureLoyaltyTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loyalty_config (
      id TEXT PRIMARY KEY, user_id TEXT UNIQUE, enabled INTEGER DEFAULT 1,
      points_per_dollar REAL DEFAULT 1,
      signup_bonus INTEGER DEFAULT 50,
      referral_bonus INTEGER DEFAULT 100,
      birthday_bonus INTEGER DEFAULT 50,
      review_bonus INTEGER DEFAULT 25,
      course_complete_bonus INTEGER DEFAULT 100,
      booking_bonus INTEGER DEFAULT 10,
      tiers TEXT DEFAULT '[{"name":"Bronze","minPoints":0,"perks":"Early access to sales","color":"#CD7F32"},{"name":"Silver","minPoints":500,"perks":"5% off all orders","discountPercent":5,"color":"#C0C0C0"},{"name":"Gold","minPoints":1500,"perks":"10% off + free shipping","discountPercent":10,"color":"#FFD700"},{"name":"Platinum","minPoints":5000,"perks":"15% off + VIP support + birthday gift","discountPercent":15,"color":"#E5E4E2"}]',
      milestones TEXT DEFAULT '[{"name":"First Purchase","trigger":"order_count","value":1,"reward":25,"icon":"🛍️"},{"name":"5 Orders","trigger":"order_count","value":5,"reward":75,"icon":"🎯"},{"name":"10 Orders","trigger":"order_count","value":10,"reward":200,"icon":"🏆"},{"name":"$100 Spent","trigger":"total_spent","value":100,"reward":50,"icon":"💰"},{"name":"$500 Spent","trigger":"total_spent","value":500,"reward":150,"icon":"💎"},{"name":"$1000 Spent","trigger":"total_spent","value":1000,"reward":500,"icon":"👑"},{"name":"First Review","trigger":"review_count","value":1,"reward":25,"icon":"⭐"},{"name":"Course Graduate","trigger":"course_complete","value":1,"reward":100,"icon":"🎓"},{"name":"1 Year Member","trigger":"member_days","value":365,"reward":200,"icon":"🎂"}]',
      rewards TEXT DEFAULT '[{"name":"$5 Off","pointsCost":50,"type":"discount","value":5},{"name":"$10 Off","pointsCost":100,"type":"discount","value":10},{"name":"$25 Off","pointsCost":200,"type":"discount","value":25},{"name":"Free Shipping","pointsCost":75,"type":"free_shipping","value":0},{"name":"10% Off Next Order","pointsCost":150,"type":"percent_discount","value":10}]',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id TEXT PRIMARY KEY, customer_id TEXT, user_id TEXT,
      type TEXT, points INTEGER, balance_after INTEGER,
      description TEXT, reference_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS loyalty_milestones_achieved (
      id TEXT PRIMARY KEY, customer_id TEXT, milestone_name TEXT,
      points_awarded INTEGER, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(customer_id, milestone_name)
    );
    CREATE TABLE IF NOT EXISTS loyalty_redemptions (
      id TEXT PRIMARY KEY, customer_id TEXT, user_id TEXT,
      reward_name TEXT, points_spent INTEGER, type TEXT, value REAL,
      coupon_code TEXT UNIQUE, used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_tx_customer ON loyalty_transactions(customer_id);
    CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_code ON loyalty_redemptions(coupon_code);
  `);
}

// Get/update loyalty program config
router.get("/loyalty/config", auth, (req, res) => {
  const db = getDb();
  ensureLoyaltyTables(db);
  const config = db.prepare("SELECT * FROM loyalty_config WHERE user_id = ?").get(req.userId);
  if (!config) {
    const id = uuid();
    db.prepare("INSERT INTO loyalty_config (id, user_id) VALUES (?,?)").run(id, req.userId);
    return res.json({ config: db.prepare("SELECT * FROM loyalty_config WHERE id = ?").get(id) });
  }
  res.json({ config: { ...config, tiers: JSON.parse(config.tiers || "[]"), milestones: JSON.parse(config.milestones || "[]"), rewards: JSON.parse(config.rewards || "[]") } });
});

router.put("/loyalty/config", auth, (req, res) => {
  const db = getDb();
  ensureLoyaltyTables(db);
  const { enabled, points_per_dollar, signup_bonus, referral_bonus, birthday_bonus, review_bonus, course_complete_bonus, booking_bonus, tiers, milestones, rewards } = req.body;
  db.prepare(`UPDATE loyalty_config SET enabled=?, points_per_dollar=?, signup_bonus=?, referral_bonus=?, birthday_bonus=?, review_bonus=?, course_complete_bonus=?, booking_bonus=?, tiers=?, milestones=?, rewards=?, updated_at=datetime('now') WHERE user_id=?`)
    .run(enabled ?? 1, points_per_dollar ?? 1, signup_bonus ?? 50, referral_bonus ?? 100, birthday_bonus ?? 50, review_bonus ?? 25, course_complete_bonus ?? 100, booking_bonus ?? 10, JSON.stringify(tiers || []), JSON.stringify(milestones || []), JSON.stringify(rewards || []), req.userId);
  res.json({ success: true });
});

// Award points to a customer (called internally on purchase, review, etc.)
router.post("/loyalty/award", auth, (req, res) => {
  const { customerEmail, type, points, description, referenceId } = req.body;
  const db = getDb();
  ensureLoyaltyTables(db);

  const config = db.prepare("SELECT * FROM loyalty_config WHERE user_id = ?").get(req.userId);
  if (!config?.enabled) return res.json({ awarded: false, reason: "Loyalty program disabled" });

  // Find or create customer
  db.exec("CREATE TABLE IF NOT EXISTS customer_accounts (id TEXT PRIMARY KEY, site_id TEXT, email TEXT, name TEXT, phone TEXT, total_spent REAL DEFAULT 0, order_count INTEGER DEFAULT 0, loyalty_points INTEGER DEFAULT 0, created_at TEXT, last_login TEXT)");
  let customer = db.prepare("SELECT * FROM customer_accounts WHERE email = ?").get(customerEmail);
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  // Award points
  // Atomic increment — avoids read-then-write race on concurrent awards
  db.prepare("UPDATE customer_accounts SET loyalty_points = loyalty_points + ? WHERE id = ?").run(points, customer.id);

  // Log transaction
  db.prepare("INSERT INTO loyalty_transactions (id, customer_id, user_id, type, points, balance_after, description, reference_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(uuid(), customer.id, req.userId, type || "manual", points, newBalance, description || "Points awarded", referenceId || null);

  // Check milestones
  const milestones = JSON.parse(config.milestones || "[]");
  const achieved = [];
  for (const m of milestones) {
    const existing = db.prepare("SELECT id FROM loyalty_milestones_achieved WHERE customer_id = ? AND milestone_name = ?").get(customer.id, m.name);
    if (existing) continue;

    let met = false;
    if (m.trigger === "order_count") met = (customer.order_count || 0) >= m.value;
    else if (m.trigger === "total_spent") met = (customer.total_spent || 0) >= m.value;
    else if (m.trigger === "review_count") {
      try { const rc = db.prepare("SELECT COUNT(*) as n FROM reviews WHERE customer_email = ?").get(customerEmail); met = (rc?.n || 0) >= m.value; } catch(e) {}
    }
    else if (m.trigger === "course_complete") {
      try { const cc = db.prepare("SELECT COUNT(*) as n FROM enrollments WHERE student_email = ? AND completed = 1").get(customerEmail); met = (cc?.n || 0) >= m.value; } catch(e) {}
    }
    else if (m.trigger === "member_days") {
      const daysSince = Math.floor((Date.now() - new Date(customer.created_at).getTime()) / 86400000);
      met = daysSince >= m.value;
    }

    if (met && m.reward) {
      const milestoneBalance = newBalance + m.reward;
      db.prepare("UPDATE customer_accounts SET loyalty_points = ? WHERE id = ?").run(milestoneBalance, customer.id);
      db.prepare("INSERT INTO loyalty_milestones_achieved (id, customer_id, milestone_name, points_awarded) VALUES (?,?,?,?)").run(uuid(), customer.id, m.name, m.reward);
      db.prepare("INSERT INTO loyalty_transactions (id, customer_id, user_id, type, points, balance_after, description) VALUES (?,?,?,?,?,?,?)").run(uuid(), customer.id, req.userId, "milestone", m.reward, milestoneBalance, `Milestone: ${m.name}`);
      achieved.push({ name: m.name, points: m.reward, icon: m.icon });
    }
  }

  // Determine tier
  const tiers = JSON.parse(config.tiers || "[]").sort((a, b) => b.minPoints - a.minPoints);
  const currentTier = tiers.find(t => newBalance >= t.minPoints) || tiers[tiers.length - 1] || { name: "Member" };

  res.json({ awarded: true, points, newBalance: db.prepare("SELECT loyalty_points FROM customer_accounts WHERE id = ?").get(customer.id).loyalty_points, tier: currentTier, milestonesAchieved: achieved });
});

// Auto-award on purchase — call this from payment webhook or order creation
router.post("/loyalty/purchase", auth, async (req, res) => {
  try {
    const { customerEmail, orderTotal, orderId } = req.body;
    const db = getDb();
    ensureLoyaltyTables(db);

    const config = db.prepare("SELECT * FROM loyalty_config WHERE user_id = ?").get(req.userId);
    if (!config?.enabled) return res.json({ awarded: false });

    const points = Math.floor((orderTotal || 0) * (config.points_per_dollar || 1));
    if (points <= 0) return res.json({ awarded: false, reason: "No points earned" });

    // Update customer spend tracking
    db.exec("CREATE TABLE IF NOT EXISTS customer_accounts (id TEXT PRIMARY KEY, site_id TEXT, email TEXT, name TEXT, phone TEXT, total_spent REAL DEFAULT 0, order_count INTEGER DEFAULT 0, loyalty_points INTEGER DEFAULT 0, created_at TEXT, last_login TEXT)");
    const customer = db.prepare("SELECT * FROM customer_accounts WHERE email = ?").get(customerEmail);
    if (!customer) return res.json({ awarded: false, reason: "Customer not found" });

    db.prepare("UPDATE customer_accounts SET total_spent = total_spent + ?, order_count = order_count + 1 WHERE id = ?").run(orderTotal || 0, customer.id);

    // Award points (piggyback on the /award logic internally)
    // Atomic increment — avoids read-then-write race on concurrent awards
    db.prepare("UPDATE customer_accounts SET loyalty_points = loyalty_points + ? WHERE id = ?").run(points, customer.id);
    db.prepare("INSERT INTO loyalty_transactions (id, customer_id, user_id, type, points, balance_after, description, reference_id) VALUES (?,?,?,?,?,?,?,?)")
      .run(uuid(), customer.id, req.userId, "purchase", points, newBalance, `Earned ${points} pts from $${orderTotal} order`, orderId || null);

    // Check milestones
    const milestones = JSON.parse(config.milestones || "[]");
    const updatedCustomer = db.prepare("SELECT * FROM customer_accounts WHERE id = ?").get(customer.id);
    const achieved = [];
    for (const m of milestones) {
      const existing = db.prepare("SELECT id FROM loyalty_milestones_achieved WHERE customer_id = ? AND milestone_name = ?").get(customer.id, m.name);
      if (existing) continue;
      let met = false;
      if (m.trigger === "order_count") met = updatedCustomer.order_count >= m.value;
      else if (m.trigger === "total_spent") met = updatedCustomer.total_spent >= m.value;
      if (met && m.reward) {
        db.prepare("UPDATE customer_accounts SET loyalty_points = loyalty_points + ? WHERE id = ?").run(m.reward, customer.id);
        db.prepare("INSERT INTO loyalty_milestones_achieved (id, customer_id, milestone_name, points_awarded) VALUES (?,?,?,?)").run(uuid(), customer.id, m.name, m.reward);
        db.prepare("INSERT INTO loyalty_transactions (id, customer_id, user_id, type, points, balance_after, description) VALUES (?,?,?,?,?,?,?)").run(uuid(), customer.id, req.userId, "milestone", m.reward, updatedCustomer.loyalty_points + m.reward, `Milestone: ${m.name}`);
        achieved.push(m);
      }
    }

    res.json({ awarded: true, points, milestonesAchieved: achieved });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" }); }
});

// Redeem points for reward — requires customer session token
router.post("/loyalty/redeem", (req, res) => {
  const { customerId, rewardName } = req.body;
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  const db = getDb();
  ensureLoyaltyTables(db);

  const customer = db.prepare("SELECT * FROM customer_accounts WHERE id = ?").get(customerId);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  if (!sessionToken || !customer.session_token || (() => { try { const a=Buffer.from(customer.session_token),b=Buffer.from(sessionToken); return a.length!==b.length||!crypto.timingSafeEqual(a,b); } catch(e){return true;} })()) {
    return res.status(403).json({ error: "Authentication required to redeem points" });
  }

  // Find site owner's loyalty config
  const config = db.prepare("SELECT * FROM loyalty_config WHERE user_id = (SELECT user_id FROM sites WHERE id = ? LIMIT 1)").get(customer.site_id);
  if (!config) return res.status(400).json({ error: "No loyalty program" });

  const rewards = JSON.parse(config.rewards || "[]");
  const reward = rewards.find(r => r.name === rewardName);
  if (!reward) return res.status(404).json({ error: "Reward not found" });
  if ((customer.loyalty_points || 0) < reward.pointsCost) return res.status(400).json({ error: `Need ${reward.pointsCost} points, you have ${customer.loyalty_points}` });

  // Atomic deduction — WHERE clause prevents double-spend race condition
  const deductResult = db.prepare(
    "UPDATE customer_accounts SET loyalty_points = loyalty_points - ? WHERE id = ? AND loyalty_points >= ?"
  ).run(reward.pointsCost, customer.id, reward.pointsCost);
  if (deductResult.changes === 0) return res.status(400).json({ error: "Insufficient points — please refresh and try again" });
  const newBalance = (customer.loyalty_points || 0) - reward.pointsCost;

  // Generate unique coupon code
  const couponCode = "REWARD-" + require("crypto").randomBytes(4).toString("hex").toUpperCase();
  db.prepare("INSERT INTO loyalty_redemptions (id, customer_id, user_id, reward_name, points_spent, type, value, coupon_code) VALUES (?,?,?,?,?,?,?,?)")
    .run(uuid(), customer.id, config.user_id, reward.name, reward.pointsCost, reward.type, reward.value, couponCode);

  // Log transaction
  db.prepare("INSERT INTO loyalty_transactions (id, customer_id, user_id, type, points, balance_after, description) VALUES (?,?,?,?,?,?,?)")
    .run(uuid(), customer.id, config.user_id, "redemption", -reward.pointsCost, newBalance, `Redeemed: ${reward.name}`);

  res.json({ success: true, couponCode, reward: reward.name, pointsSpent: reward.pointsCost, newBalance, instructions: reward.type === "discount" ? `Use code ${couponCode} for $${reward.value} off` : reward.type === "percent_discount" ? `Use code ${couponCode} for ${reward.value}% off` : `Use code ${couponCode} at checkout for free shipping` });
});

// Customer loyalty dashboard (called from published site)
router.get("/loyalty/customer/:customerId", (req, res) => {
  const db = getDb();
  ensureLoyaltyTables(db);

  const customer = db.prepare("SELECT * FROM customer_accounts WHERE id = ?").get(req.params.customerId);
  if (!customer) return res.status(404).json({ error: "Not found" });
  // Require valid session token — same auth pattern as customer portal
  const authHeader = req.headers.authorization?.replace("Bearer ", "");
  if (!authHeader || !customer.session_token || (() => { try { const a=Buffer.from(customer.session_token),b=Buffer.from(authHeader); return a.length!==b.length||!crypto.timingSafeEqual(a,b); } catch(e){return true;} })()) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const config = db.prepare("SELECT * FROM loyalty_config WHERE user_id = (SELECT user_id FROM sites WHERE id = ? LIMIT 1)").get(customer.site_id);
  if (!config?.enabled) return res.json({ enabled: false });

  const tiers = JSON.parse(config.tiers || "[]").sort((a, b) => b.minPoints - a.minPoints);
  const currentTier = tiers.find(t => (customer.loyalty_points || 0) >= t.minPoints) || tiers[tiers.length - 1] || { name: "Member" };
  const nextTier = tiers.filter(t => t.minPoints > (customer.loyalty_points || 0)).sort((a, b) => a.minPoints - b.minPoints)[0];

  const transactions = db.prepare("SELECT type, points, description, created_at FROM loyalty_transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20").all(customer.id);
  const achievedMilestones = db.prepare("SELECT milestone_name, points_awarded, created_at FROM loyalty_milestones_achieved WHERE customer_id = ?").all(customer.id);
  const rewards = JSON.parse(config.rewards || "[]");
  const allMilestones = JSON.parse(config.milestones || "[]");
  const redemptions = db.prepare("SELECT reward_name, points_spent, coupon_code, used, created_at FROM loyalty_redemptions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10").all(customer.id);

  res.json({
    enabled: true,
    points: customer.loyalty_points || 0,
    totalSpent: customer.total_spent || 0,
    orderCount: customer.order_count || 0,
    currentTier,
    nextTier: nextTier ? { ...nextTier, pointsNeeded: nextTier.minPoints - (customer.loyalty_points || 0) } : null,
    transactions,
    milestones: allMilestones.map(m => ({ ...m, achieved: achievedMilestones.some(a => a.milestone_name === m.name) })),
    rewards: rewards.map(r => ({ ...r, canRedeem: (customer.loyalty_points || 0) >= r.pointsCost })),
    redemptions,
    memberSince: customer.created_at
  });
});

// Business owner: see all loyalty members & stats
router.get("/loyalty/members", auth, (req, res) => {
  const db = getDb();
  ensureLoyaltyTables(db);
  const members = db.prepare("SELECT id, email, name, loyalty_points, total_spent, order_count, created_at, last_login FROM customer_accounts WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND loyalty_points > 0 ORDER BY loyalty_points DESC LIMIT 100").all(req.userId);
  const totalPoints = members.reduce((s, m) => s + (m.loyalty_points || 0), 0);
  const totalMembers = members.length;
  res.json({ members, stats: { totalMembers, totalPoints, avgPoints: totalMembers ? Math.round(totalPoints / totalMembers) : 0 } });
});


// ═══════════════════════════════════════
// FEATURE 6: AFFILIATE / REFERRAL PROGRAM BUILDER
// ═══════════════════════════════════════
// Users create their own affiliate programs — their customers earn commission for referrals


// POST /api/affiliates/invite — auth-gated, invite affiliate directly from dashboard
router.post("/affiliates/invite", auth, async (req, res) => {
  try {
    const { name, email, customRate } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Name and email required" });
    const db = getDb();

    const program = db.prepare("SELECT * FROM affiliate_programs WHERE user_id = ?").get(req.userId);
    if (!program) return res.status(400).json({ error: "Set up your affiliate program first" });

    const existing = db.prepare("SELECT * FROM affiliates WHERE email = ? AND program_id = ?").get(email.toLowerCase().trim(), program.id);
    if (existing) return res.status(409).json({ error: "This person is already an affiliate", affiliate: existing });

    const id = require("uuid").v4();
    const code = name.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 8) + Math.random().toString(36).substring(2, 5);
    const siteUrl = db.prepare("SELECT custom_domain, deploy_url FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const baseUrl = siteUrl?.custom_domain ? "https://" + siteUrl.custom_domain : (siteUrl?.deploy_url || "");
    const link = baseUrl ? baseUrl + "?ref=" + code : code;
    const portalUrl = (process.env.BACKEND_URL || "http://localhost:4000") + "/api/affiliates/portal/login";
    const rate = customRate || program.commission_percent;

    db.prepare("INSERT INTO affiliates (id, program_id, name, email, code, link, created_at) VALUES (?,?,?,?,?,?,datetime('now'))").run(id, program.id, name.trim(), email.toLowerCase().trim(), code, link);

    // Send invite email
    const { getSetting } = require("./integrations");
    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
    const owner = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
    const ownerName = owner?.name || "A business";

    if (sgKey) {
      const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: email.toLowerCase().trim(), name: name.trim() }] }],
          from: { email: fromEmail, name: ownerName },
          subject: "You're invited to join our affiliate program 💸",
          content: [{ type: "text/html", value: `
            <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px">
              <div style="background:linear-gradient(135deg,#4F46E5,#6366F1);border-radius:14px;padding:28px;text-align:center;margin-bottom:24px">
                <div style="font-size:32px;margin-bottom:8px">💸</div>
                <div style="font-size:20px;font-weight:800;color:#fff">You're invited!</div>
                <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">${ownerName} Affiliate Program</div>
              </div>
              <p style="font-size:15px;color:#333;line-height:1.7">Hey ${name.trim()},</p>
              <p style="font-size:14px;color:#555;line-height:1.7;margin-top:8px"><strong>${ownerName}</strong> has invited you to their affiliate program. Promote their business and earn <strong>${rate}% commission</strong> on every sale you refer — paid directly to your bank account.</p>
              <div style="background:#F0F4FF;border:1px solid #C7D2FE;border-radius:12px;padding:20px;margin:20px 0;font-size:13px">
                <div style="margin-bottom:6px"><strong>Your referral link:</strong></div>
                <div style="background:#fff;border-radius:6px;padding:8px 12px;color:#4F46E5;word-break:break-all;font-family:monospace">${link}</div>
                <div style="margin-top:10px;color:#666">Share this link on social media, your website or with friends. You earn ${rate}% on every sale made through it.</div>
              </div>
              <div style="text-align:center;margin:24px 0">
                <a href="${portalUrl}" style="display:inline-block;background:#4F46E5;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px">Access My Affiliate Dashboard →</a>
              </div>
              <div style="font-size:11px;color:#9CA3AF;text-align:center">Commission paid via bank transfer once you reach the $${program.min_payout || 50} minimum. You'll be able to request payouts from your affiliate dashboard.</div>
            </div>
          `}]
        })
      })
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    }

    res.json({ success: true, affiliate: { id, name, email, code, link, rate: rate + "%" } });
  } catch(e) {
    console.error("[Affiliates] invite:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/affiliates/program — get current user's affiliate program config
router.get("/affiliates/program", auth, (req, res) => {
  try {
    const db = getDb();
    const program = db.prepare("SELECT * FROM affiliate_programs WHERE user_id = ?").get(req.userId);
    res.json({ program: program || null, hasProgram: !!program });
  } catch(e) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/affiliates/setup", auth, (req, res) => {
  const { commissionPercent, cookieDays, minPayout, tiers } = req.body;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_programs (id TEXT PRIMARY KEY, user_id TEXT UNIQUE, commission_percent REAL DEFAULT 10, cookie_days INTEGER DEFAULT 30, min_payout REAL DEFAULT 50, tiers TEXT DEFAULT '[]', status TEXT DEFAULT 'active', created_at TEXT);
    CREATE TABLE IF NOT EXISTS affiliates (id TEXT PRIMARY KEY, program_id TEXT, name TEXT, email TEXT, code TEXT UNIQUE, link TEXT, clicks INTEGER DEFAULT 0, signups INTEGER DEFAULT 0, sales INTEGER DEFAULT 0, revenue_generated REAL DEFAULT 0, commission_earned REAL DEFAULT 0, commission_paid REAL DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT);
    CREATE TABLE IF NOT EXISTS affiliate_clicks (id TEXT PRIMARY KEY, affiliate_id TEXT, ip TEXT, user_agent TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS affiliate_conversions (id TEXT PRIMARY KEY, affiliate_id TEXT, order_id TEXT, amount REAL, commission REAL, status TEXT DEFAULT 'pending', created_at TEXT);
  `);

  const existing = db.prepare("SELECT * FROM affiliate_programs WHERE user_id = ?").get(req.userId);
  if (existing) {
    db.prepare("UPDATE affiliate_programs SET commission_percent = ?, cookie_days = ?, min_payout = ?, tiers = ? WHERE user_id = ?")
      .run(commissionPercent || 10, cookieDays || 30, minPayout || 50, JSON.stringify(tiers || []), req.userId);
    return res.json({ success: true, updated: true });
  }

  const id = uuid();
  db.prepare("INSERT INTO affiliate_programs VALUES (?,?,?,?,?,?,?,datetime('now'))")
    .run(id, req.userId, commissionPercent || 10, cookieDays || 30, minPayout || 50, JSON.stringify(tiers || [{ name: "Bronze", minSales: 0, commission: commissionPercent || 10 }, { name: "Silver", minSales: 10, commission: (commissionPercent || 10) + 5 }, { name: "Gold", minSales: 25, commission: (commissionPercent || 10) + 10 }]), "active");

  res.json({ success: true, programId: id });
});

// Register as affiliate (public — for the user's customers)
router.post("/affiliates/register", subscribePublicLimiter, async (req, res) => {
  try {
    const { siteId, name, email } = req.body;
    const db = getDb();

    const site = db.prepare("SELECT user_id FROM sites WHERE id = ?").get(siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    const program = db.prepare("SELECT * FROM affiliate_programs WHERE user_id = ?").get(site.user_id);
    if (!program) return res.status(400).json({ error: "No affiliate program" });

    const existing = db.prepare("SELECT * FROM affiliates WHERE email = ? AND program_id = ?").get(email, program.id);
    if (existing) return res.json({ affiliate: existing });

    const id = uuid();
    const code = name.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 8) + Math.random().toString(36).substring(2, 6);
    const siteUrl = db.prepare("SELECT custom_domain, deploy_url FROM sites WHERE user_id = ? LIMIT 1").get(site.user_id);
    const baseUrl = siteUrl?.custom_domain || siteUrl?.deploy_url || "";
    const link = baseUrl ? baseUrl + "?ref=" + code : code;

    db.prepare("INSERT INTO affiliates (id, program_id, name, email, code, link, created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
      .run(id, program.id, name, email, code, link);

    res.json({ affiliate: { id, name, email, code, link, commission: program.commission_percent + "%" } });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" }); }
});

// Track affiliate click
router.get("/affiliates/track/:code", (req, res) => {
  const db = getDb();
  try {
    const aff = db.prepare("SELECT * FROM affiliates WHERE code = ?").get(req.params.code);
    if (aff) {
      db.prepare("UPDATE affiliates SET clicks = clicks + 1 WHERE id = ?").run(aff.id);
      db.prepare("INSERT INTO affiliate_clicks (id, affiliate_id, ip, user_agent, created_at) VALUES (?,?,?,?,datetime('now'))")
        .run(uuid(), aff.id, req.ip || "", req.headers["user-agent"] || "");
    }
    // Redirect to site
    const program = db.prepare("SELECT user_id FROM affiliate_programs WHERE id = ?").get(aff?.program_id);
    const site = program ? db.prepare("SELECT custom_domain, deploy_url FROM sites WHERE user_id = ? LIMIT 1").get(program.user_id) : null;
    let url = site?.custom_domain || site?.deploy_url || "/";
    // Ensure redirect URL uses http/https to prevent javascript: protocol injection
    if (url !== "/" && !url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    const safeRef = encodeURIComponent(req.params.code);
    res.redirect(url + "?ref=" + safeRef);
  } catch(e) { res.redirect("/"); }
});

// Record affiliate conversion (called when an order comes through with ref code)
router.post("/affiliates/conversion", auth, (req, res) => {
  const { refCode, orderId, amount } = req.body;
  const db = getDb();

  const aff = db.prepare("SELECT a.*, p.commission_percent, p.tiers FROM affiliates a JOIN affiliate_programs p ON a.program_id = p.id WHERE a.code = ?").get(refCode);
  if (!aff) return res.json({ tracked: false, reason: "Invalid code" });

  // Calculate commission based on tier
  const tiers = JSON.parse(aff.tiers || "[]");
  let commissionRate = aff.commission_percent;
  for (const tier of tiers.sort((a, b) => b.minSales - a.minSales)) {
    if (aff.sales >= tier.minSales) { commissionRate = tier.commission; break; }
  }

  const commission = (parseFloat(amount) || 0) * (commissionRate / 100);
  const id = uuid();
  db.prepare("INSERT INTO affiliate_conversions (id, affiliate_id, order_id, amount, commission, created_at) VALUES (?,?,?,?,?,datetime('now'))")
    .run(id, aff.id, orderId || "", amount, commission);
  db.prepare("UPDATE affiliates SET sales = sales + 1, revenue_generated = revenue_generated + ?, commission_earned = commission_earned + ? WHERE id = ?")
    .run(amount, commission, aff.id);

  res.json({ tracked: true, commission, tier: commissionRate + "%" });
});

// Affiliate dashboard (for the user - site owner)
router.get("/affiliates/dashboard", auth, (req, res) => {
  const db = getDb();
  try {
    const program = db.prepare("SELECT * FROM affiliate_programs WHERE user_id = ?").get(req.userId);
    if (!program) return res.json({ hasProgram: false });
    const affiliates = db.prepare("SELECT * FROM affiliates WHERE program_id = ? ORDER BY revenue_generated DESC").all(program.id);
    const recentConversions = db.prepare("SELECT ac.*, a.name as affiliate_name FROM affiliate_conversions ac JOIN affiliates a ON ac.affiliate_id = a.id WHERE a.program_id = ? ORDER BY ac.created_at DESC LIMIT 20").all(program.id);
    const totals = db.prepare("SELECT SUM(revenue_generated) as totalRevenue, SUM(commission_earned) as totalCommission, SUM(clicks) as totalClicks, SUM(sales) as totalSales FROM affiliates WHERE program_id = ?").get(program.id);

    res.json({
      hasProgram: true,
      program: { ...program, tiers: JSON.parse(program.tiers || "[]") },
      affiliates,
      recentConversions,
      totals: totals || { totalRevenue: 0, totalCommission: 0, totalClicks: 0, totalSales: 0 }
    });
  } catch(e) { res.json({ hasProgram: false }); }
});

// Affiliate self-service dashboard — full HTML page (public, no auth)

// POST /api/affiliates/my/:code/request-payout
// Affiliate self-service payout request — notifies the business owner by email
router.post("/affiliates/my/:code/request-payout", async (req, res) => {
  try {
    const db = getDb();
    const aff = db.prepare("SELECT * FROM affiliates WHERE code = ?").get(req.params.code);
    if (!aff) return res.status(404).json({ error: "Affiliate not found" });

    const program = db.prepare("SELECT * FROM affiliate_programs WHERE id = ?").get(aff.program_id);
    if (!program) return res.status(404).json({ error: "Program not found" });

    const pending = aff.commission_earned - aff.commission_paid;
    const minPayout = program.min_payout || 50;

    if (pending < minPayout) {
      return res.status(400).json({ error: `Minimum payout is $${minPayout}. You have $${pending.toFixed(2)} pending.` });
    }

    // Log the request
    try {
      db.exec("CREATE TABLE IF NOT EXISTS affiliate_payout_requests (id TEXT PRIMARY KEY, affiliate_id TEXT, amount REAL, status TEXT DEFAULT 'pending', requested_at TEXT DEFAULT (datetime('now')), note TEXT)");
      // Prevent duplicate requests within 24h
      const recent = db.prepare("SELECT id FROM affiliate_payout_requests WHERE affiliate_id = ? AND status = 'pending' AND requested_at > datetime('now', '-1 day')").get(aff.id);
      if (recent) return res.status(429).json({ error: "You already have a pending payout request. Please wait 24 hours." });
      db.prepare("INSERT INTO affiliate_payout_requests (id, affiliate_id, amount, note) VALUES (?,?,?,?)").run(require("uuid").v4(), aff.id, pending, req.body.note || "");
    } catch(dbErr) { /* non-fatal */ }

    // Email the business owner
    try {
      const owner = db.prepare("SELECT email, name FROM users WHERE id = ?").get(program.user_id);
      const { getSetting } = require("./integrations");
      const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
      const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
      const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

      if (sgKey && owner?.email) {
        const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: owner.email, name: owner.name || "there" }] }],
            from: { email: fromEmail, name: "MINE" },
            subject: `💰 Payout request from ${aff.name || "your affiliate"} — $${pending.toFixed(2)}`,
            content: [{ type: "text/html", value: `
              <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px">
                <h2 style="font-size:20px;margin-bottom:8px">Affiliate payout request 💰</h2>
                <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:20px">
                  <strong>${aff.name || aff.email || "One of your affiliates"}</strong> has requested a payout of
                  <strong style="color:#16A34A">$${pending.toFixed(2)}</strong> for commissions earned.
                </p>
                <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:16px;margin-bottom:20px;font-size:13px">
                  <div><strong>Affiliate:</strong> ${aff.name || ""} (${aff.email || ""})</div>
                  <div><strong>Code:</strong> ${aff.code}</div>
                  <div><strong>Amount:</strong> $${pending.toFixed(2)}</div>
                  <div><strong>Total earned:</strong> $${aff.commission_earned.toFixed(2)}</div>
                  <div><strong>Previously paid:</strong> $${aff.commission_paid.toFixed(2)}</div>
                  ${req.body.note ? '<div><strong>Note:</strong> ' + req.body.note + '</div>' : ''}
                </div>
                <p style="font-size:13px;color:#555;margin-bottom:20px">Log in to your TAKEOVA dashboard → Referrals & Affiliates to process this payment.</p>
                <a href="${frontendUrl}" style="display:inline-block;background:#4F46E5;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:14px">Go to Dashboard →</a>
              </div>
            `}]
          })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
    } catch(emailErr) { /* non-fatal — request is still logged */ }

    res.json({ success: true, amount: pending, message: "Payout request sent! The business owner has been notified and will process your payment." });
  } catch(e) {
    console.error("[Affiliates] Payout request:", e.message);
    res.status(500).json({ error: "Could not submit payout request" });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// BUSINESS AFFILIATE PORTAL — Magic link login, secured stats + payout request
// ═══════════════════════════════════════════════════════════════════════════

const affCrypto = require("crypto");

function ensureAffPortalTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS biz_affiliate_sessions (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS biz_affiliate_magic_links (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS affiliate_payout_requests (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      note TEXT,
      requested_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function affPortalAuth(req, res, next) {
  const db = getDb();
  ensureAffPortalTables(db);
  const token = req.cookies?.aff_session || req.headers["x-aff-token"] || req.query.session;
  if (!token) return res.status(401).json({ error: "Not authenticated", redirect: "/api/affiliates/portal/login" });
  const session = db.prepare("SELECT * FROM biz_affiliate_sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  if (!session) return res.status(401).json({ error: "Session expired", redirect: "/api/affiliates/portal/login" });
  req.bizAffiliateId = session.affiliate_id;
  next();
}

// ── 1. LOGIN PAGE ─────────────────────────────────────────────────────────────
// GET /api/affiliates/portal/login?biz=BIZCODE
router.get("/affiliates/portal/login", (req, res) => {
  const biz = req.query.biz || "";
  const msg = req.query.msg || "";
  const err = req.query.err || "";
  res.send(`<!DOCTYPE html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Affiliate Login</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
    .card{background:#fff;border-radius:16px;padding:36px 32px;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);}
    h1{font-size:22px;font-weight:800;margin-bottom:6px;}
    p{font-size:13px;color:#666;line-height:1.6;margin-bottom:20px;}
    input{width:100%;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:14px;font-family:inherit;margin-bottom:12px;outline:none;}
    input:focus{border-color:#4F46E5;}
    button{width:100%;padding:12px;background:#4F46E5;color:#fff;border:none;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;}
    button:hover{background:#4338ca;}
    .msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;}
    .msg.ok{background:#dcfce7;color:#166534;border:1px solid #86efac;}
    .msg.err{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;}
  </style>
</head><body>
  <div class="card">
    <div style="font-size:28px;margin-bottom:12px">💸</div>
    <h1>Affiliate Portal</h1>
    <p>Enter your email address to receive a secure login link. No password needed.</p>
    ${msg ? '<div class="msg ok">' + msg + '</div>' : ''}
    ${err ? '<div class="msg err">' + err + '</div>' : ''}
    <form method="POST" action="/api/affiliates/portal/send-link">
      <input type="hidden" name="biz" value="${biz}">
      <input type="email" name="email" placeholder="your@email.com" required autofocus>
      <button type="submit">Send me a login link →</button>
    </form>
    <p style="margin-top:14px;text-align:center;font-size:12px;color:#aaa;">Check your inbox — the link expires in 1 hour.</p>
  </div>
</body></html>`);
});

// ── 2. SEND MAGIC LINK ────────────────────────────────────────────────────────
// POST /api/affiliates/portal/send-link
router.post("/affiliates/portal/send-link", async (req, res) => {
  try {
    const db = getDb();
    ensureAffPortalTables(db);
    const email = (req.body.email || "").trim().toLowerCase();
    const biz   = (req.body.biz || "").trim();
    if (!email) return res.redirect("/api/affiliates/portal/login?err=Email+required");

    // Find affiliate by email — optionally filtered by biz program
    let aff;
    if (biz) {
      aff = db.prepare("SELECT a.* FROM affiliates a JOIN affiliate_programs p ON a.program_id = p.id WHERE a.email = ? AND a.code LIKE ?").get(email, biz + "%") ||
            db.prepare("SELECT * FROM affiliates WHERE email = ? AND program_id IN (SELECT id FROM affiliate_programs WHERE user_id IN (SELECT id FROM users WHERE referral_code = ?))").get(email, biz);
    }
    if (!aff) {
      aff = db.prepare("SELECT * FROM affiliates WHERE email = ?").get(email);
    }

    // Always show success to prevent email enumeration
    const successMsg = "Login+link+sent!+Check+your+email+%E2%80%94+it+expires+in+1+hour.";
    if (!aff) return res.redirect("/api/affiliates/portal/login?msg=" + successMsg);

    // Generate token
    const token = affCrypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO biz_affiliate_magic_links (id, affiliate_id, token, expires_at) VALUES (?,?,?,?)")
      .run(require("uuid").v4(), aff.id, token, expiresAt);

    const { getSetting } = require("./integrations");
    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
    const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
    const loginUrl = backendUrl + "/api/affiliates/portal/verify?token=" + token;

    // Get business name
    const prog = db.prepare("SELECT p.*, u.name as owner_name FROM affiliate_programs p JOIN users u ON u.id = p.user_id WHERE p.id = ?").get(aff.program_id);
    const bizName = prog?.owner_name || "Your partner";

    if (sgKey) {
      const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email, name: aff.name || "there" }] }],
          from: { email: fromEmail, name: bizName },
          subject: "Your affiliate portal login link 🔗",
          content: [{ type: "text/html", value: `
            <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px">
              <div style="background:#4F46E5;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
                <div style="font-size:32px;margin-bottom:8px">💸</div>
                <div style="font-size:20px;font-weight:800;color:#fff">Your login link</div>
                <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">${bizName} Affiliate Portal</div>
              </div>
              <p style="font-size:14px;color:#555;line-height:1.7;margin-bottom:20px">Hey ${aff.name || "there"}, click the button below to access your affiliate dashboard — no password needed.</p>
              <div style="text-align:center;margin:24px 0">
                <a href="${loginUrl}" style="display:inline-block;background:#4F46E5;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px">Access My Dashboard →</a>
              </div>
              <div style="background:#f9fafb;border-radius:8px;padding:12px 16px;font-size:12px;color:#888;line-height:1.6">
                This link expires in 1 hour and can only be used once. If you didn't request this, ignore this email.
              </div>
            </div>
          `}]
        })
      })
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    }

    res.redirect("/api/affiliates/portal/login?msg=" + successMsg);
  } catch(e) {
    console.error("[BizAff portal] send-link:", e.message);
    res.redirect("/api/affiliates/portal/login?err=Something+went+wrong.+Please+try+again.");
  }
});

// ── 3. VERIFY MAGIC LINK → SET SESSION COOKIE ────────────────────────────────
// GET /api/affiliates/portal/verify?token=XYZ
router.get("/affiliates/portal/verify", (req, res) => {
  try {
    const db = getDb();
    ensureAffPortalTables(db);
    const { token } = req.query;
    if (!token) return res.redirect("/api/affiliates/portal/login?err=Invalid+link");

    const link = db.prepare("SELECT * FROM biz_affiliate_magic_links WHERE token = ? AND used = 0 AND expires_at > datetime('now')").get(token);
    if (!link) return res.redirect("/api/affiliates/portal/login?err=This+link+has+expired+or+already+been+used.+Request+a+new+one.");

    // Mark link as used
    db.prepare("UPDATE biz_affiliate_magic_links SET used = 1 WHERE id = ?").run(link.id);

    // Create 30-day session
    const sessionToken = affCrypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO biz_affiliate_sessions (id, affiliate_id, token, expires_at) VALUES (?,?,?,?)").run(require("uuid").v4(), link.affiliate_id, sessionToken, expiresAt);

    // Set cookie and redirect to dashboard
    res.setHeader("Set-Cookie", "aff_session=" + sessionToken + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
    res.redirect("/api/affiliates/portal/dashboard");
  } catch(e) {
    console.error("[BizAff portal] verify:", e.message);
    res.redirect("/api/affiliates/portal/login?err=Something+went+wrong");
  }
});

// ── 4. DASHBOARD (requires session) ──────────────────────────────────────────
// GET /api/affiliates/portal/dashboard
router.get("/affiliates/portal/dashboard", affPortalAuth, (req, res) => {
  try {
    const db = getDb();
    const aff = db.prepare("SELECT * FROM affiliates WHERE id = ?").get(req.bizAffiliateId);
    if (!aff) return res.redirect("/api/affiliates/portal/login?err=Account+not+found");

    const conversions = db.prepare("SELECT * FROM affiliate_conversions WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 30").all(aff.id);
    const program = db.prepare("SELECT p.*, u.name as owner_name FROM affiliate_programs p JOIN users u ON u.id = p.user_id WHERE p.id = ?").get(aff.program_id);
    const payoutReqs = db.prepare("SELECT * FROM affiliate_payout_requests WHERE affiliate_id = ? ORDER BY requested_at DESC LIMIT 5").all(aff.id).catch?.() || [];

    const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const pending = (aff.commission_earned || 0) - (aff.commission_paid || 0);
    const minPayout = program?.min_payout || 50;
    const bizName = esc(program?.owner_name || "Business");
    const rate = program?.commission_percent || 10;
    const progress = Math.min(100, Math.round((pending / minPayout) * 100));

    const convRows = conversions.map(c =>
      `<tr><td>${new Date(c.created_at).toLocaleDateString()}</td><td>$${(c.amount||0).toFixed(2)}</td><td style="color:#16a34a;font-weight:700">$${(c.commission||0).toFixed(2)}</td><td><span style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${c.status==="pending"?"#fef9c3":"#dcfce7"};color:${c.status==="pending"?"#a16207":"#16a34a"}">${c.status||"pending"}</span></td></tr>`
    ).join("") || '<tr><td colspan="4" style="text-align:center;color:#888;padding:20px">No conversions yet — share your link!</td></tr>';

    res.send(`<!DOCTYPE html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${bizName} — Affiliate Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#222;}
    .header{background:linear-gradient(135deg,#4F46E5,#6366F1);color:#fff;padding:24px 20px;}
    .header h1{font-size:18px;font-weight:800;}
    .header p{opacity:.8;font-size:12px;margin-top:2px;}
    .container{max-width:760px;margin:0 auto;padding:20px 16px;}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px;}
    .stat{background:#fff;border-radius:12px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.05);}
    .stat .v{font-size:22px;font-weight:800;}
    .stat .l{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-top:3px;}
    .card{background:#fff;border-radius:12px;padding:20px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.05);}
    .card h3{font-size:14px;font-weight:700;margin-bottom:12px;}
    .link-box{background:#f3f4f6;border-radius:8px;padding:10px 14px;font-size:12px;color:#4F46E5;word-break:break-all;cursor:pointer;margin-bottom:8px;}
    .link-box:hover{background:#e8e7ff;}
    table{width:100%;border-collapse:collapse;font-size:13px;}
    th{text-align:left;padding:8px;border-bottom:2px solid #eee;color:#888;font-size:11px;text-transform:uppercase;}
    td{padding:9px 8px;border-bottom:1px solid #f3f4f6;}
    .btn{padding:12px 20px;border:none;border-radius:9px;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;width:100%;}
    .btn-primary{background:#4F46E5;color:#fff;}
    .btn-primary:hover{background:#4338ca;}
    .btn-primary:disabled{background:#a5b4fc;cursor:not-allowed;}
    .progress-bar{height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin:8px 0;}
    .progress-fill{height:100%;background:#4F46E5;border-radius:4px;width:${progress}%;}
    .payout-ready{background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:20px;margin-bottom:14px;}
    .logout{font-size:11px;color:rgba(255,255,255,.6);text-decoration:none;float:right;margin-top:3px;}
    .logout:hover{color:#fff;}
    .msg{padding:12px 16px;border-radius:9px;font-size:13px;margin-bottom:14px;display:none;}
    .msg.ok{background:#dcfce7;color:#166534;border:1px solid #86efac;}
    .msg.err{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;}
  </style>
</head><body>
<div class="header">
  <a href="/api/affiliates/portal/logout" class="logout">Log out</a>
  <h1>💸 ${bizName} Affiliate Portal</h1>
  <p>Welcome back, ${esc(aff.name || aff.email)} · Code: ${esc(aff.code)} · ${rate}% commission</p>
</div>
<div class="container">
  <div class="stats">
    <div class="stat"><div class="v">${aff.clicks||0}</div><div class="l">Clicks</div></div>
    <div class="stat"><div class="v">${aff.conversions||0}</div><div class="l">Sales</div></div>
    <div class="stat"><div class="v" style="color:#16a34a">$${(aff.commission_earned||0).toFixed(2)}</div><div class="l">Earned</div></div>
    <div class="stat"><div class="v" style="color:#eab308">$${pending.toFixed(2)}</div><div class="l">Pending</div></div>
    <div class="stat"><div class="v">${rate}%</div><div class="l">Rate</div></div>
  </div>

  <div id="msg" class="msg"></div>

  ${pending >= minPayout ? `
  <div class="payout-ready">
    <div style="font-weight:800;font-size:20px;color:#16a34a;margin-bottom:4px">$${pending.toFixed(2)} ready to withdraw</div>
    <div style="font-size:12px;color:#666;margin-bottom:14px">You've hit the minimum — request your payout below.</div>
    <div style="margin-bottom:10px"><label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Note (optional — bank details, PayPal etc)</label>
    <input id="payout-note" type="text" placeholder="e.g. Please pay to PayPal: me@email.com" style="width:100%;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:13px;font-family:inherit;margin-bottom:10px"></div>
    <button class="btn btn-primary" id="payout-btn" onclick="requestPayout()">Request Payout 💸</button>
  </div>` : `
  <div class="card" style="text-align:center">
    <div style="font-size:28px;margin-bottom:8px">💰</div>
    <div style="font-weight:700;font-size:15px;margin-bottom:4px">$${pending.toFixed(2)} pending</div>
    <div style="color:#888;font-size:12px;margin-bottom:10px">Need $${(minPayout - pending).toFixed(2)} more to reach the $${minPayout} minimum payout</div>
    <div class="progress-bar"><div class="progress-fill"></div></div>
    <div style="font-size:11px;color:#aaa;margin-top:4px">${progress}% of minimum</div>
  </div>`}

  <div class="card">
    <h3>Your Referral Link</h3>
    <div class="link-box" onclick="navigator.clipboard.writeText(this.textContent);this.textContent='✅ Copied!';setTimeout(()=>this.textContent='${esc(aff.link||"")}',1500)">${esc(aff.link||"")}</div>
    <div style="font-size:11px;color:#888">${program?.cookie_days||30}-day tracking window · Click to copy</div>
  </div>

  <div class="card">
    <h3>Conversion History</h3>
    <table><thead><tr><th>Date</th><th>Sale</th><th>Commission</th><th>Status</th></tr></thead>
    <tbody>${convRows}</tbody></table>
  </div>
</div>
<script>
function requestPayout() {
  var btn = document.getElementById('payout-btn');
  var note = (document.getElementById('payout-note')||{}).value || '';
  btn.textContent = '⏳ Submitting...'; btn.disabled = true;
  fetch('/api/affiliates/portal/request-payout', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({note: note})
  }).then(r => r.json()).then(d => {
    var msg = document.getElementById('msg');
    if (d.success) {
      msg.className = 'msg ok'; msg.textContent = d.message; msg.style.display = 'block';
      btn.textContent = '✅ Request sent'; 
    } else {
      msg.className = 'msg err'; msg.textContent = d.error || 'Could not submit request'; msg.style.display = 'block';
      btn.textContent = 'Request Payout 💸'; btn.disabled = false;
    }
    window.scrollTo({top:0,behavior:'smooth'});
  }).catch(() => {
    btn.textContent = 'Request Payout 💸'; btn.disabled = false;
  });
}
</script>
</body></html>`);
  } catch(e) {
    console.error("[BizAff portal] dashboard:", e.message);
    res.status(500).send("<h1>Error loading dashboard</h1>");
  }
});

// ── 5. REQUEST PAYOUT (from dashboard, session-gated) ────────────────────────
// POST /api/affiliates/portal/request-payout
router.post("/affiliates/portal/request-payout", affPortalAuth, async (req, res) => {
  try {
    const db = getDb();
    ensureAffPortalTables(db);
    const aff = db.prepare("SELECT * FROM affiliates WHERE id = ?").get(req.bizAffiliateId);
    if (!aff) return res.status(404).json({ error: "Affiliate not found" });

    const program = db.prepare("SELECT p.*, u.name as owner_name, u.email as owner_email FROM affiliate_programs p JOIN users u ON u.id = p.user_id WHERE p.id = ?").get(aff.program_id);
    const pending = (aff.commission_earned || 0) - (aff.commission_paid || 0);
    const minPayout = program?.min_payout || 50;

    if (pending < minPayout) return res.status(400).json({ error: "Minimum payout is $" + minPayout + ". You have $" + pending.toFixed(2) + " pending." });

    // Prevent duplicate requests within 24h
    try {
      const recent = db.prepare("SELECT id FROM affiliate_payout_requests WHERE affiliate_id = ? AND status = 'pending' AND requested_at > datetime('now', '-1 day')").get(aff.id);
      if (recent) return res.status(429).json({ error: "You already have a pending payout request. The business owner has been notified." });
      db.prepare("INSERT INTO affiliate_payout_requests (id, affiliate_id, amount, note) VALUES (?,?,?,?)").run(require("uuid").v4(), aff.id, pending, req.body.note || "");
    } catch(dbErr) { console.error("[/portal/request-payout]", dbErr.message || dbErr); }

    // Email the business owner
    try {
      const { getSetting } = require("./integrations");
      const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
      const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
      const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

      if (sgKey && program?.owner_email) {
        const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: program.owner_email, name: program.owner_name || "there" }] }],
            from: { email: fromEmail, name: "MINE" },
            subject: "💰 Payout request from " + (aff.name || "your affiliate") + " — $" + pending.toFixed(2),
            content: [{ type: "text/html", value: `
              <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px">
                <h2 style="margin-bottom:8px">Affiliate payout request 💰</h2>
                <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:20px">
                  <strong>${aff.name || aff.email || "An affiliate"}</strong> has requested a payout of
                  <strong style="color:#16A34A">$${pending.toFixed(2)}</strong>.
                </p>
                <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:16px;margin-bottom:20px;font-size:13px;line-height:1.8">
                  <div><strong>Name:</strong> ${aff.name || "—"}</div>
                  <div><strong>Email:</strong> ${aff.email || "—"}</div>
                  <div><strong>Code:</strong> ${aff.code}</div>
                  <div><strong>Amount:</strong> $${pending.toFixed(2)}</div>
                  ${req.body.note ? "<div><strong>Note:</strong> " + req.body.note + "</div>" : ""}
                </div>
                <a href="${frontendUrl}" style="display:inline-block;background:#4F46E5;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:14px">Go to Dashboard → Referrals & Affiliates</a>
              </div>
            `}]
          })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
    } catch(emailErr) {}

    res.json({ success: true, message: "✅ Payout request sent! " + (program?.owner_name || "The business owner") + " has been notified and will process your payment shortly." });
  } catch(e) {
    console.error("[BizAff portal] request-payout:", e.message);
    res.status(500).json({ error: "Could not submit request" });
  }
});

// ── 6. LOGOUT ─────────────────────────────────────────────────────────────────
router.get("/affiliates/portal/logout", (req, res) => {
  const db = getDb();
  const token = req.cookies?.aff_session || req.query.session;
  if (token) {
    try { db.prepare("DELETE FROM biz_affiliate_sessions WHERE token = ?").run(token); } catch(e) { console.error("[/portal/logout]", e.message || e); }
  }
  res.setHeader("Set-Cookie", "aff_session=; Path=/; HttpOnly; Max-Age=0");
  res.redirect("/api/affiliates/portal/login?msg=You+have+been+logged+out.");
});

// ── 7. KEEP OLD CODE-BASED URL for backwards compat — redirect to login ───────
router.get("/affiliates/my/:code", (req, res) => {
  res.redirect("/api/affiliates/portal/login?biz=" + encodeURIComponent(req.params.code));
});



// DEAD CODE — duplicate of first handler at line 3458; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/affiliates/my/:code", (req, res) => {
  const db = getDb();
  try {
    const aff = db.prepare("SELECT * FROM affiliates WHERE code = ?").get(req.params.code);
    if (!aff) return res.status(404).send("<h1>Affiliate not found</h1>");
    const conversions = db.prepare("SELECT * FROM affiliate_conversions WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 30").all(aff.id);
    const program = db.prepare("SELECT commission_percent, cookie_days, min_payout, tiers FROM affiliate_programs WHERE id = ?").get(aff.program_id);
    const site = db.prepare("SELECT s.name FROM sites s JOIN affiliate_programs p ON p.user_id = s.user_id WHERE p.id = ? LIMIT 1").get(aff.program_id);
    const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const businessName = esc(site?.name || "Business");
    const pending = aff.commission_earned - aff.commission_paid;
    const minPayout = program?.min_payout || 50;

    // If JSON requested, return JSON
    if (req.headers.accept?.includes("application/json")) {
      return res.json({
        affiliate: aff, conversions,
        program: { ...program, tiers: JSON.parse(program?.tiers || "[]") },
        pendingPayout: pending, canCashOut: pending >= minPayout
      });
    }

    const convRows = conversions.map(c =>
      `<tr><td>${new Date(c.created_at).toLocaleDateString()}</td><td>$${(c.amount||0).toFixed(2)}</td><td style="color:#16a34a;font-weight:700">$${(c.commission||0).toFixed(2)}</td><td><span class="badge ${c.status==='pending'?'badge-yl':'badge-gn'}">${c.status==='pending'?'pending':'paid'}</span></td></tr>`
    ).join('') || '<tr><td colspan="4" style="text-align:center;color:#888;padding:20px;">No conversions yet — share your link!</td></tr>';

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${businessName} — Affiliate Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#222;}
.header{background:#2563EB;color:#fff;padding:24px 32px;}
.header h1{font-size:18px;font-weight:700;} .header p{opacity:.8;font-size:13px;}
.container{max-width:800px;margin:0 auto;padding:24px 16px;}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px;}
.stat{background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04);}
.stat .v{font-size:22px;font-weight:700;} .stat .l{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:2px;}
.card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.04);padding:20px;margin-bottom:16px;}
.link-box{background:#f3f4f6;border-radius:8px;padding:10px 14px;font-size:13px;color:#2563EB;word-break:break-all;margin-bottom:8px;cursor:pointer;}
.link-box:hover{background:#eef;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th{text-align:left;padding:8px;border-bottom:2px solid #eee;color:#888;font-size:11px;text-transform:uppercase;}
td{padding:8px;border-bottom:1px solid #f3f4f6;}
.badge{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;}
.badge-gn{background:#dcfce7;color:#16a34a;} .badge-yl{background:#fef9c3;color:#a16207;}
.btn{padding:12px 24px;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px;}
.btn-primary{background:#2563EB;color:#fff;} .btn-primary:hover{background:#524ae0;}
.payout-box{display:flex;align-items:center;justify-content:space-between;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;margin-bottom:16px;}
</style></head><body>
<div class="header">
  <h1>${businessName} Affiliate Program</h1>
  <p>Welcome back, ${esc(aff.name)}! Your code: <strong>${esc(aff.code)}</strong></p>
</div>
<div class="container">
  <div class="stats">
    <div class="stat"><div class="v">${aff.clicks}</div><div class="l">Clicks</div></div>
    <div class="stat"><div class="v">${aff.sales}</div><div class="l">Sales</div></div>
    <div class="stat"><div class="v" style="color:#16a34a">$${aff.commission_earned.toFixed(2)}</div><div class="l">Earned</div></div>
    <div class="stat"><div class="v" style="color:#eab308">$${pending.toFixed(2)}</div><div class="l">Pending</div></div>
    <div class="stat"><div class="v">${program?.commission_percent||10}%</div><div class="l">Rate</div></div>
  </div>

  ${pending >= minPayout ? `
<div class="payout-box">
  <div>
    <div style="font-weight:700;font-size:20px;color:#16a34a">$${pending.toFixed(2)} ready to withdraw</div>
    <div style="font-size:12px;color:#666;margin-top:2px">Commission earned and ready for payout</div>
  </div>
  <button class="btn btn-primary" onclick="requestPayout()" id="payout-btn">Request Payout 💸</button>
</div>
<div id="payout-msg" style="display:none;background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:12px;font-size:13px;color:#166534;margin-bottom:16px;"></div>
<script>
function requestPayout() {
  var note = prompt('Add a note (optional):', '');
  if (note === null) return;
  var btn = document.getElementById('payout-btn');
  btn.textContent = 'Sending...'; btn.disabled = true;
  fetch(location.pathname + '/request-payout', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({note: note})
  }).then(function(r){return r.json();}).then(function(d){
    if (d.success) {
      var msg = document.getElementById('payout-msg');
      msg.textContent = d.message;
      msg.style.display = 'block';
      btn.textContent = '✅ Request sent';
    } else {
      alert(d.error || 'Could not submit request');
      btn.textContent = 'Request Payout 💸'; btn.disabled = false;
    }
  }).catch(function(){
    alert('Something went wrong — please try again');
    btn.textContent = 'Request Payout 💸'; btn.disabled = false;
  });
}
</script>
` : `
<div class="card" style="text-align:center;padding:20px;">
  <div style="font-size:32px;margin-bottom:8px">💰</div>
  <div style="font-weight:700;font-size:15px;margin-bottom:4px">$${pending.toFixed(2)} pending</div>
  <div style="color:#888;font-size:13px;">Minimum payout is $${minPayout}. You need $${(minPayout - pending).toFixed(2)} more to request a withdrawal.</div>
  <div style="margin-top:12px;background:#f3f4f6;border-radius:8px;padding:10px;">
    <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;">
      <div style="height:100%;width:${Math.min(100,Math.round((pending/minPayout)*100))}%;background:#2563EB;border-radius:4px;"></div>
    </div>
    <div style="font-size:11px;color:#888;margin-top:4px;">${Math.round((pending/minPayout)*100)}% of minimum reached</div>
  </div>
</div>
`}

  <div class="card">
    <h3 style="font-size:15px;margin-bottom:10px;">Your Referral Link</h3>
    <div class="link-box" onclick="navigator.clipboard.writeText(this.textContent);this.style.background='#dcfce7';setTimeout(()=>this.style.background='#f3f4f6',1000);">${aff.link}</div>
    <div style="font-size:11px;color:#888;">${program?.cookie_days||30}-day cookie window. Click to copy.</div>
  </div>

  <div class="card">
    <h3 style="font-size:15px;margin-bottom:10px;">Conversion History</h3>
    <table><thead><tr><th>Date</th><th>Sale</th><th>Commission</th><th>Status</th></tr></thead><tbody>${convRows}</tbody></table>
  </div>
</div></body></html>`);
  } catch(e) { console.error("[Features] Error:", e.message); res.status(500).send("<h1>Error</h1><p>Something went wrong. Please try again.</p>"); }
});

// Payout to affiliate (site owner pays their affiliate)
router.post("/affiliates/:affId/payout", auth, async (req, res) => {
  try {
    const db = getDb();
    const aff = db.prepare("SELECT a.*, p.user_id as program_owner, p.min_payout FROM affiliates a JOIN affiliate_programs p ON a.program_id = p.id WHERE a.id = ?").get(req.params.affId);
    if (!aff) return res.status(404).json({ error: "Affiliate not found" });
    if (aff.program_owner !== req.userId) return res.status(403).json({ error: "Not your affiliate" });

    const pending = aff.commission_earned - aff.commission_paid;
    if (pending < 1) return res.status(400).json({ error: "Nothing to pay out" });

    // Fetch the TAKEOVA user's own Stripe Connect account — this is where their business revenue lives
    const user = db.prepare("SELECT stripe_connect_id FROM users WHERE id = ?").get(req.userId);
    const affStripeAccount = aff.stripe_account_id; // affiliate's own Stripe account

    if (!user?.stripe_connect_id) {
      return res.status(400).json({
        error: "Connect your Stripe account first",
        detail: "Go to Settings → Accept Payments to connect Stripe. Affiliate payouts come from your Stripe balance.",
        upgrade: false
      });
    }

    if (!affStripeAccount) {
      // No Stripe account for affiliate — mark as manual, user pays outside MINE
      db.prepare("UPDATE affiliates SET commission_paid = commission_paid + ? WHERE id = ?").run(pending, aff.id);
      return res.json({
        success: true, amount: pending, method: "manual",
        message: `Marked $${pending.toFixed(2)} as paid to ${aff.name}. This affiliate has no Stripe account registered — send payment via bank transfer, PayPal or your preferred method.`
      });
    }

    // ── Option A: Transfer from USER's Stripe Connect account to affiliate ────
    // The user's stripe_connect_id is their connected account.
    // We use the platform Stripe key but specify the user's account as the SOURCE
    // via `transfer_group` and `source_transaction`, or via a direct transfer
    // from their connected account using their own secret key.
    // Best practice: use Stripe's `on_behalf_of` + transfer from connected account.
    try {
      const stripeKey = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("STRIPE_SECRET_KEY")?.value || process.env.STRIPE_SECRET_KEY;
      const stripe = require("stripe")(stripeKey);

      // Create a payout FROM the user's connected account TO the affiliate's connected account
      // This is a transfer between two connected accounts — money moves from user's Stripe balance
      const transfer = await stripe.transfers.create(
        {
          amount: Math.round(pending * 100),
          currency: "usd",
          destination: affStripeAccount,
          description: `Affiliate commission payout — ${aff.name} (${aff.code})`,
          metadata: {
            payer_user_id: req.userId,
            affiliate_id: aff.id,
            affiliate_code: aff.code || ""
          }
        },
        {
          // stripeAccount tells Stripe to execute this transfer ON BEHALF OF
          // the user's connected account — money comes from their balance, not TAKEOVA's
          stripeAccount: user.stripe_connect_id
        }
      );

      db.prepare("UPDATE affiliates SET commission_paid = commission_paid + ? WHERE id = ?").run(pending, aff.id);

      // Log the payout
      try {
        db.exec("CREATE TABLE IF NOT EXISTS affiliate_payouts (id TEXT PRIMARY KEY, affiliate_id TEXT, amount REAL, stripe_transfer_id TEXT, method TEXT, created_at TEXT DEFAULT (datetime('now')))");
        db.prepare("INSERT INTO affiliate_payouts (id, affiliate_id, amount, stripe_transfer_id, method) VALUES (?,?,?,?,?)")
          .run(require("uuid").v4(), aff.id, pending, transfer.id, "stripe_connect");
      } catch(logErr) { /* non-fatal */ }

      return res.json({ success: true, amount: pending, method: "stripe_connect", transferId: transfer.id });
    } catch(stripeErr) {
      console.error("[Affiliates] Stripe payout failed:", stripeErr?.message);
      // Fall back to manual if Stripe fails
      return res.status(400).json({
        error: stripeErr?.message || "Stripe payout failed",
        detail: "Check your Stripe Connect balance has sufficient funds, or mark as paid manually.",
        fallback: "manual"
      });
    }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── Affiliate Stripe Express onboarding ───────────────────────────────────────
// POST /api/affiliates/:affId/stripe-onboard
// Generates a Stripe Connect Express onboarding link for an affiliate.
// Affiliate fills in their bank details in ~2 mins — no full Stripe account needed.
// Once complete, Stripe calls our return_url and we store their account ID.
router.post("/affiliates/:affId/stripe-onboard", auth, async (req, res) => {
  try {
    const db = getDb();
    const aff = db.prepare("SELECT a.*, p.user_id as program_owner FROM affiliates a JOIN affiliate_programs p ON a.program_id = p.id WHERE a.id = ?").get(req.params.affId);
    if (!aff) return res.status(404).json({ error: "Affiliate not found" });
    if (aff.program_owner !== req.userId) return res.status(403).json({ error: "Not your affiliate" });

    const stripeKey = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("STRIPE_SECRET_KEY")?.value || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(400).json({ error: "Stripe not configured" });

    const stripe = require("stripe")(stripeKey);
    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
    const backendUrl  = process.env.BACKEND_URL  || "https://api.takeova.ai";

    // Create a Stripe Express account for the affiliate
    // Express = lightweight, affiliate only needs bank details, no full Stripe dashboard
    let accountId = aff.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: aff.email || undefined,
        capabilities: { transfers: { requested: true } },
        business_type: "individual",
        metadata: { affiliate_id: aff.id, affiliate_code: aff.code || "" }
      });
      accountId = account.id;
      // Ensure column exists
      try { db.exec("ALTER TABLE affiliates ADD COLUMN stripe_account_id TEXT"); } catch(e) {}
      db.prepare("UPDATE affiliates SET stripe_account_id = ? WHERE id = ?").run(accountId, aff.id);
    }

    // Create the onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${backendUrl}/api/affiliates/${aff.id}/stripe-onboard-refresh`,
      return_url:  `${frontendUrl}?affiliate_onboarded=${aff.id}`,
      type: "account_onboarding"
    });

    res.json({ success: true, url: accountLink.url, accountId });
  } catch(e) {
    console.error("[Affiliates] Express onboard:", e.message);
    res.status(500).json({ error: e.message || "Could not create onboarding link" });
  }
});

// GET /api/affiliates/:affId/stripe-onboard-refresh
// Called by Stripe if onboarding link expires — regenerates it and redirects
router.get("/affiliates/:affId/stripe-onboard-refresh", async (req, res) => {
  try {
    const db = getDb();
    const aff = db.prepare("SELECT * FROM affiliates WHERE id = ?").get(req.params.affId);
    if (!aff || !aff.stripe_account_id) return res.redirect(process.env.FRONTEND_URL || "https://takeova.ai");
    const stripeKey = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("STRIPE_SECRET_KEY")?.value || process.env.STRIPE_SECRET_KEY;
    const stripe = require("stripe")(stripeKey);
    const backendUrl  = process.env.BACKEND_URL  || "https://api.takeova.ai";
    const frontendUrl = process.env.FRONTEND_URL  || "https://takeova.ai";
    const link = await stripe.accountLinks.create({
      account: aff.stripe_account_id,
      refresh_url: `${backendUrl}/api/affiliates/${aff.id}/stripe-onboard-refresh`,
      return_url:  `${frontendUrl}?affiliate_onboarded=${aff.id}`,
      type: "account_onboarding"
    });
    res.redirect(link.url);
  } catch(e) {
    res.redirect(process.env.FRONTEND_URL || "https://takeova.ai");
  }
});

// POST /api/affiliates/:affId/stripe-onboard-email
// Sends the affiliate an email with their Express onboarding link
router.post("/affiliates/:affId/stripe-onboard-email", auth, async (req, res) => {
  try {
    const db = getDb();
    const aff = db.prepare("SELECT a.*, p.user_id as program_owner FROM affiliates a JOIN affiliate_programs p ON a.program_id = p.id WHERE a.id = ?").get(req.params.affId);
    if (!aff) return res.status(404).json({ error: "Affiliate not found" });
    if (aff.program_owner !== req.userId) return res.status(403).json({ error: "Not your affiliate" });
    if (!aff.email) return res.status(400).json({ error: "Affiliate has no email address" });

    // Generate the onboarding link
    const stripeKey = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("STRIPE_SECRET_KEY")?.value || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(400).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);
    const backendUrl  = process.env.BACKEND_URL  || "https://api.takeova.ai";
    const frontendUrl = process.env.FRONTEND_URL  || "https://takeova.ai";

    let accountId = aff.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: aff.email,
        capabilities: { transfers: { requested: true } },
        metadata: { affiliate_id: aff.id }
      });
      accountId = account.id;
      try { db.exec("ALTER TABLE affiliates ADD COLUMN stripe_account_id TEXT"); } catch(e) {}
      db.prepare("UPDATE affiliates SET stripe_account_id = ? WHERE id = ?").run(accountId, aff.id);
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${backendUrl}/api/affiliates/${aff.id}/stripe-onboard-refresh`,
      return_url:  `${frontendUrl}?affiliate_onboarded=${aff.id}`,
      type: "account_onboarding"
    });

    // Get the program owner's name for the email
    const owner = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
    const ownerName = owner?.name || "Your partner";

    const { getSetting } = require("./integrations");
    const sgKey     = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";

    if (sgKey) {
      const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: aff.email, name: aff.name || "there" }] }],
          from: { email: fromEmail, name: ownerName },
          subject: `Set up your payout account — you have commissions waiting 💰`,
          content: [{ type: "text/html", value: `
            <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px">
              <div style="background:linear-gradient(135deg,#0A0F1E,#1e3a5f);border-radius:14px;padding:28px;text-align:center;margin-bottom:24px">
                <div style="font-size:28px;font-weight:900;color:#4F46E5;margin-bottom:4px">MINE<span style="color:#fff">.</span></div>
                <div style="font-size:22px;font-weight:800;color:#fff;margin-top:12px">You have commissions waiting 💰</div>
                <div style="color:rgba(255,255,255,.7);font-size:13px;margin-top:6px">Set up your payout account in 2 minutes</div>
              </div>

              <p style="font-size:15px;color:#333;line-height:1.7">Hey ${aff.name || "there"},</p>
              <p style="font-size:14px;color:#555;line-height:1.7"><strong>${ownerName}</strong> is using MINE to manage their affiliate program — and you've been earning commission. To receive your payouts, just connect your bank account below.</p>

              <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:12px;padding:20px;margin:20px 0">
                <div style="font-weight:700;font-size:14px;color:#166534;margin-bottom:8px">✅ Takes about 2 minutes</div>
                <div style="font-size:13px;color:#555;line-height:1.7">
                  You'll be guided through a secure Stripe Express setup:<br>
                  • Your name and date of birth<br>
                  • Your bank account details (BSB + account number)<br>
                  • That's it — no full Stripe account needed
                </div>
              </div>

              <div style="text-align:center;margin:24px 0">
                <a href="${link.url}" style="display:inline-block;background:linear-gradient(135deg,#4F46E5,#6366F1);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px">Set Up My Payout Account →</a>
              </div>

              <div style="font-size:11px;color:#9CA3AF;text-align:center;line-height:1.6">
                This link expires in 24 hours. Powered by Stripe — your bank details are never shared with ${ownerName} or MINE.<br>
                <a href="${link.url}" style="color:#9CA3AF">${link.url.slice(0,60)}...</a>
              </div>
            </div>
          `}]
        })
      });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    }

    res.json({ success: true, emailSent: !!sgKey, url: link.url });
  } catch(e) {
    console.error("[Affiliates] Onboard email:", e.message);
    res.status(500).json({ error: e.message || "Failed to send onboarding email" });
  }
});




// ═══════════════════════════════════════
// USAGE TRACKING & CAP ENFORCEMENT
// ═══════════════════════════════════════
// Tracks every billable action per user per month. Enforces plan caps. Charges overages.

const PLAN_CAPS = {
  // v50 — rebalanced for 84-85% margin @ 30% utilization
  // Ladder is strictly monotonic: every metric increases tier-by-tier
  // Prices: Starter $79, Growth $129, Pro $199, Enterprise $399, Agency $799
  starter:    {
    aiActions:30, sites:2, edits:30, images:15, chatbotChats:400,
    smsBroadcastSends:0, smsSequenceSends:0, smsReminderSends:0,
    aiVideos:0, emails:500, outreachEmails:100, outreachSMS:0, voiceMins:0,
    proposals:0, socialPosts:0, adCreatives:0,
    communityReplies:0, competitorReports:0, aiResearch:0,
    blogPosts:5, contracts:3, contractReviews:0, mentorChats:20,
    knowledgeBase:0, leadMagnets:0, customerChats:30,
    productDescs:5, reviewReplies:10, socialCaptions:10, invoiceChasers:0,
    upsellRecs:0, cartPersonalise:0, faqGeneration:0, refundHandling:0, competitorAnalysis:0,
    intelligenceRefresh:0, salesCopy:5,
    monthlyNarrative:0, ticketReply:0, refundDraft:0, subjectOptimize:3,
    courseContent:0, meetingPrep:0, leadScoring:0, churnRisk:0,
    storeBio:2, sequenceBuilder:0, smsBroadcast:0, smsSequences:0, smsKeywords:0,
    designs:5, designEdits:3,
    lookalikeGenerations:0, siteTranslations:0,
    parcelDimensions:0, seoAudits:0,
    // HF v1 caps starter
    soulImages:20, cinematicVideos: 1, brandModels:0
  },
  growth:     {
    aiActions:75, sites:3, edits:75, images:30, chatbotChats:800,
    smsBroadcastSends:100, smsSequenceSends:100, smsReminderSends:0,
    aiVideos:0, emails:1000, outreachEmails:500, outreachSMS:25, voiceMins:0,
    proposals:5, socialPosts:0, adCreatives:0,
    communityReplies:0, competitorReports:3, aiResearch:8,
    blogPosts:12, contracts:8, contractReviews:3, mentorChats:50,
    knowledgeBase:1, leadMagnets:0, customerChats:80,
    productDescs:15, reviewReplies:25, socialCaptions:25, invoiceChasers:5,
    upsellRecs:5, cartPersonalise:10, faqGeneration:2, refundHandling:5, competitorAnalysis:1,
    intelligenceRefresh:5, salesCopy:15,
    monthlyNarrative:1, ticketReply:10, refundDraft:5, subjectOptimize:15,
    courseContent:2, meetingPrep:10, leadScoring:3, churnRisk:3,
    storeBio:10, sequenceBuilder:3, smsBroadcast:5, smsSequences:3, smsKeywords:5,
    designs:25, designEdits:15,
    lookalikeGenerations:5, siteTranslations:3,
    parcelDimensions:20, seoAudits:2,
    // HF v1 caps growth
    soulImages:40, cinematicVideos: 3, brandModels:0,
    growthAgentAI: 20, growthAgentRuns: 10
  },
  pro:        {
    aiActions:200, sites:5, edits:150, images:80, chatbotChats:1500,
    smsBroadcastSends:500, smsSequenceSends:500, smsReminderSends:0,
    aiVideos:0, emails:3000, outreachEmails:1500, outreachSMS:100, voiceMins:50,
    proposals:15, socialPosts:60, adCreatives:25,
    communityReplies:300, competitorReports:6, aiResearch:18,
    blogPosts:25, contracts:20, contractReviews:10, mentorChats:150,
    knowledgeBase:3, leadMagnets:4, customerChats:300,
    productDescs:60, reviewReplies:40, socialCaptions:80, invoiceChasers:25,
    upsellRecs:25, cartPersonalise:60, faqGeneration:8, refundHandling:25, competitorAnalysis:2,
    intelligenceRefresh:20, salesCopy:30,
    monthlyNarrative:4, ticketReply:40, refundDraft:20, subjectOptimize:50,
    courseContent:6, meetingPrep:40, leadScoring:10, churnRisk:10,
    storeBio:30, sequenceBuilder:15, smsBroadcast:20, smsSequences:10, smsKeywords:20,
    designs:75, designEdits:45,
    lookalikeGenerations:25, siteTranslations:15,
    parcelDimensions:80, seoAudits:8,
    // HF v1 caps pro
    soulImages:100, cinematicVideos: 5, brandModels:1,
    growthAgentAI: 50, growthAgentRuns: 25
  },
  enterprise: {
    aiActions: 400, sites: 12, edits: 240, images: 130, chatbotChats: 2400,
    smsBroadcastSends: 1500, smsSequenceSends: 1200, smsReminderSends: 0,
    aiVideos: 0, emails: 8000, outreachEmails: 3200, outreachSMS: 200, voiceMins: 100,
    proposals: 30, socialPosts: 120, adCreatives: 40,
    communityReplies: 490, competitorReports: 10, aiResearch: 30,
    blogPosts: 35, contracts: 35, contractReviews: 20, mentorChats: 240,
    knowledgeBase: 5, leadMagnets: 7, customerChats: 650,
    productDescs: 120, reviewReplies: 75, socialCaptions: 160, invoiceChasers: 65,
    upsellRecs: 65, cartPersonalise: 120, faqGeneration: 15, refundHandling: 65, competitorAnalysis: 3,
    intelligenceRefresh: 40, salesCopy: 65,
    monthlyNarrative: 7, ticketReply: 100, refundDraft: 50, subjectOptimize: 120,
    courseContent: 12, meetingPrep: 100, leadScoring: 35, churnRisk: 35,
    storeBio: 50, sequenceBuilder: 25, growthAgentRuns: 50, growthAgentAI: 100,
    designs: 120, designEdits: 75,
    lookalikeGenerations: 80, siteTranslations: 40,
    parcelDimensions: 200, seoAudits: 16,
    // HF v1 caps enterprise
    soulImages: 240, cinematicVideos: 12, brandModels: 3,
    smsKeywords: 60, smsSequences: 30, smsBroadcast: 60
  },
  // NEW v50: Agency owner plan ($799/mo) — pooled across managed clients, full overage rates
  agency: {
    aiActions: 1000, sites: 30, edits: 380, images: 220, chatbotChats: 4300,
    smsBroadcastSends: 4000, smsSequenceSends: 2100, smsReminderSends: 0,
    aiVideos: 0, emails: 25000, outreachEmails: 6500, outreachSMS: 380, voiceMins: 250,
    proposals: 50, socialPosts: 280, adCreatives: 70,
    communityReplies: 820, competitorReports: 14, aiResearch: 40,
    blogPosts: 65, contracts: 65, contractReviews: 35, mentorChats: 380,
    knowledgeBase: 8, leadMagnets: 11, customerChats: 1000,
    productDescs: 220, reviewReplies: 130, socialCaptions: 270, invoiceChasers: 130,
    upsellRecs: 130, cartPersonalise: 220, faqGeneration: 25, refundHandling: 110, competitorAnalysis: 5,
    intelligenceRefresh: 65, salesCopy: 100,
    monthlyNarrative: 10, ticketReply: 190, refundDraft: 100, subjectOptimize: 220,
    courseContent: 19, meetingPrep: 190, leadScoring: 65, churnRisk: 65,
    storeBio: 80, sequenceBuilder: 40, growthAgentRuns: 80, growthAgentAI: 160,
    designs: 150, designEdits: 95,
    lookalikeGenerations: 110, siteTranslations: 55,
    parcelDimensions: 320, seoAudits: 35,
    // HF v1 caps agency
    soulImages: 820, cinematicVideos: 40, brandModels: 10,
    smsKeywords: 150, smsSequences: 75, smsBroadcast: 150
  },
  // Agency-managed client sites run on Enterprise caps
  agency_client: {
    aiActions: 400, sites: 12, edits: 240, images: 130, chatbotChats: 2400,
    smsBroadcastSends: 1500, smsSequenceSends: 1200, smsReminderSends: 0,
    aiVideos: 0, emails: 8000, outreachEmails: 3200, outreachSMS: 200, voiceMins: 100,
    proposals: 30, socialPosts: 120, adCreatives: 40,
    communityReplies: 490, competitorReports: 10, aiResearch: 30,
    blogPosts: 35, contracts: 35, contractReviews: 20, mentorChats: 240,
    knowledgeBase: 5, leadMagnets: 7, customerChats: 650,
    productDescs: 120, reviewReplies: 75, socialCaptions: 160, invoiceChasers: 65,
    upsellRecs: 65, cartPersonalise: 120, faqGeneration: 15, refundHandling: 65, competitorAnalysis: 3,
    intelligenceRefresh: 40, salesCopy: 65,
    monthlyNarrative: 7, ticketReply: 100, refundDraft: 50, subjectOptimize: 120,
    courseContent: 12, meetingPrep: 100, leadScoring: 35, churnRisk: 35,
    storeBio: 50, sequenceBuilder: 25, growthAgentRuns: 50, growthAgentAI: 100,
          designs: 120, designEdits: 75,
    parcelDimensions: 200, seoAudits: 16,
    // HF v1 caps agency_client
    soulImages: 240, cinematicVideos: 12, brandModels: 3
  }
};

// Minutes included with the AI Receptionist add-on — applies on any plan
const VOICE_ADDON_INCLUDED_MINS = 100;

const OVERAGE_PRICES = {
  // v49 CORE RATES — match the frontend Usage panel display
  aiActions: 0.20,        // AI tool use (was 0.08)
  sites: 3.00,            // AI Site Builder (NEW)
  edits: 0.50,            // AI Site Edit (was 8.00)
  images: 0.40,           // AI Image (was 0.75)
  chatbotChats: 0.02,
  // ── Preserved existing rates ──
  aiVideos: 25.00,
  lookalikeGenerations: 0.50, // lookalike audience gen (~$0.10 cost) — TUNABLE
  siteTranslations: 0.75,     // full-site translation (~$0.15 cost) — TUNABLE contractReviews: 2.00, ugcVideos: 49.00, emails: 0.005,
  outreachEmails: 0.008, outreachSMS: 0.10, /* AU SMS ≈ $0.05 — TUNABLE */ voiceMins: 0.15, // tiered rates in VOICE_OVERAGE_TIERS override
  proposals: 3.00, socialPosts: 0.50, adCreatives: 1.00,
  communityReplies: 0.10, competitorReports: 2.00, aiResearch: 0.50, blogPosts: 1.00,
  contracts: 3.00, mentorChats: 0.05, knowledgeBase: 3.00, leadMagnets: 3.00, customerChats: 0.03,
  crypto_platform_fee: 1.00,
  productDescs: 1.25, reviewReplies: 0.75, socialCaptions: 0.50, invoiceChasers: 1.00,
  upsellRecs: 1.00, cartPersonalise: 0.75, faqGeneration: 12.00, refundHandling: 0.75, competitorAnalysis: 25.00,
  salesCopy: 2.00, intelligenceRefresh: 1.00,
  storeBio: 1.50, sequenceBuilder: 3.00,
  whatsappMessages: 0.08,
  smsBroadcastSends: 0.10, smsSequenceSends: 0.10, /* AU SMS ≈ $0.05 each — TUNABLE */ smsReminderSends: 0.02,
  growthAgentRuns: 1.50, growthAgentAI: 0.30, /* Sonnet: run ≈ $0.10-0.20, analysis ≈ $0.04 — TUNABLE */
  monthlyNarrative: 2.00, ticketReply: 0.75, refundDraft: 1.50,
  subjectOptimize: 0.50, courseContent: 3.00, meetingPrep: 0.75,
  leadScoring: 1.00, churnRisk: 1.00,
  prospectorSearches: 0.10, prospectorDemos: 0.50, prospectorOutreach: 0.15,
  aiProposals: 0.40, coldEmails: 0.12,
  // ── Design Studio ──
  designs: 2.50,          // new AI design (pitch-deck, logo, social, ad-creative, one-pager)
  designEdits: 1.50,      // AI rewrite of an existing design (cheaper, smaller context usually)
  // ── Higgsfield premium AI (v1) ──
  parcelDimensions: 0.20,  // AI parcel sizing (small utility AI call)
  seoAudits: 4.00,         // AI SEO site audit (heavier — full-page analysis)
  soulImages: 0.12,       // Premium Soul/Higgsfield image — wholesale ~$0.04, ~67% margin
  cinematicVideos: 0,     // Billed INLINE per-second in /video/runway ($0.50/sec, over-cap only). 0 here so trackUsage never queues a second (per-video) overage charge — that was double-billing.
  brandModels: 4.00       // Soul ID training — wholesale ~$1.60, ~60% margin
};

// Expose plan caps & overage tables on the router for other routes (ai-agent.js
// etc). Assigned here — AFTER the const declarations above — to avoid load-time
// TDZ (these previously ran near the top of the file before the consts existed).
router.PLAN_CAPS = PLAN_CAPS;
router.OVERAGE_PRICES = OVERAGE_PRICES;

// Agency owners pay full overage rates like other plans (their volume
// benefit comes from the larger included caps + pooled allocation across clients).

function ensureUsageTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_tracking (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    amount REAL DEFAULT 1,
    period TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, metric, period)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS overage_charges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    quantity REAL,
    unit_price REAL,
    total REAL,
    period TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Columns added in later versions — ALTER silently on older schemas
  try { db.exec("ALTER TABLE overage_charges ADD COLUMN billed INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE overage_charges ADD COLUMN billed_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE overage_charges ADD COLUMN stripe_invoice_item_id TEXT"); } catch(e) {}
}

function getCurrentPeriod() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
}

// Get current usage for a metric this month
function getUsage(db, userId, metric) {
  ensureUsageTable(db);
  const period = getCurrentPeriod();
  const row = db.prepare("SELECT amount FROM usage_tracking WHERE user_id = ? AND metric = ? AND period = ?").get(userId, metric, period);
  return row ? row.amount : 0;
}

// Tiered overage rates for voiceMins (beyond the 100 included mins in the AI Receptionist addon)
// Rates increase with usage to protect against runaway API cost from heavy users.
// Our cost per minute: ~$0.07 (Twilio voice $0.0085 + STT $0.04 + Claude Sonnet ~$0.021)
// Minimum margin at floor tier: ~$0.08/min
const VOICE_OVERAGE_TIERS = [
  { upTo: 150,  rate: 0.15 , smsBroadcast:9999, smsSequences:9999, smsKeywords:9999},   // 101–150 mins  — $0.08 margin/min
  { upTo: 200,  rate: 0.20 },   // 151–200 mins  — $0.13 margin/min
  { upTo: 300,  rate: 0.25 },   // 201–300 mins  — $0.18 margin/min
  { upTo: Infinity, rate: 0.35 }, // 300+ mins   — $0.28 margin/min (heavy user protection)
];
// Same tiers for all plans — pricing is addon-based, not plan-based
const VOICE_OVERAGE_TIERS_ENTERPRISE = VOICE_OVERAGE_TIERS;

function getVoiceOverageRate(plan, totalMinsUsed, cap) {
  const overMins = Math.max(0, totalMinsUsed - cap);
  if (overMins <= 0) return 0;
  const tiers = plan === "enterprise" ? VOICE_OVERAGE_TIERS_ENTERPRISE : VOICE_OVERAGE_TIERS;

  // Stacked tier billing — each band only charges its rate for minutes within that band.
  // e.g. 200 overage mins = (50 × $0.15) + (50 × $0.20) + (100 × $0.25) = $40
  // NOT a flat $0.25 × 200 = $50. No cliff edges between tiers.
  let remaining = overMins;
  let totalCost = 0;
  let prevUpTo = cap; // start from cap (e.g. 100 included mins)

  for (const tier of tiers) {
    if (remaining <= 0) break;
    const bandSize = tier.upTo === Infinity ? remaining : Math.min(remaining, tier.upTo - prevUpTo);
    totalCost += bandSize * tier.rate;
    remaining -= bandSize;
    prevUpTo = tier.upTo;
  }

  // Return effective per-minute rate (for display/logging) — actual charge is totalCost
  return overMins > 0 ? totalCost / overMins : 0;
}

function getVoiceOverageCost(plan, totalMinsUsed, cap) {
  const overMins = Math.max(0, totalMinsUsed - cap);
  if (overMins <= 0) return 0;
  const tiers = plan === "enterprise" ? VOICE_OVERAGE_TIERS_ENTERPRISE : VOICE_OVERAGE_TIERS;

  let remaining = overMins;
  let totalCost = 0;
  let prevUpTo = cap;

  for (const tier of tiers) {
    if (remaining <= 0) break;
    const bandSize = tier.upTo === Infinity ? remaining : Math.min(remaining, tier.upTo - prevUpTo);
    totalCost += bandSize * tier.rate;
    remaining -= bandSize;
    prevUpTo = tier.upTo;
  }

  return Math.round(totalCost * 100) / 100; // round to cents
}

function ensureVoicePackTable(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS voice_packs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    mins_total INTEGER NOT NULL DEFAULT 100,
    mins_used INTEGER NOT NULL DEFAULT 0,
    purchased_at TEXT DEFAULT (datetime('now')),
    stripe_payment_id TEXT,
    expires_at TEXT
  )`).run();
}

// Increment usage and return { allowed, used, cap, overage, overageCost }
function trackUsage(db, userId, metric, increment = 1, opts = {}) {
  ensureUsageTable(db);
  const period = getCurrentPeriod();
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(userId);
  const plan = user?.plan || "starter";
  // Agency-managed client sites always get enterprise-level caps
  const effectivePlan = (db && userId) ? (() => { try { const u = db.prepare('SELECT is_agency_client FROM users WHERE id = ?').get(userId); return u?.is_agency_client ? 'agency_client' : plan; } catch(e) { return plan; } })() : plan;
  const caps = PLAN_CAPS[effectivePlan] || PLAN_CAPS[plan] || PLAN_CAPS.starter;
  let cap = caps[metric] !== undefined ? caps[metric] : 0;

  // voiceMins: cap comes from the AI Receptionist addon, not the plan (plan cap is always 0).
  // 100 mins/mo included with addon. Beyond that: tiered overage rates apply.
  if (metric === "voiceMins") {
    try {
      const hasAddon = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(userId);
      cap = hasAddon ? VOICE_ADDON_INCLUDED_MINS : 0;
    } catch(e) { cap = 0; }
  }

  // ── Voice pack: burn from pack balance before charging overage ──
  // Only applies to positive increments (new usage), not reconciliation adjustments
  if (metric === "voiceMins" && increment > 0) {
    try {
      ensureVoicePackTable(db);
      const pack = db.prepare(
        "SELECT id, mins_total, mins_used FROM voice_packs WHERE user_id = ? AND mins_used < mins_total ORDER BY purchased_at ASC LIMIT 1"
      ).get(userId);
      if (pack) {
        const packRemaining = pack.mins_total - pack.mins_used;
        const fromPack = Math.min(increment, packRemaining);
        db.prepare("UPDATE voice_packs SET mins_used = mins_used + ? WHERE id = ?").run(fromPack, pack.id);
        increment = increment - fromPack; // reduce what we charge to usage tracking
        if (increment <= 0) {
          // Entire increment was covered by pack — get current usage for accurate return value
          const cur = db.prepare("SELECT amount FROM usage_tracking WHERE user_id = ? AND metric = ? AND period = ?").get(userId, metric, period);
          const usedSoFar = cur ? cur.amount : 0;
          return { allowed: true, used: usedSoFar, cap, remaining: Math.max(0, cap - usedSoFar), isOverage: false, overageCost: 0, usedPackMins: fromPack, packRemaining: packRemaining - fromPack };
        }
      }
    } catch(e) { console.error("[/:affId/stripe-onboard-email]", e.message || e); }
  }

  // Overage rates: flat and identical on every plan (a v49 note once claimed an Agency 50% discount - never implemented).
  // in their dashboard but be billed at the full rate.
  let overagePrice = OVERAGE_PRICES[metric] || 0;

  // Atomic UPSERT — prevents race conditions on concurrent requests for same user/metric/period
  db.prepare(`
    INSERT INTO usage_tracking (id, user_id, metric, amount, period)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, metric, period) DO UPDATE SET amount = amount + excluded.amount
  `).run(uuid(), userId, metric, increment, period);

  // Re-read the true committed total after the atomic update
  const row = db.prepare("SELECT amount FROM usage_tracking WHERE user_id = ? AND metric = ? AND period = ?").get(userId, metric, period);
  const newTotal = row ? row.amount : increment;
  // Standard overage: charged when usage exceeds plan cap
  const isOverCap = newTotal > cap && cap > 0;
  const overageAmount = isOverCap ? Math.min(increment, newTotal - cap) : 0;

  // For voiceMins: use stacked tier cost — each band billed at its own rate
  let effectiveRate = overagePrice;
  let overageCost;
  if (metric === "voiceMins" && isOverCap) {
    overageCost = getVoiceOverageCost(plan, newTotal, cap);
    effectiveRate = overageAmount > 0 ? overageCost / overageAmount : 0; // effective blended rate for logging
  } else {
    overageCost = overageAmount * effectiveRate;
  }

  // Log overage charge and queue on Stripe for next invoice
  // Admin bypass: skip overage tracking — owner's usage routes to company API accounts.
  const _isAdminOverage = (typeof global.mineIsAdmin === "function") && global.mineIsAdmin(db, userId);
  if (isOverCap && overageCost > 0 && !_isAdminOverage && !opts.skipOverageBilling) {
    const overageId = uuid();
    db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status) VALUES (?,?,?,?,?,?,?,'pending')")
      .run(overageId, userId, metric, overageAmount, effectiveRate, overageCost, period);

    // Queue on Stripe — fires async so it never blocks the user's request
    setImmediate(async () => {
      try {
        const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) return;
        const userRow = db.prepare("SELECT stripe_customer_id, email, name FROM users WHERE id = ?").get(userId);
        if (!userRow?.stripe_customer_id) return;

        const Stripe = require("stripe");
        const stripe = Stripe(stripeKey);

        // Friendly metric label for the invoice line item
        const METRIC_LABELS = {
          monthlyNarrative: "Monthly Narrative Report", ticketReply: "AI Ticket Reply",
          refundDraft: "AI Refund Draft", subjectOptimize: "Email Subject Optimization",
          courseContent: "AI Course Content", meetingPrep: "Meeting Prep Brief",
          leadScoring: "Lead Score", churnRisk: "Churn Risk Assessment",
          emails: "Email Send", blogPosts: "AI Blog Post", proposals: "AI Proposal",
          adCreatives: "Ad Creative", socialPosts: "Social Post", socialCaptions: "Social Caption",
          reviewReplies: "Review Reply", invoiceChasers: "Invoice Chaser",
          voiceMins: "AI Voice Minute", chatbotChats: "Chatbot Chat", communityReplies: "Community Reply (Reddit/X)",
          competitorReports: "Competitor Report", aiResearch: "AI Research",
          contracts: "AI Contract", mentorChats: "Mentor Chat",
          productDescs: "Product Description", upsellRecs: "Upsell Recommendation",
          salesCopy: "AI Sales Copy", intelligenceRefresh: "Intelligence Refresh",
          aiVideos: "AI Video (Runway)", ugcVideos: "UGC Video", images: "AI Image",
          parcelDimensions: "AI Parcel Sizing",
          seoAudits: "AI SEO Audit",
        };
        const label = METRIC_LABELS[metric] || metric;
        const qty = Math.round(overageAmount * 100); // Stripe uses integer cents for quantity too

        await stripe.invoiceItems.create({
          customer: userRow.stripe_customer_id,
          amount: Math.round(overageCost * 100), // cents
          currency: "usd",
          description: `Overage: ${overageAmount} × ${label} @ $${effectiveRate.toFixed(4)} each (${period})`,
          metadata: { overage_id: overageId, metric, period, quantity: String(overageAmount), unit_price: String(effectiveRate) }
        });

        // Mark as queued in our DB; billed=1 ensures the monthly cron's
        // legacy filter also skips this row even if someone changes the
        // status-column semantics in the future.
        db.prepare("UPDATE overage_charges SET status = 'queued', billed = 1, billed_at = datetime('now') WHERE id = ?").run(overageId);
      } catch(e) {
        // Non-fatal — charge stays as 'pending' and can be reconciled manually
        console.error("[Overage] Stripe invoice item failed:", e?.message);
      }
    });
  }

  return {
    allowed: cap === 0 ? false : true,
    used: newTotal,
    cap,
    remaining: Math.max(0, cap - newTotal),
    isOverage: isOverCap,
    overageCost,
    currentOverageRate: metric === "voiceMins" && isOverCap ? effectiveRate : overagePrice,
    blocked: cap === 0
  };
}

// Check if user CAN use a feature (without incrementing)
function checkUsage(db, userId, metric) {
  ensureUsageTable(db);
  const period = getCurrentPeriod();
  const user = db.prepare("SELECT plan, role FROM users WHERE id = ?").get(userId);

  // Platform admin bypasses every cap. They run MINE itself — capping
  // them would block dogfooding and the TAKEOVA-promotes-MINE flywheel.
  if (user && user.role === "admin") {
    return {
      plan:    "admin",
      metric,
      cap:     Infinity,
      current: 0,
      remaining: Infinity,
      blocked: false,
      admin:   true,
    };
  }

  const plan = user?.plan || "starter";
  const caps = PLAN_CAPS[plan] || PLAN_CAPS.starter;
  let cap = caps[metric] !== undefined ? caps[metric] : 0;

  const existing = db.prepare("SELECT amount FROM usage_tracking WHERE user_id = ? AND metric = ? AND period = ?").get(userId, metric, period);
  const current = existing ? existing.amount : 0;

  // voiceMins: cap comes from the AI Receptionist addon, not the plan.
  if (metric === "voiceMins") {
    try {
      const hasAddon = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(userId);
      cap = hasAddon ? VOICE_ADDON_INCLUDED_MINS : 0;
    } catch(e) { cap = 0; }
  }

  // Legal Advisor employee: 3× cap on contracts and contractReviews
  if (metric === "contracts" || metric === "contractReviews") {
    try {
      const hasLegal = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'legal' AND enabled = 1").get(userId);
      if (hasLegal) cap = Math.min(cap * 3, 9999);
    } catch(e) {}
  }

    // Flat overage price - no per-plan discounts (v49's claimed Agency 50% discount was never implemented).
  let overagePrice = OVERAGE_PRICES[metric] || 0;

  return {
    used: current,
    cap,
    remaining: Math.max(0, cap - current),
    blocked: cap === 0,
    wouldBeOverage: current >= cap && cap > 0,
    overagePrice: overagePrice
  };
}

// GET usage dashboard — all metrics for current user
router.get("/usage", auth, (req, res) => {
  const db = getDb();
  ensureUsageTable(db);
  const period = getCurrentPeriod();
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  const plan = user?.plan || "starter";
  const caps = PLAN_CAPS[plan] || PLAN_CAPS.starter;

  const allUsage = db.prepare("SELECT metric, amount FROM usage_tracking WHERE user_id = ? AND period = ?").all(req.userId, period);
  const usageMap = {};
  allUsage.forEach(r => { usageMap[r.metric] = r.amount; });

  // Resolve voice cap from addon, not plan
  let voiceAddonCap = 0;
  try {
    const hasVoiceAddon = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(req.userId);
    voiceAddonCap = hasVoiceAddon ? VOICE_ADDON_INCLUDED_MINS : 0;
  } catch(e) {}

  const metrics = {};
  Object.keys(caps).forEach(metric => {
    const used = usageMap[metric] || 0;
    const cap = metric === "voiceMins" ? voiceAddonCap : caps[metric];
    metrics[metric] = {
      used,
      cap,
      remaining: Math.max(0, cap - used),
      percentUsed: cap > 0 ? Math.round((used / cap) * 100) : 0,
      blocked: cap === 0,
      overagePrice: OVERAGE_PRICES[metric] || 0,
      overageUnits: Math.max(0, used - cap),
      overageCost: Math.max(0, used - cap) * (OVERAGE_PRICES[metric] || 0)
    };
  });

  // Get total overage charges this period
  const overages = db.prepare("SELECT metric, SUM(total) as total, SUM(quantity) as qty FROM overage_charges WHERE user_id = ? AND period = ? GROUP BY metric").all(req.userId, period);
  const totalOverage = overages.reduce((s, o) => s + o.total, 0);

  res.json({ plan, period, metrics, overages, totalOverage, overagePrices: OVERAGE_PRICES, planCaps: caps });
});

// GET usage history (past months)
// ── In-dashboard Help Assistant (Part-2 item 14): plan-aware product help ──
router.post("/help-assistant", auth, async (req, res) => {
  try {
    const db = getDb();
    const q = String(req.body?.question || "").slice(0, 600);
    if (!q.trim()) return res.status(400).json({ error: "Ask a question first." });
    // meter as an AI action
    if (typeof global.mineCheckUsage === "function") {
      const u = global.mineCheckUsage(db, req.userId, "aiActions");
      if (u && u.blocked) return res.status(403).json({ error: "Monthly AI action allowance reached — upgrade your plan for more.", code: "PLAN_LIMIT", requiresUpgrade: true });
    }
    const me = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
    const plan = (me?.plan || "starter");
    const caps = PLAN_CAPS[plan] || PLAN_CAPS.starter;
    const capLine = `sites ${caps.sites}, AI actions ${caps.aiActions}/mo, emails ${caps.emails}/mo, SMS sends ${caps.smsBroadcastSends}/mo, social posts ${caps.socialPosts}/mo`;
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
    const system = `You are the TAKEOVA in-app help assistant. TAKEOVA is an all-in-one AI business platform (websites, CRM, bookings, email & SMS marketing, invoicing, memberships, and 16 hireable AI employees with Review/Half-auto/Full-auto autonomy). The user is on the ${plan} plan (key monthly allowances: ${capLine}). Answer ONLY questions about using TAKEOVA — how features work, where to find things, what their plan includes, and plain-English explanations of limits. Be concise (2-5 sentences), friendly, and concrete (name the panel/button). If they hit a limit, explain the allowance and that they can upgrade or pay-as-you-go. If asked something unrelated to TAKEOVA, politely redirect. Never invent features.`;
    const msgs = history.map(h => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content || "").slice(0, 500) }));
    msgs.push({ role: "user", content: q });
    let anthropicKey = process.env.ANTHROPIC_API_KEY || "";
    try { anthropicKey = db.prepare("SELECT value FROM settings WHERE key = ?").get("ANTHROPIC_API_KEY")?.value || anthropicKey; } catch (_e) {}
    if (!anthropicKey) return res.status(500).json({ error: "AI is not configured yet (missing Anthropic key)." });
    const nf = (await import("node-fetch")).default;
    const r = await nf("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 400, system, messages: msgs })
    });
    const d = await r.json();
    const answer = d?.content?.[0]?.text || "Sorry — I could not generate an answer just now. Please try again.";
    if (typeof global.mineTrackUsage === "function") { try { global.mineTrackUsage(db, req.userId, "aiActions", 1); } catch(_e){} }
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: "Help assistant is unavailable right now." });
  }
});

router.get("/usage/history", auth, (req, res) => {
  const db = getDb();
  ensureUsageTable(db);
  const history = db.prepare("SELECT period, metric, amount FROM usage_tracking WHERE user_id = ? ORDER BY period DESC LIMIT 200").all(req.userId);
  const charges = db.prepare("SELECT period, metric, total FROM overage_charges WHERE user_id = ? ORDER BY period DESC LIMIT 100").all(req.userId);
  res.json({ history, charges });
});

// Make checkUsage, trackUsage, and sanitizeError available to other routes
if (typeof global !== "undefined") {
  global.mineCheckUsage = checkUsage;
  global.mineTrackUsage = trackUsage;
  // Strips internal Stripe/system error details from messages sent to clients
  global.sanitizeError = (e) => {
    if (!e) return "An unexpected error occurred";
    const msg = e.message || String(e);
    // Stripe errors expose internal detail — return just the user-facing message
    if (e.type && e.message) return e.message; // Stripe errors already have clean messages
    if (msg.includes("SQLITE") || msg.includes("syntax")) return "A database error occurred";
    return msg.length > 200 ? "An unexpected error occurred" : msg;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hybrid-C overage consent — customer hits cap → modal asks consent → after
// first consent in a billing period, subsequent overages auto-charge silently.
// Currently used for Higgsfield premium features (soulImages, cinematicVideos,
// brandModels) but applies to any metric in PLAN_CAPS / OVERAGE_PRICES.
// ═══════════════════════════════════════════════════════════════════════════

function ensureOverageConsentTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS feature_overage_consent (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    period TEXT NOT NULL,
    overage_rate REAL,
    consented_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, metric, period)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_overage_consent_lookup
           ON feature_overage_consent(user_id, metric, period)`);
}

// Returns one of:
//   { ok: true, overage: false }                        → under cap, proceed
//   { ok: true, overage: true, rate }                   → over cap, consent on file, proceed
//   { ok: false, locked: true, reason, plan, cap: 0 }   → feature locked on this plan
//   { ok: false, capReached: true, cap, used, rate }    → over cap, no consent — ask user
//
// Caller must call global.mineTrackUsage AFTER successful generation to record + bill.
function enforceCapWithConsent(db, userId, metric) {
  if (!global.mineCheckUsage) return { ok: true };

  const usage = global.mineCheckUsage(db, userId, metric);
  if (usage.admin) return { ok: true };

  // Feature locked entirely on this plan
  if (usage.blocked) {
    return {
      ok: false,
      locked: true,
      reason: `${metric} is not included on your plan`,
      plan: usage.plan,
      cap: 0
    };
  }

  // Within cap — straight through
  if (!usage.wouldBeOverage) return { ok: true, overage: false };

  // Over cap → check consent for current billing period
  ensureOverageConsentTable(db);
  const period = getCurrentPeriod();
  const consent = db.prepare(
    "SELECT 1 FROM feature_overage_consent WHERE user_id = ? AND metric = ? AND period = ?"
  ).get(userId, metric, period);

  if (consent) {
    return { ok: true, overage: true, rate: usage.overagePrice };
  }

  return {
    ok: false,
    capReached: true,
    metric,
    cap: usage.cap,
    used: usage.used,
    rate: usage.overagePrice
  };
}

// Record consent — called when user clicks "Yes, continue with overage" in modal
router.post("/consent-overage", auth, (req, res) => {
  try {
    const { metric } = req.body || {};
    if (!metric || typeof metric !== "string") {
      return res.status(400).json({ ok: false, error: "metric required" });
    }
    if (OVERAGE_PRICES[metric] === undefined) {
      return res.status(400).json({ ok: false, error: "unknown or non-billable metric" });
    }
    const db = getDb();
    ensureOverageConsentTable(db);
    const period = getCurrentPeriod();
    const { v4: uuid } = require("uuid");
    const id = uuid();
    db.prepare(
      "INSERT OR IGNORE INTO feature_overage_consent (id, user_id, metric, period, overage_rate) VALUES (?, ?, ?, ?, ?)"
    ).run(id, req.userId, metric, period, OVERAGE_PRICES[metric] || 0);
    res.json({
      ok: true,
      metric,
      period,
      rate: OVERAGE_PRICES[metric] || 0,
      message: `Overage charges enabled for ${metric} this month`
    });
  } catch(e) {
    console.error("[consent-overage]", e.message);
    res.status(500).json({ ok: false, error: "consent recording failed" });
  }
});

if (typeof global !== "undefined") {
  global.mineEnforceCapWithConsent = enforceCapWithConsent;
}


// ═══════════════════════════════════════════════════
// DEAL BREAKER #3: ORDER CONFIRMATION + SHIPPING EMAILS
// ═══════════════════════════════════════════════════

router.post("/orders/confirm", auth, async (req, res) => {
  try {
    const { orderId, customerEmail, customerName, items, total, orderNumber } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const bizName = site?.name || "Store";
    const user = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(req.userId);
    const refCode = user?.referral_code || "";

    const itemsHtml = (items || []).map(i =>
      `<tr><td style="padding:12px;border-bottom:1px solid #f0f0f0">${i.name}</td><td style="padding:12px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity || 1}</td><td style="padding:12px;border-bottom:1px solid #f0f0f0;text-align:right">$${(i.price * (i.quantity || 1)).toFixed(2)}</td></tr>`
    ).join("");

    const html = `
      <div style="font-family:system-ui;max-width:600px;margin:0 auto;">
        <div style="background:#f8f8f8;padding:24px;text-align:center;border-radius:8px 8px 0 0">
          <h1 style="font-size:20px;margin:0">Order Confirmed! ✅</h1>
          <p style="color:#666;margin:8px 0 0">Thank you for your purchase from ${bizName}</p>
        </div>
        <div style="padding:24px">
          <p>Hi ${esc(customerName || "there")},</p>
          <p>We've received your order <strong>#${orderNumber || orderId}</strong> and it's being processed.</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0">
            <thead><tr style="background:#f7f8fa"><th style="padding:12px;text-align:left">Item</th><th style="padding:12px;text-align:center">Qty</th><th style="padding:12px;text-align:right">Amount</th></tr></thead>
            <tbody>${itemsHtml}</tbody>
            <tfoot><tr><td colspan="2" style="padding:12px;font-weight:bold">Total</td><td style="padding:12px;font-weight:bold;text-align:right">$${(total || 0).toFixed(2)}</td></tr></tfoot>
          </table>
          <p style="color:#666;font-size:13px">We'll send you another email when your order ships.</p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #f0f0f0;text-align:center">
            <a href="https://takeova.ai${refCode ? "?ref=" + refCode : ""}" style="color:#999;font-size:11px;text-decoration:none">Sent via <strong style="color:#2563EB">MINE</strong></a>
          </div>
        </div>
      </div>`;

    try {
      const sgKey = getSetting("SENDGRID_API_KEY");
      if (sgKey) {
        const fetch = (await import("node-fetch")).default;
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({ personalizations: [{ to: [{ email: customerEmail }] }], from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: bizName }, subject: `Order confirmed — #${orderNumber || orderId} from ${bizName}`, content: [{ type: "text/html", value: html }] })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
      res.json({ success: true });
    } catch(e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

router.post("/orders/shipping", auth, async (req, res) => {
  try {
    const { orderId, customerEmail, customerName, trackingNumber, carrier, orderNumber } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const bizName = site?.name || "Store";

    const trackingUrl = carrier === "usps" ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}` :
      carrier === "ups" ? `https://www.ups.com/track?tracknum=${trackingNumber}` :
      carrier === "fedex" ? `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}` :
      carrier === "dhl" ? `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}` : "";

    const html = `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
      <h2>Your order has shipped! 📦</h2>
      <p>Hi ${esc(customerName || "there")},</p>
      <p>Great news — your order <strong>#${orderNumber || orderId}</strong> from ${bizName} is on its way!</p>
      ${trackingNumber ? `<div style="background:#f7f8fa;padding:16px;border-radius:8px;margin:16px 0"><strong>Tracking:</strong> ${trackingNumber}${carrier ? " (" + carrier.toUpperCase() + ")" : ""}${trackingUrl ? `<br><a href="${trackingUrl}" style="color:#2563EB">Track your package →</a>` : ""}</div>` : ""}
      <p style="color:#666;font-size:13px">You'll receive your order soon. If you have any questions, just reply to this email.</p>
    </div>`;

    try {
      const sgKey = getSetting("SENDGRID_API_KEY");
      if (sgKey) {
        const fetch = (await import("node-fetch")).default;
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({ personalizations: [{ to: [{ email: customerEmail }] }], from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: bizName }, subject: `Your order from ${bizName} has shipped! 📦`, content: [{ type: "text/html", value: html }] })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
      res.json({ success: true });
    } catch(e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});


// ═══════════════════════════════════════════════════
// DEAL BREAKER #4: BOOKING CONFIRMATION + REMINDERS
// ═══════════════════════════════════════════════════

router.post("/bookings/confirm", auth, async (req, res) => {
  try {
    const { bookingId, customerEmail, customerName, service, date, time, duration, location } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const bizName = site?.name || "Business";

    const html = `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
      <h2>Booking Confirmed! ✅</h2>
      <p>Hi ${esc(customerName || "there")},</p>
      <p>Your appointment with <strong>${bizName}</strong> is confirmed.</p>
      <div style="background:#f7f8fa;padding:20px;border-radius:10px;margin:16px 0">
        <div style="margin-bottom:8px"><strong>📅 Date:</strong> ${date}</div>
        <div style="margin-bottom:8px"><strong>🕐 Time:</strong> ${time}${duration ? " (" + duration + " min)" : ""}</div>
        <div style="margin-bottom:8px"><strong>💼 Service:</strong> ${esc(service)}</div>
        ${location ? `<div><strong>📍 Location:</strong> ${location}</div>` : ""}
      </div>
      <p style="color:#666;font-size:13px">Need to reschedule or cancel? <a href="${BACKEND_URL || "http://localhost:4000"}/api/features/bookings/manage/${bookingId}" style="color:#2563EB;">Manage your booking</a> or reply to this email.</p>
      ${getWhatsAppEmailFooter(db, userId)}
    </div>`;

    try {
      const sgKey = getSetting("SENDGRID_API_KEY");
      if (sgKey) {
        const fetch = (await import("node-fetch")).default;
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({ personalizations: [{ to: [{ email: customerEmail }] }], from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: bizName }, subject: `Booking confirmed — ${String(service||"").replace(/[\r\n]/g,"")} at ${String(bizName||"").replace(/[\r\n]/g,"")}`, content: [{ type: "text/html", value: html }] })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }

      // Schedule reminder for 24h before and 1h before
      db.exec("CREATE TABLE IF NOT EXISTS booking_reminders (id TEXT PRIMARY KEY, booking_id TEXT, user_id TEXT, customer_email TEXT, customer_name TEXT, customer_phone TEXT, service TEXT, reminder_time TEXT, type TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");

      if (date && time) {
        const bookingDT = new Date(date + "T" + time);
        const reminder24h = new Date(bookingDT.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const reminder1h = new Date(bookingDT.getTime() - 60 * 60 * 1000).toISOString();

        db.prepare("INSERT INTO booking_reminders (id, booking_id, user_id, customer_email, customer_name, customer_phone, service, reminder_time, type) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(uuid(), bookingId, req.userId, customerEmail, customerName || "", req.body.customerPhone || "", service, reminder24h, "24h_email");
        db.prepare("INSERT INTO booking_reminders (id, booking_id, user_id, customer_email, customer_name, customer_phone, service, reminder_time, type) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(uuid(), bookingId, req.userId, customerEmail, customerName || "", req.body.customerPhone || "", service, reminder1h, "1h_email");

        if (req.body.customerPhone) {
          db.prepare("INSERT INTO booking_reminders (id, booking_id, user_id, customer_email, customer_name, customer_phone, service, reminder_time, type) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(uuid(), bookingId, req.userId, customerEmail, customerName || "", req.body.customerPhone, service, reminder1h, "1h_sms");
        }
      }

      res.json({ success: true });
    } catch(e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});


// ═══════════════════════════════════════════════════
// DEAL BREAKER #6: ABANDONED CART RECOVERY
// ═══════════════════════════════════════════════════

router.post("/cart/abandon", cartAbandonLimiter, async (req, res) => {
  try {
  const { siteId, customerEmail, customerName, items, cartTotal, cartUrl } = req.body;
  if (!siteId || !customerEmail) return res.status(400).json({ error: "siteId and email required" });
  if (!_CART_EMAIL_RE.test(customerEmail) || customerEmail.length > 254) return res.status(400).json({ error: "Invalid email" });
  // Validate cartUrl is a safe absolute HTTP(S) URL to prevent phishing links in emails
  let safeCartUrl = "";
  if (cartUrl) {
    try { const u = new URL(cartUrl); safeCartUrl = (u.protocol === "https:" || u.protocol === "http:") ? cartUrl : ""; } catch { safeCartUrl = ""; }
  }

  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS abandoned_carts (id TEXT PRIMARY KEY, site_id TEXT, customer_email TEXT, customer_name TEXT, items TEXT, cart_total REAL, cart_url TEXT, recovery_email_sent INTEGER DEFAULT 0, recovered INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");

  const id = uuid();
  db.prepare("INSERT INTO abandoned_carts (id, site_id, customer_email, customer_name, items, cart_total, cart_url) VALUES (?,?,?,?,?,?,?)")
    .run(id, siteId, customerEmail, customerName || "", JSON.stringify(items || []), cartTotal || 0, cartUrl || "");

  // Schedule recovery email — send 1 hour after abandonment
  db.exec("CREATE TABLE IF NOT EXISTS scheduled_emails (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT, send_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");

  const site = db.prepare("SELECT user_id, name FROM sites WHERE id = ?").get(siteId);
  if (!site) return res.json({ success: true, id });

  const bizName = site.name || "Store";
  const itemsList = (items || []).map(i => `• ${i.name} — $${i.price}`).join("\n");

  const subject = `You left something behind at ${bizName}! 🛒`;
  const body = `Hi ${esc(customerName || "there")},\n\nLooks like you didn't finish checking out at ${bizName}.\n\nYour cart:\n${itemsList}\n\nTotal: $${(cartTotal || 0).toFixed(2)}\n\n${cartUrl ? "Complete your purchase: " + cartUrl : "Head back to finish your order!"}\n\nIf you have any questions, just reply to this email.\n\n— ${bizName}`;

  db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at) VALUES (?,?,?,?,?,datetime('now','+1 hour'))")
    .run(uuid(), site.user_id, customerEmail, subject, body);

  // Schedule a second recovery email 24h later
  const subject2 = `Still thinking about it? Here's 10% off at ${bizName} 💰`;
  const body2 = `Hi ${esc(customerName || "there")},\n\nWe noticed you didn't complete your order at ${bizName} yesterday.\n\nUse code COMEBACK10 for 10% off your purchase.\n\nYour cart:\n${itemsList}\n\n${cartUrl ? "Complete your purchase: " + cartUrl : ""}\n\n— ${bizName}`;

  db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at) VALUES (?,?,?,?,?,datetime('now','+24 hours'))")
    .run(uuid(), site.user_id, customerEmail, subject2, body2);

  res.json({ success: true, id });
  } catch (e) {
    console.error("[cart/abandon]", e?.message);
    res.status(500).json({ error: "Failed to record cart abandonment" });
  }
});


// ═══════════════════════════════════════════════════
// DEAL BREAKER #7: CONTACT IMPORT (CSV)
// ═══════════════════════════════════════════════════

router.post("/contacts/import", auth, async (req, res) => {
  try {
    const { contacts } = req.body; // Array of {name, email, phone, tags, status}
    if (!contacts || !Array.isArray(contacts)) return res.status(400).json({ error: "Provide contacts array" });

    if (contacts.length > 10000) {
      return res.status(400).json({ error: "Maximum 10,000 contacts per import. Split into smaller batches." });
    }

    const db = getDb();
    let imported = 0, skipped = 0, duplicates = 0;

    for (const c of contacts) {
      if (!c.email || !c.email.includes("@")) { skipped++; continue; }

      const existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(req.userId, c.email.toLowerCase());
      if (existing) { duplicates++; continue; }

      db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, status, source, tags_json, created_at, last_activity) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))")
        .run(uuid(), req.userId, c.name || c.email.split("@")[0], c.email.toLowerCase(), c.phone || "", c.status || "lead", "csv_import", JSON.stringify(c.tags || ["imported"]));
      imported++;
    }

    res.json({ success: true, imported, skipped, duplicates, total: contacts.length });
    // ── Intelligence: log contact_added event if contacts were imported ──
    if (imported > 0) {
      try {
        const { logEvent } = require("./intelligence");
        logEvent(db, req.userId, "contact_added", { count: imported, source: "csv_import" });
      } catch(e) {}
    }
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" }); }
});


// ═══════════════════════════════════════════════════
// DEAL BREAKER #8: DIGITAL PRODUCT DELIVERY
// ═══════════════════════════════════════════════════

router.post("/products/digital-deliver", auth, async (req, res) => {
  try {
    const { customerEmail, customerName, productName, downloadUrl, orderId } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const bizName = site?.name || "Store";
    const user = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(req.userId);

    // Generate a unique time-limited download token
    const token = uuid();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    db.exec("CREATE TABLE IF NOT EXISTS digital_downloads (id TEXT PRIMARY KEY, user_id TEXT, order_id TEXT, customer_email TEXT, product_name TEXT, download_url TEXT, token TEXT UNIQUE, downloads INTEGER DEFAULT 0, max_downloads INTEGER DEFAULT 5, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')))");

    db.prepare("INSERT INTO digital_downloads (id, user_id, order_id, customer_email, product_name, download_url, token, expires_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(uuid(), req.userId, orderId || "", customerEmail, productName, downloadUrl, token, expiresAt);

    const secureLink = `${BACKEND_URL || "http://localhost:4000"}/api/features/download/${token}`;

    const html = `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
      <h2>Your download is ready! 🎉</h2>
      <p>Hi ${esc(customerName || "there")},</p>
      <p>Thank you for purchasing <strong>${productName}</strong> from ${bizName}.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${secureLink}" style="display:inline-block;padding:16px 32px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px">📥 Download Now</a>
      </div>
      <p style="color:#666;font-size:12px">This link expires in 7 days and allows up to 5 downloads. If you need help, reply to this email.</p>
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #f0f0f0;text-align:center">
        <a href="https://takeova.ai${user?.referral_code ? "?ref=" + user.referral_code : ""}" style="color:#999;font-size:11px;text-decoration:none">Sent via <strong style="color:#2563EB">MINE</strong></a>
      </div>
    </div>`;

    try {
      const sgKey = getSetting("SENDGRID_API_KEY");
      if (sgKey) {
        const fetch = (await import("node-fetch")).default;
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({ personalizations: [{ to: [{ email: customerEmail }] }], from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: bizName }, subject: `Your download from ${bizName} is ready! 📥`, content: [{ type: "text/html", value: html }] })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
      res.json({ success: true, downloadLink: secureLink });
    } catch(e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Secure download endpoint (public — customer clicks link from email)
router.get("/download/:token", (req, res) => {
  const db = getDb();
  try {
    const dl = db.prepare("SELECT * FROM digital_downloads WHERE token = ?").get(req.params.token);
    if (!dl) return res.status(404).send("<h1>Download link not found</h1>");
    if (new Date(dl.expires_at) < new Date()) return res.status(410).send("<h1>Download link expired</h1><p>Contact the seller for a new link.</p>");
    // Validate download URL before attempting the atomic increment
    let safeUrl;
    try {
      const parsed = new URL(dl.download_url);
      if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
      safeUrl = parsed.href;
    } catch(e) {
      return res.status(400).send("<h1>Invalid download URL</h1>");
    }

    // Atomic increment — only succeeds if downloads < max_downloads, prevents race condition
    const result = db.prepare(
      "UPDATE digital_downloads SET downloads = downloads + 1 WHERE token = ? AND downloads < max_downloads"
    ).run(req.params.token);
    if (result.changes === 0) {
      return res.status(410).send("<h1>Download limit reached</h1><p>This link has been used the maximum number of times.</p>");
    }
    res.redirect(safeUrl);
  } catch(e) { res.status(500).send("<h1>Error</h1>"); }
});


// ═══════════════════════════════════════════════════
// DEAL BREAKER #5: UNSUBSCRIBE MANAGEMENT
// ═══════════════════════════════════════════════════

router.get("/unsubscribe/:userId/:email", (req, res) => {
  const db = getDb();
  const email = Buffer.from(req.params.email, "base64").toString("utf8");

  db.exec("CREATE TABLE IF NOT EXISTS email_unsubscribes (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, email))");

  try {
    db.prepare("INSERT OR IGNORE INTO email_unsubscribes (id, user_id, email) VALUES (?,?,?)").run(uuid(), req.params.userId, email.toLowerCase());
  } catch(e) { console.error("[/:userId/:email]", e.message || e); }

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8f8f8;padding:20px}.card{background:#fff;border-radius:16px;padding:40px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{font-size:22px;margin-bottom:8px}p{color:#666;font-size:14px;line-height:1.6}</style>
</head><body><div class="card"><div style="font-size:40px;margin-bottom:16px">✅</div><h1>You've been unsubscribed</h1><p>You will no longer receive marketing emails from this business. This may take up to 24 hours to take effect.</p><p style="margin-top:16px;font-size:12px;color:#999">If this was a mistake, contact the business directly.</p></div></body></html>`);
});

// Check if email is unsubscribed (used before sending)
function isUnsubscribed(db, userId, email) {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_unsubscribes (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, email))");
    const row = db.prepare("SELECT id FROM email_unsubscribes WHERE user_id = ? AND email = ?").get(userId, email.toLowerCase());
    return !!row;
  } catch(e) { return false; }
}

module.exports.isUnsubscribed = isUnsubscribed;

// ═══════════════════════════════════════════════════════════
// AUTO-NOTIFICATION ENGINE
// Every customer-facing event triggers the right email/SMS automatically
// ═══════════════════════════════════════════════════════════

// Helper: send branded email from business
async function autoEmail(userId, toEmail, subject, bodyHtml) {
  // Prevent email header injection
  subject = String(subject || "").replace(/[\r\n]/g, " ").slice(0, 200);
  const db = getDb();
  if (!toEmail) return;

  // Check unsubscribe
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_unsubscribes (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, email))");
    const unsub = db.prepare("SELECT id FROM email_unsubscribes WHERE user_id = ? AND email = ?").get(userId, toEmail.toLowerCase());
    if (unsub) return;
  } catch(e) {}

  const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(userId);
  const bizName = site?.name || "Business";
  const user = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(userId);
  const refCode = user?.referral_code || "";
  const fromEmail = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
  const encodedEmail = Buffer.from(toEmail.toLowerCase()).toString("base64");
  const unsubLink = `${BACKEND_URL || "http://localhost:4000"}/api/features/unsubscribe/${userId}/${encodedEmail}`;

  const footer = `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #f0f0f0;text-align:center">
    <a href="https://takeova.ai${refCode ? "?ref=" + refCode : ""}" style="color:#999;font-size:11px;text-decoration:none">Sent via <strong style="color:#2563EB">MINE</strong></a>
    <br><a href="${unsubLink}" style="color:#bbb;font-size:10px;text-decoration:none;margin-top:4px;display:inline-block">Unsubscribe</a>
  </div>`;

  const fullHtml = `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">${bodyHtml}${footer}</div>`;

  const sgKey = getSetting("SENDGRID_API_KEY");
  const smtpHost = getSetting("SMTP_HOST");

  if (sgKey) {
    // SendGrid path
    try {
      const fetch = (await import("node-fetch")).default;
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: toEmail }] }],
          from: { email: fromEmail, name: bizName },
          subject, content: [{ type: "text/html", value: fullHtml }]
        })
      });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    } catch(e) { console.error("[autoEmail] SendGrid error:", e?.message); }
  } else if (smtpHost) {
    // SMTP fallback path
    try {
      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(getSetting("SMTP_PORT")) || 587,
        secure: parseInt(getSetting("SMTP_PORT")) === 465,
        auth: { user: getSetting("SMTP_USER"), pass: getSetting("SMTP_PASS") },
      });
      await transporter.sendMail({ from: `"${bizName}" <${fromEmail}>`, to: toEmail, subject, html: fullHtml });
    } catch(e) { console.error("[autoEmail] SMTP error:", e?.message); }
  }
  // If neither provider is configured, silently skip — admin must set up email first
}

// Helper: notify MINE user (business owner)
function notifyOwner(userId, icon, text) {
  const db = getDb();
  try {
    db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)").run(uuid(), userId, icon, text, "Just now");
  } catch(e) { console.error("[/:userId/:email]", e.message || e); }
}

// ── BOOKING: Auto-confirm when created ──
router.post("/bookings/create", auth, async (req, res) => {
  try {
    const { customerEmail, customerName, customerPhone, service, date, time, duration, location, price } = req.body;
    const db = getDb();
    const id = uuid();

    db.exec("CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, user_id TEXT, customer_email TEXT, customer_name TEXT, customer_phone TEXT, service TEXT, date TEXT, time TEXT, duration INTEGER, location TEXT, price REAL, status TEXT DEFAULT 'confirmed', created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO bookings (id, user_id, customer_email, customer_name, customer_phone, service, date, time, duration, location, price) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, customerEmail, customerName || "", customerPhone || "", service, date, time, duration || 60, location || "", price || 0);

    // Auto-enroll in "Booking confirmed" funnels
    try { const { autoEnrollInFunnels } = require("./email"); autoEnrollInFunnels(db, req.userId, "Booking confirmed", customerEmail, customerName || ""); } catch(e) {}

    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const bizName = site?.name || "Business";

    // Auto-send confirmation
    await autoEmail(req.userId, customerEmail, `Booking confirmed — ${service} at ${bizName}`,
      `<h2>Booking Confirmed! ✅</h2>
      <p>Hi ${esc(customerName || "there")},</p>
      <p>Your appointment with <strong>${bizName}</strong> is confirmed.</p>
      <div style="background:#f7f8fa;padding:20px;border-radius:10px;margin:16px 0">
        <div style="margin-bottom:8px"><strong>📅</strong> ${date}</div>
        <div style="margin-bottom:8px"><strong>🕐</strong> ${time}${duration ? " (" + duration + " min)" : ""}</div>
        <div style="margin-bottom:8px"><strong>💼</strong> ${esc(service)}</div>
        ${location ? `<div><strong>📍</strong> ${location}</div>` : ""}
      </div>
      <p style="color:#666;font-size:13px">Need to reschedule or cancel? <a href="${BACKEND_URL || "http://localhost:4000"}/api/features/bookings/manage/${id}" style="color:#2563EB;">Manage your booking</a></p>`);

    // Schedule reminders
    db.exec("CREATE TABLE IF NOT EXISTS booking_reminders (id TEXT PRIMARY KEY, booking_id TEXT, user_id TEXT, customer_email TEXT, customer_name TEXT, customer_phone TEXT, service TEXT, reminder_time TEXT, type TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");
    if (date && time) {
      const dt = new Date(date + "T" + time);
      const r24 = new Date(dt.getTime() - 24*60*60*1000).toISOString();
      const r1 = new Date(dt.getTime() - 60*60*1000).toISOString();
      db.prepare("INSERT INTO booking_reminders (id, booking_id, user_id, customer_email, customer_name, customer_phone, service, reminder_time, type) VALUES (?,?,?,?,?,?,?,?,?)").run(uuid(), id, req.userId, customerEmail, customerName||"", customerPhone||"", service, r24, "24h_email");
      db.prepare("INSERT INTO booking_reminders (id, booking_id, user_id, customer_email, customer_name, customer_phone, service, reminder_time, type) VALUES (?,?,?,?,?,?,?,?,?)").run(uuid(), id, req.userId, customerEmail, customerName||"", customerPhone||"", service, r1, "1h_email");
      if (customerPhone) db.prepare("INSERT INTO booking_reminders (id, booking_id, user_id, customer_email, customer_name, customer_phone, service, reminder_time, type) VALUES (?,?,?,?,?,?,?,?,?)").run(uuid(), id, req.userId, customerEmail, customerName||"", customerPhone, service, r1, "1h_sms");
    }

    notifyOwner(req.userId, "📅", `New booking: ${customerName || customerEmail} — ${service} on ${date}`);
    // ── Intelligence: log booking event ──────────────────────────────
    try {
      const { logEvent } = require("./intelligence");
      logEvent(db, req.userId, "booking_created", { service, price: Math.round(price || 0) });
    } catch(e) {}
    res.json({ success: true, id });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── BOOKING: Auto-cancel email ──
router.post("/bookings/:id/cancel", auth, async (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (booking?.customer_email) {
      const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
      await autoEmail(req.userId, booking.customer_email, `Booking cancelled — ${booking.service}`,
        `<p>Hi ${esc(booking.customer_name || "there")},</p>
        <p>Your appointment for <strong>${esc(booking.service)}</strong> on ${esc(booking.date)} at ${esc(booking.time)} has been cancelled.</p>
        <p>If you'd like to rebook, just reply to this email.</p>`);
    }
    // Remove pending reminders
    db.prepare("DELETE FROM booking_reminders WHERE booking_id = ? AND status = 'pending'").run(req.params.id);
    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── BOOKING: Confirm pending_review booking (typically from AI chatbot) ──
// When the customer chatbot creates a booking, it lands as status='pending_review'
// so the site owner can review and confirm before the customer is told it's locked in.
// This endpoint flips it to 'confirmed', emails the customer, and fires the webhook.
router.post("/bookings/:id/confirm", auth, async (req, res) => {
  try {
    const db = getDb();
    // Verify ownership before mutating
    const existing = db.prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: "Booking not found" });
    db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (booking?.customer_email) {
      const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
      const bizName = site?.name || "us";
      await autoEmail(req.userId, booking.customer_email, `Booking confirmed — ${booking.service}`,
        `<p>Hi ${esc(booking.customer_name || "there")},</p>
        <p>Great news — your booking with ${esc(bizName)} is confirmed.</p>
        <p><strong>${esc(booking.service)}</strong><br>
        ${esc(booking.date)} at ${esc(booking.time)}${booking.duration ? ` · ${booking.duration} min` : ""}${booking.location ? `<br>${esc(booking.location)}` : ""}</p>
        <p>Looking forward to seeing you. If you need to reschedule, just reply to this email.</p>`);
    }
    // Auto-enroll in "Booking confirmed" funnels (existing pattern)
    try { const { autoEnrollInFunnels } = require("./email"); autoEnrollInFunnels(db, req.userId, "Booking confirmed", booking.customer_email, booking.customer_name || ""); } catch(e) {}
    // Fire webhook
    try { const { fireWebhooks } = require("./marketplace"); fireWebhooks(req.userId, "booking.confirmed", { id: booking.id, customer_email: booking.customer_email, service: booking.service, date: booking.date, time: booking.time }); } catch(e) {}
    res.json({ success: true, booking });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── BOOKING: Reject pending_review booking ──
// Owner can reject an AI-created booking (e.g., wrong time, no availability).
// Sends a polite "couldn't accommodate" note and a link back to the booking page.
router.post("/bookings/:id/reject", auth, async (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: "Booking not found" });
    const reason = String(req.body?.reason || "").slice(0, 200);
    db.prepare("UPDATE bookings SET status = 'rejected', notes = COALESCE(notes,'') || ? WHERE id = ? AND user_id = ?")
      .run(reason ? `\n[Rejected: ${reason}]` : "\n[Rejected]", req.params.id, req.userId);
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (booking?.customer_email) {
      const site = db.prepare("SELECT name, slug FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
      const bizName = site?.name || "us";
      const bookingPageUrl = site?.slug ? `https://${site.slug}.takeova.ai/book` : "";
      await autoEmail(req.userId, booking.customer_email, `Booking update — ${booking.service}`,
        `<p>Hi ${esc(booking.customer_name || "there")},</p>
        <p>Thanks for your booking request for <strong>${esc(booking.service)}</strong> on ${esc(booking.date)} at ${esc(booking.time)}. Unfortunately we're not able to accommodate this slot${reason ? ` — ${esc(reason)}` : ""}.</p>
        ${bookingPageUrl ? `<p>You can pick a different time here:</p>
        <p><a href="${bookingPageUrl}" style="display:inline-block;padding:12px 20px;background:#2563EB;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">View available slots</a></p>` : ""}
        <p>Sorry for any inconvenience — please reach out if you'd like to chat about other options.</p>`);
    }
    try { const { fireWebhooks } = require("./marketplace"); fireWebhooks(req.userId, "booking.rejected", { id: booking.id, customer_email: booking.customer_email, service: booking.service, reason }); } catch(e) {}
    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── COURSE: Auto-enrollment email ──
router.post("/courses/enroll", auth, async (req, res) => {
  try {
    const { courseId, studentEmail, studentName, courseName } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const bizName = site?.name || "Academy";

    // Auto-enroll in "Course enrolled" funnels
    try { const { autoEnrollInFunnels } = require("./email"); autoEnrollInFunnels(db, req.userId, "Course enrolled", studentEmail, studentName || ""); } catch(e) {}

    await autoEmail(req.userId, studentEmail, `Welcome to ${courseName}! 🎓`,
      `<h2>You're enrolled! 🎓</h2>
      <p>Hi ${esc(studentName || "there")},</p>
      <p>Welcome to <strong>${esc(courseName)}</strong> at ${esc(bizName)}.</p>
      <p>Your course is ready. Log in to start learning:</p>
      <div style="text-align:center;margin:20px 0">
        <a href="${BACKEND_URL || "http://localhost:4000"}/api/features/student/my-courses" style="display:inline-block;padding:14px 28px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">My Courses →</a>
      </div>
      <p style="color:#666;font-size:13px">Log in with your email (${studentEmail}) — we'll send you a quick code. No password needed.</p>`);

    notifyOwner(req.userId, "🎓", `New enrollment: ${studentName || studentEmail} joined ${courseName}`);

    fireAutomation(req.userId, "course_enrolled", { email: studentEmail, name: studentName || "", courseName, courseId });
    // ── Intelligence: log student_enrolled event ────────────────────────
    try {
      const { logEvent } = require("./intelligence");
      logEvent(db, req.userId, "student_enrolled", { courseName: (courseName || "").slice(0, 80) });
    } catch(e) {}

    // Schedule progress reminder in 3 days
    db.exec("CREATE TABLE IF NOT EXISTS scheduled_emails (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT, send_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at) VALUES (?,?,?,?,?,datetime('now','+3 days'))")
      .run(uuid(), req.userId, studentEmail, `How's ${courseName} going? 📚`, `Hi ${studentName || "there"},\n\nJust checking in — have you started ${esc(courseName)} yet?\n\nYour course is waiting for you. Even 15 minutes a day makes a big difference.\n\nContinue learning: ${BACKEND_URL || "http://localhost:4000"}/api/features/student/my-courses\n\n— ${bizName}`);

    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── COURSE: Auto-completion email ──
router.post("/courses/complete", auth, async (req, res) => {
  try {
    const { courseId, studentEmail, studentName, courseName } = req.body;
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(getDb(), req.userId);
    const bizName = site?.name || "Academy";

    await autoEmail(req.userId, studentEmail, `Congratulations! You completed ${courseName}! 🎉`,
      `<h2>Course Complete! 🎉🎓</h2>
      <p>Hi ${studentName || "there"},</p>
      <p>Amazing work — you've completed <strong>${courseName}</strong> at ${bizName}!</p>
      <div style="text-align:center;margin:20px 0;padding:24px;background:linear-gradient(135deg,#F7F5FF,#FFF5F5);border-radius:12px">
        <div style="font-size:48px;margin-bottom:8px">🏆</div>
        <div style="font-family:serif;font-size:20px;font-weight:700">Certificate of Completion</div>
        <div style="font-size:14px;color:#666;margin-top:8px">${studentName || "Student"} — ${courseName}</div>
        <div style="font-size:12px;color:#999;margin-top:4px">${new Date().toLocaleDateString()}</div>
      </div>
      <p style="text-align:center"><a href="${BACKEND_URL || "http://localhost:4000"}/api/features/student/my-courses" style="color:#2563EB;font-weight:600">View your completed course →</a></p>
      <p>What's next? Check out our other courses or share your achievement on social media!</p>`);

    notifyOwner(req.userId, "🏆", `${studentName || studentEmail} completed ${courseName}!`);
    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── CONTRACT: Auto signed confirmation to sender ──
router.post("/contracts/:id/signed-notify", auth, async (req, res) => {
  try {
    const db = getDb();
    // Ownership required — only the contract owner can call this
    const contract = db.prepare("SELECT * FROM contracts WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!contract) return res.status(404).json({ error: "Not found" });

    const owner = db.prepare("SELECT email, name FROM users WHERE id = ?").get(contract.user_id || req.userId);
    if (owner?.email) {
      await autoEmail(req.userId, owner.email, `Contract signed — ${String(contract.title || "Agreement").replace(/[\r\n]/g,"")}`,
        `<h2>Contract Signed! ✅</h2>
        <p>Great news — <strong>${contract.signer_name || "the client"}</strong> has signed your contract: <strong>${esc(contract.title || "Agreement")}</strong>.</p>
        <p>Signed at: ${new Date().toLocaleString()}</p>
        <p>You can download the signed PDF from your TAKEOVA dashboard.</p>`);
    }
    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── FORM: Auto-notify owner + auto-respond to submitter ──
router.post("/forms/submission-notify", formNotifyLimiter, async (req, res) => {
  try {
    const { siteId, formName, submitterEmail, submitterName, fields } = req.body;
    if (submitterEmail && (!_CART_EMAIL_RE.test(submitterEmail) || submitterEmail.length > 254)) {
      return res.status(400).json({ error: "Invalid email" });
    }
    const db = getDb();
    const site = db.prepare("SELECT user_id, name FROM sites WHERE id = ?").get(siteId);
    if (!site) return res.json({ success: false });

    // Auto-enroll in "Form submitted" funnels
    if (submitterEmail) { try { const { autoEnrollInFunnels } = require("./email"); autoEnrollInFunnels(db, site.user_id, "Form submitted", submitterEmail, submitterName || ""); } catch(e) {} }

    const bizName = site.name || "Business";
    const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(site.user_id);
    const fieldsHtml = Object.entries(fields || {}).map(([k,v]) => `<tr><td style="padding:8px;font-weight:600;color:#333">${esc(k)}</td><td style="padding:8px;color:#555">${esc(String(v))}</td></tr>`).join("");

    // Notify owner
    if (owner?.email) {
      await autoEmail(site.user_id, owner.email, `New ${formName || "form"} submission from ${submitterName || submitterEmail || "visitor"}`,
        `<h2>New Form Submission 📋</h2>
        <p>Someone just submitted your <strong>${esc(formName || "contact form")}</strong> on ${bizName}.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f7f8fa;border-radius:8px">${fieldsHtml}</table>
        <p style="font-size:13px;color:#666">View all submissions in your TAKEOVA dashboard → Forms tab.</p>`);
    }

    // Auto-respond to submitter
    if (submitterEmail) {
      await autoEmail(site.user_id, submitterEmail, `Thanks for reaching out to ${bizName}!`,
        `<p>Hi ${esc(submitterName || "there")},</p>
        <p>Thanks for contacting <strong>${esc(bizName)}</strong>. We received your message and will get back to you soon.</p>
        <p style="color:#666;font-size:13px">This is an automated response — a real person will follow up shortly.</p>`);
    }

    notifyOwner(site.user_id, "📋", `New form submission: ${submitterName || submitterEmail || "visitor"} — ${formName || "contact form"}`);

    // Store the submission so it appears in the Forms tab (ensure a forms row for the JOIN)
    try {
      const formKey = (formName || "Contact Form");
      let formRow = db.prepare("SELECT id, form_id FROM forms WHERE site_id = ? AND title = ?").get(siteId, formKey);
      if (!formRow) {
        const newFormId = uuid();
        db.prepare("INSERT INTO forms (id, site_id, user_id, form_id, title, submissions) VALUES (?, ?, ?, ?, ?, 0)")
          .run(newFormId, siteId, site.user_id, newFormId, formKey);
        formRow = { id: newFormId, form_id: newFormId };
      }
      db.prepare("INSERT INTO form_submissions (site_id, form_id, data, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run(siteId, formRow.form_id || formRow.id, JSON.stringify(fields || { email: submitterEmail, name: submitterName }), (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').toString().slice(0, 60), (req.headers['user-agent'] || '').toString().slice(0, 200));
      db.prepare("UPDATE forms SET submissions = COALESCE(submissions,0) + 1 WHERE id = ?").run(formRow.id);
    } catch(e) { console.error("[/forms/submission-notify] store:", e.message || e); }

    // FIX: Save form submitter as contact/lead in CRM
    if (submitterEmail) {
      try {
        const existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(site.user_id, submitterEmail.toLowerCase());
        if (!existing) {
          db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, status, source, tags_json, created_at, last_activity) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))")
            .run(uuid(), site.user_id, submitterName || submitterEmail.split("@")[0], submitterEmail.toLowerCase(), fields?.phone || "", "lead", "form:" + (formName || "contact"), JSON.stringify([formName || "form_submission"]));
        } else {
          db.prepare("UPDATE contacts SET last_activity = datetime('now') WHERE id = ?").run(existing.id);
        }
      } catch(e) { console.error("[/forms/submission-notify]", e.message || e); }
    }

    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── MEMBERSHIP: Welcome + cancel emails ──
router.post("/memberships/activated", auth, async (req, res) => {
  try {
    const { customerEmail, customerName, membershipName, perks, membershipId, expiresAt } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const bizName = site?.name || "Business";

    // Record enrollment so customer portal can display active memberships
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS membership_enrollments (
        id TEXT PRIMARY KEY, membership_id TEXT, user_id TEXT, customer_email TEXT,
        customer_name TEXT, status TEXT DEFAULT 'active',
        started_at TEXT DEFAULT (datetime('now')), expires_at TEXT,
        expiry_warned TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      try { db.exec("ALTER TABLE membership_enrollments ADD COLUMN expiry_warned TEXT"); } catch(e) {}
      const mId = membershipId || db.prepare("SELECT id FROM membership_tiers WHERE user_id = ? AND name = ? LIMIT 1").get(req.userId, membershipName)?.id || null;
      db.prepare("INSERT OR REPLACE INTO membership_enrollments (id, membership_id, user_id, customer_email, customer_name, status, expires_at) VALUES (?,?,?,?,?,?,?)")
        .run(require("uuid").v4(), mId, req.userId, customerEmail, customerName || "", "active", expiresAt || null);
    } catch(e) {}

    await autoEmail(req.userId, customerEmail, `Welcome to ${membershipName}! \u{1F451}`,
      `<h2>Welcome, ${membershipName} Member! 👑</h2>
      <p>Hi ${esc(customerName || "there")},</p>
      <p>Your <strong>${membershipName}</strong> membership at ${bizName} is now active.</p>
      ${perks ? `<div style="background:#f7f8fa;padding:16px;border-radius:8px;margin:16px 0"><strong>Your perks:</strong><br>${perks}</div>` : ""}
      <p>Log in to access your exclusive content and benefits.</p>`);

    notifyOwner(req.userId, "👑", `New member: ${customerName || customerEmail} joined ${membershipName}`);
    fireAutomation(req.userId, "new_member", { email: customerEmail, name: customerName || "", membershipName, membershipId: membershipId || "" });
    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

router.post("/memberships/cancelled", auth, async (req, res) => {
  try {
    const { customerEmail, customerName, membershipName } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);

    // Update enrollment record to cancelled
    try {
      db.prepare("UPDATE membership_enrollments SET status = 'cancelled' WHERE user_id = ? AND customer_email = ? AND status = 'active'")
        .run(req.userId, customerEmail);
    } catch(e) {}

    await autoEmail(req.userId, customerEmail, `Your ${membershipName} membership`,
      `<p>Hi ${esc(customerName || "there")},</p>
      <p>Your <strong>${membershipName}</strong> membership has been cancelled. You'll retain access until the end of your current billing period.</p>
      <p>We'd love to have you back anytime. If there's anything we could do better, just reply to this email.</p>`);

    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── REVIEW REQUEST: Auto-send 3 days after delivery ──
// This is called by the cron or triggered after order delivery
router.post("/reviews/request", auth, async (req, res) => {
  try {
    const { customerEmail, customerName, productName, orderId } = req.body;
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(getDb(), req.userId);
    const bizName = site?.name || "Store";

    await autoEmail(req.userId, customerEmail, `How was your experience with ${bizName}? ⭐`,
      `<p>Hi ${esc(customerName || "there")},</p>
      <p>You recently purchased <strong>${productName || "from us"}</strong>. We'd love to hear what you think!</p>
      <div style="text-align:center;margin:20px 0">
        <p style="font-size:32px;letter-spacing:8px">⭐⭐⭐⭐⭐</p>
        <p style="color:#666;font-size:13px">How would you rate your experience?</p>
      </div>
      <p style="color:#666;font-size:13px">Just reply to this email with your rating (1-5 stars) and a quick comment. It means a lot to us!</p>`);

    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── SALE NOTIFICATION: Notify owner of new sale ──
// Called from webhook in server.js
async function notifyOwnerOfSale(userId, orderNumber, customerName, total, items) {
  const db = getDb();
  const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(userId);
  if (!owner?.email) return;
  const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(userId);
  const bizName = site?.name || "Store";

  await autoEmail(userId, owner.email, `💰 New sale — #${orderNumber} ($${total.toFixed(2)})`,
    `<h2>New Sale! 💰</h2>
    <p><strong>${esc(customerName || "A customer")}</strong> just purchased from ${bizName}.</p>
    <div style="background:#DCFCE7;padding:16px;border-radius:8px;margin:16px 0;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#16a34a">$${total.toFixed(2)}</div>
      <div style="font-size:12px;color:#166534">Order #${orderNumber}</div>
    </div>
    <p style="font-size:13px;color:#666">${(items||[]).map(i => i.name + " × " + (i.quantity||1)).join(", ")}</p>
    <p>View the order in your TAKEOVA dashboard → Orders tab.</p>`);

  notifyOwner(userId, "💰", `New sale: $${total.toFixed(2)} — #${orderNumber} from ${customerName || "customer"}`);
}

module.exports.notifyOwnerOfSale = notifyOwnerOfSale;
module.exports.autoEmail = autoEmail;
module.exports.notifyOwner = notifyOwner;

// ═══════════════════════════════════════════════════════════
// PHASE 2 FEATURES — ALL 11
// ═══════════════════════════════════════════════════════════

// ── 1. BUSINESS HOURS / AVAILABILITY ──
router.get("/availability", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS availability (id TEXT PRIMARY KEY, user_id TEXT UNIQUE, timezone TEXT DEFAULT 'America/New_York', hours TEXT DEFAULT '{\"mon\":{\"open\":\"09:00\",\"close\":\"17:00\",\"enabled\":true},\"tue\":{\"open\":\"09:00\",\"close\":\"17:00\",\"enabled\":true},\"wed\":{\"open\":\"09:00\",\"close\":\"17:00\",\"enabled\":true},\"thu\":{\"open\":\"09:00\",\"close\":\"17:00\",\"enabled\":true},\"fri\":{\"open\":\"09:00\",\"close\":\"17:00\",\"enabled\":true},\"sat\":{\"open\":\"10:00\",\"close\":\"14:00\",\"enabled\":false},\"sun\":{\"open\":\"00:00\",\"close\":\"00:00\",\"enabled\":false}}', blocked_dates TEXT DEFAULT '[]', buffer_minutes INTEGER DEFAULT 15, slot_duration INTEGER DEFAULT 60, max_advance_days INTEGER DEFAULT 30)");
  let config = db.prepare("SELECT * FROM availability WHERE user_id = ?").get(req.userId);
  if (!config) {
    db.prepare("INSERT INTO availability (id, user_id) VALUES (?,?)").run(uuid(), req.userId);
    config = db.prepare("SELECT * FROM availability WHERE user_id = ?").get(req.userId);
  }
  res.json({ ...config, hours: JSON.parse(config.hours || "{}"), blocked_dates: JSON.parse(config.blocked_dates || "[]") });
});

router.put("/availability", auth, (req, res) => {
  const db = getDb();
  const { timezone, hours, blocked_dates, buffer_minutes, slot_duration, max_advance_days } = req.body;
  db.prepare("UPDATE availability SET timezone=?, hours=?, blocked_dates=?, buffer_minutes=?, slot_duration=?, max_advance_days=? WHERE user_id=?")
    .run(timezone || "America/New_York", JSON.stringify(hours || {}), JSON.stringify(blocked_dates || []), buffer_minutes ?? 15, slot_duration ?? 60, max_advance_days ?? 30, req.userId);
  res.json({ success: true });
});

// Public: get available slots for a date
router.get("/availability/slots/:userId/:date", (req, res) => {
  const db = getDb();
  try {
    const config = db.prepare("SELECT * FROM availability WHERE user_id = ?").get(req.params.userId);
    if (!config) return res.json({ slots: [] });
    const hours = JSON.parse(config.hours || "{}");
    const blocked = JSON.parse(config.blocked_dates || "[]");
    const date = req.params.date; // YYYY-MM-DD
    if (blocked.includes(date)) return res.json({ slots: [], blocked: true });

    const dayNames = ["sun","mon","tue","wed","thu","fri","sat"];
    const dayName = dayNames[new Date(date).getDay()];
    const dayHours = hours[dayName];
    if (!dayHours?.enabled) return res.json({ slots: [], closed: true });

    // Get existing bookings for this date
    db.exec("CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, user_id TEXT, customer_email TEXT, customer_name TEXT, customer_phone TEXT, service TEXT, date TEXT, time TEXT, duration INTEGER, location TEXT, price REAL, status TEXT DEFAULT 'confirmed', created_at TEXT DEFAULT (datetime('now')))");
    const booked = db.prepare("SELECT time, duration FROM bookings WHERE user_id = ? AND date = ? AND status != 'cancelled'").all(req.params.userId, date);
    const bookedSlots = new Set();
    for (const b of booked) {
      const [h, m] = b.time.split(":").map(Number);
      const start = h * 60 + m;
      for (let t = start; t < start + (b.duration || config.slot_duration); t += config.slot_duration) {
        bookedSlots.add(t);
      }
    }

    // Generate available slots
    const [openH, openM] = dayHours.open.split(":").map(Number);
    const [closeH, closeM] = dayHours.close.split(":").map(Number);
    const openMin = openH * 60 + openM;
    const closeMin = closeH * 60 + closeM;
    const slotDur = config.slot_duration || 60;
    const buffer = config.buffer_minutes || 0;
    const slots = [];

    for (let t = openMin; t + slotDur <= closeMin; t += slotDur + buffer) {
      if (!bookedSlots.has(t)) {
        const hh = String(Math.floor(t / 60)).padStart(2, "0");
        const mm = String(t % 60).padStart(2, "0");
        slots.push(`${hh}:${mm}`);
      }
    }
    res.json({ slots, timezone: config.timezone });
  } catch(e) { res.json({ slots: [] }); }
});

// ── 2. CALENDAR VIEW OF BOOKINGS ──
router.get("/bookings/calendar", auth, (req, res) => {
  const db = getDb();
  const { month, year } = req.query; // ?month=3&year=2026
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year) || new Date().getFullYear();
  const startDate = `${y}-${String(m).padStart(2, "0")}-01`;
  const endDate = `${y}-${String(m).padStart(2, "0")}-31`;

  try { db.exec("ALTER TABLE bookings ADD COLUMN customer_phone TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bookings ADD COLUMN service TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bookings ADD COLUMN location TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bookings ADD COLUMN price REAL DEFAULT 0"); } catch(e) {}
  db.exec("CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, user_id TEXT, customer_email TEXT, customer_name TEXT, customer_phone TEXT, service TEXT, date TEXT, time TEXT, duration INTEGER, location TEXT, price REAL, status TEXT DEFAULT 'confirmed', created_at TEXT DEFAULT (datetime('now')))");
  const bookings = db.prepare("SELECT * FROM bookings WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, time").all(req.userId, startDate, endDate);
  res.json({ bookings, month: m, year: y });
});

// ── 3. PRODUCT VARIANTS ──
router.put("/products/:id/variants", auth, (req, res) => {
  const db = getDb();
  const { variants } = req.body; // [{name:"Size", options:["S","M","L","XL"]}, {name:"Color", options:["Black","White","Red"]}]
  db.exec("ALTER TABLE products ADD COLUMN variants TEXT DEFAULT '[]'").catch ? null : null;
  try { db.exec("ALTER TABLE products ADD COLUMN variants TEXT DEFAULT '[]'"); } catch(e) {}
  db.prepare("UPDATE products SET variants = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(variants || []), req.params.id, req.userId);
  res.json({ success: true });
});

router.get("/products/:id/variants", auth, (req, res) => {
  const db = getDb();
  const product = db.prepare("SELECT variants FROM products WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  res.json({ variants: JSON.parse(product?.variants || "[]") });
});

// ── 4. INVENTORY TRACKING + LOW STOCK ALERTS ──
router.put("/products/:id/inventory", auth, (req, res) => {
  const db = getDb();
  const { stock, low_stock_threshold, track_inventory } = req.body;
  try { db.exec("ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT 999"); } catch(e) {}
  try { db.exec("ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER DEFAULT 10"); } catch(e) {}
  try { db.exec("ALTER TABLE products ADD COLUMN track_inventory INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE products ADD COLUMN track_inventory INTEGER DEFAULT 0"); } catch(e) {}
  db.prepare("UPDATE products SET stock = ?, low_stock_threshold = ?, track_inventory = ? WHERE id = ? AND user_id = ?")
    .run(stock ?? 999, low_stock_threshold ?? 10, track_inventory ? 1 : 0, req.params.id, req.userId);
  res.json({ success: true });
});

router.get("/products/low-stock", auth, (req, res) => {
  const db = getDb();
  try {
    const products = db.prepare("SELECT id, name, stock, low_stock_threshold FROM products WHERE user_id = ? AND track_inventory = 1 AND stock <= low_stock_threshold").all(req.userId);
    res.json({ products });
  } catch(e) { res.json({ products: [] }); }
});

// Decrement stock on purchase (called from webhook)
function decrementStock(db, userId, items) {
  try {
    for (const item of items) {
      db.prepare("UPDATE products SET stock = MAX(0, stock - ?) WHERE user_id = ? AND name = ? AND track_inventory = 1").run(item.quantity || 1, userId, item.name);
    }
    // Check for low stock and notify
    const lowStock = db.prepare("SELECT name, stock, low_stock_threshold FROM products WHERE user_id = ? AND track_inventory = 1 AND stock <= low_stock_threshold AND stock > 0").all(userId);
    const outOfStock = db.prepare("SELECT name FROM products WHERE user_id = ? AND track_inventory = 1 AND stock <= 0").all(userId);
    for (const p of lowStock) {
      notifyOwner(userId, "⚠️", `Low stock: ${p.name} — only ${p.stock} left`);
    }
    for (const p of outOfStock) {
      notifyOwner(userId, "🚫", `OUT OF STOCK: ${p.name}`);
    }
  } catch(e) { console.error("[/products/low-stock]", e.message || e); }
}
module.exports.decrementStock = decrementStock;

// ── 5. DRIP CONTENT FOR COURSES ──
router.put("/courses/:courseId/drip", auth, (req, res) => {
  const db = getDb();
  const { drip_config } = req.body; // {enabled:true, modules:[{moduleId:"x", delay_days:0}, {moduleId:"y", delay_days:7}]}
  try { db.exec("ALTER TABLE courses ADD COLUMN drip_config TEXT DEFAULT '{}'"); } catch(e) {}
  const courseOwner = db.prepare("SELECT id FROM courses WHERE id = ? AND user_id = ?").get(req.params.courseId, req.userId);
  if (!courseOwner) return res.status(404).json({ error: "Course not found" });
  db.prepare("UPDATE courses SET drip_config = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(drip_config || {}), req.params.courseId, req.userId);
  res.json({ success: true });
});

router.get("/courses/:courseId/drip-access/:studentEmail", (req, res) => {
  const db = getDb();
  // Validate student session token
  const _sessionToken = req.query.token || req.headers.authorization?.replace("Bearer ", "");
  const _sessionEmail = req.params.studentEmail || req.query.email;
  if (!_sessionToken || !_sessionEmail) return res.status(401).json({ error: "Authentication required" });
  try {
    const _sess = db.prepare("SELECT email FROM student_sessions WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime('now'))").get(_sessionToken);
    if (!_sess || _sess.email !== _sessionEmail.toLowerCase()) return res.status(403).json({ error: "Forbidden" });
  } catch(e) { return res.status(403).json({ error: "Forbidden" }); }
  try {
    const course = db.prepare("SELECT drip_config FROM courses WHERE id = ?").get(req.params.courseId);
    const drip = JSON.parse(course?.drip_config || "{}");
    if (!drip.enabled) return res.json({ allUnlocked: true });

    const enrollment = db.prepare("SELECT created_at FROM enrollments WHERE course_id = ? AND student_email = ?").get(req.params.courseId, req.params.studentEmail);
    if (!enrollment) return res.json({ allUnlocked: false, unlocked: [] });

    const enrollDate = new Date(enrollment.created_at);
    const daysSince = Math.floor((Date.now() - enrollDate.getTime()) / (1000 * 60 * 60 * 24));
    const unlocked = (drip.modules || []).filter(m => (m.delay_days || 0) <= daysSince).map(m => m.moduleId);
    res.json({ allUnlocked: false, unlocked, daysSince });
  } catch(e) { res.json({ allUnlocked: true }); }
});

// ── 6. QUIZ / ASSESSMENT FOR COURSES ──
router.post("/courses/:courseId/quiz", auth, (req, res) => {
  const db = getDb();
  const { moduleId, lessonId, questions } = req.body; // questions: [{q:"What is...", options:["A","B","C","D"], correct:0, points:10}]
  db.exec("CREATE TABLE IF NOT EXISTS quizzes (id TEXT PRIMARY KEY, course_id TEXT, module_id TEXT, lesson_id TEXT, user_id TEXT, questions TEXT, pass_score INTEGER DEFAULT 70, created_at TEXT DEFAULT (datetime('now')))");
  const id = uuid();
  db.prepare("INSERT INTO quizzes (id, course_id, module_id, lesson_id, user_id, questions, pass_score) VALUES (?,?,?,?,?,?,?)")
    .run(id, req.params.courseId, moduleId || "", lessonId || "", req.userId, JSON.stringify(questions || []), req.body.pass_score || 70);
  res.json({ success: true, id });
});

router.post("/courses/quiz/:quizId/submit", async (req, res) => {
  try {
    const db = getDb();
    const { studentEmail, studentName, answers } = req.body; // answers: [0, 2, 1, 3] (selected option indices)
    const quiz = db.prepare("SELECT * FROM quizzes WHERE id = ?").get(req.params.quizId);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const questions = JSON.parse(quiz.questions || "[]");
    let totalPoints = 0, earnedPoints = 0;
    const results = questions.map((q, i) => {
      const pts = q.points || 10;
      totalPoints += pts;
      const correct = answers[i] === q.correct;
      if (correct) earnedPoints += pts;
      return { question: q.q, correct, selectedAnswer: q.options[answers[i]], correctAnswer: q.options[q.correct] };
    });

    const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    const passed = score >= (quiz.pass_score || 70);

    db.exec("CREATE TABLE IF NOT EXISTS quiz_attempts (id TEXT PRIMARY KEY, quiz_id TEXT, student_email TEXT, score INTEGER, passed INTEGER, answers TEXT, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO quiz_attempts (id, quiz_id, student_email, score, passed, answers) VALUES (?,?,?,?,?,?)")
      .run(uuid(), req.params.quizId, studentEmail, score, passed ? 1 : 0, JSON.stringify(answers));

    res.json({ score, passed, totalPoints, earnedPoints, results });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" }); }
});

// ── 7. INVOICE OVERDUE AUTO-REMINDERS ──
// Added to the hourly cron — checks for overdue invoices and sends reminders
async function processOverdueInvoices(db) {
  try {
    const overdue = db.prepare("SELECT i.*, u.id as owner_id FROM invoices i JOIN users u ON i.user_id = u.id WHERE i.status = 'sent' AND datetime(i.due_date) < datetime('now') AND i.reminder_sent IS NULL").all();
    for (const inv of overdue) {
      if (inv.client_email) {
        const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(inv.owner_id);
        const bizName = site?.name || "Business";
        await autoEmail(inv.owner_id, inv.client_email, `Invoice #${inv.number || inv.id} from ${bizName} is overdue`,
          (() => {
            let waBlock = "";
            try {
              const mc = db.prepare("SELECT wa_business_code,customer_mode_enabled FROM mine_control_config WHERE user_id=? AND enabled=1").get(inv.owner_id);
              const wn = (getSetting("WHATSAPP_BUSINESS_NUMBER") || process.env.WHATSAPP_BUSINESS_NUMBER || "").replace(/\D/g, "");
              if (mc?.wa_business_code && mc?.customer_mode_enabled && wn) {
                const wl = "https://wa.me/" + wn + "?text=" + encodeURIComponent("START-" + mc.wa_business_code);
                const qr = "https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=" + encodeURIComponent(wl);
                waBlock = "<div style=\"text-align:center;margin-top:20px;padding:16px;background:#f0fdf4;border-radius:8px;\"><p style=\"font-size:12px;color:#166534;font-weight:600;margin-bottom:8px;\">💬 Prefer WhatsApp? Scan to chat</p><a href=\"" + wl + "\"><img src=\"" + qr + "\" style=\"width:80px;height:80px;border-radius:6px;border:2px solid #25D366;\"/></a><p style=\"margin-top:8px;font-size:11px;\"><a href=\"" + wl + "\" style=\"color:#25D366;font-weight:600;text-decoration:none;\">Open WhatsApp →</a></p></div>";
              }
            } catch(e) {}
            return `<p>Hi ${esc(inv.client_name || "there")},</p>
          <p>This is a friendly reminder that invoice <strong>#${inv.number || inv.id}</strong> from ${bizName} for <strong>$${(inv.total || 0).toFixed(2)}</strong> was due on ${inv.due_date}.</p>
          ${inv.payment_link ? `<div style="text-align:center;margin:20px 0"><a href="${inv.payment_link}" style="display:inline-block;padding:14px 28px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Pay Now →</a></div>` : ""}
          <p style="color:#666;font-size:13px">If you've already paid, please disregard this message. Questions? Just reply to this email.</p>` + waBlock;
          })()
        );
        try { db.prepare("UPDATE invoices SET reminder_sent = datetime('now') WHERE id = ?").run(inv.id); } catch(e) { console.error("[/:quizId/submit]", e.message || e); }
        notifyOwner(inv.owner_id, "⏰", `Overdue reminder sent for invoice #${inv.number || inv.id} to ${inv.client_email}`);
        fireAutomation(inv.owner_id, "invoice_overdue", {
          email: inv.client_email, name: inv.client_name || "",
          amount: inv.total || 0, invoiceId: inv.id,
          invoiceNumber: inv.number || inv.id, dueDate: inv.due_date || ""
        });
      }
    }
    if (overdue.length > 0) console.log(`[CRON] Sent ${overdue.length} overdue invoice reminders`);
  } catch(e) { console.error("[/:quizId/submit]", e.message || e); }
}
module.exports.processOverdueInvoices = processOverdueInvoices;

// ── 8. PAYMENT RECEIVED RECEIPT ──
router.post("/invoices/:id/paid", auth, async (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
    if (inv?.client_email) {
      const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
      const bizName = site?.name || "Business";
      await autoEmail(req.userId, inv.client_email, `Payment received — Invoice #${inv.number || inv.id} from ${bizName}`,
        `<h2>Payment Received! ✅</h2>
        <p>Hi ${esc(inv.client_name || "there")},</p>
        <p>We've received your payment of <strong>$${(inv.total || 0).toFixed(2)}</strong> for invoice <strong>#${inv.number || inv.id}</strong>.</p>
        <p>This serves as your receipt. Thank you for your business!</p>
        <div style="background:#DCFCE7;padding:16px;border-radius:8px;margin:16px 0;text-align:center">
          <div style="font-size:12px;color:#166534">PAID</div>
          <div style="font-size:24px;font-weight:800;color:#16a34a">$${(inv.total || 0).toFixed(2)}</div>
          <div style="font-size:11px;color:#166534">${new Date().toLocaleDateString()}</div>
        </div>`);
      notifyOwner(req.userId, "💰", `Payment received: $${(inv.total || 0).toFixed(2)} — Invoice #${inv.number || inv.id}`);

      fireAutomation(req.userId, "invoice_paid", { email: inv.client_email, name: inv.client_name || "", amount: inv.total || 0, invoiceId: inv.id, invoiceNumber: inv.number || inv.id });

      // FIX: Record invoice payment to accounting
      try {
        recordTransaction(db, req.userId, "income", inv.total || 0, "Service Revenue", `Invoice #${inv.number || inv.id} paid by ${inv.client_name || inv.client_email}`, "invoice", inv.id, new Date().toISOString().split("T")[0]);
      } catch(e) {}

      // FIX: Update contact status to customer
      try {
        if (inv.client_email) {
          db.prepare("UPDATE contacts SET status = 'customer', last_activity = datetime('now') WHERE user_id = ? AND email = ? AND status != 'customer'").run(req.userId, inv.client_email.toLowerCase());
        }
      } catch(e) { console.error("[/:id/paid]", e.message || e); }
    }
    // ── Intelligence: log invoice_paid event ───────────────────────────
    try {
      const { logEvent } = require("./intelligence");
      logEvent(db, req.userId, "invoice_paid", { amount: Math.round(inv?.total || 0) });
    } catch(e) {}
    res.json({ success: true });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 9. EMAIL OPEN/CLICK TRACKING ──
// Tracking pixel endpoint
router.get("/track/open/:trackId", (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_tracking (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, track_id TEXT UNIQUE, opened INTEGER DEFAULT 0, opened_at TEXT, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("UPDATE email_tracking SET opened = 1, opened_at = COALESCE(opened_at, datetime('now')) WHERE track_id = ?").run(req.params.trackId);
  } catch(e) {}
  // Return 1x1 transparent pixel
  const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.writeHead(200, { "Content-Type": "image/gif", "Content-Length": pixel.length, "Cache-Control": "no-store" });
  res.end(pixel);
});

// Click tracking redirect
router.get("/track/click/:trackId", (req, res) => {
  const db = getDb();
  const url = req.query.url;
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_tracking (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, track_id TEXT UNIQUE, opened INTEGER DEFAULT 0, opened_at TEXT, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("UPDATE email_tracking SET clicks = clicks + 1 WHERE track_id = ?").run(req.params.trackId);
  } catch(e) {}
  // Validate URL to prevent open redirect phishing (only allow same-origin or absolute https)
  let safeRedirect = "/";
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        safeRedirect = parsed.href;
      }
    } catch(e) {
      // relative path
      if (url.startsWith("/") && !url.startsWith("//")) safeRedirect = url;
    }
  }
  res.redirect(safeRedirect);
});

// Get email analytics
router.get("/email-analytics", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_tracking (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, track_id TEXT UNIQUE, opened INTEGER DEFAULT 0, opened_at TEXT, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    const stats = db.prepare("SELECT COUNT(*) as total, SUM(opened) as opened, SUM(CASE WHEN clicks > 0 THEN 1 ELSE 0 END) as clicked FROM email_tracking WHERE user_id = ?").get(req.userId);
    const recent = db.prepare("SELECT email, subject, opened, clicks, created_at, opened_at FROM email_tracking WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);
    const openRate = stats.total > 0 ? Math.round((stats.opened / stats.total) * 100) : 0;
    const clickRate = stats.total > 0 ? Math.round((stats.clicked / stats.total) * 100) : 0;
    res.json({ total: stats.total, opened: stats.opened, clicked: stats.clicked, openRate, clickRate, recent });
  } catch(e) { res.json({ total: 0, opened: 0, clicked: 0, openRate: 0, clickRate: 0, recent: [] }); }
});

// ── 10. BROADCAST EMAIL ──
router.post("/email/broadcast", auth, async (req, res) => {
  try {
    const { subject, body, segment, tags } = req.body; // segment: "all", "leads", "customers", or filter by tags
    const db2 = getDb();
    const userLimits = db2.prepare("SELECT email_limit, email_used FROM users WHERE id = ?").get(req.userId);
    const emailsLeft = (userLimits?.email_limit || 500) - (userLimits?.email_used || 0);
    if (emailsLeft <= 0) return res.status(429).json({ error: "Monthly email limit reached. Upgrade your plan for more." });
    if (!subject || !body) return res.status(400).json({ error: "Subject and body required" });

    // Enforce monthly email limit — prevent plan overuse
    try {
      const u = db.prepare("SELECT email_limit, emails_sent_this_month FROM users WHERE id = ?").get(req.userId);
      const limit = u?.email_limit || 500;
      const used  = u?.emails_sent_this_month || 0;
      if (used >= limit) {
        return res.status(429).json({ error: `Monthly email limit reached (${limit} emails). Upgrade your plan for more.` });
      }
    } catch(e) { console.error("[/email/broadcast]", e.message || e); }

    const db = getDb();
    let contacts;
    if (segment === "customers") {
      contacts = db.prepare("SELECT DISTINCT email, name FROM contacts WHERE user_id = ? AND status = 'customer' AND email LIKE '%@%'").all(req.userId);
    } else if (segment === "leads") {
      contacts = db.prepare("SELECT DISTINCT email, name FROM contacts WHERE user_id = ? AND status = 'lead' AND email LIKE '%@%'").all(req.userId);
    } else if (tags && tags.length > 0) {
      contacts = db.prepare("SELECT DISTINCT email, name FROM contacts WHERE user_id = ? AND email LIKE '%@%'").all(req.userId);
      contacts = contacts.filter(c => {
        try { const t = JSON.parse(c.tags_json || "[]"); return tags.some(tag => t.includes(tag)); } catch(e) { return false; }
      });
    } else {
      contacts = db.prepare("SELECT DISTINCT email, name FROM contacts WHERE user_id = ? AND email LIKE '%@%'").all(req.userId);
    }

    // Also add customer_accounts
    try {
      const customers = db.prepare("SELECT DISTINCT email, name FROM customer_accounts WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?) AND email LIKE '%@%'").all(req.userId);
      const existingEmails = new Set(contacts.map(c => c.email.toLowerCase()));
      for (const c of customers) {
        if (!existingEmails.has(c.email.toLowerCase())) contacts.push(c);
      }
    } catch(e) {}

    // Filter out unsubscribed
    db.exec("CREATE TABLE IF NOT EXISTS email_unsubscribes (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, email))");
    const unsubscribed = new Set(db.prepare("SELECT email FROM email_unsubscribes WHERE user_id = ?").all(req.userId).map(u => u.email.toLowerCase()));
    contacts = contacts.filter(c => !unsubscribed.has(c.email.toLowerCase()));

    // Enforce email plan limits before sending
    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const usage = global.mineCheckUsage(db, req.userId, "emails");
      // blocked = feature fully off (cap===0). wouldBeOverage = at or over monthly limit.
      if (usage.blocked || (usage.wouldBeOverage && usage.remaining <= 0)) {
        return res.status(403).json({ error: "Monthly email limit reached. Upgrade your plan to send more.", cap: usage.cap, used: usage.used, upgrade: true });
      }
    }

    let sent = 0, failed = 0;
    const trackIds = [];

    for (const contact of contacts) {
      try {
        const trackId = uuid();
        db.exec("CREATE TABLE IF NOT EXISTS email_tracking (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, track_id TEXT UNIQUE, opened INTEGER DEFAULT 0, opened_at TEXT, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
        db.prepare("INSERT INTO email_tracking (id, user_id, email, subject, track_id) VALUES (?,?,?,?,?)").run(uuid(), req.userId, contact.email, subject, trackId);

        const backendUrl = BACKEND_URL || "http://localhost:4000";
        const trackPixel = `<img src="${backendUrl}/api/features/track/open/${trackId}" width="1" height="1" style="display:none" />`;
        const personalizedBody = body.replace(/\{\{name\}\}/g, contact.name || "there").replace(/\{\{email\}\}/g, contact.email);

        await autoEmail(req.userId, contact.email, subject.replace(/\{\{name\}\}/g, contact.name || "there"), personalizedBody + trackPixel);
        sent++;
        trackIds.push(trackId);
      } catch(e) { failed++; }
    }

    // Track actual emails sent against the monthly cap
    if (sent > 0 && typeof global !== "undefined" && global.mineTrackUsage) {
      global.mineTrackUsage(db, req.userId, "emails", sent);
    }

    notifyOwner(req.userId, "📧", `Broadcast sent: ${sent} delivered, ${failed} failed — "${subject}"`);
    // ── Intelligence: log email_campaign_sent event ────────────────────
    if (sent > 0) {
      try {
        const { logEvent } = require("./intelligence");
        logEvent(db, req.userId, "email_campaign_sent", { sent, subject: subject.slice(0, 80) });
      } catch(e) {}
    }
    res.json({ success: true, sent, failed, total: contacts.length });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 11. WEEKLY BUSINESS SUMMARY EMAIL ──
async function sendWeeklySummary(db) {
  try {
    const users = db.prepare("SELECT id, email, name, plan FROM users WHERE plan IS NOT NULL").all();
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    for (const user of users) {
      try {
        const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(user.id);
        const bizName = site?.name || "your business";

        // Gather stats
        const newOrders = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(total),0) as rev FROM orders WHERE user_id = ? AND created_at >= ?").get(user.id, oneWeekAgo) || { c: 0, rev: 0 };
        const newContacts = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND created_at >= ?").get(user.id, oneWeekAgo) || { c: 0 };
        const newBookings = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE user_id = ? AND created_at >= ?").get(user.id, oneWeekAgo) || { c: 0 };
        const emailsSent = db.prepare("SELECT COUNT(*) as c FROM email_tracking WHERE user_id = ? AND created_at >= ?").get(user.id, oneWeekAgo) || { c: 0 };

        let cryptoWeekly = 0;
        try { cryptoWeekly = db.prepare("SELECT COUNT(*) as c FROM crypto_orders WHERE user_id = ? AND status = 'confirmed' AND created_at >= ?").get(user.id, oneWeekAgo)?.c || 0; } catch(e) {}

        if (newOrders.c === 0 && newContacts.c === 0 && newBookings.c === 0) continue; // Skip if nothing happened

        await autoEmail(user.id, user.email, `Your week at ${bizName} — ${newOrders.c} orders, $${newOrders.rev.toFixed(0)} revenue`,
          `<h2>Your Weekly Summary 📊</h2>
          <p>Hi ${user.name?.split(" ")[0] || "there"}, here's how ${bizName} did this week:</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0">
            <div style="background:#DCFCE7;padding:16px;border-radius:10px;text-align:center"><div style="font-size:24px;font-weight:800;color:#16a34a">$${newOrders.rev.toFixed(0)}</div><div style="font-size:11px;color:#166534">Revenue</div></div>
            <div style="background:#DBEAFE;padding:16px;border-radius:10px;text-align:center"><div style="font-size:24px;font-weight:800;color:#1D4ED8">${newOrders.c}</div><div style="font-size:11px;color:#1D4ED8">Orders</div></div>
            <div style="background:#F3E8FF;padding:16px;border-radius:10px;text-align:center"><div style="font-size:24px;font-weight:800;color:#7C3AED">${newContacts.c}</div><div style="font-size:11px;color:#7C3AED">New Leads</div></div>
            <div style="background:#FEF3C7;padding:16px;border-radius:10px;text-align:center"><div style="font-size:24px;font-weight:800;color:#92400E">${newBookings.c}</div><div style="font-size:11px;color:#92400E">Bookings</div></div>
          </div>
          <p style="text-align:center"><a href="${FRONTEND_URL || "https://takeova.ai"}" style="display:inline-block;padding:12px 28px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Open Dashboard →</a></p>
          <p style="color:#666;font-size:12px;margin-top:16px">Keep building. Every week gets better. 🚀</p>
          ${cryptoWeekly > 0 ? `<div style="background:#0F172A;border-radius:10px;padding:14px;margin-top:16px;text-align:center;">
            <div style="font-size:12px;font-weight:700;color:#A5B4FC;margin-bottom:4px;">₿ You received ${cryptoWeekly} crypto payment${cryptoWeekly !== 1 ? "s" : ""} this week</div>
            <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:10px;">Swap privately with no KYC under $10k</div>
            <a href="${getSetting('VEIL_SWAP_URL') || 'https://veil.finance/swap'}" style="display:inline-block;padding:8px 20px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:12px;">Swap with Veil ↗</a>
          </div>` : ""}`);
      } catch(e) {}
    }
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════════

router.post("/push/subscribe", (req, res) => {
  const db = getDb(); ensureTables(db);
  const { subscription, siteId } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: "Invalid subscription" });
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, site_id TEXT, endpoint TEXT UNIQUE,
      auth TEXT, p256dh TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.prepare("INSERT OR IGNORE INTO push_subscriptions (id, site_id, endpoint, auth, p256dh) VALUES (?,?,?,?,?)")
      .run(require("uuid").v4(), siteId, subscription.endpoint,
        subscription.keys?.auth, subscription.keys?.p256dh);
    res.json({ success: true });
  } catch(e) { res.json({ success: true }); }
});

router.get("/push/stats", auth, (req, res) => {
  const db = getDb();
  const { siteId } = req.query;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, site_id TEXT, endpoint TEXT UNIQUE,
      auth TEXT, p256dh TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
    const count = siteId
      ? db.prepare("SELECT COUNT(*) as c FROM push_subscriptions WHERE site_id = ?").get(siteId)?.c || 0
      : db.prepare(`SELECT COUNT(*) as c FROM push_subscriptions WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?)`).get(req.userId)?.c || 0;
    res.json({ subscribers: count });
  } catch(e) { res.json({ subscribers: 0 }); }
});

router.post("/push/send", auth, async (req, res) => {
  const db = getDb();
  const { title, body, url, siteId } = req.body;
  if (!title || !body) return res.status(400).json({ error: "Title and body required" });
  try {
    const webpush = await import("web-push").catch(() => null);
    if (!webpush) return res.status(500).json({ error: "Push notifications not configured. Install web-push package." });

    const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidEmail   = process.env.VAPID_EMAIL || ("mailto:" + (process.env.EMAIL_FROM || "admin@takeova.ai"));

    if (!vapidPublic || !vapidPrivate) {
      return res.status(400).json({ error: "VAPID keys not configured in .env" });
    }

    webpush.default.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate);

    const subs = siteId
      ? db.prepare("SELECT * FROM push_subscriptions WHERE site_id = ?").all(siteId)
      : db.prepare(`SELECT * FROM push_subscriptions WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?)`).all(req.userId);

    const payload = JSON.stringify({ title, body, url: url || "/" });
    let sent = 0, failed = 0;
    for (const sub of subs) {
      try {
        await webpush.default.sendNotification(
          { endpoint: sub.endpoint, keys: { auth: sub.auth, p256dh: sub.p256dh } },
          payload
        );
        sent++;
      } catch(e) {
        failed++;
        // Remove expired/invalid subscriptions
        if (e.statusCode === 410 || e.statusCode === 404) {
          db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
        }
      }
    }
    res.json({ success: true, sent, failed, total: subs.length });
  } catch(e) {
    console.error("[Push] Send error:", e.message);
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

module.exports.sendWeeklySummary = sendWeeklySummary;

// ═══════════════════════════════════════════════════════════
// ACCOUNTING SYSTEM — Where the AI Bookkeeper stores data
// ═══════════════════════════════════════════════════════════

function ensureAccountingTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    type TEXT NOT NULL, -- 'income' or 'expense'
    amount REAL NOT NULL,
    category TEXT DEFAULT 'uncategorised',
    description TEXT,
    source TEXT, -- 'stripe', 'manual', 'invoice', 'order', 'refund', 'subscription', 'ai_bookkeeper'
    reference_id TEXT, -- order_id, invoice_id, stripe_id, etc.
    date TEXT NOT NULL,
    reconciled INTEGER DEFAULT 0,
    flagged INTEGER DEFAULT 0,
    flag_reason TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS expense_categories (
    id TEXT PRIMARY KEY, user_id TEXT,
    name TEXT NOT NULL, icon TEXT DEFAULT '📁',
    budget_monthly REAL DEFAULT 0,
    color TEXT DEFAULT '#2563EB',
    UNIQUE(user_id, name)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS financial_reports (
    id TEXT PRIMARY KEY, user_id TEXT,
    type TEXT NOT NULL, -- 'pnl', 'cashflow', 'forecast', 'summary'
    period TEXT NOT NULL, -- '2026-03', '2026-Q1', '2026'
    data TEXT NOT NULL, -- JSON
    generated_by TEXT DEFAULT 'ai_bookkeeper',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tx_user_cat ON transactions(user_id, category)");
}

// Default categories
const DEFAULT_CATEGORIES = [
  { name: "Product Sales", icon: "🛒", color: "#22C55E" },
  { name: "Service Revenue", icon: "💼", color: "#3B82F6" },
  { name: "Course Sales", icon: "🎓", color: "#8B5CF6" },
  { name: "Membership Revenue", icon: "👑", color: "#F59E0B" },
  { name: "Subscription Revenue", icon: "🔄", color: "#06B6D4" },
  { name: "Advertising", icon: "📢", color: "#EF4444" },
  { name: "Software & Tools", icon: "💻", color: "#6366F1" },
  { name: "Shipping & Fulfilment", icon: "📦", color: "#F97316" },
  { name: "Payment Processing", icon: "💳", color: "#EC4899" },
  { name: "Office & Equipment", icon: "🏢", color: "#14B8A6" },
  { name: "Marketing", icon: "📣", color: "#E11D48" },
  { name: "Refunds", icon: "↩️", color: "#DC2626" },
  { name: "Other Income", icon: "💰", color: "#16A34A" },
  { name: "Other Expense", icon: "📁", color: "#6B7280" },
];

// ── GET all transactions ──
router.get("/accounting/transactions", auth, (req, res) => {
  const db = getDb(); ensureAccountingTables(db);
  const { month, year, type, category, limit } = req.query;
  let query = "SELECT * FROM transactions WHERE user_id = ?";
  const params = [req.userId];
  if (month && year) {
    query += " AND date LIKE ?";
    params.push(`${year}-${String(month).padStart(2, "0")}%`);
  } else if (year) {
    query += " AND date LIKE ?";
    params.push(`${year}%`);
  }
  if (type) { query += " AND type = ?"; params.push(type); }
  if (category) { query += " AND category = ?"; params.push(category); }
  query += " ORDER BY date DESC LIMIT ?";
  params.push(parseInt(limit) || 200);
  res.json({ transactions: db.prepare(query).all(...params) });
});

// ── ADD transaction (manual or from AI bookkeeper) ──
router.post("/accounting/transactions", auth, (req, res) => {
  const db = getDb(); ensureAccountingTables(db);
  const { type, amount, category, description, source, reference_id, date, notes } = req.body;
  if (!type || !amount) return res.status(400).json({ error: "Type and amount required" });
  const id = uuid();
  db.prepare("INSERT INTO transactions (id, user_id, type, amount, category, description, source, reference_id, date, notes) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, req.userId, type, Math.abs(amount), category || "uncategorised", description || "", source || "manual", reference_id || "", date || new Date().toISOString().split("T")[0], notes || "");
  res.json({ success: true, id });
});

// ── UPDATE transaction (categorise, reconcile, flag) ──
router.put("/accounting/transactions/:id", auth, (req, res) => {
  const db = getDb(); ensureAccountingTables(db);
  const { category, reconciled, flagged, flag_reason, notes } = req.body;
  const sets = [];
  const params = [];
  if (category !== undefined) { sets.push("category = ?"); params.push(category); }
  if (reconciled !== undefined) { sets.push("reconciled = ?"); params.push(reconciled ? 1 : 0); }
  if (flagged !== undefined) { sets.push("flagged = ?"); params.push(flagged ? 1 : 0); }
  if (flag_reason !== undefined) { sets.push("flag_reason = ?"); params.push(flag_reason); }
  if (notes !== undefined) { sets.push("notes = ?"); params.push(notes); }
  if (sets.length === 0) return res.json({ success: true });
  params.push(req.params.id, req.userId);
  db.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
  res.json({ success: true });
});

// ── GET expense categories ──
router.get("/accounting/categories", auth, (req, res) => {
  const db = getDb(); ensureAccountingTables(db);
  let cats = db.prepare("SELECT * FROM expense_categories WHERE user_id = ?").all(req.userId);
  if (cats.length === 0) {
    for (const c of DEFAULT_CATEGORIES) {
      db.prepare("INSERT OR IGNORE INTO expense_categories (id, user_id, name, icon, color) VALUES (?,?,?,?,?)").run(uuid(), req.userId, c.name, c.icon, c.color);
    }
    cats = db.prepare("SELECT * FROM expense_categories WHERE user_id = ?").all(req.userId);
  }
  res.json({ categories: cats });
});

// ── ADD/UPDATE category ──
router.post("/accounting/categories", auth, (req, res) => {
  const db = getDb(); ensureAccountingTables(db);
  const { name, icon, budget_monthly, color } = req.body;
  db.prepare("INSERT OR REPLACE INTO expense_categories (id, user_id, name, icon, budget_monthly, color) VALUES (?,?,?,?,?,?)")
    .run(uuid(), req.userId, name, icon || "📁", budget_monthly || 0, color || "#2563EB");
  res.json({ success: true });
});

// ── P&L REPORT ──
router.get("/accounting/pnl", auth, (req, res) => {
  const db = getDb(); ensureAccountingTables(db);
  const { month, year } = req.query;
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year) || new Date().getFullYear();
  const period = `${y}-${String(m).padStart(2, "0")}`;

  const income = db.prepare("SELECT category, SUM(amount) as total, COUNT(*) as count FROM transactions WHERE user_id = ? AND type = 'income' AND date LIKE ? GROUP BY category ORDER BY total DESC").all(req.userId, period + "%");
  const expenses = db.prepare("SELECT category, SUM(amount) as total, COUNT(*) as count FROM transactions WHERE user_id = ? AND type = 'expense' AND date LIKE ? GROUP BY category ORDER BY total DESC").all(req.userId, period + "%");
  const totalIncome = income.reduce((s, r) => s + r.total, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.total, 0);
  const netProfit = totalIncome - totalExpenses;
  const margin = totalIncome > 0 ? Math.round((netProfit / totalIncome) * 100) : 0;

  res.json({ period, income, expenses, totalIncome, totalExpenses, netProfit, margin });
});

// ── DASHBOARD SUMMARY ──
router.get("/accounting/summary", auth, (req, res) => {
  const db = getDb(); ensureAccountingTables(db);
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastMonth = now.getMonth() === 0 ? `${now.getFullYear() - 1}-12` : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;

  const thisIncome = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id = ? AND type = 'income' AND date LIKE ?").get(req.userId, thisMonth + "%").t;
  const thisExpenses = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id = ? AND type = 'expense' AND date LIKE ?").get(req.userId, thisMonth + "%").t;
  const lastIncome = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id = ? AND type = 'income' AND date LIKE ?").get(req.userId, lastMonth + "%").t;
  const lastExpenses = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id = ? AND type = 'expense' AND date LIKE ?").get(req.userId, lastMonth + "%").t;

  const uncategorised = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE user_id = ? AND category = 'uncategorised'").get(req.userId).c;
  const unreconciled = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE user_id = ? AND reconciled = 0").get(req.userId).c;
  const flagged = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE user_id = ? AND flagged = 1").get(req.userId).c;

  // Monthly trend (last 6 months)
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const inc = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id = ? AND type = 'income' AND date LIKE ?").get(req.userId, p + "%").t;
    const exp = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id = ? AND type = 'expense' AND date LIKE ?").get(req.userId, p + "%").t;
    trend.push({ period: p, income: inc, expenses: exp, profit: inc - exp });
  }

  res.json({
    thisMonth: { income: thisIncome, expenses: thisExpenses, profit: thisIncome - thisExpenses },
    lastMonth: { income: lastIncome, expenses: lastExpenses, profit: lastIncome - lastExpenses },
    incomeGrowth: lastIncome > 0 ? Math.round(((thisIncome - lastIncome) / lastIncome) * 100) : 0,
    uncategorised, unreconciled, flagged, trend
  });
});

// ── AUTO-RECORD: Called from webhook when order/payment comes in ──
function recordTransaction(db, userId, type, amount, category, description, source, referenceId, date) {
  try {
    ensureAccountingTables(db);
    db.prepare("INSERT INTO transactions (id, user_id, type, amount, category, description, source, reference_id, date) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(uuid(), userId, type, Math.abs(amount), category || "uncategorised", description || "", source || "auto", referenceId || "", date || new Date().toISOString().split("T")[0]);
  } catch(e) {}
}
module.exports.recordTransaction = recordTransaction;

// ── REVENUE FORECAST ──
router.get("/accounting/forecast", auth, (req, res) => {
  const db = getDb(); ensureAccountingTables(db);
  const now = new Date();

  // Get last 3 months of income
  const months = [];
  for (let i = 3; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const inc = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id = ? AND type = 'income' AND date LIKE ?").get(req.userId, p + "%").t;
    months.push(inc);
  }

  const avgGrowth = months.length >= 2 && months[0] > 0 ? ((months[months.length - 1] - months[0]) / months[0]) / months.length : 0.05;
  const lastMonth = months[months.length - 1] || 0;

  const forecast = [];
  let projected = lastMonth;
  for (let i = 0; i < 6; i++) {
    projected = projected * (1 + Math.max(avgGrowth, 0));
    const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
    forecast.push({ period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, projected: Math.round(projected) });
  }

  res.json({ forecast, avgGrowthRate: Math.round(avgGrowth * 100), lastThreeMonths: months });
});

// ═══════════════════════════════════════════════════════════
// FINAL DATA FLOW FIXES — 7 gaps
// ═══════════════════════════════════════════════════════════

// ── 1. PAGE VIEW / VISITOR TRACKING ──
// Lightweight tracking pixel injected into published sites
router.post("/track/pageview", (req, res) => {
  const { siteId, path, referrer, userAgent } = req.body;
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS page_views (id TEXT PRIMARY KEY, site_id TEXT, path TEXT, referrer TEXT, user_agent TEXT, ip TEXT, country TEXT, created_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pv_site_date ON page_views(site_id, created_at)");
  db.prepare("INSERT INTO page_views (id, site_id, path, referrer, user_agent, ip) VALUES (?,?,?,?,?,?)")
    .run(uuid(), siteId, path || "/", referrer || "", (userAgent || "").slice(0, 200), req.ip || "");
  res.json({ ok: true });
});


// ── MOBILE ANALYTICS SUMMARY ─────────────────────────────────────────────────
// GET /api/features/analytics/summary
// Returns unified stats for the mobile home screen dashboard
router.get("/analytics/summary", auth, (req, res) => {
  const db = getDb();
  try {
    // Get all sites for this user
    const sites = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(req.userId);
    const siteIds = sites.map(s => s.id);
    if (!siteIds.length) {
      return res.json({ revenue: 0, revenueGrowth: 0, orders: 0, ordersNew: 0, visitors: 0, sitesLive: 0 });
    }
    const ph = siteIds.map(() => "?").join(",");

    // Revenue today and yesterday (from orders table)
    let revenueToday = 0, revenueYesterday = 0, orders = 0, ordersNew = 0;
    try {
      const todayRow = db.prepare(
        "SELECT COALESCE(SUM(total),0) as rev, COUNT(*) as cnt FROM orders WHERE site_id IN (" + ph + ") AND date(created_at)=date('now') AND status NOT IN ('cancelled','refunded')"
      ).get(...siteIds);
      const yestRow = db.prepare(
        "SELECT COALESCE(SUM(total),0) as rev FROM orders WHERE site_id IN (" + ph + ") AND date(created_at)=date('now','-1 day') AND status NOT IN ('cancelled','refunded')"
      ).get(...siteIds);
      const weekRow = db.prepare(
        "SELECT COUNT(*) as cnt FROM orders WHERE site_id IN (" + ph + ") AND created_at >= datetime('now','-7 days') AND status NOT IN ('cancelled','refunded')"
      ).get(...siteIds);
      revenueToday    = Math.round((todayRow.rev || 0) * 100) / 100;
      revenueYesterday = Math.round((yestRow.rev || 0) * 100) / 100;
      orders          = weekRow.cnt || 0;
      ordersNew       = todayRow.cnt || 0;
    } catch(e) {}

    // Visitors today (from page_views)
    let visitors = 0;
    try {
      db.exec("CREATE TABLE IF NOT EXISTS page_views (id TEXT PRIMARY KEY, site_id TEXT, path TEXT, referrer TEXT, user_agent TEXT, ip TEXT, country TEXT, created_at TEXT DEFAULT (datetime('now')))");
      const vRow = db.prepare(
        "SELECT COUNT(DISTINCT ip) as c FROM page_views WHERE site_id IN (" + ph + ") AND date(created_at)=date('now')"
      ).get(...siteIds);
      visitors = vRow.c || 0;
    } catch(e) {}

    // Revenue growth % vs yesterday
    const revenueGrowth = revenueYesterday > 0
      ? Math.round(((revenueToday - revenueYesterday) / revenueYesterday) * 100)
      : revenueToday > 0 ? 100 : 0;

    // Sites live count
    const liveSites = db.prepare(
      "SELECT COUNT(*) as c FROM sites WHERE user_id = ? AND status IN ('published','live')"
    ).get(req.userId).c || 0;

    res.json({
      revenue:      revenueToday,
      revenueGrowth,
      orders,
      ordersNew,
      visitors,
      sitesLive:    liveSites,
    });
  } catch(e) {
    console.error("[analytics/summary]", e.message);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

router.get("/analytics/visitors", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS page_views (id TEXT PRIMARY KEY, site_id TEXT, path TEXT, referrer TEXT, user_agent TEXT, ip TEXT, country TEXT, created_at TEXT DEFAULT (datetime('now')))");
  const { siteId, days } = req.query;
  const d = parseInt(days) || 30;
  // If siteId is provided, verify the authenticated user owns it (IDOR prevention)
  let sId;
  if (siteId) {
    const siteOwned = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(siteId, req.userId);
    if (!siteOwned) return res.status(403).json({ error: "Access denied" });
    sId = siteId;
  } else {
    sId = db.prepare("SELECT id FROM sites WHERE user_id = ? LIMIT 1").get(req.userId)?.id;
  }
  if (!sId) return res.json({ total: 0, today: 0, unique: 0, pages: [], daily: [], referrers: [] });

  const total = db.prepare("SELECT COUNT(*) as c FROM page_views WHERE site_id = ? AND created_at >= datetime('now','-' || ? || ' days')").get(sId, d).c;
  const today = db.prepare("SELECT COUNT(*) as c FROM page_views WHERE site_id = ? AND date(created_at) = date('now')").get(sId).c;
  const unique = db.prepare("SELECT COUNT(DISTINCT ip) as c FROM page_views WHERE site_id = ? AND created_at >= datetime('now','-' || ? || ' days')").get(sId, d).c;
  const pages = db.prepare("SELECT path, COUNT(*) as views FROM page_views WHERE site_id = ? AND created_at >= datetime('now','-' || ? || ' days') GROUP BY path ORDER BY views DESC LIMIT 20").all(sId, d);
  const daily = db.prepare("SELECT date(created_at) as day, COUNT(*) as views FROM page_views WHERE site_id = ? AND created_at >= datetime('now','-' || ? || ' days') GROUP BY day ORDER BY day").all(sId, d);
  const referrers = db.prepare("SELECT referrer, COUNT(*) as c FROM page_views WHERE site_id = ? AND referrer != '' AND created_at >= datetime('now','-' || ? || ' days') GROUP BY referrer ORDER BY c DESC LIMIT 10").all(sId, d);

  res.json({ total, today, unique, pages, daily, referrers });
});

// ── 2. STUDENT LESSON PROGRESS ──
router.post("/courses/progress", (req, res) => {
  const { courseId, studentEmail, lessonId, moduleId, completed } = req.body;
  // Require valid student session — token must belong to the studentEmail being updated
  const sessionToken = req.headers.authorization?.replace("Bearer ", "") || req.body.token;
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS student_sessions (token TEXT PRIMARY KEY, email TEXT, created_at TEXT DEFAULT (datetime(\'now\')))");
    const session = db.prepare("SELECT email FROM student_sessions WHERE token = ?").get(sessionToken);
    if (!session || session.email !== studentEmail?.toLowerCase()) {
      return res.status(403).json({ error: "Authentication required to update progress" });
    }
  } catch(e) {
    return res.status(403).json({ error: "Authentication required" });
  }
  db.exec("CREATE TABLE IF NOT EXISTS lesson_progress (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, module_id TEXT, lesson_id TEXT, completed INTEGER DEFAULT 0, time_spent INTEGER DEFAULT 0, completed_at TEXT, created_at TEXT DEFAULT (datetime(\'now\')), UNIQUE(course_id, student_email, lesson_id))");

  db.prepare("INSERT OR REPLACE INTO lesson_progress (id, course_id, student_email, module_id, lesson_id, completed, completed_at) VALUES (?,?,?,?,?,?,?)")
    .run(uuid(), courseId, studentEmail.toLowerCase(), moduleId || "", lessonId, completed ? 1 : 0, completed ? new Date().toISOString() : null);

  res.json({ success: true });
});

router.get("/courses/:courseId/progress/:studentEmail", (req, res) => {
  const db = getDb();
  // Validate student session token
  const _sessionToken = req.query.token || req.headers.authorization?.replace("Bearer ", "");
  const _sessionEmail = req.params.studentEmail || req.query.email;
  if (!_sessionToken || !_sessionEmail) return res.status(401).json({ error: "Authentication required" });
  try {
    const _sess = db.prepare("SELECT email FROM student_sessions WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime('now'))").get(_sessionToken);
    if (!_sess || _sess.email !== _sessionEmail.toLowerCase()) return res.status(403).json({ error: "Forbidden" });
  } catch(e) { return res.status(403).json({ error: "Forbidden" }); }
  db.exec("CREATE TABLE IF NOT EXISTS lesson_progress (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, module_id TEXT, lesson_id TEXT, completed INTEGER DEFAULT 0, time_spent INTEGER DEFAULT 0, completed_at TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(course_id, student_email, lesson_id))");
  const progress = db.prepare("SELECT lesson_id, module_id, completed, completed_at FROM lesson_progress WHERE course_id = ? AND student_email = ?").all(req.params.courseId, req.params.studentEmail);
  const totalCompleted = progress.filter(p => p.completed).length;
  res.json({ progress, totalCompleted, totalLessons: progress.length });
});

router.get("/courses/:courseId/all-progress", auth, (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS lesson_progress (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, module_id TEXT, lesson_id TEXT, completed INTEGER DEFAULT 0, time_spent INTEGER DEFAULT 0, completed_at TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(course_id, student_email, lesson_id))");
  if (!db.prepare("SELECT id FROM courses WHERE id = ? AND user_id = ?").get(req.params.courseId, req.userId)) return res.status(404).json({ error: "course not found" });
  const students = db.prepare("SELECT student_email, COUNT(*) as total, SUM(completed) as done FROM lesson_progress WHERE course_id = ? GROUP BY student_email").all(req.params.courseId);
  res.json({ students: students.map(s => ({ email: s.student_email, total: s.total, completed: s.done, percent: s.total > 0 ? Math.round((s.done / s.total) * 100) : 0 })) });
});

// ── 3. UNIFIED CONTACT ACTIVITY (all interactions in one view) ──
router.get("/contacts/:email/activity", auth, (req, res) => {
  const db = getDb();
  const email = req.params.email.toLowerCase();
  const activity = [];

  // Orders
  try {
    const orders = db.prepare("SELECT order_number, total, status, created_at FROM orders WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 10").all(req.userId, email);
    for (const o of orders) activity.push({ type: "order", icon: "🛒", title: `Order #${o.order_number} — $${o.total?.toFixed(2)}`, status: o.status, date: o.created_at });
  } catch(e) {}

  // Bookings
  try {
    const bookings = db.prepare("SELECT service, date, time, status FROM bookings WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 10").all(req.userId, email);
    for (const b of bookings) activity.push({ type: "booking", icon: "📅", title: `Booking: ${b.service} on ${b.date}`, status: b.status, date: b.date });
  } catch(e) {}

  // Support tickets
  try {
    const tickets = db.prepare("SELECT subject, status, ai_replied, created_at FROM support_tickets WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 10").all(req.userId, email);
    for (const t of tickets) activity.push({ type: "ticket", icon: "🎫", title: `Ticket: ${t.subject}`, status: t.status + (t.ai_replied ? " (AI replied)" : ""), date: t.created_at });
  } catch(e) {}

  // Course enrollments
  try {
    const enrollments = db.prepare("SELECT c.name as course_name, e.created_at FROM enrollments e JOIN courses c ON e.course_id = c.id WHERE e.student_email = ? ORDER BY e.created_at DESC LIMIT 10").all(email);
    for (const en of enrollments) activity.push({ type: "course", icon: "🎓", title: `Enrolled: ${en.course_name}`, date: en.created_at });
  } catch(e) {}

  // Emails sent
  try {
    const emails = db.prepare("SELECT subject, opened, clicks, created_at FROM email_tracking WHERE user_id = ? AND email = ? ORDER BY created_at DESC LIMIT 10").all(req.userId, email);
    for (const em of emails) activity.push({ type: "email", icon: "📧", title: `Email: ${em.subject}`, status: em.opened ? "Opened" + (em.clicks > 0 ? ` + ${em.clicks} clicks` : "") : "Not opened", date: em.created_at });
  } catch(e) {}

  // Invoices
  try {
    const invoices = db.prepare("SELECT number, total, status FROM invoices WHERE user_id = ? AND client_email = ? ORDER BY created_at DESC LIMIT 10").all(req.userId, email);
    for (const inv of invoices) activity.push({ type: "invoice", icon: "💳", title: `Invoice #${inv.number || inv.id} — $${(inv.total || 0).toFixed(2)}`, status: inv.status, date: inv.created_at });
  } catch(e) {}

  // Loyalty
  try {
    const customer = db.prepare("SELECT loyalty_points, total_spent, order_count FROM customer_accounts WHERE email = ?").get(email);
    if (customer) activity.push({ type: "loyalty", icon: "⭐", title: `Loyalty: ${customer.loyalty_points} points · $${(customer.total_spent || 0).toFixed(2)} spent · ${customer.order_count || 0} orders`, date: "" });
  } catch(e) {}

  activity.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  res.json({ email, activity });
});

// ── 4. ACTUAL STRIPE REFUND ──
router.post("/orders/:id/refund-stripe", auth, async (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    try {
      const stripe = require("stripe")(require('../db/init').getDb().prepare('SELECT value FROM platform_settings WHERE key = ?').get('STRIPE_SECRET_KEY')?.value || process.env.STRIPE_SECRET_KEY);
      // Get the payment intent from the checkout session
      const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      if (!session?.payment_intent) return res.status(400).json({ error: "No payment found for this order" });

      // Validate refund amount: positive and not exceeding the order total. Omitted => full refund.
      let _refundAmt;
      if (req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== "") {
        const amt = Number(req.body.amount);
        if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "Refund amount must be a positive number" });
        const _ot = Number(order.total);
        if (Number.isFinite(_ot) && _ot > 0 && amt > _ot + 0.005) return res.status(400).json({ error: "Refund amount cannot exceed the order total of $" + _ot.toFixed(2) });
        _refundAmt = amt;
      }
      const refund = await stripe.refunds.create({
        payment_intent: session.payment_intent,
        amount: _refundAmt !== undefined ? Math.round(_refundAmt * 100) : undefined, // validated partial, or full
        reason: req.body.reason || "requested_by_customer",
      });

      const _isFull = _refundAmt === undefined || (Number.isFinite(Number(order.total)) && _refundAmt >= Number(order.total) - 0.005);
      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(_isFull ? "refunded" : "partially_refunded", order.id);

      // Record refund in accounting
      try {
        recordTransaction(db, req.userId, "expense", (refund.amount / 100), "Refunds", `Refund — Order #${order.order_number}`, "stripe", refund.id, new Date().toISOString().split("T")[0]);
      } catch(e) {}

      // Notify customer
      if (order.customer_email) {
        const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
        await autoEmail(req.userId, order.customer_email, `Refund processed — Order #${order.order_number}`,
          `<p>Hi ${esc(order.customer_name || "there")},</p>
          <p>Your refund of <strong>$${(refund.amount / 100).toFixed(2)}</strong> for order #${order.order_number} has been processed.</p>
          <p>It may take 5-10 business days to appear on your statement.</p>`);
      }

      notifyOwner(req.userId, "↩️", `Refund processed: $${(refund.amount / 100).toFixed(2)} — Order #${order.order_number}`);
      res.json({ success: true, refundId: refund.id, amount: refund.amount / 100 });
    } catch(e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 5. EMAIL BOUNCE TRACKING (SendGrid webhook) ──
router.post("/webhooks/sendgrid", (req, res) => {
  // Verify SendGrid webhook signature to prevent bounce-list poisoning
  const sgWebhookKey = process.env.SENDGRID_WEBHOOK_KEY;
  if (sgWebhookKey) {
    const crypto = require("crypto");
    const signature = req.headers["x-twilio-email-event-webhook-signature"] || "";
    const timestamp = req.headers["x-twilio-email-event-webhook-timestamp"] || "";
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const expected = crypto.createHmac("sha256", sgWebhookKey)
      .update(timestamp + rawBody).digest("base64");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(403).json({ error: "Invalid webhook signature" });
    }
  }
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS email_bounces (id TEXT PRIMARY KEY, email TEXT, type TEXT, reason TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(email))");
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
  const ALLOWED_EVENTS = new Set(["bounce", "dropped"]);
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) {
    if (ALLOWED_EVENTS.has(event.event) && event.email && EMAIL_RE.test(event.email) && event.email.length <= 320) {
      try {
        db.prepare("INSERT OR IGNORE INTO email_bounces (id, email, type, reason) VALUES (?,?,?,?)")
          .run(uuid(), event.email.toLowerCase(), event.event, String(event.reason || event.response || "").slice(0, 500));
      } catch(e) {}
    }
  }
  res.json({ ok: true });
});

// Check bounce before sending (used by autoEmail)
function isBounced(db, email) {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_bounces (id TEXT PRIMARY KEY, email TEXT, type TEXT, reason TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(email))");
    return !!db.prepare("SELECT id FROM email_bounces WHERE email = ?").get(email?.toLowerCase());
  } catch(e) { return false; }
}
module.exports.isBounced = isBounced;

// ── 6. CUSTOMER SELF-SERVICE BOOKING CANCEL/RESCHEDULE ──
router.get("/bookings/manage/:bookingId", (req, res) => {
  const db = getDb();
  const booking = db.prepare("SELECT b.*, s.name as biz_name FROM bookings b LEFT JOIN sites s ON s.user_id = b.user_id WHERE b.id = ?").get(req.params.bookingId);
  if (!booking) return res.status(404).send("<h1>Booking not found</h1>");
  const bizName = booking.biz_name || "Business";

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manage Booking — ${esc(bizName)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8f8f8;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px;max-width:440px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:20px;margin-bottom:16px}h2{font-size:16px;margin-bottom:8px}
.info{background:#f7f8fa;padding:16px;border-radius:10px;margin-bottom:20px;font-size:14px;line-height:1.8}
.btn{display:inline-block;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:inherit;margin-right:8px;margin-bottom:8px}
.btn-cancel{background:#FEE2E2;color:#DC2626}.btn-reschedule{background:#DBEAFE;color:#1D4ED8}
.status{display:inline-block;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:600}
.confirmed{background:#DCFCE7;color:#166534}.cancelled{background:#FEE2E2;color:#991B1B}
.msg{padding:16px;border-radius:10px;margin-top:16px;font-size:14px;text-align:center}
</style></head><body>
<div class="card">
<h1>📅 Your Booking at ${esc(bizName)}</h1>
<span class="status ${["confirmed","cancelled","pending","rescheduled"].includes(booking.status)?booking.status:"pending"}">${esc(booking.status)}</span>
<div class="info" style="margin-top:12px">
<strong>Service:</strong> ${esc(booking.service)}<br>
<strong>Date:</strong> ${esc(booking.date)}<br>
<strong>Time:</strong> ${esc(booking.time)}${booking.duration ? " (" + booking.duration + " min)" : ""}<br>
${booking.location ? "<strong>Location:</strong> " + esc(booking.location) + "<br>" : ""}
</div>
${booking.status === "confirmed" ? `
<h2>Need to make changes?</h2>
<button class="btn btn-cancel" onclick="cancelBooking()">Cancel Booking</button>
<button class="btn btn-reschedule" onclick="alert('Please contact ' + ${JSON.stringify(bizName)} + ' to reschedule: reply to your confirmation email.')">Reschedule</button>
<div id="msg"></div>
<script>
async function cancelBooking(){
  if(!confirm('Are you sure you want to cancel this booking?'))return;
  const email=prompt('Please confirm your email address to cancel:');
  if(!email)return;
  const r=await fetch('/api/features/bookings/${booking.id}/cancel-self',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerEmail:email.trim()})});
  const d=await r.json();
  if(d.success){document.getElementById('msg').innerHTML='<div class="msg" style="background:#DCFCE7;color:#166534">Booking cancelled successfully. You will receive a confirmation email.</div>';setTimeout(()=>location.reload(),2000);}
  else document.getElementById('msg').innerHTML='<div class="msg" style="background:#FEE2E2;color:#991B1B">'+String(d.error||'An error occurred').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')+'</div>';
}
</script>` : booking.status === "cancelled" ? "<p style='color:#666;font-size:14px;margin-top:12px'>This booking has been cancelled.</p>" : ""}
<p style="font-size:11px;color:#999;margin-top:20px;text-align:center">Powered by MINE</p>
</div></body></html>`);
});

// Self-service cancel — requires customer email to match the booking (prevents arbitrary cancellation)
router.post("/bookings/:id/cancel-self", (req, res) => {
  const db = getDb();
  const { customerEmail } = req.body;
  if (!customerEmail) return res.status(400).json({ error: "Customer email required to cancel" });
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'confirmed'").get(req.params.id);
  if (!booking) return res.json({ error: "Booking not found or already cancelled" });
  // Verify the requesting customer email matches the booking
  if (booking.customer_email?.toLowerCase() !== customerEmail.toLowerCase()) {
    return res.status(403).json({ error: "Email does not match booking" });
  }

  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
  try { db.prepare("DELETE FROM booking_reminders WHERE booking_id = ? AND status = 'pending'").run(booking.id); } catch(e) { console.error("[/:id/cancel-self]", e.message || e); }

  // Notify owner
  notifyOwner(booking.user_id, "📅", `Booking cancelled by customer: ${booking.customer_name || booking.customer_email} — ${booking.service} on ${booking.date}`);

  // Email customer confirmation
  (async () => {
    try {
      const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(booking.user_id);
      await autoEmail(booking.user_id, booking.customer_email, `Booking cancelled — ${booking.service}`,
        `<p>Hi ${esc(booking.customer_name || "there")},</p>
        <p>Your booking for <strong>${esc(booking.service)}</strong> on ${esc(booking.date)} at ${esc(booking.time)} has been cancelled as requested.</p>
        <p>If you'd like to rebook, visit our website or reply to this email.</p>`);
    } catch(e) {}
  })();

  res.json({ success: true });
});

// ── 7. FAILED PAYMENT DUNNING ──
// Handles invoice.payment_failed webhook — already logged in server.js
// Add actual dunning email
// ─── DUNNING SYSTEM ─────────────────────────────────────────────────────────
// Handles failed payments for BOTH plan subscriptions and overage invoices.
// Sequence:
//   Day 0  — immediate email: "payment failed, update your card"
//   Day 3  — reminder email + Stripe retry attempt
//   Day 7  — final warning email + Stripe retry attempt
//   Day 10 — account paused, sites taken offline, final notice sent
//   On payment success (invoice.payment_succeeded webhook) → account un-paused immediately

async function sendDunningEmail(toEmail, attempt, type, amount, frontendUrl) {
  const sgKey = getSetting("SENDGRID_API_KEY");
  const fromEmail = getSetting("EMAIL_FROM") || "hello@takeova.ai";
  if (!sgKey || !toEmail) return false;

  const updateUrl = `${frontendUrl}?update_payment=true`;
  const isOverage = type === "overage";
  const amountStr = amount ? `$${amount.toFixed(2)}` : "";

  const subjects = {
    1: isOverage
      ? `⚠️ Overage charge of ${amountStr} failed — please update your card`
      : `⚠️ Your TAKEOVA payment failed — update your card to keep your account`,
    2: isOverage
      ? `🔴 Reminder: ${amountStr} overage charge still unpaid — retry in 4 days`
      : `🔴 Reminder: your TAKEOVA subscription payment is still failing`,
    3: isOverage
      ? `⏳ ${amountStr} still unpaid — your account is now in a grace period`
      : `⏳ Your account is in a grace period — update your card within 10 days`,
    4: isOverage
      ? `🚨 Final notice: ${amountStr} unpaid — account pauses in 3 days`
      : `🚨 Final notice: update your card now — account pauses in 3 days`,
    5: isOverage
      ? `Your TAKEOVA account has been paused — ${amountStr} outstanding`
      : `Your TAKEOVA account has been paused — payment overdue`,
  };

  const bodies = {
    1: `<p>We tried to charge your card${amountStr ? ` <strong>${amountStr}</strong>` : ""} but it was declined.</p>
        <p>Please update your payment method to avoid losing access to your account.</p>
        <p style="color:#666;font-size:13px">We'll retry the charge in 3 days. If it fails again, we'll send another reminder.</p>`,
    2: `<p>Your payment${amountStr ? ` of <strong>${amountStr}</strong>` : ""} is still outstanding.</p>
        <p>We'll retry the charge in 4 days. Please update your card now to avoid interruption.</p>
        <p style="color:#666;font-size:13px">Everything is still running normally — just update your card to stay on track.</p>`,
    3: `<p>Your payment${amountStr ? ` of <strong>${amountStr}</strong>` : ""} has failed again. We've started a <strong>10-day grace period</strong> on your account.</p>
        <p>Everything still works normally during this time. But if we can't collect payment by day 10, your account will be paused.</p>
        <p style="color:#666;font-size:13px">We'll make one more attempt in 7 days. Update your card now to avoid any disruption.</p>`,
    4: `<p>This is your final notice. Your payment${amountStr ? ` of <strong>${amountStr}</strong>` : ""} has now failed 4 times.</p>
        <p>We'll make one last attempt to charge your card in 3 days. <strong>If it fails, your account will be paused and your sites will go offline.</strong></p>
        <p style="color:#DC2626;font-weight:600;font-size:13px">Update your card right now to avoid disruption to your business.</p>`,
    5: `<p>Your TAKEOVA account has been paused due to a failed payment${amountStr ? ` of <strong>${amountStr}</strong>` : ""}.</p>
        <p>Your sites, automations, and AI features have been suspended. <strong>Your data is safe</strong> and everything will be fully restored the moment you update your card.</p>
        <p style="color:#DC2626;font-size:13px;font-weight:600">Important: your data will be permanently deleted in 60 days if payment is not resolved.</p>`,
  };

  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: fromEmail, name: "MINE" },
        subject: subjects[attempt] || subjects[1],
        content: [{ type: "text/html", value: `
          <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
              <div style="width:36px;height:36px;background:#2563EB;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px">M</div>
              <strong style="font-size:18px">MINE</strong>
            </div>
            <h2 style="margin:0 0 16px">${subjects[attempt]}</h2>
            ${bodies[attempt] || bodies[1]}
            <div style="text-align:center;margin:28px 0">
              <a href="${updateUrl}" style="display:inline-block;padding:14px 32px;background:#2563EB;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
                Update Payment Method →
              </a>
            </div>
            <p style="color:#94a3b8;font-size:12px;text-align:center">Questions? Reply to this email — we're here to help.</p>
          </div>` }]
      })
    });
    return r.ok;
  } catch(e) { return false; }
}

async function handleFailedPayment(db, customerEmail, planId, stripeInvoiceId, type = "plan", amount = null, platformUserId = null) {
  if (!customerEmail) return;
  try {
    db.exec("CREATE TABLE IF NOT EXISTS dunning_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL, attempt INTEGER DEFAULT 1, amount REAL, period TEXT, stripe_invoice_id TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");

    // For plan/overage: customerEmail IS the TAKEOVA platform user — look them up
    // For membership/product_sub: customerEmail is an end-customer NOT in users table —
    //   use platformUserId for logging, still email the customer directly
    const isMineUser = type === "plan" || type === "overage";
    const user = db.prepare("SELECT id, account_status FROM users WHERE email = ?").get(customerEmail);

    if (isMineUser && !user) return; // plan/overage failures must have a TAKEOVA user

    // logUserId: for MINE users use their id; for customers use the merchant's id
    const logUserId = user?.id || platformUserId;
    if (!logUserId) {
      // No user and no platform context — still send the email but skip DB logging
      const frontendUrl = FRONTEND_URL || "https://takeova.ai";
      await sendDunningEmail(customerEmail, 1, type, amount, frontendUrl);
      return;
    }

    const frontendUrl = FRONTEND_URL || "https://takeova.ai";

    // Count prior attempts scoped to this invoice (or this user+type if no invoice)
    const existingAttempts = stripeInvoiceId
      ? db.prepare("SELECT COUNT(*) as n FROM dunning_log WHERE user_id = ? AND stripe_invoice_id = ? AND status = 'pending'").get(logUserId, stripeInvoiceId).n
      : db.prepare("SELECT COUNT(*) as n FROM dunning_log WHERE user_id = ? AND type = ? AND status = 'pending'").get(logUserId, type).n;
    const attempt = existingAttempts + 1;

    db.prepare("INSERT INTO dunning_log (user_id, type, attempt, amount, stripe_invoice_id, status) VALUES (?,?,?,?,?,'pending')")
      .run(logUserId, type, attempt, amount, stripeInvoiceId || null);

    // ── DUNNING SEQUENCE ──────────────────────────────────────────────────
    // Attempt 1 (day 0):  fail → email → retry in 3 days
    // Attempt 2 (day 3):  fail → email → retry in 4 days
    // Attempt 3 (day 7):  fail → email → GRACE PERIOD starts → retry in 7 days
    // Attempt 4 (day 14): fail → email (final warning) → retry in 3 days
    // Attempt 5 (day 17): fail → ACCOUNT PAUSED → sites offline → deletion in 60 days
    // Day 45:             deletion warning email
    // Day 60:             data purged, account deleted
    // ─────────────────────────────────────────────────────────────────────

    await sendDunningEmail(customerEmail, Math.min(attempt, 5), type, amount, frontendUrl);

    // Enter grace period at attempt 3 (day 7) — account still works, banner shown
    if (attempt === 3 && isMineUser && user && user.account_status === "active") {
      db.prepare("UPDATE users SET account_status = 'grace', grace_period_since = datetime('now') WHERE id = ?").run(user.id);
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(
        user.id, "account_grace", JSON.stringify({ reason: "payment_failed", type, attempt, stripeInvoiceId })
      );

    }

    // Schedule next Stripe retry
    const retryDays = { 1: 3, 2: 4, 3: 7, 4: 3 }; // day 0→3, 3→7, 7→14, 14→17
    const daysUntilRetry = retryDays[attempt];
    if (daysUntilRetry && attempt < 5) {
      db.exec("CREATE TABLE IF NOT EXISTS scheduled_emails (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT, send_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");
      // Cancel any existing pending retry for this invoice to avoid duplicates
      db.prepare("UPDATE scheduled_emails SET status = 'cancelled' WHERE user_id = ? AND subject LIKE ? AND status = 'pending'")
        .run(logUserId, `__dunning_retry__${type}__${stripeInvoiceId || ""}%`);
      db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at) VALUES (?,?,?,?,?,datetime('now',?,'days'))")
        .run(uuid(), logUserId, customerEmail,
          `__dunning_retry__${type}__${stripeInvoiceId || ""}__${attempt + 1}`,
          JSON.stringify({ userId: logUserId, customerEmail, type, stripeInvoiceId, nextAttempt: attempt + 1, amount }),
          String(daysUntilRetry));
    }

    // Pause MINE platform account at attempt 5 (day 17) — sites go offline
    if (attempt >= 5 && isMineUser && user) {
      const deletionDate = new Date(Date.now() + 60 * 86400000).toISOString();
      db.prepare("UPDATE users SET account_status = 'paused', deletion_scheduled_at = ? WHERE id = ?").run(deletionDate, user.id);
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(
        user.id, "account_paused", JSON.stringify({ reason: "payment_failed", type, attempt, stripeInvoiceId, deletionScheduledAt: deletionDate })
      );
      // Schedule day-45 deletion warning email
      db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at) VALUES (?,?,?,?,?,datetime('now','+45 days'))")
        .run(uuid(), user.id, customerEmail,
          "__deletion_warning__",
          JSON.stringify({ userId: user.id, deletionDate }),
          );

    }

    // For membership/product_sub customers: cancel enrollment after 5 failed attempts
    if (attempt >= 5 && !isMineUser && platformUserId) {
      try {
        const sub = db.prepare("SELECT stripe_subscription_id FROM membership_enrollments WHERE user_id = ? AND customer_email = ? AND status = 'active' LIMIT 1")
          .get(platformUserId, customerEmail);
        if (sub?.stripe_subscription_id) {
          db.prepare("UPDATE membership_enrollments SET status = 'cancelled' WHERE user_id = ? AND customer_email = ? AND stripe_subscription_id = ?")
            .run(platformUserId, customerEmail, sub.stripe_subscription_id);
        }
        const prodSub = db.prepare("SELECT id FROM product_sub_subscribers WHERE user_id = ? AND customer_email = ? AND status = 'active' LIMIT 1")
          .get(platformUserId, customerEmail);
        if (prodSub) {
          db.prepare("UPDATE product_sub_subscribers SET status = 'cancelled' WHERE id = ?").run(prodSub.id);
        }

      } catch(e) { console.error("[/:id/cancel-self]", e.message || e); }
    }

  } catch(e) { console.error("[DUNNING] handleFailedPayment error:", e.message); }
}

// Called when payment succeeds — un-pauses account and clears pending dunning
async function handlePaymentSuccess(db, customerEmail, stripeInvoiceId) {
  if (!customerEmail) return;
  try {
    const user = db.prepare("SELECT id, account_status FROM users WHERE email = ?").get(customerEmail);
    if (!user) return;

    // Clear pending dunning entries for this invoice
    if (stripeInvoiceId) {
      db.prepare("UPDATE dunning_log SET status = 'resolved' WHERE user_id = ? AND stripe_invoice_id = ? AND status = 'pending'")
        .run(user.id, stripeInvoiceId);
    }

    // Restore account if in grace or paused
    if (user.account_status === "paused" || user.account_status === "grace") {
      db.prepare("UPDATE users SET account_status = 'active', grace_period_since = NULL, deletion_scheduled_at = NULL WHERE id = ?").run(user.id);
      // Cancel any pending deletion warning or dunning retry emails
      db.prepare("UPDATE scheduled_emails SET status = 'cancelled' WHERE user_id = ? AND subject IN ('__deletion_warning__') AND status = 'pending'").run(user.id);
      db.prepare("UPDATE scheduled_emails SET status = 'cancelled' WHERE user_id = ? AND subject LIKE '__dunning_retry__%' AND status = 'pending'").run(user.id);
      db.prepare("UPDATE dunning_log SET status = 'resolved' WHERE user_id = ? AND status = 'pending'").run(user.id);
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(
        user.id, "account_reactivated", JSON.stringify({ reason: "payment_succeeded", stripeInvoiceId, previousStatus: user.account_status })
      );
      // Send reactivation email
      const sgKey = getSetting("SENDGRID_API_KEY");
      const fromEmail = getSetting("EMAIL_FROM") || "hello@takeova.ai";
      if (sgKey) {
        try {
          const fetch = (await import("node-fetch")).default;
          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: customerEmail }] }],
              from: { email: fromEmail, name: "MINE" },
              subject: "✅ Your TAKEOVA account is back online!",
              content: [{ type: "text/html", value: renderEmail({
                preheader: "Your TAKEOVA account is active again",
                heading: "Your account is active again",
                bodyHtml: `<p style="${P}">Great news — your payment went through and your TAKEOVA account is fully restored.</p><p style="${P}">Your sites are back online, automations are running, and all features are available.</p>`,
                cta: { text: "Go to dashboard", url: FRONTEND_URL || "https://takeova.ai" },
              }) }]
            })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
        } catch(e) {}
      }

    }
  } catch(e) { console.error("[DUNNING] handlePaymentSuccess error:", e.message); }
}

module.exports.handleFailedPayment = handleFailedPayment;
module.exports.handlePaymentSuccess = handlePaymentSuccess;

// ── CUSTOMER ORDER STATUS PAGE (public) ──
router.get("/orders/status/:orderNumber", (req, res) => {
  const db = getDb();
  const order = db.prepare("SELECT o.*, s.name as biz_name FROM orders o LEFT JOIN sites s ON s.id = o.site_id WHERE o.order_number = ?").get(req.params.orderNumber);
  if (!order) return res.status(404).send("<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f8f8'><div style='text-align:center;padding:40px'><h1>Order not found</h1><p>Check the order number and try again.</p></div></body></html>");

  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const bizName = esc(order.biz_name || "Store");
  let items = []; try { items = JSON.parse(order.items || "[]"); } catch(e) {}
  let addr = {}; try { addr = JSON.parse(order.shipping_address || "{}"); } catch(e) {}

  const steps = [
    { key: "confirmed", label: "Order Confirmed", icon: "✅", done: true },
    { key: "processing", label: "Processing", icon: "⚙️", done: ["shipped","delivered"].includes(order.status) },
    { key: "shipped", label: "Shipped", icon: "🚚", done: ["shipped","delivered"].includes(order.status) },
    { key: "delivered", label: "Delivered", icon: "📬", done: order.status === "delivered" },
  ];
  if (order.status === "refunded") steps.push({ key: "refunded", label: "Refunded", icon: "↩️", done: true });

  const trackUrl = order.tracking_number ? (
    order.carrier === "usps" ? "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + order.tracking_number :
    order.carrier === "ups" ? "https://www.ups.com/track?tracknum=" + order.tracking_number :
    order.carrier === "fedex" ? "https://www.fedex.com/fedextrack/?trknbr=" + order.tracking_number :
    order.carrier === "dhl" ? "https://www.dhl.com/en/express/tracking.html?AWB=" + order.tracking_number : ""
  ) : "";

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order #${order.order_number} — ${bizName}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#f8f8f8;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px;max-width:560px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:20px;margin-bottom:4px}
.status{display:inline-block;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:600;margin-bottom:16px}
.pending{background:#FEF3C7;color:#92400E}.shipped{background:#DBEAFE;color:#1D4ED8}.delivered{background:#DCFCE7;color:#166534}.refunded{background:#FEE2E2;color:#991B1B}
.steps{display:flex;gap:0;margin:20px 0;position:relative}
.step{flex:1;text-align:center;position:relative;z-index:1}
.step-dot{width:32px;height:32px;border-radius:16px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;font-size:14px}
.step-done .step-dot{background:#DCFCE7}.step-pending .step-dot{background:#f0f0f0}
.step-label{font-size:10px;color:#666}
.step-done .step-label{color:#166534;font-weight:600}
.line{position:absolute;top:16px;left:25%;right:25%;height:2px;background:#e0e0e0;z-index:0}
.items{background:#f7f8fa;padding:16px;border-radius:10px;margin:16px 0;font-size:13px}
.item-row{display:flex;justify-content:space-between;margin-bottom:6px}
.tracking{background:#DBEAFE;padding:14px;border-radius:10px;margin:16px 0;font-size:13px}
.addr{font-size:12px;color:#666;margin:12px 0}
.footer{text-align:center;margin-top:20px;padding-top:16px;border-top:1px solid #f0f0f0;font-size:11px;color:#999}
@media(max-width:480px){.card{padding:20px}.steps{flex-wrap:wrap;gap:8px}}
</style></head><body>
<div class="card">
<h1>Order #${order.order_number}</h1>
<div style="font-size:13px;color:#666;margin-bottom:8px">${bizName} · ${order.created_at?.split("T")[0] || ""}</div>
<span class="status ${["confirmed","processing","shipped","delivered","refunded","cancelled"].includes(order.status)?order.status:"pending"}">${esc(order.status).toUpperCase()}</span>

<div class="steps">
${steps.map(s => `<div class="step ${s.done ? "step-done" : "step-pending"}"><div class="step-dot">${esc(s.icon)}</div><div class="step-label">${esc(s.label)}</div></div>`).join("")}
</div>

${order.tracking_number ? `<div class="tracking">🚚 <strong>Tracking:</strong> ${esc(order.tracking_number)}${order.carrier ? " (" + esc(order.carrier).toUpperCase() + ")" : ""}${trackUrl ? `<br><a href="${esc(trackUrl)}" style="color:#1D4ED8;font-weight:600">Track Package →</a>` : ""}</div>` : ""}

<div class="items">
<div style="font-weight:600;margin-bottom:8px">Items</div>
${items.map(i => `<div class="item-row"><span>${esc(i.name)} × ${parseInt(i.quantity)||1}</span><span style="font-weight:600">$${(parseFloat(i.price)||0 * (parseInt(i.quantity)||1)).toFixed(2)}</span></div>`).join("")}
<div style="border-top:1px solid #ddd;margin-top:8px;padding-top:8px"><div class="item-row"><strong>Total</strong><strong>$${(order.total || 0).toFixed(2)}</strong></div></div>
</div>

${addr.line1 ? `<div class="addr">📍 <strong>Shipping to:</strong> ${esc(order.shipping_name)}, ${esc(addr.line1)}${addr.line2 ? ", " + esc(addr.line2) : ""}, ${esc(addr.city)} ${esc(addr.state)} ${esc(addr.postal_code)} ${esc(addr.country)}</div>` : ""}

<div class="footer">
<a href="https://takeova.ai" style="color:#999;text-decoration:none">Powered by <strong style="color:#2563EB">MINE</strong></a>
</div>
</div></body></html>`);
});

// ═══════════════════════════════════════════════════════════
// STUDENT COURSE PORTAL (public — students access their courses)
// ═══════════════════════════════════════════════════════════

router.get("/courses/portal/:courseId/:studentEmail", (req, res) => {
  const db = getDb();
  const course = db.prepare("SELECT c.*, s.name as biz_name, s.user_id FROM courses c LEFT JOIN sites s ON s.user_id = c.user_id WHERE c.id = ?").get(req.params.courseId);
  if (!course) return res.status(404).send("<h1>Course not found</h1>");

  const studentEmail = decodeURIComponent(req.params.studentEmail);

  // Validate student session token — prevents any email-holder from accessing another's course portal
  const portalToken = req.query.token;
  if (!portalToken) {
    return res.status(401).send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Login Required</h2><p>Please log in via your student portal to access this course.</p></body></html>`);
  }
  try {
    db.exec("CREATE TABLE IF NOT EXISTS student_sessions (token TEXT PRIMARY KEY, email TEXT, created_at TEXT DEFAULT (datetime('now')))");
    const sess = db.prepare("SELECT email FROM student_sessions WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime('now'))").get(portalToken);
    if (!sess || sess.email !== studentEmail.toLowerCase()) {
      return res.status(403).send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Access Denied</h2><p>Invalid or expired session. Please log in again.</p></body></html>`);
    }
  } catch(e) {
    return res.status(403).send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Access Denied</h2><p>Could not verify your session.</p></body></html>`);
  }

  // Verify student is enrolled before showing course content
  try {
    db.exec("CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, progress INTEGER DEFAULT 0, completed INTEGER DEFAULT 0, created_at TEXT)");
    const enrolled = db.prepare("SELECT id FROM enrollments WHERE course_id = ? AND student_email = ?").get(req.params.courseId, studentEmail.toLowerCase());
    if (!enrolled) {
      return res.status(403).send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Access Denied</h2><p>You are not enrolled in this course.</p><p>Contact the course creator to enroll.</p></body></html>`);
    }
  } catch(e) { /* enrollment table may not exist — allow access gracefully on first deploy */ }
  const bizName = course.biz_name || "Academy";
  let modules = []; try { modules = JSON.parse(course.modules || "[]"); } catch(e) {}
  let drip = {}; try { drip = JSON.parse(course.drip_config || "{}"); } catch(e) {}

  // Get student progress
  db.exec("CREATE TABLE IF NOT EXISTS lesson_progress (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, module_id TEXT, lesson_id TEXT, completed INTEGER DEFAULT 0, time_spent INTEGER DEFAULT 0, completed_at TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(course_id, student_email, lesson_id))");
  const progress = db.prepare("SELECT lesson_id, completed FROM lesson_progress WHERE course_id = ? AND student_email = ?").all(req.params.courseId, studentEmail);
  const completedSet = new Set(progress.filter(p => p.completed).map(p => p.lesson_id));

  // Drip access
  let enrollment = null;
  try { enrollment = db.prepare("SELECT created_at FROM enrollments WHERE course_id = ? AND student_email = ?").get(req.params.courseId, studentEmail); } catch(e) {}
  const daysSince = enrollment ? Math.floor((Date.now() - new Date(enrollment.created_at).getTime()) / (1000*60*60*24)) : 999;

  const totalLessons = modules.reduce((a, m) => a + (m.lessons?.length || 0), 0);
  const completedCount = completedSet.size;
  const progressPct = totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;

  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const modulesHtml = modules.map((mod, mi) => {
    const isLocked = drip.enabled && (drip.modules || []).find(d => d.moduleId === mod.id)?.delay_days > daysSince;
    return `
    <div style="background:#fff;border-radius:12px;border:1px solid #f0f0f0;margin-bottom:12px;overflow:hidden;${isLocked ? "opacity:.5" : ""}">
      <div style="padding:16px;background:#f7f8fa;display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:700;font-size:14px">${isLocked ? "🔒 " : ""}Module ${mi + 1}: ${esc(mod.title) || "Untitled"}</div>
        <div style="font-size:11px;color:#666">${(mod.lessons || []).filter(l => completedSet.has(l.id || l.title)).length}/${(mod.lessons || []).length} lessons</div>
      </div>
      ${isLocked ? `<div style="padding:16px;font-size:13px;color:#666">This module unlocks in ${((drip.modules || []).find(d => d.moduleId === mod.id)?.delay_days || 0) - daysSince} days</div>` :
      (mod.lessons || []).map((lesson, li) => {
        const lessonId = lesson.id || lesson.title;
        const done = completedSet.has(lessonId);
        return `<div style="padding:12px 16px;border-top:1px solid #f0f0f0;display:flex;align-items:center;gap:12px">
          <div onclick="markLesson('${lessonId}','${mod.id||mi}',${done ? 0 : 1})" style="width:24px;height:24px;border-radius:12px;border:2px solid ${done ? "#22C55E" : "#ddd"};background:${done ? "#22C55E" : "#fff"};cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px;color:#fff">${done ? "✓" : ""}</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:${done ? "400" : "600"};${done ? "text-decoration:line-through;color:#999" : ""}">${esc(lesson.title) || "Lesson " + (li + 1)}</div>
            <div style="font-size:11px;color:#999">${lesson.type === "video" ? "🎥 Video" : lesson.type === "pdf" ? "📄 PDF" : lesson.type === "text" ? "📝 Text" : "📚 Lesson"}</div>
          </div>
          ${lesson.url && /^https?:\/\//.test(lesson.url) ? `<a href="${esc(lesson.url)}" target="_blank" style="padding:6px 12px;background:#2563EB;color:#fff;border-radius:6px;font-size:11px;text-decoration:none;font-weight:600">${lesson.type === "video" ? "▶ Watch" : lesson.type === "pdf" ? "📥 Download" : "Open"}</a>` : ""}
        </div>`;
      }).join("")}
    </div>`;
  }).join("");

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(course.title) || "Course"} — ${esc(bizName)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#f8f8f8;min-height:100vh}
.header{background:linear-gradient(135deg,#2563EB,#7C3AED);padding:32px 20px;color:#fff;text-align:center}
.header h1{font-size:24px;margin-bottom:4px}.header p{font-size:13px;opacity:.7}
.container{max-width:640px;margin:0 auto;padding:20px}
.progress-bar{height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;margin:20px 0}
.progress-fill{height:100%;background:linear-gradient(90deg,#22C55E,#16A34A);border-radius:4px;transition:width .5s}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.stat{text-align:center;padding:16px;background:#fff;border-radius:10px;border:1px solid #f0f0f0}
.stat-num{font-size:22px;font-weight:800}.stat-label{font-size:10px;color:#666;margin-top:4px}
.footer{text-align:center;padding:24px;font-size:11px;color:#999}
@media(max-width:480px){.header{padding:24px 16px}.header h1{font-size:20px}.container{padding:12px}}
</style></head><body>
<div class="header">
<p>${esc(bizName)}</p>
<h1>${esc(course.title) || "Course"}</h1>
<p>${esc(course.desc)}</p>
</div>
<div class="container">
<div class="stats">
<div class="stat"><div class="stat-num" style="color:#2563EB">${progressPct}%</div><div class="stat-label">Progress</div></div>
<div class="stat"><div class="stat-num" style="color:#22C55E">${completedCount}</div><div class="stat-label">Completed</div></div>
<div class="stat"><div class="stat-num">${totalLessons - completedCount}</div><div class="stat-label">Remaining</div></div>
</div>
<div class="progress-bar"><div class="progress-fill" style="width:${progressPct}%"></div></div>
${progressPct === 100 ? `<div style="text-align:center;padding:24px;background:#DCFCE7;border-radius:12px;margin-bottom:20px"><div style="font-size:32px;margin-bottom:8px">🎉</div><div style="font-weight:700;color:#166534">Course Complete!</div></div>` : ""}
${modulesHtml}
</div>
<div class="footer">Powered by <a href="https://takeova.ai" style="color:#2563EB;text-decoration:none"><strong>MINE</strong></a></div>
<script>
async function markLesson(lessonId, moduleId, completed) {
  await fetch('/api/features/courses/progress', {
    method: 'POST', headers: {'Content-Type':'application/json','Authorization':'Bearer ${portalToken}'},
    body: JSON.stringify({courseId:'${req.params.courseId}',studentEmail:'${studentEmail}',lessonId,moduleId,completed:!!completed})
  });
  location.reload();
}
</script>
</body></html>`);
});

// ═══════════════════════════════════════════════════════════
// STUDENT LOGIN & MY COURSES DASHBOARD
// Uses the same OTP system as customer login
// ═══════════════════════════════════════════════════════════

// Student "My Courses" page — shows all enrolled courses after OTP login
router.get("/student/my-courses", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Courses</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#f8f8f8;min-height:100vh}
.container{max-width:640px;margin:0 auto;padding:20px}
.card{background:#fff;border-radius:14px;padding:24px;margin-bottom:12px;border:1px solid #f0f0f0;box-shadow:0 1px 4px rgba(0,0,0,.03)}
h1{font-size:22px;margin-bottom:4px}
input{width:100%;padding:12px 16px;border:2px solid #E8E6F0;border-radius:10px;font-size:14px;font-family:inherit;outline:none;margin-bottom:10px}
input:focus{border-color:#2563EB}
.btn{width:100%;padding:14px;background:#2563EB;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
.btn:disabled{opacity:.5}
.course-card{background:#fff;border-radius:12px;border:1px solid #f0f0f0;padding:20px;margin-bottom:12px;cursor:pointer;transition:all .2s}
.course-card:hover{border-color:#2563EB;transform:translateY(-2px);box-shadow:0 4px 12px rgba(99,91,255,.1)}
.progress-bar{height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden;margin-top:8px}
.progress-fill{height:100%;background:#22C55E;border-radius:3px}
.err{color:#DC2626;font-size:13px;margin-bottom:8px;display:none}
</style></head><body>
<div class="container">

<!-- Login view -->
<div id="login-view" class="card" style="text-align:center;margin-top:40px">
<div style="font-size:40px;margin-bottom:12px">🎓</div>
<h1>Student Login</h1>
<p style="color:#666;font-size:13px;margin-bottom:20px">Enter your email to access your courses</p>
<div id="err" class="err"></div>
<input type="email" id="email" placeholder="Your email address" />
<div id="otp-step" style="display:none">
<input type="text" id="code" placeholder="Enter 6-digit code" maxlength="6" style="text-align:center;letter-spacing:4px;font-size:18px" />
</div>
<button class="btn" onclick="handleAuth()" id="btn">Send Login Code</button>
<p style="font-size:11px;color:#999;margin-top:12px">We'll email you a one-time code. No password needed.</p>
</div>

<!-- Courses view -->
<div id="courses-view" style="display:none">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
<div>
<h1>My Courses</h1>
<p id="student-email" style="color:#666;font-size:13px"></p>
</div>
<button onclick="logout()" style="padding:8px 16px;border-radius:8px;border:1px solid #ddd;background:#fff;font-size:12px;cursor:pointer">Logout</button>
</div>
<div id="courses-list"></div>
<div id="empty-state" style="display:none;text-align:center;padding:40px">
<div style="font-size:40px;margin-bottom:12px">📚</div>
<p style="color:#666">No courses yet. When you enroll in a course, it will appear here.</p>
</div>
</div>
</div>

<div style="text-align:center;padding:24px;font-size:11px;color:#999">
Powered by <a href="https://takeova.ai" style="color:#2563EB;text-decoration:none"><strong>MINE</strong></a>
</div>

<script>
const API='/api/features';
let studentEmail='';

async function handleAuth(){
  const email=document.getElementById('email').value.trim();
  const code=document.getElementById('code')?.value?.trim();
  const err=document.getElementById('err');
  const btn=document.getElementById('btn');
  err.style.display='none';
  if(!email||!email.includes('@')){err.textContent='Enter a valid email';err.style.display='block';return;}
  btn.disabled=true;btn.textContent='Please wait...';

  try{
    const r=await fetch(API+'/student/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,code:code||undefined})});
    const d=await r.json();
    if(d.codeSent){
      document.getElementById('otp-step').style.display='block';
      btn.textContent='Verify Code';btn.disabled=false;
    }else if(d.courses!==undefined){
      studentEmail=email;
      localStorage.setItem('student_email',email);
      localStorage.setItem('student_token',d.token||'');
      renderCourses(d.courses);
    }else{
      err.textContent=d.error||'Something went wrong';err.style.display='block';btn.disabled=false;btn.textContent='Send Login Code';
    }
  }catch(e){err.textContent='Connection error';err.style.display='block';btn.disabled=false;btn.textContent='Send Login Code';}
}

function renderCourses(courses){
  document.getElementById('login-view').style.display='none';
  document.getElementById('courses-view').style.display='block';
  document.getElementById('student-email').textContent=studentEmail;

  if(!courses.length){document.getElementById('empty-state').style.display='block';return;}

  document.getElementById('courses-list').innerHTML=courses.map(function(c){
    function hesc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    var pct=Math.min(100,Math.max(0,parseInt(c.progress)||0));
    return '<div class="course-card" onclick="window.location.href=\''+API+'/courses/portal/'+c.course_id+'/'+encodeURIComponent(studentEmail)+'?token='+encodeURIComponent(token)+'\'">'+
      '<div style="display:flex;justify-content:space-between;align-items:start">'+
      '<div><div style="font-weight:700;font-size:16px">'+hesc(c.course_name)+'</div>'+
      '<div style="font-size:12px;color:#666;margin-top:4px">'+hesc(c.biz_name||'')+'</div></div>'+
      '<div style="font-size:13px;font-weight:700;color:#2563EB">'+pct+'%</div></div>'+
      '<div class="progress-bar"><div class="progress-fill" style="width:'+pct+'%"></div></div>'+
      '<div style="font-size:11px;color:#999;margin-top:6px">'+hesc(c.completed)+'/'+hesc(c.total)+' lessons \u00b7 Enrolled '+hesc(c.enrolled_date)+'</div>'+
      '</div>';
  }).join('');
}

function logout(){localStorage.removeItem('student_email');localStorage.removeItem('student_token');location.reload();}

// Auto-login
(async function(){
  const saved=localStorage.getItem('student_email');
  const token=localStorage.getItem('student_token');
  if(saved&&token){
    try{
      const r=await fetch(API+'/student/courses?email='+encodeURIComponent(saved)+'&token='+token);
      const d=await r.json();
      if(d.courses!==undefined){studentEmail=saved;renderCourses(d.courses);}
    }catch(e) { console.error("[/student/my-courses]", e.message || e); }
  }
})();
</script>
</body></html>`);
});

// Student OTP auth
const _studentAuthLimiter = require("express-rate-limit")({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip + ":" + (req.body?.email || ""),
  message: { error: "Too many login attempts — please wait 15 minutes" },
  standardHeaders: true, legacyHeaders: false,
});
router.post("/student/auth", _studentAuthLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    const db = getDb();

    db.exec("CREATE TABLE IF NOT EXISTS student_auth_codes (email TEXT PRIMARY KEY, code TEXT, expires TEXT)");

    if (!code) {
      // Send OTP
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare("INSERT OR REPLACE INTO student_auth_codes (email, code, expires) VALUES (?,?,datetime('now','+10 minutes'))").run(email.toLowerCase(), otp);

      const sgKey = getSetting("SENDGRID_API_KEY");
      const fromEmail = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
      if (sgKey) {
        try {
          const fetch = (await import("node-fetch")).default;
          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({ personalizations: [{ to: [{ email: email.toLowerCase() }] }], from: { email: fromEmail, name: "Course Login" },
              subject: "Your login code: " + otp,
              content: [{ type: "text/plain", value: "Your student login code is: " + otp + "\n\nThis code expires in 10 minutes." }] })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
        } catch(e) {}
      }
      return res.json({ codeSent: true });
    }

    // Verify OTP
    const valid = db.prepare("SELECT * FROM student_auth_codes WHERE email = ? AND code = ? AND datetime(expires) > datetime('now')").get(email.toLowerCase(), code);
    if (!valid) {
      try { db.exec("ALTER TABLE student_auth_codes ADD COLUMN failures INTEGER DEFAULT 0"); } catch(e) {}
      db.prepare("UPDATE student_auth_codes SET failures = COALESCE(failures,0) + 1 WHERE email = ?").run(email.toLowerCase());
      const row = db.prepare("SELECT failures FROM student_auth_codes WHERE email = ?").get(email.toLowerCase());
      if (row && row.failures >= 5) {
        db.prepare("DELETE FROM student_auth_codes WHERE email = ?").run(email.toLowerCase());
        return res.status(401).json({ error: "Too many failed attempts — request a new code" });
      }
      return res.status(401).json({ error: "Invalid or expired code" });
    }
    db.prepare("DELETE FROM student_auth_codes WHERE email = ?").run(email.toLowerCase());

    // Generate token
    const token = uuid();
    db.exec("CREATE TABLE IF NOT EXISTS student_sessions (token TEXT PRIMARY KEY, email TEXT, created_at TEXT DEFAULT (datetime('now')))");
    try { db.exec("ALTER TABLE student_sessions ADD COLUMN expires_at TEXT"); } catch(e) {}
    db.prepare("INSERT INTO student_sessions (token, email, expires_at) VALUES (?,?,datetime('now','+30 days'))").run(token, email.toLowerCase());

    // Get enrolled courses
    const courses = getStudentCourses(db, email.toLowerCase());
    res.json({ courses, token });
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Get student's courses (authenticated)
router.get("/student/courses", (req, res) => {
  const { email, token } = req.query;
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS student_sessions (token TEXT PRIMARY KEY, email TEXT, created_at TEXT DEFAULT (datetime('now')))");
    const session = db.prepare("SELECT email FROM student_sessions WHERE token = ?").get(token);
    if (!session || session.email !== email?.toLowerCase()) return res.status(401).json({ error: "Invalid session" });
    const courses = getStudentCourses(db, email.toLowerCase());
    res.json({ courses });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

function getStudentCourses(db, email) {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, created_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS lesson_progress (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, module_id TEXT, lesson_id TEXT, completed INTEGER DEFAULT 0, time_spent INTEGER DEFAULT 0, completed_at TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(course_id, student_email, lesson_id))");

    const enrollments = db.prepare("SELECT e.course_id, e.created_at as enrolled_at, c.title as course_name, c.modules, s.name as biz_name FROM enrollments e LEFT JOIN courses c ON e.course_id = c.id LEFT JOIN sites s ON s.user_id = c.user_id WHERE e.student_email = ?").all(email);

    return enrollments.map(e => {
      let modules = []; try { modules = JSON.parse(e.modules || "[]"); } catch(x) {}
      const totalLessons = modules.reduce((a, m) => a + (m.lessons?.length || 0), 0);
      const completed = db.prepare("SELECT COUNT(*) as c FROM lesson_progress WHERE course_id = ? AND student_email = ? AND completed = 1").get(e.course_id, email)?.c || 0;
      return {
        course_id: e.course_id,
        course_name: e.course_name || "Course",
        biz_name: e.biz_name || "",
        total: totalLessons,
        completed,
        progress: totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0,
        enrolled_date: e.enrolled_at?.split("T")[0] || ""
      };
    });
  } catch(e) { return []; }
}

// ═══════════════════════════════════════════════════════════
// AI LEAD MAGNET GENERATOR — Describe it → AI writes it → Auto PDF
// Works for both MINE admin and regular users
// ═══════════════════════════════════════════════════════════

router.post("/lead-magnets/ai-generate", auth, async (req, res) => {
  try {
    const { topic, type, businessName, targetAudience, tone } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic required" });

    const db = getDb();

    // Cap check
    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const check = global.mineCheckUsage(db, req.userId, "leadMagnets");
      if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to generate more lead magnets.", cap: check.cap, upgrade: true });
    }
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const bizName = businessName || site?.name || "Business";

    const typeInstructions = {
      checklist: "Create a practical checklist with 15-25 checkable items grouped into 3-5 sections. Each item should be actionable and specific. Format: Section headers followed by checkbox items.",
      guide: "Write a comprehensive guide with 5-7 chapters/sections. Each section has a clear heading, 2-3 paragraphs of actionable advice, and a key takeaway. Include an introduction and conclusion.",
      cheatsheet: "Create a quick-reference cheat sheet with 20-30 concise tips, shortcuts, or formulas organized into 4-6 categories. Keep each item to 1-2 sentences max.",
      template: "Create a fill-in-the-blank template with clear instructions. Include 5-8 sections with placeholder text that the reader fills in. Add brief guidance notes for each section.",
      workbook: "Create an interactive workbook with 8-12 exercises. Each exercise has a prompt question, space description for answers, and a brief example. Group into 3-4 chapters.",
      toolkit: "Create a resource toolkit with 5-7 tools/resources. For each: name, what it does, how to use it, pro tip. Include an overview introduction and a getting-started action plan."
    };

    const prompt = `You are creating a professional lead magnet for "${aiStr(bizName, 100)}".
  Target audience: ${aiStr(targetAudience, 200) || "business owners and entrepreneurs"}
  Tone: ${aiStr(tone, 100) || "professional, friendly, actionable"}
  Type: ${type || "guide"}

  Topic: "${aiStr(topic, 300)}"

  ${typeInstructions[type] || typeInstructions.guide}

  IMPORTANT FORMATTING RULES:
  - Return the content as JSON with this exact structure:
  {"title":"The Main Title","subtitle":"A compelling subtitle","sections":[{"heading":"Section Title","items":["Item 1","Item 2"]}],"cta":"Call to action text at the end","author":"${bizName}"}
  - For checklists, items should start with "☐ " prefix
  - For guides, items are paragraphs of text
  - For cheatsheets, items are short tips
  - Keep the total content to about 2000-3000 words
  - Make it genuinely valuable — this should feel like something worth $29-49
  - Return ONLY valid JSON, no markdown fences, no preamble`;

    try {
      const anthropicKey = getSetting("ANTHROPIC_API_KEY");
      if (!anthropicKey) return res.status(400).json({ error: "Anthropic API key not configured" });

      const fetch = (await import("node-fetch")).default;
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4000,
          messages: [{ role: "user", content: prompt }] })
      });
      const aiData = await aiRes.json();
      const text = aiData.content?.[0]?.text || "";

      let content;
      try {
        const clean = text.replace(/```json|```/g, "").trim();
        content = JSON.parse(clean);
      } catch(e) {
        return res.status(500).json({ error: "AI response was not valid JSON. Try again." });
      }

      // Track on success
      let isOverage = false;
      if (typeof global !== "undefined" && global.mineTrackUsage) {
        const t = global.mineTrackUsage(db, req.userId, "leadMagnets");
        isOverage = t?.isOverage || false;
        if (isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      }

      res.json({ success: true, content, isOverage });
    } catch(e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Generate PDF from the AI content
router.post("/lead-magnets/generate-pdf", auth, async (req, res) => {
  const { content, brandColor } = req.body;
  // content: {title, subtitle, sections:[{heading, items:[]}], cta, author}
  if (!content?.title || !content?.sections) return res.status(400).json({ error: "Content with title and sections required" });
  if (String(content.title).length > 200) return res.status(400).json({ error: "Title too long (max 200 chars)" });
  if (!Array.isArray(content.sections) || content.sections.length > 20) return res.status(400).json({ error: "Max 20 sections" });
  // Truncate all text fields to prevent enormous PDFs
  content.title = String(content.title).slice(0, 200);
  content.subtitle = String(content.subtitle || "").slice(0, 400);
  content.author = String(content.author || "").slice(0, 100);
  content.cta = String(content.cta || "").slice(0, 300);
  content.sections = content.sections.slice(0, 20).map(s => ({
    heading: String(s.heading || "").slice(0, 200),
    items: Array.isArray(s.items) ? s.items.slice(0, 30).map(i => String(i).slice(0, 500)) : []
  }));

  const db = getDb();
  // Validate brandColor is a safe hex color to prevent shell injection via execSync
  const hexColorRegex = /^#[0-9a-fA-F]{3,8}$/;
  const color = (brandColor && hexColorRegex.test(brandColor)) ? brandColor : "#2563EB";
  const pdfId = uuid();
  const filename = `lead-magnet-${pdfId}.pdf`;
  const filepath = `/tmp/${filename}`;

  try {
    // Generate PDF using a child process running Python + reportlab
    const { execSync } = require("child_process");
    const fs = require("fs");

    const pyScript = `
import json, sys
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT

data = json.loads(sys.argv[1])
color = "${color}"
filepath = "${filepath}"

doc = SimpleDocTemplate(filepath, pagesize=letter, leftMargin=0.75*inch, rightMargin=0.75*inch, topMargin=0.75*inch, bottomMargin=0.75*inch)
styles = getSampleStyleSheet()

# Custom styles
styles.add(ParagraphStyle('CustomTitle', parent=styles['Title'], fontSize=28, leading=34, textColor=HexColor(color), spaceAfter=6, fontName='Helvetica-Bold', alignment=TA_CENTER))
styles.add(ParagraphStyle('CustomSubtitle', parent=styles['Normal'], fontSize=14, leading=18, textColor=HexColor('#666666'), spaceAfter=24, alignment=TA_CENTER))
styles.add(ParagraphStyle('SectionHead', parent=styles['Heading1'], fontSize=18, leading=22, textColor=HexColor(color), spaceBefore=20, spaceAfter=10, fontName='Helvetica-Bold'))
styles.add(ParagraphStyle('ItemText', parent=styles['Normal'], fontSize=11, leading=16, textColor=HexColor('#333333'), spaceAfter=8, leftIndent=12))
styles.add(ParagraphStyle('CTAStyle', parent=styles['Normal'], fontSize=13, leading=18, textColor=HexColor(color), spaceBefore=20, spaceAfter=10, alignment=TA_CENTER, fontName='Helvetica-Bold'))
styles.add(ParagraphStyle('AuthorStyle', parent=styles['Normal'], fontSize=10, leading=14, textColor=HexColor('#999999'), alignment=TA_CENTER))
styles.add(ParagraphStyle('FooterStyle', parent=styles['Normal'], fontSize=8, leading=10, textColor=HexColor('#CCCCCC'), alignment=TA_CENTER))

story = []

# Cover page
story.append(Spacer(1, 1.5*inch))
story.append(Paragraph(data.get('title', 'Lead Magnet'), styles['CustomTitle']))
story.append(Paragraph(data.get('subtitle', ''), styles['CustomSubtitle']))
story.append(HRFlowable(width="40%", thickness=2, color=HexColor(color), spaceAfter=20, spaceBefore=10, hAlign='CENTER'))
story.append(Paragraph('by ' + data.get('author', 'MINE'), styles['AuthorStyle']))
story.append(PageBreak())

# Content sections
for section in data.get('sections', []):
    story.append(Paragraph(section.get('heading', ''), styles['SectionHead']))
    story.append(HRFlowable(width="100%", thickness=0.5, color=HexColor('#E0E0E0'), spaceAfter=12))
    for item in section.get('items', []):
        safe_item = item.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        story.append(Paragraph(safe_item, styles['ItemText']))
    story.append(Spacer(1, 12))

# CTA
if data.get('cta'):
    story.append(Spacer(1, 20))
    story.append(HRFlowable(width="60%", thickness=1, color=HexColor(color), spaceAfter=16, hAlign='CENTER'))
    safe_cta = data['cta'].replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    story.append(Paragraph(safe_cta, styles['CTAStyle']))

# Footer
story.append(Spacer(1, 30))
story.append(Paragraph('Created with MINE — the all-in-one AI business platform — takeova.ai', styles['FooterStyle']))

doc.build(story)
print('OK')
`;

    const contentJson = JSON.stringify(content).replace(/'/g, "\\'").replace(/\\/g, "\\\\");
    fs.writeFileSync("/tmp/gen_pdf.py", pyScript);
    const contentFile = `/tmp/pdf_content_${pdfId}.json`;
    fs.writeFileSync(contentFile, JSON.stringify(content));

    execSync(`cd /tmp && python3 -c "
import json, sys
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER

with open('${contentFile}') as f:
    data = json.load(f)

color = '${color}'
doc = SimpleDocTemplate('${filepath}', pagesize=letter, leftMargin=0.75*inch, rightMargin=0.75*inch, topMargin=0.75*inch, bottomMargin=0.75*inch)
styles = getSampleStyleSheet()
styles.add(ParagraphStyle('CT', parent=styles['Title'], fontSize=28, leading=34, textColor=HexColor(color), spaceAfter=6, fontName='Helvetica-Bold', alignment=TA_CENTER))
styles.add(ParagraphStyle('CS', parent=styles['Normal'], fontSize=14, leading=18, textColor=HexColor('#666666'), spaceAfter=24, alignment=TA_CENTER))
styles.add(ParagraphStyle('SH', parent=styles['Heading1'], fontSize=18, leading=22, textColor=HexColor(color), spaceBefore=20, spaceAfter=10, fontName='Helvetica-Bold'))
styles.add(ParagraphStyle('IT', parent=styles['Normal'], fontSize=11, leading=16, textColor=HexColor('#333333'), spaceAfter=8, leftIndent=12))
styles.add(ParagraphStyle('CTA', parent=styles['Normal'], fontSize=13, leading=18, textColor=HexColor(color), spaceBefore=20, alignment=TA_CENTER, fontName='Helvetica-Bold'))
styles.add(ParagraphStyle('AU', parent=styles['Normal'], fontSize=10, leading=14, textColor=HexColor('#999999'), alignment=TA_CENTER))
styles.add(ParagraphStyle('FT', parent=styles['Normal'], fontSize=8, leading=10, textColor=HexColor('#CCCCCC'), alignment=TA_CENTER))

story = [Spacer(1, 1.5*inch)]
story.append(Paragraph(data.get('title',''), styles['CT']))
story.append(Paragraph(data.get('subtitle',''), styles['CS']))
story.append(HRFlowable(width='40%', thickness=2, color=HexColor(color), spaceAfter=20, spaceBefore=10, hAlign='CENTER'))
story.append(Paragraph('by ' + data.get('author','MINE'), styles['AU']))
story.append(PageBreak())

for sec in data.get('sections', []):
    story.append(Paragraph(sec.get('heading',''), styles['SH']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=HexColor('#E0E0E0'), spaceAfter=12))
    for item in sec.get('items', []):
        safe = item.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
        story.append(Paragraph(safe, styles['IT']))
    story.append(Spacer(1, 12))

if data.get('cta'):
    story.append(Spacer(1, 20))
    story.append(HRFlowable(width='60%', thickness=1, color=HexColor(color), spaceAfter=16, hAlign='CENTER'))
    story.append(Paragraph(data['cta'].replace('&','&amp;').replace('<','&lt;').replace('>','&gt;'), styles['CTA']))

story.append(Spacer(1, 30))
story.append(Paragraph('Created with MINE — takeova.ai', styles['FT']))
doc.build(story)
print('OK')
"`, { timeout: 30000 });

    // Check file exists
    if (!fs.existsSync(filepath)) return res.status(500).json({ error: "PDF generation failed" });

    // PERSISTENCE FIX: /tmp is ephemeral on cloud platforms — also save base64 (and S3 if enabled)
    // so the PDF survives server restarts.
    let pdfUrl = `${BACKEND_URL || "http://localhost:4000"}/api/features/lead-magnets/pdf/${pdfId}`;
    let pdfBase64 = "";
    let s3Url = "";
    try {
      pdfBase64 = fs.readFileSync(filepath).toString("base64");
      // If S3 is configured, upload there — much more reliable than /tmp
      try {
        const { isS3Enabled, uploadBase64ToS3 } = require("../utils/s3");
        if (typeof isS3Enabled === "function" && isS3Enabled() && typeof uploadBase64ToS3 === "function") {
          s3Url = await uploadBase64ToS3(pdfBase64, `lead-magnets/generated/${pdfId}.pdf`, "application/pdf");
          if (s3Url) pdfUrl = s3Url;  // S3 URL is the durable one
        }
      } catch(e) { console.warn("[lead-magnets/generate-pdf] S3 upload failed, falling back:", e.message); }
    } catch(e) { console.warn("[lead-magnets/generate-pdf] base64 read failed:", e.message); }

    // Store both references — base64 in DB serves as fallback if /tmp is cleared
    db.exec("CREATE TABLE IF NOT EXISTS generated_pdfs (id TEXT PRIMARY KEY, user_id TEXT, filename TEXT, filepath TEXT, title TEXT, base64 TEXT, s3_url TEXT, created_at TEXT DEFAULT (datetime('now')))");
    // Add columns if upgrading from older schema (idempotent)
    try { db.exec("ALTER TABLE generated_pdfs ADD COLUMN base64 TEXT"); } catch(_) {}
    try { db.exec("ALTER TABLE generated_pdfs ADD COLUMN s3_url TEXT"); } catch(_) {}
    db.prepare("INSERT INTO generated_pdfs (id, user_id, filename, filepath, title, base64, s3_url) VALUES (?,?,?,?,?,?,?)")
      .run(pdfId, req.userId, filename, filepath, content.title, pdfBase64, s3Url);

    res.json({ success: true, pdfUrl, pdfId });
  } catch(e) { console.error("[Route] PDF generation error: ", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// Serve generated PDF — checks /tmp first, then DB fallback for base64, then S3 redirect
router.get("/lead-magnets/pdf/:pdfId", (req, res) => {
  const fs = require("fs");
  const path = require("path");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(req.params.pdfId)) return res.status(400).send("Invalid PDF ID");
  const filepath = path.join("/tmp", `lead-magnet-${req.params.pdfId}.pdf`);
  if (!filepath.startsWith("/tmp/")) return res.status(400).send("Invalid path");

  // 1. Fast path: serve from /tmp if file exists
  if (fs.existsSync(filepath)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="lead-magnet.pdf"`);
    return fs.createReadStream(filepath).pipe(res);
  }

  // 2. Fallback: load from generated_pdfs table (survives /tmp clearing)
  try {
    const db = getDb();
    const row = db.prepare("SELECT s3_url, base64 FROM generated_pdfs WHERE id = ?").get(req.params.pdfId);
    if (row?.s3_url) return res.redirect(row.s3_url);
    if (row?.base64) {
      const buf = Buffer.from(row.base64, "base64");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="lead-magnet.pdf"`);
      return res.end(buf);
    }
  } catch(e) {}

  return res.status(404).send("PDF not found");
});

// ═══════════════════════════════════════════════════
// REVIEW COLLECTION PAGE (public)
// ═══════════════════════════════════════════════════

router.get("/reviews/submit/:siteId", (req, res) => {
  const safeSiteId = String(req.params.siteId || '').replace(/[^a-zA-Z0-9_-]/g, '');  // sanitize before interpolating into served HTML/JS
  const db = getDb();
  const site = db.prepare("SELECT name, user_id FROM sites WHERE id = ?").get(safeSiteId);
  const _escRv = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const bizName = _escRv(site?.name || "Business");

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leave a Review — ${bizName}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8f8f8;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px;max-width:440px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:22px;margin-bottom:4px;text-align:center}
.stars{display:flex;justify-content:center;gap:8px;margin:20px 0;font-size:36px}
.star{cursor:pointer;opacity:.3;transition:all .2s}.star.active{opacity:1;transform:scale(1.1)}
input,textarea{width:100%;padding:12px 16px;border:2px solid #E8E6F0;border-radius:10px;font-size:14px;font-family:inherit;outline:none;margin-bottom:10px}
input:focus,textarea:focus{border-color:#2563EB}
.btn{width:100%;padding:14px;background:#2563EB;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer}
.btn:disabled{opacity:.5}.success{text-align:center;padding:20px}.footer{text-align:center;margin-top:20px;font-size:11px;color:#999}
</style></head><body>
<div class="card">
<div id="form-view">
<h1>How was your experience?</h1>
<p style="text-align:center;color:#666;font-size:13px;margin-bottom:16px">Leave a review for ${bizName}</p>
<div class="stars" id="stars">
${[1,2,3,4,5].map(n => `<span class="star" data-val="${n}" onclick="setRating(${n})">⭐</span>`).join("")}
</div>
<input type="text" id="name" placeholder="Your name"/>
<input type="email" id="email" placeholder="Your email"/>
<textarea id="comment" rows="3" placeholder="Tell us about your experience..."></textarea>
<button class="btn" onclick="submitReview()" id="btn">Submit Review</button>
</div>
<div id="success-view" class="success" style="display:none">
<div style="font-size:48px;margin-bottom:12px">🎉</div>
<h2 style="font-size:20px;margin-bottom:8px">Thank you!</h2>
<p style="color:#666;font-size:14px">Your review has been submitted. We really appreciate your feedback.</p>
</div>
<div class="footer">Powered by <a href="https://takeova.ai" style="color:#2563EB;text-decoration:none"><strong>MINE</strong></a></div>
</div>
<script>
var rating=0;
function setRating(n){rating=n;document.querySelectorAll('.star').forEach(function(s){s.classList.toggle('active',parseInt(s.dataset.val)<=n);});}
async function submitReview(){
  var name=document.getElementById('name').value.trim();
  var email=document.getElementById('email').value.trim();
  var comment=document.getElementById('comment').value.trim();
  if(!rating){alert('Please select a star rating');return;}
  document.getElementById('btn').disabled=true;document.getElementById('btn').textContent='Submitting...';
  var r=await fetch('/api/features/reviews/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteId:'${safeSiteId}',rating:rating,name:name,email:email,comment:comment})});
  var d=await r.json();
  if(d.success){document.getElementById('form-view').style.display='none';document.getElementById('success-view').style.display='block';}
  else{document.getElementById('btn').disabled=false;document.getElementById('btn').textContent='Submit Review';}
}
</script></body></html>`);
});

// Store review
router.post("/reviews/submit", reviewSubmitLimiter, async (req, res) => {
  try {
    const { siteId, rating, name, email, comment } = req.body;
    const db = getDb();

    // Input validation
    const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email && !_EMAIL_RE.test(String(email))) return res.status(400).json({ error: "Invalid email" });
    const safeRating = Math.min(5, Math.max(1, parseInt(rating) || 5));
    const safeName = String(name || "").slice(0, 100);
    const safeComment = String(comment || "").slice(0, 2000);

    db.exec("CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, customer_name TEXT, customer_email TEXT, rating INTEGER, comment TEXT, approved INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))");

    const site = db.prepare("SELECT user_id, name FROM sites WHERE id = ?").get(siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    const id = uuid();
    db.prepare("INSERT INTO reviews (id, site_id, user_id, customer_name, customer_email, rating, comment) VALUES (?,?,?,?,?,?,?)")
      .run(id, siteId, site.user_id, safeName, email ? String(email).toLowerCase().slice(0, 254) : "", safeRating, safeComment);

    // Notify owner
    notifyOwner(site.user_id, "⭐", `New ${rating}-star review from ${name || email || "customer"}: "${(comment || "").slice(0, 60)}"`);

    res.json({ success: true, id });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" }); }
});

// List reviews for user's sites

// ═══════════════════════════════════════════════════════════
// TUTORIALS — Step-by-step guides for every MINE feature
// ═══════════════════════════════════════════════════════════

router.get("/tutorials", (req, res) => {
  const tutorials = [
    {id:"t1",cat:"Getting Started",title:"Create Your Account",icon:"🚀",steps:[
      {do:"Go to takeova.ai and click 'Get Started'",after:"The signup form opens with name, email, and password fields."},
      {do:"Enter your name, email, and create a password",after:"Your account is created instantly. A referral code is auto-generated for you."},
      {do:"Choose the Starter plan ($79/mo) — includes a 3-day free trial",after:"Growth/Pro/Enterprise charge immediately. Only Starter has a trial. Card is required but you won't be charged for 3 days."},
      {do:"Enter your card details and confirm",after:"You're taken straight to the dashboard. The onboarding wizard opens automatically."},
      {do:"Complete the onboarding wizard: business name → type → description → features → design",after:"AI builds your complete website in under 60 seconds. You also receive a welcome email with your referral link and getting-started tips."},
      {do:"",after:"💡 Tip: Day 3 and Day 7 nudge emails are auto-scheduled to help you stay on track if you haven't published yet."}
    ]},
    {id:"t2",cat:"Getting Started",title:"Build Your First Site with AI",icon:"🏗️",steps:[
      {do:"After signup, the onboarding wizard opens. Enter your business name",after:"This becomes your site name, email sender name, and subdomain (e.g. yourbiz.takeova.ai)."},
      {do:"Select your business type (Store, Service, Course, etc.)",after:"AI uses this to choose the right layout, features, and sample content for your industry."},
      {do:"Describe your business in 1-2 sentences",after:"The more detail you give, the better the site. 'Yoga studio offering hot yoga, sound baths, and teacher training in Brisbane' beats 'yoga studio'."},
      {do:"Pick features you want (booking calendar, shop, blog, etc.)",after:"AI includes only what you select — no clutter."},
      {do:"Click 'Build My Site' and wait ~60 seconds",after:"AI generates a full multi-section website with hero, features, products/services, pricing, testimonials, FAQ, footer, and all your chosen features."},
      {do:"Review your site in the preview panel",after:"You can see exactly how it looks on desktop and mobile."},
      {do:"Use the edit box to make changes: 'make the header bigger' or 'add a contact form'",after:"AI regenerates the relevant sections. You can edit as many times as your plan allows (10-30 edits/mo)."},
      {do:"Upload inspiration images if you want to match a specific style",after:"AI analyses the colours, layout, typography, and feel of your reference images and rebuilds the site to match."},
      {do:"",after:"💡 Tip: Every published site automatically includes: AI chatbot, customer login widget, page view tracking, form submission handler, and loyalty program widget. Zero setup."}
    ]},
    {id:"t3",cat:"Getting Started",title:"Publish Your Site",icon:"🌐",steps:[
      {do:"Go to the Sites tab in your dashboard",after:"You see all your sites with status (draft/live), views, revenue, and domain."},
      {do:"Click 'Publish' on your site",after:"Site deploys to yourbusiness.takeova.ai. If Cloudflare is configured by admin, it goes to Cloudflare Pages for production-grade hosting."},
      {do:"To add a custom domain: enter it in the Custom Domain field and click Connect",after:"MINE tells you what DNS records to set up."},
      {do:"Point your domain's CNAME record to takeova.ai at your DNS provider",after:"Propagation takes 5-30 minutes. After that, your site is live on your custom domain with SSL."},
      {do:"",after:"💡 What's auto-injected on publish: AI chatbot (if enabled), customer login widget, page view analytics tracking, form submission auto-notify, loyalty widget, and phone call button (if AI Receptionist is active). All without any code from you."}
    ]},
    {id:"t4",cat:"Products & Selling",title:"Add Products to Your Store",icon:"🛒",steps:[
      {do:"Go to the Products tab and click '+ Add Product'",after:"A form opens for product details."},
      {do:"Fill in: name, price, description, and upload an image",after:"The product is saved to your site's product catalog."},
      {do:"For physical products: set shipping rates and enable inventory tracking",after:"You can set stock count and low-stock threshold. When stock drops below the threshold, you get a notification. When a customer buys, inventory auto-decrements."},
      {do:"For digital products: upload the file (PDF, video, etc.)",after:"Customers get a secure download link after purchase with a 7-day expiry and 5-download limit. The link is unique per purchase."},
      {do:"Add variants if needed (size, colour, material)",after:"Customers choose from dropdowns on your product page."},
      {do:"Click Save",after:"Product appears on your published site immediately. Customers can buy it through Stripe checkout. Shipping address is collected for physical products (26 countries supported)."},
      {do:"",after:"💡 After a purchase: order auto-created, confirmation email sent to customer, owner notified, inventory updated, transaction recorded in accounting, loyalty points awarded, abandoned cart recovery activated if they leave checkout early."}
    ]},
    {id:"t5",cat:"Products & Selling",title:"Manage Orders",icon:"📦",steps:[
      {do:"When a customer buys, the order appears in your Orders tab automatically",after:"You also get a 🔔 notification in the dashboard and an email. The customer gets an order confirmation email with a 'Track your order' link."},
      {do:"Click '📦 Mark Shipped' → enter tracking number and carrier",after:"Customer receives a shipping email with a carrier-specific tracking link (USPS, UPS, FedEx, DHL, AusPost, Royal Mail). If they have a phone number, they also get an SMS. The order status page updates to show 'Shipped'."},
      {do:"When the item arrives, click '✅ Mark Delivered'",after:"Customer gets a delivery confirmation email. The public order status page shows 'Delivered'."},
      {do:"3 days after delivery, the customer automatically receives a review request email",after:"The email links to your review page where they can leave a 1-5 star rating and comment. You get notified when they submit."},
      {do:"To refund: click '↩️ Refund' and confirm",after:"Stripe processes the refund to the customer's card (takes 5-10 business days). A refund confirmation email is sent. The transaction is recorded as an expense in your Accounting tab. You get a notification."},
      {do:"Click '📧 Email' to message the customer directly",after:"Opens your email client with the customer's address pre-filled."},
      {do:"",after:"💡 The order status page at /orders/status/:orderNumber is public. Customers can check it anytime — it shows a visual step tracker: Confirmed → Processing → Shipped → Delivered with tracking link."}
    ]},
    {id:"t6",cat:"Products & Selling",title:"Set Up Payments with Stripe",icon:"💳",steps:[
      {do:"The platform admin sets up Stripe API keys in the admin dashboard",after:"This enables payments for all users on the platform."},
      {do:"When a customer buys from your store, they go through Stripe checkout",after:"Stripe handles card processing, fraud detection, and PCI compliance. You don't touch sensitive card data."},
      {do:"Payment is confirmed via webhook",after:"Order is auto-created, confirmation email sent, inventory decremented, accounting transaction recorded, loyalty points awarded — all automatically."},
      {do:"Revenue appears in your Accounting tab",after:"Every sale is categorised automatically: Product Sales, Course Sales, or Service Revenue. Platform fees are recorded as 'Payment Processing' expenses."},
      {do:"",after:"💡 Failed payments: If a customer's card is declined on a subscription renewal, they receive a dunning email asking them to update their card. A second reminder is sent 2 days later. Their account is paused if payment fails again."}
    ]},
    {id:"t7",cat:"Bookings",title:"Accept Bookings & Appointments",icon:"📅",steps:[
      {do:"Go to the Bookings tab",after:"You see all upcoming bookings with customer info, service, date, time, and status."},
      {do:"Set your business hours in availability settings",after:"Configure: open hours per day, timezone, buffer time between appointments, slot duration, and blocked dates. Public API uses this to show only available slots."},
      {do:"When a customer books through your site",after:"A booking is created with status 'confirmed'. Customer receives confirmation email with a 'Manage your booking' link. You get a 🔔 notification. The contact is auto-enrolled in any 'Booking confirmed' funnels."},
      {do:"Reminders are sent automatically",after:"24 hours before: email reminder. 1 hour before: email + SMS reminder. Both include booking details and the manage link."},
      {do:"Customers can cancel themselves via the manage link",after:"They see a public page with booking details and a Cancel button. Cancelling: removes pending reminders, notifies you, and sends confirmation email to the customer."},
      {do:"View the Calendar tab for a monthly overview",after:"Calendar shows all bookings by day with customer names, times, and colour-coded status. Click any day to see details."},
      {do:"",after:"💡 The customer is also auto-added to your CRM contacts and enrolled in matching email funnels. Everything connects."}
    ]},
    {id:"t8",cat:"Courses & Coaching",title:"Create an Online Course",icon:"🎓",steps:[
      {do:"Go to the Courses tab and click '+ Create Course'",after:"A form opens for course details with module and lesson builders."},
      {do:"Enter course title, description, and price",after:"This is what students see on your site's course catalog."},
      {do:"Add Modules (e.g. 'Week 1: Basics', 'Week 2: Advanced')",after:"Modules are the chapters of your course. You can add as many as you need."},
      {do:"Inside each module, add Lessons with: title, type (Video/PDF/Text), and content URL",after:"For videos: paste YouTube, Vimeo, or Loom links. For PDFs: upload the file or paste a URL. Students see a Watch or Download button for each lesson."},
      {do:"Optional: enable Drip Content",after:"Configure which modules unlock after how many days. E.g. Module 2 unlocks 7 days after enrollment. Students see locked modules with 'Unlocks in X days'."},
      {do:"Optional: add Quizzes",after:"Create multiple-choice questions with point values and a pass score. Students submit and get instant results with score and pass/fail."},
      {do:"Click Publish",after:"Course appears on your site. Students can enroll via Stripe checkout."},
      {do:"",after:"💡 After enrollment: welcome email sent (with My Courses login link), day-3 progress nudge scheduled, and when they finish all lessons, they get a completion certificate email. You can see all students' progress from the '👥 Progress' button on the course card."}
    ]},
    {id:"t9",cat:"Courses & Coaching",title:"How Students Access Your Course",icon:"👩‍🎓",steps:[
      {do:"Student enrolls by paying through Stripe checkout",after:"Payment processed, enrollment recorded, welcome email sent automatically."},
      {do:"Student opens the 'My Courses' link from the email",after:"Takes them to /student/my-courses — the student login page."},
      {do:"Student enters their email and receives a 6-digit code",after:"OTP login — no password needed. Code expires in 10 minutes."},
      {do:"After login, they see all enrolled courses with progress bars",after:"Each course shows: name, business name, progress %, completed/total lessons, enrolled date."},
      {do:"Click a course to open the full portal",after:"Shows all modules and lessons with: checkable completion boxes, lesson type badges (🎥 Video, 📄 PDF, 📝 Text), and Watch/Download buttons. Locked modules show when they unlock."},
      {do:"Student clicks checkboxes as they complete lessons",after:"Progress saves instantly. Progress bar updates in real-time."},
      {do:"When all lessons are complete",after:"🎉 banner appears on the portal. Student gets a completion certificate email with course name and date."},
      {do:"",after:"💡 You see all students' progress from your dashboard: Courses tab → click '👥 Progress' on any course. Shows each student's email, completed/total lessons, and percentage."}
    ]},
    {id:"t10",cat:"Invoicing",title:"Create & Send Invoices",icon:"💳",steps:[
      {do:"Go to the Invoices tab and click '+ Create Invoice'",after:"A form opens for client details and line items."},
      {do:"Add: client name, email, items with descriptions and amounts, due date",after:"Invoice total calculates automatically."},
      {do:"Click Send",after:"Client receives a branded email from your business name with invoice details, itemised breakdown, and a Pay Now button. Invoice status changes to 'Sent'. Client auto-enrolled in 'Invoice sent' funnels."},
      {do:"When client pays: click 'Mark Paid'",after:"Calls the backend — client gets a receipt email with green PAID badge. Transaction recorded in your Accounting tab. You get a notification."},
      {do:"If invoice passes due date without payment",after:"Hourly cron detects it. Auto-sends overdue reminder email with Pay Now button. Only sends once per invoice to avoid spamming."},
      {do:"",after:"💡 All invoice emails show your business name as sender, include your referral link in the footer, and have an unsubscribe option for marketing compliance."}
    ]},
    {id:"t11",cat:"Contracts",title:"Create & Send Contracts for E-Signature",icon:"📜",steps:[
      {do:"Go to the Contracts tab and click '+ Create Contract'",after:"Enter what you need: 'freelance web design contract for 3 months at $5,000/month'."},
      {do:"AI drafts the full contract text",after:"Claude generates professional legal language with all standard clauses. Review and edit as needed."},
      {do:"Click Send → enter client's email",after:"Client receives an email with a unique signing link. The link is one-time-use and secure."},
      {do:"Client opens the signing page",after:"They see the full contract text on a mobile-responsive page. At the bottom is a canvas signature pad."},
      {do:"Client draws their signature and clicks Sign",after:"Signature captured. Contract status changes to 'Signed'. You receive a notification. Both parties can download the signed PDF."},
      {do:"",after:"💡 Replaces DocuSign at no extra cost. The signing page works on desktop and mobile. No account needed for the client — just click and sign."}
    ]},
    {id:"t12",cat:"CRM",title:"Manage Contacts & Leads",icon:"👥",steps:[
      {do:"Go to the CRM tab",after:"You see all contacts in a table with name, email, status, value, source, and last seen."},
      {do:"Contacts are auto-added from multiple sources",after:"Chatbot (email detection), form submissions, lead magnets, purchases, bookings, phone calls, and CSV imports. Each contact shows the source it came from."},
      {do:"To add manually: click '+ Add Contact'",after:"Enter name, email, phone, status (lead/customer/partner), notes, and tags."},
      {do:"To import: click '📥 Import CSV'",after:"Upload a CSV with name, email, phone, tags columns. Duplicates detected by email and skipped. Shows 'Imported 847 contacts (23 duplicates skipped)'."},
      {do:"Click the 📋 icon on any contact to see their full activity",after:"Shows ALL interactions in one view: orders, bookings, support tickets, course enrollments, emails sent (with open/click status), invoices, and loyalty points. Sorted by date."},
      {do:"Use tags to segment contacts",after:"Tags let you filter contacts for broadcast emails, funnels, and lead magnets."},
      {do:"",after:"💡 The CRM is the central hub. Every system feeds into it: chatbot captures leads, forms capture leads, lead magnets capture leads, purchases create customers, bookings create contacts, phone calls create contacts. Everything connects to one profile."}
    ]},
    {id:"t13",cat:"Email Marketing",title:"Create an Email Funnel",icon:"📧",steps:[
      {do:"Go to the Funnels tab and click '+ Create Funnel'",after:"A form opens with funnel name, trigger, and email steps."},
      {do:"Name your funnel (e.g. 'Welcome Series', 'Post-Purchase Upsell')",after:"This name is only visible to you in the dashboard."},
      {do:"Choose a trigger event",after:"8 options: New signup, Purchase completed, Cart abandoned, Invoice sent, Booking confirmed, Form submitted, Course enrolled, Subscription renewed. When this event happens, contacts auto-enroll."},
      {do:"Add email steps: each has Subject, Body, and Day delay",after:"Day 0 = immediately. Day 3 = 3 days after enrollment. Day 7 = one week later. You can add as many steps as you want."},
      {do:"Click '✨ AI Write' on any step",after:"AI generates the email body based on the subject line and your business name. Review and edit."},
      {do:"Click Create Funnel → set status to Active",after:"Funnel is live. The hourly cron checks all enrollments and sends emails that are due."},
      {do:"View stats on each step",after:"Shows: sent count, opened count (%), clicked count (%). Every funnel email has an open tracking pixel, click tracking, and unsubscribe link."},
      {do:"You can create unlimited funnels",after:"Multiple funnels can trigger on the same event. E.g. a purchase could trigger both a 'Post-Purchase Thank You' and a 'Product Tips' funnel simultaneously."},
      {do:"",after:"💡 Quick-start templates are available: Welcome Series, Abandoned Cart, Post-Purchase, Invoice Reminder, Lead Nurture. Click any template to pre-fill the form."}
    ]},
    {id:"t14",cat:"Email Marketing",title:"Send a Broadcast Email",icon:"📣",steps:[
      {do:"Go to the Funnels tab and click '📧 Broadcast'",after:"A full editor modal opens."},
      {do:"Enter a subject line",after:"Tip: Click '💡 Subject Ideas' to get 3 AI-generated alternatives for higher open rates."},
      {do:"Choose who to send to: All, Leads only, or Customers only",after:"The segment pulls from your contacts table + customer accounts. Duplicates are merged."},
      {do:"Write your email body",after:"Use {{name}} to personalise with the contact's name. Line breaks are preserved. Click '✨ AI Write Body' to auto-generate the entire email."},
      {do:"Click '📤 Send Broadcast' and confirm",after:"Emails sent to all matching contacts. Unsubscribed contacts are automatically skipped. Each email gets an open tracking pixel. Shows result: '247 delivered (3 failed)'."},
      {do:"Check results in the Analytics tab",after:"Email Performance section shows total sent, open rate %, click rate %."},
      {do:"",after:"💡 Every broadcast email includes: your business name as sender, unsubscribe link (CAN-SPAM), open/click tracking, and your TAKEOVA referral link in the footer."}
    ]},
    {id:"t15",cat:"AI Employees",title:"Hire Your First AI Employee",icon:"🤖",steps:[
      {do:"Go to the Team tab (requires Pro or Enterprise plan)",after:"You see 7 AI employees with their roles, prices, and what they do."},
      {do:"Click 'Hire' on the employee you want",after:"Sales Rep $49/mo, Receptionist $129/mo, Social Manager $59/mo, Marketing Manager $79/mo, Support Agent $49/mo, Bookkeeper $49/mo, Customer Success $49/mo."},
      {do:"Choose an autonomy level",after:"Full Auto: AI acts immediately without asking. Approve First: AI drafts actions, you review and click Approve or Reject. Suggestions Only: AI recommends, you execute manually."},
      {do:"Configure the employee: business context, rules, brand voice",after:"The more context you give, the better it performs. E.g. 'We're a premium yoga studio. Never discount below 20%. Always recommend the unlimited membership first.'"},
      {do:"Toggle the employee ON",after:"It starts working immediately — on the next hourly cron cycle."},
      {do:"View all actions in Team → Actions view",after:"Every action shows: which employee, what action, reasoning, draft content, and status (pending/completed/rejected). Click Approve or Reject on pending items."},
      {do:"Chat with any employee in Team → Chat view",after:"Click the employee card → type instructions. E.g. 'Focus on following up with leads from last week' or 'What's our best-performing social post?'. AI responds using your real business data."},
      {do:"",after:"💡 You can have multiple employees active at once. A typical Pro user might run: Sales Rep (follow up leads) + Social Manager (daily posts) + Support Agent (ticket replies). They all work independently but share your business data."}
    ]},
    {id:"t16",cat:"Lead Magnets",title:"Create a Lead Magnet",icon:"🧲",steps:[
      {do:"Go to the Socials tab → Lead Magnets section → click '+ New Lead Magnet'",after:"A form opens with three ways to create your resource."},
      {do:"Option 1 — AI Generate: type the topic and pick a type",after:"Types: Checklist, Guide, Cheat Sheet, Template, Workbook, Toolkit. AI writes the full content with sections and items. You can review and regenerate if needed."},
      {do:"Click '📄 Create PDF'",after:"Auto-generates a branded, multi-page PDF with cover page, colour-coded sections, items, CTA, and 'Created with MINE' footer. No design tools needed."},
      {do:"Option 2 — Upload: drag and drop your own file",after:"Supports PDF, images, and video up to 10MB. File is uploaded to your TAKEOVA storage and a URL is generated."},
      {do:"Option 3 — Paste URL: link to an externally hosted resource",after:"Use this if you already have the resource on Google Drive, Dropbox, etc."},
      {do:"Set trigger words",after:"Default: LINK, FREE, SEND, ME, WANT, HOW, GUIDE. When someone comments any of these on your post, the auto-reply fires. You can add or remove words to match your audience."},
      {do:"Set auto-reply messages",after:"Comment Reply: what gets posted publicly (e.g. 'Check your DMs! 📩'). DM Message: what gets sent privately (e.g. 'Hey {{name}}! Here\'s what you requested: {{link}}'). {{name}} and {{link}} are auto-replaced."},
      {do:"Click '✨ Generate Post' → AI writes a social post",after:"Post promotes the lead magnet and tells people to comment a trigger word. You can edit before publishing."},
      {do:"Click 'Save + Publish Post'",after:"Post goes live on all connected platforms. Lead magnet auto-triggers on comments to that specific post."},
      {do:"",after:"💡 Full flow: Someone sees your post → comments 'LINK' → gets auto-reply comment + DM with gated landing page → enters email on landing page → gets the resource → email captured in your CRM as a lead → auto-enrolled in funnels. All automatic."}
    ]},
    {id:"t17",cat:"Social Media",title:"Post to Social Media",icon:"📱",steps:[
      {do:"Go to the Socials tab",after:"You see: autopilot toggle, connected accounts, Quick Post composer, and post history."},
      {do:"Connect accounts via the Connect buttons",after:"OAuth login for Facebook, Instagram, TikTok, X, LinkedIn, YouTube, Google. MINE never stores your password."},
      {do:"Write a post in the Quick Post box",after:"Or click '✨ AI Generate' — AI writes a post matching your brand voice and business. If you've uploaded inspiration images, AI matches the tone and style."},
      {do:"Attach images or videos (up to 4)",after:"Upload from your device or pick from AI-generated images in your Ads tab."},
      {do:"Click '📤 Post to All'",after:"Your post goes to all connected platforms simultaneously. Appears in your post history with platform badges and timestamps."},
      {do:"To automate: hire AI Social Manager ($59/mo) and toggle Autopilot ON",after:"AI generates daily posts using Perplexity trend research for your niche. Uses your actual products, prices, and events. Scheduled at optimal times."},
      {do:"Choose autonomy: Full Auto, Approve First, or Suggestions Only",after:"Full Auto posts without asking. Approve First drafts posts and waits for your approval in the Actions queue."},
      {do:"",after:"💡 The AI Social Manager researches trending hashtags, viral formats, competitor strategies, and seasonal opportunities before writing each post. It's not generic — it's specific to your niche and business."}
    ]},
    {id:"t18",cat:"Advertising",title:"Create & Run Ads",icon:"📢",steps:[
      {do:"Go to the Ads tab",after:"You see: autopilot toggle, spend tracking, creative tools, and campaign launcher."},
      {do:"Generate ad images: type a prompt",after:"AI creates the image via DALL-E or Stability AI (whichever is configured). Images saved to your asset library."},
      {do:"Generate ad copy: describe what you're promoting",after:"AI writes 3 variations: social post, email, landing page. Matched to your brand voice."},
      {do:"Add text to images with the built-in editor",after:"Drag text layers onto any generated image. Adjust font size, weight, colour, and background. Save the composited image."},
      {do:"Click '🚀 Push Ad to Socials' to launch a campaign",after:"Select platforms (Facebook, Instagram, TikTok, Google, YouTube, X, LinkedIn). Set daily budget and duration in days. Total spend calculated automatically."},
      {do:"Track performance in real-time",after:"Today's spend, monthly total, per-platform breakdown. Auto-refreshes every 5 minutes."},
      {do:"To automate: hire AI Marketing Manager ($79/mo)",after:"AI creates campaigns, adjusts budgets based on performance, pauses underperformers, A/B tests copy, and reallocates spend to winners."},
      {do:"",after:"💡 AI Video Ads are also available: type a prompt and Runway AI generates a 30-second video ad. Or use HeyGen for UGC-style avatar videos ($0.25/sec, $1 minimum — 15s=$3.75, 30s=$7.50, 60s=$15)."}
    ]},
    {id:"t19",cat:"Website Features",title:"Configure Your AI Chatbot",icon:"💬",steps:[
      {do:"Go to the Chatbot tab",after:"You see chatbot settings and customisation options."},
      {do:"Your chatbot is auto-injected on published sites",after:"No embed code, no JavaScript snippet, no setup. It appears as a floating 💬 button on every published site."},
      {do:"Customise: name, greeting, personality, position, colours, auto-open delay",after:"E.g. name: 'Luna', greeting: 'Hey! Looking for the perfect yoga class?', personality: 'friendly and casual', auto-open: 5 seconds."},
      {do:"Add custom instructions",after:"E.g. 'Always recommend the Premium plan first. Never give refund information — direct to email instead. Collect email before answering pricing questions.'"},
      {do:"The chatbot knows your business automatically",after:"It reads your products, prices, services, courses, FAQ, and business hours from your site data. No manual training needed."},
      {do:"When a visitor shares their email in chat",after:"Automatically detected and added to your CRM contacts table as a lead with source 'chatbot'. Webhook fires for any automations."},
      {do:"",after:"💡 The chatbot uses Claude AI — same technology powering the rest of MINE. It handles questions, recommends products, explains services, and guides customers toward purchases. All responses are based on YOUR real data, not generic answers."}
    ]},
    {id:"t20",cat:"Phone",title:"Set Up the AI Receptionist",icon:"📞",steps:[
      {do:"Go to the Team tab and hire the AI Receptionist ($129/mo)",after:"This is the most powerful AI employee — it handles real phone calls."},
      {do:"Go to the Voice Agent tab and enter your Twilio phone number",after:"This is the number customers will call. Get one from twilio.com ($1/mo for a local number)."},
      {do:"The AI answers every call 24/7",after:"Uses your business data: products with prices, services, hours, policies. Speaks in a natural voice via Amazon Polly through Twilio."},
      {do:"During calls, AI can: answer questions, book appointments, qualify leads, take orders, handle support",after:"If someone asks about booking, AI collects name, preferred date/time, service, and contact info."},
      {do:"After every call",after:"Caller auto-added to CRM contacts with source 'phone call' and notes about their intent. You get a 🔔 notification. Full transcript saved in the Voice Agent tab."},
      {do:"A floating 📞 button auto-appears on your published site",after:"Customers tap it to call directly from their phone. Sits alongside the 💬 chatbot button."},
      {do:"View call history, transcripts, and stats",after:"Voice Agent tab shows: total calls, today's calls, average duration, and all call logs with expandable transcripts."},
      {do:"",after:"💡 Flow: Customer calls → Twilio receives → AI answers with your greeting → customer speaks → Twilio transcribes → Claude processes → response spoken back → conversation continues → call ends → transcript saved, CRM updated, owner notified. All automatic."}
    ]},
    {id:"t21",cat:"Reviews",title:"Collect Customer Reviews",icon:"⭐",steps:[
      {do:"Reviews are collected automatically — no setup needed",after:"The system handles everything."},
      {do:"3 days after a customer purchases, they receive a review request email",after:"The email includes a direct link to your review page."},
      {do:"Review page has: star rating (1-5), name, email, and comment box",after:"Mobile-responsive, branded with your business name. Works on any device."},
      {do:"Customer submits their review",after:"Review stored in the database. You get a 🔔 notification: 'New 5-star review from Sarah: Amazing service!'"},
      {do:"View all reviews in the Reviews tab",after:"Shows all reviews with ratings, names, comments, and dates. Review page link shown at bottom for manual sharing."},
      {do:"",after:"💡 You can also share the review page link manually — it's always at /reviews/submit/your-site-id. Put it in your email signature, on social media, or in follow-up emails."}
    ]},
    {id:"t22",cat:"Loyalty",title:"Set Up a Loyalty Program",icon:"🏆",steps:[
      {do:"Go to the CRM tab → scroll to 'Customer Loyalty Program' → click Enable",after:"Configuration panel opens with all settings."},
      {do:"Set points rules: points per dollar, signup bonus, referral bonus, review bonus, birthday bonus",after:"E.g. 1 point per $1, 50 points signup bonus, 100 points referral bonus."},
      {do:"Set tiers: Bronze, Silver, Gold, Platinum",after:"Each tier has a minimum points threshold and perks. E.g. Silver at 500 points gets 5% off all orders."},
      {do:"Add milestones: First Purchase, 5 Orders, $500 Spent",after:"Each milestone awards bonus points when reached. Shows as checkboxes in the customer portal."},
      {do:"Add rewards: $5 Off, $10 Off, Free Shipping",after:"Each has a point cost. Customers redeem from the loyalty widget on your site and get a unique coupon code."},
      {do:"Save your loyalty configuration",after:"The loyalty widget appears automatically on your published site for logged-in customers. Shows: points balance, current tier, progress to next tier, redeemable rewards, and active coupon codes."},
      {do:"",after:"💡 Points are awarded automatically: purchase (per dollar), signup (bonus), referral (bonus), review (bonus), course completion (bonus). No manual action needed. The customer portal shows everything."}
    ]},
    {id:"t23",cat:"Accounting",title:"Track Revenue & Expenses",icon:"📒",steps:[
      {do:"Go to the Accounting tab",after:"Dashboard shows: this month's income, expenses, net profit, vs last month growth %, uncategorised count, and 6-month trend chart."},
      {do:"Revenue is recorded automatically from every Stripe sale",after:"Categorised as Product Sales, Course Sales, or Service Revenue based on what was purchased. Platform fees recorded as Payment Processing expense."},
      {do:"Refunds are auto-recorded as expenses under 'Refunds' category",after:"When you process a refund from the Orders tab, it appears here automatically."},
      {do:"To add a manual transaction: click '+ Add Transaction'",after:"Choose Income or Expense. Enter amount, description, category (14 built-in options), and date."},
      {do:"Click '📊 P&L Report' for any month",after:"Shows income by category vs expenses by category. Net profit with margin percentage in a big coloured box."},
      {do:"Click '🔮 Forecast' for revenue projection",after:"6-month forward forecast based on your trailing 3-month average growth rate."},
      {do:"",after:"💡 The AI Bookkeeper (add-on) automates this further: categorises uncategorised transactions, flags unusual expenses, chases overdue invoices, and generates weekly financial summaries emailed to you every Monday."}
    ]},
    {id:"t24",cat:"Analytics",title:"View Your Site Analytics",icon:"📊",steps:[
      {do:"Go to the Analytics tab",after:"Data loads automatically from the page view tracking system."},
      {do:"Top stats: Visitors (30 days), Today, Unique Visitors, Revenue",after:"All real data from the tracking script auto-injected on every published site."},
      {do:"Daily visitor bar chart shows traffic over time",after:"One bar per day for the last 30 days. See patterns: which days get the most traffic."},
      {do:"Top Pages: which URLs get the most views",after:"See if visitors are hitting your products page, blog, or pricing page most."},
      {do:"Traffic Sources: where visitors come from",after:"Google, Instagram, Facebook, direct, referral sites. Helps you know where to focus marketing."},
      {do:"Email Performance: total sent, open rate %, click rate %",after:"Aggregated across all email systems: funnels, broadcasts, AI employees, transactional."},
      {do:"",after:"💡 No setup needed. The tracking script is injected automatically when you publish your site. Works immediately."}
    ]},
    {id:"t25",cat:"Automations",title:"Create Workflow Automations",icon:"⚡",steps:[
      {do:"Go to the Automations tab and click '+ Create Automation'",after:"A form opens with trigger and action selectors."},
      {do:"Choose a trigger: new lead, booking, purchase, cart abandoned, form submitted, review posted, etc.",after:"This is the event that starts the automation."},
      {do:"Choose an action: send email, send SMS, add tag, update contact, webhook, etc.",after:"This is what happens when the trigger fires."},
      {do:"Save and activate",after:"The automation runs automatically every time the trigger event occurs. No manual intervention."},
      {do:"",after:"💡 Automations are simpler than funnels — one trigger, one action. Use funnels for multi-step email sequences. Use automations for instant one-off actions like 'when form submitted → send SMS to me' or 'when review posted → add tag VIP'."}
    ]},
    {id:"t26",cat:"Affiliates",title:"Earn Money Referring MINE",icon:"🤝",steps:[
      {do:"Every MINE user gets a referral code automatically on signup",after:"Found in the Referrals tab. Your code is in the referral link: takeova.ai?ref=YOURCODE."},
      {do:"Share your referral link anywhere",after:"Blog, social media, email signature, YouTube description."},
      {do:"When someone clicks your link and signs up for a paid plan",after:"They're tagged as your referral. You earn recurring commission on every payment they make."},
      {do:"Commission tiers based on total referral revenue",after:"13% at start → 15% at $1K revenue → 17% at $5K → 20% at $10K+. Tiers are permanent — once you reach a level, you stay there."},
      {do:"View earnings and referrals in the Referrals tab",after:"Shows: active referrals, total revenue generated, commission earned, current tier."},
      {do:"Non-users can join as Partners at /partners/signup",after:"They get their own OTP-login dashboard with: clicks, signups, earnings, referral link, tier progress, and Stripe Connect payouts."},
      {do:"",after:"💡 Your referral link is also auto-included in the footer of every email your business sends through MINE. Passive referrals from your customers."}
    ]},
    {id:"t27",cat:"Client Portal",title:"Set Up a Client Portal",icon:"🏢",steps:[
      {do:"Go to the Client Portal tab",after:"Configuration panel opens for portal settings."},
      {do:"Set your portal name and welcome message",after:"This is what clients see when they open their portal."},
      {do:"Click 'Invite' → enter client name and email",after:"System generates a unique portal link (token-based, no password needed). Link is copied to your clipboard."},
      {do:"Send the link to your client",after:"They click it and see a branded page with: their invoices, project status, upcoming bookings, and signed contracts."},
      {do:"Each client sees only their own data",after:"Token-based authentication ensures privacy. They can't see other clients' information."},
      {do:"",after:"💡 Replaces HoneyBook and Dubsado client portals. Great for agencies, consultants, freelancers, and service businesses. No extra cost — included in your plan."}
    ]},
    {id:"t28",cat:"Community",title:"Create a Community Forum",icon:"💬",steps:[
      {do:"Go to the Community tab",after:"You see any existing spaces or an empty state."},
      {do:"Click '+ Create Space' — give it a name (e.g. General, Q&A, Introductions)",after:"Space is created and visible to your site members."},
      {do:"Members create posts, reply to discussions, and like content",after:"Great for building engagement around your courses, memberships, or products."},
      {do:"",after:"💡 Replaces Skool ($129/mo), Circle ($39/mo), and Mighty Networks. Your community lives on your own platform, not someone else's."}
    ]},
    {id:"t29",cat:"Outreach",title:"Run Cold Outreach Campaigns",icon:"🎯",steps:[
      {do:"The outreach system is for reaching NEW prospects — separate from funnels",after:"Funnels nurture existing contacts. Outreach finds new ones."},
      {do:"Upload a CSV list with names, emails, and optionally phone numbers",after:"System validates and deduplicates."},
      {do:"Create a campaign: choose channel (email, SMS, or both), set goal, context, and tone",after:"E.g. goal: 'book a discovery call', tone: 'casual and friendly'."},
      {do:"AI writes a unique personalised message for each contact",after:"Not a mail merge — each message is uniquely crafted based on the contact's name and context."},
      {do:"Set follow-up steps with delays",after:"E.g. Follow-up 1 at day 3 if no reply, Follow-up 2 at day 7 with a different angle."},
      {do:"Launch the campaign",after:"Messages go out automatically on schedule. Unsubscribed contacts are skipped. Each email includes unsubscribe link."},
      {do:"",after:"💡 Pricing: $0.008/email, $0.03/SMS. Much cheaper than dedicated outreach tools ($100+/mo). AI personalisation means higher reply rates than generic templates."}
    ]},
    {id:"t30",cat:"Settings",title:"Account Settings & Security",icon:"⚙️",steps:[
      {do:"Go to the Settings tab",after:"You see profile, security, and notification settings."},
      {do:"Update your profile: name, email, password",after:"Changes saved to your account immediately."},
      {do:"Enable 2FA (two-factor authentication)",after:"Adds a second verification step on login using a 6-digit code from an authenticator app. Much more secure."},
      {do:"Set notification preferences",after:"Choose which events trigger 🔔 notifications and emails."},
      {do:"View your current plan and usage in the Usage tab",after:"Shows: plan name, every limit (sites, edits, emails, etc.) with usage meters. See exactly how much you've used and what's left."},
      {do:"Upgrade your plan anytime",after:"Click upgrade → choose a new plan → Stripe processes the change. Limits increase immediately."},
      {do:"",after:"💡 All data is encrypted. Passwords are hashed. API keys are stored encrypted on the backend. MINE never stores customer credit card details — Stripe handles that."}
    ]},
  ]

  res.json({ tutorials });
});

/* ═══════════════════════════════════════════════════════════════
   NEW FEATURES — BACKEND ROUTES
   1. Abandoned Cart Recovery (config + send)
   2. Upsells & Cross-Sells
   3. A/B Testing
   4. Podcast Hosting
   5. Digital Downloads DRM
   6. Product Subscriptions (Subscribe & Save)
═══════════════════════════════════════════════════════════════ */

// ─── INIT TABLES ─────────────────────────────────────────────
try {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cart_recovery_config (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE,
      enabled INTEGER DEFAULT 1,
      delay_mins INTEGER DEFAULT 60,
      discount_pct INTEGER DEFAULT 10,
      email_subject TEXT DEFAULT 'You left something behind 👀',
      email_body TEXT,
      second_email INTEGER DEFAULT 1,
      second_delay_hrs INTEGER DEFAULT 24,
      second_subject TEXT DEFAULT 'Last chance — your cart expires soon',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS upsells (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      trigger_product TEXT DEFAULT 'any',
      upsell_product TEXT,
      upsell_price REAL DEFAULT 0,
      discount_pct INTEGER DEFAULT 0,
      show_as TEXT DEFAULT 'post_purchase',
      headline TEXT,
      subtext TEXT,
      active INTEGER DEFAULT 1,
      conversions INTEGER DEFAULT 0,
      shown INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ab_tests (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT,
      page TEXT,
      status TEXT DEFAULT 'running',
      variant_a_headline TEXT,
      variant_a_cta TEXT,
      variant_a_visitors INTEGER DEFAULT 0,
      variant_a_conversions INTEGER DEFAULT 0,
      variant_b_headline TEXT,
      variant_b_cta TEXT,
      variant_b_visitors INTEGER DEFAULT 0,
      variant_b_conversions INTEGER DEFAULT 0,
      winner TEXT,
      started TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS podcasts (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT,
      description TEXT,
      category TEXT DEFAULT 'Business',
      author TEXT,
      cover_url TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id TEXT PRIMARY KEY,
      podcast_id TEXT,
      user_id TEXT,
      title TEXT,
      description TEXT,
      audio_url TEXT,
      duration TEXT,
      season INTEGER DEFAULT 1,
      episode INTEGER DEFAULT 1,
      explicit INTEGER DEFAULT 0,
      published_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drm_rules (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      product_id TEXT,
      download_limit INTEGER DEFAULT 3,
      expiry_days INTEGER DEFAULT 365,
      watermark_enabled INTEGER DEFAULT 0,
      watermark_text TEXT DEFAULT '{customer_email}',
      require_login INTEGER DEFAULT 1,
      allow_sharing INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drm_download_log (
      id TEXT PRIMARY KEY,
      rule_id TEXT,
      customer_email TEXT,
      product_id TEXT,
      download_count INTEGER DEFAULT 0,
      first_download TEXT,
      last_download TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      product_id TEXT,
      intervals TEXT,
      active INTEGER DEFAULT 1,
      min_cycles INTEGER DEFAULT 0,
      cancel_anytime INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_sub_subscribers (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      subscription_plan_id TEXT,
      customer_email TEXT,
      customer_name TEXT,
      product TEXT,
      interval_label TEXT,
      interval_days INTEGER DEFAULT 30,
      discount_pct INTEGER DEFAULT 0,
      stripe_subscription_id TEXT,
      status TEXT DEFAULT 'active',
      total_cycles INTEGER DEFAULT 0,
      next_charge TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch(e) { console.error('New features table init error:', e.message); }


/* ══════════════════════════════════════════
   1. ABANDONED CART RECOVERY
══════════════════════════════════════════ */

// GET all abandoned carts for user
router.get('/cart-recovery', auth, (req, res) => {
  try {
    const db = getDb();
    const sites = db.prepare('SELECT id FROM sites WHERE user_id = ?').all(req.userId).map(s => s.id);
    if (!sites.length) return res.json({ carts: [], total: 0, recovered: 0 });
    const ph = sites.map(() => '?').join(',');
    const carts = db.prepare(`SELECT * FROM abandoned_carts WHERE site_id IN (${ph}) ORDER BY created_at DESC LIMIT 100`).all(...sites);
    const recovered = carts.filter(c => c.recovered).length;
    res.json({ carts, total: carts.length, recovered, recovery_rate: carts.length ? Math.round(recovered / carts.length * 100) : 0 });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET cart recovery config
router.get('/cart-recovery/config', auth, (req, res) => {
  try {
    const db = getDb();
    const config = db.prepare('SELECT * FROM cart_recovery_config WHERE user_id = ?').get(req.userId);
    res.json(config || { enabled: true, delay_mins: 60, discount_pct: 10, second_email: true, second_delay_hrs: 24 });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// PUT update cart recovery config
router.put('/cart-recovery/config', auth, (req, res) => {
  try {
    const db = getDb();
    const { enabled, delay_mins, discount_pct, email_subject, email_body, second_email, second_delay_hrs, second_subject } = req.body;
    const id = require('crypto').randomUUID();
    db.prepare(`
      INSERT INTO cart_recovery_config (id, user_id, enabled, delay_mins, discount_pct, email_subject, email_body, second_email, second_delay_hrs, second_subject, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        enabled=excluded.enabled, delay_mins=excluded.delay_mins, discount_pct=excluded.discount_pct,
        email_subject=excluded.email_subject, email_body=excluded.email_body,
        second_email=excluded.second_email, second_delay_hrs=excluded.second_delay_hrs,
        second_subject=excluded.second_subject, updated_at=datetime('now')
    `).run(id, req.userId, enabled ? 1 : 0, delay_mins || 60, discount_pct || 0, email_subject || '', email_body || '', second_email ? 1 : 0, second_delay_hrs || 24, second_subject || '');
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST send recovery email manually
router.post('/cart-recovery/send', auth, async (req, res) => {
  try {
    const db = getDb();
    const { cart_id } = req.body;
    const cart = db.prepare('SELECT * FROM abandoned_carts WHERE id = ?').get(cart_id);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    const config = db.prepare('SELECT * FROM cart_recovery_config WHERE user_id = ?').get(req.userId)
      || { discount_pct: 10, email_subject: "You left something behind 👀" };
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);

    // Generate discount code if configured
    let discountCode = '';
    if (config.discount_pct > 0) {
      discountCode = 'RECOVER' + require("crypto").randomBytes(4).toString("hex").toUpperCase();
      db.prepare("INSERT OR IGNORE INTO coupons (id, user_id, code, type, value, min_order, uses_remaining, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
        .run(require('crypto').randomUUID(), req.userId, discountCode, 'percent', config.discount_pct, 0, 1);
    }

    // Send via SendGrid if available
    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY"));
      const items = JSON.parse(cart.items || '[]');
      const itemList = items.map(i => `${i.name || i.product_name} - $${i.price}`).join(', ');
      await sgMail.send({
        to: cart.email || cart.customer_email,
        from: { name: user?.business_name || user?.name || 'MINE Store', email: process.env.SENDGRID_FROM_EMAIL || getSetting("EMAIL_FROM") || 'noreply@takeova.ai' },
        subject: config.email_subject || "You left something behind 👀",
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2>Hey${cart.customer_name ? ' ' + cart.customer_name.split(' ')[0] : ''}! You left something behind 👀</h2>
          <p>You had these items in your cart:</p>
          <p style="background:#f5f5f5;padding:12px;border-radius:8px"><strong>${itemList}</strong></p>
          ${discountCode ? `<p>Here's <strong>${config.discount_pct}% off</strong> to complete your order: <strong style="color:#2563eb">${discountCode}</strong></p>` : ''}
          <a href="${cart.cart_url || '#'}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:12px">Complete My Order →</a>
          <p style="color:#999;font-size:12px;margin-top:24px">You're receiving this because you left items in your cart. <a href="#">Unsubscribe</a></p>
        </div>`
      });
    } catch(emailErr) { /* SendGrid not available */ }

    // Mark as sent in DB
    db.prepare("UPDATE abandoned_carts SET reminder_sent = 1, reminder_count = reminder_count + 1, updated_at = datetime('now') WHERE id = ?").run(cart_id);
    res.json({ success: true, discount_code: discountCode });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST mark cart as recovered
router.post('/cart-recovery/:id/recover', auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE abandoned_carts SET recovered = 1, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


/* ══════════════════════════════════════════
   2. UPSELLS & CROSS-SELLS
══════════════════════════════════════════ */

// GET all upsells
router.get('/upsells', auth, (req, res) => {
  try {
    const db = getDb();
    const upsells = db.prepare('SELECT * FROM upsells WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
    res.json({ upsells });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST create upsell
router.post('/upsells', auth, (req, res) => {
  try {
    const db = getDb();
    const { trigger_product, upsell_product, upsell_price, discount_pct, show_as, headline, subtext, active } = req.body;
    const id = 'u' + Date.now();
    db.prepare(`INSERT INTO upsells (id, user_id, trigger_product, upsell_product, upsell_price, discount_pct, show_as, headline, subtext, active)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, trigger_product || 'any', upsell_product, upsell_price || 0, discount_pct || 0, show_as || 'post_purchase', headline || '', subtext || '', active ? 1 : 0);
    res.json({ success: true, id });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// PUT update upsell
router.put('/upsells/:id', auth, (req, res) => {
  try {
    const db = getDb();
    const { trigger_product, upsell_product, upsell_price, discount_pct, show_as, headline, subtext, active } = req.body;
    db.prepare(`UPDATE upsells SET trigger_product=?, upsell_product=?, upsell_price=?, discount_pct=?, show_as=?, headline=?, subtext=?, active=?
      WHERE id=? AND user_id=?`)
      .run(trigger_product, upsell_product, upsell_price, discount_pct, show_as, headline, subtext, active ? 1 : 0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// DELETE upsell
router.delete('/upsells/:id', auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM upsells WHERE id=? AND user_id=?').run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST record upsell shown (called from checkout page)
router.post('/upsells/:id/shown', (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE upsells SET shown = shown + 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST record upsell conversion (called when customer accepts)
router.post('/upsells/:id/convert', (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE upsells SET conversions = conversions + 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET active upsell for a product (called from public checkout)
router.get('/upsells/active/:triggerProduct', (req, res) => {
  try {
    const db = getDb();
    const { site_id } = req.query;
    if (!site_id) return res.json({ upsell: null });
    const site = db.prepare('SELECT user_id FROM sites WHERE id = ?').get(site_id);
    if (!site) return res.json({ upsell: null });
    const upsell = db.prepare(`
      SELECT * FROM upsells WHERE user_id = ? AND active = 1
      AND (trigger_product = 'any' OR trigger_product = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(site.user_id, req.params.triggerProduct);
    res.json({ upsell: upsell || null });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


/* ══════════════════════════════════════════
   3. A/B TESTING — FULL IMPLEMENTATION
   Supports: headline, CTA, colour, image, price,
   email subject, SMS, layout, multi-variant (A/B/C/D),
   funnel steps, traffic source personalisation,
   statistical significance + auto-winner
══════════════════════════════════════════ */

// ── Schema migration — add new columns to existing ab_tests table ──
try {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(ab_tests)").all().map(c => c.name);
  const add = (col, def) => { if (!cols.includes(col)) { try { db.prepare(`ALTER TABLE ab_tests ADD COLUMN ${col} ${def}`).run(); } catch(e) {} } };
  // Test type
  add('test_type', "TEXT DEFAULT 'headline'");
  // Colour variants
  add('variant_a_color', 'TEXT');
  add('variant_b_color', 'TEXT');
  add('variant_c_color', 'TEXT');
  add('variant_d_color', 'TEXT');
  // Image variants
  add('variant_a_image', 'TEXT');
  add('variant_b_image', 'TEXT');
  add('variant_c_image', 'TEXT');
  add('variant_d_image', 'TEXT');
  // Price display variants
  add('variant_a_price', 'TEXT');
  add('variant_b_price', 'TEXT');
  add('variant_c_price', 'TEXT');
  add('variant_d_price', 'TEXT');
  // Layout variants (JSON string of section config)
  add('variant_a_layout', 'TEXT');
  add('variant_b_layout', 'TEXT');
  // Multi-variant C and D
  add('variant_c_headline', 'TEXT');
  add('variant_c_cta', 'TEXT');
  add('variant_c_visitors', 'INTEGER DEFAULT 0');
  add('variant_c_conversions', 'INTEGER DEFAULT 0');
  add('variant_d_headline', 'TEXT');
  add('variant_d_cta', 'TEXT');
  add('variant_d_visitors', 'INTEGER DEFAULT 0');
  add('variant_d_conversions', 'INTEGER DEFAULT 0');
  // Auto-winner + confidence settings
  add('auto_winner', 'INTEGER DEFAULT 0');
  add('confidence_threshold', 'INTEGER DEFAULT 95');
  // Traffic source personalisation
  add('traffic_source', "TEXT DEFAULT 'all'");
  // Funnel step (for funnel step testing)
  add('funnel_step', 'TEXT');
  add('funnel_id', 'TEXT');
  // Email / SMS campaign link
  add('campaign_type', 'TEXT');
  add('campaign_id', 'TEXT');
  // Significance cache (updated on each conversion)
  add('significance_pct', 'INTEGER DEFAULT 0');
  add('leading_variant', 'TEXT');
} catch(e) { console.error('[AB migration]', e.message); }

// ── Statistical significance (two-proportion z-test) ──────────────
function calcSignificance(c1, n1, c2, n2, c3, n3, c4, n4) {
  // Returns significance between best performer and control
  const variants = [
    { label: 'a', conversions: c1 || 0, visitors: n1 || 0 },
    { label: 'b', conversions: c2 || 0, visitors: n2 || 0 },
  ];
  if (n3 > 0) variants.push({ label: 'c', conversions: c3 || 0, visitors: n3 || 0 });
  if (n4 > 0) variants.push({ label: 'd', conversions: c4 || 0, visitors: n4 || 0 });

  // Need at least 30 visitors per variant
  if (variants.some(v => v.visitors < 30)) {
    return { significant: false, confidence: 0, leader: null, lift: 0, needed: Math.max(0, 30 - Math.min(...variants.map(v => v.visitors))) };
  }

  variants.forEach(v => { v.rate = v.visitors > 0 ? v.conversions / v.visitors : 0; });
  const control = variants[0];
  const best = variants.slice(1).reduce((b, v) => v.rate > b.rate ? v : b, variants[1]);

  if (best.rate <= control.rate) {
    return { significant: false, confidence: 0, leader: 'a', lift: 0, needed: 0 };
  }

  const p = (control.conversions + best.conversions) / (control.visitors + best.visitors);
  const se = Math.sqrt(p * (1 - p) * (1 / control.visitors + 1 / best.visitors));
  if (se === 0) return { significant: false, confidence: 0, leader: null, lift: 0, needed: 0 };

  const z = (best.rate - control.rate) / se;
  // z-score to confidence percentage
  const conf = z >= 3.29 ? 99.9 : z >= 2.58 ? 99 : z >= 1.96 ? 95 : z >= 1.65 ? 90 : z >= 1.28 ? 80 : Math.min(79, Math.round(50 + z * 19));
  const lift = control.rate > 0 ? Math.round((best.rate - control.rate) / control.rate * 100) : 0;

  return {
    significant: conf >= 95,
    confidence: Math.round(conf),
    leader: best.label,
    lift,
    needed: 0
  };
}

function formatTest(t) {
  const sig = calcSignificance(
    t.variant_a_conversions, t.variant_a_visitors,
    t.variant_b_conversions, t.variant_b_visitors,
    t.variant_c_conversions, t.variant_c_visitors,
    t.variant_d_conversions, t.variant_d_visitors
  );
  return {
    ...t,
    variant_a: { name: 'Control', headline: t.variant_a_headline, cta: t.variant_a_cta, color: t.variant_a_color, image: t.variant_a_image, price: t.variant_a_price, visitors: t.variant_a_visitors, conversions: t.variant_a_conversions, rate: t.variant_a_visitors > 0 ? Math.round(t.variant_a_conversions / t.variant_a_visitors * 1000) / 10 : 0 },
    variant_b: { name: 'Variant B', headline: t.variant_b_headline, cta: t.variant_b_cta, color: t.variant_b_color, image: t.variant_b_image, price: t.variant_b_price, visitors: t.variant_b_visitors, conversions: t.variant_b_conversions, rate: t.variant_b_visitors > 0 ? Math.round(t.variant_b_conversions / t.variant_b_visitors * 1000) / 10 : 0 },
    variant_c: t.variant_c_headline ? { name: 'Variant C', headline: t.variant_c_headline, cta: t.variant_c_cta, color: t.variant_c_color, image: t.variant_c_image, price: t.variant_c_price, visitors: t.variant_c_visitors || 0, conversions: t.variant_c_conversions || 0, rate: (t.variant_c_visitors || 0) > 0 ? Math.round((t.variant_c_conversions || 0) / t.variant_c_visitors * 1000) / 10 : 0 } : null,
    variant_d: t.variant_d_headline ? { name: 'Variant D', headline: t.variant_d_headline, cta: t.variant_d_cta, color: t.variant_d_color, image: t.variant_d_image, price: t.variant_d_price, visitors: t.variant_d_visitors || 0, conversions: t.variant_d_conversions || 0, rate: (t.variant_d_visitors || 0) > 0 ? Math.round((t.variant_d_conversions || 0) / t.variant_d_visitors * 1000) / 10 : 0 } : null,
    significance: sig,
  };
}

// GET all tests
router.get('/ab-tests', auth, (req, res) => {
  try {
    const db = getDb();
    const tests = db.prepare('SELECT * FROM ab_tests WHERE user_id = ? ORDER BY started DESC').all(req.userId);
    res.json({ tests: tests.map(formatTest) });
  } catch(e) { console.error('[ab-tests GET]', e?.message); res.status(500).json({ error: 'Failed to load tests' }); }
});

// POST create test
router.post('/ab-tests', auth, (req, res) => {
  try {
    const db = getDb();
    const {
      name, page, test_type,
      variant_a_headline, variant_a_cta, variant_a_color, variant_a_image, variant_a_price, variant_a_layout,
      variant_b_headline, variant_b_cta, variant_b_color, variant_b_image, variant_b_price, variant_b_layout,
      variant_c_headline, variant_c_cta, variant_c_color, variant_c_image, variant_c_price,
      variant_d_headline, variant_d_cta, variant_d_color, variant_d_image, variant_d_price,
      auto_winner, confidence_threshold, traffic_source, funnel_step, funnel_id,
      campaign_type, campaign_id
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Test name required' });
    const id = 'ab' + Date.now();
    db.prepare(`
      INSERT INTO ab_tests (
        id, user_id, name, page, status, test_type,
        variant_a_headline, variant_a_cta, variant_a_color, variant_a_image, variant_a_price, variant_a_layout,
        variant_b_headline, variant_b_cta, variant_b_color, variant_b_image, variant_b_price, variant_b_layout,
        variant_c_headline, variant_c_cta, variant_c_color, variant_c_image, variant_c_price,
        variant_d_headline, variant_d_cta, variant_d_color, variant_d_image, variant_d_price,
        auto_winner, confidence_threshold, traffic_source, funnel_step, funnel_id,
        campaign_type, campaign_id, started
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    `).run(
      id, req.userId, name, page || '/', 'running', test_type || 'headline',
      variant_a_headline || 'Control', variant_a_cta || '', variant_a_color || null, variant_a_image || null, variant_a_price || null, variant_a_layout || null,
      variant_b_headline || 'Variant B', variant_b_cta || '', variant_b_color || null, variant_b_image || null, variant_b_price || null, variant_b_layout || null,
      variant_c_headline || null, variant_c_cta || null, variant_c_color || null, variant_c_image || null, variant_c_price || null,
      variant_d_headline || null, variant_d_cta || null, variant_d_color || null, variant_d_image || null, variant_d_price || null,
      auto_winner ? 1 : 0, confidence_threshold || 95,
      traffic_source || 'all', funnel_step || null, funnel_id || null,
      campaign_type || null, campaign_id || null
    );
    res.json({ success: true, id });
  } catch(e) { console.error('[ab-tests POST]', e?.message); res.status(500).json({ error: 'Failed to create test' }); }
});

// PUT update / declare winner / stop
router.put('/ab-tests/:id', auth, (req, res) => {
  try {
    const db = getDb();
    const test = db.prepare('SELECT id FROM ab_tests WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const { status, winner, auto_winner, confidence_threshold, traffic_source } = req.body;
    const fields = [];
    const vals = [];
    if (status !== undefined) { fields.push('status = ?'); vals.push(status); }
    if (winner !== undefined) { fields.push('winner = ?'); vals.push(winner); }
    if (auto_winner !== undefined) { fields.push('auto_winner = ?'); vals.push(auto_winner ? 1 : 0); }
    if (confidence_threshold !== undefined) { fields.push('confidence_threshold = ?'); vals.push(confidence_threshold); }
    if (traffic_source !== undefined) { fields.push('traffic_source = ?'); vals.push(traffic_source); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    db.prepare(`UPDATE ab_tests SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[ab-tests PUT]', e?.message); res.status(500).json({ error: 'Failed to update test' }); }
});

// DELETE test
router.delete('/ab-tests/:id', auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM ab_tests WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[ab-tests DELETE]', e?.message); res.status(500).json({ error: 'Failed to delete test' }); }
});

// GET which variant to show (cookie-based consistent assignment)
// Supports traffic_source filtering: 'all' | 'google' | 'instagram' | 'tiktok' | 'facebook' | 'direct'
router.get('/ab-tests/variant/:testId', (req, res) => {
  try {
    const db = getDb();
    const test = db.prepare("SELECT * FROM ab_tests WHERE id = ? AND status = 'running'").get(req.params.testId);
    if (!test) return res.json({ variant: 'a', active: false });

    // Traffic source check
    if (test.traffic_source && test.traffic_source !== 'all') {
      const ref = (req.query.referrer || req.headers.referer || '').toLowerCase();
      const utm = (req.query.utm_source || '').toLowerCase();
      const sourceMap = { google: ['google', 'goog'], instagram: ['instagram', 'ig'], tiktok: ['tiktok'], facebook: ['facebook', 'fb'], direct: [] };
      const allowed = sourceMap[test.traffic_source] || [];
      const isMatch = test.traffic_source === 'direct'
        ? (!ref && !utm)
        : allowed.some(s => ref.includes(s) || utm.includes(s));
      if (!isMatch) return res.json({ variant: 'a', active: false, reason: 'traffic_source_mismatch' });
    }

    // Cookie-based consistent assignment
    const safeCookieName = 'ab_' + (req.params.testId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const cookieVariant = req.cookies?.[safeCookieName];
    if (cookieVariant && ['a','b','c','d'].includes(cookieVariant)) {
      return res.json({ variant: cookieVariant, active: true, test_type: test.test_type, ...getVariantData(test, cookieVariant) });
    }

    // Assign randomly — weight equally among active variants
    const activeVariants = ['a', 'b'];
    if (test.variant_c_headline) activeVariants.push('c');
    if (test.variant_d_headline) activeVariants.push('d');
    const assigned = activeVariants[Math.floor(Math.random() * activeVariants.length)];

    res.cookie(safeCookieName, assigned, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: false, sameSite: 'lax' });
    res.json({ variant: assigned, active: true, test_type: test.test_type, ...getVariantData(test, assigned) });
  } catch(e) { console.error('[ab-tests variant]', e?.message); res.json({ variant: 'a', active: false }); }
});

function getVariantData(test, variant) {
  const prefix = 'variant_' + variant + '_';
  return {
    headline: test[prefix + 'headline'] || null,
    cta: test[prefix + 'cta'] || null,
    color: test[prefix + 'color'] || null,
    image: test[prefix + 'image'] || null,
    price: test[prefix + 'price'] || null,
    layout: test[prefix + 'layout'] ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(test[prefix + 'layout']) : null,
  };
}

// POST record visit/impression for a variant
router.post('/ab-tests/:id/visit', (req, res) => {
  try {
    const db = getDb();
    const { variant } = req.body;
    const allowed = ['a','b','c','d'];
    if (!allowed.includes(variant)) return res.status(400).json({ error: 'Invalid variant' });
    const col = `variant_${variant}_visitors`;
    db.prepare(`UPDATE ab_tests SET ${col} = ${col} + 1 WHERE id = ? AND status = 'running'`).run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[ab visit]', e?.message); res.status(500).json({ error: 'Failed to record visit' }); }
});

// POST record conversion for a variant — also checks auto-winner
router.post('/ab-tests/:id/convert', (req, res) => {
  try {
    const db = getDb();
    const { variant } = req.body;
    const allowed = ['a','b','c','d'];
    if (!allowed.includes(variant)) return res.status(400).json({ error: 'Invalid variant' });
    const col = `variant_${variant}_conversions`;
    db.prepare(`UPDATE ab_tests SET ${col} = ${col} + 1 WHERE id = ? AND status = 'running'`).run(req.params.id);

    // Auto-winner check
    const test = db.prepare("SELECT * FROM ab_tests WHERE id = ? AND status = 'running' AND auto_winner = 1").get(req.params.id);
    if (test) {
      const sig = calcSignificance(
        test.variant_a_conversions + (variant === 'a' ? 1 : 0), test.variant_a_visitors,
        test.variant_b_conversions + (variant === 'b' ? 1 : 0), test.variant_b_visitors,
        test.variant_c_conversions + (variant === 'c' ? 1 : 0), test.variant_c_visitors || 0,
        test.variant_d_conversions + (variant === 'd' ? 1 : 0), test.variant_d_visitors || 0
      );
      if (sig.significant && sig.confidence >= (test.confidence_threshold || 95)) {
        db.prepare("UPDATE ab_tests SET status = 'completed', winner = ?, significance_pct = ?, leading_variant = ? WHERE id = ?")
          .run(sig.leader, sig.confidence, sig.leader, req.params.id);
        // Future: apply winner to live site content via site editor API
        res.json({ success: true, auto_winner_declared: true, winner: sig.leader, confidence: sig.confidence });
        return;
      }
      // Update cached significance
      db.prepare("UPDATE ab_tests SET significance_pct = ?, leading_variant = ? WHERE id = ?")
        .run(sig.confidence || 0, sig.leader || null, req.params.id);
    }

    res.json({ success: true });
  } catch(e) { console.error('[ab convert]', e?.message); res.status(500).json({ error: 'Failed to record conversion' }); }
});

// GET significance stats for a specific test (for live dashboard refresh)
router.get('/ab-tests/:id/stats', auth, (req, res) => {
  try {
    const db = getDb();
    const test = db.prepare('SELECT * FROM ab_tests WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!test) return res.status(404).json({ error: 'Not found' });
    const sig = calcSignificance(
      test.variant_a_conversions, test.variant_a_visitors,
      test.variant_b_conversions, test.variant_b_visitors,
      test.variant_c_conversions, test.variant_c_visitors || 0,
      test.variant_d_conversions, test.variant_d_visitors || 0
    );
    res.json({ ...sig, test_id: req.params.id });
  } catch(e) { console.error('[ab stats]', e?.message); res.status(500).json({ error: 'Failed to get stats' }); }
});

// POST create email subject line AB test (ties into email campaign)
router.post('/ab-tests/email', auth, async (req, res) => {
  try {
    const db = getDb();
    const { name, subject_a, subject_b, list_id, split_pct } = req.body;
    if (!name || !subject_a || !subject_b) return res.status(400).json({ error: 'Name and both subjects required' });
    const id = 'abem' + Date.now();
    db.prepare(`
      INSERT INTO ab_tests (id, user_id, name, status, test_type, variant_a_headline, variant_b_headline, campaign_type, started)
      VALUES (?,?,?,'running','email_subject',?,?,'email',datetime('now'))
    `).run(id, req.userId, name, subject_a, subject_b);
    res.json({ success: true, id, message: 'Email subject test created. Send campaign via SMS/Email tab to start collecting data.' });
  } catch(e) { console.error('[ab email]', e?.message); res.status(500).json({ error: 'Failed to create email test' }); }
});

// POST create SMS message AB test
router.post('/ab-tests/sms', auth, async (req, res) => {
  try {
    const db = getDb();
    const { name, message_a, message_b } = req.body;
    if (!name || !message_a || !message_b) return res.status(400).json({ error: 'Name and both messages required' });
    const id = 'absms' + Date.now();
    db.prepare(`
      INSERT INTO ab_tests (id, user_id, name, status, test_type, variant_a_headline, variant_b_headline, campaign_type, started)
      VALUES (?,?,?,'running','sms_message',?,?,'sms',datetime('now'))
    `).run(id, req.userId, name, message_a, message_b);
    res.json({ success: true, id });
  } catch(e) { console.error('[ab sms]', e?.message); res.status(500).json({ error: 'Failed to create SMS test' }); }
});




/* ══════════════════════════════════════════
   4. PODCAST HOSTING
══════════════════════════════════════════ */

// GET all podcasts
router.get('/podcasts', auth, (req, res) => {
  try {
    const db = getDb();
    const podcasts = db.prepare('SELECT * FROM podcasts WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
    const result = podcasts.map(p => ({
      ...p,
      episodes: db.prepare('SELECT * FROM podcast_episodes WHERE podcast_id = ? ORDER BY season ASC, episode ASC').all(p.id)
    }));
    res.json({ podcasts: result });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST create podcast
router.post('/podcasts', auth, (req, res) => {
  try {
    const db = getDb();
    const { title, description, category, author, cover_url } = req.body;
    const id = 'pod' + Date.now();
    db.prepare('INSERT INTO podcasts (id, user_id, title, description, category, author, cover_url) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.userId, title, description, category || 'Business', author, cover_url || '');
    res.json({ success: true, id });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// PUT update podcast
router.put('/podcasts/:id', auth, (req, res) => {
  try {
    const db = getDb();
    const { title, description, category, author, cover_url } = req.body;
    db.prepare('UPDATE podcasts SET title=?, description=?, category=?, author=?, cover_url=? WHERE id=? AND user_id=?')
      .run(title, description, category, author, cover_url, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// DELETE podcast + all episodes
router.delete('/podcasts/:id', auth, (req, res) => {
  try {
    const db = getDb();
    // Verify ownership BEFORE deleting episodes (IDOR fix)
    const owned = db.prepare('SELECT id FROM podcasts WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!owned) return res.status(404).json({ error: 'Podcast not found' });
    db.prepare('DELETE FROM podcast_episodes WHERE podcast_id = ?').run(req.params.id);
    db.prepare('DELETE FROM podcasts WHERE id=? AND user_id=?').run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST add episode
router.post('/podcasts/:id/episodes', auth, (req, res) => {
  try {
    const db = getDb();
    const { title, description, audio_url, duration, season, episode, explicit } = req.body;
    const epId = 'ep' + Date.now();
    db.prepare('INSERT INTO podcast_episodes (id, podcast_id, user_id, title, description, audio_url, duration, season, episode, explicit) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(epId, req.params.id, req.userId, title, description || '', audio_url || '', duration || '', season || 1, episode || 1, explicit ? 1 : 0);
    res.json({ success: true, id: epId });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// DELETE episode
router.delete('/podcasts/:podId/episodes/:epId', auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM podcast_episodes WHERE id=? AND user_id=?').run(req.params.epId, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET RSS feed (public — submitted to Spotify/Apple)
router.get('/podcasts/rss/:site_id', (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.site_id);
    if (!site) return res.status(404).send('Podcast not found');
    const podcast = db.prepare('SELECT * FROM podcasts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(site.user_id);
    if (!podcast) return res.status(404).send('No podcast found for this site');
    const episodes = db.prepare('SELECT * FROM podcast_episodes WHERE podcast_id = ? ORDER BY published_at DESC').all(podcast.id);
    const baseUrl = FRONTEND_URL || 'https://takeova.ai';
    const feedUrl = `${baseUrl}/api/features/podcasts/rss/${req.params.site_id}`;
    const siteUrl = site.custom_domain ? `https://${site.custom_domain}` : `${baseUrl}/s/${site.slug || site.id}`;

    const items = episodes.map(ep => `
    <item>
      <title><![CDATA[${ep.title}]]></title>
      <description><![CDATA[${ep.description || ''}]]></description>
      <enclosure url="${(ep.audio_url||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;")}" type="audio/mpeg" length="0"/>
      <guid isPermaLink="false">${ep.id}</guid>
      <pubDate>${new Date(ep.published_at).toUTCString()}</pubDate>
      <itunes:duration>${String(ep.duration||'00:00').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,20)}</itunes:duration>
      <itunes:season>${ep.season}</itunes:season>
      <itunes:episode>${ep.episode}</itunes:episode>
      ${ep.explicit ? '<itunes:explicit>true</itunes:explicit>' : ''}
    </item>`).join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title><![CDATA[${podcast.title}]]></title>
    <description><![CDATA[${podcast.description || ''}]]></description>
    <link>${siteUrl}</link>
    <language>en-us</language>
    <itunes:author><![CDATA[${podcast.author || ''}]]></itunes:author>
    <itunes:category text="${(podcast.category||"Business").replace(/&/g,"&amp;").replace(/"/g,"&quot;")}"/>
    ${podcast.cover_url ? `<itunes:image href="${podcast.cover_url.replace(/&/g,"&amp;").replace(/"/g,"&quot;")}"/>` : ''}
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
    res.set('Content-Type', 'application/rss+xml');
    res.send(rss);
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


/* ══════════════════════════════════════════
   5. DIGITAL DOWNLOADS DRM
══════════════════════════════════════════ */

// GET all DRM rules
router.get('/drm', auth, (req, res) => {
  try {
    const db = getDb();
    const rules = db.prepare('SELECT * FROM drm_rules WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
    res.json({ rules });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST create DRM rule
router.post('/drm', auth, (req, res) => {
  try {
    const db = getDb();
    const { product_id, download_limit, expiry_days, watermark_enabled, watermark_text, require_login, allow_sharing } = req.body;
    const id = 'drm' + Date.now();
    db.prepare(`INSERT INTO drm_rules (id, user_id, product_id, download_limit, expiry_days, watermark_enabled, watermark_text, require_login, allow_sharing)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, product_id || '', download_limit || 3, expiry_days || 365, watermark_enabled ? 1 : 0, watermark_text || '{customer_email}', require_login ? 1 : 0, allow_sharing ? 1 : 0);
    res.json({ success: true, id });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// PUT update DRM rule
router.put('/drm/:id', auth, (req, res) => {
  try {
    const db = getDb();
    const { product_id, download_limit, expiry_days, watermark_enabled, watermark_text, require_login, allow_sharing } = req.body;
    db.prepare(`UPDATE drm_rules SET product_id=?, download_limit=?, expiry_days=?, watermark_enabled=?, watermark_text=?, require_login=?, allow_sharing=?
      WHERE id=? AND user_id=?`)
      .run(product_id, download_limit, expiry_days, watermark_enabled ? 1 : 0, watermark_text, require_login ? 1 : 0, allow_sharing ? 1 : 0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// DELETE DRM rule
router.delete('/drm/:id', auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM drm_rules WHERE id=? AND user_id=?').run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET secure download link (public — called when customer clicks download)
router.get('/drm/download/:productId', (req, res) => {
  try {
    const db = getDb();
    const { email, order_id, site_id } = req.query;
    if (!email || !site_id) return res.status(400).json({ error: 'Missing email or site_id' });

    const site = db.prepare('SELECT user_id FROM sites WHERE id = ?').get(site_id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Find applicable DRM rule
    const rule = db.prepare(`SELECT * FROM drm_rules WHERE user_id = ? AND (product_id = ? OR product_id = '') ORDER BY product_id DESC LIMIT 1`)
      .get(site.user_id, req.params.productId);

    if (!rule) {
      // No DRM — allow download freely
      return res.json({ allowed: true, reason: 'no_drm' });
    }

    // Check expiry — based on order date, and verify order belongs to this customer
    // If expiry is configured but no order_id supplied, deny to prevent bypass
    if (rule.expiry_days > 0 && !order_id) {
      return res.json({ allowed: false, reason: 'order_required', message: 'Order ID required to verify download access.' });
    }
    if (rule.expiry_days > 0 && order_id) {
      const order = db.prepare('SELECT created_at, customer_email FROM orders WHERE id = ?').get(order_id);
      if (order) {
        // Ensure this order belongs to the claimed email to prevent borrowed order_id attacks
        if (order.customer_email && order.customer_email.toLowerCase() !== email.toLowerCase()) {
          return res.json({ allowed: false, reason: 'unauthorized', message: 'Order does not match account.' });
        }
        const orderDate = new Date(order.created_at);
        const expiryDate = new Date(orderDate.getTime() + rule.expiry_days * 86400000);
        if (new Date() > expiryDate) return res.json({ allowed: false, reason: 'expired', message: 'Your download link has expired.' });
      }
    }

    // Check download count
    const log = db.prepare('SELECT * FROM drm_download_log WHERE rule_id = ? AND customer_email = ?').get(rule.id, email);
    if (log && rule.download_limit > 0 && log.download_count >= rule.download_limit) {
      return res.json({ allowed: false, reason: 'limit_reached', message: `Download limit of ${rule.download_limit} reached.` });
    }

    // Record download
    if (log) {
      db.prepare('UPDATE drm_download_log SET download_count = download_count + 1, last_download = datetime("now") WHERE rule_id = ? AND customer_email = ?').run(rule.id, email);
    } else {
      db.prepare('INSERT INTO drm_download_log (id, rule_id, customer_email, product_id, download_count, first_download) VALUES (?,?,?,?,1,datetime("now"))')
        .run('dl' + Date.now(), rule.id, email, req.params.productId);
    }

    const remaining = rule.download_limit > 0 ? rule.download_limit - ((log?.download_count || 0) + 1) : null;
    res.json({ allowed: true, watermark_text: rule.watermark_enabled ? (rule.watermark_text || '').replace('{customer_email}', email).replace('{customer_name}', email.split('@')[0]) : null, downloads_remaining: remaining });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


/* ══════════════════════════════════════════
   6. PRODUCT SUBSCRIPTIONS (SUBSCRIBE & SAVE)
══════════════════════════════════════════ */

// GET all subscription plans
router.get('/product-subscriptions', auth, (req, res) => {
  try {
    const db = getDb();
    const plans = db.prepare('SELECT * FROM product_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
    const parsed = plans.map(p => ({ ...p, intervals: JSON.parse(p.intervals || '[]') }));
    res.json({ plans: parsed });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST create subscription plan
router.post('/product-subscriptions', auth, (req, res) => {
  try {
    const db = getDb();
    const { product_id, intervals, active, min_cycles, cancel_anytime } = req.body;
    const id = 'sp' + Date.now();
    db.prepare(`INSERT INTO product_subscriptions (id, user_id, product_id, intervals, active, min_cycles, cancel_anytime) VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.userId, product_id || '', JSON.stringify(intervals || []), active ? 1 : 0, min_cycles || 0, cancel_anytime ? 1 : 0);
    res.json({ success: true, id });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// PUT update subscription plan
router.put('/product-subscriptions/:id', auth, (req, res) => {
  try {
    const db = getDb();
    const { product_id, intervals, active, min_cycles, cancel_anytime } = req.body;
    db.prepare('UPDATE product_subscriptions SET product_id=?, intervals=?, active=?, min_cycles=?, cancel_anytime=? WHERE id=? AND user_id=?')
      .run(product_id, JSON.stringify(intervals || []), active ? 1 : 0, min_cycles || 0, cancel_anytime ? 1 : 0, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// DELETE subscription plan
router.delete('/product-subscriptions/:id', auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM product_subscriptions WHERE id=? AND user_id=?').run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET all subscribers
router.get('/product-subscriptions/subscribers', auth, (req, res) => {
  try {
    const db = getDb();
    const subscribers = db.prepare('SELECT * FROM product_sub_subscribers WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
    res.json({ subscribers });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST create subscriber (called from checkout when customer picks a subscription interval)
router.post('/product-subscriptions/subscribe', subscribePublicLimiter, async (req, res) => {
  try {
    const db = getDb();
    const { plan_id, customer_email, customer_name, site_id, stripe_payment_method_id } = req.body;
    if (!customer_email || !plan_id) return res.status(400).json({ error: 'Missing required fields' });

    const site = db.prepare('SELECT user_id FROM sites WHERE id = ?').get(site_id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Look up plan from DB — never trust client-supplied price, discount, or interval
    const plan = db.prepare('SELECT * FROM product_subscriptions WHERE id = ? AND user_id = ? AND active = 1').get(plan_id, site.user_id);
    if (!plan) return res.status(404).json({ error: 'Subscription plan not found' });

    const intervals = JSON.parse(plan.intervals || '[]');
    // Use the first active interval as the base (real apps would accept which interval the customer chose)
    const chosenInterval = intervals[0] || {};
    const price = chosenInterval.price || 0;
    const discount_pct = chosenInterval.discount_pct || 0;
    const interval_days = chosenInterval.days || 30;
    const interval_label = chosenInterval.label || '';
    const product = plan.product_id || '';

    let stripeSubId = null;

    // Create Stripe subscription if payment method provided
    if (stripe_payment_method_id && price > 0) {
      try {
        const stripe = require('stripe')(require('../db/init').getDb().prepare('SELECT value FROM platform_settings WHERE key = ?').get('STRIPE_SECRET_KEY')?.value || process.env.STRIPE_SECRET_KEY);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(site.user_id);
        const stripeAccountId = user?.stripe_connect_id; // correct column name

        // Create or get Stripe customer
        let stripeCustomer;
        const existing = db.prepare('SELECT stripe_customer_id FROM contacts WHERE email = ? AND user_id = ?').get(customer_email, site.user_id);
        if (existing?.stripe_customer_id) {
          stripeCustomer = { id: existing.stripe_customer_id };
        } else {
          stripeCustomer = await stripe.customers.create({ email: customer_email, name: customer_name || '' }, stripeAccountId ? { stripeAccount: stripeAccountId } : {});
        }

        // Attach payment method
        await stripe.paymentMethods.attach(stripe_payment_method_id, { customer: stripeCustomer.id }, stripeAccountId ? { stripeAccount: stripeAccountId } : {});

        // Create recurring price — amounts from DB, not client
        const discountedPrice = Math.round(price * (1 - (discount_pct || 0) / 100) * 100);
        const stripePrice = await stripe.prices.create({
          unit_amount: discountedPrice,
          currency: 'usd',
          recurring: { interval: 'day', interval_count: interval_days || 30 },
          product_data: { name: product || 'Subscription' }
        }, stripeAccountId ? { stripeAccount: stripeAccountId } : {});

        const sub = await stripe.subscriptions.create({
          customer: stripeCustomer.id,
          items: [{ price: stripePrice.id }],
          default_payment_method: stripe_payment_method_id
        }, stripeAccountId ? { stripeAccount: stripeAccountId } : {});
        stripeSubId = sub.id;
      } catch(stripeErr) { console.error('Stripe sub error:', stripeErr.message); }
    }

    const nextCharge = new Date(Date.now() + (interval_days || 30) * 86400000).toISOString().split('T')[0];
    const subId = 'ps' + Date.now();
    db.prepare(`INSERT INTO product_sub_subscribers (id, user_id, subscription_plan_id, customer_email, customer_name, product, interval_label, interval_days, discount_pct, stripe_subscription_id, status, next_charge)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(subId, site.user_id, plan_id, customer_email, customer_name || '', product || '', interval_label || '', interval_days || 30, discount_pct || 0, stripeSubId, 'active', nextCharge);

    res.json({ success: true, id: subId, next_charge: nextCharge, stripe_subscription_id: stripeSubId });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST cancel subscriber
router.post('/product-subscriptions/subscribers/:id/cancel', auth, async (req, res) => {
  try {
    const db = getDb();
    const sub = db.prepare('SELECT * FROM product_sub_subscribers WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    // Cancel in Stripe if exists
    if (sub.stripe_subscription_id) {
      try {
        const stripe = require('stripe')(require('../db/init').getDb().prepare('SELECT value FROM platform_settings WHERE key = ?').get('STRIPE_SECRET_KEY')?.value || process.env.STRIPE_SECRET_KEY);
        await stripe.subscriptions.cancel(sub.stripe_subscription_id);
      } catch(e) { console.error('Stripe cancel error:', e.message); }
    }

    db.prepare('UPDATE product_sub_subscribers SET status = ? WHERE id = ?').run('cancelled', req.params.id);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET available subscription options for a product (public — called from product page)
router.get('/product-subscriptions/options/:productId', (req, res) => {
  try {
    const db = getDb();
    const { site_id } = req.query;
    if (!site_id) return res.json({ options: [] });
    const site = db.prepare('SELECT user_id FROM sites WHERE id = ?').get(site_id);
    if (!site) return res.json({ options: [] });
    const plans = db.prepare(`SELECT * FROM product_subscriptions WHERE user_id = ? AND active = 1 AND (product_id = ? OR product_id = '')`)
      .all(site.user_id, req.params.productId);
    const parsed = plans.map(p => ({ ...p, intervals: JSON.parse(p.intervals || '[]') }));
    res.json({ options: parsed });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


/* ══════════════════════════════════════════
   PAID PODCAST — TOKEN-GATED PRIVATE FEEDS
══════════════════════════════════════════ */

// Init tables
try {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS podcast_tokens (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      podcast_id TEXT NOT NULL,
      member_email TEXT NOT NULL,
      member_name TEXT,
      tier_id TEXT,
      tier_name TEXT,
      token TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS membership_tiers (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      price REAL DEFAULT 0,
      interval TEXT DEFAULT 'monthly',
      perks TEXT DEFAULT '[]',
      podcast_access INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch(e) { console.error('Podcast token table init error:', e.message); }

// POST save/update membership tier (called from frontend when creating/editing tier)
router.post('/memberships', auth, (req, res) => {
  try {
    const db = getDb();
    const { site_id, tier_id, name, price, interval, perks, podcast_access } = req.body;
    const id = tier_id || ('mt' + Date.now());
    try { db.exec("ALTER TABLE membership_tiers ADD COLUMN active INTEGER DEFAULT 1").toString ? null : null; } catch(e) {}
    try { db.exec("ALTER TABLE membership_tiers ADD COLUMN active INTEGER DEFAULT 1"); } catch(e) {}
    const { active } = req.body;
    db.prepare(`
      INSERT INTO membership_tiers (id, site_id, user_id, name, price, interval, perks, podcast_access, active)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, price=excluded.price, interval=excluded.interval,
        perks=excluded.perks, podcast_access=excluded.podcast_access, active=excluded.active
    `).run(id, site_id, req.userId, name, price || 0, interval || 'monthly', JSON.stringify(perks || []), podcast_access ? 1 : 0, active !== false ? 1 : 0);
    res.json({ success: true, id });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// DEAD CODE — duplicate of first handler at line 2032; Express never reaches this. Kept for reference; remove or merge when ready.
router.get('/memberships', auth, (req, res) => {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS membership_tiers (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, name TEXT, price REAL DEFAULT 0, interval TEXT DEFAULT 'monthly', perks TEXT DEFAULT '[]', podcast_access INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    const tiers = db.prepare("SELECT * FROM membership_tiers WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
    res.json({ tiers: tiers.map(t => ({ ...t, perks: JSON.parse(t.perks || '[]') })) });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

router.delete('/memberships/:id', auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM membership_tiers WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
    res.json({ ok: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST generate private podcast token for a new member
// Called when someone pays for a membership tier that has podcast_access=true
router.post('/podcasts/generate-token', auth, async (req, res) => {
  try {
    const db = getDb();
    const { site_id, member_email, member_name, tier_id, send_email } = req.body;
    if (!site_id || !member_email) return res.status(400).json({ error: 'site_id and member_email required' });

    // Verify site belongs to requesting user
    const site = db.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?').get(site_id, req.userId);
    if (!site) return res.status(403).json({ error: 'Site not found or access denied' });

    // Check tier has podcast access
    const tier = db.prepare('SELECT * FROM membership_tiers WHERE id = ? AND site_id = ? AND podcast_access = 1').get(tier_id, site_id);
    if (!tier) return res.status(400).json({ error: 'This tier does not include podcast access' });

    // Get the podcast for this site
    const podcast = db.prepare('SELECT * FROM podcasts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(tier.user_id);
    if (!podcast) return res.status(400).json({ error: 'No podcast found for this site' });

    // Check if token already exists for this member+site
    const existing = db.prepare('SELECT * FROM podcast_tokens WHERE site_id = ? AND member_email = ? AND active = 1').get(site_id, member_email);
    if (existing) return res.json({ success: true, token: existing.token, feed_url: `${FRONTEND_URL || 'https://takeova.ai'}/api/features/podcasts/private/${site_id}?token=${existing.token}`, already_exists: true });

    // Generate unique token
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenId = 'pt' + Date.now();

    db.prepare('INSERT INTO podcast_tokens (id, site_id, podcast_id, member_email, member_name, tier_id, tier_name, token) VALUES (?,?,?,?,?,?,?,?)')
      .run(tokenId, site_id, podcast.id, member_email, member_name || '', tier_id, tier?.name || '', token);

    const feedUrl = `${FRONTEND_URL || 'https://takeova.ai'}/api/features/podcasts/private/${site_id}?token=${token}`;

    // Send email with RSS feed URL if requested
    if (send_email !== false) {
      try {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY"));
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(tier.user_id);
        await sgMail.send({
          to: member_email,
          from: { name: user?.business_name || user?.name || 'MINE', email: process.env.SENDGRID_FROM_EMAIL || getSetting("EMAIL_FROM") || 'noreply@takeova.ai' },
          subject: `🎙️ Your private podcast feed — ${String(podcast.title || "").replace(/[\r\n]/g, "")}`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
            <h2>Welcome to ${podcast.title}! 🎙️</h2>
            <p>Hi ${member_name ? member_name.split(' ')[0] : 'there'},</p>
            <p>Your <strong>${tier?.name || 'membership'}</strong> includes exclusive access to the private podcast feed. Here's your personal RSS URL:</p>
            <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0;word-break:break-all;font-family:monospace;font-size:13px">${feedUrl}</div>
            <p><strong>How to listen:</strong></p>
            <ol style="font-size:14px;line-height:1.8">
              <li>Copy the URL above</li>
              <li>Open your podcast app (Podcast Addict, Overcast, Pocket Casts, or any app that supports custom RSS)</li>
              <li>Add a podcast by URL and paste your link</li>
              <li>New episodes appear automatically when published</li>
            </ol>
            <p style="color:#e53e3e;font-size:13px">⚠️ Keep this URL private — it's unique to your account. Do not share it.</p>
            <p style="color:#999;font-size:12px;margin-top:24px">Your access is tied to your ${tier?.name || 'membership'}. If you cancel, this URL will stop working.</p>
          </div>`
        });
      } catch(emailErr) { /* email send error, non-fatal */ }
    }

    res.json({ success: true, token, feed_url: feedUrl });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET private token-gated RSS feed (public URL with token param)
router.get('/podcasts/private/:site_id', (req, res) => {
  try {
    const db = getDb();
    const { token } = req.query;
    if (!token) return res.status(401).send('Missing token. Please use the private RSS URL sent to your email.');

    // Validate token
    const tokenRecord = db.prepare('SELECT * FROM podcast_tokens WHERE site_id = ? AND token = ? AND active = 1').get(req.params.site_id, token);
    if (!tokenRecord) return res.status(403).send('Invalid or expired podcast token. Please contact support.');

    // Get podcast and episodes
    const podcast = db.prepare('SELECT * FROM podcasts WHERE id = ?').get(tokenRecord.podcast_id);
    if (!podcast) return res.status(404).send('Podcast not found');
    const episodes = db.prepare('SELECT * FROM podcast_episodes WHERE podcast_id = ? ORDER BY published_at DESC').all(podcast.id);

    const baseUrl = FRONTEND_URL || 'https://takeova.ai';
    const feedUrl = `${baseUrl}/api/features/podcasts/private/${req.params.site_id}?token=${token}`;
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.site_id);
    const siteUrl = site?.custom_domain ? `https://${site.custom_domain}` : `${baseUrl}/s/${site?.slug || req.params.site_id}`;

    const items = episodes.map(ep => `
    <item>
      <title><![CDATA[${ep.title}]]></title>
      <description><![CDATA[${ep.description || ''}]]></description>
      <enclosure url="${(ep.audio_url||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;")}" type="audio/mpeg" length="0"/>
      <guid isPermaLink="false">${ep.id}</guid>
      <pubDate>${new Date(ep.published_at).toUTCString()}</pubDate>
      <itunes:duration>${String(ep.duration||'00:00').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,20)}</itunes:duration>
      <itunes:season>${ep.season}</itunes:season>
      <itunes:episode>${ep.episode}</itunes:episode>
      ${ep.explicit ? '<itunes:explicit>true</itunes:explicit>' : ''}
    </item>`).join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title><![CDATA[${podcast.title} (Private Feed)]]></title>
    <description><![CDATA[${podcast.description || ''} — Private feed for ${tokenRecord.tier_name || 'members'}.]]></description>
    <link>${siteUrl}</link>
    <language>en-us</language>
    <itunes:author><![CDATA[${podcast.author || ''}]]></itunes:author>
    <itunes:category text="${(podcast.category||"Business").replace(/&/g,"&amp;").replace(/"/g,"&quot;")}"/>
    ${podcast.cover_url ? `<itunes:image href="${podcast.cover_url.replace(/&/g,"&amp;").replace(/"/g,"&quot;")}"/>` : ''}
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
    res.set('Content-Type', 'application/rss+xml');
    res.send(rss);
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// POST revoke token (called when member cancels their membership)
router.post('/podcasts/revoke-token', auth, (req, res) => {
  try {
    const db = getDb();
    const { member_email, site_id, tier_id } = req.body;
    // Verify caller owns the site before revoking access
    const site = db.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?').get(site_id, req.userId);
    if (!site) return res.status(403).json({ error: 'Not authorized to manage this site' });
    db.prepare("UPDATE podcast_tokens SET active = 0, revoked_at = datetime('now') WHERE member_email = ? AND site_id = ? AND active = 1")
      .run(member_email, site_id);
    res.json({ success: true });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET list all podcast token holders (dashboard — who has access)
router.get('/podcasts/:podcastId/members', auth, (req, res) => {
  try {
    const db = getDb();
    // Verify caller owns this podcast before listing members
    const podcast = db.prepare('SELECT id FROM podcasts WHERE id = ? AND user_id = ?').get(req.params.podcastId, req.userId);
    if (!podcast) return res.status(403).json({ error: 'Not authorized' });
    const tokens = db.prepare('SELECT member_email, member_name, tier_name, active, created_at, revoked_at FROM podcast_tokens WHERE podcast_id = ? ORDER BY created_at DESC').all(req.params.podcastId);
    res.json({ members: tokens, total: tokens.filter(t => t.active).length });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


/* ══════════════════════════════════════════
   REAL QR CODE GENERATOR
══════════════════════════════════════════ */

router.get('/qr', auth, async (req, res) => {
  try {
    const { text, size = 300, format = 'svg', color = '000000', bg = 'ffffff' } = req.query;
    if (!text) return res.status(400).json({ error: 'text param required' });
    if (String(text).length > 2048) return res.status(400).json({ error: 'text too long (max 2048 chars)' });
    const HEX_RE = /^#?[0-9a-fA-F]{3,8}$/;
    if (!HEX_RE.test(color) || !HEX_RE.test(bg)) return res.status(400).json({ error: 'Invalid color — use hex (e.g. 000000)' });
    const QRCode = require('qrcode');
    const fgColor = '#' + color.replace('#', '');
    const bgColor = '#' + bg.replace('#', '');
    const safeSize = Math.min(Math.max(parseInt(size) || 300, 50), 1000); // clamp 50–1000px
    if (format === 'png') {
      const buffer = await QRCode.toBuffer(text, {
        width: safeSize,
        margin: 2,
        color: { dark: fgColor, light: bgColor }
      });
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(buffer);
    }
    // Default SVG
    const svg = await QRCode.toString(text, {
      type: 'svg',
      width: safeSize,
      margin: 2,
      color: { dark: fgColor, light: bgColor }
    });
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


/* ══════════════════════════════════════════════════════
   SEO KEYWORD RESEARCH — Perplexity-powered, live data
══════════════════════════════════════════════════════ */

router.post('/seo/keywords', auth, async (req, res) => {
  try {
    const db = getDb();
    const { topic, location } = req.body;
    const site = db.prepare('SELECT name, template, data FROM sites WHERE user_id = ? LIMIT 1').get(req.userId);
    const siteData = JSON.parse(site?.data || '{}');
    const products = (siteData.products || []).slice(0, 5).map(p => p.name).join(', ');
    const businessName = site?.name || 'my business';
    const niche = topic || site?.template || businessName;
    const geo = location || 'Australia';

    const { doResearch } = require('./ai-employees');

    // Perplexity: fetch live keyword data
    const research = await doResearch(
      `SEO keyword research for a ${niche} business called "${businessName}"${products ? ' selling ' + products : ''} targeting customers in ${geo}.
       Find RIGHT NOW in ${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}:
       1. Top 10 high-intent keywords with estimated monthly search volume
       2. Long-tail keywords with lower competition (easier to rank)
       3. Question-based keywords people are searching (great for blog posts)
       4. Local SEO keywords if relevant (e.g. "[service] near me", "[service] [city]")
       5. Trending keywords in this niche gaining traction RIGHT NOW
       6. Competitor keywords (what businesses like this typically rank for)
       Include: keyword, estimated monthly searches, competition level (low/med/high), and recommended content type to target it.`,
      getSetting
    );

    const anthropicKey = getSetting('ANTHROPIC_API_KEY');
    if (!anthropicKey) return res.status(400).json({ error: 'Anthropic API key required' });

    // Claude structures the raw research into clean JSON
    const structureResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        temperature: 0,
        messages: [{
          role: 'user',
          content: `Based on this keyword research:\n\n${research.text || 'No live data — use your training knowledge'}\n\nBusiness: "${businessName}" | Niche: ${niche} | Location: ${geo}\n\nReturn ONLY a JSON object:\n{"keywords":[{"keyword":"...","volume":"e.g. 2,400/mo","competition":"low|medium|high","intent":"informational|commercial|transactional|navigational","contentType":"blog post|landing page|product page|FAQ","difficulty":1-100,"why":"one sentence on why this is valuable"}],"quickWins":["keyword1","keyword2"],"blogIdeas":["Blog post title targeting [keyword]"],"localKeywords":["..."],"trendingNow":["..."],"source":"${research.source}"}\nReturn ONLY the JSON.`
        }]
      })
    });
    const structData = await structureResp.json();
    const raw = (structData.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();

    let result;
    try { result = JSON.parse(raw); } catch(e) { result = { keywords: [], raw: research.text, source: research.source }; }

    // Cache result in DB for 24hrs
    try {
      db.exec("CREATE TABLE IF NOT EXISTS seo_keyword_cache (user_id TEXT, niche TEXT, result_json TEXT, created_at TEXT, PRIMARY KEY(user_id, niche))");
      db.prepare("INSERT OR REPLACE INTO seo_keyword_cache VALUES (?,?,?,datetime('now'))").run(req.userId, niche, JSON.stringify(result));
    } catch(e) {}

    res.json({ success: true, ...result, researchedAt: new Date().toISOString() });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// GET cached keyword results
router.get('/seo/keywords', auth, (req, res) => {
  try {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS seo_keyword_cache (user_id TEXT, niche TEXT, result_json TEXT, created_at TEXT, PRIMARY KEY(user_id, niche))");
    const rows = db.prepare("SELECT * FROM seo_keyword_cache WHERE user_id = ? AND created_at > datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 5").all(req.userId);
    const results = rows.map(r => ({ niche: r.niche, researchedAt: r.created_at, ...JSON.parse(r.result_json || '{}') }));
    res.json({ results });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

/* ══════════════════════════════════════════════════════
   PRICING INTELLIGENCE — Perplexity fetches live market rates
══════════════════════════════════════════════════════ */

router.post('/pricing/research', auth, async (req, res) => {
  try {
    const db = getDb();
    const { productName, productType, description, location } = req.body;
    if (!productName) return res.status(400).json({ error: 'productName required' });

    // Cap check
    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const check = global.mineCheckUsage(db, req.userId, "aiResearch");
      if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to run more pricing research.", cap: check.cap, upgrade: true });
    }

    const site = db.prepare('SELECT name, template FROM sites WHERE user_id = ? LIMIT 1').get(req.userId);
    const geo = location || 'Australia';
    const businessType = site?.template || 'small business';

    const { doResearch } = require('./ai-employees');

    const research = await doResearch(
      `Pricing research for "${productName}" (${productType || 'product/service'}) sold by a ${businessType} in ${geo}.
       Find RIGHT NOW:
       1. Typical price range in the market (low, mid, premium tiers)
       2. What competitors charge — with specific examples if possible
       3. What customers expect to pay at each tier
       4. Price anchoring strategies that work in this category
       5. Any seasonal pricing trends or current market conditions affecting price
       6. Recommended price point for a new or growing business trying to compete
       7. Pricing psychology tips specific to this product type
       Be specific with real dollar amounts, not vague ranges.`,
      getSetting
    );

    const anthropicKey = getSetting('ANTHROPIC_API_KEY');
    if (!anthropicKey) return res.status(400).json({ error: 'Anthropic API key required' });

    const structureResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        temperature: 0,
        messages: [{
          role: 'user',
          content: `Based on this pricing research:\n\n${research.text || 'Use training knowledge'}\n\nProduct: "${productName}" | Type: ${productType || 'general'} | Location: ${geo} | Business: ${businessType}\n\nReturn ONLY JSON:\n{"suggestedPrice":{"budget":"$X","standard":"$X","premium":"$X"},"marketRange":{"low":"$X","high":"$X","average":"$X"},"recommendation":{"price":"$X","reasoning":"2-3 sentences why","confidence":"low|medium|high"},"competitorExamples":[{"name":"...","price":"$X","tier":"budget|standard|premium"}],"pricingTips":["tip1","tip2","tip3"],"warnings":["anything to avoid"],"source":"${research.source}"}\nReturn ONLY the JSON.`
        }]
      })
    });

    const structData = await structureResp.json();
    const raw = (structData.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();

    let result;
    try { result = JSON.parse(raw); } catch(e) { result = { raw: research.text, source: research.source }; }

    // Track on success
    if (typeof global !== "undefined" && global.mineTrackUsage) {
      const t = global.mineTrackUsage(db, req.userId, "aiResearch");
      if (t?.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
    }

    res.json({ success: true, product: productName, location: geo, ...result, researchedAt: new Date().toISOString() });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════════════════
// VOICE PACK ADD-ON — $29 for 100 extra minutes
// ═══════════════════════════════════════════════════

// GET voice pack status for current user
router.get("/voice/pack-status", auth, (req, res) => {
  const db = getDb();
  ensureVoicePackTable(db);
  const packs = db.prepare(
    "SELECT id, mins_total, mins_used, purchased_at, expires_at FROM voice_packs WHERE user_id = ? ORDER BY purchased_at DESC"
  ).all(req.userId);
  const totalRemaining = packs.reduce((s, p) => s + (p.mins_total - p.mins_used), 0);
  const currentPeriod = getCurrentPeriod();
  const periodUsage = db.prepare(
    "SELECT amount FROM usage_tracking WHERE user_id = ? AND metric = 'voiceMins' AND period = ?"
  ).get(req.userId, currentPeriod);
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  const plan = user?.plan || "starter";
  const cap = (PLAN_CAPS[plan] || PLAN_CAPS.starter).voiceMins || 0;
  const used = periodUsage?.amount || 0;
  const nextTierRate = getVoiceOverageRate(plan, Math.max(used, cap) + 1, cap);

  res.json({
    packs,
    totalPackMinsRemaining: totalRemaining,
    planMinsUsed: used,
    planMinsCap: cap,
    planMinsRemaining: Math.max(0, cap - used),
    nextOverageRate: nextTierRate,
    tiers: plan === "enterprise" ? VOICE_OVERAGE_TIERS_ENTERPRISE : VOICE_OVERAGE_TIERS,
  });
});

// POST purchase a Voice Pack ($29 = 100 mins)
// Creates a Stripe checkout for the pack; on success records the pack
router.post("/voice/buy-pack", auth, async (req, res) => {
  try {
    const { quantity = 1 } = req.body; // allow buying multiple packs
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10)
      return res.status(400).json({ error: "Quantity must be 1–10" });

    const PACK_PRICE_CENTS = 2900; // $29 per pack
    const PACK_MINS = 100;
    const db = getDb();

    const user = db.prepare("SELECT email, stripe_customer_id FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(500).json({ error: "Stripe not configured" });

    try {
      const stripe = require("stripe")(stripeKey);

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

      // Ensure Stripe customer exists so the pack payment links to their account
      let stripeCustomerId = user.stripe_customer_id;
      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({ email: user.email, metadata: { mine_user: req.userId } });
        stripeCustomerId = customer.id;
        const db2 = getDb();
        db2.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, req.userId);
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: stripeCustomerId,
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Voice Pack — ${quantity * PACK_MINS} mins`,
              description: `${quantity * PACK_MINS} additional AI Receptionist minutes. Never expires.`,
            },
            unit_amount: PACK_PRICE_CENTS,
          },
          quantity,
        }],
        metadata: {
          type: "voice_pack",
          mine_user: req.userId,
          mins: String(quantity * PACK_MINS),
          quantity: String(quantity),
        },
        success_url: `${frontendUrl}/dashboard?voice_pack=success&mins=${quantity * PACK_MINS}`,
        cancel_url: `${frontendUrl}/dashboard?voice_pack=cancelled`,
      });

      res.json({ url: session.url, sessionId: session.id });
    } catch(e) {
      res.status(500).json({ error: global.sanitizeError ? global.sanitizeError(e) : "Failed to create checkout session" });
    }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// NEW AI FEATURES — Plan-gated with overage billing
// ═══════════════════════════════════════════════════════════════════════

const _aiRateLimit = require("express-rate-limit")({ windowMs: 60000, max: 20, keyGenerator: r => r.userId || r.ip, message: { error: "Too many AI requests — slow down" } });

function _callAI(prompt, systemPrompt, maxTokens = 800) {
  const Anthropic = require("@anthropic-ai/sdk");
  const getSetting = k => { try { return require("../db/init").getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } };
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("AI not configured");
  const client = new Anthropic({ apiKey });
  return client.messages.create({ model: "claude-sonnet-4-6", max_tokens: maxTokens, system: systemPrompt, messages: [{ role: "user", content: prompt }] });
}

// ── 1. AI Product Description Writer ────────────────────────────────────
router.post("/ai/product-description", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    // 1. Check eligibility WITHOUT incrementing
    const check = checkUsage(db, req.userId, "productDescs");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI product descriptions", cap: check.cap, plan: check.plan });

    // 2. Validate inputs
    const { productName, keyDetails, tone = "professional", targetAudience = "general shoppers" } = req.body;
    if (!productName || typeof productName !== "string" || productName.trim().length < 2 || productName.length > 200) return res.status(400).json({ error: "Product name required (2–200 chars)" });
    if (keyDetails && typeof keyDetails !== "string") return res.status(400).json({ error: "Invalid key details" });
    const allowedTones = ["professional", "friendly", "luxury", "playful", "minimal"];
    if (!allowedTones.includes(tone)) return res.status(400).json({ error: "Invalid tone" });

    // 3. Call AI
    try {
      const msg = await _callAI(
        `Product name: ${productName.trim()}\nKey details/features: ${(keyDetails || "").trim().slice(0, 500)}\nTarget audience: ${String(targetAudience).trim().slice(0, 100)}`,
        `You are a world-class ecommerce copywriter. Write a compelling product description in a ${tone} tone. Return JSON only: { "title": "SEO product title", "shortDesc": "1-2 sentence hook (under 160 chars)", "longDesc": "3-5 sentence full description with features and benefits", "bulletPoints": ["feature 1","feature 2","feature 3","feature 4"], "seoKeywords": ["keyword1","keyword2","keyword3"] }`
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      // 4. Only charge on success
      const t = trackUsage(db, req.userId, "productDescs");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI product-desc]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 2. AI Blog Post Writer ───────────────────────────────────────────────
router.post("/ai/blog-post", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "blogPosts");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI blog writing", cap: check.cap });

    const { topic, keywords, tone = "informative", wordCount = 600 } = req.body;
    if (!topic || typeof topic !== "string" || topic.trim().length < 5 || topic.length > 200) return res.status(400).json({ error: "Topic required (5–200 chars)" });
    const safeWords = Math.min(Math.max(parseInt(wordCount) || 600, 300), 1500);
    const allowedTones = ["informative", "conversational", "professional", "storytelling", "listicle"];
    if (!allowedTones.includes(tone)) return res.status(400).json({ error: "Invalid tone" });

    try {
      const msg = await _callAI(
        `Topic: ${topic.trim()}\nTarget keywords: ${String(keywords || "").trim().slice(0, 200)}\nDesired word count: ~${safeWords} words\nTone: ${tone}`,
        `You are an expert SEO content writer. Write a full blog post. Return JSON only, no markdown backticks: { "title": "H1 title", "metaTitle": "SEO meta title under 60 chars", "metaDescription": "SEO meta description under 155 chars", "intro": "Opening paragraph", "sections": [{ "heading": "H2 heading", "content": "section content paragraph(s)" }], "conclusion": "Closing paragraph", "tags": ["tag1","tag2","tag3"] }`,
        1500
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      const t = trackUsage(db, req.userId, "blogPosts");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI blog-post]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 3. AI Review Responder ───────────────────────────────────────────────
router.post("/ai/review-reply", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "reviewReplies");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI review replies", cap: check.cap });

    const { reviewText, rating, productName, businessName } = req.body;
    if (!reviewText || typeof reviewText !== "string" || reviewText.trim().length < 5 || reviewText.length > 1000) return res.status(400).json({ error: "Review text required (5–1000 chars)" });
    const safeRating = Math.min(Math.max(parseInt(rating) || 3, 1), 5);

    try {
      const msg = await _callAI(
        `Business: ${String(businessName || "our business").trim().slice(0, 100)}\nProduct: ${String(productName || "our product").trim().slice(0, 100)}\nCustomer rating: ${safeRating}/5 stars\nCustomer review: ${reviewText.trim()}`,
        `You are a professional customer relations manager. Write a warm, genuine response to this customer review. Return JSON only: { "reply": "Your full response text (2-4 sentences)", "tone": "positive|neutral|damage-control", "followUpAction": "Suggested internal action if any, or null" }`
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      const t = trackUsage(db, req.userId, "reviewReplies");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI review-reply]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 4. AI Social Caption Generator ──────────────────────────────────────
router.post("/ai/social-caption", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "socialCaptions");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI social captions", cap: check.cap });

    const { topic, platforms, tone = "engaging", includeHashtags = true } = req.body;
    if (!topic || typeof topic !== "string" || topic.trim().length < 5 || topic.length > 300) return res.status(400).json({ error: "Topic required (5–300 chars)" });
    const allowedPlatforms = ["instagram", "facebook", "twitter", "linkedin", "tiktok"];
    const safePlatforms = Array.isArray(platforms) ? platforms.filter(p => allowedPlatforms.includes(p)) : ["instagram", "facebook"];
    if (safePlatforms.length === 0) return res.status(400).json({ error: "At least one valid platform required" });
    const allowedTones = ["engaging", "professional", "humorous", "inspirational", "educational"];
    if (!allowedTones.includes(tone)) return res.status(400).json({ error: "Invalid tone" });

    try {
      const msg = await _callAI(
        `Topic/post idea: ${topic.trim()}\nPlatforms: ${safePlatforms.join(", ")}\nTone: ${tone}\nInclude hashtags: ${includeHashtags}`,
        `You are a social media expert. Write platform-optimised captions. Return JSON only: { "captions": { "instagram": "caption text", "facebook": "caption text", "twitter": "caption text (under 280 chars)", "linkedin": "caption text", "tiktok": "caption text" }, "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5"], "bestPostTime": "suggested time e.g. Tuesday 6-8pm" }. Only include platforms that were requested.`
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      const t = trackUsage(db, req.userId, "socialCaptions");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI social-caption]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 5. AI Invoice Chaser ─────────────────────────────────────────────────
router.post("/ai/invoice-chaser", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "invoiceChasers");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI invoice chasing", cap: check.cap });

    const { invoiceId, clientName, amount, daysOverdue, businessName } = req.body;
    if (!clientName || typeof clientName !== "string" || clientName.trim().length < 1 || clientName.length > 100) return res.status(400).json({ error: "Client name required" });
    if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: "Invoice amount required" });
    const safeDays = Math.min(Math.max(parseInt(daysOverdue) || 7, 1), 365);
    if (invoiceId) {
      const inv = db.prepare("SELECT id FROM invoices WHERE id = ? AND user_id = ?").get(invoiceId, req.userId);
      if (!inv) return res.status(404).json({ error: "Invoice not found" });
    }

    try {
      const urgency = safeDays < 14 ? "gentle" : safeDays < 30 ? "firm" : "urgent";
      const msg = await _callAI(
        `Business: ${String(businessName || "").trim().slice(0, 100)}\nClient name: ${clientName.trim()}\nInvoice amount: $${parseFloat(amount).toFixed(2)}\nDays overdue: ${safeDays}\nRequired tone: ${urgency}`,
        `You are a professional accounts manager. Write a polite but effective payment reminder email. Return JSON only: { "subject": "Email subject line", "body": "Full email body text (professional, no placeholders, ready to send)", "tone": "${urgency}", "suggestedFollowUpDays": number }`
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      const t = trackUsage(db, req.userId, "invoiceChasers");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      // Write last_chased_at so Growth Agent respects manual chases (3-day gap)
      const _invoiceId = req.body?.invoiceId;
      if (_invoiceId) {
        try { db.exec("ALTER TABLE invoices ADD COLUMN last_chased_at TEXT"); } catch(e) {}
        db.prepare("UPDATE invoices SET last_chased_at = date('now') WHERE id = ? AND user_id = ?").run(_invoiceId, req.userId);
      }
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI invoice-chaser]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 6. AI Upsell Recommender ─────────────────────────────────────────────
router.post("/ai/upsell-recommend", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "upsellRecs");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI upsell recommendations", cap: check.cap });

    const { recentPurchases, availableProducts } = req.body;
    if (!Array.isArray(recentPurchases) || recentPurchases.length === 0) return res.status(400).json({ error: "Recent purchases required" });
    if (!Array.isArray(availableProducts) || availableProducts.length === 0) return res.status(400).json({ error: "Available products required" });
    const safePurchases = recentPurchases.slice(0, 20).map(p => ({ name: String(p.name || "").slice(0, 100), price: parseFloat(p.price) || 0 }));
    const safeProducts = availableProducts.slice(0, 50).map(p => ({ id: String(p.id || "").slice(0, 50), name: String(p.name || "").slice(0, 100), price: parseFloat(p.price) || 0, category: String(p.category || "").slice(0, 50) }));

    try {
      const msg = await _callAI(
        `Customer's recent purchases: ${JSON.stringify(safePurchases)}\nAvailable products to recommend: ${JSON.stringify(safeProducts)}`,
        `You are an ecommerce merchandising expert. Analyse purchase history and recommend the best upsells. Return JSON only: { "recommendations": [{ "productId": "id from available products", "productName": "name", "reason": "1 sentence why this fits", "confidence": "high|medium|low", "upsellType": "cross-sell|upsell|bundle" }], "bundleSuggestion": "Optional bundle idea or null" }. Return max 3 recommendations, highest confidence first.`
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      const t = trackUsage(db, req.userId, "upsellRecs");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI upsell-recommend]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 7. AI Abandoned Cart Personaliser ───────────────────────────────────
router.post("/ai/cart-personalise", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "cartPersonalise");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI cart personalisation", cap: check.cap });

    const { customerName, cartItems, cartTotal, businessName } = req.body;
    if (!Array.isArray(cartItems) || cartItems.length === 0) return res.status(400).json({ error: "Cart items required" });
    const safeItems = cartItems.slice(0, 20).map(i => ({ name: String(i.name || "").slice(0, 100), price: parseFloat(i.price) || 0, qty: parseInt(i.qty) || 1 }));
    const safeTotal = parseFloat(cartTotal) || safeItems.reduce((s, i) => s + i.price * i.qty, 0);

    try {
      const msg = await _callAI(
        `Business: ${String(businessName || "").trim().slice(0, 100)}\nCustomer name: ${String(customerName || "there").trim().slice(0, 100)}\nAbandoned cart items: ${JSON.stringify(safeItems)}\nCart total: $${safeTotal.toFixed(2)}`,
        `You are a conversion optimisation expert. Write a personalised abandoned cart recovery email that references the specific items left behind. Return JSON only: { "subject": "Email subject (personalised, not generic)", "previewText": "Email preview text under 90 chars", "body": "Full email body — warm, personalised, references specific products, includes urgency without being pushy. Ready to send, no placeholders.", "discountSuggestion": "Suggested discount to offer e.g. 10% off or free shipping, or null if cart total is low" }`
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      const t = trackUsage(db, req.userId, "cartPersonalise");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI cart-personalise]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 8. AI FAQ Generator ──────────────────────────────────────────────────
router.post("/ai/faq-generate", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "faqGeneration");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI FAQ generation", cap: check.cap });

    const { siteId, topicHint } = req.body;
    if (siteId) {
      const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(siteId, req.userId);
      if (!site) return res.status(404).json({ error: "Site not found" });
    }
    const tickets = db.prepare("SELECT subject, body FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").all(req.userId) || [];
    const reviews = db.prepare("SELECT comment FROM reviews WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(req.userId) || [];
    const sourceMaterial = [
      ...tickets.map(t => `Q: ${String(t.subject || "").slice(0, 100)} — ${String(t.body || "").slice(0, 200)}`),
      ...reviews.map(r => `Review: ${String(r.comment || "").slice(0, 200)}`)
    ].slice(0, 30).join("\n");

    try {
      const msg = await _callAI(
        `Business topic/hint: ${String(topicHint || "general business").trim().slice(0, 200)}\n\nSource material (support tickets & reviews to learn from):\n${sourceMaterial || "No source material — generate general FAQs for this type of business"}`,
        `You are a customer experience expert. Generate a set of helpful FAQ questions and answers. Return JSON only: { "faqs": [{ "question": "Customer question", "answer": "Clear, helpful answer (2-4 sentences)", "category": "Shipping|Returns|Product|Payment|General|Account" }] }. Generate 8-12 FAQs. Base them on the source material if provided.`,
        1200
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      const t = trackUsage(db, req.userId, "faqGeneration");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI faq-generate]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 9. AI Refund Handler ─────────────────────────────────────────────────
router.post("/ai/refund-handler", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "refundHandling");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI refund handling", cap: check.cap });

    const { customerName, reason, orderValue, productName, businessName, refundPolicy = "30-day" } = req.body;
    if (!reason || typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500) return res.status(400).json({ error: "Refund reason required (5–500 chars)" });
    const safeValue = parseFloat(orderValue) || 0;

    try {
      const msg = await _callAI(
        `Business: ${String(businessName || "").trim().slice(0, 100)}\nCustomer name: ${String(customerName || "Customer").trim().slice(0, 100)}\nProduct: ${String(productName || "their order").trim().slice(0, 100)}\nOrder value: $${safeValue.toFixed(2)}\nRefund policy: ${String(refundPolicy).trim().slice(0, 50)}\nCustomer's refund reason: ${reason.trim()}`,
        `You are a senior customer service manager who protects both customer relationships and business revenue. Analyse this refund request holistically. Return JSON only: { "recommendation": "approve|partial|decline|exchange", "confidence": "high|medium|low", "reasoning": "2-3 sentences on why this recommendation protects both customer and revenue", "replyEmail": "Full empathetic professional email — warm, specific, no placeholders", "subject": "Email subject line", "internalNote": "Risk assessment, fraud signals if any, customer value consideration", "alternativeOffer": "Specific alternative: store credit amount, replacement terms, or null", "preventionTip": "One tip to prevent this refund type in future" }`
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      const t = trackUsage(db, req.userId, "refundHandling");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI refund-handler]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── 10. AI Competitor Analysis ───────────────────────────────────────────
router.post("/ai/competitor-analysis", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();
    const check = checkUsage(db, req.userId, "competitorAnalysis");
    if (check.blocked) return res.status(403).json({ error: "Upgrade your plan to use AI competitor analysis", cap: check.cap });

    const { competitorName, competitorUrl, yourBusinessType, yourPricing } = req.body;
    if (!competitorName || typeof competitorName !== "string" || competitorName.trim().length < 2 || competitorName.length > 100) return res.status(400).json({ error: "Competitor name required" });
    if (competitorUrl) {
      try {
        const u = new URL(competitorUrl);
        if (!["http:", "https:"].includes(u.protocol)) return res.status(400).json({ error: "Invalid URL" });
        const host = u.hostname;
        if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|metadata\.google\.internal|0\.)/.test(host) || host === "::1") return res.status(400).json({ error: "Invalid URL" });
      } catch { return res.status(400).json({ error: "Invalid URL" }); }
    }

    try {
      const msg = await _callAI(
        `Competitor name: ${competitorName.trim()}\nCompetitor website: ${competitorUrl || "unknown"}\nYour business type: ${String(yourBusinessType || "").trim().slice(0, 200)}\nYour pricing: ${String(yourPricing || "").trim().slice(0, 200)}`,
        `You are a business strategist. Analyse this competitor and identify opportunities. Base your analysis on what you know about this company/brand. Return JSON only: { "overview": "2-3 sentence summary of who this competitor is", "strengths": ["strength 1","strength 2","strength 3"], "weaknesses": ["weakness 1","weakness 2","weakness 3"], "pricingInsight": "What you know about their pricing model", "differentiationOpportunities": ["opportunity 1","opportunity 2","opportunity 3"], "threatLevel": "low|medium|high", "recommendation": "2-3 sentence strategic recommendation for how to compete" }`,
        1000
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
      // Save to research library
      try {
        const { v4: uid } = require("uuid");
        db.prepare("INSERT OR IGNORE INTO ai_research (id, user_id, topic, summary, created_at) VALUES (?,?,?,?,datetime('now'))").run(
          uid(), req.userId, `Competitor: ${competitorName.trim().slice(0, 100)}`, JSON.stringify(result).slice(0, 2000)
        );
      } catch { /* research table may not exist yet */ }
      const t = trackUsage(db, req.userId, "competitorAnalysis");
      if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
      res.json({ ...result, usage: { used: t.used, cap: t.cap, isOverage: t.isOverage, overageCost: t.overageCost } });
    } catch (e) { console.error("[AI competitor-analysis]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
  } catch(e) {
    console.error("[Features]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── Usage stats endpoint ─────────────────────────────────────────────────
router.get("/ai/usage", auth, (req, res) => {
  const db = require("../db/init").getDb();
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  const plan = user?.plan || "starter";
  const caps = PLAN_CAPS[plan] || PLAN_CAPS.starter;
  const period = getCurrentPeriod();
  ensureUsageTable(db);
  const rows = db.prepare("SELECT metric, amount FROM usage_tracking WHERE user_id = ? AND period = ?").all(req.userId, period);
  const usageMap = {};
  rows.forEach(r => { usageMap[r.metric] = r.amount; });
  const aiMetrics = ["productDescs","reviewReplies","socialCaptions","invoiceChasers","upsellRecs","cartPersonalise","faqGeneration","refundHandling","competitorAnalysis","blogPosts","images","aiVideos","proposals","aiResearch","competitorReports","leadMagnets","knowledgeBase","mentorChats","intelligenceRefresh","monthlyNarrative","ticketReply","refundDraft","subjectOptimize","courseContent","meetingPrep","storeBio","sequenceBuilder","whatsappMessages"];
  const usage = {};
  for (const m of aiMetrics) {
    usage[m] = { used: usageMap[m] || 0, cap: caps[m] || 0, overagePrice: OVERAGE_PRICES[m] || 0 };
  }
  const overages = db.prepare("SELECT metric, SUM(total) as total FROM overage_charges WHERE user_id = ? AND period = ? AND status = 'pending' GROUP BY metric").all(req.userId, period);
  const pendingOverages = {};
  overages.forEach(o => { pendingOverages[o.metric] = o.total; });
  res.json({ plan, period, usage, pendingOverages });
});

function fulfillVoicePack(db, userId, mins, stripePaymentId) {
  ensureVoicePackTable(db);
  db.prepare(
    "INSERT INTO voice_packs (id, user_id, mins_total, mins_used, stripe_payment_id) VALUES (?,?,?,0,?)"
  ).run(require("uuid").v4(), userId, mins, stripePaymentId || null);
}
module.exports.fulfillVoicePack = fulfillVoicePack;

module.exports.fireAutomation = fireAutomation;
// ── Cart Recovery (base routes) ──────────────────────────────────────────────
// DEAD CODE — duplicate of first handler at line 7791; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/cart-recovery", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const config = db.prepare("SELECT * FROM cart_recovery_config WHERE user_id = ?").get(uid);
    const abandoned = db.prepare("SELECT COUNT(*) as total, SUM(cart_total) as value FROM abandoned_carts WHERE user_id = ? AND recovered = 0").get(uid) || {};
    const recovered = db.prepare("SELECT COUNT(*) as total, SUM(cart_total) as value FROM abandoned_carts WHERE user_id = ? AND recovered = 1").get(uid) || {};
    res.json({
      config: config || { enabled: false, delay_mins: 60, discount_pct: 10 },
      stats: {
        abandoned: abandoned.total || 0,
        abandoned_value: abandoned.value || 0,
        recovered: recovered.total || 0,
        recovered_value: recovered.value || 0,
        recovery_rate: abandoned.total > 0 ? Math.round((recovered.total / abandoned.total) * 100) : 0
      }
    });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/cart-recovery/config", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const { enabled, delay_minutes, discount_pct, message_template } = req.body;
    const existing = db.prepare("SELECT id FROM cart_recovery_config WHERE user_id = ?").get(uid);
    if (existing) {
      db.prepare("UPDATE cart_recovery_config SET enabled=?, delay_mins=?, discount_pct=?, email_body=? WHERE user_id=?").run(enabled ? 1 : 0, delay_minutes || 60, discount_pct || 10, message_template || "", uid);
    } else {
      const { v4: uuidv4 } = require("uuid");
      db.prepare("INSERT INTO cart_recovery_config (id, user_id, enabled, delay_mins, discount_pct, email_body) VALUES (?, ?, ?, ?, ?, ?)").run(uuidv4 ? uuidv4() : Date.now().toString(), uid, enabled ? 1 : 0, delay_minutes || 60, discount_pct || 10, message_template || "");
    }
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 7835; Express never reaches this. Kept for reference; remove or merge when ready.
router.post("/cart-recovery/send", auth, async (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const carts = db.prepare("SELECT * FROM abandoned_carts WHERE user_id = ? AND recovered = 0 AND notified = 0 ORDER BY created_at DESC LIMIT 50").all(uid);
    let sent = 0;
    for (const cart of carts) {
      db.prepare("UPDATE abandoned_carts SET notified = 1, notified_at = CURRENT_TIMESTAMP WHERE id = ?").run(cart.id);
      sent++;
    }
    res.json({ success: true, sent });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Loyalty (base GET/POST) ───────────────────────────────────────────────────
router.get("/loyalty", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const config = db.prepare("SELECT * FROM loyalty_config WHERE user_id = ?").get(uid);
    const members = db.prepare("SELECT COUNT(*) as count FROM loyalty_transactions WHERE user_id = ?").get(uid);
    const points = db.prepare("SELECT SUM(points) as total FROM loyalty_transactions WHERE user_id = ? AND type = 'earn'").get(uid);
    const redeemed = db.prepare("SELECT COUNT(*) as count FROM loyalty_redemptions WHERE user_id = ?").get(uid);
    res.json({
      config: config || { programme_name: "Rewards", points_per_dollar: 1, redemption_value: 0.01, enabled: false },
      stats: { members: members?.count || 0, total_points: points?.total || 0, redemptions: redeemed?.count || 0 }
    });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/loyalty", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const { programme_name, points_per_dollar, redemption_value, enabled, welcome_bonus, birthday_bonus } = req.body;
    const loyaltyExisting = db.prepare("SELECT id FROM loyalty_config WHERE user_id = ?").get(uid);
    if (loyaltyExisting) {
      db.prepare("UPDATE loyalty_config SET enabled=?, points_per_dollar=?, signup_bonus=? WHERE user_id=?").run(enabled ? 1 : 0, points_per_dollar || 1, welcome_bonus || 0, uid);
    } else {
      const { v4: uuidv4 } = require("uuid");
      db.prepare("INSERT INTO loyalty_config (id, user_id, enabled, points_per_dollar, signup_bonus) VALUES (?, ?, ?, ?, ?)").run(uuidv4 ? uuidv4() : Date.now().toString(), uid, enabled ? 1 : 0, points_per_dollar || 1, welcome_bonus || 0);
    }
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/loyalty/issue", auth, (req, res) => {
  // Alias for /loyalty/award
  try {
    const db = getDb();
    const uid = req.userId;
    const { customer_email, customer_name, points, reason } = req.body;
    if (!customer_email || !points) return res.status(400).json({ error: "customer_email and points required" });
    db.prepare("INSERT INTO loyalty_transactions (user_id, customer_email, customer_name, points, type, reason) VALUES (?, ?, ?, ?, 'earn', ?)").run(uid, customer_email, customer_name || "", points, reason || "Manual award");
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── A/B Tests ─────────────────────────────────────────────────────────────────
// DEAD CODE — duplicate of first handler at line 8099; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/ab-tests", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const siteId = req.query.site_id;
    const tests = db.prepare(`SELECT t.*,
      COALESCE(SUM(CASE WHEN i.variant='A' THEN 1 ELSE 0 END), 0) as impressions_a,
      COALESCE(SUM(CASE WHEN i.variant='B' THEN 1 ELSE 0 END), 0) as impressions_b,
      COALESCE(SUM(CASE WHEN c.variant='A' THEN 1 ELSE 0 END), 0) as conversions_a,
      COALESCE(SUM(CASE WHEN c.variant='B' THEN 1 ELSE 0 END), 0) as conversions_b
      FROM ab_tests t
      LEFT JOIN ab_impressions i ON i.test_id = t.id
      LEFT JOIN ab_conversions c ON c.test_id = t.id
      WHERE t.user_id = ? ${siteId ? 'AND t.site_id = ?' : ''}
      GROUP BY t.id ORDER BY t.created_at DESC`).all(...[uid, ...(siteId ? [siteId] : [])]);
    res.json({ tests });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8108; Express never reaches this. Kept for reference; remove or merge when ready.
router.post("/ab-tests", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const { site_id, name, element, variant_a, variant_b, goal } = req.body;
    if (!name || !site_id) return res.status(400).json({ error: "name and site_id required" });
    const r = db.prepare("INSERT INTO ab_tests (user_id, site_id, name, element, variant_a, variant_b, goal, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')").run(uid, site_id, name, element || "headline", variant_a || "", variant_b || "", goal || "clicks");
    res.json({ id: r.lastInsertRowid, success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8148; Express never reaches this. Kept for reference; remove or merge when ready.
router.put("/ab-tests/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, winner } = req.body;
    const fields = []; const vals = [];
    if (status) { fields.push("status=?"); vals.push(status); }
    if (winner) { fields.push("winner=?"); vals.push(winner); }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    fields.push("updated_at=CURRENT_TIMESTAMP");
    vals.push(req.params.id, req.userId);
    db.prepare(`UPDATE ab_tests SET ${fields.join(",")} WHERE id=? AND user_id=?`).run(...vals);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8168; Express never reaches this. Kept for reference; remove or merge when ready.
router.delete("/ab-tests/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM ab_tests WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Podcasts ──────────────────────────────────────────────────────────────────
// DEAD CODE — duplicate of first handler at line 8328; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/podcasts", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const siteId = req.query.site_id;
    const shows = db.prepare(`SELECT p.*, COUNT(e.id) as episode_count, MAX(e.published_at) as last_episode FROM podcasts p LEFT JOIN podcast_episodes e ON e.podcast_id = p.id WHERE p.user_id = ? ${siteId ? 'AND p.site_id = ?' : ''} GROUP BY p.id ORDER BY p.created_at DESC`).all(...[uid, ...(siteId ? [siteId] : [])]);
    const stats = { total_shows: shows.length, total_episodes: shows.reduce((a, s) => a + (s.episode_count || 0), 0) };
    res.json({ shows, stats });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8342; Express never reaches this. Kept for reference; remove or merge when ready.
router.post("/podcasts", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const { site_id, show_name, description, category, podcast_id, episode_title, episode_notes, audio_url, duration, season, episode_number } = req.body;
    if (podcast_id) {
      // Adding an episode
      const r = db.prepare("INSERT INTO podcast_episodes (podcast_id, user_id, title, notes, audio_url, duration, season, episode_number, status, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)").run(podcast_id, uid, episode_title || "New Episode", episode_notes || "", audio_url || "", duration || 0, season || 1, episode_number || 1);
      res.json({ id: r.lastInsertRowid, success: true, type: "episode" });
    } else {
      // Creating a show
      if (!show_name || !site_id) return res.status(400).json({ error: "show_name and site_id required" });
      const r = db.prepare("INSERT INTO podcasts (user_id, site_id, name, description, category, status) VALUES (?, ?, ?, ?, ?, 'active')").run(uid, site_id, show_name, description || "", category || "Business");
      res.json({ id: r.lastInsertRowid, success: true, type: "show" });
    }
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8367; Express never reaches this. Kept for reference; remove or merge when ready.
router.delete("/podcasts/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM podcasts WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    db.prepare("DELETE FROM podcast_episodes WHERE podcast_id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Product Subscriptions ─────────────────────────────────────────────────────
// DEAD CODE — duplicate of first handler at line 8561; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/product-subscriptions", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const subs = db.prepare("SELECT * FROM product_subscriptions WHERE user_id = ? ORDER BY created_at DESC").all(uid);
    const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='active' THEN price ELSE 0 END) as mrr FROM product_subscriptions WHERE user_id = ?").get(uid);
    res.json({ subscriptions: subs, stats: stats || { total: 0, active: 0, mrr: 0 } });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8572; Express never reaches this. Kept for reference; remove or merge when ready.
router.post("/product-subscriptions", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const { product_id, name, price, interval, description, features } = req.body;
    if (!name || !price) return res.status(400).json({ error: "name and price required" });
    const r = db.prepare("INSERT INTO product_subscriptions (user_id, product_id, name, price, interval, description, features, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')").run(uid, product_id || null, name, parseFloat(price), interval || "monthly", description || "", JSON.stringify(features || []), "active");
    res.json({ id: r.lastInsertRowid, success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8607; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/product-subscriptions/subscribers", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const subId = req.query.subscription_id;
    const subs = db.prepare(`SELECT * FROM product_sub_subscribers WHERE user_id = ? ${subId ? 'AND subscription_id = ?' : ''} ORDER BY created_at DESC`).all(...[uid, ...(subId ? [subId] : [])]);
    res.json({ subscribers: subs });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8597; Express never reaches this. Kept for reference; remove or merge when ready.
router.delete("/product-subscriptions/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE product_subscriptions SET status='inactive' WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Upsells ───────────────────────────────────────────────────────────────────
// DEAD CODE — duplicate of first handler at line 7897; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/upsells", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const siteId = req.query.site_id;
    const upsells = db.prepare(`SELECT * FROM upsells WHERE user_id = ? ${siteId ? 'AND site_id = ?' : ''} ORDER BY created_at DESC`).all(...[uid, ...(siteId ? [siteId] : [])]);
    const stats = db.prepare("SELECT COUNT(*) as shown, SUM(accepted) as accepted FROM upsells WHERE user_id = ?").get(uid);
    res.json({ upsells, stats: stats || { shown: 0, accepted: 0 } });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 7907; Express never reaches this. Kept for reference; remove or merge when ready.
router.post("/upsells", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const { site_id, trigger, offer_product_id, offer_name, offer_price, discount_pct, timing } = req.body;
    if (!offer_name || !site_id) return res.status(400).json({ error: "offer_name and site_id required" });
    const r = db.prepare("INSERT INTO upsells (user_id, site_id, trigger_type, offer_product_id, offer_name, offer_price, discount_pct, timing, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')").run(uid, site_id, trigger || "post_purchase", offer_product_id || null, offer_name, parseFloat(offer_price) || 0, discount_pct || 0, timing || "immediate");
    res.json({ id: r.lastInsertRowid, success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 7921; Express never reaches this. Kept for reference; remove or merge when ready.
router.put("/upsells/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, offer_name, offer_price, discount_pct } = req.body;
    const fields = []; const vals = [];
    if (status !== undefined) { fields.push("status=?"); vals.push(status); }
    if (offer_name) { fields.push("offer_name=?"); vals.push(offer_name); }
    if (offer_price !== undefined) { fields.push("offer_price=?"); vals.push(offer_price); }
    if (discount_pct !== undefined) { fields.push("discount_pct=?"); vals.push(discount_pct); }
    if (!fields.length) return res.json({ success: true });
    vals.push(req.params.id, req.userId);
    db.prepare(`UPDATE upsells SET ${fields.join(",")} WHERE id=? AND user_id=?`).run(...vals);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 7934; Express never reaches this. Kept for reference; remove or merge when ready.
router.delete("/upsells/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM upsells WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Invoices alias (features → data) ─────────────────────────────────────────
router.get("/invoices", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const siteId = req.query.site_id;
    const invoices = db.prepare(`SELECT * FROM invoices WHERE user_id = ? ${siteId ? 'AND site_id = ?' : ''} ORDER BY created_at DESC`).all(...[uid, ...(siteId ? [siteId] : [])]);
    const stats = db.prepare("SELECT SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) as paid, SUM(CASE WHEN status='unpaid' THEN amount ELSE 0 END) as outstanding, COUNT(*) as total FROM invoices WHERE user_id = ?").get(uid);
    res.json({ invoices, stats: stats || { paid: 0, outstanding: 0, total: 0 } });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/invoices", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const { site_id, client_name, client_email, items, due_date, notes } = req.body;
    if (!client_name || !items) return res.status(400).json({ error: "client_name and items required" });
    const amount = (items || []).reduce((a, i) => a + (parseFloat(i.price) || 0) * (parseInt(i.qty) || 1), 0);
    const inv_number = "INV-" + Date.now().toString().slice(-6);
    const r = db.prepare("INSERT INTO invoices (user_id, site_id, invoice_number, client_name, client_email, items, amount, status, due_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?)").run(uid, site_id || null, inv_number, client_name, client_email || "", JSON.stringify(items), amount, due_date || null, notes || "");
    res.json({ id: r.lastInsertRowid, invoice_number: inv_number, amount, success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ─── Generate (or return cached) Stripe Checkout payment link for an invoice
// The link auto-shows Apple Pay / Google Pay on supported devices.
// Used by "Take payment" / "Show QR code" / "Send pay link" actions.
router.post("/invoices/:id/payment-link", auth, async (req, res) => {
  try {
    const db = getDb();
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "paid") return res.status(400).json({ error: "Invoice already paid" });

    // Re-use the cached link if still valid (Stripe Checkout sessions expire after 24h)
    if (inv.stripe_payment_link && inv.payment_link_expires_at && inv.payment_link_expires_at > new Date().toISOString()) {
      return res.json({
        payment_link: inv.stripe_payment_link,
        invoice_number: inv.invoice_number,
        amount: inv.amount || inv.total,
        client_name: inv.client_name,
        client_email: inv.client_email,
        cached: true,
      });
    }

    // Get the user's connected Stripe account if they have one, otherwise platform Stripe
    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Stripe is not configured on the platform" });
    const stripe = require("stripe")(stripeKey);

    const amount = parseFloat(inv.amount || inv.total || 0);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invoice has no amount" });

    const userRow = db.prepare("SELECT email, name FROM users WHERE id = ?").get(req.userId);
    const businessName = userRow?.name || "MINE";

    // Get the public host for success/cancel URLs
    const host = process.env.FRONTEND_URL || process.env.APP_URL || process.env.DASHBOARD_URL || "https://takeova.ai";

    let items = [];
    try { items = JSON.parse(inv.items || inv.items_json || "[]"); } catch(_) {}
    const lineItems = items.length ? items.map(it => ({
      price_data: {
        currency: "aud",
        product_data: { name: String(it.name || it.description || "Invoice item").slice(0, 200) },
        unit_amount: Math.round((parseFloat(it.price) || 0) * 100),
      },
      quantity: parseInt(it.qty) || 1,
    })) : [{
      price_data: {
        currency: "aud",
        product_data: { name: `Invoice ${inv.invoice_number || inv.id}` },
        unit_amount: Math.round(amount * 100),
      },
      quantity: 1,
    }];

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"], // Apple Pay / Google Pay auto-show via `card` on supported devices
      customer_email: inv.client_email || undefined,
      line_items: lineItems,
      metadata: {
        invoice_id: String(inv.id),
        invoice_number: inv.invoice_number || "",
        user_id: req.userId,
      },
      success_url: `${host}/invoice-paid?inv=${inv.id}`,
      cancel_url: `${host}/invoice/${inv.id}`,
    });

    // Cache the link — Stripe sessions expire after 24h, store with same TTL
    const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE invoices SET stripe_payment_link = ?, stripe_session_id = ?, payment_link_expires_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(session.url, session.id, expiresAt, inv.id);

    res.json({
      payment_link: session.url,
      invoice_number: inv.invoice_number,
      amount,
      client_name: inv.client_name,
      client_email: inv.client_email,
      business_name: businessName,
      expires_at: expiresAt,
      cached: false,
    });
  } catch(e) {
    console.error("[invoice payment-link]", e.message);
    res.status(500).json({ error: e.message || "Could not generate payment link" });
  }
});

// ─── Send invoice payment link via SMS to the customer ────────────────────
router.post("/invoices/:id/send-pay-sms", auth, async (req, res) => {
  try {
    const db = getDb();
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (!inv.stripe_payment_link) return res.status(400).json({ error: "Generate a payment link first" });

    const { phone } = req.body;
    const targetPhone = (phone || "").replace(/[^\d+]/g, "");
    if (!targetPhone || targetPhone.length < 8) return res.status(400).json({ error: "Valid phone number required" });

    const tw = {
      sid: getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID,
      token: getSetting("TWILIO_AUTH_TOKEN") || process.env.TWILIO_AUTH_TOKEN,
      from: getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER,
    };
    if (!tw.sid || !tw.token || !tw.from) return res.status(503).json({ error: "Twilio not configured" });

    const userRow = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
    const businessName = userRow?.name || "Your business";
    const amount = parseFloat(inv.amount || inv.total || 0).toFixed(2);
    const msg = `Hi ${inv.client_name}, your invoice ${inv.invoice_number} from ${businessName} for $${amount} is ready. Pay here: ${inv.stripe_payment_link}`;

    const fetch = (await import("node-fetch")).default;
    const tr = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(tw.sid + ":" + tw.token).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: tw.from, To: targetPhone, Body: msg }).toString(),
    });
    if (!tr.ok) {
      const err = await tr.text();
      console.error("[invoice send-pay-sms] Twilio error:", tr.status, err.slice(0, 200));
      return res.status(502).json({ error: "Failed to send SMS" });
    }
    res.json({ ok: true });
  } catch(e) {
    console.error("[invoice send-pay-sms]", e.message);
    res.status(500).json({ error: "Failed to send SMS" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// QUICK PAYMENT — one-shot in-person POS flow
// ════════════════════════════════════════════════════════════════════════════
//
// All-in-one endpoint for taking a payment face-to-face. Creates contact +
// invoice + Stripe Checkout session in a single call, returns the payment
// link so the UI can show a QR / send SMS / hand over for manual card entry.
//
// Body: { customer_name, customer_phone?, customer_email?, customer_address?,
//         amount, description?, notes? }
//
// Returns: { invoice_id, contact_id, payment_link, qr_url, amount, currency }
router.post("/quick-pay", auth, async (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const {
      customer_name, customer_phone, customer_email, customer_address,
      amount, description, notes,
    } = req.body;

    if (!customer_name || typeof customer_name !== "string") {
      return res.status(400).json({ error: "customer_name required" });
    }
    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum <= 0 || isNaN(amountNum)) {
      return res.status(400).json({ error: "Valid amount required" });
    }
    if (amountNum > 1000000) {
      return res.status(400).json({ error: "Amount too large" });
    }

    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Stripe is not configured" });
    const stripe = require("stripe")(stripeKey);

    // ── 1. Upsert contact by email (or phone if no email) ──
    let contactId = null;
    try {
      let existing = null;
      if (customer_email) {
        existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?")
                     .get(uid, customer_email.toLowerCase().trim());
      } else if (customer_phone) {
        existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND phone = ?")
                     .get(uid, customer_phone);
      }
      if (existing) {
        contactId = existing.id;
        // Update name / address if new info provided
        const updates = [];
        const values = [];
        if (customer_name) { updates.push("name = ?"); values.push(customer_name); }
        if (customer_address) { updates.push("notes = COALESCE(notes,'') || ?"); values.push(`\nAddress: ${customer_address}`); }
        if (updates.length) {
          values.push(contactId);
          db.prepare(`UPDATE contacts SET ${updates.join(", ")} WHERE id = ?`).run(...values);
        }
      } else {
        contactId = require("crypto").randomBytes(16).toString("hex");
        db.prepare(`INSERT INTO contacts (id, user_id, name, email, phone, status, source, notes, created_at)
                    VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
          .run(contactId, uid, customer_name, (customer_email || "").toLowerCase().trim(),
               customer_phone || "", "customer", "quick_pay",
               customer_address ? `Address: ${customer_address}` : "");
      }
    } catch(e) {
      console.error("[quick-pay] contact upsert failed:", e.message);
    }

    // ── 2. Create invoice ──
    const inv_number = "QP-" + Date.now().toString().slice(-6);
    const itemsJson = JSON.stringify([{
      name: description || "Quick Pay charge",
      price: amountNum,
      qty: 1,
    }]);
    const invR = db.prepare(`INSERT INTO invoices (user_id, invoice_number, client_name, client_email, items, amount, status, notes)
                              VALUES (?,?,?,?,?,?,'unpaid',?)`)
      .run(uid, inv_number, customer_name, (customer_email || ""), itemsJson, amountNum, notes || "");
    const invoiceId = invR.lastInsertRowid;

    // ── 3. Create Stripe Checkout session ──
    const host = process.env.FRONTEND_URL || process.env.APP_URL || process.env.DASHBOARD_URL || "https://takeova.ai";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"], // Apple Pay / Google Pay auto-show on supported devices
      customer_email: customer_email || undefined,
      line_items: [{
        price_data: {
          currency: "aud",
          product_data: { name: description || `Payment ${inv_number}` },
          unit_amount: Math.round(amountNum * 100),
        },
        quantity: 1,
      }],
      metadata: {
        invoice_id: String(invoiceId),
        invoice_number: inv_number,
        user_id: uid,
        contact_id: contactId || "",
        source: "quick_pay",
      },
      success_url: `${host}/invoice-paid?inv=${invoiceId}`,
      cancel_url: `${host}/invoice/${invoiceId}`,
    });

    const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE invoices SET stripe_payment_link = ?, stripe_session_id = ?, payment_link_expires_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(session.url, session.id, expiresAt, invoiceId);

    res.json({
      ok: true,
      invoice_id: invoiceId,
      invoice_number: inv_number,
      contact_id: contactId,
      payment_link: session.url,
      qr_url: `/api/features/qr?text=${encodeURIComponent(session.url)}&size=300&format=svg&color=4F46E5`,
      amount: amountNum,
      currency: "aud",
      customer: { name: customer_name, phone: customer_phone, email: customer_email },
    });
  } catch(e) {
    console.error("[quick-pay]", e.message);
    res.status(500).json({ error: e.message || "Quick pay failed" });
  }
});

// ── Charge a card directly via Stripe Elements payment_method_id ──────────
// Use case: MINE user hands phone to customer, customer types card details
// into Stripe Elements form, client tokenizes to payment_method_id, we charge.
//
// Body: { invoice_id, payment_method_id }  (payment_method_id from stripe.js)
router.post("/invoices/:id/charge-card", auth, async (req, res) => {
  try {
    const db = getDb();
    const { payment_method_id } = req.body;
    if (!payment_method_id) return res.status(400).json({ error: "payment_method_id required" });

    const inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "paid") return res.status(400).json({ error: "Already paid" });

    const amountNum = parseFloat(inv.amount || inv.total || 0);
    if (!amountNum || amountNum <= 0) return res.status(400).json({ error: "Invoice has no amount" });

    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Stripe is not configured" });
    const stripe = require("stripe")(stripeKey);

    // Create + confirm PaymentIntent in one step
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amountNum * 100),
      currency: "aud",
      payment_method: payment_method_id,
      confirm: true,
      // off_session: false — customer is right there, may need 3DS
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: {
        invoice_id: String(inv.id),
        invoice_number: inv.invoice_number || "",
        user_id: req.userId,
        source: "manual_card_entry",
      },
      description: `Invoice ${inv.invoice_number} — ${inv.client_name}`,
    }, {
      idempotencyKey: `inv_charge_${inv.id}_${payment_method_id}`,
    });

    if (intent.status === "succeeded") {
      db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
        .run(inv.id);
      return res.json({ ok: true, status: "succeeded", payment_intent_id: intent.id });
    }
    if (intent.status === "requires_action") {
      // 3D Secure required — return client_secret so frontend can complete with stripe.js
      return res.json({ ok: false, status: "requires_action", client_secret: intent.client_secret });
    }
    res.status(400).json({ error: `Payment ${intent.status}`, status: intent.status });
  } catch(e) {
    console.error("[invoice charge-card]", e.message);
    res.status(500).json({ error: e.message || "Card charge failed" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STRIPE TERMINAL — Tap to Pay on iPhone backend
// ════════════════════════════════════════════════════════════════════════════
//
// Three endpoints called by the TAKEOVA iOS app's Stripe Terminal SDK integration:
//
//   1. POST /stripe-terminal/connection-token
//      Returns a short-lived token the SDK uses to authenticate with Stripe.
//      Called automatically by the SDK before each session.
//
//   2. POST /stripe-terminal/create-payment-intent { amount, currency, invoice_id }
//      Creates a PaymentIntent on Stripe with payment_method_types=['card_present']
//      (which is what Tap to Pay uses). Returns client_secret to the iOS SDK.
//
//   3. POST /stripe-terminal/capture { payment_intent_id }
//      Called by iOS app once payment confirms locally. Marks the TAKEOVA invoice
//      as paid. (Also handled automatically by the Stripe webhook for safety.)
//
// All endpoints require auth — they run as the logged-in MINE user, so charges
// land in that user's Stripe account.

router.post("/stripe-terminal/connection-token", auth, async (req, res) => {
  try {
    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);
    const token = await stripe.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch(e) {
    console.error("[stripe-terminal connection-token]", e.message);
    res.status(500).json({ error: "Could not create connection token" });
  }
});

router.post("/stripe-terminal/create-payment-intent", auth, async (req, res) => {
  try {
    const { amount, currency = "aud", invoice_id, description } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Valid amount required" });

    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);

    let inv = null;
    if (invoice_id) {
      const db = getDb();
      inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND user_id = ?").get(invoice_id, req.userId);
    }

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // already in cents from iOS app
      currency,
      payment_method_types: ["card_present"], // Tap to Pay
      capture_method: "automatic",
      metadata: {
        invoice_id: invoice_id || "",
        invoice_number: inv?.invoice_number || "",
        user_id: req.userId,
        source: "tap_to_pay",
      },
      description: description || `Invoice ${inv?.invoice_number || invoice_id}`,
    }, {
      idempotencyKey: `tap_${invoice_id || req.userId}_${Date.now()}`,
    });

    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id });
  } catch(e) {
    console.error("[stripe-terminal create-payment-intent]", e.message);
    res.status(500).json({ error: e.message || "Could not create PaymentIntent" });
  }
});

router.post("/stripe-terminal/capture", auth, async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    if (!payment_intent_id) return res.status(400).json({ error: "payment_intent_id required" });

    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);

    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);

    // Ownership check — the metadata.user_id must match the calling user
    if (intent.metadata?.user_id !== req.userId) {
      return res.status(403).json({ error: "Not your PaymentIntent" });
    }

    // Mark invoice paid if this PaymentIntent succeeded
    if (intent.status === "succeeded" && intent.metadata?.invoice_id) {
      const db = getDb();
      db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(intent.metadata.invoice_id, req.userId);
    }
    res.json({ status: intent.status, charge_id: intent.latest_charge });
  } catch(e) {
    console.error("[stripe-terminal capture]", e.message);
    res.status(500).json({ error: "Could not confirm capture" });
  }
});

// ── Receive push token from native app for future server-initiated pushes ─
router.post("/push-tokens", auth, (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS push_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      platform TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, token)
    )`);
    const id = require("crypto").randomBytes(16).toString("hex");
    db.prepare("INSERT OR IGNORE INTO push_tokens (id, user_id, token, platform) VALUES (?,?,?,?)")
      .run(id, req.userId, token, platform || "unknown");
    res.json({ ok: true });
  } catch(e) {
    console.error("[push-tokens]", e.message);
    res.status(500).json({ error: "Could not store push token" });
  }
});

// ── DRM (Digital Rights Management for courses) ───────────────────────────────
// DEAD CODE — duplicate of first handler at line 8452; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/drm", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const courseId = req.query.course_id;
    const rules = db.prepare(`SELECT * FROM drm_rules WHERE user_id = ? ${courseId ? 'AND course_id = ?' : ''} ORDER BY created_at DESC`).all(...[uid, ...(courseId ? [courseId] : [])]);
    const downloads = db.prepare("SELECT COUNT(*) as count FROM drm_download_log WHERE user_id = ? AND created_at > datetime('now', '-30 days')").get(uid);
    res.json({ rules, stats: { downloads_30d: downloads?.count || 0 } });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// DEAD CODE — duplicate of first handler at line 8462; Express never reaches this. Kept for reference; remove or merge when ready.
router.post("/drm", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const { course_id, lesson_id, max_downloads, expiry_days, watermark, device_limit } = req.body;
    if (!course_id) return res.status(400).json({ error: "course_id required" });
    const r = db.prepare("INSERT INTO drm_rules (user_id, course_id, lesson_id, max_downloads, expiry_days, watermark, device_limit) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, course_id) DO UPDATE SET max_downloads=excluded.max_downloads, expiry_days=excluded.expiry_days, watermark=excluded.watermark, device_limit=excluded.device_limit").run(uid, course_id, lesson_id || null, max_downloads || 3, expiry_days || 365, watermark ? 1 : 0, device_limit || 2);
    res.json({ id: r.lastInsertRowid, success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── AI Contract Lawyer ────────────────────────────────────────────────────────
router.post("/ai/contract-lawyer", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();

    // Check plan contract limit (uses existing contracts metric)
    const check = checkUsage(db, req.userId, "contracts");
    if (check.blocked) return res.status(403).json({ error: "You've reached your monthly contract limit. Upgrade your plan for more.", cap: check.cap });

    const { dealDescription, partyA, partyB, contractType } = req.body;
    if (!dealDescription || typeof dealDescription !== "string" || dealDescription.trim().length < 10)
      return res.status(400).json({ error: "Deal description required (min 10 chars)" });

    // Immediate $9 Stripe charge
    const UGC_PRICE = 9.00;
    const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Payment processing not configured" });

    const userRow = db.prepare("SELECT stripe_customer_id, email, name FROM users WHERE id = ?").get(req.userId);
    if (!userRow?.stripe_customer_id) return res.status(402).json({ error: "No payment method on file. Add a card in billing settings.", needsPaymentMethod: true });

    let chargeId = null;
    // ── Admin bypass: owner uses free, costs route to company accounts ──
    const _isAdminLawyer = (typeof global.mineIsAdmin === "function") && global.mineIsAdmin(db, req.userId);
    if (_isAdminLawyer) {
      chargeId = "admin_free_lawyer_" + Date.now();
    } else try {
      const Stripe = require("stripe");
      const stripe = Stripe(stripeKey);
      // Idempotency: user + 5min window (single $X service, retries within
      // 5min de-dupe; new request after 5min is intentional).
      const idemKey = `lawyer_${req.userId}_${Math.floor(Date.now() / 300000)}`;
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(UGC_PRICE * 100),
        currency: "usd",
        customer: userRow.stripe_customer_id,
        payment_method_types: ["card"],
        confirm: true,
        off_session: true,
        description: `TAKEOVA AI Contract Lawyer — ${userRow.email}`,
        metadata: { user_id: req.userId, type: "contract_lawyer" }
      }, { idempotencyKey: idemKey });
      if (pi.status !== "succeeded") return res.status(402).json({ error: "Payment failed. Check your card in billing settings.", paymentStatus: pi.status });
      chargeId = pi.id;
      const { v4: chargeUuid } = require("uuid");
      const period = new Date().toISOString().slice(0,7);
      db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status, stripe_invoice_item_id) VALUES (?,?,?,?,?,?,?,'paid',?)")
        .run(chargeUuid(), req.userId, "contractLawyer", 1, UGC_PRICE, UGC_PRICE, period, chargeId);
    } catch(stripeErr) {
      if (stripeErr.code === "card_declined" || stripeErr.code === "authentication_required")
        return res.status(402).json({ error: "Card declined. Please update your payment method.", code: stripeErr.code });
      return res.status(402).json({ error: "Payment error: " + (stripeErr.message || "unknown") });
    }

    // Generate contract with Claude
    try {
      const safeDesc = dealDescription.trim().slice(0, 1000);
      const safeA = String(partyA || userRow.name || "Party A").trim().slice(0, 100);
      const safeB = String(partyB || "Client").trim().slice(0, 100);
      const safeType = String(contractType || "service agreement").trim().slice(0, 50);

      const msg = await _callAI(
        `Draft a professional ${safeType} contract.

Party A (Provider): ${safeA}
Party B (Client): ${safeB}
Deal description: ${safeDesc}`,
        `You are a business contract specialist. Draft a clear, professional, legally-structured contract based on the deal description.

Return JSON only:
{
  "title": "Contract title e.g. Service Agreement, Freelance Contract, NDA",
  "content": "Full contract text with proper sections: Parties, Scope of Work, Payment Terms, Timeline, Intellectual Property, Confidentiality, Termination, Dispute Resolution, Signatures. Use [DATE] for dates and [SIGNATURE] for signature lines. Professional but plain English. Minimum 500 words.",
  "keyClauses": ["3-5 key protections included in this contract"],
  "disclaimer": "Standard disclaimer text"
}

Important: The contract must be comprehensive and professional. Include all standard protective clauses for this type of agreement.`,
        2000
      );
      const text = msg.content?.[0]?.text || "";
      const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());

      // Save to contracts table
      try {
        const { v4: uid } = require("uuid");
        const contractId = uid();
        db.exec(`CREATE TABLE IF NOT EXISTS contracts (
          id TEXT PRIMARY KEY, user_id TEXT, title TEXT, content TEXT,
          status TEXT DEFAULT 'draft', client_name TEXT, client_email TEXT,
          sign_token TEXT, signed_at TEXT, created_at TEXT, updated_at TEXT
        )`);
        const signToken = require("crypto").randomBytes(24).toString("hex");
        db.prepare("INSERT INTO contracts (id, user_id, title, content, status, client_name, sign_token, created_at, updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))")
          .run(contractId, req.userId, result.title || "AI Contract", result.content || "", "draft", safeB, signToken);
        result.contractId = contractId;
      } catch(dbErr) { /* contract save non-critical */ }

      trackUsage(db, req.userId, "contracts", 1, { skipOverageBilling: true }); // $9 charged inline above — count toward cap but don't ALSO auto-bill the $3 contracts overage (double-charge)
      res.json({ ...result, chargeId, charged: UGC_PRICE });
    } catch(e) {
      res.json({ error: "Contract generation failed. Your card has not been charged.", chargeId: null });
    }
  } catch(e) {
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── AI SEO Content Planner ────────────────────────────────────────────────────
router.post("/ai/seo-planner", auth, _aiRateLimit, async (req, res) => {
  try {
    const db = require("../db/init").getDb();

    // Pro/Enterprise only
    const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
    const allowedPlans = ["pro", "enterprise"];
    if (!allowedPlans.includes(user?.plan)) {
      return res.status(403).json({ error: "AI SEO Planner is available on Pro and Enterprise plans only.", upgrade: true });
    }

    // Monthly cap: Pro = 1/mo, Enterprise = 3/mo
    const monthlyCap = user.plan === "enterprise" ? 3 : 1;
    const period = new Date().toISOString().slice(0,7);
    db.exec("CREATE TABLE IF NOT EXISTS seo_plans (id TEXT PRIMARY KEY, user_id TEXT, period TEXT, plan_data TEXT, created_at TEXT)");
    const usedThisMonth = db.prepare("SELECT COUNT(*) as n FROM seo_plans WHERE user_id = ? AND period = ?").get(req.userId, period)?.n || 0;
    if (usedThisMonth >= monthlyCap) {
      return res.status(429).json({ error: `You've used your ${monthlyCap} SEO plan${monthlyCap>1?"s":""} this month. Resets on the 1st.`, used: usedThisMonth, cap: monthlyCap });
    }

    const { businessName, businessType, targetAudience, mainKeywords, competitors } = req.body;
    if (!businessName || typeof businessName !== "string" || businessName.trim().length < 2)
      return res.status(400).json({ error: "Business name required" });

    // Pull products/site data for context
    const site = db.prepare("SELECT name, data FROM sites WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(req.userId);
    const siteData = site ? JSON.parse(site.data || "{}") : {};
    const products = (siteData.products || []).slice(0, 10).map(p => p.name).join(", ");

    const msg = await _callAI(
      `Business: ${businessName.trim().slice(0,100)}
Type: ${String(businessType||"").trim().slice(0,100)}
Products/Services: ${products || String(req.body.products||"").trim().slice(0,200)}
Target audience: ${String(targetAudience||"").trim().slice(0,200)}
Main keywords: ${String(mainKeywords||"").trim().slice(0,200)}
Competitors: ${String(competitors||"").trim().slice(0,200)}`,
      `You are an SEO strategist. Create a detailed 90-day content plan. Return JSON only:
{
  "summary": "2-sentence overview of the SEO strategy",
  "primaryKeywords": ["5 high-value keywords to target"],
  "contentCalendar": [
    {
      "week": 1,
      "theme": "Theme for the week",
      "posts": [
        {"title": "Blog post title", "keyword": "target keyword", "intent": "informational|commercial|transactional", "estimatedTraffic": "low|medium|high", "notes": "brief notes on angle or hook"}
      ]
    }
  ],
  "quickWins": ["3 things to do this week for immediate SEO impact"],
  "technicalTips": ["3 technical SEO improvements for their site type"],
  "contentTypes": ["Blog posts", "Product pages", "FAQs", "etc — recommend content mix"]
}

Generate 12 weeks of content (weeks 1-12). Each week has 1-2 posts. Make titles specific and compelling, not generic.`,
      3000
    );
    const text = msg.content?.[0]?.text || "";
    const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());

    // Save plan
    const { v4: uid } = require("uuid");
    db.prepare("INSERT INTO seo_plans (id, user_id, period, plan_data, created_at) VALUES (?,?,?,?,datetime('now'))")
      .run(uid(), req.userId, period, JSON.stringify(result));

    res.json({ ...result, used: usedThisMonth + 1, cap: monthlyCap, period });
  } catch(e) {
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── Get saved SEO plans ───────────────────────────────────────────────────────
router.get("/ai/seo-planner", auth, (req, res) => {
  try {
    const db = require("../db/init").getDb();
    db.exec("CREATE TABLE IF NOT EXISTS seo_plans (id TEXT PRIMARY KEY, user_id TEXT, period TEXT, plan_data TEXT, created_at TEXT)");
    const plans = db.prepare("SELECT id, period, plan_data, created_at FROM seo_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 6").all(req.userId);
    res.json({ plans: plans.map(p => ({ ...p, plan_data: JSON.parse(p.plan_data || "{}") })) });
  } catch(e) {
    res.json({ plans: [] });
  }
});




// ═══════════════════════════════════════════════════════════════════════
// PRODUCT BUNDLES, VARIANTS, RETURNS — added for dashboard feature parity
// ═══════════════════════════════════════════════════════════════════════

function ensureProductExtrasTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_bundles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      product_ids TEXT,
      price REAL,
      discount_percent INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      user_id TEXT NOT NULL,
      variant_name TEXT NOT NULL,
      sku TEXT,
      price REAL,
      stock INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS order_returns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      reason TEXT,
      refund_amount REAL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS referral_config (
      user_id TEXT PRIMARY KEY,
      referrer_reward TEXT,
      referee_reward TEXT,
      min_spend REAL,
      max_referrals INTEGER,
      expiry_days INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS loyalty_expiry_rules (
      user_id TEXT PRIMARY KEY,
      expires_after TEXT DEFAULT 'never',
      reminder_days INTEGER DEFAULT 30,
      extend_on_activity TEXT DEFAULT 'no',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS popup_exit_intent (
      user_id TEXT PRIMARY KEY,
      trigger TEXT,
      offer TEXT,
      code TEXT,
      show_once_per TEXT,
      enabled INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS blog_auto_publish (
      user_id TEXT PRIMARY KEY,
      platforms TEXT,
      timing TEXT,
      format TEXT,
      enabled INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

router.post("/products/bundles", auth, async (req, res) => {
  try {
    const db = getDb(); ensureProductExtrasTables(db);
    const { name, products, price, discount } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const id = uuid();
    db.prepare("INSERT INTO product_bundles (id, user_id, name, product_ids, price, discount_percent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, req.userId, name, JSON.stringify(products || []), Number(price) || 0, Number(discount) || 0);
    res.json({ ok: true, id, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/products/bundles", auth, async (req, res) => {
  try {
    const db = getDb(); ensureProductExtrasTables(db);
    const rows = db.prepare("SELECT * FROM product_bundles WHERE user_id=? ORDER BY created_at DESC").all(req.userId);
    res.json({ bundles: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/products/variants", auth, async (req, res) => {
  try {
    const db = getDb(); ensureProductExtrasTables(db);
    const { product, variant_name, sku, price, stock } = req.body || {};
    const id = uuid();
    db.prepare("INSERT INTO product_variants (id, product_id, user_id, variant_name, sku, price, stock) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, product || null, req.userId, variant_name || "Variant", sku || null, Number(price) || 0, Number(stock) || 0);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/orders/returns", auth, async (req, res) => {
  try {
    const db = getDb(); ensureProductExtrasTables(db);
    const { order_id, reason, refund_amount } = req.body || {};
    if (!order_id) return res.status(400).json({ error: "order_id required" });
    const id = uuid();
    db.prepare("INSERT INTO order_returns (id, user_id, order_id, reason, refund_amount) VALUES (?, ?, ?, ?, ?)")
      .run(id, req.userId, order_id, reason || "", Number(refund_amount) || 0);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/referrals/config", auth, async (req, res) => {
  try {
    const db = getDb(); ensureProductExtrasTables(db);
    const b = req.body || {};
    db.prepare(`INSERT INTO referral_config (user_id, referrer_reward, referee_reward, min_spend, max_referrals, expiry_days, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        referrer_reward=excluded.referrer_reward,
        referee_reward=excluded.referee_reward,
        min_spend=excluded.min_spend,
        max_referrals=excluded.max_referrals,
        expiry_days=excluded.expiry_days,
        updated_at=excluded.updated_at`)
      .run(req.userId, b.referrer_reward || "", b.referee_reward || "", Number(b.min_spend) || 0, Number(b.max_referrals) || 0, Number(b.expiry_days) || 30);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/loyalty/expiry", auth, async (req, res) => {
  try {
    const db = getDb(); ensureProductExtrasTables(db);
    const b = req.body || {};
    db.prepare(`INSERT INTO loyalty_expiry_rules (user_id, expires_after, reminder_days, extend_on_activity, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET expires_after=excluded.expires_after, reminder_days=excluded.reminder_days, extend_on_activity=excluded.extend_on_activity, updated_at=excluded.updated_at`)
      .run(req.userId, b.expires_after || "never", Number(b.reminder_days) || 30, b.extend_on_activity || "no");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/popups/exit-intent", auth, async (req, res) => {
  try {
    const db = getDb(); ensureProductExtrasTables(db);
    const b = req.body || {};
    db.prepare(`INSERT INTO popup_exit_intent (user_id, trigger, offer, code, show_once_per, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET trigger=excluded.trigger, offer=excluded.offer, code=excluded.code, show_once_per=excluded.show_once_per, enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .run(req.userId, b.trigger || "", b.offer || "", b.code || "", b.show_once_per || "session", (b.enabled === 0 || b.enabled === false) ? 0 : 1);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/blog/auto-publish", auth, async (req, res) => {
  try {
    const db = getDb(); ensureProductExtrasTables(db);
    const b = req.body || {};
    db.prepare(`INSERT INTO blog_auto_publish (user_id, platforms, timing, format, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET platforms=excluded.platforms, timing=excluded.timing, format=excluded.format, updated_at=excluded.updated_at`)
      .run(req.userId, b.platforms || "", b.timing || "", b.format || "");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// ═══════════════════════════════════════════════════════════════════════
// GENERIC CATCH-ALL for any /api/features/:entity — persists to user_features
// Falls through BELOW specific handlers so explicit routes always win.
// ═══════════════════════════════════════════════════════════════════════

function ensureGenericTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_features (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      sub_entity TEXT,
      data_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_features_user ON user_features(user_id, entity);
  `);
}

// GET /api/features/:entity — list items for an entity
router.get("/:entity", auth, (req, res) => {
  try {
    const db = getDb(); ensureGenericTable(db);
    const entity = req.params.entity;
    const rows = db.prepare("SELECT * FROM user_features WHERE user_id=? AND entity=? ORDER BY created_at DESC LIMIT 500")
      .all(req.userId, entity);
    const items = rows.map(r => {
      try { return { id: r.id, ...JSON.parse(r.data_json), created_at: r.created_at, updated_at: r.updated_at }; }
      catch { return { id: r.id, created_at: r.created_at }; }
    });
    res.json({ items, [entity]: items, data: items, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/features/:entity — create an item
router.post("/:entity", auth, (req, res) => {
  try {
    const db = getDb(); ensureGenericTable(db);
    const id = uuid();
    const entity = req.params.entity;
    db.prepare("INSERT INTO user_features (id, user_id, entity, data_json) VALUES (?, ?, ?, ?)")
      .run(id, req.userId, entity, JSON.stringify(req.body || {}));
    res.json({ ok: true, id, ...(req.body || {}), entity, created_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/features/:entity/:id — get single item
router.get("/:entity/:id", auth, (req, res) => {
  try {
    const db = getDb(); ensureGenericTable(db);
    const row = db.prepare("SELECT * FROM user_features WHERE user_id=? AND entity=? AND id=?")
      .get(req.userId, req.params.entity, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    let data = {};
    try { data = JSON.parse(row.data_json); } catch {}
    res.json({ id: row.id, ...data, created_at: row.created_at, updated_at: row.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/features/:entity/:id — update
router.put("/:entity/:id", auth, (req, res) => {
  try {
    const db = getDb(); ensureGenericTable(db);
    const result = db.prepare("UPDATE user_features SET data_json=?, updated_at=datetime('now') WHERE user_id=? AND entity=? AND id=?")
      .run(JSON.stringify(req.body || {}), req.userId, req.params.entity, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, id: req.params.id, ...(req.body || {}), updated_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/features/:entity/:id — delete
router.delete("/:entity/:id", auth, (req, res) => {
  try {
    const db = getDb(); ensureGenericTable(db);
    const result = db.prepare("DELETE FROM user_features WHERE user_id=? AND entity=? AND id=?")
      .run(req.userId, req.params.entity, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/features/:entity/:id/:action — generic action endpoint  
router.post("/:entity/:id/:action", auth, (req, res) => {
  try {
    const db = getDb(); ensureGenericTable(db);
    const { entity, id, action } = req.params;
    const row = db.prepare("SELECT * FROM user_features WHERE user_id=? AND entity=? AND id=?")
      .get(req.userId, entity, id);
    if (!row) return res.status(404).json({ error: "Not found" });
    let data = {};
    try { data = JSON.parse(row.data_json); } catch {}
    data[action] = { performed_at: new Date().toISOString(), payload: req.body || {} };
    data.last_action = action;
    db.prepare("UPDATE user_features SET data_json=?, updated_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(data), id);
    res.json({ ok: true, id, action, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/features/:entity/:action — entity-level action (no id)
router.post("/:entity/bulk/:action", auth, (req, res) => {
  try {
    res.json({ ok: true, action: req.params.action, entity: req.params.entity, processed: (req.body?.ids || []).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports.fireWebhooks = fireWebhooks;


router.post("/ai/store-bio", auth, _aiRateLimit, async (req, res) => {
  const { businessName, businessType, products, tone } = req.body;
  if (!businessName || typeof businessName !== "string" || businessName.trim().length < 2) return res.status(400).json({ error: "Business name required" });
  const _sbDb = getDb();
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const _u = global.mineCheckUsage(_sbDb, req.userId, "storeBio");
    if (_u.blocked) return res.status(403).json({ error: "Store bio generator not available on your plan.", upgrade: true });
    const _t = global.mineTrackUsage(_sbDb, req.userId, "storeBio");
    if (_t?.isOverage) res.setHeader("X-Overage-Charge", _t.overageCost);
  }
  try {
    const msg = await _callAI(
      `Business name: ${businessName.trim().slice(0,120)}\
Type: ${String(businessType||"").trim().slice(0,100)}\
Products/services: ${String(products||"").trim().slice(0,300)}\
Tone: ${String(tone||"professional").trim()}`,
      `You are a brand copywriter. Generate a complete brand identity copy kit. Return JSON only: { "tagline": "punchy 8-word max tagline", "shortBio": "2-sentence bio for About page (max 80 words)", "longBio": "4-6 sentence bio for website (max 200 words)", "instagramBio": "Instagram bio under 150 chars with 1-2 relevant emojis", "twitterBio": "Twitter/X bio under 160 chars", "linkedinSummary": "LinkedIn company description 3-4 sentences", "heroHeadline": "Homepage hero headline max 10 words", "heroSubheadline": "Homepage hero subheadline max 20 words" }`,
      800
    );
    const text = msg.content?.[0]?.text || "";
    const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
    res.json(result);
  } catch (e) { console.error("[AI store-bio]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
});

// \\u2500\\u2500 AI Email Sequence Builder \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
router.post("/ai/sequence-builder", auth, _aiRateLimit, async (req, res) => {
  const { goal, businessName, audienceDescription, numEmails, tone } = req.body;
  if (!goal || typeof goal !== "string" || goal.trim().length < 5) return res.status(400).json({ error: "Sequence goal required" });
  const n = Math.min(Math.max(parseInt(numEmails) || 5, 2), 10);
  const _sqDb = getDb();
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const _u = global.mineCheckUsage(_sqDb, req.userId, "sequenceBuilder");
    if (_u.blocked) return res.status(403).json({ error: "AI sequence builder not available on your plan. Upgrade to Growth or higher.", upgrade: true });
    const _t = global.mineTrackUsage(_sqDb, req.userId, "sequenceBuilder");
    if (_t?.isOverage) res.setHeader("X-Overage-Charge", _t.overageCost);
  }
  try {
    const msg = await _callAI(
      `Business: ${String(businessName||"").trim().slice(0,100)}\
Goal: ${goal.trim().slice(0,300)}\
Audience: ${String(audienceDescription||"new subscribers").trim().slice(0,200)}\
Tone: ${String(tone||"friendly professional").trim()}\
Emails requested: ${n}`,
      `You are an email marketing expert. Write a complete ${n}-email sequence to achieve the stated goal. Return JSON only \\u2014 an array of exactly ${n} objects: [{ "step": 1, "delay": 0, "subject": "Subject line", "preview": "Preview text under 90 chars", "body": "Full HTML email body (use <p>, <strong>, <a> tags, max 300 words, end with clear CTA)" }, ...]`,
      2000
    );
    const text = msg.content?.[0]?.text || "";
    const emails = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
    if (!Array.isArray(emails)) throw new Error("Invalid response");
    res.json({ emails });
  } catch (e) { console.error("[AI sequence-builder]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
});

// \\u2500\\u2500 Daily Digest \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
router.get("/digest/settings", auth, (req, res) => {
  const db = getDb();
  try { db.exec("CREATE TABLE IF NOT EXISTS digest_settings (user_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, channel TEXT DEFAULT 'email', send_time TEXT DEFAULT '08:00', timezone TEXT DEFAULT 'UTC', last_sent TEXT)"); } catch {}
  const row = db.prepare("SELECT * FROM digest_settings WHERE user_id=?").get(req.userId);
  res.json(row || { user_id: req.userId, enabled: 0, channel: "email", send_time: "08:00", timezone: "UTC", last_sent: null });
});

router.put("/digest/settings", auth, (req, res) => {
  const db = getDb();
  try { db.exec("CREATE TABLE IF NOT EXISTS digest_settings (user_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, channel TEXT DEFAULT 'email', send_time TEXT DEFAULT '08:00', timezone TEXT DEFAULT 'UTC', last_sent TEXT)"); } catch {}
  const { enabled, channel, send_time, timezone } = req.body;
  db.prepare("INSERT OR REPLACE INTO digest_settings (user_id, enabled, channel, send_time, timezone) VALUES (?,?,?,?,?)").run(
    req.userId, enabled ? 1 : 0, channel === "whatsapp" ? "whatsapp" : "email",
    String(send_time || "08:00").slice(0,5), String(timezone || "UTC").slice(0,50)
  );
  res.json({ success: true });
});

router.post("/digest/send-now", auth, async (req, res) => {
  const db = getDb();
  try {
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    // Gather today's stats
    const today = new Date().toISOString().split("T")[0];
    const invoices = db.prepare("SELECT COUNT(*) as n, SUM(total) as t FROM invoices WHERE user_id=? AND status='unpaid'").get(req.userId);
    const orders = db.prepare("SELECT COUNT(*) as n, SUM(amount) as t FROM orders WHERE user_id=? AND DATE(created_at)=?").get(req.userId, today);
    const bookings = db.prepare("SELECT COUNT(*) as n FROM bookings WHERE user_id=? AND date=?").get(req.userId, today);
    const reviews = db.prepare("SELECT COUNT(*) as n FROM product_reviews WHERE user_id=? AND DATE(created_at)=?").get(req.userId, today);
    const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px">
      <h2 style="margin-bottom:16px">\\u2600\\ufe0f Good morning, ${user.name?.split(" ")[0] || "there"}!</h2>
      <p style="color:#64748B;margin-bottom:24px">Here's your TAKEOVA business digest for ${today}</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:12px;background:#F1F5F9;border-radius:8px;margin-bottom:8px"><strong>\\ud83d\\udce6 Orders today</strong></td><td style="padding:12px;font-weight:700;color:#2563EB">${orders?.n || 0} (${orders?.t ? "$" + Number(orders.t).toFixed(2) : "$0"})</td></tr>
        <tr><td style="padding:12px"><strong>\\ud83d\\udcc5 Bookings today</strong></td><td style="padding:12px;font-weight:700;color:#2563EB">${bookings?.n || 0}</td></tr>
        <tr><td style="padding:12px;background:#F1F5F9"><strong>\\ud83d\\udcb3 Unpaid invoices</strong></td><td style="padding:12px;font-weight:700;color:${(invoices?.n||0)>0?"#DC2626":"#16A34A"}">${invoices?.n || 0} ($${Number(invoices?.t||0).toFixed(2)})</td></tr>
        <tr><td style="padding:12px"><strong>\\u2b50 New reviews</strong></td><td style="padding:12px;font-weight:700;color:#2563EB">${reviews?.n || 0}</td></tr>
      </table>
      <a href="${process.env.FRONTEND_URL||"https://takeova.ai"}/dashboard" style="display:inline-block;margin-top:20px;background:#2563EB;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600">Open MINE \\u2192</a>
    </div>`;
    await autoEmail(req.userId, user.email, `\\u2600\\ufe0f Your TAKEOVA digest \\u2014 ${today}`, html);
    db.prepare("UPDATE digest_settings SET last_sent=datetime('now') WHERE user_id=?").run(req.userId);
    res.json({ success: true });
  } catch (e) { console.error("[Digest]", e?.message); res.status(500).json({ error: "Failed to send digest" }); }
});

// \\u2500\\u2500 Competitor Price Tracker \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
(function initTrackerTable() {
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS price_tracker (
        id TEXT PRIMARY KEY, user_id TEXT, name TEXT, url TEXT,
        last_price TEXT, last_checked TEXT, notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_price_tracker_user ON price_tracker(user_id);
    `);
  } catch {}
})();

router.get("/competitor/tracked", auth, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM price_tracker WHERE user_id=? ORDER BY created_at DESC").all(req.userId);
  res.json({ tracked: rows });
});

router.post("/competitor/track", auth, (req, res) => {
  const { name, url, notes } = req.body;
  if (!name || !url) return res.status(400).json({ error: "Name and URL required" });
  try { const u = new URL(url); if (!["http:","https:"].includes(u.protocol)) throw new Error(); } catch { return res.status(400).json({ error: "Invalid URL" }); }
  const db = getDb();
  const { v4: uid } = require("uuid");
  const id = uid();
  db.prepare("INSERT INTO price_tracker (id, user_id, name, url, notes) VALUES (?,?,?,?,?)").run(id, req.userId, String(name).slice(0,120), url.slice(0,500), String(notes||"").slice(0,300));
  res.json({ success: true, id });
});

router.delete("/competitor/track/:id", auth, (req, res) => {
  getDb().prepare("DELETE FROM price_tracker WHERE id=? AND user_id=?").run(req.params.id, req.userId);
  res.json({ success: true });
});

router.post("/competitor/check/:id", auth, async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM price_tracker WHERE id=? AND user_id=?").get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: "Not found" });
  try {
    const msg = await _callAI(
      `Competitor URL: ${row.url}\
Competitor name: ${row.name}`,
      `You are a pricing research analyst. Based on what you know about this company/URL, provide their current pricing. Return JSON only: { "prices": [{ "product": "product name", "price": "$X/mo or $X", "notes": "any conditions" }], "pricingModel": "subscription|one-time|freemium|custom", "lastKnownUpdate": "approx date if known", "summary": "1 sentence summary of their pricing" }`,
      600
    );
    const text = msg.content?.[0]?.text || "";
    const result = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, "").trim());
    db.prepare("UPDATE price_tracker SET last_price=?, last_checked=datetime('now') WHERE id=?").run(JSON.stringify(result), row.id);
    res.json({ success: true, result, checked_at: new Date().toISOString() });
  } catch (e) { console.error("[PriceTracker]", e?.message); res.status(502).json({ error: "AI unavailable" }); }
});
module.exports.trackUsage = trackUsage;
