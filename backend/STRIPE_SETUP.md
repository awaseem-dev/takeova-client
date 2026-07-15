# Stripe Setup — Required for Card-Required Trial Flow

The signup flow requires a card upfront via Stripe Checkout (Option 2 trial model).
This document covers what you need to configure for the flow to work end-to-end.

## How the flow works

1. User fills the signup form on landing2 / landing4
2. Frontend POSTs to `/api/auth/signup` → creates account, returns JWT
3. Frontend immediately POSTs to `/api/payments/create-checkout-session` with the JWT
4. Backend creates a Stripe Customer + Checkout session with `trial_period_days: 3` (Starter plan)
5. Frontend redirects to the Stripe-hosted checkout URL
6. User enters card details on Stripe's secure form
7. Stripe redirects back to `${FRONTEND_URL}?session_id=...&plan=starter&billing=monthly`
8. Stripe webhook (`/api/payments/webhook`) updates the user's plan + subscription IDs
9. After 3 days, Stripe automatically charges the card unless the user cancelled

## Required environment variables

```bash
STRIPE_SECRET_KEY=sk_live_...          # From Stripe dashboard
STRIPE_WEBHOOK_SECRET=whsec_...         # From the webhook endpoint you create
FRONTEND_URL=https://app.mine.app       # Where Stripe redirects after checkout
```

## Required Stripe configuration

### 1. Stripe products & prices
The backend uses an `ensurePrice(planId, type, interval)` helper that auto-creates
prices in your Stripe account if they don't exist. The `PLANS` config (in
`backend/lib/plans.js` or similar) defines:
- starter → $79/mo
- growth → $129/mo
- pro → $199/mo
- enterprise → $399/mo

On first checkout request, Stripe products + prices are auto-created. No manual
setup needed.

### 2. Webhook endpoint
In your Stripe dashboard:
1. Go to Developers → Webhooks → Add endpoint
2. URL: `https://your-backend-domain.com/api/payments/webhook`
3. Subscribe to these events:
   - `checkout.session.completed` (creates the local subscription record)
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.trial_will_end` (3 days before charge)
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
4. Copy the signing secret → set as `STRIPE_WEBHOOK_SECRET`

### 3. Customer portal (for self-service cancellation)
In Stripe dashboard:
1. Settings → Billing → Customer portal → Activate
2. Allow customers to: cancel subscriptions, update payment methods, view invoices
3. The `/api/payments/portal` endpoint already wires this up

## Testing locally

1. Install Stripe CLI: `brew install stripe/stripe-cli/stripe` (or platform equiv)
2. Login: `stripe login`
3. Forward webhooks: `stripe listen --forward-to localhost:4000/api/payments/webhook`
4. Use the secret printed by `stripe listen` as `STRIPE_WEBHOOK_SECRET`
5. Use Stripe test cards: `4242 4242 4242 4242` (success), `4000 0000 0000 9995` (decline)

## What happens if Stripe isn't configured

The signup flow has a graceful fallback:
- If `/api/payments/create-checkout-session` returns an error (e.g. "Stripe not configured"),
  the frontend sets `mine_needs_payment=1` in localStorage and proceeds to the dashboard
- The dashboard can detect this flag and prompt the user to add a payment method
- So the app stays usable in dev without Stripe — but in production, Stripe MUST be configured
  or new users will hit the dashboard with `mine_needs_payment=1` and need to be re-prompted

## Trial mechanics (verified by Stripe)

- New Starter subscriber: `trial_period_days: 3` set on the subscription
- During trial: Stripe holds the card but doesn't charge it (a $0 auth may show on the card briefly)
- 3 days later: Stripe attempts to charge automatically
- If user cancels via portal before day 3: subscription cancelled, no charge ever
- If charge fails: Stripe retries per its smart retry rules (configurable in dashboard)

## Switching back to "no card required"

If you decide to switch to Option 1 (no card at signup) later:
1. Delete or comment out the checkout-session call in landing2.html (handleSignup) and landing4.html
2. Update messaging to remove "card required" lines
3. Remove the trial_period_days logic in payments.js create-checkout-session
4. Add an in-app upgrade prompt for users who try to publish/use paid features
