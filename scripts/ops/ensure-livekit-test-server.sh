#!/usr/bin/env bash
# Finds a LiveKit room server the human-room e2e can run against (Wave 17). Prints one line:
#   bin <path>        a livekit-server binary: OVO_E2E_LIVEKIT_BIN, else the one on PATH
#   skip <reason>     nothing usable (exit 3): the e2e then skips with that reason
# --install runs `brew install livekit` (Apache-2.0 bottle) when no binary is found; the mini-ci uses it.
# The server is only ever started by the test, on loopback and free ports, never by this script.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INSTALL=false
for argument in "$@"; do
  case $argument in
    --install) INSTALL=true ;;
    -h | --help)
      sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option $argument" >&2; exit 2 ;;
  esac
done

# The tag compose.yaml pins; a server of another minor version is reported, not refused.
pinned_image() {
  sed -n 's/.*image: \${OVO_LIVEKIT_IMAGE:-\(livekit\/livekit-server:[^}]*\)}.*/\1/p' \
    "$ROOT_DIR/infra/compose/compose.yaml" | head -n 1
}

usable() {
  [[ -n ${1:-} && -x $1 ]] && "$1" --version >/dev/null 2>&1
}

version_of() {
  "$1" --version 2>/dev/null | sed -n 's/.*version \([0-9][0-9.]*\).*/\1/p' | head -n 1
}

report() {
  local path=$1 want have
  want=$(pinned_image)
  want=${want##*:v}
  have=$(version_of "$path")
  [[ -z $have || $have == "$want" ]] || echo "note: $path is $have; compose pins $want" >&2
  echo "bin $path"
}

if usable "${OVO_E2E_LIVEKIT_BIN:-}"; then
  report "$OVO_E2E_LIVEKIT_BIN"
  exit 0
fi
if [[ -n ${OVO_E2E_LIVEKIT_BIN:-} ]]; then
  echo "skip OVO_E2E_LIVEKIT_BIN=$OVO_E2E_LIVEKIT_BIN is not an executable livekit-server"
  exit 3
fi
if found=$(command -v livekit-server) && usable "$found"; then
  report "$found"
  exit 0
fi
if [[ $INSTALL == true ]] && command -v brew >/dev/null 2>&1; then
  echo 'installing livekit with brew (Apache-2.0)' >&2
  brew install livekit >&2
  if found=$(command -v livekit-server) && usable "$found"; then
    report "$found"
    exit 0
  fi
fi
echo 'skip no livekit-server on PATH or in OVO_E2E_LIVEKIT_BIN (brew install livekit, or run scripts/ops/ensure-livekit-test-server.sh --install)'
exit 3
