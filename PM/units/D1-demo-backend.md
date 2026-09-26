# Work unit D1-demo-backend: Fixture test calls (real engine + real carrier serializer + templated FixtureNet providers, isolated in a child process), call stream/evidence/filter APIs, latency breakdown, outcome telemetry, worker session and telemetry ownership

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [20, 19]

## Owned paths

- packages/fixture-calls/**
- packages/plugin-observability/**
- apps/api/src/index.ts
- apps/api/src/test-call-runtime.ts
- apps/api/src/recording-runtime.ts
- apps/api/src/routes/test-calls.ts
- apps/api/src/routes/performance.ts
- apps/api/src/routes/inspection.ts
- apps/api/src/routes/simulation.ts
- apps/api/tests/test-calls.test.ts
- apps/api/tests/performance-route.test.ts
- apps/api/tests/script-simulation.test.ts
- apps/worker/src/production-session-factory.ts
- apps/worker/src/production-session-support.ts
- apps/worker/src/session-graph-*.ts
- apps/worker/src/speech-cache-runtime.ts
- apps/worker/src/cached-media-player.ts
- apps/worker/src/call-recorder.ts
- apps/worker/src/recording-runtime.ts
- apps/worker/src/recording-evidence.ts
- apps/worker/src/session-recording.ts
- apps/worker/src/session-lifecycle.ts
- apps/worker/src/live-input-policy.ts
- apps/worker/src/telemetry-*.ts
- apps/worker/tests/telemetry-runtime.test.ts
- apps/worker/tests/telemetry-stages.test.ts
- apps/worker/tests/production-session-lifecycle.test.ts
- apps/worker/tests/production-engine-selection.test.ts
- apps/worker/tests/native-extension-pins.test.ts
- apps/worker/tests/session-recording.test.ts
- apps/worker/tests/speech-cache-runtime.test.ts
- scripts/baselines/pending/D1.json

## Shared touchpoints (minimal edits allowed)

- none

## Checker notes (2026-09-26)

- F4's [wave-2 owner map](F4-apps-data-driven.md) assigns `apps/api/src/release-simulation.ts` to D1 even though this unit's owned-path list and design §15.5 omit it. The checker authorized the F4 owner map as the governing shared-touchpoint list. D1 changes only the selected voice-LLM simulation path there; I1 inherits this shared file at integration.
- The selected live carrier can negotiate PCM16 media. D1 now validates the negotiated worker-media format and passes it into the session graph, while the old gateway path retains its μ-law default. C2's unmerged worker link and recording capture provide the actual PCM16 format and recording support; the production test uses a capture stub until D1 rebases onto C2 and reruns the integrated recording path.
- A default agent caller must wait for confirmation playback before speaking `yes`, but the current fixture STT template can emit its scripted `yes` transcript as soon as the first audio frame arrives. D1 currently fails closed for default-agent confirmed-write calls while an owned playback-gated replay adapter is investigated; the latest ruling does not permit frozen fixture-contract or kit edits. The caller clock test proves its audio timing only; it does not prove a completed write. D1 must add a selected-engine, delayed-prompt write regression after that seam lands.
- The spec names `apps/api/tests/test-calls.test.ts` as D1-owned, but the production-entry test scenarios exceed the 500-line test gate when kept in one file. `apps/api/tests/test-call-inspection-runtime.test.ts` is the minimal split, tests the same D1 surfaces, and is recorded for I1 as a shared test touchpoint. No application behavior moved with the split.
- The current builder ruling permits edits under this unit's owned package, including removal of its `ovo.skeleton` flag. That metadata change is included; it does not activate runtime code and is not presented as a behavioral true negative.
- The 2026-09-26 user ruling requires local structural adapters instead of frozen contract/kit edits. D1 now implements its cache/streaming carrier output in owned `session-graph-speech-{output,buffer}.ts`, removes the last `plugin-voice` implementation import, and preserves the v1 compatibility path. Negotiated media format, bounded prefetch in both branches, one carrier send queue, epoch cancellation, and accepted weak-evidence provenance are covered through the composed v2 host output. E2 integration must still prove the complete engine path.
- On 2026-09-26 the checker explicitly authorized `apps/api/tests/real-llm-release.test.ts` to add only the required `carrierMedia.format: MULAW_8K` fixture field (plus its import). All assertions remain intact; production format requirements remain strict. I1 inherits this shared fixture correction.
- The frozen `CarrierIngress` type has no fixture-frame encoder, but D1 must feed each selected carrier's real serializer through the fake carrier driver. D1 now accepts a per-call `createFixtureFrameEncoder()` structural extension from the selected ingress, falling back only for the conformance carrier. The production child resolves this method after composing the selected carrier; C1, C3 and C4 own their protocol-faithful encoders. I1 owns the shared-contract decision after those carrier plugins land. A vendor-prefixed serializer regression fails against the previous D1 code with `selected vendor has no inbound frame builder` and passes with the adapter.
- The F4/C2 production lifecycle tests still require the worker telemetry close call to carry `(legacyOutcome, reason)`. D1 retains that two-argument call and an overload in the split `telemetry-session.ts`; the persisted outcome is always recomputed from the typed `EndReason`, so the legacy argument cannot override it. I1 inherits removal of the compatibility argument once every caller has migrated.
- The fixture-template paragraph below says to render every selected provider's scripts up front from `agentTexts`. That conflicts with a selected LLM's actual generated reply: an eager TTS script can mismatch the synthesis request or remain unconsumed. D1 renders selected TTS templates when the engine has emitted `agent.transcript.generated` and the matching synthesis request arrives. Each activated template still runs through strict FixtureNet and `assertComplete`; unsynthesized predicted text creates no script. Selected STT and LLM templates retain their setup rendering.

## Specification

GOAL: make the founder demo possible without real calls or paid traffic. The same agent runs a voice 'test call' that exercises the SELECTED real engine and the SELECTED real carrier's wire protocol, with providers replaying doc-faithful fixtures rendered from each provider's own templates. The call can then be inspected with its transcript, recording, latency breakdown and cost. This unit also finishes the telemetry side of #20 (outcome from a typed EndReason instead of reason.includes('completed')) and fixes the #19 site in observability.

Read docs/architecture/plugin-platform.md (revision 2):

- section 12 (normative);
- section 2.3 (FixtureTemplate);
- section 2.6 (EngineEvent);
- section 4.5 (the 'test' stage: meter_uncovered is a warning);
- section 4.6 (selectSessionGraph, host format adapters).
  session-host, distribution (with fixtureTemplates), plugin-kit (createFixtureNet) and @winsendotai/ovo-conformance/drivers (the fake carrier driver, fixture-kind plugins; no vitest) are frozen and ready. F3 created the skeleton packages/fixture-calls; fill it and remove the ovo.skeleton flag. F4 registered a stub routes/test-calls.ts and wired the worker session graph. You now own the listed worker session and telemetry files and the four HANDOFF worker tests.

A. packages/fixture-calls (host library, NOT a plugin; dependencies contracts, runtime, session-host, plugin-kit, audio and conformance, where only the './drivers' entry may be imported)
runFixtureCall({release | draft, registry, fixtures, fixtureTemplates, callerScript, clock?, recording?, telemetry}) → {callId, done: Promise<EngineOutcome>}:

1. Normalize the agent config and run validateSelections at stage 'test', adding 'fixture_unavailable' when a selected stt, tts, llm or carrier has neither fixtureTemplates nor fixtures. Refuse to run on errors. meter_uncovered is only a warning here.
2. Build the session graph with selectSessionGraph(..., {fixtures: true}). Every plugin's ctx.net is a FixtureNet (plugin-kit createFixtureNet).
   - For each selected stt, tts or llm plugin, render fixtureTemplates[pluginId]({format, language, sessionId, turns from the callerScript, agentTexts, tools}) into scripts.
   - Only if a template is missing, fall back to the plugin's static fixtures. If those are missing too, fall back to the conformance fixture-kind stt and tts plugins, and record it in the call evidence as sttMode 'fixture-generic'.
   - Record the sttMode actually used ('template' | 'static' | 'fixture-generic').
3. Media: a MediaDuplex whose far end is the conformance fake carrier driver, using the selected carrier's REAL MediaSerializer from its ingress. Encode and decode real frames with a playback clock that echoes marks per that carrier's capabilities, so Exotel chunking and Plivo checkpoints are really exercised.
4. The recording tap writes both tracks through the API recording runtime ONLY if config.recording is true.
5. Telemetry, transcript, speech and timing events flow into the normal telemetry pipeline. Usage uses the selected providers' meter keys and is marked estimated; uncovered meters are 'unpriced'. Budgets and reservations are never touched. The call row has kind 'test' (migration 004 allows it).
6. Never call carrier REST control, never dial, and require no live flags.
   CallerScript = {turns: [{atMs, say?: string, dtmf?: string, silenceMs?}]}, with a 'default' script per mode:

- announcement: listen;
- FAQ: two questions;
- agent: a question that triggers a confirmed write tool, then 'yes'.

B. API (apps/api)

- test-call-runtime.ts: enabled only when OVO_FIXTURE_TEST_CALLS=true. The default is true when NODE_ENV !== 'production' and false otherwise; Compose sets it explicitly. Otherwise the routes return 404 with code 'fixture_calls_disabled'.
  - In the server, fixture calls run in a CHILD PROCESS: fork(process.argv[1], ['--ovo-fixture-call-child']) with IPC events, at most 2 concurrent, and a 120 s wall timeout. apps/api/src/index.ts (yours) branches on that flag to run the child loop instead of the HTTP server. LiveKit and sharp native code therefore never run inside the control-plane process.
  - Unit tests run in process (an option on the runtime).
- routes/test-calls.ts (replace F4's stub; don't touch the registry): POST /v1/agents/:id/test-calls {useDraft?: boolean, releaseId?: string, callerScript?: 'default' | CallerScript} → 202 {callId}. The editor role is required. Idempotent with an Idempotency-Key header.
- routes/performance.ts: send the SSE heartbeat as a NAMED event ('event: heartbeat' with data {} every 15 s) instead of a comment.
- routes/inspection.ts:
  - GET /v1/calls/:id/stream: SSE events transcript.user.interim, transcript.user.final, transcript.agent.generated, transcript.agent.played, turn, timing, speech and end, plus the named heartbeat. Supports ?cursor= replay by sequence.
  - GET /v1/calls/:id/evidence → {call, selections (with the resolved versions), transcript[], latency: LatencyBreakdown[], cost: {estimated, reconciled, unpriced, lines[]}, recording?, events[], sttMode?}.
  - GET /v1/calls: expose the filters agentId, engine, carrier, kind and status (F3 added them to the storage repository), plus order and cursor.
- routes/simulation.ts: keep the existing text simulation behaviour, and share the transcript projection.
- recording-runtime.ts: the fixture recording path.

C. Observability (packages/plugin-observability)

- latency-breakdown.ts (≤250 lines): subscribes to EngineEvents. Per turn it produces {turnId, measuredFrom: 'user_silence' | 'call_start', totalMs, parts: [{key, ownerKind: 'service' | 'setting' | 'pipeline' | 'carrier', ms}], interrupted}, and the parts sum to the total.
- The telemetry outcome projection uses outcomeFor(EndReason) from contracts, never substring matching (#20).
- The transcript projection stores user interim and final, and agent generated, played and interrupted events, for the stream and evidence endpoints.
- telemetry-validation.ts: use canonicalJson from contracts, not localeCompare (#19).
- worker-telemetry-adapter.ts: remove the plugin-voice type import (the types come from contracts). This removes the observability → voice edge.
- pricing.ts stays the F1 re-export of the contracts pricing module.

D. Worker session and telemetry (the listed apps/worker files)

- Consume EngineEvents; emit the transcript and timing telemetry events; set the outcome via outcomeFor.
- telemetry-runtime.ts (396 canonical lines) must be split below 300.
- Remove the remaining plugin-voice imports from these files (use contracts types).
- Keep the F4 v1-engine compatibility path. The HANDOFF tests production-engine-selection, native-extension-pins and session-recording keep their assertions and messages unchanged, and apps/api/tests/voice-engine-release.test.ts (frozen) must stay green.

TESTS:

- packages/fixture-calls/tests:
  - a fixture call runs with the conformance fixture providers, fixtureCarrierIngress and a fake engine, and produces transcript, timing and speech events and an outcome;
  - templates are preferred over static fixtures, and sttMode is recorded;
  - recording rows exist only when config.recording is true;
  - a missing fixture → fixture_unavailable;
  - meter_uncovered does not block;
  - no socket is opened (egress sentinel);
  - the budget and reservation ports are never called.
- apps/api/tests/test-calls.test.ts: disabled in production → 404; enabled → 202 and the stream shows transcript events; the evidence has selections, latency and cost; the call list filters work; the child-process runner is exercised with a trivial fake child (or is skipped with a reason if forking is unavailable in vitest).
- performance-route.test.ts: the named heartbeat event.
- Observability: latency parts sum to the total; caller_hangup → caller_ended; telemetry-validation key ordering with non-ASCII keys.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen: session-host, distribution, conformance, plugin-kit, apps/api/src/api-plugin.ts and routes/registry.ts, and every package.json (apps/api already depends on fixture-calls).
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/D1.json.
- Done = scoped lint, typecheck and tests green, plus the HANDOFF tests.

CONSTRAINTS:

- Fixture calls must never reach external networks or carrier REST, and never run in production unless explicitly enabled.
- Honour release.config.recording.
- Do not import vendor plugin packages; everything comes through the registry.
- Modules ≤300 lines. No git commits.

## Acceptance

- runFixtureCall exercises the selected engine and the selected carrier's real MediaSerializer with FixtureNet providers rendered from their fixture templates (with the fallbacks recorded as sttMode). It opens no sockets, never touches budgets or carrier REST, and emits transcript, timing, speech and end events with a typed outcome.
- POST /v1/agents/:id/test-calls works when OVO_FIXTURE_TEST_CALLS is enabled and returns 404 fixture_calls_disabled otherwise. Server-side runs are isolated in a child process, and call rows use kind 'test'.
- GET /v1/calls/:id/stream emits the transcript and timing events plus a named heartbeat. GET /v1/calls/:id/evidence returns selections with the resolved versions, transcript, latency, cost (estimated, reconciled, unpriced) and recording info. GET /v1/calls supports the filters.
- Latency breakdown parts sum to the total. The telemetry outcome uses outcomeFor, so a caller hangup is not recorded as failed. telemetry-validation uses canonicalJson, and observability no longer imports plugin-voice.
- telemetry-runtime.ts is below 300 lines. The HANDOFF engine-selection, native-extension-pins, session-recording and voice-engine-release tests stay green. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/fixture-calls packages/plugin-observability apps/api/src/index.ts apps/api/src/test-call-runtime.ts apps/api/src/routes/test-calls.ts apps/api/src/routes/performance.ts apps/api/src/routes/inspection.ts apps/api/src/routes/simulation.ts apps/worker/src/production-session-factory.ts apps/worker/src/telemetry-runtime.ts apps/worker/src/telemetry-stages.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/fixture-calls packages/plugin-observability apps/api/src/index.ts apps/api/src/test-call-runtime.ts apps/api/src/recording-runtime.ts apps/api/src/routes apps/api/tests/test-calls.test.ts apps/worker/src apps/worker/tests`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/fixture-calls packages/plugin-observability apps/api/tests/test-calls.test.ts apps/api/tests/performance-route.test.ts apps/api/tests/script-simulation.test.ts apps/worker/tests/telemetry-runtime.test.ts apps/worker/tests/telemetry-stages.test.ts apps/worker/tests/production-session-lifecycle.test.ts apps/worker/tests/speech-cache-runtime.test.ts --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run apps/api/tests/voice-engine-release.test.ts apps/worker/tests/production-engine-selection.test.ts apps/worker/tests/native-extension-pins.test.ts apps/worker/tests/session-recording.test.ts --reporter=dot`
