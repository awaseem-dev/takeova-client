require("dotenv").config();
require("./preflight");   // validates env config — fails fast with readable errors
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const cookieParser = require("cookie-parser");
const { v4: uuid } = require("uuid");
const { init: initDb, getDb, getSetting } = require("./db/init");

// Initialize database BEFORE requiring routes — route modules may call getDb() at load time
initDb();

/* ─── ROUTE IMPORTS (all 21) ─── */
const authRoutes = require("./routes/auth");
const oauthRoutes = require("./routes/oauth");
const { router: accountingRoutes } = require("./routes/accounting-oauth");
const socialOauthRoutes = require("./routes/social-oauth");
const siteRoutes = require("./routes/sites");
const paymentRoutes = require("./routes/payments");
const dataRoutes = require("./routes/data");
const emailRoutes = require("./routes/email");
const fileRoutes = require("./routes/files");
const adminRoutes = require("./routes/admin");
const integrationRoutes = require("./routes/integrations");
const hostingRoutes = require("./routes/hosting");
const migrationRoutes = require("./routes/migration");
const userIntegrationKeysRoutes = require("./routes/user-integration-keys");
const userNotificationsRoutes = require("./routes/user-notifications");
const shippingRoutes = require("./routes/shipping");
const aiEmployeeRoutes = require("./routes/ai-employees");
const outreachRoutes = require("./routes/outreach");
const featureRoutes = require("./routes/features");
const adsRoutes = require("./routes/ads");
const platformRoutes = require("./routes/platform");
const affiliateRoutes = require("./routes/affiliates");
const cryptoRoutes     = require("./routes/crypto");
const prospectorRoutes = require("./routes/prospector");
const proposalAgentRoutes = require("./routes/proposal-agent");
const seoAgentRoutes = require("./routes/seo-agent");
const coldEmailAgentRoutes = require("./routes/cold-email-agent");
const visionRoutes    = require("./routes/vision");
const staffRoutes     = require("./routes/staff");
const jobsRoutes      = require("./routes/jobs");
const timeBillingRoutes = require("./routes/time-billing");
const verticalsRoutes = require("./routes/verticals");
const industryRoutes       = require("./routes/industry-verticals");
const industry2Routes      = require("./routes/industry-verticals-2");
const specialtyRoutes      = require("./routes/specialty");
const retailEduRoutes      = require("./routes/retail-edu");
const reviewsRoutes        = require("./routes/reviews");
const moreVertRoutes       = require("./routes/more-verticals");
const extendedRoutes       = require("./routes/extended-verticals");
const templateRoutes = require("./routes/templates");
const marketplaceRoutes = require("./routes/marketplace");
const appstoreRoutes = require("./routes/appstore");
const aiFeaturesRoutes = require("./routes/ai-features");
const showdownRoutes = require("./routes/showdown");
const showdownAdCapRoutes = require("./routes/showdown-ad-cap");
const intelligenceRoutes = require("./routes/intelligence");
const { runNightlyIntelligence, deliverMorningBriefings } = require("./routes/intelligence");
const agencyRoutes = require("./routes/agency");
const { sendMonthlyROIReport, sendOnboardingSequence, sendReEngagementEmails } = require("./routes/features");
/* ─── INIT ─── */

/* ─── SCHEDULED JOBS ─── */
// Run after startup delay to ensure DB is ready
const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;
setTimeout(function scheduledJobs() {
  const now = new Date();
  const hour = now.getHours();
  // Nightly intelligence at 2am
  if (hour === 2) {
    runNightlyIntelligence().catch(e => console.error('[cron] nightly intelligence:', e.message));
  }
  // Morning briefings at 7am
  if (hour === 7) {
    deliverMorningBriefings().catch(e => console.error('[cron] morning briefings:', e.message));
  }
  // Monthly ROI report on 1st of month at 8am
  if (now.getDate() === 1 && hour === 8) {
    sendMonthlyROIReport().catch(e => console.error('[cron] monthly ROI:', e.message));
  }
  // Re-engagement emails daily at 10am
  if (hour === 10) {
    sendReEngagementEmails().catch(e => console.error('[cron] re-engagement:', e.message));
  }
}, 5000); // 5s startup delay
// Agent-loop controller — observe outcomes, drive retry/handoff/learn/escalate. Every 5 min.
setInterval(function () {
  try { require("./routes/agent-loop").runLoopTick(getDb()); }
  catch (e) { console.error('[cron] agent-loop:', e.message); }
}, 5 * 60 * 1000);
setInterval(function() {
  const now = new Date();
  const hour = now.getHours();
  const min  = now.getMinutes();
  if (min !== 0) return; // Only run at top of each hour
  if (hour === 2) runNightlyIntelligence().catch(e => console.error('[cron] nightly:', e.message));
  if (hour === 7) deliverMorningBriefings().catch(e => console.error('[cron] briefings:', e.message));
  if (now.getDate() === 1 && hour === 8) sendMonthlyROIReport().catch(e => console.error('[cron] ROI:', e.message));
  if (hour === 10) sendReEngagementEmails().catch(e => console.error('[cron] re-engage:', e.message));
  // Proposal Agent follow-ups — daily at 10am
  if (hour === 10) {
    fetch(`http://localhost:${process.env.PORT||4000}/api/proposal-agent/cron/follow-ups`, {
      method: 'POST', headers: { 'x-internal-key': process.env.INTERNAL_API_KEY||'' }
    }).catch(e => console.error('[cron] proposal follow-ups:', e.message));
  }
  if (hour === 1) sendOnboardingSequence().catch(e => console.error('[cron] onboarding:', e.message));

  // ── Showdown ad-cap sync — daily at 4am UTC ────────────────────────────
  // Pulls month-to-date Meta/Google/TikTok spend for every active Showdown
  // entrant. Marks entries over $2,500 as excluded from this month's leaderboard.
  if (hour === 4) {
    fetch(`http://localhost:${process.env.PORT||4000}/api/showdown/cron/sync-ad-spend`, {
      method: 'POST', headers: { 'x-cron-key': process.env.CRON_SECRET || '' }
    }).catch(e => console.error('[cron] showdown ad-cap:', e.message));
  }

  // ── v49: Monthly overage reconciliation — 2nd of month at 11am ──────
  if (now.getDate() === 2 && hour === 11) {
    reconcileMonthlyOverages().catch(e => console.error('[cron] overage reconcile:', e.message));
  }

  // ── Monthly affiliate + user referral payouts — 1st of month at 9am ──────
  if (now.getDate() === 1 && hour === 9) {
    (async function runMonthlyPayouts() {
      try {
        const db = require('./db/init').getDb();
        const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
        const MIN_PAYOUT = parseFloat(process.env.AFFILIATE_MIN_PAYOUT || '50');

        // ── Affiliate payouts ─────────────────────────────────────────────
        const affiliates = db.prepare(
          "SELECT * FROM mine_affiliates WHERE status='active' AND stripe_account_id IS NOT NULL"
        ).all();
        for (const aff of affiliates) {
          const pending = (aff.commission_earned || 0) - (aff.commission_paid || 0);
          if (pending < MIN_PAYOUT) continue;
          try {
            let transferId = 'manual_' + Date.now();
            if (stripe) {
              const transfer = await stripe.transfers.create({
                amount: Math.round(pending * 100),
                currency: 'usd',
                destination: aff.stripe_account_id,
                description: 'MINE affiliate commission — ' + new Date().toISOString().slice(0,7)
              });
              transferId = transfer.id;
            }
            db.prepare("UPDATE mine_affiliates SET commission_paid = commission_paid + ? WHERE id = ?")
              .run(pending, aff.id);
            db.prepare("INSERT INTO mine_affiliate_payouts (id, affiliate_id, amount, method, stripe_transfer_id, status) VALUES (?,?,?,?,?,?)")
              .run(require('crypto').randomBytes(16).toString('hex'), aff.id, pending, 'stripe', transferId, 'paid');
            console.log('[payout] affiliate', aff.email, '$' + pending.toFixed(2));
          } catch(e) { console.error('[payout] affiliate error', aff.email, e.message); }
        }

        // ── User referral payouts ─────────────────────────────────────────
        const users = db.prepare(
          "SELECT id, email, name, commission_earned, stripe_connect_id FROM users WHERE commission_earned >= ? AND stripe_connect_id IS NOT NULL"
        ).all(MIN_PAYOUT);
        for (const user of users) {
          try {
            let transferId = 'manual_' + Date.now();
            if (stripe && user.stripe_connect_id) {
              const transfer = await stripe.transfers.create({
                amount: Math.round(user.commission_earned * 100),
                currency: 'usd',
                destination: user.stripe_connect_id,
                description: 'MINE referral commission — ' + new Date().toISOString().slice(0,7)
              });
              transferId = transfer.id;
            }
            db.prepare("UPDATE users SET commission_paid = COALESCE(commission_paid,0) + ?, commission_earned = 0 WHERE id = ?")
              .run(user.commission_earned, user.id);
            db.prepare("INSERT OR IGNORE INTO audit_log (id, user_id, action, details) VALUES (?,?,?,?)")
              .run(require('crypto').randomBytes(16).toString('hex'), user.id, 'referral_payout', JSON.stringify({ amount: user.commission_earned, transfer: transferId }));
            console.log('[payout] user referral', user.email, '$' + user.commission_earned.toFixed(2));
          } catch(e) { console.error('[payout] user referral error', user.email, e.message); }
        }
        console.log('[payout] monthly payouts complete —', affiliates.length, 'affiliates,', users.length, 'users processed');
      } catch(e) { console.error('[payout] monthly payout cron error:', e.message); }
    })();
  }

  // Cold email follow-ups — daily at 9am
  if (hour === 9) {
    fetch(`http://localhost:${process.env.PORT || 4000}/api/cold-email/followups`, {
      method: 'POST', headers: { 'x-cron-key': process.env.CRON_SECRET || '' }
    }).catch(e => console.error('[cron] cold-email followups:', e.message));
  }
}, HOUR / 60); // Check every minute

initDb();

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA MIGRATIONS — fixes drift between INSERT sites and CREATE TABLE schemas.
// Every ADD COLUMN is idempotent (wrapped in try/catch) — running repeatedly
// on an already-migrated DB is a no-op. This block was added after a
// functional audit found 115 INSERT sites across 40+ tables referencing
// columns that did not exist in any CREATE TABLE statement. Without these
// migrations most invoice creation, AI social posting, OAuth token refresh,
// contact tagging, A/B tests, and other features silently threw SQL errors
// (swallowed by route-level try/catch) — users saw "internal error" with no
// log context or nothing happening at all.
// ═══════════════════════════════════════════════════════════════════════════
(function runSchemaMigrations() {
  const db = require("./db/init").getDb();
  const migrate = (sql) => { try { db.exec(sql); } catch(e) { /* already exists */ } };

  // ── invoices — 11 INSERT sites reference these missing columns ──────────
  migrate("ALTER TABLE invoices ADD COLUMN invoice_number TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN items_json TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN items TEXT"); // some sites use `items` not `items_json`
  migrate("ALTER TABLE invoices ADD COLUMN subtotal REAL");
  migrate("ALTER TABLE invoices ADD COLUMN tax REAL DEFAULT 0");
  migrate("ALTER TABLE invoices ADD COLUMN amount REAL");
  migrate("ALTER TABLE invoices ADD COLUMN site_id TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN description TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN issue_date TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN contact_name TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN contact_email TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN job_id TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN time_entry_ids TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN last_chased_at TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN updated_at TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN stripe_payment_link TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN stripe_session_id TEXT");
  migrate("ALTER TABLE invoices ADD COLUMN payment_link_expires_at TEXT");

  // ── social_posts — all INSERTs use `content`, schema has `text` ─────────
  migrate("ALTER TABLE social_posts ADD COLUMN content TEXT");
  migrate("ALTER TABLE social_posts ADD COLUMN platform TEXT");

  // ── user_social_tokens — missing updated_at ─────────────────────────────
  migrate("ALTER TABLE user_social_tokens ADD COLUMN updated_at TEXT");

  // ── accounting_tokens — missing updated_at ──────────────────────────────
  migrate("ALTER TABLE accounting_tokens ADD COLUMN updated_at TEXT");

  // ── contacts — INSERTs use tags_json / last_seen / company not in schema
  migrate("ALTER TABLE contacts ADD COLUMN tags_json TEXT");
  migrate("ALTER TABLE contacts ADD COLUMN last_seen TEXT");
  migrate("ALTER TABLE contacts ADD COLUMN company TEXT");
  migrate("ALTER TABLE contacts ADD COLUMN updated_at TEXT");

  // ── ad_creatives — missing platform ─────────────────────────────────────
  migrate("ALTER TABLE ad_creatives ADD COLUMN platform TEXT");

  // ── transactions — missing amount/date/reference/reference_id ───────────
  migrate("ALTER TABLE transactions ADD COLUMN amount REAL");
  migrate("ALTER TABLE transactions ADD COLUMN date TEXT");
  migrate("ALTER TABLE transactions ADD COLUMN reference TEXT");
  migrate("ALTER TABLE transactions ADD COLUMN reference_id TEXT");

  // ── orders — missing payment_method ─────────────────────────────────────
  migrate("ALTER TABLE orders ADD COLUMN payment_method TEXT");

  // ── design_generations — missing many cols ──────────────────────────────
  migrate("ALTER TABLE design_generations ADD COLUMN prompt TEXT");
  migrate("ALTER TABLE design_generations ADD COLUMN model TEXT");
  migrate("ALTER TABLE design_generations ADD COLUMN output_svg TEXT");
  migrate("ALTER TABLE design_generations ADD COLUMN output_html TEXT");
  migrate("ALTER TABLE design_generations ADD COLUMN input_tokens INTEGER");
  migrate("ALTER TABLE design_generations ADD COLUMN output_tokens INTEGER");
  migrate("ALTER TABLE design_generations ADD COLUMN cost_usd REAL");
  migrate("ALTER TABLE design_generations ADD COLUMN credits_charged INTEGER");
  migrate("ALTER TABLE design_generations ADD COLUMN status TEXT");

  // ── design_versions — missing edit_instruction ──────────────────────────
  migrate("ALTER TABLE design_versions ADD COLUMN edit_instruction TEXT");

  // ── voice_packs — missing stripe_payment_id / expires_at ────────────────
  migrate("ALTER TABLE voice_packs ADD COLUMN stripe_payment_id TEXT");
  migrate("ALTER TABLE voice_packs ADD COLUMN expires_at TEXT");

  // ── vehicles — missing color ────────────────────────────────────────────
  migrate("ALTER TABLE vehicles ADD COLUMN color TEXT");

  // ── password_resets — missing email (some INSERTs email-scope these) ────
  migrate("ALTER TABLE password_resets ADD COLUMN email TEXT");
  migrate("ALTER TABLE password_resets ADD COLUMN user_id TEXT");

  // ── scheduled_emails — missing ref_id/to_email/to_name/type ─────────────
  migrate("ALTER TABLE scheduled_emails ADD COLUMN ref_id TEXT");
  migrate("ALTER TABLE scheduled_emails ADD COLUMN to_email TEXT");
  migrate("ALTER TABLE scheduled_emails ADD COLUMN to_name TEXT");
  migrate("ALTER TABLE scheduled_emails ADD COLUMN type TEXT");

  // ── email_templates — missing body_html / category ──────────────────────
  migrate("ALTER TABLE email_templates ADD COLUMN body_html TEXT");
  migrate("ALTER TABLE email_templates ADD COLUMN category TEXT");

  // ── notifications — missing title/body ──────────────────────────────────
  migrate("ALTER TABLE notifications ADD COLUMN title TEXT");
  migrate("ALTER TABLE notifications ADD COLUMN body TEXT");

  // ── agency_clients — missing fields used at insert time ─────────────────
  migrate("ALTER TABLE agency_clients ADD COLUMN user_id TEXT");
  migrate("ALTER TABLE agency_clients ADD COLUMN client_name TEXT");
  migrate("ALTER TABLE agency_clients ADD COLUMN client_email TEXT");
  migrate("ALTER TABLE agency_clients ADD COLUMN monthly_fee REAL");
  migrate("ALTER TABLE agency_clients ADD COLUMN ai_addons TEXT");

  // ── agency_payouts — full set of fields from INSERT site ────────────────
  migrate("ALTER TABLE agency_payouts ADD COLUMN period TEXT");
  migrate("ALTER TABLE agency_payouts ADD COLUMN client_count INTEGER");
  migrate("ALTER TABLE agency_payouts ADD COLUMN gross_revenue REAL");
  migrate("ALTER TABLE agency_payouts ADD COLUMN agency_share REAL");
  migrate("ALTER TABLE agency_payouts ADD COLUMN mine_share REAL");
  migrate("ALTER TABLE agency_payouts ADD COLUMN status TEXT");

  // ── Remaining smaller drifts, one per table ─────────────────────────────
  migrate("ALTER TABLE sms_inbox ADD COLUMN body TEXT");
  migrate("ALTER TABLE sms_inbox ADD COLUMN twilio_sid TEXT");
  migrate("ALTER TABLE sms_inbox ADD COLUMN created_at TEXT");
  migrate("ALTER TABLE sms_reminder_config ADD COLUMN updated_at TEXT");
  migrate("ALTER TABLE bookings ADD COLUMN notes TEXT");
  migrate("ALTER TABLE bookings ADD COLUMN service_id TEXT");
  migrate("ALTER TABLE cold_email_replies ADD COLUMN sequence_stopped INTEGER DEFAULT 0");
  migrate("ALTER TABLE growth_agent_config ADD COLUMN updated_at TEXT");
  migrate("ALTER TABLE marketing_materials ADD COLUMN sort_order INTEGER DEFAULT 0");
  migrate("ALTER TABLE marketing_materials ADD COLUMN thumbnail_url TEXT");
  migrate("ALTER TABLE membership_enrollments ADD COLUMN expires_at TEXT");
  migrate("ALTER TABLE google_business_connections ADD COLUMN token_expiry TEXT");
  migrate("ALTER TABLE prospector_demos ADD COLUMN expires_at TEXT");
  migrate("ALTER TABLE mine_control_customer_sessions ADD COLUMN updated_at TEXT");
  migrate("ALTER TABLE biz_affiliates ADD COLUMN name TEXT");
  migrate("ALTER TABLE products ADD COLUMN site_id TEXT");
  migrate("ALTER TABLE products ADD COLUMN price REAL");
  migrate("ALTER TABLE products ADD COLUMN status TEXT");
  migrate("ALTER TABLE occasion_reminders ADD COLUMN reminder_date TEXT");
  migrate("ALTER TABLE occasion_reminders ADD COLUMN occasion_type TEXT");
  migrate("ALTER TABLE occasion_reminders ADD COLUMN occasion_date TEXT");
  migrate("ALTER TABLE occasion_reminders ADD COLUMN reminder_days TEXT");
  migrate("ALTER TABLE occasion_reminders ADD COLUMN auto_sms INTEGER DEFAULT 0");
  migrate("ALTER TABLE occasion_reminders ADD COLUMN notes TEXT");
  migrate("ALTER TABLE child_profiles ADD COLUMN parent_contact_id TEXT");
  migrate("ALTER TABLE child_profiles ADD COLUMN start_date TEXT");
  migrate("ALTER TABLE child_profiles ADD COLUMN gender TEXT");
  migrate("ALTER TABLE child_profiles ADD COLUMN dietary_notes TEXT");
  migrate("ALTER TABLE child_profiles ADD COLUMN immunisation_status TEXT");
  migrate("ALTER TABLE child_attendance ADD COLUMN check_in TEXT");
  migrate("ALTER TABLE child_attendance ADD COLUMN check_out TEXT");
  migrate("ALTER TABLE child_attendance ADD COLUMN checked_in_by TEXT");
  migrate("ALTER TABLE child_attendance ADD COLUMN checked_out_by TEXT");
  migrate("ALTER TABLE child_attendance ADD COLUMN absent INTEGER DEFAULT 0");
  migrate("ALTER TABLE child_attendance ADD COLUMN absent_reason TEXT");
  migrate("ALTER TABLE children ADD COLUMN child_name TEXT");
  migrate("ALTER TABLE children ADD COLUMN date_of_birth TEXT");
  migrate("ALTER TABLE children ADD COLUMN parent_contact_id TEXT");
  migrate("ALTER TABLE children ADD COLUMN enrollment_start TEXT");
  migrate("ALTER TABLE children ADD COLUMN enrollment_days TEXT");
  migrate("ALTER TABLE parts_inventory ADD COLUMN category TEXT");
  migrate("ALTER TABLE parts_inventory ADD COLUMN markup_pct REAL DEFAULT 0");
  migrate("ALTER TABLE parts_inventory ADD COLUMN min_stock INTEGER DEFAULT 0");
  migrate("ALTER TABLE vehicle_profiles ADD COLUMN color TEXT");
  migrate("ALTER TABLE vehicle_profiles ADD COLUMN rego_due TEXT");
  migrate("ALTER TABLE vehicle_profiles ADD COLUMN service_due TEXT");
  migrate("ALTER TABLE vehicle_profiles ADD COLUMN wof_due TEXT");
  migrate("ALTER TABLE vehicle_profiles ADD COLUMN service_interval_km INTEGER");
  migrate("ALTER TABLE vehicle_services ADD COLUMN job_id TEXT");
  migrate("ALTER TABLE vehicle_services ADD COLUMN odometer_in INTEGER");
  migrate("ALTER TABLE vehicle_services ADD COLUMN odometer_out INTEGER");
  migrate("ALTER TABLE support_retainers ADD COLUMN monthly_price REAL");
  migrate("ALTER TABLE support_retainers ADD COLUMN rate_per_hour REAL");
  migrate("ALTER TABLE support_retainers ADD COLUMN started_at TEXT");
  migrate("ALTER TABLE event_vendors ADD COLUMN amount REAL");
  migrate("ALTER TABLE event_vendors ADD COLUMN cost REAL");
  migrate("ALTER TABLE event_vendors ADD COLUMN contract_status TEXT");
  migrate("ALTER TABLE student_progress ADD COLUMN session_date TEXT");
  migrate("ALTER TABLE student_progress ADD COLUMN subject TEXT");
  migrate("ALTER TABLE student_progress ADD COLUMN topic TEXT");
  migrate("ALTER TABLE student_progress ADD COLUMN homework TEXT");
  migrate("ALTER TABLE student_progress ADD COLUMN rating INTEGER");
  migrate("ALTER TABLE ad_campaigns ADD COLUMN channel_type TEXT");
  migrate("ALTER TABLE loyalty_transactions ADD COLUMN customer_email TEXT");
  migrate("ALTER TABLE loyalty_transactions ADD COLUMN customer_name TEXT");
  migrate("ALTER TABLE loyalty_transactions ADD COLUMN reason TEXT");
  migrate("ALTER TABLE podcast_episodes ADD COLUMN episode_number INTEGER");
  migrate("ALTER TABLE podcast_episodes ADD COLUMN notes TEXT");
  migrate("ALTER TABLE podcast_episodes ADD COLUMN status TEXT");
  migrate("ALTER TABLE podcasts ADD COLUMN name TEXT");
  migrate("ALTER TABLE podcasts ADD COLUMN site_id TEXT");
  migrate("ALTER TABLE podcasts ADD COLUMN status TEXT");
  migrate("ALTER TABLE product_subscriptions ADD COLUMN name TEXT");
  migrate("ALTER TABLE product_subscriptions ADD COLUMN description TEXT");
  migrate("ALTER TABLE product_subscriptions ADD COLUMN price REAL");
  migrate("ALTER TABLE product_subscriptions ADD COLUMN interval TEXT");
  migrate("ALTER TABLE product_subscriptions ADD COLUMN features TEXT");
  migrate("ALTER TABLE product_subscriptions ADD COLUMN status TEXT");
  migrate("ALTER TABLE upsells ADD COLUMN site_id TEXT");
  migrate("ALTER TABLE upsells ADD COLUMN trigger_type TEXT");
  migrate("ALTER TABLE upsells ADD COLUMN offer_product_id TEXT");
  migrate("ALTER TABLE upsells ADD COLUMN offer_name TEXT");
  migrate("ALTER TABLE upsells ADD COLUMN offer_price REAL");
  migrate("ALTER TABLE upsells ADD COLUMN timing TEXT");
  migrate("ALTER TABLE upsells ADD COLUMN status TEXT");
  migrate("ALTER TABLE drm_rules ADD COLUMN course_id TEXT");
  migrate("ALTER TABLE drm_rules ADD COLUMN lesson_id TEXT");
  migrate("ALTER TABLE drm_rules ADD COLUMN max_downloads INTEGER");
  migrate("ALTER TABLE drm_rules ADD COLUMN device_limit INTEGER");
  migrate("ALTER TABLE drm_rules ADD COLUMN watermark TEXT");
  migrate("ALTER TABLE video_posts ADD COLUMN post_id TEXT");
  migrate("ALTER TABLE video_posts ADD COLUMN status TEXT");
  migrate("ALTER TABLE video_posts ADD COLUMN error TEXT");

  // ── Latent-bug fix: tables referenced by feature endpoints but never created.
  // Without these, hitting the relevant endpoints throws SQLite errors that get
  // swallowed by route try/catch and show as generic "internal error" to users.
  // Found during a full audit; all CREATE TABLE IF NOT EXISTS so idempotent.
  migrate(`CREATE TABLE IF NOT EXISTS voice_calls (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, call_sid TEXT, from_number TEXT, to_number TEXT,
    direction TEXT, status TEXT, duration INTEGER, recording_url TEXT,
    followup_sent TEXT, transcript TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS call_transcripts (
    id TEXT PRIMARY KEY, user_id TEXT, call_sid TEXT, direction TEXT,
    speaker TEXT, text TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS user_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, key TEXT, name TEXT,
    description TEXT, icon TEXT, claimed INTEGER DEFAULT 0, claimed_at TEXT, points INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, key))`);
  migrate(`CREATE TABLE IF NOT EXISTS user_alerts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT, title TEXT, body TEXT,
    read INTEGER DEFAULT 0, severity TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT, access_token TEXT,
    refresh_token TEXT, scope TEXT, expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT,
    UNIQUE(user_id, provider))`);
  migrate(`CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY, user_id TEXT, job_type TEXT, payload TEXT,
    run_at TEXT, status TEXT DEFAULT 'pending', result TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS course_modules (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL, title TEXT, description TEXT,
    position INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS course_lessons (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL, module_id TEXT, title TEXT,
    body TEXT, video_url TEXT, position INTEGER DEFAULT 0,
    duration_minutes INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS changelog_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, subscribed_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS cold_email_sequence_steps (
    id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL, position INTEGER DEFAULT 0,
    delay_days INTEGER DEFAULT 0, subject TEXT, body TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS email_campaigns (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, subject TEXT,
    body TEXT, segment TEXT, status TEXT DEFAULT 'draft', sent_at TEXT,
    opens INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS accounting_connections (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT, status TEXT,
    last_sync_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  migrate(`CREATE TABLE IF NOT EXISTS agency_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agency_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member', created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agency_id, user_id))`);

  console.log("[schema] migrations complete");
})();

/* ─── TAILWIND BACKFILL — one-time recompile of existing CDN-based sites ───
 * Runs once at boot after schema migrations. Finds every live site that still
 * uses the Tailwind CDN, compiles its CSS into a static <style> block, and
 * strips the CDN script. Skips already-compiled sites (they have a
 * data-tw-compiled marker). Runs sequentially to avoid thundering herd on
 * the Tailwind CLI and respects a per-deploy MAX cap so the server still
 * comes up within a reasonable boot window. The job is idempotent — if it
 * doesn't finish in one boot, subsequent boots pick up where it left off.
 */
(function runTailwindBackfill() {
  if (process.env.TAILWIND_BACKFILL === "skip") {
    console.log("[tailwind-backfill] skipped by env TAILWIND_BACKFILL=skip");
    return;
  }
  // Run asynchronously — do NOT block server startup on this.
  setTimeout(async () => {
    try {
      const db = global.mineGetDb ? global.mineGetDb() : require("better-sqlite3")(process.env.DB_PATH ? process.env.DB_PATH + "/mine.db" : "./mine.db");
      const { compileTailwind, usesTailwindCdn } = require("./utils/tailwind-compile");

      // Find sites that need compiling: live status, have HTML, use CDN, not yet compiled.
      const candidates = db.prepare(
        "SELECT id, html FROM sites WHERE status = 'live' AND html IS NOT NULL AND length(html) > 100"
      ).all();

      const needsCompile = candidates.filter(s =>
        s.html &&
        usesTailwindCdn(s.html) &&
        !s.html.includes('data-tw-compiled="1"')
      );

      if (!needsCompile.length) return;

      console.log(`[tailwind-backfill] ${needsCompile.length} sites need compile — starting background pass`);

      const MAX_PER_BOOT = parseInt(process.env.TAILWIND_BACKFILL_MAX || "100", 10);
      const limit = Math.min(needsCompile.length, MAX_PER_BOOT);

      let ok = 0, fail = 0;
      for (let i = 0; i < limit; i++) {
        const site = needsCompile[i];
        try {
          const result = await compileTailwind(site.html, { timeoutMs: 15000 });
          if (result && result.html && !result.skipped) {
            db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?")
              .run(result.html, site.id);
            ok++;
          } else {
            fail++;
          }
        } catch (e) {
          console.error(`[tailwind-backfill] site ${site.id} failed:`, e.message);
          fail++;
        }
        // Small yield so the event loop isn't fully blocked
        if (i % 5 === 4) await new Promise(r => setTimeout(r, 100));
      }

      console.log(`[tailwind-backfill] done: ${ok} compiled, ${fail} failed, ${needsCompile.length - limit} deferred to next boot`);
    } catch (err) {
      console.error("[tailwind-backfill] pass aborted:", err.message);
    }
  }, 8000); // 8s delay — let server finish booting + serving requests first
})();

/* ─── SECURITY CHECKS — blocks startup if unsafe defaults are in use ─── */
if (process.env.NODE_ENV === "production") {
  const UNSAFE_DEFAULTS = {
    JWT_SECRET:              ["change-this-to-random-64-chars", "change-this-to-a-random-64-character-string", undefined],
    INTERNAL_API_KEY:        ["mine-internal-2024", "change-this-to-a-random-secret", undefined],
    CRON_SECRET:             ["change-this-to-another-random-secret", undefined],
    WHATSAPP_APP_SECRET:     [undefined],        // required for webhook signature verification
    WHATSAPP_PHONE_NUMBER_ID:[undefined],        // required to send WhatsApp messages
    WHATSAPP_API_KEY:        [undefined],        // WhatsApp Cloud API bearer token
  };
  // Warn (don't block) on optional-but-important vars
  const WARN_IF_MISSING = [
    "STRIPE_SECRET_KEY",
    "SENDGRID_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
  ];
  for (const key of WARN_IF_MISSING) {
    if (!process.env[key]) {
      console.warn(`  ⚠️  ${key} not set — related features will be disabled`);
    }
  }
  const failures = [];
  for (const [key, badValues] of Object.entries(UNSAFE_DEFAULTS)) {
    if (badValues.includes(process.env[key])) {
      failures.push(`  ❌ ${key} is using an unsafe default or is not set`);
    }
  }
  if (failures.length > 0) {
    console.error("\n🚨 STARTUP BLOCKED — Unsafe secrets detected in production:\n");
    failures.forEach(f => console.error(f));
    console.error("\n  Generate secure values with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    console.error("  Then set them in your .env file\n");
    process.exit(1);
  }
}



// ── Production env completeness warnings ─────────────────────────────────────
(function warnMissingEnv() {
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.BACKEND_URL)
      console.warn('[MINE] ⚠️  BACKEND_URL not set — automation triggers will call localhost:4000 and fail silently');
    if (!process.env.ANTHROPIC_API_KEY)
      console.warn('[MINE] ⚠️  ANTHROPIC_API_KEY not set — all AI features disabled');
    if (!process.env.SENDGRID_API_KEY)
      console.warn('[MINE] ⚠️  SENDGRID_API_KEY not set — emails will not send');
    if (!process.env.TWILIO_ACCOUNT_SID)
      console.warn('[MINE] ⚠️  TWILIO_ACCOUNT_SID not set — SMS features disabled');
  }
})();const app = express();
app.set("trust proxy", 1); // Trust first proxy (nginx) so rate limiters see real client IPs
// Expose db instance on app.locals so all routes can access via req.app.locals.db
app.locals.db = require("./db/init").getDb();
// Path-compatibility — rewrites wrong-prefix dashboard paths to their real
// handlers BEFORE any route is matched (see routes/path-compat.js).
app.use(require("./routes/path-compat"));
const _stripeServer = process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null;
function getStripeServer() {
  if (_stripeServer) return _stripeServer;
  const key = getSetting("STRIPE_SECRET_KEY");
  return key ? require("stripe")(key) : null;
}
const stripe = new Proxy({}, { get: (_, prop) => { const s = getStripeServer(); if (!s) throw new Error("Stripe not configured"); return s[prop]; } });

