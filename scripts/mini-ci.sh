#!/usr/bin/env bash
# The pre-merge gate (OPS-5), run on the Mac mini rather than GitHub Actions:
#   scripts/mini-ci.sh postgres://user@host:port/database
# The database URL may instead come from OVO_TEST_POSTGRES_URL. The Postgres suites and the
# live-path test create and migrate their own schemas in it, so use a database reserved for CI.
# Every gate runs even after a failure, so one run reports everything; exits non-zero if any failed.
set -uo pipefail
cd "$(dirname "$0")/.."

postgres_url=${1:-${OVO_TEST_POSTGRES_URL:-}}
if [[ -z $postgres_url ]]; then
  echo 'usage: scripts/mini-ci.sh <postgres-url> (or set OVO_TEST_POSTGRES_URL)' >&2
  exit 2
fi

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

postgres_suites() {
  local files
  files=$(git ls-files '*.test.ts' | grep -v '^tests/e2e/' | grep -v '^scripts/tests/fixtures/' |
    xargs grep -l 'OVO_TEST_POSTGRES_URL')
  # Shared tables: one file at a time.
  # shellcheck disable=SC2086
  OVO_TEST_POSTGRES_URL=$postgres_url pnpm exec vitest run --no-file-parallelism $files
}

echo '::: install (frozen lockfile)'
pnpm install --frozen-lockfile || { echo '::: install FAILED'; exit 1; }

step typecheck pnpm typecheck
step 'typecheck tests/e2e' pnpm exec tsc -p tests/e2e/tsconfig.json
step lint pnpm lint
step 'format check' pnpm format:check
# Without a database URL the Postgres suites skip themselves; they run next, serially.
step 'unit tests' env -u OVO_TEST_POSTGRES_URL pnpm test
step 'postgres suites' postgres_suites
step 'live-path e2e' env OVO_TEST_POSTGRES_URL="$postgres_url" pnpm test:live-path

if ((${#failed[@]})); then
  echo "mini-ci failed: ${failed[*]}"
  exit 1
fi
echo 'mini-ci passed'
