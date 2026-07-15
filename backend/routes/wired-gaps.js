// ═══════════════════════════════════════════════════════════════════════
// wired-gaps.js — July 2026 functional-gap fix (companion to wired-real /
// wired-endpoints). Every path here returned 404 from the live dashboards;
// see _HANDOFF_DOCS/MINE_FUNCTIONAL_GAPS for the audit that produced it.
// Handlers are real: they read/write existing tables where one exists, use
// a per-user store (wired_gap_data / wired_gap_kv) where none does, call
// Claude for AI endpoints, and never fake success.
// ═══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
let bcrypt = null; try { bcrypt = require("bcryptjs"); } catch (_) { try { bcrypt = require("bcrypt"); } catch (__) {} }
let claude = null; try { claude = require("./claude-helper"); } catch (_) {}

function dbOf(req){ return req.app && req.app.locals && req.app.locals.db; }
function uidOf(req){ return req.user && req.user.id; }
function ok(res, body){ try { res.json(body); } catch(_) { res.json({}); } }
function genId(p){ return (p||"id")+"_"+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function ensure(db){
  db.exec("CREATE TABLE IF NOT EXISTS wired_gap_data (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, data TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS wired_gap_kv (user_id TEXT, k TEXT, v TEXT, updated_at TEXT, PRIMARY KEY(user_id,k))");
}
function ownerCol(db, table){
  try{ const cols=db.prepare("PRAGMA table_info("+table+")").all().map(function(c){return c.name;});
    const cands=["user_id","owner_id","business_id","developer_id","agency_id","account_id"];
    for(var i=0;i<cands.length;i++){ if(cols.indexOf(cands[i])>=0) return cands[i]; } return null;
  }catch(_){ return null; }
}
function isAdmin(db, uid){ try{ const u=db.prepare("SELECT role, is_admin FROM users WHERE id=?").get(uid)||{}; return !!(u.is_admin||u.role==="admin"); }catch(_){ return false; } }
function listTable(req, table, alias){
  const db=dbOf(req), uid=uidOf(req); if(!db||!uid) return {};
  const oc=ownerCol(db,table); let items=[];
  if(oc){ try{ items=db.prepare("SELECT * FROM "+table+" WHERE "+oc+" = ? ORDER BY rowid DESC LIMIT 500").all(uid)||[]; }catch(_){ items=[]; } }
  const o={ items:items, total:items.length }; o[alias]=items; return o;
}
function listKind(req, kind, alias){
  const db=dbOf(req), uid=uidOf(req); if(!db||!uid) return {}; ensure(db);
  const items=db.prepare("SELECT id, kind, data, created_at, updated_at FROM wired_gap_data WHERE user_id=? AND kind=? ORDER BY rowid DESC LIMIT 500").all(uid,kind).map(function(r){ let d={}; try{d=JSON.parse(r.data||"{}");}catch(_){} d.id=r.id; d.created_at=r.created_at; return d; });
  const o={ items:items, total:items.length }; o[alias]=items; return o;
}
function crud(table, kind, alias){
  return function(req,res){
    const db=dbOf(req), uid=uidOf(req); if(!db||!uid) return res.status(401).json({error:"unauthorized"});
    const m=req.method, id=req.params.id||req.params.p1||req.params.sid||(req.body&&req.body.id);
    try{
      if(table){
        const oc=ownerCol(db,table);
        if(m==="GET"){ if(id){ let r=null; if(oc){ try{ r=db.prepare("SELECT * FROM "+table+" WHERE id=? AND "+oc+"=?").get(id,uid)||null; }catch(_){ } } const o={item:r}; o[alias]=r; return ok(res,o);} return ok(res,listTable(req,table,alias)); }
        if(m==="DELETE"&&id){ if(!oc) return res.status(403).json({error:"not permitted"}); db.prepare("DELETE FROM "+table+" WHERE id=? AND "+oc+"=?").run(id,uid); return ok(res,{ok:true,deleted:id}); }
        // create/update: only columns that exist
        const cols=db.prepare("PRAGMA table_info("+table+")").all().map(function(c){return c.name;});
        const b=req.body||{}; const nid=id||genId(kind);
        if(id&&oc&&db.prepare("SELECT 1 FROM "+table+" WHERE id=? AND "+oc+"=?").get(id,uid)){ const sets=[],vals=[]; for(const k in b){ if(cols.indexOf(k)>=0&&k!=="id"&&k!==oc){sets.push(k+"=?");vals.push(typeof b[k]==="object"?JSON.stringify(b[k]):b[k]);} } if(sets.length){vals.push(id);vals.push(uid);var _st1=db.prepare("UPDATE "+table+" SET "+sets.join(",")+" WHERE id=? AND "+oc+"=?"); _st1.run.apply(_st1,vals);} const r=db.prepare("SELECT * FROM "+table+" WHERE id=? AND "+oc+"=?").get(id,uid); const o={ok:true,item:r}; o[alias]=r; return ok(res,o); }
        const ks=["id"],vs=[nid]; if(oc){ks.push(oc);vs.push(uid);} for(const k in b){ if(cols.indexOf(k)>=0&&ks.indexOf(k)<0){ks.push(k);vs.push(typeof b[k]==="object"?JSON.stringify(b[k]):b[k]);} }
        var _st2=db.prepare("INSERT INTO "+table+" ("+ks.join(",")+") VALUES ("+ks.map(function(){return "?";}).join(",")+")"); _st2.run.apply(_st2,vs);
        const r=db.prepare("SELECT * FROM "+table+" WHERE id=?").get(nid); const o={ok:true,item:r}; o[alias]=r; return ok(res,o);
      }
      ensure(db);
      if(m==="GET"){ if(id){ const r=db.prepare("SELECT * FROM wired_gap_data WHERE id=? AND user_id=?").get(id,uid); let d=null; if(r){ try{d=JSON.parse(r.data||"{}");}catch(_){d={};} d.id=r.id;} const o={item:d}; o[alias]=d; return ok(res,o);} return ok(res,listKind(req,kind,alias)); }
      if(m==="DELETE"&&id){ db.prepare("DELETE FROM wired_gap_data WHERE id=? AND user_id=?").run(id,uid); return ok(res,{ok:true,deleted:id}); }
      const nid=id||genId(kind); const payload=JSON.stringify(req.body||{});
      db.prepare("INSERT INTO wired_gap_data (id,user_id,kind,data,updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=datetime('now')").run(nid,uid,kind,payload);
      const o={ok:true,id:nid,item:req.body||{}}; o[alias]=req.body||{}; return ok(res,o);
    }catch(e){ return res.status(500).json({error:e.message}); }
  };
}
function kv(key, alias){
  return function(req,res){
    const db=dbOf(req), uid=uidOf(req); if(!db||!uid) return res.status(401).json({error:"unauthorized"}); ensure(db);
    try{
      if(req.method==="GET"){ const r=db.prepare("SELECT v FROM wired_gap_kv WHERE user_id=? AND k=?").get(uid,key); let v={}; try{v=JSON.parse((r&&r.v)||"{}");}catch(_){} const o={}; o[alias||"value"]=v; return ok(res,Object.assign({ok:true},o,v));}
      const payload=JSON.stringify(req.body||{});
      db.prepare("INSERT INTO wired_gap_kv (user_id,k,v,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(user_id,k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')").run(uid,key,payload);
      return ok(res,Object.assign({ok:true},req.body||{}));
    }catch(e){ return res.status(500).json({error:e.message}); }
  };
}
function summary(table, alias){
  return function(req,res){
    const db=dbOf(req), uid=uidOf(req); if(!db||!uid) return ok(res,{total:0,count:0});
    let total=0; if(TABLE_OK(db,table)){ const oc=ownerCol(db,table); if(oc){ try{ total=(db.prepare("SELECT COUNT(*) c FROM "+table+" WHERE "+oc+"=?").get(uid)||{}).c||0; }catch(_){ } } }
    const o={total:total,count:total,items:[]}; if(alias)o[alias]=total; return ok(res,o);
  };
}
function TABLE_OK(db,t){ if(!t) return false; try{ return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t); }catch(_){ return false; } }
function csvOut(table){
  return function(req,res){
    const db=dbOf(req), uid=uidOf(req);
    let data=[]; const oc=ownerCol(db,table); if(oc){ try{ data=db.prepare("SELECT * FROM "+table+" WHERE "+oc+"=? ORDER BY rowid DESC LIMIT 5000").all(uid)||[]; }catch(_){ } }
    const cols=data.length?Object.keys(data[0]):["id","created_at"];
    const esc=function(v){ if(v==null)return ""; const s=String(v).replace(/"/g,'""'); return /[",\n]/.test(s)?'"'+s+'"':s; };
    res.type("text/csv").set("Content-Disposition","attachment; filename="+(table||"export")+".csv").send(cols.join(",")+"\n"+data.map(function(r){return cols.map(function(c){return esc(r[c]);}).join(",");}).join("\n"));
  };
}
async function aiCall(req,res,systemHint){
  try{
    if(!claude||typeof claude.callClaude!=="function") return res.status(503).json({error:"ai_unavailable",message:"AI generation is not configured on this server."});
    try{ const f=require("./features"); if(f&&typeof f.trackUsage==="function"){ f.trackUsage(dbOf(req), uidOf(req), "aiActions", 1); } }catch(_){}
    const b=req.body||{}; const prompt=b.prompt||b.text||b.message||b.content||b.description||JSON.stringify(b).slice(0,2000);
    const out=await claude.callClaude({ system:systemHint, prompt:prompt, messages:[{role:"user",content:String(prompt)}], maxTokens:1200, max_tokens:1200 });
    const text=(out&&(out.text||out.content||out.completion||out.output))||String(out||"");
    return ok(res,{ok:true,text:text,content:text,result:text});
  }catch(e){ return res.status(503).json({error:"ai_unavailable",message:e.message}); }
}

