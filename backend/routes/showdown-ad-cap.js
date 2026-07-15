// ─────────────────────────────────────────────────────────────────────────────
// Showdown Ad-Cap Enforcement  —  v2 (multi-account, integrated with social-oauth)
// ─────────────────────────────────────────────────────────────────────────────
// Implements the $2,500/month ad-spend cap rule for TAKEOVA Showdown
// (per Made by MINE 2.0 playbook §7).
//
// v2 changes vs v1:
//   • Multi-account aware. A user can have N ad accounts per platform —
//     all of them count toward their cap.
//   • Hybrid OAuth + manual. Auto-discovered accounts come from the
//     existing social-oauth.js OAuth flows (meta-ads / google-ads /
//     tiktok-ads); manual-add fallback for accounts that don't surface
//     in OAuth listing.
//   • Per-account spend rows. UNIQUE(entry_id, platform, account_id, month, source).
//   • Reconciliation: SUM across accounts within (platform, source), then
//     MAX across sources within platform, then SUM across platforms.
//
// INTEGRATION WITH social-oauth.js
//   • OAuth flows live there: GET /api/social/{meta,google,tiktok}-ads/connect
//     and the matching /callback. Tokens stored in user_social_tokens with
//     platform = 'meta-ads' | 'google-ads' | 'tiktok-ads'.
//   • Each callback fires `require('./showdown-ad-cap').discoverForUser(uid, p)`
//     — that's the contract this module fulfills (exported below).
//
// Enforcement paths (priority order):
//   1) OAuth + auto-discover (preferred):  user OAuths Meta/Google/TikTok →
//      we list their accounts and monitor all of them via daily cron.
//   2) Manual-add (fallback):  user pastes an account ID for an account they
//      have access to that didn't surface in OAuth listing.
//   3) Self-report:  user attests monthly spend via a form. Stored under
//      the sentinel account_id "__self__".
//
// All endpoints mount under /api/showdown/*.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const { auth, adminOnly } = require("../middleware/auth");

function getDb() { return require("../db/init").getDb(); }
function getSetting(k) {
  try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; }
  catch { return ""; }
}

const AD_CAP_CENTS = 250000;            // $2,500.00
const AD_CAP_DOLLARS = AD_CAP_CENTS / 100;
const SUPPORTED_PLATFORMS = ["meta", "google", "tiktok"];
const SELF_REPORT_ACCOUNT = "__self__";   // sentinel for self-reported rows
// social-oauth.js stores ads-platform tokens under '<platform>_ads' so they
// don't collide with the organic-posting tokens (different scopes).
const TOKEN_PLATFORM = { meta: "meta-ads", google: "google-ads", tiktok: "tiktok-ads" };

