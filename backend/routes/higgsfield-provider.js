// ─── Higgsfield Provider Module (REWRITTEN — verified against official SDK) ──
//
// References:
//   • Official Node SDK README:  github.com/higgsfield-ai/higgsfield-js
//   • Official Python SDK README: github.com/higgsfield-ai/higgsfield-client
//
// Verified facts (May 2026):
//   • Base URL:    https://platform.higgsfield.ai
//   • Auth header: Authorization: Key KEY_ID:KEY_SECRET   (NOT HMAC — simple bearer)
//   • Env vars:    HF_API_KEY + HF_API_SECRET   (or HF_CREDENTIALS / HF_KEY = "key:secret")
//   • Endpoints (v1):
//        Text-to-image (Soul):     POST /v1/text2image/soul
//        Image-to-video (DoP):     POST /v1/image2video/dop
//        Speech-to-video:          POST /v1/speak/higgsfield
//        Status polling:           GET  /requests/{request_id}/status
//   • Response shape:
//        { status: "queued"|"in_progress"|"nsfw"|"failed"|"completed",
//          request_id: "...", status_url: "...", cancel_url: "...",
//          images?: [{url}], video?: {url} }
//   • Status terminal states: completed | failed | nsfw
//
// Known unknowns (still scaffolded — needs real-credentials test to verify):
//   • Soul ID creation endpoint path (SDK has createSoulId() but URL not in README)
//   • Kling 3.0 endpoint — not in the SDK README; we use /v1/image2video/dop with
//     dop-turbo model as the cinematic-video equivalent (same use case, verified path).
//
// All functions return { ok, url?, jobId?, error?, provider } so callers
// can chain providers cleanly without knowing the implementation.

const HF_BASE = process.env.HF_API_BASE || "https://platform.higgsfield.ai";

// ─── Credentials ────────────────────────────────────────────────────────────
function credentials() {
  // Support both formats per official SDK:
  //   • Separate:  HF_API_KEY + HF_API_SECRET
  //   • Combined:  HF_CREDENTIALS or HF_KEY = "key_id:key_secret"
  const combined = process.env.HF_CREDENTIALS || process.env.HF_KEY;
  if (combined && combined.includes(":")) {
    const [key, secret] = combined.split(":", 2);
    if (key && secret) return { key: key.trim(), secret: secret.trim() };
  }
  const key = process.env.HF_API_KEY;
  const secret = process.env.HF_API_SECRET;
  return key && secret ? { key, secret } : null;
}

function isEnabled() { return !!credentials(); }

function authHeader() {
  const c = credentials();
  if (!c) return null;
  // Verified format from official SDK:  Authorization: Key KEY_ID:KEY_SECRET
  return `Key ${c.key}:${c.secret}`;
}

// ─── Generic request helper ─────────────────────────────────────────────────
async function hfFetch(path, opts = {}) {
  const auth = authHeader();
  if (!auth) throw new Error("Higgsfield not configured (HF_API_KEY/HF_API_SECRET)");

  const url = HF_BASE + path;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": auth,
    "User-Agent": "mine-platform/1.0",
    ...(opts.headers || {}),
  };
  const body = opts.body ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined;
  const r = await fetch(url, { method: opts.method || "GET", headers, body });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  return { ok: r.ok, status: r.status, json, text };
}

