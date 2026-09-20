#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <postgres-url> <output.dump>" >&2
  exit 64
fi

database_url=$1
output=$2
image=${OVO_POSTGRES_CLIENT_IMAGE:-postgres:17.6-alpine}

started=$(date +%s)
docker run --rm --network host "$image" pg_dump \
  --format=custom --compress=6 --no-owner --no-privileges \
  --table='public.ovo_*' "$database_url" > "$output"
finished=$(date +%s)

chmod 600 "$output"
bytes=$(wc -c < "$output" | tr -d ' ')
printf '{"operation":"backup","seconds":%s,"bytes":%s,"artifact":"%s"}\n' \
  "$((finished - started))" "$bytes" "$output"
