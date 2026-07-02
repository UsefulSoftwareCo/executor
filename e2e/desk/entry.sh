#!/usr/bin/env bash
# Desk entrypoint (runs inside the desk image): boot a display, roll one
# camera on it, run the scenario with E2E_DESK=1 so its windows land on the
# display, then drop the film into the scenario's run dir as session.mp4.
set -euo pipefail

SCENARIO="${DESK_SCENARIO:-scenarios/connect-handoff-session.test.ts}"
PROJECT="${DESK_PROJECT:-cloud}"
SIZE="${DESK_SIZE:-1440x900}"

echo "[desk] installing dependencies (cached in a volume after first run)…"
bun install --frozen-lockfile

echo "[desk] display :99 at ${SIZE}"
Xvfb :99 -screen 0 "${SIZE}x24" -nolisten tcp &
export DISPLAY=:99
sleep 0.5
openbox &
xsetroot -solid "#0b0b10" || true

mkdir -p /desk-out
echo "[desk] camera rolling"
ffmpeg -loglevel error -f x11grab -framerate 24 -video_size "$SIZE" -i :99 \
  -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -y /desk-out/desk.mp4 &
FFMPEG_PID=$!

set +e
(cd e2e && E2E_DESK=1 npx vitest run --project "$PROJECT" "$SCENARIO")
STATUS=$?
set -e

sleep 1
kill -INT "$FFMPEG_PID" 2>/dev/null || true
wait "$FFMPEG_PID" 2>/dev/null || true

# The desk film IS the session recording — it replaces the browser-only
# video the surface recorded inside the run.
RUN_DIR=$(ls -dt e2e/runs/"$PROJECT"/*/ 2>/dev/null | head -1)
if [ -n "$RUN_DIR" ] && [ -f /desk-out/desk.mp4 ]; then
  cp /desk-out/desk.mp4 "${RUN_DIR}session.mp4"
  echo "[desk] film → ${RUN_DIR}session.mp4"
fi
exit "$STATUS"
