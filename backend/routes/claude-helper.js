// ═══════════════════════════════════════════════════════════════════════════
// Claude API Helper — Unified wrapper with caching, streaming, batching
// ═══════════════════════════════════════════════════════════════════════════
//
// Replaces the raw `fetch("https://api.anthropic.com/v1/messages", ...)` calls
// scattered across backend/routes/. Provides three upgrades in one place:
//
//   1. callClaude()       — adds prompt caching (~90% cost cut on repeat calls)
//   2. streamClaude()     — word-by-word streaming for chat UIs
//   3. batchClaude()      — batch API for non-urgent bulk work (50% cheaper)
//
// Drop-in replacement: existing code that does fetch(...) can be rewritten as
//   const d = await callClaude({ model, system, messages, maxTokens });
// and get caching automatically.
// ═══════════════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ─── Retry/backoff: handle transient 429/529/503/network errors ─────────────
// Anthropic's rate limit (429), overloaded (529), and unavailable (503) errors
// are transient. Without this, a single bad minute drops requests on the floor.
// Retries up to 3 times with exponential backoff (1s, 2s, 4s) plus jitter.
async function fetchWithRetry(url, opts, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, opts);
      // Retry on transient server errors
      if (r.status === 429 || r.status === 529 || r.status === 503) {
        if (attempt < retries) {
          // Honor Retry-After header if present, else exponential backoff
          const retryAfter = parseInt(r.headers.get("retry-after") || "0", 10);
          const wait = retryAfter > 0
            ? retryAfter * 1000
            : (1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
          await new Promise(res => setTimeout(res, wait));
          continue;
        }
      }
      return r;
    } catch (err) {
      // Network error — retry
      lastErr = err;
      if (attempt < retries) {
        const wait = (1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("fetchWithRetry: exhausted retries");
}

function headers(extra = {}) {
  return {
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...extra,
  };
}

// ─── 1. callClaude — standard request with automatic caching ───────────────
//
// Usage:
//   const d = await callClaude({
//     model: "claude-sonnet-4-6",
//     maxTokens: 2000,
//     system: "You are a sales agent for...",       // cached automatically
//     businessContext: emp.business_context,         // cached automatically
//     messages: [{role: "user", content: "Write a follow-up to Sarah"}],
//     tools: [{type: "web_search_20250305", name: "web_search"}],
//     thinking: {type: "enabled", budget_tokens: 1024}, // optional
//   });
//   const text = d.content?.find(b => b.type === "text")?.text || "";
//
// Caching rules:
//   • system prompt is marked cache_control: ephemeral if ≥1024 tokens (~4000 chars)
//   • businessContext is appended to system and also cached
//   • tools are cached when caching is on (saves re-sending tool definitions)
//
// The first call populates the cache (charged at 1.25x normal).
// Every call within 5 min using identical cached content is charged at 0.1x.
// For most agents this means a ~90% cost cut on the system/context portion.

async function callClaude({
  model = "claude-sonnet-4-6",
  maxTokens = 1024,
  system = "",
  businessContext = "",
  messages = [],
  tools,
  thinking,
  temperature,
  enableCaching = true,   // set false to force no caching
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const body = { model, max_tokens: maxTokens, messages };

  // Build system as structured blocks so we can mark pieces as cacheable
  const systemBlocks = [];
  if (system) systemBlocks.push({ type: "text", text: system });
  if (businessContext) {
    systemBlocks.push({ type: "text", text: "\n\nBusiness context:\n" + businessContext });
  }

  if (systemBlocks.length > 0) {
    // Only cache if the system content is big enough to be worth it
    const totalChars = systemBlocks.reduce((n, b) => n + b.text.length, 0);
    if (enableCaching && totalChars >= 4000) {
      // Mark the LAST block as the cache breakpoint — everything before it is cached
      systemBlocks[systemBlocks.length - 1].cache_control = { type: "ephemeral" };
    }
    body.system = systemBlocks;
  }

  if (tools && tools.length) {
    body.tools = tools;
    // Cache tool definitions alongside system if caching is on
    if (enableCaching && body.system) {
      // Mark last tool as cache breakpoint — but only if we have enough tools to matter
      if (tools.length >= 2) {
        body.tools = tools.map((t, i) =>
          i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
        );
      }
    }
  }

  if (thinking) body.thinking = thinking;
  if (temperature != null) body.temperature = temperature;

  const r = await fetchWithRetry(ANTHROPIC_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Anthropic API ${r.status}: ${errText}`);
  }

  const d = await r.json();

  // Surface cache stats for observability
  if (d.usage) {
    d._cache_stats = {
      creation_input_tokens: d.usage.cache_creation_input_tokens || 0,
      read_input_tokens: d.usage.cache_read_input_tokens || 0,
      cached_pct: d.usage.cache_read_input_tokens
        ? Math.round((d.usage.cache_read_input_tokens / (d.usage.cache_read_input_tokens + d.usage.input_tokens)) * 100)
        : 0,
    };
  }

  return d;
}

// ─── 2. streamClaude — word-by-word streaming for chat UIs ─────────────────
//
// Usage (in an Express route):
//   router.post("/chat", async (req, res) => {
//     res.setHeader("Content-Type", "text/event-stream");
//     res.setHeader("Cache-Control", "no-cache");
//     res.setHeader("Connection", "keep-alive");
//     await streamClaude({
//       model: "claude-sonnet-4-6",
//       system: "You are Take Control.",
//       messages: [{role: "user", content: req.body.message}],
//       onChunk: (text) => res.write(`data: ${JSON.stringify({text})}\n\n`),
//       onDone: (full) => { res.write("data: [DONE]\n\n"); res.end(); },
//       onError: (err) => { res.write(`data: ${JSON.stringify({error: err.message})}\n\n`); res.end(); },
//     });
//   });
//
// Frontend consumes with EventSource or fetch+getReader().

async function streamClaude({
  model = "claude-sonnet-4-6",
  maxTokens = 1024,
  system = "",
  businessContext = "",
  messages = [],
  tools,
  temperature,
  enableCaching = true,
  onChunk,     // (text: string) => void — called per token/word
  onDone,      // (fullText: string, usage: object) => void
  onError,     // (err: Error) => void
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    onError?.(new Error("ANTHROPIC_API_KEY not set"));
    return;
  }

  const body = { model, max_tokens: maxTokens, messages, stream: true };

  const systemBlocks = [];
  if (system) systemBlocks.push({ type: "text", text: system });
  if (businessContext) systemBlocks.push({ type: "text", text: "\n\nBusiness context:\n" + businessContext });
  if (systemBlocks.length > 0) {
    const totalChars = systemBlocks.reduce((n, b) => n + b.text.length, 0);
    if (enableCaching && totalChars >= 4000) {
      systemBlocks[systemBlocks.length - 1].cache_control = { type: "ephemeral" };
    }
    body.system = systemBlocks;
  }
  if (tools && tools.length) body.tools = tools;
  if (temperature != null) body.temperature = temperature;

  try {
    const r = await fetchWithRetry(ANTHROPIC_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

    if (!r.ok || !r.body) {
      const errText = await r.text().catch(() => "stream open failed");
      throw new Error(`Anthropic stream ${r.status}: ${errText}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let finalUsage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames — each separated by blank line
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        const dataLine = frame.split("\n").find(l => l.startsWith("data: "));
        if (!dataLine) continue;
        const payload = dataLine.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            const t = evt.delta.text || "";
            fullText += t;
            onChunk?.(t);
          } else if (evt.type === "message_delta" && evt.usage) {
            finalUsage = evt.usage;
          }
        } catch { /* ignore malformed frames */ }
      }
    }

    onDone?.(fullText, finalUsage);
  } catch (err) {
    onError?.(err);
  }
}

