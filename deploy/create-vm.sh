#!/usr/bin/env bash
# Create the analysis VM on whichever cloud is configured.
#
#   deploy/create-vm.sh                 # auto: Oracle if OCI_COMPARTMENT_ID / oci, else GCP
#   DEPLOY_PROVIDER=gcp GCP_PROJECT=… deploy/create-vm.sh
#   DEPLOY_PROVIDER=oracle OCI_COMPARTMENT_ID=… deploy/create-vm.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/deploy/lib.sh"

PROVIDER="$(detect_provider)"
echo "→ provider: $PROVIDER"
exec "$ROOT/deploy/$PROVIDER/create-vm.sh" "$@"
