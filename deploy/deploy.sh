#!/usr/bin/env bash
# Deploy the current working tree to the configured cloud VM.
#
#   deploy/deploy.sh
#   DEPLOY_PROVIDER=gcp|oracle deploy/deploy.sh
#
# Never touches Vercel / master. Durable data stays in Supabase.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/deploy/lib.sh"

PROVIDER="$(detect_provider)"
echo "→ provider: $PROVIDER"
exec "$ROOT/deploy/$PROVIDER/deploy.sh" "$@"
