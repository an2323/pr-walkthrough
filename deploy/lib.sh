#!/usr/bin/env bash
# Shared helpers for deploy/create-vm.sh and deploy/deploy.sh.
# Runtime (Docker / Supabase) is provider-agnostic; only these wrappers care.

detect_provider() {
  if [ -n "${DEPLOY_PROVIDER:-}" ] && [ "${DEPLOY_PROVIDER}" != "auto" ]; then
    echo "$DEPLOY_PROVIDER"
    return
  fi

  local has_gcp=0 has_oci=0
  if command -v gcloud >/dev/null 2>&1 && gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q .; then
    has_gcp=1
  fi
  if command -v oci >/dev/null 2>&1 && [ -f "${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}" ]; then
    has_oci=1
  fi

  # Explicit project / compartment wins when both CLIs are set up.
  if [ "$has_oci" = 1 ] && [ -n "${OCI_COMPARTMENT_ID:-}" ]; then
    echo oracle
    return
  fi
  if [ "$has_gcp" = 1 ] && [ -n "${GCP_PROJECT:-}" ]; then
    echo gcp
    return
  fi
  if [ "$has_oci" = 1 ]; then
    echo oracle
    return
  fi
  if [ "$has_gcp" = 1 ]; then
    echo gcp
    return
  fi

  echo "No cloud CLI ready. Either:" >&2
  echo "  • GCP:    gcloud auth login && GCP_PROJECT=… deploy/create-vm.sh" >&2
  echo "  • Oracle: oci setup config && OCI_COMPARTMENT_ID=… deploy/create-vm.sh" >&2
  echo "Or set DEPLOY_PROVIDER=gcp|oracle explicitly." >&2
  return 1
}
