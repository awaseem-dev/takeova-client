#!/usr/bin/env node
/**
 * MIGRATION: Design Studio credit packs → metered billing
 *
 * Runs once after deploying the metered conversion. Converts each user's
 * remaining credit pack balance into an initial NEGATIVE usage_tracking amount,
 * which means their monthly quota effectively starts with "+N designs already
 * prepaid" — so they get full value for what they paid, and only start
 * consuming their plan quota (or incurring overage) after exhausting legacy credits.
 *
 * Idempotent: safe to run multiple times. Checks for a migration marker in
 * platform_settings and only processes each user once.
 *
 * Usage: node backend/migrations/design-credits-to-metered.js
 */

const path = require("path");
const { getDb } = require(path.join(__dirname, "..", "db", "init"));

function getCurrentPeriod() {
  // Matches the period format used by features.js usage_tracking
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
}

function main() {
  const db = getDb();
  const period = getCurrentPeriod();
  const MIGRATION_KEY = "DESIGN_CREDIT_MIGRATION_COMPLETED_" + period;

  // Check if migration already ran this period
  const existing = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(MIGRATION_KEY);
  if (existing) {
    console.log(`[MIGRATION] Already ran this period (${period}) — skipping.`);
    console.log(`[MIGRATION] To re-run: DELETE FROM platform_settings WHERE key = '${MIGRATION_KEY}';`);
    return;
  }

  // Ensure usage_tracking table exists
  db.exec(`CREATE TABLE IF NOT EXISTS usage_tracking (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    amount REAL DEFAULT 1,
    period TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, metric, period)
  )`);

  // Find all users with non-zero credit balance
  const users = db.prepare(`
    SELECT user_id, balance
    FROM design_credits
    WHERE balance > 0
  `).all();

  console.log(`[MIGRATION] Found ${users.length} users with legacy credit balances.`);

  let converted = 0;
  let skipped = 0;

  const upsert = db.prepare(`
    INSERT INTO usage_tracking (id, user_id, metric, amount, period)
    VALUES (?, ?, 'designs', ?, ?)
    ON CONFLICT(user_id, metric, period)
    DO UPDATE SET amount = amount - excluded.amount
  `);
  // Note: we INSERT a negative-starting amount (= -balance). Since mineTrackUsage
  // increments by +1 per generation, a user with 12 legacy credits gets -12 start,
  // meaning they need to generate 12 designs + their plan cap before hitting overage.

  const markLegacy = db.prepare(`
    INSERT INTO platform_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const tx = db.transaction(() => {
    for (const u of users) {
      // Check if already migrated this user (safety)
      const alreadyMigrated = db.prepare(
        "SELECT value FROM platform_settings WHERE key = ?"
      ).get("DESIGN_MIGRATED_USER_" + u.user_id);

      if (alreadyMigrated) {
        skipped++;
        continue;
      }

      // Insert negative usage — this is the "bonus" they keep
      const negAmount = -u.balance;
      upsert.run(
        require("crypto").randomUUID(),
        u.user_id,
        negAmount,
        period
      );

      // Mark this user as migrated so we never double-apply
      markLegacy.run(
        "DESIGN_MIGRATED_USER_" + u.user_id,
        JSON.stringify({ credits: u.balance, migrated_at: new Date().toISOString(), period })
      );

      converted++;
    }

    // Mark the period-level migration complete
    markLegacy.run(MIGRATION_KEY, new Date().toISOString());
  });

  tx();

  console.log(`[MIGRATION] Converted: ${converted} users`);
  console.log(`[MIGRATION] Skipped (already migrated): ${skipped}`);
  console.log(`[MIGRATION] Complete. Users' legacy credits now applied as bonus quota.`);
  console.log(`[MIGRATION] Legacy credit balances in design_credits table are preserved for audit,`);
  console.log(`[MIGRATION] but no longer consumed by the generate flow.`);
}

if (require.main === module) {
  try {
    main();
    process.exit(0);
  } catch (e) {
    console.error("[MIGRATION] FAILED:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

module.exports = { main };
