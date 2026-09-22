# OVO plugin platform: architecture and delivery plan

- **Status:** approved design, revision 2, for branch `vorflux/ovo-foundation` (HEAD `267e01c`), dated 2026-09-22.
- **Revision 2** resolves two plan reviews. The main changes:
  - Wave 1 has four sequential units. F4 is new.
  - The seams that parallel units need are frozen before wave 2 starts: contracts, the host libraries, package skeletons, catalog entries, orchestration store methods and dependencies.
  - Wave 2 units own disjoint paths, use pending baselines per unit, and verify only their own scope.
  - The contracts now cover outbound stream lookup (`streamForDial`), cancelling a call before answer, termination on close-stream carriers, the resume race, engine companions and the `ovo.speech` port, host format adapters, and fixture templates.
  - Plugin pins must match the same major version. Releases made before this change are exempt.
  - Confirmation matching is whole-utterance, and a "no" always wins.
  - The mute rules were redefined so a spoken "yes" is not lost.
  - A new unit, M2, removes the evaluation plugin's imports of other plugins.
- **Sources:** the incremental design is the base, with ideas taken from the typed-capabilities and engine-centric designs. The research covered Pipecat, the Twilio, Exotel and Plivo carriers, the Deepgram, AssemblyAI, Sarvam and OpenAI providers, LiveKit Agents JS, Fargate autoscaling, the console, and a seam audit of this repo. Critique findings were checked against the code before they were adopted.
- **Audience:** engineers (human or agent) implementing the work units in §15. Each unit spec stands alone and points here for shared contracts, tables and reasoning.

---

## 0. Principles

### 0.1 Founder intent (authoritative)

1. **Everything is a plugin**, in the style of DeepSeek Harness: a small host plus typed capability contracts.
   - Engine, carrier control, media transport, STT, TTS, LLM, VAD, turn detection, behaviors, tools, storage, queue, secrets, recordings, telemetry and cost are all capabilities.
   - An agent release is **data**: it selects plugins, bindings and config, and the host combines them into one call graph.
2. **Per-agent choice** of engine, carrier, STT, TTS and LLM.
3. **Engines are plugins.** There are two:
   - The **OVO native engine**, rebuilt in our own TypeScript using Pipecat's best ideas. No Pipecat runtime, no Python, no sidecar.
   - The **LiveKit Agents JS** engine.

   Both keep the four behavior modes, tool policy, durable jobs and campaigns, release pinning, the cost ledger and meter coverage, recordings, telemetry and the console.

4. **Providers.**
   - Carriers: Twilio (exists), Exotel and Plivo. Both new carriers are required, and neither is primary yet.
   - STT: Deepgram (exists), AssemblyAI Universal Streaming, Sarvam.
   - TTS: OpenAI (exists), Sarvam.
   - LLM: OpenAI through the AI SDK (exists).
5. **One image set, two deployments.**
   - Compose on EC2 runs a fixed set of workers, with no scaling.
   - Enterprise runs Fargate + RDS + SQS + S3 + Secrets Manager.

   The infrastructure adapters are plugins. **ECS/Application Auto Scaling scales the workers**, and the dispatcher only publishes a metric.

6. **Adding a provider, carrier or engine** means one new package against a contract, installed and then selected in the console. **No edits** to worker, gateway, operations, orchestration or API shared code.
7. **Console:**
   - responsive layout, design tokens, and layout primitives we own;
   - real routes such as `/agents/:id` and `/calls/:id`;
   - a shared data layer with pagination;
   - accessibility, with less on-screen noise;
   - manifest-driven pickers that show compatibility errors;
   - a clean demo path.
8. **No large files.** The target is ≤300 lines per source module. The hard limit is 400, or 500 for tests. Add a duplication gate, and an architecture rule that plugins depend on contracts, never on other plugins.
9. **No real calls, no paid traffic, no AWS provisioning.** Protocol fixtures follow the official docs, and live flags stay off.
10. **Demo:** the same agent switches engine (native ↔ LiveKit) and carrier (Twilio ↔ Exotel/Plivo). Each call can then be inspected with its transcript, recording, latency and cost.

### 0.2 Invariants that must survive (from `PM/HANDOFF.md`, extended)

- **Before live admission**, validate the immutable release bindings and the required carrier, STT, TTS and LLM **meter coverage**.
- **Reservations are admission guards**, not strict caps.
- **Renew both** task protection and durable job ownership.
- **Ownership loss drains the call and terminates the carrier leg.** This must hold on every carrier:
  - REST-hangup carriers hang up;
  - close-stream carriers close the stream, and their binding must attest that closing the stream ends the call (§4.10).
- **Honour `release.config.recording`.** When recording is disabled, capture nothing and create no recording rows.
- **Preserve restore fences** for jobs, outboxes, campaigns, paid-evaluation ambiguity, authorizations, inbound admissions and users.
  - Never bulk-clear them.
  - Keep the `to_regclass` guards in `scripts/postgres-restore-fence.sql`. No unit edits that file in this plan.
- **Ordinary startup never resets an admin password.**
- **Keep write confirmation and unknown-outcome protection.**
  - Never revive the `variables.confirmed` bypass.
  - **A carrier playback mark is not proof that a human heard the audio.** It is the best evidence available. Weaker evidence (`carrier-processed`) is never treated as equal to it without the explicit per-release acknowledgement `weak-playback-evidence`.
- **Fixture test calls never dial, never call carrier REST control, and never need live flags.**
- **The route is marked `terminating` before any carrier media stream is closed on purpose.** That way a carrier continuation can never revive a call the host has ended (§4.10).
- **Work stays on one branch**, `vorflux/ovo-foundation`. `PM/acceptance.json` keeps all 75 criteria. The Test Report stays **PARTIAL**.
- **Module limits:** 400 canonical nonblank lines and 24 KiB per module; tests 500. The target is ≤300.

### 0.3 Rules of this plan

- **Contracts first.**
  - `packages/contracts` holds every capability type. It imports nothing but `zod`, and it may contain pure functions.
  - Plugin packages may import only these:
    - `contracts`, `runtime` and `sdk`;
    - the kit libraries (`plugin-kit`, `audio`);
    - the `node:*` built-ins allowed for their kind;
    - third-party packages.
- **One registration list.** A new first-party plugin package changes exactly three things:
  - one entry in `packages/distribution/src/catalog.ts`;
  - one dependency line in `packages/distribution/package.json`;
  - `pnpm-lock.yaml`.

  Third-party plugins arrive through `OVO_PLUGIN_MODULES` and edit nothing. **For delivery only**, unit F3 pre-registers every package this plan creates, as a _skeleton_, so that wave 2 never edits those three shared files (§15.3).

- **Existing capability key names stay.** These are `ovo.stt`, `ovo.tts-streaming`, `ovo.inference`, `ovo.behavior`, `ovo.execution`, `ovo.speech`, `ovo.media.duplex`, `ovo.voice-session-engine`, `ovo.speech-scheduler`, `ovo.speech-output`, `ovo.operation-store` and `ovo.secret-resolver`, plus the other keys F1 enumerates.
- **Green bars.**
  - Wave-1 units end fully green: `pnpm lint && pnpm typecheck && pnpm test`. The baseline today is 380 passing and 87 skipped because they need Postgres. The pass count may only grow, except for tests this document explicitly deletes.
  - Wave-2 units end **scoped-green** (§15.4).
  - I1 starts by making the whole repository green.
- **Ratchet baselines.**
  - `scripts/baselines/*.json` record today's violations. An entry may shrink or disappear, never grow.
  - A stale entry (the file is gone or the violation is gone) is a warning, not a failure.
  - New transitional violations go only into the unit's own `scripts/baselines/pending/<UNIT>.json`, each entry with a reason and `removeBy: "I1"` (§13.9).
- **Stable plugin ids.**
  - Existing ids are kept: `@winsendotai/ovo-provider-deepgram-stt`, `-openai-tts`, `-openai-inference` and `@winsendotai/ovo-plugin-voice-session-engine`.
  - New ids follow `@winsendotai/ovo-<kind>-<provider>`.
- **Measure module size with `node scripts/check-module-size.mjs`**, never `wc -l`. The gate counts nonblank lines after prettier formatting, so `wc` undercounts by as much as 20%.

### 0.4 What this environment cannot verify

- **Docker is not running.** The 87+ Postgres-gated suites, the restore drill and the Compose smoke test are written, but they can't be executed here.
- **Terraform is not installed.** Infra is checked by a static contract test, plus `scripts/check-terraform.mjs`. That script uses the binary or a Docker image when one is present, and otherwise skips loudly.
- **New npm dependencies may be unreachable.**
  - The store has `ws@8.21.3`, `@livekit/agents@1.9.0`, `@livekit/rtc-node@0.13.34`, `zod@4.6.5`, `ai@7.0.107` and `@ai-sdk/openai@4.0.71`. It does not have jsdom, Testing Library or Playwright.
  - Only wave 1 installs anything. Units never vendor code to work around a missing package.
- **No AWS, and no carrier or provider traffic.**
- **The working tree is a git repository, but this plan makes no commits unless the user authorizes them.** See open question 8 and §15.4.

All of this is reported as PARTIAL. None of it is to be described as certified.

---

## 1. Shape of the system

```
 ┌─────────────────────────── PROCESS GRAPH  (scope 'process', one per app) ───────────────────────────┐
 │ apps/api         storage · secrets · ovo.net · registry · carrier.control[*] · carrier.ingress[*]    │
 │                  (URLs only) · fixture-call runner (child process)                                   │
 │ apps/worker      orchestration · queue · protection · carrier.control[*] · cost · recordings · net   │
 │ apps/media-gw    carrier.ingress[*] · route-token auth · worker dialer · inbound admission          │
 │ apps/dispatcher  capacity.signal · background-task[*] (hint sweeper, DLQ reconciler, campaign        │
 │                  driver, reservation sweeper) · outbox publisher · carrier.control[*] (pacing)       │
 └───────────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                             │ parent (declared reads only; separate Cordis root)
 ┌───────────────────────────── SESSION GRAPH  (scope 'session', one per call) ─────────────────────────┐
 │  behavior(mode) ──► execution ──► tool connectors (native | http | mcp)     ◄── tools never below    │
 │      ▲ respond/respondStream, beginTurn, onPlayback(receipt), speechKind?, subscribe?  the behavior  │
 │      │ execution speaks progress through ovo.speech (an engine companion)                            │
 │  ENGINE (selected: native | livekit) + its companions (native: scheduler, speech-output)             │
 │      ◄── ovo.stt (selected, host format adapter)   ◄── ovo.tts-streaming (selected, host format      │
 │      ◄── ovo.turn-detector   ◄── ovo.vad (optional)      adapter)  ◄── ovo.inference (behavior only) │
 │      ◄── ovo.text-filter[*]  ◄── ovo.media.duplex (recording-tapped, carrier-neutral)                │
 │      ──► EngineEvent stream ──► telemetry · recording evidence · cost · console live transcript      │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Outbound call, end to end**

1. The campaign driver (a dispatcher task) admits a contact, up to the available headroom.
2. Postgres records the job, and the outbox publishes an SQS hint.
3. A worker claims the job and establishes scale-in protection.
4. `CarrierRegistry.forRelease(release)` resolves the carrier binding and returns a `TelephonyControl` and the carrier capabilities.
5. The worker runs `beginDial` and then `dial()`.
   - The media URL is host-built: `wss://…/carriers/<id>/<binding>/media`.
   - The callback URLs are host-built too: `status`, `answer`, `amd` and `resume`.
   - `media.routeParams` are filled only for carriers with `streamParams: 'at-dial'`, such as Twilio's inline TwiML.
6. The carrier answers.
   - **At-dial carriers** connect straight to the gateway.
   - **On-answer carriers** fetch the stream parameters first. Plivo does this through `answer_url`, and Exotel through its Voicebot dynamic URL. The route handler calls `host.streamForDial(...)`, which correlates by `dialRequestId`, binds the carrier call id and mints a fresh single-use route token.
7. The gateway's `MediaSerializer` authenticates the upgrade and decodes `start`. The gateway then authenticates the route token and cross-checks the durable route, and **dials the owning worker** at `route.workerEndpoint`.
8. The worker checks ownership and accepts the session before STT connects. It builds the session graph from `release.selections`, and the engine starts.
9. The engine emits evidence, transcript, turn and timing events, which telemetry, recording and cost consume.
10. The call ends with a typed `EndReason`, which maps to a call outcome.
    - A deliberate end first marks the route `terminating`, then terminates the carrier leg (REST hangup, or closing the stream), and only then disposes the engine.

---

## 2. Capability contracts (`packages/contracts`)

### 2.1 Layout

`index.ts` becomes re-exports only. Every file is ≤300 lines. The package imports only `zod`. Pure functions are allowed, for example `canonicalJson`, `normalizeForMatch`, `classifyConfirmation`, `outcomeFor`, `bytesPerSecond` and `priceUsage`.

```
packages/contracts/src/
  index.ts                     re-exports only
  agent.ts                     Mode, ProcessingSpeech, ToolDefinition, AgentConfig (+voice; see §4.1)
  ports.ts                     Behavior (+speechKind?, +subscribe?), BehaviorEvent, Execution(+Request), ToolConnector,
                               OperationStore/Record, Inference* (+provider/model), Speech, SpeechReceipt(+evidenceSource),
                               EventSink, SecretResolver, ToolConnection, CallEvent, NativeToolHandler, NativeToolContext
  manifest.ts                  Manifest v1 | v2 (zod, §3.1), ManifestV2, PluginKind, normalizeManifest()
  release.ts                   Release (+selections), ReleaseSelection, BindingSnapshot
  selection.ts                 Slot, VoiceSelection, AgentVoice, Acknowledgement
  blockers.ts                  CompatCode, CompatIssue, CompatStage
  canonical-json.ts            canonicalJson(): code-unit key order (#19)
  text.ts                      normalizeForMatch(), countWords(), CONFIRM_YES/NO/FILLERS, classifyConfirmation() (#10,#11,#18)
  pricing.ts                   Usage, PriceCard, PricedUsage, priceUsage(), summarizeUsage() (moved from plugin-observability)
  inference-evidence.ts        inferenceMeterKey(), normalizeInferenceEvidence() + types (moved verbatim from plugin-ledger/src/inference.ts)
  events.ts, script.ts         (existing, unchanged)
  capabilities/keys.ts         Cap (the only place capability strings are spelled), CAPABILITY_SPECS, HOST_SESSION_SERVICES
  capabilities/map.ts          CapabilityMap (type-only)
  audio.ts                     AudioEncoding, AudioFormat, MULAW_8K, PCM16_8K, PCM16_16K, PCM16_24K, bytesPerSecond(), sameFormat()
  usage.ts                     UsageMeter, UsageSink, meterKey()
  net.ts                       NetPort, WebSocketLike, NetFixtureStep, NetFixtureScript, FixtureTemplate(+Input)
  clock.ts                     Clock
  speech/capabilities.ts       SpeechCapabilities, TurnSignal
  speech/stt.ts                SpeechToText, SttSession, SttEvent, TranscriptSegment
  speech/tts.ts                TextToSpeech, SynthesisInput, IncrementalTts
  speech/legacy.ts             v1 StreamingStt/StreamingSttSession/StreamingTts/TranscriptRevision/VoiceMediaTransport/
                               VoiceProviderUsage (moved verbatim, @deprecated)
  voice/media.ts               MediaDuplex, PlaybackEvidence
  voice/evidence.ts            SpeechKind, SpeechKindV2, SpeechSegment, SpeechEvidencePhase, SpeechEvidence (moved from plugin-voice)
  voice/output.ts              SpeechOutput (+prepare?), SpeechOutputResult (moved from plugin-voice)
  voice/engine.ts              VoiceSessionEngine v2, SessionInput (+mode), SESSION_INPUT_JSON_SCHEMA, EngineEvent,
                               EngineOutcome, StageKey, EngineCapabilities
  voice/end-reason.ts          EndReason, CallOutcome, outcomeFor() (#20)
  voice/turn.ts                VoiceEvent, TurnDecision, UserTurnController, TurnDetectorFactory, TurnConfigSchema,
                               TurnConfig, defaultMuteRules()
  voice/vad.ts                 VadAnalyzer, VadAnalyzerFactory, VadParams
  voice/filters.ts             AudioFilter, TextFilter, TextFilterContext
  carrier/capabilities.ts      CarrierCapabilities
  carrier/control.ts           CarrierControlFactory, TelephonyControl v2, DialRequest/Result, Reconciliation, HandoffTarget,
                               ResolvedBinding, HangupQuery
  carrier/media.ts             MediaSerializer, MediaCodecSession, CarrierMediaEvent, MediaCommand, UpgradeRequest,
                               CarrierProtocolError
  carrier/ingress.ts           CarrierIngress, CarrierHttpRoute, CarrierHttpRequest/Reply, CarrierHostPorts,
                               NormalizedCallEvent, InboundAdmission, InboundDecision, StreamGrant
  ops/background-task.ts       BackgroundTask
  ops/capacity-signal.ts       CapacitySignal, CapacitySignalPublisher, CAPACITY_METRIC_NAMES
  ops/recording-tap.ts         RecordingTap
```

**Compatibility shims.** F1 re-exports the moved types from their old homes, so existing imports keep working. None of these shims changes behavior:

- `plugin-voice/src/provider-types.ts` re-exports the v1 speech types from `speech/legacy.ts`.
- `plugin-voice/src/types.ts` re-exports the moved speech and evidence types.
- `plugin-orchestration/src/types.ts` re-exports the v2 carrier types. The legacy `TelephonyControl` stays.
- `plugin-providers/src/types.ts` re-exports `UsageMeter`.
- `plugin-tools/src/native.ts` re-exports `NativeToolHandler` and `NativeToolContext`.
- `plugin-observability/src/pricing.ts` re-exports the contract pricing functions.
- `plugin-ledger/src/inference.ts` re-exports `inference-evidence.ts`. Evaluations and the ledger can then share the functions without one plugin importing another.

The v1↔v2 speech adapters live in `plugin-kit/speech-shims.ts` (§2.11).

### 2.2 Capability keys, specs, host services and companions

```ts
// capabilities/keys.ts
export const Cap = {
  behavior: 'ovo.behavior',
  execution: 'ovo.execution',
  inference: 'ovo.inference',
  speech: 'ovo.speech',
  stt: 'ovo.stt',
  tts: 'ovo.tts-streaming',
  engine: 'ovo.voice-session-engine',
  scheduler: 'ovo.speech-scheduler',
  output: 'ovo.speech-output',
  media: 'ovo.media.duplex',
  turnDetector: 'ovo.turn-detector',
  vad: 'ovo.vad',
  textFilters: 'ovo.text-filter',
  audioFilter: 'ovo.audio-filter',
  operationStore: 'ovo.operation-store',
  secrets: 'ovo.secret-resolver',
  usage: 'ovo.usage-sink',
  transcripts: 'ovo.transcript-observer',
  clock: 'ovo.clock',
  net: 'ovo.net',
  carrierControl: 'ovo.carrier.control',
  carrierIngress: 'ovo.carrier.ingress',
  backgroundTask: 'ovo.background-task',
  capacitySignal: 'capacity.signal',
  operations: 'ovo.operations',
  costLedger: 'ovo.cost-ledger',
  orchestrationStore: 'orchestration.store',
  legacyTelephony: 'telephony.control', // deprecated; removed in wave 3
  // …every key provided or read anywhere today. F1 finds them by grepping provides:, requires:, ctx.provide(,
  //   ctx.get( and reflect.get( in packages/*/src and apps/*/src.
} as const;
export type CapKey = (typeof Cap)[keyof typeof Cap];
export interface CapabilitySpec {
  major: number;
  cardinality: 'one' | 'many';
  scope: 'process' | 'session' | 'either';
}
export const CAPABILITY_SPECS = {
  /* 'many': carrier.control, carrier.ingress, text-filter, background-task.
   major 2: ovo.stt, ovo.tts-streaming, ovo.voice-session-engine; 1 elsewhere. */
} satisfies Partial<Record<CapKey, CapabilitySpec>>;
export const DEFAULT_SPEC: CapabilitySpec = { major: 1, cardinality: 'one', scope: 'either' }; // unknown keys (tests)
/** Keys the worker host provides to every session graph. Release validation treats them as satisfied (§3.5). */
export const HOST_SESSION_SERVICES = [
  Cap.media,
  Cap.operationStore,
  Cap.secrets,
  Cap.usage,
  Cap.transcripts,
  Cap.clock,
] as const;
```

`capabilities/map.ts` is type-only. It maps each key to its interface. For a key with cardinality `many`, `ctx.all(key)` returns a `ReadonlyMap<string, T>` keyed by provider.

