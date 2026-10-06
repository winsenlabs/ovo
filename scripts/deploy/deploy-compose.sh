#!/usr/bin/env bash
# OPS-8: one-command deploy and redeploy of the Compose stack (ovo-dev). In order:
#   1. preflight: the env file exists, the tree is clean, `compose config` renders;
#   2. git: check out --ref (or fast-forward with --pull);
#   3. bootstrap-compose.sh: adds any variable a new release introduced, never changes one;
#   4. images: pin and pull prebuilt images (--images, from build-images.sh) or build (--build);
#   5. backing services, then the API alone: every service migrates its own schema at startup, so
#      the API reaching healthy means the control, orchestration and telemetry migrations ran;
#   6. dispatcher and console, then each worker and the gateway one at a time: each worker is
#      given up to --drain-timeout to finish its call and its SIGTERM drain covers the rest;
#   7. verify-compose.sh, plus ops/verify-live.sh when the live flags are on;
#   8. records the revision and image pins in infra/compose/.deploy/history for --rollback.
set -euo pipefail
# shellcheck disable=SC2034 # DRY_RUN and DRAIN_TIMEOUT are read by lib.sh
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/deploy/deploy-compose.sh [options]

  --env-file PATH       Compose environment (default infra/compose/.env).
  --ref REF             git fetch, then check out REF (a commit, tag or origin/<branch>).
  --pull                git pull --ff-only on the current branch instead of --ref.
  --images FILE         Pin OVO_*_IMAGE from a build-images.sh file and pull them (recommended).
  --build               Build the images on this host instead (slow; competes with live calls).
  --rollback            Redeploy the previous entry of infra/compose/.deploy/history.
  --drain-timeout SECS  How long each worker restart waits for its call (default 600).
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

DEPLOY_DIR=$(dirname "$ENV_FILE")/.deploy
HISTORY=$DEPLOY_DIR/history
IMAGE_KEYS='OVO_API_IMAGE OVO_CONSOLE_IMAGE OVO_GATEWAY_IMAGE OVO_DISPATCHER_IMAGE OVO_WORKER_IMAGE OVO_TOOLS_IMAGE'
APP_SERVICES=(api console gateway dispatcher worker-1 worker-2)

if [[ $ROLLBACK == true ]]; then
  if [[ ! -f $HISTORY ]] || (($(wc -l <"$HISTORY") < 2)); then
    die 'no previous deploy in the history to roll back to' 2
  fi
  previous=$(tail -n 2 "$HISTORY" | head -n 1)
  REF=$(sed -n 's/.* ref=\([^ ]*\).*/\1/p' <<<"$previous")
  pins=$(sed -n 's/.* images=\([^ ]*\).*/\1/p' <<<"$previous")
  step "rolling back to $REF"
  if [[ $pins == built ]]; then BUILD=true; else IMAGES=$pins; fi
fi

absolute() { printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }

step 'preflight'
require_file "$ENV_FILE" 'Compose environment (run scripts/bootstrap-compose.sh first)'
ENV_FILE=$(absolute "$ENV_FILE")
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

step 'source'
previous_ref=${OVO_DEPLOY_PREVIOUS_REF:-$(git rev-parse HEAD)}
if [[ -n $REF || $PULL == true ]]; then
  if [[ -n $REF ]]; then
    run git fetch --prune origin
    run git checkout --detach "$REF"
  else
    run git pull --ff-only
  fi
  if [[ $DRY_RUN != true ]]; then
    # Continue with the deploy script of the revision just checked out, so its steps apply.
    forward=(--env-file "$ENV_FILE" --drain-timeout "$DRAIN_TIMEOUT")
    [[ -z $IMAGES ]] || forward+=(--images "$IMAGES")
    [[ $BUILD != true ]] || forward+=(--build)
    [[ $SKIP_VERIFY != true ]] || forward+=(--skip-verify)
    [[ $ALLOW_DIRTY != true ]] || forward+=(--allow-dirty)
    OVO_DEPLOY_PREVIOUS_REF=$previous_ref exec bash "$OVO_ROOT/scripts/deploy/deploy-compose.sh" "${forward[@]}"
  fi
fi
revision=$(git rev-parse HEAD)
[[ $DRY_RUN == true && -n $REF ]] && revision=$REF

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

if [[ $SKIP_VERIFY != true ]]; then
  step 'verify'
  run "$OVO_ROOT/scripts/verify-compose.sh" "$ENV_FILE"
  if [[ $(env_value "$ENV_FILE" OVO_INBOUND_ENABLED) == true ]]; then
    run "$OVO_ROOT/scripts/ops/verify-live.sh" --env-file "$ENV_FILE" --skip-base
  fi
fi

step 'record'
stamp=$(date -u +%Y%m%dT%H%M%SZ)
pins=built
if [[ -n $IMAGES ]]; then
  pins=$DEPLOY_DIR/images-$stamp.env
  if [[ $DRY_RUN != true ]]; then
    mkdir -p "$DEPLOY_DIR"
    for key in $IMAGE_KEYS; do
      value=$(env_value "$ENV_FILE" "$key")
      [[ -z $value ]] || printf '%s=%s\n' "$key" "$value"
    done >"$pins"
  fi
fi
if [[ $DRY_RUN == true ]]; then
  say "dry run: would record ref=$revision images=$pins"
else
  mkdir -p "$DEPLOY_DIR"
  printf '%s ref=%s images=%s previous=%s\n' "$stamp" "$revision" "$pins" "$previous_ref" >>"$HISTORY"
  say "deployed $revision"
fi