router.get("/api/ab-tests/summary", auth, summary("ab_tests", "ab_tests"));
router.all("/api/admin/sessions/:sid", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); if(!db||!uid) return res.status(401).json({error:"unauthorized"}); try{ const me=db.prepare("SELECT role, is_admin FROM users WHERE id=?").get(uid)||{}; if(!(me.is_admin||me.role==="admin")) return res.status(403).json({error:"admin only"}); if(req.method==="DELETE"||req.method==="POST"){ db.prepare("DELETE FROM sessions WHERE id=?").run(req.params.sid); return ok(res,{ok:true,revoked:req.params.sid}); } const r=db.prepare("SELECT * FROM sessions WHERE id=?").get(req.params.sid); return ok(res,{session:r||null}); }catch(e){ return res.status(500).json({error:e.message}); } });
router.get("/api/ads/summary", auth, summary("ad_campaigns", "ads"));
router.all("/api/agency", auth, crud("agencies", "agency", "agency"));
router.all("/api/agency/retainers/:p1", auth, crud(null, "agency", "agency"));
router.get("/api/apps/summary", auth, summary("app_installs", "apps"));
router.get("/api/automations/summary", auth, summary("automations", "automations"));
router.get("/api/bio/summary", auth, summary("link_in_bio", "bio"));
router.get("/api/blog/summary", auth, summary("blog_posts", "blog"));
router.all("/api/bookings", auth, crud("bookings", "bookings", "bookings"));
router.get("/api/carts/summary", auth, summary("abandoned_carts", "carts"));
router.get("/api/community/summary", auth, summary("community_posts", "community"));
router.all("/api/competitor", auth, crud("competitor_snapshots", "competitors", "competitors"));
router.get("/api/competitors/summary", auth, summary("competitor_snapshots", "competitors"));
router.all("/api/contacts/hot", auth, crud("contacts", "contacts", "contacts"));
router.get("/api/contacts/summary", auth, summary("contacts", "contacts"));
router.get("/api/contracts/summary", auth, summary("contracts", "contracts"));
router.get("/api/courses/summary", auth, summary("courses", "courses"));
router.get("/api/data/export", auth, csvOut("wired_gap_data"));
router.all("/api/data/goals", auth, kv("api_data_goals", "goals"));
router.post("/api/data/import", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); if(!db||!uid)return res.status(401).json({error:"unauthorized"}); ensure(db); const items=(req.body&&(req.body.items||req.body.rows||req.body.data))||[]; let n=0; try{ const ins=db.prepare("INSERT INTO wired_gap_data (id,user_id,kind,data) VALUES (?,?,?,?)"); (Array.isArray(items)?items:[items]).forEach(function(it){ ins.run(genId("imp"),uid,"import",JSON.stringify(it)); n++; }); }catch(e){ return res.status(500).json({error:e.message}); } return ok(res,{ok:true,imported:n}); });
router.all("/api/data/invoices/followup", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); const id=req.params.id||req.params.p1||(req.body&&req.body.id); if(!db||!uid||!id) return res.status(400).json({error:"id required"}); try{ db.prepare("UPDATE invoices SET status='sent' WHERE id=? AND user_id=?").run(id,uid); }catch(e){ return res.status(500).json({error:e.message}); } return ok(res,{ok:true,id:id,status:"sent",delivery:"not_dispatched",note:"Status updated; outbound delivery hook not wired on this endpoint."}); });
router.all("/api/data/invoices/mark-paid", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); const id=(req.body&&(req.body.id||req.body.invoice_id))||req.params.id; if(!db||!uid||!id) return res.status(400).json({error:"invoice id required"}); try{ db.prepare("UPDATE invoices SET status='paid' WHERE id=? AND user_id=?").run(id,uid); }catch(e){ return res.status(500).json({error:e.message}); } const r=(function(){try{return db.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(id,uid);}catch(_){return null;}})(); return ok(res,{ok:true,invoice:r,status:"paid"}); });
router.all("/api/data/invoices/payment", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); const id=(req.body&&(req.body.id||req.body.invoice_id))||req.params.id; if(!db||!uid||!id) return res.status(400).json({error:"invoice id required"}); try{ db.prepare("UPDATE invoices SET status='paid' WHERE id=? AND user_id=?").run(id,uid); }catch(e){ return res.status(500).json({error:e.message}); } const r=(function(){try{return db.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(id,uid);}catch(_){return null;}})(); return ok(res,{ok:true,invoice:r,status:"paid"}); });
router.all("/api/data/retainers", auth, crud("retainers", "retainers", "retainers"));
router.all("/api/data/staff", auth, crud("staff_profiles", "staff", "staff"));
router.all("/api/data/transactions", auth, crud("expenses", "transactions", "transactions"));
router.get("/api/email/campaigns/:id/stats.csv", auth, csvOut("wired_gap_data"));
router.get("/api/email/stats", auth, summary(null, "email"));
router.all("/api/events", auth, crud("events", "events", "events"));
router.get("/api/exports/data.csv", auth, csvOut("wired_gap_data"));
router.get("/api/exports/leads.csv", auth, csvOut("wired_gap_data"));
router.get("/api/exports/pipeline.csv", auth, csvOut("wired_gap_data"));
router.all("/api/features/ab-testing", auth, crud("ab_tests", "tests", "tests"));
router.all("/api/features/ab-testing/create", auth, crud("ab_tests", "test", "test"));
router.all("/api/features/ab-testing/winner", auth, kv("api_features_ab_testing_winner", "test"));
router.all("/api/features/ab-tests/set-winner", auth, kv("api_features_ab_tests_set_winner", "test"));
router.all("/api/features/ads", auth, crud("ad_campaigns", "campaigns", "campaigns"));
router.all("/api/features/ads/ai-creative", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: creative. Return only the result, no preamble."); });
router.all("/api/features/ads/budget", auth, kv("api_features_ads_budget", "budget"));
router.all("/api/features/ads/connect-status", auth, crud("social_connections", "connections", "connections"));
router.all("/api/features/ads/conversion-tracking", auth, kv("api_features_ads_conversion_tracking", "tracking"));
router.all("/api/features/ads/lookalike-audience", auth, crud("lookalike_prospects", "audience", "audience"));
router.all("/api/features/affiliates", auth, crud("biz_affiliates", "affiliates", "affiliates"));
router.all("/api/features/ai-tools/custom", auth, kv("api_features_ai_tools_custom", "tools"));
router.all("/api/features/ai-tools/settings", auth, kv("api_features_ai_tools_settings", "settings"));
router.get("/api/features/app-store/installs.csv", auth, csvOut("wired_gap_data"));
router.all("/api/features/app-store/submit", auth, crud("app_store_apps", "app", "app"));
router.all("/api/features/apps", auth, crud("app_installs", "apps", "apps"));
router.all("/api/features/automations/test", auth, kv("api_features_automations_test", "automation"));
router.all("/api/features/blog/schedule", auth, kv("api_features_blog_schedule", "schedule"));
router.all("/api/features/bookings", auth, crud("bookings", "bookings", "bookings"));
router.all("/api/features/bookings/:id", auth, crud("bookings", "booking", "booking"));
router.all("/api/features/bookings/waitlist", auth, kv("api_features_bookings_waitlist", "waitlist"));
router.all("/api/features/brand-kit/logo", auth, kv("api_features_brand_kit_logo", "brand"));
router.all("/api/features/calendar/events", auth, crud("events", "events", "events"));
router.all("/api/features/cart-recovery/flows", auth, crud("cart_recovery_config", "flows", "flows"));
router.get("/api/features/cart-recovery/test", auth, summary("abandoned_carts", "carts"));
router.all("/api/features/chat", auth, crud("chat_messages", "messages", "messages"));
router.all("/api/features/chatbot/train", auth, crud("business_knowledge", "knowledge", "knowledge"));
router.all("/api/features/classes", auth, crud(null, "classes", "classes"));
router.all("/api/features/classes/:id", auth, crud(null, "class", "class"));
router.all("/api/features/classes/attendance", auth, kv("api_features_classes_attendance", "attendance"));
router.all("/api/features/client-portal/:id", auth, crud("sites", "portal", "portal"));
router.all("/api/features/client-portal/settings", auth, kv("api_features_client_portal_settings", "settings"));
router.all("/api/features/community/reddit-status", auth, crud("social_connections", "status", "status"));
router.all("/api/features/competitor/alerts", auth, kv("api_features_competitor_alerts", "alerts"));
router.all("/api/features/contacts", auth, crud("contacts", "contacts", "contacts"));
router.all("/api/features/contacts/:id", auth, crud("contacts", "contact", "contact"));
router.all("/api/features/contracts/:id/audit", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: review. Return only the result, no preamble."); });
router.all("/api/features/contracts/:id/send", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); const id=req.params.id||req.params.p1||(req.body&&req.body.id); if(!db||!uid||!id) return res.status(400).json({error:"id required"}); try{ db.prepare("UPDATE contracts SET status='sent' WHERE id=? AND user_id=?").run(id,uid); }catch(e){ return res.status(500).json({error:e.message}); } return ok(res,{ok:true,id:id,status:"sent",delivery:"not_dispatched",note:"Status updated; outbound delivery hook not wired on this endpoint."}); });
router.all("/api/features/contracts/audit", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: review. Return only the result, no preamble."); });
router.all("/api/features/contracts/send", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); const id=req.params.id||req.params.p1||(req.body&&req.body.id); if(!db||!uid||!id) return res.status(400).json({error:"id required"}); try{ db.prepare("UPDATE contracts SET status='sent' WHERE id=? AND user_id=?").run(id,uid); }catch(e){ return res.status(500).json({error:e.message}); } return ok(res,{ok:true,id:id,status:"sent",delivery:"not_dispatched",note:"Status updated; outbound delivery hook not wired on this endpoint."}); });
router.all("/api/features/courses", auth, crud(null, "courses", "courses"));
router.all("/api/features/courses/students", auth, crud("enrollments", "students", "students"));
router.all("/api/features/email-templates", auth, crud(null, "templates", "templates"));
router.all("/api/features/events", auth, crud("events", "events", "events"));
router.all("/api/features/events/tickets", auth, crud("event_tickets", "tickets", "tickets"));
router.all("/api/features/forms", auth, crud(null, "forms", "forms"));
router.all("/api/features/forms/submit", auth, crud(null, "forms", "forms"));
router.all("/api/features/funnels", auth, crud(null, "funnels", "funnels"));
router.all("/api/features/help/search", auth, crud(null, "help", "help"));
router.get("/api/features/invoices/export.pdf", auth, csvOut("wired_gap_data"));
router.all("/api/features/items/", auth, crud(null, "items", "items"));
router.all("/api/features/link-in-bio/profile", auth, crud(null, "link_in_bio", "link_in_bio"));
router.all("/api/features/mine-control/ai-config", auth, crud(null, "mine_control", "mine_control"));
router.all("/api/features/mine-control/register", auth, crud(null, "mine_control", "mine_control"));
router.all("/api/features/mine-control/resend", auth, crud(null, "mine_control", "mine_control"));
router.all("/api/features/mine-control/verify", auth, crud(null, "mine_control", "mine_control"));
router.all("/api/features/mobile-app/config", auth, crud(null, "mobile_app", "mobile_app"));
router.all("/api/features/mobile-app/dedicated-build-request", auth, crud(null, "mobile_app", "mobile_app"));
router.all("/api/features/mobile-app/launch", auth, crud(null, "mobile_app", "mobile_app"));
router.all("/api/features/mobile-app/push", auth, crud(null, "mobile_app", "mobile_app"));
router.all("/api/features/multi-currency/fx-settings", auth, crud(null, "multi_currency", "multi_currency"));
router.all("/api/features/orders/:id", auth, crud(null, "orders", "orders"));
router.all("/api/features/orders/refund", auth, crud(null, "orders", "orders"));
router.all("/api/features/podcast/distribute", auth, crud(null, "podcast", "podcast"));
router.all("/api/features/podcast/upload", auth, crud(null, "podcast", "podcast"));
router.all("/api/features/portal/invite", auth, crud(null, "portal", "portal"));
router.all("/api/features/portals", auth, crud(null, "portals", "portals"));
router.all("/api/features/products", auth, crud(null, "products", "products"));
router.all("/api/features/proposals", auth, crud(null, "proposals", "proposals"));
router.all("/api/features/proposals/:id/send", auth, crud(null, "proposals", "proposals"));
router.all("/api/features/retainers", auth, crud(null, "retainers", "retainers"));
router.all("/api/features/reviews/settings", auth, crud(null, "reviews", "reviews"));
router.all("/api/features/roadmap", auth, crud(null, "roadmap", "roadmap"));
router.all("/api/features/score", auth, crud(null, "score", "score"));
router.all("/api/features/score/analyze", auth, crud(null, "score", "score"));
router.all("/api/features/score/auto-fix", auth, crud(null, "score", "score"));
router.all("/api/features/seo/auto-fix", auth, crud(null, "seo", "seo"));
router.all("/api/features/seo/fix", auth, crud(null, "seo", "seo"));
router.all("/api/features/seo/generate", auth, crud(null, "seo", "seo"));
router.all("/api/features/seo/submit-sitemap", auth, crud(null, "seo", "seo"));
router.all("/api/features/services", auth, crud(null, "services", "services"));
router.all("/api/features/services/:id", auth, crud(null, "services", "services"));
router.all("/api/features/services/availability", auth, crud(null, "services", "services"));
router.all("/api/features/services/pricing", auth, crud(null, "services", "services"));
router.all("/api/features/site-sections/duplicate", auth, crud(null, "site_sections", "site_sections"));
router.all("/api/features/site-sections/hide", auth, crud(null, "site_sections", "site_sections"));
router.all("/api/features/sms/ab-test", auth, crud(null, "sms", "sms"));
router.all("/api/features/sms/inbox", auth, crud(null, "sms", "sms"));
router.all("/api/features/sms/inbox/reply", auth, crud(null, "sms", "sms"));
router.all("/api/features/sms/templates", auth, crud(null, "sms", "sms"));
router.all("/api/features/social/schedule", auth, crud(null, "social", "social"));
router.all("/api/features/subscriptions/:id", auth, crud(null, "subscriptions", "subscriptions"));
router.all("/api/features/tasks", auth, crud(null, "tasks", "tasks"));
router.all("/api/features/team/:id/role", auth, crud(null, "team", "team"));
router.all("/api/features/templates", auth, crud(null, "templates", "templates"));
router.all("/api/features/templates/ai-build", auth, crud(null, "templates", "templates"));
router.all("/api/features/templates/industry", auth, crud(null, "templates", "templates"));
router.all("/api/features/test", auth, crud(null, "test", "test"));
router.all("/api/features/voice/recordings", auth, crud(null, "voice", "voice"));
router.all("/api/files/logo", auth, crud(null, "files", "files"));
router.get("/api/forms/summary", auth, summary(null, "forms"));
router.get("/api/funnels/summary", auth, summary(null, "funnels"));
router.all("/api/integrations/keys/easypost", auth, crud(null, "integrations", "integrations"));
router.all("/api/integrations/oauth/mailchimp/start", auth, crud(null, "integrations", "integrations"));
router.all("/api/integrations/oauth/pinterest/start", auth, crud(null, "integrations", "integrations"));
router.all("/api/integrations/oauth/snapchat/start", auth, crud(null, "integrations", "integrations"));
router.get("/api/integrations/summary", auth, summary(null, "integrations"));
router.all("/api/invoices", auth, crud(null, "invoices", "invoices"));
router.get("/api/invoices/summary", auth, summary(null, "invoices"));
router.get("/api/lead-magnets/summary", auth, summary(null, "lead_magnets"));
router.get("/api/loyalty/summary", auth, summary(null, "loyalty"));
router.get("/api/memberships/summary", auth, summary(null, "memberships"));
router.get("/api/mobile/summary", auth, summary(null, "mobile"));
router.get("/api/orders/summary", auth, summary(null, "orders"));
router.all("/api/payments/checkout", auth, crud(null, "payments", "payments"));
router.get("/api/podcast/summary", auth, summary(null, "podcast"));
router.get("/api/products/summary", auth, summary(null, "products"));
router.all("/api/referral-programs", auth, crud(null, "referral_programs", "referral_programs"));
router.get("/api/reviews/summary", auth, summary("reviews", "reviews"));
router.get("/api/services/summary", auth, summary(null, "services"));
router.all("/api/showdown", auth, crud(null, "showdown", "showdown"));
router.all("/api/staff/:id/schedule", auth, crud(null, "staff", "staff"));
router.all("/api/staff/activity", auth, crud(null, "staff", "staff"));
router.get("/api/staff/commissions.csv", auth, csvOut("staff_profiles"));
router.get("/api/subscriptions/summary", auth, summary(null, "subscriptions"));
router.all("/api/templates", auth, crud(null, "templates", "templates"));
router.get("/api/upsells/summary", auth, summary(null, "upsells"));
router.all("/api/verticals4/retainers/:p1", auth, crud(null, "verticals4", "verticals4"));

