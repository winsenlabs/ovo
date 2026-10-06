#!/usr/bin/env bash
# OPS-12: scheduled offsite backup (run nightly by infra/systemd/ovo-backup.timer). It writes one
# age-encrypted archive holding a custom-format pg_dump of the whole OVO database, the Compose .env
# (the secrets master key and session secret: without them the dump's credentials are unreadable)
# and a manifest with checksums and per-table row counts; uploads it to a versioned GCS bucket;
# mirrors the recordings volume; prunes old local archives; and pings a dead-man's-switch URL.
# The password never appears on a command line: it goes through a mode-0600 PGPASSFILE.
set -euo pipefail
# shellcheck disable=SC2034 # ENV_FILE, OPS_ENV_FILE and DRY_RUN are read by the sourced libraries
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/backup/ovo-backup.sh [options]

  --env-file PATH     Compose environment (default infra/compose/.env).
  --ops-env PATH      OVO_OPS_BACKUP_* settings (default infra/compose/.env.ops).
  --source SOURCE     compose: pg_dump inside the bundled postgres container (default when the
                      local-postgres profile is on); url: DATABASE_URL, or OVO_OPS_BACKUP_DATABASE_URL.
  --skip-upload       Keep the archive locally only.
  --skip-recordings   Do not mirror the recordings volume.
  --no-encrypt        Write a plain .tar (local drills only; refused with an upload).
  --dry-run           Print the plan only.
EOF
}

SOURCE=
UPLOAD=true
RECORDINGS=true
ENCRYPT=true
while (($#)); do
  case $1 in
    --env-file) ENV_FILE=$2; shift 2 ;;
    --ops-env) OPS_ENV_FILE=$2; shift 2 ;;
    --source) SOURCE=$2; shift 2 ;;
    --skip-upload) UPLOAD=false; shift ;;
    --skip-recordings) RECORDINGS=false; shift ;;
    --no-encrypt) ENCRYPT=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done

require_file "$ENV_FILE" 'Compose environment'
load_ops_env
BUCKET=${OVO_OPS_BACKUP_BUCKET:-}
RECIPIENT=${OVO_OPS_BACKUP_AGE_RECIPIENT:-}
LOCAL_DIR=${OVO_OPS_BACKUP_LOCAL_DIR:-/var/backups/ovo}
KEEP=${OVO_OPS_BACKUP_KEEP_LOCAL:-3}
[[ $KEEP =~ ^[1-9][0-9]*$ ]] || die 'OVO_OPS_BACKUP_KEEP_LOCAL must be a positive integer' 2
if [[ -z $SOURCE ]]; then
  if [[ -n $(backing_services | grep -x postgres || true) ]]; then SOURCE=compose; else SOURCE=url; fi
