#!/usr/bin/env bash
# Ship the CURRENT working tree to the Oracle VM and (re)start the stack.
# Same contract as deploy/gcp/deploy.sh — Supabase holds all durable state.
#
#   deploy/oracle/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

NAME="${VM_NAME:-pr-walkthrough}"
COMPARTMENT="${OCI_COMPARTMENT_ID:?set OCI_COMPARTMENT_ID}"
SSH_KEY="${OCI_SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_rsa.pub}"
SSH_PRIV="${OCI_SSH_KEY_FILE:-${SSH_KEY%.pub}}"

# shellcheck source=../common/busy.sh
source "$ROOT/deploy/common/busy.sh"
source "$ROOT/deploy/common/gates.sh"

[ -f deploy/.env.production ] || { echo "missing deploy/.env.production (see docs/deploy.md)"; exit 1; }
ls deploy/vendor/bobshell-*.tgz >/dev/null 2>&1 || {
  echo "missing deploy/vendor/bobshell-*.tgz — run: npm pack \"\$(npm root -g)/bobshell\" --pack-destination deploy/vendor"
  exit 1
}
[ -f "$SSH_PRIV" ] || { echo "missing SSH private key: $SSH_PRIV"; exit 1; }

refuse_without_preflight || exit 1
refuse_if_busy || exit 1

INSTANCE_ID="$(oci compute instance list --compartment-id "$COMPARTMENT" --display-name "$NAME" --lifecycle-state RUNNING \
  --query 'data[0].id' --raw-output)"
[ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "null" ] || { echo "no RUNNING instance named $NAME"; exit 1; }

VNIC="$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" --query 'data[0].id' --raw-output)"
IP="$(oci network vnic get --vnic-id "$VNIC" --query 'data."public-ip"' --raw-output)"
SSH=(ssh -i "$SSH_PRIV" -o StrictHostKeyChecking=accept-new ubuntu@"$IP")
SCP=(scp -i "$SSH_PRIV" -o StrictHostKeyChecking=accept-new)

echo "→ uploading working tree to $NAME ($IP)"
{
  git ls-files -co --exclude-standard | grep -vE '^(data|demo-vo|bob_sessions|docs/prototypes)/' \
    | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done
  ls deploy/vendor/bobshell-*.tgz
} | tar -czf - -T - \
  | "${SSH[@]}" 'rm -rf ~/app.new && mkdir -p ~/app.new && tar -xzf - -C ~/app.new && rm -rf ~/app && mv ~/app.new ~/app'

"${SCP[@]}" deploy/.env.production "ubuntu@$IP:~/app/deploy/.env"
"${SSH[@]}" 'chmod 600 ~/app/deploy/.env'

echo "→ building and starting containers (first build takes ~10–20 min)"
"${SSH[@]}" 'cd ~/app && sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build && sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps'

# Every deploy leaves the previous image (2–4 GB) and build cache behind; the bootstrap prune only ever ran once.
"${SSH[@]}" 'sudo docker image prune -f >/dev/null 2>&1; sudo docker builder prune -f --filter until=72h >/dev/null 2>&1; df -h / | tail -1'

SITE="$(grep -E '^SITE_ADDRESS=' deploy/.env.production | cut -d= -f2-)"
echo
wait_healthy "$SITE"
echo "→ next, prove it for \$0: pnpm --filter @pr-walkthrough/server rehearse --pr excalidraw/excalidraw#10295"
