/**
 * lib/seo-agent-loop.js
 * Orchestrates a single SEO agent run. Phase 3 enhanced: also generates
 * actual content for content_topic/h1 suggestions and writes to sites.html.
 */

const { fetchSERP, fetchCompetitorPage } = require("./serp-scraper");

const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
const MAX_KEYWORDS_PER_RUN = 25;
const MAX_COMPETITORS_PER_KEYWORD = 5;
const MAX_CONTENT_DRAFTS_PER_KEYWORD = 2; // cost guard

async function runAgentForUser(db, userId, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const result = { keywordsProcessed: 0, suggestionsGenerated: 0, autoApplied: 0,
                   contentDraftsGenerated: 0, errors: [], startedAt: new Date().toISOString() };

  const sub = await _getRow(db, "SELECT * FROM seo_agent_subscriptions WHERE user_id = ? AND status = 'active'", [userId]);
  if (!sub) { result.errors.push("No active subscription"); return result; }

  const config = await _getRow(db, "SELECT * FROM seo_agent_config WHERE user_id = ?", [userId])
              || { autonomy_level: "manual", frequency_days: 2 };

  const keywords = await _getAll(db,
    "SELECT * FROM seo_keywords WHERE user_id = ? AND enabled = 1 ORDER BY last_checked ASC NULLS FIRST LIMIT ?",
    [userId, MAX_KEYWORDS_PER_RUN]);
  if (keywords.length === 0) { result.errors.push("No keywords tracked"); return result; }

  for (const kw of keywords) {
    try {
      const r = await _processKeyword(db, userId, kw, config, dryRun);
      result.keywordsProcessed++;
      result.suggestionsGenerated += r.suggestionsCount;
      result.autoApplied += r.autoApplied;
      result.contentDraftsGenerated += r.contentDraftsGenerated;
    } catch (e) {
      result.errors.push("keyword '" + kw.keyword + "': " + (e.message || "unknown"));
    }
  }

  if (!dryRun) {
    await _run(db, "UPDATE seo_agent_subscriptions SET last_run_at = datetime('now'), total_runs = COALESCE(total_runs,0)+1 WHERE user_id = ?", [userId]);
  }

  // Send email digest if auto-changes happened and notifications enabled
  if (!dryRun && result.autoApplied > 0 && config.notify_email !== 0) {
    try {
      await _sendDigestEmail(db, userId, result, config);
      result.emailSent = true;
    } catch (e) {
      result.errors.push("digest email: " + (e.message || "unknown"));
    }
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

async function _processKeyword(db, userId, kw, config, dryRun) {
  const out = { suggestionsCount: 0, autoApplied: 0, contentDraftsGenerated: 0 };

  const serpResults = await fetchSERP(kw.keyword, { location: kw.location || "United States", num: MAX_COMPETITORS_PER_KEYWORD });
  if (serpResults.length === 0) {
    if (!dryRun) await _run(db, "UPDATE seo_keywords SET last_checked = datetime('now'), last_error = ? WHERE id = ?", ["No SERP results", kw.id]);
    return out;
  }

  let userRank = null;
  const site = await _getRow(db, "SELECT * FROM sites WHERE id = ?", [kw.site_id]);
  if (site && site.domain) {
    const hit = serpResults.findIndex(r => (r.url || "").indexOf(site.domain) !== -1);
    userRank = hit !== -1 ? (hit + 1) : null;
  }

  const competitorUrls = serpResults.filter(r => !site || !site.domain || (r.url || "").indexOf(site.domain) === -1).slice(0, MAX_COMPETITORS_PER_KEYWORD);
  const snapshots = await Promise.all(competitorUrls.map(c => fetchCompetitorPage(c.url).catch(e => ({ url: c.url, error: e.message }))));

  if (!dryRun) {
    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      if (snap.error) continue;
      await _run(db, `INSERT INTO seo_competitor_snapshots
        (id, keyword_id, rank, competitor_url, title, meta_description, h1, word_count, schema_types, internal_links, scraped_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [_uuid(), kw.id, competitorUrls[i].rank, snap.url, snap.title, snap.metaDescription,
         snap.h1, snap.wordCount, JSON.stringify(snap.schemaTypes || []), snap.internalLinks]);
    }
  }
  if (!dryRun) {
    await _run(db, "UPDATE seo_keywords SET current_rank = ?, last_checked = datetime('now'), last_error = NULL WHERE id = ?", [userRank, kw.id]);
  }

  if (!site) return out;
  const suggestions = await _generateSuggestions(kw, site, snapshots.filter(s => !s.error));
  out.suggestionsCount = suggestions.length;

  if (dryRun) return out;

  // ─── Generate actual content for h1/content_topic types ────────────
  let contentBudget = MAX_CONTENT_DRAFTS_PER_KEYWORD;
  for (const sug of suggestions) {
    if (contentBudget > 0 && (sug.type === "h1" || sug.type === "content_topic")) {
      try {
        const deliverable = await _generateContentDeliverable(kw, site, sug, snapshots.filter(s => !s.error));
        if (deliverable) {
          sug.suggested_value_html = deliverable;
          out.contentDraftsGenerated++;
          contentBudget--;
        }
      } catch (e) {
        console.warn("[seo-agent] content gen failed:", e.message);
      }
    }

    const sugId = _uuid();
    // For h1/content_topic, save the generated HTML into suggested_value
    const finalSuggested = sug.suggested_value_html || sug.suggested || "";
    await _run(db, `INSERT INTO seo_suggestions
      (id, user_id, site_id, keyword_id, type, current_value, suggested_value, reasoning,
       source_competitors, confidence, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [sugId, userId, site.id, kw.id, sug.type, sug.current || "", finalSuggested,
       sug.reasoning || "", JSON.stringify(sug.sourceCompetitors || []), sug.confidence || 0.5, "pending"]);

    if (_shouldAutoApply(sug, config)) {
      const applied = await _applySuggestion(db, sugId, site, sug, finalSuggested);
      if (applied) {
        out.autoApplied++;
        await _run(db, "UPDATE seo_suggestions SET status='applied', applied_at=datetime('now') WHERE id = ?", [sugId]);
      }
    }
  }
  return out;
}

// ─── Claude: initial suggestion generation ──────────────────────────────
async function _generateSuggestions(kw, site, snapshots) {
  if (!CLAUDE_API_KEY || snapshots.length === 0) return [];
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: CLAUDE_API_KEY });

  const competitorSummary = snapshots.slice(0, 5).map((s, i) => ({
    rank: i + 1, url: s.url, title: s.title, metaDescription: s.metaDescription,
    h1: s.h1, h2s: (s.h2s || []).slice(0, 6), wordCount: s.wordCount, schemaTypes: s.schemaTypes
  }));
  const userPage = {
    domain: site.domain, title: site.seo_title || "",
    metaDescription: site.seo_description || "", keywords: site.seo_keywords || ""
  };
  const prompt = [
    "You are an SEO analyst. The user wants to rank for: \"" + kw.keyword + "\".",
    "", "TOP COMPETITORS:", JSON.stringify(competitorSummary, null, 2),
    "", "USER'S PAGE:", JSON.stringify(userPage, null, 2),
    "", "Identify 3-5 specific SEO improvements. Return JSON only:",
    '[{"type":"meta_title|meta_description|h1|schema|content_topic|internal_link","current":"...","suggested":"...","reasoning":"...","confidence":0.0-1.0,"sourceCompetitors":[urls]}]',
    "", "Rules: meta_title ≤60 chars; meta_description 140-160 chars; confidence 0.9+ for safe meta changes; cite competitor URLs."
  ].join("\n");

  try {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    });
    const text = (r.content[0] && r.content[0].text) || "";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("[seo-agent] suggestion gen failed:", e.message);
    return [];
  }
}

