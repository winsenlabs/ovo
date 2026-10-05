#!/usr/bin/env bash
# The pre-merge gate (OPS-5), run on the Mac mini rather than GitHub Actions:
#   scripts/mini-ci.sh postgres://user@host:port/database
# The database URL may instead come from OVO_TEST_POSTGRES_URL. Its role needs CREATEDB: the
# Postgres suites and the live-path test run in a fresh database, dropped on exit, because some
# suites use fixed idempotency keys that collide with an earlier run's rows.
# Every gate runs even after a failure, so one run reports everything; exits non-zero if any failed.
set -uo pipefail
cd "$(dirname "$0")/.."

postgres_url=${1:-${OVO_TEST_POSTGRES_URL:-}}
if [[ -z $postgres_url ]]; then
  echo 'usage: scripts/mini-ci.sh <postgres-url> (or set OVO_TEST_POSTGRES_URL)' >&2
  exit 2
fi

ci_database=ovo_ci_$$
admin_sql() { psql "$postgres_url" -v ON_ERROR_STOP=1 -qc "$1"; }
admin_sql "CREATE DATABASE $ci_database" || exit 1
trap 'admin_sql "DROP DATABASE IF EXISTS $ci_database WITH (FORCE)"' EXIT
ci_url=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.href)' \
  "$postgres_url" "$ci_database")

failed=()
step() {
  local name=$1
  shift
  echo "::: $name"
  if "$@"; then
    echo "::: $name passed"
  else
    echo "::: $name FAILED"
    failed+=("$name")
  fi
}

# Each variable gates Postgres-backed tests. OVO_BACKUP_DRILL_POSTGRES_URL is left out on purpose:
# the restore drill runs pg_dump in Docker and creates its own databases.
postgres_vars=(OVO_TEST_POSTGRES_URL LEDGER_TEST_DATABASE_URL RECORDING_TEST_DATABASE_URL)

postgres_suites() {
  local files report pattern
  pattern=$(
    IFS='|'
    echo "${postgres_vars[*]}|fixture-admission-support"
  )
  files=$(git ls-files '*.test.ts' | grep -v '^tests/e2e/' | grep -v '^scripts/tests/fixtures/' |
    xargs grep -lE "$pattern")
  report=$(mktemp)
  # Shared tables: one file at a time.
  # shellcheck disable=SC2086
  env "${postgres_vars[@]/%/=$ci_url}" pnpm exec vitest run --no-file-parallelism \
    --reporter=default --reporter=json --outputFile="$report" $files || {
    rm -f "$report"
    return 1
  }
  # A suite whose gate variable is missing skips itself; with every gate set, none may skip.
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const skipped = r.numPendingTests + r.numTodoTests;
    console.log(`postgres suites: ${r.numPassedTests} passed, ${skipped} skipped`);
    process.exit(skipped === 0 ? 0 : 1);
  ' "$report"
  local status=$?
  rm -f "$report"
  return $status
}

echo '::: install (frozen lockfile)'
pnpm install --frozen-lockfile || { echo '::: install FAILED'; exit 1; }

step typecheck pnpm typecheck
step 'typecheck tests/e2e' pnpm exec tsc -p tests/e2e/tsconfig.json
step lint pnpm lint
step 'format check' pnpm format:check
# Without a database URL the Postgres suites skip themselves; they run next, serially.
step 'unit tests' env "${postgres_vars[@]/#/-u}" pnpm test
step 'postgres suites' postgres_suites
step 'live-path e2e' env OVO_TEST_POSTGRES_URL="$ci_url" pnpm test:live-path

if ((${#failed[@]})); then
  echo "mini-ci failed: ${failed[*]}"
  exit 1
fi
echo 'mini-ci passed'
