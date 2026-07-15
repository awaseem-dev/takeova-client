/**
 * ═══════════════════════════════════════════════════════════════════
 * TAKEOVA Intelligence — Data Flywheel Engine
 * ═══════════════════════════════════════════════════════════════════
 *
 * Tracks every meaningful business event, builds anonymised cohort
 * benchmarks, and generates personalised AI briefings via Claude.
 *
 * Flow:
 *   1. Events logged in real-time  →  business_events table
 *   2. Nightly aggregation (3am)   →  cohort_benchmarks table
 *   3. Briefing generation (3:30am) → intelligence_briefings table
 *   4. Delivery (8am)              →  email + push notification
 *   5. Dashboard API               →  /api/intelligence/* endpoints
 *
 * ═══════════════════════════════════════════════════════════════════
 */

"use strict";

const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");

// ── Middleware ────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorised" });
  next();
}

function requireInternal(req, res, next) {
  const key = req.headers["x-internal-key"];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// ══════════════════════════════════════════════════════════════════
// SECTION 1 — EVENT TRACKING
// ══════════════════════════════════════════════════════════════════

/**
 * POST /api/intelligence/event
 * Log a business event (called from other routes internally)
 * Also callable from the frontend for client-side events.
 *
 * Body: { event_type, metadata }
 *
 * Event types (defined constants to avoid typos):
 *   site_published, product_created, first_sale, order_received,
 *   invoice_sent, invoice_paid, email_campaign_sent, booking_created,
 *   course_created, student_enrolled, funnel_activated,
 *   review_received, lead_captured, automation_triggered,
 *   ai_employee_activated, flash_sale_sent, contact_added
 */
router.post("/event", requireAuth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const { event_type, metadata = {} } = req.body;

    if (!event_type || typeof event_type !== "string") {
      return res.status(400).json({ error: "event_type required" });
    }

    // Whitelist of valid event types to prevent junk data
    const VALID_EVENTS = new Set([
      "site_published", "product_created", "first_sale", "order_received",
      "invoice_sent", "invoice_paid", "email_campaign_sent", "booking_created",
      "course_created", "student_enrolled", "funnel_activated",
      "review_received", "lead_captured", "automation_triggered",
      "ai_employee_activated", "flash_sale_sent", "contact_added",
      "abandoned_cart_recovered", "upsell_accepted", "subscription_created",
      "whatsapp_message_sent", "sms_campaign_sent", "social_post_published",
      "ad_campaign_launched", "competitor_analysed", "milestone_hit"
    ]);

    if (!VALID_EVENTS.has(event_type)) {
      return res.status(400).json({ error: "Invalid event_type" });
    }

    // Sanitise metadata — only allow primitives, no nested objects to prevent bloat
    const safeMetadata = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        if (k.length <= 64 && String(v).length <= 512) {
          safeMetadata[k] = v;
        }
      }
    }

    // Get user context for richer cohort data
    const user = db.prepare(
      "SELECT plan, join_date FROM users WHERE id = ?"
    ).get(req.user.id);

    const site = db.prepare(
      "SELECT category FROM sites WHERE user_id = ? LIMIT 1"
    ).get(req.user.id);

    const daysSinceJoin = user?.join_date
      ? Math.floor((Date.now() - new Date(user.join_date).getTime()) / 86400000)
      : 0;

    db.prepare(`
      INSERT INTO business_events
        (id, user_id, event_type, plan, industry, days_since_join, metadata_json, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuid(),
      req.user.id,
      event_type,
      user?.plan || "starter",
      site?.category || "general",
      daysSinceJoin,
      JSON.stringify(safeMetadata)
    );

    // Check for milestone events and update milestone tracker
    checkMilestones(db, req.user.id, event_type);

    return res.json({ ok: true });
  } catch (e) {
    console.error("[Intelligence] Event log error:", e.message);
    return res.status(500).json({ error: "Failed to log event" });
  }
});

/**
 * Internal event logger — call this from other routes without HTTP overhead.
 * Usage: logEvent(db, userId, "first_sale", { amount: 99 })
 */
function logEvent(db, userId, eventType, metadata = {}) {
  try {
    const VALID_EVENTS = new Set([
      "site_published", "product_created", "first_sale", "order_received",
      "invoice_sent", "invoice_paid", "email_campaign_sent", "booking_created",
      "course_created", "student_enrolled", "funnel_activated",
      "review_received", "lead_captured", "automation_triggered",
      "ai_employee_activated", "flash_sale_sent", "contact_added",
      "abandoned_cart_recovered", "upsell_accepted", "subscription_created",
      "whatsapp_message_sent", "sms_campaign_sent", "social_post_published",
      "ad_campaign_launched", "competitor_analysed", "milestone_hit"
    ]);

    if (!VALID_EVENTS.has(eventType)) return;

    const user = db.prepare("SELECT plan, join_date FROM users WHERE id = ?").get(userId);
    const site = db.prepare("SELECT category FROM sites WHERE user_id = ? LIMIT 1").get(userId);
    const daysSinceJoin = user?.join_date
      ? Math.floor((Date.now() - new Date(user.join_date).getTime()) / 86400000)
      : 0;

    const safeMetadata = {};
    for (const [k, v] of Object.entries(metadata)) {
      if ((typeof v === "string" || typeof v === "number" || typeof v === "boolean")
          && k.length <= 64 && String(v).length <= 512) {
        safeMetadata[k] = v;
      }
    }

    db.prepare(`
      INSERT INTO business_events
        (id, user_id, event_type, plan, industry, days_since_join, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuid(), userId, eventType,
      user?.plan || "starter",
      site?.category || "general",
      daysSinceJoin,
      JSON.stringify(safeMetadata)
    );

    checkMilestones(db, userId, eventType);
  } catch (e) {
    // Never let event logging break the calling route
    console.error("[Intelligence] logEvent error:", e.message);
  }
}

// ── Milestone tracker ─────────────────────────────────────────────
const MILESTONES = [
  // First actions
  { key: "site_live",       event: "site_published",       label: "First site live",          emoji: "🌐", share: true  },
  { key: "first_product",   event: "product_created",      label: "First product added",      emoji: "📦", share: false },
  { key: "first_sale",      event: "first_sale",           label: "First sale made",          emoji: "🎉", share: true  },
  { key: "first_invoice",   event: "invoice_sent",         label: "First invoice sent",       emoji: "📄", share: false },
  { key: "first_booking",   event: "booking_created",      label: "First booking received",   emoji: "📅", share: true  },
  { key: "first_course",    event: "course_created",       label: "First course created",     emoji: "🎓", share: false },
  { key: "first_email",     event: "email_campaign_sent",  label: "First email campaign sent",emoji: "📧", share: false },
  { key: "first_lead",      event: "lead_captured",        label: "First lead captured",      emoji: "🎯", share: false },
  // Revenue milestones — checked via checkRevenueMilestones()
  { key: "rev_100",    event: "revenue_milestone", revenue: 100,    label: "First $100 in revenue",    emoji: "💸", share: true  },
  { key: "rev_1k",     event: "revenue_milestone", revenue: 1000,   label: "$1,000 in revenue",        emoji: "💰", share: true  },
  { key: "rev_5k",     event: "revenue_milestone", revenue: 5000,   label: "$5,000 in revenue",        emoji: "🚀", share: true  },
  { key: "rev_10k",    event: "revenue_milestone", revenue: 10000,  label: "$10,000 in revenue",       emoji: "🔥", share: true  },
  { key: "rev_25k",    event: "revenue_milestone", revenue: 25000,  label: "$25,000 in revenue",       emoji: "⚡", share: true  },
  { key: "rev_50k",    event: "revenue_milestone", revenue: 50000,  label: "$50,000 in revenue",       emoji: "👑", share: true  },
  { key: "rev_100k",   event: "revenue_milestone", revenue: 100000, label: "$100,000 in revenue",      emoji: "🏆", share: true  },
  // Contact milestones
  { key: "contacts_10",  event: "contacts_milestone", contacts: 10,   label: "10 customers",    emoji: "👥", share: false },
  { key: "contacts_100", event: "contacts_milestone", contacts: 100,  label: "100 customers",   emoji: "🎊", share: true  },
  { key: "contacts_500", event: "contacts_milestone", contacts: 500,  label: "500 customers",   emoji: "🌟", share: true  },
  { key: "contacts_1k",  event: "contacts_milestone", contacts: 1000, label: "1,000 customers", emoji: "💎", share: true  },
];

