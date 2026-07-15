"""
Claude Computer Use agent loop. Roughly follows Anthropic's reference impl
but trimmed for production use. The loop:
  1. Start fresh Chrome session (kills any previous)
  2. Optionally navigate to start_url
  3. Take screenshot, send to Claude with the system prompt + user task
  4. Parse Claude's response — either text (done) or tool_use (do an action)
  5. If tool_use → execute (click/type/scroll/key) → screenshot → loop
  6. Stop at: completion, max_actions reached, forbidden pattern hit, error
"""

import os, subprocess, time, json, re, requests
from anthropic import Anthropic
from tools.computer import ComputerTool

DISPLAY = os.environ.get("DISPLAY", ":1")


def kill_chrome():
    """Force-kill any stale Chrome processes between tasks."""
    subprocess.run(["pkill", "-9", "-f", "chrome"], check=False)
    time.sleep(0.5)


def start_chrome(start_url=None):
    """Launch headed Chrome in the Xvfb display. Returns nothing — fire and forget."""
    kill_chrome()
    args = [
        "google-chrome",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--user-data-dir=/tmp/chrome-profile",
        "--window-size=1280,800",
        "--window-position=0,0",
    ]
    if start_url:
        args.append(start_url)
    else:
        args.append("about:blank")
    subprocess.Popen(args, env={**os.environ, "DISPLAY": DISPLAY},
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Give Chrome a moment to render
    time.sleep(3 if start_url else 1.5)


def contains_forbidden(text, patterns):
    """Case-insensitive substring check across all forbidden patterns."""
    if not text or not patterns: return None
    low = text.lower()
    for p in patterns:
        if p and p.lower() in low:
            return p
    return None


def fetch_credentials(unlock_url, auth_header, user_id, task_id, domain):
    """Ask MINE backend for credentials for the given domain.
    MINE returns {ok: true, username, password, ...} or {ok: false}."""
    try:
        r = requests.post(unlock_url, json={
            "user_id": user_id, "task_id": task_id, "domain": domain,
        }, headers={"X-Internal-Auth": auth_header}, timeout=10)
        if r.ok:
            return r.json()
    except Exception as e:
        print(f"[cred-unlock] failed: {e}")
    return None


def run_task(payload):
    """Main entry. Returns a dict matching the contract in server.py docstring."""
    task_id = payload.get("task_id")
    user_id = payload.get("user_id")
    anthropic_key = payload["anthropic_key"]
    model = payload.get("model", "claude-opus-4-7")
    max_actions = int(payload.get("max_actions") or 50)
    system_prompt = payload.get("system_prompt") or ""
    forbidden = payload.get("forbidden_patterns") or []
    start_url = payload.get("start_url")
    user_prompt = payload["prompt"]
    tools_def = payload.get("tools") or []

    # Pre-flight forbidden check on user prompt itself
    hit = contains_forbidden(user_prompt, forbidden)
    if hit:
        return {
            "ok": False, "task_id": task_id,
            "stopped_reason": "forbidden_pattern",
            "error": f"prompt blocked by pattern: {hit}",
            "transcript": [], "actions_taken": 0,
        }

    # Boot the browser
    start_chrome(start_url)

    client = Anthropic(api_key=anthropic_key)
    computer = ComputerTool(display=DISPLAY,
                            width=int(payload.get("tools", [{}])[0].get("display_width_px") or 1280),
                            height=int(payload.get("tools", [{}])[0].get("display_height_px") or 800))

    # First screenshot is included so Claude has a starting image
    initial_screenshot_b64 = computer.screenshot_b64()

    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": user_prompt},
            {"type": "image", "source": {
                "type": "base64", "media_type": "image/png", "data": initial_screenshot_b64
            }},
        ],
    }]

    transcript = list(messages)
    actions_taken = 0
    stopped_reason = "completed"
    summary = ""

    try:
        for _ in range(max_actions + 5):  # +5 buffer for non-action turns (text replies)
            resp = client.messages.create(
                model=model,
                max_tokens=4096,
                system=system_prompt or None,
                tools=tools_def,
                messages=messages,
                betas=["computer-use-2024-10-22"],  # required header
            )

            # Append assistant turn to transcript
            assistant_blocks = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in resp.content]
            messages.append({"role": "assistant", "content": assistant_blocks})
            transcript.append(messages[-1])

            # Check for forbidden patterns in assistant text
            for block in assistant_blocks:
                if block.get("type") == "text":
                    hit = contains_forbidden(block.get("text", ""), forbidden)
                    if hit:
                        stopped_reason = "forbidden_pattern"
                        summary = f"stopped: forbidden pattern '{hit}'"
                        break
                    summary = block.get("text", "") or summary
            if stopped_reason == "forbidden_pattern":
                break

            # Find tool_use blocks
            tool_uses = [b for b in assistant_blocks if b.get("type") == "tool_use"]
            if not tool_uses:
                # No more actions — Claude is done
                stopped_reason = "completed"
                break

            # Execute each tool_use
            tool_results = []
            for tu in tool_uses:
                tool_name = tu.get("name")
                tool_input = tu.get("input") or {}
                tool_use_id = tu.get("id")
                try:
                    if tool_name == "computer":
                        out_b64 = computer.execute(tool_input)
                        actions_taken += 1
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": [{
                                "type": "image",
                                "source": {"type": "base64", "media_type": "image/png", "data": out_b64},
                            }],
                        })
                    else:
                        tool_results.append({
                            "type": "tool_result", "tool_use_id": tool_use_id,
                            "content": [{"type": "text", "text": f"unknown tool: {tool_name}"}],
                            "is_error": True,
                        })
                except Exception as e:
                    tool_results.append({
                        "type": "tool_result", "tool_use_id": tool_use_id,
                        "content": [{"type": "text", "text": f"tool error: {e}"}],
                        "is_error": True,
                    })

            # Feed results back to Claude
            messages.append({"role": "user", "content": tool_results})
            transcript.append(messages[-1])

            if actions_taken >= max_actions:
                stopped_reason = "max_actions"
                break

        else:
            stopped_reason = "max_actions"

        return {
            "ok": stopped_reason in ("completed",),
            "task_id": task_id,
            "summary": summary or "no text response",
            "actions_taken": actions_taken,
            "stopped_reason": stopped_reason,
            "error": None if stopped_reason in ("completed", "max_actions") else stopped_reason,
            "transcript": transcript,
        }
    finally:
        kill_chrome()
