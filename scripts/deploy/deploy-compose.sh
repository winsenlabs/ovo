#!/usr/bin/env bash
# OPS-8: one-command deploy and redeploy of the Compose stack (ovo-dev). In order:
#   1. preflight: the env file exists, the tree is clean, `compose config` renders;
#   2. git: check out --ref (or fast-forward with --pull);
#   3. records the revision and image pins in infra/compose/.deploy/history as `status=pending`,
#      before anything changes, so a deploy that fails later is still known to --rollback;
#   4. bootstrap-compose.sh: adds any variable a new release introduced, never changes one;
#   5. images: pin and pull prebuilt images (--images, from build-images.sh) or build (--build);
#   6. backing services, then the API alone: every service migrates its own schema at startup, so
#      the API reaching healthy means the control, orchestration and telemetry migrations ran;
#   7. dispatcher and console, then each worker and the gateway one at a time: each worker is
#      given up to --drain-timeout to finish its call and its SIGTERM drain covers the rest;
#   8. verify-compose.sh, plus ops/verify-live.sh when the live flags are on; the history entry
#      becomes `status=ok` (`unverified` with --skip-verify), or `failed` if any step failed.
# --rollback redeploys the newest ok or unverified entry whose revision and pins differ from the
# last entry (the release now on the host, even when its deploy failed).
set -euo pipefail
# shellcheck disable=SC2034 # DRY_RUN and DRAIN_TIMEOUT are read by lib.sh
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/deploy/deploy-compose.sh [options]

  --env-file PATH       Compose environment (default infra/compose/.env).
  --ref REF             git fetch, then check out REF (a commit, tag or branch; a branch is
                        taken from origin).
  --pull                git pull --ff-only on the current branch instead of --ref.
  --images FILE         Pin OVO_*_IMAGE from a build-images.sh file and pull them (recommended).
  --build               Build the images on this host instead (slow; competes with live calls).
  --rollback            Redeploy the last good release before the current one (see history).
  --drain-timeout SECS  How long each worker restart waits for its call (default 600).
  --ops-env PATH        Host-side OVO_OPS_* file for the verification (default
                        infra/compose/.env.ops).
  --skip-verify         Skip the post-deploy verification.
  --allow-dirty         Deploy a working tree with uncommitted changes.
  --dry-run             Print every mutating command instead of running it.
EOF
}

REF=
PULL=false
IMAGES=
BUILD=false
ROLLBACK=false
DRAIN_TIMEOUT=600
SKIP_VERIFY=false
ALLOW_DIRTY=false
while (($#)); do
  case $1 in
    --env-file) ENV_FILE=$2; shift 2 ;;
    --ops-env) OPS_ENV_FILE=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    --pull) PULL=true; shift ;;
    --images) IMAGES=$2; shift 2 ;;
    --build) BUILD=true; shift ;;
    --rollback) ROLLBACK=true; shift ;;
    --drain-timeout) DRAIN_TIMEOUT=$2; shift 2 ;;
    --skip-verify) SKIP_VERIFY=true; shift ;;
    --allow-dirty) ALLOW_DIRTY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done

absolute() { printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }

# Absolute paths: the history records them, and the deploy changes directory and re-executes.
require_file "$ENV_FILE" 'Compose environment (run scripts/bootstrap-compose.sh first)'
ENV_FILE=$(absolute "$ENV_FILE")
[[ ! -f $OPS_ENV_FILE ]] || OPS_ENV_FILE=$(absolute "$OPS_ENV_FILE")
DEPLOY_DIR=$(dirname "$ENV_FILE")/.deploy
HISTORY=$DEPLOY_DIR/history
IMAGE_KEYS='OVO_API_IMAGE OVO_CONSOLE_IMAGE OVO_GATEWAY_IMAGE OVO_DISPATCHER_IMAGE OVO_WORKER_IMAGE OVO_TOOLS_IMAGE'
APP_SERVICES=(api console gateway dispatcher worker-1 worker-2)

# History lines: STAMP ref=REVISION images=PIN_FILE|built previous=REVISION status=STATUS
history_field() { sed -n "s/.* $1=\([^ ]*\).*/\1/p" <<<"$2"; }

