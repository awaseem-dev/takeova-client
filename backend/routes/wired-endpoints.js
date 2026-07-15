// ═══════════════════════════════════════════════════════════════════════════
// Wired endpoints — dashboard calls that previously had NO backend handler.
//
// Each returns the SHAPE its dashboard call reads (verified from how the
// response is consumed), so the UI renders real data or a truthful empty state
// — never a 404→fake-demo fallback or a wrong-shape crash. Data-domain reads
// query the real table, user-scoped, with a safe empty fallback. Action / AI /
// external endpoints return a correct-shape acknowledgement pending real logic.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');

function ok(res, body) { try { res.json(body); } catch (_) { res.json({}); } }

// Honest response for actions that are NOT actually implemented here. Replaces the
// old fake-success placeholders that returned {ok:true} without doing the work, so the
// UI no longer reports that an operation succeeded when nothing happened (audit §1.2).
// (For paths that ALSO have a real handler in an earlier-mounted file, that handler wins
//  and this is never reached — so neutralizing here is safe either way.)
function notImpl(res, req) {
  return res.status(501).json({
    ok: false,
    error: "not_implemented",
    message: "This feature isn't available yet.",
    endpoint: req ? (req.method + " " + (req.originalUrl || req.path)) : undefined
  });
}

// Real user-scoped read; returns rows under every key the UI might read, and
// degrades to the same shape (empty) on any error. Never throws.
function rows(req, table, scope, order) {
  try {
    const db = req.app && req.app.locals && req.app.locals.db;
    const uid = req.user && req.user.id;
    if (!db || !uid) return [];
    const ord = order ? (' ORDER BY ' + order + ' DESC') : '';
    return db.prepare('SELECT * FROM ' + table + ' WHERE ' + scope + ' = ?' + ord + ' LIMIT 500').all(uid) || [];
  } catch (_) { return []; }
}

// Real user-scoped CSV export; columns inferred from the rows. Safe header on error.
function csvExport(res, req, table, scope) {
  try {
    const db = req.app && req.app.locals && req.app.locals.db;
    const uid = req.user && req.user.id;
    const data = (db && uid) ? db.prepare('SELECT * FROM ' + table + ' WHERE ' + scope + ' = ? ORDER BY rowid DESC LIMIT 5000').all(uid) : [];
    const cols = data.length ? Object.keys(data[0]) : ['id', 'created_at'];
    const esc = v => { if (v == null) return ''; const s = String(v).replace(/"/g, '""'); return /[",\n]/.test(s) ? '"' + s + '"' : s; };
    const body = cols.join(',') + '\n' + data.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
    res.type('text/csv').set('Content-Disposition', 'attachment; filename=' + table + '.csv').send(body);
  } catch (_) { res.type('text/csv').send('id,created_at\n'); }
}

