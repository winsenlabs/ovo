#!/usr/bin/env bash
# OPS-11: GCE shutdown script. A Spot (preemptible) VM gets about 30 s notice, far less than the
# 240 s call drain, so on preemption the only useful move is to stop new calls arriving: point the
# number at the fallback TwiML (`ovo-live.sh off`, which needs no container) before the host dies.
# On an ordinary shutdown or reboot it does nothing unless --always is passed: ovo-compose.service
# stops the stack with the full drain instead. Install it as the instance's `shutdown-script`
# metadata through scripts/ops/gcp-monitoring-setup.sh (which writes a wrapper naming the repo).
set -uo pipefail

REPO=${OVO_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
METADATA=${OVO_GCE_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1}
ALWAYS=false
[[ ${1:-} == --always ]] && ALWAYS=true

preempted=$(curl -fsS -m 3 -H 'Metadata-Flavor: Google' "$METADATA/instance/preempted" 2>/dev/null || echo unknown)
if [[ $preempted != TRUE && $ALWAYS != true ]]; then
  echo "ovo shutdown: not a preemption (preempted=$preempted); leaving the number as it is"
  exit 0
fi
echo 'ovo shutdown: preempted; pointing the number at the fallback'
# Bounded well inside the notice so the host can still flush logs.
bounded=()
command -v timeout >/dev/null 2>&1 && bounded=(timeout 20)
if ${bounded[@]+"${bounded[@]}"} "$REPO/scripts/deploy/ovo-live.sh" off --env-file "$REPO/infra/compose/.env" \
  --ops-env "$REPO/infra/compose/.env.ops"; then
  echo 'ovo shutdown: number switched to the fallback'
else
  echo 'ovo shutdown: could not switch the number; Twilio will use its Voice fallback URL' >&2
fi
