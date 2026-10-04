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

- Both `packages/plugin-storage/src/{postgres,sqlite}/{calls,releases}-repository.ts`, their migration runners, the new Postgres `migrations/006-fixture-snapshots.ts`, and storage tests: explicitly authorized for private draft snapshots and atomic fixture call/fingerprint admission on 2026-09-27.
- `apps/api/tests/fixture-admission.test.ts` and `fixture-admission-support.ts`: the authorized durable admission regressions split to respect module limits; I1 inherits these shared test paths.
- `apps/api/tests/test-call-inspection-runtime.test.ts`: the earlier approved API test split; `apps/api/tests/real-llm-release.test.ts`: required `MULAW_8K` fixture field/import only, with all assertions preserved. I1 inherits these tests.
- `apps/api/src/release-simulation.ts`: the F4 owner-map ruling assigns the selected voice-LLM simulation path to D1; I1 inherits it.
- New `scripts/seed-demo-price-cards.mjs` only: explicitly approved on 2026-09-27 to satisfy design §18.10. No existing script, lint/check/CI wiring or dependency changes are authorized by this exception; I1 inherits the manual seed entry.

## Checker notes (2026-09-26)

- F4's [wave-2 owner map](F4-apps-data-driven.md) assigns `apps/api/src/release-simulation.ts` to D1 even though this unit's owned-path list and design §15.5 omit it. The checker authorized the F4 owner map as the governing shared-touchpoint list. D1 changes only the selected voice-LLM simulation path there; I1 inherits this shared file at integration.
- The selected live carrier can negotiate PCM16 media. D1 now validates the negotiated worker-media format and passes it into the session graph, while the old gateway path retains its μ-law default. C2's unmerged worker link and recording capture provide the actual PCM16 format and recording support; the production test uses a capture stub until D1 rebases onto C2 and reruns the integrated recording path.
- A default agent caller must wait for confirmation playback before speaking `yes`, but the frozen STT templates emit all turns on the first audio frame. The latest ruling forbids frozen fixture-contract/kit edits. D1 now uses an owned structural replay adapter that retains provider wire assertions and releases each transcript only with its actual caller turn. Only explicitly scripted caller hangup may omit a validated finish/metadata/normal-close tail, after every caller frame has been delivered; earlier mismatches stay fatal. I1 inherits the missing fixture delivery/cancellation contract. The selected-engine regression passes with the E2 candidate and remains red on the current F4 engine, which discards `yes` as a backchannel; the candidate diagnostic is not a normal D1 green bar.
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

## Builder checkpoint — 2026-09-26: fixture replay and persistence failures

No frozen contracts, conformance kit, host, or storage file changed. The owned
STT replay implementation infers turn boundaries by rendering successive template
prefixes. It retains wire payloads and strict FixtureNet request validation;
nonmonotonic templates and static-only confirmed-write STT are refused explicitly.
The generic and Deepgram provider clients both withhold the final `yes` through a
10-second delay, then deliver it on the released turn. Initial provider messages
wait for listeners. Unsupported shutdown shapes have no cancellation exemption.

`packages/fixture-calls/tests/native-fixture-call.test.ts` exercises the actual
native engine, behaviors, fixture LLM/STT/TTS and carrier serializer. It records
played confirmation < final `yes` < exactly one actual fixture handler execution,
requires the second LLM request to carry one tool result, requires `All done.` to
finish playback, and observes zero live handler calls. The E2 candidate source
was temporarily overlaid for this diagnostic and immediately reversed; it passed
1/1. D1's base still contains the F4 engine, which discards confirmation `yes`.
This dependency remains visible in the normal suite, without a skip or alias.