// Use UTC month keys so cron runs at hour=4 UTC don't straddle month boundaries.
function currentMonthKey(d) {
  const dt = d || new Date();
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
function ensureAdCapTables(db) {
  // showdown_ad_accounts — one row per (entry, platform, account_id).
  // Source 'discovered' came from OAuth listing; 'manual' was pasted by user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS showdown_ad_accounts (
      id             TEXT PRIMARY KEY,
      entry_id       TEXT NOT NULL,
      email          TEXT NOT NULL,
      platform       TEXT NOT NULL,
      account_id     TEXT NOT NULL,
      account_name   TEXT,
      currency       TEXT,
      source         TEXT NOT NULL DEFAULT 'discovered',
      active         INTEGER NOT NULL DEFAULT 1,
      last_error     TEXT,
      discovered_at  TEXT DEFAULT (datetime('now')),
      last_synced_at TEXT,
      UNIQUE(entry_id, platform, account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_showdown_ad_accounts_entry
      ON showdown_ad_accounts(entry_id, platform);
  `);

  // showdown_ad_spend — v1 had UNIQUE(entry_id, platform, month, source).
  // v2 adds account_id. Migrate in place if v1 schema detected.
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='showdown_ad_spend'"
  ).get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE showdown_ad_spend (
        id          TEXT PRIMARY KEY,
        entry_id    TEXT NOT NULL,
        email       TEXT NOT NULL,
        platform    TEXT NOT NULL,
        account_id  TEXT NOT NULL DEFAULT '${SELF_REPORT_ACCOUNT}',
        month       TEXT NOT NULL,
        spend_cents INTEGER NOT NULL DEFAULT 0,
        source      TEXT NOT NULL DEFAULT 'api',
        raw         TEXT,
        synced_at   TEXT DEFAULT (datetime('now')),
        UNIQUE(entry_id, platform, account_id, month, source)
      );
      CREATE INDEX IF NOT EXISTS idx_showdown_ad_spend_entry_month
        ON showdown_ad_spend(entry_id, month);
      CREATE INDEX IF NOT EXISTS idx_showdown_ad_spend_email_month
        ON showdown_ad_spend(email, month);
    `);
    return;
  }

  const cols = db.prepare("PRAGMA table_info(showdown_ad_spend)").all().map(c => c.name);
  if (cols.includes("account_id")) return; // already v2

  console.log("[showdown-ad-cap] migrating showdown_ad_spend v1 → v2 (adding account_id column)");
  try {
    db.exec("BEGIN");
    db.exec(`ALTER TABLE showdown_ad_spend RENAME TO showdown_ad_spend_v1`);
    db.exec(`
      CREATE TABLE showdown_ad_spend (
        id          TEXT PRIMARY KEY,
        entry_id    TEXT NOT NULL,
        email       TEXT NOT NULL,
        platform    TEXT NOT NULL,
        account_id  TEXT NOT NULL DEFAULT '${SELF_REPORT_ACCOUNT}',
        month       TEXT NOT NULL,
        spend_cents INTEGER NOT NULL DEFAULT 0,
        source      TEXT NOT NULL DEFAULT 'api',
        raw         TEXT,
        synced_at   TEXT DEFAULT (datetime('now')),
        UNIQUE(entry_id, platform, account_id, month, source)
      );
    `);
    db.exec(`
      INSERT INTO showdown_ad_spend (id, entry_id, email, platform, account_id, month, spend_cents, source, raw, synced_at)
      SELECT id, entry_id, email, platform, '__legacy__', month, spend_cents, source, raw, synced_at
        FROM showdown_ad_spend_v1
    `);
    db.exec(`DROP TABLE showdown_ad_spend_v1`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_showdown_ad_spend_entry_month ON showdown_ad_spend(entry_id, month)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_showdown_ad_spend_email_month ON showdown_ad_spend(email, month)`);
    db.exec("COMMIT");
    console.log("[showdown-ad-cap] migration complete");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("[showdown-ad-cap] migration FAILED:", e.message);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function findEntryForUser(db, user) {
  if (!user || !user.email) return null;
  return db.prepare(
    "SELECT * FROM showdown_entries WHERE email = ? ORDER BY created_at DESC LIMIT 1"
  ).get(String(user.email).toLowerCase());
}

function findEntryForUserId(db, userId) {
  if (!userId) return null;
  // user_social_tokens key off user_id; entries key off email. Bridge.
  const u = db.prepare("SELECT email FROM users WHERE id = ?").get(userId);
  if (!u || !u.email) return null;
  return db.prepare(
    "SELECT * FROM showdown_entries WHERE email = ? ORDER BY created_at DESC LIMIT 1"
  ).get(String(u.email).toLowerCase());
}

function getUserIdForEntry(db, entry) {
  if (!entry || !entry.email) return null;
  const u = db.prepare("SELECT id FROM users WHERE email = ?").get(entry.email);
  return u?.id || null;
}

// Reconciliation:
//   Within (platform, source) → SUM across accounts
//   Within platform           → MAX across sources
//   Across platforms          → SUM
function computeSpendCentsForMonth(db, entryId, month) {
  const rows = db.prepare(`
    SELECT platform, source, SUM(spend_cents) AS spend_cents
      FROM showdown_ad_spend
     WHERE entry_id = ? AND month = ?
     GROUP BY platform, source
  `).all(entryId, month);

  const platformMax = {};
  for (const r of rows) {
    const p = r.platform;
    const v = r.spend_cents || 0;
    if (platformMax[p] === undefined || v > platformMax[p]) platformMax[p] = v;
  }
  let total = 0;
  for (const p of Object.keys(platformMax)) total += platformMax[p];
  return { total_cents: total, by_platform: platformMax };
}

function reconcileExclusion(db, entry, month) {
  if (!entry) return null;
  const { total_cents, by_platform } = computeSpendCentsForMonth(db, entry.id, month);
  const overCap = total_cents > AD_CAP_CENTS;
  const flag = overCap ? month : null;

  if ((entry.ad_cap_excluded_month || null) !== flag) {
    db.prepare(
      "UPDATE showdown_entries SET ad_cap_excluded_month = ?, ad_spend_last_synced_at = datetime('now') WHERE id = ?"
    ).run(flag, entry.id);
  } else {
    db.prepare(
      "UPDATE showdown_entries SET ad_spend_last_synced_at = datetime('now') WHERE id = ?"
    ).run(entry.id);
  }
  return { total_cents, by_platform, excluded: overCap, month };
}

async function fetchFn() {
  return (typeof fetch === "function") ? fetch : (await import("node-fetch")).default;
}
async function f(url, opts) {
  const fn = await fetchFn();
  return fn(url, opts);
}

// Get the social-oauth-saved token for (user, platform). user_social_tokens
// stores expires_at as MILLISECONDS-since-epoch (per social-oauth.js
// saveToken). Refreshes Google access tokens on-demand when expired.
async function getAdsToken(db, userId, platform) {
  const tokPlatform = TOKEN_PLATFORM[platform];
  if (!tokPlatform) return null;
  const row = db.prepare(
    "SELECT * FROM user_social_tokens WHERE user_id = ? AND platform = ?"
  ).get(userId, tokPlatform);
  if (!row || !row.access_token) return null;

  // Google access tokens expire after 1h. Refresh if within 60s of expiry.
  if (platform === "google" && row.refresh_token) {
    const nowMs = Date.now();
    const expMs = row.expires_at || 0; // millis since epoch
    if (!expMs || expMs - nowMs < 60_000) {
      try {
        const fresh = await refreshGoogleToken(row.refresh_token);
        db.prepare(
          "UPDATE user_social_tokens SET access_token = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(fresh.access_token, fresh.expires_at_ms, row.id);
        row.access_token = fresh.access_token;
      } catch (e) {
        console.error("[ad-cap] google token refresh failed:", e.message);
        return null;
      }
    }
  }
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT DISCOVERY  —  list every ad account a token can access.
// Called from social-oauth.js callbacks via discoverForUser export.
// ─────────────────────────────────────────────────────────────────────────────

async function discoverMetaAccounts(token) {
  const url =
    `https://graph.facebook.com/v19.0/me/adaccounts` +
    `?fields=account_id,name,account_status,currency,timezone_name` +
    `&limit=100&access_token=${encodeURIComponent(token)}`;
  const out = [];
  let next = url;
  while (next && out.length < 500) {
    const r = await f(next);
    const d = await r.json();
    if (d.error) throw new Error("meta_discover: " + d.error.message);
    for (const a of (d.data || [])) {
      out.push({
        account_id: `act_${a.account_id}`,
        account_name: a.name,
        currency: a.currency,
      });
    }
    next = d.paging?.next || null;
  }
  return out;
}

async function discoverGoogleAccounts(accessToken) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || getSetting("GOOGLE_ADS_DEVELOPER_TOKEN");
  if (!devToken) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN not configured");

  // Step 1: list accessible customers (returns resource names like 'customers/1234567890').
  const listResp = await f(
    "https://googleads.googleapis.com/v16/customers:listAccessibleCustomers",
    { headers: { "Authorization": `Bearer ${accessToken}`, "developer-token": devToken } }
  );
  const list = await listResp.json();
  if (list.error) throw new Error("google_discover: " + list.error.message);
  const ids = (list.resourceNames || []).map(rn => rn.split("/")[1]).filter(Boolean);

  // Step 2: for each customer ID, fetch the descriptive name via GAQL.
  const out = [];
  for (const customerId of ids) {
    try {
      const r = await f(
        `https://googleads.googleapis.com/v16/customers/${customerId}/googleAds:searchStream`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "developer-token": devToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: "SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1",
          }),
        }
      );
      const d = await r.json();
      const row = Array.isArray(d) ? d[0]?.results?.[0]?.customer : null;
      out.push({
        account_id: customerId,
        account_name: row?.descriptiveName || `Customer ${customerId}`,
        currency: row?.currencyCode || null,
      });
    } catch {
      // Customer might be a manager (MCC) we can't read directly. Still list it.
      out.push({ account_id: customerId, account_name: `Customer ${customerId}`, currency: null });
    }
  }
  return out;
}

