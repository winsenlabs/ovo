# Cost or quota incident

**Trigger:** spend ceiling, carrier/AI/AWS quota, unexpected idle cost, usage mismatch or runaway queue.  
**Owner:** platform on-call and budget owner.  
**Signals:** provider-native usage/request IDs, price/FX versions, capacity reason/limiting quota, idle versus connected worker cost, pending budget reservations.

## Procedure

1. Pause new jobs at the narrowest safe workspace/campaign/global scope. Active-call handling follows explicit policy; do not terminate callers silently.
2. Set permitted new starts to zero through the authorized configuration path. The capacity policy must stop admission but preserve active/reserved commitments and inbound overflow behavior.
3. Compare carrier legs, STT/TTS/LLM/tool usage, retries, failed attempts, worker startup/idle, media/network and late reconciliations. Do not add overlapping latency/cost spans or hide unallocated shared cost.
4. Investigate duplicate outbox/SQS delivery versus duplicate external effects. At-least-once queue delivery is expected; duplicate dial/write is not.
5. Raise quotas or budget only with approval, then restore starts gradually through the same dispatcher authority.

## Recovery and verification

Reconcile native units using the effective price/FX cards and fixed-precision totals. Retain the pause/resume audit, limiting quota, affected jobs, late charges and revised guardrail. Cached speech may reduce generation cost but never makes carrier/worker time free.
