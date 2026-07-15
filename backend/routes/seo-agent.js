/**
 * routes/seo-agent.js
 * SEO Agent — $59/mo standalone add-on subscription.
 *
 * Endpoints:
 *   GET  /status                — am I subscribed? last run? config snapshot
 *   POST /subscribe             — start $59/mo subscription
 *   POST /unsubscribe           — cancel at period end
 *   GET  /config                — agent configuration
 *   POST /config                — update autonomy / frequency
 *   GET  /keywords              — list tracked keywords with ranks
 *   POST /keywords              — add keyword
 *   DELETE /keywords/:id        — remove keyword
 *   POST /run                   — manual trigger (rate-limited)
 *   GET  /suggestions           — pending + history
 *   POST /suggestions/:id/approve  — apply now
 *   POST /suggestions/:id/reject   — dismiss
 *   POST /suggestions/:id/revert   — undo a previously-applied suggestion
 *   GET  /competitors/:keywordId   — competitor leaderboard for a keyword
 *   GET  /overage-summary       — across-all-employees overage status
 */

const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const { getDb } = require("../db/init");
const { runAgentForUser, getOverageSummary } = require("../lib/seo-agent-loop");
const crypto = require("crypto");
// Per-tenant agent outcome tracking (safe-loaded; no-op if enhancements unmounted)
let _enh; try { _enh = require("./ai-employees-enhancements"); } catch (_) { _enh = null; }
const recordOutcome = (_enh && _enh.recordOutcome) ? _enh.recordOutcome : function(){};

const PRICE_PER_MONTH = 59;
const PRICE_ID = process.env.STRIPE_SEO_AGENT_PRICE_ID || ""; // optional: pin to a specific Stripe Price; otherwise created from PRICE_PER_MONTH

// Ensure a recurring monthly Stripe Price exists for this add-on. Uses the env
// Price ID when set; otherwise finds/creates one from PRICE_PER_MONTH so billing
// works without any env var. Cached in-process.
let _seoPriceId = null;
async function ensureSeoPrice(stripe) {
  if (PRICE_ID) return PRICE_ID;
  if (_seoPriceId) return _seoPriceId;
  const cents = PRICE_PER_MONTH * 100;
  const products = await stripe.products.list({ limit: 100 });
  let product = products.data.find(p => p.metadata && p.metadata.mine_addon === "seo_agent");
  if (!product) product = await stripe.products.create({ name: "AI SEO Agent", metadata: { mine_addon: "seo_agent" } });
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find(p => p.unit_amount === cents && p.recurring && p.recurring.interval === "month");
  if (!price) price = await stripe.prices.create({ product: product.id, unit_amount: cents, currency: "usd", recurring: { interval: "month" } });
  _seoPriceId = price.id;
  return _seoPriceId;
}

function uuid() { return crypto.randomUUID(); }

// Tiny per-user manual-trigger rate limit (1 every 60s)
const _manualThrottle = new Map();
function _throttle(userId) {
  const now = Date.now();
  const last = _manualThrottle.get(userId) || 0;
  if (now - last < 60000) return false;
  _manualThrottle.set(userId, now);
  return true;
}

