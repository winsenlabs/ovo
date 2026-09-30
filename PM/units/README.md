# Unit board: plugin platform rebuild

This board is the single source of truth for unit status. The specs in this folder were generated from the design workflow and are self-contained. For shared contracts, tables and reasoning, see [`docs/architecture/plugin-platform.md`](../../docs/architecture/plugin-platform.md), and read §18 there for the resolved decisions. Roles and the check protocol are in [`PM/HANDOFF.md`](../HANDOFF.md).

## Statuses

| Status                 | Meaning                                                                                   | Set by       |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| Not started            | No work yet.                                                                              | —            |
| In progress            | Work has started but the unit is not complete.                                            | builder      |
| Built – awaiting check | Builder says the unit is complete and committed, with checks in the commit body.          | builder      |
| Changes requested      | Checker found blocking issues (listed below).                                             | checker      |
| **Verified `<sha>`**   | Checker independently confirmed scope, the green bar, acceptance, invariants and quality. | checker only |

## Wave 1 (sequential; each unit fully green)

| Unit                          | Title                                                                                   | Depends on | Defects            | Status                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [F1](F1-contracts-runtime.md) | Contracts v2 and host enforcement                                                       | —          | 10, 18, 19, 20, 22 | **Verified `da075a7`**. Checks: lint across 599 files, format, typecheck, 512 tests pass / 87 skipped, Postgres serial run 590 / 9 / 0, build.                                                                                                                                                                          |
| [F2](F2-kits-gates.md)        | Shared kits (`plugin-kit`, `audio`, `conformance`) and hygiene gates                    | F1         | 12, 24, 27         | **Verified `3729f18` + `2edee0b`** (received checker verdict; Wave 1 complete). Independent builder-side review found no remaining blockers. Checks: lint (7 gates), format, typecheck, 770 tests passed / 87 skipped, Postgres serial run 848 / 9 / 0, build and Terraform validation.                                 |
| [F3](F3-host-seams.md)        | Host seams, selection storage and migrations, `session-host`, `distribution`, skeletons | F1, F2     | 1, 21, 27          | **Verified `266ff92`** (received checker verdict; Wave 1 complete). Four focused re-check findings fixed. Node 22 checks: lint (7 gates), format, typecheck, 1,025 tests passed / 125 Postgres-gated skips, Postgres serial run 1,141 passed / 9 skipped / 0 failed, 3 application bundles built, Terraform validation. |
| [F4](F4-apps-data-driven.md)  | API and worker made data-driven                                                         | F1–F3      | 1, 20, 21, 26      | **Verified `9b03079`** (received checker verdict; Wave 1 complete). Round 3 repaired; Node 22: lint (7 gates), format, typecheck, 1,090 passed / 138 skips default; Postgres serial 1,219 passed / 9 skipped / 0 failed; 3 application bundles, Terraform validation, and offline frozen-lockfile install.              |

## Wave 2 (parallel; disjoint ownership per design §15.5)

| Unit                               | Title                                                         | Defects                  | Status                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [E1](E1-turns-vad.md)              | Turn detector and VAD plugins, Pipecat-style                  | 3, 18                    | **Verified `ac8661d`** (checker verdict received 2026-09-27). Structural mute/confirmation guards and seven behavioral true negatives confirmed. Independent bar: 1,270 passed / 138 skipped default; 1,399 passed / 9 skipped / 0 failed Postgres serial; lint seven gates, format, typecheck and build exit 0.                    |
| [E2](E2-native-engine.md)          | OVO native engine rebuild                                     | 3, 4, 9, 26              | **Verified `a27a5e4` (checker Batch A verdict, 2026-09-27).** Iterator cleanup has eight value true negatives and independently reproduced focused 15/15. Included in the merged-foundation full bar at `e41c079`: default 1,556/153, Postgres serial 1,701/8/0; full check 0.                                                      |
| [E3](E3-livekit-engine.md)         | LiveKit Agents JS engine plugin                               | 4                        | **In progress — paused by checker.** WIP committed at `e4e821d` on `w2/E3`; remains paused for its later batch; no resumption authorized in this handoff.                                                                                                                                                                           |
| [C1](C1-carrier-twilio.md)         | Twilio carrier plugin                                         | 1, 21, 26                | **Verified `fa9aa00`; merged `0567c56` (2026-09-28).** Rebased C1 tree was byte-identical to checker-verified tree. Full gate on the merge commit: scoped/full lint, format, duplication, scoped/full typecheck, build and frozen install EXIT 0; default 1,698/153; Postgres serial 1,843/8/0; E2E 41/1. C1 worktree removed.      |
| [C2](C2-gateway-router.md)         | Carrier-neutral gateway router                                | 1, 2, 23, 26, 27         | **Verified — merged `e41c079` (2026-09-27).** Checker approved both conditions. Full gate on the merge commit exits 0: default 1,556/153, Postgres serial 1,701/8/0, Playwright 41/1, recording 4/4. Scoped lint/full format/duplication 0/0/0; frozen offline install 0. Design names the remaining HARD I1 fixture inconsistency. |
| [C3](C3-carrier-exotel.md)         | Exotel carrier plugin                                         | 21                       | **Founder-held.** Preserved WIP `eaeb03f` on `w2/C3`; confirmed Exotel 16 kHz wire-format answer is still required. Do not resume on an inferred or downgraded capability decision.                                                                                                                                                 |
| [C4](C4-carrier-plivo.md)          | Plivo carrier plugin                                          | 21, 26                   | **Checker approved; merged `25e9e67` on 2026-09-29.** Production Plivo ingress is selected through the carrier-neutral gateway. Reduced `by-call-id` and end-only capabilities were explicitly approved. C3 stays founder-held.                                                                                                     |
| [C5](C5-carrier-tcn.md)            | TCN carrier plugin                                            | —                        | **Founder-held, not started (2026-09-30).** Await confirmed TCN media wire format, callback/upgrade authentication and call-control API. Separate from C3 and C6; no vendor behavior inferred.                                                                                                                                      |
| [C6](C6-carrier-aloha.md)          | Aloha carrier plugin                                          | —                        | **Founder-held, not started (2026-09-30).** Confirm vendor identity first; candidate Alohaa docs cover media and dial but leave callback signature and voice-stream hangup unconfirmed. Separate from C3 and C5.                                                                                                                    |
| [S1](S1-speech-split.md)           | Split out the Deepgram STT, OpenAI TTS and OpenAI LLM plugins | 21, 27                   | **Verified `e2c7cc5`** (checker verdict received 2026-09-27). Independent and mixed provider selections passed; defect 21 closed; six behavioral true negatives reproduced. Subsequent cross-unit legacy TTS meter propagation fix is tracked below.                                                                                |
| [S2](S2-speech-new.md)             | AssemblyAI STT and Sarvam STT/TTS                             | 9, 21                    | **Checker approved; merged `8353dba` (2026-09-29).** The exact merged head passed root check (1,802/153, E2E 41/1) and Postgres serial (1,951/4/0). S2 worktree removed.                                                                                                                                                            |
| [O1](O1-fargate-scaling.md)        | Fargate-native autoscaling, Terraform, Fargate prep           | 7, 15, 17, 23            | **Verified `7d0c934`; merged `dbcd8c5` (2026-09-30).** Fast-forward merge; exact merged tree passes `pnpm check` 0 (1,858/173, E2E 41/1) and Postgres serial 2,027/4/0. O1 worktree removed.                                                                                                                                        |
| [O2](O2-ops-ledger.md)             | Campaign driver, queue liveness, reservation expiry           | 5, 15, 16, 19            | **Verified `fc2c8a5`; merged `f628448` (2026-09-30).** The checker reproduced root `pnpm check` with 1,867 passed / 206 skipped and lint and format exit 0. The fresh Postgres serial run passed 2,069 / 4 / 0. The four re-check items and isolated SQL mutation evidence are recorded in the unit note.                           |
| [U1](U1-console.md)                | Console refactor                                              | 8, 15                    | **Verified `75c55c0`** by the checker (verdict received 2026-09-26). Console cold build, lint and format exit 0; Postgres serial 1,277 passed / 9 skipped / 0 failed; Playwright 41 passed / 1 visibility-gated desktop skip; 69 axe analyses with 0 violations and a positive control; 0 overflow at 390 px across 23 routes.      |
| [D1](D1-demo-backend.md)           | Fixture test calls and the demo backend                       | 19, 20                   | **Verified `043b310`** (checker verdict received 2026-09-27). Three fixture isolation layers including production egress sentinel and SQL-literal test kind; control migrations contiguous 001..006 with SQLite parity; both defects closed with behavioral true negatives.                                                         |
| [M1](M1-misc-defects.md)           | Behaviors, tools and security defects                         | 6, 10–14, 18, 19, 24, 25 | **In progress (resumed 2026-09-30).** The first edit renumbered MCP removal to control migration 007; M1 rebased onto O2's merged foundation with D1's immutable fixture-snapshots migration 006 retained. Defects 13 (rotation) and 14 (production session secret) are priority.                                                   |
| [M2](M2-evaluations-decoupling.md) | Decouple the evaluations package from other plugins           | 19                       | **Verified `d322467`** by the checker; verdict recorded in `d45baee`.                                                                                                                                                                                                                                                               |

## Wave 3

| Unit                    | Title                                               | Status      |
| ----------------------- | --------------------------------------------------- | ----------- |
| [I1](I1-integration.md) | Integration, full verification, docs and PM updates | Not started |

## Post-I1 roadmap

