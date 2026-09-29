#!/usr/bin/env bash
# Ship the CURRENT working tree (not a git branch) to the VM and (re)start the stack.
# Nothing is pushed to GitHub and the Vercel demo is not touched.
#
#   deploy/gcp/deploy.sh
#
# Needs deploy/.env.production (gitignored) and deploy/vendor/bobshell-*.tgz.
set -euo pipefail

ZONE="${GCP_ZONE:-europe-west1-b}"
NAME="${VM_NAME:-pr-walkthrough}"

# shellcheck source=../common/busy.sh
source "$(cd "$(dirname "$0")/.." && pwd)/common/busy.sh"

[ -f deploy/.env.production ] || { echo "missing deploy/.env.production (see docs/deploy.md)"; exit 1; }
ls deploy/vendor/bobshell-*.tgz >/dev/null 2>&1 || {
  echo "missing deploy/vendor/bobshell-*.tgz — run: npm pack \"\$(npm root -g)/bobshell\" --pack-destination deploy/vendor"
  exit 1
}

refuse_if_busy || exit 1

echo "→ uploading working tree to $NAME"
{
  git ls-files -co --exclude-standard | grep -vE '^(data|demo-vo|bob_sessions|docs/prototypes)/' \
    | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done
  ls deploy/vendor/bobshell-*.tgz
} | tar -czf - -T - \
  | gcloud compute ssh "$NAME" --zone "$ZONE" --command \
      'rm -rf ~/app.new && mkdir -p ~/app.new && tar -xzf - -C ~/app.new && rm -rf ~/app && mv ~/app.new ~/app'

gcloud compute scp deploy/.env.production "$NAME:~/app/deploy/.env" --zone "$ZONE"

echo "→ building and starting containers (first build takes ~10 min)"
gcloud compute ssh "$NAME" --zone "$ZONE" --command \
  'cd ~/app && sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build && sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps'

SITE="$(grep -E '^SITE_ADDRESS=' deploy/.env.production | cut -d= -f2-)"
echo
echo "→ https://$SITE/health"
