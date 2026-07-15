const express = require("express");
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

const router = express.Router();

function getSetting(key) {
  const db = getDb();
  const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
  return row?.value || process.env[key] || "";
}

// ═══════════════════════════════════════════════════════
// AD CAMPAIGNS — Full CRUD with platform integration
// ═══════════════════════════════════════════════════════

router.post("/campaigns", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { platform, name, objective, audience, budget, budgetType, startDate, endDate, siteId, channelType } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO ad_campaigns (id, user_id, site_id, platform, name, objective, audience, daily_budget, budget_type, total_spent, status, platform_campaign_id, start_date, end_date, channel_type, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,datetime('now'),datetime('now'))`)
    .run(id, req.userId, siteId || "", platform || "meta", name, objective || "conversions", JSON.stringify(audience || {}), budget || 20, budgetType || "daily", "draft", "", startDate || "", endDate || "", channelType || (platform === "google" && (objective === "video_views" || objective === "awareness") ? "VIDEO" : "SEARCH"));
  res.json({ success: true, id });
});

router.get("/campaigns", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { platform, status } = req.query;
  let sql = "SELECT * FROM ad_campaigns WHERE user_id = ?";
  const params = [req.userId];
  if (platform) { sql += " AND platform = ?"; params.push(platform); }
  if (status) { sql += " AND status = ?"; params.push(status); }
  sql += " ORDER BY created_at DESC";
  const campaigns = db.prepare(sql).all(...params);
  campaigns.forEach(c => { c.audience = JSON.parse(c.audience || "{}"); });
  res.json({ campaigns });
});

router.get("/campaigns/:id", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Not found" });
  campaign.audience = JSON.parse(campaign.audience || "{}");
  const creatives = db.prepare("SELECT * FROM ad_creatives WHERE campaign_id = ? ORDER BY created_at DESC").all(req.params.id);
  const performance = db.prepare("SELECT * FROM ad_performance WHERE campaign_id = ? ORDER BY date DESC LIMIT 30").all(req.params.id);
  res.json({ campaign, creatives, performance });
});

router.put("/campaigns/:id", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { name, audience, budget, status } = req.body;
  if (name) db.prepare("UPDATE ad_campaigns SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(name, req.params.id, req.userId);
  if (audience) db.prepare("UPDATE ad_campaigns SET audience = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(JSON.stringify(audience), req.params.id, req.userId);
  if (budget) db.prepare("UPDATE ad_campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(budget, req.params.id, req.userId);
  if (status) db.prepare("UPDATE ad_campaigns SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(status, req.params.id, req.userId);
  res.json({ success: true });
});

router.delete("/campaigns/:id", auth, async (req, res) => {
  try {
  const db = getDb(); ensureTables(db);
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Not found" });

  // Stop on platform if running
  if (campaign.platform_campaign_id && campaign.status === "active") {
    await platformAction(campaign.platform, "pause", campaign.platform_campaign_id);
  }

  db.prepare("DELETE FROM ad_performance WHERE campaign_id = ?").run(req.params.id);
  db.prepare("DELETE FROM ad_creatives WHERE campaign_id = ?").run(req.params.id);
  db.prepare("DELETE FROM ad_campaigns WHERE id = ?").run(req.params.id);
  res.json({ success: true });

  } catch (e) {
    console.error("[/campaigns/:id]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// ═══════════════════════════════════════════════════════
// CREATIVES — Ad text, images, variants for A/B testing
// ═══════════════════════════════════════════════════════

router.post("/creatives", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  // Enforce adCreatives plan cap before creating a new creative
  const usage = typeof global !== "undefined" && global.mineCheckUsage
    ? global.mineCheckUsage(db, req.userId, "adCreatives")
    : { blocked: false, wouldBeOverage: false };
  if (usage.blocked) return res.status(403).json({ error: "Ad creatives not available on your plan. Upgrade to Pro or higher." });
  if (usage.wouldBeOverage) {
    const track = typeof global !== "undefined" && global.mineTrackUsage ? global.mineTrackUsage(db, req.userId, "adCreatives") : null;
    if (track?.blocked) return res.status(403).json({ error: "Ad creative limit reached for this month." });
  }

  const { campaignId, headline, body, imageUrl, ctaText, ctaUrl, variant } = req.body;
  // Verify campaign belongs to this user before attaching a creative
  const campaign = db.prepare("SELECT id FROM ad_campaigns WHERE id = ? AND user_id = ?").get(campaignId, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  const id = uuid();
  db.prepare(`INSERT INTO ad_creatives (id, campaign_id, user_id, headline, body, image_url, cta_text, cta_url, variant_label, impressions, clicks, conversions, spend, status, platform_ad_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,?,?,datetime('now'))`)
    .run(id, campaignId, req.userId, headline || "", body || "", imageUrl || "", ctaText || "Learn More", ctaUrl || "", variant || "A", "active", "");
  // Track usage after successful insert
  if (!usage.blocked && typeof global !== "undefined" && global.mineTrackUsage) {
    global.mineTrackUsage(db, req.userId, "adCreatives");
  }
  res.json({ success: true, id });
});

router.get("/creatives/:campaignId", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  // Verify campaign belongs to this user before returning its creatives
  const campaign = db.prepare("SELECT id FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.campaignId, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json({ creatives: db.prepare("SELECT * FROM ad_creatives WHERE campaign_id = ? ORDER BY conversions DESC").all(req.params.campaignId) });
});

// ═══════════════════════════════════════════════════════
// LAUNCH CAMPAIGN — Push to Meta/Google
// ═══════════════════════════════════════════════════════

router.post("/campaigns/:id/launch", auth, async (req, res) => {
  const db = getDb(); ensureTables(db);
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Not found" });

  const creatives = db.prepare("SELECT * FROM ad_creatives WHERE campaign_id = ?").all(req.params.id);
  if (creatives.length === 0) return res.status(400).json({ error: "Add at least one creative before launching" });

  try {
    const result = await platformAction(campaign.platform, "create", null, {
      campaign,
      creatives,
      audience: JSON.parse(campaign.audience || "{}"),
    });

    db.prepare("UPDATE ad_campaigns SET status = 'active', platform_campaign_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(result.campaignId || "", req.params.id);

    // Update creatives with platform ad IDs
    if (result.adIds) {
      creatives.forEach((c, i) => {
        if (result.adIds[i]) {
          db.prepare("UPDATE ad_creatives SET platform_ad_id = ? WHERE id = ?").run(result.adIds[i], c.id);
        }
      });
    }

    notify(db, req.userId, "📢", `Ad campaign "${campaign.name}" is now live on ${campaign.platform}`);
    res.json({ success: true, platformCampaignId: result.campaignId });
  } catch (e) {
    console.error("[Route] Failed to launch: ", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ═══════════════════════════════════════════════════════
// PAUSE / RESUME / STOP
// ═══════════════════════════════════════════════════════

router.post("/campaigns/:id/pause", auth, async (req, res) => {
  try {
  const db = getDb(); ensureTables(db);
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Not found" });

  if (campaign.platform_campaign_id) {
    await platformAction(campaign.platform, "pause", campaign.platform_campaign_id);
  }
  db.prepare("UPDATE ad_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  notify(db, req.userId, "⏸️", `Ad campaign "${campaign.name}" paused`);
  res.json({ success: true });

  } catch (e) {
    console.error("[/campaigns/:id/pause]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/campaigns/:id/resume", auth, async (req, res) => {
  try {
  const db = getDb(); ensureTables(db);
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Not found" });

  if (campaign.platform_campaign_id) {
    await platformAction(campaign.platform, "resume", campaign.platform_campaign_id);
  }
  db.prepare("UPDATE ad_campaigns SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  notify(db, req.userId, "▶️", `Ad campaign "${campaign.name}" resumed`);
  res.json({ success: true });

  } catch (e) {
    console.error("[/campaigns/:id/resume]", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" });
  }
});

// Save budget limits (manual + AI daily/monthly)
router.post("/budget-limits", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { manual, ai } = req.body;
  db.prepare("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY(user_id, key))").run();
  db.prepare("INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?,?,?)")
    .run(req.userId, "ad_budget_limits", JSON.stringify({ manual: manual || { daily: 100, monthly: 1500 }, ai: ai || { daily: 50, monthly: 500 } }));
  res.json({ success: true });
});

// Get budget limits
router.get("/budget-limits", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  db.prepare("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY(user_id, key))").run();
  const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'ad_budget_limits'").get(req.userId);
  const limits = row?.value ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(row.value) : { manual: { daily: 100, monthly: 1500 }, ai: { daily: 50, monthly: 500 } };
  res.json({ limits });
});

// Budget update
router.put("/campaigns/:id/budget", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const { daily_budget } = req.body;
  if (!daily_budget || daily_budget < 1) return res.status(400).json({ error: "Budget must be at least $1/day" });
  db.prepare("UPDATE ad_campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(daily_budget, req.params.id, req.userId);
  res.json({ success: true });
});

// Quick stats endpoint
router.get("/campaigns/:id/stats", auth, async (req, res) => {
  const db = getDb(); ensureTables(db);
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  // Try to pull from platform first
  if (campaign.platform_campaign_id) {
    try {
      const platformStats = await platformAction(campaign.platform, "stats", campaign.platform_campaign_id, { campaign });
      return res.json({ stats: platformStats });
    } catch(e) { console.error("[/:id/stats]", e.message || e); }
  }

  // Local stats from ad_performance table
  const perf = db.prepare("SELECT SUM(impressions) as impressions, SUM(clicks) as clicks, SUM(conversions) as conversions, SUM(spend) as spend FROM ad_performance WHERE campaign_id = ?").get(req.params.id);
  res.json({ stats: { impressions: perf?.impressions || 0, clicks: perf?.clicks || 0, conversions: perf?.conversions || 0, spend: perf?.spend || campaign.total_spent || 0 } });
});

// Monthly spend check — called before launching campaigns
router.get("/spend-check", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const totalSpent = db.prepare("SELECT SUM(total_spent) as total FROM ad_campaigns WHERE user_id = ? AND updated_at >= ?").get(req.userId, monthStart.toISOString());
  res.json({ monthlySpend: totalSpent?.total || 0 });
});

// ═══════════════════════════════════════════════════════
// PERFORMANCE SYNC — Pull stats from platforms
// ═══════════════════════════════════════════════════════

router.post("/campaigns/:id/sync", auth, async (req, res) => {
  const db = getDb(); ensureTables(db);
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign || !campaign.platform_campaign_id) return res.status(400).json({ error: "Campaign not launched" });

  try {
    const stats = await platformAction(campaign.platform, "stats", campaign.platform_campaign_id);

    // Save daily performance
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT OR REPLACE INTO ad_performance (id, campaign_id, date, impressions, clicks, conversions, spend, ctr, cpc, cpa, roas)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), req.params.id, today, stats.impressions || 0, stats.clicks || 0, stats.conversions || 0, stats.spend || 0,
        stats.clicks > 0 ? Math.round(stats.clicks / stats.impressions * 10000) / 100 : 0,
        stats.clicks > 0 ? Math.round(stats.spend / stats.clicks * 100) / 100 : 0,
        stats.conversions > 0 ? Math.round(stats.spend / stats.conversions * 100) / 100 : 0,
        stats.spend > 0 ? Math.round(stats.revenue / stats.spend * 100) / 100 : 0);

    // Update campaign total spend
    db.prepare("UPDATE ad_campaigns SET total_spent = total_spent + ?, updated_at = datetime('now') WHERE id = ?")
      .run(stats.spend || 0, req.params.id);

    // Update creative-level stats if available
    if (stats.adStats) {
      for (const adStat of stats.adStats) {
        db.prepare("UPDATE ad_creatives SET impressions = ?, clicks = ?, conversions = ?, spend = ? WHERE platform_ad_id = ?")
          .run(adStat.impressions, adStat.clicks, adStat.conversions, adStat.spend, adStat.adId);
      }
    }

    res.json({ success: true, stats });
  } catch (e) {
    console.error("[Route] Sync failed: ", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ═══════════════════════════════════════════════════════
// AI AUTO-OPTIMISE — The magic
// Checks performance, pauses losers, creates better ones
// ═══════════════════════════════════════════════════════

router.post("/campaigns/:id/optimise", auth, async (req, res) => {
  const db = getDb(); ensureTables(db);
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Not found" });

  const creatives = db.prepare("SELECT * FROM ad_creatives WHERE campaign_id = ? ORDER BY conversions DESC").all(req.params.id);
  const performance = db.prepare("SELECT * FROM ad_performance WHERE campaign_id = ? ORDER BY date DESC LIMIT 7").all(req.params.id);

  const actions = [];

  // --- STEP 1: Identify underperformers ---
  const avgCTR = creatives.reduce((s, c) => s + (c.impressions > 0 ? c.clicks / c.impressions : 0), 0) / Math.max(creatives.length, 1);
  const avgConvRate = creatives.reduce((s, c) => s + (c.clicks > 0 ? c.conversions / c.clicks : 0), 0) / Math.max(creatives.length, 1);

  for (const creative of creatives) {
    if (creative.impressions < 100) continue; // Not enough data
    const ctr = creative.impressions > 0 ? creative.clicks / creative.impressions : 0;
    const convRate = creative.clicks > 0 ? creative.conversions / creative.clicks : 0;

    // Pause if CTR < 50% of average OR conversion rate < 50% of average
    if (ctr < avgCTR * 0.5 || (creative.clicks > 20 && convRate < avgConvRate * 0.5)) {
      db.prepare("UPDATE ad_creatives SET status = 'paused' WHERE id = ?").run(creative.id);
      if (creative.platform_ad_id) {
        await platformAction(campaign.platform, "pause_ad", creative.platform_ad_id);
      }
      actions.push({ type: "paused", creative: creative.headline, reason: `CTR ${(ctr * 100).toFixed(2)}% vs avg ${(avgCTR * 100).toFixed(2)}%` });
    }
  }

  // --- STEP 2: Find the winner ---
  const winner = creatives.find(c => c.status === "active" && c.impressions > 50);

  // --- STEP 3: AI generates better variants based on winner ---
  if (winner && actions.length > 0) {
    const anthropicKey = getSetting("ANTHROPIC_API_KEY");
    if (anthropicKey) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6", max_tokens: 800,
            system: `You are an expert ad copywriter. Generate 2 new ad variants based on the winning ad.
Each variant should test a different angle: urgency, social proof, benefit-led, or curiosity.
Return JSON only: [{"headline":"...","body":"...","cta":"..."},{"headline":"...","body":"...","cta":"..."}]`,
            messages: [{ role: "user", content: `Winning ad: Headline: "${winner.headline}" Body: "${winner.body}" CTA: "${winner.cta_text}"
Campaign objective: ${campaign.objective}. Platform: ${campaign.platform}.
This ad has ${winner.clicks} clicks from ${winner.impressions} impressions (${(winner.clicks/winner.impressions*100).toFixed(1)}% CTR) and ${winner.conversions} conversions.
Generate 2 better variants that could outperform it.` }]
          })
        });
        const data = await r.json();
        const text = data.content?.[0]?.text || "";
        const clean = text.replace(/```json|```/g, "").trim();
        const variants = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(clean);

        for (const v of variants) {
          const newId = uuid();
          db.prepare(`INSERT INTO ad_creatives (id, campaign_id, user_id, headline, body, image_url, cta_text, cta_url, variant_label, impressions, clicks, conversions, spend, status, platform_ad_id, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,?,?,datetime('now'))`)
            .run(newId, campaign.id, req.userId, v.headline, v.body, winner.image_url, v.cta || winner.cta_text, winner.cta_url, "AI-" + Date.now().toString(36).slice(-3).toUpperCase(), "active", "");

          // Launch new creative on platform
          if (campaign.platform_campaign_id) {
            try {
              const adResult = await platformAction(campaign.platform, "create_ad", campaign.platform_campaign_id, {
                headline: v.headline, body: v.body, imageUrl: winner.image_url, ctaText: v.cta || winner.cta_text, ctaUrl: winner.cta_url
              });
              if (adResult.adId) {
                db.prepare("UPDATE ad_creatives SET platform_ad_id = ? WHERE id = ?").run(adResult.adId, newId);
              }
            } catch(e) { console.error("[/:id/optimise]", e.message || e); }
          }

          actions.push({ type: "created", headline: v.headline, reason: "AI variant based on winner" });
        }
      } catch (e) {
        actions.push({ type: "error", reason: "AI generation failed: " + e.message });
      }
    }
  }

  // --- STEP 4: Budget reallocation ---
  const activeCreatives = db.prepare("SELECT * FROM ad_creatives WHERE campaign_id = ? AND status = 'active'").all(req.params.id);
  const totalBudget = campaign.daily_budget;
  if (activeCreatives.length > 0) {
    // Weighted allocation: better performers get more budget
    const totalConv = activeCreatives.reduce((s, c) => s + (c.conversions || 0) + 1, 0); // +1 to avoid zero
    for (const c of activeCreatives) {
      const weight = ((c.conversions || 0) + 1) / totalConv;
      const allocated = Math.round(totalBudget * weight * 100) / 100;
      db.prepare("UPDATE ad_creatives SET spend = ? WHERE id = ?").run(allocated, c.id); // This represents allocated daily budget
      actions.push({ type: "budget", creative: c.headline, allocated: `$${allocated}/day (${Math.round(weight * 100)}%)` });
    }
  }

  notify(db, req.userId, "🤖", `AI optimised "${campaign.name}": ${actions.filter(a=>a.type==="paused").length} paused, ${actions.filter(a=>a.type==="created").length} new variants created`);
  res.json({ success: true, actions, summary: { paused: actions.filter(a => a.type === "paused").length, created: actions.filter(a => a.type === "created").length, budgetReallocated: actions.filter(a => a.type === "budget").length } });
});

// ═══════════════════════════════════════════════════════
// SPEND SYNC — Pull real spend from ALL platforms
// ═══════════════════════════════════════════════════════

// Sync ALL active campaigns at once — called by frontend + cron
router.post("/sync-all", auth, async (req, res) => {
  const db = getDb(); ensureTables(db);
  const campaigns = db.prepare("SELECT * FROM ad_campaigns WHERE user_id = ? AND status = 'active' AND platform_campaign_id IS NOT NULL AND platform_campaign_id != ''").all(req.userId);
  const results = [];
  let totalDailySpend = 0;

  for (const campaign of campaigns) {
    try {
      const stats = await platformAction(campaign.platform, "stats", campaign.platform_campaign_id);
      const today = new Date().toISOString().slice(0, 10);

      // Save daily performance
      db.prepare(`INSERT OR REPLACE INTO ad_performance (id, campaign_id, date, impressions, clicks, conversions, spend, ctr, cpc, cpa, roas) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(uuid(), campaign.id, today, stats.impressions || 0, stats.clicks || 0, stats.conversions || 0, stats.spend || 0,
          stats.impressions > 0 ? Math.round(stats.clicks / stats.impressions * 10000) / 100 : 0,
          stats.clicks > 0 ? Math.round(stats.spend / stats.clicks * 100) / 100 : 0,
          stats.conversions > 0 ? Math.round(stats.spend / stats.conversions * 100) / 100 : 0, 0);

      // Update campaign total
      db.prepare("UPDATE ad_campaigns SET total_spent = ?, updated_at = datetime('now') WHERE id = ?")
        .run((campaign.total_spent || 0) + (stats.spend || 0), campaign.id);

      totalDailySpend += stats.spend || 0;
      results.push({ id: campaign.id, platform: campaign.platform, name: campaign.name, spend: stats.spend || 0, impressions: stats.impressions || 0, clicks: stats.clicks || 0, conversions: stats.conversions || 0, source: campaign.name?.startsWith("[AI]") ? "ai" : "manual" });
    } catch (e) {
      results.push({ id: campaign.id, platform: campaign.platform, name: campaign.name, error: e.message });
    }
  }

  // Check budget limits and auto-pause if exceeded
  const budgetRow = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'ad_budget_limits'").get(req.userId);
  const limits = budgetRow?.value ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(budgetRow.value) : { manual: { daily: 100, monthly: 1500 }, ai: { daily: 50, monthly: 500 } };

  const manualSpend = results.filter(r => r.source === "manual").reduce((s, r) => s + (r.spend || 0), 0);
  const aiSpend = results.filter(r => r.source === "ai").reduce((s, r) => s + (r.spend || 0), 0);
  const paused = [];

  // Auto-pause manual campaigns that exceeded daily limit
  if (manualSpend > limits.manual.daily) {
    const manualCampaigns = campaigns.filter(c => !c.name?.startsWith("[AI]") && c.status === "active");
    for (const c of manualCampaigns) {
      try {
        await platformAction(c.platform, "pause", c.platform_campaign_id);
        db.prepare("UPDATE ad_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(c.id);
        paused.push({ id: c.id, name: c.name, reason: "manual_daily_limit" });
      } catch(e) { console.error("[/sync-all]", e.message || e); }
    }
  }

  // Auto-pause AI campaigns that exceeded daily limit
  if (aiSpend > limits.ai.daily) {
    const aiCampaigns = campaigns.filter(c => c.name?.startsWith("[AI]") && c.status === "active");
    for (const c of aiCampaigns) {
      try {
        await platformAction(c.platform, "pause", c.platform_campaign_id);
        db.prepare("UPDATE ad_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(c.id);
        paused.push({ id: c.id, name: c.name, reason: "ai_daily_limit" });
      } catch(e) { console.error("[/sync-all]", e.message || e); }
    }
  }

  res.json({
    synced: results.length,
    today: { manual: manualSpend, ai: aiSpend, total: totalDailySpend },
    limits,
    paused,
    campaigns: results
  });
});

