#!/usr/bin/env bash
# OPS-12: create the offsite backup bucket once. Prints the gcloud commands by default; --apply runs
# them. The bucket is in asia-south1 (same region as the VM, data stays in India), private
# (uniform access, public access prevention), versioned, and expires archives after 35 days and
# overwritten or deleted object versions (recordings mirror) after 30 days
# (infra/gcp/backup-lifecycle.json; format per
# https://cloud.google.com/storage/docs/lifecycle-configurations, retrieved 2026-10-06).
# The VM's service account gets roles/storage.objectUser on this bucket only: the recordings mirror
# must delete what retention deleted. Versioning plus a 14-day soft-delete window keep a deleted or
# overwritten object recoverable, including after a compromised VM deletes it.
set -euo pipefail
# shellcheck source=../deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../deploy/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/backup/gcs-bucket-setup.sh --project PROJECT --bucket NAME --service-account EMAIL [--apply]

  --location LOCATION   Default asia-south1.
  --apply               Run the commands (default: print them).
EOF
}

PROJECT=
BUCKET=
ACCOUNT=
LOCATION=asia-south1
APPLY=false
while (($#)); do
  case $1 in
    --project) PROJECT=$2; shift 2 ;;
    --bucket) BUCKET=${2#gs://}; shift 2 ;;
    --service-account) ACCOUNT=$2; shift 2 ;;
    --location) LOCATION=$2; shift 2 ;;
    --apply) APPLY=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done
[[ -n $PROJECT && -n $BUCKET && -n $ACCOUNT ]] || { usage >&2; exit 2; }
[[ $BUCKET =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || die "invalid bucket name $BUCKET" 2

[[ $APPLY == true ]] || DRY_RUN=true
run gcloud storage buckets create "gs://$BUCKET" --project="$PROJECT" --location="$LOCATION" \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=14d \
  --lifecycle-file="$OVO_ROOT/infra/gcp/backup-lifecycle.json"
run gcloud storage buckets update "gs://$BUCKET" --versioning
run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$ACCOUNT" --role=roles/storage.objectUser
[[ $APPLY == true ]] || say 'printed only; rerun with --apply to create the bucket'