// ─── Claude: deliverable content generation for content_topic / h1 ──────
async function _generateContentDeliverable(kw, site, sug, snapshots) {
  if (!CLAUDE_API_KEY) return null;
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: CLAUDE_API_KEY });

  const competitorRefs = snapshots.slice(0, 3).map(s => ({
    url: s.url, h1: s.h1, h2s: (s.h2s || []).slice(0, 5)
  }));

  let prompt;
  if (sug.type === "h1") {
    prompt = [
      "Write a single SEO-optimized H1 headline for a page targeting the keyword: \"" + kw.keyword + "\".",
      "Business: " + (site.name || site.domain || "the user's business"),
      "Current H1: " + (sug.current || "(none)"),
      "Reasoning for new H1: " + (sug.reasoning || ""),
      "Top competitors' H1s: " + JSON.stringify(competitorRefs.map(c => c.h1).filter(Boolean)),
      "",
      "Return ONLY the H1 text — no quotes, no HTML tags, no explanations. Max 70 characters."
    ].join("\n");
  } else {
    // content_topic
    prompt = [
      "Write a complete, SEO-optimized content section for a webpage targeting: \"" + kw.keyword + "\".",
      "Business: " + (site.name || site.domain || "the user's business"),
      "Topic to add: " + (sug.suggested || sug.reasoning || ""),
      "Reasoning: " + (sug.reasoning || ""),
      "Top competitors are covering these subtopics: " + JSON.stringify(competitorRefs),
      "",
      "Output HTML in this exact structure:",
      "<section class=\"seo-content\" data-seo-keyword=\"" + kw.keyword.replace(/[<>\"'&]/g, "") + "\">",
      "  <h2>{compelling section heading using the keyword naturally}</h2>",
      "  <p>{200-300 words of useful, original content that genuinely answers what searchers want. Natural keyword use, no stuffing. Specific, concrete, helpful.}</p>",
      "  <ul>{3-5 bullet points covering key sub-points}</ul>",
      "</section>",
      "",
      "Return ONLY the HTML. No markdown fences. No preamble. The content must be original — do not copy from competitors."
    ].join("\n");
  }

  try {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    });
    const text = (r.content[0] && r.content[0].text) || "";
    return text.replace(/```html|```/g, "").trim();
  } catch (e) {
    console.warn("[seo-agent] deliverable gen failed:", e.message);
    return null;
  }
}