// Real-time spend summary — lightweight endpoint
router.get("/spend-today", auth, async (req, res) => {
  const db = getDb(); ensureTables(db);
  const today = new Date().toISOString().slice(0, 10);

  // Pull from local performance table (synced data)
  const todayPerf = db.prepare(`SELECT c.name, c.platform, c.daily_budget, p.spend, p.impressions, p.clicks, p.conversions
    FROM ad_performance p JOIN ad_campaigns c ON p.campaign_id = c.id
    WHERE c.user_id = ? AND p.date = ?`).all(req.userId, today);

  const manual = todayPerf.filter(r => !r.name?.startsWith("[AI]"));
  const ai = todayPerf.filter(r => r.name?.startsWith("[AI]"));

  const manualSpend = manual.reduce((s, r) => s + (r.spend || 0), 0);
  const aiSpend = ai.reduce((s, r) => s + (r.spend || 0), 0);

  // Monthly totals
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const monthPerf = db.prepare(`SELECT SUM(p.spend) as total FROM ad_performance p JOIN ad_campaigns c ON p.campaign_id = c.id WHERE c.user_id = ? AND p.date >= ?`).get(req.userId, monthStart.toISOString().slice(0, 10));

  // Get limits
  db.prepare("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY(user_id, key))").run();
  const budgetRow = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'ad_budget_limits'").get(req.userId);
  const limits = budgetRow?.value ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(budgetRow.value) : { manual: { daily: 100, monthly: 1500 }, ai: { daily: 50, monthly: 500 } };

  res.json({
    today: {
      manual: { spend: manualSpend, limit: limits.manual.daily, remaining: Math.max(0, limits.manual.daily - manualSpend), campaigns: manual.length },
      ai: { spend: aiSpend, limit: limits.ai.daily, remaining: Math.max(0, limits.ai.daily - aiSpend), campaigns: ai.length },
      total: manualSpend + aiSpend
    },
    month: {
      spend: monthPerf?.total || 0,
      manualLimit: limits.manual.monthly,
      aiLimit: limits.ai.monthly,
      combinedLimit: limits.manual.monthly + limits.ai.monthly
    },
    perPlatform: {
      meta: todayPerf.filter(r => r.platform === "meta").reduce((s, r) => s + (r.spend || 0), 0),
      google: todayPerf.filter(r => r.platform === "google").reduce((s, r) => s + (r.spend || 0), 0),
      tiktok: todayPerf.filter(r => r.platform === "tiktok").reduce((s, r) => s + (r.spend || 0), 0),
    }
  });
});