/* ─── STRUCTURED LOGGING ─── */
// Replaces ad-hoc console.* with JSON-structured logs that integrate with
// log aggregators (Datadog, Loggly, Better Stack). Existing console.*
// statements throughout the codebase keep working — this just adds
// per-request structure.
try {
  const { httpLogger } = require("./utils/logger");
  app.use(httpLogger);
} catch (e) {
  // Logger is optional — if pino isn't installed, fall through silently.
  console.warn("[server] structured logger not available:", e.message);
}

/* ─── SECURITY ─── */
app.use(helmet({
  // Needed for embedded chatbot/badge widgets served cross-origin
  crossOriginResourcePolicy: false,

  // HSTS — 1 year, include subdomains, preload-ready
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },

  // Deny framing on all dashboard/API responses; hosted storefronts opt-out via their own header
  frameguard: { action: "sameorigin" },

  // Content-Security-Policy — tight defaults; Stripe, SendGrid, and CDN integrations whitelisted
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "https://js.stripe.com", "https://cdnjs.cloudflare.com"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:", "blob:", "https:"],
      connectSrc:  ["'self'", "https://api.stripe.com", "https://api.sendgrid.com"],
      frameSrc:    ["'self'", "https://js.stripe.com"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
      formAction:  ["'self'"],
    },
  },
}));
app.use(cookieParser());
const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL, process.env.FRONTEND_URL.replace("https://", "https://www.")]
  : ["http://localhost:3000", "http://localhost:3001"];

// Public routes (deployed sites, form submissions, chatbot embeds) need open CORS
app.use(["/api/public", "/hosted", "/hosting/pixel", "/api/hosting/geo"], cors({ origin: "*" }));

// Dashboard API — restrict to known origins (exact match to prevent subdomain bypass)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true
}));
// API rate limits: stricter for auth, generous for dashboard
const apiLimiter = rateLimit({ windowMs: 60000, max: 300, message: { error: "Too many requests, slow down." }, skip: (req) => req.path.startsWith("/webhook") });
app.use(apiLimiter);

// ── Trial gate ── paywall gated routes when trial expires ───────────────────
const PAYWALLED_PREFIXES = [
  "/api/features","/api/ai-features","/api/ai-employees",
  "/api/sms","/api/outreach","/api/platform","/api/ads",
  "/api/affiliates","/api/email","/api/data","/api/sites",
  "/api/ai-agent","/api/growth-agent","/api/mine-control",
  "/api/intelligence",
];
app.use((req, res, next) => {
  const isPaywalled = PAYWALLED_PREFIXES.some(p => req.path.startsWith(p));
  if (!isPaywalled) return next();
  if (!req.user) return next();
  const { requireActivePlan } = require("./middleware/auth");
  return requireActivePlan(req, res, next);
});


/* ─── STRIPE WEBHOOK (raw body before json parser) ─── */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });
  let event;
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || getSetting("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      return res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET is not configured — webhook rejected" });
    }
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
  } catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  const db = getDb();
  const d = event.data.object;

  // ── Agency one-off invoices: dispatch to dedicated handler if metadata matches ──
  // Triggered for invoices created via /api/agency/clients/:id/invoice. We check
  // metadata on both the checkout session and the payment intent it spawns.
  try {
    const meta = (d && d.metadata) || {};
    const piMeta = (d && d.payment_intent && typeof d.payment_intent === "object") ? (d.payment_intent.metadata || {}) : {};
    if (meta.type === "agency_invoice" || piMeta.type === "agency_invoice") {
      const handled = require("./routes/agency-invoices").handleStripeEvent(event);
      if (handled) return res.json({ received: true, dispatched: "agency_invoice" });
    }
  } catch (e) {
    console.error("[webhook] agency-invoice dispatch error:", e.message);
  }

  try {
    const meta = (d && d.metadata) || {};
    const piMeta = (d && d.payment_intent && typeof d.payment_intent === "object") ? (d.payment_intent.metadata || {}) : {};
    if (meta.type === "platform_charge" || piMeta.type === "platform_charge") {
      const handled = require("./routes/admin-finance").handleStripeEvent(event);
      if (handled) return res.json({ received: true, dispatched: "platform_charge" });
    }
  } catch (e) {
    console.error("[webhook] platform-charge dispatch error:", e.message);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const userId = d.metadata.mine_user, planId = d.metadata.mine_plan;

      // ── Agency client card setup — save stripe_customer_id + set default payment method ──
      if (d.metadata.type === "agency_client_setup" && d.mode === "setup" && d.metadata.mine_user) {
        try {
          const agencyClientId = d.metadata.mine_agency_client;
          const agencyUserId   = d.metadata.mine_user;
          const stripeCustomer = d.customer;

          // Save stripe_customer_id to both user and agency_clients records
          db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?")
            .run(stripeCustomer, agencyUserId);
          if (agencyClientId) {
            db.prepare("UPDATE agency_clients SET stripe_customer_id = ? WHERE id = ?")
              .run(stripeCustomer, agencyClientId);
          }

          // Set the new payment method as the default so future invoices charge automatically
          if (d.setup_intent) {
            const si = await stripe.setupIntents.retrieve(d.setup_intent);
            if (si.payment_method) {
              await stripe.customers.update(stripeCustomer, {
                invoice_settings: { default_payment_method: si.payment_method },
              });
            }
          }

        } catch(e) { console.error("[WEBHOOK] Agency client setup error:", e.message); }
        break;
      }

      // ── Subscription payment (MINE plan) ──
      if (userId && planId && d.mode === "subscription") {
        const limits = { starter: 500, growth: 1000, pro: 3000, enterprise: 10000 };

        // Save plan + Stripe IDs immediately — subscription.updated/deleted look up by stripe_subscription_id
        try {
          db.prepare("UPDATE users SET plan=?, email_limit=?, stripe_customer_id=?, stripe_subscription_id=?, updated_at=datetime('now') WHERE id=?")
            .run(planId, limits[planId] || 500, d.customer || null, d.subscription || null, userId);

        } catch(e) { console.error("[WEBHOOK] Failed to save plan to user:", e.message); }

        // Set the subscription's payment method as the customer's default
        // so future off-subscription invoices (overages, voice packs) can charge automatically
        try {
          if (d.subscription && d.customer) {
            const sub = await stripe.subscriptions.retrieve(d.subscription);
            const pmId = sub.default_payment_method;
            if (pmId) {
              await stripe.customers.update(d.customer, {
                invoice_settings: { default_payment_method: pmId }
              });
            }
          }
        } catch(e) { console.error("[WEBHOOK] Failed to set default payment method:", e.message); }

        // Auto-enroll in "New signup" funnels
        try { const { autoEnrollInFunnels } = require("./routes/email"); autoEnrollInFunnels(db, userId, "New signup", d.customer_email, ""); } catch(e) {}
        const user = db.prepare("SELECT referred_by FROM users WHERE id=?").get(userId);
        if (user?.referred_by) {
          const referrer = db.prepare("SELECT * FROM users WHERE referral_code=?").get(user.referred_by);
          if (referrer && referrer.id !== userId) { // prevent self-referral exploit
            const prices = {starter:69,growth:99,pro:149,enterprise:299};
            const price = prices[planId]||0;
            const pct = (referrer.referral_revenue||0) >= 10000 ? 20 : (referrer.referral_revenue||0) >= 5000 ? 17 : (referrer.referral_revenue||0) >= 1000 ? 15 : 13;
            const commission = Math.round(price * pct) / 100;
            // Only pay commission once per referred user (not on every renewal)
            const alreadyPaid = db.prepare("SELECT id FROM referrals WHERE referrer_id=? AND referred_id=?").get(referrer.id, userId);
            if (!alreadyPaid) {
              db.prepare("INSERT INTO referrals (id,referrer_id,referred_id,referred_name,plan,commission) VALUES (?,?,?,?,?,?)").run(uuid(), referrer.id, userId, d.customer_email||"", planId, commission);
              db.prepare("UPDATE users SET referral_revenue=referral_revenue+?, commission_earned=commission_earned+? WHERE id=?").run(price, commission, referrer.id);
            }
          }
        }
      }

      // ── Voice Pack purchase ──
      if (d.metadata?.type === "voice_pack" && d.metadata?.user_id && d.mode === "payment") {
        try {
          const { fulfillVoicePack } = require("./routes/features");
          const mins = parseInt(d.metadata.mins) || 100;
          fulfillVoicePack(db, d.metadata.user_id, mins, d.payment_intent);
        } catch(e) { console.error("Voice pack fulfillment error:", e.message); }
      }

      // ── Storefront payment (customer buying from MINE user's store) ──

        // ── Course purchase → grant student access ──────────────────────
        if (d.metadata?.mine_course && d.mode === "payment") {
          try {
            const { v4: courseUuid } = require("uuid");
            const courseId     = d.metadata.mine_course;
            const studentEmail = (d.metadata.student_email || d.customer_email || "").toLowerCase();
            const studentName  = d.metadata.student_name || d.customer_details?.name || "";
            const courseTitle  = d.metadata.course_title || "Course";
            const siteId       = d.metadata.mine_site;
            const storeOwnerId = d.metadata.mine_user;

            db.exec("CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, student_name TEXT, amount_paid REAL, stripe_session_id TEXT, access_token TEXT, created_at TEXT DEFAULT (datetime('now')))");

            // Idempotent
            const existingEnroll = db.prepare("SELECT id FROM enrollments WHERE stripe_session_id = ?").get(d.id);
            if (!existingEnroll && studentEmail) {
              const accessToken = courseUuid().replace(/-/g,"") + courseUuid().replace(/-/g,"");
              db.prepare("INSERT OR IGNORE INTO enrollments (id, course_id, student_email, student_name, amount_paid, stripe_session_id, access_token) VALUES (?,?,?,?,?,?,?)")
                .run(courseUuid(), courseId, studentEmail, studentName, (d.amount_total||0)/100, d.id, accessToken);

              // Create student login session
              db.exec("CREATE TABLE IF NOT EXISTS student_sessions (token TEXT PRIMARY KEY, email TEXT, course_id TEXT, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT)");
              const sessionToken = courseUuid();
              const expiry = new Date(Date.now() + 30*24*60*60*1000).toISOString(); // 30 days
              db.prepare("INSERT OR REPLACE INTO student_sessions (token, email, course_id, expires_at) VALUES (?,?,?,?)").run(sessionToken, studentEmail, courseId, expiry);

              // Send access email with login link
              const sgKey = db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value || process.env.SENDGRID_API_KEY;
              const fromEmail = db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value || process.env.EMAIL_FROM || "noreply@takeova.ai";
              const accessUrl = `${process.env.FRONTEND_URL || "https://takeova.ai"}/api/public/portal/${accessToken}`;
              const loginUrl  = `${process.env.FRONTEND_URL || "https://takeova.ai"}/api/public/course-login/${sessionToken}`;
              const site = db.prepare("SELECT name FROM sites WHERE id = ?").get(siteId);
              const bizName = site?.name || "MINE";

              if (sgKey && studentEmail) {
                const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
                await fetch("https://api.sendgrid.com/v3/mail/send", {
                  method: "POST",
                  headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    personalizations: [{ to: [{ email: studentEmail, name: studentName }] }],
                    from: { email: fromEmail, name: bizName },
                    subject: `You're enrolled in ${courseTitle}! Here's your access link.`,
                    content: [{
                      type: "text/html",
                      value: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#1a1a1a">
                        <div style="background:linear-gradient(135deg,#2563EB,#7C3AED);padding:32px 24px;border-radius:16px 16px 0 0;text-align:center">
                          <div style="color:#fff;font-size:28px;font-weight:900;letter-spacing:-0.5px">${bizName}</div>
                        </div>
                        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:32px 24px">
                          <h1 style="font-size:22px;font-weight:800;margin:0 0 8px">You're in! 🎉</h1>
                          <p style="color:#555;margin-bottom:24px">Hi ${studentName || "there"}, your payment was successful. You now have full access to <strong>${courseTitle}</strong>.</p>
                          <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Access Your Course →</a>
                          <p style="color:#888;font-size:12px;margin-top:24px">Link expires in 30 days. <a href="${loginUrl}" style="color:#2563EB">Click here</a> to access your course at any time.</p>
                          <hr style="border:none;border-top:1px solid #f0f0f0;margin:24px 0">
                          <p style="color:#aaa;font-size:11px;text-align:center">Powered by MINE</p>
                        </div>
                      </body></html>`
                    }]
                  })
                }).catch(e => console.error("[Course email]", e.message));
              }

              // Award loyalty points
              try {
                const loyaltyPoints = Math.floor((d.amount_total||0) / 100);
                db.exec("CREATE TABLE IF NOT EXISTS loyalty_points (id TEXT PRIMARY KEY, user_id TEXT, customer_email TEXT, points INTEGER, source TEXT, created_at TEXT DEFAULT (datetime('now')))");
                db.prepare("INSERT INTO loyalty_points (id, user_id, customer_email, points, source) VALUES (?,?,?,?,?)").run(courseUuid(), storeOwnerId, studentEmail, loyaltyPoints, "course_purchase");
              } catch(e) {}

              console.log("[Webhook] Course enrollment created:", courseId, studentEmail);
            }
          } catch(e) { console.error("[Webhook] Course enrollment error:", e.message); }
        }

      if (d.metadata?.mine_site && d.mode === "payment") {
        try {
          const siteId = d.metadata.mine_site;
          const storeOwnerId = d.metadata.mine_user;
          const shipping = d.shipping_details || d.customer_details?.address ? {
            name: d.shipping_details?.name || d.customer_details?.name || "",
            address: d.shipping_details?.address || d.customer_details?.address || {},
          } : null;

          const orderId = uuid();
          const orderNumber = "ORD-" + Date.now().toString(36).toUpperCase();
          const items = JSON.parse(d.metadata.items_json || "[]");
          const totalCents = d.amount_total || items.reduce((s, i) => s + i.price * (i.quantity || 1) * 100, 0);

          // Create order record
          db.exec("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, order_number TEXT, site_id TEXT, user_id TEXT, customer_email TEXT, customer_name TEXT, items TEXT, total REAL, shipping_name TEXT, shipping_address TEXT, status TEXT DEFAULT 'pending', tracking_number TEXT, carrier TEXT, stripe_session_id TEXT, created_at TEXT DEFAULT (datetime('now')))");

          // Idempotent — skip if Stripe already delivered this webhook
          const existingOrder = db.prepare("SELECT id FROM orders WHERE stripe_session_id = ?").get(d.id);
          if (existingOrder) { console.log("[Webhook] Duplicate order webhook skipped:", d.id); break; }
          db.prepare("INSERT OR IGNORE INTO orders (id, order_number, site_id, user_id, customer_email, customer_name, items, total, shipping_name, shipping_address, stripe_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(orderId, orderNumber, siteId, storeOwnerId, d.customer_email || "", shipping?.name || d.customer_details?.name || "", JSON.stringify(items), totalCents / 100,
              shipping?.name || "", JSON.stringify(shipping?.address || {}), d.id);

          // Mark abandoned cart as recovered
          try {
            db.prepare("UPDATE abandoned_carts SET recovered = 1 WHERE session_id = ?").run(d.id);
          } catch(e) {}

          // Auto-send order confirmation email
          const site = db.prepare("SELECT name FROM sites WHERE id = ?").get(siteId);
          const bizName = site?.name || "Store";
          const sgKey = db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value || process.env.SENDGRID_API_KEY;
          const fromEmail = db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value || process.env.EMAIL_FROM || "noreply@takeova.ai";
          const ownerUser = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(storeOwnerId);
          const refCode = ownerUser?.referral_code || "";

          if (sgKey && d.customer_email) {
            const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
            const itemsHtml = items.map(i =>
              `<tr><td style="padding:12px;border-bottom:1px solid #f0f0f0">${i.name}</td><td style="padding:12px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity || 1}</td><td style="padding:12px;border-bottom:1px solid #f0f0f0;text-align:right">$${(i.price * (i.quantity || 1)).toFixed(2)}</td></tr>`
            ).join("");

            const shippingHtml = shipping?.address ? `
              <div style="background:#f7f8fa;padding:16px;border-radius:8px;margin:16px 0">
                <strong>📦 Shipping to:</strong><br>
                ${shipping.name || ""}<br>
                ${shipping.address.line1 || ""}${shipping.address.line2 ? "<br>" + shipping.address.line2 : ""}<br>
                ${shipping.address.city || ""}, ${shipping.address.state || ""} ${shipping.address.postal_code || ""}<br>
                ${shipping.address.country || ""}
              </div>` : "";

            const hasDigital = items.some(i => i.type === "digital");

            await fetch("https://api.sendgrid.com/v3/mail/send", {
              method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
              body: JSON.stringify({
                personalizations: [{ to: [{ email: d.customer_email }] }],
                from: { email: fromEmail, name: bizName },
                subject: `Order confirmed — #${orderNumber} from ${bizName}`,
                content: [{ type: "text/html", value: `
                  <div style="font-family:system-ui;max-width:600px;margin:0 auto">
                    <div style="background:#f8f8f8;padding:24px;text-align:center;border-radius:8px 8px 0 0">
                      <h1 style="font-size:20px;margin:0">Order Confirmed! ✅</h1>
                      <p style="color:#666;margin:8px 0 0">Thank you for your purchase from ${bizName}</p>
                    </div>
                    <div style="padding:24px">
                      <p>Hi ${shipping?.name || d.customer_details?.name || "there"},</p>
                      <p>Your order <strong>#${orderNumber}</strong> has been received and is being processed.</p>
                      <table style="width:100%;border-collapse:collapse;margin:16px 0">
                        <thead><tr style="background:#f7f8fa"><th style="padding:12px;text-align:left">Item</th><th style="padding:12px;text-align:center">Qty</th><th style="padding:12px;text-align:right">Amount</th></tr></thead>
                        <tbody>${itemsHtml}</tbody>
                        <tfoot><tr><td colspan="2" style="padding:12px;font-weight:bold">Total</td><td style="padding:12px;font-weight:bold;text-align:right">$${(totalCents / 100).toFixed(2)}</td></tr></tfoot>
                      </table>
                      ${shippingHtml}
                      ${hasDigital ? "<p>📥 Your digital items will be delivered to this email shortly.</p>" : "<p style='color:#666;font-size:13px'>We'll send you a shipping notification when your order is on its way.</p>"}
                      <p style="text-align:center;margin-top:16px"><a href="${process.env.BACKEND_URL || "http://localhost:4000"}/api/features/orders/status/${orderNumber}" style="color:#635BFF;font-size:13px;font-weight:600">📦 Track your order →</a></p>
                      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #f0f0f0;text-align:center">
                        <a href="https://takeova.ai${refCode ? "?ref=" + refCode : ""}" style="color:#999;font-size:11px;text-decoration:none">Sent via <strong style="color:#635BFF">MINE</strong></a>
                      </div>
                    </div>
                  </div>` }]
              })
            });
          }

          // Auto-deliver digital products
          if (items.some(i => i.type === "digital")) {
            for (const item of items.filter(i => i.type === "digital" && i.downloadUrl)) {
              try {
                const dlToken = uuid();
                db.exec("CREATE TABLE IF NOT EXISTS digital_downloads (id TEXT PRIMARY KEY, user_id TEXT, order_id TEXT, customer_email TEXT, product_name TEXT, download_url TEXT, token TEXT UNIQUE, downloads INTEGER DEFAULT 0, max_downloads INTEGER DEFAULT 5, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')))");
                db.prepare("INSERT INTO digital_downloads (id, user_id, order_id, customer_email, product_name, download_url, token, expires_at) VALUES (?,?,?,?,?,?,?,?)")
                  .run(uuid(), storeOwnerId, orderId, d.customer_email, item.name, item.downloadUrl, dlToken, new Date(Date.now() + 7*24*60*60*1000).toISOString());
              } catch(e) {}
            }
          }

          // Auto-enroll in purchase funnels
          try { const { autoEnrollInFunnels } = require("./routes/email"); autoEnrollInFunnels(db, storeOwnerId, "Purchase completed", d.customer_email, shipping?.name || ""); } catch(e) {}

          // FIX: Update contact status to 'customer' and increment customer_accounts
          try {
            if (d.customer_email) {
              // Update contact status
              db.prepare("UPDATE contacts SET status = 'customer', last_activity = datetime('now') WHERE user_id = ? AND email = ? AND status != 'customer'").run(storeOwnerId, d.customer_email.toLowerCase());

              // Update customer_accounts total_spent and order_count
              db.exec("CREATE TABLE IF NOT EXISTS customer_accounts (id TEXT PRIMARY KEY, site_id TEXT, email TEXT, name TEXT, phone TEXT, total_spent REAL DEFAULT 0, order_count INTEGER DEFAULT 0, loyalty_points INTEGER DEFAULT 0, created_at TEXT, last_login TEXT)");
              const custAcct = db.prepare("SELECT id, loyalty_points, order_count, total_spent FROM customer_accounts WHERE email = ? AND site_id = ?").get(d.customer_email, siteId);
              if (custAcct) {
                db.prepare("UPDATE customer_accounts SET total_spent = total_spent + ?, order_count = order_count + 1 WHERE id = ?").run(totalCents / 100, custAcct.id);

                // Award loyalty points now that payment is confirmed
                try {
                  const { v4: luuid } = require("uuid");
                  const loyaltyConfig = db.prepare("SELECT * FROM loyalty_config WHERE user_id = ? AND enabled = 1").get(storeOwnerId);
                  if (loyaltyConfig) {
                    const points = Math.floor(totalCents / 100 * (loyaltyConfig.points_per_dollar || 1));
                    if (points > 0) {
                      const newBal = (custAcct.loyalty_points || 0) + points;
                      db.prepare("UPDATE customer_accounts SET loyalty_points = ? WHERE id = ?").run(newBal, custAcct.id);
                      db.exec("CREATE TABLE IF NOT EXISTS loyalty_transactions (id TEXT PRIMARY KEY, customer_id TEXT, user_id TEXT, type TEXT, points INTEGER, balance_after INTEGER, description TEXT, reference_id TEXT, created_at TEXT DEFAULT (datetime(\'now\')))");
                      db.prepare("INSERT INTO loyalty_transactions (id, customer_id, user_id, type, points, balance_after, description, reference_id) VALUES (?,?,?,?,?,?,?,?)")
                        .run(luuid(), custAcct.id, storeOwnerId, "purchase", points, newBal, `Earned ${points} pts from $${(totalCents/100).toFixed(2)} order`, d.id);

                      // Check milestones
                      db.exec("CREATE TABLE IF NOT EXISTS loyalty_milestones_achieved (id TEXT PRIMARY KEY, customer_id TEXT, milestone_name TEXT, points_awarded INTEGER, created_at TEXT DEFAULT (datetime(\'now\')), UNIQUE(customer_id, milestone_name))");
                      const milestones = JSON.parse(loyaltyConfig.milestones || "[]");
                      const updated = db.prepare("SELECT * FROM customer_accounts WHERE id = ?").get(custAcct.id);
                      for (const m of milestones) {
                        try {
                          const existing = db.prepare("SELECT id FROM loyalty_milestones_achieved WHERE customer_id = ? AND milestone_name = ?").get(custAcct.id, m.name);
                          if (existing) continue;
                          let met = false;
                          if (m.trigger === "order_count") met = updated.order_count >= m.value;
                          else if (m.trigger === "total_spent") met = updated.total_spent >= m.value;
                          if (met && m.reward) {
                            db.prepare("UPDATE customer_accounts SET loyalty_points = loyalty_points + ? WHERE id = ?").run(m.reward, custAcct.id);
                            db.prepare("INSERT INTO loyalty_milestones_achieved (id, customer_id, milestone_name, points_awarded) VALUES (?,?,?,?)").run(luuid(), custAcct.id, m.name, m.reward);
                          }
                        } catch(e) {}
                      }
                    }
                  }
                } catch(e) { console.error("[WEBHOOK] Loyalty award error:", e.message); }

                // Mark any used loyalty reward coupon as consumed (deferred from session creation)
                try {
                  const items = JSON.parse(d.metadata?.items_json || "[]");
                  const metaCode = d.metadata?.coupon_code;
                  if (metaCode && metaCode.startsWith("REWARD-")) {
                    db.exec("CREATE TABLE IF NOT EXISTS loyalty_redemptions (id TEXT PRIMARY KEY, customer_id TEXT, user_id TEXT, reward_name TEXT, points_spent INTEGER, type TEXT, value REAL, coupon_code TEXT UNIQUE, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime(\'now\')))");
                    db.prepare("UPDATE loyalty_redemptions SET used = 1 WHERE coupon_code = ?").run(metaCode);
                  }
                } catch(e) {}
              }
            }
          } catch(e) {}

          // Notify store owner of new sale
          try {
            const { notifyOwnerOfSale, recordTransaction } = require("./routes/features");
            await notifyOwnerOfSale(storeOwnerId, orderNumber, shipping?.name || d.customer_details?.name || d.customer_email, totalCents / 100, items);
            // Auto-record income transaction for the bookkeeper
            recordTransaction(db, storeOwnerId, "income", totalCents / 100, items[0]?.type === "course" ? "Course Sales" : items[0]?.type === "service" ? "Service Revenue" : "Product Sales", `Order #${orderNumber} — ${items.map(i => i.name).join(", ")}`, "stripe", d.id, new Date().toISOString().split("T")[0]);
            // Record platform fee as expense
            const fee = parseInt(d.metadata.platform_fee || 0);
            if (fee > 0) recordTransaction(db, storeOwnerId, "expense", fee / 100, "Payment Processing", `MINE platform fee — Order #${orderNumber}`, "stripe", d.id, new Date().toISOString().split("T")[0]);
          } catch(e) {}

          // ── Intelligence: log order event ──────────────────────────────
          try {
            const { logEvent } = require("./routes/intelligence");
            // Check if this is the user's first ever sale
            const prevOrders = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE user_id = ? AND id != ?").get(storeOwnerId, orderId);
            logEvent(db, storeOwnerId, prevOrders?.cnt === 0 ? "first_sale" : "order_received", {
              amount: Math.round(totalCents / 100),
              itemCount: items.length,
              orderNumber,
            });
          } catch(e) {}

          // Schedule review request 3 days after purchase
          try {
            // Decrement inventory
            const { decrementStock } = require("./routes/features");
            decrementStock(db, storeOwnerId, items);
          } catch(e) {}

          try {
            db.exec("CREATE TABLE IF NOT EXISTS scheduled_emails (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT, send_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");
            const topItem = items[0]?.name || "your purchase";
            const site2 = db.prepare("SELECT name FROM sites WHERE id = ?").get(siteId);
            const biz = site2?.name || "Store";
            db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at) VALUES (?,?,?,?,?,datetime('now','+3 days'))")
              .run(uuid(), storeOwnerId, d.customer_email, `How was your experience with ${biz}? ⭐`, `Hi ${shipping?.name || "there"},\n\nYou recently purchased ${topItem} from ${biz}. We'd love to hear what you think!\n\nLeave a quick review here: ${process.env.BACKEND_URL || "http://localhost:4000"}/api/features/reviews/submit/${siteId}\n\nIt only takes 30 seconds and means the world to us.\n\n— ${biz}`);
          } catch(e) {}
        } catch(e) { console.error("Order creation error:", e.message); }
      }

      // ── Membership subscription enrollment (customer subscribing to user's membership) ──
      if (d.metadata?.mine_site && d.mode === "subscription") {
        try {
          const siteOwner = db.prepare("SELECT id FROM users WHERE id = ?").get(d.metadata.mine_user);
          if (siteOwner && d.customer_email && d.subscription) {
            // Migrate membership_enrollments columns if needed
            try { db.exec("ALTER TABLE membership_enrollments ADD COLUMN stripe_subscription_id TEXT"); } catch(e) {}
            try { db.exec("ALTER TABLE membership_enrollments ADD COLUMN stripe_customer_id TEXT"); } catch(e) {}
            // Upsert enrollment
            db.exec("CREATE TABLE IF NOT EXISTS membership_enrollments (id TEXT PRIMARY KEY, membership_id TEXT, user_id TEXT, customer_email TEXT, customer_name TEXT, status TEXT DEFAULT 'active', started_at TEXT DEFAULT (datetime('now')), expires_at TEXT, expiry_warned TEXT, stripe_subscription_id TEXT, stripe_customer_id TEXT, created_at TEXT DEFAULT (datetime('now')))");
            const existing = db.prepare("SELECT id FROM membership_enrollments WHERE user_id = ? AND customer_email = ? AND status = 'active'").get(siteOwner.id, d.customer_email);
            if (!existing) {
              db.prepare("INSERT INTO membership_enrollments (id, user_id, customer_email, customer_name, status, stripe_subscription_id, stripe_customer_id) VALUES (?,?,?,?,?,?,?)")
                .run(uuid(), siteOwner.id, d.customer_email, d.customer_details?.name || "", "active", d.subscription, d.customer || null);
            } else {
              db.prepare("UPDATE membership_enrollments SET stripe_subscription_id = ?, stripe_customer_id = ?, status = 'active' WHERE id = ?")
                .run(d.subscription, d.customer || null, existing.id);
            }
          }
        } catch(e) { console.error("[Webhook] Membership enrollment error:", e.message); }
      }

      break;
    }
    case "customer.subscription.updated": {
      // Handle plan upgrades/downgrades mid-cycle
      const subId = d.id;
      const planId = d.metadata?.mine_plan || d.items?.data?.[0]?.price?.metadata?.plan;
      if (planId) {
        const limits = { starter: 500, growth: 1000, pro: 3000, enterprise: 10000 };
        const subUser = db.prepare("SELECT id FROM users WHERE stripe_subscription_id = ?").get(subId)
                     || (d.metadata?.mine_user ? db.prepare("SELECT id FROM users WHERE id = ?").get(d.metadata.mine_user) : null);
        if (subUser) {
          db.prepare("UPDATE users SET plan=?, email_limit=?, updated_at=datetime('now') WHERE id=?")
            .run(planId, limits[planId] || 500, subUser.id);

        }
      }
      // Also sync default_payment_method — fires when user updates card via billing portal.
      // Without this, overage invoices after a card change would charge the old card.
      try {
        if (d.default_payment_method && d.customer && stripe) {
          await stripe.customers.update(d.customer, {
            invoice_settings: { default_payment_method: d.default_payment_method }
          });
        }
      } catch(e) { console.error("[Webhook] Failed to sync PM on subscription.updated:", e.message); }
      break;
    }
    case "customer.subscription.deleted": {
      // Look up user by subscription ID (metadata on subscription object is unreliable)
      const subId = d.id;
      const cancelledUser = db.prepare("SELECT id FROM users WHERE stripe_subscription_id = ?").get(subId);
      if (cancelledUser) {
        db.prepare("UPDATE users SET plan=NULL, stripe_subscription_id=NULL WHERE id=?").run(cancelledUser.id);

      } else if (d.metadata?.mine_user) {
        // Fallback to metadata if subscription ID lookup fails
        db.prepare("UPDATE users SET plan=NULL, stripe_subscription_id=NULL WHERE id=?").run(d.metadata.mine_user);
      }
      break;
    }
    case "invoice.payment_failed": {

      try {
        const { handleFailedPayment } = require("./routes/features");
        const isOverage = d.metadata?.type === "overage";
        handleFailedPayment(db, d.customer_email, d.metadata?.mine_plan, d.id,
          isOverage ? "overage" : "plan",
          isOverage ? (d.amount_due / 100) : null
        );
      } catch(e) { console.error("[Webhook] invoice.payment_failed error:", e.message); }
      break;
    }

    case "invoice.payment_succeeded": {
      try {
        const { handlePaymentSuccess } = require("./routes/features");
        handlePaymentSuccess(db, d.customer_email, d.id);
      } catch(e) { console.error("[Webhook] invoice.payment_succeeded error:", e.message); }
      break;
    }

    case "customer.subscription.trial_will_end": {
      // Fires 3 days before trial ends — send reminder email
      try {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const userEmail = customer.email;
        const trialEnd = new Date(sub.trial_end * 1000).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
        const sgKey = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
        const fromEmail = process.env.FROM_EMAIL || getSetting("FROM_EMAIL") || "noreply@gettakeova.ai";
        if (sgKey && userEmail) {
          const fetch2 = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
          await fetch2("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: userEmail }] }],
              from: { email: fromEmail, name: "MINE" },
              subject: "Your free trial ends in 3 days",
              content: [{ type: "text/plain", value: `Hi there,\n\nJust a heads-up — your TAKEOVA free trial ends on ${trialEnd}.\n\nTo keep access to all your sites, contacts, and AI tools, upgrade before your trial ends.\n\nUpgrade now: ${process.env.APP_URL || "https://app.gettakeova.ai"}/billing\n\nThanks,\nThe TAKEOVA Team` }]
            })
          });
          console.log("[Webhook] trial_will_end reminder sent to:", userEmail);
        }
      } catch(e) { console.error("[Webhook] trial_will_end error:", e.message); }
      break;
    }

    case "charge.dispute.created": {
      // Fires when a chargeback is opened — log it and alert admin
      try {
        const dispute = event.data.object;
        try { db.exec("CREATE TABLE IF NOT EXISTS dispute_log (id TEXT PRIMARY KEY, charge_id TEXT, amount INTEGER, reason TEXT, status TEXT, created_at TEXT)"); } catch(e2) {}
        db.prepare("INSERT OR IGNORE INTO dispute_log (id, charge_id, amount, reason, status, created_at) VALUES (?,?,?,?,?,datetime('now'))")
          .run(dispute.id, dispute.charge, dispute.amount, dispute.reason || "unknown", dispute.status);
        const adminEmail = process.env.ADMIN_EMAIL || getSetting("ADMIN_EMAIL");
        const sgKey = process.env.SENDGRID_API_KEY || getSetting("SENDGRID_API_KEY");
        const fromEmail = process.env.FROM_EMAIL || getSetting("FROM_EMAIL") || "noreply@gettakeova.ai";
        if (sgKey && adminEmail) {
          const fetch2 = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
          await fetch2("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: adminEmail }] }],
              from: { email: fromEmail, name: "MINE Billing Alert" },
              subject: `⚠️ Chargeback opened — $${(dispute.amount / 100).toFixed(2)} (${dispute.reason || "unknown"})`,
              content: [{ type: "text/plain", value: `A chargeback has been opened.\n\nDispute ID: ${dispute.id}\nCharge ID: ${dispute.charge}\nAmount: $${(dispute.amount / 100).toFixed(2)}\nReason: ${dispute.reason || "unknown"}\nStatus: ${dispute.status}\n\n⚠️ You have 7 days to respond in Stripe:\nhttps://dashboard.stripe.com/disputes/${dispute.id}\n\nAct promptly to avoid losing the dispute.` }]
            })
          });
        }
        console.log("[Webhook] dispute.created logged:", dispute.id, "$" + (dispute.amount / 100).toFixed(2));
      } catch(e) { console.error("[Webhook] dispute.created error:", e.message); }
      break;
    }
  }
  res.json({ received: true });
});

