# MINE — Session Notes 2026-05-28

Updated live dashboards: mine-live, admin-live, agency-live (all syntax-clean: 115 / 114 / 131 script blocks).

## Admin dashboard — all 12 admin-only panels completed
- Platform Overview: table overflow fixed, plan breakdown, quick actions, blue buttons
- All Users: table -> mobile cards (Ban/Usage now reachable), Export CSV + Invite User + filter chips, iframe-safe Ban confirm
- Revenue: built out — action buttons, key metrics (ARPU/Churn/LTV), MRR trend chart, revenue-by-plan bars
- Platform Invoices: Send Reminders confirm() made iframe-safe, consistent blue buttons
- API Keys: verified clean (46 keys, test/upload working)
- Products & Prices: verified clean (26 Stripe price IDs registered)
- Social Apps: redirect URIs + copy + developer-console links
- Email & SMS: rebuilt — WhatsApp + Twilio (SID/token/number) + SendGrid, status chips, test send
- Audit Log: search + filter chips + Export CSV + demo data + mobile rows
- Video Usage: margin metric + Export CSV + demo data + mobile rows
- System Health: 10 grouped checks, summary banner, Copy report, single keys-fetch
- Showdown Monitor: force-exclude confirm() made iframe-safe, Export CSV, demo data

## Agency dashboard
- Two dead "Open Stripe" buttons wired to dashboard.stripe.com
- removeClient now confirms before deleting (was instant delete)
- addClient price reset corrected 500 -> 799 (min)
- Bottom nav fixed: Earnings -> Payouts card; Settings -> new Agency Settings section
  (display name, notification email, commission rate, payout schedule, Stripe Connect, white-label)
- Fixed literal \uXXXX escapes that were rendering as text in the Settings card HTML

## Recurring fixes (all dashboards)
- Blocked confirm()/prompt()/alert() -> iframe-safe modals (mineConfirmModal/mineFormModal/mineInfoModal)
- Overflowing fixed-width tables -> mobile card layouts
- White secondary buttons aligned to blue primary style
- Demo-data fallbacks so panels render meaningfully in preview before backend connection