| Deliberately broken implementation                                 | Failure with the new assertion                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Deliver future STT turns immediately                               | Generic and Deepgram: `expected [ 'Please do that.', 'yes' ] to deeply equal [ 'Please do that.' ]` |
| Drain initial messages before any listener                         | `expected [] to deeply equal [ 'ready' ]`                                                           |
| Exempt an unsolicited engine cancellation                          | `expected [Function] to throw an error`                                                             |
| Exempt explicit abnormal close codes 1005/1006/1011                | Three failures: `expected [Function] to throw an error`                                             |
| Discard a prior wire mismatch when accepting scripted cancellation | `expected [Function] to throw an error`                                                             |
| Permit a shutdown tail without a terminal normal close             | `expected [ 3 ] to deeply equal [ undefined ]`                                                      |

The public fixture runner now observes telemetry and recording callback promises
immediately, catches synchronous callback failures, and races persistence failure
against engine startup and active execution. Successful effects still drain before
recording completion. Each cleanup is attempted even when another throws, and the
original persistence error is preserved. It also observes teardown-time effects.

Against the previous `execute.ts`, seven callback cases failed: asynchronous event,
usage and recording failures left the call `still running`; synchronous failures
escaped their trigger; cleanup timed out with an unhandled rejection. Narrow
mutations separately reproduce a pending startup (`still running` instead of
`startup event refused`), premature recording completion (finish count 1 instead
of 0), and replacement of the original error with `engine cleanup failed`.

Exact focused commands (Node 22, normal dependency configuration):

```sh
pnpm exec vitest run packages/fixture-calls/tests/stt-replay.test.ts packages/fixture-calls/tests/stt-replay-cancel.test.ts packages/fixture-calls/tests/default-script.test.ts --reporter=dot
pnpm exec vitest run packages/fixture-calls/tests/callback-failure.test.ts packages/fixture-calls/tests/run.test.ts packages/fixture-calls/tests/child-runtime.test.ts --reporter=dot
node scripts/typecheck-scope.mjs packages/fixture-calls
```

The replay/default-script command passed **21/21**, independently reproduced. The
callback/run/child command passed **29/29**; typecheck passed. Mutation logs are
`/tmp/ovo-d1-stt-*-red.log` and `/tmp/ovo-d1-callback-*-red.log`; the separate
candidate engine diagnostic is `/tmp/ovo-d1-native-with-e2-probe.log`.

D1 remains **In progress**. Shared storage scope for draft snapshots and atomic
call/fingerprint creation is pending. That proposal uses local structural types;
no frozen `ControlStore` change is needed. The normal full bar including Postgres
must be rerun after those decisions and E2/C2 integration. No complete demo or
Built status is claimed by this checkpoint.

### Normal checkpoint bar (2026-09-26)

With the temporary E2 source overlay removed, `pnpm exec vitest run --reporter=dot`
exits 1: **1,358 passed / 139 skipped / 1 failed**, 1,498 total. The sole failure
is the new native-engine fixture regression: final `yes` index is -1 while played
confirmation is index 16 (`expected -1 to be greater than 16`). It exposes the
F4 engine dependency described above and remains enabled.

The exact scoped lint command in Verify commands and `pnpm format:check` both
exit **0 / 0**; `pnpm typecheck` and standalone
`node scripts/check-duplication.mjs` exit 0. No baselines changed. Independent
callback review ran `pnpm exec vitest run packages/fixture-calls/tests/callback-failure.test.ts packages/fixture-calls/tests/child-runtime.test.ts --reporter=dot`:
**12 passed / 0 failed**, and found no remaining concrete blocker in that delta.
Logs: `/tmp/ovo-d1-current-default.log`, `/tmp/ovo-d1-checkpoint-{lint,format,typecheck,duplication}.log`.

No final Postgres run or full green bar is claimed for this WIP checkpoint; both
remain required after the pending storage work and normal E2/C2 integration.

## Builder checkpoint — 2026-09-27: durable draft admission

