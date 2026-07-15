/**
 * Hourly auto-sync for connected integrations (Mailchimp + Shopify).
 *
 * Run from server.js setInterval with cronOwn lease to ensure single-replica.
 *
 *   const { runAutoSync } = require("./sync/auto-sync");
 *   if (cronOwn("integrations_auto_sync", 60 * 60 * 1000)) {
 *     await runAutoSync();
 *   }
 *
 * For each user with saved credentials and auto_sync_enabled=1:
 *   - Mailchimp: fetch members changed since last_sync_at, insert new contacts
 *   - Shopify:   fetch orders updated since last_sync_at, upsert orders
 *
 * Failures for one user don't affect others (try/catch per user).
 * last_sync_at is only updated when sync succeeds.
 */
"use strict";

const crypto = require("crypto");

function uuid() { return crypto.randomBytes(16).toString("hex"); }

// ── (#4) fetchWithBackoff: handles 429 + transient 5xx with exponential backoff ─
// Honors the Retry-After header when present. Retries up to 3 times.
async function fetchWithBackoff(url, opts = {}, maxAttempts = 3) {
  const fetch = (await import("node-fetch")).default;
  let attempt = 0;
  let lastResponse;
  while (attempt < maxAttempts) {
    const r = await fetch(url, opts);
    if (r.status !== 429 && r.status < 500) return r;       // success or non-retriable
    if (attempt === maxAttempts - 1) return r;              // last attempt — return as-is

    let waitMs;
    const retryAfter = r.headers.get("retry-after");
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      waitMs = isNaN(seconds) ? 2000 : Math.min(seconds * 1000, 30000); // cap at 30s
    } else {
      waitMs = Math.min(1000 * Math.pow(2, attempt), 8000); // 1s, 2s, 4s
    }
    console.warn(`[auto-sync] ${url.split('/')[2]} returned ${r.status} — backing off ${waitMs}ms (attempt ${attempt+1}/${maxAttempts})`);
    await new Promise(rs => setTimeout(rs, waitMs));
    lastResponse = r;
    attempt++;
  }
  return lastResponse;
}