// Check revenue milestones after any sale
function checkRevenueMilestones(db, userId) {
  try {
    const totalRev = db.prepare("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE user_id=? AND status='paid'").get(userId)?.total || 0;
    const totalContacts = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE user_id=?").get(userId)?.n || 0;
    for (const m of MILESTONES) {
      if (m.event === "revenue_milestone" && totalRev >= m.revenue) {
        const exists = db.prepare("SELECT id FROM business_milestones WHERE user_id=? AND milestone_key=?").get(userId, m.key);
        if (!exists) {
          db.prepare("INSERT INTO business_milestones (id,user_id,milestone_key,milestone_label,achieved_at) VALUES (?,?,?,?,datetime('now'))")
            .run(require("crypto").randomUUID(), userId, m.key, m.label);
        }
      }
      if (m.event === "contacts_milestone" && totalContacts >= m.contacts) {
        const exists = db.prepare("SELECT id FROM business_milestones WHERE user_id=? AND milestone_key=?").get(userId, m.key);
        if (!exists) {
          db.prepare("INSERT INTO business_milestones (id,user_id,milestone_key,milestone_label,achieved_at) VALUES (?,?,?,?,datetime('now'))")
            .run(require("crypto").randomUUID(), userId, m.key, m.label);
        }
      }
    }
  } catch(e) { /* non-fatal */ }
}

