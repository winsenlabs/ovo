#!/usr/bin/env bash
# OPS-11: an external uptime probe, for a machine other than the call host (the Mac mini through
# launchd or cron, or any Linux box through infra/systemd/ovo-uptime-probe.timer). The primary
# alerting is the GCP Uptime Check (scripts/ops/gcp-monitoring-setup.sh); this is the second
# opinion that also works when the GCP project's alerting is misconfigured.
# Each URL must answer 2xx (and, for /ovo-gateway-health, "ready":true) within the timeout. After
# --failures consecutive failed runs it posts one DOWN alert, and one RECOVERED alert when it passes
# again, to OVO_OPS_ALERT_WEBHOOK_URL (Slack-compatible {"text": …}). Curl only; no Node needed.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/ops/uptime-probe.sh --url URL [--url URL…] [options]

  --state-file PATH   Remembers consecutive failures (default ~/.ovo-uptime-probe.state).
  --failures N        Consecutive failed runs before alerting (default 2).
  --timeout SECS      Per-request timeout (default 10).
  --dry-run           Print the alert instead of posting it.
Environment: OVO_OPS_ALERT_WEBHOOK_URL (required unless --dry-run).
EOF
}

URLS=()
STATE=${HOME:-/tmp}/.ovo-uptime-probe.state
FAILURES=2
TIMEOUT=10
DRY_RUN=false
while (($#)); do
  case $1 in
    --url) URLS+=("$2"); shift 2 ;;
    --state-file) STATE=$2; shift 2 ;;
    --failures) FAILURES=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
((${#URLS[@]})) || { usage >&2; exit 2; }
[[ $DRY_RUN == true || -n ${OVO_OPS_ALERT_WEBHOOK_URL:-} ]] || {
  echo 'OVO_OPS_ALERT_WEBHOOK_URL is not set' >&2
  exit 2
}

problems=()
for url in "${URLS[@]}"; do
  body=$(curl -sS -m "$TIMEOUT" -o - -w '\n%{http_code}' "$url" 2>&1) || body=$'\n'"000 ${body//$'\n'/ }"
  status=${body##*$'\n'}
  if [[ ! $status =~ ^2[0-9][0-9]$ ]]; then
    problems+=("$url answered ${status:-nothing}")
  elif [[ $url == */ovo-gateway-health && $body != *'"ready":true'* ]]; then
    problems+=("$url is up but the gateway is not ready (draining or restarting)")
  fi
done

previous=0
[[ -f $STATE ]] && previous=$(cat "$STATE")
[[ $previous =~ ^[0-9]+$ ]] || previous=0

post() {
  local text=$1 payload
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  payload="{\"text\":\"$text\"}"
  if [[ $DRY_RUN == true ]]; then
    printf 'alert: %s\n' "$payload"
    return 0
  fi
  # The webhook URL is a secret: it goes to curl on stdin, not on the command line.
  printf 'url = "%s"\n' "$OVO_OPS_ALERT_WEBHOOK_URL" |
    curl -fsS -m 10 --retry 2 -o /dev/null -H 'content-type: application/json' --data-binary "$payload" -K - ||
    echo 'alert webhook failed' >&2
}

if ((${#problems[@]})); then
  failures=$((previous + 1))
  echo "$failures" >"$STATE"
  printf 'DOWN (%s consecutive): %s\n' "$failures" "${problems[*]}"
  ((failures == FAILURES)) && post "OVO DOWN: ${problems[*]}"
  exit 1
fi
echo 0 >"$STATE"
((previous >= FAILURES)) && post "OVO RECOVERED after $previous failed checks: ${URLS[*]}"
echo "UP: ${URLS[*]}"
