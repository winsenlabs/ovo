#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT_DIR/infra/compose/.env"
PROMPT_ADMIN=false
MANAGED_POSTGRES=false
MANAGED_SQS=false

usage() {
  cat <<'EOF'
Usage: ./scripts/bootstrap-compose.sh [options]

Creates an idempotent, mode-0600 Compose environment without printing secrets.

Options:
  --env-file PATH       Write a different ignored Compose env file.
  --prompt-admin        Prompt for the first administrator email/password.
  --managed-postgres    Use OVO_BOOTSTRAP_DATABASE_URL instead of local PostgreSQL.
  --managed-sqs         Use OVO_BOOTSTRAP_QUEUE_URL instead of local ElasticMQ.
  -h, --help            Show this help.

Managed service inputs are read from environment variables so credentials do not
appear in command arguments. Database URL credentials must be percent-encoded.
EOF
}

while (($#)); do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || { echo '--env-file requires a path' >&2; exit 2; }
      ENV_FILE=$2
      shift 2
      ;;
    --prompt-admin)
      PROMPT_ADMIN=true
      shift
      ;;
    --managed-postgres)
      MANAGED_POSTGRES=true
      shift
      ;;
    --managed-sqs)
      MANAGED_SQS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v openssl >/dev/null || {
  echo 'openssl is required to generate installation secrets' >&2
  exit 1
}

if $MANAGED_POSTGRES && [[ -z ${OVO_BOOTSTRAP_DATABASE_URL:-} ]]; then
  echo 'OVO_BOOTSTRAP_DATABASE_URL is required with --managed-postgres' >&2
  exit 2
fi
if $MANAGED_SQS && [[ -z ${OVO_BOOTSTRAP_QUEUE_URL:-} ]]; then
  echo 'OVO_BOOTSTRAP_QUEUE_URL is required with --managed-sqs' >&2
  exit 2
fi

mkdir -p "$(dirname "$ENV_FILE")"
LOCK_DIR="${ENV_FILE}.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another bootstrap process is using $ENV_FILE" >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR"' EXIT

umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

has_key() {
  grep -q "^$1=" "$ENV_FILE"
}

value_for() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

append() {
  local key=$1 value=$2
  has_key "$key" || printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
}

random_hex() {
  openssl rand -hex "$1"
}

single_line() {
  local name=$1 value=$2
  [[ -n $value && $value != *$'\n'* && $value != *$'\r'* ]] || {
    echo "$name must be a non-empty single-line value" >&2
    exit 2
  }
}

