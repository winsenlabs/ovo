#!/usr/bin/env bash
# OPS-11: one-time GCP setup for the call VM. Prints the gcloud commands by default; --apply runs
# them. It creates
#   - an HTTPS Uptime Check on https://HOST/ovo-gateway-health every minute from every region,
#     and an alert policy on it (infra/gcp/uptime-alert-policy.json) to a notification channel;
#   - a daily snapshot schedule (14 days) attached to the VM's boot disk;
#   - the preemption shutdown script (scripts/ops/preemption-shutdown.sh) as instance metadata;
#   - with --on-demand, automatic restart after a host failure (not allowed on Spot VMs).
# gcloud syntax per https://cloud.google.com/sdk/gcloud/reference/monitoring/uptime/create and
# .../monitoring/policies/create (GA), retrieved 2026-10-06. The alert policy mirrors the policy the
# Cloud console generates for an uptime check; confirm it once in the console after --apply.
set -euo pipefail
# shellcheck source=../deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../deploy/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/ops/gcp-monitoring-setup.sh --project P --zone Z --instance VM --host HOST \
         --notification-channel CHANNEL_ID [--disk DISK] [--repo-dir DIR] [--on-demand] [--apply]

  --disk DISK       Boot disk to snapshot (default: the instance name).
  --repo-dir DIR    Checkout path on the VM, for the shutdown script (default this checkout).
  --on-demand       The VM is not Spot: also enable restart-on-failure.
  --apply           Run the commands (default: print them).
EOF
}

PROJECT=
ZONE=
INSTANCE=
HOST=
CHANNEL=
DISK=
REPO_DIR=$OVO_ROOT
ON_DEMAND=false
APPLY=false
while (($#)); do
  case $1 in
    --project) PROJECT=$2; shift 2 ;;
    --zone) ZONE=$2; shift 2 ;;
    --instance) INSTANCE=$2; shift 2 ;;
    --host) HOST=$2; shift 2 ;;
    --notification-channel) CHANNEL=$2; shift 2 ;;
    --disk) DISK=$2; shift 2 ;;
    --repo-dir) REPO_DIR=$2; shift 2 ;;
    --on-demand) ON_DEMAND=true; shift ;;
    --apply) APPLY=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" 2 ;;
  esac
done
[[ -n $PROJECT && -n $ZONE && -n $INSTANCE && -n $HOST && -n $CHANNEL ]] || { usage >&2; exit 2; }
DISK=${DISK:-$INSTANCE}
REGION=${ZONE%-*}
CHECK=ovo-${HOST//./-}
[[ $APPLY == true ]] || DRY_RUN=true
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

step 'uptime check'
run gcloud monitoring uptime create "$CHECK" --project="$PROJECT" --resource-type=uptime-url \
  --resource-labels="host=$HOST,project_id=$PROJECT" --protocol=https --path=/ovo-gateway-health \
  --period=1 --timeout=10 --status-codes=200 --validate-ssl=true

step 'alert policy'
check_id='<CHECK_ID>'
if [[ $APPLY == true ]]; then
  check_id=$(gcloud monitoring uptime list-configs --project="$PROJECT" \
    --filter="displayName=$CHECK" --format='value(name)' | head -n 1)
  check_id=${check_id##*/}
  [[ -n $check_id ]] || die "uptime check $CHECK was not found after creating it"
fi
sed -e "s/__CHECK_ID__/$check_id/g" -e "s/__HOST__/$HOST/g" \
  "$OVO_ROOT/infra/gcp/uptime-alert-policy.json" >"$WORK/policy.json"
run gcloud monitoring policies create --project="$PROJECT" --policy-from-file="$WORK/policy.json" \
  --notification-channels="$CHANNEL"

step 'daily boot-disk snapshots'
run gcloud compute resource-policies create snapshot-schedule ovo-daily --project="$PROJECT" \
  --region="$REGION" --daily-schedule --start-time=21:00 --max-retention-days=14 \
  --on-source-disk-delete=keep-auto-snapshots
run gcloud compute disks add-resource-policies "$DISK" --project="$PROJECT" --zone="$ZONE" \
  --resource-policies=ovo-daily

step 'preemption shutdown script'
printf '#!/bin/bash\nexec %q\n' "$REPO_DIR/scripts/ops/preemption-shutdown.sh" >"$WORK/shutdown-script"
run gcloud compute instances add-metadata "$INSTANCE" --project="$PROJECT" --zone="$ZONE" \
  --metadata-from-file=shutdown-script="$WORK/shutdown-script"

if [[ $ON_DEMAND == true ]]; then
  step 'restart after host failure'
  run gcloud compute instances set-scheduling "$INSTANCE" --project="$PROJECT" --zone="$ZONE" \
    --restart-on-failure --maintenance-policy=MIGRATE
fi
[[ $APPLY == true ]] || say 'printed only; rerun with --apply to create these resources'