This checkpoint supersedes the historical pending storage scope and E2-overlay
limitations above. The checker explicitly allocated control migration **006 to
D1**, requiring M1's paused `006-mcp-tool-removed` migration to become 007 when M1
resumes. The 2026-09-27 local-branch scan found only D1's fixture snapshot 006 and
M1's conflicting 006 (`w2/M1` head `dc9f471`); no other 006/007 claim was found.
M1's branch was not edited. PostgreSQL was at 005; SQLite's version 4 already
supports test calls, so its version 5 parity marker verifies that existing kind
invariant before recording 005. Both runners then apply 006. Per-migration
contiguity hardening remains I1's separate obligation.

The approved repositories now store a fixture snapshot with purpose
`fixture-snapshot`; existing releases retain `published`. Public get/list and
non-test call admission reject fixture snapshots. A partial unique index leaves
the normal published draft slot available. Snapshot, test call and sequence-1
`fixture.request` fingerprint commit in one transaction. PostgreSQL serializes
same workspace/call IDs with a transaction advisory lock; SQLite uses its existing
immediate transaction. Changed fingerprints fail with `idempotency_conflict`.
Current-draft, voice-binding and MCP guards run inside that same transaction.
Declared binding plugin IDs and kinds must match the selected plugin/role even
when updatedAt is unchanged. Legacy null kind/plugin identity remains allowed;
the independent real API + production selection probe verifies both refusal of
a same-tick identity swap and acceptance of the normal legacy-null case.

D1's local `FixtureAdmissionStore` in `apps/api/src/test-call-runtime.ts` consumes
these dynamically bound repository methods without editing frozen `ControlStore`.
The successful transaction returns the immutable selected release, so runtime
startup needs no postcommit snapshot lookup. Local in-flight coalescing happens
before capacity reservation, while durable storage still arbitrates requests
from separate processes. Startup telemetry failure cancels the local reservation
and persists a failed call instead of leaving a running orphan.

The API draft proof uses actual distribution discovery and production release
selection, captures the immutable runtime snapshot, edits the draft afterward,
and verifies the durable snapshot remains unchanged and unavailable through public
release APIs. Its injected executor is safe; actual native engine and carrier
execution is separately measured by the public fixture runner test. It does not
claim execution of the paused vendor carriers.

### Minimal extraction and I1 carry-forwards

| Owner | Exact paths / obligation                                                                                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1    | `apps/api/tests/fixture-admission.test.ts` and `fixture-admission-support.ts`: explicitly authorized durable API tests split from the existing inspection/runtime test to meet module limits.                                                               |
| I1    | `apps/api/src/test-call-runtime.ts` local `FixtureAdmissionStore`: formalize the fixture-only structural capability after frozen contracts reopen; preserve test-scoped snapshot access and atomic admission.                                               |
| I1    | `packages/fixture-calls/src/child-runtime.ts`: the existing IPC class/protocol moved from the owned API runtime into the owned package to meet module limits; the API re-exports retain its callers. No child protocol behavior changed in this extraction. |
| M1    | Rename its paused control migration from 006 to 007 on resumption. Do not backfill another meaning into D1's allocated 006.                                                                                                                                 |
| I1    | Retain the telemetry persisted-value release/operator note below; no hash backfill is part of D1.                                                                                                                                                           |

The duplicate fixture intent/scope validation is shared through the already
approved Postgres calls repository and imported by the SQLite repository. No new
production storage helper path or duplication baseline was introduced.

### True-negative evidence

Every row below restores the implementation after its probe. Filtered mutant
runs intentionally skip nonmatching tests; those skips are not disabled tests or
the database-gated default-suite count.