dotenv_url() {
  local name=$1 value=$2
  single_line "$name" "$value"
  if [[ $value == *'$'* || $value == *'#'* || $value == *'"'* || $value == *"'"* || $value == *'\'* || $value == *[[:space:]]* ]]; then
    echo "$name contains characters that must be percent-encoded for the dotenv file" >&2
    exit 2
  fi
}

admin_email=${OVO_SEED_ADMIN_EMAIL:-}
admin_password=${OVO_SEED_ADMIN_PASSWORD:-}
if $PROMPT_ADMIN && ! has_key OVO_SEED_ADMIN_EMAIL; then
  [[ -t 0 ]] || { echo '--prompt-admin requires an interactive terminal' >&2; exit 2; }
  read -r -p 'First administrator email: ' admin_email
  read -r -s -p 'First administrator password: ' admin_password
  printf '\n' >&2
fi
admin_email=${admin_email:-admin@ovo.local}
admin_password=${admin_password:-$(random_hex 24)}
single_line OVO_SEED_ADMIN_EMAIL "$admin_email"
single_line OVO_SEED_ADMIN_PASSWORD "$admin_password"
[[ $admin_email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
  echo 'OVO_SEED_ADMIN_EMAIL must be a valid email address' >&2
  exit 2
}
[[ ${#admin_password} -ge 12 && ${#admin_password} -le 128 ]] || {
  echo 'OVO_SEED_ADMIN_PASSWORD must contain 12 to 128 characters' >&2
  exit 2
}
[[ $admin_password =~ ^[A-Za-z0-9!@%_+=:,.~-]+$ ]] || {
  echo 'OVO_SEED_ADMIN_PASSWORD contains unsupported dotenv characters' >&2
  exit 2
}

postgres_password=$(value_for POSTGRES_PASSWORD)
postgres_password=${postgres_password:-$(random_hex 24)}
database_url=${OVO_BOOTSTRAP_DATABASE_URL:-postgresql://ovo:${postgres_password}@postgres:5432/ovo}
dotenv_url DATABASE_URL "$database_url"

profiles=()
$MANAGED_POSTGRES || profiles+=(local-postgres)
$MANAGED_SQS || profiles+=(local-queue)
compose_profiles=$(IFS=,; echo "${profiles[*]}")

queue_url=${OVO_BOOTSTRAP_QUEUE_URL:-http://queue:9324/000000000000/ovo-jobs}
queue_endpoint=http://queue:9324
aws_access_key=${OVO_BOOTSTRAP_AWS_ACCESS_KEY_ID:-local}
aws_secret_key=${OVO_BOOTSTRAP_AWS_SECRET_ACCESS_KEY:-local}
if $MANAGED_SQS; then
  queue_endpoint=
  aws_access_key=${OVO_BOOTSTRAP_AWS_ACCESS_KEY_ID:-}
  aws_secret_key=${OVO_BOOTSTRAP_AWS_SECRET_ACCESS_KEY:-}
fi
dotenv_url OVO_QUEUE_URL "$queue_url"

append COMPOSE_PROFILES "$compose_profiles"
append POSTGRES_PASSWORD "$postgres_password"
append DATABASE_URL "$database_url"
append OVO_ORGANIZATION_ID ovo
append OVO_ADMIN_ID first-admin
append OVO_ADMIN_LABEL First-administrator
append OVO_ALLOW_LOCAL_HTTP true
append OVO_SESSION_SECRET "$(random_hex 32)"
append OVO_SEED_ADMIN_EMAIL "$admin_email"
append OVO_SEED_ADMIN_PASSWORD "$admin_password"
append OVO_SEED_ADMIN_LABEL Administrator
append OVO_RESTORE_ADMIN_RECOVERY false
append OVO_MEDIA_PUBLIC_BASE_URL https://voice.invalid
append OVO_MEDIA_WORKER_TOKEN "$(random_hex 32)"
append OVO_SECRETS_MASTER_KEY "$(random_hex 32)"
append OVO_SECRETS_BACKEND encrypted-store
append OVO_PLUGIN_MODULES '[]'
append OVO_RECORDING_RETENTION_DAYS 30
append OVO_INBOUND_ENABLED false
append OVO_INBOUND_ROUTE_SECRET "$(random_hex 32)"
append OVO_LIVE_DIAL_ENABLED false
append OVO_TRANSPORT_CERTIFIED false
append OVO_PROVIDER_EVALUATIONS_ENABLED false
append OVO_PERMITTED_FROM_NUMBERS ''
append POSTGRES_PORT "${POSTGRES_PORT:-54329}"
append ELASTICMQ_PORT "${ELASTICMQ_PORT:-9324}"
append API_PORT "${API_PORT:-4000}"
append CONSOLE_PORT "${CONSOLE_PORT:-3000}"
append GATEWAY_PORT "${GATEWAY_PORT:-4001}"
append AWS_REGION ap-south-1
append AWS_ACCESS_KEY_ID "$aws_access_key"
append AWS_SECRET_ACCESS_KEY "$aws_secret_key"
append OVO_SQS_ENDPOINT "$queue_endpoint"
append OVO_QUEUE_URL "$queue_url"
append TWILIO_ACCOUNT_SID disabled-local-account
append TWILIO_AUTH_TOKEN disabled-local-token

if grep -Eq '(^|=)replace-with-|change-me|example-secret' "$ENV_FILE"; then
  echo "$ENV_FILE contains placeholder secrets; remove it and rerun bootstrap" >&2
  exit 1
fi

echo "Compose environment is ready at $ENV_FILE (mode 0600)."
echo 'Secrets were generated or preserved without being printed.'
echo "Next: docker compose --env-file $ENV_FILE -f infra/compose/compose.yaml up --build -d"
