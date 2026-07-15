// tests/unit/fees.test.js
// Run: node --test   (from the backend/ directory)
// Pins the platform-fee table + the integer-cents math. No DB/Stripe/Express needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { getFeeForPlan, platformFeeCents, PLAN_FEE_PERCENT } = require("../../lib/fees");

test("each plan charges its advertised rate", () => {
  assert.equal(getFeeForPlan("starter"), 2.5);
  assert.equal(getFeeForPlan("growth"), 2.0);
  assert.equal(getFeeForPlan("pro"), 1.5);
  assert.equal(getFeeForPlan("enterprise"), 1.0);
  assert.equal(getFeeForPlan("agency_client"), 1.0);
  assert.equal(getFeeForPlan("trial"), 2.5);
});

test("unknown / missing plan falls back to the 2.5% default (legacy-safe)", () => {
  assert.equal(getFeeForPlan(undefined), 2.5);
  assert.equal(getFeeForPlan(null), 2.5);
  assert.equal(getFeeForPlan("some_plan_that_does_not_exist"), 2.5);
});

test("audit §47 regression: removed 'revenue_share' plan now falls back to default, not a hidden rate", () => {
  // revenue_share was deleted; it must NOT silently resolve to anything but the default.
  assert.equal(Object.prototype.hasOwnProperty.call(PLAN_FEE_PERCENT, "revenue_share"), false);
  assert.equal(getFeeForPlan("revenue_share"), 2.5);
});

test("Shopify-origin sales pay no MINE platform fee", () => {
  assert.equal(getFeeForPlan("pro", "shopify"), 0);
  assert.equal(getFeeForPlan("starter", "shopify"), 0);
});

test("platformFeeCents: integer cents, correct rounding", () => {
  // $100.00 = 10000c. pro = 1.5% -> 150c.
  assert.equal(platformFeeCents(10000, "pro"), 150);
  // $49.99 = 4999c. starter = 2.5% -> 124.975 -> rounds to 125c.
  assert.equal(platformFeeCents(4999, "starter"), 125);
  // enterprise 1.0% of 12345c -> 123.45 -> 123c.
  assert.equal(platformFeeCents(12345, "enterprise"), 123);
  // shopify -> always 0.
  assert.equal(platformFeeCents(99999, "pro", "shopify"), 0);
  // never returns fractional cents
  for (const amt of [1, 7, 33, 4999, 10000, 123456]) {
    for (const plan of ["starter", "growth", "pro", "enterprise"]) {
      const c = platformFeeCents(amt, plan);
      assert.equal(Number.isInteger(c), true, `non-integer cents for ${amt}/${plan}: ${c}`);
    }
  }
});

test("platformFeeCents: defensive on bad input", () => {
  assert.equal(platformFeeCents(undefined, "pro"), 0);
  assert.equal(platformFeeCents(null, "pro"), 0);
  assert.equal(platformFeeCents(NaN, "pro"), 0);
});
