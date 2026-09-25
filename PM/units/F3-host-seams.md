# Work unit F3-host-seams: Host libraries and schema: storage selections, orchestration migration ledger and carrier-identity store methods, session-host (compat, graph selection, companions, format adapters, host ports, termination), distribution with pre-registered skeletons

Wave: 1
Depends on: F1-contracts-runtime, F2-kits-gates
Defects fixed: [21, 1, 27]

## Owned paths

- packages/plugin-storage/**
- packages/plugin-orchestration/**
- packages/plugin-operations/migrations/005_inbound_carrier.sql
- packages/plugin-operations/src/inbound-routes.ts
- packages/plugin-operations/src/inbound-decision.ts
- packages/plugin-operations/src/background-tasks.ts
- packages/plugin-operations/src/migrations.ts
- packages/plugin-operations/package.json
- packages/plugin-ledger/src/background-tasks.ts
- packages/plugin-ledger/package.json
- packages/plugin-media/package.json
- packages/runtime/src/installed.ts, packages/runtime/src/graph.ts, packages/runtime/src/define.ts and their tests (checker-discovered Wave 2 filter cardinality fix)
- packages/session-host/**
- packages/distribution/**
- packages/plugin-session/**
- packages/plugin-turns/** (skeleton only)
- packages/plugin-vad/** (skeleton only)
- packages/plugin-engine-livekit/** (skeleton only)
- packages/plugin-carrier-twilio/** (skeleton only)
- packages/plugin-carrier-exotel/** (skeleton only)
- packages/plugin-carrier-plivo/** (skeleton only)
- packages/plugin-stt-deepgram/** (skeleton only)
- packages/plugin-tts-openai/** (skeleton only)
- packages/plugin-llm-openai/** (skeleton only)
- packages/plugin-stt-assemblyai/** (skeleton only)
- packages/plugin-speech-sarvam/** (skeleton only)
- packages/fixture-calls/** (skeleton only)
- pnpm-lock.yaml

## Shared touchpoints (minimal edits allowed)

- scripts/baselines/*.json: lower or remove entries for files you rewrite; never add (put transitional entries in scripts/baselines/pending/F3.json)
- packages/plugin-orchestration/tests and packages/plugin-operations/tests: new fields only
- packages/plugin-voice/src/index.ts, packages/plugin-secrets/src/index.ts, packages/plugin-observability/src/index.ts and packages/plugin-recordings/src/index.ts: export the owning module's `plugins` array for distribution to consume without a frozen catalog edit

## Specification

GOAL: build every host-side library and schema seam that F4 and all wave-2 units need, because wave 2 freezes session-host, distribution and the shared files. Read docs/architecture/plugin-platform.md (revision 2): sections 2.2, 2.4, 2.8, 3.5, 4.1–4.7, 4.10 and 15.3. Nothing in apps/* changes in this unit; F4 wires the apps. Existing behavior (Twilio + Deepgram + OpenAI) must keep working.

> **Checker note (2026-09-23).** The original §15.3 assigned app manifest dependencies to F3 while this unit forbids edits under `apps/`. The F4 spec already owns all three app manifests and lists these dependencies. F4 will add them before Wave 2; §15.3 now names F4 for that work.

> **Checker note (2026-09-23).** E2 requires two text filters from `plugin-voice` with provider `ovo`, but the pre-F3 runtime treated `(text-filter, provider)` as unique and also used provider as the `ctx.all()` qualifier. Both the loader and graph rejected E2's specified pair. F3 corrects these frozen runtime seams: filter instances are distinct by plugin id, while single-provider kinds retain their uniqueness check.

> **Checker note (2026-09-23).** The specified removal of the legacy inference fallback leaves existing live `context` and `agent` sessions without an `ovo.inference` provider until F4 wires the selected bridge. The checker permitted a documented broken window: session-host now fails explicitly, checks binding workspace, and the board names F4 as the owner before live admission is enabled.

> **Checker note (2026-09-23).** The first F3 commit already applied control migration 004 in some databases. Its SQL checksum must stay unchanged, even though its call-kind constraint lookup can leave a second narrow check behind. A new migration 005 removes every exact legacy narrow check. The migration runner refuses a compound custom check before historical 004 can drop it, so an unrelated guard is never silently lost.

> **Checker note (2026-09-23).** Request-id-only carriers can open a stream before reporting their dial call id. For carriers without exact id matching, the first stream id occupies the provisional stream alias; a later request-correlated dial or status id fills the primary slot and records the mismatch audit. This preserves both arrival orders required by §4.10.

A. Storage (packages/plugin-storage).

- Migration 004-release-selections (src/postgres/migrations/004-release-selections.ts, registered in postgres/migrations.ts) plus its sqlite equivalent:
  - ovo_ctl_releases.selections JSONB NOT NULL DEFAULT '{}' with an object CHECK (sqlite: selections_json TEXT);
  - ovo_ctl_provider_bindings.kind and plugin_id, both TEXT NULL;
  - widen the ovo_ctl_calls.kind CHECK to ('live','simulation','test'), looking up the constraint name in pg_constraint so the migration stays idempotent;
  - idempotent backfill: deepgram → stt; twilio → carrier; openai → tts or llm only when every referencing agent uses it in the same role, otherwise NULL.
- models.ts:
  - ReleaseRecord.selections and ProviderBinding.kind and pluginId, all nullable;
  - McpDiscoveredTool.removedAt?: string | null. This is the type only; M1 persists it.
  - Repositories read and write the new fields, and createRelease persists selections.
- src/legacy-selections.ts: deriveLegacySelections(release, registry, defaults), a pure function that fills UNPINNED selections for releases made before this change (section 4.2).
- inspection-repository (Postgres and sqlite):
  - listCalls is newest first by default (ORDER BY created_at DESC, id DESC, with a keyset cursor on (created_at, id) <);
  - an order 'asc' parameter keeps the old behavior;
  - add filters agentId, kind, status, engine and carrier. engine and carrier are matched against the joined release's selections JSON: jsonb operators in Postgres, json_extract in sqlite.
  - Split both inspection repositories below 300 canonical lines first; they are at 330 and 339.

B. Orchestration (packages/plugin-orchestration).

1. Migration ledger: ovo_orch_schema_migrations, under the existing advisory lock, versioned like plugin-operations/src/migrations.ts. Record 001 and 002 as applied when their tables exist. Before this change, runMigrations re-ran 001 and 002 on every boot.
2. migrations/003_carrier_identity.sql:
   - ovo_session_routes and ovo_jobs get carrier_id TEXT NOT NULL DEFAULT 'twilio', binding_id TEXT NULL and carrier_request_id TEXT NULL;
   - ovo_session_routes gets carrier_stream_call_id TEXT NULL;
   - indexes (carrier_id, carrier_call_id) and (carrier_request_id).
3. Split postgres/sessions.ts (304 canonical lines) below 300, then add or extend these store methods, each with a postgres.ts delegation and types.ts entries:
   - markDialAccepted({..., carrierCallId?, carrierRequestId?}), which requires at least one of the two.
   - resolveSessionRoute({sessionId?, carrierCallId?, dialRequestId?, carrierRequestId?}). A carrierCallId matches carrier_call_id OR carrier_stream_call_id. Keep the existing call shape working.
   - bindCarrierCallId({sessionId | dialRequestId, carrierCallId}): CAS where NULL. When a different id is already set, store it as the carrier_stream_call_id alias if that alias is NULL. Returns bound, alias or conflict.
   - issueStreamGrant({dialRequestId? | carrierRequestId? | carrierCallId?, tokenHash, expiresAt}): only for routes in status dialing or accepted, with terminal_at NULL and handshake_claimed_at NULL. It replaces the token hash and expiry, binds the call id, and returns the route.
   - reissueStream({carrierCallId, tokenHash, expiresAt, workerFreshSeconds}): only when status is connected, terminal_reason and terminal_at are NULL, and the owning worker's ovo_worker_slots heartbeat is fresh. It sets generation+1, the new token and handshake_claimed_at NULL.
   - admissionSnapshot(): {readyIdleSlots, eligibleQueuedJobs, busySlots}. These are read-only queries; O2's campaign driver uses them.
   - requestSessionTermination must be callable before any hangup and must fence the two grant methods above.
4. Add stub subpaths src/background-tasks.ts and src/capacity-signals.ts, each exporting plugins = [] and declared in package.json exports. O1 fills them.
5. Tests: pure units run here; SQL tests follow the existing Postgres-gated skip pattern.

C. Operations.

- migrations/005_inbound_carrier.sql: ovo_ops_inbound_routes gets carrier_plugin_id and carrier_binding_id, both nullable (NULL means the env binding). Register it in src/migrations.ts.
- inbound-routes.ts reads and writes the new columns.
- New src/inbound-decision.ts: inboundDecisionFor(gatewayDecision, context), which maps InboundGatewayDecision to the contracts InboundDecision. The context is a discriminated union keyed by decision.kind. C2 supplies a StreamGrant for reserved, retryUrl for wait, and digitsUrl plus timeoutSeconds for callback; the mapper stays pure and synchronous. C2 uses it read-only.

  > **Checker note (2026-09-23).** The original one-argument signature cannot construct the required InboundDecision variants: a reserved gateway decision has no media grant, wait has no retry URL, and callback has no digits URL. The builder stopped and the user approved an explicit kind-matched context argument. The mapper throws if a JavaScript caller omits required context; it never converts an incomplete decision to busy or hangup. Grant minting and URL construction remain in C2's state machine and host ports.

- New stub src/background-tasks.ts exporting plugins = [], plus its package.json export. O2 fills it.

D. Ledger: stub src/background-tasks.ts exporting plugins = [], plus its package.json export.

E. packages/session-host (new): name @winsendotai/ovo-session-host. Dependencies: contracts, runtime, sdk, audio, plugin-kit, behaviors, plugin-tools, plugin-tools-http, plugin-tools-mcp, plugin-voice (scheduler and output exports only) and plugin-inference (simulated only). Every module is ≤300 lines.

- normalize.ts: normalizeAgentConfig(config, registry, bindings, defaults).
  - Legacy providers.{stt,tts,inference,telephony} map to voice.{stt,tts,llm,carrier} via registry.resolve(kind, binding.provider).
  - Fill the defaults. A missing optional default is skipped with a warning.
- compat/*.ts: one rule per file for EVERY section 4.5 code, including mcp-tool-removed.ts (reads McpDiscoveredTool.removedAt) and termination-unsupported.ts (hangup 'close-stream' without binding.config.streamEndTerminatesCall === true).
  - compat/index.ts: validateSelections(input, stage) → CompatIssue[], each tagged with a stage per section 4.5.
  - playback_evidence_insufficient is an ERROR for any tool with effect 'write' and confirmation true when the carrier evidence is not 'carrier-played' or the engine has confirmedPlayback false, unless voice.acknowledgements includes 'weak-playback-evidence'.
  - format_unreachable uses the audio codec graph against the STT, TTS and engine formats.
  - meter_uncovered is an error at stage 'live' and a warning at stage 'test'.
- select-session-graph.ts: selectSessionGraph({release, registry, hostServices, parent, media, fixtures?, installedExtensions}) → {rows, catalog, resolved}.
  - Resolve each selection through registry.resolvePin; legacy releases resolve unpinned.
  - Throw a typed 'release.plugin_unavailable' error on a missing id or a different major.
  - Add engine companions unless hostServices provides that key.
  - Include a host service definition only when a selected plugin requires or optionally reads one of its keys.
  - Provider row config = {binding: snapshot.config, credentialRef: {credentialId}, ...selection.config}.
  - Engine row config = {session: SessionInput with mode = config.mode and maxCallSeconds = config.costPolicy?.maxCallSeconds ?? 1800, engine: selection.config}.
  - Turn-detector row config = selection.config.
  - Wrap stt and tts with the speech adapters.
  - Behavior and tool rows come from session-catalog.ts.
- engine-selection.ts: selectEngine(release, registry, installedExtensions, fallback). A release-pinned v1 replacement engine keeps the exact pin, its v1 row config {language, inputEnabled, initialInput, initialVariables} and today's error messages ('does not satisfy release pin', 'live release plugin is not installed', 'multiple installed voice session engine providers'). v2 engines follow section 4.2.
- speech-adapters/stt-format.ts, tts-format.ts and decorate.ts: the host format adapters exactly per section 2.4, using the audio codec graph, stateful transcoders and the frame aggregator. Also decorateByKind(definition, decorators).
- session-catalog.ts: move createSessionPluginCatalog out of packages/plugin-session/src/index.ts, and DELETE the OpenAI inference fallback there (lines 68-80). Live LLM comes only from the llm selection; simulations keep the inferencePlugin override.
- meters.ts: metersFor(selections, registry, {requiresInput}), with meters[].when evaluated against the binding config.
- carrier-registry.ts: CarrierRegistry(controls, bindings) with forRelease(release) → {carrierId, bindingId, control, capabilities} and forInboundRoute(route). A NULL binding is the reserved id 'env'.
- carrier-bindings.ts: resolveBinding(id) via the control store and the secret manager. The id 'env' reads OVO_CARRIER_ENV_BINDINGS JSON.
- host-ports.ts plus stream-grants.ts: createCarrierHostPorts({publicBaseUrl, routeSecret, operations, orchestration, bindings, clock}).
  - mediaUrl: wss, the host plus an explicit non-default port only, the path /carriers/<id>/<binding>/media, and a query only via opts.query for queryOnMediaUrl carriers. Throws if the base is not https.
  - callbackUrl: https. It adds t = HMAC(routeSecret, id:binding:purpose) for binding-level URLs, and r plus t = HMAC(id:binding:purpose:r) when opts.requestId is given.
  - verifyUrlSecret: constant-time.
  - streamForDial: mints a random 32-byte token, calls issueStreamGrant with its sha256 hash and a 60 s expiry, and returns {kind: 'stream', mediaUrl, routeParams {sid, rt}, resumeUrl, statusUrl}, or 'ended' or 'unmatched'.
  - resumeStream: uses reissueStream the same way.
  - admitInbound and applyCallEvent delegate to injected operations and orchestration ports.
- terminate.ts: terminateCarrierLeg({route, store, control, capabilities, media, engine, reason}), running the exact section 4.10 order: mark terminating → control.hangup({carrierCallId, carrierRequestId}) → media.terminate(sessionId) if 'unsupported' → engine.dispose(reason).
- installed.ts: a re-export from runtime.

F. packages/distribution (new): name @winsendotai/ovo-distribution.

- catalog.ts: FIRST_PARTY CatalogEntry[] per section 4.7, PRE-REGISTERING every package and subpath this plan creates (section 15.3):
  - carriers with roles ['api','worker','gateway','dispatcher'];
  - engines, providers, turn detectors and VAD with ['session'];
  - plugin-voice and behaviors with ['session','api'];
  - the operations, ledger and orchestration background-tasks subpaths and the orchestration capacity-signals subpath with ['dispatcher'].
- defaults.ts: engine '@winsendotai/ovo-plugin-voice-session-engine', turnDetector '@winsendotai/ovo-turn-detector-default' (optional), textFilters ['@winsendotai/ovo-text-filter-markdown'] (optional).
- load.ts: loadDistribution({role, profile, env}) → {catalog, processRows, defaults, fixtures, fixtureTemplates, unavailable}.
  - catalog = entries whose roles include 'session' or the role, plus the legacy bridges and OVO_PLUGIN_MODULES, through the runtime loader.
  - processRows = one row per process-scope plugin of the role, plus the profile rows.
  - SUPERSEDE RULE: when a catalog package exports a plugin with the same id as a legacy bridge, the package wins and the bridge is dropped with a log line. Test this.
- profiles/api.ts, worker.ts, gateway.ts and dispatcher.ts: each exports rows(profile, env) for the infra rows. Move today's worker infra rows (durableAdapterPlugins etc.) and the API bootstrap rows here where practical, without changing behavior. gateway.ts and dispatcher.ts can be minimal; C2 and O1 own them in wave 2.
- env-bindings.ts: legacyEnvBindings(env) builds OVO_CARRIER_ENV_BINDINGS from TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN when the new variable is unset. It SKIPS placeholder values (Compose uses 'not-configured' and 'disabled-local-account') and never validates at startup.
- legacy/deepgram-stt.ts, legacy/openai-tts.ts and legacy/openai-llm.ts: static v2 definitions that KEEP the ids '@winsendotai/ovo-provider-deepgram-stt', '-openai-tts' and '-openai-inference'.
  - Each reads its binding from row config and its credential via ctx.secret, calls the existing plugin-providers factories, and adapts v1 to v2 through the plugin-kit speech shims.
  - They declare native formats only: the Deepgram bridge μ-law 8k; the OpenAI TTS bridge whatever the legacy factory really emits.
  - Usage goes to ctx.get('ovo.usage-sink').
  - The OpenAI TTS cacheIdentity revision stays 'openai-tts-mulaw-8000-v1' for MULAW_8K.
- legacy/twilio-carrier.ts: a v2 plugin with id '@winsendotai/ovo-carrier-twilio', kind 'carrier' and provider 'twilio', providing ovo.carrier.control only.
  - It wraps TwilioTelephonyControl and createTwilioHandoffProvider, and adapts DialRequest v2 to the legacy dial.
  - Capabilities per the section 8 table: at-dial, streamCallIdMatchesDial true, cancelBeforeAnswer false, rest hangup, markup-after-stream.

G. Skeleton packages (section 15.3), in these directories: packages/plugin-turns, plugin-vad, plugin-engine-livekit, plugin-carrier-twilio, plugin-carrier-exotel, plugin-carrier-plivo, plugin-stt-deepgram, plugin-tts-openai, plugin-llm-openai, plugin-stt-assemblyai, plugin-speech-sarvam and fixture-calls.

- Each package.json has:
  - name @winsendotai/ovo-<dir>, private true, type module, version 0.1.0;
  - exports '.' → ./src/index.ts and './testing' → ./src/testing.ts;
  - the field ovo.skeleton set to true;
  - dependencies on contracts, runtime, sdk, plugin-kit and audio (workspace:_), and devDependency conformance (workspace:_);
  - the pinned third-party dependencies: @livekit/agents 1.9.0 and @livekit/rtc-node 0.13.34 for plugin-engine-livekit; @ai-sdk/openai 4.0.71 and ai 7.0.107 for plugin-llm-openai.
  - fixture-calls instead depends on contracts, runtime, session-host, plugin-kit, audio and conformance.
- src/index.ts exports plugins = [], fixtures = {} and fixtureTemplates = {}; src/testing.ts exports the same.
- Also:
  - add ws 8.21.3 to packages/plugin-media/package.json;
  - add every package to packages/distribution/package.json;
  - run pnpm install --offline once. If a pinned third-party version doesn't resolve offline, record it and leave that dependency out.

H. packages/plugin-session becomes a re-export façade of session-host. Record the transitional legacy-kind edge in scripts/baselines/pending/F3.json only if a gate flags it.

TESTS TO ADD:

- session-host:
  - normalize, including an ambiguous openai binding;
  - every compat rule, including evidence blocking and its acknowledgement, termination_unsupported and meter_uncovered stage behavior;
  - selectSessionGraph: exact, same-major and different-major pins, legacy unpinned resolution, companions added or substituted, host services pruned;
  - engine-selection keeps the v1 messages;
  - speech adapters: MULAW_8K requested from a PCM16_24K-only TTS; AssemblyAI-like frameMs re-framing;
  - metersFor with when;
  - carrier registry with the env binding and skipped placeholders;
  - host ports: a non-https base is rejected; mediaUrl is wss with no query; per-call url-secret; streamForDial and resumeStream against a fake store;
  - terminateCarrierLeg call order.
- distribution: the catalog loads; the bridges validate; the supersede rule; skeletons load with empty plugins.
- storage sqlite: selections round-trip, legacy derivation, newest-first listing with cursors, and filters.
- orchestration: the ledger (PG-gated) and the new store methods (PG-gated SQL, unit-tested mapping).

CONSTRAINTS:

- Preserve every PM/HANDOFF.md safety constraint (section 0.2).
- Do not edit scripts/postgres-restore-fence.sql.
- Modules ≤300 lines; measure with node scripts/check-module-size.mjs.
- No live calls. No git commits.
- Keep pnpm lint, typecheck and test green (full repo).

## Acceptance

- Storage migration 004 (Postgres + sqlite) adds selections, the binding kind and plugin_id columns and the 'test' call kind. sqlite tests prove the selections round-trip, legacy derivation, newest-first cursors and the call filters.
- The orchestration migration ledger exists, so 001 and 002 no longer re-run. Migration 003 adds carrier_id, binding_id, carrier_request_id and carrier_stream_call_id. markDialAccepted accepts request-id-only results. bindCarrierCallId, issueStreamGrant, reissueStream and admissionSnapshot exist, and requestSessionTermination fences the grants.
- session-host implements every section 4.5 compat code (including mcp_tool_removed and termination_unsupported), selectSessionGraph with major-compatible pins, companions and host-service pruning, selectEngine with the v1 compatibility messages, and the format adapters (MULAW_8K from a PCM16_24K-only TTS is tested).
- The F1 `parentReadableKeys` carry-forward is closed: session-scoped capabilities are removed from the parent set and required host services are supplied as session rows. The graph test rejects a missing `ovo.usage-sink` even when parent keys are present.
- Host ports produce wss media URLs with no query (unless queryOnMediaUrl) and per-call url-secrets. streamForDial and resumeStream follow section 4.10, and terminateCarrierLeg runs the documented order.
- distribution pre-registers every planned package and subpath. The 12 skeleton packages exist with the ovo.skeleton flag and are installed. The legacy bridges pass registry validation, the supersede rule is tested, and env bindings skip placeholders.
- plugin-operations has migration 005, inboundDecisionFor and a background-tasks stub. The ledger and orchestration background-tasks and capacity-signals stubs exist with package exports.
- plugin-session is a façade over session-host, and its existing tests pass. pnpm lint, typecheck and test are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm install --offline`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm lint`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm typecheck`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/session-host packages/distribution packages/plugin-storage packages/plugin-orchestration packages/plugin-operations packages/plugin-session --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm test`