function checkMilestones(db, userId, eventType) {
  try {
    const milestone = MILESTONES.find(m => m.event === eventType);
    if (!milestone) return;

    const exists = db.prepare(
      "SELECT id FROM business_milestones WHERE user_id = ? AND milestone_key = ?"
    ).get(userId, milestone.key);

    if (!exists) {
      db.prepare(`
        INSERT INTO business_milestones (id, user_id, milestone_key, milestone_label, achieved_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(uuid(), userId, milestone.key, milestone.label);
    }
  } catch (e) {
    // Silently skip — milestones are non-critical
  }
}

// ══════════════════════════════════════════════════════════════════
// SECTION 2 — COHORT BENCHMARKING
// ══════════════════════════════════════════════════════════════════

/**
 * Build anonymised cohort benchmarks for each industry.
 * Called nightly by the cron job.
 * Only includes businesses with 30+ days of history (statistically meaningful).
 */
async function buildCohortBenchmarks(db) {
  try {
    const now = new Date().toISOString().slice(0, 10);

    // Get all distinct industries with enough data
    const industries = db.prepare(`
      SELECT DISTINCT s.category as industry
      FROM sites s
      JOIN users u ON u.id = s.user_id
      WHERE s.category IS NOT NULL
        AND u.account_status = 'active'
        AND u.join_date <= date('now', '-30 days')
    `).all();

    for (const { industry } of industries) {
      try {
        // Revenue stats for businesses in this industry (last 30 days)
        const revenueStats = db.prepare(`
          SELECT
            COUNT(DISTINCT o.user_id) as business_count,
            AVG(monthly_rev.total) as avg_revenue,
            -- Median approximation: sort and pick middle
            MIN(monthly_rev.total) as min_revenue,
            MAX(monthly_rev.total) as max_revenue
          FROM (
            SELECT o.user_id, SUM(o.total) as total
            FROM orders o
            JOIN sites s ON s.user_id = o.user_id
            WHERE s.category = ?
              AND o.created_at >= date('now', '-30 days')
              AND o.status = 'paid'
            GROUP BY o.user_id
          ) monthly_rev
          JOIN sites s ON s.user_id = monthly_rev.user_id
        `).get(industry);

        // 75th percentile revenue (top 25%)
        const sortedRevenues = db.prepare(`
          SELECT SUM(o.total) as total
          FROM orders o
          JOIN sites s ON s.user_id = o.user_id
          WHERE s.category = ?
            AND o.created_at >= date('now', '-30 days')
            AND o.status = 'paid'
          GROUP BY o.user_id
          ORDER BY total ASC
        `).all(industry).map(r => r.total);

        const p75Index = Math.floor(sortedRevenues.length * 0.75);
        const p25Index = Math.floor(sortedRevenues.length * 0.25);
        const p75Revenue = sortedRevenues[p75Index] || 0;
        const p25Revenue = sortedRevenues[p25Index] || 0;

        // What actions do top 25% businesses take that bottom 75% don't?
        const topUserIds = db.prepare(`
          SELECT o.user_id
          FROM orders o
          JOIN sites s ON s.user_id = o.user_id
          WHERE s.category = ?
            AND o.created_at >= date('now', '-30 days')
            AND o.status = 'paid'
          GROUP BY o.user_id
          HAVING SUM(o.total) >= ?
        `).all(industry, p75Revenue).map(r => r.user_id);

        // Event frequency for top performers
        let topPerformerActions = {};
        if (topUserIds.length > 0) {
          const placeholders = topUserIds.map(() => "?").join(",");
          const topEvents = db.prepare(`
            SELECT event_type, COUNT(*) as count
            FROM business_events
            WHERE user_id IN (${placeholders})
              AND created_at >= date('now', '-30 days')
            GROUP BY event_type
            ORDER BY count DESC
            LIMIT 10
          `).all(...topUserIds);

          topPerformerActions = Object.fromEntries(topEvents.map(e => [e.event_type, e.count]));
        }

        // Booking stats
        const bookingStats = db.prepare(`
          SELECT AVG(cnt) as avg_bookings
          FROM (
            SELECT b.user_id, COUNT(*) as cnt
            FROM bookings b
            JOIN sites s ON s.user_id = b.user_id
            WHERE s.category = ?
              AND b.created_at >= date('now', '-30 days')
            GROUP BY b.user_id
          )
        `).get(industry);

        // Contact growth rate
        const contactStats = db.prepare(`
          SELECT AVG(cnt) as avg_new_contacts
          FROM (
            SELECT c.user_id, COUNT(*) as cnt
            FROM contacts c
            JOIN sites s ON s.user_id = c.user_id
            WHERE s.category = ?
              AND c.created_at >= date('now', '-30 days')
            GROUP BY c.user_id
          )
        `).get(industry);

        // Upsert benchmark record
        db.prepare(`
          INSERT OR REPLACE INTO cohort_benchmarks
            (id, industry, period, business_count,
             avg_revenue, p25_revenue, p75_revenue,
             avg_bookings, avg_new_contacts,
             top_performer_actions_json, updated_at)
          VALUES
            (?, ?, ?, ?,
             ?, ?, ?,
             ?, ?,
             ?, datetime('now'))
        `).run(
          `${industry}_${now}`,
          industry,
          now,
          revenueStats?.business_count || 0,
          Math.round(revenueStats?.avg_revenue || 0),
          Math.round(p25Revenue),
          Math.round(p75Revenue),
          Math.round(bookingStats?.avg_bookings || 0),
          Math.round(contactStats?.avg_new_contacts || 0),
          JSON.stringify(topPerformerActions)
        );

      } catch (e) {
        console.error(`[Intelligence] Benchmark error for ${industry}:`, e.message);
      }
    }

    // Also build "all industries" benchmark
    const allStats = db.prepare(`
      SELECT
        COUNT(DISTINCT user_id) as business_count,
        AVG(monthly_rev.total) as avg_revenue
      FROM (
        SELECT user_id, SUM(total) as total
        FROM orders
        WHERE created_at >= date('now', '-30 days')
          AND status = 'paid'
        GROUP BY user_id
      ) monthly_rev
    `).get();

    db.prepare(`
      INSERT OR REPLACE INTO cohort_benchmarks
        (id, industry, period, business_count, avg_revenue, p25_revenue, p75_revenue,
         avg_bookings, avg_new_contacts, top_performer_actions_json, updated_at)
      VALUES (?, 'all', ?, ?, ?, 0, 0, 0, 0, '{}', datetime('now'))
    `).run(`all_${now}`, now, allStats?.business_count || 0, Math.round(allStats?.avg_revenue || 0));
  } catch (e) {
    console.error("[Intelligence] buildCohortBenchmarks error:", e.message);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════════
// SECTION 3 — AI BRIEFING GENERATION
// ══════════════════════════════════════════════════════════════════

// ── Web search: fetch live industry news before generating briefing ──────────
// Runs nightly so the morning briefing references what's actually happening in
// the user's market — not just their internal data.
async function fetchIndustryNews(industry, businessName, apiKey) {
  try {
    const fetch = (...args) => import("node-fetch").then(m => m.default(...args));
    const month = new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" });
    const queries = [
      `${industry} industry news trends ${month}`,
      `small business ${industry} opportunities challenges ${new Date().getFullYear()}`,
    ];

    const summaries = [];
    for (const query of queries) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 350,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: "user", content: `Search for recent news about: ${query}. Give me 2-3 sentences of the most relevant, specific findings for a small business owner in the ${industry} space. Focus on actionable market intelligence.` }],
          }),
        });
        const d = await r.json();
        const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
        if (text) summaries.push(text);
      } catch(e) { /* skip failed query */ }
    }

    return summaries.length ? summaries.join(" | ") : null;
  } catch(e) {
    return null;
  }
}

/**
 * Generate a personalised TAKEOVA Intelligence briefing for one user.
 * Uses Claude API with the user's real data + cohort benchmarks as context.
 */
async function generateBriefingForUser(db, userId) {
  const anthropicKey = (getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY);
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  // ── Gather user data ─────────────────────────────────────────
  const user = db.prepare("SELECT name, email, plan FROM users WHERE id = ?").get(userId);
  if (!user) throw new Error("User not found");

  const site = db.prepare(
    "SELECT name, category, revenue, views, leads FROM sites WHERE user_id = ? LIMIT 1"
  ).get(userId);

  // Revenue last 30 days
  const revenue30 = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as order_count
    FROM orders
    WHERE user_id = ? AND status = 'paid'
      AND created_at >= date('now', '-30 days')
  `).get(userId);

  // Revenue prev 30 days (for trend)
  const revenuePrev30 = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM orders
    WHERE user_id = ?
      AND status = 'paid'
      AND created_at >= date('now', '-60 days')
      AND created_at < date('now', '-30 days')
  `).get(userId);

  // Unpaid invoices
  const unpaidInvoices = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as at_risk
    FROM invoices
    WHERE user_id = ? AND status = 'sent'
      AND due_date < date('now')
  `).get(userId);

  // Upcoming bookings
  const upcomingBookings = db.prepare(`
    SELECT COUNT(*) as count
    FROM bookings
    WHERE user_id = ? AND status = 'confirmed'
      AND date >= date('now') AND date <= date('now', '+7 days')
  `).get(userId);

  // Unanswered reviews
  const unansweredReviews = db.prepare(`
    SELECT COUNT(*) as count
    FROM reviews
    WHERE user_id = ? AND approved = 1
  `).get(userId);

  // Recent leads not contacted
  const coldLeads = db.prepare(`
    SELECT COUNT(*) as count
    FROM contacts
    WHERE user_id = ? AND status = 'lead'
      AND (last_contacted IS NULL OR last_contacted < date('now', '-7 days'))
      AND created_at >= date('now', '-30 days')
  `).get(userId);

  // Recent events this business has done
  const recentEvents = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM business_events
    WHERE user_id = ? AND created_at >= date('now', '-30 days')
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 15
  `).all(userId);

  // Milestones achieved
  const milestones = db.prepare(`
    SELECT milestone_key, milestone_label, achieved_at
    FROM business_milestones
    WHERE user_id = ?
    ORDER BY achieved_at DESC
    LIMIT 5
  `).all(userId);

  // Milestones NOT yet achieved
  const achievedKeys = new Set(milestones.map(m => m.milestone_key));
  const pendingMilestones = MILESTONES.filter(m => !achievedKeys.has(m.key));

  // Cohort benchmark for this industry
  const industry = site?.category || "all";
  const benchmark = db.prepare(`
    SELECT avg_revenue, p25_revenue, p75_revenue,
           avg_bookings, avg_new_contacts, top_performer_actions_json
    FROM cohort_benchmarks
    WHERE industry = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(industry) || db.prepare(`
    SELECT avg_revenue, p25_revenue, p75_revenue, 0 as avg_bookings, 0 as avg_new_contacts, '{}' as top_performer_actions_json
    FROM cohort_benchmarks
    WHERE industry = 'all'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();

  const topActions = benchmark?.top_performer_actions_json
    ? Object.keys(JSON.parse(benchmark.top_performer_actions_json)).slice(0, 5)
    : [];
  const userEventTypes = new Set(recentEvents.map(e => e.event_type));
  const missedTopActions = topActions.filter(a => !userEventTypes.has(a));

  // Revenue trend
  const revenueThisMonth = revenue30?.total || 0;
  const revenuePrevMonth = revenuePrev30?.total || 0;
  const revenueTrend = revenuePrevMonth > 0
    ? Math.round(((revenueThisMonth - revenuePrevMonth) / revenuePrevMonth) * 100)
    : null;

  // ── EXPANSION: pipeline / recurring revenue / loyalty / funnels / courses /
  //    gift-card liability. These are the modules the Take Control agent can now
  //    act on; feeding them here lets the morning briefing PROACTIVELY flag them.
  //    Wrapped defensively — an issue here must never break the core briefing.
  let growthSignals = {};
  try {
    // Sales pipeline — open value, weighted forecast, and STALLED deals (the key signal)
    const pipeOpen = db.prepare("SELECT COUNT(*) cnt, COALESCE(SUM(value),0) val, COALESCE(SUM(value*COALESCE(probability,0)/100.0),0) weighted FROM deals WHERE user_id = ? AND lower(stage) NOT IN ('won','lost','closed','closed_won','closed_lost')").get(userId);
    const pipeStalled = db.prepare("SELECT COUNT(*) cnt, COALESCE(SUM(value),0) val FROM deals WHERE user_id = ? AND lower(stage) NOT IN ('won','lost','closed','closed_won','closed_lost') AND created_at < date('now','-14 days')").get(userId);
    const pipeWon30 = db.prepare("SELECT COUNT(*) cnt, COALESCE(SUM(value),0) val FROM deals WHERE user_id = ? AND lower(stage) = 'won' AND created_at >= date('now','-30 days')").get(userId);
    if ((pipeOpen?.cnt || 0) > 0 || (pipeWon30?.cnt || 0) > 0) {
      growthSignals.salesPipeline = {
        openDeals: pipeOpen.cnt, openValue: Math.round(pipeOpen.val), weightedForecast: Math.round(pipeOpen.weighted),
        stalledDeals: pipeStalled.cnt, stalledValue: Math.round(pipeStalled.val),
        wonLast30Days: pipeWon30.cnt, wonValueLast30Days: Math.round(pipeWon30.val),
      };
    }

    // Recurring revenue (MRR) from memberships — normalised to monthly, with a
    // month-over-month trend computed from the nightly mrr_snapshots history.
    const memberships = db.prepare("SELECT price, interval_type, active_members FROM memberships WHERE user_id = ?").all(userId);
    if (memberships.length) {
      let mrr = 0, subs = 0;
      for (const m of memberships) {
        const it = (m.interval_type || "month").toLowerCase();
        const monthly = (it.includes("year") || it.includes("annual")) ? (m.price || 0) / 12 : it.includes("week") ? (m.price || 0) * 4.33 : (m.price || 0);
        mrr += monthly * (m.active_members || 0); subs += (m.active_members || 0);
      }
      mrr = Math.round(mrr);
      // Compare to ~30 days ago (closest snapshot at least 28 days old)
      const prior = db.prepare("SELECT mrr, subscribers FROM mrr_snapshots WHERE user_id = ? AND snapshot_date <= date('now','-28 days') ORDER BY snapshot_date DESC LIMIT 1").get(userId);
      const mrrTrend = (prior && prior.mrr > 0) ? Math.round(((mrr - prior.mrr) / prior.mrr) * 100) : null;
      // Record today's snapshot so future briefings have history (idempotent per day)
      db.prepare("INSERT OR REPLACE INTO mrr_snapshots (user_id, snapshot_date, mrr, subscribers) VALUES (?, date('now'), ?, ?)").run(userId, mrr, subs);
      // Surface if they have subscribers now OR had them a month ago (churn-to-zero is a signal)
      if (subs > 0 || (prior && prior.subscribers > 0)) {
        growthSignals.recurringRevenue = {
          mrr, arr: mrr * 12, subscribers: subs, planCount: memberships.length,
          mrrTrendVsLastMonth: mrrTrend,
          mrr30DaysAgo: prior ? Math.round(prior.mrr) : null,
          subscribers30DaysAgo: prior ? prior.subscribers : null,
        };
      }
    }

    // Loyalty — outstanding points liability + redemption activity
    const loyaltyOut = db.prepare("SELECT COALESCE(SUM(balance_after),0) outstanding, COUNT(*) members FROM (SELECT customer_id, balance_after FROM loyalty_transactions t WHERE user_id = ? AND created_at = (SELECT MAX(created_at) FROM loyalty_transactions WHERE customer_id = t.customer_id AND user_id = t.user_id))").get(userId);
    if ((loyaltyOut?.members || 0) > 0) {
      const redeemed30 = db.prepare("SELECT COALESCE(SUM(ABS(points)),0) p FROM loyalty_transactions WHERE user_id = ? AND type IN ('redeem','redeemed','spend') AND created_at >= date('now','-30 days')").get(userId)?.p || 0;
      growthSignals.loyalty = { membersWithPoints: loyaltyOut.members, outstandingPoints: loyaltyOut.outstanding, pointsRedeemedLast30Days: redeemed30 };
    }

    // Funnels — surface the worst converter that has real traffic (optimisation opportunity)
    const funnels = db.prepare("SELECT name, contacts_entered, conversions FROM funnels WHERE user_id = ? AND contacts_entered > 10").all(userId);
    if (funnels.length) {
      const scored = funnels.map(f => ({ name: f.name, entered: f.contacts_entered, conversions: f.conversions, rate: f.contacts_entered ? Math.round((f.conversions / f.contacts_entered) * 1000) / 10 : 0 }));
      scored.sort((a, b) => a.rate - b.rate);
      growthSignals.funnels = { count: funnels.length, lowestConverting: scored[0], highestConverting: scored[scored.length - 1] };
    }

    // Online courses — revenue + recent enrollment momentum
    const courseAgg = db.prepare("SELECT COUNT(*) cnt, COALESCE(SUM(price*enrolled),0) rev FROM courses WHERE user_id = ?").get(userId);
    if ((courseAgg?.cnt || 0) > 0) {
      const newEnroll = db.prepare("SELECT COUNT(*) c FROM enrollments WHERE user_id = ? AND created_at >= date('now','-30 days')").get(userId)?.c || 0;
      growthSignals.courses = { courses: courseAgg.cnt, totalRevenue: Math.round(courseAgg.rev), newEnrollmentsLast30Days: newEnroll };
    }

    // Gift-card liability — outstanding balance owed to customers
    const gc = db.prepare("SELECT COUNT(*) cnt, COALESCE(SUM(current_balance),0) outstanding FROM gift_cards WHERE user_id = ? AND status = 'active'").get(userId);
    if ((gc?.cnt || 0) > 0 && (gc?.outstanding || 0) > 0) {
      growthSignals.giftCardLiability = { activeCards: gc.cnt, outstandingBalance: Math.round(gc.outstanding) };
    }
  } catch (e) { /* additive only — never break the core briefing */ }

  // ── Build context for Claude ──────────────────────────────────
  const context = {
    user: { name: user.name || "there", plan: user.plan },
    business: {
      name: site?.name || "Your Business",
      industry: site?.category || "general",
      siteViews30Days: site?.views || 0,
    },
    revenue: {
      last30Days: revenueThisMonth,
      orderCount: revenue30?.order_count || 0,
      trendVsPrevMonth: revenueTrend,
      benchmarkAvg: benchmark?.avg_revenue || 0,
      benchmark75th: benchmark?.p75_revenue || 0,
    },
    alerts: {
      unpaidInvoices: {
        count: unpaidInvoices?.count || 0,
        totalAtRisk: unpaidInvoices?.at_risk || 0,
      },
      coldLeads: coldLeads?.count || 0,
      unansweredReviews: unansweredReviews?.count || 0,
      upcomingBookings7Days: upcomingBookings?.count || 0,
    },
    activity: {
      eventsThisMonth: recentEvents,
      milestonesAchieved: milestones.map(m => m.milestone_label),
      milestonesNotYetAchieved: pendingMilestones.map(m => m.label),
    },
    cohortInsight: {
      industry,
      topPerformerActionsYouHaventDone: missedTopActions,
      avgRevenueForSimilarBusinesses: benchmark?.avg_revenue || 0,
    },
    growthSignals,
  };

  // ── Fetch live industry news via web search ─────────────────────────────────
  // Enriches the briefing with real market intelligence so actions reference
  // what's actually happening in the user's industry today, not just their DB.
  let industryNews = null;
  try {
    industryNews = await fetchIndustryNews(industry, site?.name || user.name, anthropicKey);
    if (industryNews) {
      context.marketIntelligence = {
        source: "web_search",
        summary: industryNews,
        note: "Live market context fetched this morning — use this to make the cohortInsight sharper and more timely.",
      };
    }
  } catch(e) { /* non-fatal — briefing proceeds without web context */ }

  // ── Call Claude API with extended thinking ───────────────────────────────
  const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

  const prompt = `You are TAKEOVA Intelligence — the AI business advisor built into the TAKEOVA platform.

Your job is to deeply analyse this business owner's data and produce their daily morning briefing.

BUSINESS DATA:
${JSON.stringify(context, null, 2)}

INSTRUCTIONS:
- Think carefully about what this data actually means for this specific business.
- Look for non-obvious patterns — not just "you have unpaid invoices" but WHY it matters right now.
- Produce exactly 3 prioritised actions for today. No more, no less.
- Each action must be specific, actionable, and reference their actual numbers.
- Rank by revenue impact: money at risk first, then growth opportunities.
- Be direct and confident. No fluff. No "it might be worth considering."
- Include one cohort insight — something top performers in their industry do that this business hasn't done yet. If marketIntelligence is present in the data, weave it into the cohortInsight to make it timely and specific to what's happening in the market RIGHT NOW.
- Tone: like a sharp business advisor who has studied their numbers all night.

RESPONSE FORMAT (strict JSON, no markdown):
{
  "greeting": "Good morning [name].",
  "summary": "One sentence snapshot of where they stand today.",
  "actions": [
    {
      "priority": "high|medium|opportunity",
      "icon": "emoji",
      "title": "Short action title",
      "detail": "2-3 sentence explanation referencing their actual numbers.",
      "cta": "Button label text",
      "route": "optional dashboard route e.g. /invoices"
    }
  ],
  "cohortInsight": {
    "headline": "One sentence benchmark insight",
    "detail": "How they compare to similar businesses and what to do about it."
  }
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      thinking: {
        type: "enabled",
        budget_tokens: 10000,
      },
      system: [
        {
          type: "text",
          text: "You are TAKEOVA Intelligence — the AI business advisor built into the TAKEOVA platform.\n\nYour job is to deeply analyse this business owner\'s data and produce their daily morning briefing.\n\nINSTRUCTIONS:\n- Think carefully about what this data actually means for this specific business.\n- Look for non-obvious patterns — not just \"you have unpaid invoices\" but WHY it matters right now.\n- Produce exactly 3 prioritised actions for today. No more, no less.\n- Each action must be specific, actionable, and reference their actual numbers.\n- Rank by revenue impact: money at risk first, then growth opportunities.\n- Be direct and confident. No fluff. No \"it might be worth considering.\"\n- Include one cohort insight — something top performers in their industry do that this business hasn\'t done yet.\n- Tone: like a sharp business advisor who has studied their numbers all night.\n\nRESPONSE FORMAT (strict JSON, no markdown):\n{\n  \"greeting\": \"Good morning [name].\",\n  \"summary\": \"One sentence snapshot of where they stand today.\",\n  \"actions\": [\n    {\n      \"priority\": \"high|medium|opportunity\",\n      \"icon\": \"emoji\",\n      \"title\": \"Short action title\",\n      \"detail\": \"2-3 sentence explanation referencing their actual numbers.\",\n      \"cta\": \"Button label text\",\n      \"route\": \"optional dashboard route e.g. /invoices\"\n    }\n  ],\n  \"cohortInsight\": {\n    \"headline\": \"One sentence benchmark insight\",\n    \"detail\": \"How they compare to similar businesses and what to do about it.\"\n  }\n}",
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: [{ role: "user", content: "BUSINESS DATA:\n" + JSON.stringify(context, null, 2) + "\n\nNOTE: `growthSignals` holds sales-pipeline, recurring-revenue (MRR), loyalty, funnel, course, and gift-card-liability data. Treat these as first-class inputs — e.g. stalled deals and gift-card liability are money at risk; a low-converting funnel is a growth lever. In recurringRevenue, `mrrTrendVsLastMonth` is the key churn/growth signal: a negative value means MRR is shrinking (churn) and should rank as money at risk; a strong positive means momentum worth doubling down on. Surface these in your 3 actions where they outrank the other signals." }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${err}`);
  }

  const data = await response.json();

  // Extended thinking returns multiple content blocks — find the text block
  // (thinking blocks have type:"thinking", response is type:"text")
  const textBlock = data.content?.find(b => b.type === "text");
  const rawText = textBlock?.text || data.content?.[0]?.text || "";

  // Parse JSON response — strip any accidental markdown fences
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const briefing = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(cleaned);

  // Validate structure
  if (!briefing.actions || !Array.isArray(briefing.actions)) {
    throw new Error("Invalid briefing structure from Claude");
  }

  return { briefing, context };
}

// ══════════════════════════════════════════════════════════════════
// SECTION 4 — NIGHTLY CRON RUNNER
// ══════════════════════════════════════════════════════════════════

/**
 * runNightlyIntelligence — called by the main cron at 3am.
 * 1. Build cohort benchmarks
 * 2. Generate briefings for all eligible users
 * 3. Store briefings for dashboard
 * 4. Queue 8am email delivery
 */
async function runNightlyIntelligence(db) {
  const startTime = Date.now();

  try {
    // Step 1 — Build benchmarks
    await buildCohortBenchmarks(db);

    // Step 2 — Find eligible users (Growth plan+, active, not trialling)
    const eligiblePlans = ["growth", "pro", "enterprise"];
    const users = db.prepare(`
      SELECT DISTINCT u.id, u.email, u.name, u.plan, u.timezone
      FROM users u
      JOIN sites s ON s.user_id = u.id
      WHERE u.plan IN (${eligiblePlans.map(() => "?").join(",")})
        AND u.account_status = 'active'
        AND u.email IS NOT NULL
    `).all(...eligiblePlans);

    let generated = 0;
    let failed = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const user of users) {
      try {
        // Skip if already generated today
        const existing = db.prepare(`
          SELECT id FROM intelligence_briefings
          WHERE user_id = ? AND period = ?
        `).get(user.id, today);

        if (existing) continue;

        // Rate limit — avoid hammering Claude API
        await sleep(500);

        const { briefing, context } = await generateBriefingForUser(db, user.id);

        // Store briefing
        db.prepare(`
          INSERT OR REPLACE INTO intelligence_briefings
            (id, user_id, period, briefing_json, context_json, delivered_email, created_at)
          VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
        `).run(
          `${user.id}_${today}`,
          user.id,
          today,
          JSON.stringify(briefing),
          JSON.stringify(context)
        );

        generated++;
      } catch (e) {
        console.error(`[Intelligence] Failed for user ${user.id}:`, e.message);
        failed++;
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
  } catch (e) {
    console.error("[Intelligence] Nightly run failed:", e.message);
    throw e;
  }
}

/**
 * deliverMorningBriefings — called at 8am.
 * Sends email + push for all undelivered briefings from today.
 */
async function deliverMorningBriefings(db) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const pending = db.prepare(`
      SELECT ib.*, u.email, u.name, u.plan
      FROM intelligence_briefings ib
      JOIN users u ON u.id = ib.user_id
      WHERE ib.period = ? AND ib.delivered_email = 0
      LIMIT 200
    `).all(today);

    if (pending.length === 0) return;

    const sgKey = (getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY)
      || db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value;
    const fromEmail = process.env.EMAIL_FROM || "hello@takeova.ai";
    const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

    for (const record of pending) {
      try {
        const briefing = JSON.parse(record.briefing_json || "{}");
        const context = JSON.parse(record.context_json || "{}");

        if (!briefing.actions?.length) continue;

        // Build email HTML
        const priorityColours = {
          high:        { bg: "rgba(239,68,68,.08)",  border: "rgba(239,68,68,.3)",  text: "#EF4444",  label: "HIGH PRIORITY" },
          medium:      { bg: "rgba(245,158,11,.08)", border: "rgba(245,158,11,.3)", text: "#F59E0B",  label: "ACTION NEEDED" },
          opportunity: { bg: "rgba(34,197,94,.08)",  border: "rgba(34,197,94,.3)",  text: "#22C55E",  label: "OPPORTUNITY"   },
        };

        const actionCards = briefing.actions.map(a => {
          const col = priorityColours[a.priority] || priorityColours.medium;
          return `
            <div style="background:${col.bg};border:1px solid ${col.border};border-radius:12px;padding:18px;margin-bottom:12px;">
              <div style="font-size:10px;font-weight:700;color:${col.text};letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">
                ${a.icon || "•"} ${col.label}
              </div>
              <div style="font-size:15px;font-weight:700;color:#0F172A;margin-bottom:6px;">${escHtml(a.title)}</div>
              <div style="font-size:13px;color:#475569;line-height:1.6;margin-bottom:12px;">${escHtml(a.detail)}</div>
              <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}${a.route || "/dashboard"}"
                 style="display:inline-block;background:#0F172A;color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;font-weight:700;text-decoration:none;">
                ${escHtml(a.cta || "Take Action →")}
              </a>
            </div>`;
        }).join("");

        const cohortHtml = briefing.cohortInsight ? `
          <div style="background:rgba(37,99,235,.04);border:1px solid rgba(37,99,235,.12);border-radius:12px;padding:18px;margin-top:20px;">
            <div style="font-size:10px;font-weight:700;color:#2563EB;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">📊 INDUSTRY BENCHMARK</div>
            <div style="font-size:14px;font-weight:700;color:#0F172A;margin-bottom:4px;">${escHtml(briefing.cohortInsight.headline)}</div>
            <div style="font-size:13px;color:#475569;line-height:1.6;">${escHtml(briefing.cohortInsight.detail)}</div>
          </div>` : "";

        const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Segoe UI',system-ui,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-weight:900;font-size:28px;background:linear-gradient(135deg,#2563EB,#7C3AED);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:2px;margin-bottom:4px;">MINE</div>
      <div style="font-size:11px;color:#94A3B8;letter-spacing:1px;text-transform:uppercase;">Intelligence Briefing · ${new Date().toLocaleDateString("en-AU", { weekday:"long", day:"numeric", month:"long" })}</div>
    </div>

    <!-- Card -->
    <div style="background:#fff;border-radius:20px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.06);">
      <div style="font-size:18px;font-weight:700;color:#0F172A;margin-bottom:4px;">${escHtml(briefing.greeting || `Good morning, ${record.name || "there"}.`)}</div>
      <div style="font-size:14px;color:#64748B;margin-bottom:24px;line-height:1.6;">${escHtml(briefing.summary || "")}</div>

      ${actionCards}
      ${cohortHtml}
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:24px;font-size:11px;color:#94A3B8;">
      <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}/dashboard" style="color:#2563EB;text-decoration:none;font-weight:600;">Open Dashboard →</a>
      &nbsp;·&nbsp;
      <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}/unsubscribe?type=intelligence" style="color:#94A3B8;text-decoration:none;">Unsubscribe from briefings</a>
    </div>
  </div>
</body></html>`;

        // Send email
        if (sgKey) {
          const sgRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${sgKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: record.email, name: record.name || "" }] }],
              from: { email: fromEmail, name: "TAKEOVA Intelligence" },
              subject: `☀️ Your morning briefing — ${new Date().toLocaleDateString("en-AU", { weekday:"long" })}`,
              content: [{ type: "text/html", value: html }],
            }),
          });

          if (sgRes.ok) {
            db.prepare(
              "UPDATE intelligence_briefings SET delivered_email = 1, delivered_at = datetime('now') WHERE id = ?"
            ).run(record.id);
          }
        }

        await sleep(150); // Avoid SendGrid rate limits
      } catch (e) {
        console.error(`[Intelligence] Delivery failed for ${record.email}:`, e.message);
      }
    }
  } catch (e) {
    console.error("[Intelligence] deliverMorningBriefings error:", e.message);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════════
// SECTION 5 — DASHBOARD API ENDPOINTS
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/intelligence/briefing
 * Returns today's briefing for the authenticated user.
 */
router.get("/briefing", requireAuth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const today = new Date().toISOString().slice(0, 10);

    const record = db.prepare(`
      SELECT briefing_json, context_json, created_at, delivered_email
      FROM intelligence_briefings
      WHERE user_id = ? AND period = ?
    `).get(req.user.id, today);

    if (!record) {
      return res.json({ briefing: null, message: "No briefing available yet — check back tomorrow morning." });
    }

    return res.json({
      briefing: (function(s){try{return JSON.parse(s);}catch(_){return {};}})(record.briefing_json),
      context: JSON.parse(record.context_json || "{}"),
      generatedAt: record.created_at,
      delivered: record.delivered_email === 1,
    });
  } catch (e) {
    console.error("[Intelligence] GET /briefing error:", e.message);
    return res.status(500).json({ error: "Failed to fetch briefing" });
  }
});

