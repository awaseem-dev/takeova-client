/**
 * TAKEOVA Agency System
 *
 * Agencies onboard clients who pay MINE directly on their own card.
 * Minimum $799/month per client — agency sets the price, MINE collects it.
 * MINE pays the agency 40% of each client's monthly fee as commission.
 * Agency also earns 1.25% of all client transaction volume (half of TAKEOVA's 2.5% fee).
 * AI add-on fees are billed to the CLIENT, not the agency.
 * Every client runs on Enterprise-level caps.
 *   (updated) Model: $799/mo agency seat fee + 60/40 client-fee split — see billing cron below.
 *
 * BILLING MODEL:
 *   Client card:    monthly_fee (min $799) + AI addon line items
 *   Agency earns:  40% of monthly_fee + 1.25% of client transaction volume
 *   MINE keeps:    60% of monthly_fee + 1.25% of client transaction volume + all addon revenue
 *   Payout:        automatic Stripe Connect transfer after billing run
 *
 * Site attribution:
 *   - users.agency_id         links a user to their agency
 *   - users.is_agency_client  flags the user as a managed client
 *   - agency_clients          junction table (agency ↔ user)
 *   - sites.agency_id         direct tag on every site owned by an agency client
 */

"use strict";
const express      = require("express");
const router       = express.Router();
const { v4: uuid } = require("uuid");
const { getDb }    = require("../db/init");
const { auth, adminOnly } = require("../middleware/auth");
const { getSetting } = require("./integrations");

// ── Constants ─────────────────────────────────────────────────────────────────
// Agency pays a $799/month platform fee. Agency clients also pay MINE directly
// (minimum $799/month). Agency earns 40% commission on client fees.
const AGENCY_MONTHLY_FEE   = 799;       // Agency seat fee — charged monthly
const CLIENT_MONTHLY_FEE   = 799;       // Minimum agency-client monthly fee
const AGENCY_REVENUE_SHARE = 0.40;      // Agency keeps 40% of client fee

// Transaction fee split — Option B model (Enterprise-tier 1.0% total).
// MINE collects 1.0% on agency-client sales, splits 50/50 with the agency.
// Standalone Enterprise customers also pay 1.0% (consistent rate).
const AGENCY_CLIENT_TX_PERCENT = 1.0;                              // Total GMV fee on agency-client transactions
const AGENCY_TX_SHARE_PERCENT  = AGENCY_CLIENT_TX_PERCENT / 2;     // Agency's half = 0.5%
// Note: PLATFORM_FEE_PERCENT (2.5%) still applies to NON-agency-client transactions.
const PLATFORM_FEE_PERCENT     = parseFloat(process.env.PLATFORM_FEE_PERCENT || "2.5");

const AI_EMPLOYEE_PRICES = {
  sales:            79,
  support:          79,
  social:           89,
  bookkeeper:       79,
  marketing:        89,
  voice:            99,
  mine_control:     89,
  growth_agent:     89,
  csm:              49,
  legal:            89,
  community:        79,
  prospector_agent: 79,
  proposal_agent:   49,
  cold_email_agent: 69,
  browser_agent:    79,
};

const AI_ADDON_LABELS = {
  sales:            "AI Sales Rep",
  support:          "AI Support Agent",
  social:           "AI Social Manager",
  bookkeeper:       "AI Bookkeeper",
  marketing:        "AI Marketing Manager",
  voice:            "AI Receptionist",
  mine_control:     "Take Control (WhatsApp Agent)",
  growth_agent:     "TAKEOVA Growth Agent",
  csm:              "AI Customer Success",
  legal:            "AI Legal Employee",
  community:        "Community Engagement Agent",
  prospector_agent: "Prospector Agent",
  proposal_agent:   "AI Proposal Agent",
  cold_email_agent: "AI Cold Email Agent",
  browser_agent:    "AI Browser Agent",
};

// ── DB ────────────────────────────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agencies (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT UNIQUE NOT NULL,
      agency_name          TEXT NOT NULL,
      contact_name         TEXT,
      contact_email        TEXT,
      stripe_customer_id   TEXT,
      stripe_subscription_id TEXT,
      status               TEXT DEFAULT 'active',
      stripe_connect_id    TEXT,
      commission_earned    REAL DEFAULT 0,
      commission_paid      REAL DEFAULT 0,
      commission_pending   REAL DEFAULT 0,
      last_billed_at       TEXT,
      seat_fee_paid_total  REAL DEFAULT 0,
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agency_clients (
      id                     TEXT PRIMARY KEY,
      agency_id              TEXT NOT NULL REFERENCES agencies(id),
      user_id                TEXT NOT NULL,
      client_name            TEXT,
      client_email           TEXT,
      monthly_fee            REAL DEFAULT 799,
      status                 TEXT DEFAULT 'active',
      ai_addons              TEXT DEFAULT '[]',
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      billing_start          TEXT DEFAULT (datetime('now')),
      last_billed_at         TEXT,
      created_at             TEXT DEFAULT (datetime('now')),
      updated_at             TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agency_payouts (
      id               TEXT PRIMARY KEY,
      agency_id        TEXT NOT NULL REFERENCES agencies(id),
      period           TEXT NOT NULL,
      client_count     INTEGER DEFAULT 0,
      gross_revenue    REAL DEFAULT 0,
      agency_share     REAL DEFAULT 0,   -- commission + tx fee share
      tx_fee_share     REAL DEFAULT 0,   -- 1.25% of client transaction volume
      mine_share       REAL DEFAULT 0,
      status           TEXT DEFAULT 'pending',
      paid_at          TEXT,
      stripe_payout_id TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agency_clients_agency ON agency_clients(agency_id);
    CREATE INDEX IF NOT EXISTS idx_agency_clients_user   ON agency_clients(user_id);
  `);

  const safe = (sql) => { try { db.exec(sql); } catch(e) {} };
  safe("ALTER TABLE users ADD COLUMN agency_id TEXT");
  safe("ALTER TABLE users ADD COLUMN is_agency_client INTEGER DEFAULT 0");
  safe("ALTER TABLE sites ADD COLUMN agency_id TEXT");
  safe("CREATE INDEX IF NOT EXISTS idx_sites_agency ON sites(agency_id)");
  safe("CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_payouts_period ON agency_payouts(agency_id, period)");
  safe("CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_clients_user ON agency_clients(agency_id, user_id) WHERE status = 'active'");

  // FIX: Add missing billing columns to agency_clients if table was created by auth.js
  // with an incomplete schema before agency routes ran
  safe("ALTER TABLE agency_clients ADD COLUMN stripe_customer_id TEXT");
  safe("ALTER TABLE agency_clients ADD COLUMN stripe_subscription_id TEXT");
  // Agency seat fee tracking ($799/month — Option B model)
  safe("ALTER TABLE agencies ADD COLUMN last_billed_at TEXT");
  safe("ALTER TABLE agencies ADD COLUMN seat_fee_paid_total REAL DEFAULT 0");
  safe("ALTER TABLE agency_clients ADD COLUMN billing_start TEXT DEFAULT (datetime('now'))");
  safe("ALTER TABLE agency_clients ADD COLUMN consent_token_hash TEXT");
  safe("ALTER TABLE agency_clients ADD COLUMN consent_requested_at TEXT");
  safe("ALTER TABLE agency_clients ADD COLUMN consented_at TEXT");
  safe("ALTER TABLE agency_clients ADD COLUMN last_billed_at TEXT");
  safe("ALTER TABLE agency_payouts ADD COLUMN tx_fee_share REAL DEFAULT 0");

  // Backfill sites.agency_id for existing clients
  safe(`UPDATE sites SET agency_id = (
    SELECT u.agency_id FROM users u WHERE u.id = sites.user_id AND u.agency_id IS NOT NULL
  ) WHERE agency_id IS NULL`);
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function agencyAuth(req, res, next) {
  const db = getDb();
  ensureTables(db); // Guarantee tables exist before any query
  const agency = db.prepare(
    "SELECT * FROM agencies WHERE user_id = ? AND status = 'active'"
  ).get(req.userId);
  if (!agency) return res.status(403).json({ error: "Agency account required" });
  req.agency = agency;
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function clientSites(db, userId) {
  return db.prepare(`
    SELECT id, name, domain, custom_domain, status, category,
           views, revenue, leads, logo, created_at, updated_at
    FROM sites WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
}

function tagSites(db, userId, agencyId) {
  db.prepare("UPDATE sites SET agency_id = ? WHERE user_id = ?").run(agencyId, userId);
}

function untagSites(db, userId) {
  db.prepare("UPDATE sites SET agency_id = NULL WHERE user_id = ?").run(userId);
}

function aggregateClients(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.user_id;
    if (!map.has(key)) {
      const client = Object.fromEntries(
        Object.entries(row).filter(([k]) => !k.startsWith("site_"))
      );
      client.sites = [];
      map.set(key, client);
    }
    if (row.site_id) {
      map.get(key).sites.push({
        id:       row.site_id,
        name:     row.site_name,
        domain:   row.site_domain,
        status:   row.site_status,
        views:    row.site_views    || 0,
        revenue:  row.site_revenue  || 0,
        leads:    row.site_leads    || 0,
        logo:     row.site_logo,
        category: row.site_category,
      });
    }
  }
  return Array.from(map.values());
}

// Compute actual monthly gross including all client addons
function computeMonthlyGross(clients) {
  return clients.reduce((total, c) => {
    const addons = JSON.parse(c.ai_addons || "[]");
    const addonTotal = addons.reduce((t, a) => t + (AI_EMPLOYEE_PRICES[a] || 0), 0);
    return total + (c.monthly_fee || CLIENT_MONTHLY_FEE) + addonTotal;
  }, 0);
}