**Engine companions.**

- The behavior's `Execution` speaks progress messages ("Please wait while I check that") through `ovo.speech`.
- Every engine must therefore make its own audio path available as `ovo.speech`. A second audio writer to the carrier is never allowed.
- An engine plugin can't provide `ovo.speech` itself, because that would create a cycle: the engine requires the behavior, the behavior requires execution, and execution requires speech. So the engine names **companions** in its manifest (§3.1).
- Companions are plugin ids from the same package that the host adds to the session graph whenever that engine is selected. They are pinned at the engine's version.
- Companion examples:
  - The native engine's companions are `ovo.speech` + `ovo.speech-scheduler` (the scheduler) and `ovo.speech-output` (the streaming output).
  - The LiveKit engine's companion is a late-bound `ovo.speech` port. The engine attaches its session to that port at start.
- The host may substitute its own provider for a companion key. For example, the worker's speech cache provides `ovo.speech-output`.

### 2.3 Audio, usage, clock, net, fixture templates

```ts
export type AudioEncoding = 'mulaw' | 'alaw' | 'pcm_s16le';
export interface AudioFormat {
  encoding: AudioEncoding;
  sampleRate: 8000 | 16000 | 22050 | 24000 | 48000;
  channels: 1;
}
export const MULAW_8K: AudioFormat = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
export function bytesPerSecond(f: AudioFormat): number; // mulaw/alaw: rate; pcm_s16le: rate*2
export function sameFormat(a: AudioFormat, b: AudioFormat): boolean;

export interface UsageMeter {
  provider: string;
  operation: 'carrier' | 'stt' | 'tts' | 'inference';
  unit:
    | 'audio_seconds'
    | 'session_seconds'
    | 'call_seconds'
    | 'characters'
    | 'input_tokens'
    | 'output_tokens'
    | 'audio_output_tokens'
    | 'cache_read_input_tokens'
    | 'cache_write_input_tokens'
    | 'uncached_input_tokens';
  quantity: string; // decimal string
  state: 'estimated' | 'reconciled';
  requestId: string; // REQUIRED; synthesize `${provider}:${sessionId}:${n}` when the provider gives none
  elapsedMs: number;
}
export type UsageSink = (m: UsageMeter) => void;
export const meterKey = (m: Pick<UsageMeter, 'provider' | 'operation' | 'unit'>, op?: string) =>
  string;
// reproduces: 'deepgram.streaming-stt.audio_seconds', 'openai.streaming-tts.characters', 'twilio.carrier.audio_seconds',
// 'openai.inference.{input,uncached_input,cache_read_input,cache_write_input,output}_tokens'

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}

/** Host-injected network. Provider, carrier and engine plugins MUST use it, never node:net/tls/http/https or `ws`. */
export interface NetPort {
  fetch(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<Response>;
  websocket(
    url: string,
    opts?: { headers?: Record<string, string>; protocols?: string[] },
  ): WebSocketLike;
}
export interface WebSocketLike {
  /* readyState, send, close, on('open'|'message'|'close'|'error') returning unsubscribe */
}
export type NetFixtureStep =
  | {
      expect: 'http';
      method: string;
      url: string | RegExp;
      body?: 'json' | 'form' | 'any';
      where?: Record<string, unknown>;
      reply: { status: number; headers?: Record<string, string>; body?: string };
    }
  | { expect: 'ws-open'; url: string | RegExp; headers?: Record<string, string | RegExp> }
  | {
      expect: 'ws-send';
      match: 'json' | 'binary' | 'any';
      where?: Record<string, unknown>;
      repeat?: 'until-next';
    }
  | { send: string | { base64: string } }
  | { close: { code: number; reason?: string } }
  | { delayMs: number };
export interface NetFixtureScript {
  host: string;
  source: string /* doc URL */;
  retrieved: string /* ISO date */;
  steps: NetFixtureStep[];
}

/** A provider package can turn a caller script into its own documented wire messages (§12). */
export interface FixtureTemplateInput {
  format: AudioFormat;
  language: string;
  sessionId: string;
  turns: readonly { atMs: number; say?: string; dtmf?: string; silenceMs?: number }[];
  agentTexts?: readonly string[]; // TTS templates
  tools?: readonly { id: string; inputSchema: Record<string, unknown>; effect: 'read' | 'write' }[]; // LLM templates
}
export type FixtureTemplate = (i: FixtureTemplateInput) => NetFixtureScript[];
```

**Module shape.** A plugin module exports `plugins`, and optionally `fixtures: Record<pluginId, NetFixtureScript[]>` and `fixtureTemplates: Record<pluginId, FixtureTemplate>`. A template must render:

- for STT, every `say` as that provider's documented interim, final and end-of-turn messages;
- for TTS, audio frames for each requested text;
- for an LLM, a streamed reply that calls the agent's first write tool on the first user turn and then answers in text.

### 2.4 Speech (STT v2, TTS v2, inference)

```ts
export type TurnSignal =
  | 'speech-start'
  | 'speech-end'
  | 'end-of-turn'
  | 'eager-end-of-turn'
  | 'utterance-end'
  | 'turn-resumed';
export interface SpeechCapabilities {
  inputFormats?: readonly AudioFormat[]; // STT: native formats, preference order
  outputFormats?: readonly AudioFormat[]; // TTS: native formats, preference order
  frameMs?: { min: number; max: number; preferred: number }; // AssemblyAI {50,1000,100}
  languages: readonly string[]; // BCP-47 or '*'
  interim: boolean;
  wordTimestamps: boolean;
  turnSignals: readonly TurnSignal[];
  forceEndpoint: boolean;
  ttfsP99Ms?: number;
  incrementalText?: boolean;
  maxChars?: number;
}
/** Interim revisions of one segmentId REPLACE each other; 'final' locks the segment.
 *  The turn aggregator appends finals in order, idempotent on segmentId. Never dedupe by text. */
export interface TranscriptSegment {
  segmentId: string;
  revision: number /* monotonic per session */;
  text: string;
  stability: 'interim' | 'final';
  formatted?: boolean;
  confidence?: number;
  language?: string;
  startMs?: number;
  endMs?: number;
  words?: readonly { text: string; startMs: number; endMs: number; final: boolean }[];
}
export type SttEvent =
  | { type: 'transcript'; segment: TranscriptSegment }
  | { type: 'speech-start' | 'speech-end' | 'utterance-end'; atMs?: number }
  | { type: 'end-of-turn'; eager?: boolean; confidence?: number }
  | { type: 'turn-resumed' };
export interface SpeechToText {
  readonly capabilities: SpeechCapabilities;
  start(i: {
    sessionId: string;
    format: AudioFormat;
    language: string;
    signal: AbortSignal;
    onEvent(e: SttEvent): void;
    onUsage: UsageSink;
  }): Promise<SttSession>;
}
export interface SttSession {
  write(frame: Uint8Array, signal?: AbortSignal): Promise<void>;
  forceEndpoint?(): Promise<void>;
  finish(signal?: AbortSignal): Promise<void>; // graceful; reconciled usage when available
  cancel(reason: string): Promise<void>; // immediate; usage emitted EXACTLY once across finish/cancel/failure
}
export interface SynthesisInput {
  sessionId: string;
  text: string;
  format: AudioFormat;
  language: string;
  voice?: string;
  kind?: SpeechKindV2;
  signal: AbortSignal;
  onUsage: UsageSink;
}
export interface TextToSpeech {
  readonly capabilities: SpeechCapabilities;
  cacheIdentity(
    format: AudioFormat,
    voice?: string,
  ): { provider: string; model: string; voice: string; revision: string };
  synthesize(i: SynthesisInput): AsyncIterable<Uint8Array>; // bytes in exactly `format`
  open?(i: Omit<SynthesisInput, 'text'>): Promise<IncrementalTts>;
}
export interface IncrementalTts {
  push(text: string): void;
  flush(): void;
  audio: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
// Inference: existing contract + optional `readonly provider?: string; readonly model?: string`; token usage via UsageSink.
```

**Plugins never resample. The host adapts formats, once, for every engine.** `session-host/src/speech-adapters/` (F3) wraps the selected STT and TTS by kind:

- **STT adapter.**
  - `start({format})` accepts any carrier format.
  - It picks the first native `inputFormats` entry equal to that format. If there is none, it transcodes through `@winsendotai/ovo-audio` into the first reachable native format.
  - It re-frames writes to `frameMs.preferred`, keeping them within `[min, max]`. Frames are flushed on `forceEndpoint` and `finish`.
- **TTS adapter.**
  - `synthesize({format})` requests the requested format when it is native. Otherwise it requests the first native format and transcodes the stream, with state carried across chunks and odd-byte boundaries handled.
  - `open()` is passed through only when the requested format is native. Otherwise it is wrapped in the same way.
  - `cacheIdentity(format)` delegates to the plugin with the **requested** format, so plugins keep stable revisions. The OpenAI TTS plugin keeps `openai-tts-mulaw-8000-v1` for `MULAW_8K`. The speech cache is in process, so a restart clears it and the key only needs to be stable within one process.

This settles the S1/E3 conflict:

