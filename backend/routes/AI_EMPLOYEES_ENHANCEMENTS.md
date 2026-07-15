# AI Employees Enhancement Layer — Integration Guide

Five new capabilities added to the AI employee system:

1. **Outcome tracking** — know which actions earned their keep
2. **Persistent contact memory** — agents remember per-contact history
3. **Cross-agent handoffs** — Sales → Bookkeeper on deal close, etc.
4. **Retry queue** — failed actions retried with exponential backoff
5. **Approval SLA / nudges** — stale pending approvals surface to the user

---

## Setup (do this once)

### 1. Mount the routes in `server.js`
```js
const enhancements = require('./routes/ai-employees-enhancements');
app.use('/api/ai-employees', enhancements);
enhancements.migrate();   // creates 5 new tables, idempotent
```

### 2. Add to your cron runner
The existing `/api/ai-employees/cron` already runs periodically. Add one line:
```js
const { processRetries } = require('./ai-employees-enhancements');
await processRetries(async ({ actionId, userId, role, actionType, payload }) => {
  // Re-call your existing action executor here — the same function that
  // handles the case "send_followup_email" etc in ai-employees.js
  return await executeAction({ role, action: actionType, details: payload, userId, actionId });
});
```

---

## How each agent plugs in

### Outcome tracking — record after every action
In `ai-employees.js`, find where each action completes (end of each `case` block).
Add:
```js
const { recordOutcome } = require('./ai-employees-enhancements');

// After a successful action:
recordOutcome(actionId, userId, 'sales', 'send_followup_email', 'success', {
  email_sent_to: 'sarah@example.com',
  subject: 'Re: Retreat inquiry',
});

// After a failed action:
recordOutcome(actionId, userId, 'sales', 'send_followup_email', 'failed', {
  error: 'sendgrid_timeout',
});

// When no reply arrives after N days (in your cron):
recordOutcome(actionId, userId, 'sales', 'send_followup_email', 'no_response', {
  waited_days: 7,
});
```

Outcomes are then viewable at `GET /api/ai-employees/outcomes/stats?days=30`.

### Memory — read before, write after
```js
const { getMemory, upsertMemory } = require('./ai-employees-enhancements');

// Before generating an email, load what you know about this contact:
const memory = getMemory(userId, 'sales', 'sarah@example.com');
// memory = { summary, facts: [...], preferences: {...}, last_interaction, interaction_count }

// Feed into the AI prompt:
const systemPrompt = `You are a sales agent. Here's what you know about this contact:
${memory?.summary || '(no prior interaction)'}
Key facts: ${(memory?.facts || []).join(', ')}
Prefers: ${JSON.stringify(memory?.preferences || {})}`;

// After the action, update memory:
upsertMemory(userId, 'sales', 'sarah@example.com', {
  summary: "Runs Brisbane yoga studio, interested in retreats",
  newFacts: ["asked about Byron Bay Feb retreat", "opened email 3x"],
  preferences: { channel: 'sms', tone: 'warm' }
});
```

Memory is capped at 50 facts per (agent, contact) pair — oldest drop out.

### Handoffs — trigger another agent
```js
const { handoff } = require('./ai-employees-enhancements');

// Sales closes a deal, needs bookkeeper to set up invoicing:
handoff(userId, 'sales', 'bookkeeper', 'deal_closed', {
  deal_id: deal.id, contact_email: deal.email, amount: deal.value,
  reason: "Closed $4800 one-off — set up invoice"
});

// Support sees an angry VIP, escalates to CSM:
handoff(userId, 'support', 'csm', 'vip_complaint', {
  ticket_id: t.id, severity: 'high',
  reason: "VIP customer Sarah Mitchell unhappy with order delay"
});
```

View pending handoffs: `GET /api/ai-employees/handoffs`

### Retries — fail gracefully
```js
const { queueRetry } = require('./ai-employees-enhancements');

try {
  await sendgrid.send(emailPayload);
} catch (err) {
  // Don't drop the action — queue it for retry
  queueRetry(actionId, userId, 'sales', 'send_followup_email', emailPayload, err);
  // Don't throw — action is safely queued
}
```

Retry schedule: 1min, 5min, 25min, 2h, 10h, then marked `exhausted`.

### Approval nudges — surface stale work
The UI should poll `GET /api/ai-employees/approvals/stale?hours=24` once per dashboard load
and display a banner: "3 pending AI actions from yesterday. Review?"

When the user clicks Review: call `POST /api/ai-employees/approvals/:id/nudge` to record
the nudge (so you don't show the same alert twice in an hour).

When the user clicks "Don't show again" for a specific action:
`POST /api/ai-employees/approvals/:id/dismiss-nudge`

---

## New endpoints summary

| Method | Path | Purpose |
|---|---|---|
| GET  | `/outcomes/stats?days=30` | Agent scorecard — success rate by role |
| POST | `/outcomes/:actionId/feedback` | User rates an action 1-5 |
| GET  | `/memory/:email` | Everything any agent knows about this person |
| DELETE | `/memory/:email` | Forget this person (GDPR) |
| GET  | `/handoffs` | Recent handoffs between agents |
| POST | `/handoffs/:id/complete` | Mark handoff finished |
| GET  | `/retries` | Retry queue contents |
| POST | `/retries/:id/cancel` | Cancel a stuck retry |
| GET  | `/approvals/stale?hours=24` | Pending actions aged past threshold |
| POST | `/approvals/:id/nudge` | Record a nudge shown |
| POST | `/approvals/:id/dismiss-nudge` | User silenced this action |

---

## What this doesn't do (yet)

- **No automatic integration into existing action handlers.** You need to add the `recordOutcome`, `getMemory`, `upsertMemory`, `queueRetry` calls to each case block in `ai-employees.js`. ~15-20 calls total — mechanical but necessary work.
- **No UI.** You'll want to surface outcomes, handoffs, retries, and stale approvals in the dashboard. The endpoints are ready; the frontend cards aren't.
- **No automatic handoff rules.** Handoffs fire when you explicitly call `handoff(...)`. A future V2 could have a rules engine ("when deal status → closed, automatically handoff to bookkeeper").

These are deliberate — integration choices belong to you, not to this file.
