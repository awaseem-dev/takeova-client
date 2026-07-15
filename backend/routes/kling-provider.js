// ─── Kling Provider (text-to-video + image-to-video via aggregator API) ──────
//
// Path B: real Kling 3.0 video through a pay-per-call aggregator. ModelsLab,
// PiAPI, PoYo and Segmind all expose Kling 3.0 with a near-identical async
// "create job → poll task" REST shape. Defaults below target a ModelsLab-style
// contract; point them at any of the others by overriding the env vars.
//
// Config — the admin "API Keys" panel saves KLING_API_KEY to platform_settings;
// environment variables are the fallback. Endpoint/model knobs are env-only:
//   KLING_API_KEY        (required)  Bearer key for the chosen aggregator
//   KLING_API_BASE       default  https://modelslab.com/api/v1
//   KLING_T2V_PATH       default  /kling/text-to-video
//   KLING_I2V_PATH       default  /kling/image-to-video
//   KLING_STATUS_PATH    default  /kling/fetch/:id   (":id" is substituted)
//   KLING_MODEL          default  kling-v3
//
// IMPORTANT: the exact paths and request/response field names vary per provider.
// This module is structured correctly and the response parser already handles
// the common shapes, but VERIFY against your provider's docs and adjust the env
// vars accordingly — these calls cannot be validated without a live key.
//
// Every function returns { ok, url?, requestId?, status?, error?, provider:"kling" }
// so /video/runway can chain Kling → Runway/HF fallback without knowing internals.

let _getSetting = null;
try { _getSetting = require("../db/init").getSetting; } catch (_) { _getSetting = null; }

function apiKey() {
  let fromDb = "";
  try { if (_getSetting) fromDb = _getSetting("KLING_API_KEY") || ""; } catch (_) { fromDb = ""; }
  return String(fromDb || process.env.KLING_API_KEY || "").trim();
}

function isEnabled() { return !!apiKey(); }

function cfg() {
  return {
    base:       (process.env.KLING_API_BASE   || "https://modelslab.com/api/v1").replace(/\/+$/, ""),
    t2vPath:     process.env.KLING_T2V_PATH    || "/kling/text-to-video",
    i2vPath:     process.env.KLING_I2V_PATH    || "/kling/image-to-video",
    statusPath:  process.env.KLING_STATUS_PATH || "/kling/fetch/:id",
    model:       process.env.KLING_MODEL       || "kling-v3",
  };
}

// Kling expects 5/10s base durations; clamp a single-clip request into range.
function clampDur(d) { d = parseInt(d) || 5; if (d < 5) d = 5; if (d > 15) d = 15; return d; }

async function _fetch(url, opts = {}) {
  const fetch2 = (await import("node-fetch")).default;
  const key = apiKey();
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
    ...(opts.headers || {}),
  };
  const body = opts.body ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined;
  const r = await fetch2(url, { method: opts.method || "GET", headers, body });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  return { ok: r.ok, status: r.status, json, text };
}

// Pull a job/request id out of whatever the provider returned.
function extractId(j) {
  if (!j) return null;
  return j.id || j.task_id || j.request_id || j.requestId || j.fetch_result_id ||
         (j.data && (j.data.id || j.data.task_id || j.data.request_id)) || null;
}

// Pull a finished MP4 URL out of whatever the provider returned.
function extractUrl(j) {
  if (!j) return null;
  if (Array.isArray(j.output) && j.output[0]) return typeof j.output[0] === "string" ? j.output[0] : (j.output[0].url || null);
  if (j.output && j.output.media_url) return j.output.media_url;
  if (j.output && typeof j.output === "string") return j.output;
  if (j.video && j.video.url) return j.video.url;
  if (j.video_url) return j.video_url;
  if (j.media_url) return j.media_url;
  if (Array.isArray(j.future_links) && j.future_links[0]) return j.future_links[0];
  if (typeof j.fetch_result === "string" && /^https?:/.test(j.fetch_result)) return j.fetch_result;
  if (j.data && j.data.url) return j.data.url;
  return null;
}

