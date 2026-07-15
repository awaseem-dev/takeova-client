/**
 * MINE Claude Batch API Utility
 *
 * Wraps Anthropic's Message Batches API for high-volume Claude calls.
 * Benefits vs sequential calls:
 *   - 50% cheaper per token
 *   - Runs server-side at Anthropic — survives server restarts
 *   - Up to 10,000 requests per batch
 *
 * Appropriate for: Prospector demo generation, Cold Email writing, Proposal generation
 * NOT appropriate for: real-time chat, MINE Control, anything needing instant response
 *
 * Docs: https://docs.anthropic.com/en/docs/build-with-claude/message-batches
 */

const { getDb, getSetting } = require('../db/init');

// ── DB table for tracking batch jobs ─────────────────────────────────────────
function ensureBatchTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS claude_batches (
    id           TEXT PRIMARY KEY,      -- Anthropic batch ID
    type         TEXT NOT NULL,         -- 'prospector' | 'cold_email' | 'proposal'
    ref_id       TEXT NOT NULL,         -- campaign_id or job_id
    user_id      TEXT NOT NULL,
    status       TEXT DEFAULT 'pending', -- pending | processing | complete | failed
    total        INTEGER DEFAULT 0,
    completed    INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  )`);
}

// ── Submit a batch to Anthropic ───────────────────────────────────────────────
/**
 * @param {Array<{customId: string, model: string, maxTokens: number, prompt: string}>} requests
 * @returns {string} Anthropic batch ID
 */
async function submitBatch(requests) {
  const fetch = (await import('node-fetch')).default;
  const apiKey = getSetting('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const body = {
    requests: requests.map(r => ({
      custom_id: r.customId,
      params: {
        model: r.model || 'claude-haiku-4-5-20251001',
        max_tokens: r.maxTokens || 1000,
        messages: [{ role: 'user', content: r.prompt }]
      }
    }))
  };

  const res = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'message-batches-2024-09-24',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Batch submit failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.id; // Anthropic batch ID
}

// ── Poll batch status ─────────────────────────────────────────────────────────
async function getBatchStatus(batchId) {
  const fetch = (await import('node-fetch')).default;
  const apiKey = getSetting('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;

  const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'message-batches-2024-09-24'
    }
  });

  if (!res.ok) throw new Error(`Batch status check failed: ${res.status}`);
  return await res.json();
  // Returns: { id, processing_status: 'in_progress'|'ended', request_counts: { processing, succeeded, errored, canceled, expired } }
}

// ── Fetch batch results once complete ────────────────────────────────────────
async function getBatchResults(batchId) {
  const fetch = (await import('node-fetch')).default;
  const apiKey = getSetting('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;

  const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'message-batches-2024-09-24'
    }
  });

  if (!res.ok) throw new Error(`Batch results fetch failed: ${res.status}`);

  // Results come as newline-delimited JSON
  const text = await res.text();
  const results = {};
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      // r.result.type: 'succeeded' | 'errored' | 'canceled' | 'expired'
      results[r.custom_id] = {
        success: r.result?.type === 'succeeded',
        text: r.result?.message?.content?.[0]?.text || '',
        error: r.result?.type !== 'succeeded' ? r.result?.type : null
      };
    } catch(e) { /* skip malformed line */ }
  }
  return results;
}

// ── Poll until complete (with timeout) ───────────────────────────────────────
/**
 * Poll a batch until processing_status === 'ended' or timeout.
 * @param {string} batchId
 * @param {number} maxWaitMs  Maximum wait time in ms (default: 1 hour)
 * @param {number} intervalMs Poll interval in ms (default: 30s)
 * @returns {object} Final batch status
 */
async function waitForBatch(batchId, maxWaitMs = 3600_000, intervalMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await getBatchStatus(batchId);
    if (status.processing_status === 'ended') return status;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Batch ${batchId} timed out after ${maxWaitMs / 60_000} minutes`);
}

// ── Register a batch in local DB ─────────────────────────────────────────────
function registerBatch(db, batchId, type, refId, userId, total) {
  ensureBatchTable(db);
  db.prepare(`INSERT OR REPLACE INTO claude_batches (id, type, ref_id, user_id, status, total, created_at, updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`)
    .run(batchId, type, refId, userId, 'processing', total);
}

function updateBatch(db, batchId, status, completed) {
  db.prepare(`UPDATE claude_batches SET status=?, completed=?, updated_at=datetime('now') WHERE id=?`)
    .run(status, completed, batchId);
}

module.exports = { submitBatch, getBatchStatus, getBatchResults, waitForBatch, registerBatch, updateBatch, ensureBatchTable };
