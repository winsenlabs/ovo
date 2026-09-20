# Scale, deploy and drain

**Trigger:** release rollout, planned scale-in, stale capacity metrics, task-protection establishment/renewal failure, or saturation.  
**Owner:** platform on-call with voice on-call for active calls.  
**Dashboard:** desired/running/starting/ready-idle/reserved/active/draining, oldest eligible age, leader epoch, limiting quota, protection health, ECS events.

## Procedure

1. Confirm counts are fresh and mutually exclusive. If stale/inconsistent, the policy must report fail-closed, admit zero, and leave desired count unchanged.
2. Confirm only the dispatcher role can write worker desired count and there is no Application Auto Scaling policy. Check the current PostgreSQL leader authority/epoch.
3. Set target workers/gateways to draining before deregistration. Stop reservations and inbound assignment first.
4. Keep active workers protected and renew before expiry. A renewal failure sets the worker draining, blocks new admission, raises an incident and starts durable call reconciliation; it does not prove the call ended.
5. Wait for active calls or the documented product fallback deadline. Persist outcome, perform idempotent cleanup, release protection/reservation, then let ECS stop the task.
6. During rollout keep replacement headroom. Route new sessions only to readiness-passing tasks with the new pinned release.

## Expected signals

- Queue-empty/active-call leaves active protected tasks running.
- Starting tasks are not double-counted into repeated scale-out.
- Inbound below warm floor uses the configured busy/wait/callback/human route, never unexplained silence.
- Return to zero happens only for outbound/no-inbound-floor after commitments settle.

## Rollback and verification

On increased errors, stop new-release admission and restore the prior task definition for new calls. Do not terminate an active old worker just to complete deployment. Retain scale inputs/output/reason, leader epoch, protection renewals, call outcomes, startup percentiles and idle/call costs for the drill.
