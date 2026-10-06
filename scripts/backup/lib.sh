# Backup helpers shared by ovo-backup.sh, ovo-restore.sh and restore-drill.sh. Sourced.
# shellcheck shell=bash
# shellcheck source=../deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../deploy/lib.sh"

OVO_PG_CLIENT_IMAGE=${OVO_PG_CLIENT_IMAGE:-postgres:17.6-bookworm}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

urldecode() {
  local value=${1//%/\\x}
  printf '%b' "$value"
}

# pgpass fields escape backslash and colon.
pgpass_field() {
  local value=${1//\\/\\\\}
  printf '%s' "${value//:/\\:}"
}

# parse_pg_url URL PASSFILE: writes the password to a mode-0600 pgpass file and prints the same
# URL without it, so no password ever appears on a command line (`ps`) or in a log.
parse_pg_url() {
  local url=$1 passfile=$2
  local re='^postgres(ql)?://([^:@/]+)(:([^@/]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)(\?(.*))?$'
  [[ $url =~ $re ]] || die 'the database URL must look like postgresql://user:password@host:port/database' 2
  local user=${BASH_REMATCH[2]} password=${BASH_REMATCH[4]} host=${BASH_REMATCH[5]}
  local port=${BASH_REMATCH[7]:-5432} database=${BASH_REMATCH[8]} query=${BASH_REMATCH[10]}
  (
    umask 077
    printf '%s:%s:%s:%s:%s\n' "$(pgpass_field "$host")" "$port" "$(pgpass_field "$(urldecode "$database")")" \
      "$(pgpass_field "$(urldecode "$user")")" "$(pgpass_field "$(urldecode "$password")")" >"$passfile"
  )
  printf 'postgresql://%s@%s:%s/%s%s\n' "$user" "$host" "$port" "$database" "${query:+?$query}"
}

# pg_tool PASSFILE TOOL ARGS...: the host's PostgreSQL client when present, else the client image.
pg_tool() {
  local passfile=$1 tool=$2
  shift 2
  if command -v "$tool" >/dev/null 2>&1; then
    PGPASSFILE=$passfile "$tool" "$@"
  else
    docker run --rm -i --network host -e PGPASSFILE=/run/ovo/pgpass -v "$passfile:/run/ovo/pgpass:ro" \
      -v "$WORK:$WORK" -w "$WORK" "$OVO_PG_CLIENT_IMAGE" "$tool" "$@"
  fi
}

# One query that counts every ovo_* table: the restore and the drill compare against it.
# shellcheck disable=SC2034 # used by the scripts that source this file
COUNT_TABLES_SQL="SELECT coalesce(string_agg(format('SELECT %L AS t, count(*) AS n FROM %I.%I', relname, schemaname, relname), ' UNION ALL ' ORDER BY relname), 'SELECT NULL::text, NULL::bigint WHERE false') FROM pg_stat_user_tables WHERE relname LIKE 'ovo\\_%'"

# Fetches gs:// objects with gcloud, copies local paths.
fetch_archive() {
  local source=$1 target=$2
  if [[ $source == gs://* ]]; then
    gcloud storage cp --quiet "$source" "$target" >&2
  else
    cp "$source" "$target"
  fi
}
