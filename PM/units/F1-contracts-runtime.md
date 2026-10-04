# Work unit F1-contracts-runtime: Contracts v2 (carrier outbound/termination seams, companions, fixture templates, confirmation lexicon), manifest v2, typed capability map, host enforcement, plugin registry

Wave: 1
Depends on: none
Defects fixed: [22, 18, 19, 20, 10]

## Owned paths

- packages/contracts/**
- packages/runtime/src/** (not packages/runtime/src/upstream/**)
- packages/runtime/tests/** (not packages/runtime/tests/upstream/**)
- packages/sdk/**
- packages/plugin-session/src/installed.ts
- packages/plugin-voice/src/provider-types.ts
- packages/plugin-voice/src/types.ts
- packages/plugin-orchestration/src/types.ts
- packages/plugin-providers/src/types.ts
- packages/plugin-tools/src/native.ts
- packages/plugin-observability/src/pricing.ts
- packages/plugin-ledger/src/inference.ts

## Shared touchpoints (minimal edits allowed)

- pnpm-lock.yaml (sdk gains zod 4.6.5, already in the store)
- Any test file that fails to compile only because a type moved: fix the import and nothing else
- scripts/check-architecture.mjs only if a current runtime import rule blocks you; never add node: imports to runtime

## Specification

GOAL: build the typed capability contracts and host enforcement that every later unit codes against. The normative source is docs/architecture/plugin-platform.md (revision 2): section 2 (contracts) and section 3 (manifest v2 and host). Copy its interface sketches exactly, including names, fields and defaults. Existing plugins keep working unchanged in warn mode. Wave 2 freezes contracts, runtime and sdk, so every seam listed here must be complete.

A. packages/contracts. Import only 'zod' and relative files. Pure functions are allowed.

1. Split src/index.ts (279 canonical lines) into agent.ts, ports.ts, manifest.ts and release.ts. index.ts becomes re-exports only, and every existing export must still resolve from '@winsendotai/ovo-contracts'.
   ports.ts holds:
   - Behavior: the existing members plus optional speechKind?(text): SpeechKindV2 | undefined and subscribe?(fn: (e: BehaviorEvent) => void): () => void;
   - BehaviorEvent (section 2.6): tool.started, tool.settled, confirmation.pending and confirmation.resolved with result confirmed|declined|expired;
   - Execution, ExecutionRequest, ToolConnector, OperationStore, OperationRecord;
   - InferenceRequest, InferenceReply, InferenceStreamEvent, and Inference with optional readonly provider and model;
   - Speech, SpeechReceipt (plus optional evidenceSource: PlaybackEvidence), EventSink, SecretResolver, ToolConnection, CallEvent;
   - NativeToolHandler and NativeToolContext, moved from packages/plugin-tools/src/native.ts, which re-exports them.
2. Add every module listed in section 2.1:
   - capabilities/keys.ts:
     - Cap enumerates EVERY service key used today. Grep provides:, requires:, ctx.provide(, ctx.get( and reflect.get( in packages/_/src and apps/_/src. That includes ovo.speech (execution's progress speech), ovo.operations, ovo.cost-ledger, orchestration.store and orchestration.queue.
     - Add the new keys: ovo.turn-detector, ovo.vad, ovo.text-filter, ovo.audio-filter, ovo.usage-sink, ovo.transcript-observer, ovo.clock, ovo.net, ovo.carrier.control, ovo.carrier.ingress, ovo.background-task and capacity.signal.
     - CAPABILITY_SPECS: cardinality 'many' for carrier.control, carrier.ingress, text-filter and background-task. Major 2 for ovo.stt, ovo.tts-streaming and ovo.voice-session-engine; 1 elsewhere. Scope per section 2.2.
     - DEFAULT_SPEC is one/either/1.
     - HOST_SESSION_SERVICES = [ovo.media.duplex, ovo.operation-store, ovo.secret-resolver, ovo.usage-sink, ovo.transcript-observer, ovo.clock].
   - capabilities/map.ts: type-only.
   - audio.ts: MULAW_8K, PCM16_8K, PCM16_16K, PCM16_24K, bytesPerSecond and sameFormat.
   - usage.ts:
     - UsageMeter with requestId required; the units include uncached_input_tokens.
     - UsageSink.
     - meterKey must reproduce 'deepgram.streaming-stt.audio_seconds', 'openai.streaming-tts.characters', 'twilio.carrier.audio_seconds' and the five 'openai.inference.*' keys in apps/worker/src/cost-runtime.ts.
   - inference-evidence.ts: move packages/plugin-ledger/src/inference.ts verbatim (pure, 210 lines). The old file becomes a re-export.
   - pricing.ts: move priceUsage, summarizeUsage and their types verbatim from packages/plugin-observability/src/pricing.ts. The old file becomes a re-export.
   - net.ts: NetPort, WebSocketLike, NetFixtureStep (the http step has optional body matcher and where), NetFixtureScript (with host), FixtureTemplateInput and FixtureTemplate (section 2.3).
   - clock.ts.
   - speech/capabilities.ts, speech/stt.ts and speech/tts.ts. SynthesisInput has an optional kind.
   - speech/legacy.ts: the v1 StreamingStt, StreamingSttSession, StreamingTts, TranscriptRevision, VoiceMediaTransport and VoiceProviderUsage, verbatim from plugin-voice/src/provider-types.ts and marked deprecated. provider-types.ts re-exports them.
   - voice/media.ts: MediaDuplex (including clearFlushesMarkers and optional onAnsweredBy) and PlaybackEvidence.
   - voice/evidence.ts: SpeechKind, SpeechSegment, SpeechEvidencePhase and SpeechEvidence, moved from plugin-voice/src/types.ts, plus SpeechKindV2.
   - voice/output.ts: SpeechOutput and SpeechOutputResult, moved from plugin-voice/src/types.ts. SpeechOutput gains optional prepare?(segment, signal): Promise<void>. plugin-voice/src/types.ts re-exports every moved type.
   - voice/engine.ts:
     - SessionInput: mode, language, inputEnabled, initialInput?, variables, maxCallSeconds, acknowledgements.
     - SESSION_INPUT_JSON_SCHEMA: a plain object that strict draft-07 Ajv accepts, with those required fields and optional initialInput.
     - VoiceSessionEngine v2, EngineOutcome, EngineEvent, StageKey and EngineCapabilities.
   - voice/end-reason.ts: EndReason, CallOutcome (includes 'canceled') and outcomeFor as a table:
     - behavior_completed → completed
     - caller_hangup → caller_ended
     - caller_idle → no_input
     - voicemail → voicemail
     - max_duration → limit
     - transferred → transferred
     - superseded → canceled
     - everything else → failed
   - voice/turn.ts:
     - VoiceEvent, TurnDecision and UserTurnController.
     - TurnDetectorFactory.create({clock, stt?, vad, language, mode, overrides?}).
     - TurnConfigSchema in zod with exactly the section 2.7 defaults, and the TurnConfig type.
     - defaultMuteRules(mode) per the section 2.7 table.
   - voice/vad.ts and voice/filters.ts.
   - carrier/capabilities.ts, carrier/control.ts, carrier/media.ts and carrier/ingress.ts, exactly per section 2.8:
     - CarrierCapabilities, including media.queryOnMediaUrl, control.streamParams, control.streamCallIdMatchesDial and control.cancelBeforeAnswer. continuation is 'markup-after-stream' or 'none'.
     - DialRequest.callbacks = {status, answer, amd?, resume?}.
     - HangupQuery, and TelephonyControl v2 with hangup(q: HangupQuery).
     - Reconciliation, where carrierCallId is optional on live and ended.
     - UpgradeRequest {url including its query, externalUrl without query, headers, remoteAddress?}.
     - MediaSerializer.authenticateUpgrade, whose ctx includes verifyUrlSecret.
     - MediaCodecSession with optional terminate().
     - A CarrierProtocolError class.
     - CarrierHttpRequest (with query and remoteAddress) and StreamGrant.
     - CarrierHostPorts: resolveBinding, admitInbound, confirmCallback, applyCallEvent, streamForDial, resumeStream, mediaUrl(opts.query), callbackUrl(opts.requestId) and verifyUrlSecret(req, opts). There is NO mintRouteToken.
     - The CarrierHttpRoute purposes include 'answer'.
     - CarrierIngress, including operatorUrls and legacyPaths.
     - NormalizedCallEvent, including bindingId and carrierRequestId.
     - InboundAdmission and InboundDecision, derived from what apps/media-gateway/src/inbound-webhook.ts and packages/plugin-operations/src/inbound-gateway.ts exchange today: connect, wait, callback offer, human handoff, busy, reject and hangup.
   - ops/background-task.ts.
   - ops/capacity-signal.ts: CAPACITY_METRIC_NAMES with namespace 'OVO/Capacity' and RequiredSlots, ProvisionedTasks, BusySlots, ReadyIdleSlots, EligibleJobs, CampaignDemand and OldestEligibleJobAgeSeconds.
   - ops/recording-tap.ts.
   - selection.ts: Slot, VoiceSelection, AgentVoice, and the Acknowledgement enum ['weak-playback-evidence', 'model-licence:livekit-turn-detector', 'model-licence:silero', 'model-licence:smart-turn'].
   - blockers.ts: CompatCode (the section 4.5 list, including termination_unsupported and legacy_release_unpinned), CompatStage ('release' | 'live' | 'test') and CompatIssue (with stage).
   - canonical-json.ts: keys ordered by code unit, never localeCompare; value semantics as JSON.stringify.
   - text.ts:
     - normalizeForMatch: NFKC, then toLowerCase, then replace each run of characters outside the Unicode letter, mark and number classes with one space, then trim.
     - countWords: Intl.Segmenter with word granularity, counting isWordLike segments.
     - CONFIRM_YES, CONFIRM_NO and CONFIRM_FILLERS, stored pre-normalized exactly as in section 2.10.
     - classifyConfirmation(text) → 'yes' | 'no' | 'unclear': any NO phrase anywhere as a token subsequence → no; otherwise strip fillers at both ends, and a remainder equal to exactly one YES phrase → yes; anything else → unclear.
3. AgentConfig: add optional voice per section 4.1, and keep providers exactly as it is. Contracts must contain NO first-party plugin ids. Release: add optional selections per section 4.2, with keys for the slots plus textFilter:N and companion:KEY.
4. Manifest: accept contractVersion 1 (the current schema, unchanged) or 2 (the section 3.1 fields, including companions, meters[].when and LlmCapabilities {tools, streaming}).
   - Export ManifestV2, PluginKind and normalizeManifest, which upcasts v1 to kind 'infra' with optional [].
   - v2 validation: kind is required. engine, carrier, stt, tts and llm must declare provider, capabilities, runtime.egressHosts and conformance. meters are required for carrier, stt, tts and llm. provider is required for vad and turn-detector. companions are allowed only on engine.

B. Shims. These are type re-exports or verbatim moves, with no behavior change:

- plugin-voice provider-types.ts and types.ts;
- plugin-orchestration types.ts (add the v2 carrier types; keep the legacy TelephonyControl);
- plugin-providers types.ts (UsageMeter);
- plugin-tools native.ts;
- plugin-observability pricing.ts;
- plugin-ledger inference.ts.

C. packages/runtime. Imports stay cordis, contracts and ajv only; never node:fs. Split src/index.ts into graph.ts, compose.ts, facade.ts, scope.ts, config-guard.ts, enforcement.ts, registry.ts, installed.ts, validate-graph.ts and index.ts, each ≤300 canonical lines.

1. resolveGraph:
   - Many-keys may have several providers, qualified as `${key}:${provider ?? id}`.
   - Requiring a many-key depends on all of its providers; zero providers is allowed.
   - One-keys keep the 'Ambiguous service' error.
   - Optional keys don't gate anything.
   - Keys the parent satisfies count as present.
2. compose(rows, catalog, opts?), with opts = {scope?, parent?, workspaceId?, enforcement?, net?, fixtures?}:
   - EVERY composition is a separate Cordis root. Cordis keeps one service registry per context tree and throws 'service has been registered' on duplicates, so a session is never a Cordis child of the process composition.
   - Reject a scope mismatch when opts.scope is given.
   - Keep the current behavior when opts is omitted.
   - The Cordis inject is requires minus optional keys, many-keys and parent-satisfied keys.
3. facade.ts, per section 3.3:
   - Each apply gets a Proxy implementing PluginContext.
   - Declared parent keys are served by delegating to parent.ctx.
   - get, maybe, all or reflect.get of an undeclared key → violation 'read-undeclared'.
   - provide of an undeclared key → 'provide-undeclared'.
   - net is filtered by runtime.egressHosts (https and wss only); 'egress-denied' ALWAYS throws.
   - An engine-kind plugin touching ovo.execution or ovo.tool-connector.* → 'engine-tool-access', which always throws.
   - ctx.secret(pointer) reads {credentialRef:{credentialId}} at a JSON pointer in row config and resolves it through the host's ovo.secret-resolver with opts.workspaceId.
   - v1 manifests use OVO_PLUGIN_ENFORCEMENT (default warn); v2 manifests always enforce.
4. enforcement.ts: composition.violations, plus exported setViolationSink and getViolationSink. Every violation also goes to the sink.
5. config-guard.ts: a plain string at a secretFields pointer → 'secret.inline' error, in every mode.
6. Kind rules from section 3.8:
   - engine companions must exist at the same version;
   - the glibc check uses process.report.getReport().header.glibcVersionRuntime, and missing glibc marks the plugin unavailable instead of throwing.
7. The single Ajv instance: strict true, allErrors, and formats {uri, email, uuid, date-time, date, time, duration, ipv4, ipv6, hostname} all set to true (annotation-only; zod enforces them at apply). The runtime still may not import ajv-formats.
8. validate-graph.ts: validateGraph(rows, catalog, {scope, parentKeys}). It resolves the graph and validates scope, config and kind rules, but NEVER runs apply. It returns {ordered, issues}. The API uses it with parentKeys = HOST_SESSION_SERVICES plus ovo.net, replacing the synthetic WORKER_VOICE_PORTS plugin.
9. registry.ts, PluginRegistry:
   - list, resolve and get;
   - resolvePin(id, version): the exact version, otherwise the same id with the same semver major, for kinds engine, stt, tts, llm, vad, turn-detector, text-filter and carrier, and for companions. It returns {definition, exact}.
   - validateBinding (Ajv, strict false);
   - project(): JSON-safe, with no functions and never a secret value;
   - unavailable(), with reasons.
10. installed.ts:

- Move loadInstalledSessionExtensions and its helpers from packages/plugin-session/src/installed.ts, which becomes a re-export.
- Accept module.fixtures and module.fixtureTemplates.
- Validate id uniqueness, and (kind, provider) uniqueness for session kinds.
- Parse v2 manifests.

11. definePlugin: make it generic over `as const` requires and provides for typed get and provide. The plain-string overload stays and is declared LAST, because Parameters<typeof definePlugin> resolves to the last overload and existing tests rely on it. packages/runtime/tests/composition.test.ts must compile and pass UNCHANGED.

D. packages/sdk: definePluginV2({...manifest, config: zodSchema, binding?: zodSchema}, apply).

- configSchema = z.toJSONSchema(schema, {target: 'draft-7', io: 'input'}) with $schema stripped. io 'input' is mandatory: the default 'output' marks every defaulted field required, and an empty row config then fails.
- binding produces bindingSchema the same way.
- apply receives schema.parse(config).
- Add zod 4.6.5 to sdk/package.json.
- Verify that the runtime's strict Ajv compiles the output of a schema using .default(), z.url() and z.enum().

TESTS TO ADD:

- packages/contracts/tests:
  - manifest v2, including companions and meters.when;
  - selection and voice schema, including that a legacy AgentConfig still parses;
  - canonical-json;
  - text: Devanagari, plus the classifyConfirmation table from section 2.10, including 'no that is not correct' → no, 'okay' → unclear and 'haan ji' → yes;
  - end-reason;
  - capability-keys coverage;
  - a carrier-contract type fixture.
- packages/runtime/tests:
  - facade;
  - cardinality;
  - scope-parent: two concurrent session compositions under one parent, each providing ovo.stt, compose without collision;
  - validate-graph never calls apply;
  - secrets;
  - enforcement-sink;
  - registry, including resolvePin exact, same-major and different-major cases;
  - installed (moved or extended);
  - glibc-unavailable;
  - ajv formats.
- packages/sdk/tests: define-plugin-v2, where an empty config gets its defaults and a schema with a url field compiles.

CONSTRAINTS:

- Modules ≤300 canonical nonblank lines (400 hard, tests 500). Measure with node scripts/check-module-size.mjs, never wc.
- contracts imports only zod.
- Do not change the upstream/ files.
- Preserve the PM/HANDOFF.md safety constraints (doc section 0.2).
- No live or paid calls. No git commits.
- Keep pnpm lint && pnpm typecheck && pnpm test green (baseline 380 passing / 87 Postgres-skipped); the test count may only grow.

## Acceptance

- packages/contracts/src/index.ts contains only re-exports. Every contracts file is ≤300 canonical lines and imports only zod or relative modules, and every previously exported name still resolves.
- Cap and CAPABILITY_SPECS cover every service key used in packages/_/src and apps/_/src, including ovo.speech, ovo.operations, ovo.cost-ledger and orchestration.store. The many-cardinality keys are exactly carrier.control, carrier.ingress, text-filter and background-task. HOST_SESSION_SERVICES is exported.
- The carrier contracts match section 2.8: DialRequest.callbacks.answer, HangupQuery, streamForDial and resumeStream on CarrierHostPorts, UpgradeRequest.url with query, MediaCodecSession.terminate, capabilities.streamParams, streamCallIdMatchesDial, cancelBeforeAnswer, queryOnMediaUrl, and no mintRouteToken.
- Behavior has optional speechKind and subscribe, SpeechOutput has optional prepare, SessionInput has mode, and TurnDetectorFactory.create takes mode and overrides.
- classifyConfirmation implements whole-utterance matching where NO wins, and the section 2.10 table passes. normalizeForMatch('हाँ!') === 'हाँ'. outcomeFor('caller_hangup') === 'caller_ended'. canonicalJson orders keys by code unit.
- pricing and inference-evidence live in contracts, and the plugin-observability and plugin-ledger files re-export them.
- Every v1 manifest in the repo still parses, and the v2 rules (kind, provider, meters, companions only on engines) are enforced and tested.
- Facade: read-undeclared and provide-undeclared are recorded in warn mode and thrown in enforce mode. egress-denied and engine-tool-access always throw. Violations reach the sink.
- Session compositions are separate Cordis roots that read declared parent keys through the facade. Two concurrent sessions providing ovo.stt compose. validateGraph resolves without calling apply.
- registry.resolvePin accepts an exact or same-major version and rejects a different major. definePluginV2 with io 'input' produces a schema that the strict runtime Ajv compiles, and an empty config gets its defaults.
- packages/runtime/tests/composition.test.ts and the upstream tests pass unmodified. pnpm lint, typecheck and test are green with at least 380 passing.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm install --offline`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm lint`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm typecheck`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/contracts packages/runtime packages/sdk packages/plugin-session packages/plugin-example --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm test`
