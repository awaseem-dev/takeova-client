# MINE backend — tests

Two layers, using Node's **built-in** test runner (`node:test`) so the unit layer needs
zero extra dependencies.

## Unit tests — run today, no setup

```bash
cd backend
npm test
```

Pure logic, no DB / Stripe / Express. Currently covering:

- **`lib/fees.js`** — the platform-fee table and integer-cents math.
  Pins each plan's rate, the unknown-plan → 2.5% fallback, the **§47 regression**
  (the removed `revenue_share` plan must fall back to default, not a hidden rate),
  Shopify-origin → 0%, and correct cent rounding (e.g. $49.99 starter → 125¢).
- **`lib/sanitize.js`** — `cleanName()`, the **§81** fix. Proves a name field can't
  carry `<img onerror=…>` style payloads and that length is capped.

These are the safety net for the money-to-cents refactor: change the math, run `npm test`,
and a wrong rate or rounding bug fails immediately.

## Integration tests — scaffolding, needs two one-time steps

Located in `tests/integration/`. They boot the **real** app against a throwaway SQLite
DB (a fresh temp dir per run) and hit real routes. They **self-skip** with a message
until wired, so `npm run test:all` never fails just because the setup isn't done yet.

To turn them on:

1. `npm i -D supertest`
2. Make `server.js` export the app without listening on import. At the bottom of
   `server.js`, change:
   ```js
   const httpServer = app.listen(PORT, () => { ... });
   ```
   to:
   ```js
   let httpServer;
   if (require.main === module) { httpServer = app.listen(PORT, () => { ... }); }
   module.exports = app;
   ```
   (Importing a module that calls `app.listen()` would bind a real port and break the
   test client. The `require.main === module` guard keeps `node server.js` behaviour
   identical while letting tests import the app.)

Then:

```bash
npm run test:all
```

`tests/integration/auth.flow.test.js` is a complete example (signup → login → wrong
password rejected) and lists the next high-value, audit-named tests to add: lockout,
Stripe webhook idempotency (§ webhook dedup), overage-charged-once (§32), order webhook
dedup (§41). Copy its pattern.

## Notes

- Unit tests verified passing here. Integration tests are **not** verified to boot —
  the app's full dependency set + the two steps above are required first.
- Add more unit modules the same way: extract a pure function into `lib/`, import it
  back where it was, write a `*.test.js`. That's how `fees.js` and `sanitize.js` were done.
