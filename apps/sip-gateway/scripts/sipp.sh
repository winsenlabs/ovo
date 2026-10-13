#!/usr/bin/env bash
# W11 §17.3: the SIPp conformance scenarios, natively on loopback (build machine only).
# The suites start the sip-gateway on 127.0.0.1:15060 / 15160 (RTP 41000-41299) next to a fake
# media gateway that verifies every ovo-sip/1 signature; the drain scenario runs src/main.ts as a
# real process and sends it SIGTERM. Pass = SIPp exit 0 and the recorded-frame assertions.
# Set SIPP_EVIDENCE_DIR to keep the fake gateway's frames as jsonl.
set -euo pipefail
SIPP_BIN="${OVO_TEST_SIPP:-$(command -v sipp || true)}"
if [ -z "$SIPP_BIN" ]; then
  echo "skipped: sipp missing (brew install sipp)"
  exit 0
fi
cd "$(dirname "$0")/../../.."
OVO_TEST_SIPP="$SIPP_BIN" exec pnpm exec vitest run --no-file-parallelism apps/sip-gateway/tests/sipp "$@"
