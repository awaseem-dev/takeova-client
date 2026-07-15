#!/bin/bash
set -e

# Clean up any stale lock files
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true

# Start virtual display
echo "[start] Starting Xvfb on :${DISPLAY_NUM} (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT})"
Xvfb :${DISPLAY_NUM} -screen 0 ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24 -ac &
XVFB_PID=$!
sleep 1

# Lightweight window manager
echo "[start] Starting fluxbox"
fluxbox -display :${DISPLAY_NUM} &
sleep 1

# x11vnc for remote debugging (optional — exposed on 5900 if you want to peek)
if [ "${ENABLE_VNC}" = "true" ]; then
  echo "[start] Starting x11vnc on :5900"
  x11vnc -display :${DISPLAY_NUM} -nopw -forever -shared -rfbport 5900 &
fi

# Run the HTTP server (gunicorn for prod, with 1 sync worker since we manage browser state per-task)
echo "[start] Starting server on :8000"
exec gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 600 server:app
