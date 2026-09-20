# Scale, deploy and drain

**Trigger:** release rollout, planned scale-in, stale capacity metrics, task-protection establishment/renewal failure, or saturation.  
**Owner:** platform on-call with voice on-call for active calls.  
**Dashboard:** desired/running/starting/ready-idle/reserved/active/draining, oldest eligible age, leader epoch, limiting quota, protection health, ECS events.

## Procedure

1. Confirm counts are fresh and mutually exclusive. If stale/inconsistent, the policy must report fail-closed, admit zero, and leave desired count unchanged.
2. Confirm only the dispatcher role can write worker desired count and there is no Application Auto Scaling policy. Check the current PostgreSQL leader authority/epoch.
3. Check `ovo_capacity_writes` for `inflight` or `unknown`. A new leader must not issue `UpdateService` while either is unresolved. Desired-count readback is diagnostic only: even a matching value may be the preexisting count while a timed-out request can still arrive. Both statuses remain fail-closed because AWS provides no fencing token.
4. Do not settle an unresolved row from ECS desired-count readback. Release the SQL fence only through an explicit operator reconciliation after authoritative evidence establishes that the exact earlier request completed and cannot later overwrite a newer request. Record that evidence and an incident/change identifier outside the database, stop the dispatcher, then have two operators verify the exact `attempt_id`, service, authority, epoch and intended count before conditionally changing that row from `inflight` or `unknown` to `applied`. If that certificate is unavailable, leave the row unresolved and escalate; do not restore automatic scaling.
5. Set target workers/gateways to draining before deregistration. Stop reservations and inbound assignment first.
6. Keep active workers protected and renew before expiry. A renewal failure sets the worker draining, blocks new admission, raises an incident and starts durable call reconciliation; it does not prove the call ended.
7. Wait for active calls or the documented product fallback deadline. Persist outcome, perform idempotent cleanup, release protection/reservation, then let ECS stop the task.
8. During rollout keep replacement headroom. Route new sessions only to readiness-passing tasks with the new pinned release.

### Manual unresolved-write gate

There is intentionally no application API that settles `inflight` or `unknown` from ECS readback. If the certificate in step 4 exists, keep the dispatcher stopped and run a reviewed transaction using the exact values from the certificate (placeholders below are not a copy-paste command):

```sql
BEGIN;
SELECT attempt_id, service_key, authority_id, epoch, desired_count, status
FROM ovo_capacity_writes
WHERE attempt_id = '<attempt-uuid>'
FOR UPDATE;

UPDATE ovo_capacity_writes
SET status = 'applied', settled_at = now()
WHERE attempt_id = '<attempt-uuid>'
  AND service_key = '<service-key>'
  AND authority_id = '<authority-id>'
  AND epoch = <epoch>
  AND desired_count = <desired-count>
  AND status IN ('inflight', 'unknown')
RETURNING attempt_id, service_key, authority_id, epoch, desired_count, status;
COMMIT;
```

Require exactly one returned row, attach the transaction evidence to the incident/change record, then restart one dispatcher. A matching desired count, a quiet ECS event stream or elapsed time alone is not an authoritative certificate. If the exact request cannot be proven final, `ROLLBACK` and leave the fence in place.

## Expected signals

- Queue-empty/active-call leaves active protected tasks running.
- Starting tasks are not double-counted into repeated scale-out.
- Inbound below warm floor uses the configured busy/wait/callback/human route, never unexplained silence.
- Return to zero happens only for outbound/no-inbound-floor after commitments settle.

## Rollback and verification

On increased errors, stop new-release admission and restore the prior task definition for new calls. Do not terminate an active old worker just to complete deployment. Retain scale inputs/output/reason, leader epoch, protection renewals, call outcomes, startup percentiles and idle/call costs for the drill.
