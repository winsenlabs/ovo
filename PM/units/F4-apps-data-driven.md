# Work unit F4-apps-data-driven: API and worker made data-driven: plugin and compat routes, carrier URLs, selections at release, per-job carrier control, DialRequest v2 with settlement, termination path, session graph from selections, v1-engine compatibility, native engine as a v2 plugin

Wave: 1
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams
Defects fixed: [1, 20, 21, 26]

## Owned paths

- apps/api/**
- apps/worker/**
- apps/media-gateway/package.json
- packages/plugin-voice/src/production-plugins.ts
- packages/plugin-voice/src/media-output.ts
- packages/plugin-voice/src/plugins.ts
- packages/plugin-voice/src/engine-v2-adapter.ts
- packages/plugin-voice/src/index.ts
- packages/plugin-voice/src/production-media.test.ts (config-shape updates only)
- packages/plugin-evaluations/src/provider-policy.ts
- packages/plugin-evaluations/src/provider-gate.ts
- packages/plugin-evaluations/tests/provider-executor.test.ts

## Shared touchpoints (minimal edits allowed)

- pnpm-lock.yaml (app manifest dependency additions only)
- packages/plugin-voice/package.json (`@winsendotai/ovo-plugin-kit` dependency only; see checker note below)
- packages/plugin-operations/src/{inbound-gateway,inbound-session,inbound-carrier,inbound-existing}.ts and tests (carrier selection propagation; `inbound-existing.ts` is an unchanged helper extraction for the size gate)
- packages/plugin-operations/migrations/006_inbound_admission_carrier.sql and src/migrations.ts (wait-admission snapshot columns only)
- packages/plugin-orchestration/migrations/005_inbound_carrier_selection.sql, src/postgres/migrations.ts and tests/carrier-identity.test.ts (nullable durable carrier-selection columns and the migration-version expectation)
- scripts/baselines/*.json: lower or remove entries for files you rewrite; never add (transitional entries go in scripts/baselines/pending/F4.json)

**Checker note (2026-09-23).** The owned-paths list omitted `packages/plugin-voice/package.json`, but section C requires the native v2 engine to use `sttAsLegacy`, `ttsAsLegacy`, and `legacyFromDuplex` from `plugin-kit`. The builder stopped at that contradiction; the founder approved adding only the `plugin-kit` dependency and its lockfile entry as F4 shared touchpoints. E2 inherits this dependency and must keep its imports within the vendor-plugin architecture rule.

**Checker note (2026-09-24).** The board assigned inbound carrier-field propagation to F4, while design §15.5 assigns `plugin-operations` to O2. The checker authorized edits to `inbound-gateway.ts`, `inbound-session.ts`, and their tests solely for that propagation. The durable job and session tables had only nonnullable `carrier_id` (a carrier name) and nullable `binding_id`; they could not preserve a raw nullable plugin ID. F4 therefore added nullable raw-selection columns through a small orchestration migration, plus nullable wait-admission snapshot columns so a route edit does not change a waiting call's carrier. These additive migrations and the populated-schema migration test expectation are shared touchpoints for O1 and O2 under the founder's remaining-obligations rule; neither changes an ownership or capacity predicate. The original `NULL` env-binding spelling is preserved in every new row and payload field. The size gate required extracting carrier selection into `inbound-carrier.ts` and moving the unchanged persisted-decision helper into `inbound-existing.ts`; admission fencing, capacity reservation, ownership epochs, idempotency and transaction boundaries remain in their original paths.

**Checker note (2026-09-24, re-check).** The checker found that F4's carrier gate was armed in the worker, while admission runs in media-gateway. F4 now installs the gate from the loaded gateway distribution and persists the selected carrier's actual `carrier_id` alongside the nullable raw selection. `plugin-operations/src/inbound-carrier.ts` and its tests are shared O2 touchpoints for this correction. The checker also called out the scripted-announcement input predicate in `conformance/src/kit/engine-harness.ts`; its one-line correction and regression test are shared F2/E2 touchpoints. The native engine test and worker factory test use the production distribution and entry path. These edits do not change admission ownership or capacity fences.

**Checker note (2026-09-24, inference selection).** The host catalog requires a concrete inference plugin for live context and agent composition, including `output: { kind: 'host' }`. API release construction is the one deliberate exception: it sets `deferInferenceSelection` only when `voice.llm` carries a selection to validate after catalog construction. Without that explicit flag, the catalog throws `Live inference selection is required`; the selection-model API test also fails when the flag is removed. I1 inherits this distinction between release construction and live composition.

**Wave-2 owner map for F4's new app files (2026-09-24).** This map resolves additions omitted from design §15.5. The named owner has exclusive wave-2 edit responsibility; a broad glob in another unit does not transfer ownership.

| Owner | New app files                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C2    | `apps/media-gateway/src/inbound-carrier-installation.ts`, `apps/media-gateway/tests/inbound-carrier-installation.test.ts`, `apps/worker/tests/worker-media-bootstrap.test.ts`                                                                                                                                       |
| O1    | `apps/worker/src/{carrier-dial-settlement,carrier-runtime,carrier-completion,worker-carrier-plugin,worker-dial,worker-loop,worker-process,worker-termination}.ts`; `apps/worker/tests/{f4-carrier-settlement,f4-carrier-snapshot,carrier-completion,f4-dial-request,f4-termination}.test.ts`                        |
| O2    | `apps/api/src/carrier-handoff.ts`, `apps/api/tests/{carrier-handoff,carrier-handoff-postgres}.test.ts`, `apps/worker/src/cost-runtime-plugin.ts`, `apps/worker/tests/f4-cost-meters.test.ts`                                                                                                                        |
| D1    | `apps/api/src/release-simulation.ts`; `apps/worker/src/{legacy-session-compat,recording-evidence,session-graph-runtime,session-graph-host,speech-cache-v2,v1-engine-adapter}.ts`; `apps/worker/tests/{f4-recording-evidence,f4-session-graph,v1-engine-adapter,weak-playback,production-session-lifecycle}.test.ts` |
| M2    | `apps/api/src/provider-evaluation-inference.ts`, `apps/api/src/routes/evaluation-run-schemas.ts`, `apps/api/tests/f4-provider-evaluation.test.ts`                                                                                                                                                                   |
| I1    | `apps/api/src/{release-catalog,release-graph,release-selections}.ts`, `apps/api/src/routes/{plugins,registry}.ts`, `apps/api/tests/{f4-release-validation,f4-routes,f4-selection-release,f4-live-readiness,f4-companion-selection}.test.ts`                                                                         |
| D1    | `apps/api/src/routes/test-calls.ts`                                                                                                                                                                                                                                                                                 |

The gateway manifest now declares `contracts` for `Cap.carrierControl`; C2 inherits it. E2 inherits `plugin-voice/src/session-engine-guards.ts`, extracted to keep the session engine under its module-size baseline. The API readiness route reads immutable release pins through the control store's ascending paged list, so a current draft cannot conceal pin drift in the most recently created release.

## Specification

GOAL: after this unit, a release's engine, carrier, STT, TTS and LLM are DATA (release.selections). The API and worker build call graphs from that data through the registry and session-host, and wave-2 units never need to edit apps/api or apps/worker outside their own files. Read docs/architecture/plugin-platform.md (revision 2): sections 3.5, 4.1–4.10 and 15.5 (which files each wave-2 unit owns afterwards). session-host, distribution, the contracts and the orchestration store methods exist (F1–F3). Existing Twilio, Deepgram and OpenAI behavior must keep working through the distribution legacy bridges.

A. API (apps/api).

- index.ts and bootstrap.ts load distribution with role 'api'. The process graph includes carrier control and ingress (for handoff and URLs) and ovo.net.
- Split api-plugin.ts (360 canonical lines) so that route registration is a list in routes/registry.ts. Register a stub routes/test-calls.ts that always answers 404 {code: 'fixture_calls_disabled'}; D1 fills it without touching the registry.
- New routes/plugins.ts:
  - GET /v1/plugins?kind= → registry.project() plus unavailable;
  - POST /v1/plugins/compat {voice, mode, language, tools, campaign?} → CompatIssue[].
- routes/credentials.ts and schemas.ts:
  - bindings take an optional pluginId, inferred when exactly one installed plugin has that provider, otherwise stored NULL;
  - config is validated with registry.validateBinding;
  - new GET /v1/provider-bindings/:id/carrier-urls renders the carrier ingress operatorUrls through the host ports (binding-level url-secrets). The API needs OVO_MEDIA_PUBLIC_BASE_URL and OVO_INBOUND_ROUTE_SECRET; if they are unset, return 409 with a clear message.
- routes/agents.ts: release creation normalizes config.voice, builds rows and persists selections (including companions).
  - Explicit pluginIds still work, and an engine-kind id sets selections.engine.
  - Stage-'release' errors → HTTP 422 {blockers: CompatIssue[]}.
- release-runtime.ts (358 canonical lines; split first): replace WORKER_VOICE_PORTS and the scope check at line 80 with the runtime validateGraph(rows, catalog, {scope: 'session', parentKeys: [...HOST_SESSION_SERVICES, 'ovo.net']}). Validation never applies engine or provider plugins. Simulations still execute only the behavior graph.
- routes/readiness.ts: keep blockers: string[] and ADD details: CompatIssue[]. live-readiness.ts uses validateSelections(stage 'live') instead of the Deepgram and OpenAI parsers.
- GET /v1/calls (routes/inspection.ts): pass the order parameter (newest first by default). D1 adds the filters in wave 2.
- provider-evaluation-runtime.ts plus packages/plugin-evaluations/src/provider-policy.ts and provider-gate.ts: allow any installed llm-kind plugin, keep the meter checks, and remove the provider !== 'openai' checks.
- operations-runtime.ts: handoff through CarrierRegistry control.handoff.
- apps/api/package.json: add dependencies on distribution, session-host, plugin-kit and fixture-calls (the skeleton from F3).

B. Worker (apps/worker).

- Split main.ts (384 canonical lines) into main.ts (entry), worker-process.ts (process composition via distribution role 'worker', with carrier controls and ovo.net from plugin-kit createNodeNet, and no direct TWILIO_* reads) and worker-loop.ts (the delivery loop and active-session supervision). O1 owns these three files in wave 2.
- worker-media-bootstrap.ts: give createProductionWorkerMediaRuntime its FINAL signature. It takes {httpServer: http.Server (the health server from worker-health.ts on PORT, default 4100), ...} and returns {start(), close(reason), closeSession(sessionId, reason), terminate(sessionId)}. Internally it still uses the legacy WorkerGatewayClient in this wave; start() calls connect(). C2 later swaps the internals without changing the signature. main.ts must pass the health server.
- CarrierRegistry is built from ctx.all('ovo.carrier.control').
- runner.ts, inbound-runtime.ts, campaign-dial.ts, dial-request.ts, dial-settlement.ts, reconciliation.ts and worker-environment.ts:
  - Per-job control and capabilities come from CarrierRegistry.forRelease.
  - DialRequest v2 takes media.url and every callback (status, answer, amd, resume) from the host ports, per call with requestId (#1: never build '/twilio/media'; always wss).
  - media.routeParams {sid, rt} are set only when capabilities.control.streamParams is 'at-dial'.
  - maxDurationSec = maxCallSeconds + 30.
  - Handshake TTL = (ringTimeoutSec ?? 60) + 60 seconds, replacing the fixed 60 s (session-handshake.ts is yours in this wave).
  - markDialAccepted is called with carrierCallId and/or carrierRequestId.
  - Settlement follows the section 4.9 table (#26):
    - pending or live → wait;
    - ended busy or no_answer → failed with terminal_reason, retryable per policy;
    - completed with no session ever opened → failed with 'completed_without_session';
    - answeredBy machine → 'voicemail';
    - unmapped legacy states → pending.
  - No new CHECK values are needed; use the terminal_reason and last_error columns.
- Termination: behavior completion, ownership loss, drain and shutdown go through the session-host terminateCarrierLeg (section 4.10). A mediaRuntime.terminate(sessionId) that can't run yet in the legacy topology falls back to closing the carrier session exactly as today. Keep the regression test that ownership loss hangs up.
- production-session-factory.ts (322 canonical lines; split into session-graph-*.ts modules below 300):
  - Use selectSessionGraph with parent = the process composition.
  - The session-services plugin provides ovo.operation-store, ovo.secret-resolver, ovo.media.duplex (the recording-wrapped MediaDuplex via duplexFromLegacy), ovo.usage-sink (fanned out to cost and telemetry), ovo.transcript-observer and ovo.clock.
  - The worker speech cache is passed as a hostServices definition providing ovo.speech-output, which replaces the engine's streaming-output companion.
  - Telemetry wraps stt, tts and llm via decorateByKind.
  - Telemetry, recording and cost subscribe to engine.subscribe().
  - New recording-evidence.ts is a shim that feeds engine 'speech' events into today's capture.attachEvidence API (C2 owns capture.ts in wave 2 and keeps that API).
  - dispose(reason) maps the EndReason through outcomeFor, replacing reason.includes('completed') (#20).
- v1 engine compatibility: a release-pinned v1 replacement engine gets its v1 row config {language, inputEnabled, initialInput, initialVariables}, plus a host adapter with a no-op subscribe() and an 'end' event. production-session-support.ts keeps exporting selectVoiceSessionEnginePlugin, delegating to session-host engine-selection. DRIVER_IDS is deleted. Legacy releases resolve their selections unpinned; new releases follow section 4.2.
- cost-runtime.ts: required meters come from metersFor, and the carrier meter from the carrier manifest.
- speech-cache-runtime.ts: the key comes from TextToSpeech.cacheIdentity(format, voice).
- Remove imports of plugin-voice, plugin-providers, plugin-telephony-twilio and plugin-session from apps/worker/src wherever the contracts or session-host suffice. The architecture baseline for apps must shrink.
- apps/worker/package.json: add ws 8.21.3, distribution, session-host and plugin-kit. apps/media-gateway/package.json: add distribution, session-host and plugin-kit (C2 uses them in wave 2).

C. Native engine as a v2 plugin (packages/plugin-voice). Behavior stays unchanged and turn-policy.ts is untouched.

- production-plugins.ts becomes a v2 manifest: kind engine, provider 'ovo-native', config {session, engine}, and companions {'ovo.speech': scheduler id, 'ovo.speech-scheduler': scheduler id, 'ovo.speech-output': streaming output id}.
- It consumes ovo.stt v2 via sttAsLegacy, ovo.media.duplex via legacyFromDuplex, and ovo.tts-streaming v2 in media-output.ts via ttsAsLegacy.
- New engine-v2-adapter.ts wraps the existing engine as contracts VoiceSessionEngine v2:
  - subscribe() turns scheduler evidence into 'speech' events, and accepted transcripts into user.transcript and user.turn events;
  - dispose(EndReason) → EngineOutcome via outcomeFor.
- Map mark-confirmed receipts per section 2.5.
- Keep the exports session-host uses: createSpeechSchedulerPlugin, createSimulatedSpeechOutputPlugin, VOICE_PLUGIN_IDS and VOICE_SERVICE_KEYS.

TESTS:

- api:
  - GET /v1/plugins (no secret values);
  - POST /v1/plugins/compat, including playback_evidence_insufficient and its acknowledgement;
  - readiness details;
  - binding validation and inference;
  - carrier-urls;
  - a release persisting selections;
  - 422 on an unknown plugin;
  - release validation never applies an engine.
- worker:
  - engine events feed telemetry and recording;
  - a caller hangup records caller_ended, not failed;
  - the dial URL is wss://…/carriers/twilio/env/media and every callback carries r and t;
  - request-id-only acceptance;
  - reconcile busy → failed and never accepted;
  - completed without a session is not success;
  - termination order;
  - handshake TTL.
- HANDOFF regression tests (apps/api/tests/voice-engine-release.test.ts, apps/worker/tests/production-engine-selection.test.ts, native-extension-pins.test.ts and session-recording.test.ts) must pass with their assertions and expected messages UNCHANGED. The only edits allowed there are mechanical construction and wiring edits (for example constructor arguments) forced by the new factory shape.

CONSTRAINTS:

- Preserve every PM/HANDOFF.md safety constraint (section 0.2): meter coverage before live admission, recording disabled ⇒ no capture, ownership loss ⇒ hang-up, restore fences.
- Apps may import distribution, session-host, runtime and infra packages, never vendor-plugin or legacy-kind packages.
- Modules ≤300 lines; measure with node scripts/check-module-size.mjs.
- No live calls. No git commits.
- Keep pnpm lint, typecheck and test green (full repo).

## Acceptance

- GET /v1/plugins, POST /v1/plugins/compat and GET /v1/provider-bindings/:id/carrier-urls exist. Readiness adds details: CompatIssue[] while keeping blockers: string[]. Release creation persists selections and returns 422 with structured blockers.
- Release validation uses validateGraph with HOST_SESSION_SERVICES and never applies engine or provider plugins. WORKER_VOICE_PORTS is gone.
- The worker builds the live graph from release.selections through selectSessionGraph (companions and host speech-cache substitution included). DRIVER_IDS is gone. Legacy releases resolve unpinned and v2 selections are major-compatible.
- Telemetry, recording (via the recording-evidence shim) and cost subscribe to engine.subscribe(). A caller hangup records caller_ended.
- DialRequest v2 carries wss://<host>/carriers/<carrier>/<binding>/media with no query and per-call callbacks. Request-id-only acceptance works, settlement never treats busy, no_answer, voicemail or completed-without-session as success, and the handshake TTL covers the ring timeout.
- Every deliberate end and ownership loss goes through terminateCarrierLeg in the section 4.10 order.
- main.ts, api-plugin.ts, release-runtime.ts and production-session-factory.ts are split below 300 lines. createProductionWorkerMediaRuntime takes httpServer and returns start, close, closeSession and terminate.
- The HANDOFF regression tests pass with unchanged assertions. The apps no longer import plugin-providers or plugin-telephony-twilio (the architecture baseline shrinks). pnpm lint, typecheck and test are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm install --offline`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm lint`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm typecheck`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run apps/api apps/worker packages/plugin-voice packages/plugin-evaluations --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run apps/api/tests/voice-engine-release.test.ts apps/worker/tests/production-engine-selection.test.ts apps/worker/tests/native-extension-pins.test.ts apps/worker/tests/session-recording.test.ts --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm --filter @winsendotai/ovo-worker build`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm test`