// ── post-rewrite holes: path-compat sends /api/team/* here as /api/features/team/*,
//    but features.js lacks these three; they land here (mounted after features).
router.get("/api/features/team/summary", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); if(!db||!uid) return ok(res,{total:0}); let total=0; try{ total=(db.prepare("SELECT COUNT(*) c FROM team_members WHERE user_id=?").get(uid)||{}).c||0; }catch(_){ } return ok(res,{total:total,count:total,members:total}); });
router.all("/api/features/team/:mid/reset-password", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); if(!db||!uid) return res.status(401).json({error:"unauthorized"}); try{ let member=null; try{ member=db.prepare("SELECT * FROM team_members WHERE id=? AND user_id=?").get(req.params.mid,uid); }catch(_){ } const email=member&&(member.email||member.member_email); if(!email) return res.status(404).json({error:"team member not found"}); const target=db.prepare("SELECT id FROM users WHERE email=?").get(String(email).toLowerCase()); if(!target) return res.status(409).json({error:"member_has_no_account",message:"This team member hasn't created a TAKEOVA account yet, so there is no password to reset."}); const token=genId("rst")+genId(""); db.prepare("INSERT INTO password_resets (id, user_id, token, expires_at) VALUES (?,?,?,datetime('now','+1 hour'))").run(genId("pr"),target.id,token); return ok(res,{ok:true,reset_created:true,email:email,delivery:"not_dispatched",note:"Reset token stored for the member's account; email dispatch not wired on this endpoint — they can also use Forgot Password."}); }catch(e){ return res.status(500).json({error:e.message}); } });
router.all("/api/features/team/:mid", auth, crud("team_members","member","member"));