// ─── Subscription ───────────────────────────────────────────────────────
router.get("/status", auth, async (req, res) => {
  try {
    const db = getDb();
    const sub = db.prepare("SELECT * FROM seo_agent_subscriptions WHERE user_id = ?").get(req.userId);
    const config = db.prepare("SELECT * FROM seo_agent_config WHERE user_id = ?").get(req.userId);
    const counts = {
      keywords: (db.prepare("SELECT COUNT(*) c FROM seo_keywords WHERE user_id = ?").get(req.userId) || {}).c || 0,
      pendingSuggestions: (db.prepare("SELECT COUNT(*) c FROM seo_suggestions WHERE user_id = ? AND status = 'pending'").get(req.userId) || {}).c || 0,
      appliedSuggestions: (db.prepare("SELECT COUNT(*) c FROM seo_suggestions WHERE user_id = ? AND status = 'applied'").get(req.userId) || {}).c || 0
    };
    res.json({
      subscribed: !!sub && sub.status === "active",
      subscription: sub || null,
      config: config || { autonomy_level: "manual", frequency_days: 2 },
      counts,
      pricePerMonth: PRICE_PER_MONTH
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/subscribe", auth, async (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM seo_agent_subscriptions WHERE user_id = ? AND status = 'active'").get(req.userId);
    if (existing) return res.json({ success: true, alreadySubscribed: true });

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      // No Stripe configured at all (test / self-hosted mode) — activate without charge
      const id = uuid();
      db.prepare(`INSERT INTO seo_agent_subscriptions (id, user_id, status, started_at, monthly_price, stripe_subscription_id)
                  VALUES (?, ?, 'active', datetime('now'), ?, NULL)`)
        .run(id, req.userId, PRICE_PER_MONTH);
      return res.json({ success: true, mode: "self-hosted", subscriptionId: id });
    }

    const stripe = require("stripe")(stripeKey);

    // Ensure Stripe customer exists
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name || user.email });
      customerId = customer.id;
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, req.userId);
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: await ensureSeoPrice(stripe) }],
      metadata: { user_id: req.userId, addon: "seo-agent" }
    });

    const id = uuid();
    db.prepare(`INSERT INTO seo_agent_subscriptions
      (id, user_id, status, started_at, monthly_price, stripe_subscription_id, stripe_customer_id)
      VALUES (?, ?, ?, datetime('now'), ?, ?, ?)`)
      .run(id, req.userId, subscription.status === "active" || subscription.status === "trialing" ? "active" : "pending",
           PRICE_PER_MONTH, subscription.id, customerId);

    res.json({ success: true, subscriptionId: id, stripeStatus: subscription.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/unsubscribe", auth, async (req, res) => {
  try {
    const db = getDb();
    const sub = db.prepare("SELECT * FROM seo_agent_subscriptions WHERE user_id = ? AND status = 'active'").get(req.userId);
    if (!sub) return res.status(404).json({ error: "No active subscription" });

    if (sub.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
    }
    db.prepare("UPDATE seo_agent_subscriptions SET status='cancelling', cancelled_at = datetime('now') WHERE id = ?").run(sub.id);
    res.json({ success: true, message: "Subscription will end at the period end" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function requireSub(req, res) {
  const db = getDb();
  const sub = db.prepare("SELECT * FROM seo_agent_subscriptions WHERE user_id = ? AND status IN ('active','cancelling')").get(req.userId);
  if (!sub) {
    res.status(402).json({ error: "SEO Agent subscription required ($" + PRICE_PER_MONTH + "/mo)", subscribeRequired: true });
    return null;
  }
  return sub;
}

// ─── Config ─────────────────────────────────────────────────────────────
router.get("/config", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const config = db.prepare("SELECT * FROM seo_agent_config WHERE user_id = ?").get(req.userId)
              || { autonomy_level: "manual", frequency_days: 2, notify_email: 1, notify_overage: 1 };
  res.json({ config });
});

router.post("/config", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const { autonomy_level, frequency_days, notify_email, notify_overage } = req.body || {};
  const allowedAutonomy = ["manual", "auto_safe", "full_auto", "auto_aggressive"];
  if (autonomy_level && allowedAutonomy.indexOf(autonomy_level) === -1) {
    return res.status(400).json({ error: "Invalid autonomy_level" });
  }
  const freq = Math.max(1, Math.min(7, parseInt(frequency_days) || 2));

  const existing = db.prepare("SELECT id FROM seo_agent_config WHERE user_id = ?").get(req.userId);
  if (existing) {
    db.prepare(`UPDATE seo_agent_config SET
      autonomy_level = COALESCE(?, autonomy_level),
      frequency_days = ?,
      notify_email = ?,
      notify_overage = ?,
      updated_at = datetime('now')
      WHERE user_id = ?`).run(autonomy_level || null, freq, notify_email ? 1 : 0, notify_overage ? 1 : 0, req.userId);
  } else {
    db.prepare(`INSERT INTO seo_agent_config (id, user_id, autonomy_level, frequency_days, notify_email, notify_overage, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(uuid(), req.userId, autonomy_level || "manual", freq, notify_email ? 1 : 0, notify_overage ? 1 : 0);
  }
  res.json({ success: true });
});

// ─── Keywords ───────────────────────────────────────────────────────────
router.get("/keywords", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const rows = db.prepare(`
    SELECT k.*, s.name AS site_name, s.domain AS site_domain
    FROM seo_keywords k
    LEFT JOIN sites s ON s.id = k.site_id
    WHERE k.user_id = ?
    ORDER BY k.created_at DESC`).all(req.userId);
  res.json({ keywords: rows });
});

router.post("/keywords", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const { keyword, site_id, location } = req.body || {};
  if (!keyword || !site_id) return res.status(400).json({ error: "keyword and site_id required" });

  // Cap: 50 keywords per user
  const count = (db.prepare("SELECT COUNT(*) c FROM seo_keywords WHERE user_id = ?").get(req.userId) || {}).c || 0;
  if (count >= 50) return res.status(400).json({ error: "Keyword limit reached (50 max per subscription)" });

  const id = uuid();
  db.prepare(`INSERT INTO seo_keywords (id, user_id, site_id, keyword, location, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`)
    .run(id, req.userId, site_id, String(keyword).trim().toLowerCase(), location || "United States");
  res.json({ success: true, id });
});

router.delete("/keywords/:id", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const k = db.prepare("SELECT * FROM seo_keywords WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!k) return res.status(404).json({ error: "Keyword not found" });
  db.prepare("DELETE FROM seo_keywords WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ─── Manual run ─────────────────────────────────────────────────────────
router.post("/run", auth, async (req, res) => {
  if (!requireSub(req, res)) return;
  if (!_throttle(req.userId)) {
    return res.status(429).json({ error: "Manual runs limited to once per minute" });
  }
  try {
    // Run async so the response returns quickly
    res.json({ success: true, started: true, message: "Agent run started. Check Suggestions panel in 30-60 seconds." });
    runAgentForUser(getDb(), req.userId, { dryRun: false }).then(result => {
      console.log("[seo-agent] manual run complete for " + req.userId + ":", JSON.stringify(result));
    }).catch(e => {
      console.error("[seo-agent] manual run failed for " + req.userId + ":", e.message);
    });
  } catch (e) {
    // Already responded
  }
});

// ─── Suggestions ────────────────────────────────────────────────────────
router.get("/suggestions", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const status = req.query.status || "pending";
  const validStatus = ["pending", "applied", "rejected", "reverted", "all"];
  if (validStatus.indexOf(status) === -1) return res.status(400).json({ error: "Invalid status" });

  let sql = `SELECT s.*, k.keyword, si.name AS site_name FROM seo_suggestions s
             LEFT JOIN seo_keywords k ON k.id = s.keyword_id
             LEFT JOIN sites si ON si.id = s.site_id
             WHERE s.user_id = ?`;
  const params = [req.userId];
  if (status !== "all") { sql += " AND s.status = ?"; params.push(status); }
  sql += " ORDER BY s.created_at DESC LIMIT 100";

  const rows = db.prepare(sql).all.apply(db.prepare(sql), params);
  res.json({ suggestions: rows });
});

router.post("/suggestions/:id/approve", auth, async (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const sug = db.prepare("SELECT * FROM seo_suggestions WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!sug) return res.status(404).json({ error: "Suggestion not found" });
  if (sug.status !== "pending") return res.status(400).json({ error: "Already " + sug.status });

  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(sug.site_id);
  if (!site) return res.status(404).json({ error: "Target site not found" });

  // Record history snapshot
  db.prepare(`INSERT INTO seo_changes_history (id, suggestion_id, site_id, field, old_value, new_value, applied_at)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(uuid(), sug.id, site.id, sug.type, sug.current_value || "", sug.suggested_value || "");

  // Parse seo_json (canonical source of truth for the renderer)
  let seo;
  try { seo = JSON.parse(site.seo_json || "{}"); } catch (_) { seo = {}; }

  // Apply — write to BOTH legacy column AND seo_json blob
  let applied = false;
  if (sug.type === "meta_title") {
    seo.title = sug.suggested_value;
    db.prepare("UPDATE sites SET seo_title = ?, seo_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sug.suggested_value, JSON.stringify(seo), site.id);
    applied = true;
  } else if (sug.type === "meta_description") {
    seo.description = sug.suggested_value;
    db.prepare("UPDATE sites SET seo_description = ?, seo_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sug.suggested_value, JSON.stringify(seo), site.id);
    applied = true;
  } else if (sug.type === "schema") {
    seo.schema = sug.suggested_value;
    db.prepare("UPDATE sites SET seo_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(seo), site.id);
    applied = true;
  } else if (["h1","h2","h3","content_topic","internal_link"].indexOf(sug.type) !== -1) {
    // Phase 3: surgical HTML patch via jsdom — safer than regex
    try {
      const { patchHtml } = require("../lib/html-patcher");
      const result = patchHtml(site.html || "", {
        type: sug.type,
        current: sug.current_value || "",
        suggested: sug.suggested_value || "",
        anchorUrl: sug.suggested_value
      });
      if (result.ok) {
        db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?").run(result.html, site.id);
        applied = true;
      } else {
        db.prepare("UPDATE seo_suggestions SET status='failed', applied_at=datetime('now'), reasoning = COALESCE(reasoning,'') || ' [HTML patch failed: ' || ? || ']' WHERE id = ?")
          .run(result.reason || "unknown", sug.id);
        try { recordOutcome(uuid(), req.userId, 'seo_agent', sug.type || 'apply_suggestion', 'failed', { suggestion_id: sug.id, reason: result.reason || 'unknown' }); } catch(_){}
        return res.status(400).json({ error: "Could not apply: " + result.reason, type: sug.type });
      }
    } catch (e) {
      return res.status(500).json({ error: "Patcher error: " + e.message });
    }
  } else {
    applied = false;
  }

  // Auto re-publish so the live site reflects the change immediately
  let publishResult = null;
  if (applied) {
    try {
      const { republishSite } = require("../lib/site-publisher");
      const updatedSite = db.prepare("SELECT * FROM sites WHERE id = ?").get(site.id);
      publishResult = await republishSite(db, updatedSite || site);
    } catch (e) {
      console.warn("[seo-agent /approve] republish failed:", e.message);
    }
    db.prepare("UPDATE seo_suggestions SET status='applied', applied_at=datetime('now') WHERE id = ?").run(sug.id);
    try { recordOutcome(uuid(), req.userId, 'seo_agent', sug.type || 'apply_suggestion', 'success', { suggestion_id: sug.id, site_id: site.id }); } catch(_){}
  } else {
    db.prepare("UPDATE seo_suggestions SET status='approved', applied_at=datetime('now') WHERE id = ?").run(sug.id);
  }
  res.json({ success: true, applied, type: sug.type, publish: publishResult });
});

router.post("/suggestions/:id/reject", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const sug = db.prepare("SELECT * FROM seo_suggestions WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!sug) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE seo_suggestions SET status='rejected' WHERE id = ?").run(sug.id);
  res.json({ success: true });
});

router.post("/suggestions/:id/revert", auth, async (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const sug = db.prepare("SELECT * FROM seo_suggestions WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!sug) return res.status(404).json({ error: "Not found" });
  if (sug.status !== "applied") return res.status(400).json({ error: "Only applied suggestions can be reverted" });

  // Use history to restore old value
  const hist = db.prepare("SELECT * FROM seo_changes_history WHERE suggestion_id = ? ORDER BY applied_at DESC LIMIT 1").get(sug.id);
  if (!hist) return res.status(404).json({ error: "No history record — can't revert safely" });

  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(sug.site_id);
  if (!site) return res.status(404).json({ error: "Site not found" });

  let seo;
  try { seo = JSON.parse(site.seo_json || "{}"); } catch (_) { seo = {}; }

  if (hist.field === "meta_title") {
    seo.title = hist.old_value;
    db.prepare("UPDATE sites SET seo_title = ?, seo_json = ?, updated_at = datetime('now') WHERE id = ?").run(hist.old_value, JSON.stringify(seo), site.id);
  } else if (hist.field === "meta_description") {
    seo.description = hist.old_value;
    db.prepare("UPDATE sites SET seo_description = ?, seo_json = ?, updated_at = datetime('now') WHERE id = ?").run(hist.old_value, JSON.stringify(seo), site.id);
  } else if (hist.field === "schema") {
    seo.schema = hist.old_value;
    db.prepare("UPDATE sites SET seo_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(seo), site.id);
  } else if (hist.field === "h1") {
    const html = site.html || "";
    const safe = String(hist.old_value || "").replace(/<[^>]+>/g, "").trim();
    const re_h1 = new RegExp("<h1([^>]*data-seo-suggestion-id=\"" + sug.id + "\"[^>]*)>[\\s\\S]*?<\/h1>", "i");
    if (re_h1.test(html)) {
      const newHtml = html.replace(re_h1, "<h1$1>" + safe + "</h1>");
      db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?").run(newHtml, site.id);
    }
  } else if (hist.field === "content_topic") {
    const html = site.html || "";
    const startMarker = "<!-- seo-suggestion:" + sug.id + ":start -->";
    const endMarker = "<!-- seo-suggestion:" + sug.id + ":end -->";
    const s = html.indexOf(startMarker);
    const e = html.indexOf(endMarker);
    if (s !== -1 && e !== -1 && e > s) {
      const newHtml = html.slice(0, s) + html.slice(e + endMarker.length);
      db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?").run(newHtml, site.id);
    }
  
  } else {
    return res.status(400).json({ error: "Auto-revert not supported for type: " + hist.field });
  }

  // Re-publish so the revert reflects live
  let publishResult = null;
  try {
    const { republishSite } = require("../lib/site-publisher");
    const updatedSite = db.prepare("SELECT * FROM sites WHERE id = ?").get(site.id);
    publishResult = await republishSite(db, updatedSite || site);
  } catch (e) {
    console.warn("[seo-agent /revert] republish failed:", e.message);
  }
  db.prepare("UPDATE seo_suggestions SET status='reverted' WHERE id = ?").run(sug.id);
  res.json({ success: true, publish: publishResult });
});

// ─── Competitor leaderboard ─────────────────────────────────────────────
router.get("/competitors/:keywordId", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  const db = getDb();
  const kw = db.prepare("SELECT * FROM seo_keywords WHERE id = ? AND user_id = ?").get(req.params.keywordId, req.userId);
  if (!kw) return res.status(404).json({ error: "Keyword not found" });

  // Latest snapshot per competitor URL
  const rows = db.prepare(`
    SELECT * FROM seo_competitor_snapshots
    WHERE keyword_id = ?
    AND scraped_at = (SELECT MAX(scraped_at) FROM seo_competitor_snapshots WHERE keyword_id = ?)
    ORDER BY rank ASC`).all(req.params.keywordId, req.params.keywordId);

  res.json({ keyword: kw, competitors: rows });
});

// ─── Overage summary (across ALL AI employees) ──────────────────────────
router.get("/overage-summary", auth, async (req, res) => {
  if (!requireSub(req, res)) return;
  try {
    const summary = await getOverageSummary(getDb(), req.userId);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Stripe webhook handler (called from server.js webhook router) ──────
function handleStripeWebhook(event, db) {
  try {
    if (event.type === "customer.subscription.deleted") {
      const subId = event.data.object.id;
      db.prepare("UPDATE seo_agent_subscriptions SET status='cancelled', cancelled_at=datetime('now') WHERE stripe_subscription_id = ?").run(subId);
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const status = (sub.status === "active" || sub.status === "trialing") ? "active"
                    : (sub.cancel_at_period_end ? "cancelling" : sub.status);
      db.prepare("UPDATE seo_agent_subscriptions SET status = ? WHERE stripe_subscription_id = ?").run(status, sub.id);
    } else if (event.type === "invoice.payment_failed") {
      const subId = event.data.object.subscription;
      if (subId) db.prepare("UPDATE seo_agent_subscriptions SET status='past_due' WHERE stripe_subscription_id = ?").run(subId);
    }
  } catch (e) {
    console.error("[seo-agent webhook]", e.message);
  }
}

router.handleStripeWebhook = handleStripeWebhook;


// ─── Preview: dry-run a suggestion before applying ─────────────────────
router.get("/suggestions/:id/preview", auth, (req, res) => {
  if (!requireSub(req, res)) return;
  try {
    const db = getDb();
    const sug = db.prepare("SELECT * FROM seo_suggestions WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!sug) return res.status(404).json({ error: "Not found" });
    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(sug.site_id);
    if (!site) return res.status(404).json({ error: "Site not found" });

    // For HTML changes, simulate the patch and return the diff
    if (["h1","h2","h3","content_topic","internal_link"].indexOf(sug.type) !== -1) {
      const { patchHtml } = require("../lib/html-patcher");
      const result = patchHtml(site.html || "", {
        type: sug.type,
        current: sug.current_value || "",
        suggested: sug.suggested_value || "",
        anchorUrl: sug.suggested_value
      });
      return res.json({
        type: sug.type,
        previewable: result.ok,
        reason: result.reason || null,
        diff: result.diff || null,
        currentValue: sug.current_value,
        suggestedValue: sug.suggested_value
      });
    }
    // For meta/schema, just show before/after
    return res.json({
      type: sug.type,
      previewable: true,
      currentValue: sug.current_value || site.seo_title || site.seo_description || "",
      suggestedValue: sug.suggested_value
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
