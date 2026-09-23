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

| Unit                          | Title                                                                                   | Depends on | Defects            | Status                                                                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------- | ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [F1](F1-contracts-runtime.md) | Contracts v2 and host enforcement                                                       | —          | 10, 18, 19, 20, 22 | **Verified `da075a7`**. Checks: lint across 599 files, format, typecheck, 512 tests pass / 87 skipped, Postgres serial run 590 / 9 / 0, build.                                                                                                                                       |
| [F2](F2-kits-gates.md)        | Shared kits (`plugin-kit`, `audio`, `conformance`) and hygiene gates                    | F1         | 12, 24, 27         | **Built – awaiting check.** Independent builder-side review found no remaining blockers. Checks: lint (7 gates), format, typecheck, 770 tests passed / 87 skipped, Postgres serial run 848 / 9 / 0, build and Terraform validation.                                                  |
| [F3](F3-host-seams.md)        | Host seams, selection storage and migrations, `session-host`, `distribution`, skeletons | F1, F2     | 1, 21, 27          | **Built – awaiting check.** Checker corrections committed for recheck. Node 22 checks: lint (7 gates), format, typecheck, 1,023 tests passed / 125 Postgres-gated skips, Postgres serial run 1,139 passed / 9 skipped / 0 failed, 3 application bundles built, Terraform validation. |
| [F4](F4-apps-data-driven.md)  | API and worker made data-driven                                                         | F1–F3      | 1, 20, 21, 26      | Not started                                                                                                                                                                                                                                                                          |

## Wave 2 (parallel; disjoint ownership per design §15.5)

| Unit                               | Title                                                         | Defects                  | Status      |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------ | ----------- |
| [E1](E1-turns-vad.md)              | Turn detector and VAD plugins, Pipecat-style                  | 3, 18                    | Not started |
| [E2](E2-native-engine.md)          | OVO native engine rebuild                                     | 3, 4, 9, 26              | Not started |
| [E3](E3-livekit-engine.md)         | LiveKit Agents JS engine plugin                               | 4                        | Not started |
| [C1](C1-carrier-twilio.md)         | Twilio carrier plugin                                         | 1, 21, 26                | Not started |
| [C2](C2-gateway-router.md)         | Carrier-neutral gateway router                                | 1, 2, 23, 26, 27         | Not started |
| [C3](C3-carrier-exotel.md)         | Exotel carrier plugin                                         | 21                       | Not started |
| [C4](C4-carrier-plivo.md)          | Plivo carrier plugin                                          | 21, 26                   | Not started |
| [S1](S1-speech-split.md)           | Split out the Deepgram STT, OpenAI TTS and OpenAI LLM plugins | 21, 27                   | Not started |
| [S2](S2-speech-new.md)             | AssemblyAI STT and Sarvam STT/TTS                             | 9, 21                    | Not started |
| [O1](O1-fargate-scaling.md)        | Fargate-native autoscaling, Terraform, Fargate prep           | 7, 15, 17, 23            | Not started |
| [O2](O2-ops-ledger.md)             | Campaign driver, queue liveness, reservation expiry           | 5, 15, 16, 19            | Not started |
| [U1](U1-console.md)                | Console refactor                                              | 8, 15                    | Not started |
| [D1](D1-demo-backend.md)           | Fixture test calls and the demo backend                       | 19, 20                   | Not started |
| [M1](M1-misc-defects.md)           | Behaviors, tools and security defects                         | 6, 10–14, 18, 19, 24, 25 | Not started |
| [M2](M2-evaluations-decoupling.md) | Decouple the evaluations package from other plugins           | 19                       | Not started |

## Wave 3

| Unit                    | Title                                               | Status      |
| ----------------------- | --------------------------------------------------- | ----------- |
| [I1](I1-integration.md) | Integration, full verification, docs and PM updates | Not started |

## Carry-forward issues

These are minor findings that don't block their own unit. The owner resolves them no later than the unit named.

| From | Issue                                                                                                                                                                                                                                                                                                                     | Resolve in |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| F1   | The guarded plugin context passes Cordis `inject`, `plugin` and accessors straight through to the raw context, so a plugin could bypass its declared `requires` and `provides`.                                                                                                                                           | I1         |
| F1   | Strict Ajv (without `allowUnionTypes`) cannot compile unions of primitive types such as `z.union([z.string(), z.number()])` in `definePluginV2` config schemas. Wave-2 authors must avoid that shape.                                                                                                                     | all wave 2 |
| F1   | The `lockfileSha256` in `docs/research/dependency-licenses.json` is stale. No gate checks it.                                                                                                                                                                                                                             | I1         |
| F1   | API release validation (`apps/api/src/release-runtime.ts`) still uses the synthetic `WORKER_VOICE_PORTS`. Switch it to `validateGraph` with host session services as parent keys.                                                                                                                                         | F4         |
| F1   | The `classifyConfirmation` test table lacks the literal `'no that is not correct'` case. A manual check passed.                                                                                                                                                                                                           | M1         |
| F3   | The new session-host APIs and `deriveLegacySelections` have no application caller until F4 wires the API and worker. F4 must call them on real release and session paths and provide legacy binding/default inputs for compatibility validation; leaving these unwired fails F4.                                          | F4         |
| F3   | Inbound route carrier plugin and binding fields persist, but admission does not yet carry them into durable job and session rows. F4 must propagate them before carrier-neutral inbound routing; leaving the migration fields unused fails F4.                                                                            | F4         |
| F3   | **Known broken window:** live `context` and `agent` sessions cannot compose until F4 supplies the selected inference plugin. The deleted legacy fallback is not silently restored; session-host now rejects this path explicitly and checks the binding workspace. F4 must wire the bridge before live calls are enabled. | F4         |
| F3   | F4 owns the app manifest additions deferred from §15.3: `ws` in worker, `fixture-calls` in API, and `distribution`, `session-host` and `plugin-kit` in media-gateway. F4 must install them before Wave 2.                                                                                                                 | F4         |
| F3   | The optional markdown text-filter default has no implementation until E2. E2 must add it to `plugin-voice`'s exported `plugins` array; distribution now consumes that array without an edit.                                                                                                                              | E2         |
| F3   | Inbound compatibility validation must use the actual carrier selected from the route. C2 must pass that selection as `CompatInput.actualCarrier` before admission; relying on the release carrier can miss blocking playback evidence.                                                                                    | C2         |

## Changes requested

None open.

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
