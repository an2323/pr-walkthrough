#!/usr/bin/env bash
# Sourced by the provider deploy scripts. `up -d --build` recreates the api container, which
# kills a paid analysis in flight (its Bobcoins are spent, its result is lost) — so refuse to
# deploy while /health says one is running. Unreachable site (first deploy) = nothing to protect.
#
#   FORCE=1 deploy/deploy.sh    # deploy anyway
refuse_if_busy() {
  local site health
  site="$(grep -E '^SITE_ADDRESS=' deploy/.env.production 2>/dev/null | cut -d= -f2- || true)"
  [ -n "$site" ] || return 0
  health="$(curl -fsS -m 10 "https://$site/health" 2>/dev/null || true)"
  if printf '%s' "$health" | grep -q '"activeJob":true'; then
    if [ "${FORCE:-0}" = "1" ]; then
      echo "! a paid analysis is running — deploying anyway (FORCE=1)"
      return 0
    fi
    echo "A paid analysis is running (/health says activeJob:true)."
    echo "Deploying now would kill it and lose what it cost. Wait for it to finish, or re-run with FORCE=1."
    return 1
  fi
  return 0
}
