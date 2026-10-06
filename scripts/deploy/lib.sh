# Shared helpers for scripts/deploy, scripts/ops and scripts/backup. Sourced, never executed.
# Bash 3.2 compatible (macOS runs the tests); every script runs on the Debian call host too.
# shellcheck shell=bash

OVO_ROOT=${OVO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-$OVO_ROOT/infra/compose/compose.yaml}
ENV_FILE=${ENV_FILE:-$OVO_ROOT/infra/compose/.env}
OPS_ENV_FILE=${OPS_ENV_FILE:-$OVO_ROOT/infra/compose/.env.ops}
DRY_RUN=${DRY_RUN:-false}
OVO_NODE_IMAGE=${OVO_NODE_IMAGE:-node:24.8.0-bookworm-slim}
WORKERS=(worker-1 worker-2)

say() { printf '%s\n' "$*" >&2; }
step() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit "${2:-1}"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# Runs a mutating command, or only prints it under --dry-run.
run() {
  if [[ $DRY_RUN == true ]]; then
    printf '+ %s\n' "$*"
    return 0
  fi
  "$@"
}

require_file() {
  [[ -f $1 ]] || die "missing $2: $1" 2
}

# The last KEY=VALUE for KEY in a dotenv file (empty when absent). Files are parsed, never sourced.
env_value() {
  local file=$1 key=$2
  [[ -f $file ]] || return 0
  sed -n "s/^$key=//p" "$file" | tail -n 1
}

# Replaces every KEY= line (or appends one) atomically, keeping the file mode 0600.
set_env_value() {
  local file=$1 key=$2 value=$3
  [[ $value != *$'\n'* ]] || die "$key must be a single line"
  if [[ $DRY_RUN == true ]]; then
    printf '+ set %s in %s\n' "$key" "$file" >&2
    return 0
  fi
  local tmp="$file.tmp.$$"
  (
    umask 077
    { grep -v "^$key=" "$file" || true; } >"$tmp"
  )
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# Exports the OVO_OPS_* lines of the ops env file into this shell. Other keys are ignored.
load_ops_env() {
  local file=${1:-$OPS_ENV_FILE} line key
  [[ -f $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^(OVO_OPS_[A-Z0-9_]+)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    # The calling environment wins, so a one-off override needs no file edit.
    [[ -n ${!key:-} ]] || export "$key=${BASH_REMATCH[2]}"
  done <"$file"
}

# The live checks and `ovo-live.sh on` read the console as a dedicated account: since OPS-15 the
# bootstrap seed password only reaches the password-change routes.
require_ops_admin() {
  local name
  for name in OVO_OPS_ADMIN_EMAIL OVO_OPS_ADMIN_PASSWORD; do
    [[ -n ${!name:-} ]] ||
      die "$name is not set in $OPS_ENV_FILE: a console administrator other than the seed account (docs/env-reference.md)" 2
  done
}

json_string() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '"%s"' "$value"
}

# A JSON object of every set OVO_OPS_* variable.
ops_json() {
  local name first=true
  printf '{'
  for name in $(compgen -v OVO_OPS_ || true); do
    $first || printf ','
    first=false
    printf '%s:%s' "$(json_string "$name")" "$(json_string "${!name}")"
  done
  printf '}'
}

# The ops program is the concatenation of import-free modules (only ops-client.mjs imports
# node: builtins), so it runs from stdin inside the API container, where the console, dispatcher
# and workers resolve by service name, without mounting the repository.
ops_program() {
  local input=$1 dir=$OVO_ROOT/scripts/ops
  printf 'globalThis.ovoOpsInput = %s;\n' "$input"
  cat "$dir/ops-client.mjs" "$dir/live-collect.mjs" "$dir/live-checks.mjs" "$dir/live-switch.mjs" \
    "$dir/ops-main.mjs"
}

# run_ops_program stack|host INPUT_JSON: secrets travel on stdin, never on a command line.
run_ops_program() {
  local where=$1 input=$2
  if [[ $where == stack ]]; then
    ops_program "$input" | compose exec -T api node --input-type=module -
  elif command -v node >/dev/null 2>&1; then
    ops_program "$input" | node --input-type=module -
  else
    ops_program "$input" | docker run --rm -i --network host "$OVO_NODE_IMAGE" \
      node --input-type=module -
  fi
}

# The state a worker's /health reports: ready, active, reserved, dial-disabled, ... or unreachable.
worker_state() {
  compose exec -T "$1" node -e \
    "fetch('http://127.0.0.1:4100/health').then(r=>r.json()).then(s=>console.log(s.state)).catch(()=>console.log('unreachable'))" \
    2>/dev/null || echo unreachable
}

# Waits until none of the named workers holds a call, or the timeout passes (returns 1).
wait_workers_idle() {
  local timeout=$1 deadline busy worker state
  shift
  deadline=$((SECONDS + timeout))
  while :; do
    busy=()
    for worker in "$@"; do
      state=$(worker_state "$worker")
      if [[ $state == active || $state == reserved ]]; then busy+=("$worker:$state"); fi
    done
    ((${#busy[@]} == 0)) && return 0
    if ((SECONDS >= deadline)); then
      say "still busy after ${timeout}s: ${busy[*]}"
      return 1
    fi
    say "waiting for calls to finish: ${busy[*]}"
    sleep "${OVO_OPS_POLL_SECONDS:-5}"
  done
}

# Recreates services one at a time, in the order given. Compose recreates a service only when its
# image or configuration changed. A worker is first given up to DRAIN_TIMEOUT seconds to finish its
# call, and the gateway (which carries every call's media) waits for all workers; past the timeout
# the SIGTERM drain inside stop_grace_period still lets a call finish for up to 240s.
rolling_recreate() {
  local service
  for service in "$@"; do
    if [[ $DRY_RUN != true ]]; then
      case $service in
        worker-*) wait_workers_idle "${DRAIN_TIMEOUT:-600}" "$service" ||
          say "recreating $service anyway; its SIGTERM drain covers the active call" ;;
        gateway) wait_workers_idle "${DRAIN_TIMEOUT:-600}" "${WORKERS[@]}" ||
          say 'recreating the gateway anyway; it drains live media for up to 240s' ;;
      esac
    fi
    run compose up -d --no-deps --wait "$service"
  done
}

# The services a profile list starts, in dependency order.
backing_services() {
  local profiles
  profiles=$(env_value "$ENV_FILE" COMPOSE_PROFILES)
  [[ ,$profiles, == *,local-postgres,* ]] && printf 'postgres\n'
  [[ ,$profiles, == *,local-queue,* ]] && printf 'queue\n'
  return 0
}