// ── STRIPE CONNECT WEBHOOK — handles events on connected accounts (membership & product subscriptions) ──
// Registered in Stripe Dashboard under Connect > Webhooks with events:
//   invoice.payment_failed, invoice.payment_succeeded, customer.subscription.deleted
// Set STRIPE_CONNECT_WEBHOOK_SECRET in admin settings.
app.post("/webhook/connect", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });
  let event;
  try {
    const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || getSetting("STRIPE_CONNECT_WEBHOOK_SECRET");
    if (!webhookSecret) {
      return res.status(500).json({ error: "STRIPE_CONNECT_WEBHOOK_SECRET not configured" });
    }
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
  } catch(err) { return res.status(400).send(`Connect Webhook Error: ${err.message}`); }

  const db = getDb();
  const d = event.data.object;
  // The account ID of the connected account that fired this event
  const connectedAccountId = event.account;

  // Look up the TAKEOVA platform user who owns this connected account
  const platformUser = connectedAccountId
    ? db.prepare("SELECT id, email FROM users WHERE stripe_connect_id = ?").get(connectedAccountId)
    : null;

  switch (event.type) {

    case "invoice.payment_failed": {
      const customerEmail = d.customer_email;
      const stripeInvoiceId = d.id;
      const amount = d.amount_due ? d.amount_due / 100 : null;
      const stripeSubId = d.subscription;

      // Determine type: membership or product subscription
      let subType = "membership"; // default
      if (stripeSubId && platformUser) {
        const prodSub = db.prepare("SELECT id FROM product_sub_subscribers WHERE stripe_subscription_id = ? AND user_id = ?")
          .get(stripeSubId, platformUser.id);
        if (prodSub) subType = "product_subscription";
      }

      try {
        const { handleFailedPayment } = require("./routes/features");
        // Dunning email goes to the CUSTOMER (their card failed on the merchant's account)
        // Pass platformUserId so dunning_log can be attributed even though customer isn't a MINE user
        await handleFailedPayment(db, customerEmail, null, stripeInvoiceId, subType, amount, platformUser?.id || null);

        // Also notify the platform user (merchant) that a customer payment failed
        if (platformUser) {
          const sgKey = getSetting("SENDGRID_API_KEY");
          const fromEmail = getSetting("EMAIL_FROM") || "hello@takeova.ai";
          if (sgKey) {
            const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
            await fetch("https://api.sendgrid.com/v3/mail/send", {
              method: "POST",
              headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
              body: JSON.stringify({
                personalizations: [{ to: [{ email: platformUser.email }] }],
                from: { email: fromEmail, name: "MINE" },
                subject: `⚠️ Customer payment failed${amount ? ` — $${amount.toFixed(2)}` : ""}`,
                content: [{ type: "text/html", value: `
                  <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
                    <h2>⚠️ Customer Payment Failed</h2>
                    <p>A customer's ${subType === "membership" ? "membership" : "subscription"} payment failed:</p>
                    <ul>
                      <li><strong>Customer:</strong> ${customerEmail}</li>
                      ${amount ? `<li><strong>Amount:</strong> $${amount.toFixed(2)}</li>` : ""}
                    </ul>
                    <p>We've sent them an email asking them to update their payment method. We'll retry automatically.</p>
                    <p style="color:#94a3b8;font-size:12px">You can view and manage your subscribers in your TAKEOVA dashboard.</p>
                  </div>` }]
              })
            }).catch(() => {});
          }
        }
      } catch(e) { console.error("[CONNECT] Dunning trigger error:", e.message); }
      break;
    }

    case "invoice.payment_succeeded": {
      const customerEmail = d.customer_email;
      const stripeSubId = d.subscription;

      if (customerEmail && platformUser && stripeSubId) {
        // Restore membership enrollment if it was paused/cancelled due to non-payment
        try {
          db.prepare("UPDATE membership_enrollments SET status = 'active' WHERE user_id = ? AND customer_email = ? AND stripe_subscription_id = ? AND status IN ('paused','failed')")
            .run(platformUser.id, customerEmail, stripeSubId);
        } catch(e) {}

        // Restore product sub if paused
        try {
          const nextCharge = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
          db.prepare("UPDATE product_sub_subscribers SET status = 'active', dunning_attempt = 0, dunning_paused_at = NULL, next_charge = ? WHERE user_id = ? AND customer_email = ? AND stripe_subscription_id = ? AND status IN ('paused','failed')")
            .run(nextCharge, platformUser.id, customerEmail, stripeSubId);
        } catch(e) {}

        // Clear customer dunning log
        // dunning_log entries for customers are stored under the merchant's user_id (platformUser.id)
        try {
          db.prepare("UPDATE dunning_log SET status = 'resolved' WHERE user_id = ? AND stripe_invoice_id = ? AND status = 'pending'")
            .run(platformUser.id, d.id);
        } catch(e) {}
      }

      // Clear the customer's dunning sequence
      try {
        const { handlePaymentSuccess } = require("./routes/features");
        await handlePaymentSuccess(db, customerEmail, d.id);
      } catch(e) {}
      break;
    }

    case "customer.subscription.deleted": {
      // Subscription cancelled (either manually or after too many failed payments)
      const stripeSubId = d.id;
      if (platformUser && stripeSubId) {
        try {
          db.prepare("UPDATE membership_enrollments SET status = 'cancelled' WHERE user_id = ? AND stripe_subscription_id = ?")
            .run(platformUser.id, stripeSubId);
          db.prepare("UPDATE product_sub_subscribers SET status = 'cancelled' WHERE user_id = ? AND stripe_subscription_id = ?")
            .run(platformUser.id, stripeSubId);
        } catch(e) { console.error("[CONNECT] Subscription deletion sync error:", e.message); }
      }
      break;
    }
  }

  res.json({ received: true });
});

/* ─── PARSERS ─── */
// 1MB is ample for all API requests — 50MB was an open DoS vector
// (file uploads go through multer with its own limits, not express.json)
// Raw body for WhatsApp webhook signature verification
app.use("/api/mine-control/webhook", express.raw({ type: "application/json" }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) { req.rawBody = req.body.toString("utf8"); req.body = JSON.parse(req.rawBody || "{}"); }
  next();
});
// Raw body for Coinbase Commerce webhook signature verification
app.use("/api/crypto/webhook", express.raw({ type: "application/json" }));
app.use("/api/crypto", cryptoRoutes); // mounted before JSON parser
app.use("/api/prospector", prospectorRoutes);
app.use("/api/proposal-agent", proposalAgentRoutes);
app.use("/api/seo-agent", seoAgentRoutes);
app.use("/api/cold-email", coldEmailAgentRoutes);
app.use("/api/vision",     visionRoutes);
app.use("/api/verticals",  verticalsRoutes);
app.use("/api/industry",   industryRoutes);
app.use("/api/industry2",  industry2Routes);
app.use("/api/specialty",  specialtyRoutes);
app.use("/api/retail-edu", retailEduRoutes);
app.use("/api/reviews", reviewsRoutes);