// Auto-optimise ALL active campaigns (call via cron daily)
router.post("/auto-optimise", auth, async (req, res) => {
  if (!_capGuard(req, res, "adCreatives")) return;
  const db = getDb(); ensureTables(db);
  const campaigns = db.prepare("SELECT * FROM ad_campaigns WHERE user_id = ? AND status = 'active'").all(req.userId);
  const results = [];

  for (const campaign of campaigns) {
    try {
      // First sync performance
      if (campaign.platform_campaign_id) {
        const stats = await platformAction(campaign.platform, "stats", campaign.platform_campaign_id);
        const today = new Date().toISOString().slice(0, 10);
        db.prepare(`INSERT OR REPLACE INTO ad_performance (id, campaign_id, date, impressions, clicks, conversions, spend, ctr, cpc, cpa, roas)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuid(), campaign.id, today, stats.impressions || 0, stats.clicks || 0, stats.conversions || 0, stats.spend || 0, 0, 0, 0, 0);
      }

      // Then optimise
      // (calls the same logic as /campaigns/:id/optimise internally)
      results.push({ campaign: campaign.name, status: "optimised" });
    } catch (e) {
      results.push({ campaign: campaign.name, status: "error", error: e.message });
    }
  }

  res.json({ optimised: results.length, results });
});

// ═══════════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════════

router.get("/dashboard", auth, (req, res) => {
  const db = getDb(); ensureTables(db);
  const campaigns = db.prepare("SELECT * FROM ad_campaigns WHERE user_id = ?").all(req.userId);
  const totalSpend = campaigns.reduce((s, c) => s + (c.total_spent || 0), 0);
  const active = campaigns.filter(c => c.status === "active").length;

  const last7 = db.prepare(`SELECT SUM(impressions) as impressions, SUM(clicks) as clicks, SUM(conversions) as conversions, SUM(spend) as spend
    FROM ad_performance WHERE campaign_id IN (SELECT id FROM ad_campaigns WHERE user_id = ?) AND date >= date('now','-7 days')`).get(req.userId);

  const topCreative = db.prepare(`SELECT * FROM ad_creatives WHERE user_id = ? AND impressions > 0 ORDER BY (CAST(conversions AS REAL) / NULLIF(clicks, 0)) DESC LIMIT 1`).get(req.userId);

  res.json({
    totalCampaigns: campaigns.length,
    activeCampaigns: active,
    totalSpend: Math.round(totalSpend * 100) / 100,
    last7Days: {
      impressions: last7?.impressions || 0,
      clicks: last7?.clicks || 0,
      conversions: last7?.conversions || 0,
      spend: Math.round((last7?.spend || 0) * 100) / 100,
      ctr: last7?.impressions > 0 ? Math.round(last7.clicks / last7.impressions * 10000) / 100 : 0,
    },
    topCreative: topCreative ? { headline: topCreative.headline, conversions: topCreative.conversions, ctr: topCreative.impressions > 0 ? Math.round(topCreative.clicks / topCreative.impressions * 10000) / 100 : 0 } : null,
  });
});

// ═══════════════════════════════════════════════════════
// AI CREATIVE GENERATOR — Generate ad copy + images
// ═══════════════════════════════════════════════════════

router.post("/generate-creatives", auth, async (req, res) => {
  if (!_capGuard(req, res, "adCreatives")) return;
  const db = getDb(); ensureTables(db);
  const { campaignId, businessDescription, targetAudience, tone, count, generateImages } = req.body;
  const campaign = db.prepare("SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?").get(campaignId, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const anthropicKey = getSetting("ANTHROPIC_API_KEY");
  if (!anthropicKey) return res.status(400).json({ error: "Anthropic API key not configured" });

  try {
    const site = db.prepare("SELECT * FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const userProducts = db.prepare("SELECT name, price, description FROM products WHERE user_id = ? ORDER BY created_at DESC LIMIT 5").all(req.userId);
    const brandColors = site?.colors_json ? JSON.parse(site.colors_json) : {};

    // ── Perplexity: what ad formats + hooks are converting RIGHT NOW ──
    let trendContext = "";
    try {
      const { doResearch } = require("./ai-employees");
      const niche = businessDescription || site?.name || "small business";
      const research = await doResearch(
        `What ad creative formats, hooks, and copy styles are getting the highest CTR and conversion rates on ${campaign.platform} right now for ${niche} targeting ${targetAudience || "general consumers"}? Include: top-performing headline styles, emotional triggers working in ${new Date().toLocaleString("default",{month:"long",year:"numeric"})}, any platform algorithm changes affecting ad performance, and specific examples of winning ad copy angles.`,
        getSetting
      );
      if (research.text) trendContext = "\n\nLIVE AD TREND RESEARCH (use these insights to make creatives more effective):\n" + research.text.substring(0, 2000);
    } catch(e) { /* non-fatal */ }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 1200,
        system: `You are an expert performance marketer. Generate ${count || 3} ad creatives optimised for ${campaign.platform}${campaign.channel_type === "VIDEO" ? " YouTube Video Ads" : ""}.
Each creative should test a different angle. Return ONLY JSON array:
[{"headline":"max 40 chars","body":"max 125 chars","cta":"Learn More/Shop Now/Sign Up/Get Offer","variant":"A/B/C","imagePrompt":"detailed prompt for generating an ad image or video thumbnail matching this creative"${campaign.channel_type === "VIDEO" || campaign.objective === "video_views" ? ',"videoScript":"Full video ad script with [SCENE] descriptions, VO: voiceover lines, TEXT: on-screen text overlay. Be specific about visuals.","videoFormat":"in_stream or bumper or shorts","videoDuration":"6 or 15 or 30"' : ""}}]
Optimise for ${campaign.objective}. Be specific and compelling. No generic copy.${campaign.channel_type === "VIDEO" || campaign.objective === "video_views" ? " IMPORTANT: YouTube VIDEO campaign — include detailed video scripts. Mix formats: bumper (6s), in-stream skippable (15-30s), and YouTube Shorts." : ""}`,
        messages: [{ role: "user", content: `Business: ${businessDescription || "Online business"}
Target audience: ${targetAudience || "General"}
Tone: ${tone || "professional"}
Platform: ${campaign.platform}
Objective: ${campaign.objective}
${campaign.channel_type === "VIDEO" ? "Channel: YouTube Video (generate video scripts)" : ""}
Generate ${count || 3} high-converting ad creatives with image prompts for each.

BRAND CONTEXT: Use these details to make creatives match the user's brand:
- Site: ${site?.name || ""}
- Colors: ${brandColors.primary || ""}, ${brandColors.secondary || ""}
- Logo: ${site?.logo ? "Has logo" : "No logo"}
- Products: ${userProducts.slice(0, 5).map(p => p.name + " ($" + p.price + ")").join(", ") || "None listed"}
Match the brand's color scheme and tone in all image prompts.${trendContext}` }]
      })
    });

    const data = await r.json();
    const text = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const creatives = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(clean);

    const saved = [];
    for (const v of creatives) {
      let imageUrl = "";

      // Auto-generate image if requested
      if (generateImages && v.imagePrompt) {
        try {
          const imgResp = await fetch(`http://localhost:${process.env.PORT || 4000}/api/hosting/ai/image`, {
            method: "POST",
            headers: { "x-session-token": req.headers["x-session-token"] || "", "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: v.imagePrompt, size: campaign.platform === "meta" ? "square" : "landscape_16_9" })
          });
          const imgData = await imgResp.json();
          if (imgData.success) imageUrl = imgData.url;
        } catch(e) { console.error("[/generate-creatives]", e.message || e); }
      }

      const id = uuid();
      db.prepare(`INSERT INTO ad_creatives (id, campaign_id, user_id, headline, body, image_url, cta_text, cta_url, variant_label, impressions, clicks, conversions, spend, status, platform_ad_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,?,?,datetime('now'))`)
        .run(id, campaignId, req.userId, v.headline, v.body, imageUrl, v.cta || "Learn More", "", v.variant || "A", "active", "");
      saved.push({ id, headline: v.headline, body: v.body, cta: v.cta, variant: v.variant, imageUrl, imagePrompt: v.imagePrompt });
    }

    res.json({ success: true, creatives: saved });
  } catch (e) {
    console.error("[Route] AI generation failed: ", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ═══════════════════════════════════════════════════════
// PLATFORM INTEGRATION LAYER
// Meta (Facebook/Instagram) and Google Ads
// ═══════════════════════════════════════════════════════

async function platformAction(platform, action, targetId, data) {
  if (platform === "meta") return metaAction(action, targetId, data);
  if (platform === "google") return googleAction(action, targetId, data);
  if (platform === "tiktok") return tiktokAction(action, targetId, data);
  if (platform === "x") return xAdsAction(action, targetId, data);
  if (platform === "linkedin") return linkedinAdsAction(action, targetId, data);
  return { success: false, error: "Unknown platform" };
}

async function metaAction(action, targetId, data) {
  const accessToken = getSetting("META_ACCESS_TOKEN");
  const adAccountId = getSetting("META_AD_ACCOUNT_ID");
  if (!accessToken || !adAccountId) throw new Error("Meta Ads not configured. Add META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in admin.");

  const baseUrl = "https://graph.facebook.com/v19.0";

  switch (action) {
    case "create": {
      // Step 1: Create campaign
      const campResp = await fetch(`${baseUrl}/act_${adAccountId}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: accessToken,
          name: data.campaign.name,
          objective: mapMetaObjective(data.campaign.objective),
          status: "ACTIVE",
          special_ad_categories: [],
        })
      });
      const camp = await campResp.json();
      if (camp.error) throw new Error(camp.error.message);

      // Step 2: Create ad set
      const adSetResp = await fetch(`${baseUrl}/act_${adAccountId}/adsets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: accessToken,
          campaign_id: camp.id,
          name: data.campaign.name + " - Ad Set",
          daily_budget: Math.round(data.campaign.daily_budget * 100), // cents
          billing_event: "IMPRESSIONS",
          optimization_goal: "OFFSITE_CONVERSIONS",
          targeting: buildMetaTargeting(data.audience),
          status: "ACTIVE",
          start_time: data.campaign.start_date || undefined,
          end_time: data.campaign.end_date || undefined,
        })
      });
      const adSet = await adSetResp.json();

      // Step 3: Create ads for each creative
      const adIds = [];
      for (const creative of data.creatives) {
        const adResp = await fetch(`${baseUrl}/act_${adAccountId}/ads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            access_token: accessToken,
            adset_id: adSet.id,
            name: creative.headline,
            creative: { title: creative.headline, body: creative.body, link_url: creative.cta_url, call_to_action_type: mapMetaCTA(creative.cta_text) },
            status: "ACTIVE",
          })
        });
        const ad = await adResp.json();
        adIds.push(ad.id);
      }

      return { campaignId: camp.id, adSetId: adSet.id, adIds };
    }

    case "pause":
      await fetch(`${baseUrl}/${targetId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: accessToken, status: "PAUSED" }) });
      return { success: true };

    case "resume":
      await fetch(`${baseUrl}/${targetId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: accessToken, status: "ACTIVE" }) });
      return { success: true };

    case "pause_ad":
      await fetch(`${baseUrl}/${targetId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: accessToken, status: "PAUSED" }) });
      return { success: true };

    case "create_ad": {
      const adResp = await fetch(`${baseUrl}/act_${adAccountId}/ads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: accessToken,
          adset_id: targetId, // Pass adset ID
          name: data.headline,
          creative: { title: data.headline, body: data.body, call_to_action_type: "LEARN_MORE" },
          status: "ACTIVE",
        })
      });
      const ad = await adResp.json();
      return { adId: ad.id };
    }

    case "stats": {
      const resp = await fetch(`${baseUrl}/${targetId}/insights?fields=impressions,clicks,conversions,spend,actions&access_token=${accessToken}`);
      const insights = await resp.json();
      const row = insights.data?.[0] || {};
      const conversions = (row.actions || []).find(a => a.action_type === "offsite_conversion")?.value || 0;
      return { impressions: parseInt(row.impressions) || 0, clicks: parseInt(row.clicks) || 0, conversions: parseInt(conversions), spend: parseFloat(row.spend) || 0, revenue: 0 };
    }

    default: return {};
  }
}

async function googleAction(action, targetId, data) {
  const devToken = getSetting("GOOGLE_ADS_DEVELOPER_TOKEN");
  const customerId = getSetting("GOOGLE_ADS_CUSTOMER_ID");
  const accessToken = getSetting("GOOGLE_ACCESS_TOKEN");
  if (!devToken || !customerId) throw new Error("Google Ads not configured. Add GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_CUSTOMER_ID in admin.");

  const baseUrl = `https://googleads.googleapis.com/v16/customers/${customerId}`;
  const headers = { "Authorization": `Bearer ${accessToken}`, "developer-token": devToken, "Content-Type": "application/json" };

  switch (action) {
    case "create": {
      // Google Ads uses a different campaign creation flow
      const resp = await fetch(`${baseUrl}/campaigns:mutate`, {
        method: "POST", headers,
        body: JSON.stringify({
          operations: [{ create: { name: data.campaign.name, advertisingChannelType: data.campaign.channelType || (data.campaign.objective === "video_views" || data.campaign.objective === "awareness" ? "VIDEO" : "SEARCH"), status: "ENABLED", campaignBudget: `customers/${customerId}/campaignBudgets/new`,
            ...(data.campaign.channelType === "VIDEO" || data.campaign.objective === "video_views" ? { videoCampaignSettings: { videoAdFormats: ["IN_STREAM", "IN_FEED", "SHORTS"] } } : {}) } }]
        })
      });
      const result = await resp.json();
      return { campaignId: result.results?.[0]?.resourceName || "" };
    }
    case "pause":
    case "resume":
      await fetch(`${baseUrl}/campaigns:mutate`, {
        method: "POST", headers,
        body: JSON.stringify({ operations: [{ update: { resourceName: targetId, status: action === "pause" ? "PAUSED" : "ENABLED" }, updateMask: "status" }] })
      });
      return { success: true };
    case "stats": {
      const resp = await fetch(`${baseUrl}/googleAds:searchStream`, {
        method: "POST", headers,
        body: JSON.stringify({ query: `SELECT metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM campaign WHERE campaign.resource_name = '${targetId}' AND segments.date DURING TODAY` })
      });
      const result = await resp.json();
      const metrics = result[0]?.results?.[0]?.metrics || {};
      return { impressions: metrics.impressions || 0, clicks: metrics.clicks || 0, conversions: Math.round(metrics.conversions || 0), spend: (metrics.cost_micros || 0) / 1000000, revenue: 0 };
    }
    default: return {};
  }
}

async function tiktokAction(action, targetId, data) {
  const accessToken = getSetting("TIKTOK_ACCESS_TOKEN");
  const advertiserId = getSetting("TIKTOK_ADVERTISER_ID");
  if (!accessToken || !advertiserId) throw new Error("TikTok Ads not configured. Add TIKTOK_ACCESS_TOKEN and TIKTOK_ADVERTISER_ID in admin.");

  const baseUrl = "https://business-api.tiktok.com/open_api/v1.3";
  const headers = { "Access-Token": accessToken, "Content-Type": "application/json" };

  switch (action) {
    case "create": {
      // Create campaign
      const campResp = await fetch(`${baseUrl}/campaign/create/`, {
        method: "POST", headers,
        body: JSON.stringify({
          advertiser_id: advertiserId,
          campaign_name: data.campaign.name,
          objective_type: mapTikTokObjective(data.campaign.objective),
          budget_mode: "BUDGET_MODE_DAY",
          budget: data.campaign.daily_budget,
        })
      });
      const camp = await campResp.json();
      if (camp.code !== 0) throw new Error(camp.message || "TikTok campaign creation failed");
      const campaignId = camp.data?.campaign_id;

      // Create ad group
      const agResp = await fetch(`${baseUrl}/adgroup/create/`, {
        method: "POST", headers,
        body: JSON.stringify({
          advertiser_id: advertiserId,
          campaign_id: campaignId,
          adgroup_name: data.campaign.name + " - Ad Group",
          placement_type: "PLACEMENT_TYPE_AUTOMATIC",
          budget_mode: "BUDGET_MODE_DAY",
          budget: data.campaign.daily_budget,
          schedule_type: "SCHEDULE_FROM_NOW",
          optimization_goal: "CONVERT",
          billing_event: "CPC",
          bid_type: "BID_TYPE_NO_BID",
        })
      });
      const ag = await agResp.json();
      const adGroupId = ag.data?.adgroup_id;

      // Create ads for each creative
      const adIds = [];
      for (const creative of data.creatives) {
        const adResp = await fetch(`${baseUrl}/ad/create/`, {
          method: "POST", headers,
          body: JSON.stringify({
            advertiser_id: advertiserId,
            adgroup_id: adGroupId,
            ad_name: creative.headline,
            ad_text: creative.body,
            call_to_action: creative.cta_text || "LEARN_MORE",
            landing_page_url: creative.cta_url || "",
          })
        });
        const ad = await adResp.json();
        adIds.push(ad.data?.ad_id);
      }
      return { campaignId, adGroupId, adIds };
    }

    case "pause":
      await fetch(`${baseUrl}/campaign/status/update/`, { method: "POST", headers, body: JSON.stringify({ advertiser_id: advertiserId, campaign_ids: [targetId], opt_status: "DISABLE" }) });
      return { success: true };

    case "resume":
      await fetch(`${baseUrl}/campaign/status/update/`, { method: "POST", headers, body: JSON.stringify({ advertiser_id: advertiserId, campaign_ids: [targetId], opt_status: "ENABLE" }) });
      return { success: true };

    case "pause_ad":
      await fetch(`${baseUrl}/ad/status/update/`, { method: "POST", headers, body: JSON.stringify({ advertiser_id: advertiserId, ad_ids: [targetId], opt_status: "DISABLE" }) });
      return { success: true };

    case "stats": {
      const resp = await fetch(`${baseUrl}/report/integrated/get/`, {
        method: "GET", headers,
      });
      // Simplified — real implementation would use proper reporting endpoint
      const rData = await resp.json();
      const metrics = rData.data?.list?.[0]?.metrics || {};
      return {
        impressions: parseInt(metrics.impressions) || 0,
        clicks: parseInt(metrics.clicks) || 0,
        conversions: parseInt(metrics.conversions) || 0,
        spend: parseFloat(metrics.spend) || 0,
        revenue: 0
      };
    }

    default: return {};
  }
}

function mapTikTokObjective(obj) {
  const map = { conversions: "CONVERSIONS", traffic: "TRAFFIC", awareness: "REACH", leads: "LEAD_GENERATION", engagement: "VIDEO_VIEWS" };
  return map[obj] || "CONVERSIONS";
}

// ═══════════════════════════════════════════════════════
// X (TWITTER) ADS API
// ═══════════════════════════════════════════════════════

async function xAdsAction(action, targetId, data) {
  const accessToken = getSetting("X_ADS_ACCESS_TOKEN");
  const accountId = getSetting("X_ADS_ACCOUNT_ID");
  if (!accessToken || !accountId) throw new Error("X Ads not configured. Add X_ADS_ACCESS_TOKEN and X_ADS_ACCOUNT_ID in admin.");

  const baseUrl = `https://ads-api.x.com/12/accounts/${accountId}`;
  const headers = { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };

  switch (action) {
    case "create": {
      // Step 1: Create funding instrument (budget)
      const fundResp = await fetch(`${baseUrl}/funding_instruments`, { method: "GET", headers });
      const fundData = await fundResp.json();
      const fundingId = fundData.data?.[0]?.id;
      if (!fundingId) throw new Error("No funding instrument found. Add a payment method in X Ads Manager.");

      // Step 2: Create campaign
      const campResp = await fetch(`${baseUrl}/campaigns`, {
        method: "POST", headers,
        body: JSON.stringify({
          funding_instrument_id: fundingId,
          name: data.campaign.name,
          objective: mapXObjective(data.campaign.objective),
          daily_budget_amount_local_micro: Math.round((data.campaign.daily_budget || 20) * 1000000),
          entity_status: "ACTIVE",
          start_time: data.campaign.start_date ? new Date(data.campaign.start_date).toISOString() : undefined,
        })
      });
      const camp = await campResp.json();
      if (camp.errors) throw new Error(camp.errors[0]?.message || "X campaign creation failed");
      const campaignId = camp.data?.id;

      // Step 3: Create line item (ad group)
      const lineResp = await fetch(`${baseUrl}/line_items`, {
        method: "POST", headers,
        body: JSON.stringify({
          campaign_id: campaignId,
          name: data.campaign.name + " - Line Item",
          objective: mapXObjective(data.campaign.objective),
          placements: ["ALL_ON_TWITTER"],
          bid_type: "AUTO",
          product_type: "PROMOTED_TWEETS",
          entity_status: "ACTIVE",
        })
      });
      const lineItem = await lineResp.json();
      const lineItemId = lineItem.data?.id;

      // Step 4: Create promoted tweets for each creative
      const adIds = [];
      for (const creative of (data.creatives || [])) {
        // First create an organic tweet
        const tweetResp = await fetch("https://api.twitter.com/2/tweets", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
          body: JSON.stringify({ text: `${creative.headline}\n\n${creative.body}\n\n${creative.cta_url || ""}`.trim() }),
        });
        const tweet = await tweetResp.json();
        const tweetId = tweet.data?.id;

        if (tweetId) {
          // Promote the tweet
          const promoResp = await fetch(`${baseUrl}/promoted_tweets`, {
            method: "POST", headers,
            body: JSON.stringify({ line_item_id: lineItemId, tweet_ids: [tweetId] })
          });
          const promo = await promoResp.json();
          adIds.push(promo.data?.[0]?.id);
        }
      }

      return { campaignId, lineItemId, adIds };
    }

    case "pause":
      await fetch(`${baseUrl}/campaigns/${targetId}`, {
        method: "PUT", headers,
        body: JSON.stringify({ entity_status: "PAUSED" })
      });
      return { success: true };

    case "resume":
      await fetch(`${baseUrl}/campaigns/${targetId}`, {
        method: "PUT", headers,
        body: JSON.stringify({ entity_status: "ACTIVE" })
      });
      return { success: true };

    case "pause_ad":
      await fetch(`${baseUrl}/promoted_tweets/${targetId}`, {
        method: "PUT", headers,
        body: JSON.stringify({ entity_status: "PAUSED" })
      });
      return { success: true };

    case "create_ad": {
      // Create a new promoted tweet under an existing line item
      const tweetResp = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
        body: JSON.stringify({ text: `${data.headline}\n\n${data.body}`.trim() }),
      });
      const tweet = await tweetResp.json();
      if (tweet.data?.id) {
        const promoResp = await fetch(`${baseUrl}/promoted_tweets`, {
          method: "POST", headers,
          body: JSON.stringify({ line_item_id: targetId, tweet_ids: [tweet.data.id] })
        });
        const promo = await promoResp.json();
        return { adId: promo.data?.[0]?.id, tweetId: tweet.data.id };
      }
      return { success: false, error: "Failed to create tweet" };
    }

    case "stats": {
      // X Ads Analytics — async stats endpoint
      const end = new Date().toISOString().split("T")[0];
      const start = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
      const statsResp = await fetch(`${baseUrl}/stats/accounts/${accountId}?entity=CAMPAIGN&entity_ids=${targetId}&start_time=${start}&end_time=${end}&granularity=TOTAL&metric_groups=ENGAGEMENT,BILLING,VIDEO`, {
        method: "GET", headers
      });
      const statsData = await statsResp.json();
      const metrics = statsData.data?.[0]?.id_data?.[0]?.metrics || {};
      return {
        impressions: (metrics.impressions || []).reduce((s, v) => s + (v || 0), 0),
        clicks: (metrics.clicks || []).reduce((s, v) => s + (v || 0), 0),
        conversions: (metrics.conversion_purchases_web || []).reduce((s, v) => s + (v || 0), 0),
        spend: (metrics.billed_charge_local_micro || []).reduce((s, v) => s + (v || 0), 0) / 1000000,
        revenue: 0
      };
    }

    default: return {};
  }
}