fi
[[ $SOURCE == compose || $SOURCE == url ]] || die '--source must be compose or url' 2
if [[ $UPLOAD == true ]]; then
  [[ $BUCKET == gs://* ]] || die 'OVO_OPS_BACKUP_BUCKET must be gs://<bucket> (or pass --skip-upload)' 2
  [[ $ENCRYPT == true ]] || die 'refusing to upload an unencrypted archive: it holds the secrets master key' 2
fi
if [[ $ENCRYPT == true ]]; then
  [[ -n $RECIPIENT ]] || die 'OVO_OPS_BACKUP_AGE_RECIPIENT is not set (an age1... public key or a recipients file)' 2
  command -v age >/dev/null 2>&1 || die 'age is not installed (Debian: apt-get install age)' 2
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name=ovo-$stamp.tar$([[ $ENCRYPT == true ]] && echo .age)
remote=${BUCKET%/}/postgres/${stamp:0:4}/${stamp:4:2}/$name
if [[ $DRY_RUN == true ]]; then
  say "dry run: pg_dump ($SOURCE) + .env + manifest -> $LOCAL_DIR/$name"
  [[ $UPLOAD == true ]] && say "dry run: upload to $remote"
  [[ $RECORDINGS == true && $UPLOAD == true ]] && say "dry run: mirror recordings to ${BUCKET%/}/recordings"
  say "dry run: keep the newest $KEEP local archives"
  exit 0
fi

started=$SECONDS
(umask 077 && mkdir -p "$LOCAL_DIR")
LOCK=$LOCAL_DIR/.backup.lock
mkdir "$LOCK" 2>/dev/null || die "another backup holds $LOCK"
WORK=$(mktemp -d "$LOCAL_DIR/.work.XXXXXX")
trap 'rm -rf "$WORK" "$LOCK"' EXIT
mkdir "$WORK/archive"

step "dumping PostgreSQL ($SOURCE)"
if [[ $SOURCE == compose ]]; then
  dump() { compose exec -T postgres pg_dump -U ovo -d ovo "$@"; }
  query() { compose exec -T postgres psql -U ovo -d ovo -v ON_ERROR_STOP=1 -At "$@"; }
else
  url=${OVO_OPS_BACKUP_DATABASE_URL:-$(env_value "$ENV_FILE" DATABASE_URL)}
  conn=$(parse_pg_url "$url" "$WORK/pgpass")
  dump() { pg_tool "$WORK/pgpass" pg_dump --dbname="$conn" "$@"; }
  query() { pg_tool "$WORK/pgpass" psql --dbname="$conn" -v ON_ERROR_STOP=1 -At "$@"; }
fi
dump --format=custom --compress=6 --no-owner --no-privileges >"$WORK/archive/ovo.dump"
count_sql=$(query -c "$COUNT_TABLES_SQL")
query -F $'\t' -c "$count_sql" >"$WORK/archive/counts.tsv"
cp "$ENV_FILE" "$WORK/archive/compose.env"
{
  printf 'created_utc=%s\n' "$stamp"
  printf 'revision=%s\n' "$(git -C "$OVO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  printf 'source=%s\n' "$SOURCE"
  printf 'dump_bytes=%s\n' "$(wc -c <"$WORK/archive/ovo.dump" | tr -d ' ')"
  printf 'dump_sha256=%s\n' "$(sha256_of "$WORK/archive/ovo.dump")"
  printf 'env_sha256=%s\n' "$(sha256_of "$WORK/archive/compose.env")"
  printf 'counts_sha256=%s\n' "$(sha256_of "$WORK/archive/counts.tsv")"
} >"$WORK/archive/manifest.txt"

step 'packing'
archive=$LOCAL_DIR/$name
if [[ $ENCRYPT == true ]]; then
  recipient_flag=-r
  [[ -f $RECIPIENT ]] && recipient_flag=-R
  tar -C "$WORK/archive" -cf - . | age "$recipient_flag" "$RECIPIENT" >"$archive.partial"
else
  tar -C "$WORK/archive" -cf "$archive.partial" .
fi
chmod 600 "$archive.partial"
mv "$archive.partial" "$archive"

if [[ $UPLOAD == true ]]; then
  step "uploading $remote"
  gcloud storage cp --quiet "$archive" "$remote" >&2
  gcloud storage ls "$remote" >/dev/null || die "the upload of $remote could not be listed back"
  if [[ $RECORDINGS == true ]]; then
    recordings=${OVO_OPS_BACKUP_RECORDINGS_DIR:-}
    if [[ -z $recordings ]]; then
      recordings=$(docker volume inspect -f '{{ .Mountpoint }}' ovo-compact_recordings-data 2>/dev/null) || recordings=
    fi
    if [[ -n $recordings && -d $recordings ]]; then
      step 'mirroring recordings'
      # A mirror, so a recording deleted by retention or a tombstone is deleted offsite too; the
      # bucket keeps its noncurrent version only for the lifecycle window.
      gcloud storage rsync --recursive --delete-unmatched-destination-objects \
        "$recordings" "${BUCKET%/}/recordings" >&2
    else
      say 'no recordings volume found; skipped'
    fi
  fi
fi

step "keeping the newest $KEEP local archives"
# shellcheck disable=SC2012 # archive names are fixed-format timestamps
ls -1t "$LOCAL_DIR"/ovo-*.tar* 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do rm -f "$old"; done

if [[ -n ${OVO_OPS_BACKUP_HEARTBEAT_URL:-} ]]; then
  printf 'url = "%s"\n' "$OVO_OPS_BACKUP_HEARTBEAT_URL" | curl -fsS -m 10 --retry 3 -o /dev/null -K - ||
    say 'heartbeat ping failed (the backup itself succeeded)'
fi

printf '{"operation":"backup","archive":"%s","remote":"%s","bytes":%s,"seconds":%s}\n' \
  "$archive" "$([[ $UPLOAD == true ]] && echo "$remote")" "$(wc -c <"$archive" | tr -d ' ')" "$((SECONDS - started))"
