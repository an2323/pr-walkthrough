#!/usr/bin/env bash
# Sourced by deploy/preflight.sh and the provider deploy scripts.
#
# The rule: nothing reaches the VM (and so nothing can be paid for) unless `pnpm preflight` passed
# on EXACTLY the tree being shipped. preflight.sh writes the tree's hash to .preflight-ok; deploy
# refuses when the hash differs (an edit after the checks). SKIP_PREFLIGHT=1 overrides.

# Content hash of what deploy.sh ships (tracked + untracked, non-ignored files) — the same before
# and after a commit, so "preflight, then commit, then deploy" doesn't invalidate the stamp.
tree_hash() {
  local idx
  idx="$(mktemp)"
  cp "$(git rev-parse --git-dir)/index" "$idx"
  GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git write-tree
  rm -f "$idx"
}

refuse_without_preflight() {
  if [ "${SKIP_PREFLIGHT:-0}" = "1" ]; then
    echo "! deploying without preflight (SKIP_PREFLIGHT=1)"
    return 0
  fi
  local want have
  want="$(tree_hash)"
  have="$(cat .preflight-ok 2>/dev/null || true)"
  if [ "$want" != "$have" ]; then
    echo "Preflight has not passed on this exact tree (changed since, or never run)."
    echo "Run: pnpm preflight   — then deploy again. (SKIP_PREFLIGHT=1 to override.)"
    return 1
  fi
  echo "→ preflight passed on this tree"
}

# After `docker compose up -d`: wait until /health answers ok with the database and storage up.
wait_healthy() {
  local site="$1" i health
  for i in $(seq 1 60); do
    health="$(curl -fsS -m 5 "https://$site/health" 2>/dev/null || true)"
    if printf '%s' "$health" | grep -q '"ok":true' && printf '%s' "$health" | grep -q '"database":true'; then
      echo "→ healthy: $health"
      return 0
    fi
    sleep 5
  done
  echo "Site did not become healthy in 5 min. Last /health: ${health:-<no answer>}"
  return 1
}
