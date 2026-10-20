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

# Wave 13: the call-eval harness replays the committed corpus (packages/eval/corpus) offline, with no
# network, through the production engine, detector and behaviour, and fails when a metric is worse
# than the committed baseline beyond its threshold (docs/eval/README.md).
eval_gate() {
  local out status
  out=$(mktemp -d)
  pnpm -s eval:calls --mode transcript --label mini-ci --out "$out" \
    --baseline packages/eval/baselines/transcript-rules.json
  status=$?
  rm -rf "$out"
  return $status
}

# Wave 17: the human-room e2e runs against a real LiveKit server (brew install livekit, Apache-2.0),
# started by the tests on loopback and free ports. With none found the gate fails rather than skip.
room_bin=
room_server() {
  local found
  found=$(scripts/ops/ensure-livekit-test-server.sh --install) || {
    echo "$found" >&2
    return 1
  }
  room_bin=${found#bin }
  echo "livekit-server: $room_bin"
}

# The live-path e2e, with the room files held to "no skips" once a room server was found.
live_path() {
  local report status
  report=$(mktemp)
  env -u OVO_TEST_SIPP OVO_E2E_LIVEKIT_BIN="$room_bin" OVO_TEST_POSTGRES_URL="$ci_url" \
    pnpm test:live-path --reporter=default --reporter=json --outputFile="$report"
  status=$?
  if [[ -n $room_bin ]]; then
    node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const rooms = r.testResults.filter((file) => /human-room-/.test(file.name));
      const skipped = rooms.flatMap((file) => file.assertionResults).filter((t) => t.status !== "passed");
      console.log(`human-room e2e: ${rooms.length} files, ${skipped.length} not passed`);
      process.exit(rooms.length >= 4 && skipped.length === 0 ? 0 : 1);
    ' "$report" || status=1
  fi
  rm -f "$report"
  return $status
}

echo '::: install (frozen lockfile)'
pnpm install --frozen-lockfile || { echo '::: install FAILED'; exit 1; }

step typecheck pnpm typecheck
step 'typecheck tests/e2e' pnpm exec tsc -p tests/e2e/tsconfig.json
step lint pnpm lint
step 'format check' pnpm format:check
# Without a database URL the Postgres suites skip themselves; they run next, serially. Without
# OVO_TEST_SIPP the SIPp suites skip themselves too; they run last, in their own step.
step 'unit tests' env "${postgres_vars[@]/#/-u}" -u OVO_TEST_SIPP pnpm test
step 'postgres suites' postgres_suites
step 'eval offline gate' eval_gate
step 'livekit-server' room_server
step 'live-path e2e' live_path
# Wave 11: SIPp against the native sip-gateway on loopback (its scenarios, then the full SIP path
# through the media gateway and a worker). The build host may not have SIPp (brew install sipp).
if sipp_bin=$(command -v sipp); then
  step 'sip (SIPp)' env OVO_TEST_SIPP="$sipp_bin" OVO_TEST_POSTGRES_URL="$ci_url" pnpm test:sip
else
  echo '::: sip (SIPp) skipped: sipp missing (brew install sipp)'
fi

if ((${#failed[@]})); then
  echo "mini-ci failed: ${failed[*]}"
  exit 1
fi
echo 'mini-ci passed'
