#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <target-postgres-url> <input.dump>" >&2
  exit 64
fi

database_url=$1
input=$2
directory=$(cd "$(dirname "$input")" && pwd)
filename=$(basename "$input")
root=$(cd "$(dirname "$0")/.." && pwd)
image=${OVO_POSTGRES_CLIENT_IMAGE:-postgres:17.6-alpine}

started=$(date +%s)
docker run --rm --network host \
  -v "$directory:/backup:ro" \
  "$image" pg_restore \
  --clean --if-exists --no-owner --no-privileges --exit-on-error \
  --dbname="$database_url" "/backup/$filename"
docker run --rm --network host \
  -v "$root/scripts/postgres-restore-fence.sql:/restore-fence.sql:ro" \
  "$image" psql --set=ON_ERROR_STOP=1 --dbname="$database_url" --file=/restore-fence.sql >/dev/null
finished=$(date +%s)

printf '{"operation":"restore-and-fence","seconds":%s,"artifact":"%s"}\n' \
  "$((finished - started))" "$input"