// Public review landing page — /review/:token
app.get("/review/:token", (req, res) => {
  // Serve the review submission page (SPA handles this via frontend router)
  res.sendFile(require('path').join(__dirname, '../frontend/dist/index.html'), err => {
    if (err) res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leave a Review</title><script>window.__REVIEW_TOKEN__="${req.params.token.replace(/[^a-zA-Z0-9]/g,'')}";</script></head><body><div id="root"></div><script>// Redirect to API to get business info then show review form
    fetch('/api/reviews/r/' + window.__REVIEW_TOKEN__).then(r=>r.json()).then(d=>{
      document.title = 'Review ' + (d.business_name||'');
      document.body.innerHTML = '<div style="font-family:system-ui;max-width:480px;margin:48px auto;padding:24px;text-align:center"><h1 style="font-size:28px">⭐⭐⭐⭐⭐</h1><h2 style="font-size:20px;font-weight:800;margin-bottom:8px">How was your experience?</h2><p style="color:#64748B;margin-bottom:24px">Your review helps ' + (d.business_name||'us') + ' and future customers.</p>' + (d.google_url ? '<a href="' + d.google_url + '" style="display:block;background:#4285F4;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;margin-bottom:12px">⭐ Review on Google</a>' : '') + '<a href="#" onclick="showForm()" style="display:block;background:#2563EB;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px">📝 Leave a review here</a><div id="form" style="display:none;margin-top:24px"><div style="display:flex;justify-content:center;gap:8px;margin-bottom:16px">' + [1,2,3,4,5].map(n=>'<span onclick="rate('+n+')" style="font-size:36px;cursor:pointer" id="star'+n+'">☆</span>').join('') + '</div><textarea id="comment" placeholder="Tell us about your experience..." style="width:100%;padding:12px;border-radius:10px;border:1.5px solid #E2E8F0;font-size:14px;min-height:80px;box-sizing:border-box;margin-bottom:12px"></textarea><button onclick="submit()" style="background:#2563EB;color:#fff;padding:12px 24px;border-radius:10px;border:none;font-weight:700;font-size:15px;cursor:pointer;width:100%">Submit Review</button></div></div>';
      let rating = 0;
      window.rate = n => { rating = n; [1,2,3,4,5].forEach(i=>document.getElementById('star'+i).textContent=i<=n?'★':'☆'); };
      window.showForm = () => document.getElementById('form').style.display='block';
      window.submit = () => {
        if (!rating) return alert('Please select a rating');
        fetch('/api/reviews/r/' + window.__REVIEW_TOKEN__ + '/submit', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rating,comment:document.getElementById('comment').value,platform:'site'})})
        .then(r=>r.json()).then(d=>{document.body.innerHTML='<div style="font-family:system-ui;max-width:480px;margin:48px auto;padding:24px;text-align:center"><div style="font-size:64px;margin-bottom:16px">'+(rating>=4?'🌟':'🙏')+'</div><h2>Thank you!</h2><p style="color:#64748B">'+(d.message||'Your feedback has been received.')+'</p></div>';});
      };
    }).catch(()=>{ document.body.innerHTML='<div style="text-align:center;padding:48px;font-family:system-ui"><h2>Review link not found</h2><p>This link may have expired.</p></div>'; });
    </script></body></html>`);
  });
});
app.use("/api/more",       moreVertRoutes);
app.use("/api/extended",   extendedRoutes);
app.get("/demo/:slug", (req, res) => { const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g,""); res.redirect(301, "/api/prospector/demo/" + slug); });
// Shopify webhooks must read the raw request body for HMAC verification — mount before express.json.
app.use("/api/shopify/webhooks", require("./routes/shopify-app").webhookRouter);
app.use("/api/shopify/webhooks", require("./routes/shopify-commerce").webhookRouter);
app.use("/api/shopify/webhooks", require("./routes/shopify-sync").webhookRouter);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ─── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const { getDb } = require("./db/init");
  let dbOk = false;
  try { getDb().prepare("SELECT 1").get(); dbOk = true; } catch(e) {}
  const uptime = Math.floor(process.uptime());
  const status = dbOk ? "ok" : "degraded";
  res.status(dbOk ? 200 : 503).json({
    status, uptime_seconds: uptime,
    timestamp: new Date().toISOString(),
    db: dbOk ? "connected" : "error",
    version: process.env.npm_package_version || "3.0.0"
  });
});
app.get("/ping", (req, res) => res.send("pong"));

/* ─── STATIC ─── */
app.use("/uploads", (req, res, next) => {
  // Force SVG files to download rather than render inline — prevents stored XSS
  // (SVGs can contain <script> tags that execute in the browser on the API origin)
  if (req.path.toLowerCase().endsWith(".svg")) {
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  next();
}, express.static(path.join(__dirname, process.env.UPLOAD_DIR || "uploads")));

/* ─── API ROUTES ─── */
app.use("/api/auth", authRoutes);
app.use("/api/oauth", oauthRoutes);
app.use("/api/accounting", accountingRoutes);
app.use("/api/accounting-oauth", accountingRoutes);  // alias: dashboards call /api/accounting-oauth/{xero,quickbooks}/connect
app.use("/api/social", socialOauthRoutes);
app.use("/api/marketing", require("./routes/marketing-materials"));
app.use("/api/design", require("./routes/design"));   // Design Studio — Claude Opus 4.7 for pitch decks, logos, social, landing, one-pagers
app.use("/api/sites", siteRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/data", dataRoutes);
app.use("/api/data", require("./routes/dashboard-aggregates"));
app.use("/api/email", emailRoutes);
app.use("/api/contact", require("./routes/contact"));  // public contact form (landing-pages/contact.html)
app.use("/api/notes", require("./routes/notes"));      // smart notes: capture → Claude parse → route (mine-live)
app.use("/api/agent-loop", require("./routes/agent-loop"));  // closes the AI-employee loop: outcome → retry/handoff/learn/escalate
app.use("/api/files", fileRoutes);
app.use("/api/admin", require("./routes/admin-account"));  // Settings: profile, preferences, 2FA, sessions
app.use("/api/admin", adminRoutes);
app.use("/api/admin/ops", require("./routes/admin-ops"));  // v49.1 — refunds, suspend, churn metrics, MRR
app.use("/api/admin/finance", require("./routes/admin-finance"));  // Platform-wide invoice oversight, dunning, refunds, cancels
app.use("/api/microsoft", require("./routes/microsoft-oauth"));    // Microsoft 365 OAuth (connect/callback/status/disconnect)
app.use("/api/microsoft", require("./routes/microsoft-actions"));  // Microsoft 365 actions (Outlook, Calendar, OneDrive, Excel, Word, PowerPoint)
app.use("/api/branding",  require("./routes/branding"));           // Per-user/agency brand assets (favicon, logo, colors, font)
app.use("/api/browser-agent", require("./routes/browser-agent"));  // AI Browser Agent — Computer Use ($79/mo add-on, starter blocked)
app.use("/api/credentials",   require("./routes/credentials"));    // Encrypted per-domain credential vault for Browser Agent
app.use("/api/browser-agent/connections", require("./routes/browser-agent-connections")); // Credential vault + session jar for non-OAuth sites
app.use("/api/lookalike",     require("./routes/lookalike"));      // AI Lookalike Customer Generator
app.use("/api/site-localize", require("./routes/site-localize"));  // Auto-translate sites into multiple languages
app.use("/api/industry",      require("./routes/industry"));       // Industry templates registry
app.use("/api/integrations", integrationRoutes);
app.use("/api/hosting", hostingRoutes);
app.use("/api/migration", migrationRoutes);
app.use("/api/integrations/keys", userIntegrationKeysRoutes);
app.use("/api/user-notifications", userNotificationsRoutes);
app.use("/api/features/shipping", shippingRoutes);

// ─── Public branded tracking page: GET /track/:tracking_number ────────────
// Shown to the end-customer (the buyer). Pulls minimal data from shipments
// table and renders a styled tracking page on MINE's domain.
app.get("/track/:tracking", (req, res) => {
  try {
    const db = require("./db/init").getDb();
    const s = db.prepare(`SELECT s.*, u.name AS business_name, u.email AS business_email
                          FROM shipments s
                          LEFT JOIN users u ON u.id = s.user_id
                          WHERE s.tracking_number = ?`).get(req.params.tracking);
    if (!s) {
      return res.status(404).send(`<!DOCTYPE html><html><head><title>Tracking not found</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font-family:-apple-system,sans-serif;background:#F9FAFB;margin:0;padding:60px 20px;text-align:center;color:#0F172A}
        .box{max-width:420px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:40px 28px}
        h1{margin:0 0 10px;font-size:22px}.muted{color:#64748B;font-size:14px;line-height:1.6}</style></head>
        <body><div class="box"><div style="font-size:48px;margin-bottom:14px">📦</div>
        <h1>Tracking number not found</h1>
        <p class="muted">We couldn't find tracking number <b>${String(req.params.tracking).replace(/[<>]/g,"")}</b>. Double-check the number, or contact the sender.</p>
        </div></body></html>`);
    }

    const STATUS_LABELS = {
      pre_transit: { text: "Label printed", icon: "📝", color: "#9CA3AF", step: 1 },
      in_transit: { text: "In transit", icon: "🚚", color: "#EA580C", step: 2 },
      out_for_delivery: { text: "Out for delivery", icon: "🏃", color: "#0EA5E9", step: 3 },
      delivered: { text: "Delivered", icon: "✅", color: "#16A34A", step: 4 },
      return_to_sender: { text: "Return to sender", icon: "↩️", color: "#DC2626", step: 0 },
      failure: { text: "Delivery issue", icon: "⚠️", color: "#DC2626", step: 0 },
      cancelled: { text: "Cancelled", icon: "❌", color: "#9CA3AF", step: 0 },
      purchased: { text: "Label printed", icon: "📝", color: "#9CA3AF", step: 1 },
    };
    const info = STATUS_LABELS[s.status] || { text: "Processing", icon: "📦", color: "#635BFF", step: 1 };
    const businessName = String(s.business_name || "the sender").replace(/[<>]/g, "");
    const customerName = String(s.to_name || "").replace(/[<>]/g, "");
    const tn = String(s.tracking_number || "").replace(/[<>]/g, "");
    const carrier = String(s.courier || "").replace(/[<>]/g, "");
    const carrierUrl = s.tracking_url ? String(s.tracking_url).replace(/[<>"]/g, "") : "";

    const stepDot = (step, current) => {
      const filled = current >= step;
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center">
        <div style="width:28px;height:28px;border-radius:50%;background:${filled ? info.color : '#E5E7EB'};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${step}</div>
      </div>`;
    };
    const stepBar = (step, current) => {
      return `<div style="flex:1;height:3px;background:${current >= step ? info.color : '#E5E7EB'};margin:0 -4px;align-self:center"></div>`;
    };

    res.send(`<!DOCTYPE html><html><head>
      <title>Tracking ${tn} — ${businessName}</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        *{box-sizing:border-box}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F9FAFB;margin:0;color:#0F172A;line-height:1.5}
        .wrap{max-width:520px;margin:0 auto;padding:32px 20px}
        .brand{font-size:13px;color:#64748B;text-align:center;margin-bottom:12px;letter-spacing:.4px;text-transform:uppercase;font-weight:700}
        .card{background:#fff;border:1px solid #E5E7EB;border-radius:18px;padding:28px 24px;box-shadow:0 4px 14px rgba(0,0,0,.04);margin-bottom:14px}
        h1{margin:0 0 6px;font-size:20px;font-weight:800}
        .meta{font-size:13px;color:#64748B}
        .status{margin:24px 0;display:flex;align-items:center;gap:14px;padding:18px;background:${info.color}11;border:1px solid ${info.color}33;border-radius:12px}
        .status-icon{font-size:32px}
        .status-text{font-size:17px;font-weight:700;color:${info.color}}
        .status-sub{font-size:12px;color:#64748B;margin-top:2px}
        .progress{display:flex;align-items:center;margin:24px 0 8px}
        .progress-labels{display:flex;font-size:10px;color:#64748B;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
        .progress-labels>div{flex:1;text-align:center}
        .tn{font-family:'SF Mono',Monaco,monospace;font-size:14px;color:#0F172A;background:#F1F5F9;padding:8px 12px;border-radius:8px;display:inline-block;margin-top:6px}
        .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:13px}
        .row:last-child{border-bottom:none}
        .row .label{color:#64748B}
        .row .val{font-weight:600}
        .carrier-link{display:inline-block;margin-top:14px;padding:11px 18px;background:#635BFF;color:#fff;text-decoration:none;border-radius:9px;font-weight:700;font-size:13px}
        .footer{text-align:center;font-size:12px;color:#94A3B8;margin-top:24px;line-height:1.6}
        .footer a{color:#635BFF;text-decoration:none}
      </style></head><body>
      <div class="wrap">
        <div class="brand">${businessName}</div>
        <div class="card">
          <h1>Hi${customerName ? " " + customerName.split(" ")[0] : ""} — here's your tracking</h1>
          <div class="meta">Tracking number: <span class="tn">${tn}</span></div>

          <div class="status">
            <div class="status-icon">${info.icon}</div>
            <div>
              <div class="status-text">${info.text}</div>
              ${info.step === 4 ? '<div class="status-sub">Delivered successfully — enjoy!</div>' :
                info.step === 3 ? '<div class="status-sub">Your courier is on the way today</div>' :
                info.step === 2 ? '<div class="status-sub">Your package is on its journey</div>' :
                info.step === 1 ? '<div class="status-sub">Label created — awaiting collection</div>' :
                '<div class="status-sub">Contact sender for details</div>'}
            </div>
          </div>

          <div class="progress">
            ${stepDot(1, info.step)}${stepBar(2, info.step)}${stepDot(2, info.step)}${stepBar(3, info.step)}${stepDot(3, info.step)}${stepBar(4, info.step)}${stepDot(4, info.step)}
          </div>
          <div class="progress-labels">
            <div>Label</div><div>Transit</div><div>Out for delivery</div><div>Delivered</div>
          </div>

          <div style="margin-top:24px">
            <div class="row"><div class="label">Carrier</div><div class="val">${carrier || "—"}</div></div>
            <div class="row"><div class="label">From</div><div class="val">${businessName}</div></div>
            ${customerName ? `<div class="row"><div class="label">To</div><div class="val">${customerName}</div></div>` : ""}
          </div>

          ${carrierUrl ? `<a class="carrier-link" href="${carrierUrl}" target="_blank">View on ${carrier} →</a>` : ""}
        </div>

        <div class="footer">
          Tracking provided by <a href="https://takeova.ai" target="_blank">MINE</a> on behalf of ${businessName}.<br>
          Questions about your order? Reply to your order confirmation email.
        </div>
      </div>
    </body></html>`);
  } catch(e) {
    console.error("[/track]", e.message);
    res.status(500).send("Tracking lookup failed");
  }
});
app.use("/api/ai-employees", aiEmployeeRoutes);
// ─── AI Employees enhancement layer (outcomes, memory, handoffs, retries, nudges) ──
try {
  const aiEmpEnhancements = require("./routes/ai-employees-enhancements");
  app.use("/api/ai-employees", aiEmpEnhancements);
  if (typeof aiEmpEnhancements.migrate === "function") aiEmpEnhancements.migrate();
  console.log("[ai-employees-enhancements] mounted");
} catch (e) { console.warn("[ai-employees-enhancements] not mounted:", e.message); }
// ─── Claude streaming chat (SSE endpoint for Take Control / AI Advisor) ──
try {
  const claudeStream = require("./routes/claude-streaming-chat");
  app.use("/api/ai-employees", claudeStream);
  if (typeof claudeStream.migrate === "function") claudeStream.migrate();
  console.log("[claude-streaming-chat] mounted");
} catch (e) { console.warn("[claude-streaming-chat] not mounted:", e.message); }
// ─── Claude batch jobs (50% cost for overnight bulk work) ──
try {
  const claudeBatch = require("./routes/claude-batch-jobs");
  app.use("/api/ai-employees", claudeBatch);
  if (typeof claudeBatch.migrate === "function") claudeBatch.migrate();
  console.log("[claude-batch-jobs] mounted");
} catch (e) { console.warn("[claude-batch-jobs] not mounted:", e.message); }
// ─── Claude advanced (Files API, PDF input, Citations) ──
try {
  const claudeAdvanced = require("./routes/claude-advanced");
  app.use("/api/ai-employees", claudeAdvanced);
  if (typeof claudeAdvanced.migrate === "function") claudeAdvanced.migrate();
  console.log("[claude-advanced] mounted");
} catch (e) { console.warn("[claude-advanced] not mounted:", e.message); }
app.use("/api/outreach", outreachRoutes);

// ─── Domain Management — plan-gated custom domain + cron re-verification ───
try {
  const _domainMgmt = require("./routes/domain-management");
  app.use("/api/domains", _domainMgmt.router);
  _domainMgmt.startDomainCron();
  console.log("[domain-management] mounted + cron started");
} catch (e) {
  console.warn("[domain-management] not mounted:", e.message);
}

// ─── Compatibility routes — bridges for frontend-expected paths ───────────
try {
  const { router: _compatRouter, settingsRouter: _compatSettings } = require("./routes/compat-routes");
  app.use("/api/integrations", _compatRouter);  // /api/integrations/oauth/:platform/start
  app.use("/api/outreach", _compatRouter);      // /api/outreach/sequences (alongside existing campaigns)
  app.use("/api/settings", _compatSettings);    // /api/settings/sender
  console.log("[compat-routes] mounted");
} catch (e) {
  console.warn("[compat-routes] not mounted:", e.message);
}
app.use("/api/features", require("./routes/feature-actions"));    // specific real handlers — MUST precede features.js generic /:entity/:id/:action catch-all
app.use("/api/features", featureRoutes);
app.use("/api/features", require("./routes/missing-endpoints"));  // v49.1 — stubs for achievements, affiliates/commissions, brand-kit, etc.
app.use("/api/site-editor", require("./routes/site-editor"));     // v49.2 — WYSIWYG Site Editor backend
app.use("/api/site-templates", require("./routes/site-templates")); // Starter template library (creator + editor)
app.use("/uploads", express.static(require("path").join(__dirname, "uploads")));
// Site Editor (WYSIWYG) client scripts — served from the API origin so the
// dashboard orchestrator and the in-iframe inject script are reachable.
app.get(["/mine-site-editor.js", "/mine-editor-inject.js"], (req, res) => {
  res.type("application/javascript");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(require("path").join(__dirname, "editor-assets", req.path.replace(/^\//, "")), (err) => {
    if (err && !res.headersSent) res.status(404).send("// not found");
  });
});
app.use("/api/ads", adsRoutes);
app.use("/api/platform", platformRoutes);
app.use("/api/affiliates", affiliateRoutes);

// Referral programs — user referral codes, business affiliate programs, agency invite links
const referralProgramRoutes = require("./routes/referral-programs");
app.use("/api", referralProgramRoutes);

// Video library — persistent storage, S3 upload, auto-post to social
const videoRoutes = require("./routes/videos");
app.use("/api/videos", videoRoutes);
// Clean public URL for affiliate portal — /affiliates serves the full portal page
app.get("/affiliates", (req, res) => {
  const { getDb } = require("./db/init");
  const getSetting = (k) => { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } };
  const backendUrl = getSetting("BACKEND_URL") || process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
  const frontendUrl = getSetting("FRONTEND_URL") || process.env.FRONTEND_URL || "https://takeova.ai";
  const { getPortalHTML } = require("./routes/affiliates");
  if (typeof getPortalHTML === "function") {
    return res.send(getPortalHTML(backendUrl, frontendUrl));
  }
  res.redirect(302, backendUrl + "/api/affiliates/portal");
});
const aiAgentRoutes       = require("./routes/ai-agent");
const growthAgentRoutes   = require("./routes/growth-agent");
const mineControlRoutes   = require("./routes/mine-control");
const smsRoutes           = require("./routes/sms");
const publicPageRoutes    = require("./routes/public-pages");

// v49: Monthly overage reconciliation — bills accrued overages via Stripe
async function reconcileMonthlyOverages() {
  const { getDb } = require("./db/init");
  const db = getDb();
  const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
  if (!stripe) { console.log('[overage] Stripe not configured — skipping monthly reconciliation'); return; }
  // Ensure billed columns exist on overage_charges table
  try { db.exec("ALTER TABLE overage_charges ADD COLUMN billed INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE overage_charges ADD COLUMN billed_at TEXT"); } catch(e) {}

  // Previous month in YYYY-MM
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const period = prev.toISOString().slice(0, 7);

  // Get unbilled overages per user for that period.
  //
  // CRITICAL: We MUST exclude rows already in status='queued' or 'paid' —
  // those were created as Stripe invoice items by the live per-event path
  // (features.js mineTrackUsage). Without this filter, every user who had
  // successful per-event queuing gets double-billed every month.
  const rows = db.prepare(`
    SELECT user_id, SUM(total) as total
    FROM overage_charges
    WHERE period = ?
      AND (billed IS NULL OR billed = 0)
      AND status = 'pending'
    GROUP BY user_id
    HAVING total > 0
  `).all(period);

  let billed = 0, failed = 0;
  for (const row of rows) {
    try {
      const user = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(row.user_id);
      if (!user?.stripe_customer_id) { console.log(`[overage] ${row.user_id} has no Stripe customer — skipped`); continue; }

      // Create a Stripe invoice item (auto-attached to next monthly invoice)
      await stripe.invoiceItems.create({
        customer: user.stripe_customer_id,
        amount: Math.round(row.total * 100),
        currency: 'usd',
        description: `MINE overage charges — ${period}`,
        metadata: { user_id: row.user_id, period, source: 'monthly_reconciliation' }
      });

      // Mark ONLY the pending rows we actually billed — don't touch queued/paid rows
      db.prepare(`
        UPDATE overage_charges SET billed = 1, billed_at = datetime('now'), status = 'billed'
        WHERE user_id = ? AND period = ? AND status = 'pending'
      `).run(row.user_id, period);

      billed++;
      console.log(`[overage] Billed $${row.total.toFixed(2)} to ${user.email} for ${period}`);
    } catch (e) {
      failed++;
      console.error(`[overage] Failed for user ${row.user_id}:`, e.message);
    }
  }
  console.log(`[overage] Monthly reconciliation complete — ${billed} billed, ${failed} failed`);
}
// Expose on global so routes/admin-ops.js /reconcile-overages can call it
// without a circular require back into server.js.
global.reconcileMonthlyOverages = reconcileMonthlyOverages;

// Rate limiters defined BEFORE use (const is not hoisted)
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, keyGenerator: (req) => req.headers.authorization || req.ip, message: { error: "Too many AI requests, slow down." } });
const publicLimiter = rateLimit({ windowMs: 60000, max: 60, message: { error: "Too many requests" }, keyGenerator: (req) => req.ip + (req.params?.siteId || "") });

app.use("/api/templates", templateRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/appstore", appstoreRoutes);
app.use("/api/ai-agent", aiLimiter, aiAgentRoutes);
app.use("/api/ai-tools", aiLimiter, require("./routes/ai-tools"));  // real AI Tools handlers — MUST precede wired-endpoints.js canned stubs
app.use("/api/ai-features", aiLimiter, aiFeaturesRoutes);
app.use("/api/showdown", showdownRoutes);
app.use("/api/showdown", showdownAdCapRoutes);
app.use("/api/intelligence", aiLimiter, intelligenceRoutes);
app.use("/api/growth-agent", growthAgentRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/inbox", require("./routes/unified-inbox"));  // unified cross-channel inbox (SMS + WhatsApp + email + website-chat, matched by phone/email)
app.use("/api/mine-control", mineControlRoutes);
app.use("/api/agency", agencyRoutes);
app.use("/api/agency", require("./routes/agency-invoices"));  // One-off / ad-hoc invoicing — paid 40/60 split, separate from recurring fees// Agency creates videos for clients — 40% commission, billed to client
app.use("/api/staff", staffRoutes);
app.use("/api/jobs", jobsRoutes);
app.use("/api/time", timeBillingRoutes);

/* ─── PUBLIC PAGES (link-in-bio, forms, hosted sites) ─── */
app.use("/api/public", publicLimiter, publicPageRoutes);

// Chat widget rate limiter — applied before features routes to protect chat/message endpoint
const chatLimiter = rateLimit({ windowMs: 60000, max: 30, message: { error: "Too many messages, slow down." }, keyGenerator: (req) => req.ip + (req.body?.siteId || "") });
app.use("/api/features/chat/message", chatLimiter);

// ─── Public blog pages served on user subdomains (yourbiz.takeova.ai/blog) ───
// Wildcard subdomains route here — nginx passes *.takeova.ai to this server
app.use((req, res, next) => {
  const host = req.hostname || "";
  const apiHost = (process.env.API_HOST || "api.takeova.ai");
  const mainHost = (process.env.MAIN_HOST || "takeova.ai");
  // Only handle blog routes on user subdomains, not on api.takeova.ai or takeova.ai itself
  const isUserSubdomain = host !== apiHost && host !== mainHost && host !== `www.${mainHost}`;
  if (isUserSubdomain && (req.path === "/blog" || req.path.startsWith("/blog/"))) {
    return blogRouter(req, res, next);
  }
  next();
});

// ─── Serve user sites on custom domains + *.takeova.ai subdomains ─────────
// When a request arrives on a custom domain (e.g. www.zarayoga.com) or on a
// takeova.ai subdomain (e.g. zarayoga.takeova.ai), look up the site and serve
// its stored HTML. This makes custom domains work WITHOUT requiring Cloudflare.
// Paths under /api/* and other well-known paths are skipped — they route to
// the backend normally.
app.use((req, res, next) => {
  const host = (req.hostname || "").toLowerCase();
  const apiHost = (process.env.API_HOST || "api.takeova.ai").toLowerCase();
  const mainHost = (process.env.MAIN_HOST || "takeova.ai").toLowerCase();

  // Skip: API host, main marketing site, www, localhost, IPs
  if (!host) return next();
  if (host === apiHost || host === mainHost || host === `www.${mainHost}`) return next();
  if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return next();

  // Skip: paths that should hit backend routes, not site HTML
  const p = req.path;
  if (p.startsWith("/api/") || p.startsWith("/hosted/") || p.startsWith("/p/") ||
      p.startsWith("/f/") || p.startsWith("/affiliates") || p === "/robots.txt" ||
      p === "/sitemap.xml" || p === "/favicon.ico" || p.startsWith("/uploads/")) {
    return next();
  }

  // Try: custom domain match first, then subdomain slug
  try {
    const db = getDb();
    let site = null;

    // 1. Custom domain exact match (e.g. www.zarayoga.com)
    site = db.prepare(
      "SELECT s.id, s.html, s.name, u.account_status FROM sites s JOIN users u ON u.id = s.user_id WHERE s.custom_domain = ? OR s.custom_domain = ? LIMIT 1"
    ).get(host, host.replace(/^www\./, ""));

    // 2. Subdomain match (e.g. zarayoga.takeova.ai → slug "zarayoga")
    if (!site && host.endsWith("." + mainHost)) {
      const slug = host.slice(0, host.length - mainHost.length - 1);
      // sites.domain is stored as "slug.takeova.ai" by onboarding (line ~1809 of platform.js)
      site = db.prepare(
        "SELECT s.id, s.html, s.name, u.account_status FROM sites s JOIN users u ON u.id = s.user_id WHERE s.domain = ? LIMIT 1"
      ).get(host);
    }

    if (!site) return next();  // No matching site — let backend handle it

    // Serve paused-site placeholder
    if (site.account_status === "paused") {
      return res.status(402).type("html").send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Site Unavailable</title>` +
        `<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc}` +
        `.box{text-align:center;max-width:400px;padding:40px}</style></head>` +
        `<body><div class="box"><div style="font-size:48px;margin-bottom:16px">⚠️</div>` +
        `<h2 style="color:#1e293b;margin:0 0 12px">This site is temporarily unavailable</h2>` +
        `<p style="color:#64748b;margin:0">The owner needs to update their billing information.</p>` +
        `</div></body></html>`
      );
    }

    // ─── PWA artifacts on the customer's own origin (install-on-phone) ───
    // Served here so manifest/SW/app share the site's origin (install scope).
    if (p === "/mine-sw.js" || p === "/app" || p === "/app/" ||
        p === "/app/manifest.webmanifest" || p === "/manifest.webmanifest" ||
        p === "/app/icon.svg") {
      try {
        const PWA = require("./routes/mobile-pwa");
        const fs = db.prepare("SELECT * FROM sites WHERE id = ?").get(site.id) || {};
        if (p === "/mine-sw.js")
          return res.type("application/javascript").set("Service-Worker-Allowed", "/").send(PWA.serviceWorker());
        if (p === "/app/icon.svg")
          return res.type("image/svg+xml").send(PWA.iconSvg(fs));
        if (p === "/app/manifest.webmanifest" || p === "/manifest.webmanifest")
          return res.type("application/manifest+json").send(JSON.stringify(PWA.manifest(fs)));
        return res.type("html").send(PWA.appShell(fs)); // /app and /app/
      } catch (e) {
        console.error("[PWA serve] Error:", e.message);
        return next();
      }
    }

    // Only the root path (and trailing-slash) serves the site HTML.
    // Sub-paths (e.g. /products/sku-123) aren't supported yet — fall through
    // so any matching backend route can handle them (e.g. form posts, analytics).
    if (p !== "/" && p !== "") return next();

    // Fetch fresh HTML from DB and wrap with the deploy template.
    // Re-reading the DB each request isn't cheap but guarantees consistency
    // after site edits without explicit cache invalidation. For high-traffic
    // sites you'd want a CDN in front (which is why Cloudflare Pages exists).
    const fullSite = db.prepare("SELECT * FROM sites WHERE id = ?").get(site.id);
    if (!fullSite || !fullSite.html) {
      return res.status(404).type("html").send("<h1>Site not published yet</h1>");
    }

    // Build the full document using the same wrapper the deploy endpoint uses.
    // We lazy-require to avoid loading hosting.js at boot.
    const { generateSiteHTMLForPublicServe } = require("./routes/hosting");
    let html;
    if (typeof generateSiteHTMLForPublicServe === "function") {
      html = generateSiteHTMLForPublicServe(fullSite);
    } else {
      // Fallback: if hosting.js doesn't export the wrapper, just serve raw HTML.
      // This is safer than erroring — at least the user's content shows.
      html = fullSite.html;
    }

    // Make the live site itself installable (PWA manifest + service worker).
    try { html = require("./routes/mobile-pwa").injectInto(html, fullSite); } catch (_) {}

    // Grace-period billing banner
    if (site.account_status === "grace") {
      const banner = `<div id="mine-billing-banner" style="position:fixed;bottom:0;left:0;right:0;background:#FEF3C7;border-top:2px solid #F59E0B;padding:12px 20px;display:flex;align-items:center;justify-content:center;z-index:99999;font-family:system-ui;font-size:14px"><span>⚠️ <strong>Billing issue:</strong> This site may go offline soon.</span></div>`;
      html = html.replace("</body>", banner + "</body>");
    }

    res.type("html").send(html);
  } catch (err) {
    console.error("[Custom domain serve] Error:", err.message);
    next();
  }
});

// Consumer "TAKEOVA app" entry — join-code lookup + redirect to a business app.
app.use(require("./routes/mobile-pwa").router);

app.use("/hosted", (req, res, next) => {
  // Check if the site owner's account is paused before serving
  const siteId = req.path.split("/")[1]; // e.g. /hosted/siteId123/index.html → siteId123
  if (siteId && !siteId.includes(".")) { // skip file extension paths like /favicon.ico
    try {
      const db = getDb();
      const siteOwner = db.prepare(
        "SELECT u.account_status FROM users u JOIN sites s ON s.user_id = u.id WHERE s.id = ? LIMIT 1"
      ).get(siteId);
      if (siteOwner?.account_status === "paused") {
        return res.status(402).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Site Unavailable</title>
          <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc}
          .box{text-align:center;max-width:400px;padding:40px}</style></head>
          <body><div class="box">
            <div style="font-size:48px;margin-bottom:16px">⚠️</div>
            <h2 style="color:#1e293b;margin:0 0 12px">This site is temporarily unavailable</h2>
            <p style="color:#64748b;margin:0">The owner of this site needs to update their billing information.</p>
          </div></body></html>`);
      }
      // Grace period: serve HTML files ourselves so we can inject the billing banner
      if (siteOwner?.account_status === "grace") {
        const reqPath = req.path.endsWith("/") || !req.path.includes(".")
          ? req.path.replace(/\/$/, "") + "/index.html"
          : req.path;
        const fs = require("fs");
        const filePath = require("path").join(process.env.UPLOAD_DIR || "./uploads", "hosted", reqPath);
        if (reqPath.endsWith(".html") && fs.existsSync(filePath)) {
          let html = fs.readFileSync(filePath, "utf8");
          const banner = `<div id="mine-billing-banner" style="position:fixed;bottom:0;left:0;right:0;background:#FEF3C7;border-top:2px solid #F59E0B;padding:12px 20px;display:flex;align-items:center;justify-content:center;gap:16px;z-index:99999;font-family:system-ui;font-size:14px">
            <span>⚠️ <strong>Billing issue:</strong> This site may go offline soon. Site owner needs to update their payment method.</span>
          </div>`;
          html = html.replace("</body>", banner + "</body>");
          return res.type("html").send(html);
        }
      }
    } catch(e) { /* DB error — allow through rather than break all sites */ }
  }
  if (req.path.toLowerCase().endsWith(".svg")) {
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  next();
}, express.static(path.join(process.env.UPLOAD_DIR || "./uploads", "hosted")));

/* ─── SERVE FRONTEND (production) ─── */
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../frontend/build")));
  app.get("*", (req, res) => {
    if (!req.path.startsWith("/api") && !req.path.startsWith("/p/") && !req.path.startsWith("/f/")) {
      res.sendFile(path.join(__dirname, "../frontend/build", "index.html"));
    }
  });
}

/* ─── HEALTH ─── */
app.get("/api/health", (_, res) => {
  const db = getDb();
  const users = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  res.json({ ok: true, users, version: "3.0", stripe: !!process.env.STRIPE_SECRET_KEY, email: !!(process.env.SENDGRID_API_KEY), ai: !!process.env.ANTHROPIC_API_KEY, sms: !!process.env.TWILIO_ACCOUNT_SID, timestamp: new Date().toISOString() });
});

/* ─── SEO: robots.txt + sitemap.xml (served by frontend nginx, but backend fallback) ─── */
app.get("/robots.txt", (_, res) => {
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /dashboard\nDisallow: /admin\nSitemap: ${frontendUrl}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (_, res) => {
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  const pages = ["/", "/features", "/pricing", "/blog", "/docs/terms", "/docs/privacy-policy"];
  const urls = pages.map(p => `  <url><loc>${frontendUrl}${p}</loc><changefreq>weekly</changefreq></url>`).join("\n");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

/* ─── ERROR HANDLER ─── */
const PORT = process.env.PORT || 4000;
// Prevent unhandled rejections/exceptions from crashing the server
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message);
  // Don't exit - keep the server running for non-fatal errors
});

// Global error handler — catches any unhandled errors that escape route handlers
// Ensures stack traces and internal messages never reach the client
// Global async error handler — catches unhandled promise rejections on any route
// This is a safety net for routes that don't have their own try/catch

