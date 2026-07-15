# MINE Dashboard Bundle — 2026-05-27

Three dashboards (mine, admin, agency) with all session fixes applied in lockstep.

## Files
- `mine-live-dashboard.html`   — customer dashboard (2.6 MB, 114 script blocks, syntax-clean)
- `admin-live-dashboard.html`  — staff dashboard (2.6 MB, 113 script blocks, syntax-clean)
- `agency-live-dashboard.html` — agency dashboard (3.4 MB, 130 script blocks, syntax-clean)
- Backend spec markdowns from earlier sessions (apple-business, events-ticketing, mobile-app, showdown)

## What was fixed this session

### Chatbot panel (v8)
- Mine template: setTimeout autoload firing `loadChatbot`, `loadChatbotEscalations`, `loadChatbotConversations` on panel mount (was stuck on "Loading..." forever).
- `🤖 Test AI Chat` button on all 3 dashboards wired to a real `openChatbotTester()` modal that POSTs to `/api/features/chatbot/test`.
- Added `loadChatbot()` for stats (cbt-s1..s4) calling `/api/features/chatbot/stats`.

### MINE Control (AI COO) detail view
- "Save & verify number" button was a fake `toast('Verification sent')` — now real handler `aieWhatsappVerify('coo')` with E.164 validation, localStorage fallback, honest info modal. Wires to `/api/ai-employees/whatsapp/verify`.

### AI Employees stats — all 11 agents now wired
Extended `_loadAgentDashboardLive` to a single parallel batch fetching overview endpoints for:
- MINE Control / COO (`mcl-s1..s4`)
- Bookkeeper (`bka-s1..s4`)
- Growth (`gra-s1..s3`)
- Community (`com-s1..s4`)
- Proposal (`ppa-s1..s3`)
- Cold Email (`ce-stat-{sent,open,reply,meetings}`)

Each agent has three-state fallback: real data on success, em-dash if authed but no data, leave PREVIEW_ROI demo if not authed.

### Legal / Receptionist / Prospector consoles — all 15 dead buttons wired
Centralized capture-phase click delegator with 5 action types (form/confirm/list/info/navigate). New backend endpoints documented in code:
- `/api/ai-employees/legal/{draft,audit}`
- `/api/ai-employees/receptionist/{calls,voicemails}`
- `/api/ai-employees/prospector/{find,pending,interested,campaigns,stats,followups,export-cold-email}`

### Growth Agent Console — 4 dead buttons wired
- 🚀 Run Now → confirm + `POST /api/ai-employees/growth/run-now`
- 📊 View Log → list modal fetching `/api/ai-employees/growth/runs`
- 📉 Status → list modal fetching `/api/ai-employees/growth/status`
- ⚙️ Config → info modal pointing to settings section

### Intelligence panel — 5 bugs fixed
- 4 emoji buttons missing `data-act` attribute
- "What's Happening" missing entirely from ACTIONS array
- All 4 entries used broken `aiAct()` wrapper
- Apostrophe mismatch (smart `'` vs ASCII `'`) would have broken `findAction`
- Stats and briefing never loaded

Now has `loadIntelligence()` autoload + 4 real handlers (`_intelWhatsHappening`, `_intelAskAI`, `_intelGenerateReport`, `_intelMineScore`).

### `aiAct()` cleanup — 11 broken entries replaced
All `custom: aiAct('🤖 X')` references removed from ACTIONS array. Replacements:
- Orders: AI Refund, Shipping Labels, Track Shipments, Process Returns
- Cart Recovery: AI Personalise Cart
- SMS: AI SMS Copy
- Socials: Marketing Video, Social Video, Runway Video
- AI Tools: AI Insights (cleaned up)
- Chatbot: Test AI Chat (cleaned up)

Two new helpers: `_ordersTrackShipments` (list modal), `_smsAICopy` (form + response modal).

### `getPanelOfButton` fallback
Now falls back to `_currentPanel()` when no `items-*` wrapper is found in the ancestor chain. Fixes panel-filtered ACTIONS matching for templates that don't use the `items-X` convention (Intelligence panel etc.).

### Legacy `mineAIActions` overrides — 12 buttons across iOS + desktop dispatchers
The iOS touchend dispatcher and the desktop AI-button bridge both read from `window._mineAIActions` (same object reference as the closed-over `ACTIONS` var). Overrides applied:
- 4 Intelligence handlers → use new `_intel*` handlers
- 8 generic legacy handlers (AI Insights / AI Score Contacts / AI Score All Leads / AI Personalise / AI SEO Audit / 🚀 Run Now / ⚠️ Overage Monitor / Generate Ad Video Now) → use new `_aiLegacyReplacement` helper

All produce honest info modals instead of the broken "toast-then-fetch-then-404" pattern.

## Standing rules
- ALL changes applied to all 3 dashboards (mine, admin, agency) for parity
- Surgical minimal fixes only
- Always run `new Function(src)` syntax check after every edit
- Agency uses 1-space indent + spaces around `&&`; mine/admin use 2-space + no space
- Agency uses `enterPreview()` not `enterPreviewMode()`
- Agency has two-view structure (vAgency/vClient) requiring `_agencyActiveSite()` helper

## Pending backend endpoints to wire
The following endpoints are referenced by handlers but need backend implementation:

### Intelligence
- `GET /api/intelligence/overview`
- `GET /api/intelligence/whats-happening`
- `POST /api/intelligence/ask`
- `POST /api/intelligence/generate-report`
- `GET /api/intelligence/mine-score`

### Chatbot
- `GET /api/features/chatbot/stats`
- `POST /api/features/chatbot/test`

### AI Employees overview (6 agents)
- `GET /api/ai-employees/{coo,bookkeeper,growth,community,proposal,coldemail}/overview`

### Legal/Receptionist/Prospector consoles (14 endpoints)
- `POST /api/ai-employees/legal/{draft,audit}`
- `GET /api/ai-employees/receptionist/{calls,voicemails}`
- `POST /api/ai-employees/prospector/{find,followups,export-cold-email}`
- `GET /api/ai-employees/prospector/{pending,interested,campaigns,stats}`

### Growth Agent (3 endpoints)
- `POST /api/ai-employees/growth/run-now`
- `GET /api/ai-employees/growth/runs`
- `GET /api/ai-employees/growth/status`

### WhatsApp + Orders + Socials + SMS + Cart
- `POST /api/ai-employees/whatsapp/verify`
- `POST /api/orders/{ai-refund,shipping-labels,returns}`
- `GET /api/orders/shipments`
- `POST /api/cart-recovery/personalise`
- `POST /api/sms/ai-copy`
- `POST /api/socials/{marketing-video,social-video,runway-video}`

### MINE intelligence panel (legacy)
- Wire the existing endpoints if you want full UX:
  - `/api/ai-agent/insights`
  - `/api/features/crm/score`
  - `/api/ai-features/score-leads`
  - `/api/platform/customer-success/analyze`
  - `/api/features/ai/seo-planner`
  - `/api/seo-agent/run`
  - `/api/seo-agent/overage-summary`
  - `/api/ai-employees/heygen/auto-marketing`

## Next session

Resume here. The dashboards are syntax-clean across all three. Every interactive control either works or has an honest "backend not connected" fallback. No fake toasts, no fake success messages, no dead buttons.
