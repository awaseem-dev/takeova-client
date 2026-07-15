// GET /api/data/dashboard-aggregates
// Computes the per-panel stat aggregates the list endpoints don't return.
// Every metric is isolated: a missing column/table yields 0, never a 500.
// Wire stat cards to fields on this single response (see mine-wire module).
const express = require("express");
const router = express.Router();
const { getDb } = require("../db/init");
const auth = require("../middleware/auth");

// single-scalar query, defensive
function v(db, sql, params, def) {
  try {
    const row = db.prepare(sql).get(...(params || []));
    if (!row) return def;
    const k = Object.keys(row)[0];
    const val = row[k];
    return val == null ? def : val;
  } catch (_) { return def; }
}
const D30 = "datetime('now','-30 days')";

router.get("/dashboard-aggregates", auth, (req, res) => {
  const db = getDb();
  const u = req.user && (req.user.id || req.user.user_id);
  const out = {};
  const c = (sql, p) => v(db, sql, p == null ? [u] : p, 0);

  // ── Products ───────────────────────────────────────────────
  out.prd_in_stock = c("SELECT COUNT(*) n FROM products WHERE user_id=? AND (track_inventory=0 OR stock>0)");
  out.prd_low_stock = c("SELECT COUNT(*) n FROM products WHERE user_id=? AND track_inventory=1 AND stock<=low_stock_threshold");
  out.prd_revenue = c("SELECT COALESCE(SUM(total),0) n FROM orders WHERE user_id=? AND status='paid'");
  // ── Orders ─────────────────────────────────────────────────
  out.ord_pending = c("SELECT COUNT(*) n FROM orders WHERE user_id=? AND fulfillment_status='unfulfilled'");
  out.ord_fulfilled = c("SELECT COUNT(*) n FROM orders WHERE user_id=? AND fulfillment_status='fulfilled'");
  // ── Reviews / ratings ──────────────────────────────────────
  out.rvw_avg_rating = c("SELECT ROUND(AVG(rating),1) n FROM reviews WHERE user_id=? AND approved=1");
  out.rvw_count = c("SELECT COUNT(*) n FROM reviews WHERE user_id=? AND approved=1");
  // ── Blog ───────────────────────────────────────────────────
  out.blg_views = c("SELECT COALESCE(SUM(views),0) n FROM blog_posts WHERE user_id=?");
  out.blg_drafts = c("SELECT COUNT(*) n FROM blog_posts WHERE user_id=? AND status='draft'");
  // ── Memberships ────────────────────────────────────────────
  out.mbs_tiers = c("SELECT COUNT(*) n FROM memberships WHERE user_id=?");
  // ── Courses revenue (best-effort: price × enrolled) ────────
  out.crs_revenue = c("SELECT COALESCE(SUM(price*enrolled),0) n FROM courses WHERE user_id=?");
  // ── Ads ────────────────────────────────────────────────────
  out.adv_spend = c("SELECT COALESCE(SUM(spend),0) n FROM ad_campaigns WHERE user_id=?");
  out.adv_active = c("SELECT COUNT(*) n FROM ad_campaigns WHERE user_id=? AND status='active'");
  out.adv_roas = c(
    "SELECT ROUND(AVG(p.roas),2) n FROM ad_performance p JOIN ad_campaigns ca ON ca.id=p.campaign_id WHERE ca.user_id=?"
  );
  out.adv_revenue = Math.round((Number(out.adv_spend) || 0) * (Number(out.adv_roas) || 0));
  // ── Accounting (transactions) ──────────────────────────────
  out.acc_revenue = c("SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE user_id=? AND type IN ('income','revenue','sale')");
  out.acc_expenses = c("SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE user_id=? AND type IN ('expense','cost')");
  out.acc_profit = (Number(out.acc_revenue) || 0) - (Number(out.acc_expenses) || 0);
  out.acc_margin = out.acc_revenue ? Math.round((out.acc_profit / out.acc_revenue) * 100) : 0;
  // ── Automations ────────────────────────────────────────────
  out.aut_active = c("SELECT COUNT(*) n FROM automations WHERE user_id=? AND (active=1 OR enabled=1)");
  out.aut_runs = c("SELECT COALESCE(SUM(run_count),0) n FROM automations WHERE user_id=?");
  // ── Chatbot ────────────────────────────────────────────────
  out.cbt_chats = c("SELECT COUNT(*) n FROM chatbot_conversations WHERE site_id IN (SELECT id FROM sites WHERE user_id=?)");
  out.cbt_leads = c("SELECT COUNT(*) n FROM chatbot_conversations WHERE lead_captured=1 AND site_id IN (SELECT id FROM sites WHERE user_id=?)");
  // ── Cart recovery ──────────────────────────────────────────
  out.crt_abandoned = c("SELECT COUNT(*) n FROM abandoned_carts WHERE site_id IN (SELECT id FROM sites WHERE user_id=?)");
  out.crt_recovered = c("SELECT COUNT(*) n FROM abandoned_carts WHERE recovered=1 AND site_id IN (SELECT id FROM sites WHERE user_id=?)");
  out.crt_rate = out.crt_abandoned ? Math.round((out.crt_recovered / out.crt_abandoned) * 100) : 0;
  // ── Link-in-bio ────────────────────────────────────────────
  out.bio_clicks = c("SELECT COALESCE(SUM(click_count),0) n FROM link_in_bio WHERE user_id=?");
  // ── Proposals ──────────────────────────────────────────────
  out.pa_total = c("SELECT COUNT(*) n FROM proposals WHERE user_id=?");
  out.pa_won = c("SELECT COUNT(*) n FROM proposals WHERE user_id=? AND status IN ('signed','accepted','won')");
  out.pa_rate = out.pa_total ? Math.round((out.pa_won / out.pa_total) * 100) : 0;
  // ── Support tickets ────────────────────────────────────────
  out.cpt_tickets = c("SELECT COUNT(*) n FROM support_tickets WHERE user_id=? AND status='open'");
  // ── Admin metrics ──────────────────────────────────────────
  out.adm_mrr = c("SELECT mrr n FROM mrr_snapshots WHERE user_id=? ORDER BY snapshot_date DESC LIMIT 1");
  out.adm_arr = (Number(out.adm_mrr) || 0) * 12;
  out.adm_api_spend = c(`SELECT COALESCE(SUM(cost),0) n FROM ai_usage WHERE user_id=? AND created_at>=${D30}`);

  // ── Loyalty ────────────────────────────────────────────────
  out.loy_members = c("SELECT COUNT(DISTINCT customer_id) n FROM loyalty_transactions WHERE user_id=?");
  out.loy_points = c("SELECT COALESCE(SUM(points),0) n FROM loyalty_transactions WHERE user_id=? AND points>0");
  out.loy_redeemed = c("SELECT COUNT(*) n FROM loyalty_redemptions WHERE user_id=?");
  // ── Classes ────────────────────────────────────────────────
  out.cls_classes = c("SELECT COUNT(*) n FROM class_schedules WHERE user_id=?");
  out.cls_students = c("SELECT COALESCE(SUM(enrolled),0) n FROM class_schedules WHERE user_id=?");
  out.cls_fill = c("SELECT ROUND(AVG(CASE WHEN capacity>0 THEN enrolled*100.0/capacity END)) n FROM class_schedules WHERE user_id=?");
  out.cls_revenue = c("SELECT COALESCE(SUM(price*enrolled),0) n FROM class_schedules WHERE user_id=?");
  // ── Competitors (scoped via keyword join) ──────────────────
  out.cmp_tracked = c("SELECT COUNT(DISTINCT s.competitor_url) n FROM seo_competitor_snapshots s JOIN seo_keywords k ON k.id=s.keyword_id WHERE k.user_id=?");

  // ── Long tail (batch 2) ────────────────────────────────────
  const D7 = "datetime('now','-7 days')";
  // Affiliate payouts
  out.aff_pending = c("SELECT COALESCE(SUM(commission),0) n FROM referrals WHERE referrer_id=? AND (status IS NULL OR status!='paid')");
  out.aff_paid = c("SELECT COALESCE(SUM(commission),0) n FROM referrals WHERE referrer_id=? AND status='paid'");
  // Calendar / bookings
  out.cal_week = c("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND date>=date('now') AND date<date('now','+7 days')");
  out.cal_today = c("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND date=date('now')");
  out.cal_week_rev = c("SELECT COALESCE(SUM(price),0) n FROM bookings WHERE user_id=? AND date>=date('now') AND date<date('now','+7 days')");
  out.cal_cancellations = c("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND status='cancelled'");
  // Contacts new this week
  out.cnt_new_week = c(`SELECT COUNT(*) n FROM contacts WHERE user_id=? AND created_at>=${D7}`);
  // Portal clients
  out.cpt_portals = c("SELECT COUNT(*) n FROM portal_clients WHERE user_id=?");
  // Contracts
  out.cts_total = c("SELECT COUNT(*) n FROM contracts WHERE user_id=?");
  out.cts_active = c("SELECT COUNT(*) n FROM contracts WHERE user_id=? AND status IN ('signed','active')");
  out.cts_awaiting = c("SELECT COUNT(*) n FROM contracts WHERE user_id=? AND status IN ('sent','viewed')");
  out.cts_value = c("SELECT COALESCE(SUM(amount),0) n FROM contracts WHERE user_id=?");
  // Deals / pipeline
  out.lds_total = c("SELECT COUNT(*) n FROM deals WHERE user_id=?");
  out.lds_value = c("SELECT COALESCE(SUM(value),0) n FROM deals WHERE user_id=?");
  out.lds_hot = c("SELECT COUNT(*) n FROM deals WHERE user_id=? AND probability>=70");
  // Help articles (global content)
  out.hlp_articles = c("SELECT COUNT(*) n FROM help_articles", []);
  // Mobile installs
  out.mob_installs = c("SELECT COUNT(*) n FROM push_tokens WHERE user_id=?");
  // Social posts this month
  out.soc_posts = c(`SELECT COUNT(*) n FROM social_posts WHERE user_id=? AND created_at>=${D30}`);
  // Team / staff / AI employees
  out.stf_team = c("SELECT COUNT(*) n FROM staff_profiles WHERE user_id=?");
  out.tm_members = c("SELECT COUNT(*) n FROM team_members WHERE owner_id=?");
  out.tm_active = c("SELECT COUNT(*) n FROM team_members WHERE owner_id=? AND status='active'");
  out.ai_employees = c("SELECT COUNT(*) n FROM ai_employees WHERE user_id=? AND enabled=1");
  // Installed apps
  out.aps_installed = c("SELECT COUNT(*) n FROM installed_apps WHERE user_id=? AND active=1");
  // Integrations connected
  out.int_connected = c("SELECT COUNT(*) n FROM user_integration_keys WHERE user_id=?");
  // Roadmap planned
  out.rdm_planned = c("SELECT COUNT(*) n FROM roadmap_items WHERE user_id=? AND status='planned'");
  // Reviews breakdown
  out.rvw_total = c("SELECT COUNT(*) n FROM reviews WHERE user_id=? AND approved=1");
  out.rvw_positive = c("SELECT COUNT(*) n FROM reviews WHERE user_id=? AND approved=1 AND rating>=4");
  out.rvw_week = c(`SELECT COUNT(*) n FROM reviews WHERE user_id=? AND approved=1 AND created_at>=${D7}`);
  // Forms
  out.frm_subs = c("SELECT COALESCE(SUM(submissions),0) n FROM forms WHERE user_id=?");
  out.frm_week = c(`SELECT COUNT(*) n FROM form_submissions WHERE site_id IN (SELECT id FROM sites WHERE user_id=?) AND created_at>=${D7}`);
  // Event tickets
  out.evt_sold = c("SELECT COALESCE(SUM(t.sold),0) n FROM event_tickets t JOIN events e ON e.id=t.event_id WHERE e.user_id=?");
  out.evt_revenue = c("SELECT COALESCE(SUM(t.sold*t.price),0) n FROM event_tickets t JOIN events e ON e.id=t.event_id WHERE e.user_id=?");
  // Outreach
  out.otr_prospects = c("SELECT COALESCE(SUM(total_contacts),0) n FROM outreach_campaigns WHERE user_id=?");
  out.otr_open_rate = c("SELECT CASE WHEN COALESCE(SUM(total_sent),0)=0 THEN 0 ELSE ROUND(SUM(total_opened)*100.0/SUM(total_sent)) END n FROM cold_email_campaigns WHERE user_id=?");
  out.otr_replies = c("SELECT COALESCE(SUM(total_replied),0) n FROM cold_email_campaigns WHERE user_id=?");
  // Services
  out.svc_services = c("SELECT COUNT(*) n FROM services WHERE user_id=?");
  out.svc_bookable = c("SELECT COUNT(*) n FROM services WHERE user_id=? AND active=1");
  // Mobile active (tokens seen in 30d)
  out.mob_active = c(`SELECT COUNT(*) n FROM push_tokens WHERE user_id=? AND created_at>=${D30}`);
  // Link-in-bio link count (JSON array)
  out.bio_links = c("SELECT COALESCE(SUM(json_array_length(links)),0) n FROM link_in_bio WHERE user_id=? AND links IS NOT NULL AND links!=''");
  // Events sold out
  out.evt_soldout = c("SELECT COUNT(*) n FROM events e WHERE e.user_id=? AND e.capacity>0 AND (SELECT COALESCE(SUM(t.sold),0) FROM event_tickets t WHERE t.event_id=e.id) >= e.capacity");
  // Deal win-rate
  out.lds_winrate = c("SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ROUND(SUM(CASE WHEN stage IN ('won','closed_won','closed') THEN 1 ELSE 0 END)*100.0/COUNT(*)) END n FROM deals WHERE user_id=?");

  res.json(out);
});

module.exports = router;
