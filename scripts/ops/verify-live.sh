#!/usr/bin/env bash
# OPS-7: one command that answers "will the number answer?". It runs scripts/verify-compose.sh
# (health, sign-in, no env carrier binding), then checks the running containers' live flags,
# OVO_ALLOW_LOCAL_HTTP=false inside the API, the public TLS origin and its WSS upgrade path, ready
# workers, protected inbound capacity, enabled routes whose releases are live-ready, and that the
# carrier number's Voice and status URLs are the console's /carrier-urls for its binding.
# Read-only: it never changes the stack or the number.
# shellcheck disable=SC2034 # ENV_FILE, OPS_ENV_FILE, DRY_RUN and DRAIN_TIMEOUT are read by lib.sh
set -euo pipefail
# shellcheck source=../deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../deploy/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/ops/verify-live.sh [ENV_FILE] [options]

  --env-file PATH        Compose environment (default infra/compose/.env).
  --ops-env PATH         Host-side OVO_OPS_* file (default infra/compose/.env.ops).
  --pre-switch           Skip the carrier-number check (used by ovo-live.sh before switching).
  --skip-base            Skip scripts/verify-compose.sh.
  --save-snapshot PATH   Also write the collected snapshot as JSON (carrier URL tokens redacted).
  --snapshot PATH        Dry run: evaluate a saved snapshot offline; touches nothing.
EOF
}

MODE=full
SKIP_BASE=false
SNAPSHOT=
SAVE_SNAPSHOT=
while (($#)); do
  case $1 in
    --env-file) ENV_FILE=$2; shift 2 ;;
    --ops-env) OPS_ENV_FILE=$2; shift 2 ;;
    --pre-switch) MODE=pre-switch; shift ;;
    --skip-base) SKIP_BASE=true; shift ;;
    --save-snapshot) SAVE_SNAPSHOT=$2; shift 2 ;;
    --snapshot) SNAPSHOT=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option $1" 2 ;;
    *) ENV_FILE=$1; shift ;;
  esac
done

if [[ -n $SNAPSHOT ]]; then
  require_file "$SNAPSHOT" snapshot
  run_ops_program host "{\"command\":\"evaluate\",\"snapshot\":$(cat "$SNAPSHOT")}"
  exit
fi

require_file "$ENV_FILE" 'Compose environment'
load_ops_env
require_ops_admin

if [[ $SKIP_BASE != true ]]; then
  step 'base Compose checks'
  "$OVO_ROOT/scripts/verify-compose.sh" "$ENV_FILE"
fi

step 'live checks'
FLAG_NAMES='OVO_ALLOW_LOCAL_HTTP OVO_MEDIA_PUBLIC_BASE_URL OVO_LIVE_DIAL_ENABLED OVO_INBOUND_ENABLED OVO_INBOUND_CAPACITY_ENABLED OVO_TRANSPORT_CERTIFIED'
service_env=
for service in api gateway dispatcher "${WORKERS[@]}"; do
  # Only these non-secret flags leave the containers; an unreachable service reports nothing.
  # shellcheck disable=SC2016,SC2086
  values=$(compose exec -T "$service" sh -c 'for n do printf "%s=%s\n" "$n" "$(printenv "$n")"; done' \
    sh $FLAG_NAMES 2>/dev/null) || values=
  service_env="${service_env:+$service_env,}$(json_string "$service"):$(json_string "$values")"
done

input="{\"command\":\"verify-live\",\"mode\":\"$MODE\",\"ops\":$(ops_json),\"serviceEnv\":{$service_env}"
input+=",\"endpoints\":${OVO_OPS_ENDPOINTS:-null},\"emitSnapshot\":$([[ -n $SAVE_SNAPSHOT ]] && echo true || echo false)}"

status=0
output=$(run_ops_program stack "$input") || status=$?
printf '%s\n' "$output" | grep -v '^OVO_SNAPSHOT ' || true
if [[ -n $SAVE_SNAPSHOT ]]; then
  printf '%s\n' "$output" | sed -n 's/^OVO_SNAPSHOT //p' >"$SAVE_SNAPSHOT"
fi
exit "$status"
