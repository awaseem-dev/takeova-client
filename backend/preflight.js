#!/usr/bin/env node
/**
 * MINE — Pre-flight environment check
 * 
 * Run this BEFORE `npm start` to catch missing/invalid env vars
 * with readable errors instead of cryptic runtime crashes.
 * 
 * Usage:  node preflight.js
 * Exit:   0 if OK, 1 if missing REQUIRED, 2 if warnings only.
 */

require('dotenv').config();

const RED   = s => `\x1b[31m${s}\x1b[0m`;
const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const YEL   = s => `\x1b[33m${s}\x1b[0m`;
const BOLD  = s => `\x1b[1m${s}\x1b[0m`;

// ─── Required env vars (server won't work without these) ────────────────────
const REQUIRED = {
  DATABASE_URL:       { hint: 'Postgres connection string (postgres://user:pass@host/db)' },
  JWT_SECRET:         { minLen: 32, hint: 'Random 32+ char string — generate with `openssl rand -hex 32`' },
  FRONTEND_URL:       { prefix: 'http', hint: 'e.g. https://takeova.ai' },
  BACKEND_URL:        { prefix: 'http', hint: 'e.g. https://api.takeova.ai' },
  PORT:               { numeric: true, hint: 'Port number, e.g. 3001' },
  ADMIN_EMAIL:        { contains: '@', hint: 'Your admin login email' },
  INTERNAL_API_KEY:   { minLen: 16, hint: 'Random string for internal endpoint auth' },
  CRON_SECRET:        { minLen: 16, hint: 'Random string for scheduled job auth' },
};

// ─── Feature-gated env vars (feature simply disabled if missing) ────────────
const FEATURE_GATED = {
  'Stripe billing': {
    STRIPE_SECRET_KEY:     { prefix: 'sk_' },
    STRIPE_WEBHOOK_SECRET: { prefix: 'whsec_' },
  },
  'SendGrid email': {
    SENDGRID_API_KEY: { prefix: 'SG.', minLen: 40 },
    EMAIL_FROM:       { contains: '@' },
  },
  'Twilio SMS': {
    TWILIO_ACCOUNT_SID:  { prefix: 'AC' },
    TWILIO_AUTH_TOKEN:   { minLen: 30 },
    TWILIO_PHONE_NUMBER: { prefix: '+' },
  },
  'Anthropic AI': {
    ANTHROPIC_API_KEY: { prefix: 'sk-ant-', minLen: 40 },
  },
  'Cloudflare DNS/hosting': {
    CLOUDFLARE_API_TOKEN:  { minLen: 20 },
    CLOUDFLARE_ZONE_ID:    { minLen: 20 },
    CLOUDFLARE_ACCOUNT_ID: { minLen: 20 },
  },
  'Google OAuth': {
    GOOGLE_CLIENT_ID:     { contains: 'apps.googleusercontent.com' },
    GOOGLE_CLIENT_SECRET: { minLen: 20 },
  },
};

function validate(key, rules) {
  const v = process.env[key];
  if (!v || v.trim() === '') return { ok: false, reason: 'not set' };
  if (rules.minLen && v.length < rules.minLen) return { ok: false, reason: `too short (${v.length} chars, need ${rules.minLen}+)` };
  if (rules.prefix && !v.startsWith(rules.prefix)) return { ok: false, reason: `should start with "${rules.prefix}" (got "${v.slice(0,8)}…")` };
  if (rules.contains && !v.includes(rules.contains)) return { ok: false, reason: `should contain "${rules.contains}"` };
  if (rules.numeric && isNaN(parseInt(v))) return { ok: false, reason: 'should be a number' };
  return { ok: true };
}

console.log(BOLD('\n━━━ MINE Pre-flight Environment Check ━━━\n'));

// Required
let missingRequired = 0;
console.log(BOLD('REQUIRED (server will fail without these):'));
for (const [key, rules] of Object.entries(REQUIRED)) {
  const r = validate(key, rules);
  if (r.ok) {
    console.log(`  ${GREEN('✓')} ${key}`);
  } else {
    console.log(`  ${RED('✗')} ${key} — ${r.reason}`);
    if (rules.hint) console.log(`       ${YEL('hint:')} ${rules.hint}`);
    missingRequired++;
  }
}

// Feature-gated
let disabledFeatures = [];
console.log(BOLD('\nFEATURE-GATED (feature disabled if incomplete):'));
for (const [feature, keys] of Object.entries(FEATURE_GATED)) {
  const results = Object.entries(keys).map(([k, r]) => ({ key: k, ...validate(k, r) }));
  const allOk = results.every(r => r.ok);
  if (allOk) {
    console.log(`  ${GREEN('✓')} ${feature} — ready`);
  } else {
    const missing = results.filter(r => !r.ok);
    console.log(`  ${YEL('○')} ${feature} — disabled (missing ${missing.map(m => m.key).join(', ')})`);
    disabledFeatures.push(feature);
  }
}

// Summary
console.log(BOLD('\n━━━ Summary ━━━'));
const isStandalone = require.main === module;

if (missingRequired > 0) {
  console.log(RED(`✗ ${missingRequired} REQUIRED variable(s) missing. Server will not function correctly.`));
  console.log(`  Fix ${RED('backend/.env')}, then re-run this script.`);
  // Always exit on missing required — server can't work without them
  process.exit(1);
}
if (disabledFeatures.length > 0) {
  console.log(YEL(`⚠ ${disabledFeatures.length} feature(s) disabled. Server will start, but these won't work:`));
  disabledFeatures.forEach(f => console.log(`    — ${f}`));
  console.log(`  This is OK for local dev. Add the keys before production deploy.\n`);
  // Only exit when run as `node preflight.js`. When required by server.js,
  // we just log the warnings and return so the server can keep booting.
  if (isStandalone) process.exit(2);
} else {
  console.log(GREEN('✓ All checks passed. Ready to start.\n'));
  if (isStandalone) process.exit(0);
}
// When required by server.js, fall through silently — server keeps booting
