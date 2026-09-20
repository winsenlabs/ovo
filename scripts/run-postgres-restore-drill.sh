#!/usr/bin/env sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
name="ovo-restore-drill-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --name "$name" \
  -e POSTGRES_PASSWORD=ovo -e POSTGRES_USER=ovo -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 postgres:17.6-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U ovo -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
port=$(docker port "$name" 5432/tcp | sed 's/.*://')
export OVO_BACKUP_DRILL_POSTGRES_URL="postgresql://ovo:ovo@127.0.0.1:$port/postgres"
cd "$root"
pnpm exec vitest run packages/plugin-storage/tests/backup-restore-drill.test.ts
