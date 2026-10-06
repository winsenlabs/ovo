#!/usr/bin/env bash
# OPS-11/12/17: installs the host units for the call VM: ovo-compose.service (start at boot, drain
# at shutdown), the nightly ovo-backup.timer, the journald size cap and the logrotate policy, and
# caches the node image the preemption shutdown script falls back to. With
# --probe-host it instead installs the external uptime probe timer (for a machine OTHER than the
# call VM). Prints what it would do by default; --apply needs root. infra/docker/daemon.json is
# never written over an existing file: merge it by hand (see docs/runbooks/compact-gcp.md).
set -euo pipefail
# shellcheck source=../deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../deploy/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/ops/install-host-units.sh [--repo-dir DIR] [--probe-host HOST] [--apply]

  --repo-dir DIR      The checkout the units run from (default this checkout).
  --probe-host HOST   Install the uptime probe for https://HOST instead of the call-host units.
  --apply             Install and enable (default: print the plan).
Environment: OVO_HOST_ROOT installs under another root (tests).
EOF
}

REPO_DIR=$OVO_ROOT
PROBE_HOST=
APPLY=false
while (($#)); do
  case $1 in
    --repo-dir) REPO_DIR=$2; shift 2 ;;
    --probe-host) PROBE_HOST=$2; shift 2 ;;
    --apply) APPLY=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done
[[ $REPO_DIR == /* ]] || die '--repo-dir must be absolute' 2
[[ $APPLY == true ]] || DRY_RUN=true
ROOT=${OVO_HOST_ROOT:-}
SRC=$OVO_ROOT/infra

install_rendered() {
  local source=$1 target=$ROOT$2 mode=$3
  run mkdir -p "$(dirname "$target")"
  if [[ $DRY_RUN == true ]]; then
    printf '+ install %s -> %s\n' "${source#"$OVO_ROOT"/}" "$target"
    return 0
  fi
  sed -e "s#__OVO_REPO__#$REPO_DIR#g" -e "s#__OVO_PUBLIC_HOST__#$PROBE_HOST#g" "$source" >"$target"
  chmod "$mode" "$target"
}

if [[ -n $PROBE_HOST ]]; then
  [[ $PROBE_HOST =~ ^[a-z0-9.-]+$ ]] || die "invalid host $PROBE_HOST" 2
  install_rendered "$SRC/systemd/ovo-uptime-probe.service" /etc/systemd/system/ovo-uptime-probe.service 644
  install_rendered "$SRC/systemd/ovo-uptime-probe.timer" /etc/systemd/system/ovo-uptime-probe.timer 644
  run systemctl daemon-reload
  run systemctl enable --now ovo-uptime-probe.timer
  say 'put OVO_OPS_ALERT_WEBHOOK_URL=... in /etc/ovo/uptime-probe.env (mode 0600) before the first run'
  exit 0
fi

for unit in ovo-compose.service ovo-backup.service ovo-backup.timer; do
  install_rendered "$SRC/systemd/$unit" "/etc/systemd/system/$unit" 644
done
install_rendered "$SRC/systemd/journald-ovo.conf" /etc/systemd/journald.conf.d/ovo.conf 644
install_rendered "$SRC/logrotate/ovo" /etc/logrotate.d/ovo 644
run systemctl daemon-reload
run systemctl enable ovo-compose.service
run systemctl enable --now ovo-backup.timer
run systemctl restart systemd-journald
# The preemption shutdown script runs ovo-live.sh off with the host's node, or else in this image;
# pulling it inside the 30 s preemption notice would leave the number pointing at a dead VM.
command -v node >/dev/null 2>&1 || run docker pull "$OVO_NODE_IMAGE"
if [[ -f $ROOT/etc/docker/daemon.json ]]; then
  say "keeping the existing $ROOT/etc/docker/daemon.json: merge infra/docker/daemon.json into it by hand"
else
  install_rendered "$SRC/docker/daemon.json" /etc/docker/daemon.json 644
  say 'restart Docker to apply the log limits (drain first: scripts/wait-compose-idle.sh)'
fi