| Deliberately broken path                                           | New assertion's actual failure                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original API rejects draft and separates call/event writes         | Draft returns 422 `draft_snapshot_required` instead of 202; identical concurrent request returns 409 `idempotency_conflict` instead of 202.                                                              |
| Original pretransaction capacity admission                         | Identical concurrent request returns 429 `fixture_calls_capacity` instead of remaining pending and sharing the first admission.                                                                          |
| Remove transaction rollback from either repository                 | Initial-event trigger refuses the write, but releases count is 1 instead of 0 (one failure per backend).                                                                                                 |
| Remove published-purpose filter from either release reader         | Public `getRelease` returns the private snapshot instead of `undefined` (one failure per backend).                                                                                                       |
| Change only pluginId or kind within the same Date tick             | All four old-code cases (two fields × two databases) accept `{created:true,...}` instead of rejecting `binding_conflict`; declared identity now matches selected plugin/role independently of updatedAt. |
| Remove either voice-binding snapshot guard                         | Changed binding admission resolves `{created:true,...}` instead of rejecting with `binding_conflict` (one failure per backend).                                                                          |
| Give migrated old rows fixture-snapshot purpose                    | Existing populated published release becomes `undefined` instead of matching its prior record (one failure per backend).                                                                                 |
| Remove fingerprint equality guard                                  | Changed payload resolves `{created:false,...}` instead of rejecting with `idempotency_conflict` (two backend failures).                                                                                  |
| Reintroduce postcommit fixture-release lookup                      | Injected lookup failure produces HTTP 500 `postcommit lookup failed` instead of 202 and a launched job.                                                                                                  |
| Move startup telemetry outside guarded startup                     | Runtime reservation remains active (1 instead of 0); the restored implementation cancels it and persists failed status.                                                                                  |
| Remove the worker factory's `speechCache: this.speechCache` wiring | Both native 8k/16k cases synthesize twice: `expected vi.fn() to be called once, but got 2 times`.                                                                                                        |

Separate isolation mutations avoid mistaking an early reader assertion for proof
of later guards:

| Narrow isolation mutation                                               | Actual failure                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove only listReleases purpose filter, each backend                   | Private row returned: `expected [ { … } ] to deeply equal []`.                                                                                                                                                    |
| Remove the common non-test createCall purpose predicate, each backend   | The live call promise resolves instead of rejecting `Release is unavailable`; the unchanged positive test also checks simulation.                                                                                 |
| Remove createFixtureCall's published-source purpose guard, each backend | A snapshot supplied as releaseId resolves instead of rejecting `not_found`.                                                                                                                                       |
| Remove only partial unique-index predicate, each backend                | Publishing after a fixture snapshot fails: SQLite `UNIQUE constraint failed: releases.workspace_id, releases.agent_id, releases.draft_version`; PostgreSQL `This draft version already has an immutable release`. |
| Remove SQLite's published-only duplicate lookup                         | Publishing after the snapshot throws `This draft version already has an immutable release`.                                                                                                                       |

The stale-draft and wrong-agent assertions preserve pre-existing guards; they
are not represented as newly added safeguards. Same-timestamp binding logs are
`/tmp/ovo-d1-binding-identity-{red,green}.log`; isolation logs are
`/tmp/ovo-d1-isolation-*-red.log`.

Logs are `/tmp/ovo-d1-admission-current-red.log`,
`/tmp/ovo-d1-local-admission-red.log`,
`/tmp/ovo-d1-admission-{sqlite,postgres}-{atomic,private,binding,upgrade}-red.log`,
`/tmp/ovo-d1-admission-{fingerprint,lookup,prestart}-red.log`, and
`/tmp/ovo-d1-native-cache-wiring-{red,green}.log`.

### Independent production measurements

The normal native fixture test now passes 1/1 after E2 landed, with no alias or
source overlay. It requires played confirmation before final `yes`, exactly one
fixture handler invocation, a second LLM request carrying that result, final reply
playback, zero live handler calls, and strict fixture shutdown. The real
`ProductionVoiceSessionFactory` plus E2 engine cache test passes both 8k/16k cases
under the egress sentinel, with one synthesis across two sessions per format.
The separate bounded output tests retain prefetch, send ordering, PCM sample
carry, failure cancellation, shared producer survival and evidence provenance.
These discharge the E2 cache prepare/pipeline/evidence carry-forwards for D1.

