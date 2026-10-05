#!/usr/bin/env bash
# Deploy drain step (OPS-6): wait until no Compose worker holds a call before recreating the
# gateway or workers. A worker's SIGTERM ends its active call, so stop_grace_period alone cannot
# keep a caller connected across a redeploy.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${1:-$ROOT_DIR/infra/compose/.env}
TIMEOUT_SECONDS=${2:-600}
COMPOSE_FILE=$ROOT_DIR/infra/compose/compose.yaml
WORKERS=(worker-1 worker-2)

[[ -f $ENV_FILE ]] || {
  echo "Missing Compose environment: $ENV_FILE" >&2
  exit 2
}

deadline=$((SECONDS + TIMEOUT_SECONDS))
while :; do
  busy=()
  for worker in "${WORKERS[@]}"; do
    state=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$worker" node -e \
      "fetch('http://127.0.0.1:4100/health').then(r=>r.json()).then(s=>console.log(s.state)).catch(()=>console.log('unreachable'))")
    [[ $state == active || $state == reserved ]] && busy+=("$worker:$state")
  done
  if ((${#busy[@]} == 0)); then
    echo 'No worker holds a call; safe to recreate the gateway and workers.'
    exit 0
  fi
  if ((SECONDS >= deadline)); then
    echo "Workers still hold calls after ${TIMEOUT_SECONDS}s: ${busy[*]}" >&2
    exit 1
  fi
  echo "Waiting for calls to finish: ${busy[*]}"
  sleep 5
done