- OpenAI TTS declares `outputFormats: [PCM16_24K]`.
- A LiveKit or native engine asks for `MULAW_8K` or `PCM16_8K`.
- The host adapter resamples with the polyphase resampler (#27a).

Engines still decode carrier audio to PCM16 for the VAD.

### 2.5 Media duplex and playback evidence

```ts
export type PlaybackEvidence = 'carrier-played' | 'carrier-processed' | 'none';
export interface MediaDuplex {
  // v2 of VoiceMediaTransport; the recording tap wraps it
  readonly sessionId: string;
  readonly carrierId: string;
  readonly format: AudioFormat;
  readonly playbackEvidence: PlaybackEvidence;
  readonly clearFlushesMarkers: boolean | 'unknown';
  readonly bufferedBytes: number;
  sendAudio(b: Uint8Array, s?: AbortSignal): Promise<void>;
  mark(name: string, s?: AbortSignal): Promise<void>;
  clear(s?: AbortSignal): Promise<void>;
  onAudio(fn: (b: Uint8Array, tsMs: number) => void): () => void;
  onPlayed(fn: (name: string) => void): () => void; // Twilio mark / Plivo playedStream / Exotel mark
  onCleared(fn: () => void): () => void;
  onDtmf(fn: (digit: string) => void): () => void;
  onAnsweredBy?(fn: (v: 'human' | 'machine' | 'unknown') => void): () => void;
  onClose(fn: (reason: EndReason) => void): () => void;
  close(reason: EndReason): Promise<void>;
}
```

`plugin-kit` provides `duplexFromLegacy(transport, MULAW_8K, 'carrier-played')` so that existing tests keep working.

**Receipt evidence mapping.** Every engine must follow it:

| Carrier evidence           | Receipt evidence |
| -------------------------- | ---------------- |
| `carrier-played`           | `confirmed`      |
| `carrier-processed`        | `estimated`      |
| `none`                     | `estimated`      |
| mark timeout (any carrier) | `estimated`      |

There is one exception. When `session.acknowledgements` contains `weak-playback-evidence`, `carrier-processed` maps to `confirmed` with `evidenceSource: 'carrier-processed'`, and telemetry records it.

**Clear ordering.** On barge-in, an engine cancels its pending marks **before** it sends `clear`. Some carriers (Twilio) echo pending marks on clear, and a flushed mark must never produce a completed or confirmed receipt for audio that was cleared.

### 2.6 Engine contract and the EngineEvent stream

```ts
export interface SessionInput {
  mode: Mode; // lets turn detectors pick default mute rules
  language: string;
  inputEnabled: boolean;
  initialInput?: string;
  variables: Readonly<Record<string, unknown>>; // delivered on EVERY behavior call (#4)
  maxCallSeconds: number; // watchdog (#26); carrier TimeLimit = this + 30
  acknowledgements: readonly Acknowledgement[];
}
export const SESSION_INPUT_JSON_SCHEMA: Record<string, unknown>; // Ajv strict draft-07; engines embed it as configSchema.properties.session
export interface VoiceSessionEngine {
  start(): Promise<void>;
  dispose(
    reason: EndReason,
    opts?: { deadlineMs?: number /* default 2000 */ },
  ): Promise<EngineOutcome>; // idempotent; media first
  readonly ended: Promise<EngineOutcome>;
  subscribe(listener: (e: EngineEvent) => void): () => void;
  readonly ingressStats: {
    acceptedFrames: number;
    acceptedBytes: number;
    pendingFrames: number;
    pendingBytes: number;
    overflows: number;
  };
}
export interface EngineOutcome {
  reason: EndReason;
  outcome: CallOutcome;
}
export type EngineEvent =
  | { type: 'speech'; evidence: SpeechEvidence } // generated→queued→started→sent→acknowledged→completed|interrupted|dropped|failed
  | {
      type: 'user.transcript';
      turnId: string;
      segmentId: string;
      text: string;
      stability: 'interim' | 'final';
    }
  | {
      type: 'user.turn';
      phase: 'started' | 'stopped' | 'idle';
      turnId: string;
      input?: 'speech' | 'dtmf';
      text?: string;
    }
  | {
      type: 'agent.transcript';
      segmentId: string;
      text: string;
      state: 'generated' | 'played' | 'interrupted';
      spokenPrefix?: string;
    }
  | {
      type: 'timing';
      key: StageKey;
      turnId?: string;
      segmentId?: string;
      atMs: number;
      ms?: number;
    }
  | { type: 'interrupt'; reason: 'vad' | 'transcript' | 'dtmf' }
  | { type: 'voicemail'; result: 'human' | 'machine' | 'unknown' }
  | { type: 'end'; reason: EndReason };
export type StageKey =
  | 'vad_stop_wait'
  | 'stt_finalize'
  | 'turn_decision'
  | 'behavior_first_segment'
  | 'llm_ttfb'
  | 'text_aggregation'
  | 'tts_ttfb'
  | 'carrier_first_audio'
  | 'playout_ack'
  | 'bargein_latency'
  | `tool:${string}`;
export interface EngineCapabilities {
  turnDetection: readonly ('provider' | 'vad-timeout' | 'smart-turn' | 'stt')[];
  bargeIn: boolean;
  dtmf: boolean;
  confirmedPlayback: boolean;
  ownsProviders: false;
  formats: readonly AudioFormat[];
  consumesTurnDetector: boolean;
}
```

```ts
// ports.ts additions (optional; engines must work without them)
export type BehaviorEvent =
  | { type: 'tool.started' | 'tool.settled'; toolId: string; operationId: string }
  | { type: 'confirmation.pending'; toolId: string; operationId: string }
  | {
      type: 'confirmation.resolved';
      toolId: string;
      operationId: string;
      result: 'confirmed' | 'declined' | 'expired';
    };
export interface Behavior {
  /* existing: respond, respondStream?, cancel?, onPlayback?, beginTurn?, isComplete? */
  speechKind?(text: string): SpeechKindV2 | undefined; // 'confirmation' for the pending confirmation prompt
  subscribe?(fn: (e: BehaviorEvent) => void): () => void; // tool and confirmation lifecycle for mute rules
}
```

```ts
// voice/end-reason.ts
export type EndReason =
  | 'behavior_completed'
  | 'caller_hangup'
  | 'caller_idle'
  | 'voicemail'
  | 'max_duration'
  | 'transferred'
  | 'ownership_lost'
  | 'drain'
  | 'superseded'
  | `error:${string}`;
export type CallOutcome =
  | 'completed'
  | 'caller_ended'
  | 'no_input'
  | 'voicemail'
  | 'limit'
  | 'transferred'
  | 'canceled'
  | 'failed';
export function outcomeFor(r: EndReason): CallOutcome; // table, not substring matching
// behavior_completed→completed · caller_hangup→caller_ended · caller_idle→no_input · voicemail→voicemail
// max_duration→limit · transferred→transferred · superseded→canceled · drain|ownership_lost|error:*|unknown→failed
```

**Rules for every engine.** The engine conformance kit tests all of them.

- It never resolves `ovo.execution` or `ovo.tool-connector.*`. Kind rules enforce this (§3.8).
- It declares companions so that `ovo.speech` is backed by its own audio path (§2.2). Execution progress speech reaches the carrier only through the engine.
- It calls `behavior.beginTurn(epoch)` before each turn, and `behavior.onPlayback(receipt)` for every segment, with the exact spoken text.
- **Receipt ordering.** Before it dispatches a user turn to `respond*`, it delivers every pending receipt for earlier segments, whether completed or interrupted.
  - A "yes" that arrives while the confirmation prompt is still playing is held until that prompt's receipt has been delivered.
  - The behavior's `heard` check therefore always sees the real receipt.
- It speaks only text that came from the behavior, from `ovo.speech`, or from host-configured idle and disclosure prompts.
- It passes variables on every turn, including DTMF turns and the initial turn.
- `dispose` is bounded and idempotent, and it closes media first. The host has already marked the route `terminating` (§4.10).
- It emits `speech` events with the phases in order.

Telemetry, recording evidence and cost subscribe to `subscribe()`. They no longer depend on a `BoundedSpeechScheduler`.

### 2.7 Turn detection, VAD and filters

```ts
// voice/turn.ts
export type VoiceEvent =
  | { type: 'stt'; event: SttEvent; atMs: number }
  | { type: 'vad.start' | 'vad.stop'; atMs: number }
  | { type: 'dtmf'; digit: string; atMs: number }
  | { type: 'bot.started' | 'bot.stopped'; epoch: number; atMs: number; kind?: SpeechKindV2 }
  | { type: 'tool.started' | 'tool.settled'; atMs: number }
  | { type: 'confirmation.pending' | 'confirmation.resolved'; atMs: number };
export type SpeechKindV2 =
  'acknowledgment' | 'response' | 'progress' | 'confirmation' | 'disclosure' | 'idle-prompt';
export type TurnDecision =
  | { type: 'interrupt'; reason: 'vad' | 'transcript' | 'dtmf' }
  | { type: 'turn.started'; turnId: string }
  | {
      type: 'turn.stopped';
      turnId: string;
      input: { kind: 'speech'; text: string; segments: number } | { kind: 'dtmf'; digits: string };
    }
  | { type: 'turn.reset'; turnId: string; reason: 'backchannel' | 'muted' }
  | { type: 'force-endpoint' }
  | { type: 'idle'; retry: number; final: boolean; prompt?: string };
export interface UserTurnController {
  observe(e: VoiceEvent): void;
  on(fn: (d: TurnDecision) => void): () => void;
  dispose(): void;
}
export interface TurnDetectorFactory {
  create(input: {
    clock: Clock;
    stt?: SpeechCapabilities;
    vad: boolean;
    language: string;
    mode: Mode;
    overrides?: Partial<TurnConfig>;
  }): UserTurnController; // the plugin's own row config is its TurnConfig
}
export const TurnConfigSchema; // zod; defaults below
export type TurnConfig = {
  strategy: 'auto' | 'provider' | 'vad-timeout'; // auto → vad-timeout if a VAD is selected, else provider
  userSpeechTimeoutMs: 600;
  stopTimeoutMs: 5000;
  waitForTranscript: true;
  sttP99Ms?: number;
  minWordsWhileBotSpeaking: 2;
  backchannels: ['uh huh', 'mm hmm', 'yeah', 'yes', 'ok', 'okay', 'right', 'haan', 'achha', 'hmm'];
  mute: (
    | 'first-speech'
    | 'until-first-complete'
    | 'during-tools'
    | 'always-while-speaking'
    | 'during-confirmation'
  )[]; // [] → defaultMuteRules(mode)
  allowDtmfWhileMuted: true;
  idle: { timeoutMs: 10000; maxRetries: 1; prompts: ['Are you still there?'] } | null;
  dtmf: { interDigitMs: 2000; terminator: '#'; maxDigits: 32; interruptOnFirstDigit: true };
};
// voice/vad.ts
export interface VadParams {
  confidence: 0.7;
  startMs: 200;
  stopMs: 200;
  minVolume: 0.6;
  smoothing: 0.2;
}
export interface VadAnalyzer {
  readonly frameSamples: number;
  readonly sampleRate: 8000 | 16000;
  confidence(pcm: Int16Array): number;
  volume(pcm: Int16Array): number;
  reset(): void;
}
export interface VadAnalyzerFactory {
  readonly params: VadParams;
  create(rate: 8000 | 16000): VadAnalyzer;
}
// voice/filters.ts
export interface TextFilter {
  id: string;
  order: number;
  apply(text: string, ctx: { language: string; toolSchema?: JsonSchema }): string;
}
export interface AudioFilter {
  start(rate: number): void;
  filter(pcm: Int16Array): Int16Array;
  stop(): void;
}
```

**Default mute rules per mode** (`defaultMuteRules(mode)`):

| Mode         | Mute rules                            |
| ------------ | ------------------------------------- |
| announcement | `always-while-speaking`               |
| faq          | `during-confirmation`                 |
| context      | `during-confirmation`                 |
| agent        | `during-tools`, `during-confirmation` |

**What each mute rule means.** These definitions are normative. They fix the review finding that a spoken "yes" could be thrown away.

| Rule                                   | Window                                                                                                                        | What happens inside it                                                                                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `during-confirmation`                  | From `bot.started{kind:'confirmation'}` to the matching `bot.stopped`, i.e. only **while the confirmation prompt is playing** | User speech never interrupts. Finals are **buffered**, not discarded. At `bot.stopped`, if the buffered text classifies as `yes` or `no` (`classifyConfirmation`), the controller emits `turn.stopped` with that text. Otherwise it emits `turn.reset{reason:'muted'}`. |
| `during-tools`                         | `tool.started` → `tool.settled`                                                                                               | Speech is discarded (`turn.reset{reason:'muted'}` if text had started). DTMF is allowed when `allowDtmfWhileMuted`.                                                                                                                                                     |
| `always-while-speaking`                | Any bot speech                                                                                                                | No barge-in. Speech that starts while the bot is silent is handled normally.                                                                                                                                                                                            |
| `first-speech`, `until-first-complete` | As named                                                                                                                      | Pipecat semantics                                                                                                                                                                                                                                                       |

- The answer window **after** the prompt is never muted. It runs from `bot.stopped` until `confirmation.resolved`.
- A `disclosure` segment is always muted, with no buffering.

**Answers are not backchannels.** Between `confirmation.pending` and `confirmation.resolved`, a word from `CONFIRM_YES` or `CONFIRM_NO` is never treated as a backchannel and never discarded by the min-words rule. It is aggregated and released at `bot.stopped`, which is subject to the receipt-ordering rule in §2.6.

### 2.8 Carrier contracts

Every carrier plugin provides two capabilities, both with cardinality `many` and keyed by `manifest.provider`: `ovo.carrier.control` and `ovo.carrier.ingress`. The worker, API and dispatcher consume control. The gateway and API consume ingress (the API only to list URLs).

```ts
// carrier/capabilities.ts
export interface CarrierCapabilities {
  carrierId: string;
  media: {
    formats: readonly AudioFormat[];
    outboundChunk?: { minBytes: number; maxBytes: number; multipleOf: number };
    playbackEvidence: PlaybackEvidence;
    clear: boolean;
    clearFlushesMarkers: boolean | 'unknown';
    dtmf: boolean;
    queryOnMediaUrl: boolean;
  }; // Exotel true (dynamic URL may carry ≤3 pairs); Twilio/Plivo false
  control: {
    callIdTiming: 'at-dial' | 'after-answer';
    streamParams: 'at-dial' | 'on-answer';
    streamCallIdMatchesDial: boolean | 'unknown';
    cancelBeforeAnswer: boolean;
    handoff: readonly HandoffTarget['kind'][];
    amd: 'async' | 'sync' | 'none';
    maxDuration: boolean;
    reconcile: 'by-call-id' | 'by-request-id' | 'none';
    hangup: 'rest' | 'close-stream';
  };
  continuation: 'markup-after-stream' | 'none';
  webhookAuth: 'hmac-signature' | 'url-secret';
  pacing: { cps: number };
}
// carrier/control.ts
export interface ResolvedBinding {
  bindingId: string;
  pluginId: string;
  workspaceId: string;
  config: Record<string, unknown>;
  secret: string;
}
export interface CarrierControlFactory {
  readonly capabilities: CarrierCapabilities;
  create(binding: ResolvedBinding): TelephonyControl;
}
export interface DialRequest {
  requestId: string;
  jobId: string;
  to: string;
  from: string;
  media: {
    url: string /* wss:, no query, host-built */;
    routeParams: Record<string, string> /* empty for on-answer carriers */;
    format: AudioFormat;
  };
  callbacks: { status: string; answer: string; amd?: string; resume?: string }; // host-built, binding-scoped, per-call url-secret
  amd?: { mode: 'off' | 'detect' | 'hangup-on-machine'; timeoutMs?: number };
  ringTimeoutSec?: number;
  maxDurationSec: number;
}
export type DialResult =
  | { kind: 'accepted'; requestId: string; carrierCallId?: string; carrierRequestId?: string }
  | { kind: 'rejected'; requestId: string; reason: string; retryable: boolean }
  | { kind: 'unknown'; requestId: string; reason: string };
export type CallState =
  'queued' | 'ringing' | 'in_progress' | 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled';
export type Reconciliation =
  | { kind: 'pending' }
  | { kind: 'live'; carrierCallId?: string; state: 'queued' | 'ringing' | 'in_progress' }
  | {
      kind: 'ended';
      carrierCallId?: string;
      state: Exclude<CallState, 'queued' | 'ringing' | 'in_progress'>;
      answeredBy?: 'human' | 'machine' | 'unknown';
    }
  | { kind: 'rejected'; reason: string };
export type HandoffTarget =
  | { kind: 'phone'; e164: string }
  | { kind: 'queue'; name: string }
  | { kind: 'resume' }
  | { kind: 'end'; message: string };
export interface HangupQuery {
  carrierCallId?: string;
  carrierRequestId?: string;
} // request id cancels before answer
export interface TelephonyControl {
  dial(r: DialRequest): Promise<DialResult>; // MUST reject non-wss or query-bearing media.url (non-retryable) (#1)
  reconcile(q: {
    requestId: string;
    carrierCallId?: string;
    carrierRequestId?: string;
  }): Promise<Reconciliation>;
  hangup(q: HangupQuery): Promise<'ended' | 'already_ended' | 'unsupported'>;
  handoff(
    carrierCallId: string,
    t: HandoffTarget,
    requestId: string,
  ): Promise<
    | { kind: 'confirmed'; receiptId: string }
    | { kind: 'rejected'; retryable: boolean; reason: string }
    | { kind: 'unknown'; reason: string }
  >;
}
// carrier/media.ts
export type CarrierMediaEvent =
  | { type: 'connected' }
  | {
      type: 'start';
      carrierCallId: string;
      streamId: string;
      format: AudioFormat;
      routeParams: Record<string, string>;
    }
  | { type: 'audio'; seq: number; timestampMs: number; payload: Uint8Array }
  | { type: 'dtmf'; digit: string; durationMs?: number }
  | { type: 'played'; name: string }
  | { type: 'cleared' }
  | { type: 'stop'; reason: 'caller-hangup' | 'stream-ended' | 'unknown' };
export type MediaCommand =
  { type: 'audio'; payload: Uint8Array } | { type: 'mark'; name: string } | { type: 'clear' };
export interface UpgradeRequest {
  url: URL; // the full request URL INCLUDING its query (Exotel carries sid/rt/t there)
  externalUrl: string; // public origin (+ explicit non-default port) + exact path, NO query
  headers: Readonly<Record<string, string | undefined>>;
  remoteAddress?: string;
}
export interface MediaSerializer {
  authenticateUpgrade(
    req: UpgradeRequest,
    ctx: {
      bindingId: string;
      resolveBinding(id: string): Promise<ResolvedBinding>;
      verifyUrlSecret(input: {
        purpose: 'media';
        bindingId: string;
        requestId?: string;
        token: string | null;
      }): boolean;
    },
  ): Promise<{ ok: true; params: Record<string, string> } | { ok: false; status: 401 | 403 }>;
  createSession(params: Record<string, string>): MediaCodecSession;
}
export interface MediaCodecSession {
  decode(text: string): CarrierMediaEvent[]; // throws CarrierProtocolError
  encode(cmd: MediaCommand): string[]; // owns chunking (Exotel 320 B multiples, ≥3,200 B, ≤100 KB)
  flush(): string[]; // pad/emit remainder before a mark or close
  terminate?(): string[]; // frames to send before a deliberate close (optional)
}
// carrier/ingress.ts
export interface CarrierHttpRequest {
  method: 'GET' | 'POST';
  externalUrl: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  rawBody: Uint8Array;
  bindingId: string;
  remoteAddress?: string;
}
export interface CarrierHttpReply {
  status: number;
  contentType: string;
  body: string;
}
export interface StreamGrant {
  kind: 'stream';
  mediaUrl: string;
  routeParams: Record<string, string>;
  resumeUrl?: string;
  statusUrl?: string;
}
export interface CarrierHostPorts {
  resolveBinding(bindingId: string): Promise<ResolvedBinding>;
  admitInbound(a: InboundAdmission): Promise<InboundDecision>;
  confirmCallback(a: InboundAdmission & { digits: string }): Promise<InboundDecision>;
  applyCallEvent(
    e: NormalizedCallEvent,
  ): Promise<{ kind: 'applied' | 'duplicate' | 'unmatched' | 'correlation_conflict' }>;
  /** On-answer carriers: correlate an outbound dial, bind the carrier call id (CAS where NULL, alias if it differs),
   *  and mint a fresh single-use route token. Returns 'ended' when the route is terminating/terminal. */
  streamForDial(q: {
    carrierId: string;
    bindingId: string;
    dialRequestId?: string;
    carrierCallId?: string;
    carrierRequestId?: string;
  }): Promise<StreamGrant | { kind: 'ended' } | { kind: 'unmatched' }>;
  /** Continuation: re-issue at generation+1 only while the route is 'connected', not terminating, and owned by a live worker. */
  resumeStream(q: {
    carrierId: string;
    bindingId: string;
    carrierCallId: string;
  }): Promise<StreamGrant | { kind: 'ended' }>;
  mediaUrl(carrierId: string, bindingId: string, opts?: { query?: Record<string, string> }): string; // query only if queryOnMediaUrl
  callbackUrl(
    carrierId: string,
    bindingId: string,
    purpose: CarrierHttpRoute['purpose'],
    opts?: { requestId?: string },
  ): string;
  verifyUrlSecret(
    req: CarrierHttpRequest,
    opts: { purpose: CarrierHttpRoute['purpose'] | 'media'; requestId?: string },
  ): boolean;
}
export interface CarrierHttpRoute {
  method: 'GET' | 'POST';
  purpose: 'inbound' | 'answer' | 'status' | 'amd' | 'stream-status' | 'resume' | 'media-url';
  handle(req: CarrierHttpRequest, host: CarrierHostPorts): Promise<CarrierHttpReply>; // verifies carrier auth itself
}
export interface CarrierIngress {
  readonly carrierId: string;
  readonly capabilities: CarrierCapabilities;
  readonly serializer: MediaSerializer;
  readonly routes: readonly CarrierHttpRoute[];
  readonly operatorUrls: readonly {
    purpose: CarrierHttpRoute['purpose'] | 'media';
    label: string;
    help: string;
  }[]; // shown in console
  readonly legacyPaths?: Readonly<
    Record<string, { purpose: CarrierHttpRoute['purpose'] | 'media'; bindingId: string }>
  >;
}
export interface NormalizedCallEvent {
  carrierId: string;
  bindingId: string;
  eventId: string;
  carrierCallId?: string;
  carrierRequestId?: string;
  dialRequestId?: string;
  state: CallState;
  answeredBy?: 'human' | 'machine' | 'unknown';
  occurredAt: Date;
  payload?: Record<string, unknown>;
}
export interface InboundAdmission {
  carrierId: string;
  bindingId: string;
  carrierCallId: string;
  from: string;
  to: string;
  receivedAt: Date;
  raw?: Record<string, string>;
}
export type InboundDecision =
  // carrier-neutral; F1 derives exact fields from inbound-webhook.ts and inbound-gateway.ts
  | ({ kind: 'connect' } & Omit<StreamGrant, 'kind'>)
  | { kind: 'wait'; message?: string; pauseSeconds: number; retryUrl: string }
  | { kind: 'callback-offer'; prompt: string; digitsUrl: string; timeoutSeconds: number }
  | { kind: 'human'; e164: string; callerId?: string; timeoutSeconds?: number }
  | { kind: 'busy'; message?: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'hangup'; message?: string };
```

**URL scheme.** All carrier URLs are scoped to a binding: `/carriers/:carrierId/:bindingId/:purpose`, and media is `/carriers/:carrierId/:bindingId/media`. The binding id is in the path, never the query, for two reasons:

- Twilio forbids query strings on `<Stream url>`.
- The gateway needs to know which credential checks the upgrade _before_ the `start` frame arrives.

**Route parameters** are carrier-neutral: `sid` (the session id) and `rt` (the route token). The gateway also accepts the v1 names `sessionId` and `routeToken` for one release.

- They reach the gateway in `start.customParameters` (Twilio), `extra_headers` (Plivo, base32) or the dynamic media URL query (Exotel).

**Per-call URL secrets.**

- Binding-level static URLs are the ones an operator pastes into a carrier console, such as `inbound` and Exotel's `media-url`. Their `t = HMAC(OVO_INBOUND_ROUTE_SECRET, carrierId:bindingId:purpose)`.
- Per-call URLs (`status`, `answer`, `amd`, `resume`, and Exotel's issued media URL) carry `r=<dialRequestId|sessionId>` and `t = HMAC(secret, carrierId:bindingId:purpose:r)`. A leaked status URL can then be replayed only against its own call.

### 2.9 Operations contracts

```ts
export interface BackgroundTask {
  id: string;
  intervalMs: number;
  jitterMs?: number;
  tick(signal: AbortSignal): Promise<void>;
}
export interface CapacitySignal {
  requiredSlots: number;
  provisionedTasks: number;
  busySlots: number;
  readyIdleSlots: number;
  eligibleJobs: number;
  campaignDemand: number;
  oldestEligibleJobAgeSeconds: number;
  limitingQuota?: string;
  at: Date;
}
export interface CapacitySignalPublisher {
  publish(s: CapacitySignal): Promise<void>;
  last?(): CapacitySignal | undefined;
}
export const CAPACITY_METRIC_NAMES = {
  namespace: 'OVO/Capacity',
  required: 'RequiredSlots',
  provisioned: 'ProvisionedTasks',
  busy: 'BusySlots',
  readyIdle: 'ReadyIdleSlots',
  eligible: 'EligibleJobs',
  campaign: 'CampaignDemand',
  oldestAge: 'OldestEligibleJobAgeSeconds',
} as const;
export interface RecordingTap {
  wrap(m: MediaDuplex): MediaDuplex;
  attach(events: { subscribe(fn: (e: EngineEvent) => void): () => void }): void;
}
```

`pricing.ts` holds `priceUsage`, `summarizeUsage` and their types, moved verbatim from `plugin-observability/src/pricing.ts`. The ledger can then drop its import of the observability plugin.

### 2.10 Text helpers (pure, in contracts)

- **`canonicalJson(value)`** produces stable JSON with keys sorted by **code unit** (`a < b ? -1 : a > b ? 1 : 0`), never `localeCompare`. Its value semantics are the same as `JSON.stringify`.
  - It replaces the copies at `plugin-tools/src/json.ts:27`, `plugin-operations/src/identity.ts:8`, `plugin-observability/src/telemetry-validation.ts:54` and `plugin-evaluations/src/validation.ts:94`.
  - Code-unit comparison is also used for the tie-break sorts at `plugin-ledger/src/money.ts:95`, `behaviors/src/faq.ts:102` and `plugin-recordings/src/memory-repository.ts:50,103` (#19).
- **`normalizeForMatch(text)`** does the following, in order:
  1. NFKC;
  2. `toLowerCase()`;
  3. replace `[^\p{L}\p{M}\p{N}]+` with a space;
  4. trim.

  Keeping `\p{M}` preserves Devanagari combining marks (#18).

- **`countWords(text, language)`** uses `Intl.Segmenter(language, {granularity:'word'})` and counts only the `isWordLike` segments.
- **Confirmation lexicons.** These are stored **pre-normalized** (as `normalizeForMatch` outputs) and matched on whole token sequences:
  - `CONFIRM_YES` = `yes · yeah · yep · sure · correct · confirm · confirmed · go ahead · proceed · haan · haan ji · ji haan · theek hai · ठीक है · हाँ · हां`
  - `CONFIRM_NO` = `no · nope · not · cancel · stop · wait · hold on · do not · don t · nahin · nahi · mat · mat karo · ruko · नहीं · मत · रुको`
  - `CONFIRM_FILLERS` = `please · ok · okay · ji · sir · madam · hmm · uh · um`
- **`classifyConfirmation(text): 'yes' | 'no' | 'unclear'`** (#10):
  1. Normalize the text.
  2. If any `CONFIRM_NO` phrase occurs anywhere as a token subsequence, the result is **`no`**. NO always wins.
  3. Otherwise, strip `CONFIRM_FILLERS` tokens from both ends. If what remains **equals exactly one** `CONFIRM_YES` phrase, the result is `yes`.
  4. Anything else is `unclear`.

  | Input                                                  | Result    |
  | ------------------------------------------------------ | --------- |
  | "Yes!", "yes please", "okay yes", "haan ji", "ji haan" | `yes`     |
  | "okay" alone                                           | `unclear` |
  | "no that's not correct", "yes… no, cancel"             | `no`      |
  | "yes and also book another"                            | `unclear` |

### 2.11 Speech-shim policy

During the transition, `plugin-kit/speech-shims.ts` provides these adapters:

- **`legacyAsStt(v1)`** maps `TranscriptRevision` as follows:
  - `isFinal` becomes a `final` segment, and a new segmentId starts after each final;
  - `speechFinal` becomes `end-of-turn`;
  - `speechStarted` becomes `speech-start`.
- **`sttAsLegacy(v2, format)`** goes the other way.
- **`legacyAsTts` / `ttsAsLegacy`** do the same for TTS.
- **`duplexFromLegacy` / `legacyFromDuplex`** adapt the media transport.

Each shim has one wave-1 purpose: bridging an existing provider or the current engine. Wave 2 removes each use as the native packages land, and wave 3 deletes any shim that has no caller left.

---

## 3. Manifest v2 and host enforcement (`packages/runtime`, `packages/sdk`)

### 3.1 Manifest v2

```ts
Manifest = v1 | {
  id; version; contractVersion: 2; scope: 'process' | 'session';
  kind: 'engine' | 'carrier' | 'stt' | 'tts' | 'llm' | 'vad' | 'turn-detector' | 'audio-filter' | 'text-filter'
      | 'voicemail' | 'behavior' | 'tool' | 'infra' | 'host' | 'console' | 'fixture';
  provider?: string;                   // matches binding.provider; required for engine|carrier|stt|tts|llm|vad|turn-detector
  provides: string[]; requires: string[]; optional: string[];   // entries may be `${key}@${major}`
  companions?: Record<string /* CapKey */, string /* plugin id, same package */>; // engine kinds only (§2.2)
  configSchema: JsonSchema;            // row config
  bindingSchema?: JsonSchema;          // non-secret binding config → console SchemaForm + Ajv at binding create and release
  secretFields: string[];              // JSON pointers that MUST hold {credentialRef:{credentialId}}
  capabilities?: SpeechCapabilities | EngineCapabilities | CarrierCapabilities | VadParams | LlmCapabilities; // by kind
  meters?: { key: string; unit: UsageMeter['unit']; label: string; role: 'carrier' | 'stt' | 'tts' | 'llm';
             when?: { field: string; in: readonly string[] } }[];   // applies only when binding.config[field] ∈ in
  runtime?: { native?: 'glibc'; egressHosts: string[]; modelLicences: string[] };
  conformance?: ('stt@1' | 'tts@1' | 'llm@1' | 'carrier@1' | 'engine@1' | 'vad@1' | 'turn@1')[];
  ui?: { label: string; description?: string; vendor?: string; docsUrl?: string; slot?: Slot; order?: number;
         fields?: Record<string, { widget?: 'text' | 'textarea' | 'select' | 'number' | 'switch' | 'secret' | 'voice' | 'model';
                                   label?: string; help?: string; group?: string; advanced?: boolean; order?: number }> };
}
```

- v1 manifests still parse. `normalizeManifest()` upcasts them to `kind: 'infra'`, `optional: []`.
- For v2, `kind` is required.
- `engine`, `carrier`, `stt`, `tts` and `llm` must declare `provider`, `capabilities`, `runtime.egressHosts` and `conformance`.
- `meters` are required for `carrier`, `stt`, `tts` and `llm`.
- `provider` is required for `vad` and `turn-detector`.
- `companions` is allowed only on `engine`.

### 3.2 `definePlugin` generics and `definePluginV2`

**Runtime.**

- `definePlugin<const M extends Manifest>(manifest: M, apply: (ctx: PluginContext<ReqOf<M>, ProvOf<M>>, config) => …)` gives typed `get` and `provide`.
- The plain-string overload stays and is declared **last**, because `Parameters<typeof definePlugin>` resolves to the last overload and existing tests rely on that.

**Ajv.** The runtime Ajv instance is `new Ajv({ strict: true, allErrors: true, formats: { uri: true, email: true, uuid: true, 'date-time': true, date: true, time: true, duration: true, ipv4: true, ipv6: true, hostname: true } })`.

- The `true` entries make those formats annotation-only, so strict mode accepts zod output.
- zod enforces the formats at apply time.
- The runtime still may not import `ajv-formats`.

**SDK.** `definePluginV2({ …manifest, config: zodSchema, binding?: zodSchema }, apply)` works like this:

- It derives `configSchema` via `z.toJSONSchema(schema, { target: 'draft-7', io: 'input' })` and strips `$schema`. This was verified with zod 4.6.5 and Ajv 8.
  - With `io: 'input'`, fields that have defaults are optional.
  - With the default `io: 'output'`, every defaulted field is `required`, so an empty row config would fail.
- It applies the same derivation to `binding` to produce `bindingSchema`.
- `apply` receives `schema.parse(config)`, with defaults filled and types set.

### 3.3 The guarded `PluginContext`

`compose` passes each plugin's `apply` a facade (a Proxy), not the raw Cordis context.

```ts
export interface PluginContext<R extends string = string, P extends string = string> {
  get<K extends R>(key: K): K extends CapKey ? CapabilityMap[K] : unknown; // throws if absent
  maybe<K extends R>(key: K): (K extends CapKey ? CapabilityMap[K] : unknown) | undefined;
  all<K extends R>(key: K): ReadonlyMap<string, K extends CapKey ? CapabilityMap[K] : unknown>;
  provide<K extends P>(key: K, value: K extends CapKey ? CapabilityMap[K] : unknown): () => void;
  secret(pointer: string): Promise<string>; // {credentialRef} at `pointer` in row config via ovo.secret-resolver
  readonly net: NetPort; // parent ovo.net filtered by manifest.runtime.egressHosts (https/wss only)
  effect: Context['effect'];
  on: Context['on'];
  fiber: Context['fiber'];
  reflect: Context['reflect'];
}
```

| Action                                                                        | Violation                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------- |
| `get`, `maybe`, `all` or `reflect.get` on a key outside `requires ∪ optional` | `read-undeclared`                           |
| `provide` on a key outside `provides`                                         | `provide-undeclared`                        |
| A host not in `runtime.egressHosts` reached through `net`                     | `egress-denied`, which throws in every mode |
| An `engine` plugin touching `ovo.execution` or `ovo.tool-connector.*`         | `engine-tool-access`, which always throws   |

The host's own code keeps using the raw `composition.ctx`.

### 3.4 Cardinality `many`

- The facade registers a provided value under `${key}:${manifest.provider ?? manifest.id}`.
- `resolveGraph` allows several providers of a many-key, as long as their qualifiers differ.
- A plugin that requires a many-key depends on **all** of that key's providers. Zero providers is allowed.
- `ctx.all(key)` returns a frozen map.
- One-keys keep today's `Ambiguous service` error.

### 3.5 Scope and parent composition

`compose(rows, catalog, { scope?, parent?, workspaceId?, enforcement?, net?, fixtures? })` works as follows.

- **Scope.** It rejects a definition whose `manifest.scope` differs from `scope` (when `scope` is given). Existing behavior is kept when `opts` is omitted.
- **Separate roots.** Every composition gets its own Cordis root context.
  - Cordis keeps one service registry for a whole context tree, and `reflect.ts` throws `service has been registered` on duplicates.
  - So a session composition is **never** a Cordis child of the process composition. Concurrent sessions that each provide `ovo.stt` would collide.
- **Parent reads.**
  - A session plugin may read a **declared** key that the parent provides, when that key's spec scope is `process` or `either`.
  - The facade serves such reads by delegating to `parent.ctx`.
  - `resolveGraph` counts parent-provided keys as satisfied.
- **Cordis inject.** A plugin's Cordis `inject` is `requires` minus optional keys, many-keys and parent-satisfied keys. Otherwise a plugin that injects a parent-only key would never activate.
- **Release validation** in the API uses `validateGraph(rows, catalog, { scope: 'session', parentKeys: [...HOST_SESSION_SERVICES, Cap.net] })`.
  - It resolves the graph and validates config and scope, but it **never runs `apply`**. Engines and providers are never started against real media during validation.
  - It replaces `WORKER_VOICE_PORTS` (`apps/api/src/release-runtime.ts:17-23, 281-300`) and the scope check at `:80`.

### 3.6 Secrets

- `config-guard.ts` rejects row config that holds a plain string at any `secretFields` pointer (`secret.inline`), in every mode.
- `ctx.secret(pointer)` resolves `{credentialRef:{credentialId}}` through `ovo.secret-resolver`, using the composition's `workspaceId`.
- Declaring `secretFields` automatically adds `ovo.secret-resolver` to `optional`.
- Carrier plugins are process-scope and never resolve secrets themselves. The host passes them a `ResolvedBinding`.

### 3.7 Enforcement modes and the violation ratchet

- `OVO_PLUGIN_ENFORCEMENT=warn|enforce`.
  - v1 manifests default to `warn`, with violations collected on `composition.violations`.
  - v2 manifests always enforce.
- The runtime reports every violation to a sink set with `setViolationSink(fn)`. The runtime never writes files itself.
- F2's vitest `setupFiles` entry (`scripts/vitest-violation-sink.ts`) appends JSON lines to `$OVO_PLUGIN_VIOLATION_LOG`.
- F2's `globalSetup` (`scripts/vitest-global-setup.ts`) dedupes the log by `(pluginId, kind, key)` in teardown. It fails on entries that are missing from both `scripts/baselines/runtime-violations.json` and every `scripts/baselines/pending/*.json` `runtimeViolations` list.
- Wave 3 switches v1 to enforce and empties the baseline.

### 3.8 Kind rules (checked at compose time)

- `engine`:
  - may not require or read `ovo.execution` or any `ovo.tool-connector.*` key;
  - its companions must exist in the catalog at the same version.
- `stt`, `tts`, `llm` and `carrier` must declare the fields listed in §3.1.
- `fixture` plugins compose only when `fixtures: true` is set. Only `packages/fixture-calls` and tests set it.
- `runtime.native: 'glibc'`: the host checks `process.report.getReport().header.glibcVersionRuntime` at load. If glibc is absent, the plugin is marked unavailable with a reason, rather than thrown.

### 3.9 Registry and loader

**Loader.** `runtime/src/installed.ts` takes over `loadInstalledSessionExtensions` from `plugin-session/src/installed.ts`, which becomes a re-export.

- It accepts `module.plugins[]`, `module.nativeHandlers`, `module.fixtures` and `module.fixtureTemplates`.
- It checks that ids are unique, and that `(kind, provider)` is unique for session kinds.
- It parses v2 manifests.

**`runtime/src/registry.ts`.** `PluginRegistry(catalog)` has these methods:

| Method                              | What it does                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list(kind?)`                       | Lists installed plugins, optionally filtered by kind                                                                                |
| `resolve(kind, providerOrId)`       | Returns exactly one match, or throws                                                                                                |
| `get(id, version?)`                 | Looks up a plugin by id                                                                                                             |
| `resolvePin(id, version)`           | Exact match, otherwise the same id with the **same major** for pin-compatible kinds (§4.2). Returns `{definition, exact: boolean}`. |
| `validateBinding(pluginId, config)` | Runs Ajv against `bindingSchema` (strict: false)                                                                                    |
| `project()`                         | A JSON-safe public view, with no functions and never a secret value                                                                 |
| `unavailable()`                     | Plugins that failed runtime checks, with the reasons                                                                                |

---

## 4. Selection model, pinning, validation (host seams)

### 4.1 Agent configuration

```ts
export const Slot = z.enum([
  'engine',
  'carrier',
  'stt',
  'tts',
  'llm',
  'vad',
  'turnDetector',
  'audioFilter',
]);
export const VoiceSelection = z
  .object({
    plugin: z.string().min(1),
    binding: z.string().optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const Acknowledgement = z.enum([
  'weak-playback-evidence',
  'model-licence:livekit-turn-detector',
  'model-licence:silero',
  'model-licence:smart-turn',
]);
AgentConfig += {
  voice: z
    .object({
      engine,
      carrier,
      stt,
      tts,
      llm,
      vad,
      turnDetector,
      audioFilter: VoiceSelection.optional(),
      textFilters: z.array(VoiceSelection).max(8).default([]),
      acknowledgements: z.array(Acknowledgement).default([]),
    })
    .optional(),
};
```

- `AgentConfig.providers` stays exactly as it is. **Contracts contain no first-party plugin ids.**
- `session-host/normalize.ts` maps each legacy `providers.{stt,tts,inference,telephony}` binding to `voice.<slot>` via `registry.resolve(kind, binding.provider)`. The slot names map `inference → llm` and `telephony → carrier`.
- Missing slots are filled from the distribution defaults:

| Slot         | Default                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| engine       | `@winsendotai/ovo-plugin-voice-session-engine`                                                       |
| turnDetector | `@winsendotai/ovo-turn-detector-default` (optional; skipped with a warning when it is not installed) |
| textFilters  | `@winsendotai/ovo-text-filter-markdown` (optional)                                                   |
| vad          | none                                                                                                 |

### 4.2 Release selections and pinning

```ts
Release += {
  selections: Partial<
    Record<
      Slot | `textFilter:${number}` | `companion:${string}`,
      {
        pluginId: string;
        version: string;
        bindingId?: string;
        binding?: {
          provider: string;
          config: Record<string, unknown>;
          credentialId: string;
          fingerprint: string;
          updatedAt: string;
        };
        config: Record<string, unknown>;
      }
    >
  >,
};
```

**Pinning policy.** This revision replaces "exact everywhere", which would break every existing live release whenever a kept-id plugin changed version.

| What                                                                                                | Rule                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behaviors, tools, native-handler extensions and v1 replacement engines                              | **Exact** `id@version`, unchanged from HANDOFF. `release.plugins[]` stays the lock. Messages are unchanged: `does not satisfy release pin`, `live release plugin is not installed`, `multiple installed voice session engine providers`.                                                                                                                                                             |
| v2 selections of kind engine, companion, stt, tts, llm, vad, turn-detector, text-filter and carrier | Recorded as `id@version`. They resolve to the exact version if it is installed, otherwise to the same id with the **same major** version (`registry.resolvePin`). The version actually used goes into call telemetry and the call evidence. A different major, or a missing id, fails the job as non-retryable (`release.plugin_unavailable`), and readiness reports `plugin_version_not_installed`. |
| Releases made before this change (no `selections`)                                                  | `deriveLegacySelections` fills selections from `providerBindings` and the defaults. These selections are **unpinned**: they resolve by id to whatever version is installed, the version is recorded in telemetry, and readiness warns `legacy_release_unpinned`. The console offers "Re-release with current plugins".                                                                               |

- `DRIVER_IDS` (`apps/worker/src/production-session-support.ts:12-20`) is deleted.
- Carriers are process-scope, but they follow the same major-compatible rule.

### 4.3 Bindings

- `ovo_ctl_provider_bindings` gains the nullable columns `kind` and `plugin_id`.
- `POST/PUT /v1/provider-bindings` accepts an optional `pluginId`.
  - When it is absent and exactly one installed plugin has that provider, the API infers it. Otherwise the column stays NULL.
  - `kind` is derived from the manifest.
  - `config` is validated against `bindingSchema`.
- Backfill is idempotent:
  - `deepgram` → stt;
  - `twilio` → carrier;
  - `openai` → tts or llm, only when every referencing agent uses it in the same role. Otherwise the columns stay NULL.
- **`GET /v1/provider-bindings/:id/carrier-urls`** (F4) returns, for a carrier binding, every `operatorUrls` entry rendered through `callbackUrl`/`mediaUrl`. These are the URLs an operator pastes into the Twilio, Exotel or Plivo console, each with its binding-level `?t=` secret.

### 4.4 Storage and schema migrations (whole plan)

| Migration                                                                                                                              | Unit | Change                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugin-storage/src/postgres/migrations/004-release-selections.ts` + sqlite                                                            | F3   | `ovo_ctl_releases.selections JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(selections)='object')` (sqlite `selections_json TEXT`); bindings `kind`, `plugin_id` (nullable); `ovo_ctl_calls.kind` CHECK widened to `('live','simulation','test')` (the constraint name is looked up in `pg_constraint`; idempotent); backfill |
| orchestration **migration ledger** (`ovo_orch_schema_migrations`, advisory lock, versioned like `plugin-operations/src/migrations.ts`) | F3   | 001 and 002 are recorded as applied when their tables exist. Before this, `runMigrations` re-ran 001 and 002 on every boot.                                                                                                                                                                                                    |
| `plugin-orchestration/migrations/003_carrier_identity.sql`                                                                             | F3   | session routes and jobs: `carrier_id TEXT NOT NULL DEFAULT 'twilio'`, `binding_id TEXT NULL`, `carrier_request_id TEXT NULL`; routes `carrier_stream_call_id TEXT NULL`; indexes `(carrier_id, carrier_call_id)` and `(carrier_request_id)`                                                                                    |
| `plugin-operations/migrations/005_inbound_carrier.sql`                                                                                 | F3   | `ovo_ops_inbound_routes.carrier_plugin_id`, `carrier_binding_id` (nullable → env binding)                                                                                                                                                                                                                                      |
| `plugin-storage/src/postgres/migrations/005-mcp-tool-removed.ts` + sqlite                                                              | M1   | discovered tools `removed_at TIMESTAMPTZ NULL`; the RESTRICT FK stays (#6)                                                                                                                                                                                                                                                     |
| `plugin-orchestration/migrations/004_job_hints_drop_capacity.sql`                                                                      | O1   | `ovo_jobs.hinted_at`, `hint_count`; `DROP TABLE IF EXISTS ovo_capacity_writes, ovo_capacity_leases`; `superseded` job status. It is safe because of the ledger.                                                                                                                                                                |
| ledger **migration ledger** + `plugin-ledger/migrations/002_reservation_expiry.sql`                                                    | O2   | `ovo_cost_reservations.holder`, `expires_at`, `session_id`, index `(state, expires_at)`                                                                                                                                                                                                                                        |
| `plugin-operations/migrations/006_campaign_pacing.sql`                                                                                 | O2   | `max_concurrency`, `ovo_ops_pacing_buckets`, attempt status `superseded`                                                                                                                                                                                                                                                       |

- **Terminal outcomes use existing columns.** Voicemail, busy, no-answer and completed-without-session are recorded as status `failed` with `terminal_reason` (attempts) or `last_error` (jobs) set to `voicemail`, `busy`, `no_answer` or `completed_without_session`. No new CHECK values are needed.
- Every migration is additive or guarded.
- `scripts/postgres-restore-fence.sql` is **not edited**. Its `ovo_capacity_leases` block is guarded by `to_regclass` and tolerates the dropped table.

### 4.5 Compatibility validation (`packages/session-host/src/compat/*.ts`)

These are pure functions, one rule per file. Readiness, release creation, `POST /v1/plugins/compat`, the worker (as defence in depth) and fixture calls all call them.

```ts
export type CompatCode =
  | 'plugin_not_installed'
  | 'plugin_version_not_installed'
  | 'plugin_unavailable'
  | 'binding_missing'
  | 'binding_plugin_mismatch'
  | 'binding_schema_invalid'
  | 'secret_inline'
  | 'format_unreachable'
  | 'stt_frame_size'
  | 'language_unsupported'
  | 'mode_requires_llm'
  | 'mode_llm_unused'
  | 'turn_signal_missing'
  | 'playback_evidence_insufficient'
  | 'engine_capability_missing'
  | 'amd_unsupported'
  | 'meter_uncovered'
  | 'runtime_incompatible'
  | 'licence_unaccepted'
  | 'fixture_unavailable'
  | 'mcp_tool_removed'
  | 'termination_unsupported'
  | 'legacy_release_unpinned';
export type CompatStage = 'release' | 'live' | 'test';
export interface CompatIssue {
  code: CompatCode;
  severity: 'error' | 'warning';
  stage: CompatStage;
  slot?: Slot;
  pluginId?: string;
  field?: string;
  message: string;
}
```

| Code                                    | Severity                          | Rule                                                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format_unreachable`                    | error                             | `audio.codecGraph` finds no path from the carrier format to the STT input formats or the TTS output formats, or none to the engine's `formats`                                                                                         |
| `stt_frame_size`                        | warning                           | The STT's `frameMs.min` is above the carrier frame size. The host STT adapter re-frames, so this is only a warning.                                                                                                                    |
| `language_unsupported`                  | error                             | The agent language is not in the plugin's `languages`                                                                                                                                                                                  |
| `mode_requires_llm` / `mode_llm_unused` | error / warning                   | context and agent modes need an LLM; announcement and faq should not have one                                                                                                                                                          |
| `turn_signal_missing`                   | error                             | The strategy resolves to `provider`, the STT declares neither `end-of-turn` nor `utterance-end`, and no VAD is selected                                                                                                                |
| `playback_evidence_insufficient`        | **error**                         | A tool with `effect: 'write'` and `confirmation: true`, while the carrier evidence is not `carrier-played` or the engine has `confirmedPlayback: false`. It applies unless `voice.acknowledgements` includes `weak-playback-evidence`. |
| `termination_unsupported`               | **error**                         | The carrier's `control.hangup` is `'close-stream'` and the binding config lacks `streamEndTerminatesCall: true` (§4.10)                                                                                                                |
| `amd_unsupported`                       | error                             | A campaign configures AMD but the carrier reports `amd: 'none'`                                                                                                                                                                        |
| `meter_uncovered`                       | error (`live`) / warning (`test`) | A selected role has no manifest meter (with `when` evaluated against the binding), or a meter has no price card                                                                                                                        |
| `runtime_incompatible`                  | error                             | The plugin needs glibc and the worker image lacks it                                                                                                                                                                                   |
| `licence_unaccepted`                    | error                             | A plugin lists `modelLicences` with no matching acknowledgement                                                                                                                                                                        |
| `fixture_unavailable`                   | error (`test`)                    | A selected stt, tts, llm or carrier plugin exports no fixtures or fixture template (§12)                                                                                                                                               |
| `mcp_tool_removed`                      | error (`release`)                 | An allowed MCP tool's discovered tool has `removedAt`                                                                                                                                                                                  |
| `legacy_release_unpinned`               | warning                           | The release has no `selections`                                                                                                                                                                                                        |

**When each code is enforced.**

- **Stage `release`** blocks release creation (HTTP 422). This covers `plugin_not_installed`, `plugin_version_not_installed`, `binding_missing` for a selected slot, `binding_plugin_mismatch`, `binding_schema_invalid`, `secret_inline` and `mcp_tool_removed`.
- **Stage `live`** covers every other error. It blocks live admission: readiness `liveReady`, the worker's pre-dial check, and fixture calls, except that `meter_uncovered` is only a warning for fixture calls.
- **Stage `test`** is used only by fixture calls.

Simulation-only agents stay publishable.

### 4.6 `packages/session-host` (host library; replaces most of `plugin-session`)

| Module                                                | Job                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `normalize.ts`                                        | Maps legacy config to `voice.*` and fills defaults                                                                                                                                                                             |
| `compat/*.ts`, `compat/index.ts`                      | The rules above, plus `validateSelections(input, stage)`. Every rule is registered in index.ts, including `mcp-tool-removed.ts`.                                                                                               |
| `select-session-graph.ts`                             | `selectSessionGraph({release, registry, hostServices, parent, media, fixtures?, installedExtensions})` returns `{rows, catalog, resolved: {slot → {id, version, exact}}}`. Details below the table.                            |
| `engine-selection.ts`                                 | `selectEngine(release, registry, installedExtensions, fallback)`. It keeps the HANDOFF semantics and messages for v1 replacement engines, including exact pins and v1 row config, and uses §4.2 for v2 engines.                |
| `speech-adapters/{stt-format,tts-format,decorate}.ts` | The host format adapters (§2.4), plus `decorateByKind(definition, decorators)` so the worker can add telemetry around stt, tts and llm plugins                                                                                 |
| `session-catalog.ts`                                  | `createSessionPluginCatalog`, moved from `plugin-session/src/index.ts`. The OpenAI inference fallback at `:68-80` is deleted: live LLM comes only from the llm selection, and simulations keep the `inferencePlugin` override. |
| `meters.ts`                                           | `metersFor(selections, registry, {requiresInput})` = carrier ∪ tts ∪ (input ? stt : ∅) ∪ llm meters, filtered by `when`                                                                                                        |
| `carrier-registry.ts`                                 | `CarrierRegistry(controls, bindings)` with `forRelease(release)` → `{carrierId, bindingId, control, capabilities}` and `forInboundRoute(route)`. A NULL binding means the reserved id `env`.                                   |
| `carrier-bindings.ts`                                 | `resolveBinding(id)` → `ResolvedBinding`. The id `env` reads `OVO_CARRIER_ENV_BINDINGS`.                                                                                                                                       |
| `host-ports.ts` + `stream-grants.ts`                  | `createCarrierHostPorts({publicBaseUrl, routeSecret, operations, orchestration, bindings, clock})`. Details below the table.                                                                                                   |
| `terminate.ts`                                        | `terminateCarrierLeg(...)` (§4.10)                                                                                                                                                                                             |
| `installed.ts`                                        | re-export of `runtime/installed.ts`                                                                                                                                                                                            |

**`selectSessionGraph` details.**

- It resolves each selection through `registry.resolvePin`, or unpinned for legacy releases.
- It adds engine companions, unless `hostServices` provides that key.
- It includes a host service definition only when a selected plugin requires or optionally reads one of its keys.
- Provider row config = `{binding: snapshot.config, credentialRef: {credentialId}, ...selection.config}`.
- Engine row config = `{session: SessionInput, engine: selection.config}`, where `SessionInput.mode = config.mode` and `maxCallSeconds = config.costPolicy?.maxCallSeconds ?? 1800`.
- Turn-detector row config = `selection.config`, which is its `TurnConfig`.
- It wraps stt and tts with the format adapters.

**`host-ports.ts` details.**

- `mediaUrl` returns `wss://<host>[:port]/carriers/<id>/<binding>/media`.
  - The port is kept only when `OVO_MEDIA_PUBLIC_BASE_URL` has an explicit non-default port.
  - It throws on a non-https base.
  - A query is added only for carriers with `queryOnMediaUrl`.
- `callbackUrl` adds the url-secret, per call when `requestId` is given (§2.8).
- `streamForDial` and `resumeStream` are implemented on the orchestration store methods from F3 (§4.10).
- `admitInbound` and `applyCallEvent` delegate to injected operations and orchestration ports.

`plugin-session` becomes a re-export façade of `session-host`. Wave 3 deletes it.

### 4.7 `packages/distribution` (the single registration list)

```ts
// src/catalog.ts — THE list. One entry per first-party plugin package (or package subpath).
export const FIRST_PARTY: readonly CatalogEntry[] = [
  {
    package: '@winsendotai/ovo-behaviors',
    roles: ['session', 'api'],
    load: () => import('@winsendotai/ovo-behaviors'),
  },
  {
    package: '@winsendotai/ovo-plugin-voice',
    roles: ['session', 'api'],
    load: () => import('@winsendotai/ovo-plugin-voice'),
  },
  {
    package: '@winsendotai/ovo-plugin-carrier-twilio',
    roles: ['api', 'worker', 'gateway', 'dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-carrier-twilio'),
  },
  {
    package: '@winsendotai/ovo-plugin-operations/background-tasks',
    roles: ['dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-operations/background-tasks'),
  },
  // …F3 pre-registers every package and subpath this plan creates (§15.3)
];
export interface CatalogEntry {
  package: string;
  roles: readonly ('session' | 'api' | 'worker' | 'gateway' | 'dispatcher')[];
  load: () => Promise<{
    plugins?: PluginDefinition[];
    nativeHandlers?: unknown;
    fixtures?: Record<string, NetFixtureScript[]>;
    fixtureTemplates?: Record<string, FixtureTemplate>;
  }>;
}
```

| File                                              | Contents                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/defaults.ts`                                 | The default plugin id per slot (§4.1)                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/load.ts`                                     | `loadDistribution({role, profile, env})` → `{catalog, processRows, defaults, fixtures, fixtureTemplates, unavailable}`. It merges `FIRST_PARTY`, the legacy bridges and `OVO_PLUGIN_MODULES`. **Supersede rule:** when a catalog package exports a plugin with the same id as a legacy bridge, the package wins and the bridge is dropped with a log line. That lets wave-2 units replace bridges without editing distribution. |
| `src/profiles/{api,worker,gateway,dispatcher}.ts` | One app's infra rows each. Each exports `rows(profile: 'compose' \| 'fargate', env)`. F3 creates all four. In wave 2, C2 owns `gateway.ts`, and O1 owns `worker.ts` and `dispatcher.ts`.                                                                                                                                                                                                                                        |
| `src/env-bindings.ts`                             | `legacyEnvBindings(env)` builds `OVO_CARRIER_ENV_BINDINGS` from `TWILIO_*` when that variable is unset. It **skips placeholder values** (Compose ships `not-configured` and `disabled-local-account`). Validation happens when a binding is resolved, never at startup.                                                                                                                                                         |
| `src/legacy/*.ts`                                 | The wave-1 bridges: Deepgram STT, OpenAI TTS, OpenAI LLM and the Twilio carrier. I1 deletes them.                                                                                                                                                                                                                                                                                                                               |

Apps import only `distribution`, `session-host`, `runtime` and infra packages. The architecture gate enforces that.

### 4.8 API changes (F4 unless noted)

| Change                                                                                                                                                             | Where                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /v1/plugins?kind=` → `registry.project()` plus `unavailable`                                                                                                  | new `routes/plugins.ts`                                                              |
| `POST /v1/plugins/compat` `{voice, mode, language, tools, campaign?}` → `CompatIssue[]`                                                                            | same file                                                                            |
| Bindings take an optional `pluginId`, which is inferred when unambiguous; Ajv validates against `bindingSchema`; `GET /v1/provider-bindings/:id/carrier-urls`      | `routes/credentials.ts`, `schemas.ts`                                                |
| Release creation normalizes `config.voice`, persists `selections` and returns `422 {blockers: CompatIssue[]}`                                                      | `routes/agents.ts`, `release-runtime.ts` (`validateGraph`, §3.5)                     |
| Readiness keeps `blockers: string[]` and **adds** `details: CompatIssue[]`                                                                                         | `routes/readiness.ts`, `live-readiness.ts`                                           |
| `GET /v1/calls` is newest first, with a cursor, `?order=asc`, and filters `agentId, engine, carrier, kind, status`                                                 | storage (F3) plus the route (D1 exposes the filters)                                 |
| Route registration is a list in `routes/registry.ts`. F4 registers stubs for `routes/test-calls.ts`, which returns 404 `fixture_calls_disabled` until D1 fills it. | `api-plugin.ts` (split below 300 lines)                                              |
| Evaluation inference is provider-neutral: any installed llm plugin, with the meter checks kept                                                                     | `provider-evaluation-runtime.ts`, `plugin-evaluations/src/provider-{policy,gate}.ts` |
| Handoff goes through `CarrierRegistry` (`control.handoff`)                                                                                                         | `operations-runtime.ts`                                                              |
| Named SSE heartbeat (D1), fixture test calls and evidence (D1)                                                                                                     | `routes/performance.ts`, `routes/test-calls.ts`, `routes/inspection.ts`              |

### 4.9 Worker changes (F4 unless noted)

**Session graph.** `production-session-factory.ts` is split below 300 lines and uses `selectSessionGraph` with the process composition as parent.

- The session-services plugin provides `ovo.operation-store`, `ovo.secret-resolver`, `ovo.media.duplex` (the recording-wrapped `MediaDuplex`), `ovo.usage-sink` (fanned out to cost and telemetry), `ovo.transcript-observer` and `ovo.clock`.
- Telemetry decorates stt, tts and llm by kind.
- Telemetry, recording evidence and cost subscribe to `engine.subscribe()`. Recording evidence goes through a worker shim, `recording-evidence.ts`, that feeds engine `speech` events into today's `capture.attachEvidence` API.
- `dispose(reason)` maps the `EndReason` through `outcomeFor`, replacing `reason.includes('completed')` (#20).
- **v1 engine compatibility.** A release-pinned v1 replacement engine keeps its v1 row config (`{language, inputEnabled, initialInput, initialVariables}`). A host adapter gives it a no-op `subscribe()` and an `end` event. `selectVoiceSessionEnginePlugin` stays exported from `production-session-support.ts`, delegating to `session-host/engine-selection.ts`.

**Carrier per job.** `runner.ts`, `inbound-runtime.ts`, `campaign-dial.ts`, `dial-request.ts`, `dial-settlement.ts` and `reconciliation.ts` use `CarrierRegistry.forRelease(release)`.

- `DialRequest` v2 takes its media URL and callbacks from the host ports (#1: never `/twilio/media`, always wss).
- `routeParams` are set only when `streamParams: 'at-dial'`.
- `maxDurationSec = maxCallSeconds + 30`.
- **Handshake TTL** = `(ringTimeoutSec ?? 60) + 60` s, instead of a fixed 60 s. Tokens minted by `streamForDial` and `resumeStream` get a fresh 60 s.
- `markDialAccepted` accepts `carrierCallId?` and `carrierRequestId?`. After-answer carriers (Plivo) are accepted with only a request id.
- Settlement follows `Reconciliation` (#26):

| Reconciliation                                | Settlement                                          |
| --------------------------------------------- | --------------------------------------------------- |
| `pending` or `live`                           | wait                                                |
| `ended` busy or no_answer                     | failed (`terminal_reason`); retryable per policy    |
| `ended` completed with no session ever opened | `completed_without_session`, which is not a success |
| `answeredBy` machine                          | `voicemail`                                         |
| any unmapped legacy state                     | `pending`                                           |

**Termination** goes through `terminateCarrierLeg` (§4.10).

**Process wiring.**

- `main.ts` (384 lines) is split into `main.ts`, `worker-process.ts` and `worker-loop.ts`.
- Distribution is loaded with role `worker`. `ovo.net` comes from plugin-kit. `TWILIO_*` is no longer read directly.
- `createProductionWorkerMediaRuntime` gets its final signature: it takes `httpServer: http.Server` (the health server on port 4100) and returns `{ start(), close(reason), closeSession(id, reason), terminate(sessionId) }`.
  - In wave 1 its internals still use the legacy gateway client.
  - C2 later attaches the `/internal/media` upgrade handler to that same server. The port is 4100 either way, and `route.workerEndpoint` is already `ws://<ip>:4100/internal/media`.
- **Cost.** `cost-runtime.ts` takes its required meters from `metersFor`.
- **Speech cache.** Keys come from `TextToSpeech.cacheIdentity(format, voice)`.

### 4.10 Termination, continuation and correlation (host rules)

**`terminateCarrierLeg({route, control, capabilities, media, engine, reason})`** runs these steps in this order:

1. `store.requestSessionTermination(route)` sets the route to `terminating`. From then on `streamForDial`, `resumeStream` and gateway starts for this route are refused.
2. `control.hangup({carrierCallId, carrierRequestId})`. Before answer, a carrier with `cancelBeforeAnswer` cancels by request id.
3. If step 2 returns `unsupported` (close-stream carriers), call `media.terminate(sessionId)`. The worker sends `session.end{reason:'terminate'}`, and the gateway sends `terminate?()` frames and closes the carrier socket.
4. `engine.dispose(reason)`.

- Ownership loss, drain, `behavior_completed`, max duration and idle all use this path.
- A carrier stream that **opens later** for a terminating or terminal route is closed by the gateway before any audio is sent. For a close-stream carrier, that is what ends a call that was answered after ownership loss.
- **Close-stream carriers** (Exotel) must have `streamEndTerminatesCall: true` in their binding. It is a required `const true` in the plugin's `bindingSchema`, and compat code `termination_unsupported` enforces it too. The operator attests that the carrier flow is _Voicebot → Hangup_, so closing the stream ends the call. Continuation is `'none'` for such carriers.
- **Resume race.** Because step 1 runs before any media closes, Twilio's `<Redirect>` to `/resume` finds the route `terminating` and receives `<Hangup/>`. `resumeStream` re-issues only for status `connected`, with no `terminal_reason`, when the owning worker's slot heartbeat is fresh.
- **Correlation.**
  - `streamForDial` correlates by `dialRequestId` (from `answer?r=` or Exotel's `CustomField`), or by `carrierRequestId`, or by `carrierCallId`.
  - When the route has no `carrier_call_id`, it binds one (CAS where NULL).
  - When the carrier's id differs and `streamCallIdMatchesDial !== true`, it stores `carrier_stream_call_id` as an alias and records a `carrier.call_id_mismatch` audit event, for sandbox verification.
  - The gateway's start check authenticates the single-use route token (`sid` + `rt`). Then `start.carrierCallId` must equal `carrier_call_id` or `carrier_stream_call_id`, or bind it when both are NULL.
  - Status callbacks correlate by `dialRequestId`, `carrierRequestId`, `carrierCallId` or the alias.

---

## 5. Gateway: carrier-neutral router and topology (unit C2)

### 5.1 Router

`packages/plugin-media` keeps what is carrier-neutral:

- route-token verification and the durable-route cross-check;
- epoch and generation fencing;
- sequencing, backpressure, idle timers, drain and `/health`.

Everything carrier-specific leaves: `gateway.ts:3-9,103-115,196,308-311`, `carrier-callback.ts` and `twilioAuthToken`.

The gateway process composition reads `ctx.all(Cap.carrierIngress)` and mounts these routes:

| Path                                                                                         | Handler                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /carriers/:carrierId/:bindingId/media`                                                  | WebSocket upgrade → `serializer.authenticateUpgrade({url (with query), externalUrl (no query), headers, remoteAddress}, {bindingId, resolveBinding, verifyUrlSecret})` |
| `POST\|GET /carriers/:carrierId/:bindingId/:purpose`                                         | `route.handle(req, hostPorts)`                                                                                                                                         |
| each `ingress.legacyPaths` entry (e.g. `/twilio/media`, `/twilio/status`, `/twilio/inbound`) | alias to the `env` binding until phone numbers are repointed                                                                                                           |

An unknown carrier or purpose returns 404.

**`externalUrl`** = the `OVO_MEDIA_PUBLIC_BASE_URL` origin, including an explicit non-default port when there is one, plus the **exact** path, with **no query**. The scheme is `wss` for upgrades and `https` for HTTP.

**Per-socket flow**

1. `decode(frame)` produces `CarrierMediaEvent[]`.
2. On `start`:
   1. authenticate `sid` + `rt`;
   2. refuse and close if the route is terminating or terminal;
   3. apply the carrier-call-id rule (§4.10);
   4. open the worker link (§5.3).
3. `audio` becomes `media.audio`, `played` becomes `media.played{evidence}`, and `dtmf`, `cleared` and `stop` map through the same way.
4. Worker commands go through `encode(cmd)`. `session.end{reason:'terminate'}` sends `terminate?()` frames and closes the socket.

**Inbound admission.** The carrier-neutral state machine moves to `apps/media-gateway/src/inbound-admission.ts`: reserve → wait → callback → human. It returns `InboundDecision` through `plugin-operations`' `inboundDecisionFor()`, which F3 adds. `inbound-webhook.ts` is deleted.

**Campaign attempts.** `campaignAttemptStatus` never maps `completed` to `succeeded` when `answeredBy === 'machine'` or no session ever opened (#26).

### 5.2 WebSocket and pre-accept buffer

- **WebSocket library.** `ws@8.21.3` is used with `noServer: true`, `maxPayload: 1 MiB` and `perMessageDeflate: false`, for both the carrier server and the gateway → worker client (#27b).
- **Pre-accept buffer (#2).** Audio buffered before the worker accepts is budgeted by duration and bytes:
  - `preAcceptBufferMs` = 3000, measured as `payload.length / bytesPerSecond(format)`;
  - a byte cap of `min(2 × bytesPerSecond × 3, 196608)`;
  - DTMF, `start` and `played` are never dropped.

  `OVO_MEDIA_PRE_ACCEPT_MS` replaces `OVO_MEDIA_MAX_PENDING_FRAMES`, which is kept as a deprecated alias converted at 20 ms per frame.

- **Early accept.** The worker sends `session.accept` as soon as identity and fencing check out, before STT connects. The engine ring-buffers the audio.

### 5.3 Topology: the gateway dials the worker (#23)

- **Gateway to worker.** On `start`, the gateway opens `ws://<route.workerEndpoint>` with `authorization: Bearer <OVO_MEDIA_WORKER_TOKEN>`.
  - It sends `session.open {protocol: 2, carrierId, bindingId, carrierCallId, streamId, format, playbackEvidence, clearFlushesMarkers, routeToken, ownerEpoch, generation}`.
  - It waits for `session.accept` or `session.reject`.
- **Worker server.** `apps/worker/src/worker-media-server.ts` attaches a `ws` upgrade handler for `/internal/media` to the **existing health server on port 4100**, which it receives through `createProductionWorkerMediaRuntime({httpServer})`.
  - It checks the bearer token, then the route token and owner epoch against the worker's claimed job.
  - `WorkerGatewayClient` (`plugin-media/src/worker-client.ts`) and "drain on gateway disconnect" are deleted.
- **Stateless gateways.** Gateways hold no worker registry. Two or more replicas run behind the ALB. The Terraform changes belong to O1.
- **Drain on SIGTERM.** The gateway stops accepting upgrades, and `/health` returns 503 so the ALB deregisters it. It keeps the existing carrier sockets until they end or until `OVO_MEDIA_DRAIN_TIMEOUT_MS` passes (default: deregistration delay − 30 s). Only then does it close them. Carriers with a continuation re-enter through `/resume` on a healthy gateway.
- **Continuation when a gateway task dies:**

| Carrier | Continuation                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------ |
| Twilio  | `<Connect><Stream/></Connect><Redirect method="POST">…/resume?r=…&t=…</Redirect>`                |
| Plivo   | `keepCallAlive="true"` + `<Redirect>`                                                            |
| Exotel  | `'none'` (the flow ends with Hangup). A gateway crash drops the call; a graceful drain does not. |

- `/resume` calls `host.resumeStream`, which re-issues at `generation+1` only under the §4.10 rule.
- The worker's `MediaDuplex` supports `rebind(newLink)`, so the engine keeps running while the socket is swapped.
- **Protocol v2** (`plugin-media/src/protocol.ts`):
  - Gateway → worker: `media.audio`, `media.played{name, evidence}`, `media.cleared`, `media.dtmf`, `call.answered-by{value}`, `session.close{reason}`.
  - Worker → gateway: `audio`, `mark`, `clear`, `session.end{reason}`.
  - The v1 names `callSid` and `streamSid` are accepted for one release.

---

## 6. OVO native engine, rebuilt (units E1 and E2)

- **Not adopted from Pipecat:** the frame and processor pipeline, bot speech inferred from a clock, soxr (LGPL), Krisp, and LLM turn-completion markers.
- **Kept from OVO:** the epoch scheduler, mark-confirmed playback evidence, `PlaybackConversation` and the tool policy.

### 6.1 Packages

**`packages/plugin-turns` (E1).** Kind `turn-detector`, id `@winsendotai/ovo-turn-detector-default`. It provides `ovo.turn-detector`, and its config schema is `TurnConfigSchema`. Each module is ≤200 lines:

| Module                                                      | Job                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controller.ts`                                             | Ordered start and stop strategies, plus the `stopTimeoutMs` safety net. It never stops a turn while the user is speaking.                                                                                                                                 |
| `aggregator.ts`                                             | Appends finals idempotently on `segmentId`, **never deduplicating by text**. Releases the text on `turn.stopped` (#3).                                                                                                                                    |
| `start-vad.ts`, `start-transcript.ts`, `start-min-words.ts` | Min-words is evaluated on every interim. Confirmation words are never backchannels while a confirmation is pending (§2.7).                                                                                                                                |
| `stop-provider.ts`                                          | `end-of-turn` or `utterance-end` stops the turn                                                                                                                                                                                                           |
| `stop-speech-timeout.ts`                                    | On VAD stop: emit `force-endpoint` and start two timers, `userSpeechTimeoutMs` and `max(0, (sttP99Ms ?? stt.ttfsP99Ms ?? 1000) − vad.stopMs)`. A final cancels the STT wait. The turn stops when both timers are done, the VAD is quiet, and text exists. |
| `mute.ts`                                                   | The §2.7 semantics, including buffering during a confirmation prompt                                                                                                                                                                                      |
| `idle.ts`                                                   | The timer starts at `bot.stopped` only when no user turn is open and no tool is running. `idle{retry, prompt}` repeats up to `maxRetries`, then `idle{final}` → `caller_idle`.                                                                            |
| `dtmf.ts`                                                   | 2 s inter-digit flush, `#` terminator, `maxDigits` 32, interrupt on the first digit. One `{kind: 'dtmf', digits}` turn.                                                                                                                                   |
| `strategies.ts`                                             | Builds the strategy lists from the config                                                                                                                                                                                                                 |

**`packages/plugin-vad` (E1).** Kind `vad`, id `@winsendotai/ovo-vad-energy`. It provides `ovo.vad` with an energy/ZCR VAD. The state machine is counted in frames.

**`packages/plugin-voice` (E2, rebuilt in place).** The id `@winsendotai/ovo-plugin-voice-session-engine` is kept, with kind `engine` and provider `ovo-native`.

| Module                           | Job                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/events.ts`               | The `VoiceEventBus`: synchronous and in order, with the system lane first                                                                                                   |
| `engine/ingress.ts`              | Carrier audio → PCM16 for the VAD. STT frames are written in the carrier format; the host adapter handles the STT format. A pre-STT ring buffer (5 s) and bounded overflow. |
| `engine/turn-controller-host.ts` | Uses `ovo.turn-detector` when present, otherwise `engine/fallback-turns.ts` (≤80 lines). Feeds behavior `subscribe()` events and `speechKind()` into VoiceEvents.           |
| `engine/turn-driver.ts`          | Epochs; `beginTurn`; `respond*`; variables on every turn (#4); the receipt-ordering rule (§2.6)                                                                             |
| `engine/watchdog.ts`             | `max_duration` (#26)                                                                                                                                                        |
| `engine/latency.ts`              | Stage parts that sum to the total                                                                                                                                           |
| `engine/session-engine.ts`       | Wiring only                                                                                                                                                                 |
| `speech/prefetch.ts` (#9)        | `SpeechOutput.prepare?`. Sending N+1 starts once N is fully sent. Each segment keeps its own mark and receipt. An epoch change aborts prefetches.                           |
| `speech/text-filters.ts`         | Runs the ordered `ovo.text-filter` plugins. Exports the plugins `@winsendotai/ovo-text-filter-markdown` and `-url`.                                                         |
| `speech/media-output.ts`         | The §2.5 evidence mapping; clear ordering (pending marks are cancelled before clear)                                                                                        |
| `plugins.ts` (companions)        | The scheduler provides `ovo.speech` + `ovo.speech-scheduler`, and the streaming output provides `ovo.speech-output`                                                         |

`turn-policy.ts` and the F4 engine adapter are deleted.

### 6.2 Tests

- **Regression table** (`plugin-turns/tests/regression.test.ts`), each row using a FakeClock:
  - "Say yes" then "yes";
  - "yes" while the bot speaks;
  - two "yes" turns;
  - split finals;
  - `utterance-end`;
  - barge-in on the 3rd interim;
  - Devanagari;
  - DTMF;
  - idle;
  - **"yes" spoken during the confirmation prompt, released after the prompt's receipt**;
  - "no that's not correct" during the prompt, released as a `no` turn;
  - a random "hello" during the prompt, discarded.
- **Provider parity.** Deepgram, AssemblyAI and Sarvam scripts of the same conversation must produce identical accepted turns.
- **Pipelining.** The gap between segment 1's last byte and segment 2's first byte is ≤ one 20 ms frame.
- **Engine conformance.** `describeEngine` passes for the native engine.

---

## 7. LiveKit Agents engine (unit E3)

`packages/plugin-engine-livekit`:

- id `@winsendotai/ovo-engine-livekit`, kind `engine`, provider `livekit`;
- pinned to exactly `@livekit/agents@1.9.0` and `@livekit/rtc-node@0.13.34`;
- companions `{'ovo.speech': '@winsendotai/ovo-engine-livekit/speech'}`, a late-bound `Speech` port that the engine attaches at start.

**Spike first.** `experiments/voice/src/livekit.ts` runs text-only. It disables audio output, uses no STT and sets `turnDetection: null`, so it proves nothing about the audio path.

- E3 starts with an audio-path spike test: custom `AudioInput`/`AudioOutput`, `OvoStt` with `turnDetection: 'stt'`, and `say()` with `OvoTts`, all against fakes.
- If the spike cannot pass on 1.9.0, E3 stops and reports the evidence rather than faking conformance.

**Design**

- **No room.** `AgentSession` runs with custom input and output. `RoomIO` is built only when a room is passed.
- **The OVO Behavior produces every reply.**
  - `OvoAgent.onUserTurnCompleted` enqueues the turn to the turn driver and throws `StopResponse`. It **never awaits playout inside the hook**, which avoids a deadlock with LiveKit's speech-task scheduling.
  - The turn driver runs on its own promise chain.
  - LiveKit gets no LLM and no tool context. The early return at `agent_activity.ts:3037` applies.
- **Short answers.**
  - LiveKit drops user input when the current speech allows interruptions and the transcript has fewer than `minWords` words.
  - So confirmation-kind segments are spoken with `allowInterruptions: false`.
  - A "yes" at the tail of a prompt is then committed as a user turn and held until the prompt's receipt is delivered (§2.6).
- **Providers go through adapters** (`OvoStt extends stt.STT`, `OvoTts extends tts.TTS`), with `ownsProviders: false`. The host format adapter gives 8 kHz, and `connOptions.sttConnOptions.maxRetry = 0`.
- **Pinned options** (`session-options.ts`):
  - `vad: null` (or an OVO VAD adapter);
  - `turnHandling: {turnDetection: 'stt', interruption: {mode: 'vad', minWords: 2}}`;
  - `aecWarmupDuration: null`, `userAwayTimeout: null`, `ttsTextTransforms: null`;
  - `preemptiveGeneration: {enabled: false}`, `useTtsAlignedTranscript: false`;
  - no string model ids.
- **Guards** (`guards.ts`) refuse to run when:
  - any `LIVEKIT_*` env var is set;
  - `_usingDefaultVad` is truthy;
  - an `Inference*` instance exists;
  - an LLM or tool context exists.
- **Evidence.** `CarrierAudioOutput` follows flush → `media.mark` → `onPlayed` → finished, and clear → interrupted. It never finishes twice, and a mark timeout gives `estimated`.
- **Lazy loading.** The index never imports `@livekit/*` at module top; `apply` runs `await import('./session-runner.js')`.
  - Note that `@livekit/agents` itself imports `sharp` (`src/llm/utils.ts`) and `@livekit/av` (`src/ffmpeg.ts`) at module top.
  - So selecting the engine loads libvips and FFmpeg bindings, and both must be in the image.
- **Image and bundles.**
  - Every Dockerfile stage moves to `node:24.8.0-bookworm-slim`.
  - The app bundles are built by each app's `package.json` esbuild CLI and, for the API, by an inline command in the Dockerfile. E3 owns those build scripts in wave 2.
  - `@livekit/*`, `sharp` and `onnxruntime-node` are marked external in every bundle that can load the engine (worker and API), and must exist in `pnpm deploy`'s node_modules.
  - The API Dockerfile stage uses `pnpm --filter @winsendotai/ovo-api build` instead of its inline esbuild.
- **Real timers.** LiveKit uses real timers internally, so its conformance tests and the matrix rows use real time, with a 60 s timeout per row.

---

## 8. Carriers (units C1, C3, C4)

**What every carrier package contains**

- The modules `plugin.ts`, `control.ts`, `serializer.ts`, `routes.ts`, `signature.ts`, `markup.ts`, `status-map.ts` and `testing.ts`, each ≤250 lines.
- `ctx.net` only, and no vendor SDK.
- It passes `describeCarrier`.
- Doc-faithful jsonl fixtures, each with a header naming the source and marking anything `UNCONFIRMED`.
- The conservative capability value wherever the docs leave something unconfirmed.

| Carrier | Meter                          | CPS | Evidence            | Stream params          | Hangup                                   | Continuation        |
| ------- | ------------------------------ | --- | ------------------- | ---------------------- | ---------------------------------------- | ------------------- |
| Twilio  | `twilio.carrier.audio_seconds` | 1   | `carrier-played`    | at-dial                | rest                                     | markup-after-stream |
| Exotel  | `exotel.carrier.audio_seconds` | 1   | `carrier-processed` | on-answer (media-url)  | close-stream                             | none                |
| Plivo   | `plivo.carrier.audio_seconds`  | 2   | `carrier-played`    | on-answer (answer_url) | rest; cancel before answer by request id | markup-after-stream |

### 8.1 Twilio

- **Wire protocol.** μ-law 8 kHz, with the frames exactly as in the [WS messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages) doc.
- **Clear.** On `clear`, Twilio echoes pending marks (`clearFlushesMarkers: true`).
- **Markup.** `<Connect><Stream url="{mediaUrl}"><Parameter name="sid"/><Parameter name="rt"/></Stream></Connect><Redirect method="POST">{resume url}</Redirect>`.
  - There is no query on `<Stream url>`.
  - Each `<Parameter>` name+value is under 500 characters.
- **Upgrade signature (#1).** HMAC-SHA1 over the **verbatim** `wss://` URL written in the TwiML, with empty params, retried once with a trailing `/`. Port handling is UNCONFIRMED.
- **Golden vectors.**
  - Positive: the wss URL and its trailing-slash variant.
  - Negative: `https://…?edge=`, a changed host, a changed port, reordered params and a tampered body.
  - Also Twilio's **published worked example**, copied verbatim from https://www.twilio.com/docs/usage/security. If that page can't be retrieved from the environment, record that and mark the vector UNCONFIRMED; never invent values.
- **Control.**
  - `dial`: `Calls.json` with `TimeLimit`, `Timeout`, `StatusCallbackEvent` and async AMD.
  - `reconcile`: `live` / `ended{state, answeredBy}` (#26).
  - `hangup`: `Status=completed`. A 404 or error 20404 means `already_ended`.
  - `handoff`: `<Dial>`.
- **Errors.** 4xx → rejected (retryable only on 429). 408, 5xx or a timeout → unknown.

### 8.2 Exotel

Sources: [Voicebot applet](https://developer.exotel.com/docs/agentstream/stream-voicebot-applet), [connect to flow](https://developer.exotel.com/docs/voice-v1/api-reference/connect-to-flow), [auth](https://developer.exotel.com/docs/references/authentication), [status callback](https://developer.exotel.com/api/statuscallback), [support article](https://support.exotel.com/support/solutions/articles/3000108630).

**Messages** (snake_case):

| Direction | Messages                                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound   | `connected`; `start{stream_sid, start:{call_sid, account_sid, from, to, custom_parameters, media_format:{encoding, sample_rate:"8000", bit_rate}}}`; `media{sequence_number, stream_sid, media:{chunk, timestamp, payload}}`; `dtmf{dtmf:{digit, duration}}`; `mark{mark:{name}}`; `stop{stop:{reason:'stopped'\|'callended'}}` |
| Outbound  | `{event:'media', stream_sid, media:{payload}}`, `{event:'mark', stream_sid, mark:{name}}`, `{event:'clear', stream_sid}`                                                                                                                                                                                                        |

- **Audio.** PCM16 LE mono base64, at 8 or 16 kHz.
- **Outbound chunks.** Multiples of 320 B, ≥3,200 B and ≤100 KB, with the remainder carried and padded with silence before a mark.
- **Evidence.** The doc calls `mark` a "notification that a previously sent audio chunk has finished playing". The plan still classifies it conservatively as `carrier-processed` and marks that UNCONFIRMED, so confirmed writes need the acknowledgement.
- **Binding.** The binding requires `streamEndTerminatesCall: true` (§4.10). The flow must be Voicebot → Hangup.
- **Media-url route.** This is the dynamic URL the Voicebot applet calls, for both inbound and outbound calls.
  - If the request carries `CustomField` (our `dialRequestId`), or a `CallSid` that matches a route, it is **outbound**: `host.streamForDial(...)`.
  - Otherwise it is **inbound**: `host.admitInbound(...)`.
  - A connect replies `{"url":"wss://…/carriers/exotel/<b>/media?sid=…&rt=…&t=…"}`, with ≤3 query pairs and ≤256 characters.
- **Upgrade authentication.** Accept **either**:
  - an `Authorization: Basic` header that matches `apiKey:token`, or
  - a valid per-call `t` for purpose `media` in the query, which the media-url route issued.

  An `allowedCidrs` check applies either way.

- **Control.**
  - `dial`: `Calls/connect.json` with `From`, `CallerId`, `Url`, `TimeLimit`, `TimeOut`, `StatusCallback`, `StatusCallbackEvents[]` and `CustomField=requestId`.
  - `hangup` returns `unsupported` (close-stream).
  - `handoff` supports `end` only.
  - AMD requests are rejected as non-retryable.

### 8.3 Plivo

Sources: [Stream XML](https://www.plivo.com/docs/voice/xml/audio-streaming), [streaming guide](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide), [V3 signature](https://www.plivo.com/docs/voice/concepts/signature-validation), [make a call](https://www.plivo.com/docs/voice/api/call/make-a-call), [AMD](https://www.plivo.com/docs/voice/concepts/machine-detection), and [plivo-stream-sdk-java](https://github.com/plivo/plivo-stream-sdk-java) for the message models.

**Messages** (camelCase):

| Direction | Messages                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound   | `start{sequenceNumber, start:{callId, streamId, accountId, tracks, mediaFormat:{encoding, sampleRate}}, extra_headers}`; `media{sequenceNumber, streamId, media:{track, timestamp, chunk, payload}}`; `dtmf{dtmf:{digit, track}}`; `playedStream{name}`; `clearedAudio`; `stop` |
| Outbound  | `{event:'playAudio', media:{contentType, sampleRate, payload}}`, `{event:'checkpoint', streamId, name}`, `{event:'clearAudio', streamId}`                                                                                                                                       |

**`extraHeaders`** allow ≤512 B and only `[A-Za-z0-9]`. So `sid` and `rt` are base32 without padding.

- **Markup.** `<Stream bidirectional="true" keepCallAlive="true" contentType=… extraHeaders=…>wss://…/media</Stream><Redirect>…/resume?r=…&t=…</Redirect>`. Every attribute name is verified against the XML reference.
- **Messages.** `playAudio` (base64 ≤16 KB, i.e. ≤12,000 raw bytes), `checkpoint` → `playedStream` → played, `clearAudio` → `clearedAudio` → cleared.
- **Signatures.** V3: HMAC-SHA256 over URL + nonce (+ the sorted POST params). Comma-separated signatures are allowed, and any one may match.
  - Vectors are **doc-derived**, because the official SDK is not in the store.
  - Which URL Plivo signs on the upgrade is UNCONFIRMED. Try the wss URL, then the https form.
- **Dial.** `POST /v1/Account/{authId}/Call/` with `answer_url = callbacks.answer`, `hangup_url = callbacks.status`, `time_limit` and AMD. The response is `201 {request_uuid}`, which becomes `accepted{carrierRequestId}`.
- **Answer route.** `host.streamForDial({dialRequestId: r, carrierCallId: CallUUID, carrierRequestId: RequestUUID})` → Stream markup, or `<Hangup/>`.
- **Reconcile** uses the queued-call lookup `GET /v1/Account/{authId}/Call/{request_uuid}/?status=queued`, plus `RequestUUID`/`CallUUID` from the answer and hangup callbacks. It tolerates `pending`. The exact endpoint shapes must be verified against the docs and are marked UNCONFIRMED if the page can't be reached.
- **Hangup.** `DELETE …/Call/{uuid}/` (204 → ended, 404 → already_ended). Before answer, `DELETE …/Request/{request_uuid}/` (`cancelBeforeAnswer: true`).

### 8.4 Pacing

A token bucket per `(carrier, binding, from_number)`, refilled at `capabilities.pacing.cps`. A binding can override it with `config.cps`. The campaign driver reads `cps` from `ctx.all('ovo.carrier.control')` in the dispatcher, because carrier catalog entries include the `dispatcher` role.

---

## 9. Speech providers (units S1, S2)

**What every provider package contains**

- A v2 manifest and `ctx.net` only.
- `describeSpeechToText`, `describeTextToSpeech` or `describeInference` conformance.
- `testing.ts` exports `fixtures` **and** `fixtureTemplates` (§2.3).
- Usage emitted exactly once, always with a `requestId`.
- **Native formats only.** The host adapts formats (§2.4).

| Package                      | Id                                                           | Notes                                                                                                                                                                                                                                                                                                              | Meter                                                                                                               |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `plugin-stt-deepgram` (S1)   | `@winsendotai/ovo-provider-deepgram-stt`                     | `is_final` → final (new segment); `speech_final` → end-of-turn; `UtteranceEnd`; `SpeechStarted`; `Finalize`; KeepAlive; `CloseStream` → `Metadata`. **Reconciled usage comes only from `Metadata.duration`**; an abrupt close gives an estimate from bytes (fixes the `Math.max` bug).                             | `deepgram.streaming-stt.audio_seconds`                                                                              |
| `plugin-tts-openai` (S1)     | `@winsendotai/ovo-provider-openai-tts`                       | `outputFormats: [PCM16_24K]`. SSE for gpt-4o-mini-tts, with token usage from `speech.audio.done`; chunked pcm for tts-1*. Cache revision `openai-tts-mulaw-8000-v1` for MULAW_8K.                                                                                                                                  | `…characters` (`when` model ∈ tts-1*) or `…input_tokens` + `…audio_output_tokens` (`when` model ∈ gpt-4o-mini-tts*) |
| `plugin-llm-openai` (S1)     | `@winsendotai/ovo-provider-openai-inference`                 | `@ai-sdk/openai` with `fetch = ctx.net.fetch`, wrapped by `AiSdkInference` (in plugin-kit since F2). The LLM fixture template emits the agent's tool call.                                                                                                                                                         | `openai.inference.*`                                                                                                |
| `plugin-stt-assemblyai` (S2) | `@winsendotai/ovo-stt-assemblyai`                            | v3 `Begin`/`Turn`/`Termination`; model echo check; 50–1000 ms frames (defensive re-aggregation); close codes → typed errors                                                                                                                                                                                        | `assemblyai.streaming-stt.session_seconds`                                                                          |
| `plugin-speech-sarvam` (S2)  | `@winsendotai/ovo-stt-sarvam`, `@winsendotai/ovo-tts-sarvam` | **STT:** VAD endpointing; `forceEndpoint: false` (`flush` is documented only for `endpointing=manual`); `session.begin` has no documented session id, so the requestId is synthesized. **TTS:** native μ-law 8 kHz, incremental `open()`, character meter. The language field name is settled from the pinned doc. | `sarvam.streaming-stt.audio_seconds`, `sarvam.streaming-tts.characters`                                             |

Shared transport comes from `@winsendotai/ovo-plugin-kit`.

---

## 10. Deployment, Fargate native autoscaling, liveness (units O1, O2)

### 10.1 AAS is the only writer of desired count (O1)

**Capacity signal.** `plugin-orchestration/src/capacity-signal.ts` is a pure function of ≤150 lines, run every 10 s:

```
busy     = active + reserved (fresh worker_slots rows only)
jobs     = min(eligibleDueJobs, admissionHorizon)
campaign = Σ running/due campaigns: min(max_concurrency, dueQueuedContacts) − alreadyAdmitted
prewarm  = Σ campaigns with schedule_at ∈ (now, now + OVO_PREWARM_LEAD_SECONDS(600)]: min(max_concurrency, contacts)
floor    = inboundEnabled ? inboundWarmFloor : 0
hardMax  = min(configuredMax, carrierConcurrency, providerConcurrency, spendPermitted + busy)
required = clamp(busy + jobs + campaign + prewarm + floor, busy, hardMax)
```

- **Publishing** goes through `capacity.signal`: `cloudwatch` on Fargate (namespace `OVO/Capacity`, `StorageResolution=1`), or `log` on Compose, which also serves `/health` and the console.
- **Stale or inconsistent input publishes nothing.** There is no leader: every replica publishes the same value, and the scaling policies use `Maximum`.

**Terraform** (`infra/terraform/autoscaling.tf`, new):

| Resource                                                        | Settings                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws_appautoscaling_target.worker`                              | `min = enable_inbound_calls ? inbound_warm_floor : 0`, `max = worker_max_capacity`, dimension `ecs:service:DesiredCount`                                                                                                                                                |
| Target tracking (**the only scale-in path**)                    | metric math `IF(prov>0, req/prov, req)`, target 1.0, scale-out cooldown 60 s, scale-in cooldown `var` (default 300 s)                                                                                                                                                   |
| Step scaling (scale-out and scale-from-zero, no scale-in steps) | 10 s high-resolution alarm on `req − prov > 0`, 2 of 2 datapoints; steps (0,2]→+2, (2,5]→+5, (5,10]→+10, >10→+20; cooldown 30 s                                                                                                                                         |
| `aws_appautoscaling_scheduled_action`                           | one per `var.worker_schedules` entry (raise/restore pairs)                                                                                                                                                                                                              |
| `alarms.tf`                                                     | DLQ > 0; oldest eligible job > `var.job_age_slo_seconds`; stale signal (`RequiredSlots` SampleCount < 1, missing data breaching); ceiling hit; target health (api, console, gateway); protection-renewal log metric filter; queue age. All go to `var.alarm_topic_arn`. |

**The #7 fixes:**

- **Security groups:** ALB → application egress on 3000–4001, and application → application egress on 4000 (console → API).
- **Listener rules:** the path pattern adds `/carriers/*` and keeps `/twilio/*`.
- **API task environment:**
  - secrets `OVO_SESSION_SECRET`, `OVO_SEED_ADMIN_EMAIL` and `OVO_SEED_ADMIN_PASSWORD` from `runtime_secret_arn`;
  - `OVO_TRUSTED_PROXY_CIDRS = join(",", var.alb_subnet_cidrs)`;
  - `OVO_MEDIA_PUBLIC_BASE_URL` and `OVO_INBOUND_ROUTE_SECRET`, which the carrier URLs need.
- **Dispatcher:** identity from the ECS metadata `TaskARN`; the fixed id is removed; desired count 2 with a 100/200 rollout.
- **Gateway:** desired count 2; the `== 1` validation is removed; `deregistration_delay = min(3600, var.max_call_seconds)`.
- **Worker:** keeps 100/200, the circuit breaker and `ignore_changes [desired_count]`, because AAS owns it.
- **IAM:**
  - `ecs:UpdateService` is removed.
  - The dispatcher keeps `DescribeServices` and `PutMetricData` (with a namespace condition) and adds `sqs:ReceiveMessage`, `DeleteMessage` and `GetQueueAttributes` on the DLQ.
  - The worker adds `ecs:GetTaskProtection`.
- **State:** `backend "s3" {}` plus `backend.hcl.example` with `use_lockfile = true`, which needs Terraform ≥ 1.10. The README documents `dynamodb_table` for older versions.
- **tfvars:** the example adds `recordings_bucket`, `alb_subnet_cidrs`, `worker_schedules`, `alarm_topic_arn` and `job_age_slo_seconds`.
- **Queue:** `maxReceiveCount` is 10.
- **Carrier secrets:** per-carrier secrets (`OVO_CARRIER_ENV_BINDINGS`) replace `TWILIO_*`.

**Deleted:**

- `CapacityController` and the leases, capacity writes, `EcsDesiredCountWriter`, `ecsCapacityWriterPlugin` and `compactCapacityWriterPlugin`;
- `OVO_CAPACITY_AUTHORITY` and `OVO_DESIRED_WRITER`;
- IAM `ecs:UpdateService`;
- the `unresolvedCapacityWrites` readiness check, which becomes "capacity signal age" (#17).

**Worker changes:**

- Idle protection is held only for floor tokens.
- Protection expires after 60 min and renews every 2 min. A renewal failure is fatal only when less than 5 min of protection remains.
- Ownership loss → `terminateCarrierLeg`, which is unchanged and keeps its regression test.
- The worker re-checks `draining` immediately before dial.
- Deferrals release the job and **delete** the queue message.

**Compose:**

- fixed `worker-1` and `worker-2`;
- `OVO_CAPACITY_SIGNAL=log`;
- `OVO_CARRIER_ENV_BINDINGS` built from `.env`;
- `OVO_FIXTURE_TEST_CALLS=true` set **explicitly**, because every image sets `NODE_ENV=production`;
- `maxReceiveCount` 10.

### 10.2 Queue liveness (#15)

Postgres is the source of truth; SQS messages are only wake-up hints.

1. **Enqueue.** `enqueue` writes the outbox row only when `not_before <= now()`.
2. **Hint sweeper**, a dispatcher `BackgroundTask` that runs every 5 s with SKIP LOCKED and `LIMIT 100`.
   - It selects eligible jobs (queued with `not_before <= now()`, or live with an expired or NULL lease) where `hinted_at` is NULL or more than 150 s old.
   - It sets `hinted_at`, increments `hint_count` and writes `job.eligible` outbox rows.
   - **Poison cap:** a job that reaches `hint_count > 20` without moving past `owned` is failed terminally with `last_error = 'hint_exhausted'` and an alarmable log line.
3. **Deferrals delete the message and reset `hinted_at = NULL`.** They never call `changeVisibility`.
4. **DLQ reconciler.** Malformed messages are logged, counted and deleted. Valid ones set `hinted_at = NULL` and are deleted, so the sweeper takes over. It never blind-redrives, and the poison cap ends loops.
5. **A lost admission lease** makes the job terminal as `superseded` (O1). The campaign driver re-queues expired admissions (O2).
6. **Campaign views.** An `unknown` attempt means "reconciling" and is non-terminal (O2 API, U1 view).

### 10.3 Campaign driver (#5, O2)

**Where it lives.** `plugin-operations/src/campaign-driver.ts`, a dispatcher `BackgroundTask` exported from the `background-tasks` subpath that F3 pre-registered.

**Loop, every 1 s:**

1. Take `pg_try_advisory_xact_lock(hashtext('ovo-campaign-driver:'||org))`.
2. For each running or due campaign, compute `headroom = min(max_concurrency − (admitted + dialing), readyIdleSlots − eligibleQueuedJobs, pacingTokens)`.
3. Admit contacts in CSV order, up to `headroom`.

- At scale-from-zero, nothing is admitted; `campaign demand` drives the scale-out instead.
- The pacing CPS comes from `ctx.all('ovo.carrier.control')`.
- `POST /v1/calls` keeps its direct admit.

### 10.4 Durable reservation expiry (#16, O2)

1. **Reserve.** Sets holder `workerId:jobId` and `expires_at = now + maxCallSeconds + 300 s`.
2. **Heartbeat.** The worker's cost runtime extends every 60 s. Only the holder may extend.
3. **Sweeper**, a dispatcher `BackgroundTask` that runs every 30 s with SKIP LOCKED:
   - job lease live → extend;
   - session route terminal → settle at the priced usage;
   - otherwise → release.

   Each outcome records a `reservation.expired` ledger event.

Fixture test calls never reserve and never touch budgets.

---

## 11. Console (unit U1)

**No SaaS runtime dependencies.** Next 16 and React 19 stay. The test dependencies are dev-only, and F2 tries to install them in wave 1.

### 11.1 Foundations

- **`app/styles/tokens.css`:**
  - a 4 px spacing scale;
  - type from 12 px to 28 px, with **nothing below 12 px**;
  - semantic colours, e.g. `--color-text-muted #5b665f`;
  - `--focus-ring`, and `--focus-ring-inverse #a7f3c4` in `.sidebar`;
  - radii, shadows and z-index;
  - `--duration-fast`, which is 0 under reduced motion.
- **Layout primitives we own** (`components/ui/*`): `Stack`, `Cluster`, `Grid`, `Panel`, `PageHeader`, `Toolbar`, `DataTable`, `Pagination`, `EmptyState`, `Callout` (≤25 uses), `FormField`, `StatusBadge`, `Dialog`/`ConfirmDialog`, `Drawer`, `Button`, `Tabs`, `Time`, `Stat` and `Skeleton`.
- **Forms** (`components/forms/*`): `use-form-action`, `use-row-keys`, `json-editor`, `list-text-input` and `json-import-box`.
- **Data** (`lib/data/*`, about 350 lines in-house): the cache, `use-resource`, `use-cursor-list`, `use-mutation` and `use-event-stream`. The event stream uses the named heartbeat and goes stale after twice its interval.

### 11.2 Routes (App Router)

```
app/login/page.tsx
app/(console)/layout.tsx            server session gate; cached extensions
app/(console)/agents/page.tsx | new/page.tsx | [id]/{layout,page}.tsx + plugins/ test/ releases/
app/(console)/calls/page.tsx | calls/[id]/page.tsx
app/(console)/campaigns/{page,new/page,[id]/page}.tsx
app/(console)/operations/{suppressions,handoffs,inbound}/page.tsx
app/(console)/{evaluations,costs,performance,infrastructure,team,account}/page.tsx
app/(console)/settings/{providers,tools}/page.tsx
```

### 11.3 Plugin-manifest-driven pickers

- **`slot-picker`.** Radio cards per slot. An incompatible card stays visible but disabled, with its reason from a live `POST /v1/plugins/compat` attached via `aria-describedby`. The LLM slot is hidden for announcement and faq.
- **`binding-select`.** Bindings filtered by `pluginId`, with a Drawer to create one.
  - For carrier bindings, it shows **the operator URLs** from `GET /v1/provider-bindings/:id/carrier-urls`, with copy buttons.
- **`schema-form`.** Renders from `ui.fields`. Secret fields are write-only.
  - An Exotel binding shows the required `streamEndTerminatesCall` attestation as a checkbox with help text.
- **`compat-summary`.** Groups issues by slot. The weak-evidence acknowledgement checkbox appears only when that issue is present.
- **Inbound routes** (`/operations/inbound`) let an operator pick the carrier plugin and binding per number.
- **The price-card editor's meter-key picker** lists the meters from `GET /v1/plugins`. Operators can then price `exotel.*`, `plivo.*`, `assemblyai.*` and `sarvam.*` meters. Unpriced usage is shown as "unpriced", never as zero.

### 11.4 Demo path

1. The wizard: create an agent.
2. Pick the plugins.
3. Run a fixture test call with a live transcript.
4. Inspect `/calls/:id`: the recording, the transcript, the latency waterfall, and cost (estimated, reconciled or unpriced).

`/calls` has URL filters (agent, engine, carrier, kind, status) backed by D1's route and F3's storage filters.

### 11.5 #8 fixes

| Defect                                                                                                                          | Fix                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `event.currentTarget.reset()` after an await (`suppressions-view.tsx:53`, `budget-panel.tsx:60`, `campaign-create-form.tsx:80`) | `useFormAction` captures `currentTarget` before the await                                             |
| Row keys built from the edited value (`script-editor.tsx:173`, `tools-editor.tsx:57`, `faq-editor.tsx:126`)                     | `useRowKeys`                                                                                          |
| JSON input resync wipes the typed text                                                                                          | `JsonEditor` resyncs only when the canonical value changed and the field is neither dirty nor focused |
| `/calls` and `/agents` stop at 50                                                                                               | `useCursorList` + `Pagination`, newest first                                                          |
| `Field` uses `data-describedby` (`primitives.tsx:75`)                                                                           | `FormField` puts `aria-describedby` on the real control                                               |
| Sidebar focus ring at about 2:1 contrast                                                                                        | `--focus-ring-inverse` at about 12:1                                                                  |

Also fixed:

- the alias and matches inputs dropping newlines and commas;
- Integrations `reload()` unmounting the forms;
- operation ids regenerated on every retry;
- the 6 `window.confirm` calls, now `ConfirmDialog`;
- the stale `unavailable-view.tsx` and `packages/ui` evidence panels;
- the global `table {min-width: 640px}`.

### 11.6 Tests

- **Preferred:** Testing Library under jsdom, plus Playwright with axe at 390, 768 and 1280 px.
- **Offline fallback:** pure `.test.ts` tests, `renderToStaticMarkup` ARIA tests, and Playwright specs that are written but not run, with PARTIAL reported.

---

## 12. Fixture test calls and the demo backend (unit D1)

**`packages/fixture-calls`** is a host library, not a plugin.

`runFixtureCall({release | draft, registry, fixtures, fixtureTemplates, callerScript, clock?, recording?, telemetry})`:

1. **Compat.** Runs normalize and compat at stage `test`. Refuses to run on errors. `meter_uncovered` is only a warning here.
2. **Graph.** `selectSessionGraph(..., {fixtures: true})` with the **selected real engine and providers**. Every `ctx.net` is a `FixtureNet`.
   - For each selected stt, tts or llm plugin, the host renders its `fixtureTemplates[pluginId]` from the caller script.
   - Only if a template is missing does it fall back to the plugin's static `fixtures`, and then to the conformance fixture-kind plugins, recorded as `sttMode: 'fixture-generic'`.
3. **Media.** The far end is the conformance fake carrier driver (from `@winsendotai/ovo-conformance/drivers`, which never imports vitest), using the selected carrier's **real** `MediaSerializer` and a playback clock that follows that carrier's capabilities.
4. **Recording.** Only if `config.recording` is true.
5. **Telemetry and cost.** Everything goes through the normal pipeline. Usage is marked `estimated`, and uncovered meters are `unpriced`. Budgets and reservations are never touched.
6. **The call row** uses kind `test`. Nothing ever dials or calls carrier REST.

**Isolation.** In the API server, fixture calls run in a **child process**: `fork(process.argv[1], ['--ovo-fixture-call-child'])` with IPC events, at most 2 concurrent, with a 120 s wall timeout.

- LiveKit and `sharp` native code therefore never run inside the control-plane process.
- Unit tests run in process.
- `apps/api/src/index.ts` branches on the flag.

**Enablement.** `OVO_FIXTURE_TEST_CALLS=true` enables fixture calls. The default is true only when `NODE_ENV !== 'production'`; Compose sets it explicitly.

**API** (D1):

| Endpoint                         | Behaviour                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST /v1/agents/:id/test-calls` | `{useDraft?, releaseId?, callerScript?}` → 202 `{callId}`. Idempotency-Key header supported.                    |
| `GET /v1/calls/:id/stream`       | SSE transcript, turn, timing, speech and end events, plus a named `heartbeat` every 15 s; `?cursor=` replay     |
| `GET /v1/calls/:id/evidence`     | `{call, selections (with the resolved versions), transcript[], latency[], cost, recording?, events[], sttMode}` |
| `GET /v1/calls` filters          | `agentId, engine, carrier, kind, status`                                                                        |

**Observability** (D1): `latency-breakdown.ts`; the outcome projection via `outcomeFor` (#20); the transcript projection; `canonicalJson` in `telemetry-validation.ts` (#19); and no `plugin-voice` import.

---

## 13. Code hygiene gates (unit F2; `pnpm lint` = `node scripts/lint.mjs`)

Each gate is a script plus a test in `scripts/tests/*.test.ts` that runs it against `scripts/tests/fixtures/<gate>/`, which contains a known violation.

**Every gate:**

- skips any path segment named `fixtures`, `__fixtures__`, `node_modules`, `dist`, `.next`, `upstream` or `vendor` when it scans the repository. Gate tests pass their fixture folder as an explicit root instead.
- accepts `--only <path-prefix>...` to report only files under those prefixes. This is used for wave-2 scoped verification.
- reads `scripts/baselines/<gate>.json` plus every `scripts/baselines/pending/*.json`.

1. **`check-module-size.mjs`.** Source ≤300 canonical nonblank lines, tests ≤500, and 24 KiB. The baseline holds today's 301–400-line files at their counts, which may not grow. 400 stays the hard limit for everything, pending entries included.
2. **`check-duplication.mjs`.** A TypeScript scanner drops comments and whitespace and collapses string literals, then hashes 60-token windows across `apps/*/src`, `apps/console/{app,components,features,lib}` and `packages/*/src`. It fails on cross-file repeats that are not in a baseline. With `--only`, it reports windows that have at least one occurrence under the prefixes.
3. **`check-architecture.mjs`.** Keeps every current check, including PM acceptance 75 and private keys. Package kinds come from **`scripts/package-kinds.json`**, an explicit map, not directory globs, so `plugin-speech-cache` is not treated as a vendor plugin.

| Kind            | Packages                                                                                                                                        | May import                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts`     | contracts                                                                                                                                       | `zod`                                                                                                                                                                                     |
| `runtime`       | runtime                                                                                                                                         | cordis, contracts, ajv                                                                                                                                                                    |
| `sdk`           | sdk                                                                                                                                             | runtime, contracts, zod                                                                                                                                                                   |
| `kit`           | plugin-kit, audio                                                                                                                               | contracts, third-party                                                                                                                                                                    |
| `test-kit`      | conformance                                                                                                                                     | contracts, runtime, sdk, kits, behaviors, vitest (not from `./drivers`)                                                                                                                   |
| `host`          | session-host, fixture-calls                                                                                                                     | contracts, runtime, sdk, kits, `conformance/drivers` (fixture-calls only); session-host also behaviors, plugin-tools, plugin-tools-http, plugin-tools-mcp, plugin-voice, plugin-inference |
| `distribution`  | distribution                                                                                                                                    | anything except apps                                                                                                                                                                      |
| `vendor-plugin` | plugin-carrier-_, plugin-stt-_, plugin-tts-_, plugin-llm-_, plugin-speech-sarvam, plugin-engine-livekit, plugin-turns, plugin-vad, plugin-voice | contracts, runtime, sdk, kits, third-party. No `node:net`, `node:tls`, `node:http`, `node:https`, `node:dgram` or `ws`.                                                                   |
| `plugin`        | every other plugin-*, behaviors                                                                                                                 | contracts, runtime, sdk, kits, `node:*`, third-party. Never another plugin or behaviors.                                                                                                  |
| `legacy`        | plugin-providers, plugin-telephony-twilio, plugin-session                                                                                       | transitional; deleted by I1                                                                                                                                                               |
| `app`           | apps/* except console                                                                                                                           | anything except vendor-plugin and legacy kinds                                                                                                                                            |
| `console`       | apps/console                                                                                                                                    | no plugin-*                                                                                                                                                                               |
| `experiment`    | experiments/*                                                                                                                                   | unrestricted; nothing may import it                                                                                                                                                       |

4. **`check-provider-names.mjs`.** Bans `deepgram|assemblyai|sarvam|openai|twilio|exotel|plivo|livekit` in non-test code under `apps/*/src`, `packages/{runtime,contracts,session-host,plugin-media,plugin-operations,plugin-orchestration,plugin-ledger,plugin-observability,plugin-voice}/src` and the console. The baseline holds per-file counts. Migrations, `legacyPaths` and docs are allowlisted.
5. **`check-capability-keys.mjs`.** A ratchet on capability string literals outside `contracts/src/capabilities/keys.ts`.
6. **`check-conformance.mjs`.**
   - Every `vendor-plugin` package must have `tests/conformance.test.ts`, which imports `@winsendotai/ovo-conformance` and calls a `describe*` kit.
   - A package whose `package.json` has `"ovo": {"skeleton": true}` is exempt, but **I1 fails the build if any skeleton flag remains**.
   - `plugin-voice` starts in the baseline.
7. **`check-terraform.mjs`.** Runs the binary, or else the Docker image. Otherwise it prints `SKIPPED` and exits 0. It runs as `pnpm check:terraform` and is not part of lint.
8. **The runtime violation ratchet** (§3.7).
9. **Pending baselines.** `scripts/baselines/pending/<UNIT>.json` holds `{architecture, duplication, moduleSize, providerNames, capabilityKeys, conformance, runtimeViolations}`.
   - Each entry carries `reason` and `removeBy: "I1"`.
   - Only the named unit writes its own file.
   - I1 deletes the directory.
10. **`scripts/typecheck-scope.mjs <prefix>...`.** Runs the root `tsc --noEmit` and fails only on diagnostics in files under the prefixes. It prints out-of-scope diagnostics as warnings.

**`vitest.config.ts`:**

- adds the `infra/**/*.test.ts` and `scripts/**/*.test.ts` globs;
- adds the violation sink and global setup;
- adds a `console-dom` jsdom project only if `jsdom` resolves.

---

## 14. Defect → owner map

| #   | Defect                                          | Fix                                                                                                   | Unit(s)                    |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Outbound stream URL uses `https:`               | `mediaUrl` always returns wss; `dial` rejects non-wss; upgrade signature over the verbatim wss URL    | F3, F4, C1, C2             |
| 2   | Pre-accept buffer of 25 frames                  | Budgeted by duration and bytes (3 s); early accept                                                    | C2                         |
| 3   | Turn policy                                     | Controller, aggregator, min-words, mute semantics, every-interim barge-in                             | E1, E2                     |
| 4   | Variables only on the first turn                | Variables merged into every turn                                                                      | E2, E3                     |
| 5   | No campaign driver                              | `campaign-driver` BackgroundTask                                                                      | O2 (O1 runs the tasks)     |
| 6   | MCP delete blocked by the FK                    | Diff upsert with `removed_at`; compat `mcp_tool_removed`                                              | M1, F3 (compat rule)       |
| 7   | Terraform egress, env, identity, backend        | §10.1                                                                                                 | O1                         |
| 8   | Console bugs                                    | §11.5                                                                                                 | U1                         |
| 9   | No TTS pipelining                               | `prepare()` prefetch; Sarvam incremental `open()`                                                     | E2, S2                     |
| 10  | Raw JSON prompt; exact words only               | `args-speaker`; `classifyConfirmation` (NO wins, whole utterance); heard needs non-estimated evidence | F1 (lexicon), M1           |
| 11  | Script punctuation; FAQ confirmation in scripts | Normalized transitions; ScriptBehavior forwards hooks                                                 | M1                         |
| 12  | Policy errors become `unknown`                  | `ConnectorPolicyError` → `failed`                                                                     | F2 (class), M1             |
| 13  | Rotation AAD outside the lock                   | Computed inside `FOR UPDATE`                                                                          | M1                         |
| 14  | Session secret not required in production       | Refuse to start without ≥32 bytes                                                                     | M1                         |
| 15  | DLQ liveness, lease loss, `unknown` terminal    | Sweeper with poison cap, DLQ reconciler, `superseded`, reconciling view                               | O1, O2, U1                 |
| 16  | Reservations leak                               | Holder, expiry, heartbeat, sweeper                                                                    | O2                         |
| 17  | Capacity controller freezes                     | AAS only                                                                                              | O1                         |
| 18  | Devanagari marks stripped                       | `normalizeForMatch`                                                                                   | F1, M1, E1                 |
| 19  | `localeCompare`                                 | `canonicalJson` and code-unit sorts                                                                   | F1, M1, M2, O2, D1         |
| 20  | Outcome via `includes('completed')`             | `outcomeFor`                                                                                          | F1, F4, D1                 |
| 21  | Hardwired providers and carrier                 | Selection seam, packages, router, provider-name gate                                                  | F3, F4, S1, S2, C1–C4, I1  |
| 22  | Runtime enforces little                         | Facade, cardinality, scope, guard, typed keys, v2                                                     | F1                         |
| 23  | Single gateway, no reconnect                    | Gateway dials the worker; stateless replicas; continuation                                            | C2, O1                     |
| 24  | SSRF gaps                                       | `plugin-kit/ssrf.ts`                                                                                  | F2, M1                     |
| 25  | MCP re-discovery on every invoke                | Pooled client and discovery cache                                                                     | M1                         |
| 26  | Reconcile, AMD, max duration                    | Live/ended reconcile, AMD, TimeLimit, watchdog, settlement                                            | F4, C1, C3, C4, E2, E3, C2 |
| 27  | Box filter; fragmented frames rejected          | Polyphase resampler plus host adapters; `ws`                                                          | F2, F3, S1, C2             |

---

## 15. Waves, ownership and coordination

### 15.1 Waves

| Wave | Units                                                      | Mode                                                 |
| ---- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 1    | F1 → F2 → F3 → F4                                          | sequential; each ends fully green                    |
| 2    | E1, E2, E3, C1, C2, C3, C4, S1, S2, O1, O2, U1, D1, M1, M2 | parallel; disjoint `ownedPaths`; scoped verification |
| 3    | I1                                                         | integration; may edit any file for integration fixes |

**Critical path:** F1 → F2 → F3 → F4 → (C2, E2, D1 in parallel) → I1.

### 15.2 Frozen in wave 2

The following are read-only for every wave-2 unit:

- `packages/contracts`, `runtime`, `sdk`, `plugin-kit`, `audio`, `conformance` and `session-host`;
- `packages/distribution`, except `profiles/gateway.ts` (C2) and `profiles/worker.ts` and `profiles/dispatcher.ts` (O1);
- `scripts/*.mjs`, `scripts/package-kinds.json`, the top-level `scripts/baselines/*.json`, `vitest.config.ts`, `tsconfig.json`, the root `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`;
- every `package.json` not listed in the unit's own paths;
- `scripts/postgres-restore-fence.sql` and `PM/**`.

**Contract gaps.** If a frozen contract is insufficient, the unit does **not** edit it. It adds a local structural type or adapter inside its own paths, lists the gap under "Contract gaps" in its final report, and I1 resolves it.

### 15.3 Pre-registration (F3) so that wave 2 never edits shared files

- **Skeleton packages.** F3 creates skeleton packages for `plugin-turns`, `plugin-vad`, `plugin-engine-livekit`, `plugin-carrier-twilio`, `plugin-carrier-exotel`, `plugin-carrier-plivo`, `plugin-stt-deepgram`, `plugin-tts-openai`, `plugin-llm-openai`, `plugin-stt-assemblyai`, `plugin-speech-sarvam` and `fixture-calls`. Each has:
  - `package.json` with the name, `private`, `"type": "module"`, version `0.1.0`, the exports `.` and `./testing`, and `"ovo": {"skeleton": true}`;
  - the workspace dependencies contracts, runtime, sdk, plugin-kit and audio;
  - `conformance` as a dev dependency;
  - pinned third-party dependencies (`@livekit/agents@1.9.0` and `@livekit/rtc-node@0.13.34` for the engine; `@ai-sdk/openai@4.0.71` and `ai@7.0.107` for the LLM);
  - `src/index.ts` exporting `plugins = []`, `fixtures = {}` and `fixtureTemplates = {}`;
  - `src/testing.ts` with the same exports.
- **Subpath stubs.** F3 adds `plugins = []` stubs for these subpaths, each with its `package.json` export:
  - `plugin-operations/background-tasks`;
  - `plugin-ledger/background-tasks`;
  - `plugin-orchestration/background-tasks`;
  - `plugin-orchestration/capacity-signals`.
- **Catalog.** Every package and subpath gets a catalog entry and a `distribution/package.json` dependency.
  - Carriers have the roles `['api','worker','gateway','dispatcher']`.
  - Engines, speech providers, turn detectors and VAD have `['session']`.
  - Background tasks and capacity signals have `['dispatcher']`.
- **Dependencies declared up front:**
  - `ws@8.21.3` in `plugin-media` and `apps/worker`;
  - `fixture-calls` in `apps/api`;
  - `distribution`, `session-host` and `plugin-kit` in `apps/media-gateway`.
- **Install.** `pnpm install --offline` runs once, in F3. F4 runs it again if it changed an app manifest.
- **Package kinds.** `scripts/package-kinds.json` (F2) already lists every planned package.

### 15.4 Verification protocol

| Unit type            | Done means                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Wave 1               | Full `pnpm install --offline`, `pnpm lint`, `pnpm typecheck` and `pnpm test`                           |
| Wave 2               | Scoped checks only; **no `pnpm install`** (see below)                                                  |
| W2 gate              | After the last wave-2 unit, the orchestrator (or I1, as step 0) runs the full lint, typecheck and test |
| Worktrees (optional) | Available if the user authorizes commits (open question 8)                                             |

**Wave-2 scoped checks:**

```sh
node scripts/lint.mjs --only <owned prefixes>
node scripts/typecheck-scope.mjs <owned prefixes>
pnpm exec vitest run <owned test paths> --reporter=dot
```

- A unit is done when all three pass for its scope.
- It must not knowingly break files outside its scope.
- If an out-of-scope diagnostic comes from the unit's own change, for example to a type another package uses, the unit reverts or adapts that change.

**W2 gate.** Failures in owned paths go back to the owning unit. Cross-unit failures go to I1.

**Worktrees.** Each wave-2 unit runs in a detached worktree created from the wave-1 commit, and I1 applies the unit patches in wave order, re-verifying after each. Without authorization, the single-tree protocol above applies.

### 15.5 Wave-2 ownership (disjoint)

| Unit | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | `packages/plugin-turns/**`, `packages/plugin-vad/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| E2   | `packages/plugin-voice/**`, `packages/plugin-speech-cache/**`, `experiments/voice/**` (compile fixes only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| E3   | `packages/plugin-engine-livekit/**`, `infra/container/Dockerfile`, `scripts/build.mjs`, `apps/{api,worker,media-gateway,dispatcher}/package.json` (build scripts only; dependencies frozen)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C1   | `packages/plugin-carrier-twilio/**`, `packages/plugin-telephony-twilio/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| C2   | `packages/plugin-media/**`, `apps/media-gateway/**` (not package.json), `apps/worker/src/{media-runtime,session-handshake,worker-media-bootstrap,worker-media-server}.ts`, `apps/worker/tests/{media-runtime,lifecycle.integration}.test.ts`, `packages/plugin-recordings/src/{capture,wav}.ts` (+ new `capture-*.ts`), `packages/plugin-recordings/tests/{production-recordings,recordings}.test.ts`, `packages/plugin-recordings/tests/production-fixtures.ts`, `packages/distribution/src/profiles/gateway.ts`                                                                                                                                                                                                                                                                                                                                                                                   |
| C3   | `packages/plugin-carrier-exotel/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C4   | `packages/plugin-carrier-plivo/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| S1   | `packages/plugin-providers/**`, `packages/plugin-inference/**`, `packages/plugin-stt-deepgram/**`, `packages/plugin-tts-openai/**`, `packages/plugin-llm-openai/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| S2   | `packages/plugin-stt-assemblyai/**`, `packages/plugin-speech-sarvam/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| O1   | `infra/terraform/**`, `infra/compose/**`, `packages/plugin-orchestration/**`, `apps/dispatcher/**` (not package.json), `apps/worker/src/{main,worker-process,worker-loop,runner,inbound-runtime,renewal,claim-delivery,campaign-dial,dial-request,dial-settlement,reconciliation,worker-cleanup,worker-environment,runtime-plugins,worker-health,worker-reporter,worker-options,worker-plugin,worker-types,infrastructure-metrics,index}.ts`, `apps/worker/tests/{worker,inbound-runtime,infrastructure-metrics,campaign-dial}.test.ts`, `apps/api/src/{infrastructure-service,infrastructure-types,infrastructure-worker-samples,infrastructure-plugin,infrastructure-runtime}.ts`, `apps/api/src/routes/infrastructure.ts`, `apps/api/tests/infrastructure.test.ts`, `packages/plugin-storage/tests/infrastructure-postgres.test.ts`, `packages/distribution/src/profiles/{worker,dispatcher}.ts` |
| O2   | `packages/plugin-operations/**` (not `src/twilio-handoff.ts`), `packages/plugin-ledger/**`, `apps/worker/src/cost-*.ts`, `apps/worker/tests/cost-*.test.ts`, `apps/api/src/routes/{operations,operations-realtime,operations-inbound-routes,cost}.ts`, `apps/api/src/{operations-plugin,operations-runtime}.ts`, `apps/api/tests/{cost,operations-runtime}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| U1   | `apps/console/**`, `packages/ui/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D1   | `packages/fixture-calls/**`, `packages/plugin-observability/**`, `apps/api/src/{index,test-call-runtime,recording-runtime}.ts`, `apps/api/src/routes/{test-calls,performance,inspection,simulation}.ts`, `apps/api/tests/{test-calls,performance-route,script-simulation}.test.ts`, `apps/worker/src/{production-session-factory,production-session-support,speech-cache-runtime,cached-media-player,call-recorder,recording-runtime,recording-evidence,session-recording,session-lifecycle,live-input-policy}.ts`, `apps/worker/src/session-graph-*.ts`, `apps/worker/src/telemetry-*.ts`, `apps/worker/tests/{telemetry-runtime,telemetry-stages,production-session-lifecycle,production-engine-selection,native-extension-pins,session-recording,speech-cache-runtime}.test.ts`                                                                                                                  |
| M1   | `packages/behaviors/**`, `packages/plugin-tools/**`, `packages/plugin-tools-http/**`, `packages/plugin-tools-mcp/**`, `packages/plugin-secrets/**`, `apps/api/src/auth-env.ts`, `apps/api/src/routes/mcp.ts`, `apps/api/tests/{operator-auth,mcp-routes}.test.ts`, `packages/plugin-storage/src/{postgres,sqlite}/mcp-*.ts`, `packages/plugin-storage/src/postgres/migrations/005-mcp-tool-removed.ts`, `packages/plugin-storage/src/{postgres,sqlite}/migrations.ts`, `packages/plugin-storage/tests/{storage,postgres}.test.ts`, `packages/plugin-recordings/src/memory-repository.ts`, `packages/plugin-recordings/tests/memory-ordering.test.ts`                                                                                                                                                                                                                                                |
| M2   | `packages/plugin-evaluations/**`, `apps/api/src/{evaluation-plugin,evaluation-runtime,provider-evaluation-runtime}.ts`, `apps/api/src/routes/{evaluation-datasets,evaluation-provider-authorizations}.ts`, `apps/api/tests/{evaluation-runtime,evaluation-provider-authorizations,provider-evaluation-runtime}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

- **The one shared touchpoint in wave 2** is `apps/worker/tests/lifecycle.integration.test.ts`. C2 owns it. O1 may make compile-only edits there, in separate hunks, for signatures O1 changed.
- **Everything else in `apps/api` and `apps/worker` is frozen in wave 2**, because F4 finished it.

**Plugin→plugin edges and their removers:**

| Edge                                                 | Removed by                                                |
| ---------------------------------------------------- | --------------------------------------------------------- |
| media → telephony-twilio                             | C2                                                        |
| observability → voice                                | D1                                                        |
| ledger → observability                               | O2, via the contracts pricing module                      |
| secrets → storage                                    | M1, with a local structural interface                     |
| speech-cache → cache, voice                          | E2, via contracts types and a local `ByteCache` interface |
| tools-http → tools, tools-mcp → tools and tools-http | M1, via plugin-kit                                        |
| evaluations → ledger, tools, behaviors               | M2, by injection from apps/api                            |
| the façades (providers, telephony-twilio, session)   | I1, by deleting the packages                              |

---

## 16. Risks and unconfirmed items

**Risks**

1. **Wave-1 length.** Four sequential units put F3 and F4 on the critical path.
   - _Mitigation:_ the seams are pre-built so that wave 2 is truly parallel.
2. **Parallel units in one working tree.**
   - _Mitigation:_ disjoint ownership, frozen shared files, per-unit pending baselines, no installs in wave 2, scoped checks and the W2 gate. Worktrees can be used if commits are authorized.
3. **Postgres migrations are unverified here.**
   - _Mitigation:_ sqlite parity tests and the PG-gated suites.
4. **The Twilio WSS signature.** Port handling is UNCONFIRMED.
   - _Mitigation:_ the trailing-slash retry and the published example vector.
5. **Exotel.**
   - Mark semantics, mark-on-clear, `call_sid` vs API `Sid`, the dynamic-URL request fields and REST hangup are all UNCONFIRMED.
   - The flow must be Voicebot → Hangup, as attested on the binding.
   - Confirmed writes need the acknowledgement.
6. **Plivo.** The signed URL on upgrade, the stream-status event names, checkpoint behaviour on `clearAudio`, and the queued-call and cancel endpoint shapes are UNCONFIRMED.
7. **Sarvam.** The TTS language field and pricing units are UNCONFIRMED. `flush` is manual-only.
8. **LiveKit.**
   - Unverified audio path (the spike comes first).
   - Internal churn (the exact pin plus regression slices).
   - The glibc images.
   - The LGPL inventory.
   - Real timers in tests.
   - Density with concurrent sessions is not yet load-tested.
9. **AAS.** Scale-from-zero relies on the step policy, scheduled actions drift from `terraform apply`, and the infra evidence is static.
10. **Protection tolerance must not weaken the ownership-loss rule.**
    - _Mitigation:_ the regression test is kept.
11. **Scale of the work** on one branch under "no excessive review".
    - _Mitigation:_ the demo matrix and fixture calls are the acceptance evidence. The console or LiveKit slipping must not block the backend matrix.

---

## 17. Conventions for unit engineers

**Tooling**

- Every shell command starts with `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo`.
- Only wave-1 units run `pnpm install --offline`.

**Module size**

- Measure with `node scripts/check-module-size.mjs` (or `node scripts/lint.mjs --only <prefix>`), never `wc -l`.
- Before you add lines to a file that is in the module-size baseline, split it.

**New packages**

- Wave-2 units fill the skeleton F3 created and remove `"ovo": {"skeleton": true}`.
- Plugin **ids** are separate strings (§0.3).

**Plugin export shape.** `src/index.ts` exports `plugins`, and `src/testing.ts` exports `fixtures` and `fixtureTemplates`. The index re-exports both.

**Fixtures**

- Protocol fixtures live at `tests/fixtures/*.jsonl`.
- The first line is `{"source":"<doc url>","retrieved":"2026-09-22","verbatim":[…],"unconfirmed":[…]}`.
- Each following line is `{"dir":"in"|"out","frame":{…}}`.

**Never:**

- enable live, provider or paid flags;
- open non-loopback sockets in tests;
- bulk-clear restore fences;
- touch `PM/acceptance.json` counts;
- edit frozen files in wave 2;
- create branches or commits unless the orchestrator says the user authorized them.

---

## 18. Resolved decisions (orchestrator, 2026-09-22)

These close the open questions from revision 2. They supersede any earlier conditional wording ("if the user authorizes", "Docker is not running", "no network").

1. **Primary carrier:** none is preselected. The console wizard lists Twilio, Exotel and Plivo, each with a capability summary.
2. **Exotel weak evidence:** confirmed write tools on a `carrier-processed` or `none` evidence carrier are a **blocking** readiness error, unless the release sets `voice.acknowledgements: ['weak-playback-evidence']`.
3. **Exotel termination:** close-stream termination plus the binding attestation `streamEndTerminatesCall` is accepted. A gateway crash dropping Exotel calls is a documented limitation.
4. **Images:** every stage moves to `node:24.8.0-bookworm-slim` (glibc), so one image set can run LiveKit. The LGPL entries are recorded in the licence inventory. Fixture test calls run in an API child process.
5. **Pinning:** v2 engine, carrier and provider selections pin to the plugin id plus the same major version. The version actually resolved is recorded on every call. Behaviors, tools and v1 engines stay exactly pinned. Legacy releases resolve with a readiness warning.
6. **Network is available.** Wave-1 units may run `pnpm install` online to add pinned dependencies: jsdom, Testing Library, `@playwright/test`, `@axe-core/playwright`, and whatever else a unit needs. Wave-2 units run only `pnpm install --frozen-lockfile --offline` in their worktree (to link dependencies) and must never change `pnpm-lock.yaml`.
7. **Terraform** `required_version >= 1.10`, with S3 native state locking (`use_lockfile`).
8. **Git:** local commits are authorized on `vorflux/ovo-foundation`.
   - Wave 1 commits once per unit.
   - Each wave-2 unit works in its own git worktree, on branch `w2/<unit-id>` created from the wave-1 head. The orchestrator merges units into `vorflux/ovo-foundation` one at a time.
   - No pushes and no PR updates without the user's explicit approval.
9. **Idle policy** is on by default for input modes: 10 s, one "Are you still there?" retry, then hang up with `caller_idle`.
10. **Price cards:** fixture test calls label new meters as `unpriced`. D1 also ships an opt-in seed script, `scripts/seed-demo-price-cards.mjs`, that creates price cards clearly labelled **ILLUSTRATIVE — NOT A QUOTE** for the demo.
11. **Fixture test calls** are on in Compose and off on Fargate unless `OVO_FIXTURE_CALLS_ENABLED=true` is set explicitly.
12. **Unconfirmed vendor behaviour** (Twilio WSS signature port handling; Exotel marks, `call_sid` and hangup; Plivo upgrade signature and stream-status events; Sarvam language and pricing fields) is listed in `docs/runbooks/carrier-sandbox-checklist.md` (I1). It must be confirmed in a vendor sandbox before live use.
13. **Docker is available** (colima, 6 CPU, 10 GB). Postgres-gated suites run with `OVO_TEST_POSTGRES_URL` against a disposable container:
    - `docker run -d --rm --name ovo-pg-<unit> -e POSTGRES_PASSWORD=ovo -e POSTGRES_DB=ovo -p 127.0.0.1:0:5432 postgres:17.6`
    - Read the mapped port with `docker port`, and remove the container afterwards.
    - Never point tests at another project's database.

    Terraform is checked through `docker run --rm -v "$PWD/infra/terraform:/w" -w /w hashicorp/terraform:1.10 fmt -check` and `init -backend=false && validate`.

14. **Fargate prep (founder request; O1 scope, in addition to §10):**
    - Optional create-or-bring-your-own Terraform for VPC and subnets (with NAT or VPC endpoints), RDS Postgres, the S3 recordings bucket (encryption, public-access block, lifecycle), ECR repositories and the Secrets Manager secret.
    - An S3 state backend example.
    - `scripts/fargate/build-push.sh` to build and push all images to ECR.
    - A one-off migration ECS task definition and `scripts/fargate/migrate.sh`.
    - `scripts/fargate/plan.sh`, which the operator runs against their account.
    - Alarms: DLQ depth, unhealthy targets, stale capacity metric, warm-pool exhaustion.
    - An updated `docs/runbooks/fargate-deployment.md` covering the path from an empty account to the first call.
    - No `terraform plan` or `apply` against real AWS.
