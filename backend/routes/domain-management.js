// ═══════════════════════════════════════════════════════════════════════════
// Domain Management — production additions for custom domain flow
//
// Adds on top of the existing /api/hosting/domain endpoints:
//   - Plan-tier gate (custom domain is a paid feature)
//   - Better DNS verification with detailed status
//   - Domain status endpoint (combines DNS + SSL state)
//   - Cron: re-verifies DNS hourly, surfaces broken domains
//   - Email notification when domain transitions pending → live
//
// Assumes Cloudflare deployment. If CLOUDFLARE_API_TOKEN is set, this module
// queries the CF Zones API to check DNS + SSL status. If not, it falls back
// to plain DNS lookups (less detail but still functional).
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const { getDb, getSetting } = require("../db/init");

// ─── Plan-tier gate ─────────────────────────────────────────────────────────
// Plans that include custom domains. Update this list as your pricing evolves.
const PLANS_WITH_CUSTOM_DOMAIN = ["pro", "growth", "enterprise", "agency"];

function getUserPlan(userId) {
  try {
    const db = getDb();
    // Try several common column names — codebase has evolved over time
    const u = db.prepare("SELECT plan, plan_tier, subscription_tier FROM users WHERE id = ?").get(userId);
    if (!u) return "starter";
    return (u.plan || u.plan_tier || u.subscription_tier || "starter").toLowerCase();
  } catch {
    // Fallback: if the user table doesn't have a plan column, allow it
    // (better to let people use the feature than block them on a missing column)
    return "pro";
  }
}

function requireDomainPlan(req, res, next) {
  const plan = getUserPlan(req.userId);
  if (PLANS_WITH_CUSTOM_DOMAIN.includes(plan)) return next();
  return res.status(402).json({
    error: "Custom domains are available on Pro and above.",
    currentPlan: plan,
    upgradeUrl: "/pricing",
    code: "PLAN_UPGRADE_REQUIRED",
  });
}

// ─── DNS verification (deeper than the existing endpoint) ──────────────────
// Returns: { dns: 'pending'|'verified'|'broken', ssl: 'pending'|'active'|'broken', details: {...} }