// ─── 3. batchClaude — submit bulk work at 50% cost ─────────────────────────
//
// Usage:
//   const batchId = await batchClaude.submit([
//     { custom_id: "txn-1",    params: { model, max_tokens, system, messages } },
//     { custom_id: "txn-2",    params: { model, max_tokens, system, messages } },
//     ...up to 10,000 requests or 256MB
//   ]);
//
//   // Poll or check later:
//   const status = await batchClaude.status(batchId);
//   if (status.processing_status === "ended") {
//     const results = await batchClaude.results(batchId); // { "txn-1": "...", "txn-2": "..." }
//   }
//
// Best for: overnight bookkeeper categorization, weekly growth reports,
// bulk cold email drafting, schedule-ahead social posts.
// NOT for: anything user is waiting on — batches take minutes to hours.

const batchClaude = {
  async submit(requests) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    const r = await fetch("https://api.anthropic.com/v1/messages/batches", {
      method: "POST",
      headers: headers({ "anthropic-beta": "message-batches-2024-09-24" }),
      body: JSON.stringify({ requests }),
    });
    if (!r.ok) throw new Error(`Batch submit failed ${r.status}: ${await r.text()}`);
    const d = await r.json();
    return d.id;
  },

  async status(batchId) {
    const r = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
      headers: headers({ "anthropic-beta": "message-batches-2024-09-24" }),
    });
    if (!r.ok) throw new Error(`Batch status failed ${r.status}`);
    return await r.json();
  },

  async results(batchId) {
    const s = await this.status(batchId);
    if (s.processing_status !== "ended") {
      throw new Error(`Batch not ready: ${s.processing_status}`);
    }
    const r = await fetch(s.results_url, {
      headers: headers({ "anthropic-beta": "message-batches-2024-09-24" }),
    });
    if (!r.ok) throw new Error(`Batch results fetch failed ${r.status}`);
    const text = await r.text();
    // Results are JSONL — one result per line
    const out = {};
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.result?.type === "succeeded") {
          const msg = row.result.message;
          const textBlock = msg.content?.find(b => b.type === "text");
          out[row.custom_id] = { text: textBlock?.text || "", usage: msg.usage };
        } else {
          out[row.custom_id] = { error: row.result?.error?.message || "unknown" };
        }
      } catch { /* skip malformed */ }
    }
    return out;
  },

  async cancel(batchId) {
    const r = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/cancel`, {
      method: "POST",
      headers: headers({ "anthropic-beta": "message-batches-2024-09-24" }),
    });
    if (!r.ok) throw new Error(`Batch cancel failed ${r.status}`);
    return await r.json();
  },

  async list({ limit = 20 } = {}) {
    const r = await fetch(`https://api.anthropic.com/v1/messages/batches?limit=${limit}`, {
      headers: headers({ "anthropic-beta": "message-batches-2024-09-24" }),
    });
    if (!r.ok) throw new Error(`Batch list failed ${r.status}`);
    return await r.json();
  },
};

module.exports = { callClaude, streamClaude, batchClaude };
