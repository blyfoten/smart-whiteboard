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

# Remote branch (short name, no "origin/" prefix) with the most recent commit.
latest_remote_branch() {
  git for-each-ref refs/remotes/origin \
    --sort=-committerdate \
    --format='%(refname:short)' \
    --exclude=refs/remotes/origin/HEAD \
    | head -n1 \
    | sed 's#^origin/##'
}

switch_to_branch() {
  local branch="$1"
  if [ -n "$(git status --porcelain)" ]; then
    echo "$(date '+%H:%M:%S') — local changes present, not switching to $branch"
    return
  fi
  echo "$(date '+%H:%M:%S') — switching to latest updated branch: $branch"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git checkout --quiet "$branch"
  else
    git checkout --quiet -b "$branch" "origin/$branch"
  fi
  last_update=$(date +%s)
}

echo "Watching for the latest updated branch (currently $(git rev-parse --abbrev-ref HEAD))..."
echo "Polling: ${FAST_INTERVAL}s for ${FAST_DURATION}s after a pull, then ${SLOW_INTERVAL}s"

while true; do
  git fetch origin --quiet 2>/dev/null

  latest_branch=$(latest_remote_branch)
  current_branch=$(git rev-parse --abbrev-ref HEAD)

  if [ -n "$latest_branch" ] && [ "$latest_branch" != "$current_branch" ]; then
    switch_to_branch "$latest_branch"
  fi

  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "@{u}" 2>/dev/null || echo "$LOCAL")

  if [ "$LOCAL" != "$REMOTE" ]; then
    echo "$(date '+%H:%M:%S') — upstream changed, pulling..."
    git pull --ff-only
    last_update=$(date +%s)
  fi

  sleep "$(interval)"
done
