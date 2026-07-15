#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// MINE — Backend Pre-flight Check
// ═══════════════════════════════════════════════════════════════════════
// Run BEFORE starting the server to catch config issues early.
//
// Usage:   node scripts/preflight.js
// Or add to start script:
//   "scripts": { "start": "node scripts/preflight.js && node server.js" }
//
// Exits 0 if all required vars present and look valid.
// Exits 1 if any required var is missing or obviously malformed.
// Logs warnings for optional vars that are missing.
// ═══════════════════════════════════════════════════════════════════════

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const COLOR = {
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  gray:   (s) => `\x1b[90m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

// Each check: { key, required, description, validate? }
const CHECKS = [
  // Core
  { key: "NODE_ENV",         required: true,  desc: "Environment mode" },
  { key: "PORT",             required: true,  desc: "Backend port", validate: (v) => /^\d+$/.test(v) && +v > 0 && +v < 65536 },
  { key: "FRONTEND_URL",     required: true,  desc: "Frontend URL",   validate: (v) => /^https?:\/\//.test(v) },
  { key: "BACKEND_URL",      required: true,  desc: "Backend URL",    validate: (v) => /^https?:\/\//.test(v) },
  { key: "JWT_SECRET",       required: true,  desc: "JWT signing secret", validate: (v) => v.length >= 16 },
  { key: "INTERNAL_API_KEY", required: true,  desc: "Internal API key",  validate: (v) => v.length >= 16 },
  { key: "CRON_SECRET",      required: true,  desc: "Cron secret",       validate: (v) => v.length >= 16 },

  // Database
  { key: "DATABASE_URL",     required: false, desc: "Postgres URL (falls back to SQLite)" },

  // Email
  { key: "SENDGRID_API_KEY", required: true,  desc: "SendGrid API key", validate: (v) => v.startsWith("SG.") && v.length > 20 },
  { key: "EMAIL_FROM",       required: true,  desc: "Sender email",     validate: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) },
  { key: "ADMIN_EMAIL",      required: false, desc: "Admin email" },

  // Payments
  { key: "STRIPE_SECRET_KEY",     required: true,  desc: "Stripe secret",      validate: (v) => /^sk_(live|test)_/.test(v) },
  { key: "STRIPE_PUBLISHABLE_KEY",required: false, desc: "Stripe publishable", validate: (v) => /^pk_(live|test)_/.test(v) },
  { key: "STRIPE_WEBHOOK_SECRET", required: true,  desc: "Stripe webhook secret", validate: (v) => v.startsWith("whsec_") },

  // AI
  { key: "ANTHROPIC_API_KEY", required: true,  desc: "Anthropic API key", validate: (v) => v.startsWith("sk-ant-") && v.length > 50 },

  // SMS (optional)
  { key: "TWILIO_ACCOUNT_SID", required: false, desc: "Twilio SID",    validate: (v) => v.startsWith("AC") },
  { key: "TWILIO_AUTH_TOKEN",  required: false, desc: "Twilio token",  validate: (v) => v.length >= 32 },
  { key: "TWILIO_PHONE_NUMBER",required: false, desc: "Twilio number", validate: (v) => /^\+\d{8,15}$/.test(v) },

  // Cloudflare (optional but needed for custom domains)
  { key: "CLOUDFLARE_API_TOKEN",   required: false, desc: "Cloudflare API token" },
  { key: "CLOUDFLARE_ZONE_ID",     required: false, desc: "Cloudflare zone ID" },
  { key: "CLOUDFLARE_ACCOUNT_ID",  required: false, desc: "Cloudflare account ID" },
];

console.log(COLOR.bold("\n🔍 MINE Backend Pre-flight Check\n"));

let errors = 0, warnings = 0, ok = 0;

for (const c of CHECKS) {
  const val = process.env[c.key];
  if (!val || val.trim() === "") {
    if (c.required) {
      console.log(`${COLOR.red("✗ FAIL ")} ${c.key.padEnd(28)} ${COLOR.gray("(required: " + c.desc + ")")}`);
      errors++;
    } else {
      console.log(`${COLOR.yellow("⚠ WARN ")} ${c.key.padEnd(28)} ${COLOR.gray("(optional: " + c.desc + ")")}`);
      warnings++;
    }
    continue;
  }
  if (c.validate && !c.validate(val)) {
    console.log(`${COLOR.red("✗ FAIL ")} ${c.key.padEnd(28)} ${COLOR.gray("(value looks invalid: " + c.desc + ")")}`);
    errors++;
    continue;
  }
  console.log(`${COLOR.green("✓ OK   ")} ${c.key.padEnd(28)} ${COLOR.gray(c.desc)}`);
  ok++;
}

console.log();
console.log(COLOR.bold(`${ok} OK · ${warnings} warnings · ${errors} errors`));

if (errors > 0) {
  console.log(COLOR.red(`\nPre-flight failed. Fix the ${errors} required variable(s) above before starting the server.\n`));
  console.log(COLOR.gray("Tip: copy .env.template to .env and fill in the values.\n"));
  process.exit(1);
}
if (warnings > 0) {
  console.log(COLOR.yellow(`\nPre-flight passed with ${warnings} warning(s). Optional features may not work.\n`));
} else {
  console.log(COLOR.green("\nPre-flight passed. Ready to start the server.\n"));
}
process.exit(0);
