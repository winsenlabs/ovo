#!/usr/bin/env bash
# OPS-8: switch inbound calls between this stack and the fallback TwiML.
#   on      turn the live flags on (draining workers as they restart), run the live checks, then
#           point the number's Voice URL and status callback at the console's carrier URLs and its
#           Voice fallback URL at OVO_OPS_FALLBACK_URL; finally re-verify against the carrier.
#   off     point the number's Voice URL at the fallback TwiML. Immediate and container-free, so the
#           preemption shutdown script can run it. --flags also sets OVO_INBOUND_ENABLED=false and
#           restarts the affected services with the drain.
#   status  show where the number points and the live flags in the Compose environment.
# Carrier credentials come from infra/compose/.env.ops (OVO_OPS_TWILIO_*), never from a flag.
# shellcheck disable=SC2034 # ENV_FILE, OPS_ENV_FILE, DRY_RUN and DRAIN_TIMEOUT are read by lib.sh
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/deploy/ovo-live.sh on|off|status [options]

  --env-file PATH       Compose environment (default infra/compose/.env).
  --ops-env PATH        Host-side OVO_OPS_* file (default infra/compose/.env.ops).
  --flags               off only: also set OVO_INBOUND_ENABLED=false and restart with the drain.
  --skip-verify         on only: switch the number without the live checks (not recommended).
  --drain-timeout SECS  How long a restart waits for a worker's call to end (default 600).
  --dry-run             Print what would change; change nothing.
EOF
}

COMMAND=${1:-}
[[ $COMMAND == on || $COMMAND == off || $COMMAND == status ]] || {
  usage >&2
  exit 2
}
shift
FLAGS=false
SKIP_VERIFY=false
DRAIN_TIMEOUT=600
while (($#)); do
  case $1 in
    --env-file) ENV_FILE=$2; shift 2 ;;
    --ops-env) OPS_ENV_FILE=$2; shift 2 ;;
    --flags) FLAGS=true; shift ;;
    --skip-verify) SKIP_VERIFY=true; shift ;;
    --drain-timeout) DRAIN_TIMEOUT=$2; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done

load_ops_env
for name in OVO_OPS_TWILIO_ACCOUNT_SID OVO_OPS_TWILIO_API_KEY_SID OVO_OPS_TWILIO_API_KEY_SECRET \
  OVO_OPS_TWILIO_NUMBER OVO_OPS_FALLBACK_URL; do
  [[ -n ${!name:-} ]] || die "$name is not set (see docs/env-reference.md, infra/compose/.env.ops)" 2
done
[[ $OVO_OPS_FALLBACK_URL == https://* ]] || die 'OVO_OPS_FALLBACK_URL must be an https URL' 2

ops_input() {
  printf '{"command":"%s","dryRun":%s,"ops":%s,"endpoints":%s}' "$1" "$DRY_RUN" "$(ops_json)" \
    "${OVO_OPS_ENDPOINTS:-null}"
}

# The values `on` needs in the Compose environment; the workers stay dial-disabled without
# OVO_LIVE_DIAL_ENABLED, and a public API must not allow plain HTTP.
LIVE_SETTINGS='OVO_LIVE_DIAL_ENABLED=true OVO_INBOUND_ENABLED=true OVO_TRANSPORT_CERTIFIED=true OVO_ALLOW_LOCAL_HTTP=false'

# Applies NAME=value pairs to the Compose environment; prints the names that changed.
apply_settings() {
  local pair name value
  for pair in "$@"; do
    name=${pair%%=*}
    value=${pair#*=}
    if [[ $(env_value "$ENV_FILE" "$name") != "$value" ]]; then
      set_env_value "$ENV_FILE" "$name" "$value"
      printf '%s\n' "$name"
    fi
  done
}

restart_live_services() {
  step 'restarting the services whose live flags changed (each worker drains first)'
  rolling_recreate api dispatcher worker-1 worker-2 gateway
}

case $COMMAND in
  status)
    run_ops_program host "$(ops_input live-status)"
    require_file "$ENV_FILE" 'Compose environment'
    for name in OVO_LIVE_DIAL_ENABLED OVO_INBOUND_ENABLED OVO_TRANSPORT_CERTIFIED OVO_ALLOW_LOCAL_HTTP; do
      say "  $name=$(env_value "$ENV_FILE" "$name")"
    done
    ;;
  off)
    step "pointing $OVO_OPS_TWILIO_NUMBER at the fallback"
    run_ops_program host "$(ops_input live-off)"
    if [[ $FLAGS == true ]]; then
      require_file "$ENV_FILE" 'Compose environment'
      changed=$(apply_settings OVO_INBOUND_ENABLED=false)
      [[ -z $changed ]] || restart_live_services
    fi
    ;;
  on)
    require_file "$ENV_FILE" 'Compose environment'
    require_ops_admin
    base_url=$(env_value "$ENV_FILE" OVO_MEDIA_PUBLIC_BASE_URL)
    [[ $base_url == https://* && $base_url != *.invalid* ]] ||
      die 'OVO_MEDIA_PUBLIC_BASE_URL is not a public https origin; run bootstrap-compose.sh --public-host first' 2
    step 'live flags'
    # shellcheck disable=SC2086
    changed=$(apply_settings $LIVE_SETTINGS)
    if [[ -n $changed ]]; then
      say "changed: $(tr '\n' ' ' <<<"$changed")"
      restart_live_services
    else
      say 'already on in the Compose environment'
    fi
    if [[ $SKIP_VERIFY != true && $DRY_RUN != true ]]; then
      step 'live checks before switching the number'
      "$OVO_ROOT/scripts/ops/verify-live.sh" --env-file "$ENV_FILE" --ops-env "$OPS_ENV_FILE" --pre-switch ||
        die 'live checks failed; the number was not switched'
    fi
    step "pointing $OVO_OPS_TWILIO_NUMBER at this stack"
    run_ops_program stack "$(ops_input live-on)"
    if [[ $SKIP_VERIFY != true && $DRY_RUN != true ]]; then
      step 'live checks against the carrier'
      "$OVO_ROOT/scripts/ops/verify-live.sh" --env-file "$ENV_FILE" --ops-env "$OPS_ENV_FILE" --skip-base
    fi
    ;;
esac
