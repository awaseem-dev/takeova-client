/**
 * lib/sanitize.js — input sanitizers, extracted so they can be unit-tested.
 */

/**
 * Sanitize a free-form display name before it is stored or rendered.
 * Strips < > (the chars that enable the stored-XSS chain in name fields, audit §81)
 * and caps length. Defense-in-depth at the input layer, alongside output escaping.
 */
function cleanName(n) {
  return String(n == null ? "" : n).replace(/[<>]/g, "").slice(0, 120).trim();
}

module.exports = { cleanName };