/**
 * GET /api/intelligence/benchmarks
 * Returns cohort benchmark data for the user's industry.
 */
router.get("/benchmarks", requireAuth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = db.prepare(
      "SELECT category FROM sites WHERE user_id = ? LIMIT 1"
    ).get(req.user.id);
    const industry = site?.category || "all";

    // User's own 30-day revenue
    const myRevenue = db.prepare(`
      SELECT COALESCE(SUM(total), 0) as total
      FROM orders
      WHERE user_id = ? AND status = 'paid'
        AND created_at >= date('now', '-30 days')
    `).get(req.user.id);

    // Cohort benchmark
    const benchmark = db.prepare(`
      SELECT avg_revenue, p25_revenue, p75_revenue,
             avg_bookings, avg_new_contacts,
             top_performer_actions_json, business_count, updated_at
      FROM cohort_benchmarks
      WHERE industry = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(industry) || db.prepare(`
      SELECT avg_revenue, p25_revenue, p75_revenue, 0 as avg_bookings,
             0 as avg_new_contacts, '{}' as top_performer_actions_json,
             0 as business_count, datetime('now') as updated_at
      FROM cohort_benchmarks WHERE industry = 'all' ORDER BY updated_at DESC LIMIT 1
    `).get();

    // User's milestones
    const milestones = db.prepare(`
      SELECT milestone_key, milestone_label, achieved_at
      FROM business_milestones WHERE user_id = ?
      ORDER BY achieved_at ASC
    `).all(req.user.id);

    const achievedKeys = new Set(milestones.map(m => m.milestone_key));
    const pendingMilestones = MILESTONES.filter(m => !achievedKeys.has(m.key));

    // Calculate user's percentile
    let percentile = null;
    if (benchmark && myRevenue.total > 0) {
      if (myRevenue.total >= benchmark.p75_revenue) percentile = 75;
      else if (myRevenue.total >= benchmark.avg_revenue) percentile = 50;
      else if (myRevenue.total >= benchmark.p25_revenue) percentile = 25;
      else percentile = 10;
    }

    return res.json({
      industry,
      myRevenue30Days: myRevenue.total,
      percentile,
      benchmark: benchmark ? {
        avgRevenue: benchmark.avg_revenue,
        p25Revenue: benchmark.p25_revenue,
        p75Revenue: benchmark.p75_revenue,
        avgBookings: benchmark.avg_bookings,
        avgNewContacts: benchmark.avg_new_contacts,
        businessCount: benchmark.business_count,
        topPerformerActions: JSON.parse(benchmark.top_performer_actions_json || "{}"),
        updatedAt: benchmark.updated_at,
      } : null,
      milestones: {
        achieved: milestones,
        pending: pendingMilestones,
      },
    });
  } catch (e) {
    console.error("[Intelligence] GET /benchmarks error:", e.message);
    return res.status(500).json({ error: "Failed to fetch benchmarks" });
  }
});

/**
 * GET /api/intelligence/history
 * Returns the last 7 briefings for the user.
 */
router.get("/history", requireAuth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const records = db.prepare(`
      SELECT period, briefing_json, created_at, delivered_email
      FROM intelligence_briefings
      WHERE user_id = ?
      ORDER BY period DESC
      LIMIT 7
    `).all(req.user.id);

    return res.json({
      briefings: records.map(r => ({
        period: r.period,
        briefing: JSON.parse(r.briefing_json || "{}"),
        generatedAt: r.created_at,
        delivered: r.delivered_email === 1,
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: "Failed to fetch history" });
  }
});

/**
 * POST /api/intelligence/generate (internal)
 * Manually trigger briefing generation for a user (admin/cron use).
 */
router.post("/generate", requireInternal, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const { briefing, context } = await generateBriefingForUser(db, user_id);
    const today = new Date().toISOString().slice(0, 10);

    db.prepare(`
      INSERT OR REPLACE INTO intelligence_briefings
        (id, user_id, period, briefing_json, context_json, delivered_email, created_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(`${user_id}_${today}`, user_id, today, JSON.stringify(briefing), JSON.stringify(context));

    return res.json({ ok: true, briefing });
  } catch (e) {
    console.error("[Intelligence] /generate error:", e.message);
    return console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

/**
 * POST /api/intelligence/run-nightly (internal — cron trigger)
 */
router.post("/run-nightly", requireInternal, async (req, res) => {
  try {
    const db = req.app.locals.db;
    // Non-blocking — respond immediately, run in background
    res.json({ ok: true, message: "Nightly run started" });
    await runNightlyIntelligence(db);
  } catch (e) {
    console.error("[Intelligence] /run-nightly error:", e.message);
  }
});

/**
 * POST /api/intelligence/deliver (internal — cron trigger)
 */
router.post("/deliver", requireInternal, async (req, res) => {
  try {
    const db = req.app.locals.db;
    res.json({ ok: true, message: "Delivery started" });
    await deliverMorningBriefings(db);
  } catch (e) {
    console.error("[Intelligence] /deliver error:", e.message);
  }
});

// ══════════════════════════════════════════════════════════════════
// SECTION 6 — UTILITIES
// ══════════════════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ══════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════


// GET /api/intelligence/new-milestones — get milestones achieved since last seen
router.get("/new-milestones", requireAuth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const lastSeen = req.query.since || new Date(Date.now() - 7*86400000).toISOString();
    const milestones = db.prepare(`
      SELECT bm.*, m.emoji, m.share
      FROM business_milestones bm
      WHERE bm.user_id = ? AND bm.achieved_at > ? AND bm.celebrated IS NULL
      ORDER BY bm.achieved_at DESC LIMIT 5
    `).all(req.user.id, lastSeen).map(m => ({
      ...m,
      emoji: MILESTONES.find(ml => ml.key === m.milestone_key)?.emoji || "🏆",
      share: MILESTONES.find(ml => ml.key === m.milestone_key)?.share || false,
    }));
    res.json({ milestones });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// POST /api/intelligence/celebrate/:key — mark milestone as celebrated
router.post("/celebrate/:key", requireAuth, (req, res) => {
  try {
    const db = req.app.locals.db;
    db.prepare("UPDATE business_milestones SET celebrated=datetime('now') WHERE user_id=? AND milestone_key=?").run(req.user.id, req.params.key);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});



// ── POST /api/intelligence/morning-cron ── runs at 7am daily ─────────────────
// Called by server cron, sends briefing email + creates notification for each user
router.post("/morning-cron", async (req, res) => {
  // Timing-safe compare + fail-closed if INTERNAL_API_KEY isn't set.
  // Previously this fell back to a literal "dev-key" string, which meant
  // anyone on the internet could trigger the morning-cron to fan out
  // Claude calls + SendGrid emails to every paid user.
  const expected = process.env.INTERNAL_API_KEY || "";
  const provided = req.headers["x-internal-key"] || "";
  if (!expected || provided.length !== expected.length ||
      !require("crypto").timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const db = getDb();
  try {
    const users = db.prepare("SELECT id, name, email, plan FROM users WHERE plan IN ('growth','pro','enterprise') AND email NOT LIKE '%test%'").all();
    const sgKey = getSetting ? getSetting("SENDGRID_API_KEY") : process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.EMAIL_FROM || "hello@takeova.ai";
    const fetch = (await import("node-fetch")).default;
    let sent = 0;

    for (const user of users) {
      try {
        // Build today's priority items
        const today = new Date().toISOString().slice(0,10);
        const priorities = [];

        // Overdue invoices
        try {
          const overdue = db.prepare("SELECT COUNT(*) as c, SUM(total) as t FROM invoices WHERE user_id = ? AND status IN ('sent','overdue') AND due_date < ?").get(user.id, today);
          if (overdue?.c > 0) priorities.push({ dot:'🔴', title: overdue.c + ' overdue invoice' + (overdue.c > 1 ? 's' : ''), detail: '$' + (overdue.t || 0).toFixed(0) + ' outstanding', urgency:'high', panel:'invoices' });
        } catch(e) {}

        // Low bookings today
        try {
          const todayBookings = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE user_id = ? AND date = ?").get(user.id, today);
          if (todayBookings?.c === 0) priorities.push({ dot:'🟡', title:'No bookings today', detail:'Consider sending a same-day promotion', urgency:'medium', panel:'calendar' });
        } catch(e) {}

        // Hot leads
        try {
          const hotLeads = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND score >= 70 AND created_at >= datetime('now','-24 hours')").get(user.id);
          if (hotLeads?.c > 0) priorities.push({ dot:'🟢', title: hotLeads.c + ' new hot lead' + (hotLeads.c > 1 ? 's' : ''), detail:'AI Sales Rep is following up', urgency:'low', panel:'leads' });
        } catch(e) {}

        // Recent AI employee actions
        try {
          const actions = db.prepare("SELECT COUNT(*) as c FROM ai_employee_actions WHERE user_id = ? AND created_at >= datetime('now','-24 hours')").get(user.id);
          if (actions?.c > 0) priorities.push({ dot:'🟢', title: actions.c + ' AI action' + (actions.c > 1 ? 's' : '') + ' overnight', detail:'Your AI employees worked while you slept', urgency:'low', panel:'ai-employees' });
        } catch(e) {}

        // Pending agent actions waiting for approval (READ-ONLY summary — the home Autopilot card owns the actual list + approve/dismiss)
        try {
          const q = db.prepare("SELECT COUNT(*) c FROM autopilot_actions WHERE user_id=? AND status='pending'").get(user.id);
          if (q && q.c > 0) priorities.push({ dot:'⚡', title: q.c + ' action' + (q.c>1?'s':'') + ' ready to approve', detail:'Your AI drafted these — review & approve on your dashboard', urgency:'medium', panel:'overview' });
        } catch(e) {}

        if (!priorities.length) priorities.push({ dot:'✅', title:'All clear — no urgent items today', detail:'Your business is running smoothly', urgency:'low' });

        // Create in-app notification
        try {
          db.exec("CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT, icon TEXT, text TEXT, data TEXT, read INTEGER DEFAULT 0, time TEXT, created_at TEXT DEFAULT (datetime('now')))");
          const highCount = priorities.filter(p => p.urgency === 'high').length;
          const summary = highCount > 0 ? highCount + ' urgent item' + (highCount > 1 ? 's' : '') + ' need your attention' : 'Your morning briefing is ready';
          db.prepare("INSERT OR IGNORE INTO notifications (id, user_id, type, icon, text, data, read, created_at) VALUES (?,?,?,?,?,?,0,datetime('now'))")
            .run(require('crypto').randomUUID(), user.id, 'morning_briefing', '🧠', summary, JSON.stringify({ priorities, date: today }));
        } catch(e) {}

        // Send briefing email
        if (sgKey && user.email) {
          const itemsHtml = priorities.map(p =>
            '<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><table width="100%" cellpadding="0" cellspacing="0"><tr>'
            + '<td width="30" style="font-size:18px;vertical-align:top;padding-top:2px">' + p.dot + '</td>'
            + '<td><div style="font-weight:700;font-size:14px;color:#1e293b">' + p.title + '</div>'
            + (p.detail ? '<div style="font-size:12px;color:#64748b;margin-top:2px">' + p.detail + '</div>' : '')
            + '</td></tr></table></td></tr>'
          ).join('');

          const emailHtml = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 16px">
            <div style="text-align:center;margin-bottom:20px">
              <div style="font-size:32px;margin-bottom:6px">🧠</div>
              <div style="font-weight:900;font-size:22px;color:#1e293b">Good morning, ${user.name?.split(' ')[0] || 'there'}</div>
              <div style="font-size:13px;color:#64748b;margin-top:4px">Here's your TAKEOVA Intelligence briefing for today</div>
            </div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
              <tr><td style="padding:16px;background:#f8fafc">
                <table width="100%" cellpadding="0" cellspacing="0">${itemsHtml}</table>
              </td></tr>
            </table>
            <div style="text-align:center;margin-top:20px">
              <a href="https://takeova.ai/dashboard" style="background:#4F46E5;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block">Open Dashboard →</a>
            </div>
            <div style="text-align:center;margin-top:16px;font-size:11px;color:#94a3b8">TAKEOVA Intelligence · sent daily at 7am · <a href="#" style="color:#94a3b8">unsubscribe</a></div>
          </div>`;

          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: user.email, name: user.name || "" }] }],
              from: { email: fromEmail, name: "TAKEOVA Intelligence" },
              subject: `🧠 Your morning briefing — ${priorities.filter(p=>p.urgency==='high').length > 0 ? priorities.filter(p=>p.urgency==='high').length + ' things need attention' : 'all clear today'}`,
              content: [{ type: "text/html", value: emailHtml }]
            })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
          sent++;
        }
      } catch(e) { console.error("[MorningCron] User " + user.id + ":", e.message); }
    }
    res.json({ success: true, sent, total: users.length });
  } catch(e) {
    console.error("[MorningCron]", e.message);
    console.error("[/morning-cron]", e?.message || e); res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── GET /api/intelligence/briefing ─────────────────────────────────────────────
// Returns today's priorities for the dashboard
// DEAD CODE — duplicate of first handler at line 938; Express never reaches this. Kept for reference; remove or merge when ready.
router.get("/briefing", auth, async (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  const plan = user?.plan || 'starter';
  if (!['growth','pro','enterprise'].includes(plan)) {
    return res.status(403).json({ error: "Daily briefing requires Growth plan or above", upgrade: true });
  }
  const today = new Date().toISOString().slice(0,10);
  const priorities = [];
  try {
    const overdue = db.prepare("SELECT COUNT(*) as c, SUM(total) as t FROM invoices WHERE user_id = ? AND status IN ('sent','overdue') AND due_date < ?").get(req.userId, today);
    if (overdue?.c > 0) priorities.push({ dot:'🔴', title: overdue.c + ' overdue invoice' + (overdue.c>1?'s':''), detail:'$'+parseFloat(overdue.t||0).toFixed(0)+' outstanding', urgency:'high', panel:'invoices' });
  } catch(e) {}
  try {
    const hotLeads = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND score >= 70 AND created_at >= datetime('now','-24 hours')").get(req.userId);
    if (hotLeads?.c > 0) priorities.push({ dot:'🟢', title: hotLeads.c + ' new hot lead'+(hotLeads.c>1?'s':''), detail:'AI Sales Rep following up', urgency:'low', panel:'leads' });
  } catch(e) {}
  try {
    const actions = db.prepare("SELECT COUNT(*) as c FROM ai_employee_actions WHERE user_id = ? AND created_at >= datetime('now','-24 hours')").get(req.userId);
    if (actions?.c > 0) priorities.push({ dot:'🟢', title: actions.c+' AI action'+(actions.c>1?'s':'')+' overnight', detail:'Your AI employees worked while you slept', urgency:'low', panel:'ai-employees' });
    try {
      const _pq = db.prepare("SELECT COUNT(*) c FROM autopilot_actions WHERE user_id=? AND status='pending'").get(req.user.id);
      if (_pq && _pq.c > 0) priorities.push({ dot:'⚡', title: _pq.c+' action'+(_pq.c>1?'s':'')+' ready to approve', detail:'AI-drafted — review & approve on your dashboard', urgency:'medium', panel:'overview' });
    } catch(e) {}
  } catch(e) {}
  res.json({ priorities, date: today, plan });
});

module.exports = router;
module.exports.logEvent               = logEvent;
module.exports.runNightlyIntelligence = runNightlyIntelligence;
module.exports.checkRevenueMilestones  = checkRevenueMilestones;
module.exports.deliverMorningBriefings = deliverMorningBriefings;
module.exports.buildCohortBenchmarks  = buildCohortBenchmarks;
