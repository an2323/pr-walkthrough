#!/usr/bin/env bash
# $0 checks that must pass before a deploy (deploy.sh enforces it) and so before any paid run:
# build, typecheck, every unit + pipeline-branch test, the web build the image will make.
#
#   pnpm preflight
#
# After a deploy, prove the running site for $0 with a rehearsal (see docs/deploy.md):
#   pnpm --filter @pr-walkthrough/server rehearse --pr excalidraw/excalidraw#10295
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source deploy/common/gates.sh
rm -f .preflight-ok

step() { printf '\n== %s\n' "$1"; }
step "shared build";  pnpm --filter @pr-walkthrough/shared build >/dev/null
step "typecheck";     pnpm lint
step "tests";         pnpm test
step "web build";     pnpm --filter @pr-walkthrough/web build >/dev/null
step "server build";  pnpm --filter @pr-walkthrough/server build >/dev/null

tree_hash > .preflight-ok
printf '\nPREFLIGHT OK — this exact tree may be deployed.\n'