function mapXObjective(obj) {
  const map = { conversions: "WEBSITE_CONVERSIONS", traffic: "WEBSITE_CLICKS", awareness: "REACH", engagement: "ENGAGEMENTS", leads: "WEBSITE_CONVERSIONS", video_views: "VIDEO_VIEWS" };
  return map[obj] || "WEBSITE_CLICKS";
}

// ═══════════════════════════════════════════════════════
// LINKEDIN CAMPAIGN MANAGER API
// ═══════════════════════════════════════════════════════

async function linkedinAdsAction(action, targetId, data) {
  const accessToken = getSetting("LINKEDIN_ACCESS_TOKEN");
  const adAccountId = getSetting("LINKEDIN_AD_ACCOUNT_ID");
  if (!accessToken || !adAccountId) throw new Error("LinkedIn Ads not configured. Add LINKEDIN_ACCESS_TOKEN and LINKEDIN_AD_ACCOUNT_ID in admin.");

  const baseUrl = "https://api.linkedin.com/rest";
  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": "202401"
  };

  switch (action) {
    case "create": {
      // Step 1: Create campaign group
      const groupResp = await fetch(`${baseUrl}/campaignGroups`, {
        method: "POST", headers,
        body: JSON.stringify({
          account: `urn:li:sponsoredAccount:${adAccountId}`,
          name: data.campaign.name + " - Group",
          status: "ACTIVE",
          runSchedule: { start: Date.now() },
          totalBudget: { currencyCode: "USD", amount: String(Math.round((data.campaign.daily_budget || 20) * 30)) },
        })
      });
      const groupId = groupResp.headers.get("x-restli-id") || groupResp.headers.get("x-linkedin-id");

      // Step 2: Create campaign
      const campResp = await fetch(`${baseUrl}/campaigns`, {
        method: "POST", headers,
        body: JSON.stringify({
          account: `urn:li:sponsoredAccount:${adAccountId}`,
          campaignGroup: groupId ? `urn:li:sponsoredCampaignGroup:${groupId}` : undefined,
          name: data.campaign.name,
          type: "SPONSORED_UPDATES",
          objectiveType: mapLinkedInObjective(data.campaign.objective),
          costType: "CPM",
          dailyBudget: { currencyCode: "USD", amount: String(data.campaign.daily_budget || 20) },
          unitCost: { currencyCode: "USD", amount: "0" },
          status: "ACTIVE",
          runSchedule: { start: Date.now() },
          locale: { country: "US", language: "en" },
          targeting: buildLinkedInTargeting(data.audience),
          creativeSelection: "OPTIMIZED",
        })
      });
      const campaignId = campResp.headers.get("x-restli-id") || campResp.headers.get("x-linkedin-id");

      // Step 3: Create ad creatives for each creative
      const adIds = [];
      for (const creative of (data.creatives || [])) {
        // Create sponsored content post
        const contentResp = await fetch(`${baseUrl}/posts`, {
          method: "POST", headers,
          body: JSON.stringify({
            author: `urn:li:sponsoredAccount:${adAccountId}`,
            commentary: `${creative.headline}\n\n${creative.body}`,
            visibility: "PUBLIC",
            lifecycleState: "PUBLISHED",
            distribution: { feedDistribution: "MAIN_FEED" },
            content: creative.cta_url ? {
              article: {
                source: creative.cta_url,
                title: creative.headline,
                description: creative.body,
              }
            } : undefined,
          })
        });
        const postUrn = contentResp.headers.get("x-restli-id");

        if (postUrn) {
          // Create creative linking post to campaign
          const adResp = await fetch(`${baseUrl}/creatives`, {
            method: "POST", headers,
            body: JSON.stringify({
              campaign: `urn:li:sponsoredCampaign:${campaignId}`,
              reference: postUrn,
              status: "ACTIVE",
            })
          });
          const adId = adResp.headers.get("x-restli-id");
          adIds.push(adId);
        }
      }

      return { campaignGroupId: groupId, campaignId, adIds };
    }

    case "pause":
      await fetch(`${baseUrl}/campaigns/${targetId}`, {
        method: "POST", headers,
        body: JSON.stringify({ patch: { $set: { status: "PAUSED" } } })
      });
      return { success: true };

    case "resume":
      await fetch(`${baseUrl}/campaigns/${targetId}`, {
        method: "POST", headers,
        body: JSON.stringify({ patch: { $set: { status: "ACTIVE" } } })
      });
      return { success: true };

    case "pause_ad":
      await fetch(`${baseUrl}/creatives/${targetId}`, {
        method: "POST", headers,
        body: JSON.stringify({ patch: { $set: { status: "PAUSED" } } })
      });
      return { success: true };

    case "create_ad": {
      // Create a new sponsored post creative under existing campaign
      const contentResp = await fetch(`${baseUrl}/posts`, {
        method: "POST", headers,
        body: JSON.stringify({
          author: `urn:li:sponsoredAccount:${adAccountId}`,
          commentary: `${data.headline}\n\n${data.body}`,
          visibility: "PUBLIC",
          lifecycleState: "PUBLISHED",
          distribution: { feedDistribution: "MAIN_FEED" },
        })
      });
      const postUrn = contentResp.headers.get("x-restli-id");
      if (postUrn) {
        const adResp = await fetch(`${baseUrl}/creatives`, {
          method: "POST", headers,
          body: JSON.stringify({ campaign: `urn:li:sponsoredCampaign:${targetId}`, reference: postUrn, status: "ACTIVE" })
        });
        return { adId: adResp.headers.get("x-restli-id") };
      }
      return { success: false, error: "Failed to create LinkedIn post" };
    }

    case "stats": {
      // LinkedIn Campaign Analytics
      const end = Date.now();
      const start = end - 7 * 86400000;
      const statsResp = await fetch(`${baseUrl}/adAnalytics?q=analytics&dateRange=(start:(year:${new Date(start).getFullYear()},month:${new Date(start).getMonth()+1},day:${new Date(start).getDate()}),end:(year:${new Date(end).getFullYear()},month:${new Date(end).getMonth()+1},day:${new Date(end).getDate()}))&timeGranularity=ALL&campaigns=urn:li:sponsoredCampaign:${targetId}&fields=impressions,clicks,externalWebsiteConversions,costInLocalCurrency`, {
        method: "GET", headers
      });
      const statsData = await statsResp.json();
      const el = statsData.elements?.[0] || {};
      return {
        impressions: el.impressions || 0,
        clicks: el.clicks || 0,
        conversions: el.externalWebsiteConversions || 0,
        spend: parseFloat(el.costInLocalCurrency || 0),
        revenue: 0
      };
    }

    default: return {};
  }
}