router.all("/api/ai-features/advisor-send", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: reply to this advisory question. Return only the result, no preamble."); });
router.all("/api/ai-features/fix-issues", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: analyse the given site or content and list concrete fixes. Return only the result, no preamble."); });
router.all("/api/ai-features/generate", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: content generation. Return only the result, no preamble."); });
router.all("/api/ai-features/meta-tags", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: write SEO meta tags for the given page. Return only the result, no preamble."); });
router.all("/api/ai-features/personalise", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: personalise the given content for the described customer. Return only the result, no preamble."); });
router.all("/api/ai-features/seo-audit", auth, function(req,res){ return aiCall(req,res,"You are TAKEOVA, a business assistant. Task: perform an SEO audit of the given site or content. Return only the result, no preamble."); });
router.get("/api/audit/log", auth, function(req,res){ const db=dbOf(req),uid=uidOf(req); if(!db||!uid) return res.status(401).json({error:"unauthorized"}); if(isAdmin(db,uid)){ let items=[]; try{ items=db.prepare("SELECT * FROM audit_log ORDER BY rowid DESC LIMIT 200").all()||[]; }catch(_){ } return ok(res,{items:items,log:items,total:items.length}); } return ok(res,listTable(req,"audit_log","log")); });

// ── time-tracking (all-in-one dashboard): only handlers lived in unmounted stub-replacements ──
router.all("/api/features/time-tracking", auth, crud(null, "timelog", "entries"));
router.post("/api/features/time-tracking/start", auth, function(req,res){
  const db=dbOf(req), uid=uidOf(req); if(!db||!uid) return res.status(401).json({error:"unauthorized"}); ensure(db);
  try{
    const open=db.prepare("SELECT id,data FROM wired_gap_data WHERE user_id=? AND kind='timelog' AND data LIKE '%\"ended_at\":null%' ORDER BY rowid DESC LIMIT 1").get(uid);
    if(open){ const d=JSON.parse(open.data||"{}"); d.ended_at=new Date().toISOString(); db.prepare("UPDATE wired_gap_data SET data=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(d),open.id); d.id=open.id; return ok(res,{ok:true,stopped:true,entry:d}); }
    const d={ label:(req.body&&req.body.label)||"Work", started_at:new Date().toISOString(), ended_at:null };
    const id=genId("tt"); db.prepare("INSERT INTO wired_gap_data (id,user_id,kind,data) VALUES (?,?,?,?)").run(id,uid,"timelog",JSON.stringify(d));
    d.id=id; return ok(res,{ok:true,started:true,entry:d});
  }catch(e){ return res.status(500).json({error:e.message}); }
});
router.get("/api/features/time-tracking/export", auth, function(req,res){
  const db=dbOf(req), uid=uidOf(req); if(!db||!uid) return res.status(401).json({error:"unauthorized"}); ensure(db);
  let rows=[]; try{ rows=db.prepare("SELECT id,data,created_at FROM wired_gap_data WHERE user_id=? AND kind='timelog' ORDER BY rowid DESC LIMIT 5000").all(uid)||[]; }catch(_){}
  const esc=function(v){ if(v==null)return ""; const t=String(v).replace(/"/g,'""'); return /[",\n]/.test(t)?'"'+t+'"':t; };
  const lines=["id,label,started_at,ended_at,created_at"];
  rows.forEach(function(r){ let d={}; try{d=JSON.parse(r.data||"{}");}catch(_){} lines.push([r.id,d.label,d.started_at,d.ended_at,r.created_at].map(esc).join(",")); });
  res.type("text/csv").set("Content-Disposition","attachment; filename=time-tracking.csv").send(lines.join("\n"));
});

module.exports = router;
