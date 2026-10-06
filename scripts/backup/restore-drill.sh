#!/usr/bin/env bash
# OPS-12 monthly restore drill: take the newest offsite archive, restore it with ovo-restore.sh into
# a scratch database created for the drill, apply the fence, compare row counts, drop the scratch
# database and print the measured restore time. It also fails when the newest archive is older than
# --max-age-hours, so a silently stopped backup timer cannot pass the drill.
# The server URL (with a role that may CREATE DATABASE) comes from OVO_DRILL_SERVER_URL, or for the
# bundled PostgreSQL from POSTGRES_PASSWORD and POSTGRES_PORT in the Compose environment.
set -euo pipefail
# shellcheck disable=SC2034 # ENV_FILE and OPS_ENV_FILE are read by the sourced libraries
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/backup/restore-drill.sh --identity FILE [options]

  --identity FILE       age identity (private key) for the archive.
  --archive SRC         Drill this archive instead of the newest one in OVO_OPS_BACKUP_BUCKET.
  --max-age-hours N     Fail when the archive is older than N hours (default 26).
  --keep                Keep the scratch database for inspection.
  --env-file PATH       Compose environment (default infra/compose/.env).
  --ops-env PATH        OVO_OPS_* settings (default infra/compose/.env.ops).
EOF
}

IDENTITY=
ARCHIVE=
MAX_AGE=26
KEEP=false
while (($#)); do
  case $1 in
    --identity) IDENTITY=$2; shift 2 ;;
    --archive) ARCHIVE=$2; shift 2 ;;
    --max-age-hours) MAX_AGE=$2; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --env-file) ENV_FILE=$2; shift 2 ;;
    --ops-env) OPS_ENV_FILE=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done
load_ops_env

if [[ -z $ARCHIVE ]]; then
  [[ ${OVO_OPS_BACKUP_BUCKET:-} == gs://* ]] || die 'pass --archive or set OVO_OPS_BACKUP_BUCKET' 2
  ARCHIVE=$(gcloud storage ls "${OVO_OPS_BACKUP_BUCKET%/}/postgres/**" | grep -E '/ovo-[0-9TZ]+\.tar(\.age)?$' | sort | tail -n 1)
  [[ -n $ARCHIVE ]] || die "no archive found under ${OVO_OPS_BACKUP_BUCKET%/}/postgres/"
fi
stamp=$(basename "$ARCHIVE" | sed -n 's/^ovo-\([0-9]\{8\}T[0-9]\{6\}Z\)\.tar.*/\1/p')
[[ -n $stamp ]] || die "cannot read the timestamp of $ARCHIVE"
when="${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}"
created=$(date -u -d "$when" +%s 2>/dev/null || date -j -u -f '%Y-%m-%d %H:%M:%S' "$when" +%s)
age_hours=$((($(date -u +%s) - created) / 3600))

server=${OVO_DRILL_SERVER_URL:-}
if [[ -z $server ]]; then
  password=$(env_value "$ENV_FILE" POSTGRES_PASSWORD)
  [[ -n $password ]] || die 'set OVO_DRILL_SERVER_URL (no bundled PostgreSQL password in the Compose environment)' 2
  server="postgresql://ovo:$password@127.0.0.1:$(env_value "$ENV_FILE" POSTGRES_PORT)/postgres"
fi
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ovo-drill.XXXXXX")
chmod 700 "$WORK"
admin=$(parse_pg_url "$server" "$WORK/pgpass")
database=ovo_restore_drill_$(date -u +%Y%m%d%H%M%S)_$$
cleanup() {
  if [[ $KEEP != true ]]; then
    pg_tool "$WORK/pgpass" psql --dbname="$admin" -q -c "DROP DATABASE IF EXISTS $database WITH (FORCE)" >/dev/null 2>&1 ||
      say "could not drop $database; drop it by hand"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step "drilling $ARCHIVE (${age_hours}h old) into $database"
pg_tool "$WORK/pgpass" psql --dbname="$admin" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $database" >/dev/null
target=$(printf '%s' "$server" | sed -E "s#^(postgres(ql)?://[^/]+)/[^?]*#\\1/$database#")
started=$SECONDS
result=$(OVO_RESTORE_TARGET_URL=$target "$OVO_ROOT/scripts/backup/ovo-restore.sh" --archive "$ARCHIVE" \
  --identity "$IDENTITY" --env-file "$ENV_FILE" --yes)
printf '%s\n' "$result"
seconds=$((SECONDS - started))
fresh=true
((age_hours <= MAX_AGE)) || fresh=false
printf '{"operation":"restore-drill","archive":"%s","archive_age_hours":%s,"fresh":%s,"restore_seconds":%s,"kept":%s}\n' \
  "$ARCHIVE" "$age_hours" "$fresh" "$seconds" "$([[ $KEEP == true ]] && echo "\"$database\"" || echo false)"
[[ $fresh == true ]] || die "the newest archive is ${age_hours}h old (limit ${MAX_AGE}h): check ovo-backup.timer"
