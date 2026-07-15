"""
MINE Web Hands Runner — HTTP API
Accepts task requests from MINE backend, runs Claude's Computer Use loop
in a sandboxed browser, returns the final result.

Request contract (POST /run, X-Internal-Auth required):
{
  "task_id":                "...",
  "user_id":                "...",
  "anthropic_key":          "sk-ant-...",
  "model":                  "claude-opus-4-7",
  "max_actions":            50,
  "system_prompt":          "...",
  "forbidden_patterns":     ["wire transfer", ...],
  "credential_unlock_url":  "https://api.your-mine.com/api/credentials/_unlock",
  "internal_auth_header":   "<INTERNAL_API_KEY>",
  "prompt":                 "Download last month's invoices...",
  "start_url":              "https://supplier.example.com/login" or null,
  "tools":                  [{"type":"computer_20241022","name":"computer",
                              "display_width_px":1280,"display_height_px":800,
                              "display_number":1}]
}

Returns:
{
  "ok":               true|false,
  "task_id":          "...",
  "summary":          "Last assistant message text",
  "actions_taken":    23,
  "stopped_reason":   "completed" | "max_actions" | "forbidden_pattern" | "error",
  "error":            null | "...",
  "transcript":       [ ... full message history for audit ... ]
}
"""

import os, time, traceback
from flask import Flask, request, jsonify
from computer_use_loop import run_task

app = Flask(__name__)

INTERNAL_AUTH = os.environ.get("INTERNAL_API_KEY", "").strip()


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "ts": int(time.time())})


@app.route("/run", methods=["POST"])
def run():
    # ── Auth check: INTERNAL_API_KEY must match what MINE backend sends
    incoming = request.headers.get("X-Internal-Auth", "").strip()
    if not INTERNAL_AUTH:
        # Fail-open with a logged warning is unsafe — fail closed instead.
        return jsonify({"ok": False, "error": "INTERNAL_API_KEY not set on runner"}), 500
    if incoming != INTERNAL_AUTH:
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    payload = request.get_json(force=True, silent=True) or {}

    # Required fields
    for k in ("task_id", "anthropic_key", "prompt"):
        if not payload.get(k):
            return jsonify({"ok": False, "error": f"missing required field: {k}"}), 400

    try:
        result = run_task(payload)
        # ── Map the runner's native fields to the shape the MINE backend reads.
        #    backend/routes/browser-agent.js stores result.text / .action_count /
        #    .status / .screenshots / .tokens_used / .data. The runner natively
        #    returns summary / actions_taken / stopped_reason, so without this
        #    Web Hands would run but store an EMPTY result. Native fields are kept
        #    too (for the audit transcript).
        _status = {"completed": "succeeded", "forbidden_pattern": "blocked",
                   "max_actions": "succeeded", "error": "error"}.get(
                       result.get("stopped_reason"), "succeeded")
        result.setdefault("text", result.get("summary", ""))
        result.setdefault("action_count", result.get("actions_taken", 0))
        result.setdefault("status", _status)
        result.setdefault("screenshots", result.get("screenshots", []))
        result.setdefault("tokens_used", result.get("tokens_used", 0))
        result.setdefault("data", result.get("data", {}))
        # 200 for any clean stop (completed / max_actions / forbidden_pattern) so the
        # backend stores the result; 500 only on a hard error.
        http = 500 if result.get("stopped_reason") == "error" else 200
        return jsonify(result), http
    except Exception as e:
        traceback.print_exc()
        return jsonify({
            "ok": False,
            "task_id": payload.get("task_id"),
            "error": f"runner exception: {e}",
            "stopped_reason": "error",
            "transcript": [],
            "actions_taken": 0,
        }), 500


if __name__ == "__main__":
    # Local dev only — production uses gunicorn (see start.sh)
    app.run(host="0.0.0.0", port=8000, debug=False)
