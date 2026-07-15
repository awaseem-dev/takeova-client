const express = require("express");
const { teamRosterText } = require("../employee-identity");
const { isS3Enabled, uploadBase64ToS3, getSignedUrl } = require("../utils/s3");
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");

// ─── Plan-cap guard — wraps mineCheckUsage + auto-tracks on success ───
function _capGuard(req, res, metric) {
  if (typeof global.mineCheckUsage === 'function') {
    try {
      const usage = global.mineCheckUsage(getDb(), req.userId, metric);
      if (usage && usage.blocked) {
        res.status(403).json({
          error: "You've used all your AI for this month. Upgrade to continue.",
          used: usage.used, cap: usage.cap, metric: metric, upgrade: true
        });
        return false;
      }
    } catch(_) {}
  }
  const _orig = res.json.bind(res);
  res.json = function(payload) {
    if (res.statusCode < 400 && typeof global.mineTrackUsage === 'function') {
      try { global.mineTrackUsage(getDb(), req.userId, metric); } catch(_) {}
    }
    return _orig(payload);
  };
  return true;
}

const { auth } = require("../middleware/auth");
const { getSetting, getValidRedditToken } = require("./integrations");

// ─── Enhancement helpers (outcomes, memory, handoffs, retries) ────────────
// Safe-load pattern: if the enhancements module isn't mounted yet, the
// no-op fallbacks below keep the existing agent code working unchanged.
let _enh = null;
try { _enh = require("./ai-employees-enhancements"); } catch (_) { _enh = null; }
const recordOutcome = _enh?.recordOutcome || (() => {});
const getMemory     = _enh?.getMemory     || (() => null);
const upsertMemory  = _enh?.upsertMemory  || (() => {});
const handoff       = _enh?.handoff       || (() => null);
const queueRetry    = _enh?.queueRetry    || (() => {});

// ─── Baseline rule enforcement (working hours, approval rules, brand voice, KB) ───
let _baseline = null;
try { _baseline = require("./baseline-enforcement"); } catch (_) { _baseline = null; }
const _checkBaseline = _baseline?._checkBaseline || (() => ({ ok: true, brandVoice: "", businessContext: "", kbFileIds: [], config: {} }));

const router = express.Router();
const rateLimit = require("express-rate-limit");

// ═══════════════════════════════════════════════════════════════
// SHARED WEBHOOK SIGNATURE VERIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════
// Use these on every inbound Twilio/SendGrid endpoint so attackers can't
// POST fake call/SMS/email payloads directly to our routes and inject
// data into the CRM, bill fake overage usage, or redirect call flow.

function verifyTwilioSig(req, routePath) {
  // Returns true if the request has a valid x-twilio-signature for the
  // supplied route path, false otherwise. Fail-open only when the auth
  // token is missing (local dev) — production should always have one set.
  try {
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ||
      (() => { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_AUTH_TOKEN'").get()?.value; } catch { return null; } })();
    if (!twilioAuthToken) return true; // dev mode — no token configured
    const twilio = require("twilio");
    const requestUrl = (process.env.BACKEND_URL || "http://localhost:4000") + routePath;
    const signature = req.headers["x-twilio-signature"] || "";
    return twilio.validateRequest(twilioAuthToken, signature, requestUrl, req.body);
  } catch (_) {
    return true; // twilio package not installed — dev mode
  }
}

function verifySendgridSig(req) {
  // SendGrid Inbound Parse signature uses ECDSA over the raw payload.
  // Returns true when the signature is valid or when no public key is
  // configured (dev fallback). Fails closed in prod when the key is set
  // but the signature doesn't match.
  try {
    const pubKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY ||
      (() => { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_WEBHOOK_PUBLIC_KEY'").get()?.value; } catch { return null; } })();
    if (!pubKey) return true; // dev fallback
    const sig = req.headers["x-twilio-email-event-webhook-signature"] ||
                req.headers["x-sendgrid-webhook-signature"] || "";
    const ts  = req.headers["x-twilio-email-event-webhook-timestamp"] ||
                req.headers["x-sendgrid-webhook-timestamp"] || "";
    if (!sig || !ts) return false;
    const crypto = require("crypto");
    const payload = ts + (typeof req.rawBody === "string" ? req.rawBody :
                          (req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body || {})));
    const verifier = crypto.createVerify("sha256");
    verifier.update(payload);
    verifier.end();
    const formattedKey = pubKey.includes("BEGIN PUBLIC KEY")
      ? pubKey
      : `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`;
    return verifier.verify(formattedKey, sig, "base64");
  } catch (_) {
    return false; // crypto error → treat as invalid
  }
}

// Rate limiter for public support ticket creation — prevents AI cost abuse & ticket spam
const _ticketLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => req.ip + ":" + (req.body?.siteId || ""),
  message: { error: "Too many support tickets from this IP, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-username engagement rate limit — prevents fake engagement flooding social API calls
const engagementLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.body?.platform || "unknown") + ":" + (req.body?.username || req.ip),
  message: { error: "Too many engagement events — please slow down" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Escape special XML chars so AI responses don't break TwiML
// -- Grok TTS voice support for the AI receptionist ----------------------------
const GROK_VOICES = { eve: 1, ara: 1, rex: 1, sal: 1, leo: 1 };

function unescapeXml(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// A user may use a Grok voice only if Grok is configured AND they are on a paid
// plan. Adjust the plan/status lists here to tighten or loosen who gets it.
function grokVoiceEntitled(db, userId) {
  try {
    const u = db.prepare("SELECT plan, subscription_status FROM users WHERE id = ?").get(userId);
    if (!u) return false;
    const paidPlans = ["starter", "growth", "pro", "enterprise", "agency"];
    const okStatus = ["active", "trialing"];
    return (u.plan && paidPlans.includes(u.plan)) || (u.subscription_status && okStatus.includes(u.subscription_status));
  } catch (_) { return false; }
}

function computeVoiceCtx(db, userId) {
  const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
  let voice = "polly";
  try {
    const vs = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'receptionist_voice'").get(userId);
    if (vs && vs.value) voice = vs.value;
  } catch (_) {}
  const grokVoice = (GROK_VOICES[voice] && process.env.XAI_API_KEY && grokVoiceEntitled(db, userId)) ? voice : null;
  return { grokVoice, backendUrl };
}

// Call xAI Grok TTS -> MP3 Buffer, or null on any failure.
async function grokTTS(text, voiceId) {
  const key = process.env.XAI_API_KEY;
  if (!key || !text) return null;
  try {
    const resp = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text).slice(0, 3000), voice_id: voiceId, language: "en" }),
    });
    if (!resp || !resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length ? buf : null;
  } catch (_) { return null; }
}

// Cached clip id for (voice,text), generating + storing if needed. id or null.
async function getVoiceClip(db, voiceId, text) {
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256").update(voiceId + "|" + String(text)).digest("hex");
  try {
    const hit = db.prepare("SELECT id FROM voice_audio WHERE voice = ? AND text_hash = ?").get(voiceId, hash);
    if (hit) return hit.id;
  } catch (_) {}
  const buf = await grokTTS(text, voiceId);
  if (!buf) return null;
  const id = uuid();
  try {
    db.prepare("INSERT INTO voice_audio (id, voice, text_hash, mime, data, created_at) VALUES (?,?,?,?,?,datetime('now'))")
      .run(id, voiceId, hash, "audio/mpeg", buf);
    db.prepare("DELETE FROM voice_audio WHERE created_at < datetime('now','-7 days')").run();
  } catch (_) { return null; }
  return id;
}

// Send TwiML, swapping each <Say voice="Polly.Joanna"> line for a Grok <Play> when a
// Grok voice is selected. Bare <Say> (system/error) lines stay on Twilio's voice. Any
// TTS failure falls back to the original Polly line, so a call never breaks.
async function sendVoiceTwiml(res, db, vctx, twiml) {
  let out = twiml;
  if (vctx && vctx.grokVoice && process.env.XAI_API_KEY) {
    try {
      const re = /<Say voice="Polly\.Joanna">([\s\S]*?)<\/Say>/g;
      const seen = {};
      let m;
      while ((m = re.exec(twiml)) !== null) {
        if (seen[m[1]] === undefined) seen[m[1]] = await getVoiceClip(db, vctx.grokVoice, unescapeXml(m[1]));
      }
      out = twiml.replace(re, (full, seg) => {
        const id = seen[seg];
        return id ? `<Play>${vctx.backendUrl}/api/ai-employees/voice/clip/${id}.mp3</Play>` : full;
      });
    } catch (_) { out = twiml; }
  }
  return res.type("text/xml").send(out);
}

function escapeXml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


// ═══════════════════════════════════════
// AI EMPLOYEES — AUTONOMOUS AGENTS
// These don't just chat — they ACT.
// ═══════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────────
// Lead magnet polling — runs independently of Sales Rep subscription.
// Called by both the Sales Rep cron (when hired) AND the standalone magnet cron
// in server.js (which runs for every user with active magnets).
// ────────────────────────────────────────────────────────────────────────────
async function pollLeadMagnetsForUser(db, userId) {
  try {
    ensureLeadMagnetTables(db);
    const magnets = db.prepare("SELECT * FROM lead_magnets WHERE user_id = ? AND active = 1").all(userId);
    if (magnets.length === 0) return { polled: 0, reason: "no_active_magnets" };

    const connections = db.prepare("SELECT * FROM social_connections WHERE user_id = ?").all(userId);
    if (connections.length === 0) return { polled: 0, reason: "no_social_connections" };

    const fetch = (await import("node-fetch")).default;

    for (const conn of connections) {
      if (!conn.access_token) continue;
      try {
        let comments = [];
        if (conn.platform === "instagram" || conn.platform === "facebook") {
          const mediaResp = await fetch(`https://graph.facebook.com/v21.0/${conn.platform_page_id || "me"}/feed?fields=id,comments{id,from,message,created_time}&limit=10&access_token=${conn.access_token}`);
          const mediaData = await mediaResp.json();
          for (const post of (mediaData.data || [])) {
            for (const c of (post.comments?.data || [])) {
              comments.push({ platform: conn.platform, post_id: post.id, comment_id: c.id, username: c.from?.name || "", user_id_platform: c.from?.id, comment_text: c.message, created: c.created_time });
            }
          }
        } else if (conn.platform === "x") {
          const mentionsResp = await fetch(`https://api.twitter.com/2/users/${conn.platform_user_id}/mentions?max_results=20&tweet.fields=text,author_id,in_reply_to_user_id,created_at`, {
            headers: { "Authorization": `Bearer ${conn.access_token}` }
          });
          const mentionsData = await mentionsResp.json();
          for (const tweet of (mentionsData.data || [])) {
            comments.push({ platform: "x", post_id: tweet.in_reply_to_user_id || "", comment_id: tweet.id, username: tweet.author_id, user_id_platform: tweet.author_id, comment_text: tweet.text, created: tweet.created_at });
          }
        } else if (conn.platform === "tiktok") {
          const vidsResp = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=id`, {
            method: "POST", headers: { "Authorization": `Bearer ${conn.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ max_count: 5 })
          });
          const vidsData = await vidsResp.json();
          for (const vid of (vidsData.data?.videos || [])) {
            const commResp = await fetch(`https://open.tiktokapis.com/v2/comment/list/?fields=id,text,user&video_id=${vid.id}`, {
              headers: { "Authorization": `Bearer ${conn.access_token}` }
            });
            const commData = await commResp.json();
            for (const c of (commData.data?.comments || [])) {
              comments.push({ platform: "tiktok", post_id: vid.id, comment_id: c.id, username: c.user?.display_name || "", user_id_platform: c.user?.id, comment_text: c.text });
            }
          }
        }
        // Pass each comment through the engagement endpoint
        for (const comment of comments) {
          try {
            await fetch(`http://localhost:${process.env.PORT || 4000}/api/ai-employees/lead-magnets/engagement`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...comment, engagement_type: "comment" })
            });
          } catch(e) { console.error("[pollLeadMagnetsForUser/engagement]", e.message); }
        }
      } catch(e) { console.error("[pollLeadMagnetsForUser/platform]", e.message); }
    }
    return { polled: magnets.length };
  } catch(e) {
    console.error("[pollLeadMagnetsForUser]", e.message);
    return { polled: 0, error: e.message };
  }
}

module.exports.pollLeadMagnetsForUser = pollLeadMagnetsForUser;


const AI_ROLES = {
  sales: {
    name: "AI Sales Rep",
    actions: ["send_followup_email", "qualify_lead", "book_meeting", "send_proposal", "update_crm", "move_pipeline", "auto_reply_engagement", "send_lead_magnet", "dm_prospect"],
    triggers: ["new_lead", "lead_inactive_48h", "proposal_viewed", "meeting_scheduled", "deal_stalled", "social_comment", "social_dm", "social_like", "social_retweet"],
  },
  designer: {
    name: "AI Designer",
    actions: ["On-brand social graphics", "Ad creatives in your colors", "Logo and brand-refresh concepts", "Website restyle direction", "Print-ready flyers and business cards (PDF)", "Hand finished creatives to Marketing"],
    triggers: ["design", "logo", "flyer", "business card", "graphic", "creative", "brand", "rebrand", "poster", "pdf"]
  },
  support: {
    name: "AI Support Agent",
    actions: ["reply_ticket", "process_refund", "update_order", "send_shipping_info", "escalate_to_human", "close_ticket"],
    triggers: ["new_ticket", "customer_reply", "refund_request", "shipping_question", "complaint"],
  },
  social: {
    name: "AI Social Manager",
    actions: ["generate_post", "schedule_post", "reply_comment", "post_now", "analyze_performance", "suggest_content"],
    triggers: ["daily_schedule", "trending_topic", "low_engagement", "new_product_added", "weekly_report"],
  },
  bookkeeper: {
    name: "AI Bookkeeper",
    actions: ["categorize_transaction", "send_invoice_reminder", "flag_overdue", "generate_report", "reconcile", "forecast"],
    triggers: ["new_transaction", "invoice_overdue", "month_end", "weekly_summary", "unusual_expense"],
  },
  marketing: {
    name: "AI Marketing Manager",
    actions: ["adjust_ad_budget", "pause_underperforming", "create_campaign", "ab_test_copy", "send_email_blast", "generate_report", "reply_review"],
    triggers: ["low_roas", "budget_depleted", "high_performer", "weekly_review", "new_product_launch", "daily_performance_check", "new_review"],
  },
  community: {
    name: "Community Engagement Agent",
    actions: ["reply_reddit_thread", "reply_x_post", "log_engagement"],
    triggers: ["community_scan", "keyword_mention"],
  },
  csm: {
    name: "AI Customer Success Manager",
    actions: ["send_winback_email", "send_health_check", "flag_at_risk", "send_upsell", "log_interaction"],
    triggers: ["inactive_30d", "low_health_score", "purchase_anniversary", "renewal_due"],
  },
  receptionist: {
    name: "AI Receptionist",
    actions: ["answer_call", "book_appointment", "send_sms_followup", "take_message", "transfer_call"],
    triggers: ["inbound_call", "missed_call", "after_hours"],
  },
  coo: {
    name: "Take Control (AI COO)",
    actions: ["send_daily_briefing", "approve_actions", "flag_anomaly", "generate_report", "respond_whatsapp"],
    triggers: ["daily_8am", "weekly_monday", "anomaly_detected", "whatsapp_command"],
  },
  growth: {
    name: "TAKEOVA Growth Agent",
    actions: ["run_competitor_analysis", "identify_opportunity", "send_growth_report", "suggest_ab_test"],
    triggers: ["weekly_monday", "traffic_drop", "competitor_change"],
  },
  prospector: {
    name: "Prospector Agent",
    actions: ["find_businesses", "build_demo_site", "send_outreach", "follow_up_prospect"],
    triggers: ["daily_scan", "new_city_added", "outreach_replied"],
  },
  proposal: {
    name: "AI Proposal Agent",
    actions: ["generate_proposal", "send_proposal", "track_open", "send_followup", "close_deal"],
    triggers: ["new_prospect", "proposal_opened", "proposal_not_opened_48h", "meeting_booked"],
  },
  coldemail: {
    name: "AI Cold Email Agent",
    actions: ["research_prospect", "write_email", "send_email", "handle_reply", "book_meeting"],
    triggers: ["new_prospect_added", "email_replied", "email_bounced", "sequence_step_due"],
  },
  legal: {
    name: "AI Legal Employee",
    actions: ["chase_unsigned_contract", "draft_contract_for_booking", "flag_expiring_contract", "weekly_contract_digest", "send_contract_reminder"],
    triggers: ["contract_unsigned_7d", "new_booking_no_contract", "contract_expiring_30d", "weekly_legal_digest"],
    contractCapBoost: { pro: 100, enterprise: 250 }, // replaces base plan cap when hired
  },
  // ───────────────────────────────────────────────────────────────────
  // AI BROWSER AGENT — uses Claude Computer Use to operate a real browser
  //
  // Capabilities: navigates websites, fills forms, extracts data, takes
  // screenshots, downloads files, monitors prices. Acts on behalf of the
  // user across any web app — supplier portals, marketplaces, government
  // sites, social platforms, etc.
  //
  // PRICING:  $79/month add-on (matches sales/support tier)
  // PLAN GATING: starter plan denied — minimum plan is `growth`
  // USAGE CAPS: hard ceiling on browser tasks per month, varies by plan.
  //   Above the cap, hires don't run until the next billing cycle resets.
  // ───────────────────────────────────────────────────────────────────
  browser_agent: {
    name: "AI Browser Agent",
    actions: ["navigate_to", "extract_data", "fill_form", "click_button", "download_file", "take_screenshot_and_analyze", "monitor_page", "automate_workflow"],
    triggers: ["scheduled_run", "page_changed", "price_dropped", "competitor_updated", "new_inventory", "manual_trigger"],
    minPlan: "growth",   // Starter cannot access
    addonPrice: 79,      // USD/month
    monthlyTaskCaps: {
      growth:     50,    // 50 browser tasks/month
      pro:        200,
      enterprise: 500,
      agency:     1000,  // shared across agency clients
      // starter intentionally absent → fully blocked
    },
  },
};

// ════════════════════════════════════════════════════════════════════════
// AUTONOMY GATING — single source of truth for who runs and who waits
// ════════════════════════════════════════════════════════════════════════
// Three modes (newer values, plus legacy ones supported for back-compat):
//   manual   → never auto-execute. Cron triggers nothing.
//   suggest  → cron triggers Claude, saves proposed action as 'pending', no execute
//   auto     → cron triggers Claude and executes immediately
//
// Legacy column values 'semi' and 'full' are mapped to 'suggest' and 'auto'
// so existing customers see no behavior change unless they explicitly opt in.
function getAutonomyMode(emp) {
  // Map every value the codebase uses (canonical UI: full/semi/review; legacy: manual/suggest/auto)
  // to the three internal modes the gating logic checks against.
  //   full   → 'auto'    (Full auto — acts immediately)
  //   semi   → 'suggest' (Half auto — handles routine, asks on big decisions)
  //   review → 'manual'  (Review only — drafts everything, you approve before it fires)
  const a = ((emp && emp.autonomy) || 'semi').toLowerCase();
  if (a === 'manual' || a === 'review') return 'manual';
  if (a === 'suggest' || a === 'semi')  return 'suggest';
  return 'auto'; // 'full', 'auto'
}

// ── HIGH-RISK ACTION TAXONOMY (option 3) ───────────────────────────
const RISK_ACTIONS = {
  money:       new Set(["process_refund"]),
  contracts:   new Set(["send_proposal"]),
  mass_send:   new Set(["send_email_blast"]),
  public_post: new Set(["post_now","schedule_post","reply_review","reply_comment","reply_reddit_thread","reply_x_post","auto_reply_engagement"]),
};
const RISK_PATTERNS = [
  [/refund|make_payment|pay_bill|charge_customer/, "money"],
  [/send.*contract|contract.*send|sign_contract/,  "contracts"],
  [/blast|broadcast|bulk_|mass_/,                  "mass_send"],
  [/publish|post_now/,                             "public_post"],
];
function riskCategory(action) {
  if (!action) return null;
  const a = String(action).toLowerCase();
  for (const [cat, set] of Object.entries(RISK_ACTIONS)) if (set.has(a)) return cat;
  for (const [re2, cat] of RISK_PATTERNS) if (re2.test(a)) return cat;
  return null;
}
const RISK_UNLOCK_KEYS = ["money","contracts","mass_send","public_post"];
function sanitizeRiskUnlocks(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of RISK_UNLOCK_KEYS) {
    const v = obj[k];
    if (!v || typeof v !== "object" || !v.enabled) continue;
    const e = { enabled: true };
    if (k === "money"     && Number(v.maxAmount)     > 0) e.maxAmount     = Number(v.maxAmount);
    if (k === "mass_send" && Number(v.maxRecipients) > 0) e.maxRecipients = Number(v.maxRecipients);
    out[k] = e;
  }
  return out;
}
function shouldAutoExecuteAction(emp, confidence, action, details) {
  const mode = getAutonomyMode(emp);
  if (mode === 'manual') return false;
  const cat = riskCategory(action);
  if (cat) {
    if (mode !== 'auto') return false;               // Half-auto: high-risk ALWAYS queues
    let unlocks = {};
    try { unlocks = JSON.parse(emp.risk_unlocks || "{}"); } catch (e) {}
    const u = unlocks[cat];
    if (!u || !u.enabled) return false;              // Full-auto: locked by default
    if (cat === "money" && u.maxAmount) {
      const amt = Number(details && (details.amount ?? details.refundAmount ?? details.total));
      if (!(amt > 0) || amt > u.maxAmount) return false;
    }
    if (cat === "mass_send" && u.maxRecipients) {
      const n = Number(details && (details.recipients ?? details.recipientCount ?? details.count));
      if (!(n > 0) || n > u.maxRecipients) return false;
    }
    return true;
  }
  if (mode === 'auto') return true;
  return (typeof confidence === 'number' && confidence > 0.85);
}

// For direct cron-triggered actions that aren't AI decisions (Xero sync,
// sms_followup, sms_winback, overdue invoice). Returns true if cron should
// skip — user wants manual control.
function cronSkipForManual(db, userId, role) {
  try {
    const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? AND role=?").get(userId, role);
    return getAutonomyMode(emp || {}) === 'manual';
  } catch (e) { return false; }
}



// ─── EMPLOYEE CONFIGS ───
// Get all employee configs for a user
router.get("/config", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const configs = db.prepare("SELECT * FROM ai_employees WHERE user_id = ?").all(req.userId);
  res.json({ employees: configs.map(c => ({ ...c, rules: JSON.parse(c.rules || "[]"), schedule: JSON.parse(c.schedule || "{}") })) });
});

// ─── AI EMPLOYEE HIRING (monthly Stripe subscriptions) ──────────────────────
// Customers click "Hire" → we create a Stripe subscription → monthly auto-bill.
// Until hired, the employee is INACTIVE — frontend filters them out.
// Each employee has its own subscription so customers can cancel one without
// losing the others.
const AI_EMPLOYEE_CATALOG = {
  social:       { name: "AI Social Manager",      fee: 89 },
  marketing:    { name: "AI Marketing Manager",   fee: 89 },
  support:      { name: "AI Support Agent",       fee: 79 },
  bookkeeper:   { name: "AI Bookkeeper",          fee: 79 },
  legal:        { name: "AI Legal Employee",      fee: 89 },
  csm:          { name: "AI Customer Success",    fee: 49 },
  receptionist: { name: "AI Receptionist",        fee: 99 },
  coo:          { name: "Take Control (AI COO)",  fee: 89 },
  sales_rep:    { name: "AI Sales Rep",           fee: 79 },
  prospector:   { name: "Prospector Agent",       fee: 79 },
  cold_email:   { name: "AI Cold Email Agent",    fee: 69 },
  proposal:     { name: "AI Proposal Agent",      fee: 49 },
  browser_agent:{ name: "AI Web Hands",           fee: 79 },
  designer:     { name: "AI Designer",            fee: 79 },
  growth:       { name: "TAKEOVA Growth Agent",      fee: 89 },
  community:    { name: "Community Engagement",   fee: 79 },
};

// Role → employee_id mapping (autonomous-action roles vs catalog keys)
const _ROLE_TO_EMPLOYEE_ID = { sales: "sales_rep", sales_rep: "sales_rep", coldemail: "cold_email", cold_email: "cold_email", cold_email_agent: "cold_email", prospector_agent: "prospector", proposal_agent: "proposal", growth_agent: "growth" };
function _employeeIdForRole(role) { return role ? (_ROLE_TO_EMPLOYEE_ID[role] || role) : null; }
// Hire/paid gate. Returns true if admin / active (or cancelling) subscription / non-catalog role;
// false ONLY when it's a catalog agent the user has not hired. Fail-open on unexpected errors so a
// transient DB issue never silently kills the whole action pipeline.
function _isEmployeeHired(db, userId, role) {
  try {
    const empId = _employeeIdForRole(role);
    // Only gate the CORE agents that are hired via ai_employee_subscriptions AND fire through the
    // autonomous action pipeline. Specialized agents (prospector, cold_email, proposal, browser_agent,
    // growth, seo, designer) enforce their own gates inside their dedicated routes and may use a
    // different activation store, so we pass them through here to avoid false-blocking paid users.
    const _HIRE_GATED_ROLES = new Set(["social","marketing","support","bookkeeper","legal","csm","receptionist","coo","sales_rep","community"]);
    if (!empId || !_HIRE_GATED_ROLES.has(empId)) return true;
    try { const u = db.prepare("SELECT role FROM users WHERE id = ?").get(userId); if (u && u.role === "admin") return true; } catch {}
    ensureSubscriptionTable(db);
    const row = db.prepare("SELECT status FROM ai_employee_subscriptions WHERE user_id = ? AND employee_id = ?").get(userId, empId);
    if (!row) return false;
    return row.status === "active" || row.status === "cancelling"; // cancelling = paid through current period
  } catch (e) { console.error("[hire-gate] check failed (fail-open):", e.message); return true; }
}

function ensureSubscriptionTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_employee_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_name TEXT,
    monthly_fee REAL NOT NULL,
    stripe_subscription_id TEXT,
    stripe_price_id TEXT,
    status TEXT DEFAULT 'active',
    hired_at TEXT NOT NULL,
    cancelled_at TEXT,
    next_billing_date TEXT,
    UNIQUE(user_id, employee_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_employee_subs_user ON ai_employee_subscriptions(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_employee_subs_stripe ON ai_employee_subscriptions(stripe_subscription_id)`);
  // Also cache stripe price IDs so we don't create a new product/price on every hire
  db.exec(`CREATE TABLE IF NOT EXISTS ai_employee_stripe_prices (
    employee_id TEXT PRIMARY KEY,
    stripe_product_id TEXT,
    stripe_price_id TEXT,
    monthly_fee REAL,
    created_at TEXT
  )`);
}

/** Returns true if the user has an active subscription for this employee.
 *  Admin users always pass. 'cancelling' status is still active until period ends.
 *  Use this in AI employee runners/crons to block work after cancellation. */
function requireActiveSubscription(db, userId, employeeId) {
  try {
    // Admin bypass — admins dogfood all AI employees free
    const user = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    if (user?.role === "admin") return true;
    ensureSubscriptionTable(db);
    const sub = db.prepare(
      "SELECT status FROM ai_employee_subscriptions WHERE user_id = ? AND employee_id = ?"
    ).get(userId, employeeId);
    // 'active' = currently paid; 'cancelling' = paid until period end (still active)
    // 'cancelled' or 'past_due' = no work
    return !!sub && (sub.status === "active" || sub.status === "cancelling");
  } catch(e) {
    // If the check itself fails (e.g., DB issue, table missing), fail OPEN
    // — better to do unpaid work briefly than to break paid customer's flow.
    console.warn("[ai-employees] requireActiveSubscription check failed:", e.message);
    return true;
  }
}

/** Quick admin-role check. Used by all charge sites to skip Stripe + overage
 *  tracking when the user is the platform owner. Costs route to company API
 *  accounts (Anthropic, HeyGen, Runway, etc.), not to admin's card. */
function isAdminUser(db, userId) {
  try {
    const u = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    return u?.role === "admin";
  } catch(_) {
    return false;
  }
}

// Expose globally so other routes (features.js, ai-agent.js, hosting.js, etc.)
// can call without circular requires.
if (typeof global !== "undefined") {
  global.mineIsAdmin = isAdminUser;
}

// Expose globally so other routes (cold-email-agent, proposal-agent, etc.)
// can gate their cron work without circular requires.
if (typeof global !== "undefined") {
  global.mineRequireHired = requireActiveSubscription;
}

/** Get-or-create a Stripe Product + Price for an AI employee. Caches in DB.
 *  Resolution order:
 *  1. Env var override (STRIPE_PRICE_AI_<employee_id>) — admin-set via Stripe Products & Prices panel
 *  2. DB cache (ai_employee_stripe_prices) — auto-created on first hire
 *  3. Create new Stripe Product + Price + cache in DB                                       */
async function getOrCreateStripePrice(stripe, employeeId, employeeName, monthlyFee, db) {
  // 1. Env var override
  const envKey = "STRIPE_PRICE_AI_" + employeeId.toUpperCase();
  if (process.env[envKey] && /^price_/.test(process.env[envKey])) {
    return process.env[envKey];
  }
  // 2. DB cache
  const cached = db.prepare("SELECT stripe_price_id, monthly_fee FROM ai_employee_stripe_prices WHERE employee_id = ?").get(employeeId);
  if (cached && cached.stripe_price_id && cached.monthly_fee === monthlyFee) {
    return cached.stripe_price_id;
  }
  const product = await stripe.products.create({
    name: `MINE ${employeeName}`,
    metadata: { mine_employee_id: employeeId },
  });
  const price = await stripe.prices.create({
    product:  product.id,
    currency: "usd",
    unit_amount: Math.round(monthlyFee * 100),
    recurring: { interval: "month" },
    metadata: { mine_employee_id: employeeId },
  });
  db.prepare(`INSERT OR REPLACE INTO ai_employee_stripe_prices
    (employee_id, stripe_product_id, stripe_price_id, monthly_fee, created_at)
    VALUES (?,?,?,?, datetime('now'))`).run(employeeId, product.id, price.id, monthlyFee);
  return price.id;
}

// GET /api/ai-employees/hired — list current hires for this user
router.get("/hired", auth, (req, res) => {
  try {
    const db = getDb();
    ensureSubscriptionTable(db);
    const rows = db.prepare(
      "SELECT employee_id, monthly_fee, status, hired_at, next_billing_date FROM ai_employee_subscriptions WHERE user_id = ? AND status = 'active' ORDER BY hired_at DESC"
    ).all(req.userId);
    res.json({ hired: rows });
  } catch (e) {
    console.error("[ai-employees/hired]", e.message);
    res.status(500).json({ error: "Could not load hired employees" });
  }
});

// POST /api/ai-employees/hire { employee_id }
router.post("/hire", auth, async (req, res) => {
  try {
    const { employee_id } = req.body || {};
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });
    const meta = AI_EMPLOYEE_CATALOG[employee_id];
    if (!meta) return res.status(400).json({ error: "Unknown employee: " + employee_id });

    const db = getDb();
    ensureSubscriptionTable(db);

    // ── Admin no-op: admins are the company. No subscription concept needed.
    // Feature access is gated by role at requireActiveSubscription(), and
    // operational API costs are billed to the company's own provider accounts.
    const meUser = db.prepare("SELECT role, stripe_customer_id, email FROM users WHERE id = ?").get(req.userId);
    if (meUser?.role === "admin") {
      return res.json({ ok: true, employee_id, admin: true, note: "Admin role — no subscription required" });
    }

    // ── Plan gate (P0 #3): employees require Growth+; Growth = 1 active max ──
      const _hirePlan = (db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId)?.plan || "").toLowerCase();
      if (!["growth","pro","enterprise","agency","agency_client"].includes(_hirePlan)) {
        return res.status(403).json({ error: "AI employees are available on Growth, Pro and Enterprise plans. Upgrade to unlock.", code: "PLAN_REQUIRED", requiresUpgrade: true });
      }
      if (_hirePlan === "growth") {
        const _activeEmp = db.prepare("SELECT COUNT(*) AS c FROM ai_employee_subscriptions WHERE user_id = ? AND status = 'active'").get(req.userId).c;
        if (_activeEmp >= 1) {
          return res.status(403).json({ error: "Growth plan includes 1 AI employee. Upgrade to Pro for unlimited.", code: "PLAN_LIMIT", requiresUpgrade: true });
        }
      }

      // Already hired? Don't double-charge
    const existing = db.prepare(
      "SELECT id, status FROM ai_employee_subscriptions WHERE user_id = ? AND employee_id = ?"
    ).get(req.userId, employee_id);
    if (existing && existing.status === "active") {
      return res.status(409).json({ error: "Already hired", employee_id });
    }

    // Shopify-billed users: hiring recreates the Shopify subscription (base + all
    // agents + usage line); the merchant approves the new total once — no Stripe.
    try {
      const SH = require("./shopify-app");
      if (SH.isShopifyOrigin(db, req.userId)) {
        const subId = (existing && existing.id) ? existing.id : require("crypto").randomUUID();
        db.prepare(`INSERT OR REPLACE INTO ai_employee_subscriptions
          (id, user_id, employee_id, employee_name, monthly_fee, status, hired_at)
          VALUES (?,?,?,?,?, 'active', datetime('now'))`)
          .run(subId, req.userId, employee_id, meta.name, meta.fee);
        const conf = await SH.recreateSubscriptionForUser(db, req.userId);
        return res.json({ ok: true, employee_id, shopify: true, confirmationUrl: conf.confirmationUrl });
      }
    } catch (e) { console.error("[hire shopify]", e.message); }

    // Stripe required
    const stripeKey = (typeof getSetting === "function" && getSetting("STRIPE_SECRET_KEY")) || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return res.status(503).json({ error: "Billing not configured. Please contact support." });
    }
    const user = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(req.userId);
    if (!user?.stripe_customer_id) {
      return res.status(402).json({
        error: "No payment method on file. Add a card in billing settings before hiring AI employees.",
        needsPaymentMethod: true,
      });
    }

    const stripe = require("stripe")(stripeKey);
    const priceId = await getOrCreateStripePrice(stripe, employee_id, meta.name, meta.fee, db);

    // Create subscription — let Stripe attempt payment immediately
    const subscription = await stripe.subscriptions.create({
      customer: user.stripe_customer_id,
      items: [{ price: priceId }],
      collection_method: "charge_automatically",
      metadata: { mine_user_id: req.userId, mine_employee_id: employee_id, type: "ai_employee" },
      expand: ["latest_invoice.payment_intent"],
    }, {
      // Idempotency: same user re-clicking "Hire" within 5 min returns cached sub
      idempotencyKey: `hire_${req.userId}_${employee_id}_${Math.floor(Date.now() / 300000)}`,
    });

    const piStatus = subscription.latest_invoice?.payment_intent?.status;
    if (piStatus && piStatus !== "succeeded" && piStatus !== "requires_action") {
      // Hard fail — clean up the sub so we don't leave an orphan
      try { await stripe.subscriptions.cancel(subscription.id); } catch (_) {}
      return res.status(402).json({
        error: "Card declined when starting subscription. Update your card in billing.",
        paymentStatus: piStatus,
      });
    }

    // Persist
    const subId = "aies_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;
    db.prepare(`INSERT OR REPLACE INTO ai_employee_subscriptions
      (id, user_id, employee_id, employee_name, monthly_fee, stripe_subscription_id, stripe_price_id, status, hired_at, next_billing_date)
      VALUES (?,?,?,?,?,?,?,?, datetime('now'), ?)`).run(
      subId, req.userId, employee_id, meta.name, meta.fee, subscription.id, priceId, "active", periodEnd
    );

    res.json({
      ok: true,
      employee_id,
      employee_name: meta.name,
      monthly_fee: meta.fee,
      next_billing_date: periodEnd,
      stripe_subscription_id: subscription.id,
    });
  } catch (e) {
    console.error("[ai-employees/hire]", e.message);
    if (e.code === "card_declined" || e.code === "authentication_required") {
      return res.status(402).json({ error: "Card declined. Update your payment method.", code: e.code });
    }
    res.status(500).json({ error: "Hire failed: " + (e.message || "internal error") });
  }
});

// POST /api/ai-employees/cancel { employee_id }
router.post("/cancel", auth, async (req, res) => {
  try {
    const { employee_id } = req.body || {};
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });

    const db = getDb();
    ensureSubscriptionTable(db);

    // ── Admin no-op: no subscription concept for admins ──
    const meUser = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
    if (meUser?.role === "admin") {
      return res.json({ ok: true, employee_id, admin: true, note: "Admin role — no cancellation needed" });
    }

    const row = db.prepare(
      "SELECT id, stripe_subscription_id, status FROM ai_employee_subscriptions WHERE user_id = ? AND employee_id = ? AND status = 'active'"
    ).get(req.userId, employee_id);
    if (!row) return res.status(404).json({ error: "Not hired or already cancelled" });

    // Cancel at period end (customer keeps access until next billing cycle they already paid for)
    const stripeKey = (typeof getSetting === "function" && getSetting("STRIPE_SECRET_KEY")) || process.env.STRIPE_SECRET_KEY;
    if (stripeKey && row.stripe_subscription_id) {
      try {
        const stripe = require("stripe")(stripeKey);
        await stripe.subscriptions.update(row.stripe_subscription_id, {
          cancel_at_period_end: true,
        });
      } catch (e) {
        console.warn("[ai-employees/cancel] Stripe update failed:", e.message);
        // Continue — still mark locally so user UI updates
      }
    }
    db.prepare("UPDATE ai_employee_subscriptions SET status = 'cancelling', cancelled_at = datetime('now') WHERE id = ?").run(row.id);
    res.json({ ok: true, employee_id, status: "cancelling", note: "Access continues until end of billing period" });
  } catch (e) {
    console.error("[ai-employees/cancel]", e.message);
    res.status(500).json({ error: "Cancel failed: " + (e.message || "internal error") });
  }
});


// ── Role normalization — accept 'mine_control' as alias for 'coo' ──
// The frontend uses 'mine_control' as the employee ID for the Take Control / COO
// agent. This normalizes it so /config, /trigger, /actions etc. all converge
// on the canonical 'coo' role that the cron + WhatsApp webhook check for.
function normalizeRole(role) {
  if (role === 'mine_control') return 'coo';
  return role;
}

// Enable/configure an AI employee
router.post("/config", auth, (req, res) => {
  const { role, employeeId, enabled, rules, schedule, autonomy, riskUnlocks, tone, name, businessContext, emailSignature, refundPolicy, shippingInfo, faqAnswers, brandVoice, inspirationMedia } = req.body;
  const empRole = normalizeRole(role || employeeId);
  if (!AI_ROLES[empRole]) return res.status(400).json({ error: "Invalid role" });

  const db = getDb();
  ensureTables(db);
  const policies = [refundPolicy && "Refund: " + refundPolicy, shippingInfo && "Shipping: " + shippingInfo, faqAnswers && "FAQ: " + faqAnswers].filter(Boolean).join("\n");
  const existing = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = ?").get(req.userId, empRole);

  // ── Hoist baseline fields out of the rules blob into dedicated columns ──
  // The dashboard's saveEmpConfig sends ALL fields inside `rules`. Pull baseline
  // ones out so columns like brand_voice and business_context are populated
  // (the agent code reads from columns, not from rules).
  let effectiveBrandVoice = brandVoice;
  let effectiveBusinessContext = businessContext;
  if (rules && typeof rules === "object" && !Array.isArray(rules)) {
    if (!effectiveBrandVoice && rules.brandVoice) effectiveBrandVoice = rules.brandVoice;
    if (!effectiveBusinessContext && rules.businessContext) effectiveBusinessContext = rules.businessContext;
  }

  // Save inspiration media references
  const inspoJson = inspirationMedia ? JSON.stringify(inspirationMedia) : null;

  if (existing) {
    db.prepare(`UPDATE ai_employees SET enabled = ?, rules = ?, schedule = ?, autonomy = ?, risk_unlocks = COALESCE(?, risk_unlocks), tone = ?, custom_name = ?, business_context = ?, email_signature = ?, policies = ?, brand_voice = ?, inspiration_media = COALESCE(?, inspiration_media), updated_at = datetime('now') WHERE id = ?`)
      .run(enabled !== undefined ? (enabled ? 1 : 0) : 1, JSON.stringify(rules || []), JSON.stringify(schedule || {}), autonomy || "semi", riskUnlocks !== undefined ? JSON.stringify(sanitizeRiskUnlocks(riskUnlocks)) : null, tone || "professional", name || null, effectiveBusinessContext || null, emailSignature || null, policies || null, effectiveBrandVoice || null, inspoJson, existing.id);
    res.json({ success: true, updated: true });
  } else {
    const id = uuid();
    db.prepare(`INSERT INTO ai_employees (id, user_id, role, enabled, rules, schedule, autonomy, risk_unlocks, tone, custom_name, business_context, email_signature, policies, brand_voice, inspiration_media, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),datetime('now'))`)
      .run(id, req.userId, empRole, enabled ? 1 : 0, JSON.stringify(rules || []), JSON.stringify(schedule || {}), autonomy || "semi", JSON.stringify(sanitizeRiskUnlocks(riskUnlocks)), tone || "professional", name || null, effectiveBusinessContext || null, emailSignature || null, policies || null, effectiveBrandVoice || null, inspoJson);
    try { db.prepare("INSERT INTO ai_autonomy_audit (id, user_id, role, autonomy, risk_unlocks) VALUES (?, ?, ?, ?, ?)")
      .run("aud_" + Date.now() + "_" + Math.random().toString(36).slice(2,8), req.userId, role, autonomy || null, riskUnlocks !== undefined ? JSON.stringify(sanitizeRiskUnlocks(riskUnlocks)) : null); } catch (e) {}

    res.json({ success: true, id });
  }
});

// ─── ACTION LOG ───
// Every action an AI employee takes is logged
router.get("/actions", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { role, status, limit } = req.query;
  let sql = "SELECT * FROM ai_employee_actions WHERE user_id = ?";
  const params = [req.userId];
  if (role) { sql += " AND role = ?"; params.push(role); }
  if (status) { sql += " AND status = ?"; params.push(status); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(parseInt(limit) || 50);
  const actions = db.prepare(sql).all(...params);
  res.json({ actions: actions.map(a => ({ ...a, details: JSON.parse(a.details || "{}"), result: JSON.parse(a.result || "{}") })) });
});

// Approve/reject a pending action
router.post("/actions/:actionId/approve", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const action = db.prepare("SELECT * FROM ai_employee_actions WHERE id = ? AND user_id = ?").get(req.params.actionId, req.userId);
  if (!action) return res.status(404).json({ error: "Action not found" });
  if (action.status !== "pending") return res.status(400).json({ error: "Action already " + action.status });

  db.prepare("UPDATE ai_employee_actions SET status = 'approved', approved_at = datetime('now') WHERE id = ?").run(action.id);

  // Execute the action
  executeAction(db, action, req.userId).then(result => {
    db.prepare("UPDATE ai_employee_actions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(result), action.id);
  }).catch(err => {
    db.prepare("UPDATE ai_employee_actions SET status = 'failed', result = ? WHERE id = ?")
      .run(JSON.stringify({ error: err.message }), action.id);
  });

  res.json({ success: true, status: "approved" });
});

router.post("/actions/:actionId/reject", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("UPDATE ai_employee_actions SET status = 'rejected' WHERE id = ? AND user_id = ?").run(req.params.actionId, req.userId);
  res.json({ success: true });
});

// ─── TRIGGER ENGINE ───
// Called by other routes when events happen (new lead, new ticket, etc.)
// Or by cron job for scheduled triggers
// Accepts either a valid session token (normal user) OR x-internal-key (server-to-server)
router.post("/trigger", async (req, res) => {
  const internalKey = req.headers["x-internal-key"];
  const expectedKey = process.env.INTERNAL_API_KEY;
  let resolvedUserId = null;

  if (internalKey) {
    // Internal server-to-server call — verify key
    if (!expectedKey || !(((_k, _s) => _k.length > 0 && _s.length === _k.length && require("crypto").timingSafeEqual(Buffer.from(_s), Buffer.from(_k)))(expectedKey, internalKey || ""))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    resolvedUserId = req.headers["x-internal-user-id"] || req.body?.userId;
    if (!resolvedUserId) return res.status(400).json({ error: "x-internal-user-id header required for internal calls" });
  } else {
    // Normal user session auth
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token" });
    const db2 = getDb();
    const tokenHash = require("crypto").createHash("sha256").update(token).digest("hex");
    const session = db2.prepare(
      "SELECT user_id FROM sessions WHERE (token_hash = ? OR token = ?) AND expires_at > datetime('now')"
    ).get(tokenHash, token);
    if (!session) return res.status(401).json({ error: "Invalid or expired token" });
    resolvedUserId = session.user_id;
  }

  // Inject the resolved userId so the rest of the handler works unchanged
  req.userId = resolvedUserId;

  const { event, data } = req.body;
  const db = getDb();
  ensureTables(db);

  // Usage cap check for AI actions
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, req.userId, "aiActions");
    if (usage.blocked) {
      // Check user plan — agency always allowed, growth gets 1 employee max
      const _u = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
      const _plan = _u && _u.plan;
      const _allowedPlans = ["growth", "pro", "enterprise", "agency_client", "agency"];
      if (!_allowedPlans.includes(_plan)) {
        return res.status(403).json({
          error: "AI employees are available on Growth, Pro and Enterprise plans. Upgrade to unlock.",
          upgrade: true
        });
      }
      // Growth: max 1 active AI employee
      if (_plan === "growth") {
        const _activeCount = db.prepare("SELECT COUNT(*) as n FROM ai_employees WHERE user_id = ? AND enabled = 1").get(req.userId).n;
        if (_activeCount >= 1) {
          return res.status(403).json({
            error: "Growth plan includes 1 AI employee. Upgrade to Pro for unlimited AI employees.",
            upgrade: true,
            limit: 1
          });
        }
      }
    }
    const t = global.mineTrackUsage(db, req.userId, "aiActions");
    if (t.isOverage) res.setHeader("X-Overage-Charge", t.overageCost);
  }

  // Find which employees care about this event
  const employees = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND enabled = 1").all(req.userId);
  const results = [];

  for (const emp of employees) {
    const roleConfig = AI_ROLES[emp.role];
    if (!roleConfig) continue;

    // Check if this employee handles this trigger
    const matchesTrigger = roleConfig.triggers.some(t => event.includes(t) || t.includes(event));
    const rules = JSON.parse(emp.rules || "[]");
    const matchesRule = rules.some(r => r.trigger === event) || rules.length === 0;

    if (matchesTrigger || matchesRule) {
      // Enrich data with business context for relevance
      let enrichedData = { ...data };
      try {
        const site = db.prepare("SELECT id, name, custom_domain, deploy_url FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
        if (site) {
          enrichedData._business = { name: site.name, url: site.custom_domain || site.deploy_url || "" };
          enrichedData._products = db.prepare("SELECT name, price FROM products WHERE user_id = ? LIMIT 10").all(req.userId).map(p => ({ name: p.name, price: p.price }));
          enrichedData._courses = db.prepare("SELECT title as name, price FROM courses WHERE user_id = ? LIMIT 5").all(req.userId).map(c => ({ name: c.name, price: c.price }));
          try { const sm = JSON.parse(db.prepare("SELECT site_meta FROM sites WHERE id = ?").get(site.id)?.site_meta || "{}"); enrichedData._activeCoupons = (sm.coupons||[]).filter(c=>c.active).map(c=>({code:c.code,discount:c.discount})); } catch(e) {}
        }
      } catch (e) { /* enrichment failed, continue with basic data */ }

      // Use AI to decide what action to take
      const decision = await decideAction(emp, event, enrichedData, roleConfig);

      if (decision.action) {
        const actionId = uuid();
        const shouldAutoExecute = shouldAutoExecuteAction(emp, decision.confidence, decision.action, decision);

        db.prepare(`INSERT INTO ai_employee_actions (id, user_id, role, action, details, status, confidence, created_at)
          VALUES (?,?,?,?,?,?,?,datetime('now'))`)
          .run(actionId, req.userId, emp.role, decision.action, JSON.stringify({ event, data, reasoning: decision.reasoning, draft: decision.draft }),
            shouldAutoExecute ? "auto_executed" : "pending", decision.confidence);
          notifyApprovalNeeded(db, actionId).catch(function(){});

        if (shouldAutoExecute) {
          // Execute immediately
          try {
            const result = await executeAction(db, {
              id: actionId, role: emp.role, action: decision.action,
              details: JSON.stringify({ event, data, reasoning: decision.reasoning, draft: decision.draft })
            }, req.userId);
            db.prepare("UPDATE ai_employee_actions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?")
              .run(JSON.stringify(result), actionId);
            results.push({ role: emp.role, action: decision.action, status: "auto_executed", result });
          } catch (err) {
            db.prepare("UPDATE ai_employee_actions SET status = 'failed', result = ? WHERE id = ?")
              .run(JSON.stringify({ error: err.message }), actionId);
            results.push({ role: emp.role, action: decision.action, status: "failed", error: err.message });
          }
        } else {
          results.push({ role: emp.role, action: decision.action, status: "pending_approval", actionId });
        }
      }
    }
  }

  res.json({ triggered: results });
});

// ─── CRON / SCHEDULED TASKS ───
// Called periodically (every hour) to run scheduled employee tasks
router.post("/cron", async (req, res) => {
  // Protect cron endpoint — must be called from scheduler with CRON_SECRET
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["x-cron-key"] !== secret) {
    return res.status(403).json({ error: "Forbidden" });
  }
  // ── Fire any scheduled actions whose time has arrived ──────────────────────
  try {
    const db = getDb();
    const dueActions = db.prepare(
      "SELECT * FROM ai_employee_actions WHERE status='pending' AND execute_after IS NOT NULL AND datetime(execute_after) <= datetime('now') LIMIT 10"
    ).all();
    for (const action of dueActions) {
      try {
        db.prepare("UPDATE ai_employee_actions SET status='auto_executed', approved_at=datetime('now') WHERE id=?").run(action.id);
        const result = await executeAction(db, action, action.user_id);
        db.prepare("UPDATE ai_employee_actions SET status='completed', result=?, completed_at=datetime('now') WHERE id=?")
          .run(JSON.stringify(result), action.id);
      } catch(e) {
        db.prepare("UPDATE ai_employee_actions SET status='failed', result=? WHERE id=?")
          .run(JSON.stringify({ error: e.message }), action.id);
      }
    }
  } catch(_) { console.error("[/cron]", _.message || _); }

  // Accept either a valid session token OR an internal cron key
  const internalKey = req.headers["x-internal-key"];
  const db = getDb();
  ensureTables(db);

  let userId = null;

  if (internalKey) {
    // Internal cron call — key must match
    if (!(((_k, _s) => _k.length > 0 && _s.length === _k.length && require("crypto").timingSafeEqual(Buffer.from(_s), Buffer.from(_k)))(process.env.INTERNAL_API_KEY || "", internalKey || ""))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    // userId passed in body for internal calls
    userId = req.body?.user_id;
    if (!userId) return res.status(400).json({ error: "user_id required for internal cron" });
  } else {
    // Normal auth token path
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token" });
    const tokenHash = require("crypto").createHash("sha256").update(token).digest("hex");
    const session = db.prepare(
      "SELECT * FROM sessions WHERE (token_hash = ? OR token = ?) AND expires_at > datetime('now')"
    ).get(tokenHash, token);
    if (!session) return res.status(401).json({ error: "Invalid or expired token" });
    userId = session.user_id;
  }
  const employees = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND enabled = 1").all(userId);
  const results = [];

  for (const emp of employees) {
    const schedule = JSON.parse(emp.schedule || "{}");
    const now = new Date();
    const hour = now.getHours();

    // Daily tasks
    if (emp.role === "social" && schedule.postTime && parseInt(schedule.postTime) === hour) {
      const postResult = await triggerScheduled(db, userId, emp, "daily_schedule", { time: schedule.postTime });
      results.push(postResult);
      // Auto-generate image for today's post if NanoBanana is configured
      const config = JSON.parse(emp.rules || "{}");
      if (config.autoImages !== false) {
        const nanoBananaKey = getSetting("GEMINI_API_KEY") || process.env.GEMINI_API_KEY;
        if (nanoBananaKey) {
          try {
            // Get the most recent social post for this user (just created)
            const recentPost = db.prepare(
              "SELECT id, content FROM social_posts WHERE user_id = ? AND image_url IS NULL ORDER BY created_at DESC LIMIT 1"
            ).get(userId);
            if (recentPost) {
              const snippet = (recentPost.content || "").substring(0, 120);
              const fetch2 = (await import("node-fetch")).default;
              const Anthropic = require("@anthropic-ai/sdk");
              const claude = new Anthropic({ apiKey: getSetting("ANTHROPIC_API_KEY") });
              // Claude writes a precise image prompt from the post content
              const pr = await claude.messages.create({
                model: "claude-sonnet-4-6", max_tokens: 100,
                messages: [{ role: "user", content: `Write a social media image generation prompt (max 50 words) for this post caption: "${snippet}". Vibrant, professional, brand-appropriate, photorealistic.` }]
              });
              const imgPrompt = pr.content[0]?.text || snippet;
              const { generateImage } = require("../utils/image-gen");
              const imageUrl = await generateImage(imgPrompt, { size: "1080x1080", getSetting });
              if (imageUrl) {
                db.prepare("UPDATE social_posts SET image_url = ? WHERE id = ?").run(imageUrl, recentPost.id);
                results.push({ role: "social", action: "image_generated", status: "auto_executed", imageUrl });
              }
            }
          } catch(imgErr) { console.warn("[Social image gen]", imgErr.message); }
        }
      }
    }

    // ── Auto AI Video Generation (Social Manager) ──
    if (emp.role === "social" && hour === 10) {
      const config = JSON.parse(emp.rules || "{}");

      // HeyGen auto-video — fires based on configured frequency
      if (config.autoHeyGen) {
        const freq   = config.heygenFreq   || "3x_weekly";
        const dayOfWeek = now.getDay();
        const shouldFire =
          freq === "every_post" ||
          (freq === "3x_weekly"  && [1,3,5].includes(dayOfWeek)) ||
          (freq === "weekly"     && dayOfWeek === 1);

        if (shouldFire) {
          try {
            const heygenKey = getSetting("HEYGEN_API_KEY") || process.env.HEYGEN_API_KEY;
            if (!heygenKey) {
              results.push({ role:"social", action:"heygen_video_skipped", reason:"HEYGEN_API_KEY not configured" });
            } else {
              // Look up the configured default product
              const productId = config.heygenProductId;
              let productImageUrl = null;
              let productName = "";
              if (productId) {
                const product = db.prepare("SELECT name, images_json FROM products WHERE id=? AND user_id=?").get(productId, userId);
                if (product) {
                  productName = product.name;
                  try { const imgs = JSON.parse(product.images_json||"[]"); productImageUrl = imgs[0]||null; } catch(_){}
                }
              }

              const videoType  = config.heygenType || "ugc_product";
              const secs       = 30;
              const cost       = calcCost(secs);
              const charge     = calcCharge(secs);

              // Write script with Claude
              const { default: fetch2 } = await import("node-fetch");
              const Anthropic = require("@anthropic-ai/sdk");
              const claude = new Anthropic({ apiKey: getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY });
              const bizCtx = emp.business_context || emp.tone || "";

              const scriptResp = await claude.messages.create({
                model: "claude-sonnet-4-6", max_tokens: 200,
                messages:[{ role:"user", content:`Write a ${secs}-second ${videoType.replace("_"," ")} video script for a social media post${productName ? " about "+productName : ""}. Business: ${bizCtx}. Hook in first 3 seconds, clear CTA at end. Output ONLY the spoken script (~60 words).` }]
              });
              const script = scriptResp.content[0]?.text?.trim() || "";

              if (script) {
                // Generate the HeyGen video
                const endpoint = videoType === "ugc_product" && productImageUrl
                  ? "/api/ai-employees/heygen/ugc-product-v2"
                  : "/api/ai-employees/heygen/generate-av4";
                const port = process.env.PORT || 4000;
                const session = db.prepare("SELECT token FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(userId);
                const tkn = session?.token || "";

                // ── Charge BEFORE generating ─────────────────────────
                const chargeResult = await chargeUserForVideo(
                  db, userId, charge,
                  `MINE Auto Social Video (HeyGen ${secs}s) — ${productName || videoType}`
                );
                if (!chargeResult.ok) {
                  results.push({ role:"social", action:"heygen_video_skipped",
                    reason: "Payment failed: " + chargeResult.reason, charge });
                } else {
                  const gResp = await fetch2(`http://localhost:${port}${endpoint}`, {
                    method: "POST",
                    headers: { "Authorization": "Bearer "+tkn, "Content-Type": "application/json" },
                    body: JSON.stringify({
                      script, productId, productImageUrl,
                      duration: secs, aspectRatio: "9:16",
                      title: `Auto Social: ${productName || videoType}`,
                    })
                  });
                  const gData = await gResp.json();

                  // If HeyGen failed, refund
                  if (!gData.success && chargeResult.paymentIntentId) {
                    try {
                      const stripe = require("stripe")(getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY);
                      await stripe.refunds.create({ payment_intent: chargeResult.paymentIntentId });
                    } catch(_) {}
                  }

                  results.push({
                    role: "social", action: "heygen_auto_video",
                    status: gData.success ? "auto_executed" : "failed",
                    videoId: gData.videoId, cost, charge,
                    paymentIntentId: chargeResult.paymentIntentId,
                    reason: gData.reason, videoType, productName,
                  });
                }
              }
            }
          } catch(e) {
            results.push({ role:"social", action:"heygen_video_error", reason: e.message });
          }
        }
      }
    }
    if (emp.role === "bookkeeper" && now.getDay() === 1 && hour === 9) {
      // Weekly P&L summary every Monday 9am
      results.push(await triggerScheduled(db, userId, emp, "weekly_summary", {}));
      // Sync from Xero or QuickBooks if configured
      const xeroTok = getSetting("XERO_ACCESS_TOKEN") || process.env.XERO_ACCESS_TOKEN;
      const qboTok  = getSetting("QBO_ACCESS_TOKEN")  || process.env.QBO_ACCESS_TOKEN;
      if (!cronSkipForManual(db, userId, "bookkeeper")) {
        if (xeroTok) {
          try { await executeAction(db, { id: require("uuid").v4(), role: "bookkeeper", action: "xero_sync", details: "{}" }, userId); } catch(e) {}
        } else if (qboTok) {
          try { await executeAction(db, { id: require("uuid").v4(), role: "bookkeeper", action: "qbo_sync", details: "{}" }, userId); } catch(e) {}
        }
      }
      // Sync Xero or QuickBooks if configured
      const xeroToken = getSetting("XERO_ACCESS_TOKEN") || process.env.XERO_ACCESS_TOKEN;
      const qboToken  = getSetting("QBO_ACCESS_TOKEN")  || process.env.QBO_ACCESS_TOKEN;
      if (xeroToken) results.push(await triggerScheduled(db, userId, emp, "xero_sync", {}));
      else if (qboToken) results.push(await triggerScheduled(db, userId, emp, "quickbooks_sync", {}));
    }
    // Bookkeeper daily transaction sync at 7am
    if (emp.role === "bookkeeper" && hour === 7) {
      const xeroToken = getSetting("XERO_ACCESS_TOKEN") || process.env.XERO_ACCESS_TOKEN;
      const qboToken  = getSetting("QBO_ACCESS_TOKEN")  || process.env.QBO_ACCESS_TOKEN;
      if (xeroToken) {
        const lastSync = db.prepare("SELECT value FROM platform_settings WHERE key = 'xero_last_sync_' || ?").get(userId);
        const hoursSince = lastSync ? (Date.now() - new Date(lastSync.value).getTime()) / 3600000 : 999;
        if (hoursSince > 23) results.push(await triggerScheduled(db, userId, emp, "xero_sync", {}));
      } else if (qboToken) {
        results.push(await triggerScheduled(db, userId, emp, "quickbooks_sync", {}));
      }
    }
    if (emp.role === "marketing") {
      // ── Weekly review — every Friday 10am ─────────────────────────────────
      if (now.getDay() === 5 && hour === 10) {
        results.push(await triggerScheduled(db, userId, emp, "weekly_review", {}));
      }

      // ── Daily performance check — every day 8am ───────────────────────────
      if (hour === 8) {
        const campaigns = db.prepare(
          "SELECT id, name, platform, daily_budget, total_spent, status FROM ad_campaigns WHERE user_id = ? AND status = 'active'"
        ).all(userId);
        if (campaigns.length > 0) {
          const creatives = db.prepare(
            "SELECT campaign_id, headline, impressions, clicks, conversions, spend FROM ad_creatives WHERE user_id = ? AND status = 'active' AND impressions > 50"
          ).all(userId);
          // Calculate CTR per campaign
          const campaignStats = campaigns.map(c => {
            const cc = creatives.filter(cr => cr.campaign_id === c.id);
            const totalImpressions = cc.reduce((s, cr) => s + (cr.impressions || 0), 0);
            const totalClicks = cc.reduce((s, cr) => s + (cr.clicks || 0), 0);
            const totalConversions = cc.reduce((s, cr) => s + (cr.conversions || 0), 0);
            const totalSpend = cc.reduce((s, cr) => s + (cr.spend || 0), 0);
            const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
            return { ...c, ctr, totalImpressions, totalClicks, totalConversions, totalSpend, creativeCount: cc.length };
          }).filter(c => c.totalImpressions > 0);
          if (campaignStats.length > 0) {
            results.push(await triggerScheduled(db, userId, emp, "daily_performance_check", {
              campaigns: campaignStats,
              totalSpendToday: campaignStats.reduce((s, c) => s + (c.daily_budget || 0), 0),
              underperforming: campaignStats.filter(c => c.ctr < 0.005), // below 0.5% CTR
              topPerforming: campaignStats.filter(c => c.ctr > 0.02),   // above 2% CTR
            }));
          }
        }
      }

      // ── Low ROAS trigger — check every hour ──────────────────────────────
      const campaigns = db.prepare(
        "SELECT id, name, platform, daily_budget, total_spent FROM ad_campaigns WHERE user_id = ? AND status = 'active'"
      ).all(userId);
      for (const camp of campaigns) {
        const creatives = db.prepare(
          "SELECT impressions, clicks, conversions, spend FROM ad_creatives WHERE campaign_id = ? AND status = 'active' AND impressions > 100"
        ).all(camp.id);
        if (creatives.length === 0) continue;
        const totalImpressions = creatives.reduce((s, c) => s + (c.impressions || 0), 0);
        const totalClicks = creatives.reduce((s, c) => s + (c.clicks || 0), 0);
        const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
        // Trigger if CTR below 0.3% (very poor performance) and hasn't been triggered in last 24h
        if (ctr < 0.003 && totalImpressions > 200) {
          const recentTrigger = db.prepare(
            "SELECT id FROM ai_employee_actions WHERE user_id = ? AND role = 'marketing' AND action LIKE '%pause%' AND datetime(created_at) > datetime('now', '-24 hours')"
          ).get(userId);
          if (!recentTrigger) {
            results.push(await triggerScheduled(db, userId, emp, "low_roas", {
              campaign: camp, ctr: ctr.toFixed(4), impressions: totalImpressions,
              message: `Campaign "${camp.name}" has CTR of ${(ctr*100).toFixed(2)}% — below 0.3% threshold`
            }));
          }
        }
      }

      // ── Community Engagement Agent — scan every 4 hours ─────────────────────
      if (emp.role === "community") {
        const nowHour = now.getHours();
        // Fire at 6am, 10am, 2pm, 6pm
        if ([6, 10, 14, 18].includes(nowHour)) {
          const recentScan = db.prepare(
            "SELECT id FROM ai_employee_actions WHERE user_id = ? AND role = 'community' AND datetime(created_at) > datetime('now', '-3 hours')"
          ).get(userId);
          if (!recentScan) {
            results.push(await triggerScheduled(db, userId, emp, "community_scan", {}));
          }
        }
      }

      // ── New review trigger — check hourly ───────────────────────────────────
      const unansweredReviews = db.prepare(`
        SELECT id, reviewer_name, rating, text, platform, created_at
        FROM reviews
        WHERE user_id = ? AND (reply IS NULL OR reply = '')
        AND datetime(created_at) > datetime('now', '-24 hours')
        LIMIT 5
      `).all(userId);
      if (unansweredReviews.length > 0) {
        const recentReviewTrigger = db.prepare(
          "SELECT id FROM ai_employee_actions WHERE user_id = ? AND role = 'marketing' AND action = 'reply_review' AND datetime(created_at) > datetime('now', '-4 hours')"
        ).get(userId);
        if (!recentReviewTrigger) {
          results.push(await triggerScheduled(db, userId, emp, "new_review", {
            reviews: unansweredReviews,
            count: unansweredReviews.length
          }));
        }
      }

      // ── New product launch trigger — check hourly ─────────────────────────
      const newProducts = db.prepare(
        `SELECT p.id, p.name, p.price, s.name as site_name FROM products p
         JOIN sites s ON s.id = p.site_id
         WHERE s.user_id = ? AND datetime(p.created_at) > datetime('now', '-1 hour')
         LIMIT 5`
      ).all(userId);
      if (newProducts.length > 0) {
        const recentLaunch = db.prepare(
          "SELECT id FROM ai_employee_actions WHERE user_id = ? AND role = 'marketing' AND action LIKE '%launch%' AND datetime(created_at) > datetime('now', '-2 hours')"
        ).get(userId);
        if (!recentLaunch) {
          results.push(await triggerScheduled(db, userId, emp, "new_product_launch", {
            products: newProducts,
            message: `${newProducts.length} new product(s) added -- create launch campaign`
          }));
        }
      }
    }


    // ── AI LEGAL EMPLOYEE — proactive contract management ─────────────────────
    if (emp.role === "legal") {
      // 1. Chase unsigned contracts > 7 days old — once per day at 9am
      if (hour === 9) {
        try {
          const unsignedContracts = db.prepare(`
            SELECT c.id, c.title, c.client_name, c.client_email, c.amount, c.created_at
            FROM contracts c
            WHERE c.user_id = ?
              AND c.status = 'sent'
              AND c.client_email IS NOT NULL AND c.client_email != ''
              AND datetime(c.created_at, '+7 days') <= datetime('now')
              AND NOT EXISTS (
                SELECT 1 FROM ai_employee_actions a
                WHERE a.user_id = ? AND a.role = 'legal'
                  AND a.action = 'chase_unsigned_contract'
                  AND json_extract(a.details, '$.contractId') = c.id
                  AND datetime(a.created_at) > datetime('now', '-7 days')
              )
            LIMIT 10
          `).all(userId, userId);

          for (const contract of unsignedContracts) {
            results.push(await triggerScheduled(db, userId, emp, "contract_unsigned_7d", {
              contractId: contract.id, title: contract.title,
              client_name: contract.client_name, client_email: contract.client_email,
              amount: contract.amount, sent_days_ago: Math.floor((Date.now() - new Date(contract.created_at)) / 86400000),
            }));
          }
        } catch(e) { console.warn("[Legal cron unsigned]", e.message); }

        // 2. Flag contracts expiring within 30 days (retainers, annual)
        try {
          const expiring = db.prepare(`
            SELECT id, title, client_name, client_email, end_date
            FROM contracts
            WHERE user_id = ? AND status = 'signed'
              AND end_date IS NOT NULL
              AND date(end_date) BETWEEN date('now') AND date('now', '+30 days')
            LIMIT 5
          `).all(userId);
          if (expiring.length > 0) {
            results.push(await triggerScheduled(db, userId, emp, "contract_expiring_30d", { contracts: expiring }));
          }
        } catch(e) { console.warn("[Legal cron expiring]", e.message); }
      }

      // 3. New booking without a contract — check every hour
      try {
        const bookingsWithoutContracts = db.prepare(`
          SELECT b.id, b.customer_name, b.customer_email, b.service_name, b.total_price, b.start_time
          FROM bookings b
          WHERE b.user_id = ?
            AND b.status IN ('confirmed', 'pending')
            AND b.customer_email IS NOT NULL
            AND b.total_price > 100
            AND datetime(b.created_at) > datetime('now', '-2 hours')
            AND NOT EXISTS (
              SELECT 1 FROM contracts c
              WHERE c.user_id = ? AND c.client_email = b.customer_email
                AND datetime(c.created_at) > datetime('now', '-7 days')
            )
          LIMIT 3
        `).all(userId, userId);

        for (const booking of bookingsWithoutContracts) {
          const recentAction = db.prepare(`
            SELECT id FROM ai_employee_actions
            WHERE user_id = ? AND role = 'legal' AND action = 'draft_contract_for_booking'
              AND json_extract(details, '$.bookingId') = ?
              AND datetime(created_at) > datetime('now', '-24 hours')
          `).get(userId, booking.id);

          if (!recentAction) {
            results.push(await triggerScheduled(db, userId, emp, "new_booking_no_contract", {
              bookingId: booking.id, client_name: booking.customer_name,
              client_email: booking.customer_email, service: booking.service_name,
              amount: booking.total_price, date: booking.start_time,
            }));
          }
        }
      } catch(e) { console.warn("[Legal cron booking]", e.message); }

      // 4. Weekly digest — Monday 9am
      if (now.getDay() === 1 && hour === 9) {
        try {
          const stats = {
            total: db.prepare("SELECT COUNT(*) as n FROM contracts WHERE user_id = ?").get(userId)?.n || 0,
            signed_this_month: db.prepare("SELECT COUNT(*) as n FROM contracts WHERE user_id = ? AND status='signed' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get(userId)?.n || 0,
            unsigned: db.prepare("SELECT COUNT(*) as n FROM contracts WHERE user_id = ? AND status='sent'").get(userId)?.n || 0,
            value_secured: db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM contracts WHERE user_id = ? AND status='signed' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get(userId)?.v || 0,
          };
          results.push(await triggerScheduled(db, userId, emp, "weekly_legal_digest", { stats }));
        } catch(e) { console.warn("[Legal cron digest]", e.message); }
      }
    }

    // Check for stale leads (sales)
    if (emp.role === "sales") {
      const staleLeads = db.prepare(`
        SELECT * FROM contacts WHERE user_id = ? AND status = 'lead'
        AND datetime(last_activity) < datetime('now', '-2 days')
      `).all(userId);
      for (const lead of staleLeads) {
        results.push(await triggerScheduled(db, userId, emp, "lead_inactive_48h", { lead }));
      }

      // Lead magnet polling is now decoupled — runs in its own server.js cron for ALL users
      // (regardless of Sales Rep subscription). Sales Rep cron only handles stale-lead
      // follow-up sequences, which genuinely belong to the Sales Rep employee.
      // SMS follow-ups for leads with phone numbers (day 1, 3, 7)
      const salesCfg = JSON.parse(emp.rules || "{}");
      if (salesCfg.smsFollowups !== false) {
        try {
          const smsLeads = db.prepare(`
            SELECT c.*, CAST(julianday('now') - julianday(c.created_at) AS INTEGER) as days_since
            FROM contacts c
            WHERE c.user_id = ? AND c.phone IS NOT NULL AND c.phone != ''
            AND c.status = 'lead'
            AND CAST(julianday('now') - julianday(c.created_at) AS INTEGER) IN (1, 3, 7)
            LIMIT 20
          `).all(userId);
          for (const lead of smsLeads) {
            const fday = lead.days_since;
            if (!cronSkipForManual(db, userId, "sales")) {
              await executeAction(db, { id: require("uuid").v4(), role: "sales", action: "sms_followup",
                details: JSON.stringify({ data: { phone: lead.phone, name: lead.name, followupDay: fday } }) }, userId);
            }
          }
        } catch(e) {}
      }
    }

    // Check overdue invoices (bookkeeper)
    if (emp.role === "bookkeeper") {
      const overdue = db.prepare(`
        SELECT * FROM invoices WHERE user_id = ? AND status = 'sent'
        AND datetime(due_date) < datetime('now')
      `).all(userId);
      for (const inv of overdue) {
        results.push(await triggerScheduled(db, userId, emp, "invoice_overdue", { invoice: inv }));
      }
    }

    // Check support tickets needing response
    if (emp.role === "support") {
      const openTickets = db.prepare(`
        SELECT * FROM support_tickets WHERE user_id = ? AND status = 'open'
        AND datetime(created_at) < datetime('now', '-1 hour')
        AND ai_replied = 0
      `).all(userId);
      for (const ticket of openTickets) {
        results.push(await triggerScheduled(db, userId, emp, "new_ticket", { ticket }));
      }
    }
  }


    // ── AI Customer Success Manager (CSM) ──────────────────────────────────
    if (emp.role === "csm") {
      // Daily at 9am: check for at-risk customers (no purchase in 30+ days, low engagement)
      if (hour === 9) {
        try {
          const atRisk = db.prepare(`
            SELECT c.* FROM contacts c
            WHERE c.user_id = ? AND c.status NOT IN ('churned','unsubscribed')
            AND (
              datetime(c.last_activity) < datetime('now', '-30 days')
              OR c.score < 30
            )
            LIMIT 20
          `).all(userId);
          for (const contact of atRisk) {
            results.push(await triggerScheduled(db, userId, emp, "at_risk_outreach", {
              contactId: contact.id, name: contact.name, email: contact.email,
              daysSinceActivity: Math.floor((Date.now() - new Date(contact.last_activity).getTime()) / 86400000)
            }));
          }
          // Check for upsell opportunities: active customers with high score
          const upsellCandidates = db.prepare(`
            SELECT * FROM contacts WHERE user_id = ? AND score > 70
            AND status = 'customer'
            AND datetime(last_activity) > datetime('now', '-14 days')
            LIMIT 10
          `).all(userId);
          for (const contact of upsellCandidates) {
            results.push(await triggerScheduled(db, userId, emp, "upsell_check", {
              contactId: contact.id, name: contact.name
            }));
          }
        } catch(e) { console.error("[CSM cron]", e.message); }
      }
      // Weekly retention report — Monday 8am
      if (now.getDay() === 1 && hour === 8) {
        results.push(await triggerScheduled(db, userId, emp, "weekly_retention_report", {}));
      }
      // SMS win-backs for at-risk customers with phone
      const csmCfg2 = JSON.parse(emp.rules || "{}");
      if (csmCfg2.smsWinback) {
        try {
          const atRiskPhone = db.prepare(`
            SELECT c.* FROM contacts c WHERE c.user_id = ? AND c.phone IS NOT NULL AND c.phone != ''
            AND c.status = 'at_risk'
            AND (c.last_contacted IS NULL OR julianday('now') - julianday(c.last_contacted) > 14)
            LIMIT 10
          `).all(userId);
          for (const ct of atRiskPhone) {
            if (!cronSkipForManual(db, userId, "csm")) {
              await executeAction(db, { id: require("uuid").v4(), role: "csm", action: "sms_winback",
                details: JSON.stringify({ data: { phone: ct.phone, name: ct.name, lastSeen: ct.last_seen, offer: csmCfg2.winbackOffer || null } }) }, userId);
            }
          }
        } catch(e) {}
      }
    }

    // ── AI Receptionist / Voice Agent ─────────────────────────────────────
    // Voice handles inbound calls via webhook (/api/ai-employees/voice/inbound)
    // Cron handles: missed call follow-ups, call summary reports
    if (emp.role === "voice") {
      // Every hour: send SMS follow-up to missed calls from last hour
      try {
        const missedCalls = db.prepare(`
          SELECT * FROM voice_sessions
          WHERE user_id = ? AND status = 'missed'
          AND datetime(created_at) > datetime('now', '-1 hour')
          AND followup_sent IS NULL
        `).all(userId);
        for (const call of missedCalls) {
          if (call.caller_phone) {
            results.push(await triggerScheduled(db, userId, emp, "missed_call_followup", {
              phone: call.caller_phone, callerName: call.caller_name || "there"
            }));
            try { db.prepare("UPDATE voice_sessions SET followup_sent = datetime('now') WHERE id = ?").run(call.id); } catch(e) { console.error("[/cron]", e.message || e); }
          }
        }
      } catch(e) { console.error("[Voice cron]", e.message); }
      // Daily at 8am: send call summary report
      if (hour === 8) {
        results.push(await triggerScheduled(db, userId, emp, "daily_call_summary", {}));
      }
    }

    // ── Prospector Agent ───────────────────────────────────────────────────
    // Prospector runs on-demand via /api/prospector — not a continuous cron role
    // Cron only handles: daily follow-up sends (handled in prospector route itself)

    // ── AI Cold Email Agent ────────────────────────────────────────────────
    // Cold Email Agent runs on-demand — cron handles follow-ups via /api/cold-email/followups
    // (already scheduled at 9am in server.js)

    // ── Take Control (AI COO) ──────────────────────────────────────────────
    // Handled by intelligence.js (runNightlyIntelligence, deliverMorningBriefings)
    // No additional cron needed here

    // ── TAKEOVA Growth Agent ──────────────────────────────────────────────────
    // Has its own /run-now endpoint and is triggered by the server.js intelligence cron
    // No additional cron needed here

    // ── AI Proposal Agent ──────────────────────────────────────────────────
    // User-triggered via /api/proposal-agent/generate — not a cron agent

  // ── Competitor scan (Growth Agent) — every Monday 7am ─────────────────────
  if (now.getDay() === 1 && hour === 7) {
    const growthEmp = employees.find(e => e.role === "growth" && e.enabled);
    if (growthEmp) {
      try {
        const growthConfig = JSON.parse(growthEmp.rules || "{}");
        let competitors = growthConfig.competitorUrls || growthConfig.competitor_urls || growthConfig.competitors || [];
        // Normalize to an array — settings may save as comma-separated string
        if (typeof competitors === 'string') competitors = competitors.split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
        if (!Array.isArray(competitors)) competitors = [];
        if (competitors.length) {
          const fetch4 = (await import("node-fetch")).default;
          const sessToken = db.prepare("SELECT token FROM sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1").get(userId)?.token || "";
          fetch4(`http://localhost:${process.env.PORT || 4000}/api/ai-employees/growth/competitor-scan`, {
            method: "POST",
            headers: { Authorization: `Bearer ${sessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ competitors })
          }).catch(() => {});
        }
      } catch(_) {}
    }
  }

  // ── Sales SMS follow-ups — fire at 10am, 2pm ─────────────────────────────
  if ([10, 14].includes(hour)) {
    const salesEmp = employees.find(e => e.role === "sales" && e.enabled);
    if (salesEmp) {
      const salesConfig = JSON.parse(salesEmp.rules || "{}");
      if (salesConfig.smsFollowups) {
        try {
          // Find leads due for a follow-up today that have a phone number
          const dueLeads = db.prepare(`
            SELECT l.id, l.name, l.phone, l.email, l.followup_count
            FROM leads l
            WHERE l.user_id = ? AND l.phone IS NOT NULL AND l.phone != ''
            AND l.status NOT IN ('won','lost','unresponsive')
            AND (l.next_followup_at IS NULL OR datetime(l.next_followup_at) <= datetime('now'))
            AND (l.followup_count IS NULL OR l.followup_count < 3)
            LIMIT 10
          `).all(userId);
          const twilioSid3 = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
          const twilioTok3 = getSetting("TWILIO_AUTH_TOKEN") || process.env.TWILIO_AUTH_TOKEN;
          const twilioFrom3 = getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER;
          if (twilioSid3 && twilioTok3 && twilioFrom3) {
            const userRow4 = db.prepare("SELECT business_name, name FROM users WHERE id = ?").get(userId);
            const bizName4 = userRow4?.business_name || userRow4?.name || "us";
            const twilio3 = require("twilio")(twilioSid3, twilioTok3);
            for (const lead of dueLeads) {
              const seq = Math.min((lead.followup_count || 0) + 1, 3);
              const msgs = [
                `Hi ${lead.name?.split(" ")[0] || "there"}! Thanks for your interest in ${bizName4}. Happy to answer any questions — just reply! 😊`,
                `Hey ${lead.name?.split(" ")[0] || "there"}, following up from ${bizName4}. Did you get a chance to look at what we sent? Let me know if I can help!`,
                `Hi ${lead.name?.split(" ")[0] || "there"}, last follow-up from ${bizName4}. We'd love to work with you — reply YES if you're still keen!`
              ];
              try {
                await twilio3.messages.create({ body: msgs[seq-1], from: twilioFrom3, to: lead.phone });
                db.prepare("UPDATE leads SET followup_count = ?, next_followup_at = datetime('now', '+3 days') WHERE id = ?").run(seq, lead.id);
              } catch(_) { console.error("[/cron]", _.message || _); }
            }
          }
        } catch(_) { console.error("[/cron]", _.message || _); }
      }
    }
  }


    // ── RECEPTIONIST — morning missed call check ─────────────────────────────
    if (emp.role === "receptionist") {
      // Every morning at 8am: check for missed calls and send SMS follow-ups
      if (hour === 8) {
        try {
          const missedCalls = db.prepare(
            "SELECT * FROM voice_sessions WHERE user_id=? AND status='missed' AND datetime(created_at) > datetime('now','-24 hours') AND followup_sent IS NULL LIMIT 20"
          ).all(userId);
          if (missedCalls.length > 0) {
            results.push(await triggerScheduled(db, userId, emp, "missed_call", {
              calls: missedCalls,
              count: missedCalls.length,
              message: `${missedCalls.length} missed call(s) need follow-up`
            }));
          }
        } catch(e) { console.warn("[Receptionist cron]", e.message); }
      }
      // After-hours check — flag calls outside business hours
      const config = JSON.parse(emp.rules || "{}");
      const startHour = parseInt(config.startHour || 9);
      const endHour   = parseInt(config.endHour   || 17);
      if (hour < startHour || hour >= endHour) {
        // Log that we're in after-hours mode — receptionist handles next call via Twilio
        results.push({ role: "receptionist", action: "after_hours_active", status: "auto_executed", hour });
      }
    }

    // ── COO — daily briefing + weekly summary ────────────────────────────────
    if (emp.role === "coo") {
      const config = JSON.parse(emp.rules || "{}");
      const briefingHour = parseInt(config.briefingHour || 8);

      // Daily briefing at configured time
      if (hour === briefingHour) {
        try {
          // Pull key business metrics
          const todayRevenue  = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM orders WHERE user_id=? AND date(created_at)=date('now')").get(userId)?.t || 0;
          const pendingActions = db.prepare("SELECT count(*) as n FROM ai_employee_actions WHERE user_id=? AND status='pending'").get(userId)?.n || 0;
          const newLeads      = db.prepare("SELECT count(*) as n FROM leads WHERE user_id=? AND date(created_at)=date('now')").get(userId)?.n || 0;
          const openTickets   = db.prepare("SELECT count(*) as n FROM support_tickets WHERE user_id=? AND status='open'").get(userId)?.n || 0;

          results.push(await triggerScheduled(db, userId, emp, "daily_8am", {
            todayRevenue, pendingActions, newLeads, openTickets,
            date: new Date().toLocaleDateString("en-AU", {weekday:"long",day:"numeric",month:"long"})
          }));
        } catch(e) { console.warn("[COO cron daily]", e.message); }
      }

      // Weekly summary every Monday at 9am
      if (now.getDay() === 1 && hour === 9) {
        try {
          const weekRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM orders WHERE user_id=? AND datetime(created_at) > datetime('now','-7 days')").get(userId)?.t || 0;
          const weekLeads   = db.prepare("SELECT count(*) as n FROM leads WHERE user_id=? AND datetime(created_at) > datetime('now','-7 days')").get(userId)?.n || 0;
          results.push(await triggerScheduled(db, userId, emp, "weekly_monday", {
            weekRevenue, weekLeads,
            week: "Last 7 days"
          }));
        } catch(e) { console.warn("[COO cron weekly]", e.message); }
      }
    }

    // ── GROWTH AGENT — weekly report + daily opportunity scan ────────────────
    if (emp.role === "growth") {
      const config = JSON.parse(emp.rules || "{}");

      // Weekly growth report every Monday at 9am
      if (now.getDay() === 1 && hour === 9) {
        try {
          results.push(await triggerScheduled(db, userId, emp, "weekly_monday", {
            period: "Last 7 days",
            competitors: (config.competitorUrls || config.competitor_urls || (config.competitors||[]).join(',') || '').toString().split(",").map(s=>s.trim()).filter(Boolean)
          }));
        } catch(e) { console.warn("[Growth cron weekly]", e.message); }
      }

      // Daily traffic/conversion check at 9am
      if (hour === 9 && now.getDay() !== 1) {
        try {
          const sites = db.prepare("SELECT id, name, deploy_url FROM sites WHERE user_id=? AND status='live' LIMIT 5").all(userId);
          if (sites.length > 0) {
            results.push(await triggerScheduled(db, userId, emp, "traffic_drop", {
              sites: sites.map(s => s.name),
              message: "Daily growth opportunity scan"
            }));
          }
        } catch(e) { console.warn("[Growth cron daily]", e.message); }
      }
    }

    // ── PROSPECTOR — daily outreach scan ────────────────────────────────────
    if (emp.role === "prospector") {
      const config = JSON.parse(emp.rules || "{}");
      const dailyCap = parseInt(config.dailyCap || 10);
      const targetCities = config.targetCities ? config.targetCities.split(",").map(s=>s.trim()).filter(Boolean) : [];
      const niche = config.niche || "";

      // Fire daily at 10am
      if (hour === 10 && targetCities.length > 0) {
        try {
          // Check how many we've reached out to today
          const todayCount = db.prepare(
            "SELECT count(*) as n FROM ai_employee_actions WHERE user_id=? AND role='prospector' AND action='send_outreach' AND date(created_at)=date('now')"
          ).get(userId)?.n || 0;

          if (todayCount < dailyCap) {
            const city = targetCities[now.getDate() % targetCities.length]; // rotate through cities
            results.push(await triggerScheduled(db, userId, emp, "daily_scan", {
              city, niche, dailyCap, todayCount,
              remaining: dailyCap - todayCount,
              message: `Scanning ${city} for ${niche || "businesses"} — ${todayCount}/${dailyCap} reached out today`
            }));
          }
        } catch(e) { console.warn("[Prospector cron]", e.message); }
      }
    }

    // ── PROPOSAL AGENT — open tracking + follow-ups ──────────────────────────
    if (emp.role === "proposal") {
      try {
        // Check for proposals opened but not replied to in 24h → follow up
        const openedNotReplied = db.prepare(`
          SELECT p.id, p.prospect_name, p.prospect_email, p.opened_at, p.title
          FROM proposals p
          WHERE p.user_id=? AND p.status='opened'
          AND p.opened_at IS NOT NULL
          AND (p.followup_sent IS NULL OR p.followup_sent = 0)
          AND datetime(p.opened_at) < datetime('now','-24 hours')
          LIMIT 10
        `).all(userId);

        if (openedNotReplied.length > 0) {
          const noRecent = db.prepare(
            "SELECT id FROM ai_employee_actions WHERE user_id=? AND role='proposal' AND action='send_followup' AND datetime(created_at) > datetime('now','-2 hours')"
          ).get(userId);
          if (!noRecent) {
            results.push(await triggerScheduled(db, userId, emp, "proposal_opened", {
              proposals: openedNotReplied,
              count: openedNotReplied.length,
              message: `${openedNotReplied.length} proposal(s) opened but not replied — time to follow up`
            }));
          }
        }

        // Check for proposals not opened after 48h → send nudge
        const notOpened48h = db.prepare(`
          SELECT p.id, p.prospect_name, p.prospect_email, p.title, p.sent_at
          FROM proposals p
          WHERE p.user_id=? AND p.status='sent'
          AND p.opened_at IS NULL
          AND datetime(p.sent_at) < datetime('now','-48 hours')
          AND (p.followup_sent IS NULL OR p.followup_sent = 0)
          LIMIT 10
        `).all(userId);

        if (notOpened48h.length > 0) {
          results.push(await triggerScheduled(db, userId, emp, "proposal_not_opened_48h", {
            proposals: notOpened48h,
            count: notOpened48h.length,
            message: `${notOpened48h.length} proposal(s) not opened after 48h`
          }));
        }
      } catch(e) { console.warn("[Proposal cron]", e.message); }
    }

    // ── COLD EMAIL AGENT — daily sequence processing ─────────────────────────
    if (emp.role === "coldemail") {
      if (hour === 9) {
        try {
          // Find sequence steps due today
          const dueSteps = db.prepare(`
            SELECT cs.id, cs.prospect_id, cs.step_number, cs.scheduled_at,
                   cp.name as prospect_name, cp.email as prospect_email,
                   cp.company, cp.role as prospect_role
            FROM cold_email_sequence_steps cs
            JOIN cold_email_prospects cp ON cp.id = cs.prospect_id
            WHERE cp.user_id=? AND cs.status='pending'
            AND datetime(cs.scheduled_at) <= datetime('now')
            LIMIT 50
          `).all(userId);

          if (dueSteps.length > 0) {
            results.push(await triggerScheduled(db, userId, emp, "sequence_step_due", {
              steps: dueSteps,
              count: dueSteps.length,
              message: `${dueSteps.length} cold email step(s) due today`
            }));
          }

          // Check for replies that need handling
          const unhandledReplies = db.prepare(`
            SELECT * FROM cold_email_replies
            WHERE user_id=? AND handled=0
            LIMIT 20
          `).all(userId);

          if (unhandledReplies.length > 0) {
            results.push(await triggerScheduled(db, userId, emp, "email_replied", {
              replies: unhandledReplies,
              count: unhandledReplies.length
            }));
          }
        } catch(e) { console.warn("[Cold Email cron]", e.message); }
      }
    }

  res.json({ cronResults: results });
});

// ─── NICHE TREND RESEARCH (on-demand) ───
// ═══ PERPLEXITY RESEARCH HELPER ═══
// Real-time web search with citations — used by both manual research and AI auto-tasks
async function perplexityResearch(query, getSetting) {
  const perplexityKey = getSetting("PERPLEXITY_API_KEY");
  if (!perplexityKey) return null;

  try {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + perplexityKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "You are a social media and advertising research analyst. Return structured, actionable insights with specific data points. Always include sources." },
          { role: "user", content: query }
        ],
        temperature: 0.2,
        return_citations: true,
        search_recency_filter: "week"
      })
    });
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content || "";
    const citations = d.citations || [];
    return { text, citations, source: "perplexity" };
  } catch (e) {
    return null;
  }
}

// Claude web search fallback
async function claudeResearch(query, getSetting) {
  const anthropicKey = getSetting("ANTHROPIC_API_KEY");
  if (!anthropicKey) return null;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: query }]
      })
    });
    const d = await r.json();
    const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    return { text, citations: [], source: "claude_web_search" };
  } catch (e) {
    return null;
  }
}

// Combined research — tries Perplexity first, falls back to Claude
async function doResearch(query, getSetting) {
  const ppx = await perplexityResearch(query, getSetting);
  if (ppx?.text) return ppx;
  const claude = await claudeResearch(query, getSetting);
  if (claude?.text) return claude;
  return { text: "", citations: [], source: "none" };
}

// Users can trigger this from dashboard to see what's trending in their industry
router.post("/research", auth, async (req, res) => {
  const { niche, platforms } = req.body;
  const anthropicKey = getSetting("ANTHROPIC_API_KEY");
  if (!anthropicKey && !getSetting("PERPLEXITY_API_KEY")) return res.status(400).json({ error: "Add a Perplexity or Anthropic API key in admin settings" });

  const db = getDb();
  ensureTables(db);

  // Research fires 2 Sonnet calls — enforce aiActions cap (counts as 2 actions)
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, req.userId, "aiActions");
    if (usage.blocked) return res.status(403).json({ error: "You've reached your monthly AI actions limit. Upgrade your plan for a higher allowance.", upgrade: true });
    global.mineTrackUsage(db, req.userId, "aiActions", 2);
  }

  // Auto-detect niche from user's FULL business context
  let searchNiche = niche || "";
  let businessName = "";
  let productNames = "";
  let courseNames = "";
  let activeCoupons = "";

  if (!searchNiche) {
    const site = db.prepare("SELECT id, name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    if (site) {
      businessName = site.name;
      productNames = db.prepare("SELECT name, price FROM products WHERE user_id = ? LIMIT 8").all(req.userId).map(p => `${p.name}${p.price ? " ($" + p.price + ")" : ""}`).join(", ");
      courseNames = db.prepare("SELECT title FROM courses WHERE user_id = ? LIMIT 3").all(req.userId).map(c => c.title).join(", ");
      try { const sm = JSON.parse(db.prepare("SELECT site_meta FROM sites WHERE id = ?").get(site.id)?.site_meta || "{}"); activeCoupons = (sm.coupons||[]).filter(c=>c.active).map(c=>c.code+" ("+(c.discount||c.value)+"%)").join(", "); } catch(e) {}
      searchNiche = site.name + (productNames ? " selling " + productNames : "");
    }
    const emp = db.prepare("SELECT business_context FROM ai_employees WHERE user_id = ? AND business_context IS NOT NULL LIMIT 1").get(req.userId);
    if (emp?.business_context) searchNiche = emp.business_context;
  }

  if (!searchNiche) return res.status(400).json({ error: "Provide a niche or set up your business context first" });

  const fetch = (await import("node-fetch")).default;
  const targetPlatforms = platforms || ["Instagram", "TikTok", "X/Twitter", "Facebook", "LinkedIn"];

  try {
    // Step 1: Research with Perplexity (real-time web search) → fallback to Claude
    const researchQuery = `I run "${businessName || searchNiche}". ${searchNiche !== businessName ? "About us: " + searchNiche + ". " : ""}${productNames ? "We sell: " + productNames + ". " : ""}${courseNames ? "We offer courses: " + courseNames + ". " : ""}

Research the most viral, high-engagement social media content trends RIGHT NOW that are relevant to MY specific business and industry.

Find:
1. Trending hashtags on ${targetPlatforms.join(", ")} for this niche this week
2. Viral post formats getting massive engagement (reels, carousels, challenges, behind-the-scenes)
3. What top competitors or influencers in this space are posting that gets the most engagement
4. Seasonal trends, upcoming holidays, awareness days relevant to this niche
5. Trending audio/sounds on TikTok and Reels for this industry
6. Content hooks and caption styles that stop the scroll
7. Hot topics or controversy in this niche that could be leveraged
8. Top-performing ad creative styles on Meta and TikTok

Be specific with examples, data points, and sources.`;

    const research = await doResearch(researchQuery, getSetting);

    // Step 2: Use Claude to structure the raw research into JSON
    const anthropicKey = getSetting("ANTHROPIC_API_KEY");
    let parsed = null;

    if (anthropicKey && research.text) {
      const structureResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
        temperature: 0,
          messages: [{
            role: "user",
            content: `Here is real-time research about trending content for "${searchNiche}":\n\n${research.text}\n\nSources: ${(research.citations || []).join(", ")}\n\nStructure this into JSON:\n{\n  "niche": "${searchNiche}",\n  "researchDate": "today",\n  "source": "${research.source}",\n  "trendingHashtags": [{"tag": "#example", "platform": "Instagram", "volume": "high"}],\n  "viralFormats": [{"format": "...", "why": "...", "example_hook": "..."}],\n  "competitorInsights": [{"insight": "...", "source": "..."}],\n  "seasonalOpportunities": [{"event": "...", "date": "...", "angle": "..."}],\n  "trendingAudio": [{"name": "...", "platform": "TikTok"}],\n  "scrollStoppers": ["hook line 1", "hook line 2"],\n  "hotTopics": [{"topic": "...", "angle": "..."}],\n  "adCreativeStyles": [{"style": "...", "platform": "Meta", "why": "..."}],\n  "contentCalendarSuggestions": [{"day": "Monday", "type": "...", "topic": "..."}],\n  "citations": ${JSON.stringify(research.citations || [])}\n}\n\nReturn ONLY the JSON, no markdown.`
          }]
        })
      });
      const sd = await structureResp.json();
      const structText = (sd.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      try {
        const jsonMatch = structText.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(jsonMatch[0]);
      } catch (e) { /* parse failed */ }
    }

    if (!parsed && research.text) {
      // Couldn't structure, return raw
      try {
        const jsonMatch = research.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(jsonMatch[0]);
      } catch (e) { parsed = { raw: research.text, citations: research.citations || [], source: research.source }; }
    }

    // Cache the research in DB
    try {
      db.exec("CREATE TABLE IF NOT EXISTS trend_research (id TEXT PRIMARY KEY, user_id TEXT, niche TEXT, data TEXT, source TEXT, created_at TEXT)");
      db.prepare("INSERT INTO trend_research (id, user_id, niche, data, source, created_at) VALUES (?,?,?,?,?,datetime('now'))")
        .run(uuid(), req.userId, searchNiche, JSON.stringify(parsed || research.text), research.source || "unknown");
    } catch (e) { /* cache failed, not critical */ }

    res.json({
      success: true,
      niche: searchNiche,
      trends: parsed || { raw: research.text || "" },
      cached: true
    });
  } catch (e) {
    console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Get cached trend research
router.get("/research", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS trend_research (id TEXT PRIMARY KEY, user_id TEXT, niche TEXT, data TEXT, created_at TEXT)");
    const recent = db.prepare("SELECT * FROM trend_research WHERE user_id = ? ORDER BY created_at DESC LIMIT 5").all(req.userId);
    res.json({ research: recent.map(r => ({ ...r, data: JSON.parse(r.data || "{}") })) });
  } catch (e) {
    res.json({ research: [] });
  }
});

// ─── STATS / DASHBOARD ───
router.get("/stats", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);

  const total = db.prepare("SELECT COUNT(*) as n FROM ai_employee_actions WHERE user_id = ?").get(req.userId).n;
  const completed = db.prepare("SELECT COUNT(*) as n FROM ai_employee_actions WHERE user_id = ? AND status IN ('completed','auto_executed')").get(req.userId).n;
  const pending = db.prepare("SELECT COUNT(*) as n FROM ai_employee_actions WHERE user_id = ? AND status = 'pending'").get(req.userId).n;
  const rejected = db.prepare("SELECT COUNT(*) as n FROM ai_employee_actions WHERE user_id = ? AND status = 'rejected'").get(req.userId).n;

  const byRole = db.prepare(`
    SELECT role, COUNT(*) as total,
    SUM(CASE WHEN status IN ('completed','auto_executed') THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
    FROM ai_employee_actions WHERE user_id = ? GROUP BY role
  `).all(req.userId);

  const recentActions = db.prepare(`
    SELECT * FROM ai_employee_actions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(req.userId).map(a => ({ ...a, details: JSON.parse(a.details || "{}"), result: JSON.parse(a.result || "{}") }));

  // Calculate time/money saved estimates
  const timeSavedMins = completed * 15; // ~15 min per task automated
  const moneySaved = completed * 12; // ~$12 per task (avg VA cost)

  const activeEmployees = db.prepare("SELECT COUNT(*) as n FROM ai_employees WHERE user_id = ? AND enabled = 1").get(req.userId).n;

  res.json({
    totalActions: total, completed, pending, rejected,
    byRole,
    recentActions,
    timeSavedHours: Math.round(timeSavedMins / 60),
    moneySaved,
    activeEmployees,
  });
});

// ─── SUPPORT TICKETS ───
// Incoming support from user's customers
router.post("/support/ticket", _ticketLimiter, async (req, res) => {
  try {

      const { siteId, customerName, customerEmail, subject, message } = req.body;
      // Basic field length limits to prevent spam/storage abuse
      if (!siteId || !subject || !message) return res.status(400).json({ error: "siteId, subject, and message are required" });
      if (String(subject).length > 300) return res.status(400).json({ error: "Subject too long (max 300 chars)" });
      if (String(message).length > 10000) return res.status(400).json({ error: "Message too long (max 10,000 chars)" });
      if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ error: "Invalid email" });
      const db = getDb();
      ensureTables(db);

      // Find site owner
      const site = db.prepare("SELECT user_id FROM sites WHERE id = ?").get(siteId);
      if (!site) return res.status(404).json({ error: "Site not found" });

      const ticketId = uuid();
      db.prepare(`INSERT INTO support_tickets (id, user_id, site_id, customer_name, customer_email, subject, message, status, ai_replied, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
        .run(ticketId, site.user_id, siteId, customerName, customerEmail, subject, message, "open", 0);

      // Trigger AI support agent
      const supportAgent = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND role = 'support' AND enabled = 1").get(site.user_id);

      // Per-site daily AI auto-reply cap (50/day) — prevents runaway API costs from high-traffic sites
      const AI_TICKET_DAILY_CAP = 50;
      let aiReplyAllowed = false;
      if (supportAgent) {
        const today = new Date().toISOString().split("T")[0];
        db.prepare("CREATE TABLE IF NOT EXISTS ai_ticket_usage (site_id TEXT, date TEXT, count INTEGER DEFAULT 0, PRIMARY KEY (site_id, date))").run();
        const row = db.prepare("SELECT count FROM ai_ticket_usage WHERE site_id = ? AND date = ?").get(siteId, today);
        if (!row) {
          db.prepare("INSERT INTO ai_ticket_usage (site_id, date, count) VALUES (?, ?, 1)").run(siteId, today);
          aiReplyAllowed = true;
        } else if (row.count < AI_TICKET_DAILY_CAP) {
          db.prepare("UPDATE ai_ticket_usage SET count = count + 1 WHERE site_id = ? AND date = ?").run(siteId, today);
          aiReplyAllowed = true;
        }
        // else: cap reached — ticket created but no AI auto-reply today
      }

      // Deduct from aiActions cap — ticket replies are AI spend, not a free feature
      if (supportAgent && aiReplyAllowed && typeof global !== "undefined" && global.mineCheckUsage) {
        const usage = global.mineCheckUsage(db, site.user_id, "aiActions");
        if (usage.blocked) {
          aiReplyAllowed = false; // Plan doesn't include AI employees — ticket created, no auto-reply
        } else {
          global.mineTrackUsage(db, site.user_id, "aiActions");
        }
      }

      if (supportAgent && aiReplyAllowed) {
        const decision = await decideAction(supportAgent, "new_ticket", {
          customerName, customerEmail, subject, message, ticketId
        }, AI_ROLES.support);

        if (decision.action && (supportAgent.autonomy === "full" || (supportAgent.autonomy === "semi" && decision.confidence > 0.85))) {
          // Auto-reply
          const actionId = uuid();
          db.prepare(`INSERT INTO ai_employee_actions (id, user_id, role, action, details, status, confidence, created_at)
            VALUES (?,?,?,?,?,?,?,datetime('now'))`)
            .run(actionId, site.user_id, "support", decision.action, JSON.stringify({ ticketId, draft: decision.draft, reasoning: decision.reasoning }), "auto_executed", decision.confidence);

          // Send the reply email
          await sendEmail(site.user_id, customerEmail, `Re: ${subject}`, decision.draft);
          db.prepare("UPDATE support_tickets SET ai_replied = 1, ai_response = ?, status = 'ai_responded' WHERE id = ?")
            .run(decision.draft, ticketId);

          db.prepare("UPDATE ai_employee_actions SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(actionId);
        } else if (decision.action) {
          // Queue for approval
          const actionId = uuid();
          db.prepare(`INSERT INTO ai_employee_actions (id, user_id, role, action, details, status, confidence, created_at)
            VALUES (?,?,?,?,?,?,?,datetime('now'))`)
            .run(actionId, site.user_id, "support", decision.action, JSON.stringify({ ticketId, draft: decision.draft, reasoning: decision.reasoning }), "pending", decision.confidence);
          notifyApprovalNeeded(db, actionId).catch(function(){});
        }
      }

      res.json({ success: true, ticketId });

  } catch(e) {
    console.error("[Route Error]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Get support tickets
router.get("/support/tickets", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const tickets = db.prepare("SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);
  res.json({ tickets });
});

router.post("/support/tickets/:id/resolve", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("UPDATE support_tickets SET status = 'resolved' WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_employees (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
      enabled INTEGER DEFAULT 1, rules TEXT DEFAULT '[]', schedule TEXT DEFAULT '{}',
      autonomy TEXT DEFAULT 'semi', tone TEXT DEFAULT 'professional', custom_name TEXT,
      business_context TEXT, email_signature TEXT, policies TEXT,
      brand_voice TEXT, inspiration_media TEXT,
      created_at TEXT, updated_at TEXT,
      UNIQUE(user_id, role)
    );
    CREATE TABLE IF NOT EXISTS ai_autonomy_audit (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
      autonomy TEXT, risk_unlocks TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ai_employee_actions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
      action TEXT, details TEXT, result TEXT,
      status TEXT DEFAULT 'pending', confidence REAL DEFAULT 0,
      created_at TEXT, approved_at TEXT, completed_at TEXT
    ), scheduled_at TEXT DEFAULT NULL, execute_after TEXT DEFAULT NULL);

    CREATE INDEX IF NOT EXISTS idx_actions_user ON ai_employee_actions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_actions_status ON ai_employee_actions(user_id, status);
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT,
      customer_name TEXT, customer_email TEXT, subject TEXT, message TEXT,
      status TEXT DEFAULT 'open', ai_replied INTEGER DEFAULT 0, ai_response TEXT,
      notes TEXT, sentiment TEXT, updated_at TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS lead_scores (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      score_reason TEXT,
      last_scored_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_scores_user ON lead_scores(user_id);
    CREATE INDEX IF NOT EXISTS idx_community_replies_user ON community_replies(user_id) WHERE EXISTS (SELECT 1 FROM community_replies LIMIT 1);
  `);
  try { db.prepare("ALTER TABLE ai_employees ADD COLUMN risk_unlocks TEXT DEFAULT '{}'").run(); } catch (e) {}
// Change 9: schema-drift ALTERs for ai_employee_actions
try { db.exec("ALTER TABLE ai_employee_actions ADD COLUMN execute_after TEXT"); } catch(_){}
  // Migrations
  try { db.exec("ALTER TABLE support_tickets ADD COLUMN notes TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE support_tickets ADD COLUMN sentiment TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE support_tickets ADD COLUMN updated_at TEXT"); } catch(e) {}
}

async function decideAction(employee, event, data, roleConfig) {
  const anthropicKey = getSetting("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return { action: roleConfig.actions[0], confidence: 0.5, reasoning: "Default action (no AI key configured)", draft: "" };
  }

  const fetch = (await import("node-fetch")).default;
  const tone = employee.tone || "professional";
  const rules = JSON.parse(employee.rules || "[]");
  const rulesText = rules.length > 0 ? "\nContent rules you MUST follow: " + rules.map(r => r.description).filter(Boolean).join("; ") : "";
  const businessContext = employee.business_context ? "\nBusiness context: " + employee.business_context : "";
  // #2 hook — inject what the owner has captured in smart notes (knowledge items). Safe no-op if unavailable.
  let ownerKnowledge = "";
  try { ownerKnowledge = require("./notes").getBusinessKnowledge(getDb(), employee.user_id); } catch (_) {}
  const emailSig = employee.email_signature ? "\nAlways end emails with this signature:\n" + employee.email_signature : "";
  const policies = employee.policies ? "\nPolicies:\n" + employee.policies : "";

  // ═══ COMMUNITY SCAN — fetch real posts from Reddit + X ═══
  if (employee.role === "community" && event === "community_scan") {
    const keywords   = data?.keywords   || [];
    const subreddits = data?.subreddits || [];
    const xHashtags  = data?.xHashtags  || [];
    const posts = [];
    const fetchImpl = (await import("node-fetch")).default;

    // ── Reddit search ────────────────────────────────────────────────────────
    const redditToken = await getValidRedditToken(employee.user_id);
    const redditUser  = null;
    if (redditToken && (subreddits.length > 0 || keywords.length > 0)) {
      for (const sub of subreddits.slice(0, 3)) {
        try {
          const query = keywords.length > 0 ? keywords[0] : "";
          const url   = query
            ? `https://oauth.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=10`
            : `https://oauth.reddit.com/r/${sub}/new.json?limit=10`;
          const resp  = await fetchImpl(url, {
            headers: { "Authorization": `Bearer ${redditToken}`, "User-Agent": `MINE:CommunityAgent:1.0 (by /u/${redditUser||"mine_agent"})` }
          });
          const rd = await resp.json();
          for (const item of (rd?.data?.children || []).slice(0, 5)) {
            const p = item.data;
            posts.push({ id: `t3_${p.id}`, platform: "reddit", subreddit: p.subreddit, title: p.title, content: p.selftext?.substring(0, 400) || "", url: p.url, score: p.score, comments: p.num_comments });
          }
        } catch(e) { console.error("[/:id/resolve]", e.message || e); }
      }
      // Also search globally for keywords on Reddit
      for (const kw of keywords.slice(0, 2)) {
        try {
          const resp = await fetchImpl(`https://oauth.reddit.com/search.json?q=${encodeURIComponent(kw)}&sort=new&t=day&limit=10`, {
            headers: { "Authorization": `Bearer ${redditToken}`, "User-Agent": `MINE:CommunityAgent:1.0 (by /u/${redditUser||"mine_agent"})` }
          });
          const rd = await resp.json();
          for (const item of (rd?.data?.children || []).slice(0, 5)) {
            const p = item.data;
            if (!posts.find(x => x.id === `t3_${p.id}`)) {
              posts.push({ id: `t3_${p.id}`, platform: "reddit", subreddit: p.subreddit, title: p.title, content: p.selftext?.substring(0, 400) || "", url: p.url, score: p.score, comments: p.num_comments });
            }
          }
        } catch(e) { console.error("[/:id/resolve]", e.message || e); }
      }
    }

    // ── LinkedIn mention monitoring ──────────────────────────────────────────
    // Uses LinkedIn's Community Management API (requires Marketing Developer Platform access)
    const liAccessToken = getSetting("LINKEDIN_ACCESS_TOKEN");
    const liOrgId = getSetting("LINKEDIN_ORG_ID");
    if (liAccessToken && liOrgId && keywords.length > 0) {
      try {
        // Search for LinkedIn posts mentioning the business or keywords
        const liResp = await fetchImpl(
          `https://api.linkedin.com/rest/socialMetadata?q=mentions&organization=urn:li:organization:${liOrgId}`,
          { headers: { "Authorization": `Bearer ${liAccessToken}`, "LinkedIn-Version": "202401", "X-Restli-Protocol-Version": "2.0.0" } }
        );
        const liData = await liResp.json();
        for (const item of (liData.elements || []).slice(0, 5)) {
          if (item.ugcPost || item.share) {
            const postId = item.ugcPost || item.share;
            posts.push({
              id: `li_${postId}`,
              platform: "linkedin",
              li_post_urn: postId,
              title: (item.commentary || "").substring(0, 100),
              content: item.commentary || "",
              score: item.totalSocialActivityCounts?.numLikes || 0,
              comments: item.totalSocialActivityCounts?.numComments || 0
            });
          }
        }
      } catch(liErr) { console.error("[/:id/resolve]", liErr.message || liErr); }

      // Fallback: search LinkedIn posts by keyword using /ugcPosts search
      if (posts.filter(p => p.platform === "linkedin").length === 0) {
        for (const kw of keywords.slice(0, 1)) {
          try {
            const liSearchResp = await fetchImpl(
              `https://api.linkedin.com/rest/posts?q=dslQuery&query.keywords=${encodeURIComponent(kw)}&count=5`,
              { headers: { "Authorization": `Bearer ${liAccessToken}`, "LinkedIn-Version": "202401" } }
            );
            const liSearch = await liSearchResp.json();
            for (const post of (liSearch.elements || []).slice(0, 3)) {
              posts.push({
                id: `li_${post.id}`,
                platform: "linkedin",
                li_post_urn: post.id,
                title: (post.commentary || "").substring(0, 100),
                content: post.commentary || "",
                score: 0, comments: 0
              });
            }
          } catch(e) { console.error("[/:id/resolve]", e.message || e); }
        }
      }
    }

    // ── X / Twitter search ───────────────────────────────────────────────────
    const xBearerToken = getSetting("X_BEARER_TOKEN") || getSetting("X_API_KEY");
    if (xBearerToken && (keywords.length > 0 || xHashtags.length > 0)) {
      const searchTerms = [...keywords.slice(0, 2), ...xHashtags.slice(0, 2).map(h => `#${h}`)];
      for (const term of searchTerms.slice(0, 2)) {
        try {
          const resp = await fetchImpl(`https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(term + " -is:retweet lang:en")}&max_results=10&tweet.fields=text,author_id,public_metrics,created_at`, {
            headers: { "Authorization": `Bearer ${xBearerToken}` }
          });
          const xd = await resp.json();
          for (const tweet of (xd.data || []).slice(0, 5)) {
            posts.push({ id: tweet.id, platform: "x", x_tweet_id: tweet.id, title: tweet.text?.substring(0, 100), content: tweet.text, score: tweet.public_metrics?.like_count || 0, comments: tweet.public_metrics?.reply_count || 0 });
          }
        } catch(e) { console.error("[/:id/resolve]", e.message || e); }
      }
    }

    // Add fetched posts to data for Claude and executeAction
    data.posts = posts;
    data.postsFound = posts.length;
    if (posts.length === 0) {
      return { action: "log_engagement", confidence: 0.3, reasoning: "No relevant posts found in this scan", draft: "" };
    }
  }

  // ═══ NICHE TREND RESEARCH ═══
  // For social/marketing roles, research trending content in the user's niche BEFORE creating content
  let trendResearch = "";
  const isSocialOrAd = employee.role === "social" || employee.role === "marketing";
  const isContentEvent = event.includes("daily") || event.includes("post") || event.includes("content") || event.includes("campaign") || event.includes("creative");

  if (isSocialOrAd && isContentEvent) {
    try {
      const businessName = data?._business?.name || data?.business?.name || "";
      const businessUrl = data?._business?.url || "";
      const businessType = employee.business_context || "";
      const productList = (data?._products || data?.products || []).slice(0, 8);
      const productNames = productList.map(p => `${p.name}${p.price ? " ($" + p.price + ")" : ""}`).join(", ");
      const courseNames = (data?._courses || []).slice(0, 3).map(c => c.name).join(", ");
      const activeCoupons = (data?._activeCoupons || []).map(c => c.code + " (" + c.discount + ")").join(", ");
      const recentPosts = (data?.recentSocialPosts || []).slice(0, 3).map(p => (p.content || "").substring(0, 50)).join("; ");

      const bizParts = [];
      if (businessName) bizParts.push(businessName);
      if (businessType) bizParts.push(businessType);
      if (productNames) bizParts.push("Products: " + productNames);
      if (courseNames) bizParts.push("Courses: " + courseNames);
      const niche = bizParts.join(". ") || "small business";

      if (niche.length > 5) {
        const researchQuery = `I run "${businessName || "a business"}". ${businessType ? "About us: " + businessType + ". " : ""}${productNames ? "We sell: " + productNames + ". " : ""}${courseNames ? "We offer courses: " + courseNames + ". " : ""}

What are the most viral, high-engagement social media content trends RIGHT NOW that are specifically relevant to MY business and industry? I need:
1. Trending topics and hashtags in MY niche this week on Instagram, TikTok, Facebook, X, LinkedIn
2. Viral post formats for businesses like mine (reels, carousels, before/after, tips, etc.)
3. What competitors in my space are posting that gets the most engagement
4. Seasonal events, holidays, or cultural moments I should post about now
5. Scroll-stopping hooks and caption openers specific to my industry
6. Trending audio/sounds on TikTok and Reels that fit my brand
7. Ad creative styles converting for my type of business on Meta and TikTok
${activeCoupons ? "Active promotions: " + activeCoupons + ". How should I promote them? " : ""}${recentPosts ? "Recent posts covered: " + recentPosts + ". Suggest different angles. " : ""}
Be specific to MY business, not generic. Include real examples.`;
        const research = await doResearch(researchQuery, getSetting);
        trendResearch = research.text || "";

        if (trendResearch) {
          trendResearch = "\n\nTRENDING CONTENT RESEARCH FOR " + (businessName || "YOUR BUSINESS").toUpperCase() + " (use these insights):\n" + trendResearch.substring(0, 3000);
        }
      }
    } catch (e) {
      console.error("Trend research error:", e.message);
      // Continue without trends — don't block content creation
    }
  }

  const roleSpecificInstructions = {
    sales: `
SALES REP INTELLIGENCE UPGRADE:
- You have the full lead history above (emailHistory, leadProfile, contactOrders). Reference it explicitly.
- Score every lead in leadsToScore from 1-10 based on: recency of activity, total spent, email engagement (opened/clicked), order history. Hot leads (8+) get immediate follow-up. Cold leads (3-) get re-engagement or disqualification.
- For follow-up emails: reference specific previous interactions ("I noticed you opened our email about [X] but didn't click through — here's what other customers in your situation found helpful...")
- Never send a generic email. Every email must reference something specific from their history.
- If a lead has gone cold (>14 days no activity), propose a re-engagement angle based on what they originally showed interest in.`,

    support: `
SUPPORT AGENT INTELLIGENCE UPGRADE:
- You have the customer's full ticket history above (customerTicketHistory, ticketCount, sentimentTrend, isRepeatIssue).
- If this is a repeat issue (isRepeatIssue=true), flag it immediately and recommend human review — do not send another automated reply.
- If sentimentTrend shows escalating negativity (e.g. neutral → negative → angry), escalate to human and notify the business owner.
- If ticketCount > 3 from the same customer, this is a high-risk churn signal — treat with extra care and offer something proactive.
- Reference their history naturally: "I can see you've been in touch with us before about [X]..."
- For billing/refund tickets from repeat customers: lean toward approval to protect the relationship.`,

    bookkeeper: `
BOOKKEEPER EXTENDED THINKING UPGRADE — be a CFO, not just a bookkeeper:
- You have deep financial data: revenueByDayOfWeek, monthlyTrend, clientConcentration, aovTrend, discountImpact.
- If cryptoPaymentsThisMonth exists: ALWAYS flag it. State exact count and value. Crypto has different tax treatment in most jurisdictions — tell the owner to flag these transactions for their accountant.
- Look for patterns that a human bookkeeper would miss. Examples:
  * If Tuesday revenue is consistently 40% lower than Thursday → flag as a pattern worth investigating
  * If AOV drops every time discounts run → this is costing more than the revenue gained
  * If top client accounts for >40% of revenue → critical concentration risk, flag urgently
  * If monthly revenue trend shows 3 consecutive months of decline → proactive forecast alarm
  * If discountImpact shows discounted orders have lower AOV → recommend reducing discount frequency
- The weekly summary email should read like a real CFO briefing: trend analysis, risks, opportunities, one clear recommendation.
- Reference specific numbers, not generalities. "Your Tuesday revenue ($340 avg) is 43% lower than your Thursday revenue ($600 avg) — consider adding a Tuesday-only promotion to even out the week."`,

    social: `
SOCIAL MANAGER VISION UPGRADE — be a content strategist, not just a poster:
- You have engagement data: platformEngagement, topPerformingPosts, lowPerformingPosts, bestPostingHours.
- Analyse what's actually working vs what isn't. Reference specific patterns from topPerformingPosts.
- If flat-lay product shots consistently outperform lifestyle shots → recommend more flat-lays.
- If one platform shows significantly higher engagement → prioritise it.
- If bestPostingHours data exists → schedule content at those times.
- Never create the same format twice in a row. If last post was a product showcase, next should be educational or behind-the-scenes.
- The draft should reference the engagement patterns: "Based on your top posts, [X] format gets 3x more engagement — using that angle here."`,

    marketing: `
MARKETING MANAGER DYNAMIC UPGRADE — reason across all campaigns, don't just check rules:
- You have full campaign intelligence: campaignPerformanceDetail, bestCreativePatterns, platformEfficiency.
- Think strategically before acting:
  * Which platform is giving the best cost-per-acquisition? Double down there.
  * Which campaigns have the best CTR patterns? Create variants of those, not new from scratch.
  * If one platform has high spend but zero conversions → pause and reallocate budget.
  * If a creative headline pattern appears in all top performers → use that structure for new creatives.
- Don't just pause bad campaigns — recommend what to replace them with and why.
- NanoBanana images should match the visual style of the best-performing creatives (note their format/style in your reasoning).`,

    community: `
COMMUNITY AGENT MEMORY UPGRADE — build relationships, not just replies:
- You have full engagement history: communityEngagementHistory, recentReplyAngles, topEngagedCommunities.
- Never use an angle you've already used in that community recently (check recentReplyAngles).
- Build on threads where you've had success before (topEngagedCommunities) — become a known, trusted voice there.
- Vary your approach: sometimes helpful answer, sometimes a question, sometimes sharing a relevant insight.
- If you've been in a community 3+ times, your replies should feel like a regular contributor, not a newcomer.
- Track which angles drive traffic vs which just get upvotes — prioritise traffic-driving angles.`,
  };

  const roleInstruction = roleSpecificInstructions[emp.role] || "";

  const prompt = `You are an autonomous ${roleConfig.name} AI agent for a small business.
Your tone: ${tone}
Available actions: ${roleConfig.actions.join(", ")}
${businessContext}
${ownerKnowledge}
${rulesText}
${emailSig}
${policies}
${trendResearch}
${roleInstruction}

Event: "${event}"
Data: ${JSON.stringify(data)}

IMPORTANT INSTRUCTIONS FOR CONTENT CREATION:
- If creating social posts, write content that specifically references the business's actual products, services, prices, and events from the data above. Never write generic posts.
- USE THE TRENDING CONTENT RESEARCH above to inform your content strategy. Adapt viral formats, hooks, and angles to this specific business.
- If creating ad copy, reference specific products/services with real prices. Use customer reviews as social proof. Mention active coupons/promos.
- Look at "recentSocialPosts" to avoid repeating topics. Create fresh angles based on what's trending.
- If blog posts exist, repurpose them into social snippets.
- If reviews exist, create testimonial-based posts (e.g. "Here's what [name] said about us...").
- If events are upcoming, promote them with urgency.
- If there are active coupons, mention the discount code.
- For ad optimization, check campaign performance data and pause anything below average CTR.
- Always include a call-to-action with the business URL if available.
- Match the trending formats from the research (reels, carousels, hooks, etc.)

Decide what action to take. Respond ONLY in JSON:
{
  "action": "one_of_the_available_actions",
  "confidence": 0.0-1.0,
  "reasoning": "why this action and what trending angle you're using",
  "draft": "if the action involves sending a message/email OR creating social/ad content, write the FULL content here. For social posts, write 6 platform-specific versions (Instagram, Facebook, TikTok, X, LinkedIn, YouTube) separated by ---. Reference specific products, prices, and details from the data. Use trending hooks and formats from the research. Otherwise empty string.",
  "trending_angle": "which trending topic or format from the research you used and why"
}`;

  try {
    // Bookkeeper uses extended thinking for deeper financial analysis
    const useExtendedThinking = emp.role === "bookkeeper";
    const requestBody = useExtendedThinking
      ? {
          model: "claude-sonnet-4-6",
          max_tokens: 16000,
          thinking: { type: "enabled", budget_tokens: 8000 },
          messages: [{ role: "user", content: prompt }],
        }
      : {
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(requestBody),
    });
    const d = await r.json();
    // Extended thinking returns multiple blocks — find the text block
    const textBlock = d.content?.find(b => b.type === "text");
    const text = textBlock?.text || d.content?.[0]?.text || "";
    // Extract JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(jsonMatch[0]);
      return {
        action: parsed.action || roleConfig.actions[0],
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        reasoning: parsed.reasoning || "",
        draft: parsed.draft || "",
      };
    }
  } catch (e) {
    console.error("AI decision error:", e.message);
  }

  return { action: roleConfig.actions[0], confidence: 0.3, reasoning: "Fallback default action", draft: "" };
}


// ── Build a rich NanoBanana ad prompt with text overlay instructions ──────────
// NanoBanana 2 supports text rendering — always include headline + CTA in prompt
function buildAdImagePrompt(headline, bodyCopy, platform, productName, style) {
  const platformStyle = {
    meta:     "Facebook/Instagram square ad 1080x1080",
    tiktok:   "TikTok vertical ad 1080x1920",
    google:   "Google display ad 1200x628 landscape banner",
    linkedin: "LinkedIn sponsored content 1200x628",
    x:        "Twitter/X ad card 1200x628",
  }[platform] || "social media ad";

  // Extract short headline (first line or first 8 words)
  const shortHeadline = (headline || bodyCopy || "").split("\n")[0].split(" ").slice(0, 8).join(" ");
  const cta = (bodyCopy || "").toLowerCase().includes("shop") ? "Shop Now"
             : (bodyCopy || "").toLowerCase().includes("book") ? "Book Now"
             : (bodyCopy || "").toLowerCase().includes("learn") ? "Learn More"
             : (bodyCopy || "").toLowerCase().includes("sign") ? "Sign Up Free"
             : "Get Started";

  const productMention = productName ? ` featuring ${productName}` : "";

  return `${platformStyle}${productMention}. ` +
    `Bold text overlay reading "${shortHeadline}" in large white font with dark shadow, positioned in upper third. ` +
    `Bottom section shows call-to-action button with text "${cta}". ` +
    `High-quality product photography or lifestyle image as background. ` +
    `Professional ad design, high contrast, eye-catching. ` +
    `${style ? style + " style. " : ""}` +
    `Text must be clearly readable. Clean modern layout.`;
}

async function _rawExecuteAction(db, action, userId) {
  const details = JSON.parse(action.details || "{}");

  // ── Hire/paid gate ──────────────────────────────────────────────────────
  // Catalog agents must be hired (active ai_employee_subscriptions row) before
  // they fire. Admins bypass; non-catalog/system roles pass through. This is the
  // single execution funnel, so every autonomous action is gated here.
  {
    const _gateRole = action.role || inferRoleFromAction(action.action);
    if (_isEmployeeHired(db, userId, _gateRole) === false) {
      try { recordOutcome(action.id, userId, _gateRole, action.action, "blocked", { reason: "agent not hired — subscription required", blockType: "not_hired" }); } catch {}
      return { sent: false, completed: false, blocked: true, reason: "Agent not hired — subscription required", blockType: "not_hired", _outcome_recorded: true };
    }
  }

  switch (action.action) {
    case "send_followup_email":
    case "reply_ticket": {
      // ── Customer Service Orchestra ──────────────────────────────────────────
      // 4-agent chain: TRIAGE → RESPONDER → VALIDATOR → EXECUTOR
      // Convenience aliases for enhancement-layer calls:
      const actionId = action.id;
      const actionType = action.action;
      const actionRole = action.role || (actionType === "send_followup_email" ? "sales" : "support");
      const ticketEmail = details.data?.email || details.data?.customerEmail;

      // ── Baseline enforcement: working hours, approval rules ────────────────
      // Reads the user's saved config (brand voice, hours, approval rules, KB files).
      // If the agent is outside its working window or hits an approval rule,
      // we block the send and return early with a recorded outcome.
      const baseline = _checkBaseline(db, userId, actionRole, actionType, {
        contact: details.data?.contact || { email: ticketEmail },
        amount: details.data?.amount,
      });
      if (baseline.block) {
        // Outcome: blocked — distinct from failed/escalated, makes scorecards honest
        recordOutcome(actionId, userId, actionRole, actionType,
          baseline.blockType === "needs_approval" ? "escalated" : "blocked",
          { reason: baseline.reason, blockType: baseline.blockType });
        // If outside hours: queue for retry when hours resume
        if (baseline.shouldQueue) {
          queueRetry(actionId, userId, actionRole, actionType,
            { ticketEmail, ticketId: details.data?.ticketId, retryWhenInHours: true },
            new Error(baseline.reason));
        }
        return { sent: false, blocked: true, reason: baseline.reason, blockType: baseline.blockType, _outcome_recorded: true };
      }
      const ticketText  = details.data?.ticketContent || details.data?.message || details.draft || "";
      const ticketId    = details.data?.ticketId || details.ticketId;
      if (!ticketText) return { sent: false, reason: "No ticket content" };

      const anthropicKey = getSetting("ANTHROPIC_API_KEY");
      if (!anthropicKey) {
        if (ticketEmail && details.draft) {
          await sendEmail(userId, ticketEmail, "Reply to your enquiry", details.draft);
          return { sent: true, to: ticketEmail, agent: "fallback" };
        }
        return { sent: false, reason: "No AI key and no draft" };
      }

      const empRow = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND role = 'support'").get(userId);
      const brandVoice   = empRow?.brand_voice || "professional and helpful";
      const refundPolicy = empRow?.policies    || "";
      const faqAnswers   = empRow?.faq_answers || "";
      const agentName    = empRow?.name        || "Support Team";

      // ── Pre-check: repeat issue or escalating sentiment — skip auto-reply ───
      const isRepeatIssue = details.data?.isRepeatIssue;
      const sentimentTrend = details.data?.sentimentTrend || [];
      const ticketCount = details.data?.ticketCount || 0;
      const angryPattern = sentimentTrend.filter(s => s === "angry" || s === "negative").length >= 2;

      if (isRepeatIssue || angryPattern || ticketCount > 4) {
        const reason = isRepeatIssue ? "repeat issue detected" : angryPattern ? "escalating negative sentiment" : "high ticket volume customer";
        if (ticketId) {
          db.prepare("UPDATE support_tickets SET status = 'escalated', notes = COALESCE(notes,'') || ? WHERE id = ? AND user_id = ?")
            .run(`\n[AI] Auto-escalated: ${reason}. Ticket count: ${ticketCount}. Sentiment: ${sentimentTrend.join(",")}.`, ticketId, userId);
        }
        // Notify business owner
        try {
          const owner = db.prepare("SELECT email, name FROM users WHERE id = ?").get(userId);
          if (owner?.email) {
            await sendEmail(userId, owner.email,
              `⚠️ Support escalation required — ${reason}`,
              `<div style="font-family:sans-serif;max-width:480px">
                <h3 style="color:#DC2626">⚠️ Customer needs your attention</h3>
                <p>The AI Support Agent has flagged this ticket for human review:</p>
                <p><strong>Reason:</strong> ${reason}</p>
                <p><strong>Customer:</strong> ${ticketEmail || "unknown"}</p>
                <p><strong>Ticket count:</strong> ${ticketCount} previous tickets</p>
                <p><strong>Sentiment trend:</strong> ${sentimentTrend.join(" → ") || "unknown"}</p>
                <p><strong>Message:</strong> "${ticketText.substring(0, 200)}"</p>
                <p style="color:#64748B;font-size:12px">No automated reply was sent. Please respond personally.</p>
              </div>`
            );
          }
        } catch(e) { /* non-fatal */ }
        recordOutcome(action.id, userId, actionRole, actionType, "escalated", {
          reason, ticketCount, sentiment_trend: sentimentTrend, to: ticketEmail,
        });
        return { sent: false, escalated: true, reason, ticketCount, sentimentTrend, _outcome_recorded: true };
      }

      async function orchClaude(system, user, maxTok = 300) {
        const fetch = (await import("node-fetch")).default;
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTok, temperature: 0, system, messages: [{ role: "user", content: user }] })
        });
        const d = await r.json();
        return d.content?.[0]?.text || "";
      }

      // Load customer history to pass to responder
      const customerHistory = details.data?.customerTicketHistory || [];
      const historyContext = customerHistory.length > 0
        ? `\nCUSTOMER HISTORY: This customer has submitted ${customerHistory.length} previous tickets. Recent: ${customerHistory.slice(0,3).map(t => `"${t.subject}" (${t.status})`).join(", ")}. Reference this naturally if relevant.`
        : "";

      // ── Load persistent contact memory (across both sales + support agents) ──
      // This remembers what ANY agent has learned about this customer in the past.
      // Builds on customerHistory above — that's ticket metadata, this is
      // distilled facts ("is VIP", "cares about delivery speed", "prefers SMS").
      const memRole = actionRole === "sales" ? "sales" : "support";
      const memory = ticketEmail ? getMemory(userId, memRole, ticketEmail) : null;
      const memoryContext = memory
        ? `\nCONTACT MEMORY (${memory.interaction_count} prior interactions, last ${memory.last_interaction}):
  Summary: ${memory.summary || "(none)"}
  Known facts: ${(memory.facts || []).slice(-10).join("; ") || "(none)"}
  Preferences: ${JSON.stringify(memory.preferences || {})}`
        : "";

      // AGENT 1: TRIAGE — classify and extract key details
      const triageRaw = await orchClaude(
        `You are a support triage agent. Classify this ticket and extract key details.
Respond ONLY in JSON: {"category":"billing|technical|refund|complaint|general","urgency":"high|medium|low","sentiment":"positive|neutral|negative|angry","key_issue":"one line","customer_name":"or null","requires_human":false,"escalate":false}`,
        `Ticket: "${ticketText}"`
      );
      let triage = { category: "general", urgency: "medium", sentiment: "neutral", key_issue: ticketText };
      try { triage = { ...triage, ...JSON.parse(triageRaw) }; } catch(e) {}

      if (triage.escalate || triage.requires_human) {
        if (ticketId) {
          db.prepare("UPDATE support_tickets SET status = 'escalated', notes = COALESCE(notes,'') || ? WHERE id = ? AND user_id = ?")
            .run("\n[AI Triage] Escalated: " + triage.key_issue, ticketId, userId);
        }
        recordOutcome(action.id, userId, actionRole, actionType, "escalated", {
          reason: triage.key_issue, category: triage.category, triage,
        });
        return { sent: false, escalated: true, reason: triage.key_issue, triage, _outcome_recorded: true };
      }

      // AGENT 2: RESPONDER — draft the reply using brand voice + customer history
      const draft = await orchClaude(
        `You are a customer support responder for this business. Write a reply to this support ticket.
Brand voice: ${brandVoice}
Policies: ${refundPolicy || "Handle with care and good faith"}
FAQs: ${faqAnswers || "Use best judgement"}
Sign as: ${agentName}
${historyContext}${memoryContext}
Rules: Be concise. Be warm. Don't make promises outside the policies. Don't be defensive. Max 150 words. If you have their history, reference it briefly to show you know them.`,
        `Ticket category: ${triage.category}
Customer issue: ${triage.key_issue}
Original message: "${ticketText}"`
      , 400);

      // AGENT 3: VALIDATOR — check against policies, tone, accuracy
      const validationRaw = await orchClaude(
        `You are a QA validator for customer support replies. Check this draft reply.
Policies: ${refundPolicy || "none specified"}
Brand voice should be: ${brandVoice}
Check for: promises outside policy, defensive language, incorrect info, wrong tone, excessive length (over 200 words).
Respond ONLY in JSON: {"approved":true/false,"issues":[],"revised_draft":"same as input if approved, or corrected version"}`,
        `Draft reply: "${draft}"
Original ticket: "${ticketText}"`
      , 500);

      let finalReply = draft;
      let approved = true;
      try {
        const validation = JSON.parse(validationRaw);
        approved = validation.approved;
        if (validation.revised_draft && validation.revised_draft !== draft) {
          finalReply = validation.revised_draft;
        }
      } catch(e) {}

      // AGENT 4: EXECUTOR — send the reply and update records
      let sendSucceeded = false;
      if (ticketEmail) {
        const subject = triage.category === "billing" ? "Re: Your billing enquiry"
                      : triage.category === "refund"   ? "Re: Your refund request"
                      : "Re: Your support request";
        try {
          await sendEmail(userId, ticketEmail, subject, finalReply);
          sendSucceeded = true;
        } catch (sendErr) {
          // Queue for retry — don't lose the action
          queueRetry(actionId, userId, memRole, actionType,
            { ticketEmail, subject, finalReply, ticketId }, sendErr);
          recordOutcome(actionId, userId, memRole, actionType, "failed",
            { error: String(sendErr).slice(0, 200), to: ticketEmail });
          return { sent: false, queued_retry: true, error: String(sendErr).slice(0, 200), _outcome_recorded: true };
        }
      }
      if (ticketId) {
        db.prepare("UPDATE support_tickets SET status = 'replied', updated_at = datetime('now'), sentiment = ? WHERE id = ? AND user_id = ?")
          .run(triage.sentiment, ticketId, userId);
        db.prepare("UPDATE contacts SET last_activity = datetime('now') WHERE user_id = ? AND email = ?")
          .run(userId, ticketEmail);
      }

      // ── Record outcome + update memory ─────────────────────────────────
      if (sendSucceeded) {
        recordOutcome(actionId, userId, memRole, actionType, "success", {
          to: ticketEmail, category: triage.category, sentiment: triage.sentiment,
          validator_approved: approved, draft_length: finalReply.length,
        });

        // Update contact memory with new facts learned this interaction.
        // Summary gets overwritten (it's a rolling snapshot); facts accumulate.
        if (ticketEmail) {
          const newFacts = [];
          if (triage.category !== "general") newFacts.push(`asked about ${triage.category}`);
          if (triage.sentiment === "angry" || triage.sentiment === "negative") newFacts.push(`was ${triage.sentiment} on ${new Date().toISOString().slice(0,10)}`);
          if (triage.key_issue) newFacts.push(triage.key_issue.slice(0, 80));

          upsertMemory(userId, memRole, ticketEmail, {
            summary: triage.customer_name
              ? `${triage.customer_name} — ${triage.category} enquiries`
              : `${triage.category} customer (${triage.sentiment})`,
            newFacts,
            preferences: {
              // Learn channel pref from where they contacted us
              channel: details.data?.channel || "email",
              last_category: triage.category,
            },
          });
        }
      }

      return { sent: sendSucceeded, to: ticketEmail, triage, approved, agent: "orchestra", draft: finalReply, customerHistory: customerHistory.length, memory_used: !!memory, _outcome_recorded: true };
    }
    case "send_invoice_reminder": {
      const email = details.data?.email || details.data?.customerEmail || details.data?.lead?.email;
      if (email && details.draft) {
        await sendEmail(userId, email, `Reminder: Invoice payment due`, details.draft);
        return { sent: true, to: email };
      }
      return { sent: false, reason: "No email or draft" };
    }
    case "qualify_lead":
    case "update_crm":
    case "move_pipeline": {
      const leadId = details.data?.lead?.id || details.data?.contactId;
      if (leadId) {
        db.prepare("UPDATE contacts SET status = ?, notes = notes || ?, last_activity = datetime('now') WHERE id = ? AND user_id = ?")
          .run(action.action === "qualify_lead" ? "qualified" : "active", "\n[AI] " + details.reasoning, leadId, userId);
        return { updated: true, leadId };
      }
      return { updated: false };
    }
    case "book_meeting": {
      // Real meeting booking: insert meeting record + send confirmation email
      const email = details.data?.email || details.data?.lead?.email || details.email;
      const leadName = (details.data?.lead?.name || details.data?.contact?.name || details.leadName || "there").split(/\s+/)[0];
      const meetingTime = details.scheduled_at || details.meetingTime || details.data?.scheduled_at || null;
      const meetingTopic = (details.topic || details.draft || "").slice(0, 500);
      const contactId = details.data?.contactId || details.data?.lead?.id || null;

      if (!email) return { booked: false, reason: "No email address in action details" };

      // Create meetings table on first use (idempotent)
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS meetings (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          contact_id TEXT,
          contact_email TEXT,
          contact_name TEXT,
          scheduled_at TEXT,
          topic TEXT,
          status TEXT DEFAULT 'requested',
          source TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`);
      } catch(_) {}

      const { v4: uuid } = require("uuid");
      const meetingId = uuid();

      try {
        db.prepare("INSERT INTO meetings (id, user_id, contact_id, contact_email, contact_name, scheduled_at, topic, status, source) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(meetingId, userId, contactId, email, leadName, meetingTime, meetingTopic, "requested", "ai_sales_rep");
      } catch(e) { console.error("[book_meeting insert]", e.message); }

      // Update contact notes if we have a contact ID
      if (contactId) {
        try {
          db.prepare("UPDATE contacts SET notes = COALESCE(notes,'') || ?, last_activity = datetime('now') WHERE id = ? AND user_id = ?")
            .run("\n[AI " + new Date().toISOString().slice(0,10) + "] Meeting requested" + (meetingTime ? " for " + meetingTime : "") + (meetingTopic ? " — " + meetingTopic.slice(0,100) : ""), contactId, userId);
        } catch(_) {}
      }

      // Send confirmation email
      const subject = meetingTime ? "Confirming our call — " + meetingTime : "Quick call this week?";
      const body = details.draft && details.draft.length > 50 ? details.draft : ("<p>Hi " + leadName + ",</p>\n<p>Thanks for your interest. I'd love to set up a quick call to walk through next steps.</p>\n" + (meetingTime ? "<p><strong>Proposed time:</strong> " + meetingTime + "</p>\n<p>Reply to confirm, or suggest another time that works better.</p>" : "<p>Are you free for a 15-minute call this week? Reply with a couple of times that suit you.</p>") + "\n<p>Talk soon.</p>");

      try {
        await sendEmail(userId, email, subject, body);
        return { booked: true, sent: true, meetingId, email, scheduled_at: meetingTime, note: "Meeting record created + confirmation email sent" };
      } catch(e) {
        return { booked: true, sent: false, meetingId, email, reason: "Meeting recorded but email failed: " + e.message };
      }
    }
    case "send_proposal": {
      const email = details.data?.email || details.data?.lead?.email;
      if (email && details.draft) {
        await sendEmail(userId, email, "Proposal for your review", details.draft);
        return { sent: true, to: email };
      }
      return { sent: false };
    }
    case "process_refund": {
      return { refundInitiated: true, note: "Refund flagged for processing", requiresStripeAction: true };
    }
    case "escalate_to_human": {
      return { escalated: true, note: "Ticket escalated — needs human review" };
    }
    case "close_ticket": {
      const ticketId = details.ticketId;
      if (ticketId) {
        db.prepare("UPDATE support_tickets SET status = 'closed' WHERE id = ? AND user_id = ?").run(ticketId, userId);
        return { closed: true };
      }
      return { closed: false };
    }
    case "generate_post":
    case "schedule_post": {
      // Schedule for later — check execute_after before posting
      const schedAt = details.scheduled_at || details.execute_after;
      if (schedAt && new Date(schedAt) > new Date()) {
        // Store the schedule time and exit — cron will pick it up
        try {
          getDb().prepare("UPDATE ai_employee_actions SET execute_after=? WHERE id=?").run(schedAt, action.id);
        } catch(_) {}
        return { scheduled: true, execute_after: schedAt, content: details.draft };
      }
      // Falls through to post_now if time has passed or no schedule set
    }
    case "post_now": {
      // ACTUALLY post to connected social platforms
      const draft = details.draft || "";
      if (!draft) return { generated: true, posted: false, reason: "No content drafted" };

      // Split draft into platform-specific versions (separated by ---)
      const versions = draft.split("---").map(v => v.trim()).filter(Boolean);

      // Get user's connected platforms
      const tokens = db.prepare("SELECT platform, access_token FROM user_social_tokens WHERE user_id = ?").all(userId);
      const connectedPlatforms = tokens.map(t => t.platform);

      if (connectedPlatforms.length === 0) {
        // Save as draft in social_posts table for manual posting
        const { v4: uuid } = require("uuid");
        db.prepare("INSERT INTO social_posts (id, user_id, content, platforms, status, created_at) VALUES (?,?,?,?,?,datetime('now'))")
          .run(uuid(), userId, draft, JSON.stringify(["draft"]), action.action === "schedule_post" ? "scheduled" : "draft");
        return { generated: true, posted: false, reason: "No social platforms connected. Content saved as draft.", content: versions[0] || draft };
      }

      // Post to each connected platform
      const fetch = (await import("node-fetch")).default;
      const postResults = {};

      // ── Auto-generate image if no video and NanoBanana configured ───────────
      if (!hasVideo) {
        const nanoBananaKey = getSetting("GEMINI_API_KEY") || process.env.GEMINI_API_KEY;
        if (nanoBananaKey && versions[0]) {
          setImmediate(async () => {
            try {
              const { v4: imgUuid } = require("uuid");
              const postId = imgUuid();
              await executeAction(db, {
                id: postId, role: "social", action: "generate_post_image",
                details: JSON.stringify({ data: { prompt: versions[0].substring(0, 200), postId: null } })
              }, userId);
            } catch(e) {}
          });
        }
      }

      // ── Get latest completed video once (shared across all platforms) ──
      let latestVideo = null;
      try {
        db.exec("CREATE TABLE IF NOT EXISTS short_form_videos (id TEXT PRIMARY KEY, user_id TEXT, product_id TEXT, script TEXT, video_url TEXT, status TEXT, provider TEXT, task_id TEXT, platforms TEXT, created_at TEXT)");
        latestVideo = db.prepare(
          "SELECT video_url, script FROM short_form_videos WHERE user_id = ? AND video_url != '' AND video_url IS NOT NULL ORDER BY created_at DESC LIMIT 1"
        ).get(userId);
      } catch(e) {}

      const hasVideo = !!latestVideo?.video_url;

      for (const token of tokens) {
        // Use platform-specific version of the post if available
        const platformIndex = { meta: 0, instagram: 0, facebook: 0, x: 2, linkedin: 3, tiktok: 1, youtube: 5 };
        const idx = platformIndex[token.platform] ?? 0;
        const postText = versions[idx] || versions[0] || draft;

        try {
          switch (token.platform) {

            case "meta": {
              if (hasVideo) {
                // Post as Facebook Reel / video post
                const r = await fetch(`https://graph.facebook.com/v19.0/me/videos`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    description: postText,
                    file_url: latestVideo.video_url,
                    published: true,
                    access_token: token.access_token
                  })
                });
                const d = await r.json();
                postResults.meta = { success: !!d.id, videoId: d.id, type: "video" };
              } else {
                // Text post fallback
                const r = await fetch("https://graph.facebook.com/v19.0/me/feed", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ message: postText, access_token: token.access_token })
                });
                const d = await r.json();
                postResults.meta = { success: !!d.id, postId: d.id, type: "text" };
              }
              break;
            }

            case "instagram": {
              if (hasVideo) {
                // Instagram Reel — two-step: create container then publish
                const pageR = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${token.access_token}`);
                const pageD = await pageR.json();
                const igAccountId = pageD.data?.[0]?.instagram_business_account?.id || "me";

                // Step 1: Create media container
                const containerR = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    media_type: "REELS",
                    video_url: latestVideo.video_url,
                    caption: postText,
                    share_to_feed: true,
                    access_token: token.access_token
                  })
                });
                const containerD = await containerR.json();
                if (!containerD.id) { postResults.instagram = { success: false, reason: containerD.error?.message || "Container creation failed", draft: true }; break; }

                // Step 2: Publish the container
                const publishR = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media_publish`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ creation_id: containerD.id, access_token: token.access_token })
                });
                const publishD = await publishR.json();
                postResults.instagram = { success: !!publishD.id, reelId: publishD.id, type: "reel" };
              } else {
                postResults.instagram = { success: false, draft: true, reason: "No video — Instagram requires video for Reels. Caption saved as draft." };
                const { v4: _iguuid } = require("uuid");
                db.prepare("INSERT INTO social_posts (id, user_id, content, platforms, status, created_at) VALUES (?,?,?,?,?,datetime('now'))")
                  .run(_iguuid(), userId, postText, JSON.stringify(["instagram"]), "draft");
              }
              break;
            }

            case "x": {
              const r = await fetch("https://api.twitter.com/2/tweets", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.access_token },
                body: JSON.stringify({ text: postText.substring(0, 280) })
              });
              const d = await r.json();
              postResults.x = { success: !!d.data?.id, tweetId: d.data?.id };
              break;
            }

            case "linkedin": {
              const meR = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: "Bearer " + token.access_token } });
              const me = await meR.json();
              const r = await fetch("https://api.linkedin.com/rest/posts", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.access_token, "X-Restli-Protocol-Version": "2.0.0", "Linkedin-Version": "202401" },
                body: JSON.stringify({ author: "urn:li:person:" + me.sub, commentary: postText, visibility: "PUBLIC", lifecycleState: "PUBLISHED", distribution: { feedDistribution: "MAIN_FEED" } })
              });
              postResults.linkedin = { success: r.status === 201 };
              break;
            }

            case "tiktok": {
              if (!hasVideo) {
                const { v4: _ttuuid } = require("uuid");
                db.prepare("INSERT INTO social_posts (id, user_id, content, platforms, status, created_at) VALUES (?,?,?,?,?,datetime('now'))")
                  .run(_ttuuid(), userId, postText, JSON.stringify(["tiktok"]), "draft");
                postResults.tiktok = { success: false, draft: true, reason: "No video found — caption saved as draft. Generate a video first in Social → Videos." };
                break;
              }
              const r = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.access_token },
                body: JSON.stringify({
                  post_info: { title: postText.substring(0, 150), privacy_level: "PUBLIC_TO_EVERYONE", disable_duet: false, disable_comment: false, disable_stitch: false },
                  source_info: { source: "PULL_FROM_URL", video_url: latestVideo.video_url }
                })
              });
              const d = await r.json();
              if (d.data?.publish_id) {
                postResults.tiktok = { success: true, publishId: d.data.publish_id, videoUrl: latestVideo.video_url };
              } else {
                const { v4: _ttuuid2 } = require("uuid");
                db.prepare("INSERT INTO social_posts (id, user_id, content, platforms, status, created_at) VALUES (?,?,?,?,?,datetime('now'))")
                  .run(_ttuuid2(), userId, postText, JSON.stringify(["tiktok"]), "draft");
                postResults.tiktok = { success: false, draft: true, reason: d.error?.message || "TikTok rejected — saved as draft" };
              }
              break;
            }

            case "youtube": {
              if (!hasVideo) {
                postResults.youtube = { success: false, reason: "No video — YouTube requires video. Generate a video first." };
                break;
              }
              // Upload as YouTube Short (vertical video)
              const gToken = getUserToken(userId, "google");
              if (!gToken) { postResults.youtube = { success: false, reason: "Google account not connected." }; break; }
              const initR = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
                method: "POST",
                headers: { Authorization: `Bearer ${gToken.access_token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  snippet: { title: postText.substring(0, 100) + " #Shorts", description: postText, tags: ["shorts"], categoryId: "22" },
                  status: { privacyStatus: "public", selfDeclaredMadeForKids: false }
                })
              });
              const uploadUrl = initR.headers.get("location");
              if (!uploadUrl) { postResults.youtube = { success: false, reason: "YouTube upload init failed" }; break; }
              const videoRes = await fetch(latestVideo.video_url);
              const videoBuffer = await videoRes.buffer();
              const upR = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/*", "Content-Length": videoBuffer.length }, body: videoBuffer });
              const vid = await upR.json();
              postResults.youtube = { success: !!vid.id, videoId: vid.id, url: vid.id ? `https://youtube.com/shorts/${vid.id}` : null };
              break;
            }

          }
        } catch (e) {
          postResults[token.platform] = { success: false, error: e.message };
        }
      }

      // Save to social_posts table
      const { v4: uuid } = require("uuid");
      db.prepare("INSERT INTO social_posts (id, user_id, content, platforms, status, created_at) VALUES (?,?,?,?,?,datetime('now'))")
        .run(uuid(), userId, draft, JSON.stringify(Object.keys(postResults)), "posted");

      // Log in audit
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(userId, "ai_social_post", JSON.stringify({ platforms: Object.keys(postResults), results: postResults }));

      const successCount = Object.values(postResults).filter(r => r.success).length;
      const draftCount = Object.values(postResults).filter(r => r.draft).length;
      return { generated: true, posted: true, platforms: postResults, successCount, draftCount, totalPlatforms: Object.keys(postResults).length, note: draftCount > 0 ? `${draftCount} platform(s) saved as draft (TikTok requires video — attach one in Social → Drafts)` : undefined };
    }
    case "categorize_transaction": {
      return { categorized: true, category: details.reasoning };
    }
    case "flag_overdue":
    case "send_shipping_info":
    case "update_order": {
      const email = details.data?.email || details.data?.customerEmail;
      if (email && details.draft) {
        await sendEmail(userId, email, "Update on your order", details.draft);
        return { sent: true, to: email };
      }
      return { handled: true, note: details.reasoning };
    }
    case "adjust_ad_budget": {
      // Actually adjust budget via ads route
      if (details.data?.campaignId && details.data?.newBudget) {
        const db = getDb();
        db.prepare("UPDATE ad_campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
          .run(details.data.newBudget, details.data.campaignId, userId);
        return { adjusted: true, campaignId: details.data.campaignId, newBudget: details.data.newBudget };
      }
      return { action: "adjust_ad_budget", note: details.reasoning };
    }
    case "pause_underperforming": {
      // Trigger auto-optimise on all active campaigns
      const db = getDb();
      const campaigns = db.prepare("SELECT id FROM ad_campaigns WHERE user_id = ? AND status = 'active'").all(userId);
      const paused = [];
      for (const camp of campaigns) {
        const creatives = db.prepare("SELECT * FROM ad_creatives WHERE campaign_id = ? AND status = 'active' AND impressions > 100").all(camp.id);
        const avgCTR = creatives.reduce((s, c) => s + (c.impressions > 0 ? c.clicks / c.impressions : 0), 0) / Math.max(creatives.length, 1);
        for (const c of creatives) {
          const ctr = c.impressions > 0 ? c.clicks / c.impressions : 0;
          if (ctr < avgCTR * 0.5) {
            db.prepare("UPDATE ad_creatives SET status = 'paused' WHERE id = ?").run(c.id);
            paused.push(c.headline);
          }
        }
      }
      return { paused: paused.length, headlines: paused, note: details.reasoning };
    }
    case "create_campaign": {
      const db = getDb();
      const { v4: uuid } = require("uuid");
      const id = uuid();
      const platform = details.data?.platform || "meta";
      const campaignName = details.data?.name || "AI-Generated Campaign";
      const budget = details.data?.budget || 20;
      const objective = details.data?.objective || "conversions";

      // Check daily + monthly spend limits before creating
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const monthlySpent = db.prepare("SELECT SUM(total_spent) as total FROM ad_campaigns WHERE user_id = ? AND updated_at >= ?").get(userId, monthStart.toISOString());
      const dailySpent = db.prepare("SELECT SUM(daily_budget) as total FROM ad_campaigns WHERE user_id = ? AND status = 'active' AND name LIKE '[AI]%'").get(userId);

      // Load budget limits
      const budgetLimits = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'ad_budget_limits'").get(userId);
      const limits = budgetLimits?.value ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(budgetLimits.value) : {};
      const aiDailyMax = limits.ai?.daily || 50;
      const aiMonthlyMax = limits.ai?.monthly || 500;

      if ((dailySpent?.total || 0) + budget > aiDailyMax) {
        return { created: false, reason: `AI daily spend limit ($${aiDailyMax}/day) would be exceeded. Current AI daily: $${(dailySpent?.total || 0).toFixed(0)}. Skipping.` };
      }
      if ((monthlySpent?.total || 0) + budget * 30 > aiMonthlyMax) {
        return { created: false, reason: `AI monthly spend limit ($${aiMonthlyMax}/mo) would be exceeded. Current spend: $${(monthlySpent?.total || 0).toFixed(0)}. Skipping.` };
      }

      // Check max active AI campaigns limit
      const empConfig = db.prepare("SELECT rules FROM ai_employees WHERE user_id = ? AND role = 'marketing'").get(userId);
      const empRules = empConfig?.rules ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(empConfig.rules) : {};
      const maxAiCampaigns = parseInt(empRules.maxAiCampaigns) || 3;
      const activeCampaignCount = db.prepare("SELECT COUNT(*) as n FROM ad_campaigns WHERE user_id = ? AND status = 'active' AND name LIKE '[AI]%'").get(userId);
      if ((activeCampaignCount?.n || 0) >= maxAiCampaigns) {
        return { created: false, reason: `Max active AI campaigns (${maxAiCampaigns}) reached. Pause or delete an existing AI campaign first.` };
      }

      // Save campaign to local DB first — tagged as AI-created
      db.prepare(`INSERT INTO ad_campaigns (id, user_id, site_id, platform, name, objective, audience, daily_budget, budget_type, total_spent, status, platform_campaign_id, start_date, end_date, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,datetime('now'),datetime('now'))`)
        .run(id, userId, "", platform, "[AI] " + campaignName, objective, JSON.stringify(details.data?.audience || {}), budget, "daily", "active", "", "", "");

      // Actually push to ad platform API
      let platformResult = { pushed: false };
      const fetch = (await import("node-fetch")).default;

      try {
        if (platform === "meta") {
          const metaToken = getSetting("META_ACCESS_TOKEN");
          const metaAdAccount = getSetting("META_AD_ACCOUNT_ID");
          if (metaToken && metaAdAccount) {
            const r = await fetch(`https://graph.facebook.com/v19.0/act_${metaAdAccount}/campaigns`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: campaignName, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [], access_token: metaToken, daily_budget: Math.round(budget * 100) })
            });
            const d = await r.json();
            if (d.id) {
              db.prepare("UPDATE ad_campaigns SET platform_campaign_id = ?, status = 'active' WHERE id = ?").run(d.id, id);
              platformResult = { pushed: true, platform: "meta", platformCampaignId: d.id };
            }
          }
        } else if (platform === "tiktok") {
          const tiktokToken = getSetting("TIKTOK_ACCESS_TOKEN");
          const tiktokAdv = getSetting("TIKTOK_ADVERTISER_ID");
          if (tiktokToken && tiktokAdv) {
            const r = await fetch("https://business-api.tiktok.com/open_api/v1.3/campaign/create/", {
              method: "POST", headers: { "Access-Token": tiktokToken, "Content-Type": "application/json" },
              body: JSON.stringify({ advertiser_id: tiktokAdv, campaign_name: campaignName, objective_type: "CONVERSIONS", budget_mode: "BUDGET_MODE_DAY", budget: budget })
            });
            const d = await r.json();
            if (d.code === 0 && d.data?.campaign_id) {
              db.prepare("UPDATE ad_campaigns SET platform_campaign_id = ?, status = 'active' WHERE id = ?").run(d.data.campaign_id, id);
              platformResult = { pushed: true, platform: "tiktok", platformCampaignId: d.data.campaign_id };
            }
          }
        } else if (platform === "x") {
          const xToken = getSetting("X_ADS_ACCESS_TOKEN");
          const xAccount = getSetting("X_ADS_ACCOUNT_ID");
          if (xToken && xAccount) {
            const headers = { "Authorization": `Bearer ${xToken}`, "Content-Type": "application/json" };
            // Get funding instrument
            const fundResp = await fetch(`https://ads-api.x.com/12/accounts/${xAccount}/funding_instruments`, { method: "GET", headers });
            const fundData = await fundResp.json();
            const fundingId = fundData.data?.[0]?.id;
            if (fundingId) {
              const r = await fetch(`https://ads-api.x.com/12/accounts/${xAccount}/campaigns`, {
                method: "POST", headers,
                body: JSON.stringify({ funding_instrument_id: fundingId, name: campaignName, objective: "WEBSITE_CLICKS", daily_budget_amount_local_micro: Math.round(budget * 1000000), entity_status: "ACTIVE" })
              });
              const d = await r.json();
              if (d.data?.id) {
                db.prepare("UPDATE ad_campaigns SET platform_campaign_id = ?, status = 'active' WHERE id = ?").run(d.data.id, id);
                platformResult = { pushed: true, platform: "x", platformCampaignId: d.data.id };
              }
            }
          }
        } else if (platform === "linkedin") {
          const liToken = getSetting("LINKEDIN_ACCESS_TOKEN");
          const liAdAccount = getSetting("LINKEDIN_AD_ACCOUNT_ID");
          if (liToken && liAdAccount) {
            const headers = { "Authorization": `Bearer ${liToken}`, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0", "LinkedIn-Version": "202401" };
            const r = await fetch("https://api.linkedin.com/rest/campaigns", {
              method: "POST", headers,
              body: JSON.stringify({ account: `urn:li:sponsoredAccount:${liAdAccount}`, name: campaignName, type: "SPONSORED_UPDATES", objectiveType: "WEBSITE_VISIT", costType: "CPM", dailyBudget: { currencyCode: "USD", amount: String(budget) }, status: "ACTIVE", runSchedule: { start: Date.now() }, locale: { country: "US", language: "en" }, creativeSelection: "OPTIMIZED" })
            });
            const campaignId = r.headers.get("x-restli-id");
            if (campaignId) {
              db.prepare("UPDATE ad_campaigns SET platform_campaign_id = ?, status = 'active' WHERE id = ?").run(campaignId, id);
              platformResult = { pushed: true, platform: "linkedin", platformCampaignId: campaignId };
            }
          }
        } else if (platform === "google") {
          const devToken = getSetting("GOOGLE_ADS_DEVELOPER_TOKEN");
          const customerId = getSetting("GOOGLE_ADS_CUSTOMER_ID");
          const googleToken = getSetting("GOOGLE_ACCESS_TOKEN");
          if (devToken && customerId && googleToken) {
            const headers = { "Authorization": `Bearer ${googleToken}`, "developer-token": devToken, "Content-Type": "application/json" };
            const r = await fetch(`https://googleads.googleapis.com/v16/customers/${customerId}/campaigns:mutate`, {
              method: "POST", headers,
              body: JSON.stringify({ operations: [{ create: { name: campaignName, advertisingChannelType: objective === "video_views" ? "VIDEO" : "SEARCH", status: "ENABLED" } }] })
            });
            const d = await r.json();
            if (d.results?.[0]?.resourceName) {
              db.prepare("UPDATE ad_campaigns SET platform_campaign_id = ?, status = 'active' WHERE id = ?").run(d.results[0].resourceName, id);
              platformResult = { pushed: true, platform: "google", platformCampaignId: d.results[0].resourceName };
            }
          } else {
            platformResult = { pushed: false, platform: "google", note: "Google Ads not configured — add API keys in admin" };
          }
        }
      } catch (e) {
        platformResult = { pushed: false, error: e.message };
      }

      // Generate N creative variants (copy + image each)
      const adVariants = parseInt(empRules?.adVariants) || 2;
      if (details.draft) {
        const draftVariants = details.draft.split("---").map(v => v.trim()).filter(Boolean);
        const createdCreatives = [];
        for (let vi = 0; vi < adVariants; vi++) {
          const variantCopy = draftVariants[vi] || draftVariants[0] || details.draft;
          const creativeId = uuid();
          const headline = variantCopy.split("\n")[0]?.substring(0, 100) || campaignName;
          try {
            db.prepare(`INSERT INTO ad_creatives (id, user_id, campaign_id, headline, body, cta_text, cta_url, platform, status, impressions, clicks, conversions, spend, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,datetime('now'))`)
              .run(creativeId, userId, id, headline, variantCopy.substring(0, 500), "Learn More", "", platform, "active");
            createdCreatives.push(creativeId);
          } catch (e) { /* schema mismatch */ }
          // Generate image for every variant — ads always need images
          const nanoBananaKey = getSetting("GEMINI_API_KEY") || process.env.GEMINI_API_KEY;
          if (nanoBananaKey) {
            try {
              const imgSize = platform === "meta" ? "1080x1080" : platform === "tiktok" ? "1080x1920" : "1200x628";
              const { generateImage } = require("../utils/image-gen");
              const _adImg = await generateImage(
                buildAdImagePrompt(variantCopy.split("\n")[0], variantCopy, platform, campaignName, null),
                { size: imgSize, getSetting }
              );
              if (_adImg) {
                db.prepare("UPDATE ad_creatives SET image_url = ? WHERE id = ?").run(_adImg, creativeId);
              }
            } catch(e) { console.error("[/:id/resolve]", e.message || e); }
          }
        }

        // Generate ad image via NanoBanana
        const nanoBananaKey = getSetting("GEMINI_API_KEY") || process.env.GEMINI_API_KEY;
        if (nanoBananaKey) {
          try {
            const imagePrompt = details.data?.imagePrompt ||
              buildAdImagePrompt(
                details.draft?.split("\n")[0] || campaignName,
                details.draft || "",
                platform,
                campaignName,
                null
              );
            const { generateImage } = require("../utils/image-gen");
            const _adImg = await generateImage(imagePrompt, { size: platform === "meta" ? "1080x1080" : "1200x628", getSetting });
            if (_adImg) {
              db.prepare("UPDATE ad_creatives SET image_url = ? WHERE id = ?")
                .run(_adImg, creativeId);
            }
          } catch(imgErr) { /* image gen failed — creative still saved with copy */ }
        }
      }

      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(userId, "ai_campaign_created", JSON.stringify({ campaignId: id, platform, platformResult }));

      // ── Intelligent video ad decision engine ──────────────────────────────────
      // Analyses 6 signals to decide whether to spend on a HeyGen UGC video ($3 for 15s).
      // Never fires blindly — every decision is logged with reasoning.
      const mktConfig = db.prepare("SELECT rules FROM ai_employees WHERE user_id = ? AND role = 'marketing'").get(userId);
      const mktRules = mktConfig?.rules ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(mktConfig.rules) : {};

      // Only consider video if user hasn't explicitly disabled it
      if (mktRules.autoVideoAds !== false) {
        try {
          const userRow = db.prepare("SELECT stripe_customer_id, email, business_name, name FROM users WHERE id = ?").get(userId);

          // ── SIGNAL 1: Platform suitability ──────────────────────────────────
          // TikTok and Instagram Reels demand video. Google Search never needs it.
          // Meta Feed is mixed — worth testing video. LinkedIn rarely benefits.
          const platformVideoScore = {
            tiktok:    1.0,  // video is the only format that works
            instagram: 0.9,  // Reels dominate; static underperforms significantly
            meta:      0.7,  // video outperforms static ~60% of the time on feed
            facebook:  0.6,  // older demographic, static still competitive
            youtube:   0.8,  // obviously video
            google:    0.1,  // search ads are text links -- video irrelevant
            linkedin:  0.2,  // professional reading mode; static sponsored posts win
          }[platform] ?? 0.5;

          // ── SIGNAL 2: Objective suitability ─────────────────────────────────
          // Awareness and engagement campaigns get massive lift from video.
          // Pure conversion/search campaigns see less difference.
          const objectiveVideoScore = {
            awareness:   1.0,  // video dominates for reach and brand recall
            engagement:  0.9,  // video drives shares and comments far better
            video_views: 1.0,  // obviously
            retargeting: 0.8,  // UGC testimonial converts well for warm audiences
            leads:       0.55, // cold lead gen: static offer with clear CTA often wins
            conversions: 0.4,  // cold conversions: static gets to the offer quicker
            traffic:     0.5,  // neutral -- both formats perform similarly
          }[objective] ?? 0.5;

          // ── SIGNAL 3: Past video vs static performance ───────────────────────
          // If previous video ads for this user outperformed static, lean into video.
          let videoPerformanceScore = 0.5; // neutral default — no history
          try {
            const videoCreatives = db.prepare(`
              SELECT AVG(CAST(clicks AS REAL) / NULLIF(impressions, 0)) as avg_ctr
              FROM ad_creatives
              WHERE user_id = ? AND video_provider IS NOT NULL
              AND impressions > 100 AND status != 'paused'
            `).get(userId);
            const staticCreatives = db.prepare(`
              SELECT AVG(CAST(clicks AS REAL) / NULLIF(impressions, 0)) as avg_ctr
              FROM ad_creatives
              WHERE user_id = ? AND (video_provider IS NULL OR video_provider = '')
              AND impressions > 100 AND status != 'paused'
            `).get(userId);

            const videoCTR  = parseFloat(videoCreatives?.avg_ctr  || 0);
            const staticCTR = parseFloat(staticCreatives?.avg_ctr || 0);

            if (videoCTR > 0 && staticCTR > 0) {
              // Video beats static by more than 20% → strong signal to use video
              const ratio = videoCTR / staticCTR;
              if (ratio > 1.5)      videoPerformanceScore = 1.0;
              else if (ratio > 1.2) videoPerformanceScore = 0.8;
              else if (ratio > 0.9) videoPerformanceScore = 0.6;
              else                  videoPerformanceScore = 0.3; // static is winning — don't add video
            } else if (videoCTR > 0) {
              // Have video data but no static comparison — video is working, keep going
              videoPerformanceScore = 0.75;
            }
          } catch(_) {}

          // ── SIGNAL 4: Budget sanity check ────────────────────────────────────
          // Video cost vs monthly campaign budget. Don't spend on paid video for tiny budgets.
          const monthlyBudget = parseFloat(budget || 0) * 30;
          const budgetScore = monthlyBudget <= 0   ? 0
            : monthlyBudget < 100  ? 0    // <$3.30/day -- video too large a share of budget
            : monthlyBudget < 150  ? 0.4  // marginal -- video is one-time so still possible
            : monthlyBudget < 300  ? 0.6  // reasonable ROI on a one-time paid video
            : monthlyBudget < 600  ? 0.8  // good fit
            :                        1.0;  // large budget -- video is low risk

          // ── SIGNAL 5: Recency — don't spam videos ────────────────────────────
          // If a video ad was created for this user in the last 7 days, hold off.
          let recencyScore = 1.0;
          try {
            const recentVideo = db.prepare(`
              SELECT id FROM ad_creatives
              WHERE user_id = ? AND video_provider IS NOT NULL
              AND datetime(created_at) > datetime('now', '-7 days')
            `).get(userId);
            if (recentVideo) recencyScore = 0.2; // already made one recently
          } catch(_) {}

          // ── SIGNAL 6: Current static CTR health ─────────────────────────────
          // If existing static ads are performing well (CTR > 2%), don't fix what isn't broken.
          // If static is underperforming (CTR < 0.5%), video is more urgent.
          let staticHealthScore = 0.5;
          try {
            const currentCampaignCreatives = db.prepare(`
              SELECT AVG(CAST(clicks AS REAL) / NULLIF(impressions, 0)) as avg_ctr
              FROM ad_creatives WHERE user_id = ? AND impressions > 50
              AND (video_provider IS NULL OR video_provider = '')
            `).get(userId);
            const currentCTR = parseFloat(currentCampaignCreatives?.avg_ctr || 0);
            if (currentCTR > 0.02)      staticHealthScore = 0.2; // static working great — no urgency
            else if (currentCTR > 0.01) staticHealthScore = 0.5; // average
            else if (currentCTR > 0)    staticHealthScore = 0.8; // underperforming — try video
            else                        staticHealthScore = 0.6; // no data — slight lean toward video
          } catch(_) {}

          // ── COMPOSITE SCORE ─────────────────────────────────────────────────
          // Weighted average across all 6 signals.
          // Threshold: score must be >= 0.65 to justify spending $49.
          const weights = {
            platform:    0.25,  // most important — platform determines format needs
            objective:   0.20,  // second — campaign goal shapes creative format
            performance: 0.20,  // historical proof of what works for this account
            budget:      0.20,  // financial sanity check
            recency:     0.10,  // avoid video spam
            staticHealth: 0.05, // tiebreaker
          };
          const compositeScore =
            (platformVideoScore    * weights.platform)   +
            (objectiveVideoScore   * weights.objective)  +
            (videoPerformanceScore * weights.performance) +
            (budgetScore           * weights.budget)     +
            (recencyScore          * weights.recency)    +
            (staticHealthScore     * weights.staticHealth);

          const VIDEO_THRESHOLD = 0.65;
          const shouldMakeVideo  = compositeScore >= VIDEO_THRESHOLD;

          // Build decision reasoning for audit log
          const decisionReasoning = {
            compositeScore: Math.round(compositeScore * 100) / 100,
            threshold: VIDEO_THRESHOLD,
            decision: shouldMakeVideo ? "CREATE_VIDEO" : "SKIP_VIDEO",
            signals: {
              platform:    { score: platformVideoScore,    weight: weights.platform,    note: `${platform} — ${platformVideoScore >= 0.8 ? "video-first platform" : platformVideoScore >= 0.5 ? "video helps" : "video rarely needed"}` },
              objective:   { score: objectiveVideoScore,   weight: weights.objective,   note: `${objective} — ${objectiveVideoScore >= 0.8 ? "video maximises reach" : "static competitive"}` },
              performance: { score: videoPerformanceScore, weight: weights.performance, note: videoPerformanceScore === 0.5 ? "no historical data" : videoPerformanceScore > 0.6 ? "video outperforming static" : "static outperforming video" },
              budget:      { score: budgetScore,           weight: weights.budget,      note: `$${monthlyBudget.toFixed(0)}/mo budget — ${budgetScore >= 0.8 ? "video cost justified" : budgetScore < 0.3 ? "budget too small for paid video" : "marginal"}` },
              recency:     { score: recencyScore,          weight: weights.recency,     note: recencyScore < 0.5 ? "video created recently — spacing out" : "no recent video" },
              staticHealth:{ score: staticHealthScore,     weight: weights.staticHealth, note: staticHealthScore <= 0.2 ? "static CTR strong — no urgency" : staticHealthScore >= 0.8 ? "static underperforming — try video" : "average static performance" },
            },
          };

          // Log the decision regardless of outcome
          db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
            .run(userId, "video_ad_decision", JSON.stringify({ campaignId: id, ...decisionReasoning }));

          if (shouldMakeVideo) {
            // ── Card check — needs Stripe customer ──────────────────────────
            const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
            if (!stripeKey || !userRow?.stripe_customer_id) {
              db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
                .run(userId, "video_ad_skipped", JSON.stringify({ reason: "no_payment_method", campaignId: id }));
            } else {
              // ── Charge for HeyGen video (15s default = $3.75 at $0.25/sec) ──
              // Covers HeyGen cost ($0.05/sec = $0.75) with healthy markup.
              // Stripe's $0.30 flat fee still leaves positive margin.
              const AUTO_VIDEO_SECS = 15;
              const AUTO_VIDEO_CHARGE = Math.max(1.00, AUTO_VIDEO_SECS * 0.25); // $3.75
              let chargeOk = false;
              let paymentIntentId = null;
              // ─── Subscription gate ─────────────────────────────────────────
              // Marketing Manager must be hired before it can take expensive
              // actions like generating video ads.
              const _mktmgrHired = (typeof global.mineRequireHired !== "function") ||
                                   global.mineRequireHired(db, userId, "marketing");
              if (!_mktmgrHired) {
                console.log(`[MktMgr] skipped video for ${userId} — AI Marketing Manager not hired`);
              } else if (typeof global.mineIsAdmin === "function" && global.mineIsAdmin(db, userId)) {
                // Admin bypass: video gets made without charging
                chargeOk = true;
                paymentIntentId = "admin_free_mktmgr_" + Date.now();
              } else { try {
                const stripe = require("stripe")(stripeKey);
                const idemKey = `mktmgr_video_${userId}_${id}_${new Date().toISOString().slice(0,10)}`;
                const pi = await stripe.paymentIntents.create({
                  amount: Math.round(AUTO_VIDEO_CHARGE * 100), currency: "usd",
                  customer: userRow.stripe_customer_id,
                  payment_method_types: ["card"], confirm: true, off_session: true,
                  description: `MINE Auto Video Ad (HeyGen ${AUTO_VIDEO_SECS}s) — ${campaignName} [score: ${compositeScore.toFixed(2)}]`,
                  metadata: { user_id: userId, campaign_id: id, composite_score: String(compositeScore.toFixed(2)), platform, objective, duration_sec: String(AUTO_VIDEO_SECS) }
                }, { idempotencyKey: idemKey });
                if (pi.status === "succeeded") { chargeOk = true; paymentIntentId = pi.id; }
              } catch(stripeErr) {
                console.warn("[MktMgr video charge]", stripeErr.message);
              }

              if (chargeOk) {
                // ── Build Claude-written UGC script ──────────────────────────
                const anthropicKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
                const product = details.data?.products?.[0] || details.data?.product;
                const bizName = userRow?.business_name || userRow?.name || "our business";
                let script = "";

                if (anthropicKey) {
                  try {
                    const Anthropic = require("@anthropic-ai/sdk");
                    const claude = new Anthropic({ apiKey: anthropicKey });
                    const scriptPrompt = objective === "retargeting"
                      ? `Write a 30-second UGC video ad script for someone who already visited ${bizName}'s website but didn't buy. ${product ? `Product: ${product.name}, $${product.price}.` : ""} Warm, personal testimonial style. Hook → social proof → urgency CTA. Under 80 words. Just the script.`
                      : `Write a 30-second UGC video ad script for ${bizName}. ${product ? `Feature: ${product.name} ($${product.price}). ${product.desc ? product.desc.substring(0, 80) : ""}` : ""} Platform: ${platform}. Goal: ${objective}. Natural talking-head style. Hook → problem → solution → CTA. Under 80 words. Just the script, no stage directions.`;
                    const sr = await claude.messages.create({
                      model: "claude-sonnet-4-6", max_tokens: 200,
                      messages: [{ role: "user", content: scriptPrompt }]
                    });
                    script = sr.content[0]?.text || "";
                  } catch(_) {}
                }

                // Fallback script if Claude fails
                if (!script) {
                  script = product
                    ? `Okay I have to tell you about ${product.name} from ${bizName}. I've been using it for a while now and honestly? ${product.desc ? product.desc.substring(0, 80) : "The results are incredible"}. And it's only $${product.price}. Link in bio — you need to check this out.`
                    : `I want to talk about ${bizName} because honestly more people need to know about this. Whether you're looking for quality, value, or just something that actually works — this is it. Click the link and see for yourself.`;
                }

                // ── Call HeyGen (replaced Arcads) ─────────────────────────────
                const heygenKey = getSetting("HEYGEN_API_KEY") || process.env.HEYGEN_API_KEY;
                if (heygenKey) {
                  const fetch = (await import("node-fetch")).default;
                  // HeyGen v2 create video endpoint
                  const heygenRes = await fetch("https://api.heygen.com/v2/video/generate", {
                    method: "POST",
                    headers: { "X-Api-Key": heygenKey, "Content-Type": "application/json" },
                    body: JSON.stringify({
                      video_inputs: [{
                        character: { type: "avatar", avatar_id: "Daisy-inskirt-20220818", avatar_style: "normal" },
                        voice: { type: "text", input_text: script.substring(0, 1000), voice_id: "2d5b0e6cf36f460aa7fc47e3eee4ba54" },
                        background: { type: "color", value: "#ffffff" },
                      }],
                      dimension: { width: 720, height: 1280 },
                      test: false,
                    })
                  });
                  const heygenData = await heygenRes.json();
                  const taskId = heygenData.data?.video_id || heygenData.video_id;

                  if (taskId) {
                    const { v4: cuuid } = require("uuid");
                    const creativeId = cuuid();
                    db.prepare(`INSERT INTO ad_creatives
                      (id, user_id, campaign_id, headline, body, cta_text, platform, status, video_task_id, video_provider, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
                      .run(creativeId, userId, id,
                        `[AI Video] ${product?.name || bizName}`,
                        script.substring(0, 500),
                        objective === "leads" ? "Get Started" : objective === "retargeting" ? "Buy Now" : "Learn More",
                        platform, "rendering", taskId, "heygen");

                    db.prepare(`INSERT OR IGNORE INTO pending_video_tasks
                      (id, user_id, campaign_id, creative_id, task_id, provider, created_at)
                      VALUES (?,?,?,?,?,?,datetime('now'))`)
                      .run(cuuid(), userId, id, creativeId, taskId, "heygen");

                    db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
                      .run(userId, "auto_video_ad_queued", JSON.stringify({
                        campaignId: id, creativeId, taskId, cost: AUTO_VIDEO_CHARGE, duration_sec: AUTO_VIDEO_SECS,
                        paymentIntentId, compositeScore: compositeScore.toFixed(2),
                        reason: `Score ${compositeScore.toFixed(2)} >= threshold ${VIDEO_THRESHOLD}`
                      }));

                    // Notify user why video was created
                    try {
                      db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
                        .run(cuuid(), userId, "🎬",
                          `Marketing Manager created a ${AUTO_VIDEO_SECS}s video ad for "${campaignName}" — ${platform} + ${objective} score ${Math.round(compositeScore * 100)}% confidence. $${AUTO_VIDEO_CHARGE.toFixed(2)} charged.`,
                          "Just now");
                    } catch(_) {}
                  }
                }
              }
              }
            }
          } else {
            // Log why video was skipped so user can see the reasoning
            try {
              const { v4: skipUuid } = require("uuid");
              db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
                .run(skipUuid(), userId, "📊",
                  `Marketing Manager skipped video ad for "${campaignName}" — confidence ${Math.round(compositeScore * 100)}% (need 65%). ${Object.entries(decisionReasoning.signals).map(([k,v]) => `${k}: ${Math.round(v.score*100)}%`).join(", ")}.`,
                  "Just now");
            } catch(_) {}
          }
        } catch(videoErr) {
          console.warn("[MktMgr video decision]", videoErr.message);
          // Non-fatal — campaign was still created
        }
      }

      return { created: true, campaignId: id, platform, platformResult, note: details.reasoning };
    }
    case "ab_test_copy": {
      // Generate new creative variants based on AI draft
      const db = getDb();
      const { v4: uuid } = require("uuid");
      if (details.draft) {
        const variants = details.draft.split("---").map(v => v.trim()).filter(Boolean);
        const createdIds = [];
        for (const variant of variants.slice(0, 3)) {
          const cid = uuid();
          const headline = variant.split("\n")[0]?.substring(0, 100) || "AI Variant";
          try {
            db.prepare(`INSERT INTO ad_creatives (id, user_id, campaign_id, headline, body, cta_text, platform, status, impressions, clicks, conversions, spend, created_at)
              VALUES (?,?,?,?,?,?,?,?,0,0,0,0,datetime('now'))`)
              .run(cid, userId, details.data?.campaignId || "", headline, variant.substring(0, 500), "Shop Now", details.data?.platform || "meta", "active");
            createdIds.push(cid);
          } catch (e) { /* schema mismatch */ }
        }
        return { generated: true, variantsCreated: createdIds.length, note: details.reasoning };
      }
      return { generated: true, note: details.reasoning, hint: "No draft provided for variants" };
    }
    case "chase_unsigned_contract": {
      // Send a follow-up email to a client about an unsigned contract
      const { client_email, client_name, title, contractId, sent_days_ago, amount } = details.data || details;
      if (!client_email) return { sent: false, reason: "No client email" };
      try {
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
        const bizName = user?.business_name || user?.name || "us";
        const firstName = (client_name || "there").split(" ")[0];
        await sendEmail(userId, client_email,
          `Quick reminder — ${title || "your contract"} is waiting for your signature`,
          `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="font-size:18px;font-weight:800;margin-bottom:8px">Hi ${firstName} 👋</h2>
            <p style="color:#475569;line-height:1.7">Just a friendly reminder that your ${title || "contract"} with ${bizName} has been waiting for your signature for ${sent_days_ago || 7} days.</p>
            ${amount ? `<p style="color:#475569">Contract value: <strong>$${amount}</strong></p>` : ""}
            <p style="color:#475569;line-height:1.7">If you have any questions or need changes, just reply to this email — we're happy to help.</p>
            <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}/sign/${contractId}" style="display:inline-block;background:#2563EB;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;margin-top:8px">Review & Sign →</a>
          </div>`
        );
        return { sent: true, to: client_email, contractId };
      } catch(e) { return { sent: false, error: e.message }; }
    }
    case "draft_contract_for_booking": {
      // Auto-draft a service agreement for a new high-value booking
      const { client_name, client_email, service, amount, bookingId } = details.data || details;
      if (!client_email) return { drafted: false, reason: "No client email" };
      try {
        const anthropicKey = getSetting("ANTHROPIC_API_KEY");
        if (!anthropicKey) return { drafted: false, reason: "No AI key" };
        const fetch = (await import("node-fetch")).default;
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6", max_tokens: 2500,
            messages: [{ role: "user", content: `Draft a professional service agreement for this booking.
Service: ${service || "professional services"}
Client: ${client_name || "Client"}
Amount: $${amount || "TBD"}
Include: parties, scope, payment terms, cancellation policy, IP ownership, limitation of liability, signatures.
Write in clear professional language with [brackets] for specific details.` }]
          })
        });
        const d = await r.json();
        const content = d.content?.[0]?.text || "";
        if (content) {
          const { v4: uid } = require("uuid");
          const contractId = uid();
          db.prepare(`INSERT INTO contracts (id, user_id, client_name, client_email, title, content, template, amount, status, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
            .run(contractId, userId, client_name || "", client_email || "",
              `Service Agreement — ${service || "Booking"}`, content, "service", amount || 0, "draft");
          return { drafted: true, contractId, client_email, note: "Draft saved to Contracts tab — review before sending" };
        }
      } catch(e) { return { drafted: false, error: e.message }; }
      return { drafted: false, reason: "Generation failed" };
    }
    case "flag_expiring_contract": {
      // Notify the business owner about contracts expiring soon
      const { contracts: expiring } = details.data || details;
      if (!expiring?.length) return { notified: false };
      try {
        const user = db.prepare("SELECT email, business_name, name FROM users WHERE id = ?").get(userId);
        if (user?.email) {
          await sendEmail(userId, user.email,
            `⚠️ ${expiring.length} contract${expiring.length > 1 ? "s" : ""} expiring soon`,
            `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
              <h2 style="font-size:18px;font-weight:800;margin-bottom:12px">Contracts expiring in the next 30 days</h2>
              ${expiring.map(c => `<div style="padding:12px;background:#FEF3C7;border-radius:8px;margin-bottom:8px">
                <strong>${c.title}</strong> — ${c.client_name}<br>
                <span style="color:#92400E;font-size:13px">Expires: ${c.end_date}</span>
              </div>`).join("")}
              <p style="color:#475569;margin-top:16px">Log in to MINE to renew or renegotiate these contracts.</p>
            </div>`
          );
        }
        return { notified: true, count: expiring.length };
      } catch(e) { return { notified: false, error: e.message }; }
    }
    case "weekly_legal_digest": {
      // Send weekly contract summary to business owner
      const { stats } = details.data || details;
      try {
        const user = db.prepare("SELECT email, business_name, name FROM users WHERE id = ?").get(userId);
        if (user?.email && stats) {
          const bizName = user.business_name || user.name || "your business";
          await sendEmail(userId, user.email,
            `⚖️ Weekly legal summary — ${bizName}`,
            `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
              <h2 style="font-size:18px;font-weight:800;margin-bottom:16px">⚖️ Weekly contract summary</h2>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
                <div style="padding:16px;background:#F0F9FF;border-radius:10px;text-align:center">
                  <div style="font-size:28px;font-weight:900;color:#0369A1">${stats.signed_this_month}</div>
                  <div style="font-size:12px;color:#0369A1">Signed this month</div>
                </div>
                <div style="padding:16px;background:${stats.unsigned > 0 ? "#FEF9C3" : "#F0FDF4"};border-radius:10px;text-align:center">
                  <div style="font-size:28px;font-weight:900;color:${stats.unsigned > 0 ? "#92400E" : "#166534"}">${stats.unsigned}</div>
                  <div style="font-size:12px;color:${stats.unsigned > 0 ? "#92400E" : "#166534"}">${stats.unsigned > 0 ? "Awaiting signature" : "Nothing unsigned"}</div>
                </div>
              </div>
              <p style="color:#475569">Value secured this month: <strong>$${(stats.value_secured || 0).toFixed(2)}</strong></p>
            </div>`
          );
        }
        return { sent: true };
      } catch(e) { return { sent: false, error: e.message }; }
    }
    case "reply_review": {
      // ── Review Response Generator Orchestra ─────────────────────────────────
      // 3-agent chain: ANALYZER → DRAFTER → VALIDATOR → PUBLISHER
      const reviews = details.data?.reviews || [];
      if (!reviews.length) return { published: 0 };

      const anthropicKey = getSetting("ANTHROPIC_API_KEY");
      if (!anthropicKey) return { published: 0, reason: "No AI key" };

      const empRow = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND role = 'marketing'").get(userId);
      const brandVoice = empRow?.brand_voice || "professional, warm and genuine";

      async function rvClaude(system, user, maxTok = 300) {
        const fetch = (await import("node-fetch")).default;
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTok, temperature: 0, system, messages: [{ role: "user", content: user }] })
        });
        const d = await r.json();
        return d.content?.[0]?.text || "";
      }

      const published = [];
      for (const review of reviews.slice(0, 5)) {
        try {
          // AGENT 1: ANALYZER — sentiment, complaints, flags
          const analysisRaw = await rvClaude(
            `Analyze this customer review. Respond ONLY in JSON:
{"sentiment":"positive|neutral|negative","rating":${review.rating || "null"},"main_praise":"or null","main_complaint":"or null","mentions_refund":false,"mentions_legal":false,"escalate":false,"response_tone":"appreciative|apologetic|reassuring|celebratory"}`,
            `Review: "${review.text}" Rating: ${review.rating}/5`
          );
          let analysis = { sentiment: "neutral", escalate: false, response_tone: "appreciative" };
          try { analysis = { ...analysis, ...JSON.parse(analysisRaw) }; } catch(e) {}

          if (analysis.escalate || analysis.mentions_legal) {
            db.prepare("UPDATE reviews SET flag_for_human = 1 WHERE id = ? AND user_id = ?")
              .run(review.id, userId);
            continue;
          }

          // AGENT 2: DRAFTER — write brand-voice response
          const draft = await rvClaude(
            `Write a response to this ${review.rating}-star review. Brand voice: ${brandVoice}.
Tone should be: ${analysis.response_tone}.
Rules: Thank them by name if known. Max 80 words. No generic boilerplate.
${analysis.main_complaint ? "Address the complaint: " + analysis.main_complaint : ""}
${analysis.main_praise ? "Acknowledge the praise: " + analysis.main_praise : ""}
Never offer refunds in a public response. Be genuine not corporate.`,
            `Review by ${review.reviewer_name || "customer"}: "${review.text}"`
          , 200);

          // AGENT 3: VALIDATOR — final check before publishing
          const validRaw = await rvClaude(
            `Validate this review response. Check: under 100 words, no refund promises, no defensive language, sounds human not robotic, appropriate for public platform.
Respond ONLY in JSON: {"approved":true,"issues":[],"final":"same text if approved or corrected"}`,
            `Response draft: "${draft}"
Original review: "${review.text}"`
          , 300);
          let finalReply = draft;
          try {
            const v = JSON.parse(validRaw);
            if (v.final) finalReply = v.final;
          } catch(e) {}

          // AGENT 4: PUBLISHER — save reply to DB
          db.prepare("UPDATE reviews SET reply = ?, reply_at = datetime('now'), reply_by = 'ai_marketing' WHERE id = ? AND user_id = ?")
            .run(finalReply, review.id, userId);
          published.push({ id: review.id, reviewer: review.reviewer_name, rating: review.rating, reply: finalReply });
        } catch(e) { /* skip failed review, continue with others */ }
      }
      return { published: published.length, reviews: published };
    }
    case "generate_report":
    case "forecast":
    case "reconcile": {
      return { generated: true, report: details.draft || details.reasoning };
    }
    case "analyze_performance":
    case "suggest_content":
    case "reply_comment": {
      // Actually reply to the comment via platform API
      const commentId  = details.commentId || details.comment_id;
      const replyText  = details.draft || details.reply || details.reasoning || '';
      const platform   = details.platform || 'meta';
      if (!commentId || !replyText) return { completed: false, reason: 'Missing commentId or reply text' };

      const tokens = getDb().prepare("SELECT platform, access_token FROM user_social_tokens WHERE user_id=?").all(userId);
      const tok = tokens.find(t => t.platform === platform || (platform === 'instagram' && t.platform === 'meta'));
      if (!tok) return { completed: false, reason: `No ${platform} account connected` };

      const fetch3 = (await import('node-fetch')).default;
      try {
        if (platform === 'meta' || platform === 'instagram' || platform === 'facebook') {
          const r = await fetch3(`https://graph.facebook.com/v19.0/${commentId}/replies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: replyText, access_token: tok.access_token })
          });
          const d = await r.json();
          return { completed: !!d.id, replyId: d.id, platform, error: d.error?.message };
        } else if (platform === 'x' || platform === 'twitter') {
          // Reply to tweet
          const r = await fetch3('https://api.twitter.com/2/tweets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.access_token },
            body: JSON.stringify({ text: replyText.substring(0, 280), reply: { in_reply_to_tweet_id: commentId } })
          });
          const d = await r.json();
          return { completed: !!d.data?.id, tweetId: d.data?.id, platform };
        } else if (platform === 'linkedin') {
          const r = await fetch3('https://api.linkedin.com/rest/socialActions/' + commentId + '/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.access_token, 'Linkedin-Version': '202401', 'X-Restli-Protocol-Version': '2.0.0' },
            body: JSON.stringify({ message: { text: replyText } })
          });
          return { completed: r.status === 201, platform };
        }
      } catch(e) {
        return { completed: false, reason: e.message };
      }
      return { completed: false, reason: 'Unsupported platform: ' + platform };
    }
    case "reply_reddit_thread":
    case "reply_x_post":
    case "log_engagement": {
      // ── Community Engagement Agent — multi-platform reply engine ────────────
      // Check communityReplies cap before posting anything
      if (typeof global !== "undefined" && global.mineCheckUsage) {
        const usage = global.mineCheckUsage(db, userId, "communityReplies");
        if (usage.blocked) {
          return { replied: 0, reason: "Community reply limit reached for your plan. Pro: 300/mo, Enterprise: 750/mo. Overage: $0.10/reply." };
        }
      }
      const platform   = action.action === "reply_reddit_thread" ? "reddit" : "x";
      const posts      = details.data?.posts || [];
      const keywords   = details.data?.keywords || [];
      const businessName = details.data?.business?.name || "our business";
      const siteUrl    = details.data?.business?.url || "";
      const replyStyle = details.data?.replyStyle || "helpful";
      const includePromo = details.data?.includePromotion !== false;
      const alreadyReplied = details.data?.recentReplies || [];
      const maxReplies = details.data?.maxRepliesPerRun || 5;
      const anthropicKey = getSetting("ANTHROPIC_API_KEY");
      if (!anthropicKey || !posts.length) return { replied: 0, reason: "No posts or AI key" };

      const fetch   = (await import("node-fetch")).default;
      const replied = [];
      const skipped = [];

      for (const post of posts.slice(0, maxReplies)) {
        if (alreadyReplied.includes(post.id)) { skipped.push(post.id); continue; }

        try {
          // ── AGENT 1: RELEVANCE CHECK ──────────────────────────────────────
          const relevanceRaw = await (async () => {
            const r = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "claude-sonnet-4-6", max_tokens: 150,
        temperature: 0,
                system: "You are a relevance checker. Is this post a good opportunity to add genuine value and naturally mention a business? Respond ONLY in JSON: {relevant:true/false, reason:string, angle:string}",
                messages: [{ role: "user", content: `Business: ${businessName}. Keywords: ${keywords.join(", ")}.
Post title: "${post.title}"
Post content: "${(post.content||"").substring(0,300)}"` }]
              })
            });
            return (await r.json()).content?.[0]?.text || "{}";
          })();

          let relevance = { relevant: false };
          try { relevance = JSON.parse(relevanceRaw); } catch(e) {}
          if (!relevance.relevant) { skipped.push(post.id); continue; }

          // ── AGENT 2: REPLY WRITER ────────────────────────────────────────
          const replyRaw = await (async () => {
            const r = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "claude-sonnet-4-6", max_tokens: 300,
                system: `You write ${platform === "reddit" ? "Reddit" : "X/Twitter"} replies that add genuine value first.
Style: ${replyStyle}. Business: ${businessName}. ${siteUrl ? "Site: " + siteUrl : ""}
Rules:
- Lead with genuinely helpful information (2-3 sentences)
- ${includePromo ? `Naturally mention ${businessName} only if directly relevant — never forced` : "Do NOT mention the business"}
- Match the tone of the platform (${platform === "reddit" ? "conversational, detailed, no hype" : "punchy, max 280 chars, no hashtag spam"})
- NEVER sound like an ad. Sound like a knowledgeable person.
- No "Check out our site!" type language
${platform === "x" ? "- Keep under 250 characters" : "- 2-4 sentences max"}`,
                messages: [{ role: "user", content: `Angle: ${relevance.angle}
Post: "${post.title}" — "${(post.content||"").substring(0,200)}"` }]
              })
            });
            return (await r.json()).content?.[0]?.text || "";
          })();

          if (!replyRaw.trim()) continue;

          // ── AGENT 3: SAFETY VALIDATOR ────────────────────────────────────
          const safeRaw = await (async () => {
            const r = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "claude-sonnet-4-6", max_tokens: 100,
        temperature: 0,
                system: "Check if this reply is appropriate for posting. Reject if: sounds spammy, overly promotional, off-topic, too long for platform. Respond ONLY in JSON: {safe:true/false, reason:string}",
                messages: [{ role: "user", content: `Platform: ${platform}
Reply: "${replyRaw}"` }]
              })
            });
            return (await r.json()).content?.[0]?.text || '{"safe":true}';
          })();

          let safety = { safe: true };
          try { safety = JSON.parse(safeRaw); } catch(e) {}
          if (!safety.safe) { skipped.push(post.id); continue; }

          // ── AGENT 4: POST TO PLATFORM ────────────────────────────────────
          let posted = false;
          let postError = "";

          if (platform === "reddit") {
            const redditToken = await getValidRedditToken(userId);
            if (redditToken) {
              try {
                const postResp = await fetch("https://oauth.reddit.com/api/comment", {
                  method: "POST",
                  headers: {
                    "Authorization": `Bearer ${redditToken}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "MINE:CommunityAgent:1.0"
                  },
                  body: new URLSearchParams({ api_type: "json", text: replyRaw, thing_id: post.id })
                });
                const postData = await postResp.json();
                posted = !postData.json?.errors?.length;
                if (!posted) postError = JSON.stringify(postData.json?.errors || []);
              } catch(e) { postError = e.message; }
            } else {
              // No creds — log as draft
              posted = false; postError = "Reddit credentials not configured";
            }
          } else if (platform === "x") {
            const xToken = getSetting("X_API_KEY") || getSetting("X_ACCESS_TOKEN");
            if (xToken && post.x_tweet_id) {
              try {
                const tweetResp = await fetch("https://api.twitter.com/2/tweets", {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${xToken}`, "Content-Type": "application/json" },
                  body: JSON.stringify({ text: replyRaw.substring(0, 280), reply: { in_reply_to_tweet_id: post.x_tweet_id } })
                });
                const tweetData = await tweetResp.json();
                posted = !!tweetData.data?.id;
                if (!posted) postError = JSON.stringify(tweetData.errors || []);
              } catch(e) { postError = e.message; }
            } else {
              posted = false; postError = "X credentials not configured";
            }
          }

          // Track usage against communityReplies cap
          if (posted && typeof global !== "undefined" && global.mineTrackUsage) {
            global.mineTrackUsage(db, userId, "communityReplies");
          }

          // Log the engagement regardless of whether it posted
          try {
            db.exec(`CREATE TABLE IF NOT EXISTS community_replies (
              id TEXT PRIMARY KEY, user_id TEXT, platform TEXT,
              external_post_id TEXT, post_title TEXT, subreddit TEXT,
              reply_text TEXT, posted INTEGER DEFAULT 0, post_error TEXT,
              created_at TEXT DEFAULT (datetime('now'))
            )`);
            db.prepare("INSERT INTO community_replies (id, user_id, platform, external_post_id, post_title, subreddit, reply_text, posted, post_error) VALUES (?,?,?,?,?,?,?,?,?)")
              .run(require("uuid").v4(), userId, platform, post.id, post.title || "", post.subreddit || "", replyRaw, posted ? 1 : 0, postError);
          } catch(e) {}

          replied.push({ id: post.id, title: post.title, platform, posted, reply: replyRaw.substring(0, 100) });
        } catch(e) { skipped.push(post.id); }
      }

      return { replied: replied.length, skipped: skipped.length, posts: replied };
    }


    // ─────────────────────────────────────────────────────────────────────────
    // SOCIAL MANAGER — AI image generation for posts
    // ─────────────────────────────────────────────────────────────────────────
    case "generate_post_image": {
      const { prompt, postId } = details.data || {};
      if (!prompt) return { generated: false, reason: "No prompt" };
      const anthropicKey = getSetting("ANTHROPIC_API_KEY");
      if (!anthropicKey) return { generated: false, reason: "No Anthropic key" };
      try {
        // Use Claude to enhance the image prompt then call image gen
        const Anthropic = require("@anthropic-ai/sdk");
        const claude = new Anthropic({ apiKey: anthropicKey });
        const pr = await claude.messages.create({
          model: "claude-sonnet-4-6", max_tokens: 150,
          messages: [{ role: "user", content: `Write a detailed image generation prompt for a social media post about: "${prompt}". Professional, vibrant, brand-appropriate. Max 60 words.` }]
        });
        const imagePrompt = pr.content[0]?.text || prompt;
        // Try NanoBanana image gen (already configured for ads)
        const nanoBananaKey = getSetting("GEMINI_API_KEY") || process.env.GEMINI_API_KEY;
        if (nanoBananaKey) {
          const { generateImage } = require("../utils/image-gen");
          const imageUrl = await generateImage(imagePrompt, { size: "1080x1080", getSetting });
          if (imageUrl && postId) {
            db.prepare("UPDATE social_posts SET image_url = ? WHERE id = ? AND user_id = ?")
              .run(imageUrl, postId, userId);
          }
          return { generated: true, imageUrl, prompt: imagePrompt };
        }
        return { generated: false, reason: "No image generation service configured (add GEMINI_API_KEY)" };
      } catch(e) { return { generated: false, reason: e.message }; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CUSTOMER SUCCESS — SMS win-back
    // ─────────────────────────────────────────────────────────────────────────
    case "sms_winback": {
      const { phone, name, lastSeen, offer } = details.data || {};
      if (!phone) return { sent: false, reason: "No phone number" };
      const bizName = details.data?._business?.name || "us";
      const daysSince = lastSeen ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 86400000) : 30;
      const smsBody = offer
        ? `Hey ${name || "there"}! It's been a while — we miss you. ${offer} — exclusively for you. Reply STOP to opt out.`
        : `Hey ${name || "there"}, it's been ${daysSince} days since we saw you at ${bizName}. We'd love to have you back! Reply STOP to opt out.`;
      const result = await sendSMS(phone, smsBody, userId);
      if (result.sent) {
        db.prepare("UPDATE contacts SET last_contacted = datetime('now'), notes = COALESCE(notes,'') || ? WHERE user_id = ? AND phone = ?")
          .run(`
[AI Win-back SMS sent ${new Date().toLocaleDateString()}]`, userId, phone);
      }
      return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SALES REP — SMS follow-up
    // ─────────────────────────────────────────────────────────────────────────
    case "sms_followup": {
      const { phone, name, leadSource, followupDay } = details.data || {};
      if (!phone) return { sent: false, reason: "No phone number" };
      const bizName = details.data?._business?.name || "us";
      const msgs = {
        1: `Hi ${name || "there"}! Thanks for your interest in ${bizName}. Happy to answer any questions — just reply here or call us anytime.`,
        3: `Hey ${name || "there"}, just checking in from ${bizName}. Have you had a chance to look over what we sent? Happy to jump on a quick call.`,
        7: `Hi ${name || "there"}, last follow-up from ${bizName}. If timing isn't right, no worries — just let us know and we'll check back later. Reply STOP to opt out.`
      };
      const smsBody = msgs[followupDay || 1] || msgs[1];
      const result = await sendSMS(phone, smsBody, userId);
      if (result.sent) {
        db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
          .run(userId, "sales_sms_sent", JSON.stringify({ phone, followupDay, leadSource }));
      }
      return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RECEPTIONIST — Outbound calling (Twilio Programmable Voice)
    // ─────────────────────────────────────────────────────────────────────────
    case "outbound_call": {
      const { phone, name, reason } = details.data || {};
      if (!phone) return { called: false, reason: "No phone number" };
      const sid   = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
      const token = getSetting("TWILIO_AUTH_TOKEN")   || process.env.TWILIO_AUTH_TOKEN;
      const from  = getSetting("TWILIO_PHONE_NUMBER")  || process.env.TWILIO_PHONE_NUMBER;
      const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
      if (!sid || !token || !from) return { called: false, reason: "Twilio not configured" };
      try {
        const fetch2 = (await import("node-fetch")).default;
        const params = new URLSearchParams({
          To: phone, From: from,
          Url: `${backendUrl}/api/ai-employees/voice/outbound-twiml?userId=${userId}&name=${encodeURIComponent(name||"")}&reason=${encodeURIComponent(reason||"follow up")}`,
          StatusCallback: `${backendUrl}/api/ai-employees/voice/status`
        });
        const r = await fetch2(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
          method: "POST",
          headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
          body: params
        });
        const d = await r.json();
        return { called: !!d.sid, callSid: d.sid, to: phone, reason };
      } catch(e) { return { called: false, reason: e.message }; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LEGAL + PROPOSAL — Native e-signature request
    // Generates a unique signing link; client signs online without DocuSign
    // ─────────────────────────────────────────────────────────────────────────
    case "esign_request": {
      const { contractId, clientEmail, clientName, title } = details.data || {};
      if (!clientEmail || !contractId) return { sent: false, reason: "Missing contractId or clientEmail" };
      const { v4: uuid } = require("uuid");
      const sigToken = uuid().replace(/-/g, "");
      const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
      const sigLink = `${backendUrl}/api/ai-employees/sign/${sigToken}`;
      const expires = new Date(Date.now() + 14 * 86400000).toISOString();
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS esign_requests (
          id TEXT PRIMARY KEY, user_id TEXT, contract_id TEXT,
          client_email TEXT, client_name TEXT, title TEXT,
          token TEXT UNIQUE, signed INTEGER DEFAULT 0,
          signed_at TEXT, signed_ip TEXT, expires_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`);
        db.prepare("INSERT INTO esign_requests (id, user_id, contract_id, client_email, client_name, title, token, expires_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(uuid(), userId, contractId, clientEmail, clientName || "", title || "Agreement", sigToken, expires);
      } catch(e) {}
      // Email the signing link
      await sendEmail(userId, clientEmail, `Please sign: ${title || "your agreement"}`,
        `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
          <h2>Your document is ready to sign</h2>
          <p>Hi ${clientName || "there"},</p>
          <p>Please review and sign <strong>${title || "your agreement"}</strong> at your earliest convenience.</p>
          <div style="text-align:center;margin:28px 0">
            <a href="${sigLink}" style="background:#2563EB;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
              Review &amp; Sign Document →
            </a>
          </div>
          <p style="font-size:12px;color:#94A3B8">This link expires in 14 days. It can only be used once.</p>
        </div>`
      );
      return { sent: true, sigLink, token: sigToken, expires };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BOOKKEEPER — Xero sync
    // ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// BOOKKEEPER — auto-categorize newly synced transactions in batch
// Called from xero_sync and qbo_sync after the inserts complete.
// Costs ~1 Claude call per sync regardless of transaction count (batched).
// ─────────────────────────────────────────────────────────────────────────
async function autoCategorizeTransactions(db, userId, maxItems = 50) {
  try {
    // Find recently inserted uncategorised transactions
    const rows = db.prepare(`
      SELECT id, description, amount, date
      FROM transactions
      WHERE user_id = ?
      AND (category = 'uncategorised' OR category IS NULL OR category = '')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, maxItems);

    if (rows.length === 0) return { categorized: 0, total: 0, skipped: 0 };

    const anthropicKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return { categorized: 0, total: rows.length, skipped: rows.length, reason: "No Anthropic API key" };

    // Build a compact prompt — each transaction on one line for Claude
    const txList = rows.map(r => `${r.id}|${(r.description||"").slice(0,80)}|${r.amount>=0?"+":""}${r.amount}|${r.date||""}`).join("\n");

    const prompt = `You are categorising bank transactions for a small-business P&L. For each line below, return ONE category from this fixed list:

REVENUE: sales, services, refunds_in, interest_income, other_income
COST_OF_GOODS: cogs, raw_materials, manufacturing, wholesale
OPERATING: rent, utilities, software, internet_phone, insurance, repairs, cleaning
PAYROLL: wages, contractor_fees, payroll_tax, superannuation, employee_benefits
MARKETING: advertising, content, events, sponsorships, ai_subscriptions
TRAVEL: flights, accommodation, meals_entertainment, transport, vehicle
OFFICE: supplies, equipment, furniture, postage
PROFESSIONAL: legal, accounting, consulting, training
TAX_AND_FEES: gst, income_tax, payroll_tax_remit, bank_fees, merchant_fees
TRANSFERS: owner_drawing, owner_contribution, interbank_transfer, loan_repayment
OTHER: misc, unknown

Format: one line per transaction, exactly: <id>|<category>
NO commentary, NO markdown, NO explanation. Just the lines.

Transactions (format: id | description | amount | date):
${txList}`;

    const fetch4 = (await import("node-fetch")).default;
    const r = await fetch4("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        temperature: 0,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const d = await r.json();
    const text = d.content?.find(b => b.type === "text")?.text || d.content?.[0]?.text || "";

    // Parse lines: "<id>|<category>"
    let updated = 0;
    const updates = db.prepare("UPDATE transactions SET category = ? WHERE id = ? AND user_id = ?");
    const txn = db.transaction((pairs) => {
      for (const [id, cat] of pairs) {
        try { updates.run(cat.toLowerCase().trim(), id, userId); updated++; } catch(_) {}
      }
    });
    const pairs = [];
    for (const line of text.split(/\r?\n/)) {
      const [id, cat] = line.split("|").map(s => (s || "").trim());
      if (id && cat && cat.length > 0 && cat.length < 50) pairs.push([id, cat]);
    }
    if (pairs.length > 0) txn(pairs);

    return { categorized: updated, total: rows.length, skipped: Math.max(0, rows.length - updated) };
  } catch (e) {
    console.error("[bookkeeper] auto-categorize failed:", e.message);
    return { categorized: 0, total: 0, skipped: 0, error: e.message };
  }
}


    case "xero_sync": {
      try {
        const { ensureValidToken } = require('./accounting-oauth');
        const xeroToken  = await ensureValidToken(db, userId, 'xero');
        const xeroRec    = db.prepare("SELECT tenant_id FROM accounting_tokens WHERE user_id=? AND provider='xero'").get(userId);
        const xeroTenant = xeroRec?.tenant_id || getSetting("XERO_TENANT_ID") || process.env.XERO_TENANT_ID;
        if (!xeroTenant) return { synced: false, reason: "Connect Xero in Settings → Integrations" };
        const fetch2 = (await import("node-fetch")).default;
        const since = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
        const r = await fetch2(`https://api.xero.com/api.xro/2.0/Transactions?ModifiedAfter=${since}&order=Date DESC`, {
          headers: { Authorization: `Bearer ${xeroToken}`, "Xero-Tenant-Id": xeroTenant, Accept: "application/json" }
        });
        const d = await r.json();
        const transactions = d.BankTransactions || [];
        let synced = 0;
        for (const tx of transactions.slice(0, 200)) {
          try {
            db.prepare(`INSERT OR IGNORE INTO transactions (id, user_id, amount, description, date, category, source, reference, created_at)
              VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
              .run(tx.BankTransactionID, userId,
                tx.Total || 0,
                tx.Contact?.Name || tx.Reference || "",
                tx.DateString?.split("T")[0] || new Date().toISOString().split("T")[0],
                tx.LineItems?.[0]?.AccountCode || "uncategorised",
                "xero", tx.Reference || "");
            synced++;
          } catch(_) {}
        }
        const cat = await autoCategorizeTransactions(db, userId);
        return { synced: true, count: synced, source: "xero", period: `last 30 days`, categorized: cat.categorized, categorize_total: cat.total };
      } catch(e) { return { synced: false, reason: e.message }; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BOOKKEEPER — QuickBooks Online sync
    // ─────────────────────────────────────────────────────────────────────────
    case "qbo_sync": {
      try {
        const { ensureValidToken } = require('./accounting-oauth');
        const qboToken = await ensureValidToken(db, userId, 'quickbooks');
        const qboRec   = db.prepare("SELECT tenant_id FROM accounting_tokens WHERE user_id=? AND provider='quickbooks'").get(userId);
        const qboRealm = qboRec?.tenant_id || getSetting("QBO_REALM_ID") || process.env.QBO_REALM_ID;
        if (!qboRealm) return { synced: false, reason: "Connect QuickBooks in Settings → Integrations" };
        const fetch2 = (await import("node-fetch")).default;
        const since = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
        const query = encodeURIComponent(`SELECT * FROM Purchase WHERE MetaData.LastUpdatedTime > '${since}' MAXRESULTS 200`);
        const r = await fetch2(`https://quickbooks.api.intuit.com/v3/company/${qboRealm}/query?query=${query}`, {
          headers: { Authorization: `Bearer ${qboToken}`, Accept: "application/json" }
        });
        const d = await r.json();
        const purchases = d.QueryResponse?.Purchase || [];
        let synced = 0;
        for (const p of purchases) {
          try {
            db.prepare(`INSERT OR IGNORE INTO transactions (id, user_id, amount, description, date, category, source, created_at)
              VALUES (?,?,?,?,?,?,?,datetime('now'))`)
              .run(p.Id, userId,
                p.TotalAmt || 0,
                p.PaymentMethodRef?.name || p.EntityRef?.name || "",
                p.TxnDate || new Date().toISOString().split("T")[0],
                p.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || "uncategorised",
                "quickbooks");
            synced++;
          } catch(_) {}
        }
        const _qcat = await autoCategorizeTransactions(db, userId);
        return { synced: true, count: synced, source: "quickbooks", period: "last 30 days" , categorized: _qcat.categorized, categorize_total: _qcat.total };
      } catch(e) { return { synced: false, reason: e.message }; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GROWTH AGENT — Competitor monitoring snapshot
    // Scrapes competitor sites for pricing/offer changes
    // ─────────────────────────────────────────────────────────────────────────
    case "competitor_snapshot": {
      const { competitors } = details.data || {};
      const urls = Array.isArray(competitors) ? competitors : [];
      if (!urls.length) return { done: false, reason: "No competitor URLs configured" };
      const anthropicKey = getSetting("ANTHROPIC_API_KEY");
      const fetch2 = (await import("node-fetch")).default;
      const snapshots = [];
      for (const url of urls.slice(0, 5)) {
        try {
          const r = await fetch2(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
          const html = await r.text();
          // Strip HTML tags for Claude analysis
          const text = html.replace(/<[^>]+>/g, " ").replace(/[ \t\r\n]+/g, " ").substring(0, 3000);
          if (anthropicKey) {
            const Anthropic = require("@anthropic-ai/sdk");
            const claude = new Anthropic({ apiKey: anthropicKey });
            const analysis = await claude.messages.create({
              model: "claude-sonnet-4-6", max_tokens: 200,
              messages: [{ role: "user", content: `Analyse this competitor page and extract: pricing, offers, key features, recent changes. Be concise.

URL: ${url}
Content: ${text}` }]
            });
            const summary = analysis.content[0]?.text || "";
            // Store snapshot
            const { v4: uuid } = require("uuid");
            db.exec("CREATE TABLE IF NOT EXISTS competitor_snapshots (id TEXT PRIMARY KEY, user_id TEXT, url TEXT, summary TEXT, created_at TEXT DEFAULT (datetime('now')))");
            db.prepare("INSERT INTO competitor_snapshots (id, user_id, url, summary) VALUES (?,?,?,?)").run(uuid(), userId, url, summary);
            snapshots.push({ url, summary });
          } else {
            snapshots.push({ url, summary: "Scraped — add ANTHROPIC_API_KEY for AI analysis" });
          }
        } catch(e) { snapshots.push({ url, error: e.message }); }
      }
      // Send digest to owner
      if (snapshots.length) {
        const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(userId);
        if (owner?.email) {
          const body = snapshots.map(s => `<h3>${s.url}</h3><p>${s.summary || s.error || ""}</p>`).join("");
          await sendEmail(userId, owner.email, "Weekly competitor intelligence — TAKEOVA Growth Agent",
            `<div style="font-family:sans-serif;max-width:600px;margin:0 auto"><h2>Competitor Snapshot</h2>${body}</div>`);
        }
      }
      return { done: true, snapshots: snapshots.length };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COLD EMAIL AGENT — Stop sequence on reply detection
    // ─────────────────────────────────────────────────────────────────────────
    case "reply_stop_sequence": {
      const { email, sequenceId } = details.data || {};
      if (!email) return { stopped: false, reason: "No email" };
      try {
        // Mark all pending follow-ups for this email as cancelled
        db.exec("CREATE TABLE IF NOT EXISTS cold_email_sequences (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, status TEXT DEFAULT 'active', replied INTEGER DEFAULT 0, sequence_id TEXT, created_at TEXT DEFAULT (datetime('now')))");
        const result = db.prepare("UPDATE cold_email_sequences SET status = 'replied', replied = 1 WHERE user_id = ? AND email = ? AND status = 'active'")
          .run(userId, email);
        // Also cancel any scheduled jobs for this email
        db.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE user_id = ? AND job_data LIKE ? AND status = 'pending'")
          .run(userId, `%${email}%`);
        db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
          .run(userId, "sequence_stopped_on_reply", JSON.stringify({ email, sequenceId, rowsUpdated: result.changes }));
        // Add lead to CRM as warm lead
        try {
          const existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(userId, email);
          if (!existing) {
            const { v4: uuid } = require("uuid");
            db.prepare("INSERT INTO contacts (id, user_id, email, source, status, notes, created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
              .run(uuid(), userId, email, "cold_email_replied", "warm_lead", "Replied to cold email sequence — follow up personally");
          } else {
            db.prepare("UPDATE contacts SET status = 'warm_lead', notes = COALESCE(notes,'') || ? WHERE id = ?")
              .run("\n[Replied to cold email sequence — follow up personally]", existing.id);
          }
        } catch(_) {}
        return { stopped: true, email, rowsUpdated: result.changes };
      } catch(e) { return { stopped: false, reason: e.message }; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PROSPECTOR — SMS cold outreach to leads
    // ─────────────────────────────────────────────────────────────────────────
    case "sms_outreach": {
      const { phone, bizName, ownerName, demoUrl } = details.data || {};
      if (!phone) return { sent: false, reason: "No phone number" };
      const myBiz = details.data?._business?.name || "our team";
      const body = ownerName
        ? `Hi ${ownerName}! I'm from ${myBiz}. I built ${bizName || "your business"} a free AI-powered website — no catch. Take a look: ${demoUrl || "takeova.ai"} — happy to answer any questions. Reply STOP to opt out.`
        : `Hi! We built ${bizName || "your business"} a free AI website demo — take 30 seconds to look: ${demoUrl || "takeova.ai"} Reply STOP to opt out.`;
      const result = await sendSMS(phone, body, userId);
      if (result.sent) {
        db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
          .run(userId, "prospector_sms_sent", JSON.stringify({ phone, bizName, demoUrl }));
      }
      return result;
    }



    case "send_email_blast": {
      const subject = details.subject || (details.draft||'').split('\n')[0] || 'Update from us';
      const body    = details.body || details.draft || details.reasoning || '';
      if (!body) return { sent: false, reason: 'No email body' };
      const sgKey = getSetting('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
      if (!sgKey) return { sent: false, reason: 'SENDGRID_API_KEY not configured' };
      let contacts = [];
      try { contacts = db.prepare("SELECT DISTINCT email FROM contacts WHERE user_id=? AND email IS NOT NULL AND email!='' LIMIT 500").all(userId); } catch(_) {}
      if (!contacts.length) return { sent: false, reason: 'No contacts found' };
      const { default: fetch2 } = await import('node-fetch');
      const fromEmail = getSetting('EMAIL_FROM') || getSetting('FROM_EMAIL') || process.env.EMAIL_FROM || process.env.FROM_EMAIL || 'noreply@takeova.ai';
      const batches = [];
      for (let i=0; i<contacts.length; i+=50) batches.push(contacts.slice(i,i+50));
      let sent = 0;
      for (const batch of batches) {
        try {
          const _sgResp = await fetch2('https://api.sendgrid.com/v3/mail/send', {
            method:'POST', headers:{ Authorization:'Bearer '+sgKey, 'Content-Type':'application/json' },
            body: JSON.stringify({ personalizations: batch.map(c=>({to:[{email:c.email}]})), from:{email:fromEmail}, subject, content:[{type:'text/html',value:body.replace(/\n/g,'<br>')}] })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
          sent += batch.length;
        } catch(_) {}
      }
      return { sent: true, count: sent, subject };
    }
    case "weekly_contract_digest": {
      let unsigned=[], expiring=[];
      try { unsigned = db.prepare("SELECT id,client_name FROM contracts WHERE user_id=? AND status='sent' AND datetime('now') > datetime(sent_at,'+7 days')").all(userId); } catch(_){}
      try { expiring = db.prepare("SELECT id,client_name,expires_at FROM contracts WHERE user_id=? AND status='signed' AND datetime(expires_at) < datetime('now','+30 days')").all(userId); } catch(_){}
      return { completed:true, unsigned:unsigned.length, expiring:expiring.length, summary:`${unsigned.length} unsigned, ${expiring.length} expiring soon` };
    }
    case "send_contract_reminder": {
      const email = details.email || details.clientEmail;
      const body  = details.draft || 'Your contract is waiting for your signature.';
      if (!email) return { sent:false, reason:'No client email' };
      const sgKey = getSetting('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
      if (!sgKey) return { sent:false, reason:'SENDGRID_API_KEY not configured' };
      const { default: fetch2 } = await import('node-fetch');
      const fromEmail = getSetting('EMAIL_FROM') || getSetting('FROM_EMAIL') || process.env.EMAIL_FROM || process.env.FROM_EMAIL || 'noreply@takeova.ai';
      const _sgResp = await fetch2('https://api.sendgrid.com/v3/mail/send', { method:'POST', headers:{Authorization:'Bearer '+sgKey,'Content-Type':'application/json'}, body:JSON.stringify({ personalizations:[{to:[{email}]}], from:{email:fromEmail}, subject:'Reminder: Contract awaiting your signature', content:[{type:'text/html',value:body.replace(/\n/g,'<br>')}] }) });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
      return { sent:true, email };
    }
    case "auto_reply_engagement": {
      const reply = details.draft || details.reply || 'Thanks for the love! Drop us a DM to learn more. 🙌';
      if (details.commentId) return await executeAction(db,{...action,action:'reply_comment',details:JSON.stringify({commentId:details.commentId,platform:details.platform||'meta',draft:reply})},userId);
      return { completed:true, note:'No comment ID — reply logged', reply };
    }
    case "send_lead_magnet": {
      const email  = details.email || details.leadEmail;
      const body   = details.draft || details.content || '';
      if (!email) return { sent:false, reason:'No email' };
      const sgKey = getSetting('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
      if (!sgKey) return { sent:false, reason:'SENDGRID_API_KEY not configured' };
      const { default: fetch2 } = await import('node-fetch');
      const fromEmail = getSetting('EMAIL_FROM') || getSetting('FROM_EMAIL') || process.env.EMAIL_FROM || process.env.FROM_EMAIL || 'noreply@takeova.ai';
      const _sgResp = await fetch2('https://api.sendgrid.com/v3/mail/send', { method:'POST', headers:{Authorization:'Bearer '+sgKey,'Content-Type':'application/json'}, body:JSON.stringify({ personalizations:[{to:[{email}]}], from:{email:fromEmail}, subject:"Here's what you requested!", content:[{type:'text/html',value:body.replace(/\n/g,'<br>')}] }) });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
      return { sent:true, email };
    }
    case "dm_prospect": {
      // Honest draft mode: no worker exists to actually send DMs via Instagram/Twitter,
      // so we save as a draft and notify the user to review + send manually.
      const { v4: uuidv4 } = require("uuid");
      const platform = details.platform || "instagram";
      const handle = details.handle || details.data?.handle || "";
      const message = details.draft || details.message || details.reasoning || "";

      try {
        db.exec("CREATE TABLE IF NOT EXISTS outreach_log (id TEXT PRIMARY KEY,user_id TEXT,platform TEXT,handle TEXT,message TEXT,status TEXT,created_at TEXT)");
      } catch(_) {}

      if (!message) return { completed: false, reason: "No DM content drafted" };
      if (!handle) return { completed: false, reason: "No target handle specified" };

      const draftId = uuidv4();
      try {
        db.prepare("INSERT INTO outreach_log (id,user_id,platform,handle,message,status,created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
          .run(draftId, userId, platform, handle, message, "draft");
      } catch(e) { console.error("[dm_prospect log]", e.message); }

      // In-app notification so the user knows a DM needs sending
      try {
        const notifId = uuidv4();
        db.prepare("INSERT INTO notifications (id, user_id, type, icon, text, data, time) VALUES (?,?,?,?,?,?,?)")
          .run(notifId, userId, "dm_drafted", "💬", "DM drafted for " + handle + " on " + platform + " — review & send", JSON.stringify({ draftId, platform, handle, preview: message.slice(0, 100) }), "Just now");
      } catch(_) {}

      return {
        completed: true,
        sent: false,
        status: "draft",
        draftId,
        platform,
        handle,
        note: "DM drafted — review in Outreach Drafts and send manually. Direct DM API send not implemented for " + platform + " yet."
      };
    }
    case "send_winback_email":
    case "send_health_check": {
      const email = details.email||details.customerEmail;
      const body  = details.draft||details.reasoning||'';
      if (!email||!body) return { sent:false, reason:'Missing email or body' };
      const sgKey = getSetting('SENDGRID_API_KEY')||process.env.SENDGRID_API_KEY;
      if (!sgKey) return { sent:false, reason:'SENDGRID_API_KEY not configured' };
      const { default: fetch2 } = await import('node-fetch');
      const fromEmail = getSetting('EMAIL_FROM') || getSetting('FROM_EMAIL') || process.env.EMAIL_FROM || process.env.FROM_EMAIL || 'noreply@takeova.ai';
      const subj = action.action==='send_winback_email'?`We miss you! 👋`:`Checking in — how are things going?`;
      const _sgResp = await fetch2('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{Authorization:'Bearer '+sgKey,'Content-Type':'application/json'},body:JSON.stringify({personalizations:[{to:[{email}]}],from:{email:fromEmail},subject:subj,content:[{type:'text/html',value:body.replace(/\n/g,'<br>')}]})});
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
      return { sent:true, email, action:action.action };
    }
    case "run_competitor_analysis":
    case "identify_opportunity":
    case "send_growth_report":
    case "suggest_ab_test":
    case "find_businesses": {
      // ── Real autonomous lead-finding ──
      // Wired to the same /run logic the manual button uses, with safety
      // rails on add-on access, daily cap, and a per-run hard limit.
      try {
        const empRow = db.prepare("SELECT rules FROM ai_employees WHERE user_id = ? AND role = 'prospector'").get(userId);
        if (!empRow) return { completed: false, reason: "Prospector not configured for this user" };
        let rules = {}; try { rules = JSON.parse(empRow.rules || "{}"); } catch(_) {}

        const targetCities = rules.targetCities
          ? String(rules.targetCities).split(",").map(s => s.trim()).filter(Boolean)
          : [];
        if (!targetCities.length) return { completed: false, reason: "No targetCities configured — autonomous scan needs cities" };

        const niche = rules.niche || "";
        if (!niche) return { completed: false, reason: "No niche configured — autonomous scan needs a niche" };

        const dailyCap = parseInt(rules.dailyCap || 10);
        // Honor the daily cap — count outreach already sent today
        const todayCount = db.prepare(
          "SELECT count(*) as n FROM ai_employee_actions WHERE user_id=? AND role='prospector' AND action='send_outreach' AND date(created_at)=date('now')"
        ).get(userId)?.n || 0;
        const remaining = dailyCap - todayCount;
        if (remaining <= 0) return { completed: false, reason: "Daily cap of " + dailyCap + " already met for today" };

        // Hard per-run safety cap regardless of dailyCap setting — never
        // run more than 10 leads in a single autonomous campaign. If the
        // user wants higher throughput they should use manual /run.
        const maxLeads = Math.min(remaining, 10);

        // City: prefer what the cron/Claude proposed, fall back to rotation
        const city = details.city || targetCities[new Date().getDate() % targetCities.length];

        // Add-on gate — paid feature, same as manual /run endpoint enforces
        let hasAddon = false;
        try {
          const prospectorModule = require("./prospector");
          hasAddon = prospectorModule.hasProspectorAddon ? prospectorModule.hasProspectorAddon(db, userId) : false;
        } catch(e) {
          console.warn("[find_businesses] hasProspectorAddon import failed:", e.message);
        }
        const userInfo = db.prepare("SELECT plan, role FROM users WHERE id = ?").get(userId);
        const isAdmin = userInfo?.role === "admin";
        if (!isAdmin && !hasAddon) return { completed: false, reason: "Prospector add-on not active for this user" };

        // Translate channel preference
        const channels = rules.channels === "email" ? ["email"]
                       : rules.channels === "sms"   ? ["sms"]
                       : ["email", "sms"];

        // Create campaign row (mirrors the /run endpoint exactly)
        const uuid = require("uuid").v4;
        const campaignId = uuid();
        try { db.exec("ALTER TABLE prospector_campaigns ADD COLUMN cancelled INTEGER DEFAULT 0"); } catch(_) {}
        db.prepare("INSERT INTO prospector_campaigns (id, user_id, city, category, status) VALUES (?,?,?,?,?)")
          .run(campaignId, userId, city, niche, "running");

        // Run async — don't block the executor. The campaign function handles
        // its own error logging into prospector_campaigns.error.
        const plan = userInfo?.plan || "starter";
        setImmediate(async () => {
          try {
            const prospectorModule = require("./prospector");
            if (!prospectorModule.runProspectorCampaign) {
              console.error("[find_businesses] runProspectorCampaign not exported");
              db.prepare("UPDATE prospector_campaigns SET status='failed', error=? WHERE id=?").run("runProspectorCampaign not exported", campaignId);
              return;
            }
            await prospectorModule.runProspectorCampaign(db, userId, campaignId, city, niche, maxLeads, channels, isAdmin, plan, rules.preview_mode === "yes");
          } catch (e) {
            console.error("[find_businesses autonomous]", e.message);
            try { db.prepare("UPDATE prospector_campaigns SET status='failed', error=? WHERE id=?").run(e.message, campaignId); } catch(_) {}
          }
        });

        return {
          completed: true,
          campaignId,
          city,
          niche,
          maxLeads,
          channels,
          dailyCapRemaining: remaining,
          message: "Autonomous campaign launched: " + niche + " in " + city + " — finding up to " + maxLeads + " leads"
        };
      } catch (e) {
        console.error("[find_businesses]", e.message);
        return { completed: false, reason: e.message };
      }
    }
    case "build_demo_site":
    case "follow_up_prospect":
    case "generate_proposal":
    case "track_open":
    case "research_prospect":
    case "write_email":
    case "handle_reply":
    case "book_meeting":
    case "flag_at_risk":
    case "send_upsell":
    case "log_interaction":
    case "answer_call":
    case "book_appointment":
    case "take_message":
    case "transfer_call":
    case "send_daily_briefing":
    case "approve_actions":
    case "flag_anomaly":
    case "respond_whatsapp": {
      return { completed:true, content:details.draft||details.reasoning||'', action:action.action };
    }
    case "send_outreach":
    case "send_email":
    case "send_proposal": {
      const email  = details.email||details.prospectEmail||details.clientEmail;
      const body   = details.draft||details.message||'';
      const subject= details.subject||'A message for you';
      if (!email) return { sent:false, reason:'No email address' };
      const sgKey = getSetting('SENDGRID_API_KEY')||process.env.SENDGRID_API_KEY;
      if (!sgKey) return { sent:false, reason:'SENDGRID_API_KEY not configured' };
      const { default: fetch2 } = await import('node-fetch');
      const fromEmail = getSetting('EMAIL_FROM') || getSetting('FROM_EMAIL') || process.env.EMAIL_FROM || process.env.FROM_EMAIL || 'noreply@takeova.ai';
      const _sgResp = await fetch2('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{Authorization:'Bearer '+sgKey,'Content-Type':'application/json'},body:JSON.stringify({personalizations:[{to:[{email}]}],from:{email:fromEmail},subject,content:[{type:'text/html',value:body.replace(/\n/g,'<br>')}]})});
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
      return { sent:true, email, subject, action:action.action };
    }
    case "send_sms_followup": {
      const phone   = details.phone||details.toPhone;
      const message = details.draft||details.message||'Thanks for calling! How can we help?';
      if (!phone) return { sent:false, reason:'No phone number' };
      const twilioSid  = getSetting('TWILIO_ACCOUNT_SID')||process.env.TWILIO_ACCOUNT_SID;
      const twilioAuth = getSetting('TWILIO_AUTH_TOKEN')||process.env.TWILIO_AUTH_TOKEN;
      const twilioFrom = getSetting('TWILIO_PHONE_NUMBER')||process.env.TWILIO_PHONE_NUMBER;
      if (!twilioSid||!twilioAuth) return { sent:false, reason:'Twilio not configured' };
      const { default: fetch2 } = await import('node-fetch');
      const r = await fetch2(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,{
        method:'POST', headers:{Authorization:'Basic '+Buffer.from(twilioSid+':'+twilioAuth).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({To:phone,From:twilioFrom,Body:message}).toString()
      });
      const d = await r.json();
      return { sent:!!d.sid, sid:d.sid, phone, message };
    }
    default:
      return { completed: true, note: "Action processed: " + action.action };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// executeAction — wraps _rawExecuteAction with automatic outcome tracking
// ═══════════════════════════════════════════════════════════════════════════
// Every action's return value is inspected to infer success/failure/escalation,
// and an outcome row is written via the enhancement layer. Zero changes needed
// to individual case blocks — they just return whatever they already returned.
//
// Inference rules:
//   { sent: true }              → success
//   { sent: false, escalated } → escalated
//   { sent: false }             → no_response (action skipped, e.g. no email)
//   { updated: true }           → success
//   { called: true }            → success
//   { error: ... }              → failed  (and queues for retry if external)
//   anything with an Error      → failed  (thrown errors caught here)
//   default                     → success (completed without obvious failure)
async function executeAction(db, action, userId) {
  // ── Baseline enforcement ─────────────────────────────────────────────
  // For external-facing actions (email, SMS, post, call), check working hours
  // and approval rules BEFORE doing the real work. Sales/Support handlers do
  // their own check inside the case block; we skip here to avoid double-blocking.
  const _actionRole = action.role || inferRoleFromAction(action.action);
  const _alreadyChecksItself = (action.action === "send_followup_email" || action.action === "reply_ticket");
  if (!_alreadyChecksItself && isExternalSend(action.action)) {
    try {
      const _details = typeof action.details === "string" ? JSON.parse(action.details) : (action.details || {});
      const _baselineCheck = _checkBaseline(db, userId, _actionRole, action.action, {
        contact: _details.data?.contact || { email: extractContactEmail(action, {}) },
        amount: _details.data?.amount || _details.data?.estimatedSpend,
      });
      if (_baselineCheck.block) {
        const blockedOutcome = _baselineCheck.blockType === "needs_approval" ? "escalated" : "blocked";
        try {
          recordOutcome(action.id, userId, _actionRole, action.action, blockedOutcome,
            { reason: _baselineCheck.reason, blockType: _baselineCheck.blockType });
        } catch {}
        // Outside-hours actions get queued for retry when window reopens
        if (_baselineCheck.shouldQueue) {
          try {
            queueRetry(action.id, userId, _actionRole, action.action,
              _details, new Error(_baselineCheck.reason));
          } catch {}
        }
        return {
          sent: false, blocked: true,
          reason: _baselineCheck.reason,
          blockType: _baselineCheck.blockType,
          _outcome_recorded: true,
        };
      }
    } catch (e) {
      // Don't block actions on enforcement errors — log and continue
      console.error("[baseline-enforcement-wrapper]", e.message);
    }
  }

  let result, thrown = null;
  try {
    result = await _rawExecuteAction(db, action, userId);
  } catch (err) {
    thrown = err;
    result = { error: String(err).slice(0, 200) };
  }

  // Skip tracking for actions that already handle their own outcomes
  // (the big Sales/Support send_followup_email / reply_ticket block does this)
  if (result && result._outcome_recorded) return result;

  try {
    const outcome = inferOutcome(result);
    const role = action.role || inferRoleFromAction(action.action);
    const contactEmail = extractContactEmail(action, result);

    recordOutcome(action.id, userId, role, action.action, outcome, {
      ...(typeof result === 'object' ? result : {}),
      had_error: !!thrown,
    });

    // Queue for retry on external-send failures (email/SMS/call)
    if (outcome === "failed" && isExternalSend(action.action) && thrown) {
      try {
        const details = typeof action.details === "string" ? JSON.parse(action.details) : (action.details || {});
        queueRetry(action.id, userId, role, action.action, details, thrown);
      } catch {}
    }

    // Light memory update on successful external contact
    if (outcome === "success" && contactEmail && isContactAction(action.action)) {
      upsertMemory(userId, role, contactEmail, {
        newFacts: [`${action.action.replace(/_/g,' ')} on ${new Date().toISOString().slice(0,10)}`],
      });
    }
  } catch (e) {
    console.error("[outcome-wrapper]", e.message);
  }

  // Re-throw so callers still see the error
  if (thrown) throw thrown;
  return result;
}

// ─── Helpers for the wrapper ──────────────────────────────────────────────
function inferOutcome(result) {
  if (!result || typeof result !== "object") return "success";
  if (result.error) return "failed";
  if (result.escalated) return "escalated";
  if (result.sent === true || result.called === true || result.updated === true || result.booked === true || result.success === true) return "success";
  if (result.sent === false || result.called === false || result.updated === false) return "no_response";
  if (result.completed === true) return "success";
  return "success";
}

function inferRoleFromAction(actionName) {
  const map = {
    send_followup_email: "sales", qualify_lead: "sales", book_meeting: "sales", send_proposal: "sales", move_pipeline: "sales", update_crm: "sales", sms_followup: "sales",
    reply_ticket: "support", process_refund: "support", close_ticket: "support", escalate_to_human: "support", send_shipping_info: "support", update_order: "support",
    send_invoice_reminder: "bookkeeper", categorize_transaction: "bookkeeper", flag_overdue: "bookkeeper", xero_sync: "bookkeeper", qbo_sync: "bookkeeper", generate_report: "bookkeeper", forecast: "bookkeeper", reconcile: "bookkeeper",
    generate_post: "social", schedule_post: "social", post_now: "social", reply_comment: "social", analyze_performance: "social", suggest_content: "social", generate_post_image: "social",
    adjust_ad_budget: "marketing", pause_underperforming: "marketing", create_campaign: "marketing", ab_test_copy: "marketing", send_email_blast: "marketing", reply_review: "marketing",
    chase_unsigned_contract: "legal", draft_contract_for_booking: "legal", flag_expiring_contract: "legal", weekly_legal_digest: "legal", esign_request: "legal",
    sms_winback: "csm",
    outbound_call: "receptionist",
    reply_reddit_thread: "community", reply_x_post: "community", log_engagement: "community",
    competitor_snapshot: "growth",
  };
  return map[actionName] || "sales";
}

function extractContactEmail(action, result) {
  try {
    const d = typeof action.details === "string" ? JSON.parse(action.details) : (action.details || {});
    return (d.data?.email || d.data?.customerEmail || d.data?.clientEmail || d.data?.lead?.email || result?.to || "").toLowerCase() || null;
  } catch { return null; }
}

const _externalSendActions = new Set([
  "send_followup_email","send_proposal","send_invoice_reminder","send_email_blast",
  "sms_winback","sms_followup","outbound_call","esign_request","post_now",
  "reply_comment","reply_review","reply_ticket","reply_reddit_thread","reply_x_post",
]);
function isExternalSend(actionName) { return _externalSendActions.has(actionName); }

const _contactActions = new Set([
  "send_followup_email","reply_ticket","send_proposal","send_invoice_reminder",
  "sms_winback","sms_followup","outbound_call","esign_request","reply_review",
]);
function isContactAction(actionName) { return _contactActions.has(actionName); }


// ═══════════════════════════════════════
// LEAD MAGNET AUTO-REPLY SYSTEM
// ═══════════════════════════════════════
// When someone comments, DMs, likes, or retweets a post, automatically
// send them a link/PDF/resource. Classic "Comment LINK to get the guide" strategy.

function ensureLeadMagnetTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_magnets (
      id TEXT PRIMARY KEY, user_id TEXT,
      name TEXT, type TEXT DEFAULT 'link',
      url TEXT, pdf_url TEXT, description TEXT,
      trigger_words TEXT DEFAULT '["LINK","SEND","YES","ME","WANT","FREE","GUIDE","PDF"]',
      trigger_on TEXT DEFAULT '["comment","dm"]',
      reply_message TEXT DEFAULT 'Here you go! 🎉 {{link}} — Let me know if you have any questions!',
      dm_message TEXT DEFAULT 'Hey {{name}}! Thanks for your interest 🙌 Here''s the link you requested: {{link}}',
      follow_up_email INTEGER DEFAULT 1,
      email_subject TEXT DEFAULT 'Here''s what you requested!',
      email_body TEXT DEFAULT 'Hi {{name}},\n\nThanks for engaging with our post! Here''s the resource you asked for:\n\n{{link}}\n\nLet me know if you need anything else!\n\n— {{business}}',
      capture_as_lead INTEGER DEFAULT 1,
      email_capture_mode INTEGER DEFAULT 0,
      email_capture_ask TEXT DEFAULT 'Reply with your email and I''ll send it straight to your inbox! 📧',
      platforms TEXT DEFAULT '["instagram","facebook","tiktok","x","linkedin","youtube"]',
      active INTEGER DEFAULT 1,
      post_ids TEXT DEFAULT '[]',
      stats_sent INTEGER DEFAULT 0, stats_clicks INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lead_magnet_sends (
      id TEXT PRIMARY KEY, magnet_id TEXT, user_id TEXT,
      platform TEXT, username TEXT, email TEXT,
      engagement_type TEXT, post_id TEXT,
      sent_via TEXT, sent_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lm_sends_magnet ON lead_magnet_sends(magnet_id);
  `);
  // Email capture flow — tracks people who were asked for their email
  db.exec(`CREATE TABLE IF NOT EXISTS lead_magnet_email_awaiting (
    id TEXT PRIMARY KEY, magnet_id TEXT, user_id TEXT,
    platform TEXT, username TEXT, post_id TEXT, comment_id TEXT,
    dm_message_id TEXT, asked_at TEXT DEFAULT (datetime('now')),
    fulfilled INTEGER DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS lead_magnet_pdfs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, magnet_id TEXT,
    filename TEXT, base64 TEXT, size_bytes INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS lead_magnet_email_awaiting (
    id TEXT PRIMARY KEY,
    send_id TEXT NOT NULL,
    magnet_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    platform TEXT,
    username TEXT,
    asked_at TEXT DEFAULT (datetime('now')),
    email_received TEXT,
    fulfilled INTEGER DEFAULT 0
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_lmea_username ON lead_magnet_email_awaiting(user_id, platform, username)'); } catch(e) {}

}


function leadMagnetGate(db, userId) {
  // Admins bypass
  if (typeof global !== "undefined" && global.mineIsAdmin && global.mineIsAdmin(db, userId)) return null;
  try {
    const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(userId);
    const plan = (user?.plan || "starter").toLowerCase();
    // Lead magnets require Pro+. Plans with leadMagnets cap = 0: starter, growth.
    const LOCKED_PLANS = new Set(["starter", "growth", "free", "trial"]);
    if (LOCKED_PLANS.has(plan)) {
      return { error: "Lead magnets require Pro plan or higher. Upgrade to unlock 4 included magnets/month.", upgrade: true, currentPlan: plan };
    }
  } catch(e) {}
  return null;
}


// ── CRUD for lead magnets ──
router.get("/lead-magnets", auth, (req, res) => {
  const db = getDb();
  ensureLeadMagnetTables(db);
  const magnets = db.prepare(`
    SELECT lm.*,
      (SELECT COUNT(*) FROM lead_magnet_sends s WHERE s.magnet_id = lm.id) as triggers,
      (SELECT COUNT(*) FROM contacts c WHERE c.user_id = lm.user_id AND c.tags_json LIKE '%' || lm.name || '%') as captures
    FROM lead_magnets lm
    WHERE lm.user_id = ? ORDER BY lm.created_at DESC
  `).all(req.userId);
  res.json({ magnets: magnets.map(m => ({
    ...m,
    trigger_words: JSON.parse(m.trigger_words || "[]"),
    trigger_on: JSON.parse(m.trigger_on || "[]"),
    platforms: JSON.parse(m.platforms || "[]"),
    post_ids: JSON.parse(m.post_ids || "[]"),
    triggers: m.triggers || 0,
    captures: m.captures || 0
  })) });
});

router.post("/lead-magnets", auth, (req, res) => {
  const { name, type, url, pdf_url, description, trigger_words, trigger_on, reply_message, dm_message, follow_up_email, email_subject, email_body, capture_as_lead, platforms, post_ids } = req.body;
  const db = getDb();
  ensureLeadMagnetTables(db);
  // Plan gate: Starter/Growth blocked from creating any lead magnets
  const gate = leadMagnetGate(db, req.userId);
  if (gate) return res.status(403).json(gate);
  const id = uuid();
  db.prepare(`INSERT INTO lead_magnets (id, user_id, name, type, url, pdf_url, description, trigger_words, trigger_on, reply_message, dm_message, follow_up_email, email_subject, email_body, capture_as_lead, platforms, post_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.userId, name || "Lead Magnet", type || "link", url || "", pdf_url || "", description || "", JSON.stringify(trigger_words || ["LINK", "SEND", "YES", "ME", "WANT", "FREE"]), JSON.stringify(trigger_on || ["comment", "dm"]), reply_message || "Here you go! 🎉 {{link}}", dm_message || "Hey {{name}}! Here's your link: {{link}}", follow_up_email ? 1 : 0, email_subject || "Here's what you requested!", email_body || "", capture_as_lead ? 1 : 0, JSON.stringify(platforms || ["instagram", "facebook", "tiktok", "x", "linkedin"]), JSON.stringify(post_ids || []));
  res.json({ success: true, id });
});

router.put("/lead-magnets/:id", auth, (req, res) => {
  const db = getDb();
  const { name, type, url, pdf_url, description, trigger_words, trigger_on, reply_message, dm_message, follow_up_email, email_subject, email_body, capture_as_lead, platforms, post_ids, active } = req.body;
  db.prepare(`UPDATE lead_magnets SET name=?, type=?, url=?, pdf_url=?, description=?, trigger_words=?, trigger_on=?, reply_message=?, dm_message=?, follow_up_email=?, email_subject=?, email_body=?, capture_as_lead=?, platforms=?, post_ids=?, active=? WHERE id=? AND user_id=?`)
    .run(name, type, url, pdf_url, description, JSON.stringify(trigger_words || []), JSON.stringify(trigger_on || []), reply_message, dm_message, follow_up_email ? 1 : 0, email_subject, email_body, capture_as_lead ? 1 : 0, JSON.stringify(platforms || []), JSON.stringify(post_ids || []), active ?? 1, req.params.id, req.userId);
  res.json({ success: true });
});

router.delete("/lead-magnets/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM lead_magnets WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: true });
});

// ── Incoming engagement webhook (called by platform webhooks) ──

router.post("/lead-magnets/engagement", engagementLimiter, async (req, res) => {
  const { platform, engagement_type, post_id, username, user_id_platform, comment_text, comment_id } = req.body;
  const db = getDb();
  ensureLeadMagnetTables(db);

  // Find all active lead magnets that match this platform and engagement type
  const allMagnets = db.prepare("SELECT * FROM lead_magnets WHERE active = 1").all();

  for (const magnet of allMagnets) {
    const triggerOn = JSON.parse(magnet.trigger_on || "[]");
    const platforms = JSON.parse(magnet.platforms || "[]");
    const triggerWords = JSON.parse(magnet.trigger_words || "[]");
    const postIds = JSON.parse(magnet.post_ids || "[]");

    // Check platform match
    if (!platforms.includes(platform)) continue;

    // Check engagement type match
    if (!triggerOn.includes(engagement_type)) continue;

    // If specific post IDs set, check match
    if (postIds.length > 0 && !postIds.includes(post_id)) continue;

    // For comments — check trigger words
    if (engagement_type === "comment" && comment_text) {
      const upper = comment_text.toUpperCase();
      const matched = triggerWords.some(w => upper.includes(w.toUpperCase()));
      if (!matched) continue;
    }

    // Check we haven't already sent to this user for this magnet
    const existing = db.prepare("SELECT id FROM lead_magnet_sends WHERE magnet_id = ? AND platform = ? AND username = ?").get(magnet.id, platform, username);
    if (existing) continue;

    // Create a send record first so we have a tracking ID
    const sendId = uuid();
    db.prepare("INSERT INTO lead_magnet_sends (id, magnet_id, user_id, platform, username, engagement_type, post_id, sent_via) VALUES (?,?,?,?,?,?,?,?)")
      .run(sendId, magnet.id, magnet.user_id, platform, username || "", engagement_type, post_id || "", "");

    // Generate gated landing page link — captures email before delivering resource
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
    const gatedLink = `${backendUrl}/api/public/lm/${sendId}`;
    const rawLink = magnet.url || magnet.pdf_url || "";

    const businessSite = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(magnet.user_id);
    const businessName = businessSite?.name || "us";
    const replacements = { "{{link}}": gatedLink, "{{raw_link}}": rawLink, "{{name}}": username || "there", "{{business}}": businessName };
    const replaceVars = (text) => Object.entries(replacements).reduce((t, [k, v]) => t.replaceAll(k, v), text || "");

    const fetch = (await import("node-fetch")).default;
    const connections = db.prepare("SELECT * FROM social_connections WHERE user_id = ?").all(magnet.user_id);
    const conn = connections.find(c => c.platform === platform);
    if (!conn?.access_token) continue;

    let sentVia = [];
    const hasDmApi = ["instagram", "facebook", "x"].includes(platform);
    const noDmPlatforms = ["tiktok", "linkedin", "youtube"];

    // ── AUTO-REPLY to comment ──
    if (engagement_type === "comment" && comment_id) {
      // On DM-capable platforms: short teaser reply + send full link via DM
      // On non-DM platforms: put the full link directly in the comment reply
      const replyText = hasDmApi
        ? replaceVars("Check your DMs! 📩 I just sent you the link. 🎉")
        : replaceVars(magnet.reply_message); // Full link in public reply

      try {
        if (platform === "instagram" || platform === "facebook") {
          await fetch(`https://graph.facebook.com/v21.0/${comment_id}/replies`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: replyText, access_token: conn.access_token })
          });
          sentVia.push("comment_reply");
        } else if (platform === "x") {
          await fetch("https://api.twitter.com/2/tweets", {
            method: "POST",
            headers: { "Authorization": `Bearer ${conn.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ text: `@${username} ${replyText}`, reply: { in_reply_to_tweet_id: comment_id } })
          });
          sentVia.push("comment_reply");
        } else if (platform === "tiktok") {
          await fetch("https://open.tiktokapis.com/v2/comment/reply/", {
            method: "POST",
            headers: { "Authorization": `Bearer ${conn.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ comment_id, text: replyText })
          });
          sentVia.push("comment_reply");
        } else if (platform === "linkedin") {
          await fetch(`https://api.linkedin.com/v2/socialActions/${comment_id}/comments`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${conn.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ actor: conn.platform_user_id, message: { text: replyText } })
          });
          sentVia.push("comment_reply");
        } else if (platform === "youtube") {
          await fetch(`https://www.googleapis.com/youtube/v3/comments?part=snippet`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${conn.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ snippet: { parentId: comment_id, textDisplay: replyText } })
          });
          sentVia.push("comment_reply");
        }
      } catch(e) { console.error(`[LeadMagnet] Comment reply failed (${platform}):`, e.message); }
    }

    // ── AUTO-DM (only on platforms that support it) ──
    if (hasDmApi && (triggerOn.includes("dm") || triggerOn.includes("auto_dm") || engagement_type === "comment")) {
      const dmText = replaceVars(magnet.dm_message);

      try {
        if (platform === "instagram") {
          await fetch(`https://graph.facebook.com/v21.0/${conn.platform_page_id}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: { id: user_id_platform }, message: { text: dmText }, access_token: conn.access_token })
          });
          sentVia.push("dm");
        } else if (platform === "facebook") {
          await fetch(`https://graph.facebook.com/v21.0/${conn.platform_page_id}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: { id: user_id_platform }, message: { text: dmText }, access_token: conn.access_token, messaging_type: "RESPONSE" })
          });
          sentVia.push("dm");
        } else if (platform === "x") {
          await fetch("https://api.twitter.com/2/dm_conversations", {
            method: "POST",
            headers: { "Authorization": `Bearer ${conn.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message: { text: dmText }, participant_ids: [user_id_platform], conversation_type: "Group" })
          });
          sentVia.push("dm");
        }
      } catch(e) { console.error(`[LeadMagnet] DM failed (${platform}):`, e.message); }
    }

    // ── Capture as lead in CRM ──
    let capturedContactId = null;
    let newCapture = false;
    if (magnet.capture_as_lead) {
      try {
        const existingContact = db.prepare("SELECT id, email FROM contacts WHERE user_id = ? AND (email = ? OR name = ?)").get(magnet.user_id, username || "", username || "");
        if (!existingContact) {
          capturedContactId = uuid();
          newCapture = true;
          db.prepare("INSERT INTO contacts (id, user_id, name, email, status, source, tags_json, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
            .run(capturedContactId, magnet.user_id, username || "Social Lead", "", "lead", `${platform}_${engagement_type}`, JSON.stringify([platform, "lead-magnet", magnet.name]));
        } else {
          capturedContactId = existingContact.id;
        }
      } catch(e) {}
      // Real-time notification on new captures (skip duplicates)
      if (newCapture) {
        try {
          db.exec(`CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, icon TEXT, text TEXT, data TEXT, time TEXT DEFAULT (datetime('now')), read INTEGER DEFAULT 0)`);
          db.prepare("INSERT INTO notifications (id, user_id, type, icon, text, data, time) VALUES (?,?,?,?,?,?,datetime('now'))")
            .run(uuid(), magnet.user_id, "lead_magnet_capture", "🧲", `New lead from ${platform}: ${username || "Social Lead"} engaged with "${magnet.name}"`, JSON.stringify({ magnetId: magnet.id, magnetName: magnet.name, platform, username, engagement_type }));
        } catch(e) {}
      }
    }

    // ── EMAIL CAPTURE FULFILMENT — check if this DM is an email reply ──────────
    if (engagement_type === "dm" && text) {
      const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
      const detectedEmail = text.match(emailRegex)?.[0];
      if (detectedEmail) {
        // Check if we were waiting for this person's email
        const pending = db.prepare(
          "SELECT * FROM lead_magnet_email_awaiting WHERE user_id = ? AND platform = ? AND username = ? AND fulfilled = 0 ORDER BY asked_at DESC LIMIT 1"
        ).get(magnet.user_id, platform, username);
        if (pending) {
          // Load the PDF
          const pdfRecord = db.prepare(
            "SELECT * FROM lead_magnet_pdfs WHERE user_id = ? AND magnet_id = ?"
          ).get(magnet.user_id, pending.magnet_id);
          if (pdfRecord) {
            const emailSubject = replaceVars(magnet.email_subject || "Here's what you requested! 🎉");
            const emailBody = replaceVars(magnet.email_body || `Hi {{name}},

Thanks so much for your interest! Here's your resource — attached to this email.

Let me know if you have any questions!

— {{business}}`);
            // Get PDF content — from S3 or local base64
          let pdfBase64 = pdfRecord.base64;
          if (!pdfBase64 && pdfRecord.s3_url && isS3Enabled()) {
            // Fetch from S3 to attach to email
            try {
              const fetchImpl = (await import("node-fetch")).default;
              const s3Resp = await fetchImpl(pdfRecord.s3_url);
              const buf = await s3Resp.buffer();
              pdfBase64 = buf.toString("base64");
            } catch(e) { pdfBase64 = null; }
          }
          const sgAttachment = pdfBase64 ? [{
              content: pdfBase64,
              filename: pdfRecord.filename,
              type: "application/pdf",
              disposition: "attachment"
            }] : [];
            // Update/create contact with email
            try {
              const existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND (email = ? OR (phone = ? AND phone != ''))")
                .get(magnet.user_id, detectedEmail, username);
              if (existing) {
                db.prepare("UPDATE contacts SET email = ?, last_activity = datetime('now') WHERE id = ?")
                  .run(detectedEmail, existing.id);
              } else {
                const { v4: cid } = require("uuid");
                db.prepare("INSERT INTO contacts (id, user_id, name, email, tags, status, source, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
                  .run(cid(), magnet.user_id, username, detectedEmail, "lead-magnet", "lead", platform);
              }
            } catch(e) {}
            // Send the PDF via email
            await sendEmail(magnet.user_id, detectedEmail, emailSubject, emailBody, sgAttachment);
            // Mark as fulfilled
            db.prepare("UPDATE lead_magnet_email_awaiting SET fulfilled = 1 WHERE id = ?").run(pending.id);
            // Confirm via DM
            try {
              if (platform === "instagram" || platform === "facebook") {
                await fetch(`https://graph.facebook.com/v21.0/me/messages`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ recipient: { id: user_id_platform }, message: { text: `✅ Sent! Check your inbox at ${detectedEmail}` }, access_token: conn.access_token })
                });
              }
            } catch(e) { console.error("[/lead-magnets/engagement]", e.message || e); }
            sentVia.push("pdf_emailed");
          }
        }
      }
    }

    // ── Follow-up email — send if we have their email in CRM ──────────────────
    // ── EMAIL CAPTURE MODE — two-step flow ──────────────────────────────────
    if (magnet.email_capture_mode) {
      // Step 1: Ask for their email via DM instead of sending the link
      const askText = magnet.email_capture_ask || "Reply with your email and I'll send it straight to your inbox! 📧";
      try {
        if (hasDmApi && conn?.access_token) {
          if (platform === "instagram" || platform === "facebook") {
            await fetch(`https://graph.facebook.com/v21.0/me/messages`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ recipient: { id: user_id_platform }, message: { text: askText }, access_token: conn.access_token })
            });
          } else if (platform === "x") {
            await fetch("https://api.twitter.com/2/dm_conversations/with/:participant_id/messages", {
              method: "POST",
              headers: { "Authorization": `Bearer ${conn.access_token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ text: askText })
            });
          }
          sentVia.push("email_ask");
        }
        // Store in awaiting table — we'll deliver when they reply with email
        db.prepare(`INSERT OR IGNORE INTO lead_magnet_email_awaiting
          (id, send_id, magnet_id, user_id, platform, username) VALUES (?,?,?,?,?,?)`)
          .run(require("uuid").v4(), sendId, magnet.id, magnet.user_id, platform, username || "");
      } catch(e) { console.error("[/lead-magnets/engagement]", e.message || e); }
    } else if (magnet.follow_up_email && capturedContactId) {
      // Standard email follow-up — only fires if email already in CRM
      try {
        const contact = db.prepare("SELECT email FROM contacts WHERE id = ?").get(capturedContactId);
        if (contact?.email && contact.email.includes("@")) {
          const emailSubject = replaceVars(magnet.email_subject || "Here's what you requested!");
          const emailBody = replaceVars(magnet.email_body || `Hi {{name}},\n\nThanks for engaging with our post! Here's the resource:\n\n{{link}}\n\nLet me know if you need anything!\n\n— {{business}}`);
          await sendEmail(magnet.user_id, contact.email, emailSubject, emailBody);
          sentVia.push("email");
        }
      } catch(e) {}
    }

    // Update the send record with delivery methods
    db.prepare("UPDATE lead_magnet_sends SET sent_via = ? WHERE id = ?").run(sentVia.join(","), sendId);
    db.prepare("UPDATE lead_magnets SET stats_sent = stats_sent + 1 WHERE id = ?").run(magnet.id);
  }

  res.json({ success: true });
});

// ── Stats ──
router.get("/lead-magnets/:id/stats", auth, (req, res) => {
  const db = getDb();
  ensureLeadMagnetTables(db);
  const magnet = db.prepare("SELECT * FROM lead_magnets WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!magnet) return res.status(404).json({ error: "Not found" });
  const allSends = db.prepare("SELECT platform, engagement_type, username, sent_via, sent_at FROM lead_magnet_sends WHERE magnet_id = ? ORDER BY sent_at DESC").all(magnet.id);
  const byPlatform = {};
  let dms_sent = 0, emails_sent = 0;
  allSends.forEach(s => {
    byPlatform[s.platform] = (byPlatform[s.platform] || 0) + 1;
    if (s.sent_via && s.sent_via.includes("dm")) dms_sent++;
    if (s.sent_via && (s.sent_via.includes("email") || s.sent_via.includes("pdf_emailed"))) emails_sent++;
  });
  // Captures = contacts tagged with this magnet name
  let captures = 0;
  try {
    const namePattern = `%${magnet.name}%`;
    const row = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND tags_json LIKE ?").get(req.userId, namePattern);
    captures = row?.c || 0;
  } catch(e) {}
  const recent_engagements = allSends.slice(0, 20).map(s => ({
    handle: s.username, platform: s.platform, type: s.engagement_type, sent_via: s.sent_via, created_at: s.sent_at
  }));
  res.json({
    stats: { captures, triggers: allSends.length, dms_sent, emails_sent, recent_engagements },
    magnet: { ...magnet, trigger_words: JSON.parse(magnet.trigger_words || "[]"), platforms: JSON.parse(magnet.platforms || "[]") },
    sends: allSends.slice(0, 50), byPlatform, totalSent: magnet.stats_sent
  });
});


async function sendSMS(to, body, fromUserId) {
  const db = getDb();
  const sid   = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const token = getSetting("TWILIO_AUTH_TOKEN")   || process.env.TWILIO_AUTH_TOKEN;
  const from  = getSetting("TWILIO_PHONE_NUMBER")  || process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) return { sent: false, reason: "Twilio not configured" };
  try {
    const fetch2 = (await import("node-fetch")).default;
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const r = await fetch2(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });
    const d = await r.json();
    if (fromUserId && d.sid) {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(fromUserId, "sms_sent", JSON.stringify({ to, sid: d.sid }));
    }
    return { sent: !!d.sid, sid: d.sid, error: d.message };
  } catch(e) { return { sent: false, reason: e.message }; }
}

async function sendEmail(userId, to, subject, body, attachments) {
  // Input validation — previously crashed on undefined `to` or `body`.
  // Every caller now gets a boolean return so they can log/retry.
  if (!to || typeof to !== "string") {
    console.warn("[sendEmail] skipped: no recipient");
    return false;
  }
  if (!subject) subject = "(no subject)";
  if (typeof body !== "string") body = String(body || "");

  const db = getDb();
  const sgKey = getSetting("SENDGRID_API_KEY");
  const fromEmail = getSetting("EMAIL_FROM") || "noreply@takeova.ai";

  // Fail-loud if SendGrid isn't configured — previously this silently
  // returned without sending, so every caller thought the email went out.
  if (!sgKey) {
    console.error(`[sendEmail] SENDGRID_API_KEY not configured — email to ${to} NOT sent (subject: "${subject}")`);
    return false;
  }

  // Get user's business name and referral code
  let businessName = "";
  let refCode = "";
  try {
    const user = db.prepare("SELECT name, referral_code FROM users WHERE id = ?").get(userId);
    refCode = user?.referral_code || "";
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(userId);
    businessName = site?.name || user?.name || "Business";
  } catch(e) { businessName = "Business"; }

  const encodedTo = Buffer.from(to.toLowerCase()).toString("base64");
  const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
  const unsubLink = `${backendUrl}/api/features/unsubscribe/${userId}/${encodedTo}`;
  const trackId = require("uuid").v4();

  // Track email
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_tracking (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, track_id TEXT UNIQUE, opened INTEGER DEFAULT 0, opened_at TEXT, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO email_tracking (id, user_id, email, subject, track_id) VALUES (?,?,?,?,?)").run(require("uuid").v4(), userId, to, subject, trackId);
  } catch(e) {}

  const trackPixel = `<img src="${backendUrl}/api/features/track/open/${trackId}" width="1" height="1" style="display:none" />`;
  const mineFooter = `
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #f0f0f0;text-align:center;">
      <a href="https://takeova.ai${refCode ? "?ref=" + refCode : ""}" style="color:#999;font-size:11px;text-decoration:none;">
        Sent via <strong style="color:#2563EB;">MINE</strong>
      </a>
      <br><a href="${unsubLink}" style="color:#bbb;font-size:10px;text-decoration:none;margin-top:4px;display:inline-block">Unsubscribe</a>
    </div>${trackPixel}`;

  try {
    const fetch = (await import("node-fetch")).default;
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${sgKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: businessName },
        subject,
        content: [{ type: "text/html", value: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">${body.replace(/\n/g, "<br>")}${mineFooter}</div>` }],
        ...(attachments?.length ? { attachments } : {}),
      }),
    });
    // Check response — previously the function returned on success even if
    // SendGrid rejected with 400 (unverified sender, invalid address, etc).
    if (!resp.ok) {
      let errBody = "";
      try { errBody = (await resp.text()).slice(0, 300); } catch(_) {}
      console.error(`[sendEmail] SendGrid ${resp.status} for ${to}: ${errBody}`);
      return false;
    }
    // Log successful send
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(userId, "ai_email_sent", JSON.stringify({ to, subject }));
    } catch(_) {}
    return true;
  } catch (e) {
    // Network error / timeout — previously propagated up and could crash
    // callers that didn't wrap the call in try/catch.
    console.error(`[sendEmail] network error for ${to}: ${e.message}`);
    return false;
  }
}

async function triggerScheduled(db, userId, emp, event, data) {
  const roleConfig = AI_ROLES[emp.role];

  // ═══ ENRICH WITH FULL BUSINESS CONTEXT ═══
  // Pull the user's actual business data so AI creates RELEVANT content
  const enrichedData = { ...data };

  // Load inspiration media from employee config
  try {
    const inspoMedia = emp.inspiration_media ? JSON.parse(emp.inspiration_media) : [];
    if (inspoMedia.length > 0) {
      enrichedData.inspirationMedia = inspoMedia;
      enrichedData.inspirationNote = `STYLE REFERENCE: The user has uploaded ${inspoMedia.length} inspiration reference(s). Match the visual style, tone, colour palette, layout patterns, and overall aesthetic of these references when creating content. Types: ${inspoMedia.map(i => i.type + ": " + (i.name || "untitled")).join(", ")}`;
    }
    if (emp.brand_voice) {
      enrichedData.brandVoice = emp.brand_voice;
    }
  } catch (e) { /* parse error, skip */ }

  try {
    // 1. User's sites (business name, niche, brand, URL)
    const sites = db.prepare("SELECT id, name, data, custom_domain, deploy_url, template, status FROM sites WHERE user_id = ? LIMIT 5").all(userId);
    const primarySite = sites[0];
    if (primarySite) {
      const siteData = JSON.parse(primarySite.data || "{}");
      enrichedData.business = {
        name: primarySite.name || "Business",
        url: primarySite.custom_domain || primarySite.deploy_url || "",
        template: primarySite.template || "",
      };

      // 2. Products/services (what they sell, prices, descriptions)
      enrichedData.products = (siteData.products || []).slice(0, 15).map(p => ({
        name: p.name, price: p.price, desc: (p.desc || "").substring(0, 100), active: p.active
      }));

      // 3. Courses
      enrichedData.courses = (siteData.courses || []).slice(0, 10).map(c => ({
        name: c.name, price: c.price, lessons: (c.lessons || []).length
      }));

      // 4. Blog posts (for repurposing into social content)
      enrichedData.recentBlog = (siteData.blog || siteData.blogPosts || []).slice(0, 5).map(b => ({
        title: b.title, excerpt: (b.content || "").substring(0, 150)
      }));

      // 5. Reviews/testimonials (for social proof content)
      enrichedData.reviews = (siteData.reviews || []).slice(0, 5).map(r => ({
        name: r.name, rating: r.rating, text: (r.text || "").substring(0, 100)
      }));

      // 6. Events (upcoming things to promote)
      enrichedData.upcomingEvents = (siteData.events || []).filter(e => new Date(e.date) > new Date()).slice(0, 5).map(e => ({
        name: e.name, date: e.date, price: e.price
      }));

      // 7. Coupons (active promos to mention)
      enrichedData.activeCoupons = (siteData.coupons || []).filter(c => c.active).slice(0, 3).map(c => ({
        code: c.code, discount: c.discount, type: c.type
      }));

      // 8. Memberships
      enrichedData.memberships = (siteData.memberships || []).slice(0, 5).map(m => ({
        name: m.name, price: m.price, interval: m.interval
      }));
    }

    // 9. Contact/lead count
    const contactCount = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE user_id = ?").get(userId);
    enrichedData.totalContacts = contactCount?.n || 0;

    // 10. Recent social posts (so AI doesn't repeat topics)
    const recentPosts = db.prepare("SELECT content, platform, created_at FROM social_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(userId);
    enrichedData.recentSocialPosts = recentPosts.map(p => ({ text: (p.content || "").substring(0, 100), platform: p.platform, date: p.created_at }));

    // 11. Analytics (what's performing — for ad manager)
    if (emp.role === "community") {
      try {
        const empConfig = JSON.parse(emp.rules || "{}");
        enrichedData.keywords        = empConfig.keywords       || [];
        enrichedData.subreddits      = empConfig.subreddits     || [];
        enrichedData.xHashtags       = empConfig.xHashtags      || [];
        enrichedData.replyStyle      = empConfig.replyStyle      || "helpful";
        enrichedData.maxRepliesPerRun= empConfig.maxRepliesPerRun|| 5;
        enrichedData.includePromotion= empConfig.includePromotion!== false;
        // Recent replies to avoid duplicate engagement
        enrichedData.recentReplies = db.prepare(
          "SELECT external_post_id FROM community_replies WHERE user_id = ? AND datetime(created_at) > datetime('now', '-48 hours')"
        ).all(userId).map(r => r.external_post_id);
      } catch(e) {}
    }
    if (emp.role === "marketing" || emp.role === "social") {
      try {
        const analytics = db.prepare("SELECT page, COUNT(*) as views FROM site_analytics WHERE site_id = ? AND created_at > datetime('now', '-7 days') GROUP BY page ORDER BY views DESC LIMIT 5").all(primarySite?.id || "");
        enrichedData.topPages = analytics;

        const totalViews = db.prepare("SELECT COUNT(*) as n FROM site_analytics WHERE site_id = ? AND created_at > datetime('now', '-7 days')").get(primarySite?.id || "");
        enrichedData.weeklyViews = totalViews?.n || 0;
      } catch (e) { /* analytics table might not exist yet */ }
    }

    // 12. Ad campaign performance (for ad manager)
    if (emp.role === "marketing") {
      try {
        const campaigns = db.prepare("SELECT name, platform, status, daily_budget, total_spent FROM ad_campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(userId);
        enrichedData.activeCampaigns = campaigns;

        const creatives = db.prepare("SELECT headline, body, platform, ctr, conversions FROM ad_creatives WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(userId);
        enrichedData.recentCreatives = creatives.map(c => ({
          headline: c.headline, body: (c.body || "").substring(0, 80),
          platform: c.platform, ctr: c.ctr, conversions: c.conversions
        }));
      } catch (e) { /* ad tables might not exist yet */ }
    }

    // 13. Order/revenue data (for context on what's selling)
    try {
      const recentOrders = db.prepare("SELECT total, status, created_at FROM orders WHERE user_id = ? AND created_at > datetime('now', '-30 days') ORDER BY created_at DESC LIMIT 20").all(userId);
      enrichedData.recentRevenue = recentOrders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
      enrichedData.recentOrderCount = recentOrders.length;
      enrichedData.topSelling = recentOrders.length > 0 ? "Data available" : "No recent orders";
    } catch (e) { /* orders table might not exist */ }

    // ── SALES REP: full lead history + lead scoring context ──────────────────
    if (emp.role === "sales") {
      try {
        // Full lead interaction history for the contact in question
        const contactId = data?.lead?.id || data?.contactId;
        if (contactId) {
          const contact = db.prepare("SELECT * FROM contacts WHERE id = ? AND user_id = ?").get(contactId, userId);
          if (contact) {
            enrichedData.leadProfile = {
              name: contact.name, email: contact.email, phone: contact.phone,
              status: contact.status, source: contact.source, notes: contact.notes,
              totalSpent: contact.total_spent, tags: contact.tags,
              firstSeen: contact.created_at, lastActivity: contact.last_activity,
            };
            // All past emails sent to this contact
            enrichedData.emailHistory = db.prepare(
              "SELECT subject, body, opened, clicked, sent_at FROM email_sends WHERE user_id = ? AND to_email = ? ORDER BY sent_at DESC LIMIT 20"
            ).all(userId, contact.email || "").map(e => ({
              subject: e.subject, preview: (e.body || "").substring(0, 120),
              opened: !!e.opened, clicked: !!e.clicked, date: e.sent_at
            }));
            // Past orders from this contact
            enrichedData.contactOrders = db.prepare(
              "SELECT total, status, created_at FROM orders WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 10"
            ).all(userId, contact.email || "");
          }
        }
        // Lead scoring context — all leads ranked by activity
        const hotLeads = db.prepare(`
          SELECT c.id, c.name, c.email, c.status, c.last_activity, c.total_spent,
                 COUNT(DISTINCT o.id) as order_count,
                 MAX(o.created_at) as last_order
          FROM contacts c
          LEFT JOIN orders o ON o.customer_email = c.email AND o.user_id = c.user_id
          WHERE c.user_id = ? AND c.status IN ('lead','qualified','prospect')
          GROUP BY c.id
          ORDER BY c.last_activity DESC LIMIT 20
        `).all(userId);
        enrichedData.leadsToScore = hotLeads;
      } catch(e) { /* non-fatal */ }
    }

    // ── SUPPORT AGENT: customer ticket history + sentiment trend ─────────────
    if (emp.role === "support") {
      try {
        const ticketEmail = data?.ticket?.customer_email || data?.data?.email;
        if (ticketEmail) {
          // All past tickets from this customer
          enrichedData.customerTicketHistory = db.prepare(
            "SELECT subject, status, notes, created_at FROM support_tickets WHERE user_id = ? AND customer_email = ? ORDER BY created_at DESC LIMIT 10"
          ).all(userId, ticketEmail).map(t => ({
            subject: t.subject, status: t.status,
            notes: (t.notes || "").substring(0, 100), date: t.created_at
          }));
          enrichedData.ticketCount = enrichedData.customerTicketHistory.length;
          // Sentiment trend — are they getting angrier?
          const sentimentHistory = db.prepare(
            "SELECT sentiment, created_at FROM support_tickets WHERE user_id = ? AND customer_email = ? AND sentiment IS NOT NULL ORDER BY created_at DESC LIMIT 5"
          ).all(userId, ticketEmail);
          enrichedData.sentimentTrend = sentimentHistory.map(s => s.sentiment);
          // Flag repeat issue customers
          const sameSubject = enrichedData.customerTicketHistory.filter(t =>
            t.subject && data?.ticket?.subject &&
            t.subject.toLowerCase().includes((data.ticket.subject || "").toLowerCase().split(" ")[0])
          );
          enrichedData.isRepeatIssue = sameSubject.length > 1;
          enrichedData.repeatIssueCount = sameSubject.length;
        }
      } catch(e) { /* non-fatal */ }
    }

    // ── BOOKKEEPER: deep financial analysis data ──────────────────────────────
    if (emp.role === "bookkeeper") {
      try {
        const now = new Date();
        const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().split("T")[0];
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split("T")[0];
        const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth()-2, 1).toISOString().split("T")[0];

        // Revenue by day of week (spot patterns)
        const revByDay = db.prepare(`
          SELECT strftime('%w', created_at) as dow,
                 COALESCE(SUM(total),0) as rev, COUNT(*) as orders
          FROM orders WHERE user_id = ? AND created_at > datetime('now','-90 days')
          GROUP BY dow ORDER BY dow
        `).all(userId);
        enrichedData.revenueByDayOfWeek = revByDay.map(r => ({
          day: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][parseInt(r.dow)] || r.dow,
          revenue: Math.round(r.rev), orders: r.orders
        }));

        // Month over month comparison
        const thisMonth = db.prepare("SELECT COALESCE(SUM(total),0) as rev, COUNT(*) as n FROM orders WHERE user_id = ? AND created_at >= ?").get(userId, monthStart);
        const lastMonth = db.prepare("SELECT COALESCE(SUM(total),0) as rev, COUNT(*) as n FROM orders WHERE user_id = ? AND created_at >= ? AND created_at <= ?").get(userId, lastMonthStart, lastMonthEnd);
        const twoMonths = db.prepare("SELECT COALESCE(SUM(total),0) as rev, COUNT(*) as n FROM orders WHERE user_id = ? AND created_at >= ? AND created_at < ?").get(userId, twoMonthsAgo, lastMonthStart);
        enrichedData.monthlyTrend = {
          thisMonth: { revenue: Math.round(thisMonth?.rev || 0), orders: thisMonth?.n || 0 },
          lastMonth: { revenue: Math.round(lastMonth?.rev || 0), orders: lastMonth?.n || 0 },
          twoMonthsAgo: { revenue: Math.round(twoMonths?.rev || 0), orders: twoMonths?.n || 0 },
        };

        // Revenue concentration risk — single client dependency
        const topClients = db.prepare(`
          SELECT customer_email, customer_name, SUM(total) as rev, COUNT(*) as orders
          FROM orders WHERE user_id = ? AND created_at > datetime('now','-90 days')
          AND customer_email IS NOT NULL AND customer_email != ''
          GROUP BY customer_email ORDER BY rev DESC LIMIT 5
        `).all(userId);
        const totalRev = topClients.reduce((s, c) => s + (c.rev || 0), 0);
        enrichedData.clientConcentration = topClients.map(c => ({
          name: c.customer_name || c.customer_email,
          revenue: Math.round(c.rev), orders: c.orders,
          shareOfRevenue: totalRev > 0 ? Math.round((c.rev / totalRev) * 100) + "%" : "0%"
        }));

        // Average order value trend
        const aovThisMonth = thisMonth?.n > 0 ? Math.round((thisMonth.rev || 0) / thisMonth.n) : 0;
        const aovLastMonth = lastMonth?.n > 0 ? Math.round((lastMonth.rev || 0) / lastMonth.n) : 0;
        enrichedData.aovTrend = { thisMonth: aovThisMonth, lastMonth: aovLastMonth };

        // Discount correlation — does discounting hurt AOV?
        const ordersWithDiscount = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total),0) as rev FROM orders WHERE user_id = ? AND discount_amount > 0 AND created_at > datetime('now','-30 days')").get(userId);
        const ordersNoDiscount = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total),0) as rev FROM orders WHERE user_id = ? AND (discount_amount IS NULL OR discount_amount = 0) AND created_at > datetime('now','-30 days')").get(userId);
        enrichedData.discountImpact = {
          withDiscount: { orders: ordersWithDiscount?.n || 0, avgValue: ordersWithDiscount?.n > 0 ? Math.round((ordersWithDiscount.rev || 0) / ordersWithDiscount.n) : 0 },
          noDiscount: { orders: ordersNoDiscount?.n || 0, avgValue: ordersNoDiscount?.n > 0 ? Math.round((ordersNoDiscount.rev || 0) / ordersNoDiscount.n) : 0 },
        };

        // Unpaid invoices detail
        enrichedData.unpaidInvoiceDetail = db.prepare(
          "SELECT client_name, client_email, total, due_date, invoice_number FROM invoices WHERE user_id = ? AND status IN ('sent','unpaid','overdue') ORDER BY due_date ASC LIMIT 10"
        ).all(userId);

        // Crypto payments — flag for tax treatment
        try {
          const cryptoMonth = new Date().toISOString().slice(0, 7);
          const cryptoData = db.prepare(
            "SELECT COUNT(*) as n, COALESCE(SUM(order_total - platform_fee),0) as rev FROM crypto_orders WHERE user_id = ? AND status = 'confirmed' AND strftime('%Y-%m', confirmed_at) = ?"
          ).get(userId, cryptoMonth);
          if ((cryptoData?.n || 0) > 0) {
            enrichedData.cryptoPaymentsThisMonth = {
              count: cryptoData.n,
              revenue: Math.round(cryptoData.rev || 0),
              taxNote: "Crypto payments have different tax treatment — flag these for your accountant"
            };
          }
        } catch(e) { /* non-fatal — crypto_orders table may not exist yet */ }
      } catch(e) { /* non-fatal */ }
    }

    // ── SOCIAL MANAGER: vision analysis of top posts + engagement data ────────
    if (emp.role === "social") {
      try {
        // Engagement performance per platform
        const postPerformance = db.prepare(`
          SELECT platform,
                 COALESCE(AVG(likes),0) as avg_likes,
                 COALESCE(AVG(comments),0) as avg_comments,
                 COALESCE(AVG(shares),0) as avg_shares,
                 COUNT(*) as post_count
          FROM social_posts WHERE user_id = ? AND created_at > datetime('now','-60 days')
          GROUP BY platform
        `).all(userId);
        enrichedData.platformEngagement = postPerformance;

        // Best performing posts — content patterns to replicate
        const topPosts = db.prepare(`
          SELECT content, platform, likes, comments, shares, created_at
          FROM social_posts WHERE user_id = ?
          ORDER BY (COALESCE(likes,0) + COALESCE(comments,0)*2 + COALESCE(shares,0)*3) DESC LIMIT 5
        `).all(userId);
        enrichedData.topPerformingPosts = topPosts.map(p => ({
          platform: p.platform,
          preview: (p.content || "").substring(0, 150),
          likes: p.likes, comments: p.comments, shares: p.shares,
          date: p.created_at
        }));

        // Worst performing posts — what to avoid
        const bottomPosts = db.prepare(`
          SELECT content, platform, likes, comments, shares, created_at
          FROM social_posts WHERE user_id = ? AND likes IS NOT NULL
          ORDER BY (COALESCE(likes,0) + COALESCE(comments,0)*2 + COALESCE(shares,0)*3) ASC LIMIT 3
        `).all(userId);
        enrichedData.lowPerformingPosts = bottomPosts.map(p => ({
          platform: p.platform,
          preview: (p.content || "").substring(0, 100),
          engagement: (p.likes || 0) + (p.comments || 0) + (p.shares || 0)
        }));

        // Best posting time patterns
        const postTimes = db.prepare(`
          SELECT strftime('%H', created_at) as hour,
                 COALESCE(AVG(likes + comments + shares),0) as avg_engagement
          FROM social_posts WHERE user_id = ? AND likes IS NOT NULL
          GROUP BY hour ORDER BY avg_engagement DESC LIMIT 3
        `).all(userId);
        enrichedData.bestPostingHours = postTimes.map(p => `${p.hour}:00 (avg engagement: ${Math.round(p.avg_engagement)})`);
      } catch(e) { /* non-fatal */ }
    }

    // ── MARKETING MANAGER: dynamic campaign reasoning context ─────────────────
    if (emp.role === "marketing") {
      try {
        // Detailed per-campaign performance with ROAS estimate
        const campaignDetail = db.prepare(`
          SELECT c.id, c.name, c.platform, c.daily_budget, c.total_spent, c.status,
                 COALESCE(SUM(cr.impressions),0) as impressions,
                 COALESCE(SUM(cr.clicks),0) as clicks,
                 COALESCE(SUM(cr.conversions),0) as conversions,
                 COALESCE(SUM(cr.spend),0) as spend,
                 COUNT(cr.id) as creative_count
          FROM ad_campaigns c
          LEFT JOIN ad_creatives cr ON cr.campaign_id = c.id
          WHERE c.user_id = ?
          GROUP BY c.id ORDER BY c.created_at DESC LIMIT 10
        `).all(userId);
        enrichedData.campaignPerformanceDetail = campaignDetail.map(c => ({
          name: c.name, platform: c.platform, status: c.status,
          budget: c.daily_budget, spent: Math.round(c.spend || 0),
          impressions: c.impressions, clicks: c.clicks, conversions: c.conversions,
          ctr: c.impressions > 0 ? ((c.clicks / c.impressions) * 100).toFixed(2) + "%" : "0%",
          convRate: c.clicks > 0 ? ((c.conversions / c.clicks) * 100).toFixed(2) + "%" : "0%",
          creatives: c.creative_count
        }));

        // Best creative copy patterns
        const bestCreatives = db.prepare(`
          SELECT headline, body, platform, impressions, clicks, conversions
          FROM ad_creatives WHERE user_id = ? AND impressions > 50
          ORDER BY (COALESCE(clicks,0) * 1.0 / NULLIF(impressions,0)) DESC LIMIT 5
        `).all(userId);
        enrichedData.bestCreativePatterns = bestCreatives.map(c => ({
          headline: c.headline, preview: (c.body || "").substring(0, 80),
          platform: c.platform,
          ctr: c.impressions > 0 ? ((c.clicks / c.impressions) * 100).toFixed(2) + "%" : "0%"
        }));

        // Platform budget allocation vs performance
        const platformROAS = db.prepare(`
          SELECT c.platform,
                 COALESCE(SUM(cr.spend),0) as total_spend,
                 COALESCE(SUM(cr.conversions),0) as total_conversions
          FROM ad_campaigns c
          LEFT JOIN ad_creatives cr ON cr.campaign_id = c.id
          WHERE c.user_id = ?
          GROUP BY c.platform
        `).all(userId);
        enrichedData.platformEfficiency = platformROAS.map(p => ({
          platform: p.platform, spend: Math.round(p.total_spend),
          conversions: p.total_conversions,
          cpa: p.total_conversions > 0 ? "$" + Math.round(p.total_spend / p.total_conversions) : "no conversions"
        }));
      } catch(e) { /* non-fatal */ }
    }

    // ── COMMUNITY AGENT: engagement memory + thread strategy ─────────────────
    if (emp.role === "community") {
      try {
        // Which communities have driven actual results?
        const communityPerf = db.prepare(`
          SELECT platform, subreddit,
                 COUNT(*) as replies,
                 SUM(CASE WHEN posted = 1 THEN 1 ELSE 0 END) as successful,
                 MAX(created_at) as last_active
          FROM community_replies WHERE user_id = ?
          GROUP BY platform, subreddit ORDER BY replies DESC LIMIT 10
        `).all(userId);
        enrichedData.communityEngagementHistory = communityPerf;

        // Recent reply content — avoid repeating the same angles
        const recentReplyContent = db.prepare(
          "SELECT platform, subreddit, reply_text, post_title, created_at FROM community_replies WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
        ).all(userId).map(r => ({
          platform: r.platform, community: r.subreddit,
          angle: (r.reply_text || "").substring(0, 80),
          context: (r.post_title || "").substring(0, 60),
          date: r.created_at
        }));
        enrichedData.recentReplyAngles = recentReplyContent;

        // Most engaged threads — topics that resonate
        const topThreads = db.prepare(`
          SELECT post_title, subreddit, platform, COUNT(*) as times_engaged
          FROM community_replies WHERE user_id = ? AND posted = 1
          GROUP BY subreddit, platform ORDER BY times_engaged DESC LIMIT 5
        `).all(userId);
        enrichedData.topEngagedCommunities = topThreads;

        // Tone that's working in each community
        enrichedData.communityToneGuide = `Based on ${recentReplyContent.length} past replies, vary angles to avoid sounding repetitive. Previous angles used: ${recentReplyContent.slice(0,5).map(r => r.angle).join(" | ")}`;
      } catch(e) { /* non-fatal */ }
    }

  } catch (e) {
    // If enrichment fails, continue with basic data — don't block the task
    console.error("Context enrichment error:", e.message);
  }

  // Check aiActions cap before firing a Sonnet call — cron runs hourly for all employees
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, userId, "aiActions");
    if (usage.blocked) return { role: emp.role, status: "skipped_no_plan", reason: "Monthly AI action allowance reached — upgrade your plan for more plan" };
    global.mineTrackUsage(db, userId, "aiActions");
  }

  const decision = await decideAction(emp, event, enrichedData, roleConfig);

  if (decision.action) {
    const actionId = uuid();
    const shouldAutoExecute = shouldAutoExecuteAction(emp, decision.confidence, decision.action, decision);

    db.prepare(`INSERT INTO ai_employee_actions (id, user_id, role, action, details, status, confidence, created_at)
      VALUES (?,?,?,?,?,?,?,datetime('now'))`)
      .run(actionId, userId, emp.role, decision.action,
        JSON.stringify({ event, data: enrichedData, reasoning: decision.reasoning, draft: decision.draft }),
        shouldAutoExecute ? "auto_executed" : "pending", decision.confidence);
          notifyApprovalNeeded(db, actionId).catch(function(){});

    if (shouldAutoExecute) {
      try {
        const result = await executeAction(db, { id: actionId, role: emp.role, action: decision.action, details: JSON.stringify({ event, data: enrichedData, draft: decision.draft, reasoning: decision.reasoning }) }, userId);
        db.prepare("UPDATE ai_employee_actions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(result), actionId);
        return { role: emp.role, action: decision.action, status: "completed" };
      } catch (err) {
        return { role: emp.role, action: decision.action, status: "failed", error: err.message };
      }
    }
    return { role: emp.role, action: decision.action, status: "pending_approval" };
  }
  return { role: emp.role, status: "no_action_needed" };
}


// GET /api/ai-employees/community/replies — get recent community replies
router.get("/community/replies", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS community_replies (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT,
      external_post_id TEXT, post_title TEXT, subreddit TEXT,
      reply_text TEXT, posted INTEGER DEFAULT 0, post_error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const replies = db.prepare(
      "SELECT * FROM community_replies WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.userId);
    res.json({ replies });
  } catch(e) { res.json({ replies: [] }); }
});

// POST /api/ai-employees/community/reddit-auth — exchange Reddit credentials for access token
router.post("/community/reddit-auth", auth, async (req, res) => {
  const { clientId, clientSecret, username, password } = req.body;
  if (!clientId || !clientSecret || !username || !password) {
    return res.status(400).json({ error: "All Reddit credentials required" });
  }
  try {
    const fetch = (await import("node-fetch")).default;
    const resp = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": `MINE:CommunityAgent:1.0 (by /u/${username})`
      },
      body: new URLSearchParams({ grant_type: "password", username, password, scope: "submit read" })
    });
    const data = await resp.json();
    if (data.access_token) {
      // Save to platform_settings
      const db = getDb();
      const { getSetting } = require("./integrations");
      db.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?,?)")
        .run("REDDIT_ACCESS_TOKEN", data.access_token);
      db.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?,?)")
        .run("REDDIT_USERNAME", username);
      res.json({ success: true, token: data.access_token.substring(0, 8) + "..." });
    } else {
      res.status(400).json({ error: data.error || "Reddit authentication failed" });
    }
  } catch(e) {
    console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});


// ── PDF Upload for Lead Magnets ───────────────────────────────────────────────
router.post("/lead-magnets/upload-pdf", auth, async (req, res) => {
  const { filename, base64, magnetId } = req.body;
  if (!base64 || !filename) return res.status(400).json({ error: "filename and base64 required" });
  // Plan gate
  const db0 = getDb();
  const gate0 = leadMagnetGate(db0, req.userId);
  if (gate0) return res.status(403).json(gate0);
  if (!filename.toLowerCase().endsWith(".pdf")) return res.status(400).json({ error: "Only PDF files accepted" });
  if (base64.length > 10 * 1024 * 1024) return res.status(400).json({ error: "PDF too large — max 7.5MB" });
  const db = getDb();
  const { v4: uid } = require("uuid");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS lead_magnet_pdfs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, magnet_id TEXT,
      filename TEXT, base64 TEXT, s3_url TEXT, size_bytes INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    if (magnetId) {
      db.prepare("DELETE FROM lead_magnet_pdfs WHERE user_id = ? AND magnet_id = ?").run(req.userId, magnetId);
    }
    const id = uid();
    let pdfUrl = null;
    let storedBase64 = null;
    if (isS3Enabled()) {
      // Store PDF in S3 — much better for production
      pdfUrl = await uploadBase64ToS3(base64, `lead-magnets/${req.userId}/${id}.pdf`, "application/pdf");
    } else {
      // Fallback: store base64 in DB (ok for small scale)
      storedBase64 = base64;
    }
    db.prepare("INSERT INTO lead_magnet_pdfs (id, user_id, magnet_id, filename, base64, s3_url, size_bytes) VALUES (?,?,?,?,?,?,?)")
      .run(id, req.userId, magnetId || null, filename, storedBase64, pdfUrl, Math.round(base64.length * 0.75));
    if (magnetId) {
      db.prepare("UPDATE lead_magnets SET pdf_url = ? WHERE id = ? AND user_id = ?")
        .run("__pdf_attachment__", magnetId, req.userId);
    }
    res.json({ success: true, id, filename, sizeKB: Math.round(base64.length * 0.75 / 1024) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});



// ═══════════════════════════════════════════════════════════════════════════════
// SUPPORT AGENT — Email inbound (SendGrid Inbound Parse webhook)
// Configure in SendGrid: Inbound Parse → POST to /api/ai-employees/email-inbound
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/email-inbound", async (req, res) => {
  // Verify SendGrid webhook signature — without this, any internet caller
  // can POST fake "from" addresses to inject messages/contacts into the
  // target user's CRM and trigger automations.
  if (!verifySendgridSig(req)) {
    return res.status(403).json({ error: "Invalid signature" });
  }
  res.sendStatus(200); // SendGrid needs 200 immediately
  const { from, to, subject, text, html } = req.body;
  if (!from) return;

  const db = getDb();
  const { v4: uuid } = require("uuid");

  // Match the To address to a TAKEOVA user (support@their-domain.com → user lookup)
  let userId = null;
  try {
    const domain = (to || "").split("@")[1]?.split(">")[0];
    if (domain) {
      const site = db.prepare("SELECT user_id FROM sites WHERE custom_domain = ? OR deploy_url LIKE ?").get(domain, `%${domain}%`);
      if (site) userId = site.user_id;
    }
    // Fallback: check if support agent email matches
    if (!userId) {
      const emp = db.prepare("SELECT user_id FROM ai_employees WHERE role = 'support' AND enabled = 1 LIMIT 1").get();
      if (emp) userId = emp.user_id;
    }
  } catch(e) {}
  if (!userId) return;

  // Check support agent is enabled
  const emp = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND role = 'support' AND enabled = 1").get(userId);
  if (!emp) return;

  // Create ticket
  const ticketId = uuid();
  const senderEmail = from.replace(/.*<(.+)>/, "$1").trim() || from;
  const senderName  = from.includes("<") ? from.split("<")[0].trim() : senderEmail;
  const content = (text || html || "").replace(/<[^>]+>/g, " ").trim().substring(0, 2000);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY, user_id TEXT, customer_email TEXT, customer_name TEXT,
      subject TEXT, content TEXT, source TEXT DEFAULT 'chat',
      status TEXT DEFAULT 'open', reply TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.prepare("INSERT INTO support_tickets (id, user_id, customer_email, customer_name, subject, content, source) VALUES (?,?,?,?,?,?,?)")
      .run(ticketId, userId, senderEmail, senderName, subject || "(no subject)", content, "email");
  } catch(e) { return; }

  // Trigger support agent to respond
  setImmediate(async () => {
    try {
      const decision = await decideAction(emp, "new_ticket", {
        email: senderEmail, customerName: senderName,
        ticketContent: content, subject, ticketId, source: "email"
      }, AI_ROLES["support"]);
      if (decision.action) {
        await executeAction(db, {
          id: uuid(), role: "support", action: decision.action,
          details: JSON.stringify({ event: "new_ticket", data: { email: senderEmail, customerName: senderName, ticketContent: content, subject, ticketId }, draft: decision.draft })
        }, userId);
      }
    } catch(e) { console.error("[EmailInbound]", e.message); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COLD EMAIL AGENT — SendGrid reply detection webhook
// Configure in SendGrid: Event Webhook → POST to /api/ai-employees/reply-webhook
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/reply-webhook", async (req, res) => {
  // ── SendGrid event webhook signature verification ──
  // Prevents attackers from injecting fake "open"/"click" events.
  const sgWebhookKey = process.env.SENDGRID_WEBHOOK_KEY || (function(){
    try { return require("../db/init").getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get("SENDGRID_WEBHOOK_KEY")?.value; } catch(_) { return null; }
  })();
  if (sgWebhookKey) {
    try {
      const cryptoMod = require("crypto");
      const signature = req.headers["x-twilio-email-event-webhook-signature"] || "";
      const timestamp = req.headers["x-twilio-email-event-webhook-timestamp"] || "";
      const rawBody   = req.rawBody || JSON.stringify(req.body);
      const expected  = cryptoMod.createHmac("sha256", sgWebhookKey).update(timestamp + rawBody).digest("base64");
      const sigBuf    = Buffer.from(signature);
      const expBuf    = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !cryptoMod.timingSafeEqual(sigBuf, expBuf)) {
        return res.status(403).json({ error: "Invalid webhook signature" });
      }
    } catch(e) {
      return res.status(403).json({ error: "Webhook verification failed" });
    }
  }
  res.sendStatus(200);
  const events = Array.isArray(req.body) ? req.body : [req.body];
  const db = getDb();
  const { v4: uuid } = require("uuid");

  for (const event of events) {
    if (event.event !== "open" && event.event !== "click" && event.event !== "delivered") {
      // Only care about replies — SendGrid sends "inbound" for replies
      continue;
    }
    // For reply detection use inbound parse above; here track opens
    if (event.event === "open" && event.email) {
      try {
        db.prepare("UPDATE email_tracking SET opened = 1, opened_at = datetime('now') WHERE track_id = ?")
          .run(event.sg_message_id || "");
        // Notify owner of open
        const tracking = db.prepare("SELECT user_id, email FROM email_tracking WHERE track_id = ?").get(event.sg_message_id || "");
        if (tracking) {
          db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
            .run(uuid(), tracking.user_id, "👁", `Cold email opened by ${event.email}`, "Just now");
        }
      } catch(_) {}
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED APPROVAL INBOX — All pending AI actions across all employees
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/approval-inbox", auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS ai_employee_actions (id TEXT PRIMARY KEY, user_id TEXT, role TEXT, action TEXT, details TEXT, status TEXT DEFAULT 'pending', confidence REAL, result TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT)");
    const pending = db.prepare(`
      SELECT a.*, e.custom_name as agent_name
      FROM ai_employee_actions a
      LEFT JOIN ai_employees e ON e.user_id = a.user_id AND e.role = a.role
      WHERE a.user_id = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
      LIMIT 50
    `).all(req.userId);
    res.json({ success: true, pending, count: pending.length });
  } catch(e) {
    res.json({ success: true, pending: [], count: 0 });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVITY LOG — Everything AI employees did this week
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/activity-log", auth, (req, res) => {
  const db = getDb();
  const { days = 7, role } = req.query;
  try {
    const roleFilter = role ? "AND a.role = ?" : "";
    const params = role ? [req.userId, req.userId, role] : [req.userId, req.userId];
    const actions = db.prepare(`
      SELECT a.id, a.role, a.action, a.status, a.confidence, a.created_at, a.completed_at,
             e.custom_name as agent_name,
             json_extract(a.details, '$.reasoning') as reasoning
      FROM ai_employee_actions a
      LEFT JOIN ai_employees e ON e.user_id = a.user_id AND e.role = a.role
      WHERE a.user_id = ? AND datetime(a.created_at) > datetime('now', '-${parseInt(days)} days')
      ${roleFilter}
      ORDER BY a.created_at DESC
      LIMIT 200
    `).all(...params);

    // Summary counts
    const summary = db.prepare(`
      SELECT role, status, COUNT(*) as count
      FROM ai_employee_actions
      WHERE user_id = ? AND datetime(created_at) > datetime('now', '-${parseInt(days)} days')
      GROUP BY role, status
    `).all(req.userId);

    res.json({ success: true, actions, summary, period: `${days} days` });
  } catch(e) {
    res.json({ success: true, actions: [], summary: [], period: `${days} days` });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPEND DASHBOARD — Total AI employee costs breakdown
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/spend", auth, (req, res) => {
  const db = getDb();
  try {
    // Employee subscription costs
    const employees = db.prepare("SELECT role, enabled FROM ai_employees WHERE user_id = ?").all(req.userId);
    const COSTS = { social:89, marketing:89, support:79, bookkeeper:79, legal:89, csm:49, receptionist:99, coo:89, growth:89, community:79, prospector:79, sales:79, proposal:49, coldemail:69 };
    const subscriptionCost = employees.filter(e => e.enabled).reduce((s, e) => s + (COSTS[e.role] || 0), 0);

    // Per-use charges (Runway, Arcads, SMS, etc.)
    const overages = db.prepare(`
      SELECT metric, SUM(total) as total, COUNT(*) as count
      FROM overage_charges
      WHERE user_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
      GROUP BY metric
    `).all(req.userId);

    const totalOverages = overages.reduce((s, o) => s + (o.total || 0), 0);

    // SMS sent this month
    let smsCost = 0;
    try {
      const smsCount = db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE user_id = ? AND action = 'sms_sent' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')").get(req.userId);
      smsCost = (smsCount?.n || 0) * 0.08; // ~$0.08 per SMS via Twilio
    } catch(_) {}

    res.json({
      success: true,
      thisMonth: {
        subscriptions: subscriptionCost,
        perUse: totalOverages,
        sms: smsCost,
        total: subscriptionCost + totalOverages + smsCost
      },
      breakdown: {
        employees: employees.filter(e => e.enabled).map(e => ({ role: e.role, cost: COSTS[e.role] || 0 })),
        overages
      }
    });
  } catch(e) {
    res.json({ success: true, thisMonth: { subscriptions: 0, perUse: 0, sms: 0, total: 0 }, breakdown: { employees: [], overages: [] } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// E-SIGNATURE — Client signs document online (no DocuSign needed)
// GET /api/ai-employees/sign/:token — shows signing page
// POST /api/ai-employees/sign/:token — records signature
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/sign/:token", async (req, res) => {
  const db = getDb();
  try {
    const req2 = db.prepare("SELECT * FROM esign_requests WHERE token = ? AND signed = 0 AND expires_at > datetime('now')").get(req.params.token);
    if (!req2) return res.status(410).send("<h2>This signing link has expired or already been used.</h2>");
    const contract = db.prepare("SELECT title, content FROM contracts WHERE id = ?").get(req2.contract_id);
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign: ${req2.title}</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,sans-serif;max-width:700px;margin:0 auto;padding:20px;color:#1e293b}
.doc{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin:20px 0;max-height:400px;overflow-y:auto;white-space:pre-wrap;font-size:13px;line-height:1.7}
.sig-box{border:2px solid #2563EB;border-radius:8px;padding:16px;margin:20px 0}
input[type=text]{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:6px;font-size:16px;font-style:italic}
button{width:100%;padding:14px;background:#2563EB;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;margin-top:12px}</style></head>
<body><h1>Sign Document</h1><p>Please review <strong>${req2.title}</strong> below and type your full name to sign.</p>
<div class="doc">${contract?.content?.replace(/</g,"&lt;") || "(Document content not available)"}</div>
<div class="sig-box"><label>Type your full name to sign:</label>
<input type="text" id="sig" placeholder="Your full legal name" />
<button onclick="sign()">Sign Document →</button></div>
<script>async function sign(){
  const sig=document.getElementById('sig').value.trim();
  if(!sig){alert('Please type your full name');return;}
  const r=await fetch('/api/ai-employees/sign/${req.params.token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({signature:sig})});
  const d=await r.json();
  if(d.success){document.body.innerHTML='<div style="text-align:center;padding:60px"><h1>✅ Signed!</h1><p>Thank you — a copy has been emailed to you.</p></div>';}
  else{alert(d.error||'Signing failed');}
}</script></body></html>`);
  } catch(e) { res.status(500).send("Error"); }
});

router.post("/sign/:token", async (req, res) => {
  const db = getDb();
  const { signature } = req.body;
  if (!signature) return res.status(400).json({ error: "Signature required" });
  try {
    const req2 = db.prepare("SELECT * FROM esign_requests WHERE token = ? AND signed = 0 AND expires_at > datetime('now')").get(req.params.token);
    if (!req2) return res.status(410).json({ error: "Link expired or already used" });
    const ip = req.ip || req.headers["x-forwarded-for"] || "";
    db.prepare("UPDATE esign_requests SET signed = 1, signed_at = datetime('now'), signed_ip = ? WHERE token = ?").run(ip, req.params.token);
    // Update contract status
    db.prepare("UPDATE contracts SET status = 'signed', signed_at = datetime('now'), client_signature = ? WHERE id = ? AND user_id = ?")
      .run(signature, req2.contract_id, req2.user_id);
    // Notify owner
    const { v4: uuid } = require("uuid");
    db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
      .run(uuid(), req2.user_id, "✍️", `${req2.client_name || req2.client_email} signed "${req2.title}"`, "Just now");
    // Email confirmation to client
    await sendEmail(req2.user_id, req2.client_email,
      `Signed copy: ${req2.title}`,
      `<p>Hi ${req2.client_name || "there"},</p><p>Thank you for signing <strong>${req2.title}</strong>.</p><p>Signed by: <em>${signature}</em> on ${new Date().toLocaleDateString()}</p><p>We have a copy on file.</p>`
    );
    res.json({ success: true });
  } catch(e) { console.error("[/sign/:token]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// OUTBOUND CALL TwiML — what the receptionist says on outbound calls
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/voice/outbound-twiml", (req, res) => {
  // Verify Twilio signature — without this, anyone can hit this endpoint
  // and see the TwiML template, or inject XML via the `name`/`reason`
  // query params (TwiML <Say> content reflection).
  if (!verifyTwilioSig(req, "/api/ai-employees/voice/outbound-twiml")) {
    return res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
  }
  const { name, reason } = req.query;
  // XML-escape interpolated query params so they can't break out of <Say>.
  const xe = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
  const db = getDb();
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Hello, may I speak with ${xe(name) || "the owner"}? This is a call from your AI Receptionist regarding ${xe(reason) || "a follow up"}. Please hold for a moment.</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna">If you'd like to schedule an appointment or have any questions, please call us back at your convenience. Thank you and have a great day!</Say>
</Response>`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROSPECTOR CLAIM PAGE — takeova.ai/claim?code=XXX&biz=Business+Name
// Business owners land here after receiving a cold email/SMS
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/claim", (req, res) => {
  const { code, biz, demo } = req.query;
  const bizName = decodeURIComponent(biz || "Your Business");
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claim your free website — MINE</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700;900&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#0A0F1E;color:#fff;min-height:100vh}
.hero{padding:60px 20px;text-align:center;max-width:600px;margin:0 auto}
h1{font-size:clamp(28px,5vw,48px);font-weight:900;line-height:1.1;margin-bottom:16px}
h1 span{color:#2563EB}
p{color:#94A3B8;font-size:16px;line-height:1.7;margin-bottom:32px}
.card{background:#111827;border:1px solid #1e293b;border-radius:14px;padding:28px;margin-bottom:16px;text-align:left}
.card h3{font-size:16px;margin-bottom:8px}
.card p{font-size:14px;margin-bottom:0}
.btn{display:block;padding:16px;background:#2563EB;color:#fff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:700;text-align:center;margin-bottom:12px}
.btn-secondary{background:transparent;border:1px solid #1e293b}
form input{width:100%;padding:12px 16px;background:#0A0F1E;border:1px solid #1e293b;border-radius:8px;color:#fff;font-size:15px;margin-bottom:12px;font-family:inherit}
form input:focus{outline:none;border-color:#2563EB}
.features{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:28px 0}
.feat{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:14px}
.feat .icon{font-size:20px;margin-bottom:6px}
.feat p{font-size:12px;color:#64748b;margin-bottom:0}</style></head>
<body><div class="hero">
<p style="font-size:12px;letter-spacing:2px;color:#2563EB;text-transform:uppercase;margin-bottom:16px">Built just for you</p>
<h1>${bizName} — your <span>free AI website</span> is ready</h1>
<p>We built you a complete AI-powered website — bookings, payments, reviews and marketing all included. Yours free to keep. No credit card needed to claim it.</p>
${demo ? `<a href="${demo}" target="_blank" class="btn">👀 Preview your site →</a>` : ""}
<div class="card" style="margin-top:24px"><h3>Claim your site in 60 seconds</h3>
<form onsubmit="claim(event)">
<input type="text" id="name" placeholder="Your name" required />
<input type="email" id="email" placeholder="Email address" required />
<input type="tel" id="phone" placeholder="Phone number" />
<button type="submit" class="btn" style="border:none;cursor:pointer;width:100%">Claim my free website →</button>
</form></div>
<div class="features">
<div class="feat"><div class="icon">📅</div><p>Online bookings 24/7</p></div>
<div class="feat"><div class="icon">💳</div><p>Accept payments online</p></div>
<div class="feat"><div class="icon">⭐</div><p>Review management</p></div>
<div class="feat"><div class="icon">📱</div><p>Auto social posting</p></div>
</div>
<p style="font-size:12px;color:#475569">No credit card. No setup fees. Free forever, upgrade anytime.</p>
</div>
<script>async function claim(e){
  e.preventDefault();
  const btn=e.target.querySelector('button');
  btn.textContent='Claiming...';btn.disabled=true;
  const data={name:document.getElementById('name').value,email:document.getElementById('email').value,phone:document.getElementById('phone').value,code:'${code||""}',biz:'${bizName}'};
  const r=await fetch('/api/ai-employees/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const d=await r.json();
  if(d.success){document.body.innerHTML='<div style="text-align:center;padding:80px 20px"><h1 style="font-size:36px;margin-bottom:16px">🎉 Claimed!</h1><p style="color:#94A3B8;font-size:16px">Check your email — your login link is on its way.</p></div>';}
  else{btn.textContent='Claim my free website →';btn.disabled=false;alert(d.error||'Something went wrong');}
}</script></body></html>`);
});

// Handle claim form submission
router.post("/claim", async (req, res) => {
  const { name, email, phone, code, biz } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const db = getDb();
  const { v4: uuid } = require("uuid");
  try {
    // Find the agency user via the invite code
    let agencyUserId = null;
    try {
      const agency = db.prepare("SELECT user_id FROM agencies WHERE invite_code = ?").get(code);
      if (agency) agencyUserId = agency.user_id;
    } catch(_) {}
    // Log the claim
    db.exec("CREATE TABLE IF NOT EXISTS prospect_claims (id TEXT PRIMARY KEY, agency_user_id TEXT, name TEXT, email TEXT, phone TEXT, biz TEXT, code TEXT, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO prospect_claims (id, agency_user_id, name, email, phone, biz, code) VALUES (?,?,?,?,?,?,?)")
      .run(uuid(), agencyUserId, name, email, phone || "", biz || "", code || "");
    // Notify the agency owner
    if (agencyUserId) {
      db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
        .run(uuid(), agencyUserId, "🔥", `${name} from ${biz} just claimed their free site! Follow up now.`, "Just now");
    }
    // Send magic login link to the prospect.
    // Store only the SHA-256 hash — matches auth.js password-reset hardening.
    const loginToken = uuid().replace(/-/g,"");
    const loginTokenHash = require("crypto").createHash("sha256").update(loginToken).digest("hex");
    db.prepare("INSERT OR IGNORE INTO password_resets (id, token, email, expires_at) VALUES (?,?,?,datetime('now','+24 hours'))")
      .run(uuid(), loginTokenHash, email);
    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
    const sgKey = getSetting("SENDGRID_API_KEY");
    if (sgKey) {
      const fetch2 = (await import("node-fetch")).default;
      const _sgResp = await fetch2("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${sgKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email, name }] }],
          from: { email: getSetting("EMAIL_FROM") || "hello@takeova.ai", name: "MINE" },
          subject: "Your free website is ready — log in now",
          content: [{ type: "text/html", value: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:40px 20px">
            <h2>Hey ${name}! 👋</h2>
            <p>Your free AI-powered website for <strong>${biz}</strong> is ready.</p>
            <a href="${frontendUrl}/?token=${loginToken}" style="display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:20px 0">Log in to your site →</a>
            <p style="font-size:12px;color:#94A3B8">This link expires in 24 hours. No password needed.</p>
          </div>` }]
        })
      });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    }
    res.json({ success: true });
  } catch(e) { console.error("[/claim]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

module.exports = router;
// ─── HeyGen video engine (2026-06-11): the routes the social flow + Video tab already call ───
// NOTE FOR DEV: payload follows HeyGen v2 API (api.heygen.com/v2/video/generate); verify fields against current docs on first live run.
async function _heygenCreate({ script, dimension }) {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) return { ok: false, error: "HeyGen not configured — set HEYGEN_API_KEY (and HEYGEN_AVATAR_ID)." };
  const avatar = process.env.HEYGEN_AVATAR_ID || "default";
  try {
    const r = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST", headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ video_inputs: [{ character: { type: "avatar", avatar_id: avatar }, voice: { type: "text", input_text: String(script).slice(0, 1400) } }], dimension: dimension || { width: 720, height: 1280 } })
    });
    const d = await r.json().catch(() => ({}));
    const vid = d && d.data && (d.data.video_id || d.data.id);
    if (!r.ok || !vid) return { ok: false, error: (d && (d.error?.message || d.message)) || ("HeyGen HTTP " + r.status) };
    return { ok: true, videoId: vid };
  } catch (e) { return { ok: false, error: e.message }; }
}
router.post("/heygen/ugc-product-v2", auth, async (req, res) => {
  try {
    const b = req.body || {};
    let { script, productId, productImageUrl, style } = b;
    if (!script && productId) {
      try {
        const db = require("../db/init").getDb();
        const prod = db.prepare("SELECT p.name, p.description FROM products p JOIN sites s ON p.site_id=s.id WHERE p.id=? AND s.user_id=?").get(productId, req.userId);
        if (prod) script = "Meet " + prod.name + " — " + String(prod.description || "our newest favourite").slice(0, 140) + ". " + (style || "trending") + " pick of the week. Tap to shop!";
      } catch (_e) {}
    }
    if (!script) return res.json({ success: false, error: "script or productId required" });
    const out = await _heygenCreate({ script });
    if (!out.ok) return res.json({ success: false, error: out.error });
    res.json({ success: true, id: out.videoId, taskId: out.videoId, status: "rendering", script, pollUrl: "/ai-employees/heygen/status/" + out.videoId });
  } catch (e) { console.error("[heygen/ugc]", e.message); res.status(500).json({ error: "An internal error occurred" }); }
});
router.post("/heygen/generate-av4", auth, async (req, res) => {
  try {
    const script = String((req.body && req.body.script) || "").trim();
    if (!script) return res.json({ success: false, error: "script required" });
    const out = await _heygenCreate({ script });
    res.json(out.ok ? { success: true, id: out.videoId, taskId: out.videoId, status: "rendering", script, pollUrl: "/ai-employees/heygen/status/" + out.videoId } : { success: false, error: out.error });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});
router.get("/heygen/status/:id", auth, async (req, res) => {
  try {
    const key = process.env.HEYGEN_API_KEY;
    if (!key) return res.json({ status: "error", error: "HeyGen not configured" });
    const r = await fetch("https://api.heygen.com/v1/video_status.get?video_id=" + encodeURIComponent(req.params.id), { headers: { "X-Api-Key": key } });
    const d = await r.json().catch(() => ({}));
    const st = d && d.data ? d.data : {};
    res.json({ status: st.status || "unknown", url: st.video_url || null, error: st.error || null });
  } catch (e) { res.json({ status: "error", error: e.message }); }
});

module.exports.doResearch = doResearch;
// 🤝 AUTONOMOUS CSM (2026-06-13): scans at-risk customers, proposes win-backs; Full=send, Half/Review=queue
router.post("/csm/scan", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    // only run autonomously if the CSM is actually hired/enabled
    try { const _hired = db.prepare("SELECT id FROM ai_employees WHERE user_id=? AND role='csm' AND enabled=1").get(userId); if (!_hired) return res.json({ success: true, created: 0, queued: 0, note: "Hire the Customer Success agent to enable autonomous win-backs" }); } catch(_e) {}
    // autonomy for the csm employee
    let mode = "suggest";
    try { const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? AND role='csm'").get(userId); mode = getAutonomyMode ? getAutonomyMode(emp || {}) : "suggest"; } catch(_e) {}

    // at-risk detection: contacts with no activity in 45+ days (reuses the same idea as atRiskContacts)
    let risky = [];
    try {
      risky = db.prepare(`SELECT id, name, email,
        COALESCE(last_activity, last_contacted, created_at) AS last_touch
        FROM contacts WHERE user_id=? AND email IS NOT NULL AND email != ''
        AND COALESCE(last_activity, last_contacted, created_at) <= datetime('now','-45 day')
        ORDER BY last_touch ASC LIMIT 15`).all(userId);
    } catch(_e) {}
    if (!risky.length) return res.json({ success: true, mode, created: 0, queued: 0, note: "No at-risk customers right now" });

    const biz = (db.prepare("SELECT business_name FROM users WHERE id=?").get(userId)||{}).business_name || "your business";
    // ask Claude to prioritise the top few + draft a personal win-back line each
    let proposals = [];
    try {
      const Anthropic = require("@anthropic-ai/sdk");
      if (process.env.ANTHROPIC_API_KEY) {
        const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
        const sys = 'You are a retention specialist. Given at-risk customers (no activity 45+ days), pick up to 3 worth a personal win-back and draft a warm one-sentence message each. Return ONLY JSON: [{"contactId":"<id from list>","title":"Win back <name>","reason":"one sentence","message":"personal win-back line"}]. No prose outside JSON.';
        const msg = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 700, system: sys,
          messages: [{ role: "user", content: "Business: " + biz + ". At-risk: " + JSON.stringify(risky.map(r=>({id:r.id,name:r.name,last_touch:r.last_touch}))) }] });
        let txt = (msg.content && msg.content[0] && msg.content[0].text || "").trim().replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
        try { proposals = JSON.parse(txt); } catch(_e) {}
      }
    } catch(_e) {}
    if (!Array.isArray(proposals) || !proposals.length) {
      // fallback: propose the 3 most-overdue with a default line
      proposals = risky.slice(0,3).map(r => ({ contactId: r.id, title: "Win back " + (r.name||"customer"), reason: "No activity since " + String(r.last_touch).slice(0,10), message: "Hi " + ((r.name||"there").split(" ")[0]) + "! We miss you at " + biz + " — here's 10% off to welcome you back." }));
    }
    const validIds = new Set(risky.map(r=>r.id));
    proposals = proposals.filter(p => p && validIds.has(p.contactId)).slice(0,3);

    let created = 0, queued = 0;
    db.prepare("CREATE TABLE IF NOT EXISTS autopilot_actions (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, input_json TEXT, title TEXT, reason TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, executed_at TEXT)").run();
    for (const p of proposals) {
      if (mode === "auto") {
        try { const mc = require("./mine-control"); const out = await mc.executeTool(db, userId, "send_winback", { contactId: p.contactId, message: p.message }); if (out && out.success) created++; } catch(_e) {}
      } else {
        const dup = db.prepare("SELECT 1 FROM autopilot_actions WHERE user_id=? AND type='send_winback' AND input_json LIKE ? AND status='pending'").get(userId, '%"'+p.contactId+'"%');
        if (!dup) {
          db.prepare("INSERT INTO autopilot_actions (id,user_id,type,input_json,title,reason) VALUES (?,?,?,?,?,?)")
            .run(require("uuid").v4(), userId, "send_winback", JSON.stringify({ contactId: p.contactId, message: p.message }), "🤝 " + String(p.title||"Win-back").slice(0,88), String(p.reason||"").slice(0,200));
          queued++;
        }
      }
    }
    try {
      const { v4: _uuid } = require("uuid");
      db.prepare("CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, icon TEXT, text TEXT, type TEXT, read INTEGER DEFAULT 0, time TEXT DEFAULT CURRENT_TIMESTAMP)").run();
      if (created > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83e\udd1d", "Customer Success sent " + created + " win-back(s) to at-risk customers.");
      else if (queued > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83e\udd1d", "Customer Success found " + risky.length + " at-risk customer(s) \u2014 " + queued + " win-back(s) waiting for approval.");
    } catch(_e) {}
    res.json({ success: true, mode, created, queued, atRisk: risky.length,
      message: mode === "auto" ? (created + " win-back(s) sent") : (queued + " win-back(s) waiting for your approval") });
  } catch (e) { console.error("[csm/scan]", e.message); res.status(500).json({ error: "CSM scan failed: " + e.message }); }
});

// 💼 AUTONOMOUS SALES (2026-06-13): finds warm leads going cold, proposes follow-ups; Full=send, Half/Review=queue
router.post("/sales/scan", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    // hired gate
    try { const _h = db.prepare("SELECT id FROM ai_employees WHERE user_id=? AND role='sales' AND enabled=1").get(userId); if (!_h) return res.json({ success: true, created: 0, queued: 0, note: "Hire the AI Sales Rep to enable autonomous follow-ups" }); } catch(_e) {}
    let mode = "suggest";
    try { const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? AND role='sales'").get(userId); mode = getAutonomyMode ? getAutonomyMode(emp || {}) : "suggest"; } catch(_e) {}

    // find WARM contacts going cold: engaged/opened or bought once, but no contact in 5–30 days, not already customers churned
    let warm = [];
    try {
      warm = db.prepare(`
        SELECT c.id, c.name, c.email,
          COALESCE(c.last_contacted, c.last_activity, c.created_at) AS last_touch,
          (SELECT COUNT(*) FROM orders o WHERE o.user_id=c.user_id AND o.customer_email=c.email) AS orders
        FROM contacts c
        WHERE c.user_id=? AND c.email IS NOT NULL AND c.email != ''
          AND COALESCE(c.last_contacted, c.last_activity, c.created_at) BETWEEN datetime('now','-30 day') AND datetime('now','-5 day')
        ORDER BY orders DESC, last_touch ASC LIMIT 15`).all(userId);
    } catch(_e) {}
    if (!warm.length) return res.json({ success: true, mode, created: 0, queued: 0, note: "No warm leads need a nudge right now" });

    const biz = (db.prepare("SELECT business_name FROM users WHERE id=?").get(userId)||{}).business_name || "your business";
    // ask Claude to pick the top few worth a follow-up + why
    let proposals = [];
    try {
      const Anthropic = require("@anthropic-ai/sdk");
      if (process.env.ANTHROPIC_API_KEY) {
        const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
        const sys = 'You are a sharp sales rep. From these warm-but-cooling leads, pick up to 3 most worth a personal follow-up now. Prioritise past buyers and recent engagement. Return ONLY JSON: [{"contactName":"<name from list>","reason":"one sentence why now"}]. No prose outside JSON.';
        const msg = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 600, system: sys,
          messages: [{ role: "user", content: "Business: " + biz + ". Leads: " + JSON.stringify(warm.map(w=>({name:w.name,orders:w.orders,last_touch:w.last_touch}))) }] });
        let txt = (msg.content && msg.content[0] && msg.content[0].text || "").trim().replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
        try { proposals = JSON.parse(txt); } catch(_e) {}
      }
    } catch(_e) {}
    if (!Array.isArray(proposals) || !proposals.length) {
      proposals = warm.slice(0,3).map(w => ({ contactName: w.name, reason: (w.orders>0 ? "Past buyer" : "Engaged lead") + ", quiet since " + String(w.last_touch).slice(0,10) }));
    }
    const byName = new Map(warm.map(w=>[String(w.name||"").toLowerCase(), w]));
    proposals = proposals.filter(p => p && p.contactName && byName.has(String(p.contactName).toLowerCase())).slice(0,3);

    let created = 0, queued = 0;
    db.prepare("CREATE TABLE IF NOT EXISTS autopilot_actions (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, input_json TEXT, title TEXT, reason TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, executed_at TEXT)").run();
    for (const p of proposals) {
      const input = { contact_name: p.contactName };
      if (mode === "auto") {
        try { const mc = require("./mine-control"); const out = await mc.executeTool(db, userId, "send_followup", input); if (out && (out.sent || out.queued || out.success)) created++; } catch(_e) {}
      } else {
        const dup = db.prepare("SELECT 1 FROM autopilot_actions WHERE user_id=? AND type='send_followup' AND title LIKE ? AND status='pending'").get(userId, '%'+String(p.contactName).slice(0,40)+'%');
        if (!dup) {
          db.prepare("INSERT INTO autopilot_actions (id,user_id,type,input_json,title,reason) VALUES (?,?,?,?,?,?)")
            .run(require("uuid").v4(), userId, "send_followup", JSON.stringify(input), "\ud83d\udcbc Follow up with " + String(p.contactName).slice(0,70), String(p.reason||"").slice(0,200));
          queued++;
        }
      }
    }
    try {
      const { v4: _uuid } = require("uuid");
      db.prepare("CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, icon TEXT, text TEXT, type TEXT, read INTEGER DEFAULT 0, time TEXT DEFAULT CURRENT_TIMESTAMP)").run();
      if (created > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83d\udcbc", "AI Sales Rep followed up with " + created + " warm lead(s) automatically.");
      else if (queued > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83d\udcbc", "AI Sales Rep found " + warm.length + " cooling lead(s) \u2014 " + queued + " follow-up(s) waiting for approval.");
    } catch(_e) {}
    res.json({ success: true, mode, created, queued, warm: warm.length,
      message: mode === "auto" ? (created + " follow-up(s) sent") : (queued + " follow-up(s) waiting for approval") });
  } catch (e) { console.error("[sales/scan]", e.message); res.status(500).json({ error: "Sales scan failed: " + e.message }); }
});

// 💰 AUTONOMOUS BOOKKEEPER (2026-06-13): detects overdue invoices, proposes chases; Full=send, Half/Review=queue
router.post("/bookkeeper/scan", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    // bookkeeper is a core money agent — but still respect an explicit disable if a row exists
    try { const row = db.prepare("SELECT enabled FROM ai_employees WHERE user_id=? AND role='bookkeeper'").get(userId); if (row && row.enabled === 0) return res.json({ success: true, created: 0, queued: 0, note: "Bookkeeper is switched off" }); } catch(_e) {}
    let mode = "suggest";
    try { const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? AND role='bookkeeper'").get(userId); mode = getAutonomyMode ? getAutonomyMode(emp || {}) : "suggest"; } catch(_e) {}

    // find overdue invoices
    let overdue = [];
    try {
      overdue = db.prepare("SELECT id, total, due_date FROM invoices WHERE user_id=? AND status NOT IN ('paid','draft','void','cancelled') AND due_date IS NOT NULL AND due_date < datetime('now') ORDER BY due_date ASC LIMIT 50").all(userId);
    } catch(_e) {}
    if (!overdue.length) return res.json({ success: true, mode, created: 0, queued: 0, note: "No overdue invoices \u2014 your cashflow is clean" });

    const totalOwed = overdue.reduce((a,i)=>a+(i.total||0),0);
    let created = 0, queued = 0;
    db.prepare("CREATE TABLE IF NOT EXISTS autopilot_actions (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, input_json TEXT, title TEXT, reason TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, executed_at TEXT)").run();
    if (mode === "auto") {
      try { const mc = require("./mine-control"); const out = await mc.executeTool(db, userId, "chase_invoices", { confirm: true }); if (out && out.success) created = out.chased || overdue.length; } catch(_e) {}
    } else {
      const dup = db.prepare("SELECT 1 FROM autopilot_actions WHERE user_id=? AND type='chase_invoices' AND status='pending'").get(userId);
      if (!dup) {
        db.prepare("INSERT INTO autopilot_actions (id,user_id,type,input_json,title,reason) VALUES (?,?,?,?,?,?)")
          .run(require("uuid").v4(), userId, "chase_invoices", JSON.stringify({ confirm: true }), "\ud83d\udcb0 Chase " + overdue.length + " overdue invoice(s)", "$" + Math.round(totalOwed) + " owed to you across " + overdue.length + " invoice(s)");
        queued = 1;
      }
    }
    try {
      const { v4: _uuid } = require("uuid");
      db.prepare("CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, icon TEXT, text TEXT, type TEXT, read INTEGER DEFAULT 0, time TEXT DEFAULT CURRENT_TIMESTAMP)").run();
      if (created > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83d\udcb0", "Bookkeeper chased " + created + " overdue invoice(s) \u2014 $" + Math.round(totalOwed) + " owed.");
      else if (queued > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83d\udcb0", "Bookkeeper found " + overdue.length + " overdue invoice(s) ($" + Math.round(totalOwed) + ") \u2014 chase waiting for approval.");
    } catch(_e) {}
    res.json({ success: true, mode, created, queued, overdue: overdue.length, owed: Math.round(totalOwed),
      message: mode === "auto" ? ("Chased " + created + " overdue invoice(s)") : ("Chase for " + overdue.length + " invoice(s) waiting for approval") });
  } catch (e) { console.error("[bookkeeper/scan]", e.message); res.status(500).json({ error: "Bookkeeper scan failed: " + e.message }); }
});

// 🎧 AUTONOMOUS SUPPORT (2026-06-13): finds stale open tickets, drafts replies; Full=draft+notify, Half/Review=queue
router.post("/support/scan", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    try { const _h = db.prepare("SELECT id FROM ai_employees WHERE user_id=? AND role='support' AND enabled=1").get(userId); if (!_h) return res.json({ success: true, created: 0, queued: 0, note: "Hire the AI Support Agent to enable autonomous triage" }); } catch(_e) {}
    let mode = "suggest";
    try { const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? AND role='support'").get(userId); mode = getAutonomyMode ? getAutonomyMode(emp || {}) : "suggest"; } catch(_e) {}

    // stale open tickets: open/new, created >4h ago, oldest first
    let stale = [];
    try {
      stale = db.prepare("SELECT id, subject FROM support_tickets WHERE user_id=? AND status IN ('open','new','pending') AND created_at <= datetime('now','-4 hour') ORDER BY created_at ASC LIMIT 10").all(userId);
    } catch(_e) {
      try { stale = db.prepare("SELECT id, subject FROM tickets WHERE user_id=? AND status IN ('open','new','pending') AND created_at <= datetime('now','-4 hour') ORDER BY created_at ASC LIMIT 10").all(userId); } catch(_e2) {}
    }
    if (!stale.length) return res.json({ success: true, mode, created: 0, queued: 0, note: "No tickets waiting \u2014 support is on top of things" });

    let created = 0, queued = 0;
    db.prepare("CREATE TABLE IF NOT EXISTS autopilot_actions (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, input_json TEXT, title TEXT, reason TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, executed_at TEXT)").run();
    for (const t of stale.slice(0,5)) {
      const input = { ticketId: t.id };
      if (mode === "auto") {
        // Full auto = draft the reply (still leaves it for the owner to send — replying to customers unprompted is high-stakes)
        try { const mc = require("./mine-control"); const out = await mc.executeTool(db, userId, "draft_ticket_reply", input); if (out && out.success) created++; } catch(_e) {}
      } else {
        const dup = db.prepare("SELECT 1 FROM autopilot_actions WHERE user_id=? AND type='draft_ticket_reply' AND input_json LIKE ? AND status='pending'").get(userId, '%"'+t.id+'"%');
        if (!dup) {
          db.prepare("INSERT INTO autopilot_actions (id,user_id,type,input_json,title,reason) VALUES (?,?,?,?,?,?)")
            .run(require("uuid").v4(), userId, "draft_ticket_reply", JSON.stringify(input), "\ud83c\udfa7 Draft reply: " + String(t.subject||"ticket").slice(0,60), "Open ticket waiting over 4 hours");
          queued++;
        }
      }
    }
    try {
      const { v4: _uuid } = require("uuid");
      db.prepare("CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, icon TEXT, text TEXT, type TEXT, read INTEGER DEFAULT 0, time TEXT DEFAULT CURRENT_TIMESTAMP)").run();
      if (created > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83c\udfa7", "Support drafted " + created + " reply(ies) for tickets waiting \u2014 review & send.");
      else if (queued > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83c\udfa7", "Support found " + stale.length + " ticket(s) waiting \u2014 " + queued + " reply draft(s) for approval.");
    } catch(_e) {}
    res.json({ success: true, mode, created, queued, stale: stale.length,
      message: mode === "auto" ? (created + " reply(ies) drafted for your review") : (queued + " reply draft(s) waiting for approval") });
  } catch (e) { console.error("[support/scan]", e.message); res.status(500).json({ error: "Support scan failed: " + e.message }); }
});

module.exports.getAutonomyMode = getAutonomyMode;
module.exports.shouldAutoExecuteAction = shouldAutoExecuteAction;

// ═══════════════════════════════════════
// FEATURE 1: AI VOICE AGENT (6th Employee)
// ═══════════════════════════════════════
// Inbound: customer calls → Twilio webhook → Deepgram STT → Claude AI → ElevenLabs TTS → play back
// Outbound: AI calls leads, confirms bookings, follows up

// Twilio webhook — answers inbound calls
// Public: serve a generated Grok TTS clip (Twilio <Play> fetches this, no auth).
router.get("/voice/clip/:id", (req, res) => {
  const db = getDb();
  const id = String(req.params.id || "").replace(/\.mp3$/i, "");
  try {
    const row = db.prepare("SELECT mime, data FROM voice_audio WHERE id = ?").get(id);
    if (!row || !row.data) return res.status(404).end();
    res.set("Content-Type", row.mime || "audio/mpeg");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data));
  } catch (_) { return res.status(404).end(); }
});

// List available receptionist voices + the user's current selection.
router.get("/voice/voices", auth, (req, res) => {
  const db = getDb();
  let current = "polly";
  try {
    const vs = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'receptionist_voice'").get(req.userId);
    if (vs && vs.value) current = vs.value;
  } catch (_) {}
  const grokEnabled = !!process.env.XAI_API_KEY && grokVoiceEntitled(db, req.userId);
  res.json({
    current,
    grokEnabled,
    grokConfigured: !!process.env.XAI_API_KEY,
    voices: [
      { id: "polly", label: "Default (Twilio - Joanna)", tone: "Standard female", grok: false, sample: null },
      { id: "eve", label: "Eve", tone: "Energetic, upbeat", grok: true, sample: "https://data.x.ai/audio-samples/voice_eve.mp3" },
      { id: "ara", label: "Ara", tone: "Warm, conversational", grok: true, sample: "https://data.x.ai/audio-samples/voice_ara.mp3" },
      { id: "rex", label: "Rex", tone: "Confident, professional", grok: true, sample: "https://data.x.ai/audio-samples/voice_rex.mp3" },
      { id: "sal", label: "Sal", tone: "Smooth, balanced", grok: true, sample: "https://data.x.ai/audio-samples/voice_sal.mp3" },
      { id: "leo", label: "Leo", tone: "Authoritative, strong", grok: true, sample: "https://data.x.ai/audio-samples/voice_leo.mp3" },
    ],
  });
});

// Save the user's chosen receptionist voice.
router.post("/voice/voice", auth, (req, res) => {
  const db = getDb();
  const voice = String((req.body && req.body.voice) || "polly");
  const allowed = ["polly", "eve", "ara", "rex", "sal", "leo"];
  if (!allowed.includes(voice)) return res.status(400).json({ error: "invalid voice" });
  if (GROK_VOICES[voice]) {
    if (!process.env.XAI_API_KEY) return res.status(400).json({ error: "Grok voices are not configured on this server." });
    if (!grokVoiceEntitled(db, req.userId)) return res.status(403).json({ error: "Grok voices require a paid plan.", requiresUpgrade: true });
  }
  try {
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'receptionist_voice', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(req.userId, voice);
  } catch (e) { return res.status(500).json({ error: "could not save voice" }); }
  res.json({ success: true, voice });
});

router.post("/voice/inbound", async (req, res) => {
  // Verify request is genuinely from Twilio using signature validation
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ||
    (() => { try { return require("../db/init").getDb().prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_AUTH_TOKEN'").get()?.value; } catch { return null; } })();
  if (twilioAuthToken) {
    try {
      const twilio = require("twilio");
      const requestUrl = (process.env.BACKEND_URL || "http://localhost:4000") + "/api/ai-employees/voice/inbound";
      const signature = req.headers["x-twilio-signature"] || "";
      const isValid = twilio.validateRequest(twilioAuthToken, signature, requestUrl, req.body);
      if (!isValid) return res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
    } catch(e) { console.error("[/voice/inbound]", e.message || e); }
  }
  const { CallSid, From, To, CallStatus } = req.body;
  const db = getDb();

  // Find which user owns this phone number
  const setting = db.prepare("SELECT user_id FROM user_voice_numbers WHERE phone_number = ?").get(To);
  if (!setting) {
    res.type("text/xml").send(`<Response><Say>Sorry, this number is not configured.</Say></Response>`);
    return;
  }
  const userId = setting.user_id;
  const vctx = computeVoiceCtx(db, userId); /*VOICECTX*/

  // Get voice agent config
  const agent = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(userId);

  // Enforce voiceMins plan cap for inbound calls (estimated 5 mins per call)
  if (agent && typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, userId, "voiceMins");
    if (usage.blocked) {
      await sendVoiceTwiml(res, db, vctx, `<Response><Say>Sorry, this business is currently unavailable for AI calls. Please contact them directly.</Say><Hangup/></Response>`);
      return;
    }
    global.mineTrackUsage(db, userId, "voiceMins", 5);
  }
  if (!agent) {
    await sendVoiceTwiml(res, db, vctx, `<Response><Say>Thank you for calling. Please leave a message after the beep.</Say><Record maxLength="120" action="/ai-employees/voice/recording"/></Response>`);
    return;
  }

  // Get business context
  const site = db.prepare("SELECT name, data FROM sites WHERE user_id = ? LIMIT 1").get(userId);
  const siteData = site ? JSON.parse(site.data || "{}") : {};
  const products = (siteData.products || []).slice(0, 10).map(p => `${p.name} ($${p.price})`).join(", ");
  const businessContext = agent.business_context || "";

  // Start a voice conversation session
  const sessionId = uuid();
  ensureVoiceTables(db);
  db.prepare("INSERT INTO voice_sessions (id, user_id, call_sid, caller, status, transcript, stage, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
    .run(sessionId, userId, CallSid, From, "active", "[]", "intake_name");

  // Greet and immediately ask for name — always collect before handling any query
  const businessName = site?.name || "us";
  const customGreeting = agent.custom_greeting;
  const introLine = customGreeting || `Thanks for calling ${businessName}!`;
  const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";

  await sendVoiceTwiml(res, db, vctx, `<Response>
    <Gather input="speech" action="${backendUrl}/api/ai-employees/voice/process?sid=${sessionId}&uid=${userId}" speechTimeout="3" language="en-AU"
      statusCallback="${backendUrl}/api/ai-employees/voice/status" statusCallbackEvent="completed" statusCallbackMethod="POST">
      <Say voice="Polly.Joanna">${escapeXml(introLine)} Before I help you, could I get your name please?</Say>
    </Gather>
    <Say voice="Polly.Joanna">I didn't catch that. Could I get your name please?</Say>
    <Gather input="speech" action="${backendUrl}/api/ai-employees/voice/process?sid=${sessionId}&uid=${userId}" speechTimeout="4">
    </Gather>
  </Response>`);
});

// Process speech from caller → AI response → speak back
router.post("/voice/process", async (req, res) => {
  // Verify request is genuinely from Twilio to prevent speech injection
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ||
    (() => { try { return require("../db/init").getDb().prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_AUTH_TOKEN'").get()?.value; } catch { return null; } })();
  if (twilioAuthToken) {
    try {
      const twilio = require("twilio");
      const { sid: qSid, uid: qUid } = req.query;
      const requestUrl = (process.env.BACKEND_URL || "http://localhost:4000") +
        `/api/ai-employees/voice/process?sid=${qSid}&uid=${qUid}`;
      const signature = req.headers["x-twilio-signature"] || "";
      const isValid = twilio.validateRequest(twilioAuthToken, signature, requestUrl, req.body);
      if (!isValid) return res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
    } catch(e) { console.error("[/voice/process]", e.message || e); }
  }
  const { SpeechResult, Confidence } = req.body;
  const { sid, uid } = req.query;
  const db = getDb();
  ensureVoiceTables(db);
  const vctx = computeVoiceCtx(db, uid); /*VOICECTX*/

  if (!SpeechResult) {
    const _bUrl1 = process.env.BACKEND_URL || "http://localhost:4000";
    await sendVoiceTwiml(res, db, vctx, `<Response><Say>I didn't catch that. Could you say that again?</Say><Gather input="speech" action="${_bUrl1}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="2"><Say>I'm listening.</Say></Gather></Response>`);
    return;
  }

  // Get conversation history - validate sid belongs to uid to prevent cross-user access
  const session = db.prepare("SELECT * FROM voice_sessions WHERE id = ? AND user_id = ?").get(sid, uid);
  if (!session) {
    await sendVoiceTwiml(res, db, vctx, `<Response><Say>Session not found.</Say><Hangup/></Response>`);
    return;
  }
  const transcript = JSON.parse(session?.transcript || "[]");
  const stage = session.stage || "intake_name";
  const backendUrl2 = process.env.BACKEND_URL || "http://localhost:4000";

  // ── INTAKE STAGE: collect name ──────────────────────────────────────────────
  if (stage === "intake_name") {
    // Extract name from whatever they said — be generous, take the whole utterance
    // if it's short (most people just say their name), otherwise look for patterns
    let callerName = SpeechResult.trim();
    // Strip common filler phrases if present
    callerName = callerName
      .replace(/^(my name is|i'm|i am|this is|it's|its)\s+/i, "")
      .replace(/[.,!?].*$/, "") // strip anything after punctuation
      .trim();
    // Cap at 40 chars — if they rambled, take first two words as the name
    if (callerName.length > 40) {
      callerName = callerName.split(/\s+/).slice(0, 2).join(" ");
    }

    db.prepare("UPDATE voice_sessions SET stage = 'intake_email', caller_name = ? WHERE id = ?")
      .run(callerName, sid);

    await sendVoiceTwiml(res, db, vctx, `<Response>
      <Gather input="speech" action="${backendUrl2}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="4" language="en-AU">
        <Say voice="Polly.Joanna">Thanks ${escapeXml(callerName)}! And could I grab your email address? Just say it out loud, like sarah at gmail dot com.</Say>
      </Gather>
      <Say voice="Polly.Joanna">I didn't catch that. Could you repeat your email?</Say>
      <Gather input="speech" action="${backendUrl2}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="5">
      </Gather>
    </Response>`);
    return;
  }

  // ── INTAKE STAGE: collect email ─────────────────────────────────────────────
  if (stage === "intake_email") {
    const callerName = session.caller_name || "";
    const db2 = getDb();

    // Parse spoken email: "sarah at gmail dot com" → sarah@gmail.com
    let rawEmail = SpeechResult.trim().toLowerCase();
    rawEmail = rawEmail
      .replace(/\s+at\s+/g, "@")
      .replace(/\s+dot\s+/g, ".")
      .replace(/\s+/g, "");
    const emailMatch = rawEmail.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/);
    const callerEmail = emailMatch ? emailMatch[0] : null;

    // Save email and advance to main conversation stage
    db.prepare("UPDATE voice_sessions SET stage = 'main', caller_email = ? WHERE id = ?")
      .run(callerEmail || null, sid);

    // Create CRM contact immediately — even if email parse failed, we have name + phone
    try {
      db.exec("CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, email TEXT, phone TEXT, status TEXT, source TEXT, notes TEXT, tags TEXT, last_activity TEXT, created_at TEXT, updated_at TEXT)");
      const callerPhone = session.caller || "";
      const existingContact = callerEmail
        ? db.prepare("SELECT id FROM contacts WHERE user_id = ? AND (email = ? OR phone = ?)").get(uid, callerEmail, callerPhone)
        : db.prepare("SELECT id FROM contacts WHERE user_id = ? AND phone = ?").get(uid, callerPhone);
      if (!existingContact) {
        db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, status, source, tags, last_activity, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))")
          .run(uuid(), uid, callerName, callerEmail || "", callerPhone, "lead", "phone-call", "phone-lead");
      } else {
        // Update existing contact with any new info
        db.prepare("UPDATE contacts SET name = CASE WHEN name = '' OR name IS NULL THEN ? ELSE name END, email = CASE WHEN email = '' OR email IS NULL THEN ? ELSE email END, last_activity = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(callerName, callerEmail || "", existingContact.id);
      }
    } catch(e) { /* non-fatal */ }

    // If email wasn't parseable, ask once more then move on — don't block the call
    if (!callerEmail) {
      // Move to main regardless — we have name and phone, that's enough
      const firstName = callerName.split(" ")[0];
      await sendVoiceTwiml(res, db, vctx, `<Response>
        <Gather input="speech" action="${backendUrl2}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="4" language="en-AU">
          <Say voice="Polly.Joanna">No worries ${escapeXml(firstName)}, I couldn't quite catch that. We'll follow up on this number. Now, how can I help you today?</Say>
        </Gather>
        <Say voice="Polly.Joanna">I'm here to help — go ahead.</Say>
        <Gather input="speech" action="${backendUrl2}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="5">
        </Gather>
      </Response>`);
      return;
    }

    const firstName = callerName.split(" ")[0];
    await sendVoiceTwiml(res, db, vctx, `<Response>
      <Gather input="speech" action="${backendUrl2}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="4" language="en-AU">
        <Say voice="Polly.Joanna">Perfect, thanks ${escapeXml(firstName)}! How can I help you today?</Say>
      </Gather>
      <Say voice="Polly.Joanna">I'm listening — go ahead.</Say>
      <Gather input="speech" action="${backendUrl2}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="5">
      </Gather>
    </Response>`);
    return;
  }

  // Hard cap: hang up after 20 turns to prevent runaway API cost
  const MAX_TURNS = 20;
  if (transcript.length >= MAX_TURNS) {
    db.prepare("UPDATE voice_sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?").run(sid);
    await sendVoiceTwiml(res, db, vctx, `<Response><Say voice="Polly.Joanna">I've reached the end of what I can help with in one call. Please visit our website or call back if you need more assistance. Goodbye!</Say><Hangup/></Response>`);
    return;
  }

  transcript.push({ role: "caller", text: SpeechResult, time: new Date().toISOString() });

  // Only send last 10 turns to Claude — full history compounds tokens exponentially with no quality gain
  const contextWindow = transcript.slice(-10);

  // Get full business context
  const agent = db.prepare("SELECT * FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(uid);
  const site = db.prepare("SELECT name, data, custom_domain, deploy_url FROM sites WHERE user_id = ? LIMIT 1").get(uid);
  const siteData = site ? JSON.parse(site.data || "{}") : {};
  const products = (siteData.products || []).slice(0, 15).map(p => `${p.name} - $${p.price}: ${(p.desc||"").substring(0,60)}`).join("\n");
  const courses = (siteData.courses || []).slice(0, 5).map(c => `${c.name} - $${c.price}`).join("\n");
  const bookings = (siteData.bookings || []).slice(0, 5).map(b => `${b.service} - $${b.price}, ${b.duration}min`).join("\n");
  const events = (siteData.events || []).filter(e => new Date(e.date) > new Date()).slice(0, 3).map(e => `${e.name} on ${e.date} - $${e.price}`).join("\n");
  const coupons = (siteData.coupons || []).filter(c => c.active).map(c => `${c.code}: ${c.discount}% off`).join(", ");
  const rules = JSON.parse(agent?.rules || "[]");
  const rulesText = rules.map(r => r.description).filter(Boolean).join(". ");
  const url = site?.custom_domain || site?.deploy_url || "";

  const anthropicKey = getSetting("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    await sendVoiceTwiml(res, db, vctx, `<Response><Say>I'm having a technical issue. Please call back later.</Say><Hangup/></Response>`);
    return;
  }

  const fetch = (await import("node-fetch")).default;
  try {
    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: `You are a friendly, helpful phone receptionist for ${site?.name || "a business"}.
Tone: ${agent?.tone || "professional"}
Caller name: ${session.caller_name || "unknown"}
${session.caller_email ? "Caller email: " + session.caller_email : ""}
${agent?.business_context ? "Business info: " + agent.business_context : ""}
${products ? "Products/services:\n" + products : ""}
${courses ? "Courses:\n" + courses : ""}
${bookings ? "Bookable services:\n" + bookings : ""}
${events ? "Upcoming events:\n" + events : ""}
${coupons ? "Active promos: " + coupons : ""}
${url ? "Website: " + url : ""}
${rulesText ? "Rules: " + rulesText : ""}

CRITICAL PHONE RULES:
- Keep responses SHORT (1-3 sentences). You're on a phone call, not writing an essay.
- Be warm, natural, and conversational — like a real receptionist.
- If they want to book, collect: name, date/time preference, service, phone/email.
- If they want to buy, tell them prices and direct them to the website.
- If they have a question you can't answer, offer to take their details and have someone call back.
- If they want to speak to a person, say you'll transfer them (and note it in transcript).
- Always confirm what you heard back to the caller.`,
        messages: [
          ...contextWindow.map(t => ({ role: t.role === "caller" ? "user" : "assistant", content: t.text })),
        ]
      })
    });
    const d = await aiResp.json();
    const aiText = d.content?.[0]?.text || "I'm sorry, could you repeat that?";

    transcript.push({ role: "agent", text: aiText, time: new Date().toISOString() });
    db.prepare("UPDATE voice_sessions SET transcript = ? WHERE id = ?").run(JSON.stringify(transcript), sid);

    // Check if AI wants to end the call
    const isGoodbye = aiText.toLowerCase().includes("goodbye") || aiText.toLowerCase().includes("have a great day") || aiText.toLowerCase().includes("take care");

    // Lead intent detection — name/email already captured during intake
    const callerPhone = session?.caller || "";
    const callerName = session?.caller_name || "";
    const callerEmail = session?.caller_email || "";
    const speechLower = SpeechResult.toLowerCase();
    const wantsBook = speechLower.includes("book") || speechLower.includes("appointment") || speechLower.includes("schedule");
    const wantsBuy = speechLower.includes("buy") || speechLower.includes("order") || speechLower.includes("purchase");

    // Log intent to voice_leads
    if (wantsBook || wantsBuy) {
      db.prepare("INSERT INTO voice_leads (id, user_id, session_id, caller_phone, intent, details, created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
        .run(uuid(), uid, sid, callerPhone, wantsBook ? "booking" : "purchase", JSON.stringify({ speech: SpeechResult, aiResponse: aiText, name: callerName, email: callerEmail }));
    }

    // Update CRM contact with intent/activity (contact already created during intake)
    try {
      if (wantsBook || wantsBuy) {
        db.prepare("UPDATE contacts SET last_activity = datetime('now'), notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || ' | ' || ? END, updated_at = datetime('now') WHERE user_id = ? AND (phone = ? OR email = ?)")
          .run(`Wants to ${wantsBook ? "book" : "buy"} — called ${new Date().toLocaleDateString()}`, `Wants to ${wantsBook ? "book" : "buy"} — called ${new Date().toLocaleDateString()}`, uid, callerPhone, callerEmail);
      }
    } catch(e) {}

    // If caller wants to book, try to create an actual booking
    if (wantsBook && detectedName) {
      try {
        const { autoEnrollInFunnels } = require("./email");
        if (detectedEmail) autoEnrollInFunnels(db, uid, "Booking confirmed", detectedEmail, detectedName);
      } catch(e) {}
    }

    if (isGoodbye) {
      // Notify owner of completed call
      try {
        const { notifyOwner } = require("./features");
        notifyOwner(uid, "📞", `Call completed from ${callerPhone}${callerName ? " (" + callerName + ")" : ""}${callerEmail ? " · " + callerEmail : ""}${wantsBook ? " — wants to book" : wantsBuy ? " — wants to buy" : ""}. ${transcript.length} turns.`);
      } catch(e) {}

      // Contact insert and funnel enrollment already handled mid-call above
      // (duplicate insert removed — mid-call block checks email OR phone; this block only checked phone, causing duplicates)

      db.prepare("UPDATE voice_sessions SET status = 'completed' WHERE id = ?").run(sid);
      await sendVoiceTwiml(res, db, vctx, `<Response><Say voice="Polly.Joanna">${escapeXml(aiText)}</Say><Hangup/></Response>`);
    } else {
      await sendVoiceTwiml(res, db, vctx, `<Response>
        <Gather input="speech" action="${process.env.BACKEND_URL || "http://localhost:4000"}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="2">
          <Say voice="Polly.Joanna">${escapeXml(aiText)}</Say>
        </Gather>
        <Say>Are you still there?</Say>
        <Gather input="speech" action="${process.env.BACKEND_URL || "http://localhost:4000"}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="3">
          <Say voice="Polly.Joanna">Hello?</Say>
        </Gather>
      </Response>`);
    }
  } catch (e) {
    await sendVoiceTwiml(res, db, vctx, `<Response><Say>I'm having trouble right now. Let me transfer you.</Say><Hangup/></Response>`);
  }
});

// Get voice call history
router.get("/voice/calls", auth, (req, res) => {
  const db = getDb();
  ensureVoiceTables(db);
  const calls = db.prepare("SELECT * FROM voice_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);
  const leads = db.prepare("SELECT * FROM voice_leads WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);
  res.json({
    calls: calls.map(c => ({
      ...c,
      transcript: JSON.parse(c.transcript || "[]"),
      callerName: c.caller_name || null,
      callerEmail: c.caller_email || null
    })),
    leads
  });
});

// Get voice stats
router.get("/voice/stats", auth, (req, res) => {
  const db = getDb();
  ensureVoiceTables(db);
  const total = db.prepare("SELECT COUNT(*) as n FROM voice_sessions WHERE user_id = ?").get(req.userId)?.n || 0;
  const today = db.prepare("SELECT COUNT(*) as n FROM voice_sessions WHERE user_id = ? AND created_at > datetime('now', '-1 day')").get(req.userId)?.n || 0;
  const leads = db.prepare("SELECT COUNT(*) as n FROM voice_leads WHERE user_id = ?").get(req.userId)?.n || 0;
  const avgDuration = db.prepare("SELECT AVG(json_array_length(transcript)) as avg FROM voice_sessions WHERE user_id = ?").get(req.userId)?.avg || 0;
  res.json({ totalCalls: total, callsToday: today, leadsCapitured: leads, avgTurns: Math.round(avgDuration / 2) });
});

// ── VOICE NUMBER PROVISIONING ────────────────────────────────────────────────
// All via TAKEOVA's master Twilio account — users never need their own Twilio.

function getTwilioCreds() {
  const sid   = process.env.TWILIO_ACCOUNT_SID   || getSetting("TWILIO_ACCOUNT_SID");
  const token = process.env.TWILIO_AUTH_TOKEN     || getSetting("TWILIO_AUTH_TOKEN");
  return { sid, token, auth: sid && token ? Buffer.from(sid + ":" + token).toString("base64") : null };
}

// Search available numbers by country
router.get("/voice/available-numbers", auth, async (req, res) => {
  try {

    const { country = "US", areaCode, contains } = req.query;
    const { sid, auth } = getTwilioCreds();
    if (!auth) return res.status(503).json({ error: "Voice not available — Twilio not configured" });

    const db = getDb();
    const hasAddon = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(req.userId);
    if (!hasAddon) {
      return res.status(403).json({ error: "Voice AI requires the AI Receptionist add-on ($99/mo). Add it from Settings → Billing.", upgrade: true });
    }

    const fetch = (await import("node-fetch")).default;
    const params = new URLSearchParams({ VoiceEnabled: "true", SmsEnabled: "false", PageSize: "10" });
    if (areaCode) params.set("AreaCode", areaCode);
    if (contains) params.set("Contains", contains);

    const countryCode = String(country).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2) || "US";
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/${countryCode}/Local.json?${params}`,
      { headers: { Authorization: "Basic " + auth } }
    );
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.message || "Failed to fetch numbers" });

    const numbers = (d.available_phone_numbers || []).map(n => ({
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name,
      locality: n.locality,
      region: n.region,
      isoCountry: n.iso_country,
      capabilities: n.capabilities
    }));
    res.json({ numbers });

  } catch(e) {
    console.error("[Route]", e?.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Provision a number from TAKEOVA's Twilio account and wire up the webhook automatically
router.post("/voice/provision-number", auth, async (req, res) => {
  try {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });

  const { sid, token, auth } = getTwilioCreds();
  if (!auth) return res.status(503).json({ error: "Voice not available — Twilio not configured" });

  const db = getDb();
  ensureVoiceTables(db);

  // Plan gate — Pro or Enterprise only
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  const allowedPlans = ["pro", "enterprise"];
  if (!user || !allowedPlans.includes(user.plan)) {
    return res.status(403).json({ error: "AI Receptionist requires Pro or Enterprise plan.", upgrade: true });
  }

  // Addon gate — must have purchased the AI Receptionist addon
  const hasAddon = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(req.userId);
  if (!hasAddon) {
    return res.status(403).json({ error: "Voice AI requires the AI Receptionist add-on ($99/mo). Add it from Settings → Billing.", upgrade: true });
  }

  // One number per user
  const existing = db.prepare("SELECT phone_number FROM user_voice_numbers WHERE user_id = ?").get(req.userId);
  if (existing) {
    return res.status(409).json({ error: "You already have a number assigned. Release it first before getting a new one.", existing: existing.phone_number });
  }

  const backendUrl = process.env.BACKEND_URL || getSetting("BACKEND_URL") || "https://your-server.com";
  const inboundWebhook = `${backendUrl}/api/ai-employees/voice/inbound`;
  const smsWebhook = `${backendUrl}/api/sms/inbound`;
  const statusCallback  = `${backendUrl}/api/ai-employees/voice/status`;

  const fetch = (await import("node-fetch")).default;

  // Purchase the number and wire up the webhook in one call
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      PhoneNumber:            phoneNumber,
      VoiceUrl:               inboundWebhook,
      SmsUrl:                 smsWebhook,
      SmsMethod:              "POST",
      VoiceMethod:            "POST",
      StatusCallback:         statusCallback,
      StatusCallbackMethod:   "POST",
      FriendlyName:           `MINE-user-${req.userId.slice(0, 8)}`
    })
  });
  const d = await r.json();
  if (!r.ok || !d.sid) {
    return res.status(r.status).json({ error: d.message || "Failed to provision number" });
  }

  // Save number + Twilio SID so we can release it later
  db.prepare(`
    INSERT OR REPLACE INTO user_voice_numbers (user_id, phone_number, twilio_number_sid, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(req.userId, d.phone_number, d.sid);

  res.json({
    success:      true,
    phoneNumber:  d.phone_number,
    friendlyName: d.friendly_name,
    sid:          d.sid
  });

  } catch (e) {
    console.error("[/voice/provision-number]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

  // Release a number back to Twilio (user cancels or switches number)
  router.post("/voice/release-number", auth, async (req, res) => {
  try {
    const { sid, auth } = getTwilioCreds();
    if (!auth) return res.status(503).json({ error: "Twilio not configured" });

    const db = getDb();
    ensureVoiceTables(db);
    const row = db.prepare("SELECT phone_number, twilio_number_sid FROM user_voice_numbers WHERE user_id = ?").get(req.userId);
    if (!row) return res.status(404).json({ error: "No number to release" });
    if (!row.twilio_number_sid) return res.status(400).json({ error: "Number has no Twilio SID — cannot release automatically" });

    const fetch = (await import("node-fetch")).default;
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${row.twilio_number_sid}.json`,
      { method: "DELETE", headers: { Authorization: "Basic " + auth } }
    );

  if (r.status === 204 || r.status === 200) {
    db.prepare("DELETE FROM user_voice_numbers WHERE user_id = ?").run(req.userId);
    res.json({ success: true, released: row.phone_number });
  } else {
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json({ error: d.message || "Failed to release number" });
  }

  } catch (e) {
    console.error("[/voice/release-number]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// Get user's provisioned number
router.get("/voice/number", auth, (req, res) => {
  const db = getDb();
  ensureVoiceTables(db);
  const num = db.prepare("SELECT phone_number, twilio_number_sid, created_at FROM user_voice_numbers WHERE user_id = ?").get(req.userId);
  res.json({ phoneNumber: num?.phone_number || null, sid: num?.twilio_number_sid || null, provisionedAt: num?.created_at || null });
});

router.post("/voice/call-out", auth, async (req, res) => {
  try { const _h = getDb().prepare("SELECT id FROM ai_employees WHERE user_id=? AND role='voice' AND enabled=1").get(req.userId); if (!_h) return res.status(403).json({ success:false, error:"Hire the AI Receptionist to use this." }); } catch(_e) {}
  const { to, purpose, script } = req.body;
  const db = getDb();
  ensureVoiceTables(db);

  // Usage cap check — estimate 5 mins per outbound call
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, req.userId, "voiceMins");
    if (usage.blocked) return res.status(403).json({ error: "AI Voice not available on your plan. Upgrade to Pro or higher.", upgrade: true });
    global.mineTrackUsage(db, req.userId, "voiceMins", 5);
  }

  const twilioSid = getSetting("TWILIO_ACCOUNT_SID");
  const twilioToken = getSetting("TWILIO_AUTH_TOKEN");
  if (!twilioSid || !twilioToken) return res.status(400).json({ error: "Twilio voice not configured" });

  // Use the user's own provisioned number as the caller ID — so the recipient sees their number
  ensureVoiceTables(db);
  const userNumRow = db.prepare("SELECT phone_number FROM user_voice_numbers WHERE user_id = ?").get(req.userId);
  const voiceNumber = userNumRow?.phone_number;
  if (!voiceNumber) return res.status(400).json({ error: "No phone number provisioned. Go to AI Employees → Voice AI to get a number first." });

  const sessionId = uuid();
  db.prepare("INSERT INTO voice_sessions (id, user_id, call_sid, caller, status, transcript, created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
    .run(sessionId, req.userId, "", to, "outbound", JSON.stringify([{ role: "agent", text: script || "Hi, I'm calling from " + (req.body.businessName || "your service provider"), time: new Date().toISOString() }]));

  const fetch = (await import("node-fetch")).default;
  const serverUrl = process.env.BACKEND_URL || getSetting("BACKEND_URL") || "https://your-server.com";

  try {
    const twilio = Buffer.from(twilioSid + ":" + twilioToken).toString("base64");
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls.json`, {
      method: "POST",
      headers: { "Authorization": "Basic " + twilio, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        To: to, From: voiceNumber,
        Url: `${serverUrl}/api/ai-employees/voice/outbound-start?sid=${sessionId}&uid=${req.userId}`
      })
    });
    const d = await r.json();
    if (d.sid) {
      db.prepare("UPDATE voice_sessions SET call_sid = ? WHERE id = ?").run(d.sid, sessionId);
      res.json({ success: true, callSid: d.sid, sessionId });
    } else {
      res.status(400).json({ error: d.message || "Call failed" });
    }
  } catch (e) {
    console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/voice/outbound-start", (req, res) => {
  // Verify this is genuinely from Twilio
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ||
    (() => { try { return require("../db/init").getDb().prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_AUTH_TOKEN'").get()?.value; } catch { return null; } })();
  if (twilioAuthToken) {
    try {
      const twilio = require("twilio");
      const { sid: qSid, uid: qUid } = req.query;
      const requestUrl = (process.env.BACKEND_URL || "http://localhost:4000") +
        `/api/ai-employees/voice/outbound-start?sid=${qSid}&uid=${qUid}`;
      const sig = req.headers["x-twilio-signature"] || "";
      if (!twilio.validateRequest(twilioAuthToken, sig, requestUrl, req.body))
        return res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
    } catch(e) { console.error("[/voice/outbound-start]", e.message || e); }
  }
  const { sid, uid } = req.query;
  const db = getDb();
  ensureVoiceTables(db);
  const session = db.prepare("SELECT * FROM voice_sessions WHERE id = ?").get(sid);
  const transcript = JSON.parse(session?.transcript || "[]");
  const rawGreeting = transcript[0]?.text || "Hi there, how are you?";
  // XML-escape greeting to prevent TwiML injection from stored AI response text
  const greeting = String(rawGreeting).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").slice(0, 500);
  const _bUrlOut = process.env.BACKEND_URL || "http://localhost:4000";
  res.type("text/xml").send(`<Response><Gather input="speech" action="${_bUrlOut}/api/ai-employees/voice/process?sid=${sid}&uid=${uid}" speechTimeout="2"><Say voice="Polly.Joanna">${greeting}</Say></Gather></Response>`);
});

// Twilio status callback — fired when a call ends with real duration
// This reconciles the 5-min estimate we charged at call start with actual duration
router.post("/voice/status", async (req, res) => {
  // Verify this is genuinely from Twilio — prevents anyone faking call durations
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ||
    (() => { try { return require("../db/init").getDb().prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_AUTH_TOKEN'").get()?.value; } catch { return null; } })();
  if (twilioAuthToken) {
    try {
      const twilio = require("twilio");
      const requestUrl = (process.env.BACKEND_URL || "http://localhost:4000") + "/api/ai-employees/voice/status";
      const sig = req.headers["x-twilio-signature"] || "";
      if (!twilio.validateRequest(twilioAuthToken, sig, requestUrl, req.body))
        return res.sendStatus(403);
    } catch(e) { console.error("[/voice/status]", e.message || e); }
  }

  const { CallSid, CallDuration, CallStatus } = req.body; // CallDuration in seconds
  if (CallStatus !== "completed" || !CallSid || !CallDuration) return res.sendStatus(200);

  const db = getDb();
  ensureVoiceTables(db);

  const session = db.prepare("SELECT * FROM voice_sessions WHERE call_sid = ?").get(CallSid);
  if (!session) return res.sendStatus(200);

  const actualMins = Math.ceil(parseInt(CallDuration) / 60); // round up, like Twilio does
  const estimatedMins = 5; // what we charged at call start
  const diff = actualMins - estimatedMins;

  // Store real duration on the session
  db.prepare("UPDATE voice_sessions SET call_duration_secs = ?, status = 'completed', ended_at = datetime('now') WHERE call_sid = ?")
    .run(parseInt(CallDuration), CallSid);

  // Reconcile usage: adjust the difference from the 5-min estimate
  // Only reconcile upward (longer calls) — we don't credit back short calls to avoid
  // gaming the system and because Twilio already billed us for the full minutes
  if (diff > 0 && typeof global !== "undefined" && global.mineTrackUsage) {
    try {
      global.mineTrackUsage(db, session.user_id, "voiceMins", diff);
    } catch(e) { /* ignore if reconciliation fails */ }
  }

  res.sendStatus(200);
});

// Save recording (fallback when no voice agent active)
router.post("/voice/recording", (req, res) => {
  if (!verifyTwilioSig(req, "/api/ai-employees/voice/recording")) {
    return res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
  }
  res.type("text/xml").send(`<Response><Say>Thank you. We'll get back to you soon.</Say><Hangup/></Response>`);
});

function ensureVoiceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_sessions (id TEXT PRIMARY KEY, user_id TEXT, call_sid TEXT, caller TEXT, status TEXT, transcript TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS voice_leads (id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT, caller_phone TEXT, intent TEXT, details TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS user_voice_numbers (user_id TEXT PRIMARY KEY, phone_number TEXT, twilio_number_sid TEXT, created_at TEXT);
  `);
  try { db.exec("CREATE TABLE IF NOT EXISTS voice_audio (id TEXT PRIMARY KEY, voice TEXT, text_hash TEXT, mime TEXT DEFAULT 'audio/mpeg', data BLOB, created_at TEXT)"); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_voice_audio_lookup ON voice_audio(voice, text_hash)"); } catch(e) {}
  // Migrations
  try { db.exec("ALTER TABLE voice_sessions ADD COLUMN call_duration_secs INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE user_voice_numbers ADD COLUMN twilio_number_sid TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE voice_sessions ADD COLUMN stage TEXT DEFAULT 'intake_name'"); } catch(e) {}
  try { db.exec("ALTER TABLE voice_sessions ADD COLUMN caller_name TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE voice_sessions ADD COLUMN caller_email TEXT"); } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// MISSED CALL TEXT-BACK
// When a caller hangs up without speaking (no-answer/busy/failed),
// Twilio fires a fallback status. We send an automatic SMS within 30 seconds.
// ═══════════════════════════════════════════════════════════════════════════

(function ensureMissedCallTable() {
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS missed_call_config (
        user_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 1,
        message TEXT DEFAULT 'Hey! Sorry we missed your call. How can we help? Reply here and we will get back to you shortly.',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS missed_calls (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        caller_phone TEXT,
        call_sid TEXT,
        sms_sent INTEGER DEFAULT 0,
        sms_sid TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_missed_calls_user ON missed_calls(user_id);
    `);
  } catch(e) {}
})();

// Get/update missed call text-back config
router.get("/missed-call/config", auth, (req, res) => {
  const db = getDb();
  // Plan gate — Pro and Enterprise only
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  const allowed = ["pro", "enterprise", "agency"];
  if (!user || !allowed.includes(user.plan)) {
    return res.status(403).json({ error: "Missed Call Text-Back is available on Pro and Enterprise plans only.", upgrade: true });
  }
  // Must have AI Receptionist add-on
  const hasReceptionist = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(req.userId);
  if (!hasReceptionist) {
    return res.status(403).json({ error: "Missed Call Text-Back requires the AI Receptionist add-on ($99/mo).", upgrade: true });
  }
  let cfg = db.prepare("SELECT * FROM missed_call_config WHERE user_id = ?").get(req.userId);
  if (!cfg) {
    db.prepare("INSERT OR IGNORE INTO missed_call_config (user_id) VALUES (?)").run(req.userId);
    cfg = db.prepare("SELECT * FROM missed_call_config WHERE user_id = ?").get(req.userId);
  }
  // Monthly usage — Pro: 80 included, Enterprise: 190 included, overage $0.10
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const monthStr = monthStart.toISOString().split("T")[0].slice(0,7); // YYYY-MM
  const monthlyCount = db.prepare("SELECT COUNT(*) as n FROM missed_calls WHERE user_id = ? AND sms_sent = 1 AND strftime('%Y-%m', created_at) = ?").get(req.userId, monthStr)?.n || 0;
  const userForPlan = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  const included = userForPlan?.plan === "enterprise" ? 190 : 80;
  const overage = Math.max(0, monthlyCount - included);
  const recent = db.prepare("SELECT * FROM missed_calls WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(req.userId);
  res.json({ config: cfg, recentMissedCalls: recent, usage: { monthlyCount, included, overage, overageRate: 0.10 } });
});

router.put("/missed-call/config", auth, (req, res) => {
  const db = getDb();
  // Plan gate
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  if (!user || !["pro", "enterprise", "agency"].includes(user.plan)) {
    return res.status(403).json({ error: "Missed Call Text-Back is available on Pro and Enterprise plans only.", upgrade: true });
  }
  const hasReceptionist = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(req.userId);
  if (!hasReceptionist) {
    return res.status(403).json({ error: "Missed Call Text-Back requires the AI Receptionist add-on.", upgrade: true });
  }
  const { enabled, message } = req.body;
  if (message && (typeof message !== "string" || message.length > 320))
    return res.status(400).json({ error: "Message must be under 320 characters" });
  db.prepare("INSERT INTO missed_call_config (user_id, enabled, message) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, message=excluded.message, updated_at=datetime('now')")
    .run(req.userId, enabled ? 1 : 0, (message || "").trim().slice(0, 320) || "Hey! Sorry we missed your call. How can we help?");
  res.json({ success: true });
});

// Twilio fallback webhook — fires when inbound call goes unanswered
// Set this as the "Fallback URL" on your Twilio phone number
router.post("/voice/missed", async (req, res) => {
  // Verify Twilio signature
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ||
    (() => { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_AUTH_TOKEN'").get()?.value; } catch { return null; } })();
  if (twilioAuthToken) {
    try {
      const twilio = require("twilio");
      const requestUrl = (process.env.BACKEND_URL || "http://localhost:4000") + "/api/ai-employees/voice/missed";
      const sig = req.headers["x-twilio-signature"] || "";
      if (!twilio.validateRequest(twilioAuthToken, sig, requestUrl, req.body))
        return res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
    } catch(e) { console.error("[/voice/missed]", e.message || e); }
  }

  res.type("text/xml").send("<Response><Hangup/></Response>"); // Respond to Twilio immediately

  const { CallSid, From, To, CallStatus } = req.body;
  if (!From || !To) return;

  setImmediate(async () => {
    try {
      const db = getDb();
      const { v4: uuid } = require("uuid");

      // Find user who owns this number
      const setting = db.prepare("SELECT user_id FROM user_voice_numbers WHERE phone_number = ?").get(To);
      if (!setting) return;
      const userId = setting.user_id;

      // Plan + receptionist gate
      const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(userId);
      if (!user || !["pro","enterprise"].includes(user.plan)) return;
      const hasReceptionist = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(userId);
      if (!hasReceptionist) return;

      // Check if text-back is enabled
      const cfg = db.prepare("SELECT * FROM missed_call_config WHERE user_id = ?").get(userId);
      if (!cfg || !cfg.enabled) return;

      // Hard daily spam cap of 30/day
      const today = new Date().toISOString().split("T")[0];
      const todayCount = db.prepare("SELECT COUNT(*) as n FROM missed_calls WHERE user_id = ? AND sms_sent = 1 AND DATE(created_at) = ?").get(userId, today)?.n || 0;
      if (todayCount >= 30) { return; }

      // Monthly usage — Pro: 80, Enterprise: 190 included. Overage $0.10/msg
      const monthStr = new Date().toISOString().slice(0, 7);
      const monthlyCount = db.prepare("SELECT COUNT(*) as n FROM missed_calls WHERE user_id = ? AND sms_sent = 1 AND strftime('%Y-%m', created_at) = ?").get(userId, monthStr)?.n || 0;
      const included = user.plan === "enterprise" ? 190 : 80;
      const isOverage = monthlyCount >= included;
      const overageRate = 0.10;

      // Log the missed call
      const missedId = uuid();
      db.prepare("INSERT INTO missed_calls (id, user_id, caller_phone, call_sid) VALUES (?,?,?,?)")
        .run(missedId, userId, From, CallSid || "");

      // Send SMS via Twilio
      const accountSid = process.env.TWILIO_ACCOUNT_SID || db.prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_ACCOUNT_SID'").get()?.value;
      const authToken  = process.env.TWILIO_AUTH_TOKEN  || db.prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_AUTH_TOKEN'").get()?.value;
      const fromNumber = To; // Reply from the same number they called
      if (!accountSid || !authToken) return;

      const fetch = (await import("node-fetch")).default;
      const params = new URLSearchParams({ To: From, From: fromNumber, Body: cfg.message });
      const smsRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: params }
      );
      const smsData = await smsRes.json();

      if (smsData.sid) {
        db.prepare("UPDATE missed_calls SET sms_sent = 1, sms_sid = ? WHERE id = ?").run(smsData.sid, missedId);
        // Log overage charge if over monthly included amount.
        // Uses the canonical schema (metric/quantity/unit_price/total/period)
        // — previously this insert used `type/amount/description` columns
        // which don't exist on the real table, so every missed-call-textback
        // overage silently failed and was never billed. Revenue leak.
        if (isOverage && !(typeof global.mineIsAdmin === "function" && global.mineIsAdmin(db, userId))) {
          try {
            const periodStr = new Date().toISOString().slice(0, 7); // YYYY-MM
            db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status) VALUES (?,?,?,?,?,?,?,'pending')")
              .run(uuid(), userId, "missed_call_textback", 1, overageRate, overageRate, periodStr);
          } catch(e) { console.error("[overage] missed_call_textback insert failed:", e.message); }
        }
        // Add to CRM contacts if not already there
        try {
          const existing = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND phone = ?").get(userId, From);
          if (!existing) {
            db.prepare("INSERT INTO contacts (id, user_id, phone, name, source, created_at) VALUES (?,?,?,?,?,datetime('now'))")
              .run(uuid(), userId, From, From, "missed_call");
          }
        } catch(e) {}
      }
    } catch(e) {
      console.error("[MissedCall] Text-back failed:", e.message);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MISSING FEATURE IMPLEMENTATIONS — all 14 AI employee gaps
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. SOCIAL MANAGER: Image generation for posts ────────────────────────────
// Called by the social manager cron when posting to platforms that support images.
// Uses NanoBanana if configured, falls back to a prompt-only post.


// ─── Direct user-initiated social post ───────────────────────────────────────
// Bypasses AI decision/autonomy gates and posts user-provided content immediately.
// Used by the dashboard "Post Now" button.
router.post("/social/post-direct", auth, async (req, res) => {
  const { content, platforms, image_url } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: "content required" });

  const db = getDb();

  // Construct a synthetic action that _rawExecuteAction can execute.
  // The post_now case reads details.draft and posts to all connected platforms.
  const syntheticAction = {
    id: "direct-" + Date.now(),
    user_id: req.userId,
    role: "social",
    action: "post_now",
    details: JSON.stringify({
      draft: content,
      platforms: platforms || "all",
      image_url: image_url || null,
      _direct: true
    })
  };

  try {
    const result = await _rawExecuteAction(db, syntheticAction, req.userId);
    // result shape from post_now case:
    //   posted: bool, platforms: { meta:{success,postId/reason}, instagram:{...}, ... },
    //   successCount, draftCount, totalPlatforms, reason?, content?
    return res.json({ success: true, ...result });
  } catch (e) {
    console.error("[social/post-direct] error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});


router.post("/social/generate-post-image", auth, async (req, res) => {
  if (!_capGuard(req, res, "images")) return;
  const { caption, platform, businessName, style } = req.body;
  const db = getDb();
  const nanoBananaKey = getSetting("GEMINI_API_KEY") || process.env.GEMINI_API_KEY;

  if (!nanoBananaKey) {
    return res.json({ success: false, reason: "GEMINI_API_KEY not configured — add it in Settings → Integrations to enable AI post images" });
  }

  // Build a platform-appropriate image prompt from the caption
  const fetch2 = (await import("node-fetch")).default;
  const Anthropic = require("@anthropic-ai/sdk");
  const claude = new Anthropic({ apiKey: getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY });

  // First use Claude to turn the caption into a good image prompt
  let imagePrompt = "";
  try {
    const pr = await claude.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 100,
      messages: [{ role: "user", content: `Write a visual image generation prompt (no text/words in image) for a ${platform} post with this caption: "${caption.substring(0, 200)}". Business: ${businessName}. Style: ${style || "professional, vibrant, eye-catching"}. 1-2 sentences only. No quotes.` }]
    });
    imagePrompt = pr.content[0]?.text || caption.substring(0, 100);
  } catch(_) {
    imagePrompt = `${businessName} — professional product lifestyle photo, ${style || "vibrant colours, clean background"}`;
  }

  // Size by platform
  const size = platform === "tiktok" ? "1080x1920"
    : platform === "instagram" ? "1080x1080"
    : platform === "facebook" ? "1200x628"
    : "1080x1080";

  try {
    const { generateImage } = require("../utils/image-gen");
    const imageUrl = await generateImage(imagePrompt, { size, getSetting });
    if (!imageUrl) return res.json({ success: false, reason: "Image generation failed", prompt: imagePrompt });
    res.json({ success: true, imageUrl, prompt: imagePrompt, size });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── 2. SUPPORT AGENT: Email ticket ingestion (SendGrid Inbound Parse) ─────────
// Mount at /api/ai-employees/support/inbound-email
// Configure SendGrid Inbound Parse to POST to: https://yourdomain.com/api/ai-employees/support/inbound-email
// SendGrid docs: https://docs.sendgrid.com/for-developers/parsing-email/setting-up-the-inbound-parse-webhook

router.post("/support/inbound-email", async (req, res) => {
  // Verify SendGrid webhook signature — prevents forged tickets.
  if (!verifySendgridSig(req)) {
    return res.status(403).json({ error: "Invalid signature" });
  }
  // SendGrid sends multipart form data
  const { from, subject, text, html, to } = req.body;
  if (!from) return res.status(400).json({ error: "No sender" });

  const db = getDb();
  ensureTables(db);

  // Match email to a user by their support address (support@<custom_domain>)
  // or by the To address if using shared support inbox
  let userId = null;
  try {
    // Try matching by custom domain
    const domain = to?.split("@")[1]?.replace(">","").trim();
    if (domain) {
      const site = db.prepare("SELECT user_id FROM sites WHERE custom_domain = ? OR deploy_url LIKE ?").get(domain, `%${domain}%`);
      if (site) userId = site.user_id;
    }
    // Fallback: first active user with support agent enabled (single-tenant fallback)
    if (!userId) {
      const emp = db.prepare("SELECT user_id FROM ai_employees WHERE role = 'support' AND enabled = 1 LIMIT 1").get();
      if (emp) userId = emp.user_id;
    }
  } catch(_) {}

  if (!userId) return res.status(200).json({ ok: true, note: "No matching user" });

  // Extract sender info
  const senderEmail = from.match(/<(.+)>/)?.[1] || from;
  const senderName  = from.match(/^([^<]+)</)?.[1]?.trim() || senderEmail;
  const body        = text || html?.replace(/<[^>]+>/g, "") || "";

  // Create ticket in DB
  const { v4: uuid } = require("uuid");
  const ticketId = uuid();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS support_tickets (id TEXT PRIMARY KEY, user_id TEXT, customer_name TEXT, customer_email TEXT, subject TEXT, body TEXT, channel TEXT DEFAULT 'email', status TEXT DEFAULT 'open', reply TEXT, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO support_tickets (id, user_id, customer_name, customer_email, subject, body, channel) VALUES (?,?,?,?,?,?,?)")
      .run(ticketId, userId, senderName, senderEmail, subject || "(no subject)", body.substring(0, 2000), "email");
  } catch(_) {}

  // Trigger Support Agent to handle it
  try {
    const fetch2 = (await import("node-fetch")).default;
    await fetch2(`http://localhost:${process.env.PORT || 4000}/api/ai-employees/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY || "", "x-internal-user-id": userId },
      body: JSON.stringify({ event: "new_support_ticket", data: { ticketId, customerName: senderName, customerEmail: senderEmail, subject, body: body.substring(0, 500), channel: "email" } })
    });
  } catch(_) { console.error("[/support/inbound-email]", _.message || _); }

  res.status(200).json({ ok: true, ticketId });
});

// ── 3. BOOKKEEPER: Xero sync ──────────────────────────────────────────────────

router.post("/bookkeeper/xero-sync", auth, async (req, res) => {
  const db = getDb();
  const xeroToken   = getSetting("XERO_ACCESS_TOKEN") || process.env.XERO_ACCESS_TOKEN;
  const xeroTenantId = getSetting("XERO_TENANT_ID") || process.env.XERO_TENANT_ID;

  if (!xeroToken || !xeroTenantId) {
    return res.json({ success: false, reason: "Xero not connected. Add XERO_ACCESS_TOKEN and XERO_TENANT_ID in Settings → Integrations." });
  }

  const fetch2 = (await import("node-fetch")).default;
  const results = { invoices: 0, bills: 0, payments: 0, errors: [] };

  try {
    // Sync invoices from Xero
    const invoiceRes = await fetch2("https://api.xero.com/api.xro/2.0/Invoices?where=Status!=\"VOIDED\"&order=UpdatedDateUTC+DESC&pageSize=100", {
      headers: { Authorization: `Bearer ${xeroToken}`, "Xero-tenant-id": xeroTenantId, Accept: "application/json" }
    });
    const invoiceData = await invoiceRes.json();
    const invoices = invoiceData.Invoices || [];

    db.exec("CREATE TABLE IF NOT EXISTS xero_invoices (id TEXT PRIMARY KEY, user_id TEXT, xero_invoice_id TEXT UNIQUE, contact_name TEXT, invoice_number TEXT, amount REAL, amount_due REAL, status TEXT, due_date TEXT, synced_at TEXT DEFAULT (datetime('now')))");

    const insertInvoice = db.prepare("INSERT OR REPLACE INTO xero_invoices (id, user_id, xero_invoice_id, contact_name, invoice_number, amount, amount_due, status, due_date) VALUES (?,?,?,?,?,?,?,?,?)");
    const { v4: uuid } = require("uuid");

    for (const inv of invoices) {
      insertInvoice.run(uuid(), req.userId, inv.InvoiceID, inv.Contact?.Name || "", inv.InvoiceNumber || "", inv.Total || 0, inv.AmountDue || 0, inv.Status, inv.DueDate || "");
      results.invoices++;
    }

    // Sync bank transactions (bills/expenses)
    const txRes = await fetch2("https://api.xero.com/api.xro/2.0/BankTransactions?pageSize=100", {
      headers: { Authorization: `Bearer ${xeroToken}`, "Xero-tenant-id": xeroTenantId, Accept: "application/json" }
    });
    const txData = await txRes.json();
    const txs = txData.BankTransactions || [];

    db.exec("CREATE TABLE IF NOT EXISTS xero_transactions (id TEXT PRIMARY KEY, user_id TEXT, xero_tx_id TEXT UNIQUE, type TEXT, amount REAL, description TEXT, date TEXT, account_name TEXT, synced_at TEXT DEFAULT (datetime('now')))");
    const insertTx = db.prepare("INSERT OR REPLACE INTO xero_transactions (id, user_id, xero_tx_id, type, amount, description, date, account_name) VALUES (?,?,?,?,?,?,?,?)");

    for (const tx of txs) {
      insertTx.run(uuid(), req.userId, tx.BankTransactionID, tx.Type, tx.Total || 0, tx.Reference || tx.Narration || "", tx.Date || "", tx.BankAccount?.Name || "");
      results.payments++;
    }

    res.json({ success: true, synced: results, message: `Synced ${results.invoices} invoices and ${results.payments} transactions from Xero.` });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── 4. BOOKKEEPER: QuickBooks sync ────────────────────────────────────────────

router.post("/bookkeeper/quickbooks-sync", auth, async (req, res) => {
  const db = getDb();
  const qbToken   = getSetting("QUICKBOOKS_ACCESS_TOKEN") || process.env.QUICKBOOKS_ACCESS_TOKEN;
  const qbRealmId = getSetting("QUICKBOOKS_REALM_ID") || process.env.QUICKBOOKS_REALM_ID;
  const qbEnv     = process.env.QUICKBOOKS_ENV || "production"; // or "sandbox"

  if (!qbToken || !qbRealmId) {
    return res.json({ success: false, reason: "QuickBooks not connected. Add QUICKBOOKS_ACCESS_TOKEN and QUICKBOOKS_REALM_ID in Settings → Integrations." });
  }

  const baseUrl = qbEnv === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";

  const fetch2 = (await import("node-fetch")).default;
  const { v4: uuid } = require("uuid");
  const results = { invoices: 0, expenses: 0 };

  try {
    // Fetch invoices from QuickBooks
    const invRes = await fetch2(`${baseUrl}/v3/company/${qbRealmId}/query?query=SELECT * FROM Invoice MAXRESULTS 100&minorversion=65`, {
      headers: { Authorization: `Bearer ${qbToken}`, Accept: "application/json" }
    });
    const invData = await invRes.json();
    const invoices = invData.QueryResponse?.Invoice || [];

    db.exec("CREATE TABLE IF NOT EXISTS qb_invoices (id TEXT PRIMARY KEY, user_id TEXT, qb_invoice_id TEXT UNIQUE, customer_name TEXT, doc_number TEXT, amount REAL, balance REAL, status TEXT, due_date TEXT, synced_at TEXT DEFAULT (datetime('now')))");
    const insertInv = db.prepare("INSERT OR REPLACE INTO qb_invoices (id, user_id, qb_invoice_id, customer_name, doc_number, amount, balance, status, due_date) VALUES (?,?,?,?,?,?,?,?,?)");

    for (const inv of invoices) {
      insertInv.run(uuid(), req.userId, inv.Id, inv.CustomerRef?.name || "", inv.DocNumber || "", parseFloat(inv.TotalAmt || 0), parseFloat(inv.Balance || 0), inv.EmailStatus || "open", inv.DueDate || "");
      results.invoices++;
    }

    // Fetch expenses
    const expRes = await fetch2(`${baseUrl}/v3/company/${qbRealmId}/query?query=SELECT * FROM Purchase MAXRESULTS 100&minorversion=65`, {
      headers: { Authorization: `Bearer ${qbToken}`, Accept: "application/json" }
    });
    const expData = await expRes.json();
    const expenses = expData.QueryResponse?.Purchase || [];

    db.exec("CREATE TABLE IF NOT EXISTS qb_expenses (id TEXT PRIMARY KEY, user_id TEXT, qb_expense_id TEXT UNIQUE, vendor_name TEXT, amount REAL, account_name TEXT, memo TEXT, tx_date TEXT, synced_at TEXT DEFAULT (datetime('now')))");
// Change 9: schema-drift ALTERs for qb_expenses
try { db.exec("ALTER TABLE qb_expenses ADD COLUMN category TEXT"); } catch(_){}
    const insertExp = db.prepare("INSERT OR REPLACE INTO qb_expenses (id, user_id, qb_expense_id, vendor_name, amount, account_name, memo, tx_date) VALUES (?,?,?,?,?,?,?,?)");

    for (const exp of expenses) {
      const line = exp.Line?.[0];
      insertExp.run(uuid(), req.userId, exp.Id, exp.EntityRef?.name || "", parseFloat(exp.TotalAmt || 0), line?.AccountBasedExpenseLineDetail?.AccountRef?.name || "", exp.PrivateNote || "", exp.TxnDate || "");
      results.expenses++;
    }

    res.json({ success: true, synced: results, message: `Synced ${results.invoices} invoices and ${results.expenses} expenses from QuickBooks.` });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── 5. LEGAL + PROPOSAL: Native e-signature ───────────────────────────────────
// Simple token-based signing — no third party needed.
// Client gets a link, views the document, clicks Sign, we record the IP + timestamp.

router.post("/legal/send-for-signature", auth, async (req, res) => {
  const { documentId, documentType, clientEmail, clientName, documentUrl, documentContent } = req.body;
  if (!clientEmail) return res.status(400).json({ error: "clientEmail required" });

  const db = getDb();
  const { v4: uuid } = require("uuid");
  const crypto = require("crypto");

  // Create signing session
  const signingToken = crypto.randomBytes(32).toString("hex");
  const signingId    = uuid();
  const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  db.exec("CREATE TABLE IF NOT EXISTS signing_sessions (id TEXT PRIMARY KEY, user_id TEXT, document_id TEXT, document_type TEXT, client_email TEXT, client_name TEXT, token TEXT UNIQUE, document_url TEXT, document_content TEXT, status TEXT DEFAULT 'pending', signed_at TEXT, signer_ip TEXT, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')))");
  db.prepare("INSERT INTO signing_sessions (id, user_id, document_id, document_type, client_email, client_name, token, document_url, document_content, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(signingId, req.userId, documentId || "", documentType || "contract", clientEmail, clientName || clientEmail, signingToken, documentUrl || "", documentContent || "", expiresAt);

  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  const signingUrl  = `${frontendUrl}/sign?token=${signingToken}`;

  // Send signing email
  const sgKey     = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  const fromEmail = getSetting('EMAIL_FROM') || getSetting('FROM_EMAIL') || process.env.EMAIL_FROM || process.env.FROM_EMAIL || "noreply@takeova.ai";
  const user      = db.prepare("SELECT name, business_name FROM users WHERE id = ?").get(req.userId);
  const senderName = user?.business_name || user?.name || "Your Service Provider";

  if (sgKey) {
    try {
      const fetch2 = (await import("node-fetch")).default;
      const _sgResp = await fetch2("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${sgKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: clientEmail, name: clientName || clientEmail }] }],
          from: { email: fromEmail, name: senderName },
          subject: `Action required: Please sign your ${documentType || "document"} — ${senderName}`,
          content: [{ type: "text/html", value: `
            <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
              <h2 style="margin-bottom:8px;">Document ready to sign</h2>
              <p>Hi ${clientName || "there"},</p>
              <p><strong>${senderName}</strong> has sent you a document to review and sign electronically.</p>
              <p><strong>Document:</strong> ${documentType || "Contract"}</p>
              <a href="${signingUrl}" style="display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:20px 0;">Review & Sign Document →</a>
              <p style="font-size:12px;color:#999;margin-top:24px;">This link expires in 7 days. By clicking Sign, you agree that your electronic signature is legally binding.</p>
            </div>
          ` }]
        })
      });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    } catch(emailErr) { console.error("[e-sign email]", emailErr.message); }
  }

  res.json({ success: true, signingId, signingUrl, expiresAt });
});

// Client views + signs the document (public endpoint)
router.get("/legal/sign/:token", async (req, res) => {
  const db = getDb();
  const session = db.prepare("SELECT * FROM signing_sessions WHERE token = ? AND status = 'pending' AND expires_at > datetime('now')").get(req.params.token);
  if (!session) return res.status(404).json({ error: "Signing link not found or expired." });
  res.json({ success: true, session: { id: session.id, documentType: session.document_type, clientName: session.client_name, documentContent: session.document_content, documentUrl: session.document_url, status: session.status } });
});

router.post("/legal/sign/:token", async (req, res) => {
  const db = getDb();
  const session = db.prepare("SELECT * FROM signing_sessions WHERE token = ? AND status = 'pending' AND expires_at > datetime('now')").get(req.params.token);
  if (!session) return res.status(404).json({ error: "Signing link not found, expired, or already signed." });

  const signerIp = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "";
  db.prepare("UPDATE signing_sessions SET status = 'signed', signed_at = datetime('now'), signer_ip = ? WHERE token = ?")
    .run(signerIp, req.params.token);

  // Notify the business owner
  try {
    const { v4: nuuid } = require("uuid");
    db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
      .run(nuuid(), session.user_id, "✍️", `${session.client_name} signed the ${session.document_type}. IP: ${signerIp}.`, "Just now");
  } catch(_) {}

  res.json({ success: true, message: "Document signed successfully.", signedAt: new Date().toISOString(), signerIp });
});

// Get all signing sessions for a user
router.get("/legal/signatures", auth, (req, res) => {
  const db = getDb();
  const sessions = db.prepare("SELECT id, document_type, client_name, client_email, status, signed_at, expires_at, signing_url, created_at FROM signing_sessions WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ sessions });
});

// ── 6. CUSTOMER SUCCESS: SMS win-backs via Twilio ─────────────────────────────

router.post("/csm/sms-winback", auth, async (req, res) => {
  try { const _h = getDb().prepare("SELECT id FROM ai_employees WHERE user_id=? AND role='csm' AND enabled=1").get(req.userId); if (!_h) return res.status(403).json({ success:false, error:"Hire the Customer Success agent to use this." }); } catch(_e) {}
  const { contactId, phoneNumber, message } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });

  const db = getDb();
  const twilioSid   = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = getSetting("TWILIO_AUTH_TOKEN")   || process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom  = getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER;

  if (!twilioSid || !twilioToken || !twilioFrom) {
    return res.json({ success: false, reason: "Twilio not configured — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env" });
  }

  // Build personalised win-back message if not provided
  let smsBody = message;
  if (!smsBody) {
    const contact = db.prepare("SELECT name, last_purchase_at FROM contacts WHERE id = ? AND user_id = ?").get(contactId || "", req.userId);
    const user    = db.prepare("SELECT business_name, name FROM users WHERE id = ?").get(req.userId);
    const bizName = user?.business_name || user?.name || "us";
    const firstName = contact?.name?.split(" ")[0] || "there";
    smsBody = `Hey ${firstName}! We miss you at ${bizName}. It's been a while — come back and get 10% off your next visit. Reply STOP to opt out.`;
  }

  try {
    const client = require("twilio")(twilioSid, twilioToken);
    const msg = await client.messages.create({ body: smsBody, from: twilioFrom, to: phoneNumber });

    // Log it
    const { v4: uuid } = require("uuid");
    db.exec("CREATE TABLE IF NOT EXISTS sms_log (id TEXT PRIMARY KEY, user_id TEXT, contact_id TEXT, phone TEXT, body TEXT, twilio_sid TEXT, direction TEXT DEFAULT 'outbound', status TEXT, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO sms_log (id, user_id, contact_id, phone, body, twilio_sid, status) VALUES (?,?,?,?,?,?,?)")
      .run(uuid(), req.userId, contactId || "", phoneNumber, smsBody, msg.sid, msg.status);

    res.json({ success: true, sid: msg.sid, status: msg.status });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── 7. RECEPTIONIST: Outbound calling ────────────────────────────────────────
// Calls a lead or customer — reads a script, handles responses, books appointment.

router.post("/receptionist/call-out", auth, async (req, res) => {
  const { phoneNumber, contactName, script, purpose } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });

  const db = getDb();
  const twilioSid   = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = getSetting("TWILIO_AUTH_TOKEN")   || process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom  = getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER;
  const backendUrl  = getSetting("BACKEND_URL") || process.env.BACKEND_URL || "https://your-backend.railway.app";

  if (!twilioSid || !twilioToken || !twilioFrom) {
    return res.json({ success: false, reason: "Twilio not configured." });
  }

  try {
    const { v4: uuid } = require("uuid");
    const callId = uuid();
    const user   = db.prepare("SELECT business_name, name FROM users WHERE id = ?").get(req.userId);
    const bizName = user?.business_name || user?.name || "the business";

    // Store context so the TwiML handler can retrieve it
    db.exec("CREATE TABLE IF NOT EXISTS outbound_call_context (id TEXT PRIMARY KEY, user_id TEXT, call_sid TEXT, contact_name TEXT, script TEXT, purpose TEXT, status TEXT DEFAULT 'initiated', created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO outbound_call_context (id, user_id, contact_name, script, purpose) VALUES (?,?,?,?,?)")
      .run(callId, req.userId, contactName || "there", script || `Hi, this is the AI assistant from ${bizName}. I'm calling to follow up on your enquiry and see if we can help. Do you have a moment?`, purpose || "follow_up");

    const client = require("twilio")(twilioSid, twilioToken);
    const call = await client.calls.create({
      to:   phoneNumber,
      from: twilioFrom,
      url:  `${backendUrl}/api/ai-employees/receptionist/outbound-twiml/${callId}`,
      statusCallback: `${backendUrl}/api/ai-employees/voice/status`,
      statusCallbackMethod: "POST",
    });

    db.prepare("UPDATE outbound_call_context SET call_sid = ?, status = 'ringing' WHERE id = ?").run(call.sid, callId);
    res.json({ success: true, callSid: call.sid, callId, status: call.status });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// TwiML for outbound call — reads the script, listens for response
router.get("/receptionist/outbound-twiml/:callId", async (req, res) => {
  const db = getDb();
  const ctx = db.prepare("SELECT * FROM outbound_call_context WHERE id = ?").get(req.params.callId);
  const script = ctx?.script || "Hello, this is an automated call. Thank you for your time.";
  const backendUrl = process.env.BACKEND_URL || "https://your-backend.railway.app";

  res.set("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="5" action="${backendUrl}/api/ai-employees/receptionist/outbound-gather/${req.params.callId}" method="POST">
    <Say voice="Polly.Joanna">${script.replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" })[c])}</Say>
  </Gather>
  <Say voice="Polly.Joanna">We didn't catch that. We'll try again soon. Goodbye.</Say>
</Response>`);
});

// Handles speech response from outbound call
router.post("/receptionist/outbound-gather/:callId", async (req, res) => {
  // Twilio signature — without this an attacker with a valid callId
  // could POST arbitrary SpeechResult to burn Anthropic credits and
  // inject fabricated text into call transcripts.
  if (!verifyTwilioSig(req, "/api/ai-employees/receptionist/outbound-gather/" + req.params.callId)) {
    return res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
  }
  const { SpeechResult, CallSid } = req.body;
  const db = getDb();
  const ctx = db.prepare("SELECT * FROM outbound_call_context WHERE id = ?").get(req.params.callId);
  if (!ctx) return res.send(`<?xml version="1.0"?><Response><Hangup/></Response>`);

  // Use Claude to decide what to say next
  const Anthropic = require("@anthropic-ai/sdk");
  const claude = new Anthropic({ apiKey: getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY });
  let reply = "Thank you for that. We'll be in touch shortly. Have a great day!";

  try {
    const r = await claude.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 100,
      messages: [{ role: "user", content: `You are an AI receptionist making an outbound call for a business. Purpose: ${ctx.purpose}. The person said: "${SpeechResult}". Write a brief, friendly response (1-2 sentences, natural spoken English, no punctuation that sounds weird when read aloud). If they want to book, say you'll send them a booking link via SMS.` }]
    });
    reply = r.content[0]?.text || reply;
  } catch(_) {}

  // Log the call interaction
  try {
    db.prepare("UPDATE outbound_call_context SET status = 'completed' WHERE id = ?").run(req.params.callId);
    const { v4: uuid } = require("uuid");
    db.prepare("INSERT OR IGNORE INTO call_transcripts (id, user_id, call_sid, direction, speaker, text, created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
      .run(uuid(), ctx.user_id, CallSid, "outbound", "customer", SpeechResult || "", );
  } catch(_) { console.error("[/outbound-gather/:callId]", _.message || _); }

  res.set("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${reply.replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" })[c])}</Say>
  <Hangup/>
</Response>`);
});

// ── 8. GROWTH AGENT: Competitor monitoring ────────────────────────────────────
// Searches for competitor mentions, tracks their offers and content.

router.post("/growth/competitor-scan", auth, async (req, res) => {
  const { competitors } = req.body; // array of competitor names/domains
  if (!competitors?.length) return res.status(400).json({ error: "competitors array required" });

  const db = getDb();
  const Anthropic = require("@anthropic-ai/sdk");
  const claude = new Anthropic({ apiKey: getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY });
  const { v4: uuid } = require("uuid");
  const fetch2 = (await import("node-fetch")).default;

  db.exec("CREATE TABLE IF NOT EXISTS competitor_intel (id TEXT PRIMARY KEY, user_id TEXT, competitor TEXT, category TEXT, finding TEXT, source TEXT, actioned INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");

  const findings = [];

  for (const competitor of competitors.slice(0, 5)) { // cap at 5
    try {
      // Fetch their website
      let competitorContent = "";
      try {
        const r = await fetch2(`https://${competitor.replace(/^https?:\/\//,"")}`, { timeout: 8000 });
        const html = await r.text();
        competitorContent = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").substring(0, 3000);
      } catch(_) { competitorContent = `Unable to fetch ${competitor}`; }

      // Ask Claude to analyse what they found
      const analysis = await claude.messages.create({
        model: "claude-sonnet-4-6", max_tokens: 400,
        messages: [{ role: "user", content: `Analyse this competitor website content and identify: 1) Their pricing/offers, 2) Key features they promote, 3) Any recent promotions, 4) Gaps or weaknesses a competitor could exploit. Be specific. Content from ${competitor}:\n\n${competitorContent}\n\nRespond in JSON: {"pricing": "...", "keyFeatures": ["..."], "promotions": "...", "weaknesses": ["..."], "opportunities": ["..."]}` }]
      });

      let intel = {};
      try { intel = JSON.parse(analysis.content[0].text.replace(/```json|```/g, "").trim()); } catch(_) { intel = { raw: analysis.content[0].text }; }

      // Save findings
      const categories = ["pricing", "keyFeatures", "promotions", "weaknesses", "opportunities"];
      for (const cat of categories) {
        const val = intel[cat];
        if (!val) continue;
        const text = Array.isArray(val) ? val.join("; ") : String(val);
        if (text.length < 5) continue;
        const id = uuid();
        db.prepare("INSERT INTO competitor_intel (id, user_id, competitor, category, finding, source) VALUES (?,?,?,?,?,?)")
          .run(id, req.userId, competitor, cat, text.substring(0, 500), competitor);
        findings.push({ competitor, category: cat, finding: text.substring(0, 200) });
      }
    } catch(e) {
      findings.push({ competitor, error: e.message });
    }
  }

  res.json({ success: true, findings, scanned: competitors.length });
});

router.get("/growth/competitor-intel", auth, (req, res) => {
  const db = getDb();
  const intel = db.prepare("SELECT * FROM competitor_intel WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.userId);
  res.json({ intel });
});

// ── 9. COMMUNITY ENGAGEMENT: LinkedIn posts/comments ─────────────────────────

router.post("/community/linkedin-post", auth, async (req, res) => {
  const { text, linkedinToken, linkedinPersonUrn } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  const db = getDb();
  const token = linkedinToken || db.prepare("SELECT access_token FROM oauth_tokens WHERE user_id = ? AND platform = 'linkedin'").get(req.userId)?.access_token;
  const urn   = linkedinPersonUrn || db.prepare("SELECT account_id FROM oauth_tokens WHERE user_id = ? AND platform = 'linkedin'").get(req.userId)?.account_id;

  if (!token || !urn) return res.json({ success: false, reason: "LinkedIn not connected. Connect it in Settings → Integrations." });

  const fetch2 = (await import("node-fetch")).default;
  try {
    const r = await fetch2("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({
        author: `urn:li:person:${urn}`,
        lifecycleState: "PUBLISHED",
        specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text }, shareMediaCategory: "NONE" } },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" }
      })
    });
    const d = await r.json();
    const postId = d.id;
    if (!postId) return res.json({ success: false, reason: d.message || "LinkedIn post failed" });
    res.json({ success: true, postId });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── 10. PROSPECTOR: takeova.ai/claim landing page + SMS outreach ───────────────

// takeova.ai/claim — the page prospects land on after the Prospector finds them
router.get("/prospector/claim-page/:prospectId", async (req, res) => {
  const db = getDb();
  const prospect = db.prepare("SELECT * FROM prospector_leads WHERE id = ?").get(req.params.prospectId);
  if (!prospect) return res.status(404).send("<h1>This demo has expired</h1>");

  const businessName = prospect.business_name || "Your Business";
  const demoUrl      = prospect.demo_url || "#";
  const agencyUser   = db.prepare("SELECT business_name, name FROM users WHERE id = ?").get(prospect.user_id);
  const agencyName   = agencyUser?.business_name || agencyUser?.name || "TAKEOVA Agency";

  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Free Website is Ready — ${businessName}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8f9ff;color:#0A0F1E}
.hero{background:linear-gradient(135deg,#2563EB,#2563EB);color:#fff;padding:60px 20px;text-align:center}
.hero h1{font-size:clamp(24px,4vw,40px);font-weight:900;margin-bottom:12px}
.hero p{font-size:16px;opacity:.9;max-width:480px;margin:0 auto 32px}
.btn{display:inline-block;background:#fff;color:#2563EB;padding:16px 32px;border-radius:10px;font-size:16px;font-weight:800;text-decoration:none;margin:8px}
.btn-outline{background:transparent;color:#fff;border:2px solid rgba(255,255,255,.5)}
.card{background:#fff;border-radius:16px;padding:32px;margin:24px auto;max-width:540px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h2{font-size:22px;margin-bottom:8px}p{line-height:1.6;color:#444;margin-bottom:12px}
.steps{display:grid;gap:16px;margin:24px 0}.step{display:flex;gap:14px;align-items:flex-start}
.step-n{width:32px;height:32px;border-radius:50%;background:#2563EB;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;flex-shrink:0}
</style></head>
<body>
<div class="hero">
  <h1>Your free website is ready, ${businessName}!</h1>
  <p>We built you a professional website — completely free. Preview it now and claim it in 60 seconds.</p>
  <a href="${demoUrl}" target="_blank" class="btn">View My Free Website</a>
  <a href="#claim" class="btn btn-outline">Claim It Free</a>
</div>
<div class="card" id="claim">
  <h2>What happens when you claim it</h2>
  <div class="steps">
    <div class="step"><div class="step-n">1</div><div><strong>We transfer it to you</strong><p>Your website goes live on your own domain within 24 hours.</p></div></div>
    <div class="step"><div class="step-n">2</div><div><strong>We connect your tools</strong><p>Online bookings, payments, email marketing — all set up for you.</p></div></div>
    <div class="step"><div class="step-n">3</div><div><strong>AI runs your marketing</strong><p>Posts to Instagram, replies to enquiries, chases unpaid invoices — automatically.</p></div></div>
  </div>
  <p style="font-size:13px;color:#888;margin-top:16px">Built by ${agencyName} using MINE — the AI business platform.</p>
  <a href="mailto:${prospect.contact_email || "hello@takeova.ai"}?subject=I want to claim my free website — ${businessName}" class="btn" style="display:block;text-align:center;margin-top:8px;background:#2563EB;color:#fff">Claim My Free Website</a>
</div>
</body></html>`);
});

// Prospector SMS outreach — sends a personalised SMS to a prospect
router.post("/prospector/sms-outreach", auth, async (req, res) => {
  const { prospectId, phoneNumber, businessName, demoUrl } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });

  const db = getDb();
  const twilioSid   = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = getSetting("TWILIO_AUTH_TOKEN")   || process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom  = getSetting("TWILIO_PROSPECTOR_NUMBER") || getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER;

  if (!twilioSid || !twilioToken || !twilioFrom) return res.json({ success: false, reason: "Twilio not configured." });

  const user    = db.prepare("SELECT business_name, name FROM users WHERE id = ?").get(req.userId);
  const agencyName = user?.business_name || user?.name || "us";
  const firstName  = businessName?.split(" ")[0] || "there";
  const claimUrl   = demoUrl || `${process.env.FRONTEND_URL || "https://takeova.ai"}/claim/${prospectId}`;

  const smsBody = `Hi ${firstName}! I built a free website for ${businessName} — take a look: ${claimUrl}\n\nIf you want to claim it, just reply YES. — ${agencyName}. Reply STOP to opt out.`;

  try {
    const client = require("twilio")(twilioSid, twilioToken);
    const msg = await client.messages.create({ body: smsBody, from: twilioFrom, to: phoneNumber });

    // Log outreach
    const { v4: uuid } = require("uuid");
    db.exec("CREATE TABLE IF NOT EXISTS prospector_outreach (id TEXT PRIMARY KEY, user_id TEXT, prospect_id TEXT, channel TEXT, phone TEXT, body TEXT, twilio_sid TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO prospector_outreach (id, user_id, prospect_id, channel, phone, body, twilio_sid, status) VALUES (?,?,?,?,?,?,?,?)")
      .run(uuid(), req.userId, prospectId || "", "sms", phoneNumber, smsBody, msg.sid, msg.status);

    res.json({ success: true, sid: msg.sid });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── 11. SALES REP: SMS follow-ups ─────────────────────────────────────────────

router.post("/sales/sms-followup", auth, async (req, res) => {
  const { leadId, phoneNumber, leadName, followupNumber, dealContext } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });

  const db = getDb();
  // only act if the Sales Rep is actually hired/enabled
  try { const _hired = db.prepare("SELECT id FROM ai_employees WHERE user_id=? AND role='sales' AND enabled=1").get(req.userId); if (!_hired) return res.status(403).json({ success: false, error: "Hire the AI Sales Rep to send sales follow-ups." }); } catch(_e) {}
  const twilioSid   = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = getSetting("TWILIO_AUTH_TOKEN")   || process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom  = getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER;
  if (!twilioSid || !twilioToken || !twilioFrom) return res.json({ success: false, reason: "Twilio not configured." });

  const user     = db.prepare("SELECT business_name, name FROM users WHERE id = ?").get(req.userId);
  const bizName  = user?.business_name || user?.name || "us";
  const firstName = leadName?.split(" ")[0] || "there";

  // Escalating message sequence
  const messages = [
    `Hi ${firstName}! Thanks for your interest in ${bizName}. Happy to answer any questions — just reply here. 😊`,
    `Hey ${firstName}, just following up! Did you get a chance to look at what we sent? Let me know if I can help. — ${bizName}`,
    `Hi ${firstName}, last follow-up from ${bizName}! We'd love to work with you. Reply YES if you're still interested and I'll get things moving quickly.`
  ];
  const smsBody = messages[Math.min((followupNumber || 1) - 1, messages.length - 1)];

  try {
    const client = require("twilio")(twilioSid, twilioToken);
    const msg = await client.messages.create({ body: smsBody, from: twilioFrom, to: phoneNumber });

    // Log in sms_log
    const { v4: uuid } = require("uuid");
    try {
      db.prepare("INSERT INTO sms_log (id, user_id, contact_id, phone, body, twilio_sid, status) VALUES (?,?,?,?,?,?,?)")
        .run(uuid(), req.userId, leadId || "", phoneNumber, smsBody, msg.sid, msg.status);
    } catch(_) {}

    res.json({ success: true, sid: msg.sid, message: smsBody });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── 12. COLD EMAIL: Reply detection (SendGrid Inbound Parse) ──────────────────
// Configure SendGrid Inbound Parse to POST to: /api/ai-employees/cold-email/inbound-reply
// When a prospect replies to a cold email, this stops their sequence automatically.

router.post("/cold-email/inbound-reply", async (req, res) => {
  // Verify SendGrid webhook signature — without this, a competitor could
  // forge fake "replies" from prospects to stop the target user's cold
  // email sequences.
  if (!verifySendgridSig(req)) {
    return res.status(403).json({ error: "Invalid signature" });
  }
  const { from, to, subject, text } = req.body;
  if (!from) return res.status(200).json({ ok: true });

  const db = getDb();
  const senderEmail = from.match(/<(.+)>/)?.[1] || from;

  // Find the cold email sequence this person is in
  let stopped = 0;
  try {
    db.exec("CREATE TABLE IF NOT EXISTS cold_email_replies (id TEXT PRIMARY KEY, user_id TEXT, prospect_email TEXT, subject TEXT, body TEXT, received_at TEXT DEFAULT (datetime('now')), sequence_stopped INTEGER DEFAULT 0)");

    // Find active sequences for this email
    const sequences = db.prepare(`
      SELECT cs.id, cs.user_id, cs.prospect_email
      FROM cold_email_sequences cs
      WHERE LOWER(cs.prospect_email) = LOWER(?) AND cs.status = 'active'
    `).all(senderEmail);

    for (const seq of sequences) {
      // Stop the sequence
      db.prepare("UPDATE cold_email_sequences SET status = 'replied', stopped_at = datetime('now'), stop_reason = 'prospect_replied' WHERE id = ?").run(seq.id);

      // Log the reply
      const { v4: uuid } = require("uuid");
      db.prepare("INSERT INTO cold_email_replies (id, user_id, prospect_email, subject, body, sequence_stopped) VALUES (?,?,?,?,?,?)")
        .run(uuid(), seq.user_id, senderEmail, subject || "", (text || "").substring(0, 1000), 1);

      // Notify the user
      try {
        db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)")
          .run(uuid(), seq.user_id, "📬", `${senderEmail} replied to your cold email sequence — sequence stopped automatically. Check your inbox!`, "Just now");
      } catch(_) {}

      // Add to CRM as a warm lead
      try {
        db.prepare("INSERT OR IGNORE INTO contacts (id, user_id, email, tags, source, created_at) VALUES (?,?,?,?,?,datetime('now'))")
          .run(uuid(), seq.user_id, senderEmail, JSON.stringify(["cold-email-reply","warm-lead"]), "cold_email_reply");
        db.prepare("UPDATE contacts SET tags = json_insert(tags, '$[#]', 'warm-lead'), source = 'cold_email_reply' WHERE user_id = ? AND email = LOWER(?)").run(seq.user_id, senderEmail);
      } catch(_) { console.error("[/cold-email/inbound-reply]", _.message || _); }

      stopped++;
    }
  } catch(e) { console.error("[cold-email reply]", e.message); }

  res.status(200).json({ ok: true, sequencesStopped: stopped });
});

// Get cold email replies
router.get("/cold-email/replies", auth, (req, res) => {
  const db = getDb();
  try {
    const replies = db.prepare("SELECT * FROM cold_email_replies WHERE user_id = ? ORDER BY received_at DESC LIMIT 50").all(req.userId);
    res.json({ replies });
  } catch(_) { res.json({ replies: [] }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HEYGEN INTEGRATION — UGC ads, product placement, avatar videos
// Replaces Arcads entirely. Costs ~$0.50–$3 vs Arcads $49.
// Charge 4x: $6 Avatar IV 30s, $12 Avatar IV 60s, $6 UGC+Product
// ═══════════════════════════════════════════════════════════════════════════════

const HEYGEN_API = 'https://api.heygen.com';

// Credit costs at Scale tier ($0.50/credit):
// Avatar IV: 6 credits/min = $3/min at Scale tier = $0.05/sec raw cost
// At Pro tier ($0.99/credit): ~$0.10/sec raw cost
// Your charge: $0.25/sec with $1 minimum (covers Stripe $0.30 flat fee on tiny videos)
// Examples: 15s=$3.75, 30s=$7.50, 60s=$15
const COST_PER_SEC   = 0.05;
const CHARGE_PER_SEC = 0.25;
const MIN_CHARGE     = 1.00;
const calcCost   = secs => Math.round(secs * COST_PER_SEC   * 100) / 100;
const calcCharge = secs => Math.max(MIN_CHARGE, Math.round(secs * CHARGE_PER_SEC * 100) / 100);

// ── Stripe off-session charge helper ─────────────────────────────────────────
// Returns { ok, paymentIntentId, reason }
async function chargeUserForVideo(db, userId, amountDollars, description) {
  // ── Admin bypass: owner uses free, costs route to company API accounts ──
  if (typeof global.mineIsAdmin === "function" && global.mineIsAdmin(db, userId)) {
    return { ok: true, paymentIntentId: "admin_free_video_" + Date.now(), admin: true };
  }
  const stripeKey = getSetting('STRIPE_SECRET_KEY') || process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return { ok: false, reason: 'Stripe not configured — add STRIPE_SECRET_KEY' };

  const user = db.prepare('SELECT stripe_customer_id, email FROM users WHERE id=?').get(userId);
  if (!user?.stripe_customer_id) return { ok: false, reason: 'No payment method on file' };

  const amountCents = Math.round(amountDollars * 100);
  try {
    const stripe = require('stripe')(stripeKey);
    // Get default payment method for the customer
    const customer = await stripe.customers.retrieve(user.stripe_customer_id, {
      expand: ['invoice_settings.default_payment_method']
    });
    const pm = customer?.invoice_settings?.default_payment_method;
    if (!pm) return { ok: false, reason: 'No default payment method on file' };

    const pi = await stripe.paymentIntents.create({
      amount:               amountCents,
      currency:             'usd',
      customer:             user.stripe_customer_id,
      payment_method:       typeof pm === 'string' ? pm : pm.id,
      payment_method_types: ['card'],
      confirm:              true,
      off_session:          true,
      description,
      metadata: { user_id: userId, type: 'video_generation' },
    }, {
      // Idempotency: user + amount + description hash + 5min window.
      // If caller retries within 5min for same charge, we get the cached PI.
      idempotencyKey: `vid_${userId}_${amountCents}_${require('crypto').createHash('md5').update(description || '').digest('hex').slice(0, 8)}_${Math.floor(Date.now() / 300000)}`,
    });
    if (pi.status === 'succeeded') {
      return { ok: true, paymentIntentId: pi.id };
    }
    return { ok: false, reason: 'Payment failed: ' + pi.status };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
}


// ── List available HeyGen avatars ──────────────────────────────────────────────
router.get('/heygen/avatars', auth, async (req, res) => {
  const apiKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.json({ success: false, reason: 'HEYGEN_API_KEY not configured' });

  const fetch2 = (await import('node-fetch')).default;
  try {
    const r = await fetch2(`${HEYGEN_API}/v2/avatars`, {
      headers: { 'X-Api-Key': apiKey }
    });
    const d = await r.json();
    // Return curated list with UGC-suitable avatars flagged
    const avatars = (d.data?.avatars || []).map(a => ({
      id: a.avatar_id,
      name: a.avatar_name,
      gender: a.gender,
      preview: a.preview_image_url,
      previewVideo: a.preview_video_url,
      ugcSuitable: a.avatar_name?.toLowerCase().includes('ugc') || a.tags?.includes('ugc'),
    }));
    res.json({ success: true, avatars, pricing: { av4_30s:{cost:1.50,charge:6.00}, av4_60s:{cost:3.00,charge:12.00}, ugc_product:{cost:1.50,charge:6.00} } });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── Generate Avatar IV video (all videos use Avatar IV) ─────────────────────────
router.post('/heygen/generate', auth, async (req, res) => {
  const { script, avatarId, voiceId, duration, avatarStyle, background, aspectRatio, title } = req.body;
  if (!script) return res.status(400).json({ error: 'script required' });

  const apiKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.json({ success: false, reason: 'Add HEYGEN_API_KEY in .env or Settings → Integrations' });

  const db = getDb();
  const { v4: uuid } = require('uuid');
  const fetch2 = (await import('node-fetch')).default;

  // Determine pricing tier based on duration
  const dur = duration || 60;
  const useAv4 = true;
  const pricingKey = dur <= 30 ? 'av4_30s' : 'av4_60s';
  const pricing = { cost: calcCost(dur), charge: calcCharge(dur) };

  // Charge the user
  try {
    db.exec("CREATE TABLE IF NOT EXISTS charges (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, amount REAL, description TEXT, status TEXT, reference TEXT, created_at TEXT DEFAULT (datetime('now')))");
    const charge = db.prepare('INSERT INTO charges (id, user_id, type, amount, description, status) VALUES (?,?,?,?,?,?)')
      .run(uuid(), req.userId, 'heygen_video', pricing.charge, pricing.label, 'pending');
  } catch(_) {}

  // Charge before generating
  const _c1 = await chargeUserForVideo(db,req.userId,charge,`MINE HeyGen ${dur}s`);
  if(!_c1.ok) return res.json({success:false,reason:'Payment: '+_c1.reason,charge});

    try {
    const payload = {
      video_inputs: [{
        character: {
          type: 'avatar',
          avatar_id: avatarId || 'default',
          avatar_style: useAv4 ? 'normal' : 'normal',
          use_avatar_iv_model: true, // Always Avatar IV
        },
        voice: {
          type: 'text',
          input_text: script,
          voice_id: voiceId || '',
          speed: 1.0,
        },
        background: {
          type: background?.type || 'color',
          value: background?.value || '#FFFFFF',
        },
      }],
      aspect_ratio: aspectRatio || '9:16',
      test: false,
      caption: true,
    };

    const r = await fetch2(`${HEYGEN_API}/v2/video/generate`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    const videoId = d.data?.video_id;
    if (!videoId) return res.json({ success: false, reason: d.message || 'Generation failed', raw: d });

    // Store the job
    db.exec('CREATE TABLE IF NOT EXISTS heygen_jobs (id TEXT PRIMARY KEY, user_id TEXT, video_id TEXT, type TEXT, title TEXT, script TEXT, status TEXT DEFAULT \'pending\', video_url TEXT, thumbnail_url TEXT, cost REAL, charged REAL, created_at TEXT DEFAULT (datetime(\'now\')))');
    db.prepare('INSERT INTO heygen_jobs (id, user_id, video_id, type, title, script, cost, charged) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), req.userId, videoId, pricingKey, title || 'Avatar Video', script.substring(0,100), pricing.cost, pricing.charge);

    // Mark charge as complete
    try { db.prepare("UPDATE charges SET status='completed', reference=? WHERE user_id=? AND type='heygen_video' AND status='pending'").run(videoId, req.userId); } catch(_) { console.error("[/heygen/generate]", _.message || _); }

    res.json({ success: true, videoId, pricingKey, cost: pricing.cost, charged: pricing.charge });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── Generate Avatar IV video (hyper-realistic) ────────────────────────────────
router.post('/heygen/generate-av4', auth, async (req, res) => {



  const { script, avatarId, voiceId, duration, background, aspectRatio, title, gesturePrompt } = req.body;
  if (!script) return res.status(400).json({ error: 'script required' });

  const apiKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.json({ success: false, reason: 'Add HEYGEN_API_KEY in .env' });

  const db = getDb(); const { v4: uuid } = require('uuid');
  const fetch2 = (await import('node-fetch')).default;
  const dur = duration || 30;
  const cost = calcCost(dur);
  const charge = calcCharge(dur);

  const av4charge = await chargeUserForVideo(db,req.userId,charge,'MINE HeyGen Avatar IV '+dur+'s');
  if(!av4charge.ok) return res.json({success:false,reason:'Payment required: '+av4charge.reason,charge});

  try {
    // Avatar IV endpoint
    const payload = {
      avatar_id: avatarId || '',
      input_text: script,
      voice_id: voiceId || '',
      aspect_ratio: aspectRatio || '9:16',
      ...(gesturePrompt && { motion_prompt: gesturePrompt }),
      background: background?.value || '#FFFFFF',
      caption: true,
    };

    const r = await fetch2(`${HEYGEN_API}/v2/video/av4/generate`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    const videoId = d.data?.video_id;
    if (!videoId) return res.json({ success: false, reason: d.message || 'AV4 generation failed', raw: d });

    db.prepare('INSERT OR IGNORE INTO heygen_jobs (id, user_id, video_id, type, title, script, cost, charged) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), req.userId, videoId, 'av4_'+dur+'s', title || 'Avatar IV Video', script.substring(0,100), cost, charge);

    res.json({ success: true, videoId, cost: pricing.cost, charged: pricing.charge });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── Generate UGC Ad with Product Placement ────────────────────────────────────
// User uploads product image → avatar holds/interacts with it → UGC ad
router.post('/heygen/ugc-product', auth, async (req, res) => {
  const { script, productImageUrl, avatarId, voiceId, aspectRatio, title, avatarPosition, duration } = req.body;
  if (!script) return res.status(400).json({ error: 'script required' });
  if (!productImageUrl) return res.status(400).json({ error: 'productImageUrl required — upload product image first' });

  const apiKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.json({ success: false, reason: 'Add HEYGEN_API_KEY in .env' });

  const db = getDb(); const { v4: uuid } = require('uuid');
  const fetch2 = (await import('node-fetch')).default;
  const ugcSecs2 = duration || 30;
  const pricing = { cost: calcCost(ugcSecs2), charge: calcCharge(ugcSecs2) };

  try {
    // UGC Ad / Product Placement uses the Avatar IV endpoint with product_image
    const payload = {
      avatar_id: avatarId || '',
      input_text: script,
      voice_id: voiceId || '',
      aspect_ratio: aspectRatio || '9:16',
      product_image_url: productImageUrl,
      avatar_position: avatarPosition || 'bottom-right',
      duration: duration || 8, // seconds: 4, 8, or 12
      caption: true,
    };

    // Use the UGC ad endpoint
    const r = await fetch2(`${HEYGEN_API}/v1/ugc_ad/generate`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    const videoId = d.data?.video_id || d.video_id;
    if (!videoId) return res.json({ success: false, reason: d.message || 'UGC generation failed', raw: d });

    db.prepare('INSERT OR IGNORE INTO heygen_jobs (id, user_id, video_id, type, title, script, cost, charged) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), req.userId, videoId, 'ugc_product', title || 'UGC Product Ad', script.substring(0,100), pricing.cost, pricing.charge);

    res.json({ success: true, videoId, type: 'ugc_product', cost: pricing.cost, charged: pricing.charge, label: pricing.label });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── Upload asset (product image) to HeyGen ────────────────────────────────────
router.post('/heygen/upload-asset', auth, async (req, res) => {
  const { imageUrl, imageBase64, mimeType, fileName } = req.body;
  const apiKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.json({ success: false, reason: 'Add HEYGEN_API_KEY in .env' });

  const fetch2 = (await import('node-fetch')).default;
  try {
    let assetUrl = imageUrl;
    if (!assetUrl && imageBase64) {
      // Upload base64 image to HeyGen asset storage
      const r = await fetch2(`${HEYGEN_API}/v1/asset`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_name: fileName || 'product.jpg',
          content: imageBase64,
          mime_type: mimeType || 'image/jpeg',
        }),
      });
      const d = await r.json();
      assetUrl = d.data?.url || d.url;
      if (!assetUrl) return res.json({ success: false, reason: d.message || 'Upload failed' });
    }
    res.json({ success: true, assetUrl });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── Poll video status ──────────────────────────────────────────────────────────
router.get('/heygen/status/:videoId', auth, async (req, res) => {
  const apiKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.json({ success: false, reason: 'HEYGEN_API_KEY not configured' });

  const fetch2 = (await import('node-fetch')).default;
  try {
    const r = await fetch2(`${HEYGEN_API}/v1/video_status.get?video_id=${req.params.videoId}`, {
      headers: { 'X-Api-Key': apiKey },
    });
    const d = await r.json();
    const status  = d.data?.status || d.status;
    const videoUrl = d.data?.video_url;
    const thumbUrl = d.data?.thumbnail_url;

    // Update DB if complete
    if (status === 'completed' && videoUrl) {
      const db = getDb();
      try {
        db.prepare("UPDATE heygen_jobs SET status='completed', video_url=?, thumbnail_url=? WHERE video_id=? AND user_id=?")
          .run(videoUrl, thumbUrl || '', req.params.videoId, req.userId);
        // Mirror into short_form_videos so post_now can find it automatically
        const job = db.prepare("SELECT title, script, type FROM heygen_jobs WHERE video_id=? AND user_id=?").get(req.params.videoId, req.userId);
        db.exec("CREATE TABLE IF NOT EXISTS short_form_videos (id TEXT PRIMARY KEY, user_id TEXT, product_id TEXT, script TEXT, video_url TEXT, status TEXT, provider TEXT, task_id TEXT, platforms TEXT, created_at TEXT)");
        const { v4: sfvUuid } = require('uuid');
        db.prepare("INSERT OR IGNORE INTO short_form_videos (id, user_id, script, video_url, status, provider, task_id, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
          .run(sfvUuid(), req.userId, job?.script || '', videoUrl, 'completed', 'heygen', req.params.videoId);
      } catch(_) {}
    }

    res.json({ success: true, status, videoUrl, thumbnailUrl: thumbUrl, raw: d.data });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── Get all HeyGen videos for user ────────────────────────────────────────────
router.get('/heygen/videos', auth, (req, res) => {
  const db = getDb();
  try {
    const videos = db.prepare('SELECT * FROM heygen_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.userId);
    res.json({ success: true, videos, pricing: { av4_30s:{cost:1.50,charge:6.00}, av4_60s:{cost:3.00,charge:12.00}, ugc_product:{cost:1.50,charge:6.00} } });
  } catch(_) {
    res.json({ success: true, videos: [], pricing: { av4_30s:{cost:1.50,charge:6.00}, av4_60s:{cost:3.00,charge:12.00}, ugc_product:{cost:1.50,charge:6.00} } });
  }
});

// ── AI script writer for HeyGen videos ────────────────────────────────────────
router.post('/heygen/write-script', auth, async (req, res) => {
  const { productName, productDescription, platform, goal, tone, duration, videoType, businessName } = req.body;
  const Anthropic = require('@anthropic-ai/sdk');
  const claude = new Anthropic({ apiKey: getSetting('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY });
  const db = getDb();
  const user = db.prepare('SELECT name, business_name FROM users WHERE id=?').get(req.userId);
  const biz = businessName || user?.business_name || user?.name || 'the business';

  const wordCount = duration === 30 ? 60 : 120; // ~2 words/sec

  const typeGuides = {
    ugc_product:  'Write as a genuine customer discovery — hook with a relatable problem, reveal the product naturally, show one key benefit, end with direct CTA.',
    talking_head: 'Professional but conversational. Lead with value, explain the main benefit, social proof if possible, CTA.',
    testimonial:  'First-person success story. Before/after structure. Specific results. Authentic and unscripted feeling.',
    explainer:    'Clear, educational. Problem → solution → how it works → CTA. No jargon.',
    promo:        'High energy. Hook → offer → urgency → CTA. Keep tight.',
  };

  try {
    const pr = await claude.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a ${duration || 60}-second ${videoType || 'ugc'} video script for ${platform || 'TikTok/Instagram'}.
Business: ${biz}
Product: ${productName || 'our product'}
Description: ${productDescription || ''}
Goal: ${goal || 'drive sales'}
Tone: ${tone || 'authentic, casual'}
Style guide: ${typeGuides[videoType] || typeGuides.ugc_product}

Write ONLY the spoken script — about ${wordCount} words. No stage directions, no notes, just the words the avatar will say. Start with a strong hook in the first 3 seconds.`
      }]
    });
    const script = pr.content[0]?.text?.trim() || '';
    res.json({ success: true, script });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ── Marketing Manager auto-video: uses saved product config ──────────────────────
router.post('/heygen/auto-marketing', auth, async (req, res) => {
  const { score, platform, businessName } = req.body;
  const db = getDb();
  const config = db.prepare("SELECT rules FROM ai_employees WHERE user_id=? AND role='marketing'").get(req.userId);
  let rules = {};
  try { rules = JSON.parse(config?.rules || '{}'); } catch(_) {}

  if (!rules.autoVideoAds) return res.json({ success: false, reason: 'autoVideoAds not enabled in Marketing Manager config' });

  // Look up the configured product
  let productImageUrl = null;
  let productName = '';
  const productId = (req.body && req.body.productId) || rules.videoProductId;
  if (productId) {
    const product = db.prepare('SELECT name, images_json FROM products WHERE id=? AND user_id=?').get(productId, req.userId);
    if (product) {
      productName = product.name;
      try {
        const imgs = JSON.parse(product.images_json || '[]');
        productImageUrl = imgs[0] || null;
      } catch(_) {}
    }
  }
  if (!productImageUrl) return res.json({ success: false, reason: 'No product configured. Open Marketing Manager config and select a default product.' });

  const token = db.prepare('SELECT token FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(req.userId)?.token || '';
  const fetch2 = (await import('node-fetch')).default;
  const api = process.env.API_BASE_URL || ('http://localhost:'+(process.env.PORT||4000));

  // Write script
  const sRes = await fetch2(api+'/api/ai-employees/heygen/write-script', {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body: JSON.stringify({ platform: platform||'facebook', goal: ((req.body && req.body.hook) ? String(req.body.hook).trim() : '') || 'drive sales', tone: rules.tone||'professional', duration:30, videoType:'ugc_product', businessName, productName })
  });
  const sData = await sRes.json();
  if (!sData.success) return res.json({ success: false, reason: 'Script failed' });

  // Generate UGC video
  // Charge before generating
  const mktSecs = 30;
  const mktChargeResult = await chargeUserForVideo(
    db, req.userId, calcCharge(mktSecs),
    `MINE Auto Marketing Video (HeyGen ${mktSecs}s) — ${productName}`
  );
  if (!mktChargeResult.ok) {
    return res.json({ success: false, reason: 'Payment failed: ' + mktChargeResult.reason });
  }

  const gRes = await fetch2(api+'/api/ai-employees/heygen/ugc-product-v2', {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body: JSON.stringify({ script: sData.script, productId, productImageUrl, duration:30, aspectRatio:'1:1', title: 'Auto Marketing: '+productName })
  });
  const gData = await gRes.json();
  // Refund if HeyGen failed
  if (!gData.success && mktChargeResult.paymentIntentId) {
    try {
      const stripe2 = require('stripe')(getSetting('STRIPE_SECRET_KEY') || process.env.STRIPE_SECRET_KEY);
      await stripe2.refunds.create({ payment_intent: mktChargeResult.paymentIntentId });
    } catch(_) {}
  }
  res.json({ success: gData.success, videoId: gData.videoId, script: sData.script,
    cost: gData.cost || calcCost(mktSecs), charged: mktChargeResult.ok ? calcCharge(mktSecs) : 0,
    paymentIntentId: mktChargeResult.paymentIntentId,
    reason: gData.reason });
});

// ── HeyGen social auto: AI decides video type and generates ───────────────────
// Called by Social Manager cron when autoHeyGen is enabled
router.post('/heygen/auto-social', auth, async (req, res) => {
  const { postCaption, platform, productName, businessName } = req.body;
  const db = getDb();
  const config = db.prepare("SELECT rules FROM ai_employees WHERE user_id=? AND role='social'").get(req.userId);
  let rules = {};
  try { rules = JSON.parse(config?.rules || '{}'); } catch(_) {}

  if (!rules.autoHeyGen) return res.json({ success: false, reason: 'autoHeyGen not enabled in Social Manager config' });

  // Look up the configured default product
  let productImageUrl = null;
  let resolvedProductName = productName || '';
  const productId = rules.heygenProductId;
  if (productId) {
    const product = db.prepare('SELECT name, images_json FROM products WHERE id=? AND user_id=?').get(productId, req.userId);
    if (product) {
      resolvedProductName = productName || product.name;
      try {
        const imgs = JSON.parse(product.images_json || '[]');
        productImageUrl = imgs[0] || null;
      } catch(_) {}
    }
  }
  if (!productImageUrl && rules.heygenType === 'ugc_product') {
    return res.json({ success: false, reason: 'No product configured for UGC ads. Open Social Manager config and select a default product.' });
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const claude = new Anthropic({ apiKey: getSetting('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY });
  const fetch2 = (await import('node-fetch')).default;

  // Step 1: AI decides video type
  const decision = await claude.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 100,
    messages: [{
      role: 'user',
      content: `For this social post on ${platform}: "${postCaption.substring(0,200)}"
Decide the best HeyGen video type. Reply with ONLY one of: ugc_product, talking_head, testimonial, explainer, promo
Rules: If post mentions a product/item → ugc_product. If it's a story/tip → talking_head. If it's a review → testimonial. If it explains something → explainer. If it's a sale/offer → promo.`
    }]
  });
  const videoType = decision.content[0]?.text?.trim().toLowerCase().replace(/[^a-z_]/g,'') || 'talking_head';
  const needsProduct = videoType === 'ugc_product';
  if (needsProduct && !productImageUrl) return res.json({ success: false, reason: 'ugc_product selected but no productImageUrl provided', videoType });

  // Step 2: Write script
  const scriptRes = await fetch2(`http://localhost:${process.env.PORT || 4000}/api/ai-employees/heygen/write-script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${db.prepare('SELECT token FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(req.userId)?.token || ''}` },
    body: JSON.stringify({ platform, goal: 'engagement and reach', tone: rules.tone || 'friendly', duration: 30, videoType, businessName, productName: resolvedProductName }),
  });
  const scriptData = await scriptRes.json();
  if (!scriptData.success) return res.json({ success: false, reason: 'Script generation failed' });

  // Step 3: Generate video
  const genEndpoint = needsProduct ? '/api/ai-employees/heygen/ugc-product' : '/api/ai-employees/heygen/generate';
  // Charge before generating
  const asSecs = 30;
  const asChargeResult = await chargeUserForVideo(
    db, req.userId, calcCharge(asSecs),
    `MINE Auto Social Video (HeyGen ${asSecs}s) — ${videoType}`
  );
  if (!asChargeResult.ok) {
    return res.json({ success: false, reason: 'Payment failed: ' + asChargeResult.reason });
  }

  const genRes = await fetch2(`http://localhost:${process.env.PORT || 4000}${genEndpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${db.prepare('SELECT token FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(req.userId)?.token || ''}` },
    body: JSON.stringify({
      script: scriptData.script,
      productImageUrl: productImageUrl || null,
      aspectRatio: platform === 'tiktok' || platform === 'instagram_reels' ? '9:16' : '1:1',
      title: `Auto: ${platform} ${videoType}`,
      duration: 30,
    }),
  });
  const genData = await genRes.json();

  res.json({
    success: genData.success,
    videoId: genData.videoId,
    videoType,
    script: scriptData.script,
    cost: genData.cost,
    charged: genData.charged,
    reason: genData.reason,
  });
});


// ── Runway Gen-4 Turbo: same cost as HeyGen ($0.05/sec) ──────────────────────
router.post('/runway/generate-turbo', auth, async (req, res) => {
  const { prompt, imageUrl, duration, aspectRatio, title } = req.body;
  const runwayKey = getSetting('RUNWAY_API_KEY') || process.env.RUNWAY_API_KEY;
  if (!runwayKey) return res.json({ success: false, reason: 'Add RUNWAY_API_KEY in .env' });
  const db = getDb(); const { v4: uuid } = require('uuid');
  const fetch2 = (await import('node-fetch')).default;
  const secs = duration || 10;
  const cost = calcCost(secs); const charge = calcCharge(secs);
  // Charge before generating
  const _c4 = await chargeUserForVideo(db,req.userId,charge,`MINE Runway Gen-4 Turbo ${secs}s`);
  if(!_c4.ok) return res.json({success:false,reason:'Payment: '+_c4.reason,charge});

    try {
    const r = await fetch2('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer '+runwayKey, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' },
      body: JSON.stringify({ model: 'gen4_turbo', promptText: prompt || '', ...(imageUrl && { promptImage: imageUrl }), ratio: aspectRatio || '1280:720', duration: secs })
    });
    const d = await r.json();
    const taskId = d.id;
    if (!taskId) return res.json({ success: false, reason: d.message || 'Runway failed', raw: d });
    try { db.prepare('INSERT OR IGNORE INTO heygen_jobs (id,user_id,video_id,type,title,script,cost,charged) VALUES (?,?,?,?,?,?,?,?)').run(uuid(), req.userId, taskId, 'runway_turbo_'+secs+'s', title||'Runway Turbo', (prompt||'').substring(0,100), cost, charge); } catch(_) { console.error("[/runway/generate-turbo]", _.message || _); }
    res.json({ success: true, videoId: taskId, provider: 'runway', cost, charged: charge, secs });
  } catch(e) { res.json({ success: false, reason: e.message }); }
});

router.get('/runway/status/:taskId', auth, async (req, res) => {
  const runwayKey = getSetting('RUNWAY_API_KEY') || process.env.RUNWAY_API_KEY;
  if (!runwayKey) return res.json({ success: false, reason: 'RUNWAY_API_KEY not configured' });
  const fetch2 = (await import('node-fetch')).default;
  try {
    const r = await fetch2('https://api.dev.runwayml.com/v1/tasks/'+req.params.taskId, {
      headers: { 'Authorization': 'Bearer '+runwayKey, 'X-Runway-Version': '2024-11-06' }
    });
    const d = await r.json();
    const videoUrl = (d.output||[])[0];
    if (d.status === 'SUCCEEDED' && videoUrl) {
      try { getDb().prepare("UPDATE heygen_jobs SET status='completed', video_url=? WHERE video_id=?").run(videoUrl, req.params.taskId); } catch(_) {}
    }
    res.json({ success: true, status: d.status, videoUrl, raw: d });
  } catch(e) { res.json({ success: false, reason: e.message }); }
});

// ── Get user's products for HeyGen product picker ─────────────────────────────
router.get('/heygen/products', auth, (req, res) => {
  const db = getDb();
  try {
    const products = db.prepare(
      "SELECT id, name, description, price, images_json, category FROM products WHERE user_id=? AND status='active' ORDER BY name ASC LIMIT 100"
    ).all(req.userId);

    const mapped = products.map(p => {
      let images = [];
      try { images = JSON.parse(p.images_json || '[]'); } catch(_) {}
      return {
        id:          p.id,
        name:        p.name,
        description: p.description,
        price:       p.price,
        category:    p.category,
        primaryImage: images[0] || null,  // first image URL
        allImages:   images,
      };
    });

    res.json({ success: true, products: mapped });
  } catch(e) {
    res.json({ success: false, reason: e.message, products: [] });
  }
});

// ── Generate UGC + Product Placement (corrected endpoint with fallback) ────────
// Primary: POST /v2/video/generate with use_avatar_iv_model + product_image_url
// Fallback: POST /v2/video/av4/generate  
// Both produce Avatar IV presenter holding/interacting with the product
router.post('/heygen/ugc-product-v2', auth, async (req, res) => {
  const { 
    script, productId, productImageUrl, avatarId, voiceId,
    aspectRatio, title, avatarPosition, duration, gesturePrompt 
  } = req.body;

  if (!script) return res.status(400).json({ error: 'script required' });

  const apiKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.json({ success: false, reason: 'Add HEYGEN_API_KEY in .env' });

  const db = getDb();
  const { v4: uuid } = require('uuid');
  const fetch2 = (await import('node-fetch')).default;
  const secs   = duration || 30;
  const cost   = calcCost(secs);
  const charge = calcCharge(secs);

  // If productId provided, look up the product's image from DB
  let resolvedImageUrl = productImageUrl;
  let productName = '';
  if (productId && !resolvedImageUrl) {
    const product = db.prepare('SELECT name, images_json FROM products WHERE id=? AND user_id=?').get(productId, req.userId);
    if (product) {
      productName = product.name;
      try {
        const imgs = JSON.parse(product.images_json || '[]');
        resolvedImageUrl = imgs[0] || null;
      } catch(_) {}
    }
    if (!resolvedImageUrl) return res.json({ success: false, reason: `Product "${productName}" has no image. Add a product image first.` });
  }

  if (!resolvedImageUrl) return res.json({ success: false, reason: 'No product image — either select a product or upload an image' });

  // Upload product image to HeyGen asset storage first
  let heygenAssetUrl = resolvedImageUrl;
  if (!resolvedImageUrl.startsWith('https://')) {
    return res.json({ success: false, reason: 'Product image must be a public HTTPS URL. Upload the image to your site storage first.' });
  }

  // Try primary endpoint: /v2/video/generate with product_image_url
  const primaryPayload = {
    video_inputs: [{
      character: {
        type: 'avatar',
        avatar_id: avatarId || '',
        avatar_style: 'normal',
        use_avatar_iv_model: true,
      },
      voice: {
        type: 'text',
        input_text: script,
        voice_id: voiceId || '',
        speed: 1.0,
      },
      background: {
        type: 'color',
        value: '#FFFFFF',
      },
      // Product placement parameters
      ...(heygenAssetUrl && {
        product_image_url: heygenAssetUrl,
        avatar_position: avatarPosition || 'center',
      }),
    }],
    aspect_ratio: aspectRatio || '9:16',
    test: false,
    caption: true,
    ...(gesturePrompt && { motion_prompt: gesturePrompt }),
  };

  // Charge before generating
  const _c3 = await chargeUserForVideo(db,req.userId,charge,`MINE HeyGen UGC ${secs}s`);
  if(!_c3.ok) return res.json({success:false,reason:'Payment: '+_c3.reason,charge});

    try {
    let videoId = null;
    let endpointUsed = 'v2/video/generate';

    // Try primary endpoint
    const r1 = await fetch2(`${HEYGEN_API}/v2/video/generate`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(primaryPayload),
    });
    const d1 = await r1.json();
    videoId = d1.data?.video_id;

    // Fallback: try /v2/video/av4/generate if primary failed
    if (!videoId) {
      console.log('[HeyGen UGC] Primary failed, trying AV4 fallback:', d1.message);
      endpointUsed = 'v2/video/av4/generate';
      const av4Payload = {
        avatar_id:          avatarId || '',
        input_text:         script,
        voice_id:           voiceId || '',
        aspect_ratio:       aspectRatio || '9:16',
        product_image_url:  heygenAssetUrl,
        avatar_position:    avatarPosition || 'center',
        caption:            true,
        ...(gesturePrompt && { motion_prompt: gesturePrompt }),
      };
      const r2 = await fetch2(`${HEYGEN_API}/v2/video/av4/generate`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(av4Payload),
      });
      const d2 = await r2.json();
      videoId = d2.data?.video_id;

      if (!videoId) {
        return res.json({ 
          success: false, 
          reason: d2.message || 'Both HeyGen endpoints failed — check your API plan supports Avatar IV and product placement',
          primary_error: d1.message,
          fallback_error: d2.message,
        });
      }
    }

    // Save the job
    db.exec("CREATE TABLE IF NOT EXISTS heygen_jobs (id TEXT PRIMARY KEY, user_id TEXT, video_id TEXT, type TEXT, title TEXT, script TEXT, status TEXT DEFAULT 'pending', video_url TEXT, thumbnail_url TEXT, cost REAL, charged REAL, product_id TEXT, created_at TEXT DEFAULT (datetime('now')))");
    try {
      db.prepare('INSERT OR IGNORE INTO heygen_jobs (id,user_id,video_id,type,title,script,cost,charged,product_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(uuid(), req.userId, videoId, 'ugc_product_'+secs+'s', title || (productName ? 'UGC: '+productName : 'UGC Product'), script.substring(0,100), cost, charge, productId || null);
    } catch(_) {}

    res.json({ success: true, videoId, endpointUsed, cost, charged: charge, secs, productName });
  } catch(e) {
    res.json({ success: false, reason: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FIX 4: COO WhatsApp inbound handler
// Receives WhatsApp messages, Claude acts as AI COO, executes commands

// ─── In-panel COO chat — SSE endpoint used by the Take Control dashboard ───
// Mirrors the WhatsApp webhook logic but streams to the frontend instead of
// posting back to WhatsApp. Used for testing/onboarding without a real
// WhatsApp number.
router.post("/chat-stream", auth, async (req, res) => {
  const { message, history } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });

  // Plan gate — same as Take Control /test: Growth, Pro, Enterprise only.
  // Checked BEFORE SSE headers so we can return a clean 403 the dashboard can read.
  const gateUser = getDb().prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  if (!['growth', 'pro', 'enterprise'].includes(gateUser?.plan || 'starter')) {
    return res.status(403).json({
      error: "Take Control is available on Growth, Pro, and Enterprise plans.",
      upgrade: true,
      plans: ['growth', 'pro', 'enterprise']
    });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const db = getDb();
    const userId = req.userId;

    // ── FULL AGENT (option 2) ──────────────────────────────────────────────
    // Run the SAME 100-tool agent as WhatsApp via the shared runControlAgent.
    // It executes any tool calls to completion, then we stream the final reply
    // text back over the existing SSE contract the dashboard already parses —
    // so the dashboard chat now TAKES ACTIONS, not just advises, and keeps its
    // token-by-token feel.
    const { runControlAgent } = require("./mine-control");

    // The dashboard sends history as [{role,content}]; the agent wants a string.
    let historyFormatted = "";
    if (Array.isArray(history)) {
      historyFormatted = history.slice(-10)
        .filter(t => t && t.content)
        .map(t => `${t.role === "assistant" ? "Assistant" : "User"}: ${String(t.content)}`)
        .join("\n");
    }

    // Persist inbound to the shared Take Control log (parity with /test + WhatsApp)
    try {
      db.prepare("INSERT INTO mine_control_messages (id, user_id, direction, message) VALUES (?,?,?,?)")
        .run(require("uuid").v4(), userId, "inbound", String(message));
    } catch(_) {}

    const reply = await runControlAgent(db, userId, String(message), historyFormatted);

    // Stream the reply in small chunks for a typed-in feel (same SSE frames)
    const parts = String(reply || "Done ✅").split(/(\s+)/);
    let buf = "";
    for (let i = 0; i < parts.length; i++) {
      buf += parts[i];
      if (buf.length >= 18 || i === parts.length - 1) {
        send({ text: buf });
        buf = "";
        await new Promise(r => setTimeout(r, 12));
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();

    // Log outbound + command-log entry
    try {
      db.prepare("INSERT INTO mine_control_messages (id, user_id, direction, message) VALUES (?,?,?,?)")
        .run(require("uuid").v4(), userId, "outbound", String(reply || ""));
      db.prepare("INSERT OR IGNORE INTO ai_employee_actions (id,user_id,role,action,details,status,confidence,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
        .run(require("uuid").v4(), userId, "coo", "dashboard_chat", JSON.stringify({ message, reply }), "completed", 1.0);
    } catch(_) {}
  } catch (e) {
    try { send({ error: e.message || "Chat error" }); res.write("data: [DONE]\n\n"); res.end(); }
    catch(_) {}
  }
});

// ─── Send a test WhatsApp message — used by the 'Send Test' button ─────────
router.post("/coo/send-test", auth, async (req, res) => {
  try {
    const db = getDb();
    const message = req.body?.message || "Test from Take Control";

    // Get the user's configured WhatsApp number
    const empRow = db.prepare("SELECT rules FROM ai_employees WHERE user_id = ? AND role = 'coo' AND enabled = 1").get(req.userId);
    if (!empRow) return res.json({ posted: false, connected: false, note: "Take Control isn't set up yet. Open Settings on the agent and add your WhatsApp number." });
    let rules = {}; try { rules = JSON.parse(empRow.rules || "{}"); } catch(_) {}
    const waNumber = rules.whatsappNumber || rules.whatsapp_number || "";
    if (!waNumber) return res.json({ posted: false, connected: false, note: "No WhatsApp number configured. Add it in Settings first." });

    const waToken = (typeof getSetting === "function" && getSetting("WHATSAPP_BUSINESS_TOKEN")) || process.env.WHATSAPP_BUSINESS_TOKEN;
    const phoneId = (typeof getSetting === "function" && getSetting("WHATSAPP_PHONE_NUMBER_ID")) || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!waToken || !phoneId) return res.json({ posted: false, connected: false, note: "WhatsApp Business credentials not configured. Add WHATSAPP_BUSINESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in Settings." });

    // Send via Meta WhatsApp API
    const fetch = (await import("node-fetch")).default;
    const to = waNumber.replace(/[^\d]/g, ""); // digits only
    const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + waToken, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: message } })
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.json({ posted: false, connected: true, error: result.error?.message || ("HTTP " + r.status), note: result.error?.message || "WhatsApp send failed" });
    }

    // Log it
    try {
      db.prepare("INSERT OR IGNORE INTO ai_employee_actions (id,user_id,role,action,details,status,confidence,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
        .run(require("uuid").v4(), req.userId, "coo", "send_test", JSON.stringify({ to: waNumber, message }), "completed", 1.0);
    } catch(_) {}

    res.json({ posted: true, connected: true, note: "Sent to " + waNumber, messageId: result.messages?.[0]?.id });
  } catch (e) {
    console.error("[coo/send-test]", e.message);
    res.status(500).json({ posted: false, error: e.message });
  }
});

// Setup: set your Meta WhatsApp webhook to POST /api/ai-employees/coo/whatsapp
// ══════════════════════════════════════════════════════════════════════════════

// Verify webhook (Meta requires GET verification)
router.get('/coo/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = getSetting('WHATSAPP_VERIFY_TOKEN') || process.env.WHATSAPP_VERIFY_TOKEN || 'mine_whatsapp_verify';
  if (mode === 'subscribe' && token === verifyToken) {
    return res.send(challenge);
  }
  res.sendStatus(403);
});

// Receive WhatsApp messages → COO AI processes and responds
router.post('/coo/whatsapp', async (req, res) => {
  res.sendStatus(200); // Respond immediately to avoid timeout

  try {
    const body   = req.body;
    const entry  = body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg    = change?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const from    = msg.from; // The user's WhatsApp number
    const text    = msg.text?.body || '';
    const waToken = getSetting('WHATSAPP_BUSINESS_TOKEN') || process.env.WHATSAPP_BUSINESS_TOKEN;
    const phoneId = getSetting('WHATSAPP_PHONE_NUMBER_ID') || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!waToken || !phoneId) return;

    // Find user by WhatsApp number
    const db = getDb();
    const empRows = db.prepare(`
      SELECT ae.user_id FROM ai_employees ae
      WHERE ae.role = 'coo' AND ae.enabled = 1
      AND (json_extract(ae.rules, '$.whatsappNumber') LIKE ?
           OR json_extract(ae.rules, '$.whatsapp_number') LIKE ?)
    `).all('%' + from.slice(-9) + '%', '%' + from.slice(-9) + '%');
    if (!empRows.length) return;
    const userId = empRows[0].user_id;

    // Load full business context
    const sites    = db.prepare("SELECT name, data FROM sites WHERE user_id=? LIMIT 1").get(userId);
    const revenueToday = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM orders WHERE user_id=? AND date(created_at)=date('now')").get(userId)?.total || 0;
    const pendingActions = db.prepare("SELECT count(*) as n FROM ai_employee_actions WHERE user_id=? AND status='pending'").get(userId)?.n || 0;
    const bizName  = sites?.name || 'the business';

    const Anthropic = require('@anthropic-ai/sdk');
    const claude    = new Anthropic({ apiKey: getSetting('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY });

    // COO system prompt
    const systemPrompt = `You are Take Control, the AI COO for ${bizName}. You receive WhatsApp commands from the business owner and take action. You lead a team of AI specialists you can delegate to or speak on behalf of: ${teamRosterText()}. When a task fits a teammate, refer to them by name (e.g. "I'll get Bailey on the books").

Current status:
- Revenue today: $${revenueToday}
- Pending approvals: ${pendingActions} actions waiting

You can:
- Report revenue, orders, bookings (query the data)
- Approve or reject pending actions ("approve all", "reject X")  
- Schedule email blasts ("send email to all customers about...")
- Get performance summaries ("how are my ads performing?")
- Answer business questions

Reply in under 160 characters when possible. Be direct and action-oriented.`;

    const pr = await claude.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }]
    });
    let reply = pr.content[0]?.text?.trim() || 'On it.';

    // Handle specific commands
    let actionTaken = false;
    const lowerText = text.toLowerCase();

    if (lowerText.includes('approve all')) {
      const pendingList = db.prepare("SELECT id FROM ai_employee_actions WHERE user_id=? AND status='pending' LIMIT 10").all(userId);
      for (const a of pendingList) {
        db.prepare("UPDATE ai_employee_actions SET status='approved', approved_at=datetime('now') WHERE id=?").run(a.id);
        try { await executeAction(db, db.prepare("SELECT * FROM ai_employee_actions WHERE id=?").get(a.id), userId); } catch(_) {}
      }
      actionTaken = true;
    }

    // Single-tap approval: a bare YES/NO reply approves/rejects the most recent
    // pending action (preferring the one we pinged the owner about).
    if (!actionTaken && /^(yes|y|approve|ok|okay|do it|go|send it)\b/i.test(text.trim())) {
      const a = db.prepare("SELECT * FROM ai_employee_actions WHERE user_id=? AND status='pending' ORDER BY CASE WHEN json_extract(details,'$.wa_pinged')=1 THEN 0 ELSE 1 END, created_at DESC LIMIT 1").get(userId);
      if (a) {
        db.prepare("UPDATE ai_employee_actions SET status='approved', approved_at=datetime('now') WHERE id=?").run(a.id);
        try { await executeAction(db, db.prepare("SELECT * FROM ai_employee_actions WHERE id=?").get(a.id), userId); } catch(_) {}
        reply = "Approved and done.";
        actionTaken = true;
      }
    }
    if (!actionTaken && /^(no|n|reject|skip|cancel|dont|don't|stop)\b/i.test(text.trim())) {
      const a = db.prepare("SELECT * FROM ai_employee_actions WHERE user_id=? AND status='pending' ORDER BY CASE WHEN json_extract(details,'$.wa_pinged')=1 THEN 0 ELSE 1 END, created_at DESC LIMIT 1").get(userId);
      if (a) {
        db.prepare("UPDATE ai_employee_actions SET status='rejected' WHERE id=?").run(a.id);
        reply = "Skipped that one.";
        actionTaken = true;
      }
    }

    // Send WhatsApp reply
    const fetch2 = (await import('node-fetch')).default;
    await fetch2(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + waToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: reply }
      })
    });

    // Log the interaction
    db.prepare("INSERT OR IGNORE INTO ai_employee_actions (id,user_id,role,action,details,status,confidence,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
      .run(require('uuid').v4(), userId, 'coo', 'whatsapp_command', JSON.stringify({ from, text, reply, actionTaken }), 'completed', 1.0);

  } catch(e) {
    console.error('[COO WhatsApp]', e.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FIX 5: HeyGen webhook — replaces polling for high-volume users
// Register at: https://app.heygen.com/settings?nav=API → Webhooks
// URL: https://yourdomain.com/api/ai-employees/heygen/webhook
// ══════════════════════════════════════════════════════════════════════════════

router.post('/heygen/webhook', async (req, res) => {
  // ── HeyGen webhook signature verification ──
  // Prevents attackers from injecting fake video completion events.
  // HeyGen signs with HMAC-SHA256 using your webhook secret.
  const heygenSecret = process.env.HEYGEN_WEBHOOK_SECRET || (function(){
    try { return require("../db/init").getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get("HEYGEN_WEBHOOK_SECRET")?.value; } catch(_) { return null; }
  })();
  if (heygenSecret) {
    try {
      const cryptoMod = require("crypto");
      const signature = req.headers["x-webhook-signature"] || req.headers["x-heygen-signature"] || "";
      const rawBody   = req.rawBody || JSON.stringify(req.body);
      const expected  = cryptoMod.createHmac("sha256", heygenSecret).update(rawBody).digest("hex");
      const sigBuf    = Buffer.from(signature);
      const expBuf    = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !cryptoMod.timingSafeEqual(sigBuf, expBuf)) {
        return res.status(403).json({ error: "Invalid webhook signature" });
      }
    } catch(e) {
      return res.status(403).json({ error: "Webhook verification failed" });
    }
  }
  res.sendStatus(200); // Acknowledge immediately

  try {
    const { event_type, data } = req.body;
    if (event_type !== 'avatar_video.success' && event_type !== 'video.completed') return;

    const videoId  = data?.video_id || data?.id;
    const videoUrl = data?.video_url || data?.url;
    const thumbUrl = data?.thumbnail_url || '';
    if (!videoId || !videoUrl) return;

    const db = getDb();

    // Update the job
    db.prepare("UPDATE heygen_jobs SET status='completed', video_url=?, thumbnail_url=? WHERE video_id=?")
      .run(videoUrl, thumbUrl, videoId);

    // Mirror to short_form_videos
    const job = db.prepare("SELECT user_id, script, type FROM heygen_jobs WHERE video_id=?").get(videoId);
    if (!job) return;

    db.exec("CREATE TABLE IF NOT EXISTS short_form_videos (id TEXT PRIMARY KEY, user_id TEXT, product_id TEXT, script TEXT, video_url TEXT, status TEXT, provider TEXT, task_id TEXT, platforms TEXT, created_at TEXT)");
    const { v4: uuid } = require('uuid');
    db.prepare("INSERT OR IGNORE INTO short_form_videos (id,user_id,script,video_url,status,provider,task_id,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
      .run(uuid(), job.user_id, job.script || '', videoUrl, 'completed', 'heygen', videoId);

    // Check if there's a pending auto-post action linked to this video
    const autoPost = db.prepare(
      "SELECT * FROM ai_employee_actions WHERE user_id=? AND action='schedule_post' AND status='pending' AND json_extract(details,'$.video_id')=?"
    ).get(job.user_id, videoId);
    if (autoPost) {
      try {
        db.prepare("UPDATE ai_employee_actions SET status='auto_executed' WHERE id=?").run(autoPost.id);
        await executeAction(db, autoPost, job.user_id);
        db.prepare("UPDATE ai_employee_actions SET status='completed', completed_at=datetime('now') WHERE id=?").run(autoPost.id);
      } catch(e) {
        console.error('[HeyGen webhook auto-post]', e.message);
      }
    }

    console.log(`[HeyGen webhook] Video ${videoId} completed for user ${job.user_id}`);
  } catch(e) {
    console.error('[HeyGen webhook]', e.message);
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// AGENT NOTIFICATIONS — notify user when agents take actions
// ══════════════════════════════════════════════════════════════════════════════

// Call this after any significant agent action to notify the user
async function notifyAgentAction(db, userId, role, action, summary) {
  try {
    // 1. Store in notifications table
    db.exec(`CREATE TABLE IF NOT EXISTS agent_notifications (
      id TEXT PRIMARY KEY, user_id TEXT, role TEXT, action TEXT,
      summary TEXT, read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const { v4: uuid } = require('uuid');
    db.prepare("INSERT INTO agent_notifications (id,user_id,role,action,summary) VALUES (?,?,?,?,?)")
      .run(uuid(), userId, role, action, summary);

    // 2. Send email if configured
    const user = db.prepare("SELECT email, name FROM users WHERE id=?").get(userId);
    const sgKey = getSetting('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
    if (sgKey && user?.email) {
      const fetch2 = (await import('node-fetch')).default;
      const roleNames = {
        social:'AI Social Manager', marketing:'AI Marketing Manager',
        support:'AI Support Agent', bookkeeper:'AI Bookkeeper',
        legal:'AI Legal Employee', csm:'AI Customer Success',
        receptionist:'AI Receptionist', coo:'Take Control',
        growth:'TAKEOVA Growth Agent', community:'Community Engagement',
        prospector:'Prospector Agent', sales:'AI Sales Rep',
        proposal:'AI Proposal Agent', coldemail:'AI Cold Email Agent',
      };
      const _sgResp = await fetch2('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: user.email, name: user.name || '' }] }],
          from: { email: getSetting('EMAIL_FROM') || getSetting('FROM_EMAIL') || process.env.EMAIL_FROM || process.env.FROM_EMAIL || 'noreply@mine.ai', name: 'TAKEOVA AI' },
          subject: `${roleNames[role] || role} just took action`,
          content: [{ type: 'text/plain', value:
            `Hi ${user.name || 'there'},\n\n${roleNames[role] || role} just acted:\n\n${summary}\n\nLog in to view details and manage your AI team.\n\n— TAKEOVA AI` }],
        })
      });
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }
    }
  } catch(e) { console.warn('[notifyAgentAction]', e.message); }
}

// ── Get notifications for user ─────────────────────────────────────────────
router.get('/notifications', auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS agent_notifications (id TEXT PRIMARY KEY, user_id TEXT, role TEXT, action TEXT, summary TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    const notifs = db.prepare("SELECT * FROM agent_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(req.userId);
    const unread = db.prepare("SELECT COUNT(*) as n FROM agent_notifications WHERE user_id=? AND read=0").get(req.userId).n;
    res.json({ success: true, notifications: notifs, unread });
  } catch(e) { res.json({ success: true, notifications: [], unread: 0 }); }
});

// ── Mark notifications read ────────────────────────────────────────────────
router.post('/notifications/read', auth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE agent_notifications SET read=1 WHERE user_id=?").run(req.userId);
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

// ── Full action history ─────────────────────────────────────────────────────
router.get('/history', auth, (req, res) => {
  const db = getDb();
  const { role, status, limit = 50, offset = 0 } = req.query;
  try {
    let sql = "SELECT * FROM ai_employee_actions WHERE user_id=?";
    const params = [req.userId];
    if (role)   { sql += " AND role=?";   params.push(role); }
    if (status) { sql += " AND status=?"; params.push(status); }
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(Number(limit), Number(offset));
    const actions = db.prepare(sql).all(...params);
    const total   = db.prepare("SELECT COUNT(*) as n FROM ai_employee_actions WHERE user_id=?").get(req.userId).n;
    res.json({ success: true, actions, total, limit: Number(limit), offset: Number(offset) });
  } catch(e) { res.json({ success: true, actions: [], total: 0 }); }
});

// ── Video spend dashboard ───────────────────────────────────────────────────
router.get('/video-spend', auth, (req, res) => {
  const db = getDb();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS heygen_jobs (id TEXT PRIMARY KEY, user_id TEXT, video_id TEXT, type TEXT, title TEXT, script TEXT, status TEXT DEFAULT 'pending', video_url TEXT, thumbnail_url TEXT, cost REAL, charged REAL, product_id TEXT, created_at TEXT DEFAULT (datetime('now')))");
    const thisMonth = db.prepare(`
      SELECT
        COUNT(*) as total_videos,
        COALESCE(SUM(cost),0) as total_cost,
        COALESCE(SUM(charged),0) as total_charged,
        COALESCE(SUM(charged) - SUM(cost),0) as margin,
        type
      FROM heygen_jobs
      WHERE user_id=? AND datetime(created_at) > datetime('now','-30 days')
      GROUP BY type
    `).all(req.userId);

    const totals = db.prepare(`
      SELECT COUNT(*) as videos, COALESCE(SUM(cost),0) as cost, COALESCE(SUM(charged),0) as charged
      FROM heygen_jobs WHERE user_id=? AND datetime(created_at) > datetime('now','-30 days')
    `).get(req.userId);

    const recent = db.prepare(`
      SELECT title, type, cost, charged, status, video_url, created_at
      FROM heygen_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 10
    `).all(req.userId);

    res.json({ success: true, thisMonth, totals, recent });
  } catch(e) { res.json({ success: true, thisMonth: [], totals: {}, recent: [] }); }
});


// ══════════════════════════════════════════════════════════════════════════════
// SOCIAL CONNECTIONS — OAuth for Facebook/Instagram, TikTok, X, LinkedIn, YouTube
// ══════════════════════════════════════════════════════════════════════════════

function ensureSocialTokensTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_social_tokens (
    id TEXT PRIMARY KEY, user_id TEXT, platform TEXT,
    access_token TEXT, refresh_token TEXT, expires_at INTEGER,
    platform_user_id TEXT, platform_username TEXT, platform_name TEXT,
    follower_count INTEGER DEFAULT 0, scope TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, platform)
  )`);
}

// GET /api/ai-employees/social/status — returns all connected platforms
router.get('/social/status', auth, (req, res) => {
  const db = getDb();
  ensureSocialTokensTable(db);
  const tokens = db.prepare("SELECT platform, platform_username, platform_name, follower_count, expires_at, updated_at FROM user_social_tokens WHERE user_id=?").all(req.userId);
  res.json({ success: true, platforms: tokens });
});

// POST /api/ai-employees/social/disconnect
router.post('/social/disconnect', auth, (req, res) => {
  const db = getDb();
  const { platform } = req.body;
  if (!platform) return res.status(400).json({ error: 'platform required' });
  ensureSocialTokensTable(db);
  db.prepare("DELETE FROM user_social_tokens WHERE user_id=? AND platform=?").run(req.userId, platform);
  res.json({ success: true });
});

// ── Facebook / Instagram OAuth ─────────────────────────────────────────────
// Requires: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
router.get('/social/facebook/connect', auth, (req, res) => {
  const appId = process.env.FACEBOOK_APP_ID || getSetting('FACEBOOK_APP_ID');
  if (!appId) return res.status(500).json({ error: 'FACEBOOK_APP_ID not configured' });
  const crypto = require('crypto');
  const db     = getDb();
  ensureSocialTokensTable(db);
  const state  = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO oauth_states (state, user_id, provider, created_at) VALUES (?,?,?,datetime('now'))").run(state, req.userId, 'facebook');
  const params = new URLSearchParams({
    client_id:     appId,
    redirect_uri:  `${process.env.BACKEND_URL || 'http://localhost:4000'}/api/ai-employees/social/facebook/callback`,
    scope:         'pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,public_profile,pages_show_list',
    state,
  });
  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

router.get('/social/facebook/callback', async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
  const BACKEND_URL  = process.env.BACKEND_URL  || 'http://localhost:4000';
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}`);
  const db = getDb();
  const stateRec = db.prepare("SELECT user_id FROM oauth_states WHERE state=? AND provider='facebook'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state`);
  db.prepare("DELETE FROM oauth_states WHERE state=?").run(state);
  try {
    const fetch2 = (await import('node-fetch')).default;
    const appId     = process.env.FACEBOOK_APP_ID || getSetting('FACEBOOK_APP_ID');
    const appSecret = process.env.FACEBOOK_APP_SECRET || getSetting('FACEBOOK_APP_SECRET');
    // Exchange code for token
    const tokenR = await fetch2(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(BACKEND_URL+'/api/ai-employees/social/facebook/callback')}&client_secret=${appSecret}&code=${code}`);
    const tokens = await tokenR.json();
    if (!tokens.access_token) throw new Error(tokens.error?.message || 'Token exchange failed');
    // Get long-lived token
    const llR = await fetch2(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokens.access_token}`);
    const ll  = await llR.json();
    const longToken = ll.access_token || tokens.access_token;
    // Get user/page info
    const meR = await fetch2(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${longToken}`);
    const me  = await meR.json();
    ensureSocialTokensTable(db);
    const { v4: uuid } = require('uuid');
    db.prepare(`INSERT OR REPLACE INTO user_social_tokens (id,user_id,platform,access_token,expires_at,platform_user_id,platform_name,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`)
      .run(uuid(), stateRec.user_id, 'meta', longToken, Date.now() + 60*86400000, me.id, me.name);
    // Also save as instagram (same token)
    db.prepare(`INSERT OR REPLACE INTO user_social_tokens (id,user_id,platform,access_token,expires_at,platform_user_id,platform_name,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`)
      .run(require('uuid').v4(), stateRec.user_id, 'instagram', longToken, Date.now() + 60*86400000, me.id, me.name+' (IG)');
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=facebook&name=${encodeURIComponent(me.name)}`);
  } catch(e) {
    res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}`);
  }
});

// ── TikTok OAuth ──────────────────────────────────────────────────────────
router.get('/social/tiktok/connect', auth, (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY || getSetting('TIKTOK_CLIENT_KEY');
  if (!clientKey) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY not configured' });
  const crypto = require('crypto');
  const db     = getDb();
  const state  = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO oauth_states (state, user_id, provider, created_at) VALUES (?,?,?,datetime('now'))").run(state, req.userId, 'tiktok');
  const params = new URLSearchParams({
    client_key:    clientKey,
    response_type: 'code',
    scope:         'user.info.basic,video.publish,video.upload',
    redirect_uri:  `${process.env.BACKEND_URL || 'http://localhost:4000'}/api/ai-employees/social/tiktok/callback`,
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize?${params}`);
});

router.get('/social/tiktok/callback', async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}`);
  const db = getDb();
  const stateRec = db.prepare("SELECT user_id FROM oauth_states WHERE state=? AND provider='tiktok'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state`);
  db.prepare("DELETE FROM oauth_states WHERE state=?").run(state);
  try {
    const fetch2 = (await import('node-fetch')).default;
    const clientKey    = process.env.TIKTOK_CLIENT_KEY    || getSetting('TIKTOK_CLIENT_KEY');
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET || getSetting('TIKTOK_CLIENT_SECRET');
    const r = await fetch2('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: `${process.env.BACKEND_URL || 'http://localhost:4000'}/api/ai-employees/social/tiktok/callback` }).toString()
    });
    const tokens = await r.json();
    if (!tokens.access_token) throw new Error(tokens.message || 'TikTok token exchange failed');
    ensureSocialTokensTable(db);
    const { v4: uuid } = require('uuid');
    db.prepare(`INSERT OR REPLACE INTO user_social_tokens (id,user_id,platform,access_token,refresh_token,expires_at,platform_user_id,platform_username,updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(uuid(), stateRec.user_id, 'tiktok', tokens.access_token, tokens.refresh_token||null, Date.now()+(tokens.expires_in||86400)*1000, tokens.open_id||'', tokens.open_id||'');
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=tiktok`);
  } catch(e) { res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}`); }
});

// ── LinkedIn OAuth ─────────────────────────────────────────────────────────
router.get('/social/linkedin/connect', auth, (req, res) => {
  const clientId = process.env.LINKEDIN_CLIENT_ID || getSetting('LINKEDIN_CLIENT_ID');
  if (!clientId) return res.status(500).json({ error: 'LINKEDIN_CLIENT_ID not configured' });
  const crypto = require('crypto');
  const db     = getDb();
  const state  = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO oauth_states (state, user_id, provider, created_at) VALUES (?,?,?,datetime('now'))").run(state, req.userId, 'linkedin');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  `${process.env.BACKEND_URL || 'http://localhost:4000'}/api/ai-employees/social/linkedin/callback`,
    state,
    scope:         'openid profile email w_member_social',
  });
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

router.get('/social/linkedin/callback', async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(error)}`);
  const db = getDb();
  const stateRec = db.prepare("SELECT user_id FROM oauth_states WHERE state=? AND provider='linkedin'").get(state);
  if (!stateRec) return res.redirect(`${FRONTEND_URL}/dashboard?social_error=invalid_state`);
  db.prepare("DELETE FROM oauth_states WHERE state=?").run(state);
  try {
    const fetch2     = (await import('node-fetch')).default;
    const clientId     = process.env.LINKEDIN_CLIENT_ID     || getSetting('LINKEDIN_CLIENT_ID');
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET || getSetting('LINKEDIN_CLIENT_SECRET');
    const tokenR = await fetch2('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type:'authorization_code', code, client_id:clientId, client_secret:clientSecret, redirect_uri:`${process.env.BACKEND_URL||'http://localhost:4000'}/api/ai-employees/social/linkedin/callback` }).toString()
    });
    const tokens = await tokenR.json();
    if (!tokens.access_token) throw new Error('LinkedIn token exchange failed');
    const meR = await fetch2('https://api.linkedin.com/v2/userinfo', { headers:{ Authorization:`Bearer ${tokens.access_token}` } });
    const me  = await meR.json();
    ensureSocialTokensTable(db);
    db.prepare(`INSERT OR REPLACE INTO user_social_tokens (id,user_id,platform,access_token,expires_at,platform_user_id,platform_name,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`)
      .run(require('uuid').v4(), stateRec.user_id, 'linkedin', tokens.access_token, Date.now()+(tokens.expires_in||5184000)*1000, me.sub||'', me.name||'LinkedIn User');
    res.redirect(`${FRONTEND_URL}/dashboard?social_connected=linkedin&name=${encodeURIComponent(me.name||'LinkedIn')}`);
  } catch(e) { res.redirect(`${FRONTEND_URL}/dashboard?social_error=${encodeURIComponent(e.message)}`); }
});


// ─────────────────────────────────────────────────────────────────────────────
// Proactive WhatsApp approval push
// When a high-stakes action is queued for approval, ping the owner on WhatsApp so
// they can approve/reject from their phone. The /coo/whatsapp inbound handler
// turns a "YES"/"NO" reply into an approve/reject + execute.
// ─────────────────────────────────────────────────────────────────────────────
async function sendOwnerWhatsApp(db, userId, message) {
  try {
    const coo = db.prepare("SELECT rules FROM ai_employees WHERE user_id=? AND role='coo' AND enabled=1").get(userId);
    if (!coo) return false;
    let rules = {}; try { rules = JSON.parse(coo.rules || "{}"); } catch (_) {}
    const waNumber = rules.whatsappNumber || rules.whatsapp_number || "";
    if (!waNumber) return false;
    const waToken = (typeof getSetting === "function" && getSetting("WHATSAPP_BUSINESS_TOKEN")) || process.env.WHATSAPP_BUSINESS_TOKEN;
    const phoneId = (typeof getSetting === "function" && getSetting("WHATSAPP_PHONE_NUMBER_ID")) || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!waToken || !phoneId) return false;
    const fetch = (await import("node-fetch")).default;
    const to = String(waNumber).replace(/[^\d]/g, "");
    const r = await fetch("https://graph.facebook.com/v19.0/" + phoneId + "/messages", {
      method: "POST",
      headers: { "Authorization": "Bearer " + waToken, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: to, type: "text", text: { body: message } })
    });
    return r.ok;
  } catch (_) { return false; }
}

// Action types worth interrupting the owner for (money movement / outbound comms).
const HIGH_STAKES_ACTIONS = new Set([
  "send_email", "send_followup_email", "send_proposal", "send_email_blast", "send_cold_email",
  "write_email", "dm_prospect", "send_lead_magnet", "process_refund", "adjust_ad_budget",
  "pause_underperforming", "create_campaign", "send_winback_email", "send_upsell", "send_outreach",
  "draft_contract", "send_contract_reminder"
]);

async function notifyApprovalNeeded(db, actionId) {
  try {
    const a = db.prepare("SELECT * FROM ai_employee_actions WHERE id=?").get(actionId);
    if (!a || a.status !== "pending") return;
    let det = {}; try { det = JSON.parse(a.details || "{}"); } catch (_) {}
    if (det.wa_pinged) return; // already notified about this one
    const highStakes = HIGH_STAKES_ACTIONS.has(a.action) || det.high_stakes === true ||
                       (a.confidence != null && a.confidence < 0.7);
    if (!highStakes) return; // don't interrupt for routine/low-stakes actions
    const emp = db.prepare("SELECT custom_name FROM ai_employees WHERE user_id=? AND role=?").get(a.user_id, a.role);
    const who = (emp && emp.custom_name) || ("Your " + String(a.role).replace(/_/g, " ") + " agent");
    const what = det.summary || det.reasoning || String(a.action || "").replace(/_/g, " ");
    const msg = "Approval needed\n" + who + " wants to: " + what + "\n\nReply YES to approve, NO to skip \u2014 or open your TAKEOVA dashboard.";
    try { db.prepare("UPDATE ai_employee_actions SET details = json_set(COALESCE(details,'{}'),'$.wa_pinged',1) WHERE id=?").run(actionId); } catch (_) {}
    await sendOwnerWhatsApp(db, a.user_id, msg);
  } catch (_) {}
}
