// tests/integration/auth.flow.test.js
// EXAMPLE integration test — the pattern to copy for the rest.
// Self-skips until supertest is installed and server.js exports the app (see helpers.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { useTempDb, loadHarness } = require("./helpers");

useTempDb();
const h = loadHarness();

if (!h.ok) {
  test("integration: auth flow (SKIPPED)", { skip: h.reason }, () => {});
} else {
  const { request, app } = h;

  test("signup → login → wrong password is rejected", async () => {
    const email = "itest+" + Date.now() + "@example.com";
    const password = "Sup3rSecret!";

    // signup
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email, password, name: "Integration Tester" });
    assert.ok([200, 201].includes(signup.status), "signup status " + signup.status);

    // login with correct password
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ email, password });
    assert.ok([200, 201].includes(ok.status), "login status " + ok.status);
    assert.ok(ok.body && (ok.body.token || ok.body.session || ok.body.user), "login returned no token/session");

    // login with wrong password must NOT succeed
    const bad = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "wrong-" + password });
    assert.ok(bad.status >= 400, "wrong password should be rejected, got " + bad.status);
  });

  // TODO (high-value, audit-named — copy the pattern above):
  //  - repeated wrong-password attempts trigger lockout (audit: auth hardening)
  //  - Stripe webhook idempotency: POST the same event id twice → processed once
  //    (assert processed_stripe_events has 1 row; second call is a no-op 200)
  //  - overage is charged once per cycle, not double (audit §32)
  //  - order webhook dedup by stripe_session_id (audit §41)
}
