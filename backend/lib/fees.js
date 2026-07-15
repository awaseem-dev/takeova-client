/**
 * lib/fees.js — MINE platform-fee logic, extracted from routes/payments.js so it
 * can be unit-tested in isolation (no DB / Express / Stripe needed).
 *
 * This is the single source of truth for "what % does MINE take, by plan" and the
 * integer-cents fee calculation. payments.js imports from here; the values and
 * getFeeForPlan() behaviour are IDENTICAL to the previous inline copy.
 */
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || "2.5");

// Tiered platform fee by plan — what marketing promises and what code now charges.
// Defaults to 2.5% if plan is unknown/missing (safe fallback to legacy behaviour).
// Agency clients are auto-set to 'enterprise' plan, so they get 1.0% automatically.
const PLAN_FEE_PERCENT = {
  starter:        2.5,
  growth:         2.0,
  pro:            1.5,
  enterprise:     1.0,
  agency_client:  1.0,  // Agency clients get Enterprise-tier fee
  trial:          2.5,  // Treat trial users like Starter
  agency:         2.5,  // Agency owners' personal transactions (rare path)
};

function getFeeForPlan(plan, origin) {
  if (origin === "shopify") return 0; // Option A: Shopify-billed users pay no MINE platform fee
  if (!plan) return PLATFORM_FEE_PERCENT;
  return PLAN_FEE_PERCENT[plan] !== undefined ? PLAN_FEE_PERCENT[plan] : PLATFORM_FEE_PERCENT;
}

/**
 * Platform fee in INTEGER CENTS for an amount already in cents.
 * Mirrors the call-site math `Math.round(amountCents * (getFeeForPlan()/100))`.
 * Use this everywhere instead of recomputing, so the rounding is consistent.
 */
function platformFeeCents(amountCents, plan, origin) {
  const cents = Math.round(Number(amountCents) || 0);
  const pct = getFeeForPlan(plan, origin);
  return Math.round(cents * (pct / 100));
}

module.exports = { PLATFORM_FEE_PERCENT, PLAN_FEE_PERCENT, getFeeForPlan, platformFeeCents };
