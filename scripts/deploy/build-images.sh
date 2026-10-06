#!/usr/bin/env bash
# OPS-9: build every image off the call host (the Mac mini), tag it with the git revision, push it,
# and write an image pin file (registry digests) that deploy-compose.sh --images applies on the VM.
# Building on the 4-vCPU call host competes with live calls for CPU; this keeps redeploys a pull
# and makes rollback a re-pin of an older file.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/deploy/build-images.sh --registry REGISTRY [options]

  --registry REGISTRY   e.g. asia-south1-docker.pkg.dev/PROJECT/ovo (required)
  --platform PLATFORM   Target platform (default linux/amd64, the GCP VM).
  --push                Push and write the pin file (otherwise build into the local cache only).
  --out PATH            Pin file (default infra/compose/.deploy/images-<revision>.env).
  --allow-dirty         Build a working tree with uncommitted changes (tagged <sha>-dirty).
  --dry-run             Print the commands only.
EOF
}

REGISTRY=
PLATFORM=linux/amd64
PUSH=false
OUT=
ALLOW_DIRTY=false
while (($#)); do
  case $1 in
    --registry) REGISTRY=$2; shift 2 ;;
    --platform) PLATFORM=$2; shift 2 ;;
    --push) PUSH=true; shift ;;
    --out) OUT=$2; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done
[[ -n $REGISTRY ]] || die '--registry is required' 2
[[ $REGISTRY =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)*$ ]] || die "invalid registry $REGISTRY" 2

cd "$OVO_ROOT"
revision=$(git rev-parse --short=12 HEAD)
if [[ -n $(git status --porcelain) ]]; then
  [[ $ALLOW_DIRTY == true ]] || die 'the working tree has uncommitted changes; commit, or pass --allow-dirty' 2
  revision="$revision-dirty"
fi
OUT=${OUT:-$OVO_ROOT/infra/compose/.deploy/images-$revision.env}
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT

step "building $revision for $PLATFORM"
output=(--load)
[[ $PUSH == true ]] && output=(--push)
# The bake file reads REGISTRY, REVISION and PLATFORM from the environment.
run env REGISTRY="$REGISTRY" REVISION="$revision" PLATFORM="$PLATFORM" \
  docker buildx bake -f infra/container/docker-bake.hcl --metadata-file "$metadata" "${output[@]}"

[[ $PUSH == true ]] || {
  say 'built into the local image store; pass --push to publish and write a pin file'
  exit 0
}
if [[ $DRY_RUN == true ]]; then
  say "dry run: would write $OUT"
  exit 0
fi

# bake --metadata-file records each target's pushed manifest digest under containerimage.digest.
[[ -s $metadata ]] || die 'docker buildx bake wrote no metadata; nothing was pinned'
mkdir -p "$(dirname "$OUT")"
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
node -e '
  const meta = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const [registry, revision] = process.argv.slice(2);
  const names = { api: "API", console: "CONSOLE", gateway: "GATEWAY", dispatcher: "DISPATCHER", worker: "WORKER", tools: "TOOLS" };
  for (const [target, key] of Object.entries(names)) {
    const digest = meta[target]?.["containerimage.digest"];
    if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) throw new Error(`no pushed digest for ${target}`);
    console.log(`OVO_${key}_IMAGE=${registry}/ovo-${target}:${revision}@${digest}`);
  }
' "$metadata" "$REGISTRY" "$revision" >"$OUT"
say "pinned images written to $OUT"
say "deploy: scripts/deploy/deploy-compose.sh --ref $revision --images <copy of that file on the VM>"