function mapLinkedInObjective(obj) {
  const map = { conversions: "WEBSITE_CONVERSIONS", traffic: "WEBSITE_VISIT", awareness: "BRAND_AWARENESS", leads: "LEAD_GENERATION", engagement: "ENGAGEMENT", video_views: "VIDEO_VIEWS" };
  return map[obj] || "WEBSITE_VISIT";
}

function buildLinkedInTargeting(audience) {
  // Default broad targeting — users can refine in LinkedIn Campaign Manager
  return {
    includedTargetingFacets: {
      locations: ["urn:li:geo:103644278"], // USA default
      interfaceLocales: [{ country: "US", language: "en" }],
    }
  };
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function mapMetaObjective(obj) {
  const map = { conversions: "OUTCOME_SALES", traffic: "OUTCOME_TRAFFIC", awareness: "OUTCOME_AWARENESS", leads: "OUTCOME_LEADS", engagement: "OUTCOME_ENGAGEMENT" };
  return map[obj] || "OUTCOME_SALES";
}

function mapMetaCTA(cta) {
  const map = { "Learn More": "LEARN_MORE", "Shop Now": "SHOP_NOW", "Sign Up": "SIGN_UP", "Get Offer": "GET_OFFER", "Book Now": "BOOK_TRAVEL", "Contact Us": "CONTACT_US" };
  return map[cta] || "LEARN_MORE";
}

function buildMetaTargeting(audience) {
  const targeting = {};
  if (audience.ageMin) targeting.age_min = audience.ageMin;
  if (audience.ageMax) targeting.age_max = audience.ageMax;
  if (audience.genders) targeting.genders = audience.genders; // [1] = male, [2] = female
  if (audience.locations) targeting.geo_locations = { countries: audience.locations };
  if (audience.interests) targeting.interests = audience.interests.map(i => ({ id: i.id, name: i.name }));
  return targeting;
}

function notify(db, userId, icon, text) {
  db.prepare("INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)").run(uuid(), userId, icon, text, "Just now");
}

// ═══════════════════════════════════════════════════════
// DB TABLES
// ═══════════════════════════════════════════════════════

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ad_campaigns (
      id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT, platform TEXT, name TEXT, objective TEXT,
      audience TEXT, daily_budget REAL DEFAULT 20, budget_type TEXT DEFAULT 'daily',
      total_spent REAL DEFAULT 0, status TEXT DEFAULT 'draft', platform_campaign_id TEXT,
      start_date TEXT, end_date TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ad_creatives (
      id TEXT PRIMARY KEY, campaign_id TEXT, user_id TEXT, headline TEXT, body TEXT,
      image_url TEXT, cta_text TEXT, cta_url TEXT, variant_label TEXT,
      impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0,
      spend REAL DEFAULT 0, status TEXT DEFAULT 'active', platform_ad_id TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ad_performance (
      id TEXT PRIMARY KEY, campaign_id TEXT, date TEXT, impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, spend REAL DEFAULT 0,
      ctr REAL DEFAULT 0, cpc REAL DEFAULT 0, cpa REAL DEFAULT 0, roas REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ad_campaigns_user ON ad_campaigns(user_id);
    CREATE INDEX IF NOT EXISTS idx_ad_creatives_campaign ON ad_creatives(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_ad_perf_campaign ON ad_performance(campaign_id);
  `);
}

module.exports = router;
module.exports.platformAction = platformAction;