# The release a history line deployed: its revision and image pins (empty when the pins are gone).
release_of() {
  local ref pins
  ref=$(history_field ref "$1")
  pins=$(history_field images "$1")
  if [[ $pins == built ]]; then
    printf '%s built\n' "$ref"
  elif [[ -f $pins ]]; then
    printf '%s %s\n' "$ref" "$(sort "$pins" | tr '\n' ' ')"
  fi
}

if [[ $ROLLBACK == true ]]; then
  [[ -s $HISTORY ]] || die 'no deploy in the history to roll back to' 2
  running=$(release_of "$(tail -n 1 "$HISTORY")")
  target=
  # Newest first; entries from before the status field count as good.
  while IFS= read -r line; do
    case $(history_field status "$line") in ok | unverified | '') ;; *) continue ;; esac
    release=$(release_of "$line")
    if [[ -n $release && $release != "$running" ]]; then
      target=$line
      break
    fi
  done < <(sed -n '1!G;h;$p' "$HISTORY")
  [[ -n $target ]] || die 'no earlier good deploy in the history differs from the current one' 2
  REF=$(history_field ref "$target")
  pins=$(history_field images "$target")
  step "rolling back to $REF (deployed ${target%% *})"
  if [[ $pins == built ]]; then BUILD=true; else IMAGES=$pins; fi
fi

