// tests/unit/sanitize.test.js
// Run: node --test   (from the backend/ directory)
// Pins the audit §81 fix: display names can't carry HTML/JS injection.
const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanName } = require("../../lib/sanitize");

test("strips the angle brackets that enable stored XSS (audit §81)", () => {
  const evil = '<img src=x onerror="fetch(\'/steal?t=\'+localStorage.token)">';
  const out = cleanName(evil);
  assert.equal(out.includes("<"), false);
  assert.equal(out.includes(">"), false);
  // the dangerous tag can no longer form
  assert.equal(/<\s*img/i.test(out), false);
});

test("leaves normal names intact (minus any stray brackets)", () => {
  assert.equal(cleanName("Jane O'Brien"), "Jane O'Brien");
  assert.equal(cleanName("  José Núñez  "), "José Núñez");
  assert.equal(cleanName("Renée-Marie"), "Renée-Marie");
});

test("caps length to 120 chars", () => {
  const long = "a".repeat(500);
  assert.equal(cleanName(long).length, 120);
});

test("handles null / undefined / non-strings without throwing", () => {
  assert.equal(cleanName(null), "");
  assert.equal(cleanName(undefined), "");
  assert.equal(cleanName(12345), "12345");
});