// Wrap all async route handlers to catch unhandled rejections
// Applied at process level as belt-and-suspenders
// Wired endpoints — dashboard calls that previously had NO backend handler.
// Each returns the shape its call expects (correct payload key) so the UI shows
// real data or a truthful empty state. Mounted among the specific routers; the
// /api 404 now sits at the very bottom, before the generic catch-alls only.
app.use(require("./routes/wired-real"));      // real handlers for paths that were canned stubs — MUST precede wired-endpoints
app.use(require("./routes/wired-endpoints"));
app.use(require("./routes/wired-gaps"));     // July 2026 gap-fix: real handlers for the 161 frontend paths that 404'd (see MINE_FUNCTIONAL_GAPS)

// ── Global error handler ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const correlationId = Math.random().toString(36).slice(2, 10);
  console.error("[Server] Unhandled error " + correlationId + ":", (err && err.stack) ? err.stack : ((err && err.message) || err));
  if (res.headersSent) return next(err);
  // Never leak internal 5xx exception text (SQL / stack details) to the client (audit §2.1).
  // Deliberate 4xx messages still pass through; 5xx gets a generic message + a correlation id for log lookup.
  const status = err.status || 500;
  const clientMsg = status >= 500 ? "Internal server error" : (err.message || "Request error");
  res.status(status).json({ error: clientMsg, correlation_id: correlationId });
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[UnhandledRejection]", reason?.message || reason);
  // Don't crash — log and continue
});

// ── Morning briefing cron — fires at 7am daily ───────────────────────────────
(function scheduleMorningCron() {
  function msUntil7am() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(7, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }
  function runMorningCron() {
    fetch('http://localhost:' + (process.env.PORT || 4000) + '/api/intelligence/morning-cron', {
      method: 'POST',
      headers: { 'x-internal-key': process.env.INTERNAL_API_KEY || 'dev-key', 'Content-Type': 'application/json' }
    }).then(r => r.json()).then(d => {
      console.log('[MorningCron] Sent ' + d.sent + '/' + d.total + ' briefings');
      setTimeout(runMorningCron, 24 * 60 * 60 * 1000);
    }).catch(e => {
      console.error('[MorningCron] Error:', e.message);
      setTimeout(runMorningCron, 60 * 60 * 1000); // retry in 1hr on error
    });
  }
  setTimeout(runMorningCron, msUntil7am());
  console.log('[MorningCron] Scheduled, firing in', Math.round(msUntil7am()/60000), 'minutes');
})();


// ───── SEO Agent — daily runner ─────
// Iterates active subscribers, runs the agent if frequency_days elapsed since last run.
setInterval(async () => {
  try {
    const db = require("./db/init").getDb();
    if (!db) return;
    const { runAgentForUser } = require("./lib/seo-agent-loop");

    const due = db.prepare(`
      SELECT s.user_id, s.last_run_at, COALESCE(c.frequency_days, 2) AS freq
      FROM seo_agent_subscriptions s
      LEFT JOIN seo_agent_config c ON c.user_id = s.user_id
      WHERE s.status = 'active'
      AND (s.last_run_at IS NULL
           OR julianday('now') - julianday(s.last_run_at) >= COALESCE(c.frequency_days, 2))
      LIMIT 50
    `).all();

    for (const row of due) {
      try {
        const result = await runAgentForUser(db, row.user_id, { dryRun: false });
        console.log("[seo-agent cron] user=" + row.user_id, JSON.stringify(result));
      } catch (e) {
        console.error("[seo-agent cron] user=" + row.user_id + " failed:", e.message);
      }
    }
  } catch (e) {
    console.error("[seo-agent cron] outer error:", e.message);
  }
}, 60 * 60 * 1000); // hourly check; the inner julianday gate enforces user's frequency_days


// ─── Lead Magnet polling — independent of Sales Rep subscription ───
// Runs hourly for any user with active magnets. Decoupled so users on Pro+
// can use lead magnets without hiring the $79/mo Sales Rep agent.
setInterval(async () => {
  try {
    if (typeof cronOwn === "function" && !cronOwn("lead_magnets_polling", 60 * 60 * 1000)) return;
    const db = require('./db/init').getDb();
    const usersWithMagnets = db.prepare(
      "SELECT DISTINCT user_id FROM lead_magnets WHERE active = 1"
    ).all();
    if (usersWithMagnets.length === 0) return;
    const { pollLeadMagnetsForUser } = require('./routes/ai-employees');
    if (typeof pollLeadMagnetsForUser !== "function") return;
    for (const { user_id } of usersWithMagnets) {
      try {
        await pollLeadMagnetsForUser(db, user_id);
      } catch(e) {
        console.error(`[lead-magnets-cron] user ${user_id}:`, e.message);
      }
    }
  } catch(e) { console.error("[lead-magnets-cron]", e.message); }
}, 60 * 60 * 1000);  // hourly

// ─── Lead Magnet cleanup — runs daily, deletes 30+ day old unfulfilled email-awaiting rows ───
setInterval(async () => {
  try {
    const db = require('./db/init').getDb();
    const result = db.prepare(`DELETE FROM lead_magnet_email_awaiting WHERE fulfilled = 0 AND asked_at < datetime('now', '-30 days')`).run();
    if (result.changes > 0) console.log(`[lead-magnet-cleanup] Removed ${result.changes} stale email-awaiting rows`);
  } catch(e) { /* table may not exist yet */ }
}, 24 * 60 * 60 * 1000);  // daily


