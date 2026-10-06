#!/usr/bin/env bash
# Local load test (never against real services): N concurrent fake-carrier calls through the stack.
#   OVO_TEST_POSTGRES_URL=postgres://ovo@127.0.0.1:55439/<scratch db> scripts/loadtest/loadtest.sh --calls 8
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${OVO_TEST_POSTGRES_URL:-}" ]]; then
  echo "OVO_TEST_POSTGRES_URL must point at a scratch Postgres database" >&2
  exit 2
fi
export OVO_LOG_LEVEL="${OVO_LOG_LEVEL:-error}"
exec node --import tsx --import "$here/../register-sql.mjs" --import "$here/register-routed-net.mjs" "$here/run.ts" "$@"
