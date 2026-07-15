"""
Computer tool implementations — screenshot, click, type, scroll, key.
Uses xdotool for input and scrot for screenshots. Matches the
`computer_20241022` tool spec from Anthropic.

Anthropic's tool input shape (input dict from Claude):
  action: "screenshot" | "left_click" | "right_click" | "double_click" |
          "middle_click" | "type" | "key" | "mouse_move" | "left_click_drag" |
          "cursor_position" | "scroll"
  coordinate: [x, y]   (for click/drag/scroll/mouse_move)
  text: "..."          (for type/key)
  scroll_direction: "up" | "down" | "left" | "right"  (for scroll)
  scroll_amount: int

Returns base64-encoded PNG after action.
"""

import os, subprocess, base64, time, tempfile


class ComputerTool:
    def __init__(self, display=":1", width=1280, height=800):
        self.display = display
        self.width = width
        self.height = height

    def _env(self):
        return {**os.environ, "DISPLAY": self.display}

    def _run(self, cmd):
        subprocess.run(cmd, env=self._env(), check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # ── Screenshot ──────────────────────────────────────────────────────
    def screenshot_b64(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            path = f.name
        try:
            self._run(["scrot", "-o", "-z", path])
            with open(path, "rb") as fh:
                return base64.b64encode(fh.read()).decode("ascii")
        finally:
            try: os.unlink(path)
            except OSError: pass

    # ── Mouse + keyboard primitives ─────────────────────────────────────
    def move(self, x, y):
        self._run(["xdotool", "mousemove", "--sync", str(int(x)), str(int(y))])

    def click(self, button=1, x=None, y=None):
        if x is not None and y is not None:
            self.move(x, y)
        self._run(["xdotool", "click", str(button)])

    def double_click(self, x=None, y=None):
        if x is not None and y is not None:
            self.move(x, y)
        self._run(["xdotool", "click", "--repeat", "2", "--delay", "100", "1"])

    def drag(self, fx, fy, tx, ty):
        self.move(fx, fy)
        self._run(["xdotool", "mousedown", "1"])
        self.move(tx, ty)
        self._run(["xdotool", "mouseup", "1"])

    def type_text(self, text):
        # --delay = ms between keystrokes; tune for site stability
        self._run(["xdotool", "type", "--delay", "12", text or ""])

    def keypress(self, keys):
        # xdotool key supports combos like 'ctrl+l' or 'Return'
        self._run(["xdotool", "key", keys])

    def scroll(self, direction, amount, x=None, y=None):
        if x is not None and y is not None:
            self.move(x, y)
        # Buttons 4/5 = wheel up/down, 6/7 = wheel left/right
        btn = {"up": "4", "down": "5", "left": "6", "right": "7"}.get(direction, "5")
        for _ in range(max(1, int(amount or 1))):
            self._run(["xdotool", "click", btn])

    # ── Dispatch ────────────────────────────────────────────────────────
    def execute(self, params):
        """Run a single action from Claude's tool_use input, return screenshot after."""
        action = (params or {}).get("action")
        coord = params.get("coordinate") if params else None
        text = params.get("text") if params else None

        if action == "screenshot":
            pass  # just return current screenshot
        elif action == "left_click":
            x, y = coord
            self.click(1, x, y)
            time.sleep(0.5)
        elif action == "right_click":
            x, y = coord
            self.click(3, x, y)
            time.sleep(0.5)
        elif action == "middle_click":
            x, y = coord
            self.click(2, x, y)
            time.sleep(0.3)
        elif action == "double_click":
            x, y = coord
            self.double_click(x, y)
            time.sleep(0.5)
        elif action == "left_click_drag":
            # Anthropic passes start_coordinate + coordinate (end)
            start = params.get("start_coordinate") or [self.width // 2, self.height // 2]
            self.drag(start[0], start[1], coord[0], coord[1])
            time.sleep(0.5)
        elif action == "mouse_move":
            x, y = coord
            self.move(x, y)
        elif action == "type":
            self.type_text(text)
            time.sleep(0.2)
        elif action == "key":
            self.keypress(text)
            time.sleep(0.3)
        elif action == "cursor_position":
            pass  # no-op; we just return a screenshot
        elif action == "scroll":
            direction = params.get("scroll_direction") or "down"
            amount = params.get("scroll_amount") or 3
            self.scroll(direction, amount, coord[0] if coord else None, coord[1] if coord else None)
            time.sleep(0.4)
        else:
            # Unknown action — still return a screenshot so the loop can recover
            pass

        return self.screenshot_b64()