The root independently ran the normal worker/native/simulation HANDOFF scope:
10 files, **36 passed / 0 failed**, including selected voice-LLM simulation and
unchanged HANDOFF `voice-engine-release`; log `/tmp/ovo-d1-root-worker-handoff.log`. This
supports discharge of the F4/M2 selected voice-LLM simulation obligation. The
new durable snapshot/admission tests discharge the draft snapshot obligation.
No alternate build, fixture alias, disabled regression or new baseline is used.

### Persisted-value release/operator note (retained)

D1's observability change from locale-sensitive sorting to contracts
`canonicalJson` changes persisted telemetry hash values when key ordering differs,
including mixed-case and non-ASCII payload keys. `telemetryEventHash` is stored in
`ovo_telemetry_events.event_hash`. Replaying an affected old event with the same
identity now increments the conflict count rather than the duplicate count;
the existing event and projections are retained. No hash backfill is included.
I1 must retain this release note when integrating D1. The current manifest change
does not change stored values.

### E2 integration duplication cleanup

The standalone repository duplication command initially failed after E2 landed:
D1's worker prefetch queue and E2's engine prefetch queue shared 43 token windows.
The earlier scoped storage lint did not cover that worker pair. D1 replaced only
its owned buffer with fixed-capacity byte-ring storage and transition broadcasts,
keeping the host's detachable shared-cache producer behavior. This changes the
actual buffer implementation, not names or gate thresholds. The new direct tests
exercise wraparound and byte ownership, exact capacity backpressure, abort wakeup
without a consumer, and detaching playback while shared synthesis may finish.
All existing cache transport and real native cache checks remain enabled.

| Ring safety mutation                    | Actual assertion failure                                  |
| --------------------------------------- | --------------------------------------------------------- |
| Return early when storage is full       | Producer is already settled: `expected true to be false`. |
| Remove blocked-producer abort wakeup    | `expected 'still blocked' to be 'aborted'`.               |
| Keep unread playback bytes after detach | Iterator still yields: `expected false to be true`.       |

Logs: `/tmp/ovo-d1-ring-{capacity,abort,detach}-red.log` and
`/tmp/ovo-d1-ring-cache-green.log` (21/21). I1 inherits consolidation of bounded
prefetch semantics into a future shared API; no frozen kit, engine implementation
import or baseline change was used.

### Current scoped checkpoint commands and counts

