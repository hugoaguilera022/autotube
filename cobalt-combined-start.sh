#!/bin/sh
set -eu
bun /opt/yt-session/src/index.ts > /tmp/yt-session.log 2>&1 &
SESSION_PID=$!
echo "yt-session-generator started pid=$SESSION_PID"
for i in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:3000/token >/tmp/yt-token.json 2>/dev/null; then echo "yt-session-generator token ready"; break; fi
  if ! kill -0 "$SESSION_PID" 2>/dev/null; then cat /tmp/yt-session.log >&2 || true; exit 1; fi
  if [ $((i % 10)) -eq 0 ]; then echo "yt-session-generator still waiting ($i/90)"; tail -n 40 /tmp/yt-session.log || true; fi
  sleep 2
done
if ! test -s /tmp/yt-token.json; then cat /tmp/yt-session.log >&2 || true; echo "yt-session-generator did not produce a token" >&2; exit 1; fi
cat /tmp/yt-token.json | head -c 200; echo
cd /opt/cobalt
exec pnpm --filter @imput/cobalt-api start