async function discoverTikTokAccounts(accessToken) {
  // TikTok Business API. The OAuth callback in social-oauth.js receives
  // advertiser_ids as part of the access_token response. But to be safe we
  // call the advertiser/info endpoint to list and resolve names.
  const url = "https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/" +
    `?app_id=${encodeURIComponent(process.env.TIKTOK_ADS_APP_ID || "")}` +
    `&secret=${encodeURIComponent(process.env.TIKTOK_ADS_APP_SECRET || "")}`;
  const r = await f(url, { headers: { "Access-Token": accessToken } });
  const d = await r.json();
  if (d.code && d.code !== 0) throw new Error("tiktok_discover: " + (d.message || "api_error"));
  const list = d.data?.list || [];
  return list.map(a => ({
    account_id: String(a.advertiser_id),
    account_name: a.advertiser_name || `Advertiser ${a.advertiser_id}`,
    currency: null,
  }));
}

async function refreshGoogleToken(refreshToken) {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    "refresh_token",
  });
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(d.error_description || d.error || "refresh_failed");
  return {
    access_token: d.access_token,
    expires_at_ms: Date.now() + ((d.expires_in || 3600) * 1000),
  };
}

// Persist discovered accounts: deactivate stale discovered ones, upsert current set.
function persistDiscoveredAccounts(db, entry, platform, accounts) {
  // Soft-deactivate previously-discovered accounts for this platform (manual ones untouched).
  db.prepare(
    "UPDATE showdown_ad_accounts SET active = 0 WHERE entry_id = ? AND platform = ? AND source = 'discovered'"
  ).run(entry.id, platform);

  const upsert = db.prepare(`
    INSERT INTO showdown_ad_accounts (id, entry_id, email, platform, account_id, account_name, currency, source, active, discovered_at)
    VALUES (?,?,?,?,?,?,?, 'discovered', 1, datetime('now'))
    ON CONFLICT(entry_id, platform, account_id) DO UPDATE SET
      account_name = COALESCE(excluded.account_name, showdown_ad_accounts.account_name),
      currency     = COALESCE(excluded.currency, showdown_ad_accounts.currency),
      active       = 1,
      last_error   = NULL
  `);
  for (const acct of accounts) {
    upsert.run(uuid(), entry.id, entry.email, platform, acct.account_id, acct.account_name || null, acct.currency || null);
  }
}