async function checkDomainStatus(domain) {
  const result = {
    dns: "pending",
    ssl: "pending",
    details: { checks: [] },
  };

  if (!domain) return result;

  const cleanDomain = String(domain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").trim();
  const expectedTarget = (process.env.MINE_DOMAIN || "takeova.ai").toLowerCase();

  // ─── DNS check ───
  try {
    const dns = require("dns").promises;
    // Try CNAME first (preferred)
    let cname = [];
    try { cname = await dns.resolveCname(cleanDomain); } catch {}
    if (cname.length > 0) {
      const points_to_us = cname.some(r => r.toLowerCase().includes(expectedTarget));
      result.details.checks.push({ type: "CNAME", value: cname[0], points_to_us });
      result.dns = points_to_us ? "verified" : "broken";
    } else {
      // Fall back to A record (some providers don't allow CNAME on apex)
      let a = [];
      try { a = await dns.resolve4(cleanDomain); } catch {}
      if (a.length > 0) {
        // For A record, we can't easily tell if it points to us without knowing our IPs
        // Cloudflare proxy IPs change; just record what we found
        result.details.checks.push({ type: "A", value: a[0], points_to_us: null });
        result.dns = "verified"; // assume good if record exists; cron will refine
      } else {
        result.dns = "pending";
        result.details.checks.push({ type: "lookup", error: "No DNS records found" });
      }
    }
  } catch (e) {
    result.dns = "broken";
    result.details.dns_error = e.message;
  }

  // ─── SSL check (via Cloudflare API if available) ───
  const cfToken = getSetting("CLOUDFLARE_API_TOKEN") || process.env.CLOUDFLARE_API_TOKEN;
  const cfZoneId = getSetting("CLOUDFLARE_ZONE_ID") || process.env.CLOUDFLARE_ZONE_ID;

  if (result.dns === "verified" && cfToken && cfZoneId) {
    try {
      const fetch = (await import("node-fetch")).default;
      // Look up custom hostname status
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/custom_hostnames?hostname=${encodeURIComponent(cleanDomain)}`,
        { headers: { Authorization: `Bearer ${cfToken}` } }
      );
      const data = await r.json();
      if (data.success && data.result && data.result.length > 0) {
        const hostname = data.result[0];
        result.ssl = hostname.ssl?.status === "active" ? "active" : "pending";
        result.details.ssl_status = hostname.ssl?.status;
        result.details.ssl_method = hostname.ssl?.method;
      } else {
        result.ssl = "pending";
        result.details.ssl_note = "Not yet registered with Cloudflare";
      }
    } catch (e) {
      result.details.ssl_error = e.message;
    }
  } else if (result.dns === "verified") {
    // No CF integration — assume SSL is being handled at the platform level
    // (e.g., a deploy on Render/Railway that handles SSL automatically)
    result.ssl = "pending";
    result.details.ssl_note = "Cloudflare integration not configured; manual SSL setup may be required";
  }

  return result;
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// GET /api/domains/status/:siteId — full status for a site's custom domain
router.get("/status/:siteId", auth, async (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare("SELECT id, custom_domain, slug FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    const status = {
      site_id: site.id,
      slug_url: `${site.slug}.${process.env.MINE_DOMAIN || "takeova.ai"}`,
      custom_domain: site.custom_domain || null,
    };

    if (site.custom_domain) {
      Object.assign(status, await checkDomainStatus(site.custom_domain));
      // Persist latest status
      db.prepare(`
        UPDATE site_domains
        SET dns_configured = ?, ssl_status = ?, last_check_at = CURRENT_TIMESTAMP
        WHERE site_id = ? AND domain = ?
      `).run(status.dns === "verified" ? 1 : 0, status.ssl, site.id, site.custom_domain.toLowerCase());
    } else {
      status.dns = "n/a";
      status.ssl = "n/a";
    }

    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/domains/connect/:siteId — gated, calls existing logic + records intent
router.post("/connect/:siteId", auth, requireDomainPlan, async (req, res) => {
  try {
    const { domain } = req.body || {};
    if (!domain) return res.status(400).json({ error: "Domain required" });

    const db = getDb();
    // Add last_check_at + notified_live columns (idempotent)
    try {
      db.exec("ALTER TABLE site_domains ADD COLUMN last_check_at TEXT");
    } catch {} // already exists
    try {
      db.exec("ALTER TABLE site_domains ADD COLUMN notified_live INTEGER DEFAULT 0");
    } catch {}

    // Forward to the existing /api/hosting/domain/:siteId logic
    // by hitting the route handler directly via an internal call.
    // Simplest: just write to the DB ourselves and return DNS instructions.
    const cleanDomain = String(domain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").trim();
    const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    if (!DOMAIN_RE.test(cleanDomain)) {
      return res.status(400).json({ error: "Invalid domain format" });
    }

    const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    // Check uniqueness
    const conflict = db.prepare(
      "SELECT user_id FROM site_domains WHERE domain = ? AND user_id != ?"
    ).get(cleanDomain, req.userId);
    if (conflict) {
      return res.status(409).json({ error: "Domain already registered on another account" });
    }

    // Save / upsert
    const id = require("crypto").randomBytes(8).toString("hex");
    try {
      db.prepare(`
        INSERT OR REPLACE INTO site_domains (id, site_id, user_id, domain, dns_configured, ssl_status, created_at, last_check_at, notified_live)
        VALUES (?, ?, ?, ?, 0, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
      `).run(id, site.id, req.userId, cleanDomain);
      db.prepare("UPDATE sites SET custom_domain = ? WHERE id = ?").run(cleanDomain, site.id);
    } catch (e) {
      console.error("[domains/connect]", e.message);
      return res.status(500).json({ error: "Could not save domain" });
    }

    // Return DNS instructions
    const target = process.env.MINE_DOMAIN || "takeova.ai";
    res.json({
      ok: true,
      domain: cleanDomain,
      instructions: {
        type: "CNAME",
        host: cleanDomain,
        value: `proxy.${target}`,
        ttl: 3600,
        note: "If your domain is on the apex (no subdomain), use an A record or your DNS provider's ALIAS/ANAME record instead.",
      },
      next_step: "Add this DNS record at your domain registrar. We'll verify within 60 seconds.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/domains/verify/:siteId — manual re-check trigger (user clicks "Check now")
router.post("/verify/:siteId", auth, async (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare("SELECT custom_domain FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
    if (!site || !site.custom_domain) return res.status(404).json({ error: "No custom domain configured" });

    const status = await checkDomainStatus(site.custom_domain);
    db.prepare(`
      UPDATE site_domains
      SET dns_configured = ?, ssl_status = ?, last_check_at = CURRENT_TIMESTAMP
      WHERE site_id = ? AND domain = ?
    `).run(status.dns === "verified" ? 1 : 0, status.ssl, req.params.siteId, site.custom_domain.toLowerCase());

    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/domains/disconnect/:siteId — remove custom domain
router.delete("/disconnect/:siteId", auth, (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare("SELECT id, custom_domain FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    db.prepare("UPDATE sites SET custom_domain = NULL WHERE id = ?").run(site.id);
    db.prepare("DELETE FROM site_domains WHERE site_id = ? AND user_id = ?").run(site.id, req.userId);

    res.json({ ok: true, disconnected: site.custom_domain });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PERIODIC RE-VERIFICATION CRON ─────────────────────────────────────────
// Runs every hour, checks pending and verified-but-stale domains,
// updates their status, and sends a one-time email when DNS goes live.

async function runDomainCheckCron() {
  try {
    const db = getDb();
    // Add columns if first run
    try { db.exec("ALTER TABLE site_domains ADD COLUMN last_check_at TEXT"); } catch {}
    try { db.exec("ALTER TABLE site_domains ADD COLUMN notified_live INTEGER DEFAULT 0"); } catch {}

    // Re-check every domain at most once per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stale = db.prepare(`
      SELECT sd.id, sd.site_id, sd.user_id, sd.domain, sd.dns_configured, sd.ssl_status, sd.notified_live,
             u.email AS user_email, u.name AS user_name, s.slug AS site_slug
      FROM site_domains sd
      LEFT JOIN users u ON u.id = sd.user_id
      LEFT JOIN sites s ON s.id = sd.site_id
      WHERE sd.last_check_at IS NULL OR sd.last_check_at < ?
      ORDER BY sd.created_at DESC
      LIMIT 100
    `).all(oneHourAgo);

    let checked = 0, transitioned = 0, notified = 0;

    for (const row of stale) {
      try {
        const status = await checkDomainStatus(row.domain);
        const wasVerified = row.dns_configured === 1;
        const isNowVerified = status.dns === "verified";

        db.prepare(`
          UPDATE site_domains
          SET dns_configured = ?, ssl_status = ?, last_check_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(isNowVerified ? 1 : 0, status.ssl, row.id);

        // Pending → live transition: notify user once
        if (!wasVerified && isNowVerified && !row.notified_live && row.user_email) {
          await notifyDomainLive(row);
          db.prepare("UPDATE site_domains SET notified_live = 1 WHERE id = ?").run(row.id);
          notified++;
        }
        if (wasVerified !== isNowVerified) transitioned++;
        checked++;
      } catch (e) {
        console.error(`[domain-cron] check failed for ${row.domain}:`, e.message);
      }
    }

    if (checked > 0) {
      console.log(`[domain-cron] checked=${checked} transitioned=${transitioned} notified=${notified}`);
    }
  } catch (e) {
    console.error("[domain-cron]", e.message);
  }
}

async function notifyDomainLive(row) {
  try {
    // Use existing email helper if available
    let sendEmail;
    try { sendEmail = require("./email").sendEmail; } catch {}
    if (!sendEmail) return;

    const subject = `🎉 Your custom domain is live`;
    const body = `
Hi ${row.user_name || "there"},

Great news — your custom domain ${row.domain} is now connected to MINE.

Visit your site: https://${row.domain}

If you don't see your site yet, give it 5-10 minutes for DNS to fully propagate worldwide.

— The TAKEOVA team
`;
    await sendEmail({ to: row.user_email, subject, text: body });
  } catch (e) {
    console.error("[notify-domain-live]", e.message);
  }
}

// Start the cron when this module is loaded
let _cronStarted = false;
function startDomainCron() {
  if (_cronStarted) return;
  _cronStarted = true;
  // Run once 30s after start, then every hour
  setTimeout(() => { runDomainCheckCron().catch(e => console.error("[domain-cron]", e.message)); }, 30 * 1000);
  setInterval(() => { runDomainCheckCron().catch(e => console.error("[domain-cron]", e.message)); }, 60 * 60 * 1000);
  console.log("[domain-cron] started");
}

module.exports = { router, startDomainCron, checkDomainStatus, runDomainCheckCron };
