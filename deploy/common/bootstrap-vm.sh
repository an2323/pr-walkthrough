#!/usr/bin/env bash
# VM startup script (cloud-init user-data: runs ONCE, at first boot; written to be re-runnable): Docker + swap.
# Shared by GCP and Oracle — cloud provider only hosts this box.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# unattended-upgrades often holds the dpkg lock right after first boot; wait instead of aborting.
APT=(-o DPkg::Lock::Timeout=300)

if ! command -v docker >/dev/null 2>&1; then
  apt-get "${APT[@]}" update
  apt-get "${APT[@]}" install -y docker.io docker-compose-v2
  # live-restore: a docker.service restart (package upgrade) must not kill a run in flight;
  # log rotation: container logs otherwise grow without bound.
  mkdir -p /etc/docker
  cat >/etc/docker/daemon.json <<'JSON'
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
JSON
  systemctl enable --now docker
fi

# Headroom for peaks (two Excalidraw servers + Chromium + Bob) on an 8–12 GB machine.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show | grep -q /swapfile || swapon /swapfile
# Without an fstab entry the swap is gone after any reboot.
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Keep the disk from filling up with old image layers.
docker image prune -f >/dev/null 2>&1 || true
