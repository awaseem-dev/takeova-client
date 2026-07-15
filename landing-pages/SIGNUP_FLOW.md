# Landing Page Signup Flow

Both `landing2.html` and `landing4.html` now have working signup that calls the
real backend at `POST /api/auth/signup`, stores the JWT, and redirects the user
to the main dashboard.

## How it works

1. User clicks any "Start Free →" button or pricing tier
2. Signup modal opens (preserving the selected plan in `sessionStorage`)
3. User enters name, email, password (and optional referral code)
4. Form validates client-side: required fields, password length, email format
5. POSTs to `${MINE_API}/api/auth/signup`
6. On success: stores `mine_token` + `mine_api` in `localStorage`, redirects to dashboard
7. On failure: shows inline error (email taken, weak password, etc.)

## Required configuration

Both pages read these globals (set them via a `<script>` tag before the page renders, or via inline config):

```html
<script>
  window.MINE_API = 'https://api.your-domain.com';      // Backend API base URL
  window.MINE_DASHBOARD_URL = '/mine-live-dashboard.html'; // Where to land after signup
</script>
```

**Defaults if not set:**
- `MINE_API` → `https://api.mine.app`
- `MINE_DASHBOARD_URL` → `/mine-live-dashboard.html`

## Storage keys written on success

| Key | Where | Value |
|---|---|---|
| `mine_token` | localStorage | JWT access token |
| `mine_api` | localStorage | API base URL |
| `mine_refresh_token` | localStorage | JWT refresh token (if backend returns one) |
| `mine_intended_plan` | localStorage | Set if user clicked a pricing tier (e.g., `pro`) |
| `mine_intended_prompt` | localStorage | Set if user used hero "Build for Free" input |

## Plan tracking (pricing tiers)

When user clicks `<a href="/signup?plan=pro">Start Free →</a>`, the `?plan=pro`
gets captured in `sessionStorage.mine_signup_plan`, then transferred to
`localStorage.mine_intended_plan` after successful signup. The dashboard can
then prompt them to upgrade to that plan.

## Referral codes

Three sources, in priority order:
1. User typed in the modal's "Referral code" field
2. Cookie `mine_ref` (set when user landed via `?ref=XXX`)
3. None

The cookie-setting code already exists in both pages (top of file).

## Error handling

- Invalid email → "Please enter a valid email address"
- Empty fields → "Please fill in name, email, and password"
- Password < 8 chars → "Password must be at least 8 characters"
- Backend rejection (e.g., email taken) → backend's error message displayed verbatim
- Network failure → "Cannot reach the server — please try again"

Loading state shows "Creating account…" / "Signing in…" with the button disabled.

## Testing locally

1. Start the backend: `cd backend && node server.js`
2. Open `landing-pages/landing2.html` in a browser, but configure the API URL first:

```html
<!-- Add this BEFORE all other scripts on the page, e.g. in <head> -->
<script>
  window.MINE_API = 'http://localhost:4000';
  window.MINE_DASHBOARD_URL = '../live/mine-live-dashboard.html';
</script>
```

3. Click "Start Free →"
4. Fill in test name + email + password (8+ chars)
5. Submit — should hit your backend, create an account, and redirect

If using SendGrid, the user will also get a verification email immediately.

## What changed from before

**Before:** Both pages had `handleSignup`/`handleLogin` functions that just
redirected to `/?auth=signup&email=X` — expecting a React app at the root that
didn't exist in production.

**After:** Real fetch calls to the backend, real token storage, real redirect
to the dashboard. No React app required.

## Mobile / accessibility

Both modals work on mobile (responsive widths, virtual keyboard handled).
Inputs use `autocomplete="email"`, `autocomplete="current-password"`,
`autocomplete="new-password"` for browser/password manager integration.

## What's NOT included (deliberate)

- Google/Apple OAuth — landing2 already has the buttons (calling
  `/api/auth/google` and `/api/auth/apple`); these need backend OAuth handlers
  to be configured before they'll work
- Captcha — not added; if signup spam becomes an issue, recommend adding
  reCAPTCHA or Turnstile
- 2FA on signup — backend supports 2FA but not enforced at signup
