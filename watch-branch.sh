#!/usr/bin/env bash
set -e

FAST_INTERVAL=5
SLOW_INTERVAL=30
FAST_DURATION=600  # 10 minutes in seconds

last_update=0

interval() {
  local now
  now=$(date +%s)
  if (( now - last_update < FAST_DURATION )); then
    echo $FAST_INTERVAL
  else
    echo $SLOW_INTERVAL
  fi
}

echo "Watching branch $(git rev-parse --abbrev-ref HEAD)..."
echo "Polling: ${FAST_INTERVAL}s for ${FAST_DURATION}s after a pull, then ${SLOW_INTERVAL}s"

while true; do
  git fetch origin --quiet 2>/dev/null

  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "@{u}" 2>/dev/null || echo "$LOCAL")

  if [ "$LOCAL" != "$REMOTE" ]; then
    echo "$(date '+%H:%M:%S') — upstream changed, pulling..."
    git pull --ff-only
    last_update=$(date +%s)
  fi

  sleep "$(interval)"
done
