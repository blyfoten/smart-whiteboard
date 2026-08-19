#!/usr/bin/env bash
#
# Follow the most recently updated remote branch and keep the checkout on it.
#
# NOTE: deliberately NOT `set -e`. Every git call here can fail for ordinary,
# recoverable reasons — a diverged branch that cannot be fast-forwarded, a dirty
# tree, a network blip — and an exiting watcher freezes the deployment on old
# code silently. That has happened: a debug session committed locally on a branch
# whose remote was still at its base, `git pull --ff-only` refused, the script
# exited, and the box served a stale bundle for hours while the repository had
# the fix. Log and carry on instead.
set -uo pipefail

FAST_INTERVAL=5
SLOW_INTERVAL=30
FAST_DURATION=600  # 10 minutes in seconds

# debug/sessions.js writes this file (branch name as contents) for as long as a
# debug session's coding agent owns the shared working directory — from before
# it re-checks-out its branch through the end of its turn. Touching the
# checkout during that window is exactly what stranded a fix commit on the
# wrong branch once already: the watcher switched HEAD to what it thought was
# the "latest" branch mid-session, and the agent's next commit landed there
# instead of on its own branch. Stand off entirely while the lock is present.
LOCK_FILE=".debug-sessions/.workspace-lock"

last_update=0
last_warning=""

log() { echo "$(date '+%H:%M:%S') — $*"; }

# Repeat a warning only when the situation changes, so a stuck state does not
# fill the log every 5 seconds.
warn_once() {
  local key="$1"; shift
  if [ "$last_warning" != "$key" ]; then
    log "$@"
    last_warning="$key"
  fi
}

clear_warning() { last_warning=""; }

interval() {
  local now
  now=$(date +%s)
  if (( now - last_update < FAST_DURATION )); then
    echo $FAST_INTERVAL
  else
    echo $SLOW_INTERVAL
  fi
}

is_clean() { [ -z "$(git status --porcelain)" ]; }

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
  if ! is_clean; then
    warn_once "dirty-$branch" "local changes present, not switching to $branch"
    return
  fi
  log "switching to latest updated branch: $branch"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git checkout --quiet "$branch" || { warn_once "co-$branch" "could not check out $branch"; return; }
  else
    git checkout --quiet -b "$branch" "origin/$branch" || { warn_once "co-$branch" "could not create $branch"; return; }
  fi
  last_update=$(date +%s)
  clear_warning
}

# Bring the current branch up to date. Returns without dying on any failure.
update_current() {
  local current="$1" latest="$2"

  if ! git rev-parse '@{u}' >/dev/null 2>&1; then
    warn_once "noupstream-$current" "$current has no upstream — nothing to pull"
    return
  fi

  # stderr is muted: the interesting failure (a diverged branch) prints a long
  # git hint block every poll, and we report that case ourselves below.
  if git pull --ff-only --quiet 2>/dev/null; then
    log "pulled $current"
    last_update=$(date +%s)
    clear_warning
    return
  fi

  # Fast-forward refused. Either the tree is dirty or the branch has diverged.
  if ! is_clean; then
    warn_once "dirty-pull-$current" "cannot pull $current — uncommitted changes in the tree"
    return
  fi

  local ahead
  ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  if [ "$ahead" = "0" ]; then
    warn_once "pullfail-$current" "could not pull $current — will retry"
    return
  fi

  # There are local commits the remote does not have. If they already exist on
  # the branch we are being asked to follow, they are not lost and we can safely
  # move on; otherwise leave them alone — unpushed work is not ours to discard.
  if [ -n "$latest" ] && git merge-base --is-ancestor HEAD "origin/$latest" 2>/dev/null; then
    log "$current has $ahead local commit(s), already contained in origin/$latest — following that instead"
    git checkout --quiet -B "$latest" "origin/$latest" && last_update=$(date +%s) && clear_warning
    return
  fi

  warn_once "diverged-$current" \
    "$current has diverged from its remote ($ahead unpushed commit(s)) — not touching it. Push or reset it by hand; still watching for a newer branch."
}

echo "Watching for the latest updated branch (currently $(git rev-parse --abbrev-ref HEAD))..."
echo "Polling: ${FAST_INTERVAL}s for ${FAST_DURATION}s after a pull, then ${SLOW_INTERVAL}s"

while true; do
  if [ -f "$LOCK_FILE" ]; then
    warn_once "locked" "debug session working on $(cat "$LOCK_FILE" 2>/dev/null || echo '?') — deploy loop paused"
    sleep "$FAST_INTERVAL"
    continue
  fi

  git fetch origin --quiet 2>/dev/null

  latest_branch=$(latest_remote_branch)
  current_branch=$(git rev-parse --abbrev-ref HEAD)

  if [ -n "$latest_branch" ] && [ "$latest_branch" != "$current_branch" ]; then
    switch_to_branch "$latest_branch"
    current_branch=$(git rev-parse --abbrev-ref HEAD)
  fi

  LOCAL=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  REMOTE=$(git rev-parse '@{u}' 2>/dev/null || echo "$LOCAL")

  if [ "$LOCAL" != "$REMOTE" ]; then
    update_current "$current_branch" "$latest_branch"
  fi

  sleep "$(interval)"
done