function _shouldAutoApply(sug, config) {
  if (config.autonomy_level === "manual") return false;
  if (config.autonomy_level === "full_auto") return true;
  if (config.autonomy_level === "auto_safe") {
    // Low-risk: only DB-level fields, high confidence
    const safeTypes = ["meta_title", "meta_description", "schema"];
    return safeTypes.indexOf(sug.type) !== -1 && (sug.confidence || 0) >= 0.85;
  }
  if (config.autonomy_level === "auto_aggressive") {
    // Phase 3: also patches H1/H2/content/links at ≥0.75 confidence
    // Mandatory email digest + revert window per change
    const aggressiveTypes = ["meta_title", "meta_description", "schema", "h1", "h2", "content_topic", "internal_link"];
    return aggressiveTypes.indexOf(sug.type) !== -1 && (sug.confidence || 0) >= 0.75;
  }
  return false;
}

async function _applySuggestion(db, sugId, site, sug, deliverable) {
  // Snapshot for revert
  const snapshotId = _uuid();
  const oldValue = (sug.type === "h1" || sug.type === "content_topic")
                   ? (sug.type === "h1" ? _extractFirstH1(site.html || "") : "") : (sug.current || "");
  await _run(db, `INSERT INTO seo_changes_history
    (id, suggestion_id, site_id, field, old_value, new_value, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [snapshotId, sugId, site.id, sug.type, oldValue, deliverable || sug.suggested || "", new Date().toISOString()]);

  switch (sug.type) {
    case "meta_title":
      await _run(db, "UPDATE sites SET seo_title = ?, updated_at = datetime('now') WHERE id = ?", [sug.suggested, site.id]);
      return true;
    case "meta_description":
      await _run(db, "UPDATE sites SET seo_description = ?, updated_at = datetime('now') WHERE id = ?", [sug.suggested, site.id]);
      return true;
    case "schema": {
      let seo;
      try { seo = JSON.parse(site.seo_json || "{}"); } catch (_) { seo = {}; }
      seo.schema = sug.suggested;
      await _run(db, "UPDATE sites SET seo_json = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(seo), site.id]);
      return true;
    }
    case "h1":
    case "h2":
    case "h3":
    case "content_topic":
    case "internal_link": {
      // Phase 3: surgical HTML patching using jsdom (safer than string ops)
      const { patchHtml } = require("./html-patcher");
      const result = patchHtml(site.html || "", {
        type: sug.type,
        current: sug.current || sug.current_value || "",
        suggested: deliverable || sug.suggested || sug.suggested_value || "",
        anchorUrl: sug.anchorUrl || deliverable || sug.suggested
      });
      if (!result.ok) {
        try {
          await _run(db,
            "UPDATE seo_suggestions SET status='failed', applied_at=datetime('now'), reasoning = COALESCE(reasoning,'') || ' [HTML patch failed: ' || ? || ']' WHERE id = ?",
            [result.reason || "unknown", sugId]);
        } catch(_) {}
        return false;
      }
      await _run(db, "UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?", [result.html, site.id]);
      return true;
    }
    default:
      return false;
  }
}

// ─── HTML manipulation helpers ──────────────────────────────────────────
function _extractFirstH1(html) {
  const m = String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}
function _replaceFirstH1(html, newText, sugId) {
  if (!/<h1[^>]*>/i.test(html)) return null;
  const safe = String(newText || "").replace(/<[^>]+>/g, "").trim();
  if (!safe) return null;
  return html.replace(/<h1([^>]*)>[\s\S]*?<\/h1>/i,
    '<h1$1 data-seo-suggestion-id="' + sugId + '">' + safe + '</h1>');
}
function _appendContentBlock(html, blockHtml, sugId) {
  const wrapped = '\n<!-- seo-suggestion:' + sugId + ':start -->\n'
                + blockHtml.replace(/data-seo-suggestion-id="[^"]*"/g, '')
                + '\n<!-- seo-suggestion:' + sugId + ':end -->\n';
  // Prefer to inject before closing </main> if present, else </body>, else append
  if (/<\/main>/i.test(html)) return html.replace(/<\/main>/i, wrapped + '</main>');
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, wrapped + '</body>');
  return html + wrapped;
}

// ─── Overage summary helper ─────────────────────────────────────────────
async function _sendDigestEmail(db, userId, runResult, config) {
  const user = await _getRow(db, "SELECT email, name FROM users WHERE id = ?", [userId]);
  if (!user || !user.email) return;
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "agent@takeova.ai";
  if (!SENDGRID_API_KEY) {
    console.log("[seo-agent] SENDGRID_API_KEY not set — skipping digest email for " + userId);
    return;
  }

  const applied = await _getAll(db,
    `SELECT s.id, s.type, s.current_value, s.suggested_value, s.confidence, k.keyword
     FROM seo_suggestions s
     LEFT JOIN seo_keywords k ON k.id = s.keyword_id
     WHERE s.user_id = ?
     AND s.status = 'applied'
     AND s.applied_at >= datetime('now','-2 hours')
     ORDER BY s.applied_at DESC LIMIT 50`,
    [userId]);

  let baseUrl = process.env.BACKEND_URL || "https://takeova.ai";
  if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);

  const items = applied.map(s => {
    const typeLabel = ({
      meta_title: "📌 Meta title",
      meta_description: "📝 Meta description",
      schema: "🔧 Schema markup",
      h1: "🏷️ H1 heading",
      h2: "🏷️ H2 heading",
      content_topic: "✍️ Content rewrite",
      internal_link: "🔗 Internal link"
    })[s.type] || s.type;
    const before = _trunc(s.current_value, 100);
    const after = _trunc(s.suggested_value, 100);
    const revertUrl = baseUrl + "/api/seo-agent/suggestions/" + s.id + "/revert";
    return `
      <tr><td style="padding:12px;border-bottom:1px solid #eee;font-size:13px">
        <div style="font-weight:700;color:#5b21b6;margin-bottom:4px">${typeLabel}</div>
        <div style="color:#666;font-size:11px;margin-bottom:4px">Keyword: ${_escape(s.keyword || "—")}</div>
        ${before ? `<div style="background:#fef3c7;padding:6px;border-radius:4px;margin-bottom:4px;font-size:12px"><b>Was:</b> ${_escape(before)}</div>` : ""}
        <div style="background:#dcfce7;padding:6px;border-radius:4px;margin-bottom:6px;font-size:12px"><b>Now:</b> ${_escape(after)}</div>
        <a href="${revertUrl}" style="color:#dc2626;font-size:11px;text-decoration:none;font-weight:600">↶ Revert this change</a>
      </td></tr>`;
  }).join("");

  const subject = `🎯 SEO Agent — ${runResult.autoApplied} change(s) applied today`;
  const aggressiveNote = config.autonomy_level === "auto_aggressive"
    ? `<div style="background:#fef3c7;border:1px solid #fcd34d;padding:10px;border-radius:8px;margin-bottom:14px;font-size:12px;color:#92400e">⚡ <b>Auto-aggressive mode</b> — I rewrote content, headings, and added internal links. Use the revert links if anything looks off.</div>`
    : "";

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f7;margin:0;padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:24px 12px">
      <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px">
          <tr><td style="background:linear-gradient(135deg,#5b21b6,#7c3aed);padding:24px;text-align:center;color:#fff">
            <div style="font-size:32px;margin-bottom:6px">🎯</div>
            <div style="font-weight:700;font-size:18px">SEO Agent Daily Summary</div>
            <div style="font-size:13px;opacity:.85;margin-top:4px">Hi ${_escape(user.name || "there")} — here's what I changed today</div>
          </td></tr>
          <tr><td style="padding:20px">
            ${aggressiveNote}
            <div style="font-size:14px;color:#444;line-height:1.6;margin-bottom:16px">
              I applied <b>${runResult.autoApplied} SEO improvement(s)</b> across your tracked keywords (${runResult.keywordsProcessed} processed).
              Every change has a one-tap revert below — if anything looks wrong, click revert and the previous value is restored instantly.
            </div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">${items}</table>
            <div style="margin-top:20px;padding:14px;background:#f8f9ff;border-radius:8px;font-size:12px;color:#666;line-height:1.6">
              <b>Don't want auto-changes?</b> Open AI Employees → SEO Agent → Config and switch autonomy to <b>manual</b>. I'll queue suggestions for your approval instead.
            </div>
          </td></tr>
          <tr><td style="background:#f8f9ff;padding:14px;text-align:center;font-size:11px;color:#888">
            MINE · AI SEO Agent · <a href="${baseUrl}" style="color:#5b21b6;text-decoration:none">Open dashboard</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;

  const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { "Authorization": "Bearer " + SENDGRID_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: user.email, name: user.name || "" }] }],
      from: { email: FROM_EMAIL, name: "MINE SEO Agent" },
      subject,
      content: [{ type: "text/html", value: html }]
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("SendGrid " + resp.status + ": " + errText.slice(0, 200));
  }
}

function _trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
function _escape(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

async function getOverageSummary(db, userId) {
  if (typeof global.mineCheckUsage !== "function") return { metrics: [], hasOverage: false };
  const metrics = ["productDescs","blogPosts","reviewReplies","socialCaptions","cartPersonalise","invoiceChasers","upsellRecs","faqGeneration","refundHandling","competitorAnalysis","contracts","intelligenceRefresh","monthlyNarrative","parcelDimensions","seoAudits","adCreatives","images","aiVideos","sequenceBuilder"];
  const out = []; let hasOverage = false;
  for (const m of metrics) {
    try {
      const u = global.mineCheckUsage(db, userId, m);
      if (!u) continue;
      const pct = u.cap > 0 ? Math.round((u.used / u.cap) * 100) : 0;
      const overage = u.used > u.cap ? (u.used - u.cap) : 0;
      const cost = overage * (u.overagePrice || 0);
      if (overage > 0 || pct >= 80) {
        out.push({ metric: m, used: u.used, cap: u.cap, pct, overage, cost });
        if (overage > 0) hasOverage = true;
      }
    } catch (_) {}
  }
  return { metrics: out, hasOverage };
}

// ─── DB helpers ─────────────────────────────────────────────────────────
function _uuid() { return require("crypto").randomUUID(); }
function _getRow(db, sql, params) { return new Promise((res, rej) => { if (db.get) return db.get(sql, params, (e, r) => e?rej(e):res(r)); try { res(db.prepare(sql).get.apply(db.prepare(sql), params||[])); } catch(e){rej(e);} }); }
function _getAll(db, sql, params) { return new Promise((res, rej) => { if (db.all) return db.all(sql, params, (e, r) => e?rej(e):res(r||[])); try { res(db.prepare(sql).all.apply(db.prepare(sql), params||[])); } catch(e){rej(e);} }); }
function _run(db, sql, params) { return new Promise((res, rej) => { if (db.run) return db.run(sql, params, function(e){ e?rej(e):res(this); }); try { res(db.prepare(sql).run.apply(db.prepare(sql), params||[])); } catch(e){rej(e);} }); }

module.exports = { runAgentForUser, getOverageSummary };