// Disable all AI employees for a user (called on client removal)
function disableClientEmployees(db, userId, agencyAddons) {
  // Only disable roles the agency enabled — preserve any the user set up independently
  try {
    for (const role of (agencyAddons || [])) {
      db.prepare(
        "UPDATE ai_employees SET enabled = 0, updated_at = datetime('now') WHERE user_id = ? AND role = ?"
      ).run(userId, role);
    }
  } catch(e) { /* ai_employees table may not exist yet */ }
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
router.post("/register", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { agency_name, contact_name } = req.body;
    if (!agency_name?.trim()) return res.status(400).json({ error: "Agency name required" });

    const existing = db.prepare("SELECT id FROM agencies WHERE user_id = ?").get(req.userId);
    if (existing) return res.status(409).json({ error: "Agency account already exists" });

    const user = db.prepare("SELECT email, name, is_agency_client, plan, subscription_status, stripe_subscription_id FROM users WHERE id = ?").get(req.userId);
    if (user?.is_agency_client) {
      return res.status(403).json({ error: "Your account is managed by an agency and cannot register as one" });
    }
    // Agency access is a paid plan — require an active Agency subscription before granting it.
    const paidForAgency = user && user.plan === 'agency' &&
      (user.subscription_status === 'active' || user.subscription_status === 'trialing' || !!user.stripe_subscription_id);
    if (!paidForAgency) {
      return res.status(403).json({
        error: "An active Agency subscription is required before creating an agency account. Please subscribe to the Agency plan first.",
        requiresUpgrade: true,
        plan: "agency"
      });
    }
    const id = uuid();

    db.prepare(`INSERT INTO agencies (id, user_id, agency_name, contact_name, contact_email)
                VALUES (?, ?, ?, ?, ?)`)
      .run(id, req.userId, agency_name.trim(),
           contact_name || user?.name || "", user?.email || "");

    db.prepare("UPDATE users SET role = 'agency', plan = 'enterprise' WHERE id = ?").run(req.userId);

    res.json({ success: true, agency_id: id });

    // Send agency welcome email
    try {
      const sgKey     = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
      const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
      const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
      const agencyUser = db.prepare("SELECT name, email FROM users WHERE id = ?").get(req.userId);
      const agencyName = agency_name || (agencyUser && agencyUser.name) || "Your Agency";
      const toEmail    = agencyUser && agencyUser.email;

      if (sgKey && toEmail) {
        const fetch = (await import("node-fetch")).default;
        const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:0 auto;padding:32px 16px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0A0F1E,#1e3a5f);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;font-weight:900;color:#4F46E5;letter-spacing:-.5px;margin-bottom:4px">MINE<span style="color:#fff">.</span></div>
    <div style="color:rgba(255,255,255,.7);font-size:13px">Agency Partner</div>
    <div style="margin-top:20px;font-size:22px;font-weight:800;color:#fff">Welcome to TAKEOVA Agency, ${agencyName}! 🎉</div>
    <div style="color:rgba(255,255,255,.7);font-size:14px;margin-top:8px;line-height:1.6">You're now set up as a TAKEOVA Agency partner.<br>Here's exactly how your business works.</div>
  </div>

  <!-- What you get -->
  <div style="background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:24px;margin-bottom:16px">
    <div style="font-weight:800;font-size:16px;color:#111827;margin-bottom:16px">🏗️ What you get as an agency</div>
    <div style="display:grid;gap:12px">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <span style="font-size:20px;flex-shrink:0">💼</span>
        <div><div style="font-weight:700;font-size:14px;color:#111827">Enterprise account for your own business</div><div style="font-size:12px;color:#6B7280;margin-top:2px">Use all of TAKEOVA's features — AI site builder, bookings, CRM, email, AI employees — for your own agency. No extra charge.</div></div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        <span style="font-size:20px;flex-shrink:0">👥</span>
        <div><div style="font-weight:700;font-size:14px;color:#111827">Unlimited client accounts</div><div style="font-size:12px;color:#6B7280;margin-top:2px">Add as many clients as you want. Each gets a full MINE Enterprise dashboard you manage on their behalf.</div></div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        <span style="font-size:20px;flex-shrink:0">🔍</span>
        <div><div style="font-weight:700;font-size:14px;color:#111827">Business Audit tool</div><div style="font-size:12px;color:#6B7280;margin-top:2px">AI analyses any business across 10 dimensions, maps every gap to a TAKEOVA feature, generates a branded PDF report — your best closing tool.</div></div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        <span style="font-size:20px;flex-shrink:0">🚀</span>
        <div><div style="font-weight:700;font-size:14px;color:#111827">AI Prospector</div><div style="font-size:12px;color:#6B7280;margin-top:2px">Finds local businesses, builds them a free demo site, sends personalised outreach automatically. Your agency runs itself.</div></div>
      </div>
    </div>
  </div>

  <!-- How you earn -->
  <div style="background:linear-gradient(135deg,rgba(79,70,229,.06),rgba(99,91,255,.03));border:1.5px solid rgba(79,70,229,.2);border-radius:14px;padding:24px;margin-bottom:16px">
    <div style="font-weight:800;font-size:16px;color:#111827;margin-bottom:16px">💰 How you earn — two income streams</div>

    <div style="background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-weight:700;font-size:14px;color:#111827">40% Monthly Commission</div>
        <div style="background:#DCFCE7;color:#166534;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">Primary</div>
      </div>
      <div style="font-size:12px;color:#6B7280;line-height:1.6;margin-bottom:10px">You earn 40% of whatever you charge each client per month — forever, automatically, paid on the 1st via Stripe Connect.</div>
      <div style="background:#F9FAFB;border-radius:8px;padding:12px">
        <div style="font-size:11px;font-weight:700;color:#9CA3AF;margin-bottom:6px">EXAMPLE</div>
        <div style="font-size:13px;color:#111827">10 clients × $999/mo = <strong>$9,990 gross</strong></div>
        <div style="font-size:13px;color:#16A34A;font-weight:700">Your 40% = $3,996/mo</div>
      </div>
    </div>

    <div style="background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-weight:700;font-size:14px;color:#111827">1.25% Transaction Share</div>
        <div style="background:#FFEDD5;color:#C2410C;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">Bonus</div>
      </div>
      <div style="font-size:12px;color:#6B7280;line-height:1.6;margin-bottom:10px">MINE charges your clients 2.5% on every sale they make. You earn half — 1.25% of all your clients' combined transaction volume each month.</div>
      <div style="background:#F9FAFB;border-radius:8px;padding:12px">
        <div style="font-size:11px;font-weight:700;color:#9CA3AF;margin-bottom:6px">EXAMPLE</div>
        <div style="font-size:13px;color:#111827">10 clients × $15,000 avg sales = $150k total</div>
        <div style="font-size:13px;color:#EA580C;font-weight:700">Your 1.25% = $1,875/mo extra</div>
      </div>
    </div>
  </div>

  <!-- Combined example -->
  <div style="background:#0A0F1E;border-radius:14px;padding:24px;margin-bottom:16px;color:#fff">
    <div style="font-weight:800;font-size:15px;margin-bottom:14px">💸 Combined income with 10 clients</div>
    <div style="display:grid;gap:8px">
      <div style="display:flex;justify-content:space-between;font-size:13px"><span style="color:rgba(255,255,255,.7)">Commission (40% of $9,990)</span><span style="font-weight:700">$3,996</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px"><span style="color:rgba(255,255,255,.7)">Transaction share (1.25% of $150k)</span><span style="font-weight:700">$1,875</span></div>
      <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:900;border-top:1px solid rgba(255,255,255,.15);padding-top:10px;margin-top:4px"><span>Monthly total</span><span style="color:#4ADE80">$5,871</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px"><span style="color:rgba(255,255,255,.5)">Annual total</span><span style="color:rgba(255,255,255,.7);font-weight:600">$70,452</span></div>
    </div>
  </div>

  <!-- Get started steps -->
  <div style="background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:24px;margin-bottom:16px">
    <div style="font-weight:800;font-size:16px;color:#111827;margin-bottom:16px">🚀 Get your first client in 7 days</div>
    <div style="display:grid;gap:14px">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="width:26px;height:26px;border-radius:50%;background:#4F46E5;color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">1</div>
        <div><div style="font-weight:700;font-size:13px;color:#111827">Run a Business Audit on a local prospect</div><div style="font-size:12px;color:#6B7280;margin-top:2px">Go to Business Audit → enter their name and URL → AI generates a full report in 30 seconds.</div></div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="width:26px;height:26px;border-radius:50%;background:#4F46E5;color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">2</div>
        <div><div style="font-weight:700;font-size:13px;color:#111827">Download the PDF and book a meeting</div><div style="font-size:12px;color:#6B7280;margin-top:2px">Walk in with hard data: "Your business is losing $8,400/month because of these 8 gaps — here's how we fix them."</div></div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="width:26px;height:26px;border-radius:50%;background:#4F46E5;color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">3</div>
        <div><div style="font-weight:700;font-size:13px;color:#111827">Add them as a client in MINE</div><div style="font-size:12px;color:#6B7280;margin-top:2px">Use Add Client → set their monthly fee → MINE bills them, you earn 40% automatically.</div></div>
      </div>
    </div>
  </div>

  <!-- CTA -->
  <div style="text-align:center;margin-bottom:24px">
    <a href="${frontendUrl}/frontend/public/agency-dashboard.html" style="display:inline-block;background:linear-gradient(135deg,#4F46E5,#6366F1);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px">Open My Agency Dashboard →</a>
  </div>

  <div style="text-align:center;color:#9CA3AF;font-size:12px">
    MINE · takeova.ai · Questions? Reply to this email anytime.<br>
    <a href="${frontendUrl}" style="color:#9CA3AF">takeova.ai</a>
  </div>
</div>
</body>
</html>`;

        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + sgKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: toEmail, name: agencyUser.name || agencyName }] }],
            from: { email: fromEmail, name: "TAKEOVA Agency" },
            subject: "Welcome to TAKEOVA Agency — here's how your earnings work 💰",
            content: [{ type: "text/html", value: emailHtml }]
          })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
    } catch(emailErr) {
      console.warn("[Agency Welcome Email]", emailErr.message);
      // Non-fatal — agency is still registered
    }

  } catch(e) {
    console.error("[Agency] Register:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get("/dashboard", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const agency = req.agency;

    const rawRows = db.prepare(`
      SELECT
        ac.id, ac.user_id, ac.client_name, ac.client_email, ac.monthly_fee,
        ac.status, ac.ai_addons, ac.last_billed_at, ac.created_at,
        u.name      AS user_name,  u.email     AS user_email,
        u.plan      AS user_plan,  u.emails_sent,
        u.created_at AS joined_at,
        s.id        AS site_id,    s.name      AS site_name,
        s.domain    AS site_domain, s.status   AS site_status,
        s.views     AS site_views, s.revenue   AS site_revenue,
        s.leads     AS site_leads, s.logo      AS site_logo,
        s.category  AS site_category
      FROM agency_clients ac
      LEFT JOIN users u ON u.id = ac.user_id
      LEFT JOIN sites s ON s.user_id = ac.user_id
      WHERE ac.agency_id = ? AND ac.status = 'active'
      ORDER BY ac.created_at DESC
    `).all(agency.id);

    const clients    = aggregateClients(rawRows);
    const activeCount = clients.length;
    const allSites   = clients.flatMap(c => c.sites);

    const monthlyGross = computeMonthlyGross(clients);
    // Agency earns 40% of each client's actual monthly_fee
    const monthlyAgencyShare = clients.reduce((t, c) => t + (c.monthly_fee || CLIENT_MONTHLY_FEE) * AGENCY_REVENUE_SHARE, 0);

    const recentPayouts = db.prepare(`
      SELECT * FROM agency_payouts WHERE agency_id = ?
      ORDER BY created_at DESC LIMIT 6
    `).all(agency.id);

    res.json({
      agency: {
        id:                    agency.id,
        name:                  agency.agency_name,
        status:                agency.status,
        activeClients:         activeCount,
        totalSites:            allSites.length,
        liveSites:             allSites.filter(s => s.status === "live").length,
        totalPortfolioRevenue: allSites.reduce((t, s) => t + (s.revenue || 0), 0),
        totalPortfolioViews:   allSites.reduce((t, s) => t + (s.views   || 0), 0),
        clientFee:             CLIENT_MONTHLY_FEE,
        revenueShare:          AGENCY_REVENUE_SHARE,
        monthlyGrossRevenue:   monthlyGross,
        monthlyAgencyEarnings: monthlyAgencyShare,
        commissionEarned:      agency.commission_earned,
        commissionPaid:        agency.commission_paid,
        commissionPending:     agency.commission_pending,
        // Seat fee (Option B): $799/mo platform subscription
        seatFeeMonthly:        AGENCY_MONTHLY_FEE,
        seatFeeSetup:          !!agency.stripe_customer_id,
        seatFeeLastBilled:     agency.last_billed_at || null,
        seatFeePaidTotal:      agency.seat_fee_paid_total || 0,
      },
      clients,
      recentPayouts,
    });
  } catch(e) {
    console.error("[Agency] Dashboard:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── ALL CLIENTS ───────────────────────────────────────────────────────────────
router.get("/clients", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const rawRows = db.prepare(`
      SELECT
        ac.id, ac.user_id, ac.client_name, ac.client_email, ac.monthly_fee,
        ac.status, ac.ai_addons, ac.last_billed_at, ac.created_at,
        u.name AS user_name, u.email AS user_email,
        u.plan AS user_plan, u.emails_sent, u.created_at AS user_created,
        s.id       AS site_id,    s.name    AS site_name,
        s.domain   AS site_domain, s.status AS site_status,
        s.views    AS site_views,  s.revenue AS site_revenue,
        s.leads    AS site_leads,  s.logo    AS site_logo,
        s.category AS site_category
      FROM agency_clients ac
      LEFT JOIN users u ON u.id = ac.user_id
      LEFT JOIN sites s ON s.user_id = ac.user_id
      WHERE ac.agency_id = ? AND ac.status = 'active'
      ORDER BY ac.created_at DESC
    `).all(req.agency.id);
    res.json({ clients: aggregateClients(rawRows) });
  } catch(e) {
    console.error("[Agency] List clients:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── ALL SITES ACROSS ALL CLIENTS ──────────────────────────────────────────────
router.get("/sites", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const sites = db.prepare(`
      SELECT s.*,
             u.name  AS owner_name,  u.email AS owner_email,
             ac.id   AS client_record_id, ac.client_name
      FROM sites s
      JOIN users u           ON u.id  = s.user_id
      JOIN agency_clients ac ON ac.user_id = s.user_id
                             AND ac.agency_id = ?
                             AND ac.status = 'active'
      ORDER BY s.created_at DESC
    `).all(req.agency.id);

    const totals = {
      count:        sites.length,
      live:         sites.filter(s => s.status === "live").length,
      totalViews:   sites.reduce((t, s) => t + (s.views   || 0), 0),
      totalRevenue: sites.reduce((t, s) => t + (s.revenue || 0), 0),
      totalLeads:   sites.reduce((t, s) => t + (s.leads   || 0), 0),
    };
    res.json({ sites, totals });
  } catch(e) {
    console.error("[Agency] All sites:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── INVITE / ONBOARD CLIENT ───────────────────────────────────────────────────
router.post("/clients/invite", auth, agencyAuth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { email, client_name, ai_addons } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: "Client email required" });

    const cleanEmail = email.toLowerCase().trim();
    let clientUser = db.prepare("SELECT id, email, name, agency_id, is_agency_client FROM users WHERE email = ?").get(cleanEmail);
    let isNewUser  = false;

    if (!clientUser) {
      const bcrypt  = require("bcryptjs");
      const hash    = await bcrypt.hash(uuid().split("-")[0], 12);
      const userId  = uuid();
      const refCode = uuid().split("-")[0].toUpperCase();
      db.prepare(`
        INSERT INTO users (id, email, name, password_hash, referral_code, plan, trial_ends_at, created_at)
        VALUES (?, ?, ?, ?, ?, 'enterprise', datetime('now','+36500 days'), datetime('now'))
      `).run(userId, cleanEmail, client_name || cleanEmail.split("@")[0], hash, refCode);
      clientUser = { id: userId, email: cleanEmail, name: client_name || "", agency_id: null };
      isNewUser  = true;
      // Create a set-password token so they can activate via email link (not a broken signup page).
      // Store only the SHA-256 hash — matches auth.js password-reset hardening.
      // The raw token is sent in the email link below.
      db.exec("CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
      const inviteToken = uuid().replace(/-/g, "");
      const inviteTokenHash = require("crypto").createHash("sha256").update(inviteToken).digest("hex");
      db.prepare("INSERT OR IGNORE INTO password_resets (id, user_id, token, expires_at) VALUES (?, ?, ?, datetime('now','+7 days'))").run(uuid(), userId, inviteTokenHash);
      clientUser._inviteToken = inviteToken;
    } else {
      // FIX: Block if already managed by a different agency
      if (clientUser.is_agency_client && clientUser.agency_id && clientUser.agency_id !== req.agency.id) {
        return res.status(409).json({ error: "This user is already managed by another agency" });
      }
      // P0 #4 consent gate: no changes to an existing account until they ACCEPT (see /consent endpoints)
    }

    const alreadyClient = db.prepare(
      "SELECT id FROM agency_clients WHERE agency_id = ? AND user_id = ? AND status = 'active'"
    ).get(req.agency.id, clientUser.id);
    if (alreadyClient) return res.status(409).json({ error: "Client already in your agency" });

    const clientId = uuid();
    // Validate and apply custom price (minimum $799)
    const customFee = req.body.monthly_fee ? parseFloat(req.body.monthly_fee) : CLIENT_MONTHLY_FEE;
    const monthlyFee = isNaN(customFee) || customFee < CLIENT_MONTHLY_FEE ? CLIENT_MONTHLY_FEE : Math.round(customFee * 100) / 100;

      // ── P0 #4 CONSENT GATE: existing accounts must explicitly accept ──
      if (!isNewUser) {
        const _crypto = require("crypto");
        const consentToken = _crypto.randomBytes(24).toString("hex");
        const consentHash  = _crypto.createHash("sha256").update(consentToken).digest("hex");
        db.prepare(`
          INSERT INTO agency_clients (id, agency_id, user_id, client_name, client_email, ai_addons, monthly_fee, status, consent_token_hash, consent_requested_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'invited', ?, datetime('now'))
        `).run(clientId, req.agency.id, clientUser.id,
               client_name || clientUser.name, cleanEmail,
               JSON.stringify(ai_addons || []), monthlyFee, consentHash);
        try {
          const sgKey      = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
          const fromEmail  = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
          const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
          const acceptUrl  = `${frontendUrl}/api/agency/consent/accept?token=${consentToken}`;
          const declineUrl = `${frontendUrl}/api/agency/consent/decline?token=${consentToken}`;
          if (sgKey) {
            const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
            await fetch("https://api.sendgrid.com/v3/mail/send", {
              method: "POST",
              headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
              body: JSON.stringify({
                personalizations: [{ to: [{ email: cleanEmail }] }],
                from: { email: fromEmail, name: req.agency.agency_name },
                subject: `${req.agency.agency_name} wants to manage your TAKEOVA account`,
                content: [{ type: "text/html", value: `
                  <div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:32px">
                    <h2>${req.agency.agency_name} has invited you</h2>
                    <p style="color:#444;line-height:1.65">They would like to manage your TAKEOVA account as their client. You would get enterprise-level access, and they would run your business platform and bill you $${monthlyFee}/month. <b>Nothing changes unless you accept.</b> If you have your own TAKEOVA subscription, accepting will stop it at the end of its current period so you are never billed twice.</p>
                    <p style="margin:26px 0"><a href="${acceptUrl}" style="background:#059669;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700">Accept invitation</a>&nbsp;&nbsp;<a href="${declineUrl}" style="color:#94a3b8;padding:13px 10px;text-decoration:none">Decline</a></p>
                    <p style="color:#999;font-size:12px">This invitation expires in 7 days. If you were not expecting it, decline or ignore this email — your account is untouched.</p>
                  </div>` }],
              }),
            });
          }
        } catch (e) { console.error("[AgencyInvite] consent email failed:", e.message); }
        return res.json({ ok: true, pending: true, client_id: clientId,
          message: "Invitation sent — this user already has a TAKEOVA account, so they must accept before joining your agency." });
      }

    db.prepare(`
      INSERT INTO agency_clients (id, agency_id, user_id, client_name, client_email, ai_addons, monthly_fee)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(clientId, req.agency.id, clientUser.id,
           client_name || clientUser.name, cleanEmail,
           JSON.stringify(ai_addons || []), monthlyFee);

    db.prepare(
      "UPDATE users SET agency_id = ?, is_agency_client = 1, plan = 'enterprise' WHERE id = ?"
    ).run(req.agency.id, clientUser.id);

    tagSites(db, clientUser.id, req.agency.id);

    // Send welcome email to client
    try {
      const sgKey      = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
      const fromEmail  = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
      const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
      const code       = req.agency.id.split("-")[0].toUpperCase();
      const signupUrl  = `${frontendUrl}/agency-invite.html?code=${code}&agency=${encodeURIComponent(req.agency.agency_name)}`;
      const loginUrl   = `${frontendUrl}/?auth=login`;
      // New users: link directly to password-reset so they can set their own password
      // without hitting the "already registered" error on the signup page
      const setPasswordUrl = clientUser._inviteToken
        ? `${frontendUrl}/?reset_token=${clientUser._inviteToken}`
        : signupUrl;
      const ctaUrl     = isNewUser ? setPasswordUrl : loginUrl;
      const ctaLabel   = isNewUser ? "Set Your Password & Get Started →" : "Log In to Your Dashboard →";
      const emailSubject = isNewUser
        ? `You've been invited to ${req.agency.agency_name}'s business platform`
        : `${req.agency.agency_name} has added you to their agency`;
      const emailBody  = isNewUser
        ? `${req.agency.agency_name} has set up a full business platform for you — website builder, e-commerce, bookings, CRM, AI tools, and more.`
        : `${req.agency.agency_name} has connected your existing TAKEOVA account. You now have enterprise-level access — log in to see your upgraded dashboard.`;
      if (sgKey) {
        const fetch = (...a) => import("node-fetch").then(m => m.default(...a));
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: cleanEmail }] }],
            from: { email: fromEmail, name: req.agency.agency_name },
            subject: emailSubject,
            content: [{ type: "text/html", value: `
              <div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:32px">
                <h2>${isNewUser ? "Welcome to your new business platform 🎉" : "You've been added to an agency 🏢"}</h2>
                <p>${emailBody}</p>
                <div style="text-align:center;margin:32px 0">
                  <a href="${ctaUrl}" style="display:inline-block;background:#2563EB;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px">${ctaLabel}</a>
                </div>
                <p style="color:#94a3b8;font-size:12px;text-align:center">Managed by ${req.agency.agency_name}</p>
              </div>` }]
          })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
    } catch(e) { /* non-fatal */ }

    res.json({
      success:     true,
      client_id:   clientId,
      user_id:     clientUser.id,
      is_new_user: isNewUser,
      message:     `${client_name || cleanEmail} added. Welcome email sent.`,
    });
  } catch(e) {
    console.error("[Agency] Invite client:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── SINGLE CLIENT ─────────────────────────────────────────────────────────────
router.get("/clients/:id", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const client = db.prepare(`
      SELECT ac.*, u.name, u.email, u.plan, u.emails_sent, u.email_limit,
             u.created_at AS joined
      FROM agency_clients ac
      LEFT JOIN users u ON u.id = ac.user_id
      WHERE ac.id = ? AND ac.agency_id = ?
    `).get(req.params.id, req.agency.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const sites  = clientSites(db, client.user_id);
    const orders = db.prepare(
      "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
    ).all(client.user_id);
    const contactCount = (() => {
      try { return db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?").get(client.user_id)?.n || 0; }
      catch(e) { return 0; }
    })();
    const usage = db.prepare("SELECT emails_sent, email_limit FROM users WHERE id = ?").get(client.user_id);
    const siteStats = {
      total:        sites.length,
      live:         sites.filter(s => s.status === "live").length,
      totalViews:   sites.reduce((t, s) => t + (s.views   || 0), 0),
      totalRevenue: sites.reduce((t, s) => t + (s.revenue || 0), 0),
      totalLeads:   sites.reduce((t, s) => t + (s.leads   || 0), 0),
    };
    res.json({ client, sites, orders, usage, siteStats, contactCount });
  } catch(e) {
    console.error("[Agency] Client detail:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── BUILD SITE ON BEHALF OF CLIENT ────────────────────────────────────────────
router.post("/clients/:id/sites", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const client = db.prepare(
      "SELECT user_id FROM agency_clients WHERE id = ? AND agency_id = ? AND status = 'active'"
    ).get(req.params.id, req.agency.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const { name, category, template, html, css } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Site name required" });

    const siteId = uuid();
    db.prepare(`
      INSERT INTO sites
        (id, user_id, agency_id, name, category, template, html, css, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', datetime('now'), datetime('now'))
    `).run(siteId, client.user_id, req.agency.id,
           name.trim(), category || "general", template || "", html || "", css || "");

    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
    res.json({ success: true, site });
  } catch(e) {
    console.error("[Agency] Create site:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── TOGGLE AI EMPLOYEE FOR A CLIENT ──────────────────────────────────────────
router.post("/clients/:id/employees/:role", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { enabled } = req.body;
    const role = req.params.role;

    if (!AI_EMPLOYEE_PRICES[role]) {
      return res.status(400).json({ error: `Unknown AI employee role: ${role}` });
    }

    const client = db.prepare(
      "SELECT * FROM agency_clients WHERE id = ? AND agency_id = ? AND status = 'active'"
    ).get(req.params.id, req.agency.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const currentAddons = JSON.parse(client.ai_addons || "[]");
    const newAddons = enabled
      ? (currentAddons.includes(role) ? currentAddons : [...currentAddons, role])
      : currentAddons.filter(a => a !== role);

    db.prepare("UPDATE agency_clients SET ai_addons = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(newAddons), client.id);

    // Mirror the change on the ai_employees record in the client's account
    db.exec(`CREATE TABLE IF NOT EXISTS ai_employees (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
      enabled INTEGER DEFAULT 1, rules TEXT DEFAULT '[]',
      schedule TEXT DEFAULT '{}', autonomy TEXT DEFAULT 'semi',
      tone TEXT DEFAULT 'professional', custom_name TEXT,
      business_context TEXT, email_signature TEXT, policies TEXT,
      brand_voice TEXT, inspiration_media TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    const existing = db.prepare(
      "SELECT id FROM ai_employees WHERE user_id = ? AND role = ?"
    ).get(client.user_id, role);

    if (enabled) {
      if (existing) {
        db.prepare("UPDATE ai_employees SET enabled = 1, updated_at = datetime('now') WHERE id = ?")
          .run(existing.id);
      } else {
        const { v4: empUuid } = require("uuid");
        db.prepare(`INSERT INTO ai_employees
          (id, user_id, role, enabled, rules, schedule, autonomy, tone, created_at, updated_at)
          VALUES (?, ?, ?, 1, '[]', '{}', 'semi', 'professional', datetime('now'), datetime('now'))`)
          .run(empUuid(), client.user_id, role);
      }
    } else {
      if (existing) {
        db.prepare("UPDATE ai_employees SET enabled = 0, updated_at = datetime('now') WHERE id = ?")
          .run(existing.id);
      }
    }

    const monthlyAddonCost = newAddons.reduce((t, a) => t + (AI_EMPLOYEE_PRICES[a] || 0), 0);
    res.json({
      success:          true,
      role,
      enabled:          !!enabled,
      activeAddons:     newAddons,
      addonMonthlyCost: monthlyAddonCost,
      totalClientCost:  CLIENT_MONTHLY_FEE + monthlyAddonCost,
      message: enabled
        ? `${AI_ADDON_LABELS[role]} activated for ${client.client_name}. Billed to their card monthly.`
        : `${AI_ADDON_LABELS[role]} deactivated for ${client.client_name}.`,
    });
  } catch(e) {
    console.error("[Agency] Toggle employee:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── BULK UPDATE ADD-ONS ──────────────────────────────────────────────────────
// Replaces the full ai_addons array in one call — useful for bulk changes
router.put("/clients/:id/addons", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { ai_addons } = req.body;
    if (!Array.isArray(ai_addons)) return res.status(400).json({ error: "ai_addons must be an array" });
    const invalid = ai_addons.filter(r => !AI_EMPLOYEE_PRICES[r]);
    if (invalid.length) return res.status(400).json({ error: `Unknown roles: ${invalid.join(", ")}` });
    const client = db.prepare(
      "SELECT id FROM agency_clients WHERE id = ? AND agency_id = ? AND status = 'active'"
    ).get(req.params.id, req.agency.id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    const currentClient = db.prepare("SELECT ai_addons, user_id FROM agency_clients WHERE id = ?").get(req.params.id);
    const oldAddons = JSON.parse(currentClient?.ai_addons || "[]");
    db.prepare("UPDATE agency_clients SET ai_addons = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(ai_addons), req.params.id);
    // Sync ai_employees table — enable newly added, disable removed
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ai_employees (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, rules TEXT DEFAULT '[]',
        schedule TEXT DEFAULT '{}', autonomy TEXT DEFAULT 'semi',
        tone TEXT DEFAULT 'professional', custom_name TEXT,
        business_context TEXT, email_signature TEXT, policies TEXT,
        brand_voice TEXT, inspiration_media TEXT,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      )`);
      const { v4: empUuid } = require("uuid");
      for (const role of ai_addons) {
        if (oldAddons.includes(role)) continue; // no change
        const existing = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = ?").get(currentClient.user_id, role);
        if (existing) db.prepare("UPDATE ai_employees SET enabled = 1, updated_at = datetime('now') WHERE id = ?").run(existing.id);
        else db.prepare("INSERT INTO ai_employees (id, user_id, role, enabled, rules, schedule, autonomy, tone, created_at, updated_at) VALUES (?, ?, ?, 1, '[]', '{}', 'semi', 'professional', datetime('now'), datetime('now'))").run(empUuid(), currentClient.user_id, role);
      }
      for (const role of oldAddons) {
        if (ai_addons.includes(role)) continue; // no change
        const existing = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = ?").get(currentClient.user_id, role);
        if (existing) db.prepare("UPDATE ai_employees SET enabled = 0, updated_at = datetime('now') WHERE id = ?").run(existing.id);
      }
    } catch(e) { /* non-fatal */ }
    res.json({ success: true, ai_addons });
  } catch(e) {
    console.error("[Agency] Bulk update addons:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── REMOVE CLIENT ─────────────────────────────────────────────────────────────
router.delete("/clients/:id", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const client = db.prepare(
      "SELECT * FROM agency_clients WHERE id = ? AND agency_id = ?"
    ).get(req.params.id, req.agency.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    db.prepare("UPDATE agency_clients SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    db.prepare("UPDATE users SET agency_id = NULL, is_agency_client = 0, plan = 'starter' WHERE id = ?")
      .run(client.user_id);
    untagSites(db, client.user_id);
    // FIX: Disable all AI employees so they stop running after removal
    disableClientEmployees(db, client.user_id, JSON.parse(client.ai_addons || "[]"));

    res.json({ success: true, message: "Client removed." });
  } catch(e) {
    console.error("[Agency] Remove client:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── CLIENT PAYMENT SETUP ─────────────────────────────────────────────────────
// Called after a client signs up via invite link.
// Creates a Stripe Checkout session in setup mode so the client can save
// their card. On completion the webhook saves stripe_customer_id to the user.
// The first $799 charge fires on the next billing cycle.
router.post("/clients/:id/setup-payment", auth, agencyAuth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const client = db.prepare(
      "SELECT ac.*, u.email, u.name, u.stripe_customer_id AS user_stripe_id FROM agency_clients ac LEFT JOIN users u ON u.id = ac.user_id WHERE ac.id = ? AND ac.agency_id = ? AND ac.status = 'active'"
    ).get(req.params.id, req.agency.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
    if (!stripeKey) return res.status(500).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);

    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

    // Ensure Stripe customer exists for this client
    let stripeCustomerId = client.stripe_customer_id || client.user_stripe_id;
    if (!stripeCustomerId) {
      const cu = await stripe.customers.create({
        email: client.client_email,
        name:  client.client_name || client.name,
        metadata: { mine_user: client.user_id, agency_id: req.agency.id },
      });
      stripeCustomerId = cu.id;
      // Save to both tables
      db.prepare("UPDATE agency_clients SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, client.id);
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, client.user_id);
    }

    // Checkout in setup mode — saves card, no charge now
    const session = await stripe.checkout.sessions.create({
      customer:    stripeCustomerId,
      mode:        "setup",
      payment_method_types: ["card"],
      success_url: `${frontendUrl}/?setup=complete&client=${client.id}`,
      cancel_url:  `${frontendUrl}/?setup=cancelled`,
      metadata: {
        mine_agency_client: client.id,
        mine_user:          client.user_id,
        mine_agency:        req.agency.id,
        type:               "agency_client_setup",
      },
    });

    res.json({ url: session.url, session_id: session.id });
  } catch(e) {
    console.error("[Agency] Setup payment:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Public version — called from the client's own dashboard (not agency auth)
// so the client themselves can add/update their payment method
router.post("/payment-setup", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    // Must be an agency client
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND is_agency_client = 1").get(req.userId);
    if (!user) return res.status(403).json({ error: "Agency client account required" });

    const client = db.prepare(
      "SELECT * FROM agency_clients WHERE user_id = ? AND status = 'active'"
    ).get(req.userId);
    if (!client) return res.status(404).json({ error: "Agency client record not found" });

    const agency = db.prepare("SELECT * FROM agencies WHERE id = ?").get(client.agency_id);

    const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
    if (!stripeKey) return res.status(500).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);
    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

    let stripeCustomerId = client.stripe_customer_id || user.stripe_customer_id;
    if (!stripeCustomerId) {
      const cu = await stripe.customers.create({
        email: user.email, name: user.name,
        metadata: { mine_user: user.id, agency_id: client.agency_id },
      });
      stripeCustomerId = cu.id;
      db.prepare("UPDATE agency_clients SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, client.id);
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode:     "setup",
      payment_method_types: ["card"],
      success_url: `${frontendUrl}/?setup=complete`,
      cancel_url:  `${frontendUrl}/?setup=cancelled`,
      metadata: {
        mine_agency_client: client.id,
        mine_user:          user.id,
        mine_agency:        client.agency_id,
        type:               "agency_client_setup",
      },
    });

    res.json({ url: session.url, session_id: session.id });
  } catch(e) {
    console.error("[Agency] Client payment setup:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── SETUP AGENCY SEAT FEE PAYMENT ─────────────────────────────────────────────
// Sets up the agency's own $799/month subscription card.
// Called from the agency dashboard after registration.
// Creates a Stripe Checkout session in setup mode — saves card, no charge yet.
// Monthly $799 charge fires on the 1st via /cron/bill.
router.post("/seat-fee/setup", auth, agencyAuth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
    if (!stripeKey) return res.status(500).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);
    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

    // Ensure Stripe customer for the agency
    let stripeCustomerId = req.agency.stripe_customer_id;
    if (!stripeCustomerId) {
      const cu = await stripe.customers.create({
        email: req.agency.contact_email,
        name:  req.agency.agency_name,
        metadata: { mine_agency: req.agency.id, type: "agency_seat" },
      });
      stripeCustomerId = cu.id;
      db.prepare("UPDATE agencies SET stripe_customer_id = ? WHERE id = ?")
        .run(stripeCustomerId, req.agency.id);
    }

    // Checkout session in setup mode — saves card, doesn't charge
    const session = await stripe.checkout.sessions.create({
      customer:    stripeCustomerId,
      mode:        "setup",
      payment_method_types: ["card"],
      success_url: `${frontendUrl}/?seat_fee_setup=complete`,
      cancel_url:  `${frontendUrl}/?seat_fee_setup=cancelled`,
      metadata: {
        mine_agency: req.agency.id,
        type:        "agency_seat_fee_setup",
      },
    });

    res.json({ url: session.url, session_id: session.id, monthly_fee: AGENCY_MONTHLY_FEE });
  } catch(e) {
    console.error("[Agency] Seat fee setup:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── SET CLIENT MONTHLY PRICE ─────────────────────────────────────────────────
// Agency can charge clients anything above the $799 minimum.
// Commission (40%) is always calculated on whatever price is set.
// Minimum enforced server-side so it can never be bypassed.
router.put("/clients/:id/price", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const { monthly_fee } = req.body;
    const fee = parseFloat(monthly_fee);

    if (isNaN(fee) || fee < CLIENT_MONTHLY_FEE) {
      return res.status(400).json({
        error: `Minimum price is $${CLIENT_MONTHLY_FEE}/month`,
        minimum: CLIENT_MONTHLY_FEE,
      });
    }

    // Round to nearest cent
    const rounded = Math.round(fee * 100) / 100;

    const client = db.prepare(
      "SELECT id, client_name, client_email FROM agency_clients WHERE id = ? AND agency_id = ? AND status = 'active'"
    ).get(req.params.id, req.agency.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    db.prepare(
      "UPDATE agency_clients SET monthly_fee = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(rounded, client.id);

    const agencyEarns = Math.round(rounded * AGENCY_REVENUE_SHARE * 100) / 100;
    const mineKeeps   = Math.round(rounded * (1 - AGENCY_REVENUE_SHARE) * 100) / 100;

    res.json({
      success:      true,
      monthly_fee:  rounded,
      agency_earns: agencyEarns,
      mine_keeps:   mineKeeps,
      message:      `${client.client_name || client.client_email} price set to $${rounded}/month. You earn $${agencyEarns}/month.`,
    });
  } catch(e) {
    console.error("[Agency] Set price:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── AGENCY IMPERSONATION — ACT AS CLIENT ────────────────────────────────────
// Creates a short-lived session token for the client's account.
// The agency uses this token for all subsequent API calls while in context —
// every route that reads req.userId automatically operates on the client's data.
// The agency's own session is untouched and still valid.
// ── P0 #4: consent endpoints — the user's Accept/Decline links land here ──
router.get("/consent/:decision", async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const dec = req.params.decision;
    const raw = String(req.query.token || "");
    const page = (title, body) => res.set("Content-Type", "text/html").send(
      `<!doctype html><html><body style="font-family:system-ui;background:#f6f8fc;margin:0;padding:60px 16px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:36px;text-align:center;box-shadow:0 8px 30px rgba(15,23,42,.08)"><h2 style="color:#0f172a;margin:0 0 10px">${title}</h2><p style="color:#556;line-height:1.65;margin:0">${body}</p></div></body></html>`);
    if (!raw || !["accept", "decline"].includes(dec)) return page("Invalid link", "This invitation link is not valid.");
    const hash = require("crypto").createHash("sha256").update(raw).digest("hex");
    const row = db.prepare("SELECT * FROM agency_clients WHERE consent_token_hash = ? AND status = 'invited'").get(hash);
    if (!row) return page("Link expired or already used", "If you still want to join the agency, ask them to send a new invitation.");
    const ageDays = (Date.now() - new Date(row.consent_requested_at || row.created_at).getTime()) / 86400000;
    if (ageDays > 7) {
      db.prepare("UPDATE agency_clients SET status='expired', consent_token_hash=NULL, updated_at=datetime('now') WHERE id=?").run(row.id);
      return page("Invitation expired", "This invitation is older than 7 days. Ask the agency to resend it.");
    }
    const agencyRow = db.prepare("SELECT * FROM agencies WHERE id = ?").get(row.agency_id);
    if (dec === "decline") {
      db.prepare("UPDATE agency_clients SET status='declined', consent_token_hash=NULL, updated_at=datetime('now') WHERE id=?").run(row.id);
      return page("Invitation declined", "No changes were made to your account.");
    }
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id);
    if (!u) return page("Account not found", "Please contact support.");
    let subNote = "";
    try {
      if (u.stripe_subscription_id) {
        const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
        if (stripeKey) {
          const stripe = require("stripe")(stripeKey);
          await stripe.subscriptions.update(u.stripe_subscription_id, { cancel_at_period_end: true });
          subNote = " Your existing personal subscription will stop at the end of its current period — no further personal charges.";
        }
      }
    } catch (e) {
      console.error("[AgencyConsent] personal-sub cancel failed:", e.message);
      subNote = " We could not automatically stop your old subscription — please cancel it in Billing to avoid double charges.";
    }
    db.prepare("UPDATE users SET agency_id = ?, is_agency_client = 1, plan = 'enterprise' WHERE id = ?").run(row.agency_id, row.user_id);
    try { tagSites(db, row.user_id, row.agency_id); } catch (e) {}
    db.prepare("UPDATE agency_clients SET status='active', consent_token_hash=NULL, consented_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(row.id);
    return page("You are in", `${agencyRow ? agencyRow.agency_name : "The agency"} now manages your TAKEOVA account with enterprise-level access.${subNote}`);
  } catch (e) {
    console.error("[AgencyConsent] error:", e.message);
    return res.status(500).send("Something went wrong — please contact support.");
  }
});

router.post("/act-as/:clientId", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const client = db.prepare(
      "SELECT * FROM agency_clients WHERE id = ? AND agency_id = ? AND status = 'active'"
    ).get(req.params.clientId, req.agency.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const crypto = require("crypto");
    const { v4: sid } = require("uuid");

    // Safe migrations
    try { db.exec("ALTER TABLE sessions ADD COLUMN impersonated_by TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE sessions ADD COLUMN token_hash TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE sessions ADD COLUMN owner_id TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE sessions ADD COLUMN team_role TEXT"); } catch(e) {}

    // Revoke any existing impersonation sessions this agency has for this client
    db.prepare(`
      DELETE FROM sessions
      WHERE user_id = ? AND impersonated_by = ?
    `).run(client.user_id, req.userId);

    // Create a 4-hour impersonation session for the client's user_id.
    //
    // SECURITY: We store only the SHA-256 hash of the token, never the raw
    // value. The raw token is returned once and lives only in the agency's
    // browser. If the sessions table leaks, the attacker gets hashes not
    // live credentials — matching how signToken() handles normal sessions.
    const token      = crypto.randomBytes(32).toString("hex");
    const tokenHash  = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt  = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, token, token_hash, expires_at, impersonated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sid(), client.user_id, "", tokenHash, expiresAt, req.userId);

    // Audit trail — impersonation is sensitive and every session must be traceable
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "agency_impersonation_started", JSON.stringify({
          agency_id: req.agency.id,
          client_user_id: client.user_id,
          agency_client_id: client.id,
          expires_at: expiresAt,
        }));
    } catch(e) {}

    // Fetch the client's full user record to return to frontend
    const clientUser = db.prepare(
      "SELECT id, email, name, role, plan, is_agency_client, agency_id FROM users WHERE id = ?"
    ).get(client.user_id);

    res.json({
      success:      true,
      token,
      expires_at:   expiresAt,
      client_user:  clientUser,
      client_id:    client.id,
      client_name:  client.client_name || clientUser?.name,
    });
  } catch(e) {
    console.error("[Agency] Act-as:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Revoke the impersonation session when agency exits client context
router.delete("/act-as", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb();
    // Revoke ALL impersonation sessions this agency created
    try { db.exec("ALTER TABLE sessions ADD COLUMN impersonated_by TEXT"); } catch(e) {}
    const result = db.prepare(
      "DELETE FROM sessions WHERE impersonated_by = ?"
    ).run(req.userId);
    res.json({ success: true, revoked: result.changes });
  } catch(e) {
    console.error("[Agency] Revoke act-as:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── STRIPE CONNECT — AGENCY PAYOUT SETUP ────────────────────────────────────
// Agencies connect their Stripe account (Express) to receive automatic commission
// payouts after each monthly billing run.

// Start Stripe Connect onboarding
router.post("/stripe-connect", auth, agencyAuth, async (req, res) => {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
    if (!stripeKey) return res.status(500).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);
    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
    const db = getDb(); ensureTables(db);

    let connectId = req.agency.stripe_connect_id;

    // Create a Stripe Express account if not already connected
    if (!connectId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: req.agency.contact_email,
        metadata: { mine_agency: req.agency.id },
        capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
        settings: { payouts: { schedule: { interval: "monthly", monthly_anchor: 15 } } },
      });
      connectId = account.id;
      db.prepare("UPDATE agencies SET stripe_connect_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(connectId, req.agency.id);
    }

    // Generate onboarding link (or re-entry link for incomplete onboarding)
    const accountLink = await stripe.accountLinks.create({
      account:     connectId,
      refresh_url: `${frontendUrl}/?stripe_connect=refresh`,
      return_url:  `${frontendUrl}/?stripe_connect=success`,
      type:        "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch(e) {
    console.error("[Agency] Stripe Connect:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Check Stripe Connect status
router.get("/stripe-connect/status", auth, agencyAuth, async (req, res) => {
  try {
    if (!req.agency.stripe_connect_id) {
      return res.json({ connected: false });
    }
    const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
    if (!stripeKey) return res.json({ connected: false });
    const stripe = require("stripe")(stripeKey);

    const account = await stripe.accounts.retrieve(req.agency.stripe_connect_id);
    res.json({
      connected:        account.charges_enabled && account.payouts_enabled,
      charges_enabled:  account.charges_enabled,
      payouts_enabled:  account.payouts_enabled,
      details_submitted: account.details_submitted,
      connect_id:       req.agency.stripe_connect_id,
    });
  } catch(e) {
    console.error("[Agency] Stripe Connect status:", e.message);
    res.json({ connected: false, error: e.message });
  }
});

// Generate Stripe Express dashboard login link
router.post("/stripe-connect/dashboard", auth, agencyAuth, async (req, res) => {
  try {
    if (!req.agency.stripe_connect_id) {
      return res.status(400).json({ error: "Stripe not connected" });
    }
    const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
    if (!stripeKey) return res.status(500).json({ error: "Stripe not configured" });
    const stripe = require("stripe")(stripeKey);
    const link = await stripe.accounts.createLoginLink(req.agency.stripe_connect_id);
    res.json({ url: link.url });
  } catch(e) {
    console.error("[Agency] Stripe dashboard link:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── PAYOUTS ───────────────────────────────────────────────────────────────────
router.get("/payouts", auth, agencyAuth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const payouts = db.prepare(
      "SELECT * FROM agency_payouts WHERE agency_id = ? ORDER BY created_at DESC LIMIT 24"
    ).all(req.agency.id);
    res.json({
      payouts,
      pending: req.agency.commission_pending,
      paid:    req.agency.commission_paid,
    });
  } catch(e) {
    console.error("[Agency] Payouts:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── MONTHLY BILLING CRON ──────────────────────────────────────────────────────
// Billing model (Option B):
//   1. Agency pays MINE $799/month seat fee (charged on agency's own card).
//   2. Each client pays MINE directly ($799/month minimum, on client's own card).
//   3. MINE pays the agency 40% commission of each client's monthly fee + 0.5%
//      of client transaction volume, as a Stripe Connect transfer.
// Overages are handled separately by the main overage cron in server.js —
// they use the client's own stripe_customer_id and are billed directly.
router.post("/cron/bill", async (req, res) => {
  const secret = process.env.CRON_SECRET || getSetting("CRON_SECRET");
  // Reject empty-string secret — means env var not configured
  if (!secret) {
    console.error("[Agency Billing] CRON_SECRET not configured — billing aborted");
    return res.status(500).json({ error: "CRON_SECRET not configured" });
  }
  if (req.headers["x-cron-key"] !== secret) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Validate Stripe is configured before touching any client data
  const stripeKey = process.env.STRIPE_SECRET_KEY || getSetting("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    console.error("[AgencyBilling] STRIPE_SECRET_KEY not configured — billing aborted");
    return res.status(500).json({ error: "Stripe not configured" });
  }

  const db = getDb(); ensureTables(db);

  const stripe  = require("stripe")(stripeKey);
  const period  = new Date().toISOString().slice(0, 7);
  const results = { agencies_billed: 0, clients_billed: 0, skipped: 0, errors: [] };

  const agencies = db.prepare("SELECT * FROM agencies WHERE status = 'active'").all();

  for (const agency of agencies) {
    try {
      // ── 1. Bill the agency's $799/month seat fee ────────────────────────────
      // Only charge once per period (use last_billed_at for idempotency).
      // If the agency has no payment method on file, skip this run with an
      // error logged — the seat fee accrues until they add one.
      if (!agency.last_billed_at?.startsWith(period) && agency.stripe_customer_id) {
        try {
          const cu = await stripe.customers.retrieve(agency.stripe_customer_id);
          const hasPaymentMethod = cu.invoice_settings?.default_payment_method || cu.default_source;
          if (!hasPaymentMethod) {
            results.errors.push(`Agency ${agency.agency_name}: no payment method for seat fee — skipped`);
          } else {
            const seatInvoiceIdempKey = `seat-fee-${agency.id}-${period}`;
            const seatInv = await stripe.invoices.create({
              customer:          agency.stripe_customer_id,
              auto_advance:      true,
              collection_method: "charge_automatically",
              metadata: { mine_agency: agency.id, period, type: "agency_seat_fee" },
            }, { idempotencyKey: seatInvoiceIdempKey });

            await stripe.invoiceItems.create({
              customer:    agency.stripe_customer_id,
              invoice:     seatInv.id,
              amount:      Math.round(AGENCY_MONTHLY_FEE * 100),
              currency:    "usd",
              description: `TAKEOVA Agency Platform — monthly seat fee (${period})`,
            });
              // ── Sites overage: AGENCY ONLY — $3/site/mo beyond the 30 included (ceiling in sites.js; both TUNABLE) ──
              try {
                const _ownerId = agency.user_id || agency.owner_id || agency.owner_user_id || null;
                if (_ownerId) {
                  const _cnt = db.prepare("SELECT COUNT(*) AS c FROM sites WHERE user_id = ?").get(_ownerId).c;
                  const _extra = Math.max(0, _cnt - 30);
                  if (_extra > 0) {
                    await stripe.invoiceItems.create({
                      customer:    agency.stripe_customer_id,
                      invoice:     seatInv.id,
                      amount:      _extra * 300,
                      currency:    "usd",
                      description: `Extra client sites: ${_extra} x $3/mo (${period})`,
                    });
                  }
                }
              } catch (e) { results.errors.push(`Agency ${agency.agency_name}: site-overage calc failed — ${e.message}`); }


            const seatFinalised = await stripe.invoices.finalizeInvoice(seatInv.id);
            const seatPaid      = await stripe.invoices.pay(seatFinalised.id);

            if (seatPaid.status === "paid") {
              db.prepare(`
                UPDATE agencies SET
                  last_billed_at      = datetime('now'),
                  seat_fee_paid_total = seat_fee_paid_total + ?,
                  updated_at          = datetime('now')
                WHERE id = ?
              `).run(AGENCY_MONTHLY_FEE, agency.id);
            } else {
              results.errors.push(`Agency ${agency.agency_name}: seat fee invoice ${seatPaid.id} status=${seatPaid.status}`);
            }
          }
        } catch (seatErr) {
          results.errors.push(`Agency ${agency.agency_name} seat fee: ${seatErr.message}`);
          console.error("[Agency Billing] Seat fee charge failed:", seatErr.message);
        }
      }

      // ── 2. Bill the agency's clients ────────────────────────────────────────
      const clients = db.prepare(`
        SELECT ac.*, u.email, u.name, u.stripe_customer_id AS user_stripe_id
        FROM agency_clients ac LEFT JOIN users u ON u.id = ac.user_id
        WHERE ac.agency_id = ? AND ac.status = 'active'
      `).all(agency.id);
      if (!clients.length) continue;

      // Deterministic payout id — stable across retries
      const payoutId = require("crypto").createHash("sha256")
        .update(agency.id + "|" + period).digest("hex").slice(0, 36);

      let existingPayout = db.prepare("SELECT * FROM agency_payouts WHERE id = ?").get(payoutId);

      // Seed the payout row on first run so retries can accumulate into it
      if (!existingPayout) {
        db.prepare(`
          INSERT OR IGNORE INTO agency_payouts
            (id, agency_id, period, client_count, gross_revenue, agency_share, tx_fee_share, mine_share, status)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 'pending')
        `).run(payoutId, agency.id, period);
        existingPayout = db.prepare("SELECT * FROM agency_payouts WHERE id = ?").get(payoutId);
      }

      let gross          = existingPayout?.gross_revenue  || 0;
      let billed         = existingPayout?.client_count   || 0;
      let baseCommission = existingPayout?.agency_share   || 0;
      // Subtract prev txFeeShare so baseCommission starts at pure fee-based commission
      baseCommission = Math.max(0, baseCommission - (existingPayout?.tx_fee_share || 0));

      // ── Bill each client on their own card ────────────────────────────────
      // Per-client idempotency: skip if last_billed_at is already in this period.
      // Failed clients from a prior run are retried; billed clients are skipped.
      for (const client of clients) {
        if (client.last_billed_at?.startsWith(period)) { results.skipped++; continue; }

        // Each client needs their own Stripe customer + payment method
        const clientStripeId = client.stripe_customer_id || client.user_stripe_id;
        if (!clientStripeId) {
          results.errors.push(`Client ${client.client_email}: no payment method on file — skipped`);
          continue;
        }

        try {
          const cu = await stripe.customers.retrieve(clientStripeId);
          if (!cu.invoice_settings?.default_payment_method && !cu.default_source) {
            results.errors.push(`Client ${client.client_email}: no default payment method — skipped`);
            results.skipped++;
            continue;
          }

          // Idempotency key: unique per agency+client+period — safe to retry
          const invoiceIdempKey = `invoice-${agency.id}-${client.id}-${period}`;
          const inv = await stripe.invoices.create({
            customer: clientStripeId,
            auto_advance: true,
            collection_method: "charge_automatically",
            metadata: { mine_agency: agency.id, mine_client: client.user_id, period, type: "agency_client" },
          }, { idempotencyKey: invoiceIdempKey });

          // Base platform fee
          await stripe.invoiceItems.create({
            customer: clientStripeId, invoice: inv.id,
            amount: Math.round(client.monthly_fee * 100), currency: "usd",
            description: `MINE Business Platform — managed by ${agency.agency_name} (${period})`,
          });

          // AI add-on line items
          const clientAddons = JSON.parse(client.ai_addons || "[]");
          for (const addonRole of clientAddons) {
            const addonPrice = AI_EMPLOYEE_PRICES[addonRole];
            if (!addonPrice) continue;
            await stripe.invoiceItems.create({
              customer: clientStripeId, invoice: inv.id,
              amount: Math.round(addonPrice * 100), currency: "usd",
              description: `${AI_ADDON_LABELS[addonRole] || addonRole} (${period})`,
            });
          }

          const finalised = await stripe.invoices.finalizeInvoice(inv.id);
          const paid      = await stripe.invoices.pay(finalised.id);

          if (paid.status === "paid") {
            // Stamp immediately — prevents double billing on retry
            db.prepare("UPDATE agency_clients SET last_billed_at = datetime('now') WHERE id = ?").run(client.id);
            const addonTotal = clientAddons.reduce((t, r) => t + (AI_EMPLOYEE_PRICES[r] || 0), 0);
            gross          += client.monthly_fee + addonTotal;
            baseCommission += client.monthly_fee * AGENCY_REVENUE_SHARE; // 40% of actual fee
            billed++;
          } else {
            results.errors.push(`Client ${client.client_email}: invoice ${paid.id} status=${paid.status}`);
            // Notify agency that a client payment failed
            try {
              const sgKey     = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
              const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
              if (sgKey && agency.contact_email) {
                const fetch2 = (...a) => import("node-fetch").then(m => m.default(...a));
                const _sgResp = await fetch2("https://api.sendgrid.com/v3/mail/send", {
                  method: "POST",
                  headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    personalizations: [{ to: [{ email: agency.contact_email }] }],
                    from: { email: fromEmail, name: "MINE" },
                    subject: `Payment failed — ${client.client_name || client.client_email}`,
                    content: [{ type: "text/html", value: `
                      <div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:32px">
                        <h2>⚠️ Client payment failed</h2>
                        <p>The monthly payment for <strong>${client.client_name || client.client_email}</strong> failed for ${period}.</p>
                        <p>Invoice: <code>${paid.id}</code> · Status: ${paid.status}</p>
                        <p>Stripe will automatically retry the charge. If it continues to fail, please contact your client to update their payment method.</p>
                        <p style="color:#94a3b8;font-size:12px">TAKEOVA Agency Billing</p>
                      </div>`
                    }]
                  })
                });
                if (!_sgResp.ok) {
                  let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
                  console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
                }
              }
            } catch(e) { /* non-fatal */ }
          }
        } catch(e) {
          results.errors.push(`Client ${client.client_email}: ${e.message}`);
        }
      }

      // ── Calculate agency's transaction fee share (1.25% of client sales) ──────
      // Query total orders placed by all agency clients this period
      const periodStart = period + "-01";
      // Use first day of NEXT month as exclusive upper bound — works for all month lengths
      const [py, pm] = period.split("-").map(Number);
      const nextMonth = pm === 12 ? `${py + 1}-01` : `${py}-${String(pm + 1).padStart(2, "0")}`;
      const periodEnd = nextMonth + "-01";
      let totalClientTxVolume = 0;
      for (const client of clients) {
        const txVol = db.prepare(`
          SELECT COALESCE(SUM(total), 0) AS volume
          FROM orders
          WHERE user_id = ?
            AND status = 'paid'
            AND created_at >= ? AND created_at < ?
        `).get(client.user_id, periodStart, periodEnd);
        totalClientTxVolume += txVol?.volume || 0;
      }
      const txFeeShare = Math.round(totalClientTxVolume * (AGENCY_TX_SHARE_PERCENT / 100) * 100) / 100;

      // Agency earns 40% of each client's actual monthly_fee + 1.25% of client tx volume
      // baseCommission accumulates in the billing loop above as clients are stamped paid
      const newAgencyShare  = (baseCommission) + txFeeShare;
      const prevAgencyShare = existingPayout?.agency_share || 0;
      const deltaShare      = newAgencyShare - prevAgencyShare;

      db.prepare(`
        UPDATE agency_payouts SET
          client_count  = ?, gross_revenue = ?,
          agency_share  = ?, tx_fee_share  = ?,
          mine_share    = ?, updated_at    = datetime('now')
        WHERE id = ?
      `).run(billed, gross, newAgencyShare, txFeeShare, gross - newAgencyShare, payoutId);

      // Only add incremental delta — avoids double-counting on retries
      if (deltaShare > 0) {
        db.prepare(`
          UPDATE agencies SET
            commission_earned  = commission_earned  + ?,
            commission_pending = commission_pending + ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(deltaShare, deltaShare, agency.id);

        // Auto-transfer commission to agency's Stripe Connect account
        const transferAmountCents = Math.round(deltaShare * 100);
        if (agency.stripe_connect_id && transferAmountCents >= 50) { // Stripe minimum = 50 cents
          try {
            // Idempotency key is the deterministic payout_id — if this exact
            // (agency, period) transfer was already created, Stripe returns
            // the original instead of creating a duplicate. Prevents
            // double-payout if the DB update after transfer fails mid-flight.
            const transfer = await stripe.transfers.create({
              amount:      transferAmountCents,
              currency:    "usd",
              destination: agency.stripe_connect_id,
              description: `TAKEOVA Agency Commission — ${period}`,
              metadata: {
                mine_agency:       agency.id,
                period,
                clients_billed:    billed,
                base_commission:   Math.round(baseCommission * 100) / 100,
                tx_fee_share:      txFeeShare,
                client_tx_volume:  totalClientTxVolume,
              },
            }, { idempotencyKey: `agency-payout-${payoutId}` });
            // Mark payout as paid immediately since transfer is automatic
            db.prepare(`
              UPDATE agency_payouts SET
                status           = 'paid',
                paid_at          = datetime('now'),
                stripe_payout_id = ?
              WHERE id = ?
            `).run(transfer.id, payoutId);
            db.prepare(`
              UPDATE agencies SET
                commission_paid    = commission_paid    + ?,
                commission_pending = MAX(0, commission_pending - ?),
                updated_at         = datetime('now')
              WHERE id = ?
            `).run(deltaShare, deltaShare, agency.id);
          } catch(e) {
            // Transfer failed — leave as pending, admin can retry manually
            results.errors.push(`Agency ${agency.agency_name} commission transfer: ${e.message}`);
            console.error("[Agency Billing] Transfer failed:", e.message);
          }
        }
      }

      results.agencies_billed++;
      results.clients_billed += billed;
    } catch(e) {
      results.errors.push(`Agency ${agency.id}: ${e.message}`);
      console.error("[Agency Billing] Fatal:", e.message);
    }
  }

  res.json({ success: true, period, ...results });
});

// ── MARK PAYOUT PAID (admin) ─────────────────────────────────────────────────
router.post("/admin/payouts/:id/paid", auth, adminOnly, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const payout = db.prepare("SELECT * FROM agency_payouts WHERE id = ?").get(req.params.id);
    if (!payout) return res.status(404).json({ error: "Payout not found" });
    if (payout.status === "paid") return res.status(409).json({ error: "Already paid" });
    db.prepare("UPDATE agency_payouts SET status = 'paid', paid_at = datetime('now'), stripe_payout_id = ? WHERE id = ?")
      .run(req.body.stripe_payout_id || null, payout.id);
    db.prepare("UPDATE agencies SET commission_pending = MAX(0, commission_pending - ?), commission_paid = commission_paid + ?, updated_at = datetime('now') WHERE id = ?")
      .run(payout.agency_share, payout.agency_share, payout.agency_id);
    // Audit trail — manual payout marks move real money and must be attributable
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "admin_payout_marked_paid", JSON.stringify({
          payout_id: payout.id,
          agency_id: payout.agency_id,
          amount: payout.agency_share,
          stripe_payout_id: req.body.stripe_payout_id || null,
        }));
    } catch(e) {}
    res.json({ success: true, message: `$${payout.agency_share} marked as paid.` });
  } catch(e) { console.error("[Agency] Mark paid:", e.message); res.status(500).json({ error: "An internal error occurred" }); }
});

// ── ADMIN: ALL AGENCIES ───────────────────────────────────────────────────────
router.get("/admin/all", auth, adminOnly, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const agencies = db.prepare(`
      SELECT a.*, u.email, u.name,
        (SELECT COUNT(*) FROM agency_clients ac WHERE ac.agency_id = a.id AND ac.status = 'active') AS client_count,
        (SELECT COUNT(*) FROM sites s JOIN agency_clients ac ON ac.user_id = s.user_id WHERE ac.agency_id = a.id AND ac.status = 'active') AS site_count,
        (SELECT COALESCE(SUM(ac.monthly_fee),0) FROM agency_clients ac WHERE ac.agency_id = a.id AND ac.status = 'active') AS monthly_arr,
        (SELECT COALESCE(SUM(s.revenue),0) FROM sites s JOIN agency_clients ac ON ac.user_id = s.user_id WHERE ac.agency_id = a.id AND ac.status = 'active') AS total_client_revenue
      FROM agencies a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
    `).all();
    res.json({ agencies });
  } catch(e) {
    console.error("[Agency] Admin list:", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── BUSINESS AUDIT ────────────────────────────────────────────────────────────
// Accepts a business URL + name, uses Claude to score 10 dimensions,
// maps every gap to a TAKEOVA feature, estimates monthly revenue being lost.
// Returns structured JSON the dashboard uses to render the report + PDF.

router.post("/audit", auth, async (req, res) => {
  const { businessName, websiteUrl, businessType, location } = req.body;
  if (!businessName) return res.status(400).json({ error: "Business name is required" });

  const db = getDb();
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  if (!["enterprise", "agency_client"].includes(user?.plan)) {
    return res.status(403).json({ error: "Business Audit is an Enterprise/Agency feature", upgrade: true });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY || getSetting("ANTHROPIC_API_KEY");
  if (!anthropicKey) return res.status(400).json({ error: "AI not configured" });

  try {
    const fetch = (await import("node-fetch")).default;

    const prompt = `You are a business growth consultant auditing a local business for a digital agency.

Business: "${businessName}"
Website: "${websiteUrl || "not provided"}"
Type: "${businessType || "local business"}"
Location: "${location || "not specified"}"

Audit this business across 10 dimensions. For each dimension, give:
- A score out of 10
- 2-3 specific findings (what's missing or weak)
- The estimated monthly revenue being lost due to this gap
- The TAKEOVA feature that fixes it

Return ONLY valid JSON in this exact structure:
{
  "businessName": "${businessName}",
  "overallScore": <0-100 integer>,
  "grade": "<A/B/C/D/F>",
  "estimatedMonthlyLoss": <integer in dollars>,
  "summary": "<2 sentence executive summary of the audit>",
  "dimensions": [
    {
      "id": "website",
      "name": "Website & Online Presence",
      "icon": "🌐",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "TAKEOVA AI Site Builder",
      "mineDescription": "New professional site built by AI in 60 seconds"
    },
    {
      "id": "bookings",
      "name": "Online Booking",
      "icon": "📅",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "MINE Bookings",
      "mineDescription": "24/7 online booking, automated reminders, zero no-shows"
    },
    {
      "id": "reviews",
      "name": "Reviews & Reputation",
      "icon": "⭐",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "TAKEOVA AI Review Responder",
      "mineDescription": "Auto-requests reviews after every sale, AI replies instantly"
    },
    {
      "id": "social",
      "name": "Social Media",
      "icon": "📱",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "TAKEOVA AI Social Manager",
      "mineDescription": "Posts daily across Instagram, Facebook, TikTok automatically"
    },
    {
      "id": "email",
      "name": "Email Marketing",
      "icon": "📧",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "MINE Email Marketing",
      "mineDescription": "Automated sequences, campaigns, abandoned cart recovery"
    },
    {
      "id": "ai_staff",
      "name": "AI Employees & Automation",
      "icon": "🤖",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "TAKEOVA AI Employees",
      "mineDescription": "AI receptionist, sales rep, support agent — working 24/7"
    },
    {
      "id": "payments",
      "name": "Online Payments & Invoicing",
      "icon": "💳",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "MINE Payments & Invoices",
      "mineDescription": "Accept payments online, auto-chase invoices, instant payouts"
    },
    {
      "id": "retention",
      "name": "Customer Retention & Loyalty",
      "icon": "🏆",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "MINE Loyalty & Referrals",
      "mineDescription": "Points program, referral rewards, win-back campaigns"
    },
    {
      "id": "leads",
      "name": "Lead Generation & CRM",
      "icon": "🎯",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "MINE CRM & AI Sales Rep",
      "mineDescription": "Lead scoring, auto follow-up within 1 hour, pipeline tracking"
    },
    {
      "id": "seo",
      "name": "SEO & Discoverability",
      "icon": "🔍",
      "score": <0-10>,
      "findings": ["finding 1", "finding 2"],
      "loss": <monthly $ loss integer>,
      "mineFeature": "MINE SEO & Blog AI",
      "mineDescription": "AI writes SEO-optimised blog posts weekly, auto meta tags"
    }
  ],
  "topOpportunities": [
    { "title": "opportunity 1", "impact": "High", "timeToFix": "1 day" },
    { "title": "opportunity 2", "impact": "High", "timeToFix": "2 days" },
    { "title": "opportunity 3", "impact": "Medium", "timeToFix": "1 week" }
  ],
  "recommendedPlan": "Enterprise",
  "recommendedAddons": ["AI Social Manager", "AI Receptionist", "AI Sales Rep"]
}

Be realistic and specific. Use the business type and location to make findings relevant. If no website is provided, assume it's weak or missing.`;

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        temperature: 0,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const aiData = await aiResp.json();
    const raw = aiData.content?.[0]?.text || "";

    // Strip markdown fences if present
    const clean = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
    const audit = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(clean);

    // Save to DB for history
    db.exec(`CREATE TABLE IF NOT EXISTS agency_audits (
      id TEXT PRIMARY KEY,
      agency_user_id TEXT,
      business_name TEXT,
      website_url TEXT,
      overall_score INTEGER,
      estimated_loss INTEGER,
      audit_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);

    const auditId = uuid();
    db.prepare("INSERT INTO agency_audits (id, agency_user_id, business_name, website_url, overall_score, estimated_loss, audit_json) VALUES (?,?,?,?,?,?,?)")
      .run(auditId, req.userId, businessName, websiteUrl || "", audit.overallScore, audit.estimatedMonthlyLoss, JSON.stringify(audit));

    res.json({ ok: true, auditId, audit });

  } catch(e) {
    console.error("[Agency Audit]", e.message);
    res.status(500).json({ error: "Audit failed — " + e.message });
  }
});

// ── GET /api/agency/audits ── list past audits ─────────────────────────────
router.get("/audits", auth, async (req, res) => {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS agency_audits (
      id TEXT PRIMARY KEY, agency_user_id TEXT, business_name TEXT,
      website_url TEXT, overall_score INTEGER, estimated_loss INTEGER,
      audit_json TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
    const audits = db.prepare(
      "SELECT id, business_name, website_url, overall_score, estimated_loss, created_at FROM agency_audits WHERE agency_user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.userId);
    res.json({ audits });
  } catch(e) {
    console.error("[/audits]", e?.message || e); res.status(500).json({ error: "An internal error occurred" });
  }
});

// ─── AGENCY AUTOPILOT (2026-06-11): one approval inbox across every client business ───
function _agApDb(db){
  db.exec("CREATE TABLE IF NOT EXISTS autopilot_actions (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, input_json TEXT, title TEXT, reason TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, executed_at TEXT)");
  try { db.exec("ALTER TABLE autopilot_actions ADD COLUMN created_by TEXT"); } catch (_a) {}
  return db;
}
router.post("/autopilot/scan", auth, agencyAuth, async (req, res) => {
  try {
    const db = _agApDb(getDb());
    const clients = db.prepare("SELECT user_id, client_name FROM agency_clients WHERE agency_id = ? AND user_id IS NOT NULL LIMIT 25").all(req.agency.id);
    if (!clients.length) return res.json({ success: true, created: 0, note: "No linked client accounts yet" });
    const sums = [];
    for (const c of clients) {
      const M = { client: c.client_name || "Client" };
      try { const r = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM invoices WHERE user_id=? AND status NOT IN ('paid','draft','void')").get(c.user_id); M.unpaid_invoices = r.c; M.unpaid_total = Math.round(r.s); } catch (_e) {}
      try { const r = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE user_id=? AND created_at>=datetime('now','-7 day')").get(c.user_id); M.orders_7d = r.c; M.revenue_7d = Math.round(r.s); } catch (_e) {}
      try { M.leads_7d = db.prepare("SELECT COUNT(*) c FROM leads WHERE user_id=? AND created_at>=datetime('now','-7 day')").get(c.user_id).c; } catch (_e) {}
      if ((M.unpaid_invoices || 0) + (M.orders_7d || 0) + (M.leads_7d || 0) === 0) continue;
      sums.push({ i: sums.length, user_id: c.user_id, M });
    }
    if (!sums.length) return res.json({ success: true, created: 0, note: "All clients quiet \u2014 nothing urgent" });
    const Anthropic = require("@anthropic-ai/sdk"); const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const sys = 'You are an agency operations AI reviewing multiple client businesses. Return ONLY a JSON array (max 8 items, max 2 per client) of high-impact moves: {"i":<client index>,"type":"chase_invoices"|"create_discount"|"note","title":"short imperative","reason":"one sentence citing that client\u2019s numbers","input":{}}. chase_invoices only if that client has unpaid_invoices>0, input {"confirm":true}. create_discount input {"percent_off":5-20,"code":"LETTERS+2digits"} only for plausibly slow sales. note = advice, input {}. No prose outside JSON.';
    const msg = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1200, system: sys, messages: [{ role: "user", content: "Clients: " + JSON.stringify(sums.map(x => ({ i: x.i, metrics: x.M }))) }] });
    let txt = (msg.content && msg.content[0] && msg.content[0].text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let acts = []; try { acts = JSON.parse(txt); } catch (_p) {}
    if (!Array.isArray(acts)) acts = [];
    const { v4: uuid } = require("uuid"); let created = 0;
    for (const a of acts.slice(0, 8)) {
      const c = sums[a && a.i]; if (!c || !a.type || !["chase_invoices", "create_discount", "note"].includes(a.type)) continue;
      const dup = db.prepare("SELECT 1 FROM autopilot_actions WHERE user_id=? AND type=? AND status='pending'").get(c.user_id, a.type);
      if (dup) continue;
      db.prepare("INSERT INTO autopilot_actions (id,user_id,type,input_json,title,reason,created_by) VALUES (?,?,?,?,?,?,?)")
        .run(uuid(), c.user_id, a.type, JSON.stringify(a.input || {}), String(a.title || a.type).slice(0, 90), ("\ud83c\udfe2 " + (c.M.client || "Client") + ": " + String(a.reason || "").slice(0, 170)), "agency:" + req.agency.id);
      created++;
    }
    res.json({ success: true, created, scanned: sums.length });
  } catch (e) { console.error("[agency/autopilot/scan]", e.message); res.status(500).json({ error: "Scan failed: " + e.message }); }
});
router.get("/autopilot", auth, agencyAuth, (req, res) => {
  try {
    const db = _agApDb(getDb());
    const pending = db.prepare("SELECT a.*, ac.client_name FROM autopilot_actions a JOIN agency_clients ac ON ac.user_id = a.user_id AND ac.agency_id = ? WHERE a.status='pending' ORDER BY a.created_at DESC LIMIT 12").all(req.agency.id);
    const recent = db.prepare("SELECT a.*, ac.client_name FROM autopilot_actions a JOIN agency_clients ac ON ac.user_id = a.user_id AND ac.agency_id = ? WHERE a.status != 'pending' ORDER BY a.executed_at DESC LIMIT 6").all(req.agency.id);
    res.json({ pending, recent });
  } catch (e) { res.status(500).json({ error: "Failed to load" }); }
});
router.post("/autopilot/:id/approve", auth, agencyAuth, async (req, res) => {
  try {
    const db = _agApDb(getDb());
    const row = db.prepare("SELECT a.* FROM autopilot_actions a JOIN agency_clients ac ON ac.user_id = a.user_id AND ac.agency_id = ? WHERE a.id = ? AND a.status = 'pending'").get(req.agency.id, req.params.id);
    if (!row) return res.json({ success: false, error: "Action not found for your clients" });
    let status = "executed", result = "";
    if (row.type === "note") result = "Noted.";
    else { try { const mc = require("./mine-control"); const out = await mc.executeTool(db, row.user_id, row.type, JSON.parse(row.input_json || "{}")); result = typeof out === "string" ? out : JSON.stringify(out); } catch (e) { status = "failed"; result = e.message; } }
    db.prepare("UPDATE autopilot_actions SET status=?, result=?, executed_at=datetime('now') WHERE id=?").run(status, String(result).slice(0, 800), row.id);
    res.json({ success: status === "executed", status, result: String(result).slice(0, 300) });
  } catch (e) { res.status(500).json({ error: "Approve failed" }); }
});
router.post("/autopilot/:id/dismiss", auth, agencyAuth, (req, res) => {
  try {
    const db = _agApDb(getDb());
    db.prepare("UPDATE autopilot_actions SET status='dismissed', executed_at=datetime('now') WHERE id = ? AND user_id IN (SELECT user_id FROM agency_clients WHERE agency_id = ?)").run(req.params.id, req.agency.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Dismiss failed" }); }
});

module.exports = router;
