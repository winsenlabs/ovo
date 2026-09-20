# ADR 0002: Voice components for the local implementation

Date: 2026-09-20. Status: **local component selection; not production voice-engine certification**.

## Evidence

The matched experiment mounts both candidates through the actual DeepSeek-derived host. The focused path uses the implemented behavior, scheduler, AI SDK inference, shared execution and native connector packages. The other path uses a real persistent LiveKit `AgentSession`. One hundred bounded samples pass; cold lifecycle costs are reported separately. Source and lockfile hashes identify the dirty implementation snapshot. See [comparison](../research/upstream-comparison.md) and [benchmark](../research/voice-benchmark.md).

## Decision

Use the focused plugin set for the current local runtime and console simulation. Use AI SDK only as a single inference step with schema-only tool definitions and retries disabled. OVO owns conversation continuation and business-effect execution. Keep LiveKit as a real adapter experiment, not a second simultaneous loop. Use Pipecat's audited interruption/acknowledgment behavior as a reference, not a hidden Python service or copied competing runtime.

Retain the ordinary engine-plugin boundary so a production engine choice can change without moving telephony, storage, tools or behavior into the host. No local licensed LiveKit model is copied into the focused implementation.

## Limits

Text-only API viability does not establish streaming speech latency, VAD quality, STT revisions, TTS cancellation, carrier mark/clear fidelity or packet-loss behavior. A production engine decision must close those gates with actual audio and authorized integration tests. The current AI SDK adapter returns a completed single-step result; streaming output segmentation into live audio remains open work. Do not market local benchmark times as caller-perceived latency.