// ─── Polling helper — wait until terminal status, with safety timeout ───────
async function pollUntilDone(requestId, { intervalMs = 2000, maxMs = 300000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const r = await hfFetch(`/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" });
    if (!r.ok || !r.json) {
      return { ok: false, error: r.text || `Status check failed: ${r.status}` };
    }
    const status = r.json.status;
    if (status === "completed") {
      return { ok: true, status, raw: r.json };
    }
    if (status === "failed" || status === "nsfw" || status === "canceled" || status === "cancelled") {
      return { ok: false, error: `Generation ${status}`, status, raw: r.json };
    }
    // Still queued/in_progress — wait and try again
    await new Promise(res => setTimeout(res, intervalMs));
  }
  return { ok: false, error: "polling timed out after " + (maxMs / 1000) + "s" };
}

// ─── Single-shot job: submit + wait + extract result ────────────────────────
async function runJob(path, body, { extract = "image", maxMs = 300000 } = {}) {
  // Submit the job
  const submit = await hfFetch(path, { method: "POST", body });
  if (!submit.ok || !submit.json) {
    return { ok: false, error: (submit.json && submit.json.error) || submit.text || `HF returned ${submit.status}` };
  }

  // Submissions return either an immediate result (rare) or { request_id, status_url }
  let finalJson = submit.json;
  if (finalJson.status && finalJson.status !== "completed" && finalJson.request_id) {
    const polled = await pollUntilDone(finalJson.request_id, { maxMs });
    if (!polled.ok) return polled;
    finalJson = polled.raw;
  }

  // Extract URL — response shape: { images: [{url}], video: {url} }
  let url = null;
  if (extract === "video" && finalJson.video && finalJson.video.url) url = finalJson.video.url;
  else if (finalJson.images && finalJson.images[0] && finalJson.images[0].url) url = finalJson.images[0].url;
  else if (finalJson.video && finalJson.video.url) url = finalJson.video.url;

  if (!url) {
    return { ok: false, error: "no media URL in response", raw: finalJson };
  }
  return { ok: true, url, requestId: finalJson.request_id, raw: finalJson };
}

// ─── Soul: text-to-image with optional Soul ID for character consistency ────
// Verified endpoint: /v1/text2image/soul
// Verified params:   prompt, width_and_height, quality, batch_size,
//                    custom_reference_id (Soul ID), custom_reference_strength,
//                    style_id, style_strength, seed
async function generateSoulImage({ prompt, aspectRatio = "1:1", quality = "standard", soulId = null, referenceImageUrl = null }) {
  if (!isEnabled()) return { ok: false, error: "higgsfield_disabled", provider: "higgsfield-soul" };
  if (!prompt || prompt.length < 3) return { ok: false, error: "prompt too short", provider: "higgsfield-soul" };

  // Map our aspect-ratio strings to Higgsfield's width_and_height enum values
  // (Values match SoulSize enum from official SDK helpers)
  const sizeMap = {
    "1:1":   "SQUARE_1536x1536",
    "16:9":  "LANDSCAPE_2048x1536",
    "9:16":  "PORTRAIT_1536x2048",
    "4:5":   "PORTRAIT_1536x1920",
    "1.91:1":"LANDSCAPE_2048x1080",
  };

  const body = {
    prompt: prompt.slice(0, 2000),
    width_and_height: sizeMap[aspectRatio] || "SQUARE_1536x1536",
    quality: (quality === "hd" || quality === "premium") ? "HD" : "STANDARD",
    batch_size: "SINGLE",
  };
  if (soulId) {
    body.custom_reference_id = soulId;
    body.custom_reference_strength = 1.0;
  }

  try {
    const result = await runJob("/v1/text2image/soul", body, { extract: "image" });
    if (!result.ok) return { ok: false, error: result.error, provider: "higgsfield-soul" };
    return { ok: true, url: result.url, requestId: result.requestId, provider: "higgsfield-soul" };
  } catch (err) {
    return { ok: false, error: err.message, provider: "higgsfield-soul" };
  }
}

// ─── DoP (Director of Photography) image-to-video for cinematic clips ───────
// Verified endpoint: /v1/image2video/dop
// Verified params:   model, prompt, input_images, motions?
//
// This is what we surface as "Kling-equivalent cinematic" in the runway endpoint.
// Higgsfield's actual Kling 3.0 endpoint isn't documented in the SDK README — DoP
// is the closest documented cinematic video model. Both produce ~5s cinematic clips.
async function generateKlingVideo({ prompt, duration = 5, aspectRatio = "16:9", referenceImageUrl = null }) {
  if (!isEnabled()) return { ok: false, error: "higgsfield_disabled", provider: "higgsfield-dop" };
  if (!prompt || prompt.length < 3) return { ok: false, error: "prompt too short", provider: "higgsfield-dop" };
  if (!referenceImageUrl) {
    // DoP is image-to-video. Without a reference image we can't generate.
    // Caller should use text-to-image first, then pass the result here.
    return { ok: false, error: "DoP is image-to-video — referenceImageUrl required", provider: "higgsfield-dop" };
  }

  const body = {
    model: "dop-turbo", // Other options: dop-standard, dop-pro (per SDK DoPModel enum)
    prompt: prompt.slice(0, 2000),
    input_images: [{ type: "image_url", image_url: referenceImageUrl }],
  };

  try {
    const result = await runJob("/v1/image2video/dop", body, { extract: "video", maxMs: 300000 });
    if (!result.ok) {
      return { ok: false, error: result.error, jobId: result.requestId, provider: "higgsfield-dop" };
    }
    return { ok: true, url: result.url, requestId: result.requestId, provider: "higgsfield-dop" };
  } catch (err) {
    return { ok: false, error: err.message, provider: "higgsfield-dop" };
  }
}

// ─── Soul ID training ───────────────────────────────────────────────────────
// The official SDK exposes client.createSoulId({ name, input_images }) but
// the underlying REST endpoint path isn't in the README. Best guess based on
// SDK naming convention. Falls through known candidate paths.
async function createSoulId({ name, referenceImages = [] }) {
  if (!isEnabled()) return { ok: false, error: "higgsfield_disabled" };
  if (!name || !Array.isArray(referenceImages) || referenceImages.length < 2) {
    return { ok: false, error: "name + at least 2 reference image URLs required" };
  }

  const body = {
    name: name.slice(0, 100),
    input_images: referenceImages.map(url => ({ type: "image_url", image_url: url })),
  };

  const tries = ["/v1/soul-ids", "/v1/soul-ids/create", "/v1/soul/ids"];
  for (const path of tries) {
    const r = await hfFetch(path, { method: "POST", body });
    if (r.ok && r.json) {
      const id = r.json.id || r.json.soul_id || r.json.request_id;
      return {
        ok: true,
        soulId: id,
        status: r.json.status || "training",
        provider: "higgsfield-soul-id",
      };
    }
    if (r.status !== 404) {
      return { ok: false, error: (r.json && r.json.error) || r.text || `HF returned ${r.status}` };
    }
  }
  return { ok: false, error: "Soul ID create endpoint not found at any candidate path. Check Higgsfield docs." };
}

// ─── Status polling — exposed for the video endpoint's polling URL ──────────
async function pollJob(requestId) {
  if (!isEnabled()) return { ok: false, error: "higgsfield_disabled" };
  if (!requestId) return { ok: false, error: "requestId required" };

  const r = await hfFetch(`/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" });
  if (!r.ok || !r.json) {
    return { ok: false, error: r.text || `HF returned ${r.status}` };
  }
  const j = r.json;
  const rawStatus = j.status || "unknown";
  const status = rawStatus === "completed" ? "completed"
               : (rawStatus === "failed" || rawStatus === "nsfw" || rawStatus === "canceled" || rawStatus === "cancelled") ? "failed"
               : "processing";
  return {
    ok: true,
    status,
    url: (j.video && j.video.url) || (j.images && j.images[0] && j.images[0].url) || null,
    progress: null,
    raw: j,
  };
}

module.exports = {
  isEnabled,
  generateSoulImage,
  generateKlingVideo,    // uses DoP under the hood — see comment above
  createSoulId,
  pollJob,
  _hfFetch: hfFetch,
  _credentials: credentials,
};
