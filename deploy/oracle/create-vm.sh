#!/usr/bin/env bash
# Create (or reuse) the analysis VM on Oracle Cloud.
#
#   OCI_COMPARTMENT_ID=ocid1.compartment… deploy/oracle/create-vm.sh
#
# Prefers Always Free Ampere A1 (2 OCPU / 12 GB, ARM). Override with:
#   OCI_SHAPE=VM.Standard.E4.Flex OCI_OCPUS=2 OCI_MEMORY_GB=16
#   (x86 — use if Bob/Chromium misbehave on ARM)
#
# Needs: `oci` CLI configured (`oci setup config`), a public subnet, and an SSH key.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${VM_NAME:-pr-walkthrough}"
COMPARTMENT="${OCI_COMPARTMENT_ID:?set OCI_COMPARTMENT_ID (tenancy or compartment OCID)}"
SHAPE="${OCI_SHAPE:-VM.Standard.A1.Flex}"
OCPUS="${OCI_OCPUS:-2}"
MEMORY_GB="${OCI_MEMORY_GB:-12}"
SSH_KEY="${OCI_SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_rsa.pub}"
AD="${OCI_AD:-}" # optional; default = first AD in the region

[ -f "$SSH_KEY" ] || { echo "missing SSH public key: $SSH_KEY"; exit 1; }

if [ -z "$AD" ]; then
  AD="$(oci iam availability-domain list --compartment-id "$COMPARTMENT" --query 'data[0].name' --raw-output)"
fi

# Prefer an existing public subnet; otherwise require OCI_SUBNET_ID.
SUBNET="${OCI_SUBNET_ID:-}"
if [ -z "$SUBNET" ]; then
  SUBNET="$(oci network subnet list --compartment-id "$COMPARTMENT" --all \
    --query "data[?\"prohibit-public-ip-on-vnic\"==\`false\`] | [0].id" --raw-output 2>/dev/null || true)"
fi
[ -n "$SUBNET" ] && [ "$SUBNET" != "null" ] || {
  echo "No public subnet found. Create a VCN with a public subnet in the console,"
  echo "then: OCI_SUBNET_ID=ocid1.subnet… $0"
  exit 1
}

# Ubuntu 24.04 for the chosen architecture (Ampere = aarch64, else x86_64).
ARCH="x86_64"
case "$SHAPE" in
  *A1*|*A2*) ARCH="aarch64" ;;
esac
IMAGE_ID="$(oci compute image list --compartment-id "$COMPARTMENT" --operating-system "Canonical Ubuntu" \
  --operating-system-version "24.04" --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC \
  --query "data[?contains(\"display-name\", \`$ARCH\`) || contains(\"display-name\", \`Minimal\`)] | [0].id" \
  --raw-output 2>/dev/null || true)"
if [ -z "$IMAGE_ID" ] || [ "$IMAGE_ID" = "null" ]; then
  IMAGE_ID="$(oci compute image list --compartment-id "$COMPARTMENT" --operating-system "Canonical Ubuntu" \
    --operating-system-version "24.04" --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC \
    --query 'data[0].id' --raw-output)"
fi

INSTANCE_ID="$(oci compute instance list --compartment-id "$COMPARTMENT" --display-name "$NAME" --lifecycle-state RUNNING \
  --query 'data[0].id' --raw-output 2>/dev/null || true)"

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "null" ]; then
  echo "→ launching $NAME ($SHAPE ${OCPUS} OCPU / ${MEMORY_GB} GB, $ARCH)"
  SHAPE_CONFIG=()
  case "$SHAPE" in
    *Flex*) SHAPE_CONFIG=(--shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}") ;;
  esac
  INSTANCE_ID="$(oci compute instance launch \
    --compartment-id "$COMPARTMENT" \
    --availability-domain "$AD" \
    --display-name "$NAME" \
    --shape "$SHAPE" \
    "${SHAPE_CONFIG[@]}" \
    --image-id "$IMAGE_ID" \
    --subnet-id "$SUBNET" \
    --assign-public-ip true \
    --boot-volume-size-in-gbs "${OCI_BOOT_GB:-100}" \
    --ssh-authorized-keys-file "$SSH_KEY" \
    --user-data-file "$ROOT/deploy/common/bootstrap-vm.sh" \
    --wait-for-state RUNNING \
    --query 'data.id' --raw-output)"
fi

# Public IP from the primary VNIC.
VNIC="$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" --query 'data[0].id' --raw-output)"
IP="$(oci network vnic get --vnic-id "$VNIC" --query 'data."public-ip"' --raw-output)"

# Open 80/443 if a NSG is attached (best-effort; many free-tier setups use the default security list).
echo
echo "VM:     $NAME"
echo "OCID:   $INSTANCE_ID"
echo "IP:     $IP"
echo "Arch:   $ARCH"
echo "Domain: ${IP//./-}.sslip.io   → put SITE_ADDRESS=${IP//./-}.sslip.io in deploy/.env.production"
echo "SSH:    ssh -i ${SSH_KEY%.pub} ubuntu@$IP"
echo "Next:   wait ~2 min for Docker, then deploy/deploy.sh"
if [ "$ARCH" = "aarch64" ]; then
  echo
  echo "Note: Always Free Ampere is ARM. If Bob or Chromium fail in the image,"
  echo "      recreate with OCI_SHAPE=VM.Standard.E4.Flex OCI_OCPUS=2 OCI_MEMORY_GB=16 (PAYG)."
fi