# A branch name resolves to the commit just fetched from origin, not to a stale local branch;
# `git checkout --detach <branch>` with no local branch of that name would also fail.
fetched_ref() {
  if [[ $1 != origin/* ]] && git show-ref --verify --quiet "refs/remotes/origin/$1"; then
    printf 'origin/%s\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}

# The OVO_*_IMAGE pins this deploy runs: --images over the environment's own registry pins.
release_pins() {
  local key value
  for key in $IMAGE_KEYS; do
    value=
    [[ -z $IMAGES ]] || value=$(env_value "$IMAGES" "$key")
    [[ -n $value ]] || value=$(env_value "$ENV_FILE" "$key")
    [[ -z $value || $value == *:local ]] || printf '%s=%s\n' "$key" "$value"
  done
}

mark_history() {
  local tmp=$HISTORY.tmp.$$
  awk -v id="$stamp" -v status="$1" '$1 == id { sub(/ status=[^ ]*$/, " status=" status) } { print }' \
    "$HISTORY" >"$tmp"
  mv "$tmp" "$HISTORY"
}

step 'preflight'
[[ -z $IMAGES ]] || IMAGES=$(absolute "$IMAGES")
cd "$OVO_ROOT"
if [[ $ALLOW_DIRTY != true && -n $(git status --porcelain --untracked-files=no) ]]; then
  die 'the checkout has uncommitted changes; commit or stash them, or pass --allow-dirty' 2
fi
if [[ -n $IMAGES ]]; then
  require_file "$IMAGES" 'image pin file'
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line =~ ^OVO_(API|CONSOLE|GATEWAY|DISPATCHER|WORKER|TOOLS)_IMAGE=[a-z0-9./:_-]+(@sha256:[0-9a-f]{64})?$ ]] ||
      die "unexpected line in $IMAGES: $line" 2
  done <"$IMAGES"
elif [[ $BUILD != true ]]; then
  [[ $(env_value "$ENV_FILE" OVO_API_IMAGE) == *:local || -z $(env_value "$ENV_FILE" OVO_API_IMAGE) ]] &&
    die 'the images are local builds: pass --images FILE from build-images.sh, or --build to build here' 2
fi

if [[ $SKIP_VERIFY != true && $(env_value "$ENV_FILE" OVO_INBOUND_ENABLED) == true ]]; then
  # verify-live.sh runs after the restart; missing console credentials must stop it before.
  load_ops_env
  require_ops_admin
fi

step 'source'
previous_ref=${OVO_DEPLOY_PREVIOUS_REF:-$(git rev-parse HEAD)}
if [[ -n $REF || $PULL == true ]]; then
  if [[ -n $REF ]]; then
    run git fetch --prune origin
    run git checkout --detach "$(fetched_ref "$REF")"
  else
    run git pull --ff-only
  fi
  if [[ $DRY_RUN != true ]]; then
    # Continue with the deploy script of the revision just checked out, so its steps apply.
    forward=(--env-file "$ENV_FILE" --ops-env "$OPS_ENV_FILE" --drain-timeout "$DRAIN_TIMEOUT")
    [[ -z $IMAGES ]] || forward+=(--images "$IMAGES")
    [[ $BUILD != true ]] || forward+=(--build)
    [[ $SKIP_VERIFY != true ]] || forward+=(--skip-verify)
    [[ $ALLOW_DIRTY != true ]] || forward+=(--allow-dirty)
    OVO_DEPLOY_PREVIOUS_REF=$previous_ref exec bash "$OVO_ROOT/scripts/deploy/deploy-compose.sh" "${forward[@]}"
  fi
fi
revision=$(git rev-parse HEAD)
[[ $DRY_RUN == true && -n $REF ]] && revision=$REF

step 'record'
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
pins=built
[[ $BUILD == true ]] || pins=$DEPLOY_DIR/images-$stamp.env
if [[ $DRY_RUN == true ]]; then
  say "dry run: would record ref=$revision images=$pins"
else
  mkdir -p "$DEPLOY_DIR"
  if [[ $pins != built ]]; then
    (
      umask 077
      release_pins >"$pins"
    )
  fi
  printf '%s ref=%s images=%s previous=%s status=pending\n' "$stamp" "$revision" "$pins" \
    "$previous_ref" >>"$HISTORY"
  pending=true
  # Any failure from here on leaves the entry `failed`, so --rollback looks past it.
  trap 'if [[ $pending == true ]]; then mark_history failed; fi' EXIT
fi

step 'environment'
run "$OVO_ROOT/scripts/bootstrap-compose.sh" --env-file "$ENV_FILE"
run compose config --quiet

step 'images'
if [[ -n $IMAGES ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    set_env_value "$ENV_FILE" "${line%%=*}" "${line#*=}"
  done <"$IMAGES"
  run compose pull "${APP_SERVICES[@]}"
elif [[ $BUILD == true ]]; then
  say 'building on this host; prefer scripts/deploy/build-images.sh on the build machine'
  # A build tags the images as named in the environment, so registry pins go back to :local.
  for key in $IMAGE_KEYS; do
    value=$(env_value "$ENV_FILE" "$key")
    local_image=$(tr 'A-Z_' 'a-z-' <<<"${key%_IMAGE}"):local
    [[ -z $value || $value == "$local_image" ]] || set_env_value "$ENV_FILE" "$key" "$local_image"
  done
  run compose build "${APP_SERVICES[@]}"
else
  say 'keeping the image pins already in the Compose environment'
  run compose pull "${APP_SERVICES[@]}"
fi

step 'backing services'
backing=$(backing_services)
# shellcheck disable=SC2086
[[ -z $backing ]] || run compose up -d --wait $backing

step 'API (runs the migrations at startup)'
rolling_recreate api

step 'dispatcher and console'
rolling_recreate dispatcher console

step 'workers and gateway, one at a time with the drain'
rolling_recreate worker-1 worker-2 gateway
run compose up -d --wait --remove-orphans

status=unverified
if [[ $SKIP_VERIFY != true ]]; then
  step 'verify'
  # verify-compose.sh signs in with OVO_OPS_ADMIN_* from the ops file, never the seed password.
  load_ops_env
  run "$OVO_ROOT/scripts/verify-compose.sh" "$ENV_FILE"
  if [[ $(env_value "$ENV_FILE" OVO_INBOUND_ENABLED) == true ]]; then
    run "$OVO_ROOT/scripts/ops/verify-live.sh" --env-file "$ENV_FILE" --ops-env "$OPS_ENV_FILE" --skip-base
  fi
  status=ok
fi

if [[ $DRY_RUN != true ]]; then
  mark_history "$status"
  pending=false
  say "deployed $revision ($status)"
fi