All commands use Node 22 and normal dependency resolution from the D1 worktree.
The Postgres URL is the disposable `postgres:17.6` container
`ovo-d1-admission-0927`, bound only to loopback. Its isolated test schemas are
removed by the harness; the idle container is handed to the root builder for the
exact-merge whole-repo serial run and removal.

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
OVO_TEST_POSTGRES_URL=postgresql://postgres:fixture@127.0.0.1:32902/postgres pnpm exec vitest run packages/plugin-storage/tests/fixture-admission.test.ts packages/plugin-storage/tests/postgres.test.ts packages/plugin-storage/tests/f3-postgres.test.ts apps/api/tests/fixture-admission.test.ts apps/api/tests/test-calls.test.ts apps/api/tests/test-call-inspection-runtime.test.ts packages/fixture-calls/tests/child-runtime.test.ts --reporter=dot --no-file-parallelism
pnpm exec vitest run packages/fixture-calls/tests/prefetch-buffer.test.ts packages/fixture-calls/tests/cache-transport.test.ts packages/fixture-calls/tests/worker-speech-cache.test.ts packages/fixture-calls/tests/native-worker-cache.test.ts apps/worker/tests/speech-cache-runtime.test.ts --reporter=dot
pnpm lint:scope packages/plugin-storage packages/fixture-calls apps/api/src/routes/test-calls.ts apps/api/src/routes/inspection.ts apps/api/src/test-call-runtime.ts apps/api/tests/fixture-admission.test.ts apps/api/tests/fixture-admission-support.ts apps/api/tests/test-call-inspection-runtime.test.ts apps/api/tests/test-calls.test.ts apps/worker/src/session-graph-speech-buffer.ts
pnpm typecheck:scope packages/plugin-storage packages/fixture-calls apps/api/src/test-call-runtime.ts apps/api/src/routes/test-calls.ts apps/api/src/routes/inspection.ts apps/api/tests apps/worker/src/session-graph-speech-buffer.ts
pnpm format:check
node scripts/check-duplication.mjs
git diff --check
```

The serial storage/API/child command passes **49/49**, seven files, exit 0. The
cache command passes **21/21**, five files, exit 0. Independent storage review
reran the storage/API pair **22/22** (8 SQLite, 8 Postgres, 6 API) and reproduced
the actual same-tick binding PUT refusal plus the normal legacy-null positive.
The library, source, test and migration paths were audited for ignored files;
no intended source is hidden by `.gitignore`.

The root's normal default command before the byte-ring cleanup passed
**1,474 / 147 skipped / 0 failed** (1,621 total), proving the old E2 dependency
failure is gone. This is explicitly a pre-cleanup measurement. The final normal
full check, exact-merge default count and whole-repo serial Postgres run remain
required and belong to the root builder; this scoped checkpoint is not a Built
or checker verification claim.

Operator action for affected historic telemetry replay conflicts: investigate
against the retained original event and projections. Do not overwrite stored
hashes or backfill them as part of D1.

Final checkpoint hygiene: scoped lint **exit 0** (seven gates), scoped typecheck
**exit 0** (no diagnostics), full `pnpm format:check` **exit 0**, standalone
`node scripts/check-duplication.mjs` **exit 0** (818 source files; 57 existing
baseline pairs), and `git diff --check` **exit 0**. Independent ring/cache review
reproduced **21/21** and additionally verified terminal-error drain and wakeup.
No baseline changed. Logs: `/tmp/ovo-d1-admission-final-{postgres,lint,type,format,duplication}.log`.

## Checker note — 2026-09-27: manual illustrative price-card seed

Design §18.10 explicitly requires `scripts/seed-demo-price-cards.mjs`, while the
unit ownership list omitted it and scripts are otherwise frozen. The checker
approved this **new file only**. It has no dependencies beyond Node's URL helper,
is not referenced by any existing script or CI/gate, and never runs automatically.
The permanent owned `packages/fixture-calls/tests/demo-price-cards.test.ts` only
imports its pure preview builder, verifies import has no side effects and checks
native-unit arithmetic. That test never invokes the CLI or creates price cards.
I1 inherits this approved script exception and the requirement to keep seeding
manual and the persisted labels intact.

The default invocation prints a preview and makes zero requests. Mutation requires
both `--apply` and an explicit literal-loopback API origin plus `OVO_ADMIN_TOKEN`.
The CLI POSTs the real strict cost API schema with string money, deterministic
identities/effective timestamps, and **ILLUSTRATIVE — NOT A QUOTE** in both version
and persisted provenance. It invents 100 paise per 1000 native units solely for
demo arithmetic. It changes no release pins, budgets or vendor settings. Existing
meter references remain unpriced until an operator explicitly selects a card.
Redirects are refused, HTTP error bodies and credentials are not printed, and
immutable-catalog conflicts stop the script without overwriting existing cards.
If a later write fails, prior cards may remain; deterministic identities make a
repeat of the same seed idempotent through the ledger.

Manual proof (not installed as a test/gate) runs the actual CLI against real
`registerCostRoutes` plus `PostgresCostLedger`, listening only on loopback and
using an isolated disposable-Postgres schema. Exact commands:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm exec vitest run packages/fixture-calls/tests/demo-price-cards.test.ts --reporter=dot
PATH=/opt/homebrew/opt/node@22/bin:$PATH OVO_TEST_POSTGRES_URL=postgresql://postgres:fixture@127.0.0.1:32902/postgres node --import ./scripts/register-sql.mjs --import tsx /tmp/ovo-d1-demo-seed-proof.ts
```