// Normalise the provider's status string to completed | failed | processing.
function extractStatus(j) {
  if (!j) return "processing";
  if (extractUrl(j)) return "completed";
  const s = String(j.status || j.state || "").toLowerCase();
  if (["success", "succeeded", "completed", "complete", "done", "ready"].includes(s)) return "completed";
  if (["failed", "error", "errored", "nsfw", "canceled", "cancelled"].includes(s)) return "failed";
  return "processing"; // processing | queued | in_queue | in_progress | starting | …
}

async function _submit(path, body) {
  if (!isEnabled()) return { ok: false, error: "kling_disabled", provider: "kling" };
  const c = cfg();
  // Send the key in the body too — ModelsLab-style APIs read it there; the
  // Bearer header covers PiAPI/PoYo-style auth. Harmless to include both.
  const payload = Object.assign({ key: apiKey() }, body);
  let r;
  try { r = await _fetch(c.base + path, { method: "POST", body: payload }); }
  catch (e) { return { ok: false, error: e.message, provider: "kling" }; }
  if (!r.ok && !(r.json && (extractId(r.json) || extractUrl(r.json)))) {
    return { ok: false, error: (r.json && (r.json.error || r.json.message)) || r.text || `kling HTTP ${r.status}`, provider: "kling" };
  }
  const url = extractUrl(r.json);
  if (url) return { ok: true, url, requestId: extractId(r.json), status: "completed", provider: "kling" };
  const id = extractId(r.json);
  if (id) return { ok: true, requestId: id, status: "processing", provider: "kling" };
  return { ok: false, error: "no job id or url in Kling response", raw: r.json, provider: "kling" };
}

async function generateTextToVideo({ prompt, duration = 5, aspectRatio = "16:9" }) {
  if (!prompt || String(prompt).trim().length < 3) return { ok: false, error: "prompt too short", provider: "kling" };
  const c = cfg();
  return _submit(c.t2vPath, {
    model_id: c.model,
    prompt: String(prompt).slice(0, 2400),
    duration: clampDur(duration),
    aspect_ratio: aspectRatio,
    cfg_scale: 0.5,
  });
}

async function generateImageToVideo({ prompt, duration = 5, aspectRatio = "16:9", referenceImageUrl = null }) {
  if (!referenceImageUrl) return { ok: false, error: "referenceImageUrl required for image-to-video", provider: "kling" };
  const c = cfg();
  return _submit(c.i2vPath, {
    model_id: c.model,
    prompt: String(prompt || "Cinematic camera movement").slice(0, 2400),
    init_image: referenceImageUrl,   // ModelsLab field; PiAPI uses image_url
    image_url: referenceImageUrl,    // include both so either provider picks it up
    duration: clampDur(duration),
    aspect_ratio: aspectRatio,
    cfg_scale: 0.5,
  });
}

async function pollJob(requestId) {
  if (!isEnabled()) return { ok: false, error: "kling_disabled", provider: "kling" };
  if (!requestId) return { ok: false, error: "requestId required", provider: "kling" };
  const c = cfg();
  const url = c.base + c.statusPath.replace(":id", encodeURIComponent(requestId));
  let r;
  // Most aggregators expose status via GET; ModelsLab's fetch wants a POST with
  // the key. Try GET first, then POST with the key on a non-2xx.
  try {
    r = await _fetch(url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(apiKey()), { method: "GET" });
    if (!r.ok) r = await _fetch(url, { method: "POST", body: { key: apiKey(), request_id: requestId } });
  } catch (e) {
    return { ok: false, error: e.message, provider: "kling" };
  }
  if (!r.ok && !r.json) return { ok: false, error: r.text || `kling status HTTP ${r.status}`, provider: "kling" };
  return { ok: true, status: extractStatus(r.json), url: extractUrl(r.json), progress: null, raw: r.json, provider: "kling" };
}

module.exports = {
  isEnabled,
  generateTextToVideo,
  generateImageToVideo,
  pollJob,
  _apiKey: apiKey,
};