// EXPORTED. Called from social-oauth.js callbacks (fire-and-forget — we
// swallow errors so a failure here can't cause an unhandled rejection in
// the caller).
async function discoverForUser(userId, platform) {
  try {
    if (!SUPPORTED_PLATFORMS.includes(platform)) return;
    const db = getDb();
    ensureAdCapTables(db);
    const entry = findEntryForUserId(db, userId);
    if (!entry) return; // user has no Showdown entry — nothing to discover for

    const tokenRow = await getAdsToken(db, userId, platform);
    if (!tokenRow || !tokenRow.access_token) return;

    let accounts = [];
    if (platform === "meta")   accounts = await discoverMetaAccounts(tokenRow.access_token);
    if (platform === "google") accounts = await discoverGoogleAccounts(tokenRow.access_token);
    if (platform === "tiktok") accounts = await discoverTikTokAccounts(tokenRow.access_token);

    persistDiscoveredAccounts(db, entry, platform, accounts);
    console.log(`[ad-cap] discovered ${accounts.length} ${platform} accounts for entry ${entry.id}`);
  } catch (e) {
    console.error(`[ad-cap] discoverForUser ${platform} ${userId}:`, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-ACCOUNT SPEND FETCHERS
// Each takes (token, accountId) and returns { ok, spend_cents, raw, error }.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchMetaSpend(accessToken, accountId) {
  if (!accessToken) return { ok: false, error: "no_token" };
  if (!accountId) return { ok: false, error: "no_account_id" };
  const cleanId = String(accountId).replace(/^act_/i, "");
  const url =
    `https://graph.facebook.com/v19.0/act_${encodeURIComponent(cleanId)}/insights` +
    `?fields=spend&date_preset=this_month&access_token=${encodeURIComponent(accessToken)}`;
  try {
    const resp = await f(url);
    const data = await resp.json();
    if (data.error) return { ok: false, error: data.error.message || "meta_api_error" };
    const spendDollars = parseFloat(data.data?.[0]?.spend || 0);
    return { ok: true, spend_cents: Math.round(spendDollars * 100), raw: JSON.stringify(data).slice(0, 2000) };
  } catch (e) {
    return { ok: false, error: e.message || "fetch_failed" };
  }
}

async function fetchGoogleSpend(accessToken, customerId) {
  if (!accessToken) return { ok: false, error: "no_token" };
  if (!customerId) return { ok: false, error: "no_account_id" };
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || getSetting("GOOGLE_ADS_DEVELOPER_TOKEN");
  if (!devToken) return { ok: false, error: "platform_not_configured" };

  const cleanId = String(customerId).replace(/-/g, "");
  const url = `https://googleads.googleapis.com/v16/customers/${cleanId}/googleAds:searchStream`;
  try {
    const resp = await f(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "developer-token": devToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "SELECT metrics.cost_micros FROM customer WHERE segments.date DURING THIS_MONTH",
      }),
    });
    const data = await resp.json();
    if (!Array.isArray(data)) return { ok: false, error: data.error?.message || "google_api_error" };
    let totalMicros = 0;
    for (const batch of data) {
      for (const row of (batch.results || [])) {
        totalMicros += parseInt(row.metrics?.costMicros || row.metrics?.cost_micros || 0, 10);
      }
    }
    return { ok: true, spend_cents: Math.round(totalMicros / 10000), raw: JSON.stringify(data).slice(0, 2000) };
  } catch (e) {
    return { ok: false, error: e.message || "fetch_failed" };
  }
}