const httpServer = app.listen(PORT, () => {


  // ── Prospector restart recovery ──────────────────────────────────────────
  // Mark any campaigns that were "running" when server last stopped as "interrupted"
  try {
    const { getDb } = require("./db/init");
    const db = getDb();
    const interrupted = db.prepare("UPDATE prospector_campaigns SET status = 'interrupted', error = 'Server restarted mid-campaign. Please re-run.' WHERE status = 'running'").run();
    if (interrupted.changes > 0) console.log(`[Prospector] ${interrupted.changes} interrupted campaign(s) marked on startup`);
  } catch(e) {}

  // ── Shopify abandoned-cart recovery scheduler ──
  try {
    const { getDb } = require("./db/init");
    require("./routes/shopify-commerce").startRecoveryScheduler(getDb());
  } catch (e) { console.error("[Shopify] recovery scheduler start failed:", e?.message); }

  // ── Shopify two-way sync reconciler (MINE → Shopify) ──
  try {
    const { getDb } = require("./db/init");
    require("./routes/shopify-sync").startSyncScheduler(getDb());
  } catch (e) { console.error("[Shopify] sync scheduler start failed:", e?.message); }

  // ═══ ONE-TIME BACKFILL: set default_payment_method on existing subscribers ═══
  // Runs on every startup but is cheap — skips users who already have it set,
  // and only fires against Stripe for those who don't. Safe to run repeatedly.
  (async () => {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return;
    try {
      const db = getDb();
      // Find all users with a subscription but who may be missing a default PM on their customer
      const subscribers = db.prepare(
        "SELECT id, email, stripe_customer_id, stripe_subscription_id FROM users WHERE stripe_subscription_id IS NOT NULL AND stripe_customer_id IS NOT NULL"
      ).all();

      if (subscribers.length === 0) return;

      const stripe = require("stripe")(stripeKey);
      let fixed = 0, skipped = 0, failed = 0;

      // Process in batches of 10 with 1s delay to avoid Stripe rate limits
      for (let i = 0; i < subscribers.length; i++) {
        const user = subscribers[i];
        if (i > 0 && i % 10 === 0) await new Promise(r => setTimeout(r, 1000));
        try {
          // Check if customer already has a default PM — if so, skip (avoids unnecessary API calls)
          const customer = await stripe.customers.retrieve(user.stripe_customer_id);
          if (customer.deleted) { skipped++; continue; }
          if (customer.invoice_settings?.default_payment_method) { skipped++; continue; }

          // No default PM — get it from the subscription
          const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
          const pmId = sub.default_payment_method;
          if (!pmId) { skipped++; continue; }

          await stripe.customers.update(user.stripe_customer_id, {
            invoice_settings: { default_payment_method: pmId }
          });
          fixed++;
        } catch(e) {
          failed++;
          if (e.code !== "resource_missing") { // suppress "subscription not found" noise
            console.error(`[BACKFILL] Failed for ${user.email}:`, e.message);
          }
        }
      } // end for loop

      if (fixed > 0 || failed > 0) {

      }
    } catch(e) { console.error("[BACKFILL] Error:", e.message); }
  })();

  // ═══ SCHEDULED JOBS ═══
  const db = getDb();
  const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

  // ─── Cron leadership: ensure each scheduled job only runs on ONE replica ───
  // Without this, every replica's setInterval fires and you get duplicate
  // billing / duplicate emails / duplicate webhooks. Each replica generates
  // an INSTANCE_ID at boot. Before running a cron tick, we try to acquire a
  // database-backed lease keyed by job name. The lease expires after `ttlMs`,
  // so if the leader dies mid-run, another replica picks up next tick.
  const INSTANCE_ID = require("crypto").randomBytes(8).toString("hex");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS cron_leases (job TEXT PRIMARY KEY, instance TEXT, expires_at INTEGER)");
  } catch(_) {}
  /** Returns true if THIS replica holds the lease for `job` right now.
   *  ttlMs should be ~3x the interval so a slow tick doesn't cause overlap. */
  function cronOwn(job, ttlMs) {
    try {
      const now = Date.now();
      const row = db.prepare("SELECT instance, expires_at FROM cron_leases WHERE job = ?").get(job);
      if (!row || row.expires_at < now) {
        // Lease is missing or expired — try to grab it
        db.prepare("INSERT OR REPLACE INTO cron_leases (job, instance, expires_at) VALUES (?,?,?)")
          .run(job, INSTANCE_ID, now + ttlMs);
        return true;
      }
      if (row.instance === INSTANCE_ID) {
        // We already hold it — extend the TTL
        db.prepare("UPDATE cron_leases SET expires_at = ? WHERE job = ? AND instance = ?")
          .run(now + ttlMs, job, INSTANCE_ID);
        return true;
      }
      return false; // Another replica holds it
    } catch(e) {
      // If the DB call itself fails, default to running (single-instance safety).
      // Better to run on every replica than not run at all.
      return true;
    }
  }
  console.log(`[cron] this instance = ${INSTANCE_ID} (leases ensure only one replica runs each job)`);

  // ── Ad Spend Sync — every hour ──
  // Pulls real spend from Meta, Google, TikTok for ALL users with active campaigns
  // Auto-pauses campaigns that exceed daily budget limits
  setInterval(async () => {
    try {
      if (!cronOwn("ad_spend_sync", 10800000)) return;
      const activeUsers = db.prepare("SELECT DISTINCT user_id FROM ad_campaigns WHERE status = 'active' AND platform_campaign_id IS NOT NULL AND platform_campaign_id != ''").all();

      for (const { user_id } of activeUsers) {
        try {
          // Internal call to sync-all endpoint
          const campaigns = db.prepare("SELECT * FROM ad_campaigns WHERE user_id = ? AND status = 'active' AND platform_campaign_id IS NOT NULL AND platform_campaign_id != ''").all(user_id);

          for (const campaign of campaigns) {
            try {
              // Import platformAction from ads route
              const { platformAction } = require("./routes/ads");
              const stats = await platformAction(campaign.platform, "stats", campaign.platform_campaign_id);
              const today = new Date().toISOString().slice(0, 10);

              // Save performance
              db.prepare(`INSERT OR REPLACE INTO ad_performance (id, campaign_id, date, impressions, clicks, conversions, spend, ctr, cpc, cpa, roas) VALUES (?,?,?,?,?,?,?,0,0,0,0)`)
                .run(uuid(), campaign.id, today, stats.impressions || 0, stats.clicks || 0, stats.conversions || 0, stats.spend || 0);

              // Update total spent
              db.prepare("UPDATE ad_campaigns SET total_spent = total_spent + ?, updated_at = datetime('now') WHERE id = ?")
                .run(stats.spend || 0, campaign.id);

              // FIX: Record ad spend to accounting
              if (stats.spend > 0) {
                try {
                  const { recordTransaction } = require("./routes/features");
                  recordTransaction(db, user_id, "expense", stats.spend, "Advertising", `${campaign.platform} — ${campaign.name}`, "ad_platform", campaign.id, today);
                } catch(e) {}
              }
            } catch (e) { /* Platform API error — skip */ }
          }

          // Check budget limits and auto-pause
          db.prepare("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY(user_id, key))").run();
          const budgetRow = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'ad_budget_limits'").get(user_id);
          const limits = budgetRow?.value ? JSON.parse(budgetRow.value) : { manual: { daily: 100, monthly: 1500 }, ai: { daily: 50, monthly: 500 } };
          const dateStr = new Date().toISOString().slice(0, 10);

          // Calculate today's spend per source
          const todaySpend = db.prepare(`SELECT c.name, p.spend FROM ad_performance p JOIN ad_campaigns c ON p.campaign_id = c.id WHERE c.user_id = ? AND p.date = ?`).all(user_id, dateStr);
          const manualSpend = todaySpend.filter(r => !r.name?.startsWith("[AI]")).reduce((s, r) => s + (r.spend || 0), 0);
          const aiSpend = todaySpend.filter(r => r.name?.startsWith("[AI]")).reduce((s, r) => s + (r.spend || 0), 0);

          // Auto-pause manual campaigns over daily limit
          if (manualSpend > limits.manual.daily) {
            const toPause = campaigns.filter(c => !c.name?.startsWith("[AI]"));
            for (const c of toPause) {
              try {
                const { platformAction: pa } = require("./routes/ads");
                await pa(c.platform, "pause", c.platform_campaign_id);
                db.prepare("UPDATE ad_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(c.id);
                console.log(`[CRON] Auto-paused manual campaign "${c.name}" — daily limit $${limits.manual.daily} exceeded ($${manualSpend.toFixed(2)})`);
              } catch (e) { /* skip */ }
            }
          }

          // Auto-pause AI campaigns over daily limit
          if (aiSpend > limits.ai.daily) {
            const toPause = campaigns.filter(c => c.name?.startsWith("[AI]"));
            for (const c of toPause) {
              try {
                const { platformAction: pa } = require("./routes/ads");
                await pa(c.platform, "pause", c.platform_campaign_id);
                db.prepare("UPDATE ad_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(c.id);
                console.log(`[CRON] Auto-paused AI campaign "${c.name}" — daily limit $${limits.ai.daily} exceeded ($${aiSpend.toFixed(2)})`);
              } catch (e) { /* skip */ }
            }
          }
        } catch (e) { console.error(`[CRON] Spend sync error for user ${user_id}:`, e.message); }
      }
    } catch (e) { console.error("[CRON] Ad spend sync failed:", e.message); }
  }, 60 * 60 * 1000); // Every hour

  // ── Pending Video Tasks — poll every 5 minutes (Arcads renders in ~5 min) ──
  setInterval(async () => {
    try {
      if (!cronOwn("video_poll", 900000)) return;
      const db = getDb();
      const { getSetting } = require('./db/init');
      const fetch = (await import('node-fetch')).default;

      const pendingTasks = db.prepare(`
        SELECT pt.*, ac.campaign_id as camp_id, ac.platform as ad_platform,
               ac.headline as creative_headline
        FROM pending_video_tasks pt
        LEFT JOIN ad_creatives ac ON ac.id = pt.creative_id
        WHERE pt.status = 'pending' AND pt.attempts < 24
        LIMIT 10
      `).all();

      for (const task of pendingTasks) {
        try {
          db.prepare("UPDATE pending_video_tasks SET attempts = attempts + 1 WHERE id = ?").run(task.id);

          let videoUrl = null;
          let done = false;

          // Poll provider
          if (task.provider === 'heygen') {
            const heygenKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
            if (!heygenKey) continue;
            const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${task.task_id}`, {
              headers: { 'X-Api-Key': heygenKey }
            });
            const d = await r.json();
            const status = d.data?.status || d.status;
            const url = d.data?.video_url || d.video_url;
            if (status === 'completed' && url) { videoUrl = url; done = true; }
            else if (status === 'failed') done = true;
          } else if (task.provider === 'arcads') {
            // Arcads deprecated — mark old pending tasks as failed so they stop polling
            done = true;
          } else if (task.provider === 'runway') {
            const runwayKey = getSetting('RUNWAY_API_KEY') || process.env.RUNWAY_API_KEY;
            if (!runwayKey) continue;
            const r = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task.task_id}`, {
              headers: { Authorization: `Bearer ${runwayKey}`, 'X-Runway-Version': '2024-11-06' }
            });
            const d = await r.json();
            if (d.status === 'SUCCEEDED' && d.output?.[0]) { videoUrl = d.output[0]; done = true; }
            else if (d.status === 'FAILED') done = true;
          }

          if (!done) continue;

          db.prepare("UPDATE pending_video_tasks SET status = ? WHERE id = ?")
            .run(videoUrl ? 'completed' : 'failed', task.id);

          if (!videoUrl || !task.creative_id) continue;

          // Update creative with video URL
          db.prepare("UPDATE ad_creatives SET video_url = ?, status = 'active' WHERE id = ?")
            .run(videoUrl, task.creative_id);

          // ── Upload video creative to the ad platform ──────────────────────
          const campaign = db.prepare("SELECT name, platform, platform_campaign_id FROM ad_campaigns WHERE id = ?").get(task.campaign_id);
          let platformCreativeId = null;

          if (campaign?.platform_campaign_id) {
            try {
              if (campaign.platform === 'meta') {
                const metaToken = getSetting('META_ACCESS_TOKEN');
                const metaAdAccount = getSetting('META_AD_ACCOUNT_ID');
                if (metaToken && metaAdAccount) {
                  // Step 1: Upload video to Meta
                  const uploadRes = await fetch(`https://graph.facebook.com/v19.0/act_${metaAdAccount}/advideos`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file_url: videoUrl, access_token: metaToken, title: task.creative_headline || campaign.name })
                  });
                  const uploadData = await uploadRes.json();
                  const videoId = uploadData.id;

                  if (videoId) {
                    // Step 2: Create ad creative with video
                    const creativeRes = await fetch(`https://graph.facebook.com/v19.0/act_${metaAdAccount}/adcreatives`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        access_token: metaToken,
                        name: `[AI Video] ${campaign.name}`,
                        object_story_spec: {
                          video_data: {
                            video_id: videoId,
                            message: task.creative_headline || campaign.name,
                            call_to_action: { type: 'SHOP_NOW', value: { link: '' } }
                          }
                        }
                      })
                    });
                    const creativeData = await creativeRes.json();
                    platformCreativeId = creativeData.id;

                    // Step 3: Create ad in the campaign
                    if (platformCreativeId) {
                      const adSetRes = await fetch(`https://graph.facebook.com/v19.0/act_${metaAdAccount}/adsets?access_token=${metaToken}&campaign_id=${campaign.platform_campaign_id}&limit=1`);
                      const adSetData = await adSetRes.json();
                      const adSetId = adSetData.data?.[0]?.id;
                      if (adSetId) {
                        await fetch(`https://graph.facebook.com/v19.0/act_${metaAdAccount}/ads`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            access_token: metaToken,
                            name: `[AI Video Ad] ${campaign.name}`,
                            adset_id: adSetId,
                            creative: { creative_id: platformCreativeId },
                            status: 'PAUSED' // Paused by default — user reviews before going live
                          })
                        });
                      }
                    }
                  }
                }
              } else if (campaign.platform === 'tiktok') {
                const tiktokToken = getSetting('TIKTOK_ACCESS_TOKEN');
                const tiktokAdv = getSetting('TIKTOK_ADVERTISER_ID');
                if (tiktokToken && tiktokAdv) {
                  // Upload video to TikTok
                  const uploadRes = await fetch('https://business-api.tiktok.com/open_api/v1.3/file/video/ad/upload/', {
                    method: 'POST',
                    headers: { 'Access-Token': tiktokToken, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ advertiser_id: tiktokAdv, video_url: videoUrl, upload_type: 'UPLOAD_BY_URL' })
                  });
                  const uploadData = await uploadRes.json();
                  const videoId = uploadData.data?.video_info?.video_id;
                  if (videoId) {
                    platformCreativeId = videoId;
                    // Create TikTok ad creative
                    await fetch('https://business-api.tiktok.com/open_api/v1.3/creative/create/', {
                      method: 'POST',
                      headers: { 'Access-Token': tiktokToken, 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        advertiser_id: tiktokAdv,
                        campaign_id: campaign.platform_campaign_id,
                        ad_name: `[AI Video] ${campaign.name}`,
                        ad_text: task.creative_headline || campaign.name,
                        video_id: videoId,
                        call_to_action: 'SHOP_NOW',
                        operation_status: 'DISABLE' // Paused for review
                      })
                    });
                  }
                }
              }
            } catch(platformErr) {
              console.warn('[VideoPoller platform upload]', platformErr.message);
              // Non-fatal — video is still saved locally
            }
          }

          // Update creative with platform ID if we got one
          if (platformCreativeId) {
            db.prepare("UPDATE ad_creatives SET platform_creative_id = ? WHERE id = ?")
              .run(String(platformCreativeId), task.creative_id);
          }

          // Notify business owner
          const owner = db.prepare("SELECT email, business_name, name FROM users WHERE id = ?").get(task.user_id);
          if (owner?.email) {
            try {
              const sgMail = require('@sendgrid/mail');
              sgMail.setApiKey(process.env.SENDGRID_API_KEY || getSetting('SENDGRID_API_KEY'));
              const bizName = owner.business_name || owner.name || 'your business';
              const platformUploaded = platformCreativeId
                ? `<p style="color:#16A34A;font-weight:600">✅ Uploaded to ${campaign?.platform || 'ad platform'} as a paused ad — review and activate in your Ads tab.</p>`
                : `<p style="color:#64748B;font-size:13px">The video is saved to your TAKEOVA account. Connect your ${campaign?.platform || 'ad platform'} account in Settings → Integrations to auto-upload future videos.</p>`;

              await sgMail.send({
                to: owner.email,
                from: { name: 'TAKEOVA AI Marketing Manager', email: process.env.SENDGRID_FROM_EMAIL || getSetting('EMAIL_FROM') || 'noreply@takeova.ai' },
                subject: `🎬 Your video ad is ready — ${campaign?.name || 'new campaign'}`,
                html: `<div style="font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px;color:#0F172A">
                  <h2 style="font-size:20px;font-weight:800;margin-bottom:8px">🎬 Video ad ready!</h2>
                  <p style="color:#475569;margin-bottom:16px">Your AI Marketing Manager created a UGC video ad for <strong>${campaign?.name || 'your campaign'}</strong>.</p>
                  <video controls style="width:100%;border-radius:12px;margin-bottom:16px;max-height:400px" src="${videoUrl}" poster="${videoUrl}"></video>
                  ${platformUploaded}
                  <a href="${process.env.FRONTEND_URL || 'https://takeova.ai'}" style="display:inline-block;background:#2563EB;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;margin-top:12px">Review in MINE →</a>
                </div>`
              });
            } catch(mailErr) { /* non-fatal */ }
          }

          console.log(`[VideoPoller] ✅ Creative ${task.creative_id} ready${platformCreativeId ? ' + platform uploaded' : ''}`);

        } catch(taskErr) { console.warn('[VideoPoller task]', taskErr.message); }
      }
    } catch(e) { console.error('[VideoPoller]', e.message); }
  }, 5 * 60 * 1000); // Every 5 minutes

  // ── AI Employee Tasks — every hour ──
  setInterval(async () => {
    try {
      if (!cronOwn("ai_employee_tasks", 10800000)) return;
      // Guard: only run once per hour using cron_log
      const todayHour = new Date().toISOString().slice(0,13); // "2025-03-15T14"
      const lastRun = db.prepare("SELECT last_run FROM cron_log WHERE key='ai_employees_hourly'").get();
      if (lastRun?.last_run === todayHour) return;
      db.prepare("INSERT OR REPLACE INTO cron_log (key, last_run) VALUES ('ai_employees_hourly',?)").run(todayHour);
      const enabledEmployees = db.prepare("SELECT DISTINCT user_id FROM ai_employees WHERE enabled = 1").all();

      for (const { user_id } of enabledEmployees) {
        try {
          const cronResp = await fetch(`http://localhost:${PORT}/api/ai-employees/cron`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-key": process.env.INTERNAL_API_KEY
            },
            body: JSON.stringify({ user_id })
          });
          if (!cronResp.ok) {
            let errBody = ""; try { errBody = (await cronResp.text()).slice(0, 200); } catch(_) {}
            console.error(`[CRON ai-employees] user ${user_id} → ${cronResp.status}: ${errBody}`);
          }
        } catch (e) {
          console.error(`[CRON ai-employees] user ${user_id} fetch error:`, e.message);
        }
      }
    } catch (e) { console.error("[CRON] AI employee cron failed:", e.message); }
  }, 60 * 60 * 1000); // Every hour

  // ── Scheduled Emails — send pending emails that are due ──
  setInterval(async () => {
    try {
      if (!cronOwn("scheduled_emails", 900000)) return;
      db.exec("CREATE TABLE IF NOT EXISTS scheduled_emails (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT, send_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");
      const due = db.prepare("SELECT * FROM scheduled_emails WHERE status = 'pending' AND datetime(send_at) <= datetime('now')").all();
      // Always check booking reminders (not gated on scheduled email count)
      if (true) {
        // Also check booking reminders
        try {
          db.exec("CREATE TABLE IF NOT EXISTS booking_reminders (id TEXT PRIMARY KEY, booking_id TEXT, user_id TEXT, customer_email TEXT, customer_name TEXT, customer_phone TEXT, service TEXT, reminder_time TEXT, type TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");
          const reminders = db.prepare("SELECT * FROM booking_reminders WHERE status = 'pending' AND datetime(reminder_time) <= datetime('now')").all();
          if (reminders.length > 0) {
            const sgKey = db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value || process.env.SENDGRID_API_KEY;
            const fromEmail = db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value || "hello@takeova.ai";
            if (sgKey) {
              const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
              for (const r of reminders) {
                try {
                  const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(r.user_id);
                  const bizName = site?.name || "Business";
                  const timeLabel = r.type.startsWith("24h") ? "tomorrow" : "in 1 hour";

                  if (r.type.includes("email")) {
                    // Escape user-controlled values before embedding in HTML email
                    const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
                    const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
                      method: "POST", headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
                      body: JSON.stringify({ personalizations: [{ to: [{ email: r.customer_email }] }], from: { email: fromEmail, name: esc(bizName) },
                        subject: `Reminder: ${esc(r.service)} at ${esc(bizName)} — ${timeLabel}`,
                        content: [{ type: "text/html", value: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px"><h2>Appointment Reminder ⏰</h2><p>Hi ${esc(r.customer_name || "there")},</p><p>Just a reminder that your <strong>${esc(r.service)}</strong> appointment at <strong>${esc(bizName)}</strong> is ${timeLabel}.</p><p style="color:#666;font-size:13px;margin-top:16px">Need to reschedule? Reply to this email.</p></div>` }] })
                    });
                    if (!_sgResp.ok) {
                      // Don't mark the reminder as 'sent' — let it retry on next cron tick.
                      // Previously this whole block fell through to the "UPDATE status='sent'"
                      // line below, so SendGrid rejections made reminders vanish without ever reaching customers.
                      let errBody = ""; try { errBody = (await _sgResp.text()).slice(0, 200); } catch(_) {}
                      console.error(`[cron booking-reminder] SendGrid ${_sgResp.status} for ${r.customer_email}: ${errBody}`);
                      throw new Error("SendGrid " + _sgResp.status);
                    }
                  }
                  if (r.type.includes("sms") && r.customer_phone) {
                    // Validate phone looks like a phone number before sending to Twilio
                    const cleanPhone = String(r.customer_phone).replace(/[^+\d]/g, "");
                    if (cleanPhone.length >= 7 && cleanPhone.length <= 16) {
                      const twilioSid = db.prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_ACCOUNT_SID'").get()?.value;
                      const twilioAuth = db.prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_AUTH_TOKEN'").get()?.value;
                      const twilioFrom = db.prepare("SELECT value FROM platform_settings WHERE key = 'TWILIO_PHONE_NUMBER'").get()?.value;
                      if (twilioSid && twilioAuth && twilioFrom) {
                        const _twResp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
                          method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
                          body: `To=${encodeURIComponent(cleanPhone)}&From=${encodeURIComponent(twilioFrom)}&Body=${encodeURIComponent(`Reminder: Your ${r.service} at ${bizName} is ${timeLabel}. See you soon! — ${bizName}`)}`
                        });
                        if (!_twResp.ok) {
                          // Twilio rejected (bad number, no credits, wrong geo, etc).
                          // Previously the reminder was marked 'sent' regardless;
                          // now we throw so the catch below marks it 'failed'.
                          let errBody = ""; try { errBody = (await _twResp.text()).slice(0, 200); } catch(_) {}
                          console.error(`[cron booking-reminder] Twilio ${_twResp.status} for ${cleanPhone}: ${errBody}`);
                          throw new Error("Twilio " + _twResp.status);
                        }
                      }
                    }
                  }
                  db.prepare("UPDATE booking_reminders SET status = 'sent' WHERE id = ?").run(r.id);
                } catch(e) { db.prepare("UPDATE booking_reminders SET status = 'failed' WHERE id = ?").run(r.id); }
              }

            }
          }
        } catch(e) {}
      }
      if (due.length === 0) return;
      const sgKey = db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value || process.env.SENDGRID_API_KEY;
      const fromEmail = db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value || "hello@takeova.ai";
      if (!sgKey) return;
      const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
      for (const email of due) {
        try {
          // Enforce plan email cap before each scheduled send
          const ownerLimits = db.prepare("SELECT emails_sent, email_limit FROM users WHERE id = ?").get(email.user_id);
          if (ownerLimits && ownerLimits.emails_sent >= ownerLimits.email_limit) {
            db.prepare("UPDATE scheduled_emails SET status = 'failed' WHERE id = ?").run(email.id);
            continue; // Skip — plan limit reached
          }
          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({ personalizations: [{ to: [{ email: email.email }] }], from: { email: fromEmail, name: "MINE" }, subject: String(email.subject || "").replace(/[\r\n]/g, " "), content: [{ type: "text/html", value: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">${email.body.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g, "<br>")}</div>` }] })
          });
          if (!_sgResp.ok) {
            // Scheduled email rejected by SendGrid — mark failed so we don't
            // retry infinitely AND don't double-bill for the email.
            let errBody = ""; try { errBody = (await _sgResp.text()).slice(0, 200); } catch(_) {}
            console.error(`[cron scheduled-email] SendGrid ${_sgResp.status} for ${email.email}: ${errBody}`);
            db.prepare("UPDATE scheduled_emails SET status = 'failed' WHERE id = ?").run(email.id);
            continue;
          }
          db.prepare("UPDATE scheduled_emails SET status = 'sent' WHERE id = ?").run(email.id);
          db.prepare("UPDATE users SET emails_sent = emails_sent + 1 WHERE id = ?").run(email.user_id);
          // Track in usage_tracking for overage billing.
          // Without this, scheduled-email pushes past the plan cap would
          // not trigger overage charges — matching the funnel engine fix.
          if (typeof global !== "undefined" && global.mineTrackUsage) {
            try { global.mineTrackUsage(db, email.user_id, "emails"); } catch(e) {}
          }
        } catch(e) { db.prepare("UPDATE scheduled_emails SET status = 'failed' WHERE id = ?").run(email.id); }
      }

    } catch(e) {}
  }, 60 * 60 * 1000);

  // ── MINE Intelligence — nightly at 3am ───────────────────────────────────
  // Builds cohort benchmarks and generates personalised briefings.
  // Uses a DB flag so a server restart after 3am still fires, not silently skips.
  setInterval(async () => {
    const now = new Date();
    // Run between 3:00am and 3:59am
    if (now.getHours() !== 3) return;
    if (!cronOwn('intel_nightly', 2 * 60 * 60 * 1000)) return;
    try {
      const db = getDb();
      db.exec("CREATE TABLE IF NOT EXISTS cron_log (key TEXT PRIMARY KEY, last_run TEXT)");
      const todayStr = now.toISOString().slice(0, 10);
      const lastRun = db.prepare("SELECT last_run FROM cron_log WHERE key = 'intelligence_nightly'").get();
      if (lastRun?.last_run === todayStr) return; // Already ran today
      db.prepare("INSERT OR REPLACE INTO cron_log (key, last_run) VALUES ('intelligence_nightly', ?)").run(todayStr);

      await runNightlyIntelligence(db);
    } catch(e) { console.error("[CRON] Intelligence nightly error:", e.message); }
  }, 60 * 60 * 1000); // Check every hour

  // ── MINE Intelligence — morning delivery at 8am ───────────────────────────
  // Sends the generated briefings via email + push notification.
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 8) return;
    if (!cronOwn('intel_morning', 2 * 60 * 60 * 1000)) return;
    try {
      const db = getDb();
      db.exec("CREATE TABLE IF NOT EXISTS cron_log (key TEXT PRIMARY KEY, last_run TEXT)");
      const todayStr = now.toISOString().slice(0, 10);
      const lastRun = db.prepare("SELECT last_run FROM cron_log WHERE key = 'intelligence_delivery'").get();
      if (lastRun?.last_run === todayStr) return;
      db.prepare("INSERT OR REPLACE INTO cron_log (key, last_run) VALUES ('intelligence_delivery', ?)").run(todayStr);

      await deliverMorningBriefings(db);
    } catch(e) { console.error("[CRON] Intelligence delivery error:", e.message); }
  }, 60 * 60 * 1000); // Check every hour
  // still fires, instead of silently skipping the whole week if the server was down at 9am.
  setInterval(async () => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() >= 9) {
      try {
        const thisMonday = now.toISOString().slice(0, 10); // YYYY-MM-DD
        db.exec("CREATE TABLE IF NOT EXISTS cron_log (key TEXT PRIMARY KEY, last_run TEXT)");
        const lastRun = db.prepare("SELECT last_run FROM cron_log WHERE key = 'weekly_summary'").get();
        if (!lastRun || lastRun.last_run < thisMonday) {
          db.prepare("INSERT OR REPLACE INTO cron_log (key, last_run) VALUES ('weekly_summary', ?)").run(thisMonday);
          const { sendWeeklySummary } = require("./routes/features");
          await sendWeeklySummary(db);

        }
      } catch(e) {}
    }
    // ── Onboarding Day 3/7 emails + Re-engagement 7/14-day ─────────────────
  try { await sendOnboardingSequence(db); } catch(e) {}
  try { await sendReEngagementEmails(db); } catch(e) {}
  // Prospector follow-up emails (Day 4 + Day 8)
  try {
    const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
    await fetch(`http://localhost:${process.env.PORT || 4000}/api/prospector/send-followups`, {
      method: "POST",
      headers: { "x-cron-key": process.env.CRON_SECRET || "" }
    });
  } catch(e) {}

  // Overdue invoices — check every hour
    try {
      const { processOverdueInvoices } = require("./routes/features");
      await processOverdueInvoices(db);
    } catch(e) {}
    // Membership expiring — warn members 7 days before expiry
    try {
      const expiringMembers = db.prepare(`
        SELECT me.*, u.id as owner_id FROM membership_enrollments me
        JOIN users u ON me.user_id = u.id
        WHERE me.status = 'active'
        AND me.expires_at IS NOT NULL
        AND datetime(me.expires_at) BETWEEN datetime('now') AND datetime('now', '+7 days')
        AND me.expiry_warned IS NULL
      `).all();
      const { fireAutomation } = require("./routes/features");
      // Ensure expiry_warned column exists (run once before loop)
      try { db.prepare("ALTER TABLE membership_enrollments ADD COLUMN expiry_warned TEXT").run(); } catch(e) {}
      for (const m of expiringMembers) {
        fireAutomation(m.owner_id, "membership_expiring", {
          email: m.customer_email, name: m.customer_name || "",
          membershipId: m.membership_id, expiresAt: m.expires_at
        });
        db.prepare("UPDATE membership_enrollments SET expiry_warned = datetime('now') WHERE id = ?").run(m.id);
      }
      if (expiringMembers.length) console.log(`[CRON] ${expiringMembers.length} membership expiry warnings sent`);
    } catch(e) {}
    // Abandoned cart recovery emails — process every hour
    try {
      const abandonedCarts = db.prepare(`
        SELECT ac.*, s.user_id FROM abandoned_carts ac
        JOIN sites s ON s.id = ac.site_id
        WHERE ac.recovered = 0 AND ac.reminder_count < 3
        AND datetime(ac.updated_at, '+1 hour') <= datetime('now')
        LIMIT 100
      `).all();
      const { autoEmail: cartEmail, fireAutomation: cartFireAuto } = require("./routes/features");
      for (const cart of abandonedCarts) {
        const items = JSON.parse(cart.items || "[]");
        const itemList = items.map(i => `${i.name || "Item"} — $${(i.price || 0).toFixed(2)}`).join("<br>");
        const subject = cart.reminder_count === 0 ? "You left something behind..." : cart.reminder_count === 1 ? "Still interested?" : "Last chance — your cart expires soon";
        if (cart.customer_email) {
          try {
            await cartEmail(cart.user_id, cart.customer_email, subject,
              `<h2>You left something in your cart 🛒</h2>
              <p>Hi${cart.customer_name ? " " + cart.customer_name : ""},</p>
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0">
                ${itemList}
                <div style="font-weight:700;font-size:16px;margin-top:12px;color:#635BFF">Total: $${(cart.cart_total || 0).toFixed(2)}</div>
              </div>
              ${cart.cart_url ? `<div style="text-align:center;margin:20px 0"><a href="${cart.cart_url}" style="display:inline-block;padding:14px 28px;background:#635BFF;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Complete Your Order →</a></div>` : ""}
              <p style="color:#94a3b8;font-size:12px">Your cart is saved and ready when you are.</p>`
            );
          } catch(e) {}
          cartFireAuto(cart.user_id, "cart_abandoned", { email: cart.customer_email, name: cart.customer_name || "", cartTotal: cart.cart_total || 0, cartUrl: cart.cart_url || "" });
        }
        db.prepare("UPDATE abandoned_carts SET reminder_sent = 1, reminder_count = reminder_count + 1, updated_at = datetime('now') WHERE id = ?").run(cart.id);
      }
      if (abandonedCarts.length) console.log(`[CRON] Sent ${abandonedCarts.length} cart recovery emails`);
    } catch(e) {}
    // Funnel engine — send due funnel emails
    try {
      const { processFunnelSteps } = require("./routes/email");
      await processFunnelSteps(db);
    } catch(e) {}
    // Outreach follow-ups — send scheduled campaign follow-ups
    try {
      const { processAllFollowUps } = require("./routes/outreach");
      await processAllFollowUps(db);
    } catch(e) {}
    // Launch scheduled outreach campaigns whose time has arrived
    try {
      const dueCampaigns = db.prepare(
        "SELECT * FROM outreach_campaigns WHERE status = 'scheduled' AND datetime(scheduled_time) <= datetime('now')"
      ).all();
      for (const c of dueCampaigns) {
        db.prepare("UPDATE outreach_campaigns SET status = 'running' WHERE id = ?").run(c.id);
        const { processCampaign } = require("./routes/outreach");
        if (processCampaign) processCampaign(db, c.id, c.user_id).catch(() => {});
      }
      if (dueCampaigns.length) console.log(`[CRON] Started ${dueCampaigns.length} scheduled outreach campaigns`);
    } catch(e) {}
  }, 60 * 60 * 1000);

  
  // ── Webhook Retry — retry failed webhooks up to 3 times ──────────────────────
  setInterval(async () => {
    try {
      if (!cronOwn("webhook_retry", 900000)) return;
      const db2 = getDb();
      try { db2.exec("CREATE TABLE IF NOT EXISTS webhook_logs (id TEXT PRIMARY KEY, webhook_id TEXT, user_id TEXT, event TEXT, payload TEXT, url TEXT, status TEXT, response_code INTEGER, retry_count INTEGER DEFAULT 0, next_retry_at TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch(e) {}
      const due = db2.prepare("SELECT * FROM webhook_logs WHERE status IN ('failed','error') AND retry_count < 3 AND datetime(next_retry_at) <= datetime('now')").all();
      if (!due.length) return;
      const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
      for (const log of due) {
        try {
          const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 5000);
          const resp = await fetch(log.url, {
            signal: ctrl.signal, method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: log.payload || '{}'
          });
          if (resp.ok) {
            db2.prepare("UPDATE webhook_logs SET status='delivered', response_code=? WHERE id=?").run(resp.status, log.id);
          } else {
            const nextDelay = Math.pow(2, log.retry_count) * 5; // 5, 10, 20 minutes
            db2.prepare("UPDATE webhook_logs SET retry_count=retry_count+1, next_retry_at=datetime('now',?), response_code=? WHERE id=?")
              .run(`+${nextDelay} minutes`, resp.status, log.id);
          }
        } catch(e) {
          const nextDelay = Math.pow(2, log.retry_count) * 5;
          try { db2.prepare("UPDATE webhook_logs SET retry_count=retry_count+1, next_retry_at=datetime('now',?) WHERE id=?").run(`+${nextDelay} minutes`, log.id); } catch(e2) {}
        }
      }
    } catch(e) { console.error('[CRON] Webhook retry error:', e.message); }
  }, 5 * 60 * 1000); // every 5 minutes

// ── Session Cleanup — remove expired sessions daily ──
  const { cleanupSessions, requireActivePlan } = require("./middleware/auth");
  cleanupSessions(); // run once on startup
  // Run cleanup daily to prevent sessions/password_resets table bloat
  setInterval(() => {
    try {
      cleanupSessions();
      const db = getDb();
      db.prepare("DELETE FROM password_resets WHERE used = 1 OR datetime(expires_at) < datetime('now')").run();
      // Prune partner_sessions older than 90 days (they have no expiry column — age-based cleanup)
      try { db.prepare("DELETE FROM partner_sessions WHERE datetime(created_at) < datetime('now','-90 days')").run(); } catch(e) {}
      // Prune portal_clients tokens older than 1 year
      try { db.prepare("DELETE FROM portal_clients WHERE token_expires IS NOT NULL AND datetime(token_expires) < datetime('now')").run(); } catch(e) {}
    } catch(e) {}
  }, 24 * 60 * 60 * 1000);

  // Monthly ROI Report — send on 1st of month at 9am
  setInterval(async () => {
    const now = new Date();
    if (now.getDate() !== 1 || now.getHours() !== 9) return;
    try {
      const db = getDb();
      db.exec("CREATE TABLE IF NOT EXISTS cron_log (key TEXT PRIMARY KEY, last_run TEXT)");
      const todayStr = now.toISOString().slice(0, 10);
      const lastRun = db.prepare("SELECT last_run FROM cron_log WHERE key = 'monthly_roi_report'").get();
      if (lastRun?.last_run === todayStr) return;
      db.prepare("INSERT OR REPLACE INTO cron_log (key, last_run) VALUES ('monthly_roi_report', ?)").run(todayStr);

      await sendMonthlyROIReport(db);

      // ── Bill all pending overages for the previous month ──────────────────
      try {
        const prevPeriod = (() => {
          const d = new Date(); d.setMonth(d.getMonth() - 1);
          return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        })();
        const usersWithOverages = db.prepare(
          "SELECT DISTINCT user_id FROM overage_charges WHERE period = ? AND status = 'pending'"
        ).all(prevPeriod);
        for (const { user_id } of usersWithOverages) {
          try {
            // Admin bypass: mark pending rows as admin_free, never call billing
            const adminCheck = db.prepare("SELECT role FROM users WHERE id = ?").get(user_id);
            if (adminCheck?.role === "admin") {
              db.prepare("UPDATE overage_charges SET status='admin_free' WHERE user_id=? AND period=? AND status='pending'").run(user_id, prevPeriod);
              continue;
            }
            const fetch2 = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
            const base = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
            await fetch2(`${base}/api/payments/bill-overages`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-cron-key": process.env.CRON_SECRET || "",
                "Authorization": `Bearer __SYSTEM__`
              },
              body: JSON.stringify({ user_id })
            });
          } catch(e) { console.error("[CRON] Overage billing failed for", user_id, e.message); }
        }
        if (usersWithOverages.length > 0) {
          console.log(`[CRON] Billed overages for ${usersWithOverages.length} users (period: ${prevPeriod})`);
        }
      } catch(e) { console.error("[CRON] Monthly overage billing error:", e.message); }

    } catch(e) { console.error("[CRON] Monthly ROI report error:", e.message); }
  }, 60 * 60 * 1000);

  // ── Agency billing — runs on 1st of each month ───────────────────────────
  // Bills each agency client on their own card.
  // Records agency commission (40% of fees + 1.25% of client tx volume) and transfers via Stripe Connect.
  setInterval(async () => {
    const now = new Date();
    if (now.getDate() !== 1 || now.getHours() !== 6) return; // 6am on 1st
    if (!cronOwn('agency_billing', 24 * 60 * 60 * 1000)) return;
    try {
      const db = getDb();
      db.exec("CREATE TABLE IF NOT EXISTS cron_log (key TEXT PRIMARY KEY, last_run TEXT)");
      const todayStr = now.toISOString().slice(0, 10);
      const lastRun = db.prepare("SELECT last_run FROM cron_log WHERE key = 'agency_billing'").get();
      if (lastRun?.last_run === todayStr) return;
      db.prepare("INSERT OR REPLACE INTO cron_log (key, last_run) VALUES ('agency_billing', ?)").run(todayStr);

      const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
      const { getSetting } = require("./routes/integrations");
      const cronSecret = process.env.CRON_SECRET || getSetting("CRON_SECRET") || "";
      await fetch(`http://localhost:${PORT}/api/agency/cron/bill`, {
        method: "POST",
        headers: { "x-cron-key": cronSecret }
      });
    } catch(e) { console.error("[CRON] Agency billing error:", e.message); }
  }, 60 * 60 * 1000);

  // Month-end overage billing — runs daily, fires Stripe invoices on the last day of each month
  setInterval(async () => {
    try {
      const now = new Date();
      const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      if (now.getDate() !== lastDayOfMonth) return; // only run on last day of month
      // Idempotency guard — prevent double-billing if server restarts on last day
      const db2 = getDb();
      db2.exec("CREATE TABLE IF NOT EXISTS cron_log (key TEXT PRIMARY KEY, last_run TEXT)");
      const todayStr2 = now.toISOString().slice(0, 10);
      const overageLastRun = db2.prepare("SELECT last_run FROM cron_log WHERE key = 'overage_billing'").get();
      if (overageLastRun?.last_run === todayStr2) return;
      db2.prepare("INSERT OR REPLACE INTO cron_log (key, last_run) VALUES ('overage_billing', ?)").run(todayStr2);

      const db = getDb();
      const period = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      const usersWithOverages = db.prepare(
        "SELECT DISTINCT user_id FROM overage_charges WHERE period = ? AND status = 'pending'"
      ).all(period);

      for (const { user_id } of usersWithOverages) {
        try {
          // ── Admin bypass: skip billing entirely. Mark pending rows as
          // 'admin_free' so they don't accumulate forever. Admin owns the
          // platform; API costs route to company accounts, not the admin's card.
          const adminCheck = db.prepare("SELECT role FROM users WHERE id = ?").get(user_id);
          if (adminCheck?.role === "admin") {
            db.prepare("UPDATE overage_charges SET status='admin_free' WHERE user_id=? AND period=? AND status='pending'").run(user_id, period);
            continue;
          }
          const overages = db.prepare(
            "SELECT metric, SUM(total) as total, SUM(quantity) as qty FROM overage_charges WHERE user_id = ? AND period = ? AND status = 'pending' GROUP BY metric"
          ).all(user_id, period);
          const totalOverage = overages.reduce((s, o) => s + o.total, 0);
          if (totalOverage < 0.50) continue; // Stripe minimum ~$0.50

          const user = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(user_id);
          if (!user?.stripe_customer_id) {

            continue;
          }

          const stripeKey = process.env.STRIPE_SECRET_KEY;
          if (!stripeKey) { console.error("[BILLING] STRIPE_SECRET_KEY not set"); break; }

          const stripe = require("stripe")(stripeKey);
          const invoice = await stripe.invoices.create({
            customer: user.stripe_customer_id,
            auto_advance: true,
            collection_method: "charge_automatically",
            metadata: { mine_user: user_id, mine_period: period, type: "overage" },
          });
          const isAgencyClient = false;
          const billingCustomerId = user.stripe_customer_id;

          const METRIC_NAMES = {
            edits:"AI Edits", images:"AI Images", aiVideos:"AI Videos", ugcVideos:"UGC Videos",
            emails:"Emails", outreachEmails:"Outreach Emails", outreachSMS:"Outreach SMS",
            voiceMins:"Voice Minutes", proposals:"AI Proposals", socialPosts:"Social Posts",
            adCreatives:"Ad Creatives", aiActions:"AI Actions", chatbotChats:"Chatbot Chats",
            competitorReports:"Competitor Reports", aiResearch:"AI Research", blogPosts:"Blog Posts",
            contracts:"Contracts", mentorChats:"Mentor Chats", knowledgeBase:"Knowledge Base Articles",
            leadMagnets:"Lead Magnets", customerChats:"Customer Chats",
            whatsappMessages:"Take Control Messages", storeBio:"AI Store Bio", sequenceBuilder:"AI Email Sequence", smsBroadcastSends:"SMS Broadcast", smsSequenceSends:"SMS Sequence", smsReminderSends:"SMS Appointment Reminder", growthAgentRuns:"Growth Agent Run", growthAgentAI:"Growth Agent AI Call", productDescs:"AI Product Descriptions", reviewReplies:"AI Review Replies",
            socialCaptions:"AI Social Captions", invoiceChasers:"AI Invoice Chasers",
            upsellRecs:"AI Upsell Recommendations", cartPersonalise:"AI Cart Personalisation",
            faqGeneration:"AI FAQ Generation", refundHandling:"AI Refund Handling",
            competitorAnalysis:"AI Competitor Analysis"
          };

          for (const o of overages) {
            const label = METRIC_NAMES[o.metric] || o.metric;
            await stripe.invoiceItems.create({
              customer: billingCustomerId,
              invoice: invoice.id,
              amount: Math.round(o.total * 100),
              currency: "usd",
              description: `MINE Overage — ${label}: ${o.qty} × $${(o.total / o.qty).toFixed(2)} (${period})`,
            });
          }

          await stripe.invoices.finalizeInvoice(invoice.id);
          const paid = await stripe.invoices.pay(invoice.id);
          if (paid.status === "paid") {
            db.prepare(
              "UPDATE overage_charges SET status = 'billed' WHERE user_id = ? AND period = ? AND status = 'pending'"
            ).run(user_id, period);

          } else {
            // Payment failed — kick off dunning sequence
            db.prepare(
              "UPDATE overage_charges SET status = 'failed' WHERE user_id = ? AND period = ? AND status = 'pending'"
            ).run(user_id, period);

            try {
              const { handleFailedPayment } = require("./routes/features");
              await handleFailedPayment(db, user.email, null, invoice.id, "overage", totalOverage);
            } catch(e2) { console.error("[BILLING] Dunning trigger failed:", e2.message); }
          }
        } catch(e) {
          try {
            db.prepare(
              "UPDATE overage_charges SET status = 'failed' WHERE user_id = ? AND period = ? AND status = 'pending'"
            ).run(user_id, period);
            const { handleFailedPayment } = require("./routes/features");
            await handleFailedPayment(db, user?.email, null, null, "overage", totalOverage);
          } catch(_) {}
          console.error(`[BILLING] Failed for user ${user_id} (${user?.email}):`, e.message);
        }
      }
    } catch(e) { console.error("[BILLING] Month-end cron error:", e.message); }
  }, 24 * 60 * 60 * 1000);

  // ── DUNNING RETRY CRON — runs daily, retries failed payments and pauses accounts ──
  setInterval(async () => {
    try {
      if (!cronOwn("dunning_retry", 86400000)) return;
      const db = getDb();

      // Find scheduled dunning retries that are due
      const dueRetries = db.prepare(`
        SELECT se.*, u.email, u.stripe_customer_id, u.account_status
        FROM scheduled_emails se
        JOIN users u ON u.id = se.user_id
        WHERE se.subject LIKE '__dunning_retry__%'
          AND se.status = 'pending'
          AND datetime(se.send_at) <= datetime('now')
        LIMIT 50
      `).all();

      for (const retry of dueRetries) {
        try {
          const payload = JSON.parse(retry.body || "{}");
          const { userId, customerEmail: payloadEmail, type, stripeInvoiceId, nextAttempt, amount } = payload;
          // customerEmail: for plan/overage = retry.email (the TAKEOVA user); for membership/product_sub = payloadEmail (the end customer)
          const retryEmail = payloadEmail || retry.email;
          const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");

          // Attempt Stripe retry if invoice exists
          let retrySucceeded = false;
          if (stripeInvoiceId && stripeKey) {
            try {
              const stripe = require("stripe")(stripeKey);
              // For membership/product_sub, the invoice lives on the connected account
              const connectTypes = ["membership", "product_subscription"];
              const stripeOptions = connectTypes.includes(type) && retry.user_id
                ? (() => {
                    const owner = db.prepare("SELECT stripe_connect_id FROM users WHERE id = ?").get(retry.user_id);
                    return owner?.stripe_connect_id ? { stripeAccount: owner.stripe_connect_id } : {};
                  })()
                : {};
              const paid = await stripe.invoices.pay(stripeInvoiceId, { forgive: false }, stripeOptions);
              if (paid.status === "paid") {
                retrySucceeded = true;
                const { handlePaymentSuccess } = require("./routes/features");
                await handlePaymentSuccess(db, retry.email, stripeInvoiceId);
                // Mark all pending overage charges for this user as billed if overage type
                if (type === "overage") {
                  db.prepare("UPDATE overage_charges SET status = 'billed' WHERE user_id = ? AND status = 'failed'")
                    .run(userId);
                }

              }
            } catch(stripeErr) {
              // Payment still failing — continue dunning sequence

            }
          }

          if (!retrySucceeded) {
            // Escalate dunning — pass retryEmail (customer) and userId (platform user for logging)
            const { handleFailedPayment } = require("./routes/features");
            await handleFailedPayment(db, retryEmail, null, stripeInvoiceId, type, amount, retryEmail !== retry.email ? userId : null);
          }

          // Mark this scheduled retry as processed
          db.prepare("UPDATE scheduled_emails SET status = 'sent' WHERE id = ?").run(retry.id);

        } catch(e) {
          db.prepare("UPDATE scheduled_emails SET status = 'failed' WHERE id = ?").run(retry.id);
          console.error(`[DUNNING] Retry error for user ${retry.user_id}:`, e.message);
        }
      }
    } catch(e) { console.error("[DUNNING] Retry cron error:", e.message); }
  }, 24 * 60 * 60 * 1000); // daily

  // ── DELETION WARNING + DATA PURGE CRON — runs daily ──
  // Day 45 after pause: sends deletion warning email
  // Day 60 after pause: purges all user data and deletes account
  setInterval(async () => {
    try {
      if (!cronOwn("deletion_purge", 86400000)) return;
      const db = getDb();

      // ── Process deletion warning emails (day 45) ──
      const warningEmails = db.prepare(`
        SELECT se.*, u.email as user_email, u.id as uid
        FROM scheduled_emails se
        JOIN users u ON u.id = se.user_id
        WHERE se.subject = '__deletion_warning__'
          AND se.status = 'pending'
          AND datetime(se.send_at) <= datetime('now')
        LIMIT 20
      `).all();

      for (const row of warningEmails) {
        try {
          const payload = JSON.parse(row.body || "{}");
          const sgKey = getSetting("SENDGRID_API_KEY");
          const fromEmail = getSetting("EMAIL_FROM") || "hello@takeova.ai";
          if (sgKey && row.user_email) {
            const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
            const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
              method: "POST",
              headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
              body: JSON.stringify({
                personalizations: [{ to: [{ email: row.user_email }] }],
                from: { email: fromEmail, name: "MINE" },
                subject: "⚠️ Your TAKEOVA data will be deleted in 15 days",
                content: [{ type: "text/html", value: `
                  <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
                    <h2 style="color:#DC2626">⚠️ Data Deletion Notice</h2>
                    <p>Your TAKEOVA account has been paused for 45 days due to an unpaid balance.</p>
                    <p><strong>Your account data will be permanently deleted in 15 days</strong> (${new Date(payload.deletionDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}) unless you update your payment method.</p>
                    <p>This includes all your sites, contacts, products, orders, emails, and every other piece of data in your account. This cannot be undone.</p>
                    <div style="text-align:center;margin:28px 0">
                      <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}?update_payment=true" style="display:inline-block;padding:14px 32px;background:#635BFF;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">
                        Update Payment & Restore Account →
                      </a>
                    </div>
                    <p style="color:#94a3b8;font-size:12px">If you believe this is an error, reply to this email immediately.</p>
                  </div>` }]
              })
            });
            if (!_sgResp.ok) {
              // CRITICAL: this is a DATA DELETION warning. If SendGrid rejects
              // it and we mark the email as 'sent', the user gets no warning
              // and their data is purged 15 days later with no notice. Leave
              // as 'pending' so the cron will retry the next run.
              let errBody = ""; try { errBody = (await _sgResp.text()).slice(0, 200); } catch(_) {}
              console.error(`[PURGE] CRITICAL: deletion-warning SendGrid ${_sgResp.status} for ${row.user_email}: ${errBody}`);
              throw new Error("SendGrid " + _sgResp.status);
            }
          } else if (!sgKey) {
            // No SendGrid key — don't mark sent, retry when it's configured
            console.error("[PURGE] CRITICAL: no SendGrid key, cannot send deletion warning to " + row.user_email);
            continue;
          }
          db.prepare("UPDATE scheduled_emails SET status = 'sent' WHERE id = ?").run(row.id);

        } catch(e) {
          // Don't mark as 'failed' for network errors — we want to retry.
          // Only mark as 'failed' if the error looks permanent (bad payload).
          if (e && /JSON|undefined|null/.test(e.message || "")) {
            db.prepare("UPDATE scheduled_emails SET status = 'failed' WHERE id = ?").run(row.id);
          }
          console.error(`[PURGE] Warning email failed for ${row.uid}:`, e.message);
        }
      }

      // ── Purge accounts past deletion_scheduled_at (day 60) ──
      // SAFETY: require the deletion warning email was actually successfully
      // sent before purging. If the warning scheduled-email is still 'pending'
      // or has no corresponding row, skip this purge cycle — we will not
      // destroy user data without giving them notice first.
      const toDelete = db.prepare(`
        SELECT u.id, u.email, u.stripe_subscription_id, u.stripe_customer_id
        FROM users u
        WHERE u.account_status = 'paused'
          AND u.deletion_scheduled_at IS NOT NULL
          AND datetime(u.deletion_scheduled_at) <= datetime('now')
          AND EXISTS (
            SELECT 1 FROM scheduled_emails se
            WHERE se.user_id = u.id
              AND se.subject = '__deletion_warning__'
              AND se.status = 'sent'
          )
        LIMIT 10
      `).all();

      const purgeTables = [
        // Core user data
        "sessions","sites","contacts","deals","products","orders","invoices","bookings",
        "recurring_bookings","group_bookings","courses","enrollments","events","event_tickets",
        "memberships","blog_posts","forms","form_submissions","reviews","funnels",
        "email_templates","email_templates_user","email_log","email_tracking","scheduled_emails",
        "automations","automation_logs","notifications","webhooks","webhook_logs","files",
        // AI & features
        "ai_usage","ai_employees","ai_employee_actions","ai_research","ai_agent_config",
        "ai_agent_insights","ai_agent_reports","ai_ticket_usage","intelligence_insights",
        "monthly_narratives","meeting_preps","churn_scores","support_tickets","sales_copy_history",
        "mine_control_config","mine_control_messages","growth_agent_config","growth_agent_log","missed_call_config","missed_calls","user_addons","sms_conversations","sms_sequences","sms_platform_config","sms_cart_config","sms_reminder_config","sms_messages","sms_enrollments","sms_sequence_enrollments","sms_broadcasts","sms_keywords","sms_optouts","sms_appointment_config",
        // Outreach & email
        "outreach_campaigns","outreach_contacts","outreach_lists","outreach_messages",
        "email_sends","email_bounces","email_unsubscribes","lead_magnets","lead_magnet_sends",
        // Ads
        "ads","ad_campaigns","ad_creatives","ad_performance",
        // Affiliates
        "affiliates","affiliate_links","affiliate_clicks","affiliate_conversions","affiliate_programs",
        "mine_affiliates","mine_affiliate_conversions","mine_affiliate_clicks",
        "mine_affiliate_assets","mine_affiliate_payouts",
        // Payments & billing
        "proposals","contracts","payment_plans","payment_plan_enrollments","transactions",
        "overage_charges","dunning_log",
        // Loyalty & commerce
        "gift_cards","coupons","loyalty_config","loyalty_transactions","loyalty_redemptions",
        "loyalty_milestones_achieved","product_subscriptions","product_sub_subscribers",
        "customer_accounts","customer_auth_codes","customer_orders","upsells","shipping_rules","tax_rules",
        // Social & content
        "link_in_bio","social_connections","social_posts","social_profiles","user_social_tokens",
        "short_form_videos","podcast_episodes","podcasts","podcast_tokens",
        "community_posts","community_replies","community_likes","community_spaces",
        // Sites & analytics
        "site_analytics","site_ab_tests","site_ab_impressions","site_ab_conversions",
        "site_domains","site_imports","site_push_subscriptions","page_views",
        "ab_tests","trend_research","financial_reports","roadmap_items",
        // Bookings & services
        "booking_types","availability","coaching_sessions",
        "group_booking_attendees","event_attendees","waitlist","waitlist_entries",
        // Customer-facing portals
        "portal_clients","portal_projects","client_portal",
        "student_auth_codes","student_sessions",
        "chatbot_config","chatbot_conversations","chat_messages",
        "kb_articles","kb_categories","customer_health",
        // Courses
        "course_quizzes","quizzes","quiz_attempts","lesson_progress","funnel_enrollments",
        // Downloads & files
        "digital_downloads","download_tokens","generated_pdfs","drm_rules","drm_download_log",
        // Push & devices
        "push_subscriptions","push_tokens","device_tokens",
        // Misc user data
        "user_settings","user_onboarding","user_voice_numbers","voice_sessions","voice_leads","voice_packs",
        "installed_apps","app_installs","template_installs","template_reviews",
        "time_entries","expense_categories","abandoned_carts","cart_recovery_config",
        "membership_enrollments","membership_tiers","product_reviews",
        "outreach_campaigns","referrals","booking_reminders","audit_log","password_resets",
        // MINE affiliate platform tables
        "usage_tracking",
      ];

      for (const user of toDelete) {
        try {
          // Cancel Stripe subscription if still active
          const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
          if (stripeKey && user.stripe_subscription_id) {
            try {
              const stripe = require("stripe")(stripeKey);
              await stripe.subscriptions.cancel(user.stripe_subscription_id).catch(() => {});
            } catch(e) {}
          }

          // Send final deletion confirmation email
          const sgKey = getSetting("SENDGRID_API_KEY");
          const fromEmail = getSetting("EMAIL_FROM") || "hello@takeova.ai";
          if (sgKey && user.email) {
            const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
            await fetch("https://api.sendgrid.com/v3/mail/send", {
              method: "POST",
              headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
              body: JSON.stringify({
                personalizations: [{ to: [{ email: user.email }] }],
                from: { email: fromEmail, name: "MINE" },
                subject: "Your TAKEOVA account has been deleted",
                content: [{ type: "text/html", value: `
                  <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
                    <h2>Your TAKEOVA account has been deleted</h2>
                    <p>Your TAKEOVA account and all associated data have been permanently deleted due to 60 days of non-payment.</p>
                    <p>If you'd like to start fresh, you can always create a new account at <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}">takeova.ai</a>.</p>
                    <p style="color:#94a3b8;font-size:12px">If you believe this was in error, please contact us by replying to this email.</p>
                  </div>` }]
              })
            }).catch(() => {});
          }

          // Collect site IDs BEFORE purging DB rows (query would return nothing after deletion)
          const userSitesForPurge = db.prepare("SELECT id FROM sites WHERE user_id = ?").all(user.id);

          // Purge all user data from DB
          const purgeUser = db.transaction(() => {
            for (const table of purgeTables) {
              try { db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id); } catch(e) {}
            }
            db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
          });
          purgeUser();

          // Delete hosted site files from disk
          try {
            const fs = require("fs");
            const path = require("path");
            const uploadDir = process.env.UPLOAD_DIR || "./uploads";
            // Use pre-fetched site IDs (already deleted from DB above)
            const userSites = userSitesForPurge;
            for (const site of userSites) {
              const siteDir = path.join(uploadDir, "hosted", site.id);
              if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });
            }
            // Delete user upload folder
            const userDir = path.join(uploadDir, "users", user.id);
            if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
          } catch(fsErr) { console.error(`[PURGE] File cleanup failed for ${user.id}:`, fsErr.message); }

        } catch(e) {
          console.error(`[PURGE] Failed to purge ${user.email}:`, e.message);
        }
      }
    } catch(e) { console.error("[PURGE] Cron error:", e.message); }
  }, 24 * 60 * 60 * 1000); // daily

  // ── Hourly auto-sync for connected integrations (Mailchimp + Shopify) ──
  // Fetches new/updated records since last sync and writes them to user's
  // contacts / orders tables. Lease TTL = 50 min to avoid double-runs but
  // recover quickly if leader dies mid-tick.
  setInterval(async () => {
    try {
      if (!cronOwn("integrations_auto_sync", 50 * 60 * 1000)) return;
      const { runAutoSync } = require("./sync/auto-sync");
      await runAutoSync(getDb());
    } catch(e) { console.error("[auto-sync] Cron error:", e.message); }
  }, 60 * 60 * 1000); // hourly

  // ── MINE Intelligence — generate insights for all users nightly at 3am, email at 8am ──
  setInterval(async () => {
    try {
      const now = new Date();
      const hour = now.getHours();

      // 3am: generate insights for all active users
      if (hour === 3) {
        const { generateInsightsForUser, ensureIntelligenceTables } = require("./routes/ai-agent");
        const getSetting = (k) => { try { return db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } };
        const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return;

        ensureIntelligenceTables(db);
        const today = now.toISOString().slice(0, 10);
        const users = db.prepare("SELECT id FROM users WHERE role = 'user' AND created_at <= datetime('now', '-1 day')").all();

        for (const { id: userId } of users) {
          try {
            // Skip if already generated today
            const existing = db.prepare("SELECT id FROM intelligence_insights WHERE user_id = ? AND date = ?").get(userId, today);
            if (existing) continue;

            const insights = await generateInsightsForUser(db, userId, apiKey);
            if (insights && insights.length > 0) {
              const { v4: uuid } = require("uuid");
              db.prepare("INSERT INTO intelligence_insights (id, user_id, date, insights) VALUES (?,?,?,?)")
                .run(uuid(), userId, today, JSON.stringify(insights));
            }
            // Small delay to avoid rate limits
            await new Promise(r => setTimeout(r, 1500));
          } catch (e) { console.error(`[Intelligence] Failed for user ${userId}:`, e.message); }
        }

      }

      // 8am: send morning email + push notification with today's insights
      if (hour === 8) {
        const today = now.toISOString().slice(0, 10);

        // Initialise web-push with VAPID keys (only if configured)
        let webpush = null;
        const vapidPublic = process.env.VAPID_PUBLIC_KEY;
        const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
        const vapidEmail = process.env.VAPID_EMAIL || "mailto:hello@takeova.ai";
        if (vapidPublic && vapidPrivate) {
          try {
            webpush = require("web-push");
            webpush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate);
          } catch (e) {

            webpush = null;
          }
        }

        const pending = db.prepare(`
          SELECT ii.*, u.name, u.email
          FROM intelligence_insights ii
          JOIN users u ON ii.user_id = u.id
          WHERE ii.date = ? AND ii.email_sent = 0
        `).all(today);

        for (const row of pending) {
          try {
            const insights = JSON.parse(row.insights || "[]");
            if (insights.length === 0) continue;

            const firstName = row.name?.split(" ")[0] || "there";
            const topInsight = insights[0];

            // ── Send email ──
            const insightRows = insights.map((ins) => `
              <div style="background:#F8F7FF;border-left:4px solid #635BFF;border-radius:8px;padding:16px;margin-bottom:12px;">
                <div style="font-size:18px;margin-bottom:6px;">${ins.icon} <strong>${ins.headline}</strong></div>
                <div style="font-size:13px;color:#475569;line-height:1.6;margin-bottom:8px;">${ins.detail}</div>
                <div style="font-size:12px;font-weight:700;color:#16A34A;">💰 ${ins.impact}</div>
              </div>
            `).join("");

            const { autoEmail } = require("./routes/features");
            await autoEmail(row.user_id, row.email,
              `🧠 Your TAKEOVA Intelligence briefing for ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`,
              `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:24px;">
                <div style="text-align:center;margin-bottom:24px;">
                  <div style="font-size:32px;margin-bottom:8px;">🧠</div>
                  <h1 style="font-size:22px;font-weight:800;margin:0 0 6px;">Good morning, ${firstName}.</h1>
                  <p style="color:#64748B;font-size:14px;margin:0;">Here's what needs your attention today.</p>
                </div>
                ${insightRows}
                <div style="text-align:center;margin-top:24px;">
                  <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}?tab=intelligence" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#635BFF,#4F46E5);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;">View Full Briefing →</a>
                </div>
                <p style="text-align:center;color:#94A3B8;font-size:11px;margin-top:20px;">MINE Intelligence · <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}?tab=settings" style="color:#94A3B8;">Manage notifications</a></p>
              </div>`
            );

            // ── Send push notifications ──
            const allSubs = db.prepare("SELECT subscription, type FROM push_subscriptions WHERE user_id = ?").all(row.user_id);
            const webSubs = allSubs.filter(s => s.type === 'web');
            const expoSubs = allSubs.filter(s => s.type === 'expo');

            // Web push (browsers / PWA)
            if (webpush && webSubs.length > 0) {
              const pushPayload = JSON.stringify({
                title: `🧠 Good morning, ${firstName}`,
                body: `${topInsight.icon} ${topInsight.headline} · ${topInsight.impact}`,
                icon: "/icon-192.png",
                badge: "/badge-72.png",
                url: `${process.env.FRONTEND_URL || "https://takeova.ai"}?tab=intelligence`,
                tag: "mine-intelligence",
                data: { tab: "intelligence" }
              });
              for (const { subscription } of webSubs) {
                try {
                  await webpush.sendNotification(JSON.parse(subscription), pushPayload);
                } catch (pushErr) {
                  if (pushErr.statusCode === 410) {
                    db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND subscription = ?")
                      .run(row.user_id, subscription);
                  } else {
                    console.error(`[Intelligence] Web push failed for user ${row.user_id}:`, pushErr.message);
                  }
                }
              }
            }

            // Expo push (iOS / Android native app)
            if (expoSubs.length > 0) {
              try {
                const expoMessages = expoSubs.map(({ subscription }) => ({
                  to: subscription,
                  title: `🧠 Good morning, ${firstName}`,
                  body: `${topInsight.icon} ${topInsight.headline} · ${topInsight.impact}`,
                  sound: "default",
                  badge: 1,
                  channelId: "mine-intelligence",
                  data: { tab: "intelligence", type: "intelligence" }
                }));
                const expoResp = await fetch("https://exp.host/--/api/v2/push/send", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Accept": "application/json" },
                  body: JSON.stringify(expoMessages)
                });
                const expoData = await expoResp.json();
                // Clean up invalid tokens
                if (expoData.data) {
                  const results = Array.isArray(expoData.data) ? expoData.data : [expoData.data];
                  results.forEach((result, i) => {
                    if (result.status === "error" && (result.details?.error === "DeviceNotRegistered" || result.details?.error === "InvalidCredentials")) {
                      const badToken = expoSubs[i]?.subscription;
                      if (badToken) db.prepare("DELETE FROM push_subscriptions WHERE subscription = ?").run(badToken);
                    }
                  });
                }
              } catch (expoErr) {
                console.error(`[Intelligence] Expo push failed for user ${row.user_id}:`, expoErr.message);
              }
            }

            db.prepare("UPDATE intelligence_insights SET email_sent = 1, push_sent = 1 WHERE id = ?").run(row.id);
          } catch (e) { console.error(`[Intelligence] Delivery failed for ${row.email}:`, e.message); }
        }

      }
    } catch (e) { console.error("[Intelligence] Cron error:", e.message); }
  }, 60 * 60 * 1000); // Check every hour

  // ── SMS Appointment Reminders — every 15 minutes ────────────────────────
  setInterval(async () => {
    try {
      const { sendAppointmentReminders, ensureTables: smsEnsure } = require("./routes/sms");
      smsEnsure(db);
      await sendAppointmentReminders(db);
    } catch(e) { console.error("[SMS Reminders] Interval error:", e.message); }
  }, 15 * 60 * 1000); // Every 15 minutes

  // ── SMS Cart Abandonment — every 10 minutes ────────────────────────────
  setInterval(async () => {
    try {
      const { sendCartAbandonmentSMS, ensureTables: smsEnsure2 } = require("./routes/sms");
      smsEnsure2(db);
      await sendCartAbandonmentSMS(db);
    } catch(e) { console.error("[SMS Cart] Interval error:", e.message); }
  }, 10 * 60 * 1000); // Every 10 minutes

  // ── SMS Sequence Step Runner — every 5 minutes ─────────────────────────
  setInterval(async () => {
    try {
      const { ensureTables: smsEnsure3 } = require("./routes/sms");
      smsEnsure3(db);
      // Find enrollments where next step is due
      const enrollments = db.prepare(`
        SELECT e.*, s.steps FROM sms_sequence_enrollments e
        JOIN sms_sequences s ON e.sequence_id = s.id
        WHERE e.status = 'active' AND e.completed_at IS NULL
      `).all();
      for (const enr of enrollments) {
        try {
          const steps = JSON.parse(enr.steps || "[]");
          const nextStep = enr.current_step;
          if (nextStep >= steps.length) {
            db.prepare("UPDATE sms_sequence_enrollments SET status='completed', completed_at=datetime('now') WHERE id=?").run(enr.id);
            continue;
          }
          const step = steps[nextStep];
          const enrolledAt = new Date(enr.enrolled_at).getTime();
          const dueAt = enrolledAt + (step.delay_hours || 0) * 3600000;
          if (Date.now() < dueAt) continue; // Not yet due
          // Check opt-out
          const optout = (() => { try { return db.prepare("SELECT 1 FROM sms_optouts WHERE phone=? AND user_id=?").get(enr.contact_phone, enr.user_id); } catch(e) { return null; } })();
          if (optout) {
            db.prepare("UPDATE sms_sequence_enrollments SET status='cancelled' WHERE id=?").run(enr.id);
            continue;
          }
          // Send the step
          const { default: fetch } = await import("node-fetch");
          const accountSid = (() => { try { return db.prepare("SELECT value FROM platform_settings WHERE key='TWILIO_ACCOUNT_SID'").get()?.value || process.env.TWILIO_ACCOUNT_SID; } catch(e) { return process.env.TWILIO_ACCOUNT_SID; } })();
          const authToken  = (() => { try { return db.prepare("SELECT value FROM platform_settings WHERE key='TWILIO_AUTH_TOKEN'").get()?.value || process.env.TWILIO_AUTH_TOKEN; } catch(e) { return process.env.TWILIO_AUTH_TOKEN; } })();
          const fromNum    = (() => { try { return db.prepare("SELECT value FROM platform_settings WHERE key='TWILIO_PHONE_NUMBER'").get()?.value || process.env.TWILIO_PHONE_NUMBER; } catch(e) { return process.env.TWILIO_PHONE_NUMBER; } })();
          if (!accountSid || !authToken || !fromNum) continue;
          const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
            method: "POST",
            headers: { Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ To: enr.contact_phone, From: fromNum, Body: step.message.slice(0, 1600) }).toString(),
          });
          const rd = await r.json();
          if (rd.sid) {
            db.prepare("UPDATE sms_sequence_enrollments SET current_step=current_step+1 WHERE id=?").run(enr.id);
            // Meter the sequence send — within cap = free, over cap = $0.02 overage
            try { if (global.mineTrackUsage) global.mineTrackUsage(db, enr.user_id, "smsSequenceSends"); } catch(e) {}
            // Log to inbox
            try { db.prepare("INSERT INTO sms_inbox (id,user_id,contact_phone,contact_name,direction,body,twilio_sid,created_at) VALUES(?,?,?,?,'outbound',?,?,datetime('now'))").run(require("uuid").v4(), enr.user_id, enr.contact_phone, enr.contact_name, step.message, rd.sid); } catch(e) {}
          }
        } catch(e) { console.error("[SMS Seq] Step error:", e.message); }
      }
    } catch(e) { console.error("[SMS Seq] Cron error:", e.message); }
  }, 5 * 60 * 1000); // Every 5 minutes

  // ── SMS Purge tables entry ─────────────────────────────────────────────

  // ── Growth Agent — runs nightly at 4am for all subscribed users ──────────
  setInterval(async () => {
    try {
      const now = new Date();
      if (now.getHours() !== 4) return;
      const { runAgentForUser, ensureTables } = require("./routes/growth-agent");
      ensureTables(db);
      const users = db.prepare("SELECT user_id FROM growth_agent_config WHERE enabled = 1").all();

      for (const u of users) {
        try { await runAgentForUser(u.user_id, db); }
        catch(e) { console.error(`[GrowthAgent] Failed for ${u.user_id}:`, e.message); }
      }
    } catch(e) { console.error("[GrowthAgent] Cron error:", e.message); }
  }, 60 * 60 * 1000); // Growth Agent — checks hourly, runs at 4am

  // ── Session cleanup — weekly, removes expired sessions ───────────────────
  setInterval(() => {
    try {
      const db = getDb();
      const { changes } = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now', '-1 day')").run();
      if (changes > 0) console.log(`[Cleanup] Purged ${changes} expired sessions`);
    } catch(e) { console.error("[Cleanup] Session cleanup error:", e.message); }
  }, 7 * 24 * 60 * 60 * 1000); // Every 7 days


  // ── Cart Recovery SMS — fires 30 minutes after abandonment (before email) ──
  setInterval(async () => {
    try {
      const { sendSMS, ensureSMSTables } = require("./routes/sms");
      ensureSMSTables(db);
      // Find carts abandoned 28-35 mins ago with a phone number, SMS not yet sent
      const carts = db.prepare(`
        SELECT * FROM abandoned_carts
        WHERE recovered = 0 AND reminder_count = 0
        AND customer_email IS NOT NULL
        AND created_at <= datetime('now', '-28 minutes')
        AND created_at >= datetime('now', '-35 minutes')
        LIMIT 20
      `).all();
      for (const cart of carts) {
        try {
          // Find contact phone
          const contact = db.prepare("SELECT phone FROM contacts WHERE user_id = ? AND email = ? AND phone IS NOT NULL").get(cart.user_id||cart.site_id, cart.customer_email);
          if (!contact?.phone) continue;
          const items = JSON.parse(cart.items || "[]");
          const itemList = items.slice(0,2).map(i=>i.name||i.title||"item").join(" & ");
          const total = parseFloat(cart.cart_total||0).toFixed(2);
          const msg = `Hi! You left ${itemList} (total $${total}) in your cart. Complete your order here: ${process.env.FRONTEND_URL||"https://takeova.ai"}/cart`;
          await sendSMS(cart.user_id||cart.site_id, contact.phone, msg, db);
          db.prepare("UPDATE abandoned_carts SET reminder_count = reminder_count + 1 WHERE id = ?").run(cart.id);
        } catch(e) { console.error("[Cart SMS]", e.message); }
      }
    } catch(e) { console.error("[Cart SMS Cron]", e.message); }
  }, 5 * 60 * 1000); // Every 5 minutes

  // ── Appointment SMS sequences ─────────────────────────────────────────────
  setInterval(async () => {
    try {
      const { sendSMS, ensureSMSTables, mergeTemplate } = require("./routes/sms");
      ensureSMSTables(db);
      const reminders = db.prepare(`
        SELECT br.*, u.id as owner_id
        FROM booking_reminders br
        JOIN users u ON br.user_id = u.id
        WHERE br.status = 'pending'
        AND br.type IN ('confirmation_sms','24h_sms','1h_sms','review_sms')
        AND datetime(br.reminder_time) <= datetime('now')
        LIMIT 30
      `).all();

      for (const r of reminders) {
        try {
          if (!r.customer_phone) { db.prepare("UPDATE booking_reminders SET status='skipped' WHERE id=?").run(r.id); continue; }
          const cfg = db.prepare("SELECT * FROM sms_appointment_config WHERE user_id=?").get(r.user_id) || {};
          const shouldSend = (r.type==="confirmation_sms" && cfg.send_confirmation!==0)
            || (r.type==="24h_sms" && cfg.send_24h!==0)
            || (r.type==="1h_sms" && cfg.send_1h!==0)
            || (r.type==="review_sms" && cfg.send_review_request!==0);
          if (!shouldSend) { db.prepare("UPDATE booking_reminders SET status='skipped' WHERE id=?").run(r.id); continue; }

          // Get booking details for template vars
          const booking = db.prepare("SELECT date, time FROM bookings WHERE id=?").get(r.booking_id) || {};
          const site = db.prepare("SELECT id FROM sites WHERE user_id=? LIMIT 1").get(r.user_id);
          const reviewUrl = site ? `${process.env.FRONTEND_URL||"https://takeova.ai"}/${site.id}/reviews` : "";
          const vars = { name: r.customer_name||"there", service: r.service||"appointment", date: booking.date||"", time: booking.time||"", review_url: reviewUrl };

          let template = cfg.confirmation_msg || r.type === "24h_sms" ? cfg.reminder_24h_msg : r.type === "1h_sms" ? cfg.reminder_1h_msg : cfg.review_msg;
          if (r.type==="confirmation_sms") template = cfg.confirmation_msg || "Hi {name}, your {service} is confirmed for {date} at {time}.";
          if (r.type==="24h_sms") template = cfg.reminder_24h_msg || "Reminder: {service} tomorrow at {time}.";
          if (r.type==="1h_sms") template = cfg.reminder_1h_msg || "Your {service} is in 1 hour at {time}.";
          if (r.type==="review_sms") template = cfg.review_msg || "Thanks for your visit! Leave a review: {review_url}";

          const body = mergeTemplate(template, vars);
          // Respect SMS opt-outs (TCPA compliance)
          try {
            db.exec("CREATE TABLE IF NOT EXISTS sms_optouts (phone TEXT, user_id TEXT, opted_out_at TEXT, PRIMARY KEY(phone,user_id))");
            const isOptedOut = db.prepare("SELECT 1 FROM sms_optouts WHERE phone=? AND user_id=?").get(r.customer_phone, r.user_id);
            if (isOptedOut) { db.prepare("UPDATE booking_reminders SET status='skipped' WHERE id=?").run(r.id); continue; }
          } catch(e) {}
          await sendSMS(r.user_id, r.customer_phone, body, db);
          db.prepare("UPDATE booking_reminders SET status='sent' WHERE id=?").run(r.id);
        } catch(e) { db.prepare("UPDATE booking_reminders SET status='failed' WHERE id=?").run(r.id); }
      }
    } catch(e) { console.error("[Appt SMS Cron]", e.message); }
  }, 60 * 1000); // Every minute


  // ── DAILY REMINDERS CRON (runs every 6 hours) ──────────────────────────────
  let _dailyCronRunning = false;
  setInterval(async () => {
    if (_dailyCronRunning) { console.log('[DailyCron] Skipping — previous run still active'); return; }
    _dailyCronRunning = true;
    try {
      const db = getDb();
      const today = new Date().toISOString().split('T')[0];
      const inDays = n => { const d=new Date(); d.setDate(d.getDate()+n); return d.toISOString().split('T')[0]; };

      // 0. REVENUE & CONTACT MILESTONES — check all active users
      try {
        const { checkRevenueMilestones } = require('./routes/intelligence');
        const activeUsers = db.prepare("SELECT id FROM users WHERE account_status='active' AND plan IS NOT NULL LIMIT 200").all();
        for (const u of activeUsers) {
          try { checkRevenueMilestones(db, u.id); } catch(e) {}
        }
      } catch(e) { console.error('[MilestoneCron]', e.message); }

      // 1. PET SERVICE REMINDERS — SMS owner day before appointment
      try {
        const petAppts = db.prepare(`SELECT pa.*, c.name as owner_name, c.phone as owner_phone, pp.name as pet_name
          FROM pet_appointments pa
          LEFT JOIN contacts c ON c.id=pa.owner_id
          LEFT JOIN pet_profiles pp ON pp.id=pa.pet_id
          WHERE pa.appointment_date=? AND pa.reminder_sent IS NULL AND c.phone IS NOT NULL`)
          .all(inDays(1));
        for (const appt of petAppts) {
          const msg = `Hi ${appt.owner_name||'there'}, reminder: ${appt.pet_name||'your pet'}'s ${appt.service_type||'appointment'} is tomorrow${appt.appointment_time ? ' at '+appt.appointment_time : ''}. See you then!`;
          await sendSMS(appt.user_id, appt.owner_phone, msg, db);
          db.prepare("UPDATE pet_appointments SET reminder_sent=datetime('now') WHERE id=?").run(appt.id);

        }
      } catch(e) { console.error('[PetCron]', e.message); }

      // 2. VEHICLE WOF / SERVICE DUE — SMS owner 7 days before
      try {
        const vehDue = db.prepare(`SELECT vs.*, v.make, v.model, v.rego, c.name as owner_name, c.phone as owner_phone
          FROM vehicle_services vs
          JOIN vehicle_profiles v ON v.id=vs.vehicle_id
          LEFT JOIN contacts c ON c.id=v.contact_id
          WHERE vs.next_service_date=? AND vs.reminder_sent IS NULL AND c.phone IS NOT NULL AND v.active=1`)
          .all(inDays(7));
        for (const vs of vehDue) {
          const msg = `Hi ${vs.owner_name||'there'}, your ${vs.make||''} ${vs.model||''} ${vs.rego ? '('+vs.rego+')' : ''} is due for service on ${vs.next_service_date}. Call us to book in.`;
          await sendSMS(vs.user_id, vs.owner_phone, msg, db);
          db.prepare("UPDATE vehicle_services SET reminder_sent=datetime('now') WHERE id=?").run(vs.id);

        }
      } catch(e) { console.error('[VehCron]', e.message); }

      // 3. OCCASION REMINDERS — email/SMS owner X days before occasion
      try {
        const reminders = db.prepare(`SELECT o.*, c.name as cname, c.email as cemail, c.phone as cphone,
          u.email as owner_email
          FROM occasion_reminders o
          LEFT JOIN contacts c ON c.id=o.contact_id
          LEFT JOIN users u ON u.id=o.user_id
          WHERE o.last_reminded IS NULL OR date(o.last_reminded) < date('now','-300 days')`)
          .all();
        for (const r of reminders) {
          const [,mm,dd] = r.occasion_date.split('-');
          const now = new Date();
          const occThis = new Date(`${now.getFullYear()}-${mm}-${dd}`);
          if (occThis < now) occThis.setFullYear(now.getFullYear()+1);
          const daysAway = Math.ceil((occThis - now) / 86400000);
          if (daysAway !== (r.reminder_days||14)) continue;
          // Notify business owner
          if (r.owner_email) {
            const sgKey = getSetting('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
            if (sgKey) {
              const fetch = (...a) => import('node-fetch').then(({default:f})=>f(...a));
              await fetch('https://api.sendgrid.com/v3/mail/send', {
                method:'POST', headers:{'Authorization':'Bearer '+sgKey,'Content-Type':'application/json'},
                body: JSON.stringify({ personalizations:[{to:[{email:r.owner_email}]}], from:{email:'noreply@takeova.ai',name:'MINE'}, subject:`🎂 ${r.cname}'s ${r.occasion_type} in ${daysAway} days`,
                  content:[{type:'text/html',value:`<p>Just a heads up — <strong>${r.cname}</strong> has a <strong>${r.occasion_type}</strong> in ${daysAway} days (${r.occasion_date}).</p><p>Now's a great time to reach out with a personalised offer.</p>`}]})
              });
            }
          }
          // Auto-SMS customer if enabled
          if (r.auto_sms && r.cphone) {
            const msg = `Hi ${r.cname||'there'}, hope you have a wonderful ${r.occasion_type} coming up! 🎉 We'd love to help make it special.`;
            await sendSMS(r.user_id, r.cphone, msg, db);
          }
          db.prepare("UPDATE occasion_reminders SET last_reminded=datetime('now') WHERE id=?").run(r.id);
        }
      } catch(e) { console.error('[OccasionCron]', e.message); }

      // 4. RETAINER AUTO-INVOICING — invoice on billing day each month
      try {
        const dayOfMonth = new Date().getDate();
        const retainers = db.prepare(`SELECT r.*, c.email as client_email FROM support_retainers r
          LEFT JOIN contacts c ON c.id=r.contact_id
          WHERE r.active=1 AND r.auto_invoice=1 AND r.billing_day=?`).all(dayOfMonth);
        for (const ret of retainers) {
          // Check if already invoiced this month
          const now = new Date();
          const monthStartStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01 00:00:00`;
          const existing = db.prepare("SELECT id FROM invoices WHERE user_id=? AND client_name=? AND created_at>=? AND invoice_number LIKE 'RET-%'")
            .get(ret.user_id, ret.client_name, monthStartStr);
          if (existing) continue;
          const invId = require('crypto').randomUUID();
          const invNum = `RET-${Date.now().toString().slice(-6)}`;
          const dueDate = new Date(); dueDate.setDate(dueDate.getDate()+14);
          const items = JSON.stringify([{description:`${ret.plan_name} — monthly retainer (${ret.hours_included}h included)`,amount:ret.price_per_month}]);
          db.prepare("INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,items_json,subtotal,tax,total,status,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(invId, ret.user_id, invNum, ret.client_name, ret.client_email||'', items, ret.price_per_month, 0, ret.price_per_month, 'sent', dueDate.toISOString().split('T')[0]);
          // Reset hours_used for new month
          db.prepare("UPDATE support_retainers SET hours_used=0 WHERE id=?").run(ret.id);

        }
      } catch(e) { console.error('[RetainerCron]', e.message); }

      // 5. CHILDCARE — mark absentees and notify parents via WhatsApp if not checked in by 10am
      try {
        const hour = new Date().getHours();
        if (hour >= 10 && hour <= 11) {
          const notCheckedIn = db.prepare(`SELECT ch.*, ca.status, c.phone as parent_phone, c.name as parent_name
            FROM child_profiles ch
            LEFT JOIN child_attendance ca ON ca.child_id=ch.id AND ca.date=?
            LEFT JOIN contacts c ON c.id=ch.parent_id
            WHERE ch.active=1 AND (ca.status IS NULL OR ca.status='present') AND ca.check_in_time IS NULL`)
            .all(today);
          for (const child of notCheckedIn) {
            // Only notify if parent has phone and child is enrolled today
            const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            const todayDay = dayNames[new Date().getDay()];
            const enrolled = JSON.parse(child.enrolment_days||'[]');
            if (!enrolled.includes(todayDay)) continue;
            if (child.parent_phone) {
              await sendSMS(child.user_id, child.parent_phone, `Hi ${child.parent_name||'there'}, we haven't seen ${child.name} arrive yet today. Is everything okay? Please let us know if they won't be in.`, db);
            }
          }
        }
      } catch(e) { console.error('[ChildcareCron]', e.message); }


      // 6. WIN-BACK — personalised SMS to customers inactive 30+ days
      try {
        const { personaliseMessage } = require('./utils/personalise');
        const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate()-14);
        const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate()-30);
        const sixtyDaysAgo = new Date(); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate()-60);

        // Find users who have SMS enabled and have contacts inactive 30-60 days
        const smsUsers = db.prepare(`SELECT DISTINCT u.id, u.name, s.name as biz_name, u.plan
          FROM users u JOIN sites s ON s.user_id=u.id
          WHERE u.plan IN ('growth','pro','enterprise') AND u.account_status='active'
          LIMIT 50`).all();

        for (const usr of smsUsers) {
          try {
            // Find contacts inactive 30-60 days with phone who haven't been texted recently
            const lapsedContacts = db.prepare(`
              SELECT c.*,
                MAX(o.created_at) as last_purchase,
                COUNT(o.id) as order_count,
                CAST(julianday('now') - julianday(MAX(COALESCE(c.last_contacted, c.created_at))) AS INTEGER) as days_inactive
              FROM contacts c
              LEFT JOIN orders o ON o.user_id=c.user_id AND (o.customer_name=c.name OR o.customer_email=c.email)
              WHERE c.user_id=? AND c.phone IS NOT NULL
                AND c.status != 'unsubscribed'
                AND (c.last_contacted IS NULL OR c.last_contacted < ?)
                AND c.created_at < ?
              GROUP BY c.id
              HAVING days_inactive BETWEEN 30 AND 60
              ORDER BY order_count DESC
              LIMIT 5`).all(usr.id, twoWeeksAgo.toISOString(), thirtyDaysAgo.toISOString());

            for (const contact of lapsedContacts) {
              try {
                const msg = await personaliseMessage({
                  scenario: 'winback',
                  customer: {
                    name: contact.name,
                    last_purchase: contact.last_purchase ? new Date(contact.last_purchase).toLocaleDateString() : null,
                    weeks_inactive: Math.round((contact.days_inactive||30)/7),
                    visit_count: contact.order_count || 0,
                  },
                  business: { name: usr.biz_name || usr.name, type: 'service' },
                  channel: 'sms',
                  tone: 'friendly',
                });

                if (msg.body) {
                  await sendSMS(usr.id, contact.phone, msg.body, db);
                  db.prepare("UPDATE contacts SET last_contacted=datetime('now') WHERE id=?").run(contact.id);

                }
              } catch(e) { console.error('[WinBackCron] Contact error:', e.message); }
              await new Promise(r => setTimeout(r, 1000)); // 1s between sends
            }
          } catch(e) { console.error('[WinBackCron] User error:', e.message); }
        }
      } catch(e) { console.error('[WinBackCron]', e.message); }

      // 7. REVIEW REQUESTS — full reputation management system
      try {
        // Trigger the reputation management endpoint internally
        const reviewsRouter = require('./routes/reviews');
        // Process pending review requests via the reputation system
        // This handles both bookings and orders based on each user's config
        const pendingOrders = db.prepare(`
          SELECT o.id, o.customer_email, o.customer_name, o.customer_phone,
                 s.user_id, rc.delay_hours, rc.enabled, rc.trigger_type
          FROM orders o
          JOIN sites s ON o.site_id = s.id
          JOIN review_request_config rc ON rc.user_id = s.user_id
          WHERE rc.enabled = 1
            AND (rc.trigger_type = 'orders' OR rc.trigger_type = 'both')
            AND o.status IN ('paid','fulfilled','completed')
            AND o.customer_email IS NOT NULL
            AND datetime(o.created_at, '+' || rc.delay_hours || ' hours') <= datetime('now')
            AND NOT EXISTS (
              SELECT 1 FROM review_requests rr
              WHERE rr.user_id = s.user_id
                AND rr.customer_email = o.customer_email
                AND rr.created_at > datetime('now','-30 days')
            )
          LIMIT 50
        `).all();

        const pendingBookings = db.prepare(`
          SELECT b.id, b.customer_email, b.customer_name, b.customer_phone,
                 b.user_id, rc.delay_hours, rc.enabled, rc.trigger_type
          FROM bookings b
          JOIN review_request_config rc ON rc.user_id = b.user_id
          WHERE rc.enabled = 1
            AND (rc.trigger_type = 'bookings' OR rc.trigger_type = 'both')
            AND b.status IN ('completed','attended')
            AND b.customer_email IS NOT NULL
            AND datetime(b.start_time, '+' || rc.delay_hours || ' hours') <= datetime('now')
            AND NOT EXISTS (
              SELECT 1 FROM review_requests rr
              WHERE rr.user_id = b.user_id
                AND rr.customer_email = b.customer_email
                AND rr.created_at > datetime('now','-30 days')
            )
          LIMIT 50
        `).all();

        const allPending = [
          ...pendingOrders.map(o => ({ ...o, source: 'order', order_id: o.id })),
          ...pendingBookings.map(b => ({ ...b, source: 'booking', booking_id: b.id }))
        ];

        let reviewsSent = 0;
        const crypto = require('crypto');
        const { getSetting } = require('./db/init');

        for (const item of allPending) {
          try {
            const config = db.prepare('SELECT * FROM review_request_config WHERE user_id=?').get(item.user_id);
            if (!config) continue;

            const token = crypto.randomBytes(24).toString('hex');
            const reqId = crypto.randomUUID();
            const user = db.prepare('SELECT * FROM users WHERE id=?').get(item.user_id);
            const firstName = item.customer_name ? item.customer_name.split(' ')[0] : 'there';
            const businessName = user?.business_name || user?.name || 'us';
            const reviewLink = `${process.env.APP_URL || process.env.FRONTEND_URL || 'https://takeova.ai'}/review/${token}`;
            const platforms = JSON.parse(config.platforms || '["google","site"]');

            let sent = false;

            // Send email
            if (config.email_enabled !== 0 && item.customer_email) {
              try {
                const sgMail = require('@sendgrid/mail');
                sgMail.setApiKey(process.env.SENDGRID_API_KEY || getSetting('SENDGRID_API_KEY'));
                const subject = (config.email_subject || 'How was your experience? 🌟').replace('{{name}}', firstName);
                const platformButtons = platforms.map(p => {
                  const map = { google: { label: '⭐ Review on Google', color: '#4285F4' }, facebook: { label: '👍 Review on Facebook', color: '#1877F2' }, site: { label: '🌟 Leave a Review', color: '#2563EB' } };
                  const info = map[p] || { label: '🌟 Leave a Review', color: '#2563EB' };
                  return `<a href="${reviewLink}?platform=${p}" style="display:inline-block;background:${info.color};color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;margin:6px">${info.label}</a>`;
                }).join('');
                await sgMail.send({
                  to: item.customer_email,
                  from: { name: businessName, email: process.env.SENDGRID_FROM_EMAIL || getSetting('EMAIL_FROM') || 'noreply@takeova.ai' },
                  subject,
                  html: `<div style="font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#0F172A"><div style="text-align:center;margin-bottom:28px"><div style="font-size:48px;margin-bottom:12px">⭐</div><h1 style="font-size:24px;font-weight:800;margin:0 0 8px">How did we do, ${firstName}?</h1><p style="font-size:15px;color:#64748B;margin:0">Your feedback helps ${businessName} improve and helps others find us.</p></div><div style="background:#F8FAFC;border-radius:16px;padding:28px;text-align:center;margin-bottom:24px"><p style="font-size:15px;color:#374151;margin:0 0 20px">It only takes 30 seconds 🙏</p>${platformButtons}</div><p style="font-size:12px;color:#94A3B8;text-align:center">You're receiving this because you recently visited ${businessName}.</p></div>`
                });
                sent = true;
              } catch(emailErr) { console.warn('[ReviewCron email]', emailErr.message); }
            }

            // Send SMS if configured
            if (config.sms_enabled && item.customer_phone) {
              try {
                const twilio = require('twilio')(
                  process.env.TWILIO_ACCOUNT_SID || getSetting('TWILIO_ACCOUNT_SID'),
                  process.env.TWILIO_AUTH_TOKEN || getSetting('TWILIO_AUTH_TOKEN')
                );
                const smsBody = (config.sms_message || 'Hi {{name}}! How was your experience at {{business}}? Leave us a review: {{link}}')
                  .replace(/\{\{name\}\}/g, firstName).replace(/\{\{link\}\}/g, reviewLink).replace(/\{\{business\}\}/g, businessName);
                await twilio.messages.create({ body: smsBody, from: process.env.TWILIO_FROM || getSetting('TWILIO_FROM'), to: item.customer_phone });
                sent = true;
              } catch(smsErr) { console.warn('[ReviewCron SMS]', smsErr.message); }
            }

            // Save record
            db.prepare(`INSERT OR IGNORE INTO review_requests
              (id, user_id, customer_email, customer_name, customer_phone, order_id, booking_id, trigger_type, status, sent_at, review_token, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?,datetime('now'))`)
              .run(reqId, item.user_id, item.customer_email, item.customer_name || null,
                   item.customer_phone || null, item.order_id || null, item.booking_id || null,
                   'auto_' + item.source, sent ? 'sent' : 'failed', token);

            if (sent) reviewsSent++;
          } catch(e) { console.error('[ReviewCron item]', e.message); }
        }

        // Send reminders for unopened requests
        if (pendingOrders.length || pendingBookings.length) {
          const reminders = db.prepare(`
            SELECT rr.*, rc.reminder_hours, rc.reminder_enabled, rc.sms_enabled, rc.sms_message
            FROM review_requests rr
            JOIN review_request_config rc ON rc.user_id = rr.user_id
            WHERE rr.status = 'sent'
              AND rr.reviewed_at IS NULL
              AND rr.reminder_sent_at IS NULL
              AND rc.reminder_enabled = 1
              AND datetime(rr.sent_at, '+' || rc.reminder_hours || ' hours') <= datetime('now')
            LIMIT 30
          `).all();

          for (const rem of reminders) {
            try {
              db.prepare("UPDATE review_requests SET reminder_sent_at=datetime('now') WHERE id=?").run(rem.id);
              // Send reminder email (simplified)
            } catch(e) {}
          }
        }

        if (reviewsSent > 0) console.log(`[ReviewCron] Sent ${reviewsSent} review requests`);
      } catch(e) { console.error('[ReviewCron]', e.message); }

      // 8. PENDING VIDEO TASKS — poll Arcads/Runway for completed video ads
      try {
        const pendingTasks = db.prepare(`
          SELECT pt.*, ac.campaign_id as camp_id
          FROM pending_video_tasks pt
          LEFT JOIN ad_creatives ac ON ac.id = pt.creative_id
          WHERE pt.status = 'pending' AND pt.attempts < 20
          LIMIT 10
        `).all();

        const fetch = (await import('node-fetch')).default;
        const { getSetting } = require('./db/init');

        for (const task of pendingTasks) {
          try {
            db.prepare("UPDATE pending_video_tasks SET attempts = attempts + 1 WHERE id = ?").run(task.id);

            let videoUrl = null;
            let done = false;

            if (task.provider === 'heygen') {
              const heygenKey = getSetting('HEYGEN_API_KEY') || process.env.HEYGEN_API_KEY;
              if (!heygenKey) continue;
              const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${task.task_id}`, {
                headers: { 'X-Api-Key': heygenKey }
              });
              const d = await r.json();
              const status = d.data?.status || d.status;
              const url = d.data?.video_url || d.video_url;
              if (status === 'completed' && url) { videoUrl = url; done = true; }
              else if (status === 'failed') { done = true; }
            } else if (task.provider === 'arcads') {
              // Arcads deprecated — mark as failed so pending tasks clear out
              done = true;
            } else if (task.provider === 'runway') {
              const runwayKey = getSetting('RUNWAY_API_KEY') || process.env.RUNWAY_API_KEY;
              if (!runwayKey) continue;
              const r = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task.task_id}`, {
                headers: { Authorization: `Bearer ${runwayKey}`, 'X-Runway-Version': '2024-11-06' }
              });
              const d = await r.json();
              if (d.status === 'SUCCEEDED' && d.output?.[0]) { videoUrl = d.output[0]; done = true; }
              else if (d.status === 'FAILED') { done = true; }
            }

            if (done) {
              db.prepare("UPDATE pending_video_tasks SET status = ? WHERE id = ?")
                .run(videoUrl ? 'completed' : 'failed', task.id);

              if (videoUrl && task.creative_id) {
                // Attach video URL to the ad creative and mark it active
                db.prepare("UPDATE ad_creatives SET video_url = ?, status = 'active' WHERE id = ?")
                  .run(videoUrl, task.creative_id);

                // Notify the business owner
                const owner = db.prepare("SELECT email, business_name, name FROM users WHERE id = ?").get(task.user_id);
                if (owner?.email) {
                  const campaign = db.prepare("SELECT name, platform FROM ad_campaigns WHERE id = ?").get(task.campaign_id);
                  const bizName = owner.business_name || owner.name || 'your business';
                  try {
                    const sgMail = require('@sendgrid/mail');
                    sgMail.setApiKey(process.env.SENDGRID_API_KEY || getSetting('SENDGRID_API_KEY'));
                    await sgMail.send({
                      to: owner.email,
                      from: { name: 'TAKEOVA AI', email: process.env.SENDGRID_FROM_EMAIL || getSetting('EMAIL_FROM') || 'noreply@takeova.ai' },
                      subject: `🎬 Your video ad is ready — ${campaign?.name || 'new campaign'}`,
                      html: `<div style="font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px">
                        <h2 style="font-size:20px;font-weight:800;margin-bottom:8px">🎬 Video ad ready!</h2>
                        <p style="color:#475569">Your AI Marketing Manager created a UGC video ad for <strong>${campaign?.name || 'your campaign'}</strong> on ${campaign?.platform || 'your ad platform'}.</p>
                        <video controls style="width:100%;border-radius:12px;margin:16px 0" src="${videoUrl}"></video>
                        <p style="font-size:13px;color:#64748B">The creative has been attached to your campaign automatically. Log in to MINE to review and push it live.</p>
                      </div>`
                    });
                  } catch(mailErr) { /* non-fatal */ }
                }
                console.log(`[VideoPoller] Creative ${task.creative_id} ready — ${videoUrl.substring(0, 60)}`);
              }
            }
          } catch(taskErr) { console.warn('[VideoPoller task]', taskErr.message); }
        }
      } catch(e) { console.error('[VideoPoller]', e.message); }

    } catch(e) { console.error('[DailyCron]', e.message); }
    finally { _dailyCronRunning = false; }
  }, 6 * 60 * 60 * 1000);

  // ── Password reset token cleanup — daily ──────────────────────────────────
  setInterval(() => {
    try {
      const db = getDb();
      db.exec("CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT, token TEXT, expires_at TEXT, used INTEGER DEFAULT 0, created_at TEXT)");
      const { changes } = db.prepare("DELETE FROM password_resets WHERE used = 1 OR datetime(expires_at) < datetime('now', '-1 day')").run();
      if (changes > 0) console.log(`[Cleanup] Purged ${changes} stale password reset tokens`);
    } catch(e) { console.error('[Cleanup] Token cleanup:', e.message); }
  }, 24 * 60 * 60 * 1000);
 // Every 6 hours

  // Add reminder_sent column to pet_appointments and vehicle_services if missing
  try {
    const db = getDb();
    try { db.exec("ALTER TABLE pet_appointments ADD COLUMN reminder_sent TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE vehicle_services ADD COLUMN reminder_sent TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE cleaning_jobs ADD COLUMN staff_ids TEXT DEFAULT '[]'"); } catch(e) {}
    try { db.exec("ALTER TABLE ad_creatives ADD COLUMN platform_creative_id TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE ad_creatives ADD COLUMN video_url TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE ad_creatives ADD COLUMN video_task_id TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE ad_creatives ADD COLUMN video_provider TEXT"); } catch(e) {}
  } catch(e) {}

});
// ─── Session-added routes (21 Apr 2026) ──────────────────────────────────────
app.use('/api/ai-email',     require('./routes/ai-email'));
app.use('/api/ai-employees', require('./routes/ai-employees-plus'));
app.use('/api/v4', require('./routes/verticals4'));
// ─── Stub catch-all (must be LAST among /api mounts) ────────────────────────
const importLimiter = rateLimit({ windowMs: 60000, max: 10, keyGenerator: (req) => req.ip, message: { error: "Too many import requests, slow down." } });
app.use("/api/content-import", importLimiter, require("./routes/content-import"));  // v31 — migrate-site backend (SSRF-guarded + rate-limited)