function decrypt(ct, ivB, tagB, userId) {
  const vaultKey = process.env.CREDENTIAL_VAULT_KEY || "";
  if (!vaultKey || vaultKey.length < 64 || !/^[0-9a-fA-F]{64,}$/.test(vaultKey)) {
    throw new Error("CREDENTIAL_VAULT_KEY missing or invalid (need 64-char hex)");
  }
  const key = crypto.createHmac("sha256", Buffer.from(vaultKey.slice(0, 64), "hex"))
                    .update(String(userId)).digest();
  const iv  = Buffer.from(ivB, "base64");
  const tag = Buffer.from(tagB, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// Augment the table to track sync state on first use
function ensureSyncColumns(db) {
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN auto_sync_enabled INTEGER DEFAULT 1"); } catch(_) {}
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_at TEXT"); } catch(_) {}
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_status TEXT"); } catch(_) {}
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_count INTEGER"); } catch(_) {}
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN consecutive_failures INTEGER DEFAULT 0"); } catch(_) {}
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_failure_email_at TEXT"); } catch(_) {}
}

// ── (#5) Send the user an email + in-app notification when sync has failed
// 3 times in a row. Suppressed for 24h after sending one to avoid spam.
//
// If SENDGRID_API_KEY isn't configured, the in-app notification still gets
// written so the user has visibility through the dashboard.
async function emailUserAboutSyncFailure(db, userId, service, errorMsg) {
  const serviceName = service.charAt(0).toUpperCase() + service.slice(1);
  const safeErrorMsg = errorMsg ? String(errorMsg).replace(/[<>]/g, "").slice(0, 200) : "Unknown error";

  // ── In-app notification (always) — visible as a banner in the dashboard ──
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS user_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT,
      severity TEXT,
      title TEXT,
      body TEXT,
      action_url TEXT,
      action_label TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id_read ON user_notifications(user_id, read)"); } catch(_) {}

    // Don't insert duplicate unread notification for the same failing service
    const existingUnread = db.prepare(`SELECT id FROM user_notifications
                                       WHERE user_id = ? AND type = ? AND read = 0`)
                              .get(userId, `sync_failure:${service}`);
    if (!existingUnread) {
      db.prepare(`INSERT INTO user_notifications (id, user_id, type, severity, title, body, action_url, action_label)
                  VALUES (?,?,?,?,?,?,?,?)`)
        .run(uuid(), userId, `sync_failure:${service}`, "error",
             `${serviceName} sync needs attention`,
             `Your ${serviceName} integration has failed 3 times in a row. Latest error: ${safeErrorMsg}. ` +
             `This usually means your API key was revoked. Reconnect to fix it.`,
             `/dashboard#panel-integrations`, "Reconnect");
    }
  } catch(e) { console.error("[auto-sync] failed to write in-app notification:", e.message); }

  // ── Email notification (best-effort, requires SendGrid) ──
  try {
    const user = db.prepare("SELECT email, name FROM users WHERE id = ?").get(userId);
    if (!user?.email) return;
    const sgKey = process.env.SENDGRID_API_KEY ||
      db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value;
    if (!sgKey) {
      console.warn(`[auto-sync] No SendGrid key — in-app notification only for user ${userId} (${service})`);
      // Still mark email as "sent" so the 24h cooldown applies to the in-app
      // notification (we don't want to re-spam the notifications table either)
      try {
        db.prepare("UPDATE user_integration_keys SET last_failure_email_at = datetime('now') WHERE user_id = ? AND service = ?")
          .run(userId, service);
      } catch(_) {}
      return;
    }
    const fromEmail = process.env.SENDGRID_FROM_EMAIL ||
      db.prepare("SELECT value FROM platform_settings WHERE key = 'EMAIL_FROM'").get()?.value ||
      "hello@takeova.ai";

    const fetch = (await import("node-fetch")).default;
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: user.email, name: user.name || "" }] }],
        from: { email: fromEmail, name: "MINE" },
        subject: `Action needed: Your ${serviceName} connection needs to be reconnected`,
        content: [{
          type: "text/html",
          value:
            `<p>Hi ${user.name || "there"},</p>` +
            `<p>Your <b>${serviceName}</b> integration in MINE has failed to sync 3 times in a row.</p>` +
            `<p><b>Latest error:</b> ${safeErrorMsg}</p>` +
            `<p>This usually means your API key was revoked or your store/account changed. To fix it:</p>` +
            `<ol><li>Open MINE → Integrations</li><li>Find your ${serviceName} card</li><li>Click <b>Disconnect</b>, then reconnect with a fresh key</li></ol>` +
            `<p>Until you reconnect, your contacts and orders won't auto-sync from ${serviceName}.</p>` +
            `<p>— MINE</p>`,
        }],
      }),
    });
    // Mark email sent so we don't spam them
    db.prepare("UPDATE user_integration_keys SET last_failure_email_at = datetime('now') WHERE user_id = ? AND service = ?")
      .run(userId, service);
  } catch(e) {
    console.error("[auto-sync] failed to email user about sync failure:", e.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Mailchimp incremental sync
// ════════════════════════════════════════════════════════════════════════════
async function syncMailchimpForUser(db, userId, apiKey, meta) {
  if (!meta || !meta.listId) {
    // User connected Mailchimp but never picked a list yet — auto-sync will
    // activate after they pick a list via the manual import button at least once.
    return { skipped: true, reason: "awaiting first manual import (so we know which list to sync)" };
  }

  const dash = apiKey.lastIndexOf("-");
  const dc = dash > 0 ? apiKey.slice(dash + 1) : null;
  if (!dc) return { error: "invalid api key" };

  // (#1) Ensure contacts has an external_id column so we can dedupe by
  // Mailchimp's stable unique_email_id (survives email address changes).
  try { db.exec("ALTER TABLE contacts ADD COLUMN external_id TEXT"); } catch(_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_contacts_external_id ON contacts(user_id, external_id)"); } catch(_) {}

  const sinceParam = meta.lastSyncAt ? `&since_last_changed=${encodeURIComponent(meta.lastSyncAt)}` : "";

  const headers = { Authorization: "Basic " + Buffer.from("anystring:" + apiKey).toString("base64") };

  let imported = 0, skipped = 0, updated = 0, unsubscribed = 0, pagesScanned = 0, offset = 0;
  const pageSize = 1000;
  const MAX_PAGES = 50;
  const latestChangedSeen = []; // collect to compute new high-watermark

  // (#3) Compute checkpoint helper — used both on success and on error mid-sync
  function checkpoint() {
    return latestChangedSeen.length > 0
      ? latestChangedSeen.sort().slice(-1)[0]
      : meta.lastSyncAt || null;
  }

  while (pagesScanned < MAX_PAGES) {
    const url = `https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(meta.listId)}/members` +
                `?count=${pageSize}&offset=${offset}` +
                `&fields=members.id,members.unique_email_id,members.email_address,members.merge_fields,members.status,members.tags,members.last_changed,total_items` +
                sinceParam;
    const r = await fetchWithBackoff(url, { headers });
    if (!r.ok) {
      // (#3) Return checkpoint watermark so next sync starts after the last
      // successful page, not from scratch.
      return {
        error: `mailchimp ${r.status}`,
        newWatermark: checkpoint(),
        imported, updated, unsubscribed, skipped, pagesScanned,
      };
    }
    const data = await r.json();
    const members = data.members || [];
    if (members.length === 0) break;

    for (const m of members) {
      const email = (m.email_address || "").toLowerCase().trim();
      if (!email) { skipped++; continue; }
      const mcStatus = m.status || "subscribed";
      if (m.last_changed) latestChangedSeen.push(m.last_changed);

      // (#1) Mailchimp's unique_email_id is stable across email changes
      // (the subscriber ID). Match on this first to handle "user changed
      // their email in Mailchimp" without creating a duplicate in MINE.
      const externalId = m.unique_email_id ? "mailchimp:" + m.unique_email_id : null;

      let existing = null;
      if (externalId) {
        existing = db.prepare("SELECT id, name, phone, tags, status, email FROM contacts WHERE user_id = ? AND external_id = ?")
                     .get(userId, externalId);
      }
      // Fallback: legacy contacts inserted before external_id column was added,
      // or contacts created via manual import without a Mailchimp ID. Match by
      // email, and backfill the external_id so future syncs use the stable ID.
      if (!existing) {
        existing = db.prepare("SELECT id, name, phone, tags, status, email, external_id FROM contacts WHERE user_id = ? AND email = ?")
                     .get(userId, email);
        if (existing && externalId && !existing.external_id) {
          try {
            db.prepare("UPDATE contacts SET external_id = ? WHERE id = ?").run(externalId, existing.id);
          } catch(_) {}
        }
      }

      // ── (#2) Propagate unsubscribes/cleaned status to MINE ──
      if (mcStatus === "unsubscribed" || mcStatus === "cleaned") {
        if (existing && existing.status !== "unsubscribed") {
          try {
            db.prepare("UPDATE contacts SET status = 'unsubscribed', notes = COALESCE(notes,'') || ? WHERE id = ?")
              .run(`\nMailchimp marked as ${mcStatus} on ${new Date().toISOString().slice(0,10)}`, existing.id);
            unsubscribed++;
          } catch(_) { skipped++; }
        } else {
          skipped++;
        }
        continue;
      }

      // Only proceed for subscribed / pending
      if (mcStatus !== "subscribed" && mcStatus !== "pending") { skipped++; continue; }

      const mf = m.merge_fields || {};
      const newName = `${mf.FNAME || ""} ${mf.LNAME || ""}`.trim() || email.split("@")[0];
      const newPhone = mf.PHONE || "";
      const newTags = Array.isArray(m.tags) ? m.tags.map(t => t.name || t).filter(Boolean) : [];
      if (!newTags.includes("mailchimp-sync")) newTags.unshift("mailchimp-sync");

      if (existing) {
        // ── (#1) Update existing contact: name, phone, tags, status, AND email
        // since Mailchimp may have changed the email but external_id is stable.
        let existingTags = [];
        try { existingTags = JSON.parse(existing.tags || "[]"); } catch(_) {}
        const emailChanged = existing.email !== email;
        const nameChanged = existing.name !== newName;
        const phoneChanged = (existing.phone || "") !== newPhone;
        const tagsChanged = JSON.stringify(existingTags.slice().sort()) !== JSON.stringify(newTags.slice().sort());
        const statusChanged = existing.status === "unsubscribed"; // resubscribed → bring back

        if (emailChanged || nameChanged || phoneChanged || tagsChanged || statusChanged) {
          try {
            db.prepare(`UPDATE contacts SET email = ?, name = ?, phone = ?, tags = ?, status = ? WHERE id = ?`)
              .run(email, newName, newPhone, JSON.stringify(newTags),
                   statusChanged ? "lead" : existing.status, existing.id);
            updated++;
          } catch(_) { skipped++; }
        } else {
          skipped++;
        }
        continue;
      }

      // New contact → insert (with external_id when available)
      try {
        db.prepare(`INSERT INTO contacts (id, user_id, name, email, phone, status, source, tags, notes, external_id, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
          .run(uuid(), userId, newName, email, newPhone, "lead", "mailchimp_sync",
               JSON.stringify(newTags),
               `Auto-synced from Mailchimp list ${meta.listId}. Status: ${mcStatus}.`,
               externalId);
        imported++;
      } catch(_) { skipped++; }
    }

    pagesScanned++;
    offset += pageSize;
    if (members.length < pageSize) break;
  }

  return { imported, updated, unsubscribed, skipped, pagesScanned, newWatermark: checkpoint() || new Date().toISOString() };
}

// ════════════════════════════════════════════════════════════════════════════
// Shopify orders incremental sync
// ════════════════════════════════════════════════════════════════════════════
async function syncShopifyForUser(db, userId, accessToken, meta) {
  if (!meta || !meta.shopDomain) return { error: "no shop domain saved" };
  const domain = meta.shopDomain;

  // Domain re-validation (defense-in-depth)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\.]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/.test(domain) ||
      /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i.test(domain)) {
    return { error: "invalid domain" };
  }

  const headers = { "X-Shopify-Access-Token": accessToken };

  const since = meta.lastSyncAt ? `&updated_at_min=${encodeURIComponent(meta.lastSyncAt)}` : "";
  let url = `https://${domain}/admin/api/2024-01/orders.json?limit=250&status=any${since}`;

  let imported = 0, skipped = 0, updated = 0, pagesScanned = 0;
  const MAX_PAGES = 20;
  const latestUpdatedSeen = [];

  const site = db.prepare("SELECT id FROM sites WHERE user_id = ? LIMIT 1").get(userId);
  const siteId = site?.id || null;

  function mapStatus(fin) {
    if (!fin) return "pending";
    if (fin === "paid" || fin === "partially_paid") return "paid";
    if (fin === "pending" || fin === "authorized") return "pending";
    if (fin === "refunded") return "refunded";
    if (fin === "partially_refunded") return "partially_refunded";
    if (fin === "voided") return "cancelled";
    return "pending";
  }
  function mapFulfillment(f) {
    if (!f) return "unfulfilled";
    if (f === "fulfilled") return "fulfilled";
    if (f === "partial") return "partial";
    return "unfulfilled";
  }
  function isValidPaginationUrl(u) {
    try { const p = new URL(u); return p.protocol === "https:" && p.hostname === domain; }
    catch(_) { return false; }
  }

  // (#3) Compute checkpoint helper so errors mid-sync don't lose progress
  function checkpoint() {
    return latestUpdatedSeen.length > 0
      ? latestUpdatedSeen.sort().slice(-1)[0]
      : meta.lastSyncAt || null;
  }

  while (pagesScanned < MAX_PAGES) {
    const r = await fetchWithBackoff(url, { headers });
    if (!r.ok) {
      return {
        error: `shopify ${r.status}`,
        newWatermark: checkpoint(),
        imported, updated, skipped, pagesScanned,
      };
    }
    const data = await r.json();
    const orders = data.orders || [];
    if (orders.length === 0) break;

    for (const o of orders) {
      const externalId = "shopify_" + String(o.id);
      const existing = db.prepare("SELECT id, status FROM orders WHERE user_id = ? AND stripe_session_id = ?")
                         .get(userId, externalId);
      const newStatus = mapStatus(o.financial_status);

      if (existing) {
        // Order exists — update status if it changed (refunds, fulfillment)
        if (existing.status !== newStatus) {
          db.prepare("UPDATE orders SET status = ?, fulfillment_status = ?, notes = ? WHERE id = ?")
            .run(newStatus, mapFulfillment(o.fulfillment_status),
                 `Auto-sync update from Shopify on ${new Date().toISOString().slice(0,10)}`,
                 existing.id);
          updated++;
        } else {
          skipped++;
        }
        if (o.updated_at) latestUpdatedSeen.push(o.updated_at);
        continue;
      }

      // New order — insert
      const items = (o.line_items || []).map(li => ({
        name: li.title || "",
        variant: li.variant_title || "",
        quantity: li.quantity || 1,
        price: parseFloat(li.price) || 0,
        sku: li.sku || "",
      }));
      const shipping = o.shipping_address || {};
      const customerName = o.customer
        ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() || (o.email || "")
        : (shipping.name || o.email || "");

      try {
        db.prepare(`INSERT INTO orders (
            id, site_id, user_id, order_number, customer_name, customer_email,
            items, total, shipping_name, shipping_address,
            status, fulfillment_status, stripe_session_id, notes, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuid(), siteId, userId, o.order_number || String(o.id),
               customerName, o.email || "",
               JSON.stringify(items), parseFloat(o.total_price) || 0,
               shipping.name || customerName, JSON.stringify(shipping),
               newStatus, mapFulfillment(o.fulfillment_status),
               externalId, `Auto-synced from Shopify`,
               o.created_at || new Date().toISOString());
        imported++;
        if (o.updated_at) latestUpdatedSeen.push(o.updated_at);
      } catch(_) { skipped++; }
    }

    // Cursor pagination
    const linkHeader = r.headers.get("link") || "";
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (!nextMatch || !isValidPaginationUrl(nextMatch[1])) break;
    url = nextMatch[1];
    pagesScanned++;
    await new Promise(rs => setTimeout(rs, 100));
  }

  return { imported, updated, skipped, pagesScanned, newWatermark: checkpoint() || new Date().toISOString() };
}

// ════════════════════════════════════════════════════════════════════════════
// Main cron entry point
// ════════════════════════════════════════════════════════════════════════════
async function runAutoSync(db) {
  ensureSyncColumns(db);

  // Pick users due for sync: last_sync_at older than 50 minutes (or never synced).
  // Buffer of 50min (not 60) ensures we don't drift due to cron tick timing.
  const fiftyMinAgo = new Date(Date.now() - 50 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT id, user_id, service, ciphertext, iv, auth_tag, meta, last_sync_at,
           COALESCE(consecutive_failures, 0) AS consecutive_failures,
           last_failure_email_at
    FROM user_integration_keys
    WHERE COALESCE(auto_sync_enabled, 1) = 1
      AND (last_sync_at IS NULL OR last_sync_at < ?)
  `).all(fiftyMinAgo);

  if (rows.length === 0) return { totalChecked: 0, ran: 0 };

  let ran = 0, succeeded = 0, failed = 0, emailsSent = 0;
  let totalImported = 0, totalUpdated = 0;

  for (const row of rows) {
    ran++;
    let apiKey;
    let meta = {};
    try {
      apiKey = decrypt(row.ciphertext, row.iv, row.auth_tag, row.user_id);
      meta = JSON.parse(row.meta || "{}");
    } catch(e) {
      console.error(`[auto-sync] decrypt failed for user ${row.user_id} (${row.service}):`, e.message);
      try {
        db.prepare("UPDATE user_integration_keys SET last_sync_at=datetime('now'), last_sync_status='decrypt_failed', consecutive_failures=COALESCE(consecutive_failures,0)+1 WHERE id=?").run(row.id);
      } catch(_) {}
      failed++;
      continue;
    }

    meta.lastSyncAt = row.last_sync_at;

    let result;
    try {
      if (row.service === "mailchimp") {
        result = await syncMailchimpForUser(db, row.user_id, apiKey, meta);
      } else if (row.service === "shopify") {
        result = await syncShopifyForUser(db, row.user_id, apiKey, meta);
      } else {
        result = { skipped: true, reason: "unsupported service" };
      }
    } catch(e) {
      console.error(`[auto-sync] ${row.service} sync failed for user ${row.user_id}:`, e.message);
      result = { error: e.message };
    }

    // Update sync state
    try {
      const newWatermark = result.newWatermark || row.last_sync_at;
      const status = result.error ? `error: ${result.error.slice(0, 80)}` :
                     result.skipped ? `skipped: ${result.reason}` :
                     "ok";
      const count = (result.imported || 0) + (result.updated || 0);
      const isError = !!result.error;
      const newFailures = isError ? (row.consecutive_failures + 1) : 0;

      const cleanMeta = { ...meta };
      delete cleanMeta.lastSyncAt;

      db.prepare(`UPDATE user_integration_keys SET
                    last_sync_at = ?,
                    last_sync_status = ?,
                    last_sync_count = ?,
                    meta = ?,
                    consecutive_failures = ?
                  WHERE id = ?`)
        .run(newWatermark, status, count, JSON.stringify(cleanMeta), newFailures, row.id);

      // (#5) Email user when 3 consecutive failures, suppress for 24h thereafter
      if (newFailures >= 3) {
        const recentEmail = row.last_failure_email_at &&
          (Date.now() - new Date(row.last_failure_email_at).getTime() < 24 * 60 * 60 * 1000);
        if (!recentEmail) {
          await emailUserAboutSyncFailure(db, row.user_id, row.service, result.error || "Unknown error");
          emailsSent++;
        }
      }

      if (isError) failed++;
      else {
        succeeded++;
        totalImported += result.imported || 0;
        totalUpdated  += result.updated  || 0;
      }
    } catch(e) {
      console.error("[auto-sync] state update failed:", e.message);
      failed++;
    }

    await new Promise(rs => setTimeout(rs, 250));
  }

  console.log(`[auto-sync] checked=${rows.length} ran=${ran} ok=${succeeded} failed=${failed} imported=${totalImported} updated=${totalUpdated} emailsSent=${emailsSent}`);
  return { totalChecked: rows.length, ran, succeeded, failed, totalImported, totalUpdated, emailsSent };
}

// ── Sync a single user's specific service immediately (used after connect) ──
async function runAutoSyncForUser(db, userId, service) {
  ensureSyncColumns(db);
  const row = db.prepare(`
    SELECT id, user_id, service, ciphertext, iv, auth_tag, meta, last_sync_at,
           COALESCE(consecutive_failures, 0) AS consecutive_failures
    FROM user_integration_keys WHERE user_id = ? AND service = ?
  `).get(userId, service);
  if (!row) return { error: "not connected" };

  let apiKey, meta = {};
  try {
    apiKey = decrypt(row.ciphertext, row.iv, row.auth_tag, row.user_id);
    meta = JSON.parse(row.meta || "{}");
  } catch(e) { return { error: "decrypt failed" }; }

  meta.lastSyncAt = row.last_sync_at;

  let result;
  try {
    if (service === "mailchimp")     result = await syncMailchimpForUser(db, userId, apiKey, meta);
    else if (service === "shopify")  result = await syncShopifyForUser(db, userId, apiKey, meta);
    else return { error: "unsupported service" };
  } catch(e) { return { error: e.message }; }

  // Update sync state same as batch path
  const newWatermark = result.newWatermark || row.last_sync_at;
  const status = result.error ? `error: ${result.error.slice(0, 80)}` :
                 result.skipped ? `skipped: ${result.reason}` : "ok";
  const count = (result.imported || 0) + (result.updated || 0);
  const isError = !!result.error;
  const newFailures = isError ? (row.consecutive_failures + 1) : 0;
  const cleanMeta = { ...meta };
  delete cleanMeta.lastSyncAt;
  try {
    db.prepare(`UPDATE user_integration_keys SET
                  last_sync_at = ?, last_sync_status = ?, last_sync_count = ?,
                  meta = ?, consecutive_failures = ?
                WHERE id = ?`)
      .run(newWatermark, status, count, JSON.stringify(cleanMeta), newFailures, row.id);
  } catch(_) {}
  console.log(`[auto-sync] immediate sync for user=${userId} service=${service} status=${status} count=${count}`);
  return result;
}

module.exports = { runAutoSync, ensureSyncColumns, runAutoSyncForUser };
