# Scale, deploy and drain

**Trigger:** release rollout, planned scale-in, stale capacity signal, protection failure or saturation.  
**Owner:** platform on-call with voice on-call for active calls.  
**Dashboard:** required/provisioned slots, signal age, AAS target and alarm, ready-idle/reserved/active/draining counts, oldest eligible age, limiting quota and ECS events.

## Procedure

1. Confirm dispatcher inputs and published `OVO/Capacity` signals are fresh. Failed input produces no signal and degraded dispatcher health; it never authorizes admission.
2. [ADR 0003](../decisions/0003-aas-only-desired-count-writer.md) assigns worker desired count to Application Auto Scaling alone. Inspect the target tracking policy, fast scale-out alarm, scheduled actions and ECS service state. Do not issue a competing `UpdateService` while AAS owns the target.
3. Stop new reservations and inbound assignment before draining. Mark workers draining before deregistration. The worker must establish and renew scale-in protection while an active call exists; renewal failure blocks new admission and starts durable reconciliation without claiming that the call ended.
4. Wait for active calls or the documented fallback deadline. Persist the actual outcome, perform idempotent local and inbound-session cleanup, release protection and reservation, then let ECS stop the task. Unknown carrier or tool outcomes remain unknown until reconciliation; they are never redialed or reported as success by guess.
5. During rollout retain replacement headroom and route new sessions only to readiness-passing tasks with the new pinned release.

Compose publishes the same computed capacity signal to the log and keeps two fixed workers; it does not call AAS.

## Expected signals

- Queue-empty with active calls keeps protected tasks running.
- Starting tasks are not double-counted into repeated scale-out.
- Inbound below the warm floor uses the configured busy/wait/callback/human route, never unexplained silence.
- Return to zero happens only after outbound commitments settle and when the inbound warm floor permits it.

## Rollback and verification

On increased errors, stop new-release admission and restore the prior task definition for new calls. Do not terminate an active old worker solely to complete deployment. Retain capacity inputs, signal timestamps, AAS decisions, protection renewals, call outcomes, startup percentiles and idle/call costs for the drill. A live AWS scale drill remains unverified until separately authorized.