async function fetchTikTokSpend(accessToken, advertiserId) {
  if (!accessToken) return { ok: false, error: "no_token" };
  if (!advertiserId) return { ok: false, error: "no_account_id" };

  const now = new Date();
  const start = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);

  const url =
    "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/" +
    `?advertiser_id=${encodeURIComponent(advertiserId)}` +
    `&report_type=BASIC&data_level=AUCTION_ADVERTISER` +
    `&dimensions=["advertiser_id"]&metrics=["spend"]` +
    `&start_date=${start}&end_date=${end}`;
  try {
    const resp = await f(url, { headers: { "Access-Token": accessToken } });
    const data = await resp.json();
    if (data.code && data.code !== 0) return { ok: false, error: data.message || "tiktok_api_error" };
    const spendDollars = parseFloat(data.data?.list?.[0]?.metrics?.spend || 0);
    return { ok: true, spend_cents: Math.round(spendDollars * 100), raw: JSON.stringify(data).slice(0, 2000) };
  } catch (e) {
    return { ok: false, error: e.message || "fetch_failed" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNC ENTRY  —  iterate every active ad account for an entry, sync each.
// ─────────────────────────────────────────────────────────────────────────────
async function syncEntry(db, entry) {
  if (!entry) return { synced: 0, errors: [] };
  const month = currentMonthKey();
  const errors = [];
  const perPlatform = {};
  const userId = getUserIdForEntry(db, entry);

  // Pull all active ad accounts, grouped by platform.
  const accountRows = db.prepare(
    "SELECT * FROM showdown_ad_accounts WHERE entry_id = ? AND active = 1"
  ).all(entry.id);
  const byPlatform = { meta: [], google: [], tiktok: [] };
  for (const a of accountRows) {
    if (byPlatform[a.platform]) byPlatform[a.platform].push(a);
  }

  // BACK-COMPAT: legacy single-ID columns on showdown_entries.
  const legacy = [
    ["meta",   entry.ad_meta_account_id],
    ["google", entry.ad_google_customer_id],
    ["tiktok", entry.ad_tiktok_advertiser_id],
  ];
  for (const [platform, accountId] of legacy) {
    if (!accountId) continue;
    const exists = byPlatform[platform].some(a => a.account_id === accountId);
    if (!exists) byPlatform[platform].push({ account_id: accountId, account_name: "(legacy)", source: "manual" });
  }

  for (const platform of SUPPORTED_PLATFORMS) {
    const accounts = byPlatform[platform];
    if (!accounts || accounts.length === 0) continue;

    let token = null;
    if (userId) {
      const tokenRow = await getAdsToken(db, userId, platform);
      token = tokenRow?.access_token || null;
    }
    // Platform-admin fallback (legacy users who haven't OAuth'd).
    if (!token) {
      if (platform === "meta")   token = getSetting("META_ACCESS_TOKEN")   || process.env.META_ACCESS_TOKEN;
      if (platform === "google") token = getSetting("GOOGLE_ACCESS_TOKEN") || process.env.GOOGLE_ACCESS_TOKEN;
      if (platform === "tiktok") token = getSetting("TIKTOK_ACCESS_TOKEN") || process.env.TIKTOK_ACCESS_TOKEN;
    }

    if (!token) {
      perPlatform[platform] = { ok: false, error: "no_token", accounts: accounts.length };
      continue;
    }

    const results = [];
    for (const acct of accounts) {
      let r;
      try {
        if (platform === "meta")   r = await fetchMetaSpend(token, acct.account_id);
        if (platform === "google") r = await fetchGoogleSpend(token, acct.account_id);
        if (platform === "tiktok") r = await fetchTikTokSpend(token, acct.account_id);
      } catch (e) {
        r = { ok: false, error: e.message || "unknown" };
      }
      if (!r) continue;

      if (r.ok) {
        db.prepare(`
          INSERT INTO showdown_ad_spend (id, entry_id, email, platform, account_id, month, spend_cents, source, raw, synced_at)
          VALUES (?,?,?,?,?,?,?, 'api', ?, datetime('now'))
          ON CONFLICT(entry_id, platform, account_id, month, source) DO UPDATE SET
            spend_cents = excluded.spend_cents,
            raw         = excluded.raw,
            synced_at   = datetime('now')
        `).run(uuid(), entry.id, entry.email, platform, acct.account_id, month, r.spend_cents || 0, r.raw || null);

        db.prepare(
          "UPDATE showdown_ad_accounts SET last_synced_at = datetime('now'), last_error = NULL WHERE entry_id = ? AND platform = ? AND account_id = ?"
        ).run(entry.id, platform, acct.account_id);

        results.push({ account_id: acct.account_id, ok: true, spend_cents: r.spend_cents || 0 });
      } else {
        db.prepare(
          "UPDATE showdown_ad_accounts SET last_error = ? WHERE entry_id = ? AND platform = ? AND account_id = ?"
        ).run(String(r.error).slice(0, 200), entry.id, platform, acct.account_id);
        results.push({ account_id: acct.account_id, ok: false, error: r.error });
        if (r.error !== "no_account_id" && r.error !== "no_token") {
          errors.push({ platform, account_id: acct.account_id, error: r.error });
        }
      }
    }
    perPlatform[platform] = { accounts: results.length, results };
  }

  const reconciled = reconcileExclusion(db, entry, month);
  return { month, per_platform: perPlatform, ...reconciled, errors };
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═════════════════════════════════════════════════════════════════════════════

router.get("/ad-cap-info", (req, res) => {
  res.json({
    cap_cents: AD_CAP_CENTS,
    cap_dollars: AD_CAP_DOLLARS,
    platforms: SUPPORTED_PLATFORMS,
    month: currentMonthKey(),
    rule:
      "Showdown participants whose total paid-ad spend across Meta, Google, " +
      "and TikTok exceeds $2,500 in a calendar month are excluded from that " +
      "month's leaderboard. You are not banned from MINE — you simply don't " +
      "rank for that month's prize.",
    // Tell the frontend where to send users to connect ad-platform OAuth.
    // These endpoints are owned by social-oauth.js.
    oauth_connect_urls: {
      meta:   "/api/social/meta-ads/connect",
      google: "/api/social/google-ads/connect",
      tiktok: "/api/social/tiktok-ads/connect",
    },
  });
});

router.get("/ad-spend-status", auth, (req, res) => {
  try {
    const db = getDb();
    ensureAdCapTables(db);
    const entry = findEntryForUser(db, req.user);
    if (!entry) {
      return res.json({
        entered: false,
        cap_cents: AD_CAP_CENTS,
        spent_cents: 0,
        excluded_this_month: false,
        message: "No active Showdown entry for this account.",
      });
    }
    const month = currentMonthKey();
    const { total_cents, by_platform } = computeSpendCentsForMonth(db, entry.id, month);
    const excluded = (entry.ad_cap_excluded_month === month) || (total_cents > AD_CAP_CENTS);

    const accounts = db.prepare(`
      SELECT a.id, a.platform, a.account_id, a.account_name, a.source, a.last_synced_at, a.last_error,
             COALESCE((SELECT spend_cents FROM showdown_ad_spend
                        WHERE entry_id = a.entry_id AND platform = a.platform
                          AND account_id = a.account_id AND month = ?
                          AND source = 'api'
                        LIMIT 1), 0) AS spend_cents
        FROM showdown_ad_accounts a
       WHERE a.entry_id = ? AND a.active = 1
       ORDER BY a.platform, a.account_name
    `).all(month, entry.id);

    // OAuth connection state per platform — read from user_social_tokens.
    const oauth = { meta: false, google: false, tiktok: false };
    const userId = getUserIdForEntry(db, entry);
    if (userId) {
      const tokens = db.prepare(
        "SELECT platform FROM user_social_tokens WHERE user_id = ? AND platform IN ('meta-ads','google-ads','tiktok-ads')"
      ).all(userId);
      for (const t of tokens) {
        if (t.platform === "meta-ads")   oauth.meta = true;
        if (t.platform === "google-ads") oauth.google = true;
        if (t.platform === "tiktok-ads") oauth.tiktok = true;
      }
    }

    res.json({
      entered: true,
      entry_id: entry.id,
      month,
      cap_cents: AD_CAP_CENTS,
      spent_cents: total_cents,
      remaining_cents: Math.max(0, AD_CAP_CENTS - total_cents),
      excluded_this_month: excluded,
      by_platform,
      oauth_connected: oauth,
      accounts,
      account_count: accounts.length,
      last_synced_at: entry.ad_spend_last_synced_at || null,
    });
  } catch (e) {
    console.error("[showdown-ad-cap] status error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /connect-ad-accounts — manual-add fallback (option C). Accepts arrays
// for multi-account, and singular strings for v1 back-compat.
router.post("/connect-ad-accounts", auth, (req, res) => {
  try {
    const db = getDb();
    ensureAdCapTables(db);
    const entry = findEntryForUser(db, req.user);
    if (!entry) return res.status(404).json({ error: "No Showdown entry found for this account." });

    function asArray(v, single) {
      if (Array.isArray(v)) return v;
      if (typeof v === "string" && v.trim()) return [v.trim()];
      if (typeof single === "string" && single.trim()) return [single.trim()];
      return [];
    }

    const inputs = [
      { platform: "meta",   ids: asArray(req.body.meta_account_ids,      req.body.meta_account_id) },
      { platform: "google", ids: asArray(req.body.google_customer_ids,   req.body.google_customer_id) },
      { platform: "tiktok", ids: asArray(req.body.tiktok_advertiser_ids, req.body.tiktok_advertiser_id) },
    ];

    const upsert = db.prepare(`
      INSERT INTO showdown_ad_accounts (id, entry_id, email, platform, account_id, account_name, source, active, discovered_at)
      VALUES (?,?,?,?,?,?, 'manual', 1, datetime('now'))
      ON CONFLICT(entry_id, platform, account_id) DO UPDATE SET
        active = 1,
        last_error = NULL
    `);

    const added = [];
    for (const { platform, ids } of inputs) {
      for (const rawId of ids) {
        const id = String(rawId).trim().slice(0, 64);
        if (!id) continue;
        upsert.run(uuid(), entry.id, entry.email, platform, id, null);
        added.push({ platform, account_id: id });
      }
    }

    const firstMeta   = inputs[0].ids[0] || null;
    const firstGoogle = inputs[1].ids[0] || null;
    const firstTiktok = inputs[2].ids[0] || null;
    db.prepare(`
      UPDATE showdown_entries
         SET ad_meta_account_id      = COALESCE(?, ad_meta_account_id),
             ad_google_customer_id   = COALESCE(?, ad_google_customer_id),
             ad_tiktok_advertiser_id = COALESCE(?, ad_tiktok_advertiser_id)
       WHERE id = ?
    `).run(firstMeta, firstGoogle, firstTiktok, entry.id);

    res.json({ success: true, added, count: added.length });
  } catch (e) {
    console.error("[showdown-ad-cap] connect error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /ad-account/:id — remove a manually-added account.
router.delete("/ad-account/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const entry = findEntryForUser(db, req.user);
    if (!entry) return res.status(404).json({ error: "No Showdown entry found for this account." });

    const acct = db.prepare(
      "SELECT * FROM showdown_ad_accounts WHERE id = ? AND entry_id = ?"
    ).get(req.params.id, entry.id);
    if (!acct) return res.status(404).json({ error: "Account not found." });
    if (acct.source === "discovered") {
      return res.status(400).json({
        error: "discovered_account_cannot_be_removed",
        message: "Auto-discovered accounts can only be removed by disconnecting OAuth for this platform. This is required for Showdown integrity.",
        platform: acct.platform,
        oauth_disconnect_url: `/api/social/${acct.platform}_ads/disconnect`,
      });
    }
    db.prepare("DELETE FROM showdown_ad_accounts WHERE id = ?").run(req.params.id);
    res.json({ success: true, removed: { id: req.params.id, platform: acct.platform, account_id: acct.account_id } });
  } catch (e) {
    console.error("[showdown-ad-cap] delete account error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /rediscover/:platform — re-list ad accounts for a platform without re-OAuthing.
// Useful when the user got added to a new Business Manager and wants to surface
// the new accounts immediately rather than waiting for the daily cron.
router.post("/rediscover/:platform", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureAdCapTables(db);
    const entry = findEntryForUser(db, req.user);
    if (!entry) return res.status(404).json({ error: "No Showdown entry found for this account." });

    const platform = req.params.platform;
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: "Unsupported platform." });
    }
    const userId = getUserIdForEntry(db, entry);
    if (!userId) return res.status(400).json({ error: "User not found." });

    const tokenRow = await getAdsToken(db, userId, platform);
    if (!tokenRow) return res.status(400).json({
      error: "not_connected",
      message: `Connect ${platform} ads at /api/social/${platform}-ads/connect first.`,
    });

    let accounts = [];
    if (platform === "meta")   accounts = await discoverMetaAccounts(tokenRow.access_token);
    if (platform === "google") accounts = await discoverGoogleAccounts(tokenRow.access_token);
    if (platform === "tiktok") accounts = await discoverTikTokAccounts(tokenRow.access_token);

    persistDiscoveredAccounts(db, entry, platform, accounts);
    res.json({ success: true, platform, accounts_found: accounts.length });
  } catch (e) {
    console.error("[showdown-ad-cap] rediscover error:", e.message);
    res.status(500).json({ error: "Rediscovery failed", message: e.message });
  }
});

router.post("/sync-my-ad-spend", auth, async (req, res) => {
  try {
    const db = getDb();
    ensureAdCapTables(db);
    const entry = findEntryForUser(db, req.user);
    if (!entry) return res.status(404).json({ error: "No Showdown entry found for this account." });
    const result = await syncEntry(db, entry);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error("[showdown-ad-cap] sync error:", e.message);
    res.status(500).json({ error: "Sync failed" });
  }
});

router.post("/self-report-ad-spend", auth, (req, res) => {
  try {
    const db = getDb();
    ensureAdCapTables(db);
    const entry = findEntryForUser(db, req.user);
    if (!entry) return res.status(404).json({ error: "No Showdown entry found for this account." });

    const month = currentMonthKey();
    const inputs = [
      ["meta",   req.body.meta_cents],
      ["google", req.body.google_cents],
      ["tiktok", req.body.tiktok_cents],
      ["other",  req.body.other_cents],
    ];
    const upsert = db.prepare(`
      INSERT INTO showdown_ad_spend (id, entry_id, email, platform, account_id, month, spend_cents, source, synced_at)
      VALUES (?,?,?,?,?,?,?, 'self', datetime('now'))
      ON CONFLICT(entry_id, platform, account_id, month, source) DO UPDATE SET
        spend_cents = excluded.spend_cents,
        synced_at = datetime('now')
    `);
    for (const [platform, raw] of inputs) {
      const cents = Math.max(0, Math.min(100000000, parseInt(raw, 10) || 0));
      upsert.run(uuid(), entry.id, entry.email, platform, SELF_REPORT_ACCOUNT, month, cents);
    }
    const reconciled = reconcileExclusion(db, entry, month);
    res.json({ success: true, ...reconciled });
  } catch (e) {
    console.error("[showdown-ad-cap] self-report error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CRON
// ═════════════════════════════════════════════════════════════════════════════

router.post("/cron/sync-ad-spend", async (req, res) => {
  const provided = req.headers["x-cron-key"] || "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const db = getDb();
    ensureAdCapTables(db);

    // Active entries that have either an ad_account row, an OAuth token in
    // user_social_tokens (joined via email→user_id), or a legacy single-ID column.
    const entries = db.prepare(`
      SELECT DISTINCT se.*
        FROM showdown_entries se
        LEFT JOIN showdown_ad_accounts a ON a.entry_id = se.id AND a.active = 1
        LEFT JOIN users u                ON u.email   = se.email
        LEFT JOIN user_social_tokens t   ON t.user_id = u.id
                                        AND t.platform IN ('meta-ads','google-ads','tiktok-ads')
       WHERE se.status NOT IN ('reviewed','paid','claim_submitted')
         AND (se.review_result IS NULL OR se.review_result != 'win')
         AND (a.id IS NOT NULL
              OR t.id IS NOT NULL
              OR se.ad_meta_account_id IS NOT NULL
              OR se.ad_google_customer_id IS NOT NULL
              OR se.ad_tiktok_advertiser_id IS NOT NULL)
    `).all();

    let synced = 0, excluded = 0, errors = 0;
    for (const entry of entries) {
      try {
        // Lightweight rediscovery for Meta + Google before each sync.
        // Catches accounts the user gained access to since they connected.
        // TikTok rediscovery is omitted from the per-cron path because the
        // advertiser-list endpoint is rate-strict; users can hit
        // /api/showdown/rediscover/tiktok manually.
        const userId = getUserIdForEntry(db, entry);
        if (userId) {
          for (const platform of ["meta", "google"]) {
            const tokenRow = await getAdsToken(db, userId, platform);
            if (!tokenRow) continue;
            try {
              let discovered = [];
              if (platform === "meta")   discovered = await discoverMetaAccounts(tokenRow.access_token);
              if (platform === "google") discovered = await discoverGoogleAccounts(tokenRow.access_token);
              persistDiscoveredAccounts(db, entry, platform, discovered);
            } catch (e) {
              console.warn("[ad-cap cron] rediscovery", platform, entry.id, e.message);
            }
          }
        }

        const r = await syncEntry(db, entry);
        synced++;
        if (r.excluded) excluded++;
        if (r.errors && r.errors.length) errors += r.errors.length;
      } catch (e) {
        errors++;
        console.error("[showdown-ad-cap cron] entry", entry.id, e.message);
      }
    }
    res.json({ success: true, total: entries.length, synced, excluded, errors });
  } catch (e) {
    console.error("[showdown-ad-cap] cron error:", e.message);
    res.status(500).json({ error: "Cron failed" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN
// ═════════════════════════════════════════════════════════════════════════════

router.get("/admin/ad-cap-summary", auth, adminOnly, (req, res) => {
  try {
    const db = getDb();
    ensureAdCapTables(db);
    const month = currentMonthKey();

    const rows = db.prepare(`
      SELECT se.id, se.email, se.name, se.competitor_url,
             se.ad_cap_excluded_month, se.ad_spend_last_synced_at,
             COALESCE((
               SELECT SUM(plat_max) FROM (
                 SELECT MAX(summed) AS plat_max
                   FROM (
                     SELECT platform, source, SUM(spend_cents) AS summed
                       FROM showdown_ad_spend
                      WHERE entry_id = se.id AND month = ?
                      GROUP BY platform, source
                   )
                  GROUP BY platform
               )
             ), 0) AS spent_cents
        FROM showdown_entries se
       WHERE se.status NOT IN ('paid')
       ORDER BY spent_cents DESC
       LIMIT 500
    `).all(month);

    const overCap = rows.filter(r => r.spent_cents > AD_CAP_CENTS).length;
    const nearCap = rows.filter(r => r.spent_cents > AD_CAP_CENTS * 0.8 && r.spent_cents <= AD_CAP_CENTS).length;

    res.json({
      month,
      cap_cents: AD_CAP_CENTS,
      total_entries: rows.length,
      over_cap: overCap,
      near_cap: nearCap,
      entries: rows.map(r => ({ ...r, excluded_this_month: r.ad_cap_excluded_month === month })),
    });
  } catch (e) {
    console.error("[showdown-ad-cap] admin summary error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/admin/force-exclude/:entryId", auth, adminOnly, (req, res) => {
  try {
    const db = getDb();
    const entryId = req.params.entryId;
    const exclude = req.body.exclude !== false;
    const month = currentMonthKey();
    const flag = exclude ? month : null;
    const result = db.prepare(
      "UPDATE showdown_entries SET ad_cap_excluded_month = ? WHERE id = ?"
    ).run(flag, entryId);
    if (result.changes === 0) return res.status(404).json({ error: "Entry not found." });
    res.json({ success: true, entry_id: entryId, excluded: !!exclude, month });
  } catch (e) {
    console.error("[showdown-ad-cap] force-exclude error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;
module.exports.AD_CAP_CENTS              = AD_CAP_CENTS;
module.exports.SUPPORTED_PLATFORMS       = SUPPORTED_PLATFORMS;
module.exports.currentMonthKey           = currentMonthKey;
module.exports.computeSpendCentsForMonth = computeSpendCentsForMonth;
module.exports.reconcileExclusion        = reconcileExclusion;
module.exports.syncEntry                 = syncEntry;
module.exports.discoverForUser           = discoverForUser; // called by social-oauth.js callbacks
