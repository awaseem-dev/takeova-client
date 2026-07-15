# Custom Domain Management

Adds production-grade handling for custom domains on top of the existing
`/api/hosting/domain/*` endpoints. Assumes Cloudflare deployment.

## Endpoints (all under `/api/domains`)

| Method | Path | Purpose | Plan-gated |
|---|---|---|---|
| GET    | `/status/:siteId`     | Full DNS + SSL status for a site's domain | No |
| POST   | `/connect/:siteId`    | Connect a custom domain to a site (saves + returns DNS instructions) | **Yes** |
| POST   | `/verify/:siteId`     | Manual re-check trigger (for "Check now" button) | No |
| DELETE | `/disconnect/:siteId` | Remove the custom domain from a site | No |

## Plan gate

Custom domains are restricted to plans in `PLANS_WITH_CUSTOM_DOMAIN`
(currently: `pro`, `growth`, `enterprise`, `agency`). Starter users hitting
`POST /connect` get HTTP 402 with `{code: "PLAN_UPGRADE_REQUIRED", upgradeUrl}`.

Edit the constant in `domain-management.js` to match your pricing.

## DNS verification

`checkDomainStatus()` does:

1. **CNAME lookup** — checks if domain points to `MINE_DOMAIN` (env var, defaults to `mine.app`)
2. **A record fallback** — for apex domains where CNAME isn't allowed
3. **Cloudflare SSL check** — if `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` are set,
   queries the CF API for the custom hostname's SSL status
4. **Returns** `{ dns: pending|verified|broken, ssl: pending|active|broken, details: {...} }`

## Periodic re-verification cron

Starts 30 seconds after server boot, then runs every hour. Picks up any
domains whose `last_check_at` is older than 1 hour, re-checks status, and:

- Updates `dns_configured` and `ssl_status` columns
- Detects pending → verified transitions
- On first verified state, sends a one-time email to the user (using
  `routes/email.js` if available) and sets `notified_live = 1`
- Logs `[domain-cron] checked=N transitioned=N notified=N`

## Required env vars for full functionality

```
MINE_DOMAIN=mine.app                   # your platform domain
CLOUDFLARE_API_TOKEN=cf-token-here     # for SSL status checks
CLOUDFLARE_ZONE_ID=cf-zone-id-here     # the zone hosting *.mine.app
```

If Cloudflare vars are missing, DNS verification still works (via plain
`dns.resolveCname`) but SSL status will be reported as `pending` until manually
confirmed.

## Required Cloudflare setup at deploy time

1. Add `mine.app` (or whatever `MINE_DOMAIN` is) as a Cloudflare zone
2. Enable Universal SSL (automatic — covers `*.mine.app`)
3. Set up [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-saas/)
   to handle customer-supplied custom domains
4. Generate an API token with `Zone:Read`, `Zone:Edit`, and `Custom Hostnames:Edit`
   for your zone
5. Set the env vars above

Without Cloudflare for SaaS, custom-domain SSL provisioning won't be automatic —
customers will need to manually configure their DNS, and you'll need a separate
SSL strategy (Let's Encrypt + nginx, or similar).

## Frontend integration

The dashboards already have a "Connect Your Domain" modal (mine-live-dashboard
line ~3436). Frontend should:

1. Call `POST /api/domains/connect/:siteId` with `{domain}` — handle 402 by
   showing upgrade modal
2. Display the `instructions` returned (CNAME record to add)
3. Poll `GET /api/domains/status/:siteId` every 30s, or let user click "Check now"
   which calls `POST /api/domains/verify/:siteId`
4. Show DNS/SSL status badges in UI: pending (orange) / verified (green) / broken (red)
5. When `dns === verified && ssl === active`, show success state — also user
   will get an email automatically

## Database additions

Two columns added to `site_domains` (auto-migrated on first cron run):

- `last_check_at TEXT` — when status was last verified
- `notified_live INTEGER DEFAULT 0` — whether we've sent the "your domain is live" email yet

## What this doesn't do

- **No SSL provisioning** — Cloudflare handles that automatically when you use
  Cloudflare for SaaS. Without Cloudflare, you'll need a separate cert pipeline.
- **No DNS record creation** — users still configure DNS at their registrar.
  The Cloudflare for SaaS API can be used to validate/auto-attach hostnames,
  but creating DNS at the customer's registrar is impossible without their auth.
- **No subdomain routing** — that's handled elsewhere (existing `public-pages.js`
  serves `{slug}.mine.app` traffic).

## Testing the cron locally

```bash
# Force a check of all stale domains
node -e "require('./backend/routes/domain-management').runDomainCheckCron()"
```

The function is exported for testing.

## Frontend integration — already wired

The "Connect Your Domain" modal in all 3 dashboards has been updated to use
the new endpoints. Three placeholders need replacing post-Cloudflare-deploy:

### 1. CNAME target
In each dashboard's `openDomainConnect` function, find:
```js
var CLOUDFLARE_CNAME_TARGET='REPLACE_WITH_CLOUDFLARE_ENDPOINT';
```

Replace with the actual hostname Cloudflare for SaaS gives you, e.g.:
- `proxy.mine.app` (if you set up a subdomain proxy)
- `your-zone.cfargotunnel.com` (Cloudflare Tunnel hostname)
- Whatever Cloudflare for SaaS gives you in their dashboard

### 2. Upgrade URL
In the same function, find:
```js
var UPGRADE_URL='/pricing';
```

Set to your real pricing/upgrade page route. If you have a billing page in
the dashboard like `?panel=billing`, use that instead.

### 3. (Optional) Polling cadence
The modal polls `/api/domains/verify/:siteId` every 30 seconds while the user
sits on the DNS instructions page. Adjust if you want different timing:
```js
pollTimer=setInterval(function(){checkStatus(domain,false);},30000);
```

After replacing those 3 strings, the flow works end-to-end:
1. User clicks "Connect Your Domain"
2. Enters domain → clicks Continue
3. Backend gates on plan → Pro+ proceeds, Starter sees Upgrade modal
4. Backend saves intent → returns DNS instructions
5. Frontend shows CNAME record to add
6. Frontend polls `/verify/:siteId` every 30s
7. User can click "Check now" for instant re-check
8. When DNS verifies → success screen + auto-email goes out
