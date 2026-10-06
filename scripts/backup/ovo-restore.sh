#!/usr/bin/env bash
# OPS-12: restore an archive written by ovo-backup.sh into an ISOLATED database, then apply the
# ownership fence (scripts/postgres-restore-fence.sql) exactly as docs/runbooks/backup-restore.md
# requires, and compare row counts with the archive's manifest. --extract-to only unpacks it (for
# example to recover the secrets master key from compose.env). The target database URL is read
# from OVO_RESTORE_TARGET_URL so its password stays off the command line.
set -euo pipefail
# shellcheck disable=SC2034 # ENV_FILE and OPS_ENV_FILE are read by the sourced libraries
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage: OVO_RESTORE_TARGET_URL=postgresql://... scripts/backup/ovo-restore.sh --archive SRC --yes [options]
       scripts/backup/ovo-restore.sh --archive SRC --extract-to DIR [options]

  --archive SRC       Local path or gs:// URL of an ovo-*.tar.age (or .tar) archive.
  --identity FILE     age identity (private key) file for an encrypted archive.
  --extract-to DIR    Unpack and verify only; restore nothing.
  --yes               Required to restore: the target's ovo tables are dropped and replaced.
  --env-file PATH     Compose environment, used to refuse restoring over the live database.
EOF
}

ARCHIVE=
IDENTITY=
EXTRACT=
YES=false
while (($#)); do
  case $1 in
    --archive) ARCHIVE=$2; shift 2 ;;
    --identity) IDENTITY=$2; shift 2 ;;
    --extract-to) EXTRACT=$2; shift 2 ;;
    --yes) YES=true; shift ;;
    --env-file) ENV_FILE=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done
[[ -n $ARCHIVE ]] || die '--archive is required' 2
TARGET=${OVO_RESTORE_TARGET_URL:-}
if [[ -z $EXTRACT ]]; then
  [[ -n $TARGET ]] || die 'set OVO_RESTORE_TARGET_URL to the isolated target database' 2
  [[ $YES == true ]] || die 'pass --yes: the restore replaces the target database ovo tables' 2
  if [[ -f $ENV_FILE && $TARGET == "$(env_value "$ENV_FILE" DATABASE_URL)" ]]; then
    die 'refusing to restore over the live DATABASE_URL; restore into a new isolated database' 2
  fi
fi

started=$SECONDS
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ovo-restore.XXXXXX")
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/archive"

step "fetching $ARCHIVE"
fetch_archive "$ARCHIVE" "$WORK/archive.bin"
if [[ $ARCHIVE == *.age ]]; then
  [[ -n $IDENTITY ]] || die 'the archive is encrypted: pass --identity' 2
  age -d -i "$IDENTITY" "$WORK/archive.bin" | tar -C "$WORK/archive" -xf -
else
  tar -C "$WORK/archive" -xf "$WORK/archive.bin"
fi

step 'verifying checksums'
manifest=$WORK/archive/manifest.txt
require_file "$manifest" 'archive manifest'
for pair in dump_sha256:ovo.dump env_sha256:compose.env counts_sha256:counts.tsv; do
  expected=$(sed -n "s/^${pair%%:*}=//p" "$manifest")
  [[ $(sha256_of "$WORK/archive/${pair#*:}") == "$expected" ]] || die "${pair#*:} does not match its checksum"
done

if [[ -n $EXTRACT ]]; then
  (umask 077 && mkdir -p "$EXTRACT")
  cp "$WORK/archive/"* "$EXTRACT/"
  say "verified and extracted to $EXTRACT (compose.env holds secrets: keep it mode 0600)"
  exit 0
fi

conn=$(parse_pg_url "$TARGET" "$WORK/pgpass")
step 'restoring'
pg_tool "$WORK/pgpass" pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error \
  --dbname="$conn" "$WORK/archive/ovo.dump"
# The fence skips any OVO table the archive does not have, so it always runs.
step 'applying the ownership fence'
pg_tool "$WORK/pgpass" psql --dbname="$conn" -v ON_ERROR_STOP=1 -q -f - \
  <"$OVO_ROOT/scripts/postgres-restore-fence.sql" >/dev/null

step 'comparing row counts with the manifest'
count_sql=$(pg_tool "$WORK/pgpass" psql --dbname="$conn" -v ON_ERROR_STOP=1 -At -c "$COUNT_TABLES_SQL")
pg_tool "$WORK/pgpass" psql --dbname="$conn" -v ON_ERROR_STOP=1 -At -F $'\t' -c "$count_sql" >"$WORK/restored.tsv"
missing=$(cut -f1 "$WORK/archive/counts.tsv" | sort | comm -23 - <(cut -f1 "$WORK/restored.tsv" | sort) | tr '\n' ' ')
[[ -z ${missing// /} ]] || die "tables missing after the restore: $missing"
differing=$(sort "$WORK/archive/counts.tsv" | comm -23 - <(sort "$WORK/restored.tsv") | cut -f1 | tr '\n' ' ')

printf '{"operation":"restore","created_utc":"%s","fenced":true,"tables":%s,"count_differences":"%s","seconds":%s}\n' \
  "$(sed -n 's/^created_utc=//p' "$manifest")" "$(wc -l <"$WORK/restored.tsv" | tr -d ' ')" \
  "${differing% }" "$((SECONDS - started))"