The pure-data test passes **1/1**, exit 0. The completed manual probe exits 0:
preview/missing opt-in/missing credentials each create zero requests; eight
labelled cards persist; repeating the CLI still leaves eight cards with 16 audited
puts. No redirect is followed and no token is logged. A conflicting existing
card returns HTTP 409 and retains its 999-paise value. The probe drops only its
own schema. Initial probe setup attempts failed on a missing SQL loader and a
foreign-key-protected TRUNCATE; neither is counted as passing evidence. The
completed probe uses the repository SQL loader and deletes only its isolated
empty-use catalog before the conflict case.

| Seed mutation                                    | Actual failure                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Bypass the opt-in preview branch                 | Manual probe observes 8 API requests instead of 0.                             |
| Replace the illustrative label with `Demo price` | Data test: `expected 'Demo price v1' to contain 'ILLUSTRATIVE — NOT A QUOTE'`. |
| Follow redirects                                 | Manual probe records 1 redirect destination request instead of 0.              |

All mutations were restored. Logs are
`/tmp/ovo-d1-demo-seed-data-green.log`, `/tmp/ovo-d1-demo-seed-proof-green.log`,
and `/tmp/ovo-d1-demo-seed-{opt-in,label,redirect}-red.log`. No real vendor or
paid request was made, and the manual seed is never invoked by lint, check or CI.

Independent seed review reproduced the pure-data **1/1** and real CLI/API/ledger
manual probe, both exit 0, with no remaining finding. Final seed scoped lint
(`pnpm lint:scope scripts/seed-demo-price-cards.mjs packages/fixture-calls`),
scoped typecheck (`pnpm typecheck:scope packages/fixture-calls`), full
`pnpm format:check`, standalone duplication and `git diff --check` all exit 0.
Only the new script, owned data-only test and documentation changed in this
follow-up; all previously reviewed source remains untouched.

## Final merged handoff — 2026-09-27

**Built – awaiting check**, merged after E2 at `043b310` on
`vorflux/ovo-foundation`. Source checkpoints rebased onto `6890b48` are
`1dc357e` (admission/cache) and `479ad7e` (the required opt-in seed).
Only a documentation conflict needed resolution during the final D1 rebase;
all received checker verdicts and E2/I1 obligations were retained. The D1
worktree was removed immediately after merge. No paused unit resumed or moved.

### Exact-merge full bar

All commands used `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` and the
normal dependency configuration. On exact merge `043b310`:

| Command                                                                                                                                                                                               | Result                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                                                                                                                                                          | **EXIT 0**: seven lint gates, full formatting, full typecheck, default tests, three application bundles, console production build, audit and Playwright |
| `pnpm test` within that check                                                                                                                                                                         | **1,478 passed / 147 skipped / 0 failed**; 1,625 total                                                                                                  |
| `OVO_TEST_POSTGRES_URL=postgresql://postgres:fixture@127.0.0.1:32902/postgres pnpm exec vitest run --no-file-parallelism --reporter=dot --reporter=json --outputFile=/tmp/ovo-d1-final-postgres.json` | **EXIT 0: 1,616 passed / 9 skipped / 0 failed**; 1,625 total                                                                                            |
| Playwright within `pnpm check`                                                                                                                                                                        | **41 passed / 1 skipped**; the mobile Menu is hidden at desktop width                                                                                   |