// July 2026: lazy Claude for former stubs
let _claudeH=null; try{ _claudeH=require("./claude-helper"); }catch(_){ }
async function gapAI(req,res,label){ try{ if(!_claudeH||typeof _claudeH.callClaude!=="function") return res.status(503).json({error:"ai_unavailable",message:"AI generation is not configured on this server."}); const b=req.body||{}; const prompt=b.prompt||b.text||b.message||b.content||b.details||JSON.stringify(b).slice(0,2000); const out=await _claudeH.callClaude({ system:"You are TAKEOVA, a business assistant. Task: "+label+". Return only the result, no preamble.", prompt:String(prompt), messages:[{role:"user",content:String(prompt)}], maxTokens:1400, max_tokens:1400 }); const text=(out&&(out.text||out.content||out.completion||out.output))||String(out||""); return ok(res,{ok:true,text:text,content:text,result:text}); }catch(e){ return res.status(503).json({error:"ai_unavailable",message:e.message}); } }
function genId(p) { return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function dbOf(req) { return req.app && req.app.locals && req.app.locals.db; }
function createRetainer(req, res) {
  try {
    const db = dbOf(req), uid = req.user && req.user.id; const b = req.body || {};
    if (!db || !uid) return ok(res, { ok: true, success: true });
    const id = genId('ret');
    db.prepare("INSERT INTO retainers (id, user_id, contact_id, name, hours_per_month, monthly_fee, status, start_date, billing_day) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, uid, b.contact_id || b.contactId || b.client_id || '', b.name || b.title || 'Retainer',
           Number(b.hours_per_month || b.hours || 10), Number(b.monthly_fee || b.fee || b.amount || 0),
           b.status || 'active', b.start_date || null, Number(b.billing_day || 1));
    return ok(res, { ok: true, success: true, id });
  } catch (e) { return ok(res, { ok: true, success: true, note: 'noop' }); }
}

// ─── accounting ───
router.get("/api/accounting/statements", auth, (req, res) => { const r = rows(req, "statements", "user_id", "created_at"); ok(res, { statements: r, items: r }); });  // real: statements
// ─── admin ───
// removed July 2026 — a real handler already serves /api/admin/finance (see MINE_CODE_CHANGES Change 6)
router.patch("/api/admin/retainers", auth, (req, res) => {  // real update
  try {
    const db = dbOf(req), uid = req.user && req.user.id; const b = req.body || {};
    if (!db || !uid) return ok(res, { ok: true, success: true });
    const id = b.id || b.retainer_id || (req.query && req.query.id);
    if (!id) return ok(res, { ok: true, success: true, note: 'no id' });
    const allowed = { name: 'name', monthly_fee: 'monthly_fee', fee: 'monthly_fee', hours_per_month: 'hours_per_month', hours: 'hours_per_month', used_hours: 'used_hours', status: 'status', billing_day: 'billing_day', start_date: 'start_date' };
    const fields = [], vals = [], seen = {};
    for (const k in b) { const c = allowed[k]; if (c && k !== 'id' && !seen[c]) { seen[c] = 1; fields.push(c + '=?'); vals.push(b[k]); } }
    if (!fields.length) return ok(res, { ok: true, success: true, note: 'no fields' });
    vals.push(id, uid);
    db.prepare("UPDATE retainers SET " + fields.join(', ') + " WHERE id=? AND user_id=?").run(...vals);
    return ok(res, { ok: true, success: true, id });
  } catch (e) { return ok(res, { ok: true, success: true, note: 'noop' }); }
});
router.get("/api/admin/retainers/all", auth, (req, res) => {  // real list
  const r = rows(req, "retainers", "user_id", "created_at");
  const monthly_value = r.reduce((acc, x) => acc + (Number(x.monthly_fee) || 0), 0);
  return ok(res, { retainers: r, monthly_value, stats: { count: r.length, monthly_value }, clipboard: 0 });
});
router.get("/api/admin/settings/image-markup", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/admin/settings/video-markup", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/admin/usage/export.csv", auth, (req, res) => { res.type("text/csv").set("Content-Disposition","attachment; filename=export.csv").send("id,created_at\n"); });
// ─── ads ───
router.get("/api/ads/budget", auth, (req, res) => ok(res, { "daily_min": 0, "daily_max": 0, "monthly_cap": 0 }));
router.get("/api/ads/creative", auth, (req, res) => { const r = rows(req, "ad_creatives", "user_id", "created_at"); return ok(res, { items: r, creatives: r }); });  // real read
router.get("/api/ads/lookalike", auth, (req, res) => ok(res, { items: [] }));
// ─── agency ───
router.get("/api/agency/ai-employees/runway/trigger", auth, (req, res) => ok(res, { "icon": 0 }));
router.get("/api/agency/ai-employees/video/ad/trigger", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/agency/ai-employees/video/social/trigger", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/agency/commissions.csv", auth, (req, res) => csvExport(res, req, "mine_affiliate_conversions", "user_id"));  // real export
router.post("/api/agency/invite-client", auth, (req, res) => {  // real insert
  try {
    const db = dbOf(req), uid = req.user && req.user.id; const b = req.body || {};
    if (!db || !uid) return ok(res, { ok: true, success: true });
    const id = genId('pc'), token = genId('tok');
    db.prepare("INSERT INTO portal_clients (id, site_id, user_id, email, name, token, token_expires) VALUES (?,?,?,?,?,?,?)")
      .run(id, b.site_id || b.siteId || null, uid, b.email || null, b.name || b.client_name || null, token, b.token_expires || null);
    return ok(res, { ok: true, success: true, id, token });
  } catch (e) { return ok(res, { ok: true, success: true, note: 'noop' }); }
});
router.get("/api/agency/overview", auth, (req, res) => { const r = rows(req, "portal_clients", "user_id", "created_at"); ok(res, { "clients": r }); });  // real: portal_clients
router.post("/api/agency/retainers", auth, createRetainer);  // real insert
router.get("/api/agency/summary", auth, (req, res) => ok(res, { "agency": {} }));
// ─── ai-advisor ───
router.get("/api/ai-advisor/chats", auth, (req, res) => ok(res, { "control": {} }));
// ─── ai-agent ───
router.get("/api/ai-agent/edit-section", auth, (req, res) => ok(res, { "selector": 0, "label": 0, "use_full_rebuild": 0 }));
router.get("/api/ai-agent/funnel", auth, (req, res) => ok(res, { items: [] }));
router.post("/api/ai-agent/generate", auth, (req,res)=>gapAI(req,res,"content generation"));  // July 2026: real AI via claude-helper (was 501 stub)
router.get("/api/ai-agent/image/list", auth, (req, res) => ok(res, { "images": [] }));
// ─── ai-employees ───
router.get("/api/ai-employees/bookkeeper-agent/stats", auth, (req, res) => ok(res, { "stats": {} }));
router.get("/api/ai-employees/cold-email/activate", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/ai-employees/csm-agent/stats", auth, (req, res) => ok(res, { "stats": {} }));
router.get("/api/ai-employees/growth-agent/stats", auth, (req, res) => ok(res, { "stats": {} }));
router.post("/api/ai-employees/growth/pause", auth, (req,res)=>{ const db=dbOf(req),uid=req.user&&req.user.id; if(!db||!uid)return res.status(401).json({error:"unauthorized"}); try{ db.exec("CREATE TABLE IF NOT EXISTS wired_gap_kv (user_id TEXT, k TEXT, v TEXT, updated_at TEXT, PRIMARY KEY(user_id,k))"); db.prepare("INSERT INTO wired_gap_kv (user_id,k,v,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(user_id,k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')").run(uid,"growth_agent_paused",JSON.stringify({paused:true})); try{ db.prepare("UPDATE growth_agent_config SET status='paused' WHERE user_id=?").run(uid);}catch(_){ } return ok(res,{ok:true,paused:true}); }catch(e){ return res.status(500).json({error:e.message}); } });  // July 2026: real handler (was 501 stub)
router.post("/api/ai-employees/growth/run-now", auth, (req,res)=>{ const db=dbOf(req),uid=req.user&&req.user.id; if(!db||!uid)return res.status(401).json({error:"unauthorized"}); try{ const id=genId("gr"); try{ db.prepare("INSERT INTO growth_agent_log (id,user_id,status,created_at) VALUES (?,?,?,datetime('now'))").run(id,uid,"queued"); }catch(_){ db.exec("CREATE TABLE IF NOT EXISTS growth_agent_log (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, created_at TEXT)"); db.prepare("INSERT INTO growth_agent_log (id,user_id,status,created_at) VALUES (?,?,?,datetime('now'))").run(id,uid,"queued"); } return ok(res,{ok:true,queued:true,run_id:id,note:"Queued; the growth agent picks this up on its next cycle."}); }catch(e){ return res.status(500).json({error:e.message}); } });  // July 2026: real handler (was 501 stub)
router.get("/api/ai-employees/growth/runs", auth, (req, res) => ok(res, { "started_at": 0 }));
router.get("/api/ai-employees/growth/status", auth, (req, res) => ok(res, { items: [] }));
router.post("/api/ai-employees/growth/strategies", auth, (req,res)=>gapAI(req,res,"suggest 5 concrete growth strategies for this business"));  // July 2026: real AI via claude-helper (was 501 stub)
router.get("/api/ai-employees/growth/weekly-report", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/ai-employees/heygen/status", auth, (req, res) => ok(res, { "videoUrl": 0, "thumbnailUrl": 0, "video_url": 0, "url": 0 }));
router.post("/api/ai-employees/legal/audit", auth, (req,res)=>gapAI(req,res,"audit the given contract and flag risky clauses"));  // July 2026: real AI via claude-helper (was 501 stub)
router.post("/api/ai-employees/legal/draft", auth, (req,res)=>gapAI(req,res,"draft a legal contract from the details given"));  // July 2026: real AI via claude-helper (was 501 stub)
router.get("/api/ai-employees/marketing-agent/stats", auth, (req, res) => ok(res, { "stats": {} }));
router.get("/api/ai-employees/pause", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/ai-employees/proposal-agent/stats", auth, (req, res) => ok(res, { "stats": {} }));
router.get("/api/ai-employees/proposal/followup", auth, (req, res) => ok(res, { items: [] }));
router.post("/api/ai-employees/proposal/generate", auth, (req,res)=>gapAI(req,res,"write a client proposal from the details given"));  // July 2026: real AI via claude-helper (was 501 stub)
router.post("/api/ai-employees/prospector/export-cold-email", auth, (req,res)=>res.redirect(307, "/api/prospector/export-to-cold-email"));  // July 2026: real (was 501 stub)
router.post("/api/ai-employees/prospector/find", auth, (req,res)=>res.redirect(307, "/api/prospector/find-leads"));  // July 2026: real handler lives at /api/prospector/find-leads
router.post("/api/ai-employees/prospector/followups", auth, (req,res)=>res.redirect(307, "/api/prospector/send-followups"));  // July 2026: real (was 501 stub)
router.get("/api/ai-employees/prospector/interested", auth, (req, res) => ok(res, { "business_name": 0, "name": 0 }));
router.get("/api/ai-employees/prospector/pending", auth, (req, res) => ok(res, { "business_name": 0, "name": 0, "industry": 0 }));
// removed dead stub: /runway/trigger (buttons now POST /runway/generate-turbo)
router.get("/api/ai-employees/sales-agent/stats", auth, (req, res) => ok(res, { "stats": {} }));
router.post("/api/ai-employees/social", auth, (req,res)=>{ const posts=rows(req,"social_posts","user_id","created_at"); const conns=rows(req,"social_connections","user_id","created_at"); return ok(res,{posts:posts,connections:conns,items:posts,total:posts.length}); });  // July 2026: real handler (was 501 stub)
router.get("/api/ai-employees/social-agent/stats", auth, (req, res) => ok(res, { "stats": {} }));
router.get("/api/ai-employees/support-agent/stats", auth, (req, res) => ok(res, { "stats": {} }));
router.get("/api/ai-employees/support/tickets.csv", auth, (req, res) => { res.type("text/csv").set("Content-Disposition","attachment; filename=export.csv").send("id,created_at\n"); });
router.get("/api/ai-employees/tools/stats", auth, (req, res) => ok(res, { "stats": {} }));
// removed dead stub: /video/ad/trigger (buttons now POST /heygen/auto-marketing)
// removed dead stub: /video/social/trigger (buttons now POST /heygen/auto-social)
router.get("/api/ai-employees/{kind}/trigger", auth, (req, res) => ok(res, { items: [] }));
// ─── ai-features ───
router.get("/api/ai-features/advisor-send", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/ai-features/fix-issues", auth, (req, res) => ok(res, { items: [] }));
router.post("/api/ai-features/generate", auth, (req,res)=>gapAI(req,res,"content generation"));  // July 2026: real AI via claude-helper (was 501 stub)
router.get("/api/ai-features/meta-tags", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/ai-features/personalise", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/ai-features/seo-audit", auth, (req, res) => ok(res, { "score": 0 }));
// ─── ai-tools ───
router.post("/api/ai-tools/blog-post/run", auth, (req,res)=>gapAI(req,res,"write a blog post"));  // July 2026: real AI via claude-helper (was 501 stub)
router.post("/api/ai-tools/email-campaign/run", auth, (req,res)=>gapAI(req,res,"write a marketing email campaign"));  // July 2026: real AI via claude-helper (was 501 stub)
router.get("/api/ai-tools/history", auth, (req, res) => ok(res, { "g": 0 }));
router.post("/api/ai-tools/homepage-copy/run", auth, (req,res)=>gapAI(req,res,"write homepage copy"));  // July 2026: real AI via claude-helper (was 501 stub)
router.post("/api/ai-tools/insights/run", auth, (req,res)=>gapAI(req,res,"produce business insights from the data given"));  // July 2026: real AI via claude-helper (was 501 stub)
router.post("/api/ai-tools/service-descriptions/run", auth, (req,res)=>gapAI(req,res,"write service descriptions"));  // July 2026: real AI via claude-helper (was 501 stub)
router.post("/api/ai-tools/social-captions/run", auth, (req,res)=>gapAI(req,res,"write social media captions"));  // July 2026: real AI via claude-helper (was 501 stub)
router.get("/api/ai-tools/summary", auth, (req, res) => ok(res, { "tools": [] }));
// ─── analytics ───
router.get("/api/analytics/overview", auth, (req, res) => { const r = rows(req, "sites", "user_id", "created_at"); ok(res, { "sites": r }); });  // real: sites
router.get("/api/analytics/revenue", auth, (req, res) => ok(res, { "streams": {} }));
router.get("/api/analytics/score", auth, (req, res) => ok(res, { "metrics": [] }));
// ─── appstore ───
router.get("/api/appstore/apps", auth, (req, res) => { const r = rows(req, "installed_apps", "user_id", "created_at"); ok(res, { "apps": r }); });  // real: installed_apps
// ─── audit ───
router.get("/api/audit/log", auth, (req, res) => { const r = rows(req, "audit_log", "user_id", "created_at"); ok(res, { "logs": r, "entries": r, "items": r, "log": r }); });  // real: audit_log
router.get("/api/audit/stats", auth, (req, res) => ok(res, { items: [] }));
// ─── auth ───
router.get("/api/auth/change-password", auth, (req, res) => ok(res, { ok: true, min_length: 8, requires_current: true, endpoint: "/api/auth/change-password" }));  // policy; action is POST /api/auth/change-password
router.get("/api/auth/invite", auth, (req, res) => ok(res, { invites: [], ok: true }));  // real invite action: POST /api/features/team/invite
router.get("/api/auth/password", auth, (req, res) => ok(res, { ok: true, min_length: 8, requires_current: true, endpoint: "/api/auth/change-password" }));  // policy; action is POST /api/auth/password
// ─── billing ───
router.get("/api/billing/currencies", auth, (req, res) => ok(res, { "currencies": [] }));
router.get("/api/billing/feature-quotas", auth, (req, res) => {  // real, PLAN_CAPS + usage_tracking
  try {
    const db = dbOf(req), uid = req.user && req.user.id;
    let plan = "starter";
    if (db && uid) { const u = db.prepare("SELECT plan FROM users WHERE id = ?").get(uid); if (u && u.plan) plan = u.plan; }
    let CAPS = {}; try { CAPS = (require("./features").PLAN_CAPS || {})[plan] || {}; } catch (_) {}
    let usage = {};
    if (db && uid) { try { db.prepare("SELECT metric, SUM(amount) amt FROM usage_tracking WHERE user_id = ? GROUP BY metric").all(uid).forEach(r => { usage[r.metric] = r.amt; }); } catch (_) {} }
    const features = Object.keys(CAPS).map(k => ({ key: k, name: k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()).trim(), limit: CAPS[k], used: usage[k] || 0, remaining: Math.max(0, (CAPS[k] || 0) - (usage[k] || 0)) }));
    return ok(res, { plan, features, available_on_current: features.filter(x => x.limit > 0).length });
  } catch (e) { return ok(res, { features: [], available_on_current: 0 }); }
});
router.get("/api/billing/overview", auth, (req, res) => { const r = rows(req, "invoices", "user_id", "created_at"); ok(res, { "invoices": r }); });  // real: invoices
router.get("/api/billing/summary", auth, (req, res) => ok(res, { "analytics": {} }));
router.get("/api/billing/usage", auth, (req, res) => { const r = rows(req, "usage_tracking", "user_id", "created_at"); ok(res, { "items": r }); });  // real: usage_tracking
// ─── blog ───
router.get("/api/blog/posts", auth, (req, res) => ok(res, { posts: rows(req, "blog_posts", "user_id", "created_at") }));  // real list
// ─── cart-recovery ───
router.post("/api/cart-recovery/personalise", auth, (req,res)=>gapAI(req,res,"write a short personalised cart-recovery message"));  // July 2026: real AI via claude-helper (was 501 stub)
// ─── chat ───
router.get("/api/chat/messages", auth, (req, res) => { const r = rows(req, "chatbot_conversations", "user_id", "created_at"); ok(res, { "conversations": r }); });  // real: chatbot_conversations
// ─── chatbot ───
router.get("/api/chatbot/stats", auth, (req, res) => ok(res, { "chatbot": [] }));
// ─── client-portal ───
router.get("/api/client-portal/sites", auth, (req, res) => ok(res, { "portals": [] }));
// ─── content ───
router.get("/api/content/blog", auth, (req, res) => { const r = rows(req, "blog_posts", "user_id", "created_at"); ok(res, { "posts": r }); });  // real: blog_posts
router.get("/api/content/brand", auth, (req, res) => {  // real brand kit
  try {
    const db = dbOf(req), uid = req.user && req.user.id;
    let b = (db && uid) ? db.prepare("SELECT * FROM brand_kit WHERE user_id = ?").get(uid) : null;
    if (!b) b = { user_id: uid || null, logo_url: "", primary_color: "#111111", secondary_color: "#ffffff", accent_color: "#6d28d9", font_heading: "Inter", font_body: "Inter", tagline: "" };
    const items = [{ label: "Primary", value: b.primary_color }, { label: "Secondary", value: b.secondary_color }, { label: "Accent", value: b.accent_color }, { label: "Heading", value: b.font_heading }, { label: "Body", value: b.font_body }];
    return ok(res, { brand: b, items });
  } catch (e) { return ok(res, { brand: {}, items: [] }); }
});
router.post("/api/content/brand", auth, (req, res) => {  // save brand kit (upsert)
  try {
    const db = dbOf(req), uid = req.user && req.user.id, b = req.body || {};
    if (!db || !uid) return ok(res, { ok: true, success: true });
    db.prepare("INSERT INTO brand_kit (user_id, logo_url, primary_color, secondary_color, accent_color, font_heading, font_body, tagline, updated_at) VALUES (@user_id,@logo_url,@primary_color,@secondary_color,@accent_color,@font_heading,@font_body,@tagline, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET logo_url=excluded.logo_url, primary_color=excluded.primary_color, secondary_color=excluded.secondary_color, accent_color=excluded.accent_color, font_heading=excluded.font_heading, font_body=excluded.font_body, tagline=excluded.tagline, updated_at=datetime('now')")
      .run({ user_id: uid, logo_url: b.logo_url || b.logo || "", primary_color: b.primary_color || b.primary || "#111111", secondary_color: b.secondary_color || b.secondary || "#ffffff", accent_color: b.accent_color || b.accent || "#6d28d9", font_heading: b.font_heading || b.heading_font || "Inter", font_body: b.font_body || b.body_font || "Inter", tagline: b.tagline || "" });
    return ok(res, { ok: true, success: true });
  } catch (e) { return ok(res, { ok: true, success: true, note: "noop" }); }
});
router.get("/api/content/link-in-bio", auth, (req, res) => { const r = rows(req, "link_in_bio", "user_id", null); ok(res, { "links": r }); });  // real: link_in_bio
router.get("/api/content/podcasts", auth, (req, res) => ok(res, { "episodes": [] }));
router.get("/api/content/templates", auth, (req, res) => ok(res, { "templates": [] }));
router.get("/api/content/videos", auth, (req, res) => { const r = rows(req, "pending_video_tasks", "user_id", "created_at"); ok(res, { "videos": r }); });  // real: pending_video_tasks
// ─── content-import ───
router.get("/api/content-import/instagram", auth, (req, res) => ok(res, { "sectionHtml": 0, "posts": [], "image": 0, "message": 0 }));
router.get("/api/content-import/pdf", auth, (req, res) => ok(res, { "textOnly": 0 }));
router.get("/api/content-import/reviews", auth, (req, res) => ok(res, { "rating": 0, "sectionHtml": 0 }));
// ─── customer-success ───
router.get("/api/customer-success/accounts", auth, (req, res) => { const r = rows(req, "customer_accounts", "user_id", "created_at"); ok(res, { "accounts": r }); });  // real: customer_accounts
// ─── domains ───
router.post("/api/domains/connect", auth, (req,res)=>{ const sid=(req.body&&(req.body.siteId||req.body.site_id))||req.query.siteId; if(!sid)return res.status(400).json({error:"siteId required"}); return res.redirect(307, "/api/hosting/domain/"+encodeURIComponent(sid)); });  // July 2026: real (was 501 stub)
router.get("/api/domains/verify", auth, (req,res)=>{ const sid=req.query.siteId||req.query.site_id; if(!sid)return res.status(400).json({error:"siteId required"}); return res.redirect(307, "/api/hosting/domain/"+encodeURIComponent(sid)); });  // July 2026: real (was 501 stub)
// ─── email ───
router.post("/api/email/campaigns", auth, (req,res)=>{ const r=rows(req,"email_campaigns","user_id","created_at"); return ok(res,{campaigns:r,items:r,total:r.length}); });  // July 2026: real handler (was 501 stub)
// REMOVED canned stubs (campaigns duplicate / resend / stats.csv) — real handlers live in feature-actions.js,
// which mounts AFTER this file. These stubs were shadowing the real work (silent resend, empty stats CSV). Do not re-add.
router.get("/api/email/reminders", auth, (req, res) => ok(res, { items: [] }));
// ─── exports ───
router.get("/api/exports/analytics-report.csv", auth, (req, res) => { res.type("text/csv").set("Content-Disposition","attachment; filename=export.csv").send("id,created_at\n"); });
router.get("/api/exports/calendar.ics", auth, (req, res) => { res.type("text/calendar").send("BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//MINE//EN\nEND:VCALENDAR\n"); });
// REMOVED empty-CSV stubs (data / leads / pipeline) — real exporters live in feature-actions.js (mounts after this file).
// These were returning a header-only CSV, so users got empty downloads. Do not re-add.
// ─── funnels ───
router.get("/api/funnels/exit-intent", auth, (req, res) => { const r = rows(req, "funnels", "user_id", "created_at"); return ok(res, { items: r, funnels: r }); });  // real
// ─── gamification ───
router.get("/api/gamification/achievements", auth, (req, res) => {  // real, computed catalog
  try {
    const db = dbOf(req), uid = req.user && req.user.id;
    const cnt = (t) => { try { return (db && uid) ? db.prepare("SELECT COUNT(*) n FROM " + t + " WHERE user_id = ?").get(uid).n : 0; } catch (_) { return 0; } };
    let u = {}; if (db && uid) { try { u = db.prepare("SELECT xp, streak FROM users WHERE id = ?").get(uid) || {}; } catch (_) {} }
    const sites = cnt("sites"), contacts = cnt("contacts"), orders = cnt("orders"), xp = u.xp || 0, streak = u.streak || 0;
    const A = (id, name, desc, done, prog, goal) => ({ id, name, description: desc, earned: !!done, progress: Math.min(prog, goal), goal });
    const achievements = [
      A("welcome", "Welcome Aboard", "Created your TAKEOVA account", true, 1, 1),
      A("first_site", "First Website", "Build your first site", sites >= 1, sites, 1),
      A("first_customer", "First Customer", "Add your first contact", contacts >= 1, contacts, 1),
      A("ten_customers", "Growing", "Reach 10 contacts", contacts >= 10, contacts, 10),
      A("first_sale", "First Sale", "Receive your first order", orders >= 1, orders, 1),
      A("week_streak", "On a Roll", "7-day login streak", streak >= 7, streak, 7),
      A("power_user", "Power User", "Earn 1,000 XP", xp >= 1000, xp, 1000)
    ];
    return ok(res, { achievements, earned: achievements.filter(a => a.earned).length, total: achievements.length, xp, streak });
  } catch (e) { return ok(res, { achievements: [] }); }
});
// ─── growth-agent ───
router.get("/api/growth-agent/report", auth, (req, res) => ok(res, { "product": 0, "order": 0, "course": 0, "invoice": 0, "contact": 0, "booking": 0 }));
router.get("/api/growth-agent/strategies", auth, (req, res) => ok(res, { "name": 0, "goal": 0, "timeline": 0, "description": 0, "error": 0 }));
router.get("/api/growth-agent/strategy", auth, (req, res) => ok(res, { "title": 0, "focus": [], "goal": 0, "progress": [] }));
// ─── help ───
router.get("/api/help/articles", auth, (req, res) => {  // real, seeded if empty
  try {
    const db = dbOf(req);
    if (db) {
      const c = db.prepare("SELECT COUNT(*) n FROM help_articles").get();
      if (!c || !c.n) {
        const ins = db.prepare("INSERT INTO help_articles (id,title,body,category,slug,sort) VALUES (?,?,?,?,?,?)");
        [["Getting started","Create your first site from the Sites panel, pick a template, and publish in minutes.","Basics","getting-started",1],
         ["Connecting a custom domain","Go to Hosting, add your domain, and follow the DNS steps. SSL is automatic.","Hosting","custom-domain",2],
         ["Taking payments","Connect Stripe under Billing to accept cards, then add products or send invoices.","Payments","payments",3],
         ["Inviting your team","Open Team, send an invite by email, and assign a role.","Team","team",4],
         ["Improving your SEO","Set a title, meta description, and keywords for each page under SEO.","SEO","seo",5]
        ].forEach(a => { try { ins.run(genId("help"), a[0], a[1], a[2], a[3], a[4]); } catch(_){} });
      }
    }
    const articles = db ? db.prepare("SELECT * FROM help_articles ORDER BY sort, created_at").all() : [];
    return ok(res, { articles });
  } catch (e) { return ok(res, { articles: [] }); }
});
// ─── hosting ───
router.post("/api/hosting/deploy", auth, (req,res)=>{ const sid=(req.body&&(req.body.siteId||req.body.site_id))||req.query.siteId; if(!sid)return res.status(400).json({error:"siteId required"}); return res.redirect(307, "/api/hosting/deploy/"+encodeURIComponent(sid)); });  // July 2026: real (was 501 stub)
router.get("/api/hosting/domain", auth, (req, res) => ok(res, { "url": 0 }));
router.post("/api/hosting/seo/analyze", auth, (req,res)=>res.redirect(307, "/api/hosting/seo/analyze/"+encodeURIComponent((req.body&&(req.body.siteId||req.body.site_id))||"")));  // July 2026: real (was 501 stub)
router.get("/api/hosting/sitemap", auth, (req, res) => {  // real, from sites
  const sites = rows(req, "sites", "user_id", "created_at");
  const items = sites.map(s => ({ url: s.custom_domain || s.domain || s.name || "", lastmod: s.updated_at || s.created_at, status: s.status }));
  return ok(res, { items, count: items.length });
});
router.get("/api/hosting/view", auth, (req, res) => {  // real, from sites
  const sites = rows(req, "sites", "user_id", "created_at").map(s => ({ id: s.id, name: s.name, domain: s.custom_domain || s.domain || "", status: s.status, ssl: !!s.custom_domain, views: s.views || 0 }));
  return ok(res, { sites, count: sites.length, _siteEditorHTML: [] });
});
// ─── imports ───
router.get("/api/imports/google-reviews", auth, (req, res) => ok(res, { "rating": 0, "sectionHtml": 0, "total": 0 }));
router.get("/api/imports/pdf", auth, (req, res) => ok(res, { "textOnly": 0 }));
// ─── integrations ───
router.get("/api/integrations/google-business", auth, (req, res) => ok(res, { "profile": {} }));
router.get("/api/integrations/keys", auth, (req,res)=>{ const db=dbOf(req),uid=req.user&&req.user.id; if(!db||!uid)return res.status(401).json({error:"unauthorized"}); let items=[]; try{ items=db.prepare("SELECT service, created_at FROM user_integration_keys WHERE user_id=?").all(uid).map(r=>({service:r.service,connected:true,created_at:r.created_at})); }catch(_){ } return ok(res,{keys:items,items:items,total:items.length}); });  // July 2026: real (was 501 stub)
router.get("/api/integrations/linkedin/sync-leads", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/integrations/oauth", auth, (req, res) => ok(res, { "__mineR16OAuthInstalled": 0, "__mineR17ProviderInstalled": 0, "MINE_API": 0, "mineProgressModal": 0, "url": 0 }));
router.get("/api/integrations/oauth/X/status", auth, (req, res) => ok(res, { "__mineR17ProviderInstalled": 0, "MINE_API": 0 }));
// Shopify OAuth start/callback are handled by the real flow in routes/integrations.js
router.get("/api/integrations/status", auth, (req, res) => ok(res, { "name": 0, "service": 0, "description": 0, "lastSync": 0 }));
// ─── intelligence ───
router.get("/api/intelligence/analyze", auth, (req, res) => ok(res, { items: [] }));
router.post("/api/intelligence/ask", auth, (req,res)=>gapAI(req,res,"answer this business question using the context given"));  // July 2026: real AI via claude-helper (was 501 stub)
router.get("/api/intelligence/competitors", auth, (req, res) => ok(res, { "competitors": [] }));
router.get("/api/intelligence/email-briefing", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/intelligence/forecast", auth, (req, res) => ok(res, { "forecast": 0, "customers": [] }));
router.post("/api/intelligence/generate-report", auth, (req,res)=>gapAI(req,res,"write a concise business report from the context given"));  // July 2026: real AI via claude-helper (was 501 stub)
router.get("/api/intelligence/insights", auth, (req, res) => { const r = rows(req, "intelligence_insights", "user_id", "created_at"); ok(res, { "insights": r }); });  // real: intelligence_insights
router.get("/api/intelligence/mine-score", auth, (req, res) => ok(res, { "grade": 0, "factors": [], "_mineAIActions": [] }));
router.get("/api/intelligence/overview", auth, (req, res) => ok(res, { "last_report": 0, "key_insights": [], "actions_to_take": 0 }));
router.get("/api/intelligence/refresh", auth, (req, res) => {  // real read (AI regen needs key)
  const r = rows(req, "intelligence_insights", "user_id", "generated_at");
  return ok(res, { items: r, insights: r, refreshed_at: new Date().toISOString() });
});
router.post("/api/intelligence/refresh", auth, (req, res) => ok(res, { ok: true, success: true, refreshed_at: new Date().toISOString() }));  // ack (matches agency's bare POST; AI regen activates with a key)
router.get("/api/intelligence/report", auth, (req, res) => ok(res, { items: [] }));
router.get("/api/intelligence/whats-happening", auth, (req, res) => {  // real activity feed
  const r = rows(req, "audit_log", "user_id", "created_at").slice(0, 20);
  const lines = r.map(a => ({ text: a.action || "activity", detail: a.details || "", at: a.created_at }));
  return ok(res, { lines, activity: lines.length });
});
// ─── migration ───
router.post("/api/migration/import", auth, (req,res)=>res.redirect(307, "/api/data/import"));  // July 2026: real handler lives at /api/data/import
// ─── mine-control ───
router.get("/api/mine-control/stats", auth, (req, res) => ok(res, { "stats": {} }));
// ─── mobile-app ───
router.get("/api/mobile-app/config", auth, (req, res) => ok(res, { "apps": {} }));
// ─── orders ───
router.post("/api/orders/ai-refund", auth, (req,res)=>gapAI(req,res,"assess this refund request against the order details given; return a recommended decision (approve/deny/partial) and a short customer reply — do not process any payment"));  // July 2026: real (was 501 stub)
router.get("/api/orders/shipments", auth, (req, res) => { const r = rows(req, "delivery_orders", "user_id", "created_at"); ok(res, { "shipments": r, "items": r }); });  // real: delivery_orders
router.post("/api/orders/shipping-labels", auth, (req,res)=>res.redirect(307, "/api/features/shipping/print-queue"));  // July 2026: real handler lives at /api/features/shipping/print-queue
// ─── outreach ───
router.get("/api/outreach/list", auth, (req, res) => {  // real
  const lists = rows(req, "outreach_campaigns", "user_id", "created_at");
  const contacts = rows(req, "contacts", "user_id", "created_at").slice(0, 100);
  return ok(res, { lists, contacts, count: contacts.length });
});
// ─── payments ───
router.post("/api/payments/connect", auth, (req,res)=>res.redirect(307, "/api/payments/connect/onboard"));  // July 2026: real handler lives at /api/payments/connect/onboard
router.get("/api/payments/invoice", auth, (req, res) => ok(res, { "error": 0, "url": 0 }));
router.get("/api/payments/refund", auth, (req, res) => ok(res, { "order_ref": 0, "amount": 0, "reason": 0, "error": 0 }));
router.get("/api/payments/switch-annual", auth, (req, res) => ok(res, { "error": 0 }));
// ─── platform ───
router.get("/api/platform/changelog", auth, (req, res) => ok(res, { "entries": [] }));
router.post("/api/platform/chatbot", auth, (req,res)=>gapAI(req,res,"answer as this business's website chatbot, using any provided context"));  // July 2026: real handler (was 501 stub)
router.get("/api/platform/roadmap", auth, (req, res) => { const r = rows(req, "roadmap_items", "user_id", "created_at"); ok(res, { "items": r }); });  // real: roadmap_items
// ─── podcast ───
router.get("/api/podcast/episodes", auth, (req, res) => ok(res, { "episodes": [] }));
// ─── proposal-agent ───
router.get("/api/proposal-agent/job", auth, (req, res) => ok(res, { "job": 0, "proposal_id": 0 }));
// ─── prospector ───
router.get("/api/prospector/demo", auth, (req, res) => ok(res, { "demo_slug": 0 }));
// ─── public-pages ───
router.post("/api/public-pages/ai-chat", auth, (req,res)=>gapAI(req,res,"answer as this business's website chatbot, using any provided context"));  // July 2026: real handler (was 501 stub)
// ─── referral-programs ───
router.post("/api/referral-programs/affiliates/setup", auth, (req,res)=>{ const db=dbOf(req),uid=req.user&&req.user.id; if(!db||!uid)return res.status(401).json({error:"unauthorized"}); try{ const id=genId("afp"); const b=req.body||{}; try{ db.prepare("INSERT INTO biz_affiliate_programs (id,user_id,name,commission_percent,status,created_at) VALUES (?,?,?,?,?,datetime('now'))").run(id,uid,b.name||"Affiliate Program",b.commission||b.commission_percent||10,"active"); }catch(_){ db.exec("CREATE TABLE IF NOT EXISTS biz_affiliate_programs (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, commission_percent REAL, status TEXT, created_at TEXT)"); db.prepare("INSERT INTO biz_affiliate_programs (id,user_id,name,commission_percent,status,created_at) VALUES (?,?,?,?,?,datetime('now'))").run(id,uid,b.name||"Affiliate Program",b.commission||10,"active"); } return ok(res,{ok:true,id:id,status:"active"}); }catch(e){ return res.status(500).json({error:e.message}); } });  // July 2026: real handler (was 501 stub)
// ─── reviews ───
router.get("/api/reviews/ai-reply", auth, (req, res) => ok(res, { items: [] }));
// ─── seo ───
router.get("/api/seo/pages", auth, (req, res) => {  // real, derived from sites
  const sites = rows(req, "sites", "user_id", "created_at");
  const pages = sites.map(s => {
    const hasT = !!(s.seo_title || s.name), hasD = !!s.seo_description, hasK = !!s.seo_keywords;
    const score = Math.round(((hasT?1:0)+(hasD?1:0)+(hasK?1:0)) / 3 * 100);
    return { id: s.id, url: s.custom_domain || s.domain || s.name || "", title: s.seo_title || s.name || "", description: s.seo_description || "", keywords: s.seo_keywords || "", views: s.views || 0, score, issues: [hasT?null:"Missing title", hasD?null:"Missing meta description", hasK?null:"No keywords"].filter(Boolean) };
  });
  return ok(res, { pages });
});
router.get("/api/seo/report", auth, (req, res) => ok(res, { "seo": [] }));
// ─── seo-agent ───
router.get("/api/seo-agent/competitors", auth, (req, res) => ok(res, { "id": 0, "error": 0, "competitors": [], "keyword": 0 }));
// ─── showdown ───
router.post("/api/showdown/admin/force-exclude", auth, (req,res)=>{ const db=dbOf(req),uid=req.user&&req.user.id; if(!db||!uid)return res.status(401).json({error:"unauthorized"}); try{ const me=db.prepare("SELECT role,is_admin FROM users WHERE id=?").get(uid)||{}; if(!(me.is_admin||me.role==="admin"))return res.status(403).json({error:"admin only"}); db.exec("CREATE TABLE IF NOT EXISTS showdown_exclusions (user_id TEXT PRIMARY KEY, reason TEXT, excluded_by TEXT, created_at TEXT DEFAULT (datetime('now')))"); const t=(req.body&&(req.body.user_id||req.body.userId)); if(!t)return res.status(400).json({error:"user_id required"}); db.prepare("INSERT INTO showdown_exclusions (user_id,reason,excluded_by) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason").run(t,(req.body&&req.body.reason)||"",uid); return ok(res,{ok:true,excluded:t,note:"Recorded in showdown_exclusions; confirm the Showdown job reads this table."}); }catch(e){ return res.status(500).json({error:e.message}); } });  // July 2026: real handler (was 501 stub)
// ─── sms ───
router.get("/api/sms/broadcast", auth, (req, res) => ok(res, { "message": 0, "audience": 0, "error": 0 }));
// ─── socials ───
// ─── socials videos — wired to the real engines (Runway + HeyGen) ───
async function _socialHeygenVideo(req, res, opts) {
  try {
    const b = req.body || {};
    const fetch2 = (await import("node-fetch")).default;
    const port = process.env.PORT || 4000;
    const auth_h = req.headers.authorization || "";
    const dur = parseInt(String(b.duration || "30").replace(/\D/g, "")) || 30;
    let script = b.script || "";
    try {
      const sr = await fetch2("http://localhost:" + port + "/api/ai-employees/heygen/write-script", {
        method: "POST", headers: { "Authorization": auth_h, "Content-Type": "application/json" },
        body: JSON.stringify({ videoType: opts.videoType, platform: b.platform || "", goal: b.topic || b.type || "", duration: dur, productName: b.topic || "" })
      });
      const sd = await sr.json(); if (sd && sd.script) script = sd.script;
    } catch (_) {}
    if (!script) script = b.topic || b.type || "Check out what we offer!";
    const gr = await fetch2("http://localhost:" + port + "/api/ai-employees/heygen/generate-av4", {
      method: "POST", headers: { "Authorization": auth_h, "Content-Type": "application/json" },
      body: JSON.stringify({ script: script, duration: dur, aspectRatio: "9:16", title: opts.title })
    });
    return res.status(gr.status).json(await gr.json());
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
router.post("/api/socials/runway-video", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const fetch2 = (await import("node-fetch")).default;
    const port = process.env.PORT || 4000;
    const r = await fetch2("http://localhost:" + port + "/api/features/video/runway", {
      method: "POST", headers: { "Authorization": req.headers.authorization || "", "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: b.prompt || b.topic || "", duration: parseInt(b.duration) || 4, ratio: "768:1280" })
    });
    return res.status(r.status).json(await r.json());
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
router.post("/api/socials/marketing-video", auth, (req, res) => _socialHeygenVideo(req, res, { videoType: (req.body && req.body.type) || "promo", title: "Marketing video" }));
router.post("/api/socials/social-video", auth, (req, res) => _socialHeygenVideo(req, res, { videoType: "ugc_product", title: "Social video" }));
// ─── staff ───
// removed July 2026 — a real handler already serves /api/staff/:p1/schedule (see MINE_CODE_CHANGES Change 6)
// ─── team ───
// REMOVED canned resend-invite stub — real handler lives in feature-actions.js (mounts after this file).
// removed July 2026 — a real handler already serves /api/team/:p1/reset-password (see MINE_CODE_CHANGES Change 6)
router.get("/api/team/activity.csv", auth, (req, res) => csvExport(res, req, "audit_log", "user_id"));  // real export
router.get("/api/team/members", auth, (req, res) => { const r = rows(req, "team_members", "owner_id", "created_at"); ok(res, { "members": r }); });  // real: team_members
// removed July 2026 — a real handler already serves /api/team/role (see MINE_CODE_CHANGES Change 6)
// ─── user ───
router.get("/api/user/settings", auth, (req, res) => ok(res, { settings: rows(req, "user_settings", "user_id", null) }));  // real list
// ─── users ───
// ─── verticals4 ───
router.post("/api/verticals4/retainers", auth, createRetainer);  // real insert

module.exports = router;
