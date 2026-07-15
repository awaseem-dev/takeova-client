# Baseline Rule Enforcement — How It Works

When a user configures an agent's baseline rules in the dashboard (working hours,
approval rules for VIPs/refunds/big spend, brand voice, knowledge base), those
rules are now **actually enforced** at action time.

## Two enforcement paths

### Path 1 — Sales/Support handler (rich enforcement)
The `send_followup_email` / `reply_ticket` case block does its own `_checkBaseline()`
call **inside** the handler. This gives it richer context: it can use the loaded
brand voice, business context, and KB file IDs to inject into the Claude prompt.
Sales/Support gets the full benefit.

### Path 2 — All other agents (wrapper-level enforcement)
The `executeAction()` wrapper (the same one that auto-records outcomes) now ALSO
runs `_checkBaseline()` before calling the raw action handler. This catches every
agent without requiring per-agent edits:

```
executeAction(db, action, userId)
  ├─ Skip if Sales/Support (they self-enforce)
  ├─ Skip if not an external-send action (categorize_transaction etc don't need hours check)
  ├─ Run _checkBaseline()
  │   ├─ Outside hours / weekend? → block, queueRetry, record "blocked" outcome, return
  │   ├─ VIP customer? → block, record "escalated", return
  │   ├─ Refund without approval? → block, record "escalated", return
  │   ├─ Spend > threshold? → block, record "escalated", return
  │   └─ All checks pass → continue
  └─ _rawExecuteAction() runs
```

## What this means for users

When a user toggles "Skip weekends" on their Sales agent and saves:
- A `send_followup_email` action that fires on Saturday returns `{blocked: true}`
- The retry queue gets the action with `next_retry_at = next Monday 9am`
- The Team Intelligence card shows the action under "Blocked" or "Retry queue"
- On Monday morning the retry processor re-runs it; this time the baseline check passes and it sends

When a user sets `approveBigSpend: true, approveThreshold: 200`:
- A `pause_underperforming` action with $300 estimated spend returns `{escalated: true}`
- The action lands in the approval inbox
- User approves → action runs (skipping baseline since it was already approved)

## What still needs hand-wiring

The wrapper-level enforcement uses **default contexts** for amount/contact extraction.
If you want richer behavior on a specific agent (e.g., "VIP check should look up via
contact_id not email"), you can add a custom `_checkBaseline()` call inside that
agent's case block — like Sales/Support does.

## What we deliberately don't do

- **No enforcement for internal actions** — `categorize_transaction`, `generate_report`,
  `analyze_performance`, `flag_anomaly` etc. don't get blocked by working hours.
  They're internal data ops, not customer-facing.
- **No enforcement for already-approved actions** — if an action came through the
  approval inbox, the user already said "yes, fire it." Re-checking would be silly.
- **No test/preview mode** — that's a separate feature.

## How to test it actually works

1. Set Sales agent baseline:  Working hours = "Custom", Start: "23:00", End: "23:30",
   Skip weekends: on
2. Trigger a `send_followup_email` action outside that 30-min window
3. Watch the action: should return `{blocked: true, reason: "outside_hours"}`,
   record a "blocked" outcome, and queue a retry for the next 23:00 slot
4. Manually edit the retry's `next_retry_at` to NOW
5. Run cron — the retry fires, baseline passes (we're now inside the window), email sends