**Status: not started.** All five items are blocked on I1 unfreezing `packages/contracts` and defining the [decision, human handoff, intent-graph, templated-clip and multilingual-confirmation contracts](I1-integration.md#founder-scope-addition-2026-09-30-define-post-i1-contracts-while-contracts-are-open). **Before any post-I1 feature work, OVO must place its first real call. It has never done so.** That call is a gate, not authorization to place one during this roadmap update. Items 4 and 5 are parallel tracks; neither depends on items 1–3. No implementation in this section has started.

1. **Decision slot — Not started.** Build plugins behind `Cap.decision`: `plugin-decision-jev` first because it is GA and validates the abstraction fastest, then `plugin-decision-laya` for production (self-hosted, approximately 35 ms, Apache-2.0, 100+ languages, no per-token fee, and transcripts remain in the VPC). Reserve room for `plugin-decision-openai`, but do not build it while the Decisions API is limited preview. **Entry criterion before committing to this build:** measure calibrated confidence and per-option probabilities across Hindi, Tamil, Telugu, Kannada, Marathi, Bengali and code-mixed forms, using speech-to-text transcripts with recognition errors. If calibration degrades in any target language, the confidence threshold can route a call into the wrong branch instead of invoking the LLM fallback; resolve that risk before building on the threshold.
2. **Intent-graph behavior — Not started; depends on item 1.** Add a behavior mode with three routing tiers: regex rules at approximately 0 ms, the decision model, then LLM fallback. Extract slots in the same decision request without another latency step; apply global intents at every node; resume the graph at a named node after fallback. Use the intent-graph contract defined in I1 and OCSO's validated, versioned, browser-editable `RouterStep` (`ASK` / `CLASSIFY` / `KNOWN`) as the schema source.
3. **Pre-rendered audio — Not started.** Render generic clips at boot and per-contact variable clips while the phone rings, aiming for a known reply in approximately 15 ms rather than waiting on TTS. `plugin-speech-cache` already supplies `prepare()` and cache identities. Add templated clips and a pre-dial render hook in the campaign driver.
4. **Human handoff — Not started; parallel to items 1–3.** Implement the built-in open-pickup queue and an OCSO plugin behind `Cap.humanHandoff`; OVO and OCSO remain separate deployments. Borrow OCSO's service identity and `AVAILABLE` / `AWAY` / `OFFLINE` presence with capacity, queue objects with teams, eligibility plus deterministic ranking, `AUTO_ASSIGN` / `OPEN_PICKUP` modes with accept timeout and reassignment, and escalation rules evaluated at turn time. OVO already has `HandoffTarget { kind: 'queue' }` and carrier control; the human model is the missing piece.
5. **Conversation correlation — Not started; parallel to items 1–3.** Accept a `conversationId` owned outside OVO, stamp it on the call, and emit transcript and outcome as interaction parts so chat, call and human handoff remain one thread. This is the smallest item and unlocks the cross-product flow.

**Design provenance:** items 2 and 3 come from the [CreditMantri collections POC](https://github.com/tejassudsfp/temp-cmchatbot). Item 4 and the intent-graph schema come from [OCSO's RouterStep source](../../../ocso/packages/domain/src/routing/router-definition.ts) in `~/work/ocso`.

## Carry-forward issues

The named owner must resolve these findings. Items marked **BLOCKING** prevent that owner's approval; other carry-forwards do not block the originating unit.

| From          | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Resolve in                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| E2            | **HARD BLOCKING I1 (B2):** fix normalizeAgentConfig input mutation, then remove all three caller clones: apps/api/src/release-selections.ts, apps/api/src/test-call-runtime.ts, packages/fixture-calls/src/run.ts. Frozen packages/session-host/src/legacy-session-selections.ts passes input.release.config unprotected and currently mutates a release in memory. No fourth clone. Current API clone-reversion proof is nine HTTP 409 failures, after D1 added call sites.                                            | I1                                             |
| D1            | Control migration allocation is D1 **006**, then M1 **007** on resumption. Both edit the migration runners; the second unit must rebase and re-verify both backends. `runControlMigrations` currently permits silent out-of-order application of a missing lower version; I1 must add a contiguity assertion before applying SQL. The paused M1 branch stays unchanged until Batch A is verified.                                                                                                                       | M1, I1                                         |
| S1            | The frozen session host emits a root `credentialRef`, while older fixtures put one under `/credentialRef`; S1 accepts both through `ctx.secret`. I1 must normalize the host and fixtures to one guarded shape, and remove the legacy `api: responses` binding field and worker-added `workspaceId` / `bindingId` / `updatedAt` provider config fields once persisted rows and the frozen bridge are migrated.                                                                                                           | I1                                             |
| S1            | The frozen catalog and contracts have no batch STT slot. S1 moved the OpenAI batch implementation to `plugin-tts-openai` but leaves it unregistered; I1 must decide a batch contract and registration. I1 also owns deletion of the `plugin-providers` façade, its local cached/streaming TTS adapter, and frozen same-ID bridges after migration, including pruning the legacy package's now-stale dependencies and baseline entries.                                                                                  | I1                                             |
| F1            | The guarded plugin context passes Cordis `inject`, `plugin` and accessors straight through to the raw context, so a plugin could bypass its declared `requires` and `provides`.                                                                                                                                                                                                                                                                                                                                         | I1                                             |
| F1            | Strict Ajv (without `allowUnionTypes`) cannot compile unions of primitive types such as `z.union([z.string(), z.number()])` in `definePluginV2` config schemas. Wave-2 authors must avoid that shape.                                                                                                                                                                                                                                                                                                                   | all wave 2                                     |
| F1            | The `lockfileSha256` in `docs/research/dependency-licenses.json` is stale. No gate checks it.                                                                                                                                                                                                                                                                                                                                                                                                                           | I1                                             |
| F1            | **Discharged by F4:** API release validation uses `validateGraph` with host session services; `WORKER_VOICE_PORTS` is gone.                                                                                                                                                                                                                                                                                                                                                                                             | F4                                             |
| F1            | The `classifyConfirmation` test table lacks the literal `'no that is not correct'` case. A manual check passed.                                                                                                                                                                                                                                                                                                                                                                                                         | M1                                             |
| F3            | **Discharged by F4:** the API builds release selections; the worker calls `selectSessionGraph` and derives legacy selections for unpinned releases with binding/default inputs.                                                                                                                                                                                                                                                                                                                                         | F4                                             |
| F3            | **Discharged by F4:** inbound route carrier plugin and binding fields now flow through admission, including waits, into durable job and session rows in one transaction. NULL remains the env binding; Postgres tests cover NULL, explicit selection, and an uninstalled plugin.                                                                                                                                                                                                                                        | F4                                             |
| F3            | **Discharged by F4:** selected inference composes in the worker and selection-model `context`/`agent` releases publish through the API; the workspace guard rejects an explicitly foreign binding.                                                                                                                                                                                                                                                                                                                      | F4                                             |
| F3            | **Discharged by F4:** the deferred app manifest dependencies and lockfile entries are installed; frozen-lockfile installation succeeds.                                                                                                                                                                                                                                                                                                                                                                                 | F4                                             |
| F3            | The optional markdown text-filter default has no implementation until E2. E2 must add it to `plugin-voice`'s exported `plugins` array; distribution now consumes that array without an edit.                                                                                                                                                                                                                                                                                                                            | E2                                             |
| F3            | Inbound compatibility validation must use the actual carrier selected from the route. C2 must pass that selection as `CompatInput.actualCarrier` before admission; relying on the release carrier can miss blocking playback evidence.                                                                                                                                                                                                                                                                                  | C2                                             |
| F3            | **Discharged by F4:** worker and API live readiness use the session-host `sessionRequiresInput` predicate.                                                                                                                                                                                                                                                                                                                                                                                                              | F4                                             |
| F3            | The legacy call-id-only route lookup deliberately spans tenants. C2 must move its media caller to scoped correlation; I1 must retire the unscoped overload after the legacy bridge is removed.                                                                                                                                                                                                                                                                                                                          | C2, I1                                         |
| F3            | `findCarrierCallId(requestId)` has no organization or carrier scope and fails closed on ambiguity. O1 must give the orchestration lookup a scoped contract before new carrier paths use it.                                                                                                                                                                                                                                                                                                                             | O1                                             |
| F3            | The post-grant `carrier.call_id_mismatch` audit write is outside the grant transaction. O1 must make grant issuance and its required audit durable together, or give the caller an explicit recovery path.                                                                                                                                                                                                                                                                                                              | O1                                             |
| F3            | `qualifierOf` still keys `carrier.control`, `carrier.ingress` and `background-task` by provider. I1 must give distinct same-provider plugins stable identities and prove composition with two background tasks from one provider; wave-2 authors should report any collision as an integration gap.                                                                                                                                                                                                                     | I1                                             |
| F4            | `plugin-voice` now declares `plugin-kit` to use the F4 native engine's v2 speech and media shims. E2 inherits this dependency; keep vendor-plugin imports within contracts, runtime, SDK, kits and third-party packages, with no Node network built-ins or other plugin imports.                                                                                                                                                                                                                                        | E2                                             |
| F4            | O2 inherits edits to `plugin-operations/src/inbound-gateway.ts`, `inbound-session.ts`, the small `inbound-carrier.ts` and `inbound-existing.ts` extractions, their Postgres tests, and migration 006. They preserve raw nullable inbound carrier plugin/binding fields through wait admission and atomically into job/session rows; O2 must retain the NULL env convention.                                                                                                                                             | O2                                             |
| F4            | O1 inherits orchestration migration 005, its registration and the populated-schema test expectation, adding nullable raw carrier plugin/binding columns to jobs and session routes. Keep the existing `carrier_id` scope and ownership fences unchanged.                                                                                                                                                                                                                                                                | O1                                             |
| F4            | C2 can read the raw route carrier selection from the inbound admission's job payload and durable rows; the worker now reads that selection and its actual `carrier_id`. C2's separate obligation to pass the actual route carrier as `CompatInput.actualCarrier` before admission remains open.                                                                                                                                                                                                                         | C2                                             |
| F4            | C2 inherits `apps/media-gateway/src/inbound-carrier-installation.ts` and its test; it must keep gate installation in the admitting process when replacing `inbound-webhook.ts`. C2 also owns the new `apps/worker/tests/worker-media-bootstrap.test.ts` and the termination callback through `worker-media-bootstrap.ts`.                                                                                                                                                                                               | C2                                             |
| F4            | O1 inherits `apps/worker/src/{carrier-dial-settlement,carrier-runtime,carrier-completion,worker-carrier-plugin,worker-dial,worker-termination}.ts` and their F4 tests; these files select the carrier per job, settle completion without a session, and fence before media closes. O1 must preserve that ordering.                                                                                                                                                                                                      | O1                                             |
| F4            | O2 inherits `apps/api/src/carrier-handoff.ts`, `apps/worker/src/cost-runtime-plugin.ts`, and their F4 tests. Keep the selected inbound `carrier_id` distinct from the nullable raw plugin/binding fields.                                                                                                                                                                                                                                                                                                               | O2                                             |
| F4            | D1 inherits `apps/api/src/release-simulation.ts`, `apps/worker/src/{legacy-session-compat,speech-cache-v2,v1-engine-adapter}.ts`, `apps/worker/tests/{weak-playback,production-session-lifecycle}.test.ts`, and the F4 recording/session-graph tests. These are explicit D1 touchpoints under its broad session and simulation globs.                                                                                                                                                                                   | D1                                             |
| F4            | M2 inherits `apps/api/src/provider-evaluation-inference.ts`, `routes/evaluation-run-schemas.ts`, and the paid-evaluation route error mapping in `routes/evaluation-datasets.ts`; the provider gate now gives a structured refusal for an uninstalled selected LLM. The F4 provider evaluation tests are shared with M2.                                                                                                                                                                                                 | M2                                             |
| F4            | I1 owns the new API release modules `release-catalog.ts`, `release-graph.ts`, `release-selections.ts`, `routes/plugins.ts`, `routes/registry.ts` and their F4 tests after wave 1. D1 alone owns `routes/test-calls.ts`; O2 alone owns carrier-handoff. This resolves the new-file gaps before wave 2.                                                                                                                                                                                                                   | I1, D1, O2                                     |
| F4            | E2 inherits the native v2 adapter's new production-path test. The one-line scripted-announcement predicate fix in `conformance/src/kit/engine-harness.ts` and its test are shared F2/E2 touchpoints; future engine conformance must preserve input-enabled scripted announcements.                                                                                                                                                                                                                                      | E2                                             |
| F4            | E2 inherits the `plugin-voice/src/scheduler.ts` first-turn correction and the real gateway regression in `plugin-media/tests/gateway.integration.test.ts` (C2's harness). The pre-existing first-call blocker sent a media clear before `session.accept`; retain the no-clear-before-media invariant as E2 changes the engine.                                                                                                                                                                                          | E2, C2                                         |
| F4            | D1/O1 inherit the worker STT telemetry decoration and the input-enabled session lifecycle regression. The pre-existing v1/v2 session shape mismatch made `cancel` throw synchronously and prevented engine disposal, the media fence and leg termination. Keep the v2 `cancel`/`finish` contract when replacing telemetry or ingress.                                                                                                                                                                                   | D1, O1                                         |
| F4            | I1 inherits release validation of the resolved default engine and every selected slot; `apps/api/tests/selected-speech-fixture.ts` is an I1 test fixture. A release using the distribution default must receive the same dependency check as an explicit engine.                                                                                                                                                                                                                                                        | I1                                             |
| F4            | C2 inherits the media-gateway NULL-carrier fallback and the webhook's explicit 503 for an unarmed carrier gate; O2 inherits the admission gate in `plugin-operations/src/{inbound-carrier,inbound-gateway}.ts`. Preserve the NULL env-binding convention and reject admission loudly until the local gateway process installs its carrier controls.                                                                                                                                                                     | C2, O2                                         |
| F4            | O1 inherits typed `EndReason` forwarding through worker termination and `session-host/src/terminate.ts`; C2 inherits the media runtime's typed close. A close-stream carrier must record ownership or cost reasons rather than `caller_hangup`.                                                                                                                                                                                                                                                                         | O1, C2                                         |
| F4            | C2 inherits the bounded pre-accept media queue in `plugin-media/src/worker-media-session.ts`, the per-session pre-accept close rule in `gateway.ts`, and their gateway regressions. E2 inherits `apps/worker/tests/real-gateway-first-call.test.ts`, which runs the real distribution and factory with four extra awaits and a 20 ms scheduling delay. Keep `session.accept` before audio and isolate a failed open from neighboring calls.                                                                             | C2, E2                                         |
| F4            | I1 inherits the API host-service dependency allowance and `apps/api/tests/real-llm-release.test.ts`. Both context and agent releases must publish with the actual OpenAI inference bridge when the same release composes in the worker.                                                                                                                                                                                                                                                                                 | I1                                             |
| F4            | O2 inherits durable inbound carrier-configuration refusals in `plugin-operations/src/{inbound-carrier,inbound-gateway,inbound-overflow}.ts` and their Postgres tests. C2 inherits gateway startup arming, the constrained env fallback, and HTTP 503 for configuration refusals.                                                                                                                                                                                                                                        | O2, C2                                         |
| F4            | **Discharged by O1/O2:** forced shutdown and job lease loss now await owned-job termination, cost finalization, and matching inbound `completeSession` cleanup; O2 proved the missing-call value failure. C2 continues to preserve the `onSessionClose` callback contract for normal exits.                                                                                                                                                                                                                             | O1, O2, C2                                     |
| F4            | **Discharged by F4:** the live `gateway disconnected` reason maps to `ownership_lost`, and suffixed `cost-meter-unconfigured:<meters>` maps to `error:cost-meter-unconfigured`. O1 and C2 inherit these boundary strings.                                                                                                                                                                                                                                                                                               | O1, C2                                         |
| U1            | The console refactor removed or shortened files that still have top-level module-size, duplication and provider-name baseline entries. Scoped lint passes but reports those entries as stale warnings. I1 must prune them when ratcheting the full baselines and consolidate the five relocated cross-package type overlaps recorded in U1's pending duplication baseline.                                                                                                                                              | I1                                             |
| U1            | Other agent pickers use only the first `/agents` page. Studio deep links and inbound route edits fetch exact IDs; I1 owns cursor-aware selection. Shared `agent-release-options.ts`, used by `evaluation-provider-authorizations.tsx` and inbound routes, uses a bare `Promise.all` for 50 release reads; one failed agent empties each picker. I1 must isolate failures per agent as `evaluations-view.tsx` does.                                                                                                      | I1                                             |
| U1            | The script delete notice counts self-loops as incoming transitions. `forms/json-import-box.tsx`, `ui/button.tsx` (`Button`, `Tabs`) and `ui/feedback.tsx` (`Stat`, `Skeleton`) have no consumers.                                                                                                                                                                                                                                                                                                                       | I1                                             |
| W2            | Design §15.4 omits Prettier from scoped verification and treats format and duplication as independent despite formatting changing duplication counts. I1 must reconcile the protocol with the required combined gate.                                                                                                                                                                                                                                                                                                   | I1                                             |
| W2            | Design §15.2 freezes `PM/**` while `PM/HANDOFF.md` §6 and the current builder brief require board status updates during wave 2. The explicit builder instruction authorizes this status update; I1 must resolve the standing ownership contradiction.                                                                                                                                                                                                                                                                   | I1                                             |
| E1            | E2 inherits the `plugin-turns` controller's conditional `force-endpoint` behavior and its regression test: after a final transcript, `vad.stop` must not request another provider endpoint. The 2026-09-25 checker note in E1 supersedes the spec's unconditional wording.                                                                                                                                                                                                                                              | E2                                             |
| E2            | **Discharged by D1:** both cache and streaming branches prepare bounded audio; real `ProductionVoiceSessionFactory` plus E2 engine runs two sessions with one synthesis per format (8k/16k). Removing factory cache wiring makes both tests synthesize twice. `TextToSpeech.cacheIdentity` is retained.                                                                                                                                                                                                                 | D1                                             |
| E2            | **Discharged by D1:** the composed v2 output now has bounded prefetch, a shared ordered carrier send queue, multiple pending segments, byte framing separate from prefetch capacity and PCM sample carry. Production host tests prove deferred sends, cancellation-before-clear and shared producer survival; real native cache integration covers both formats.                                                                                                                                                        | D1                                             |
| E2            | **Discharged by D1:** mark timeout maps to completed/estimated and accepted carrier-processed evidence retains its source. Composed cache-enabled output tests cover both receipt mappings and epoch cancellation before clear.                                                                                                                                                                                                                                                                                         | D1                                             |
| E2            | Add the missing plugin-voice → audio and plugin-speech-cache → contracts manifest dependencies with the lockfile, then replace E2's temporary relative imports. Remove the stale plugin-speech-cache → plugin-cache/plugin-voice manifest dependencies and stale architecture baseline entries. Widen frozen speech kind contracts for confirmation/disclosure/idle-prompt. Retire the v1 voice compatibility path after its frozen consumers migrate.                                                                  | I1                                             |
| E2            | Frozen `StageKey` and the conformance kit reject the `total` timing event required by E2. The native engine computes total internally; I1 must add `total` to contracts and the kit before it can be emitted. Frozen `Behavior` has no provider-token timestamp, so E2 measures `llm_ttfb` at the first streamed behavior segment; I1 should provide a precise provider timestamp if needed for analysis.                                                                                                               | I1                                             |
| D1            | The frozen fixture template/NetPort contracts have no caller-turn delivery gate or scripted-cancellation seam. D1 uses an owned structural replay adapter with strict wire validation, rejects unsupported confirmed-write templates and permits only a fully delivered, validated shutdown tail on actual scripted hangup. I1 must formalize or replace this adapter; normal E2 integration now passes, and approved durable snapshot/idempotency work is implemented. Final root full bar remains required.           | I1                                             |
| D1            | `apps/api/tests/test-call-inspection-runtime.test.ts` splits D1's production-entry test scenarios from `test-calls.test.ts` to satisfy the 500-line test gate. I1 inherits this additional API test path when integrating the call routes.                                                                                                                                                                                                                                                                              | I1                                             |
| D1            | F4's wave-2 owner map assigns `apps/api/src/release-simulation.ts` to D1 despite omission from design §15.5 and this unit's path list. **Discharged by D1:** selected voice-LLM simulation is fixed there using immutable binding snapshots and a fixture-only usage sink. I1 inherits the shared file and its production-route regression (independently green in the 36-test worker/native/simulation scope).                                                                                                         | I1                                             |
| D1            | D1 propagates the selected worker media format through the live session graph. C2's worker link and recording capture supply PCM16 8/16 kHz on the live path; after C2 lands, D1 must rerun a selected PCM16-only carrier with recording enabled against the real capture, then I1 inherits the integrated path.                                                                                                                                                                                                        | C2, D1, I1                                     |
| D1            | **Discharged by D1:** owned replay gates final `yes` on actual confirmation playback. The normal native engine + actual behaviors/fixture providers regression proves played prompt before yes, one fixture handler execution, one result in the next LLM request and zero live handler calls. I1 inherits formalization of the structural replay seam.                                                                                                                                                                 | D1, I1                                         |
| D1            | The fixture API defaults off in production. O1 owns Compose and must explicitly set `OVO_FIXTURE_TEST_CALLS=true` for the demo deployment; otherwise POST test calls return `fixture_calls_disabled`.                                                                                                                                                                                                                                                                                                                   | O1                                             |
| D1            | The fixture child now consumes a per-call `createFixtureFrameEncoder()` structural extension from the selected carrier ingress and feeds its real serializer. C1, C3 and C4 must expose protocol-faithful encoders; D1 must prove each integrated carrier path as those packages land. I1 owns whether this extension becomes a shared contract. Vendor plugins must not import a legacy plugin for it.                                                                                                                 | C1, C3, C4, D1, I1                             |
| D1            | The API fixture child currently loads the distribution in its own process, but the API parent still imports the distribution catalog during normal startup. E1 and I1 must keep native LiveKit and sharp code out of the parent import path when those plugins are installed, with a production-entry test.                                                                                                                                                                                                             | E1, I1                                         |
| D1            | The worker telemetry session retains a two-argument close overload for the F4/C2 production lifecycle call shape. I1 should remove the legacy outcome argument after callers migrate; the typed end reason already determines the stored outcome.                                                                                                                                                                                                                                                                       | I1                                             |
| D1            | `apps/worker/src/telemetry-runtime.ts` is now 156 canonical lines after the D1 split, leaving a stale entry in the frozen top-level `scripts/baselines/module-size.json`. I1 must prune that entry when ratcheting the baselines.                                                                                                                                                                                                                                                                                       | I1                                             |
| D1            | The checker authorized the required `carrierMedia.format: MULAW_8K` field and import in `apps/api/tests/real-llm-release.test.ts` on 2026-09-26. All assertions are unchanged; I1 inherits the corrected shared fixture.                                                                                                                                                                                                                                                                                                | I1                                             |
| D1            | **Discharged by D1:** checker-approved control migration 006 and both storage backends create private draft snapshots, calls and initial fingerprints atomically. Public/live readers exclude snapshots; published slots remain available; identical local admissions coalesce before capacity and cross-process admissions serialize in storage. New `apps/api/tests/fixture-admission{,-support}.ts` and local `FixtureAdmissionStore` are I1 touchpoints; frozen ControlStore was not changed.                       | I1                                             |
| D1            | After E2 integration, standalone duplication exposed copied prefetch logic. D1 now uses owned fixed-capacity byte-ring storage with transition notifications and explicit shared-producer detach. I1 owns any future shared bounded-prefetch contract/consolidation; no kit or baseline was changed.                                                                                                                                                                                                                    | I1                                             |
| C2            | HTTP carrier externalUrl retains the raw query for callback signatures; WSS retains its query-free signature URL. The upgrade adapter maps the serializer request identity to the real host verifier without adding a query pair. C3 inherits the loopback SessionBridge proof that empty termination frames still close the carrier socket. Preserve these cross-unit regressions during integration.                                                                                                                  | C1, C3, I1                                     |
| C2            | **HARD BLOCKING I1:** fixture-carrier.ts signFixtureRequest and fixture-carrier-routes.ts verified append parsed query to a query-bearing externalUrl. They sign a doubled query no real carrier emits. Correct both helpers, consumers and reference documentation together, with literal-wire signature proofs; existing fixture success is not vendor signature fidelity. Checker authorized the design correction and explicit shipped-fixture warning now; the frozen helper correction remains a hard I1 blocker. | I1                                             |
| C2            | Checker-approved `@types/ws` manifest/lock importer and three shared worker lifecycle harnesses now use the authenticated media runtime. A local typed WebSocket re-export uses the existing worker dependency. I1 inherits these shared paths and the actual-PG non-Twilio gateway regression; D1 must retain lifecycle, STT, telemetry, fencing and recording-disabled assertions.                                                                                                                                    | I1, D1                                         |
| S1 cross-unit | **Built – awaiting check at `724c0a0`, owner S1 integration builder:** `deriveLegacySelections` now retains the already-loaded binding. Absent/empty legacy selection tests and actual worker admission reproduce the missing conditional TTS meters; 9 value failures before the fix become 25/25 green. All four models refuse missing TTS cards before budget reservation; legacy/v2 positive branches add no unconditional fallback meter. I1 retains these regressions.                                            | S1 integration builder; I1 retains regressions |
| S1 cross-unit | **BLOCKING before legacy bridge deletion:** frozen `session-host/src/meters.ts` must fail closed when a selected plugin declares meters for the role but no meter survives conditional filtering. I1 must add the validation error and absent-binding/missing-model/unknown-model tests, preserving valid conditional selection without duplicate charges. The storage propagation fix does not close this contract gap.                                                                                                | I1                                             |
| D1            | Remove the now-unused @winsendotai/ovo-plugin-voice dependency from packages/plugin-observability/package.json and matching lock importer after the source edge removal. This complements the recorded speech-cache manifest cleanup.                                                                                                                                                                                                                                                                                   | I1                                             |
| D1            | Add direct branch coverage for fixtureCallsEnvironmentEnabled (undefined, true, false, invalid) and fixture STT static mode when doing integration coverage. These are recorded coverage gaps, not D1 blockers.                                                                                                                                                                                                                                                                                                         | I1                                             |
| C2            | confirmCallback in apps/media-gateway/src/inbound-admission.ts skips validateBeforeAdmission, unlike admitInbound. Enforce the same carrier/binding identity check before this currently unused entry point gains a production caller; add rejection and valid-counterpart coverage.                                                                                                                                                                                                                                    | I1                                             |
| C2            | C1 covers its carrier-played/true and route aliases. C4 owns synthetic C2 queryOnMediaUrl:true, native Plivo clearFlushesMarkers unknown and carrier-played. C3, still held, owns real Exotel queryOnMediaUrl:true and carrier-processed. I1 integration owns synthetic clearFlushesMarkers false, playbackEvidence none, and protocol v1 callSid/streamSid aliases. Do not count C4 synthetic shape as a Plivo capability change.                                                                                      | C4; C3 when founder-unfrozen; I1               |
| C2            | Add startup/config coverage for installInboundCarriers with 2+ env bindings, OVO_MEDIA_PRE_ACCEPT_MS explicitly present and deprecated OVO_MEDIA_MAX_PENDING_FRAMES ×20 conversion.                                                                                                                                                                                                                                                                                                                                     | I1                                             |
| C2            | Raise plugin-media gateway schema preAcceptBufferMs minimum from 1 ms and prove a supported first audio frame fits. At 1 ms the first 160-byte frame is refused and every call drops, reopening defect 2 through misconfiguration.                                                                                                                                                                                                                                                                                      | I1                                             |
| C2            | Cover the six new recording guard branches. Replace four undeclared contracts deep imports in plugin-recordings src/capture-types.ts, capture.ts, wav.ts and live-service.ts with declared dependency/public exports; capture-types.ts is currently the only file with an adapter note.                                                                                                                                                                                                                                 | I1                                             |
| C2            | Delete zero-consumer gatewayInfrastructureRows (including its false host-caller comment), encodeWorkerMessage, sameIdentity and WorkerMediaRuntime.connect after confirming integration consumers.                                                                                                                                                                                                                                                                                                                      | I1                                             |
| C2            | Remove the production open() branch for media not instanceof WorkerMediaLink after migrating its last media-runtime.test.ts caller to the socket path. The prior claim that production had no compatibility bypass was inaccurate and has been corrected in C2's report.                                                                                                                                                                                                                                                | I1                                             |

### C1 carry-forwards

| Source      | Obligation                                                                                                                                                                                                                                                                                                                                                                                                                                           | Owner                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| C1          | The approved legacy manifest dependency and matching lockfile point from plugin-telephony-twilio to plugin-carrier-twilio only. Delete that façade/dependency and its stale capability baseline entry with the legacy package. Vendor architecture has zero baselined edges.                                                                                                                                                                         | I1                                                |
| C1          | The selected production ingress supplies createFixtureFrameEncoder() for D1's real wire replay. Its per-session Twilio codec is exercised through the real distribution and C2 gateway; preserve the adapter during final integration and decide its shared contract.                                                                                                                                                                                | D1, I1                                            |
| C1          | **Contract gap / blocking integration:** resume handoff accepts a local structural target.resumeUrl carrying a host-built, authenticated binding-scoped callback; it never reads binding.config.resumeUrl. The frozen HandoffTarget contract has no callback context and apps/api/src/carrier-handoff.ts does not pass it. I1 must define the host context and wire the API caller before claiming operational resume handoff; absence fails closed. | I1 (contract/API); O2 preserves handoff semantics |
| C1          | HTTP raw-query fidelity is independently proven with the genuine offline Twilio SDK validator and production C2 router (stripped/doubled query signatures fail). The frozen conformance reference signer/verifier remains known-inconsistent and HARD BLOCKING I1; this proof does not repair it. WSS explicit-port behavior remains UNCONFIRMED without founder-authorized vendor evidence.                                                         | I1; founder for vendor confirmation               |
| C1 re-check | Preserve SDK-compatible HTTPS signature variants, exact WSS validation, and the deliberate case-insensitive hexadecimal account-SID syntax. Move the test-only SDK oracle with the tests when deleting the legacy façade; production vendor code has no SDK or Node dependency. No shared production path changed in this correction.                                                                                                                | I1                                                |

### C4 carry-forwards (started 2026-09-28)

| Source      | Obligation                                                                                                                                                                                                                                                                                                                         | Owner                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| C4          | **Discharged C2 carry-forward:** a synthetic alternate ingress drives `queryOnMediaUrl: true` through the production gateway adapter; the selected Plivo ingress proves native `false`, `clearFlushesMarkers: 'unknown'` and `playbackEvidence: 'carrier-played'`. C3 and I1 retain the other C2 cases in the row above.           | C4; C3 and I1 retain their cases    |
| C4          | The selected Plivo ingress now supplies a per-call protocol-faithful frame encoder for D1 fixture replay. Keep the encoder selected through the real distribution when integrating fixtures; decide whether the structural extension becomes a shared contract.                                                                    | D1, I1                              |
| C4          | Plivo's published Calls API has no request-UUID call lookup. The checker approved `by-call-id`: C4 returns pending until a callback supplies CallUUID. C2 must preserve request-to-call correlation from answer/status callbacks.                                                                                                  | C2, I1                              |
| C4          | Plivo phone/resume transfer needs a host-served XML `aleg_url`, absent from frozen `HandoffTarget` and C4's host callback contract. The checker approved end-only for C4; phone/resume fail before network. A future host URL seam belongs to F1/C2 and integration to I1.                                                         | F1, C2, I1                          |
| C4          | Preserve PHP SDK `SORT_NATURAL` V3 signing of raw URL including query and port. I1 must resolve HTTPS signature port/encoding variants and the vendor WSS signing form, stream-status events, clear/checkpoint behavior, inbound frame limit and nonce replay policy. No vendor endpoint was contacted in C4.                      | I1; founder for vendor confirmation |
| C4 approval | **BLOCKING I1:** add a production integration case with real Twilio and Plivo ingresses installed together. C2's multi-carrier case clones one ingress; the carrier-neutral gateway case uses a Plivo label on Twilio-derived code. S2 owns speech paths and cannot close this.                                                    | I1                                  |
| C4 approval | Exercise `unknown_outcome` and `not_failed` in plugin-operations (currently only `attempt_limit` is tested), then wire a production caller for redrive.                                                                                                                                                                            | O2, I1                              |
| C4 approval | Document and resolve the operator consequence of Plivo's request-ID-only dial and absent request-ID reconciliation: a crash before the first callback can leave a `dialing` job with its delivery deleted, requiring operator action. A terminal `unknown` attempt can undercount a genuinely connected call in campaign counters. | O2, I1                              |
| C4 approval | Remove unused skeleton `plugins = []` export from `packages/plugin-carrier-plivo/src/testing.ts`; it has no importers. Preserve and test both comma and semicolon `extra_headers` paths when resolving the vendor ambiguity.                                                                                                       | I1                                  |
| C4 approval | The no-correlation settlement test touches `apps/worker/tests/f4-carrier-settlement.test.ts` as an approved C4 shared test touchpoint; worker implementation was unchanged.                                                                                                                                                        | O2                                  |

### S2 carry-forwards (started 2026-09-29)

| Source     | Obligation                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Owner   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| S2         | The frozen `sttAsLegacy` bridge clears finals on the first end-of-turn and may carry a later formatted revision into the next turn. S2's production AssemblyAI URL uses `format_turns=false`, and its v2 parser test covers the revision. Fix the bridge before exposing formatted mode.                                                                                                                                                                               | I1      |
| S2         | Host compatibility reads static AssemblyAI manifest languages, while the selected model has a narrower or wider language set. Sarvam TTS's static manifest says 2,500 characters while the v2 instance correctly limits to 1,500. Make compatibility and limits binding-aware so release validation agrees with the selected model.                                                                                                                                    | I1      |
| S2         | Sarvam REST TTS can return a base64 WAV envelope. Keep its native-format extraction and wrong-codec/rate refusal when integrating provider output; the old path sent RIFF bytes as audio.                                                                                                                                                                                                                                                                              | I1      |
| S2 checker | **WAVE-LEVEL BLOCKING I1:** drive selected speech plugins through the real session graph, following S1's `production-entry.test.ts` pattern. A canary that made all three S2 entry points throw failed only five files, all inside S2; 85 simultaneous behavioral mutations left the 1,952-test repo suite green, and 86 of 140 guards survived both S2-only and repo-wide runs. Distribution/composition checks currently stop at `graph.get(Cap.stt)` being defined. | I1      |
| S2 checker | Export `decodeBase64` from plugin-kit; S2 contains three local copies because the fixture matcher is not exported. Make stt@1's frame-size check see JSON-framed Sarvam audio, and make tts@1 non-native coverage independently pin each of its redundant guards.                                                                                                                                                                                                      | F2 / I1 |
| S2 checker | The formatted duplicate revision also violates stt@1's locked-finals invariant, beyond the legacy bridge issue above. Conformance must reject or explicitly reconcile this before selectable formatted mode.                                                                                                                                                                                                                                                           | I1      |
| S2 checker | Add consumers/tests for declared `ttfsP99Ms` and `maxChars`; perturbing them currently leaves the suite green. Forbid unapproved conformance `only:` subsetting, which can make a plugin pass with one check.                                                                                                                                                                                                                                                          | I1      |
| S2 checker | **Founder/vendor confirmation required:** reconcile AssemblyAI Universal-3.5-Pro Urdu support against the original spec; confirm Sarvam Odia `or-IN` for STT versus `od-IN` for TTS; confirm the supported Sarvam speaker roster before constraining `bindingSchema.speaker`. Do not settle any of these from inference.                                                                                                                                               | Tejas   |

### O2 saved WIP carry-forwards (resumed 2026-09-30)

| Source | Obligation                                                                                                                                                                                                                                                                                                                                                                                                                               | Owner        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| O2 WIP | Preserve the operations migration 007 carrier snapshot and nullable tenant-scoped pacing bucket. Keep NULL as the env binding and retain tenant and in-flight call guards when integrating carriers.                                                                                                                                                                                                                                     | I1           |
| O2 WIP | Release-note the persisted `input_digest` change for mixed-case and non-ASCII keys: matching pre-upgrade operation retries may return 409. Remove the ledger's stale observability baseline edge after its manifest dependency is removed.                                                                                                                                                                                               | I1           |
| O2     | Document that O1's ownership-loss receipt deletion retains `hinted_at`; campaign capacity can wait for the 150-second hint sweep instead of `deferSeconds`. O2's driver uses the observed capacity snapshot and promises no faster recovery.                                                                                                                                                                                             | I1           |
| O2     | **Discharged:** the production admin redrive route and Postgres regressions now prove `not_failed` and `unknown_outcome` block requeue; unknown attempt history remains authoritative even if a contact row says failed.                                                                                                                                                                                                                 | I1 preserves |
| O2     | A release with no selected carrier meter has no carrier price snapshot. The durable sweeper settles known usage without inventing carrier seconds; an incomplete carrier snapshot fails with the reservation still reserved. Preserve the required price-card check whenever a carrier is selected.                                                                                                                                      | I1           |
| O2     | The campaign driver's early active/unknown occupancy subtraction duplicates the admission service's authoritative concurrency check. Removing either early check alone can leave the admission result unchanged, so mutation survival here reflects a redundant guard rather than proof that both checks are pinned.                                                                                                                     | I1           |
| O2     | The campaign token debit `AND tokens >= 1` and drained-campaign unknown-attempt `NOT EXISTS` are defense in depth alongside separate admission and contact-state guards. Whole-predicate deletion can survive although broader OR/EXISTS mutations fail; I1 should pin or simplify these redundant SQL fences with direct tests.                                                                                                         | I1           |
| O2     | Preserve the awaited forced-termination callback's inbound `completeSession` cleanup in O1-owned `apps/worker/src/worker-loop.ts`; lease loss bypasses `onSessionClose`. Worker shutdown continues to await `inboundRuntime.close()`.                                                                                                                                                                                                    | I1           |
| O2     | I1 inherits `apps/worker/tests/worker-forced-exit.test.ts`, split faithfully from O1's infrastructure-metrics test to satisfy the canonical-line limit. Keep its forced-termination failure and inbound cleanup regressions with the shared worker loop.                                                                                                                                                                                 | I1           |
| O2     | I1 inherits the checked-in TypeScript/SQL mutation runner under `scripts/mutation-{sites,sweep,related,postgres}.mjs`. It reports executable SQL predicates separately from TypeScript branches and flags invalid SQL mutants and runs repo-related survivor tests in isolated databases; future units should rerun against their own production scopes and tests.                                                                       | I1           |
| O2     | **Tracked I1 mutation target:** 190 of 360 executable SQL decision mutations survived O2's Postgres suite (52.8%); 187 of 360 survived O2 plus transitive repo-related tests (51.9%). These are the isolated-database baseline for O2's SQL scope, not a whole-repository census. I1's integration-level plugin driving should lower the survival count; rerun the checked-in sweep and report the new numerator, denominator and scope. | I1           |
| O2     | A manually corrupted, partial carrier snapshot currently raises from reservation resolution and rolls back the sweeper's whole 100-row transaction. Normal admission cannot create it; I1 should isolate each row while preserving the reservation and priced-usage fences.                                                                                                                                                              | I1           |

| M1 | Preserve D1's immutable control migration 006 before M1's `007-mcp-tool-removed.ts` in Postgres and SQLite. The MCP diff-upsert retains approved tools with `removed_at`; I1's required contiguity assertion must reject an out-of-order ledger before running SQL. | I1 |
| M1 | M1's local `CredentialStore` and metadata adapter removes the secrets→storage import but duplicates frozen storage types. Promote a shared credential port and metadata into contracts during I1, then remove the local adapter and its pending duplication entries. | I1 |
| M1 | MCP pool identity resolves and hashes the secret on every acquisition; changed secrets evict the prior client and revoked credentials fail closed. Identical secret bytes across credential versions cannot be distinguished because frozen `SecretResolver` exposes no version. Add a real credential-version port. | I1 |
| M1 | **Persisted-value release note:** code-unit canonical JSON changes tool operation fingerprints and MCP schema digests for case/non-ASCII keys. Existing retries may conflict; operators may need MCP rediscovery and reapproval. Preserve both consequences in release notes rather than describing this as an ordering-only change. | I1 |
| M1 | Behavior, secrets and MCP repository splits and removal of tools/secrets plugin edges leave stale architecture, module-size, capability-key and duplication baseline entries. Prune them after M1 merges; none of the prohibited source edges is baselined by M1. | I1 |
| M1 | Preserve the D1-owned fixture-admission upgrade regression updated for control migration 007, including its published-call and event assertions. | I1 |

### O1 re-check carry-forwards (2026-09-29)

| Source     | Obligation                                                                                                                                                                                                                        | Owner |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| O1 checker | Update `docs/runbooks/scale-and-drain.md` and `docs/runbooks/fargate-deployment.md`: they still tell operators to query the dropped `ovo_capacity_writes` table or avoid racing a dispatcher that no longer writes desired count. | I1    |
| O1 checker | Strengthen `terraform.contract.test.ts` to assert the gateway count without whitespace dependence, tie alarm assertions to the stale-signal resource, and pin the absence of scale-in steps.                                      | I1    |
| O1 checker | Narrow orchestration migration 006's removal of the status CHECK constraint; its `%status%` match could remove a future unrelated constraint.                                                                                     | I1    |
| O1 checker | Test starting-task reconciliation with `provisionedTasks` greater than `counts.total`; current `dispatcher-capacity.test.ts` fixtures make the difference zero.                                                                   | I1    |
| O1 checker | Decide whether an explicit one-replica gateway deployment must be accepted. O1 currently enforces `gateway_desired_count >= 2` for redundant production ingress; this is stricter than merely removing the old `== 1` validation. | I1    |
| O1 checker | Record the ownership-loss wake-up latency: `deferLostOwnership` deletes the receipt but retains `hinted_at`, so the next hint can wait for the 150-second sweep rather than `deferSeconds`.                                       | O2    |
| O1 checker | Prune stale capability-key entries for dispatcher index/main, the `plugin-orchestration/src/aws.ts` module-size entry, and the dispatcher-main/worker-environment duplication pair.                                               | I1    |

## Approved exceptions

These dates record the checker/founder's original approvals on the board;
later reconfirmations do not change them. Each row is the full approved scope, not a
general waiver of design §15.2 or unit ownership.

| Date       | Unit  | Approved exception                                                                                                                                               | Reason and limit                                                                                                                                                                                                                                      | Approved by            |
| ---------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 2026-09-26 | U1    | Root `package.json` appends `&& pnpm test:console:e2e` to `check`.                                                                                               | Makes the axe sweep and mobile-nav keyboard assertions part of the repository gate. Every wave-2 unit now runs console E2E; unrelated failures go to the checker, not into that unit's code.                                                          | Tejas, checker/founder |
| 2026-09-27 | D1    | New, unreferenced `scripts/seed-demo-price-cards.mjs` under frozen `scripts/*.mjs`.                                                                              | Design §18.10 requires it. No existing script or gate changes; created cards say **ILLUSTRATIVE — NOT A QUOTE**.                                                                                                                                      | Tejas, checker/founder |
| 2026-09-29 | O1    | Add only contracts, distribution, plugin-kit and plugin-ledger workspace dependencies to `apps/dispatcher/package.json` and its `pnpm-lock.yaml` importer.       | The production dispatcher imports all four directly; the owned-path list omits its frozen manifest. No other dependency or version changes.                                                                                                           | Tejas, checker/founder |
| 2026-09-29 | O1    | Give the shared distribution tests a dispatcher-only loopback DLQ URL and inert definitions for three host plugins; check the selected signal rows.              | The worker fixture must not carry dispatcher-only inputs. Compose selects the log signal before composition; both dispatcher cases remain covered.                                                                                                    | Tejas, checker/founder |
| 2026-09-29 | C2    | Add `@types/ws` to `packages/plugin-media/package.json` and its lockfile importer.                                                                               | The authenticated WebSocket media code needs the already-locked declaration version for typecheck.                                                                                                                                                    | Tejas, checker/founder |
| 2026-09-29 | O2    | Remove only plugin-ledger's obsolete plugin-observability manifest dependency and matching lockfile importer on O2 resumption.                                   | The ledger must import pricing contracts directly; keep the dependency graph consistent with that decoupling.                                                                                                                                         | Tejas, checker/founder |
| 2026-09-30 | O2    | Add inbound session cleanup only at the forced-termination callback in O1-owned `apps/worker/src/worker-loop.ts`, with a production-loop regression.             | Worker shutdown and job lease loss bypass `onSessionClose`; O2 must clear inbound state after the awaited owned-job termination without changing O1's fence or carrier ordering.                                                                      | Tejas, checker/founder |
| 2026-09-30 | O2    | Move forced-exit scenarios from O1-owned `apps/worker/tests/infrastructure-metrics.test.ts` into `apps/worker/tests/worker-forced-exit.test.ts`.                 | A faithful move with no removed assertions keeps the original test below the 500-line gate. I1 inherits ownership of the new test file.                                                                                                               | Tejas, checker/founder |
| 2026-09-30 | O2    | Add `scripts/mutation-sites.mjs`, `scripts/mutation-sweep.mjs`, `scripts/mutation-related.mjs` and `scripts/mutation-postgres.mjs` under frozen `scripts/*.mjs`. | The O2 checker required reproducible TypeScript and SQL mutation measurement, including isolated Postgres databases per mutant and repo-related survivor tests. No existing gate or script is changed; I1 inherits the runner.                        | Tejas, checker/founder |
| 2026-09-29 | M1    | Fix secret rotation inside the existing storage row lock.                                                                                                        | The AAD version must be chosen under the same lock as the credential update; limit edits to the rotation obligation.                                                                                                                                  | Tejas, checker/founder |
| 2026-09-29 | M1    | Add the `apps/api/src/routes/mcp-discovery.ts` module split.                                                                                                     | Keep the MCP discovery route within the module-size gate while implementing M1; no general API ownership transfer.                                                                                                                                    | Tejas, checker/founder |
| 2026-09-29 | D1/M1 | D1 owns control migration 006; M1 renumbers its paused migration to 007 before resumption.                                                                       | The control runner lacks a contiguity check, so landing 007 before 006 would silently apply migrations out of order. The second unit rebases and re-verifies both backends.                                                                           | Tejas, checker/founder |
| 2026-09-29 | C2    | `CarrierHttpRequest.externalUrl` carries the raw HTTPS query; `docs/architecture/plugin-platform.md` lines 934, 960 and 1702–1709 were amended.                  | Twilio signatures require the exact query-bearing URL. WSS upgrades retain the exact path without query; the frozen conformance driver's conflicting URL rebuild remains a hard I1 blocker.                                                           | Tejas, checker/founder |
| 2026-09-29 | D1    | Correct the shared test fixture to `format: MULAW_8K`.                                                                                                           | Make the fixture satisfy the carrier-media contract without weakening production validation or changing its assertions.                                                                                                                               | Tejas, checker/founder |
| 2026-09-29 | M1    | Extend expected-version fixture arrays to include control migration 6.                                                                                           | Existing fixtures must reflect D1's landed migration; M1 must also renumber its own migration to 007.                                                                                                                                                 | Tejas, checker/founder |
| 2026-09-26 | M1    | Correct the D1-owned `packages/plugin-storage/tests/fixture-admission.test.ts` pre-006 upgrade fixture for M1's version 7.                                       | The checker's rule (c) permits contract-correct fixtures. Remove the new `removed_at` column and version-7 row when constructing the old database, then assert all seven migrations; keep published-call and event assertions. I1 inherits this test. | Tejas, checker/founder |
| 2026-09-29 | C2    | Update three shared worker harness tests for the authenticated gateway and installed ingress.                                                                    | The prior private open shape was replaced. Preserve their lifecycle assertions and treat the shared tests as narrow touchpoints.                                                                                                                      | Tejas, checker/founder |
| 2026-09-29 | S2/I1 | Assign the real-Twilio-plus-real-Plivo integration test to I1 as a **BLOCKER**.                                                                                  | S2's plugin tests cannot prove the selected-carrier production path; I1 must run this integration before approval.                                                                                                                                    | Tejas, checker/founder |
| 2026-09-27 | All   | Continue updating `PM/**` despite its freeze, in documentation-only commits separate from code.                                                                  | The board is the unit status and checker-decision record; separating commits keeps unit-code reverts from reverting decisions.                                                                                                                        | Tejas, checker/founder |

## Changes requested

The cross-unit legacy-meter correction is Built at `724c0a0`, awaiting checker
confirmation. S1 and E1 remain Verified at their recorded merge commits. The
frozen host fail-closed contract remains a blocking I1 obligation.

## F2 checker pass (2026-09-23)

The builder's own review passed, so four independent audits went looking for what a green suite hides. They found real defects; all are fixed, each with a regression test that fails on the old behaviour.

**Blocking, found and fixed**

1. **The resampler aliased badly on the main production path.** Worst-case rejection was −31.6 dB at 24k→8k and −15.0 dB at 48k→8k, against an acceptance of ≥60 dB. The single test that "proved" it probed 6 kHz, which resamples to digital silence and would pass however wide the transition got. Root cause: a fixed taps-per-phase gives a pure decimation only 48 total taps, so the stop band began ~600 Hz above the output Nyquist and 4.0–4.6 kHz folded back into speech — audible on sibilants for 24 kHz TTS over an 8 kHz carrier. The prototype length is now derived from the attenuation and transition width. Measured after: **−76 to −79 dB on every pair**, pass band flat to ≤0.01 dB across 300–3400 Hz. The unit spec itself demanded two things that cannot both hold and is corrected.
2. **`ctx.net` had no address policy at all.** `assertPublicHost` existed with zero callers: cloud metadata (169.254.169.254), loopback, RFC1918 and `[::1]` all reached the transport. Every wave-2 provider and carrier plugin would have been unguarded. Now: host judged before connect, DNS answers validated, the connection pinned to a validated address, and any socket landing on a private address destroyed before a request byte is written. DNS rebinding is covered by test.
3. **The plugin host's guard was bypassable**, so "everything is a plugin" was advisory: `ctx.plugin`, `ctx.inject`, `ctx.root`, `ctx.scope`, `ctx.extend` and the event bus all handed back an unguarded context. Now blocked and recorded as a `context-escape` violation; enforce mode fails the composition.
4. **The conformance kits accepted badly broken plugins** — the kits every wave-2 plugin is judged by. A plugin could pass while returning 40 arbitrary bytes for every audio format, serving them from a colliding cache key, leaking the provider socket on cancel, reporting calls hung up without calling the carrier, never authenticating a callback, dropping 100% of usage billing, mis-mapping playback evidence in exactly the way §18.2 calls blocking, or writing audio after a barge-in. 24 findings fixed; the kits went from 95 to **174** checks.
5. **The capability-key gate was partly blind.** Its raw scanner mis-scanned any file containing a template substitution — 42 tokens seen in `apps/worker/src/main.ts` against 99 real literals. Now an AST walk; 8 previously invisible files appeared.
6. **The pinned HTTP tool connector never worked on Node 22.** `createPinnedFetch` paired the global `fetch` with an undici dispatcher, which fails with `invalid onRequestStart method`. Its tests always injected a fake fetch, so the real path was never exercised. Fixed with a regression test.

**Also fixed:** the `tests/` directory bypassing the import rules (which immediately exposed 7 real cross-package imports); `--write-baseline --only` silently truncating a baseline; `check-upstream` having no failure test; the module-size summary ignoring `--only`; G.711 plannable at impossible sample rates; the identity transcode handing back the caller's own buffer; `flush()` dropping most of the filter tail; an equal-rate resampler notching the band; SSRF gaps (3fff::/20 mask, IPv4-compatible ::/96, NAT64); FixtureNet not asserting request headers, and missing requests not being a mismatch; `ConnectorPolicyError` settling a write as `unknown` instead of `failed` (defect #12's execution-side mapping, which shrinks M1); policy errors without a `name`; a vendor hostname baked into a shared kit's default.

## F3 checker verdict (2026-09-23): changes requested

Reproduced exactly, nothing overstated: lint (7 gates), formatting, typecheck, build, Terraform, **1,000 passed / 104 skipped** default and **1,095 passed / 9 skipped / 0 failed** Postgres-serial. The skip arithmetic is right and all 17 new skips are genuinely Postgres-gated. All three independent sweeps reproduce. Every baseline shrink is real — regenerating them from scratch produces byte-identical content, and all 11 pending entries are genuine F3 artefacts. Sampled true-negative rows all hold.

The problem is not the numbers. It is that 1,000 green tests sit on top of four paths that cannot work.

### Blocking — live-call breakage

1. **Live `context` and `agent` calls cannot compose a session.** `session-catalog.ts:53-58` kept only the injected-plugin branch when the OpenAI inference fallback was deleted; `apps/worker/src/production-session-factory.ts:141` calls it with `output: {kind:'live'}` and no `inferencePlugin`, so compose throws `Missing service ovo.inference`. The spec ordered the deletion and F4 lands the bridges — but the regression is undisclosed while the unit reads green, and the deleted code never had a test. The cross-workspace guard on the inference binding (`binding.workspaceId !== input.workspaceId`) went with it and was not replaced.
2. **`terminateCarrierLeg` abandons the carrier leg when hangup fails.** `terminate.ts:28-40` reaches `media.terminate` only when `control.hangup` _returns_ `'unsupported'`. If it rejects — carrier 500, timeout, expired auth — the engine disposes, the error propagates, and a close-stream carrier's media socket is never closed. Closing that stream is the only thing that ends an Exotel call, so the call stays live after ownership loss, against §0.2. Same hole when a close-stream carrier's hangup returns `'ended'`.
3. **`issueStreamGrant` applies no ownership check** (`postgres/session-grants.ts:90-136`). After a lease expires and another worker claims the job at a higher epoch, the stale route still mints a token that authenticates, carrying the dead worker's endpoint. `reissueStream` enforces owner, epoch and lease; this path does not.
4. **The §4.10 step-1 fence no-ops for the caller it exists for.** `requestTermination` requires the caller to still own the route (`postgres/sessions.ts:124-129`) and returns `undefined` otherwise; `terminate.ts:27` discards that result. Ownership loss is the primary caller, and by definition it has already lost ownership — so the route is never marked `terminating` and a carrier continuation can still mint a grant. The seam also does not typecheck against the real store (1 parameter vs 4).

### Blocking — admission checks that do not run

5. **`playback_evidence_insufficient` returns `[]` when `selections` lacks `engine` or `carrier`** (`compat/playback-evidence-insufficient.ts:11`), and `ReleaseSelections` makes both optional. A confirmed write tool on a `playbackEvidence: 'none'` carrier produces zero issues. Worse, the inbound path picks its carrier from the route (`carrier-registry.ts:52-55`), which need not be the release's carrier at all, so compat never sees the carrier the call actually uses. §18.2 calls this blocking.
6. **`meter_uncovered` only checks roles present in `selections`** (`compat/meter-uncovered.ts:4-5`). A legacy release gets **no meter validation at all**, against §0.2's "validate required carrier, STT, TTS and LLM meter coverage before live admission". Nothing derives legacy selections before validating.
7. **A scripted announcement agent loses its input.** The existing rule is `mode !== 'announcement' || Boolean(config.script)` (`apps/worker/src/live-input-policy.ts:4-8`, commented "keep provider admission, engine input, and STT cost coverage aligned"). All three session-host copies dropped the `|| script` half, so such an agent gets `inputEnabled: false` and never listens for the transitions its own script declares, and loses its STT meter check. `engine-selection.ts:56` also hardcodes `initialVariables: {}` where the old path cloned the call's variables.

### Blocking — correlation and the Wave 2 contract

8. **`resolveSessionRoute` cannot match a route whose `carrier_call_id` is still NULL** (`postgres/sessions.ts:85`), so `streamForDial` bails before reaching the CAS-where-NULL logic that handles it correctly. This breaks exactly the request-id-only answer webhooks F3 added `markDialAccepted` support for: Exotel and Plivo.
9. **`inboundDecisionFor` discards `decision.state`** (`inbound-decision.ts:84-98`). All four callback states become a fresh offer, so a queued callback is re-prompted and a **suppressed (do-not-call) admission is turned back into a live offer**. The pre-F3 gateway branched on that state.
10. **The catalog hard-codes `plugin-voice`'s three plugins** (`distribution/src/catalog.ts:18-30`), so E2 cannot register its text filters without editing `packages/distribution`, which §15.2 freezes for Wave 2. `defaults.ts:4` already names `@winsendotai/ovo-text-filter-markdown`, an id that exists nowhere. Four other entries share the shape. This is the one thing F3 exists to prevent.

### Also required

- `carrier.call_id_mismatch` audit event (§4.10) is not implemented and `streamCallIdMatchesDial` is never consulted.
- Migration issues: the ledger probe is `search_path`-sensitive and can adopt and ALTER another schema's tables; `worker_slot_epoch` is added with no backfill, so no call in flight across the upgrade can resume; migration 004's constraint rename picks one matching constraint in heap order and can silently leave the narrow one in place.
- `listAudit`/`listEvaluations`/`listUsage` cursors truncate to milliseconds and can loop forever on a sub-millisecond row (`listCalls` was hardened, these were not).
- No `organization_id` or `carrier_id` predicate on the new orchestration surfaces: a duplicate `carrier_request_id` is a cross-tenant denial of service, and carriers share one call-id namespace.
- §15.3's "dependencies declared up front" is unfulfilled (`ws` in `apps/worker`, `fixture-calls` in `apps/api`, three packages in `apps/media-gateway`) because the unit spec says F3 changes no `apps/` file. The two documents contradict each other.
- Test-quality items: `proves()` asserts neither severity nor stage for 22 of 23 codes; the `mcp_tool_removed` and `termination_unsupported` pairings are tautological (the rules themselves are correct — the audit built the missing counterparts and they pass); `host-ports.test.ts` stubs `resolveSessionRoute` to return the same route for every query, which is what made finding 8 invisible.

## F3 builder response (2026-09-23): submitted for recheck

Nine blocking code paths and the additional migration, audit, cursor, scope and test-quality findings above have fixes and regression tests. The live inference path instead has an explicit failure test and a documented broken window owned by F4, as the checker permitted. Fresh review also found and fixed exact-ID stream mismatches, a stream-first request-ID correlation order, transitive host-service dependencies, and preservation of the already-applied control migration 004 checksum. The app manifest and admission wiring remain with their named owners in the carry-forward table.

Node 22 green bar: lint (7 gates), format, typecheck, **1,023 passed / 125 skipped** without Postgres; **1,139 passed / 9 skipped / 0 failed** in a fresh serial Postgres 17 run; 3 application bundles and Terraform validation. The original skip check was **991 + 104 = 1,095** and **1,086 + 9 = 1,095**: its 17 new skips were Postgres-gated, not disabled tests. The current run has **1,023 + 125 = 1,148** and **1,139 + 9 = 1,148**.

## F3 re-check (2026-09-23): 9 of 10 fixed, one narrow item open

Re-verified by three agents that reproduced every original failure against `a3d5542` before confirming the fix, so none of this rests on the builder's own tests. Green bar re-run by the checker: lint (7 gates), formatting, typecheck, build, Terraform, **1,023 passed / 125 skipped** default and **1,139 passed / 9 skipped / 0 failed** Postgres-serial. All 125 skips are conditionally database-gated; no disabled tests.

**Verified dead** (with the original failure reproduced first):

- **Carrier leg on a failed hangup.** The branch is now on `capabilities.control.hangup === 'close-stream'` rather than the hangup return value. A rejecting hangup, an `'ended'` return, and a throwing dispose all still close the stream. A throwing fence now disposes the engine instead of leaking it.
- **Stream-grant ownership.** Running `a3d5542`'s verbatim SQL against the same seeded database mints a token for a dead worker and authenticates it; `c89253e` refuses it, along with replaced, draining and expired slots and every non-connected job status.
- **The §4.10 fence.** Now matches the route's worker and epoch rather than the job's, so the dispossessed owner can fence; the result is checked, and the two-argument overload genuinely typechecks against the real store.
- **Both admission checks.** `playback_evidence_insufficient` and `meter_uncovered` fire with absent selections, legacy derivation runs inside `validateSelections` and fails closed when its inputs are missing.
- **The scripted announcement.** One shared `sessionRequiresInput` helper inside session-host, all three former copies import it, and per-call variables reach the engine.
- **NULL call-id correlation**, in both arrival orders, with the stream id held provisional; exact-id carriers still reject a differing id at both layers.
- **Callback states.** Queued, declined and suppressed each become a hangup with their own message; an unknown state throws.
- **The catalog.** All six entries load the owning module's own `plugins` export. E2 can now add two same-provider text filters touching only `packages/plugin-voice/**`; the old code rejected that pair with `Duplicate installed text-filter provider ovo`.
- **All five extras:** the `carrier.call_id_mismatch` audit event (four emit paths, conditional on the route actually holding both ids), the `search_path`-qualified ledger probe, the `worker_slot_epoch` backfill (only genuinely in-flight routes), migration 005 removing every narrow CHECK with a compound-check guard that refuses and asks for review, microsecond cursors on all three readers, and organization/carrier scoping that throws rather than silently widening.

**Still open — one item, in F3's own seam**

The fix for "live context/agent cannot compose" repaired the worker path and is honestly documented as a broken window with F4 named. But it introduced a differently-shaped break in `selectSessionGraph`:

1. **The workspace guard rejects the binding shape F3 itself declares.** `session-catalog.ts:57-63` treats any binding object without a `workspaceId` property as cross-workspace. `NormalizationBinding` (`normalize.ts:4-8`), which is what `select-session-graph.ts:208-216` passes, is `{id, provider, pluginId?}` — no `workspaceId`. So every `context`/`agent` release routed through the host seam dies with a misleading "Inference binding belongs to another workspace".
2. **`output: {kind:'host'}` is exempt from the live-inference assert**, so that graph composes with no `ovo.inference` provider and the original obscure `Missing service ovo.inference` resurfaces at `resolveGraph` — and `packages/plugin-session/tests/composition.test.ts:199-205` asserts `.not.toThrow()`, locking the wrong behaviour in.
3. **Per-call variables are shallow-copied** (`engine-selection.ts:58`, `select-session-graph.ts:105`) where the path they replace used `structuredClone`. Nested variable objects stay aliased to the caller's payload.
4. **Two test-quality items:** the `playback_evidence_insufficient` "valid counterpart" has `tools: []`, so the rule short-circuits before the evidence comparison and that half of the pairing would pass even if the logic were deleted; and `proves()`'s new `stage` assertion cannot fail, because `issue()` copies the stage it was given — the real gating (`RELEASE_RULES` vs `ADMISSION_RULES`) is untested.

**Recorded, not blocking:** the input predicate still exists three times repo-wide (session-host, `apps/worker`, `apps/api/src/live-readiness.ts:27`) and the 60-token duplication gate cannot see it — F4 should unify it; the legacy call-id-only lookup deliberately spans tenants and wants a deprecation owner; `findCarrierCallId(requestId)` is unscoped and degrades closed; the post-grant audit write is unwrapped; and `qualifierOf` still keys `carrier.control`, `carrier.ingress` and `background-task` by provider, which is the same shape as defect 10 for any wave-2 unit shipping two same-provider background tasks.

## F3 final verification (2026-09-23): verified

The four items from the re-check are fixed and confirmed by the checker against the real modules:

1. **The workspace guard no longer misfires.** It now only rejects when the binding actually carries a conflicting `workspaceId`, so the graph's `NormalizationBinding` shape (`{id, provider, pluginId?}`) passes. A genuinely foreign binding is still refused. Verified by composing all four shapes: graph-shaped binding → the clear F4 message, foreign binding → "belongs to another workspace".
2. **`output: {kind:'host'}` is no longer exempt.** `missingLiveInference` is now set for every non-simulation output, so the host seam fails with the same specific error instead of an obscure `Missing service ovo.inference` at `resolveGraph`. The `.not.toThrow()` assertion now covers the case where an inference plugin _is_ supplied, which is the correct thing to assert.
3. **Per-call variables are deep-cloned** (`structuredClone` at `engine-selection.ts:58` and `select-session-graph.ts:105`). Both tests mutate a nested value after the call and assert the engine still sees the original, so a shallow copy would fail them.
4. **Both test pairings can now fail.** The playback pairing carries the confirmed-write tool on _both_ sides, so the good case reaches the evidence comparison instead of short-circuiting on empty tools; and `compat.test.ts:37` asserts that every admission rule is absent at stage `release`, which is the real gating rather than the copied stage field.

Five carry-forwards are recorded with owners: unifying the input predicate across session-host, `apps/worker` and `apps/api` (F4); a deprecation owner for the legacy tenant-spanning call-id lookup; the unscoped `findCarrierCallId` (fails closed); the unwrapped post-grant audit write; and `qualifierOf` keying `carrier.control`, `carrier.ingress` and `background-task` by provider, which is defect 10's shape for any wave-2 unit shipping two same-provider background tasks.

**Wave 1 is complete.** F1 `da075a7`, F2 `3729f18` + `2edee0b`, F3 `a3d5542` → `c89253e` → `266ff92`. Wave 2's 15 parallel units are unblocked.

## F4 checker verdict (2026-09-24): changes requested

Reproduced exactly: lint (7 gates), format, typecheck, build, offline and frozen-lockfile installs, **1,054 passed / 130 skipped** default, **1,175 passed / 9 skipped / 0 failed** Postgres-serial, all five added skips database-gated, the ring-timeout sweep over all 600 values, the canonical line counts, and every baseline shrink (regenerating them produces byte-identical files). 17 of 19 sampled true negatives reproduce. **No default in the diff enables dialing, a paid provider or live admission**, and the restore fence is byte-identical.

The failures are in the wiring this unit exists to do.

### Blocking

1. **Every normally completed call is now recorded as FAILED.** The worker disposes with `media closed: behavior_completed` (`media-runtime.ts:104`); `asEndReason` (`plugin-kit/src/duplex-shims.ts:22-27`) does not recognise it and returns `error:media closed: behavior_completed`, so `recordSessionOutcome` writes `failed`. At `b859505` the same string mapped to `ended`. Defect #20's substring matching was **relocated into `asEndReason`**, not removed — it now also mis-classifies `cost-max-duration` and `carrier termination`. The test that appears to cover this passes an already-typed `'caller_hangup'`, skipping the conversion where the defect lives.
2. **The route is fenced AFTER the carrier media stream is closed** on the behaviour-completion path. The engine closes media inside its own dispose, and the fence only runs from the media-close callback (`worker-media-bootstrap.ts:62-88`). With Twilio's `markup-after-stream` continuation the `<Redirect>` to `/resume` fires while the route is still `connected`, so the call the host just ended can be revived — exactly what §4.10 step 1 and §0.2 exist to prevent, and the third time this ordering has broken in this project.
3. **Every engine-initiated end other than `behavior_completed` skips termination entirely** (`worker-media-bootstrap.ts:66`: `if (reason !== 'behavior_completed') return;`). `carrier stopped`, `STT ingress capacity exceeded`, `turn failed`, `media idle deadline exceeded` and `owning worker disconnected` produce no fence and no hangup, leaving a REST-carrier leg live.
4. **The inbound carrier gate is armed in the wrong process.** `setInstalledCarrierPlugins` is called only in `apps/worker/src/worker-process.ts`, and the worker never admits inbound calls. The media gateway does admit (`inbound-webhook.ts:217`) and never arms it, so its installed set stays empty and **every inbound number with an explicit carrier throws and returns busy TwiML**. Both happy-path tests arm the gate in `beforeAll`, so the suite cannot see it. This gate was also outside the authorization, which was propagation only with admission fencing unchanged.
5. **The engine dependency check never runs on the data-driven path.** `release-runtime.ts:53-84` builds the validation graph from `release.plugins` only, but the engine lives in `selections.engine`. A release whose engine requires a missing service publishes **201**, reads `releaseReady: true`, and then cannot start a session. The check fires only when the engine is pinned in `pluginIds`.
6. **A `context`/`agent` release still cannot be created through the selection model.** `session-factory.ts:35-45` builds bindings from `agent.config.providers` only, and production never supplies `inferencePlugin`, so `POST /releases` with `voice.llm` returns 422 "An inference binding is required". The relaxation F4 added at `release-graph.ts:45-50` is unreachable because the catalog step throws first. Obligation 2 is discharged on the worker, not on the API.
7. **Obligation 2 is not demonstrated end to end.** No test constructs `ProductionVoiceSessionFactory` with the `graph` argument, so the entire live branch (carrier selection, recording wiring, telemetry subscribe, engine start, dispose/outcome) is untested; the "live composition" test hand-assembles a fixture catalog and never calls `loadDistribution`. `'Live inference plugin is required until F4 wiring'` is still reachable.
8. **Inbound rows keep `carrier_id = 'twilio'` whatever carrier the route selected**, because the inbound writers never set it. Every scoped correlation path keys on that column, so a Plivo or Exotel route's durable rows claim the Twilio scope, F3's per-carrier partitions collapse, and inbound handoff for a non-default carrier can never succeed (`carrier-handoff.ts:96-99` selects control by `carrier_id`). Meanwhile the new `carrier_plugin_id` on jobs and session routes is **never read** — the propagation does not reach a consumer.

### Required before re-check

- The `weak-playback-evidence` acknowledgement is inert at runtime: `allowWeakEvidence` is never set (companions are added with `{}`), so a `carrier-processed` carrier can never confirm and the behaviour's `heard` check never passes. The release-level waiver therefore promises something the runtime cannot deliver.
- The native v2 engine adapter has **no test at all**, and the A65 regression tests (`production-engine-selection`, `native-extension-pins`) now construct the factory with 7 arguments, which routes them onto the legacy compat branch production never takes. Verified work silently migrated onto dead code, and that branch also omits telemetry subscription and recording evidence.
- `recording: false` has no test at the call site: substituting `enabled: true` passes the recording suite. That is a §0.2 invariant.
- The §2.6 event surface is incomplete: no `agent.transcript`, `interrupt` or `voicemail`, although `session-graph-runtime.ts:97-99` registers an `agent.transcript` branch.
- "completed without a session" is implemented twice with different predicates (`carrier-dial-settlement.ts:130` vs `reconciliation.ts:157`); only one is tested.
- `terminateOwnedJob` passes `store: { requestSessionTermination: async () => fenced }`, a constant, so the host's own fence and its failure throw are unreachable from the worker; and when the real fence fails (which _is_ ownership loss) nothing is torn down locally. The inbound ownership-loss branch that the tests exercise still runs fence and hangup concurrently in one `Promise.allSettled`.
- `runtime_incompatible` has become the catch-all release code for unrelated failures while its own rule can never fire; `turn_signal_missing`, `engine_capability_missing`, `stt_frame_size` and `mcp_tool_removed` can never fire from readiness because their inputs are never supplied; readiness cannot report `plugin_version_not_installed` or `legacy_release_unpinned` because it re-derives selections from the live registry; companion resolution demands exact version equality instead of §4.2's same-major rule; a refused paid evaluation returns 500.
- **Board and docs bookkeeping.** Five of the six inherited obligations are done in code but still read as open on the board, and three board bullets are now factually false. `docs/architecture/plugin-platform.md` contradicts the code in about 13 places (handshake TTL, §4.10 signatures and step 3, §4.5's `actualCarrier` claim, §4.7's import rule, §4.6 signatures, §4.9 file names). Fifteen new app files have no wave-2 owner although §15.5 declares the apps frozen, and two collide with D1's and M2's globs.
- `packages/conformance/src/kit/engine-harness.ts:209` carries the announcement-without-script predicate, so every wave-2 engine gets a scripted announcement with input disabled.

## F4 builder re-check (2026-09-24): built, awaiting check

All eight blocking findings and the additional required items above are addressed. The production factory test now loads the distribution, composes the selected graph, observes the host termination fence before media close, and checks a completed outcome with recording disabled. The media gateway installs the inbound carrier gate; admission persists the actual `carrier_id` while retaining nullable raw selection fields, and the worker reads those fields from the job payload. Release publication validates selected engine dependencies, and the API defers inference catalog construction only for an explicit `voice.llm` selection. The weak playback waiver, native v2 events, shared completion predicate, real termination fence, readiness inputs and issue codes, same-major companion resolution, structured evaluation refusal, conformance input predicate, owner map, and architecture text are updated.

Node 22 green bar: lint (7 gates), format, typecheck, **1,071 passed / 132 skipped** default; **1,194 passed / 9 skipped / 0 failed** in the serial Postgres run; three application bundles, Terraform validation, and offline frozen-lockfile installation. Both test totals equal **1,203**, so the 123 additional default skips are Postgres-gated. Focused mutations produced the expected failing messages before restoration, including `error:media closed: behavior_completed` causing a failed outcome, absent `fence:behavior_completed` in the completion path, a selected missing engine service publishing 201 rather than 422, the media gateway's installed-carrier call count falling to zero, and the API returning 422 `Live inference selection is required` when its explicit deferred-selection flag is removed. The restored focused tests pass.

## F4 re-check (2026-09-24)

Green bar re-run by the checker: lint (7 gates), format, typecheck, build, Terraform, **1,071 passed / 132 skipped** default, **1,194 passed / 9 skipped / 0 failed** Postgres-serial. Three agents drove the real production paths — the real `WorkerMediaRuntime.open`, the real factory and distribution, the real API through `app.inject`, real Postgres — and reproduced every original failure against `5376501` first.

**Verified dead**

- **Fence before the deliberate media close.** Proven against real Postgres: at `5376501`, `resumeStream` at the instant of the carrier media close returned a _grant_; at `54c132f` it returns `ended`, and the route is `terminating`. Markup-after-stream revival is closed.
- **`context`/`agent` releases through the selection model.** Both publish with `selections.llm` stored; a foreign-workspace binding, an uninstalled llm and a wrong-major pin are each still refused. The deferred-selection flag is narrowly scoped and the live path still fails closed.
- **Obligation 2 end to end.** Two tests now drive the real `ProductionVoiceSessionFactory` with a graph through `loadDistribution`; the "until F4 wiring" string is gone from production.
- **Inbound `carrier_id`.** A non-Twilio route now writes its own carrier scope, the worker overrides the release selection from the job payload, and non-default inbound handoff succeeds — all four verified against real Postgres, with the old commit reproducing the failure.

**Still open**

1. **The distribution-default engine is still never dependency-checked.** The check is gated on `agent.config.voice?.engine` (`routes/agents.ts:176-180`, `routes/readiness.ts:64`), but `normalize.ts:50-54` fills the engine only when the config lacks one — so a release on the default engine has `selections.engine` set and `config.voice.engine` absent, and skips validation entirely. Such a release publishes 201 with `releaseReady: true`, and the worker then refuses it with the identical message the API would have produced. Related: `release-graph.ts:72-88` never admits `tts`/`stt`/`vad`/`turnDetector` selections into the dependency set, so an agent-mode release on the real default engine is refused with `Release requires exactly one selected provider for ovo.tts-streaming`.
2. **`STT ingress capacity exceeded` still leaks the leg — and so does every engine-initiated end on an input-enabled call.** `performDispose` (`session-engine.ts:307`) calls `sttSession.close(reason)`, which reaches `sttAsLegacy`'s `session.cancel(reason)`; the instrumented session from `telemetry-stages.ts:107-136` is v1-shaped and has no `cancel`, so a synchronous `TypeError` escapes before the `.catch()` attaches and the fence-carrying media close never runs. Pre-existing, but it means the new fence is unreachable for exactly the case the rejection named, and behaviour completion on any script/FAQ/agent call never ends the call either. The announcement-only happy path masks it.
3. **`'carrier termination'` now maps to `caller_hangup`.** `WorkerMediaRuntime.terminate` closes with that literal, and `terminateCarrierLeg` calls `media.terminate` before `engine.dispose`, so on a close-stream carrier a lost lease or a cost cut-off would be recorded as a successful caller hangup. Latent today (the only shipped carrier is REST-hangup) and asserted as intended at `media-runtime.test.ts:55`. Free-form `error:${reason}` inference also remains for `worker-shutdown`, `job-lease-lost`, `task-protection-renewal-failed` and the `cost-*` reasons — the outcome bucket is right, the reason string is not.
4. **A NULL-carrier inbound route can now be refused.** `InstalledInboundCarrierPlugins.carrierId(null)` throws unless exactly one env carrier is configured _and_ installed, and the webhook's blanket catch turns that into busy TwiML with **no admission row** — the same class of silent outage as the original defect, moved to the other branch. Previously a NULL-carrier route always admitted.

### Two pre-existing blockers that would stop the first real call

Neither is F4's doing; both were found only because the re-check drove the real gateway and the real engine.

- **No live call can start.** `VoiceSessionEngine.start()` runs `startTurn` synchronously, which reaches `BoundedSpeechScheduler.beginEpoch` → `output.interrupt` → `media.clear()`, so a clear frame is written **before** `WorkerGatewayClient` sends `session.accept`. The gateway rejects it with `media sent before session acceptance` and closes the whole worker connection with 1008. Deterministic across runs of the full real-gateway harness.
- **Input-enabled calls never end** — the same `performDispose` throw as item 2 above.

These belong with E2 (engine) and D1/O1 (worker telemetry seams), but they block the demo matrix, so they need owners before wave 2 fans out.

## F4 builder second re-check (2026-09-24): built, awaiting check

The two pre-existing first-call blockers and four remaining F4 findings above are repaired. The native scheduler no longer sends an initial clear before gateway acceptance; a real `MediaGateway` and `WorkerGatewayClient` now accept and speak the opening announcement. Worker telemetry preserves the v2 STT session's `cancel`, `finish`, `write` and optional `forceEndpoint`; an input-enabled release composed through the real distribution now ends, fences and terminates its leg. E2 owns the engine correction, C2 inherits its gateway harness, and D1/O1 own the worker telemetry seam and lifecycle regression.

The API validates the resolved distribution-default engine and includes every selected slot in its release dependency graph. Worker close-stream termination forwards the actual typed `EndReason`, and legacy boundary strings now have explicit mappings. A NULL inbound carrier route uses the sole installed control even without a unique credential binding. Inbound admission refuses an unarmed gate before SQL, and the webhook reports that configuration failure as HTTP 503 rather than caller-busy TwiML. C2, O2, O1 and I1 inherit the corresponding shared touchpoints recorded above and in the F4 unit note.

True negatives were run by temporarily restoring the old source or reintroducing the old guard, then restoring the repaired files: the opening announcement never reached its mark; the STT bridge threw `session.cancel is not a function` and the production lifecycle never recorded `ended`; the default-engine route returned 201 where 422 was required, and old readiness returned `releaseReady: true`; the selected TTS dependency threw `Release requires exactly one selected provider for ovo.tts-streaming`; close-stream termination disposed as `caller_hangup` instead of `ownership_lost`, while the old reason shim returned `error:worker-shutdown` instead of `drain`; the NULL carrier fallback did not select `twilio`; and an unarmed admission reached SQL while the webhook returned busy XML. The restored focused regressions pass.

Node 22 final green bar: lint (7 gates), format, typecheck, **1,084 passed / 133 skipped** default, **1,208 passed / 9 skipped / 0 failed** Postgres serial, three application bundles, Terraform validation, and offline frozen-lockfile installation. Both runs total **1,217** tests; the additional 124 default skips are Postgres-gated. No live carrier, paid provider or AWS operation was run.

## F4 round 3 (2026-09-24)

Green bar re-run by the checker: lint (7 gates), format, typecheck, build, Terraform, **1,084 passed / 133 skipped** default, **1,208 passed / 9 skipped / 0 failed** Postgres-serial.

**Both first-call blockers are fixed, proven end to end.** Against `54c132f`, a full real-gateway harness (real `MediaGateway`, real `WorkerGatewayClient`, real carrier websocket, real distribution, real factory) recorded `[worker.hello, media.clear, session.accept, …]` and the worker connection dying with 1008 on every run; at `c0c3e61` five consecutive runs record `[worker.hello, session.accept, media.audio, media.mark]`, the carrier receives audio and a playback mark, and the worker socket stays open. For the input-enabled blocker, all eight termination routes now fence, hang up and record an outcome; at `54c132f` behaviour completion, STT overflow and turn failure recorded _nothing_ and left the leg up.

Also fixed: the default-engine dependency check (refusal message now byte-identical to the worker's, readiness agrees), and the `'carrier termination'` reason mapping across both carrier shapes and seven scenarios, with the mis-asserting test corrected.

### Still open

1. **The accept ordering holds by 4 microtasks, not by construction.** The scheduler no longer clears when nothing is active, but nothing prevents a media write before `session.accept`: `worker-client.ts:217-228` sends accept only after `onSession` completes, and `WorkerMediaSession.send` has no accept gate. Measured slack: inserting 4 extra microtask hops between `graph.engine.start()` and the accept send reproduces the original failure exactly. `StreamingMediaSpeechOutput.interrupt` still calls `media.clear()` unconditionally. The new regression test hand-builds the engine and never touches `loadDistribution`/`ProductionVoiceSessionFactory`/`WorkerMediaRuntime.open`, so it cannot see await-depth drift in the production path.
2. **A failed session open kills every other call on that worker.** Any failure inside `WorkerMediaRuntime.open` — no durable route, identity mismatch, terminal route, job not owned, or `graph.engine.start()` throwing because a provider is unreachable — reaches `worker-client.ts:230`, which writes a `session.close` frame pre-accept; the gateway treats that like any other pre-accept media frame and closes the **worker connection** with 1008, draining every in-flight call on it. Pre-existing, on the first-call path, same rule as blocker 1.
3. **An LLM-mode release still cannot be published in production.** `validatePermittedGraph` runs before the validation host that provides `ovo.usage-sink`, so a `context`/`agent` release selecting the real first-party OpenAI llm is refused with `Release requires exactly one selected provider for ovo.usage-sink`, while the worker composes the identical release. Tests pass only because they inject a fixture llm with `requires: []`. Pre-existing at `54c132f`, untested, and it means obligation 2 is not met on the API side for the provider production actually wires.
4. **Two silent inbound refusals remain, and arming is still forgettable.** With no carrier control installed, or two installed controls plus an ambiguous env, `carrierId(route.carrier_plugin_id)` throws inside the admission transaction, so the rollback discards everything and the webhook returns generic busy TwiML with no admission row. Unarmed admission now fails explicitly before any SQL (0 pool connects, distinguishable from a transient failure) — good — but arming is still a separate call at `media-gateway/src/main.ts:38`: a process that omits it boots reporting `ready: true` and fails only on the first inbound call.

### Secondary (record with owners)

- `duplex-shims.ts` maps `'owning worker disconnected'`, but the worker never receives that string — `worker-client.ts:185` produces `'gateway disconnected'`, which is unmapped. The new table entry is dead and the live string is missing.
- On `worker shutdown` and `job lease lost`, `onSessionClose` never fires (the engine is already out of the map), so `costs.finalize` and `inbound.completeSession` are skipped on those routes. `worker-loop.ts:213` may cover the cost half; needs checking, not assumed.
- The inbound env-carrier fallback now takes `installed[0]` when exactly one control is installed even if the env config names a different set, which loosens a guard the previous code kept.
- No test combines the real gateway with the real distribution and `WorkerMediaRuntime` — the only combination that proves a first call works.

## F4 builder round 3 repair (2026-09-24): built, awaiting check

The worker now queues at most 25 pre-accept media frames and bounds their bytes; `session.accept` is sent before the queue flushes. The gateway accepts `session.close` before acceptance as a refusal of that call, leaving its worker connection available. A production-path test runs the real gateway, loaded distribution, `ProductionVoiceSessionFactory` and `WorkerMediaRuntime`: a failed first open closes only its carrier, then the next call emits `session.accept`, `media.audio`, `media.mark` in that order and its carrier receives audio and a mark despite four added awaits and a 20 ms scheduling delay.

The API's permitted-graph walk now recognizes the host session capabilities that the worker supplies. `context` and `agent` releases using the actual first-party OpenAI inference bridge publish with HTTP 201 and compose in the worker. Inbound carrier configuration is resolved before the admission write transaction; no control, ambiguous or incompatible env, and an uninstalled explicit plugin create durable busy admissions with no job. A waiting call whose carrier disappears becomes a durable busy admission. The webhook returns HTTP 503 with the configuration reason, and gateway startup asserts that admission has been armed before reporting ready. The sole-control env fallback applies only when no incompatible env set was explicitly configured. The live `gateway disconnected` and suffixed cost-meter reasons now map to their typed end reasons.

True negatives were run with each broken implementation temporarily restored, then the repaired source restored: disabling the accept queue made the production first-call test miss its playback mark; removing its frame cap let the third frame resolve instead of throwing `pre-accept media buffer exceeded`; rejecting pre-accept `session.close` made the neighboring call miss its mark; removing the API host capability allowance made both LLM releases return HTTP 422 with `Release requires exactly one selected provider for ovo.usage-sink`; throwing on an inbound configuration refusal made the Postgres test receive `inbound_carrier_configuration_env_unavailable` instead of a durable busy row, while the old wait path returned `wait` instead of `busy`; loosening the env fallback selected `twilio` from an incompatible config; removing the webhook branch returned HTTP 200 instead of 503; and removing the two end-reason mappings produced `error:gateway disconnected` and the meter-suffixed error. The restored focused tests pass.

Node 22 full green bar: lint (7 gates, 914 files), format, typecheck, **1,090 passed / 138 skipped** default, **1,219 passed / 9 skipped / 0 failed** Postgres serial, build (three runnable bundles and console), Terraform fmt/init/validate, and offline frozen-lockfile install. Both test runs total **1,228**: 1,090 + 138 = 1,219 + 9 = 1,228. The 129 additional default skips are Postgres-gated. The first serial pass exposed two old tests that expected an exception and no admission row for an uninstalled plugin; their updated assertions require the intended durable busy row, and the final serial pass is green. No live carrier, paid provider or AWS operation was run.

## F4 final verification (2026-09-24): verified

Four rounds. Every fix was checked by reproducing the original failure against the previous commit first, then testing the new code adversarially through the production entry points.

**The acceptance test passes.** A `context` release and an `agent` release both publish (201) with the **real first-party OpenAI inference plugin** from the real `loadDistribution({role:'api'})` — no fixture llm, no injected `inferencePlugin`, Postgres storage — readiness agrees, and the _same stored release_ composes in the worker with `ovo.inference` present. Against `c0c3e61` the identical input returns 422. The relaxation is scoped exactly to the six services the worker host provides, and a genuinely uncomposable graph is still refused.

**A first call works, and is ordered by construction.** The accept gate refuses every frame but `session.close` until `accepted` is set synchronously at the accept write, so the call survives 4, 12, 50 and 200 extra microtask hops and a full second of wall-clock drift — where 4 hops broke it last round. Five consecutive real-gateway runs deliver audio and a playback mark to the carrier with the worker socket open.

**A failed open no longer drains the worker.** With two concurrent sessions, all six failure causes (no durable route, identity mismatch, terminal route, job not owned, carrier format, engine start) leave the live call streaming, the worker connection open and a subsequent third call working. At `c0c3e61` each one killed the live call and 1008'd the connection.

**Inbound configuration refusals are durable and distinguishable:** a `busy` admission row carrying the reason plus `503` plain text, versus busy TwiML for real capacity. The gateway aborts at startup rather than booting healthy while unarmed, and the `installed[0]` env fallback is now guarded.

### Carry-forward from F4's verification

| Item                                                                                                                                                                                                                                                                                                                                                                                                                     | Owner  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Pre-accept queue overflow (25 frames) closes the call with no audio delivered and no record: `media-runtime.ts:104` registers `media.onClose` after `factory.create`, so the overflow window inside `create` produces no `onSessionClose`, no `costs.finalize`, no `inbound.completeSession`, no route termination. Blast radius is one call, but the durable state leaks.                                               | C2     |
| Four of five open-failure causes (`media-runtime.ts:75/82/84/94`) throw before `onSessionClose` at `:100`, so a rejected session's route, job and cost meters are never finalised and are left to reconciliation.                                                                                                                                                                                                        | C2, O1 |
| `gateway.ts:158-162` still closes the whole worker connection with 1008 for a frame naming a session the gateway no longer holds — reachable when a worker `session.close` crosses an in-flight `session.cancel` (`gateway.ts:333` deletes first). Pre-existing.                                                                                                                                                         | C2     |
| A published voice-LLM release cannot be simulated: `release-simulation.ts:47-60` composes only `release.plugins ∩ behaviorGraph`, and the selection model keeps the llm in `selections`, so simulation returns `422 simulation_unavailable`. Newly reachable now that publishing works.                                                                                                                                  | D1     |
| Coverage: nothing drives `apps/media-gateway/src/main.ts`, so the startup `assertArmed()` guard has no in-repo test; and no repo test joins the signed webhook to the durable refusal row (the webhook test fakes operations, the durability test bypasses the webhook).                                                                                                                                                 | C2     |
| `InstalledInboundCarrierPlugins.carrierId()` still throws and now has no callers — a future caller would reinstate the rollback-in-transaction shape.                                                                                                                                                                                                                                                                    | C2, I1 |
| **Upgrade note (undeclared in M2's report):** replacing `localeCompare` with code-unit ordering changes persisted fingerprint _values_ for keys that differ only in case or use non-ASCII. Consequences, both fail-safe: a pre-existing paid authorization for such a release now fails closed with 403, and `importVersion` creates a new dataset version instead of deduping. Needs a release note, not a code change. | I1     |
| Prune the three stale `plugin-evaluations` architecture baseline entries, the stale `provider-executor.ts` module-size entry, and the three now-dead manifest dependencies (`behaviors`, `plugin-ledger`, `plugin-tools`) — until then a re-import would pass the gate as a warning.                                                                                                                                     | I1     |
| `packages/plugin-tools/src/json.ts:27` still has a second `canonicalJson` using `localeCompare`, consumed by `plugin-tools-mcp/src/schema.ts:69-70` for schema digests (defect #19's last site).                                                                                                                                                                                                                         | M1     |
| M2's spec verify command omits `apps/api/tests/f4-provider-evaluation.test.ts`, so the reported 17/23 counts cannot be reproduced from the spec as written; and the ledger type test is a runtime no-op (vitest has no typecheck project) whose value comes only from `scripts/typecheck-scope.mjs` — a reviewer counting green lines is shown an assertion that cannot fail at run time.                                | I1     |
| `duplex-shims.ts` maps `'owning worker disconnected'`, which the worker never receives; the live string `'gateway disconnected'` (`worker-client.ts:185`) is unmapped. `cost-runtime.ts:141` emits a suffixed `cost-meter-unconfigured:<meters>` that misses its table key.                                                                                                                                              | O1     |
| On worker shutdown and job-lease-loss, `onSessionClose` never fires, so `costs.finalize` and `inbound.completeSession` are skipped on those routes. `worker-loop.ts:213` may cover the cost half — verify, do not assume.                                                                                                                                                                                                | O1, O2 |

**Wave 1 is complete.** F1 `da075a7`, F2 `3729f18` + `2edee0b`, F3 `a3d5542` → `266ff92`, F4 `5376501` → `9b03079`. Wave 2's 15 parallel units are unblocked.

## Checker direction received 2026-09-26: finish Batch A

U1 is **Verified `75c55c0`**; later documentation commits preserve its code tree.
Serial foundation merges are unblocked. Merge and verify S1, then E1, then finish
E2, C2 and D1. The eight other unit heads recorded above are deliberately frozen
until Batch A is merged and verified. No new unit or worktree is to be started.
C3 additionally remains held for a founder decision on the authenticated 16 kHz
wire format; neither a fourth parameter nor reduced capability is approved.

The next S1 merge also appends `&& pnpm test:console:e2e` to the root `check`
script, as explicitly requested, so the console axe and keyboard suite is part
of the normal repository gate. This is a narrow approved root-manifest edit.

Frozen contract gaps use unit-local structural types or adapters under design
§15.2; no frozen contract is widened to unblock a unit. The checker approved the
specified manifest/lock importer changes for O1, C2 and O2, the specified M1/D1/C2
test fixture repairs, M1's storage-lock rotation and API module split, and S2's
fixture replay/compat work. Approvals for paused units are recorded for resumption,
not authority to work on those units before Batch A. Normal commands must pass;
temporary aliases never establish Built status.

### Persisted-value notes retained for I1

M1's committed note is retained verbatim:

> Persisted-value compatibility: replacing tool canonical JSON changes operation fingerprints and MCP schema digests for case/non-ASCII key ordering. An existing operation retry may conflict, and MCP approvals can need rediscovery/reapproval. This needs release notes even though ordinary ASCII-keyed values retain their digest.

Operator action: inspect the original operation before retrying a fingerprint
conflict; rediscover and reapprove MCP tools whose schema digests changed.

D1's committed note is retained verbatim:

> D1's observability change from locale-sensitive sorting to contracts
> `canonicalJson` changes persisted telemetry hash values when key ordering differs,
> including mixed-case and non-ASCII payload keys. `telemetryEventHash` is stored in
> `ovo_telemetry_events.event_hash`. Replaying an affected old event with the same
> identity now increments the conflict count rather than the duplicate count;
> the existing event and projections are retained. No hash backfill is included.
> I1 must retain this release note when integrating D1. The current manifest change
> does not change stored values.

Operator action: investigate a replay conflict against the retained original event
before retrying it; the changed hash does not authorize replacing its projections.

I1 inherits both notes and operator actions verbatim. C4's known foundation
Twilio-only gateway expectation is **discharged by C2**: the production gateway
first-call test and actual-Postgres admission regression use a non-Twilio carrier,
with a true negative that restores the Twilio-only handshake comparison. I1 must
preserve these regressions during integration; C4's paused branch is unchanged.

## Batch A builder handoff — 2026-09-26

S1 is merged at `e2c7cc5` and E1 at `ac8661d`, with exact-merge full bars recorded
above; both await checker verdicts. C2 is Built on its branch, not merged. The
normal root `check` script now includes `pnpm test:console:e2e`.

C2 final-code Postgres confirmation at `45c410a`: **1,455 passed / 8 skipped /
0 failed**. **1,319 + 144 = 1,463**; **1,455 + 8 = 1,463**; 136 default skips activated with
the database, and all eight remaining skips are separately database-gated.
C2's full report and true-negative proofs are committed at `1b14bfb` on `w2/C2`.
The disposable Postgres container was removed. Its carrier-neutral gateway
regression discharges the Twilio-only test assumption when C2 is merged.

The following ownership proposals were pending at this checkpoint; both are
approved by the 2026-09-27 ruling below:

- **E2:** the required markdown registration exposes mutation in the frozen
  normalizer before E2 receives control. Proposed one-line local boundary repair
  in I1-owned `apps/api/src/release-selections.ts`:
  `normalizeAgentConfig(structuredClone(agent.config), ...)`. The real API/SQLite
  regression fails now; the temporary caller clone gives 71 passed / 10 skipped
  for API plus regression. The caller file was restored. The frozen host stays
  untouched, and I1 inherits the general input-immutability gap.
- **D1:** `useDraft` needs a durable fixture snapshot, and idempotency needs atomic
  call plus initial fingerprint creation. The concrete production-route SQLite
  probes return `422 draft_snapshot_required` and, under the concurrent window,
  `409 idempotency_conflict`. The pending scope covers both storage backends'
  call/release repositories, migration runners, new control migration 006, and
  tests. D1 uses local structural types, with no frozen `ControlStore` edit.
  Public/live release reads must exclude fixture snapshots, non-test calls must
  reject them, and snapshots must not consume a publication slot. M1 must renumber its unpublished migration to 007 on resumption.

D1's local replay/cleanup work is committed. The combined E2+D1 diagnostic proves
played confirmation before final `yes`, exactly one actual fixture handler
execution afterward, and no live handler call. Its temporary E2 source overlay
was reversed; it is not a normal D1 green bar. The current normal suite retains
the failing F4-engine regression. Neither E2 nor D1 is Built.

Four worktrees remain. The eight frozen unit heads are unchanged. No unit outside
Batch A resumed; I1 has not started. Nothing was pushed.

## Checker decisions received 2026-09-27

S1 and E1 are under independent check; their verdicts are pending. E2's single
API caller clone is approved with its existing immutability regression. This is
an ownership exception: no `apps/**` path appears in design §15.2's frozen list.
The frozen normalizer remains unchanged in wave 2, and its mutation is a
**BLOCKING I1 contract gap**, not a permanent caller-clone convention.

D1's snapshot and atomic idempotency storage scope is approved, with **control
migration 006**. The M1 spec now allocates **007** when that paused unit resumes.
Read-only inspection confirms the current Postgres runner has no contiguity
check and would apply missing 006 after recorded 007; the previous proposal to
permit that sequence is superseded. I1 must prevent this class of gap.

Merge **E2, then D1**. D1 rebases onto landed E2 and must pass its normal full
bar, including the native confirmation test, before Built status. Hand C2 over
after those two land. All eight paused unit heads remain unchanged until Batch A
is merged and verified. No push is authorized.

### E2 landed and D1 dependency cleared (2026-09-27)

E2 merge `007606f` passed the complete normal bar and disposable Postgres serial
run: **1,369 + 138 = 1,507** and **1,498 + 9 = 1,507**. E2 is Built awaiting
check. D1 rebased onto that merge; its native confirmed-write fixture test passes
normally, without the old candidate overlay. D1 remains In progress while the
approved durable storage work completes. S1/E1 verdicts remain pending. C2 stays
unmerged and will be handed over after D1 lands. Three worktrees remain; all eight
paused heads are unchanged.

### D1 landed; C2 current-foundation handoff preparation (2026-09-27)

D1 is **Built – awaiting check** at merge `043b310`, after E2 `007606f`.
The exact-merge full check and serial Postgres run both exit 0:
**1,478 + 147 = 1,625**. Separately, **1,616 + 9 = 1,625**.
Its detailed acceptance, independent measurements, failure proofs and remaining
contract gaps are in the D1 spec. The D1 worktree and test container were removed.

C2 is **Built – awaiting check and unmerged** at `733907f` on `w2/C2`,
rebased onto foundation `58fb2f2` after E2/D1. Its full report is committed in
`PM/units/C2-gateway-router.md` on that branch. Source checkpoint `8bd0cf1`
(implementation `33fe188`) passed the full normal check: 1,527 passed /
153 skipped / 0 failed, plus 41 Playwright passed / 1 desktop-hidden Menu skip.
Full Postgres serial: 1,672 passed / 8 skipped / 0 failed. **1,527 + 153 = 1,680**.
Separately, **1,672 + 8 = 1,680**. All skips are database-gated; 145 activate with
Postgres. The four separately gated recording cases also passed 4/4.

Independent review of the resolved shared lifecycle/recording paths passed 25/25.
Forcing the fixture to ignore the negotiated format fails both PCM16 assertions:
`expected false to be true` and `promise resolved ... instead of rejecting`.
The fixture was restored byte-for-byte and its lifecycle tests passed 3/3.
The preceding C2 proofs remain in its spec; this rebase did not change production
behavior beyond the previously reported C2 implementation.

Frozen offline install, full `pnpm check`, scoped lint/full format **0 / 0**, and
standalone duplication **0** all pass. No baseline or frozen contract changed.
Both worktrees are retained for this handoff; the own test container was removed.
S1/E1 checker verdicts remain pending. C2 is handed over now, without merging.
All eight paused heads remain unchanged; I1 has not started and nothing was pushed.

Queue: Wave 1 complete; six of 15 Wave 2 units merged (M2, U1, S1, E1, E2, D1).
Of the nine unmerged units, C2 is Built and eight remain paused. I1 follows all
15 landed units and a green W2 gate. This board-only update changes no code.

## Checker verdict and legacy-meter correction — 2026-09-27

S1 **Verified `e2c7cc5`** and E1 **Verified `ac8661d`**. The checker exercised
all three provider selections independently and in a mixed graph, found no
provider names in the production session host/factory/legacy engine paths, and
reproduced six S1 plus seven E1 value-assertion true negatives. The reported
S1+E1 bar is an historical measurement of that tree, not the later E2+D1 tree.

The S1 integration builder owns the newly reported cross-unit storage snapshot
propagation defect now. The checker explicitly authorizes the minimal storage
fix and absent-input regression in session-host tests; the frozen `metersFor`
implementation remains untouched. Current foundation already includes E2
`007606f` and D1 `043b310` with control migration 006. Re-run the entire normal
bar and Postgres serial suite on the corrected current foundation, then hand
E2 over first for check; D1 follows, then unmerged C2. The eight paused heads
remain paused; I1 has not started.

### Current-foundation handoff after the verdict — 2026-09-27

Verdicts and ownership/exception notes were committed separately at `98b7196`.
The legacy binding correction is code-only **`724c0a0`**, Built awaiting check;
its exact three-file regression command fails with nine value assertions before
repair and passes **25/25** afterward, independently reproduced. No frozen
`metersFor` implementation or unconditional meter was changed. I1's zero-meter
fail-closed obligation remains blocking before legacy bridge deletion.

The complete normal and Postgres serial bars ran at **`724c0a0`**, which includes
E2 and already-landed D1. Full `pnpm check` **EXIT 0**: seven lint gates,
format, typecheck, default **1,494 passed / 147 skipped / 0 failed**, bundles,
console production build, audit and Playwright **41 passed / 1 desktop Menu skip**.
Postgres serial **1,632 passed / 9 skipped / 0 failed**, **EXIT 0**.
**1,494 + 147 = 1,641**. Separately, **1,632 + 9 = 1,641**.
138 database-gated cases activate; the remaining nine are eight separate-database
cases and one additionally ElasticMQ-gated lifecycle case. None is disabled.
Exact commands and logs are in the S1 correction and refreshed E2 reports.

**E2 is handed over first for check at the current code tree.** D1 remains on
migration 006 and follows E2's verdict; C2 remains unmerged at `733907f` and must
refresh on the new foundation before its later handoff. S1/E1 are Verified.
All eight paused heads are unchanged. I1 has not started. The own test container
was removed; only foundation and C2 worktrees remain. No push occurred.

## D1 verdict and E2 iterator correction — 2026-09-27

D1 **Verified `043b310`**. E2 is **not approved** until it returns the manually
acquired behavior iterator on every exit path. `Behavior.cancel` is optional;
third-party generators must have their `finally` cleanup requested by the engine.
Add a contract-legal no-cancel generator regression through real engine barge-in.
The current stalled-stream test only proves next-turn progress, not cleanup.

B2 is a hard I1 blocker. The three clones and the live, unprotected frozen worker
caller are named in the carry-forward row above. I1 fixes the normalizer and then
removes the three workarounds; no additional caller clone is authorized.
The current clone-reversion result is **nine** API HTTP 409 failures: api.test,
default-modes, f4-routes x2, real-llm-release x2, script-simulation x3. Earlier
seven-failure measurements predated D1's added call sites.

Before M1 resumes, its first act must be renumbering its unpublished control 006
to 007. Foundation already owns fixture-snapshots 006; an unrenumbered merge
throws `Control migration 6 checksum changed` against migrated databases. Keep
M1's paused branch unchanged until unfreeze. Once E2's iterator repair lands,
hand E2 back and submit refreshed C2. Batch A is otherwise done. No push.

## E2 iterator repair resubmitted — 2026-09-27

Code-only **`a27a5e4`** returns the optional behavior iterator in finally, with
nonblocking cleanup and rejection/synchronous-throw handling. A no-cancel
try/finally generator is exercised through real carrier DTMF barge-in, hangup,
disposal and epoch change. Eight pre-fix failures all report
`AssertionError: expected +0 to be 1`; the fixed focused suite and independent
rerun both pass **15/15**. The absent-return positive case is reported separately.

At that exact current-foundation code, `pnpm check` **EXIT 0**: default
**1,503 passed / 147 skipped / 0 failed**, Playwright **41 passed / 1 skipped**,
plus all lint, formatting, typecheck, build and audit steps. Full Postgres serial
**1,641 passed / 9 skipped / 0 failed**, **EXIT 0**. **1,503 + 147 = 1,650**.
Separately, **1,641 + 9 = 1,650**. 138 database-gated cases activate; the remaining
nine comprise eight separately database-gated cases and one also ElasticMQ-gated
worker lifecycle. Scoped lint/full format **0 / 0**; standalone duplication **0**.
Exact commands, failure proofs, generator limitation and logs are in E2's spec.

D1 remains Verified. C2 has rebased onto this repaired foundation with only board
conflicts and is running its refreshed full bar before submission, still unmerged.
The own test container is retained for C2's sequential run. All eight paused
heads remain unchanged; no I1 work or push. Board updates remain separate from code.

## E2 and refreshed C2 handed over — 2026-09-27

**E2:** source repair `a27a5e4`, separate report `b08f1b9`, Built awaiting
re-check. **C2:** unmerged `w2/C2` at **`2ac8f9e`**, checked source checkpoint
`ef82ffd` (rebased implementation `b75efea`) on foundation code `a27a5e4`.
Later C2 commits only copy E2's report and record this handoff. C2's own source,
tests and lockfile are unchanged from its previous handoff; inherited foundation
repairs and regression cases are included. No production/test rebase conflicts.

Both complete `pnpm check` runs exit **0**, including lint, formatting,
typecheck, default tests, all builds, audit and console E2E. Both scoped lint/full
format pairs exit **0 / 0**; both standalone duplication runs exit **0**.
No baselines changed. Playwright is **41 passed / 1 desktop Menu visibility skip**
on each tree. C2's frozen offline install also exits **0**.

| Tree                      | Default passed / skipped / failed | Postgres serial passed / skipped / failed |
| ------------------------- | --------------------------------- | ----------------------------------------- |
| Foundation / E2 `a27a5e4` | 1,503 / 147 / 0                   | 1,641 / 9 / 0                             |
| C2 `ef82ffd`              | 1,552 / 153 / 0                   | 1,697 / 8 / 0                             |

Foundation: **1,503 + 147 = 1,650**. Separately, **1,641 + 9 = 1,650**.
C2: **1,552 + 153 = 1,705**. Separately, **1,697 + 8 = 1,705**.
138 and 145 database-gated tests activate respectively. Foundation's remaining
nine include one additionally ElasticMQ-gated case; C2's remaining eight use
separate ledger/recording/restore database variables. No disabled tests.
C2's dedicated recording database command passed **4/4**, outside the totals.

The exact current C2 database commands were:

```sh
OVO_TEST_POSTGRES_URL=postgresql://postgres:fixture@127.0.0.1:32905/postgres pnpm exec vitest run --no-file-parallelism --reporter=dot --reporter=json --outputFile=/tmp/ovo-c2-refreshed-postgres.json
RECORDING_TEST_DATABASE_URL=postgresql://postgres:fixture@127.0.0.1:32905/postgres pnpm exec vitest run packages/plugin-recordings/tests/postgres-recordings.test.ts --no-file-parallelism --reporter=dot
```

The E2 report records eight pre-fix value failures (`expected +0 to be 1`),
independent focused **15/15**, the optional-return positive and async-generator
pending-next limit. C2's branch spec records its existing true-negative proofs
and prior independent **25/25** accurately as historical measurements; they are
not claimed as a fresh independent audit of this rebase. Both full bars are new.

D1 remains **Verified `043b310`**. The own loopback-only test container
`ovo-e2-c2-recheck-0927` was stopped and removed after both serial runs and the
recording check. Only foundation and C2 worktrees remain. The eight paused heads
remain C1 `382d690`, C3 `eaeb03f`, C4 `45ef2df`, S2 `00c80ec`, O1 `1e49894`,
O2 `cd77047`, M1 `dc9f471`, E3 `e4e821d`. No I1 work or push. B2 is still hard
blocking I1; no fourth clone was added. M1 first renumbers control 006 to 007 when
unfrozen. Board updates are separate from code; C2 awaits checker approval before
merge, and paused units remain paused until Batch A is merged and verified.

## C2 conditional merge approval received — 2026-09-27

The checker accepts C2 subject to the externalUrl design correction and missing
multi-carrier/no-ingress regressions. The latter are committed at `4cf850d`:
14/14 focused green and six value-assertion mutation failures, with no production
behavior change. Full verification is complete: default 1,556/153, Postgres serial
1,701/8/0, Playwright 41/1, recording 4/4; full check exits 0. The design amendment is prepared;
the verdict's simultaneous doc/frozen-fixture instruction conflicts with its
explicit prohibition on conformance changes now, and that sequencing decision
has been requested. C2 remains unmerged until both conditions can be discharged.

The fixture signature discrepancy is now HARD BLOCKING I1. All additional findings
have explicit carry-forward owners above. C2's inaccurate production-bypass claim
is corrected. Batch B is C1, C3, C4 and S2 after C2 merges and Batch A closes; no
paused branch has resumed during this conditional work. C1 or C3 must supply the
first actual production carrier ingress: Exotel/Plivo packages are still skeletons
and the legacy Twilio package exports telephony control/media-protocol capabilities,
so today's demo ingress comes from the conformance fixture.

C2 condition-2 verification completed at `4cf850d`: **1,556 + 153 = 1,709**.
Separately, **1,701 + 8 = 1,709**. 145 database-gated cases activate; all eight
remaining skips use separate database variables. Recording 4/4 is additional,
not added to either total. Frozen offline install exits 0. The own temporary
Postgres container was stopped/removed. The design patch is ready at
`/tmp/ovo-c2-external-url-design.patch`, but C2 remains unmerged while the
contradictory doc/frozen-helper sequencing instruction awaits a ruling.

## C2 merge approval and consistency ruling — 2026-09-27

The checker explicitly approves C2 to merge and confirms that this closes Batch A.
The prior sequencing instruction was self-contradictory and is superseded:
correct the architecture document now, with an explicit warning that the shipped
conformance signer/verifier still rebuild `${externalUrl}?${query}` and are known
inconsistent. The normative HTTP/WSS rule is authoritative. Frozen conformance
remains unchanged and its existing HARD I1 blocker remains in force.

**Standing precedent:** when a frozen file prevents full consistency, correct the
artifacts currently owned/authorized and document the remaining gap where the
reader encounters it. Do not leave a widely read normative artifact incorrect
merely to keep it aligned with a known-wrong frozen implementation. This does not
authorize edits to the frozen implementation; its named owner retains that work.

The architecture correction is `c3e691e`, including the explicit warning naming
both shipped driver files. The approved tests rebased to `4003748`; their source
is unchanged from `4cf850d`. Rebase onto current foundation `67c25af` completed
without conflicts or tree changes. Board updates are a separate commit. Merge
C2, run the complete gate on that exact merge commit, and hand back literal exits.

Batch B starts with **C1 (Twilio)** after the C2 handoff. C3 remains held on the
16 kHz wire-format question pending a confirmed Exotel answer; C4 and S2 follow
the carrier work. Only foundation and one unit worktree may be alive at a time;
remove C2's worktree after its merge, then recreate C1 from its preserved branch
and rebase onto the current foundation when starting it. No Batch B work has
started in this handoff. All eight recorded paused heads remain unchanged.
M1 remains paused; its FIRST act on resumption is renumbering control migration
006 to 007, because foundation owns fixture-snapshots 006 and merging its old
006 would throw `Control migration 6 checksum changed`. No I1 start or push.

## Batch A closed — C2 merged with exact-merge green bar (2026-09-27)

C2 is **Verified and merged at `e41c079`** following the checker's explicit merge
approval. Both conditions are discharged. The design now distinguishes raw-query
HTTPS callback URLs from bare-path WSS external URLs and explicitly names both
shipped conformance helpers as known-inconsistent. The rule is authoritative;
the frozen fixture repair remains **HARD BLOCKING I1**, unchanged in scope.
The tests rebased without source changes, and the checker accepted all six
value-assertion mutation proofs. No control migration was touched by C2.

All results below were measured on exact merge commit `e41c079`, with a clean
working tree before this separate documentation-only board update:

```text
FROZEN_OFFLINE_INSTALL_EXIT=0
FULL_CHECK_EXIT=0
SCOPED_LINT_EXIT=0 FORMAT_EXIT=0 DUPLICATION_EXIT=0
POSTGRES_SERIAL_EXIT=0
RECORDING_EXIT=0
```

`pnpm check` includes full lint/format/typecheck/tests/build/audit and console E2E.
Default **1,556 passed / 153 skipped / 0 failed**; Postgres serial **1,701 passed /
8 skipped / 0 failed**; Playwright **41 passed / 1 desktop visibility skip**;
separate recording database **4/4**. **1,556 + 153 = 1,709**. Separately,
**1,701 + 8 = 1,709**. 145 database-gated cases activate; the remaining eight use
separate ledger/recording/restore database variables. No disabled tests. Exact
commands and `/tmp/ovo-c2-merge-*` logs are in C2's final report.

**Seven of 15 Wave 2 units are merged. Batch A is closed per the checker.** Batch B
starts with **C1 (Twilio)**, the unblocked production ingress. No Batch B work has
started during this handoff. C3 remains held pending confirmed Exotel 16 kHz
information; C4 and S2 are queued in Batch B. E3, M1, O1 and O2 remain paused for
later batches. Their branch heads, and C1/C3/C4/S2's saved heads, are unchanged.
M1's FIRST action on resumption is control migration 006 → 007; foundation already
owns fixture-snapshots 006. Preserve the shared-runner rebase and verification rule.

The merged C2 worktree was removed immediately after merge. The own test container
was stopped and removed after verification. Only the foundation worktree remains;
keep at most two total when recreating the next unit's worktree. I1 has not started
and nothing was pushed. The authoritative consistency precedent above remains:
fix the authorized artifacts now and document a frozen remaining gap where the
reader encounters it.

## Batch B started — 2026-09-27

Checker explicitly closed Batch A: M2, U1, S1, E1, E2 (including `a27a5e4`), D1 and C2 are verified. Start **C1, then C4, then S2**, handing each completed unit back for independent check before the next merge. C3 remains founder-held pending a confirmed authenticated 16 kHz Exotel wire format; E3, M1, O1 and O2 remain paused. M1 must renumber control migration 006 to 007 as its first action when eventually resumed.

C1 starts from preserved `382d690`, rebased onto current foundation. Maximum two worktrees total. All carrier proofs use synthetic credentials, FixtureNet, conformance drivers and loopback sockets: no real credentials, vendor requests, live/provider/paid flags, calls, AWS, push or PR. C1 must supply the production ingress through release selections and the carrier-neutral gateway, and independently prove raw-query signature fidelity using the genuine offline Twilio validator. Frozen conformance remains untouched; its doubled-query reference driver is a HARD I1 blocker.

Board/spec changes stay separate from code commits. Scoped lint, full format and duplication exits must be reported together, followed by typecheck/build/default tests and a disposable loopback Postgres 17.6 serial run. Unrelated console E2E failures escalate to the checker.

## C1 handed over — 2026-09-27

**Built – awaiting check `9207fc1`, unmerged on `w2/C1`**, based on foundation `353ba5d`. The complete report, conditional/absent/negative matrix, independent genuine-SDK signature proof, three pre-C1 value failures, 16 deliberate mutation failures, missing-route before-fix failure and literal exit codes are in [C1's unit report](C1-carrier-twilio.md#c1-handover--built--awaiting-check-2026-09-27). Code and this report are separate commits.

Requested gates pass: scoped lint / full format / standalone duplication **0 / 0 / 0**; full lint, typecheck, build, offline/frozen install and console E2E **0**. Default **1,676 + 153 = 1,829**. Separately, Postgres serial **1,821 + 8 = 1,829**, zero failures. 145 skips activate with the main Postgres variable; the remaining eight use separate ledger/recording/restore database variables. Playwright **41 passed / 1 visibility skip**. A prior intermediate gate-subprocess failure and its isolated successful full rerun are disclosed in the report; no unrelated code was changed.

The production carrier supplies control and ingress through the real distribution and release selections and crosses C2's carrier-neutral gateway into the real worker media link on loopback. The Twilio SDK independently accepts the raw-query signature and rejects stripped/doubled query variants. Frozen conformance is unchanged and its known doubled-query behavior is still HARD BLOCKING I1. **Contract gap:** API handoff resume needs I1's host-built per-call callback wiring; the owned adapter fails closed without it. Carry-forward owners are recorded above.

All testing used synthetic credentials, FixtureNet and loopback only. The owned Postgres 17.6 container and Playwright artifacts are removed; no other containers/images were touched. Two worktrees remain for review. No push, PR, AWS, vendor request or actual call. C4 then S2 remain queued pending C1 approval/merge; C3 remains founder-held, and E3/M1/O1/O2 are unchanged. M1's first action remains migration 006 → 007 when it is explicitly resumed.

## C1 checker turnaround started — 2026-09-27

C1 is not approved. The checker verified the raw-query oracle, real distribution and gateway integration, one-way façade, architecture, fail-closed resume gap, and the 16 behavioral mutation proofs. The remaining blocker is HTTPS signature compatibility: the implementation accepts only the no-port form while Twilio 5.10.4 accepts no-port, with-port, and both legacy-querystring forms. Repair that set, keep WSS exact, and add the requested query/alias/AMD/partial-optionals coverage. Correct the earlier long-key claim and settle the account-SID pattern deliberately. Code and documentation remain separate commits; no C1 merge or next unit until re-check. All proof remains offline with synthetic tokens and loopback sockets.

## C1 correction handed back — 2026-09-27

**Built – awaiting re-check `fa9aa00`, unmerged on `w2/C1`.** The branch was rebased
onto current foundation `b5ce7ab` before repairing the HTTPS signature candidate
set. Only signature.ts changes in production; the new tests exercise every SDK
HTTPS candidate through the real distribution and gateway, preserve exact WSS,
and cover the requested absent/equal/partial inputs. The unit report corrects the
long-key claim and records the deliberate case-insensitive account-SID syntax.

[The re-check report](C1-carrier-twilio.md#checker-turnaround--https-signature-compatibility-2026-09-27)
contains exact commands, the 10 behavioral failures against the previous signature
source, all 16 deliberate mutation failures and independent SDK/Node-HMAC/gateway
measurements. **Scoped lint EXIT=0; format:check EXIT=0; duplication EXIT=0.** Full
lint, both typechecks, build, frozen offline install and console E2E also exit 0.
Default **1,698 + 153 = 1,851**; Postgres serial **1,843 + 8 = 1,851**, zero failed.
All skips are database-gated; E2E separately passes 41 with one desktop visibility
skip. Owned Postgres 17.6 container and Playwright artifacts are removed.

Code and this board/spec report are separate commits. Source remains unmerged
until the checker approves. C4 then S2 remain queued; C3 and the other held units
have not resumed. No push, PR, vendor request or call.

## Batch B: C1 verified and C4 started — 2026-09-28

The checker verified original C1 correction `fa9aa00`. Rebase onto foundation
replayed its code as `7c881db` with a byte-identical tree. The staged merge commit
`0567c56` passed the full gate before foundation was fast-forwarded to it: scoped
lanes and full lint/format/duplication/typecheck/build exit 0; frozen offline
install exit 0; default 1,698 passed / 153 database-gated skips; disposable
Postgres 17.6 serial 1,843 passed / 8 database-gated skips / 0 failed; console
E2E 41 passed / 1 desktop visibility skip. **1,698 + 153 = 1,851** and
**1,843 + 8 = 1,851**. The database, its anonymous volume, and Playwright
artifacts were removed. The C1 worktree and merged branch were removed. No push.

C4 starts now from preserved head `45ef2df`; rebase onto this foundation before
implementation. Maximum two worktrees. C3 remains founder-held for confirmed
16 kHz authenticated Exotel wire format. S2 follows C4's independent check.
When M1 unfreezes, its first action remains control migration 006 → 007.

## Batch B: C4 merge approval and final gate — 2026-09-29

The checker approved C4's `by-call-id` reconciliation and end-only handoff,
conditional on two missing-correlation assertions and correction of its stale
checkpoint numbers. The Plivo HTTP 201 without `request_uuid` test returns
`unknown`; the worker live-result case with no correlation IDs returns
`reconcile_required` without calling `markDialAccepted`. Both tests failed on
deliberately broken production guards with value or outcome assertions. The
worker test is an approved shared test touchpoint; no worker source changed.

Final C4 tree: scoped and full lint, full format, duplication, typecheck, build,
and audit all exit 0. Default Vitest: **1,749 passed + 153 skipped = 1,902**,
exit 0. Disposable loopback Postgres 17.6, serial with both Postgres and
recording database variables: **1,898 passed + 4 skipped = 1,902**, 0 failed,
exit 0. The extra default-run skips are database-gated. Console E2E: 41 passed, 1 desktop-menu
skip, exit 0. The owned container was removed. No vendor endpoint, live call,
credential, push or PR was used. S2 follows C4's fast-forward; C3 remains held.

C4 was fast-forwarded to foundation at `25e9e67`; the worktree and branch were
removed. On that exact merged commit, root `pnpm check` exited 0 (seven lint
gates, format, typecheck, default Vitest 1,749/153, build, audit and console
E2E 41/1). The disposable localhost Postgres 17.6 serial run exited 0 at
1,898 passed / 4 skipped / 0 failed. Its container and the Playwright result
artifact were removed. Foundation is clean and remains unpushed.

## Batch B: S2 started — 2026-09-29

After C4 merged and passed the full foundation gate, the saved `w2/S2` branch
was recreated in the second worktree and rebased onto `9421a63`. It contains
owned AssemblyAI and Sarvam implementations and tests. The 2026-09-29
continuation resolved the fixture replay question in owned paths; the frozen
legacy STT bridge remains an I1 integration gap. C3 remains
founder-held; no other paused unit was resumed.

## Batch B: S2 built for independent check — 2026-09-29

S2 code head `9d89a50` fills both production speech packages: AssemblyAI
Universal Streaming STT, Sarvam realtime STT, and Sarvam Bulbul TTS. Owned
tests drive distribution composition, two-turn fixture replay, native audio,
model-specific defaults and provider usage. The final full `pnpm check` exits
0 with 1,802 passed / 153 skipped default tests and 41 passed / 1 skipped
console E2E. The Postgres 17.6 serial run exits 0 with 1,951 passed / 4
skipped / 0 failed; both totals are 1,955, with 149 database-gated skips in
the default run. Scoped lint, full format check, standalone duplication,
typecheck, build and audit all exit 0. The S2 unit note holds the independent
true negatives and I1 carry-forwards. No merge, push, PR, real provider call,
or work on founder-held C3 occurred.

## Batch B closed; Batch C starts — 2026-09-29

S2 was fast-forwarded into foundation at `8353dba` after its two checker
conditions and REST pre-fetch spending guard landed. The exact merged head
passed `pnpm install --frozen-lockfile --offline` and `pnpm check`: 1,802
passed / 153 skipped default tests, 41 passed / 1 skipped console E2E, and
all lint, format, typecheck, build and audit lanes EXIT 0. Its disposable
localhost Postgres 17.6 serial run passed 1,951 / 4 / 0; both suites total
1,955 and the extra 149 default skips are database-gated. The S2 worktree,
owned container and Playwright result artifact were removed. Batch B is
closed. Batch C order is O1, O2, M1, E3; M1 first renumbers its unpublished
control migration 006 to 007. C3 stays founder-held. No push or PR.

## O1 verified and O2 resumed — 2026-09-30

The checker verified O1 code `7d0c934`. Its code and separate board commits
fast-forwarded foundation to `dbcd8c5`. On that exact merged tree, Node 22
`pnpm check` passed 1,858 / 173 default tests and 41 / 1 console E2E;
disposable loopback Postgres 17.6 serial passed 2,027 / 4 / 0. Both Vitest
totals are 2,031. The initial foundation typecheck lacked the four newly
declared dispatcher workspace links; the approved frozen offline install
restored them and the full rerun passed. The O1 worktree and owned database
container were removed. No other container was touched.

O2 is resumed next from saved WIP `cd77047`. Preserve the legacy selection's
OpenAI TTS meter coverage and account for O1's 150-second lost-ownership hint
delay when reviewing campaign timing. Pin `unknown_outcome` and `not_failed`
so an unreconcilable call cannot redial or become a guessed success, and find
a production redrive caller. M1 stays paused until after O2 and must renumber
its control migration to 007 on resumption. C3 stays founder-held. No push.

## O2 verified and merged — 2026-09-30

The checker verified O2 at `fc2c8a5` and reproduced the default bar: 1,867
passed + 206 skipped = 2,073; lint and format exited 0. The fresh Postgres
serial bar passed 2,069 + 4 skipped = 2,073. O2 rebased cleanly onto the
foundation's separate post-I1 roadmap documentation commit and fast-forwarded
at `f628448`; the code and tests remain the checker-verified tree. The four
re-check items are closed. I1 inherits the tracked 190/360 isolated SQL
survival baseline above. M1 is next, with migration 006 → 007 as its first
change; C3 remains founder-held. No push or PR.

## M1 resumed — 2026-09-30

After O2 was verified and merged, M1's preserved branch was recreated as the
second worktree. Its first edit allocated MCP-tool removal to control migration
007, then the branch rebased on foundation. The merged migration order is D1's
immutable fixture-snapshots 006 followed by M1's MCP removal 007 in both
Postgres and SQLite. M1 remains in progress, with production startup secret
enforcement (#14) and concurrent rotation (#13) prioritized. C3 stays held;
the post-I1 roadmap remains unstarted.