// === STUB REPLACEMENTS - real handlers for 69 endpoints ===
// (Added by integration. Must mount BEFORE catch-all stubs.js)
app.use('/api', require('./routes/stub-replacements'));
try { app.use('/api/panels', require('./routes/panels')); } catch (e) { console.error('[mount] /api/panels skipped:', e.message); }

// ── 404 for unknown API routes ───────────────────────────────────────────
// Placed AFTER every specific router (so they're reachable — previously this
// 404 sat too early and shadowed them). The old generic fallbacks
// (feature-crud / stubs) were removed — they returned mismatched shapes
// and fake-success writes, so an honest 404 is the intended behaviour.
// === BATCH 1: real DB-backed feature action handlers (make-every-button-work) ===
app.use('/api/exports', require('./routes/feature-actions').exportsRouter);
app.use('/api', require('./routes/feature-actions').bareRouter);
app.use("/api", require("./routes/shopify-app").router); // Shopify public app: install + Shopify Billing
// Panel list-loader shims — answer bare /api/<resource> paths with the exact shape
// the dashboard loaders expect (real data, empty-on-error). Must precede the 404.
app.use("/api", require("./routes/loader-shims"));

app.use("/api", (req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// === END STUB REPLACEMENTS ===


// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
function shutdown(signal) {

  httpServer.close((err) => {
    if (err) { console.error("[shutdown] Error:", err.message); process.exit(1); }

    process.exit(0);
  });
  // Force-kill if still running after 10s
  setTimeout(() => { console.error("[shutdown] Timeout — forcing exit"); process.exit(1); }, 10000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
