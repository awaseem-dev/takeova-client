# Email Verification

**Soft verification model.** Users get full dashboard access immediately after
signup, but a banner reminds them to verify until they do. Specific high-value
actions (publishing a site, sending email campaigns) can be gated server-side
on `email_verified` — see "Gating actions" below.

## Flow

1. User submits signup form
2. Backend creates account with `email_verified = 0` and a 64-char `verification_token`
3. Backend sends verification email via SendGrid (fire-and-forget; signup succeeds even if email is slow)
4. Backend returns auth token; user is logged in immediately
5. Dashboard loads → `mineShowVerifyBanner(user)` checks `user.emailVerified` → shows banner if false
6. User clicks email link → hits `GET /api/auth/verify/:token`
7. Backend marks `email_verified = 1`, clears token, shows success page with "Open MINE →"
8. User returns to dashboard, refreshes (or it's already there) → banner gone

## Endpoints (in `auth.js`)

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/api/auth/signup` | none | Now also generates verification token + sends email |
| GET  | `/api/auth/verify/:token` | none | Marks user verified, shows result page |
| POST | `/api/auth/resend-verification` | yes (logged in) | Generates new token + resends email; rate-limited to once per 60s |

## Required env vars

- `SENDGRID_API_KEY` — without this, signup still works but no email is sent
- `EMAIL_FROM` — sender address (defaults to `hello@mine.app`)
- `BACKEND_URL` — used to build the verify link (defaults to `http://localhost:4000`)
- `FRONTEND_URL` — used in the post-verify success page "Open MINE" button (defaults to `http://localhost:3000`)

## Schema

Three columns added to `users`:

```sql
email_verified INTEGER DEFAULT 0
verification_token TEXT
verification_sent_at TEXT
```

`schema.sql` updated for fresh deploys; an `ALTER TABLE` migration runs at the
top of `auth.js` to bring older databases up to date.

## Gating actions on email verification (optional)

If you want certain endpoints to require verification (e.g., publish, send
campaign), add this check inside the handler:

```js
const u = db.prepare("SELECT email_verified FROM users WHERE id = ?").get(req.userId);
if (!u.email_verified) return res.status(403).json({ error: "Please verify your email first", code: "VERIFY_EMAIL_REQUIRED" });
```

Frontend handles `VERIFY_EMAIL_REQUIRED` by showing a "verify first" prompt.

## Testing

1. Sign up a test user
2. Check Postgres: `SELECT email, email_verified, verification_token FROM users WHERE email = 'you@test.com';`
3. Visit the verify URL: `BACKEND_URL/api/auth/verify/<token>`
4. Re-check DB — `email_verified` should be 1, `verification_token` should be NULL
5. Refresh dashboard — banner should be gone

For local testing without SendGrid, just copy the token from the DB and visit
the verify URL directly.
