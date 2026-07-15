# Claude API Upgrades — Integration Guide

Three new modules that upgrade how MINE uses the Anthropic API:

1. **`claude-helper.js`** — unified wrapper with automatic prompt caching
2. **`claude-streaming-chat.js`** — SSE streaming endpoint for chat UIs
3. **`claude-batch-jobs.js`** — batch API runner for bulk non-urgent work

Expected impact at scale:
- **Prompt caching**: ~90% cost reduction on the system/context portion of repeat agent calls
- **Streaming**: chat feels 3x faster (words appear as generated)
- **Batching**: 50% cost reduction on overnight/scheduled bulk work

---

## Setup — mount in `server.js`

```js
const streaming = require("./routes/claude-streaming-chat");
const batchJobs = require("./routes/claude-batch-jobs");

app.use("/api/ai-employees", streaming);
app.use("/api/ai-employees", batchJobs);

streaming.migrate();   // creates ai_chat_history
batchJobs.migrate();   // creates ai_batch_jobs
```

And in your existing cron endpoint, add one line:
```js
const { checkJobs } = require("./claude-batch-jobs");
await checkJobs();   // polls pending batches, fires completion handlers
```

---

## 1. Prompt Caching — how to migrate existing calls

### Before (what MINE does now)
```js
const r = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: longSystemPrompt + businessContext,
    messages: [{ role: "user", content: prompt }],
  }),
});
const d = await r.json();
const text = d.content?.find(b => b.type === "text")?.text || "";
```

### After (one-line swap for caching)
```js
const { callClaude } = require("./claude-helper");
const d = await callClaude({
  model: "claude-sonnet-4-6",
  maxTokens: 2000,
  system: longSystemPrompt,
  businessContext,           // cached separately
  messages: [{ role: "user", content: prompt }],
});
const text = d.content?.find(b => b.type === "text")?.text || "";

// Bonus: inspect what caching saved you
console.log(d._cache_stats);  // { creation_input_tokens, read_input_tokens, cached_pct }
```

**Where caching matters most:**
- Sales/Support/CSM/Coldemail agents (they all use the same `business_context` on every call)
- AI Advisor chat (same system prompt every message)
- Any agent called in a tight loop (categorizing 50 leads, scoring 100 prospects)

**Caching rules the helper applies automatically:**
- System block ≥ 4000 chars → marked `cache_control: ephemeral`
- Tool definitions cached when ≥ 2 tools are passed
- 5-minute cache window — subsequent calls pay ~10% of the cached portion
- First call pays 1.25x (cache write premium), every hit after saves 90%

---

## 2. Streaming Chat — new endpoint

**New endpoint:** `POST /api/ai-employees/chat-stream`
**Body:** `{ message: string, history: [{role, content}], role: "advisor" | "control" }`
**Returns:** Server-Sent Events stream. Each event is `data: {"text": "..."}` or `data: [DONE]`.

### Frontend migration — from waiting UI to streaming UI

**Before (current)**
```js
const r = await fetch("/api/ai-employees/chat", { method: "POST", ... });
const { response } = await r.json();
// User stared at spinner for 8s before seeing anything
chatDiv.textContent = response;
```

**After (streaming)**
```js
const res = await fetch("/api/ai-employees/chat-stream", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  body: JSON.stringify({ message, history })
});

const reader = res.body.getReader();
const dec = new TextDecoder();
const msgEl = appendMessageBubble("");  // empty bubble, text streams into it

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const frame of dec.decode(value).split("\n\n")) {
    const line = frame.split("\n").find(l => l.startsWith("data: "));
    if (!line) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") return;
    try {
      const { text, error } = JSON.parse(payload);
      if (error) { showError(error); return; }
      msgEl.textContent += text;   // word-by-word
      msgEl.scrollIntoView({ block: "end" });
    } catch {}
  }
}
```

**Where to wire this in (on the dashboard):**
- MINE Control chat panel
- AI Advisor panel
- Customer chat widget (if you surface it to end users)

Non-streaming `/chat` endpoints still work — swap per-surface as you're ready.

---

## 3. Batch Jobs — 50% discount on non-urgent work

**Good candidates for batching:**
- Bookkeeper categorizing 200 transactions overnight
- Cold Email agent drafting 50 outreach emails before morning
- Social agent drafting next week's 14 posts in one go
- Growth agent analyzing 30 competitors weekly

**Bad candidates (use regular `callClaude` instead):**
- Anything the user is watching a spinner for — batches take minutes to hours
- Interactive chat
- Real-time support responses

### Submitting a batch job

```js
const { enqueueBatch } = require("./claude-batch-jobs");

await enqueueBatch({
  userId,
  jobType: "categorize_transactions",
  items: transactions.map(t => ({
    custom_id: t.id,                      // must be unique per item
    system: "You are a bookkeeper. Respond with ONLY a category name.",
    user: `${t.description}, $${t.amount}`,
    maxTokens: 50,
  })),
  onComplete: "bookkeeper_categorize",    // key in HANDLERS
  model: "claude-haiku-4-5-20251001",     // Haiku is fine for simple classification
});
```

### Adding a new completion handler

In `claude-batch-jobs.js`, add your handler to the `HANDLERS` object:

```js
const HANDLERS = {
  async my_new_handler(userId, results) {
    // results is { custom_id: {text, usage} | {error}, ... }
    for (const [id, r] of Object.entries(results)) {
      if (r.error) continue;
      // ... do something with r.text
    }
  },
};
```

Then reference it by name in `enqueueBatch({ onComplete: "my_new_handler" })`.

### Polling (already wired — just call from cron)

`checkJobs()` polls all pending batches. Call it every 5-15 minutes:
```js
const { checkJobs } = require("./claude-batch-jobs");
setInterval(checkJobs, 10 * 60 * 1000);  // every 10 min
```

Or add to your existing `/api/ai-employees/cron` endpoint.

### HTTP endpoints added

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/ai-employees/batch-jobs` | List user's batch jobs + status |
| POST | `/api/ai-employees/batch-jobs/:id/cancel` | Cancel a running batch |
| POST | `/api/ai-employees/batch-jobs/check` | Manually trigger polling (test) |

---

## What this doesn't do

- **Doesn't automatically convert existing agent calls to use the helper.** You need to swap `fetch("https://api.anthropic.com/v1/messages", ...)` → `callClaude(...)` at each call site. ~30 call sites across the route files. Start with the highest-traffic ones (ai-employees.js action triggers, mine-control.js chat).
- **Doesn't migrate the frontend chat UI to streaming.** You need to update the JS that currently awaits a full response. The streaming endpoint is ready; the frontend swap is per-surface.
- **Doesn't automatically route bulk work to batches.** You decide what's worth batching by calling `enqueueBatch` in the agent code where the bulk work happens.

These are deliberate — automatic migration would hide the decisions that matter.
