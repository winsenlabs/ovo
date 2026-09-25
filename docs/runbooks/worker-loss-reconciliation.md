# Worker loss reconciliation

**Trigger:** missed durable heartbeat, stopped/crashed task, gateway route loss, expired owner lease, or ECS/host termination.  
**Owner:** voice operations primary, platform secondary.  
**Target:** detect within 15 seconds and start reconciliation within 30 seconds after this is measured and alerting is certified.

## Procedure

1. Close admission for the worker/route; capture job ID, owner, ownership epoch, carrier call SID/request ID, stream SID and last durable event.
2. Fence the old owner by allowing its lease to expire or performing the approved conditional transition. Never mutate by job ID without matching epoch.
3. Query the carrier by known call SID and correlate signed callbacks by persisted request ID. For dial timeout without a SID, leave `reconcile_required` until callback lookup or an operator decision; do not call `dial` again.
4. Query pending write operations through their reconciliation/status contract. Unknown writes remain unknown; do not blind retry.
5. If the carrier call is active but the certified transport cannot reconnect, apply the configured apology/human/end fallback where technically possible and record interruption. Do not claim seamless audio recovery.
6. Requeue only jobs whose external outcome is proven not accepted and whose eligibility window, suppression, budget and attempt policy still pass.

## Recovery and verification

Restore capacity through the one dispatcher authority. Confirm a stale epoch cannot heartbeat, settle or bind a gateway route. Retain provider responses, signed callback dedupe keys, job/attempt history and the decision that permitted or blocked retry.
