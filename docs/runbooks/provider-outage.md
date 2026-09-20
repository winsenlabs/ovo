# Provider outage

**Trigger:** elevated timeout/error rate, quota rejection, invalid media, carrier callback failures, or provider status incident.  
**Owner:** voice on-call; business owner approves fallback.  
**Signals:** provider-specific error/latency, limiting quota, ready capacity, accepted/unknown operations, bounded queue/drop metrics.

## Procedure

1. Identify carrier, STT, TTS, inference or tool scope and affected releases/regions without logging credentials or customer payloads.
2. Stop new admissions that cannot satisfy readiness. Preserve active calls only where their current path remains healthy.
3. Use only a release-certified fallback. Announcement/FAQ may continue without an LLM if their speech/carrier paths pass readiness. Otherwise use configured human/busy/callback/end behavior.
4. Bound provider retries by deadline and documented safe-retry semantics. Interrupt obsolete speech and never replay a partial response as if new.
5. Persist unknown carrier/tool outcomes and reconcile. Do not announce success without a settled result.

## Recovery and verification

Restore new admission gradually through the capacity policy, respecting provider quota and error health. Verify no queue growth, duplicate dial, duplicate write, stale audio or false success. Retain incident/provider timestamps, affected request IDs (redacted), fallback releases and sampled call outcomes.