Arithmetic: **1,478 + 147 = 1,625**. Separately,
**1,616 + 9 = 1,625**. The Postgres run activates 138 database-gated tests;
none was disabled. The remaining nine comprise one ledger test requiring
`LEDGER_TEST_DATABASE_URL`, four recording tests requiring
`RECORDING_TEST_DATABASE_URL`, three restore-drill tests requiring
`OVO_BACKUP_DRILL_POSTGRES_URL`, and one worker lifecycle test additionally
requiring ElasticMQ. The latter is an infrastructure gate, not a database-only
skip. The JSON report was inspected per skipped case.

Logs: `/tmp/ovo-d1-final-merge-check.log`,
`/tmp/ovo-d1-final-postgres.log` and its JSON report. The team-owned disposable
`postgres:17.6` container `ovo-d1-admission-0927` was removed after verification;
no other project's container or database was touched.

### Acceptance and inherited obligations

| Acceptance                                                                     | Production evidence                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selected engine, provider fixtures and carrier serializer without live effects | Normal native fixture test requires confirmation playback before final yes, one fixture write-handler call, the result in the next LLM request, completed reply playback and zero live handler calls; egress sentinel and strict FixtureNet remain active |
| Child-process fixture API, durable draft and idempotency                       | Production route tests plus both real storage backends; atomic snapshot/call/initial event, pre-capacity coalescing, failure cleanup, hidden snapshots and preserved publication slots; independent admission review 22/22                                |
| Recording policy and call inspection                                           | Capture and durable metadata only when requested; paged stream/evidence, resolved selections, transcripts, latency, priced/unpriced usage and named heartbeat route tests pass                                                                            |
| Native worker cache and speech output                                          | Independent cache scope 21/21; real native 8 kHz/16 kHz sessions synthesize once across two calls, with bounded prefetch, ordered sends, cancellation and evidence checks                                                                                 |
| Typed outcomes, latency and canonical telemetry hashes                         | Observability and worker tests pass; telemetry module split meets size gates; persisted hash compatibility and operator action are recorded above                                                                                                         |
| Selected voice-LLM simulation                                                  | Real API simulation tests with selected LLMs pass; F4/M2 carry-forward discharged                                                                                                                                                                         |
| Optional demo price cards                                                      | New manual script, independent real CLI/API/Postgres proof: eight labelled rows, repeat stays eight, zero preview requests, redirects refused, conflicting value retained; no automatic seeding in any gate                                               |

The true-negative tables above record the broken versions and observed failure
messages. Independent reviewers closed the admission, binding-identity, byte-ring
and seed-script findings. Full integration of paused carrier fixture encoders,
C2's live PCM16 recording path and later I1 contracts remains explicit in the
carry-forward table; no real provider/carrier traffic or deployment was tested.
The frozen normalizer immutability defect remains **BLOCKING I1**. D1 owns
control migration **006**; M1 must use **007** after rebasing on resumption, and
I1 must enforce migration contiguity. Frozen `ControlStore` was unchanged.

Final report hygiene was rerun after the documentation update:

```sh
node scripts/lint.mjs --only packages/fixture-calls packages/plugin-observability packages/plugin-storage apps/api apps/worker
pnpm format:check
node scripts/check-duplication.mjs
```

Pasted exits: **SCOPED_LINT_EXIT=0**, **FORMAT_EXIT=0**,
**DUPLICATION_EXIT=0**. No baseline or frozen contract changed. Console test
artifacts were cleaned up after the successful Playwright run.

## Checker verification — 2026-09-27

**Verified `043b310`.** The checker confirmed all three fixture safety layers,
including the production egress sentinel and SQL-literal `kind='test'`, contiguous
control migrations 001..006 with SQLite parity, and behavioral true negatives
for both defects. The new, unreferenced manual seed script is an explicitly
approved §15.2 exception under design §18.10, also recorded on the board.
I1 inherits the stale plugin-observability -> plugin-voice manifest dependency,
fixture env-parser/static-STT branch coverage, and removal of this unit's two
normalizer clones after fixing the frozen normalizer itself.
