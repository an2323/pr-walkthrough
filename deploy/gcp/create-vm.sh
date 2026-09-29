#!/usr/bin/env bash
# Create the analysis VM on Google Cloud (run once, from the repo root, after `gcloud auth login`).
#
#   GCP_PROJECT=my-project deploy/gcp/create-vm.sh
#
# e2-standard-2 (2 vCPU, 8 GB) + 60 GB disk ≈ $55/month, paid from the $300 trial credit.
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
ZONE="${GCP_ZONE:-europe-west1-b}"
REGION="${ZONE%-*}"
NAME="${VM_NAME:-pr-walkthrough}"
MACHINE="${VM_MACHINE:-e2-standard-2}"

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable compute.googleapis.com

if ! gcloud compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$NAME-ip" --region "$REGION"
fi
IP="$(gcloud compute addresses describe "$NAME-ip" --region "$REGION" --format='value(address)')"

if ! gcloud compute firewall-rules describe "$NAME-web" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$NAME-web" \
    --allow tcp:80,tcp:443 --target-tags "$NAME-web" --description "HTTP/HTTPS for $NAME"
fi

if ! gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$NAME" \
    --zone "$ZONE" \
    --machine-type "$MACHINE" \
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size 60GB --boot-disk-type pd-balanced \
    --address "$IP" \
    --tags "$NAME-web" \
    --metadata-from-file startup-script=deploy/common/bootstrap-vm.sh
fi

echo
echo "VM:     $NAME ($ZONE)"
echo "IP:     $IP"
echo "Domain: ${IP//./-}.sslip.io   → put SITE_ADDRESS=${IP//./-}.sslip.io in deploy/.env.production"
echo "Next:   wait ~2 min for Docker to install, then deploy/deploy.sh"
