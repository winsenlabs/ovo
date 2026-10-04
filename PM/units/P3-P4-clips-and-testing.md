# Work unit P3-P4-clips-and-testing: Templated clips and pre-rendered audio on the existing speech cache, a pinned non-expiring clip tier, a pre-dial render hook in O2's campaign driver, and an in-console interactive test call with a per-turn routing and latency trace — no new carrier path, no real dial, no provider egress by default

Wave: Post-I1 (roadmap item 3 plus the founder's in-OVO call-testing ask)
Depends on: I1-integration, D1-demo-backend, U1-console, O2-ops-ledger, S1-speech-split
Defects fixed: [] — no numbered defect from §14. This unit closes post-I1 roadmap item 3 (`PM/units/README.md:191`) and six previously unrecorded findings named in Part A.0 and Part E.0.

**This unit does not discharge the first-real-call gate.** `PM/units/README.md:184` states: "Before any post-I1 feature work, OVO must place its first real call. It has never done so." Nothing in this unit places one, and Part H.2 is the only path that touches a vendor at all — it is default-off, production-refused, and does not ship without a dated founder decision on the board. Build P3/P4 as the thing that de-risks that first call, not as a substitute for it.

## Owned paths

- packages/plugin-speech-cache/\*\*
- packages/plugin-cache/\*\*
- packages/fixture-calls/\*\*
- packages/contracts/src/spoken-form.ts (new file)
- packages/contracts/tests/spoken-form.test.ts (new file)
- apps/worker/src/clip-identity.ts (new)
- apps/worker/src/clip-renderer.ts (new)
- apps/worker/src/clip-warm.ts (new)
- apps/worker/src/clip-predial.ts (new)
- apps/worker/tests/clip-\*.test.ts
- apps/api/src/routes/test-calls.ts
- apps/api/src/routes/test-call-turns.ts (new)
- apps/api/src/test-call-runtime.ts
- apps/api/src/test-call-interactive.ts (new)
- apps/api/tests/test-call\*.test.ts
- apps/console/features/test-console.tsx
- apps/console/features/test-console-\*.tsx (new)
- apps/console/features/call-inspector.tsx
- apps/console/lib/data/use-event-stream.ts
- apps/console/components/operations/evaluations-view.tsx
- apps/console/components/operations/performance-view.tsx
- apps/console/e2e/\*\*

## Shared touchpoints (minimal edits allowed)

- packages/contracts/src/capabilities/keys.ts — one `Cap` entry and one `CAPABILITY_SPECS` entry (Part A.1)
- packages/contracts/src/capabilities/map.ts — three `TypedCapabilities` entries (Part A.1)
- packages/contracts/src/templated-clip.ts — `TemplatedClipPort.prepare` gains the target audio format (Part A.2)
- packages/contracts/src/agent.ts — `clips` field plus two refines (Part A.3)
- packages/contracts/src/voice/engine.ts — one `StageKey` member and two `EngineEvent` variants (Part A.4)
- packages/contracts/src/index.ts — export `spoken-form.ts`
- packages/plugin-observability/src/call-stream-events.ts — three `streamEventName` rows (Part E.2)
- apps/worker/src/speech-cache-v2.ts — extract the binding-identity builder; pass `emit` (Part B.3)
- apps/worker/src/speech-cache-runtime.ts — cache limits and the clip phrase purpose (Part B.2)
- apps/worker/src/worker-dial.ts — one call to the pre-dial hook (Part C.3)
- apps/worker/src/worker-options.ts, apps/worker/src/main.ts — warm pass and readiness (Part C.2)
- apps/worker/src/cost-runtime.ts — clip pre-render usage attribution (Part D)
- apps/api/src/bootstrap.ts — decouple `fixtureRecordingsEnabled` from the storage adapter (Part E.5)
- apps/api/src/routes/performance.ts — close the SSE response on a terminal event (Part E.4)

---

## Specification

GOAL: make a known agent reply play from memory in roughly the time it takes to copy bytes to the carrier instead of waiting on a TTS round trip, and give an operator a seat in the OVO console from which they can drive a call turn by turn and see transcript, audio, selected plugins, per-turn latency, which tier answered, and running cost — without a phone line, and without any new way for a test call to reach a carrier.

Read `docs/architecture/plugin-platform.md` (revision 2): §2.3 (audio, usage, fixture templates), §2.4 (speech v2 and `cacheIdentity`), §2.5 (playback evidence), §2.6 (the `EngineEvent` stream), §4.9 (worker), §11.4 (demo path), §12 (fixture test calls and the evidence API) and §13 (gates). Read `PM/units/README.md:182-194` (the post-I1 roadmap and its provenance) and `PM/units/D1-demo-backend.md`.

PINNED: `plugin-speech-cache` already supplies everything this unit must not rebuild — `createSpeechCacheKey` (`packages/plugin-speech-cache/src/key.ts:5-22`), `CachedSpeechOutput.prepare/play/interrupt` (`src/output.ts:49-115`), `ApprovedSpeechPolicy` (`src/policy.ts:20-23`), and `ByteCache.getOrLoad` with `onSource: 'hit' | 'miss' | 'coalesced'` (`packages/plugin-cache/src/cache.ts:34-44`). The POC that motivates this work is `https://github.com/tejassudsfp/temp-cmchatbot` (47 clips = 35 generic + 12 variable, 34 nodes, two languages, zero dependencies). Do not port its architecture; port only `lib/format.js` (Part B.1), its boot/dial render split (Part C) and its latency panel (Part F).

---

### Part A — contract work (narrow, and it is all that is required)

#### A.0 Findings this unit must fix, with evidence

1. **Boot-rendered clips expire after five minutes and nothing can stop that.** `packages/plugin-cache/src/entries.ts:41-45` sets `expiresAt = now + ttlMs` on `set` and `src/types.ts:70` defaults `ttlMs` to `300_000`. `get` (`entries.ts:27-31`) deletes on expiry and **does not refresh the TTL on access**. A generic clip set rendered at worker boot is therefore gone 300 s later, used or not. "Render generic clips once at boot" is not expressible on today's cache.
2. **Generic and per-contact clips share one unpartitioned LRU.** `entries.ts:74-80` evicts the oldest entry once `maxEntries` (default 256, `types.ts:71`) or `maxBytes` (32 MiB) is exceeded. 35 generic clips plus 12 variable clips per in-flight contact crosses 256 entries at ~18 concurrent contacts, and the thing evicted is the boot set.
3. **Cache hit or miss is invisible outside the worker.** `apps/worker/src/speech-cache-v2.ts:116` tags the audio source `'cache'` but `createV2SpeechCachePlugin` never passes `emit`, so `SpeechCacheTelemetry` (`packages/plugin-speech-cache/src/types.ts:95-110`) is dropped. No stream event, no evidence row, no way to show "this reply came from RAM".
4. **`Cap.decision` and `Cap.humanHandoff` resolve to `unknown`.** They are in `Cap` (`keys.ts:6-7`) and `CAPABILITY_SPECS` (`keys.ts:101-102`) but absent from `TypedCapabilities` (`capabilities/map.ts:28-57`), so `CapabilityMap` (`map.ts:60-62`) falls through to `unknown`. Every consumer casts. `TemplatedClipPort` has no key at all.
5. **`TemplatedClipPort.prepare` cannot be asked for a format.** `packages/contracts/src/templated-clip.ts:73-79` takes `(clip, request, signal)`; `PreparedClip.format` (`:69`) is output-only. A caller cannot request μ-law 8 kHz, which is the only format that matters for telephony.
6. **Nothing pins a clip's language to the agent's.** `TemplatedClip.locale` exists (`templated-clip.ts:11`); `AgentConfig.language`/`locale` exist (`agent.ts:57-58`); no validation connects them. An English clip set bound to a Tamil agent parses clean. The founder's design is one language per bot, so this is a cheap, correct check.

#### A.1 Keys and the type map

In `packages/contracts/src/capabilities/keys.ts`:

- add `templatedClip: 'ovo.templated-clip'` to `Cap` (the object at `:2-74`);
- add `[Cap.templatedClip]: PROCESS` to `CAPABILITY_SPECS` (`:97-165`, preset at `:92`). **Process scope, cardinality `one`.** Clips are rendered before a session exists; the renderer is a process service that the dialing worker owns, and only `process` and `either` keys may be read from a parent (`keys.ts:86-87`).

In `packages/contracts/src/capabilities/map.ts` add three rows to `TypedCapabilities` (`:28-57`):

```ts
[Cap.decision]: DecisionPort;          // decision.ts:128
[Cap.humanHandoff]: HumanHandoffPort;  // human-handoff.ts:76
[Cap.templatedClip]: TemplatedClipPort;
```

Never spell a capability string outside `keys.ts`; `scripts/check-capability-keys.mjs:39-42` counts literals per file against `scripts/baselines/capability-keys.json` and a file absent from the baseline must be zero.

#### A.2 `TemplatedClipPort` gains a target format

```ts
export interface TemplatedClipPort {
  prepare(
    clip: TemplatedClip,
    request: ClipPreparation,
    options: { format: AudioFormat; voice?: string; signal: AbortSignal },
  ): Promise<PreparedClip>;
}
```

`PreparedClip.format` must equal `options.format`; a renderer that cannot produce it rejects with a typed `ClipFormatUnsupportedError` rather than silently returning another format. Nothing implements the old signature (grep: only `packages/contracts/tests/post-i1-contracts.test.ts`), so this is free.

Add `ClipDeadlineError` to `templated-clip.ts`. The existing comment at `:45-46` ("a timeout must fall back to normal synthesis") becomes enforced: `prepare` rejects with `ClipDeadlineError` once `deadlineMs` elapses from the call to `prepare`, and the documented caller contract is that `ClipDeadlineError` is swallowed, not propagated.

#### A.3 `AgentConfig.clips`

In `packages/contracts/src/agent.ts` (the object at `:53-126`):

```ts
clips: z.array(TemplatedClip).max(200).default([]),
```

plus two refines alongside the existing ones at `:128-134`:

- clip ids are unique → `'Clip IDs must be unique'`;
- every `clip.locale` equals `config.language` → `` `Clip locale must match the agent language` ``.

**Clips bind to utterances by rendered-text identity, not by id.** This is the whole reason P3 is small. `CachedSpeechOutput.cachedAudio` (`output.ts:117-140`) looks up `createSpeechCacheKey(config, segment.text)`. If a clip's rendered text is byte-identical to the text a behavior later produces, the pre-rendered audio is already under the key the session will compute, and the session plays it with no code change at all. No node→clip reference, no new addressing. The consequence — and the invariant the tests must pin — is that **rendering is only useful when the pre-render binding identity is byte-identical to the session's**, which is Part B.3.

Do **not** add a `clipId` to `ScriptGraph` or `IntentScriptNode`. Addressing a clip from a graph node belongs to the intent-graph behavior unit (post-I1 roadmap item 2) and must not be invented here.

#### A.4 Two engine events and one stage key

In `packages/contracts/src/voice/engine.ts`:

- `StageKey` (`:74-85`) gains `'clip_lookup'`. It does **not** gain `'rule_match'` or `'decision'`; those belong to roadmap items 1 and 2.
- `EngineEvent` (`:87-120`) gains:

```ts
| { type: 'clip';
    segmentId: string;
    outcome: 'hit' | 'miss' | 'coalesced' | 'bypass';
    prepared: boolean;          // true when a pre-dial or boot render produced this entry
    keyPrefix: string;          // first 8 hex of the cache key, never the key or the text
    ms: number }
| { type: 'route';
    turnId: string;
    tier: 'rule' | 'decision' | 'llm';
    ms: number;
    intentId?: string;
    confidence?: number;
    calibrationVersion?: string;
    probabilities?: Record<string, number>;
    fallbackReason?: 'other' | 'low_confidence' | 'error';
    speculative?: boolean }
```

`keyPrefix` honours the rule stated at `packages/plugin-speech-cache/src/key.ts:4`: "raw text and the compound key never enter telemetry."

**`route` has no producer in this unit and must not get a fake one.** No behavior shipping today has routing tiers. P4 defines the event, maps it into the SSE stream, renders it in the console, and proves the rendering against a fixture-only emitter in `packages/conformance/src/drivers`. For every real release the console's tier column reads `—`. **Do not synthesise a tier from timing data.** What P4 _does_ show for real today is the three-way distinction that exists: clip/cache hit, TTS synthesis, LLM generation — derived from the `clip` event plus `tts_ttfb` and `llm_ttfb` timings.

---

### Part B — `plugin-speech-cache` and `plugin-cache` (owned)

#### B.1 `packages/contracts/src/spoken-form.ts` — the spoken-form renderer (≤200 lines)

This is `lib/format.js` from the POC with no OVO counterpart. It must live in **contracts**, not in the cache plugin, because `packages/behaviors` may import only contracts, runtime, zod, ajv, ajv-formats and `node:*` (`scripts/check-architecture.mjs:109-121`) and the announcement renderer needs it too. Contracts may import only zod (`check-architecture.mjs:100-101`); this file needs nothing.

Pure, no `Intl`, exported:

- `inWords(n: number): string` — Indian numbering: crore / lakh / thousand / hundred, with `and` before a trailing two-digit group. `inWords(123456789)` → `'twelve crore thirty four lakh fifty six thousand seven hundred and eighty nine'`.
- `rupeesWords(paise | rupees: number): string` → `rupeesWords(4850)` = `'four thousand eight hundred and fifty rupees'`. Specify the unit explicitly in the signature; do not let a caller guess.
- `digitsSpoken(s: string): string` → `digitsSpoken('8213')` = `'8 2 1 3'`.
- `dateWords(iso: string, style: 'day-first' | 'month-first'): string` → `'the 3rd of October'` / `'October 3rd'`.
- `dayDateWords(iso: string, style): string` → `'Saturday, the 3rd of October'`.

Then extend `formatValue` in `packages/behaviors/src/announcement.ts:165-186` with `x-ovo-format` values `'currency-spoken'`, `'date-spoken'`, `'day-date-spoken'` and `'digits-spoken'`, and a per-agent `x-ovo-spoken-date-style` defaulting to `'day-first'`. The existing `'currency'` and `'date'` paths are unchanged, because a display string is still wanted for a payment page.

**Why this is not `Intl`:** `formatValue` with `x-ovo-format: 'currency'` produces `₹4,850` (`announcement.ts:176`) and `format: 'date'` produces `4 October 2026`. A TTS engine reads both inconsistently. The POC writes every amount and date out the way an Indian collections agent says it, and the Tamil path reads dates in English, month first.

#### B.2 `packages/plugin-cache` — a pinned tier (fixes A.0 findings 1 and 2)

Extend `ByteCache` (`src/types.ts:38-44`) and `BoundedByteCache` (`src/cache.ts:12-55`):

```ts
set(key, workspaceId, value, options?: { pinned?: boolean }): boolean;
unpin(key: string, workspaceId: string): boolean;
readonly stats: ByteCacheStats;   // gains pinnedEntries, pinnedBytes
```

Rules, enforced in `ByteCacheEntries` (`src/entries.ts`):

- a pinned entry has **no `expiresAt`**; `purgeExpired` and `get`'s expiry branch skip it;
- pinned entries are **never** chosen by `evictToBudget`; it walks the insertion order skipping pinned entries, and when only pinned entries remain and the budget is still exceeded, `set` of a _new unpinned_ entry returns `false` rather than evicting a pinned one;
- `pinnedBytes` is capped by a new limit `maxPinnedBytes` (default 8 MiB) and `maxPinnedEntries` (default 512); a `set({pinned: true})` over either limit returns `false` and is reported, not silently dropped;
- `invalidateWorkspace` and `clear` still remove pinned entries — a release change must be able to drop them.

Raise the worker's limits in `apps/worker/src/speech-cache-runtime.ts:15-17`: `ttlMs: 900_000`, `maxEntries: 4_096`, `maxBytes: 192 * 1024 * 1024`, `maxPinnedBytes: 16 * 1024 * 1024`, `maxPinnedEntries: 1_024`, and make every one of them configurable from `worker-options.ts`. Pinned ≈ the generic set per release; unpinned ≈ 12 clips × concurrent contacts.

Also in `speech-cache-runtime.ts`: `ApprovedSpeechPhrase.purpose` (`packages/plugin-speech-cache/src/types.ts:38-41`) gains `'clip'`, `ApprovedSpeechPolicy.permits` (`src/policy.ts:20-23`) admits a `'clip'` phrase for **any** `SpeechKind`, and `approvedSpeechPhrases(agent)` (`speech-cache-runtime.ts:24-43`) appends one `'clip'` phrase per `agent.clips[]` rendered text. Without this the policy refuses the lookup and `play` goes straight to `uncachedAudio` (`output.ts:85`), so every clip would be a cache bypass.

#### B.3 `plugin-speech-cache` modules (≤250 lines each)

- `src/clip-text.ts`: `renderClipText(clip: TemplatedClip, values: Record<string,string>): string` — `validateClipPreparation` first (it already enforces every declared variable supplied and each within `maxLength`, `templated-clip.ts:51-63`), then substitute `{{name}}`. Throw, never blank, on a missing variable. `clipTexts(clips, valuesByClipId)` returns the whole set for a contact.
- `src/clip-prepare.ts`: `TemplatedClipRenderer implements TemplatedClipPort`, constructed with `{ cache: ByteCache, tts: NormalizedTts, binding: SpeechSynthesisBinding, clock }`.
  - `prepare` renders text, computes `createSpeechCacheKey(binding, text)`, returns immediately on a cache hit with `cacheKey` set and no synthesis;
  - otherwise synthesises through `cache.getOrLoad` so two concurrent contacts with the same text coalesce (`pending.ts:43-51`), races `deadlineMs` with an internal `AbortController`, and rejects `ClipDeadlineError` on timeout after aborting the producer;
  - verifies `options.format` against the binding's `codec`/`sampleRate` before any `tts.synthesize` call and rejects `ClipFormatUnsupportedError` first, so an unsupported format cannot spend a character (same shape as the S2 REST spending guard);
  - reports `{ charsBilled, charsCoalesced, charsWouldBillUncached }` so the cache-miss counterfactual is computable (Part D).
- `src/clip-warm.ts`: `warmClips({clips, binding, cache, tts, format, concurrency = 4, attempts = 3, signal})`.
  - Generic clips only — a clip with `variables.length === 0`. Pins every entry (`set({pinned: true})`).
  - Bounded concurrency 4; 3 attempts with 500 ms × 2^n backoff, retried only on a retryable provider error.
  - Per-locale memoised promise held in a `Map`, **deleted on failure** so a retry is possible — the POC's `genericReady` rule.
  - Returns `{rendered, cached, chars, pinned, failures: {clipId, reason}[]}`. A non-empty `failures` is the caller's decision, not an exception.

`CachedSpeechOutput` itself is unchanged except that `cachedAudio`'s `onSource` callback (`output.ts:123-130`) now also reports `prepared` — true when the entry is pinned or was written by the renderer. Track that with a key set on the renderer, not by widening `ByteCache.get`.

---

### Part C — worker wiring (owned, plus three minimal shared edits)

#### C.1 `apps/worker/src/clip-identity.ts` — one identity builder, used twice

Extract the `cacheKey` object literal at `apps/worker/src/speech-cache-v2.ts:52-68` verbatim into:

```ts
export function speechBindingFor(input: {
  release: ReleaseRecord;
  identity: ReturnType<TextToSpeech['cacheIdentity']>; // {provider, model, voice, revision}, speech/tts.ts:21-24
  format: AudioFormat;
}): SpeechSynthesisBinding;
```

`speech-cache-v2.ts` then calls it, and so does the pre-render path. **This is the load-bearing invariant of P3:** if the two disagree on any one of the twelve fields hashed by `createSpeechCacheKey` (`key.ts:6-20`) — including `bindingVersion`, which today falls back through `selection.binding.fingerprint → updatedAt → version → 'legacy'` (`speech-cache-v2.ts:56-59`) — every pre-render is wasted spend and every reply still waits on TTS. There must be exactly one builder, and a test must prove a one-field mutation produces a miss (Part G, negative control 3).

#### C.2 `apps/worker/src/clip-renderer.ts` and `clip-warm.ts` — a TTS with no session

The renderer needs a `TextToSpeech` before a session exists. Do **not** call `selectSessionGraph`: it requires `media` (`packages/session-host/src/select-session-graph.ts:130`) and composes an engine. Instead:

- `composeClipRenderer(release, registry, hostServices)` calls `compose()` directly with **one row** — the release's selected `tts` plugin, with the row config built by the same rule `configFor` uses for non-engine slots (`select-session-graph.ts:94-127`): `{binding: binding.config, credentialRef: {credentialId}, ...selection.config}` — plus host services for `Cap.net`, `Cap.secrets`, `Cap.usage` and `Cap.clock`. Scope `session`, `enforcement: 'enforce'`.
- `tts.cacheIdentity(format, voice)` then gives the identity for `speechBindingFor`. `format` is the selected carrier's `capabilities.media.formats[0]`, resolved the same way `apps/api/src/test-call-runtime.ts:111` resolves it.
- Dispose the composition after each warm pass or pre-dial batch. One composition per release per pass, never one per clip.

Boot warm pass, in `apps/worker/src/main.ts` via `worker-options.ts`:

- for each release the worker is configured to serve (or, in the common single-release dev case, the release named by `OVO_WARM_RELEASE_IDS`), render and pin the generic set;
- it runs **after** plugins compose and **before** the worker reports ready (`worker-health.ts`); a failure leaves the worker unready with the clip id and reason in the log, and it is retried on the next readiness probe. Unlike the POC, do **not** `process.exit(1)`: a worker that cannot reach TTS must fail its readiness probe so the scheduler stops routing to it, not crash-loop.
- `OVO_WARM_CLIPS=false` skips the pass entirely for a deployment that does not want it. Default on.

#### C.3 `apps/worker/src/clip-predial.ts` — render while the phone rings

The contract says the deadline is "relative to dial admission" (`templated-clip.ts:45`). The exact admission point in the worker is immediately after `beginDialSession` returns a route and before the carrier `dial`, at `apps/worker/src/worker-dial.ts:182-192`.

```ts
const clips = startClipPreparation({
  // clip-predial.ts
  release,
  callId: job.id,
  variables: dialPayload.variables,
  format,
  deadlineMs,
});
// ... existing selected.control.dial(carrierRequest) runs next, NOT awaited on clips
```

Rules:

- **`startClipPreparation` must never be awaited before `dial`.** It returns a handle; the dial proceeds in the same tick. A test asserts the dial's observed start time is within 5 ms of admission with a TTS that takes 2 s.
- The handle is stored on the worker's per-call state and handed to the session factory (`production-session-factory.ts`); the session awaits it with the _remaining_ deadline before its first utterance, and swallows `ClipDeadlineError`.
- `deadlineMs` defaults to the release's `ringTimeoutSec * 1000` capped to `ClipPreparation`'s 300 s maximum, and is overridable per campaign.
- Per-contact variables come from `authorizeCampaignPayload`'s resolved `variables` (`apps/worker/src/campaign-dial.ts:97`), which is already the per-contact map stored by the CSV importer (`packages/plugin-operations/src/campaign-admin.ts:139-147`, schema `api-schemas.ts:24`). No new column, no new migration.
- On a dial failure the handle is aborted in the same cleanup paths that call `cost?.releaseBeforeStart()`.
- `ClipPreparation.releaseId`/`contactId`/`workspaceId` are filled from the job; `clipId`/`values` per clip.

**Why the process-local cache is enough here, and where it is not.** The worker that dials is the worker that composes and runs the session (`apps/worker/src/session-graph-runtime.ts:162`), so a pre-render written to `WorkerSpeechCacheRuntime.cache` is found by that call. It is **not** enough across workers: each worker renders the generic set once per boot (N workers × generic set, once per deploy — state that cost in the package README), and a per-contact render is useless if the job is re-queued onto another worker. A durable blob tier behind `ByteCache` is **explicitly out of scope and named here as the follow-up**; it is the only way to make a re-queued contact keep its clips, and `packages/plugin-storage` is the right home. Do not half-build it.

---

### Part D — metering and the cache-miss counterfactual

- Clip pre-render and boot-warm synthesis are ordinary TTS spend: `UsageMeter {provider, operation: 'tts', unit: 'characters', ...}` (`packages/contracts/src/usage.ts:20-30`), `meterKey` unchanged (`usage.ts:46-47`). **No new `UsageOperation` is needed.** (`'decision'` is missing from `UsageOperation` at `usage.ts:18`, which collapses a decision-model tier into `'inference'` — that is roadmap item 1's problem, not this unit's. Do not add it here.)
- Pre-dial renders are attributed to the call: emit through the per-call usage sink with `requestId` from the provider, or `${provider}:${callId}:clip:${n}` when the provider gives none (`usage.ts:27`). Boot-warm renders have no call; emit them to a process-level sink and record them in the worker's log plus `infrastructure-metrics.ts`, **not** against any call. Charging a deploy-time render to the first caller would make the per-call number a lie.
- `apps/worker/src/cost-runtime.ts` (O2-owned, minimal edit): accept the clip meters as ordinary `tts`-role meters so the existing `metersFor` / `meterUncovered` resolution (`packages/session-host/src/meters.ts:11-37`, `compat/meter-uncovered.ts:5-51`) and the hard admission gate (`cost-runtime.ts:102-118`) are unchanged. A release that already has a TTS price card needs no new card.
- **Counterfactual.** Append one `clip.prepared` call event per call with `{charsBilled, charsCoalesced, charsWouldBillUncached, hits, misses, pinnedHits, deadlineMisses}`. The console computes "what this call costs for a first-time contact" as the priced total plus `charsWouldBillUncached - charsBilled` at the TTS rate. Do **not** invent a usage meter for characters that were never billed; `priceUsage` (`packages/contracts/src/pricing.ts`) requires pricing provenance and a meter is a billing claim.

---

### Part E — P4 step 1: make the console surface that already exists actually work

#### E.0 Findings, with evidence

The test console at `/agents/:id/test` renders three live panels that are wired to a contract the API has never emitted. The e2e suite is green because it mocks the fictional contract: `apps/console/e2e/fixtures/console.json:5890-5932` emits `event: stage`, a flat `event: transcript` with `speaker/phase/text`, and `event: cost` with `costPaise: "3"`, and `console.spec.ts:53-54` asserts exactly that. **The green test certifies the mock, not the API.**

| Console expects                                                                          | API emits                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE names `transcript`, `stage`, `cost` (`apps/console/lib/data/use-event-stream.ts:38`) | `transcript.user.{interim,final}`, `transcript.agent.{generated,played,interrupted}`, `turn`, `timing`, `speech`, `end`, `gap`, `audit` (`packages/plugin-observability/src/call-stream-events.ts:2-33`) |
| `payload.stage` (`features/test-console.tsx:101`)                                        | never present; the real field is `payload.event.key` on a `timing` event (`contracts/src/voice/engine.ts:111-118`)                                                                                       |
| `payload.costPaise` (`test-console.tsx:102,194`)                                         | **no producer anywhere in the repo**; `UsageMeter` has no such field                                                                                                                                     |

SSE event names are exact-match, so `transcript.*` and `audit` are never delivered at all. Live transcript is permanently empty, the stage timeline is permanently empty, "Cost so far" permanently reads `unpriced`, and `fixture.result` — which carries the outcome, the resolved selections and `sttMode` — rides `audit` and never arrives. Three more: the simulation result panel is gated out of the only page that mounts it (`components/operations/evaluations-view.tsx:167` wraps the panel at `:206` in `!simulationsOnly`, and `evaluation-datasets-view.tsx:64` mounts it with `simulationsOnly`); fixture audio is served but never fetched (`features/call-inspector.tsx:41-45` assigns `recordingSource = recording.source`, which for a fixture is the literal string `'fixture'` (`apps/api/src/recording-runtime.ts:118`), and `recording.segments` is undefined so the guard at `:77` falls through to "No recording available"); and the performance source filter offers only live and simulation (`components/operations/performance-view.tsx:135-137`) although fixture telemetry writes `source: 'test'` (`packages/plugin-observability/src/fixture-telemetry.ts:20`).

#### E.1 `use-event-stream.ts`

Replace the name array at `:38` with the names the API actually produces: `transcript.user.interim`, `transcript.user.final`, `transcript.agent.generated`, `transcript.agent.played`, `transcript.agent.interrupted`, `turn`, `timing`, `speech`, `clip`, `route`, `end`, `audit`, `gap`. **Remove `stage` and `cost`** — keeping a name with no producer is what hid this for a release. Derive the subscribed set from one exported constant so a test can compare it against `streamEventName`'s whole output range.

#### E.2 `streamEventName` (shared touchpoint, three rows)

```ts
if (raw.type === 'clip') return 'clip';
if (raw.type === 'route') return 'route';
// and, outside the `event` branch:
if (row.type === 'call.finished') return 'end';
```

#### E.3 `test-console.tsx` (split into ≤300-line modules)

- read every field from `payload.event`, with `payload` itself as the fallback for the legacy row shapes `streamEventName` still maps (`call-stream-events.ts:25-32`);
- transcript from `transcript.user.*` and `transcript.agent.*`, labelled by the event type, not by a regex over a `kind` field;
- stage timeline from `timing` events: `payload.event.key`, `turnId`, `ms`;
- **delete the `costPaise` read.** Cost comes from `GET /v1/calls/:id/evidence` (`apps/api/src/routes/inspection.ts`), which already returns `{estimatedPaise, reconciledPaise, unpriced[], lines[]}`, polled on each agent turn and once at `end`. When the deployment has no cost ledger, render `unpriced — no cost ledger on this deployment`, not a bare `unpriced`.

#### E.4 A terminal marker, and close the stream

`finishCall` appends no call event (`packages/plugin-storage/src/sqlite/calls-repository.ts:154`), so the SSE loop in `apps/api/src/routes/performance.ts:111-140` polls every 500 ms until the one-hour `maxConnectionMs`. Append a `call.finished` event (type, plus `{status, outcome}`) at the end of `persistFixtureResult` and in the `fail` path of `routes/test-calls.ts:154-167`; map it to `end` (E.2); and in the SSE loop, after writing an event whose name is `end`, flush and return instead of continuing to poll. Do not change the storage repository.

#### E.5 The deployment coupling

`apps/api/src/bootstrap.ts:100-104` ties `costLedgerEnabled`, `telemetryEnabled` and `evaluationsEnabled` to Postgres but `fixtureRecordingsEnabled` to **sqlite**. On the default dev run you get fixture audio and no prices; on Postgres you get prices and `persistFixtureRecording` throws `Fixture recording storage is unavailable` (`apps/api/src/recording-runtime.ts:121`), which marks the call failed (`routes/test-calls.ts:199`). **You cannot currently have audible fixture audio and real paise in one deployment**, which is exactly the demo. Make `fixtureRecordingsEnabled` independent of the storage adapter (its archive is `packages/plugin-storage`-backed and works on both); gate it on its own option, default on when fixture calls are enabled. The cost ledger stays Postgres-only — that is real, and the console must say so rather than show a blank.

#### E.6 Playable fixture audio and the remaining two fixes

- `call-inspector.tsx:41-45`: when `recording.source === 'fixture'`, build `/api/v1/calls/${callId}/recordings/${trackId}/audio` per entry of `recording.tracks` (`{agent?, caller?}`, `recording-runtime.ts:118`) and render a plain `<audio controls>` per track. The endpoint already serves `audio/wav` (`apps/api/src/routes/recordings.ts:47-70`). Do not require `recording.segments` for a fixture.
- `evaluations-view.tsx`: move the "API result" panel (`:206`) out of the `!simulationsOnly` branch so `/evaluations` shows the simulation's actual reply text.
- `performance-view.tsx:135-137`: add `<option value="test">Test</option>`.

**E.1–E.6 alone give a working console loop today**: typed caller script → fixture call → live transcript + stage timeline + playable agent track + post-call paise. It is still a scripted replay against canned provider wire scripts. Part G is what makes it a conversation.

---

### Part F — P4 step 2: the per-turn trace panel

One panel, driven only by events that exist:

| Column       | Source                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn         | `user.turn {phase:'stopped', turnId}`                                                                                                                           |
| Caller said  | `transcript.user.final`                                                                                                                                         |
| Tier         | `route.tier` when present, else `—` (no real behavior emits one yet)                                                                                            |
| Confidence   | `route.confidence` + `route.calibrationVersion`, else `—`                                                                                                       |
| Audio source | `clip.outcome` (`hit`/`miss`/`coalesced`/`bypass`) + `clip.prepared`                                                                                            |
| Latency      | `LatencyBreakdown` from `projectLatencyBreakdowns` (`packages/plugin-observability/src/latency-breakdown.ts:129-137`), parts labelled by `ownerKind` (`:26-31`) |
| Agent said   | `transcript.agent.played`, with `generated` shown while pending                                                                                                 |

Render the latency parts as a stacked bar and carry the no-double-counting warning from `latency-breakdown.ts:33-36` and `docs/04-architecture.md:103` in the panel text: reported stage `ms` values can overlap, so the parts are attributed to the stage that ended each interval and do not sum to the total.

Score each turn against `docs/07-acceptance.md` §5: cached scripted response p95 ≤700 ms, no-tool meaningful response p50 ≤800 / p95 ≤1,500 ms, cached acknowledgment p95 ≤500 ms, greeting p95 ≤1,000 ms. A clip hit that misses 700 ms is the single most useful signal this panel can give.

---

### Part G — P4 step 3: the interactive turn channel (new runtime work)

This is the only genuinely new runtime in the unit. Three things block it today.

1. `FixtureChildJob` is `{callId, release, callerScript}` and the child does `process.once('message')` (`packages/fixture-calls/src/child-runtime.ts:6-10, :152`). There is no mid-call input channel.
2. The caller's turns are pre-scheduled timers from a script submitted up front (`src/default-script.ts:51-59`, `types.ts:19-21`).
3. The STT fixture script is rendered **once from the whole caller script** (`src/fixture-scripts.ts:39, :52, :61-69`), so a turn that was not in the original script hits `FixtureMismatchError` (`packages/plugin-kit/src/fixture-match.ts`) at the unscripted host.

#### G.1 A per-turn STT script source

Mirror the shape that already exists for TTS. `selectFixtureScripts` defers TTS with `ttsTemplate = (text) => template({...templateInput, agentTexts: [text]})` (`fixture-scripts.ts:42-44`) and `deferredTtsNet` feeds it in on demand. Do the same for STT:

- `sttTemplate = (text, turnIndex) => template({...templateInput, turns: [{atMs: 0, say: text}]})`;
- `createSttReplayNet` (`src/stt-replay-net.ts`) gains `append(scripts: NetFixtureScript[], turn: number)`, so a script can be added to a live `FixtureNet` run set after construction. `createFixtureNet`'s `runs` array (`packages/plugin-kit/src/fixture-net.ts:101-108`) is private; expose an `append` on `FixtureNet` rather than reaching into it, and keep `assertComplete()` honest — an appended script's required steps count toward `pending()`.
- `planSttReplay` keeps its existing gating (`release(turn)`), so interim/final ordering per turn is unchanged.

A provider whose fixture template cannot render a single-turn script refuses with `fixture_unavailable: <pluginId> has no per-turn STT template`, named, not silently degraded to `fixture-generic`.

#### G.2 `packages/fixture-calls/src/interactive.ts` (≤250 lines)

```ts
export function runInteractiveFixtureCall(input: FixtureCallInput & { interactive: true }): {
  callId: string;
  submit(turn: { say?: string; dtmf?: string; silenceMs?: number }): Promise<void>;
  hangup(): Promise<void>;
  done: Promise<FixtureCallResult>;
};
```

- replaces `callerPlayback`'s timer loop with a queue; a `submit` resolves once the turn's audio has been handed to the fake carrier and the STT script appended, so the API can answer 202 truthfully;
- refuses a `submit` while the previous turn's agent reply has not reached `transcript.agent.played` — one turn in flight, like a real call;
- retains everything else in `executeFixtureCall` unchanged: the fake carrier with the selected carrier's **real** serializer (`src/execute.ts:83-93`), `fixtureParent` (`:45-64`), the egress sentinel (`src/run.ts:122, :163-178`), the synthetic secret resolver, `net.assertComplete()` at the end.
- An idle watchdog ends the call after `idleTimeoutMs` (default 120 s since the last `submit`) with `EndReason` `'no_input'`, and a hard cap `maxCallMs` (default 900 s) ends it with `'limit'`. Both are enforced **inside** the child, not only by the parent.

#### G.3 `child-runtime.ts` and the API

- `FixtureChildJob` gains `interactive?: true`, `idleTimeoutMs?`, `maxCallMs?`.
- `runFixtureCallChild` keeps **one job per child** but switches to `process.on('message')` for `{type:'turn', turn}` and `{type:'hangup'}` after the `{type:'start'}` frame; a second `start` is refused with `Invalid fixture child request`. `FixtureChildMessage` gains `{type:'turn-accepted', seq}`.
- `TestCallRuntime.wallTimeoutMs` stays 120 s for scripted calls; interactive calls use `maxCallMs` and a **separate concurrency cap of 1** (`options.maxConcurrentInteractive`), because one interactive call holds a child for minutes. `POST /v1/agents/:id/test-calls` gains `mode: 'scripted' | 'interactive'` (default `'scripted'`); interactive refuses with 429 `fixture_calls_capacity` when one is already live, and the 422 `caller_script_exceeds_timeout` check (`routes/test-calls.ts:75-80`) does not apply.
- New `apps/api/src/routes/test-call-turns.ts`:
  - `POST /v1/calls/:callId/turns` `{say?: string(≤10_000), dtmf?: string(≤100), silenceMs?: int}` → 202; 404 if the call is not this workspace's `kind: 'test'`; 409 `call_finished`; 409 `turn_in_flight`; 404 `fixture_calls_disabled`. Editor role. Idempotency-Key supported, matching `routes/test-calls.ts:83-88`.
  - `POST /v1/calls/:callId/hangup` → 202.
  - The in-flight handle lives in `apps/api/src/test-call-interactive.ts`, keyed by callId, with the same reservation discipline as `TestCallRuntime.reserve()`; a process restart loses the call, and the route then answers 409 `call_finished`.
- The caller's typed text is written to the event log as a `transcript.user.final`-shaped engine event by the normal path — no special-case event type.

#### G.4 Console

A reply box above the trace panel: a text input, a DTMF input, a "silence" button, "Hang up", and the existing engine/carrier pickers. The `callerScript` field the API has accepted since D1 (`routes/test-calls.ts:30-46`) also gets a UI for scripted mode, replacing the hardcoded `{useDraft: true}` at `features/test-console.tsx:85`. Mic input is **out of scope**: there is no `getUserMedia`, `MediaRecorder` or `AudioContext` anywhere in `apps/console` or `packages/ui` today, and adding a browser audio pipeline is its own unit. Typed turns are what the founder asked for as the minimum and they exercise the same routing path.

#### G.5 The safety boundary (NON-NEGOTIABLE)

**A test call must remain structurally incapable of reaching a carrier, and the interactive path changes none of the four layers that make that true.**

1. **Process fence.** `fork(process.argv[1], ['--ovo-fixture-call-child'], {stdio: ['ignore','ignore','ignore','ipc']})` (`child-runtime.ts:95-99`), one call per child, `process.exit` after the result (`:162-170`), and the child never starts the HTTP server (`apps/api/src/index.ts:9`). Interactive adds message kinds _after_ `start`; it does not add a second job, does not widen stdio, and does not keep the child alive past one call.
2. **Egress sentinel.** `withFixtureEgressSentinel` (`packages/fixture-calls/src/egress.ts:5-8`) wraps the whole child body including process-plugin setup (`apps/api/src/test-call-runtime.ts:72`), and `installEgressSentinel({allowLoopback: false})` (`packages/conformance/src/drivers/egress-sentinel.ts:39-96`) replaces `net.connect`, `net.createConnection`, `tls.connect`, `globalThis.fetch` and `WebSocket` with throwing guards, calls `syncBuiltinESMExports()` so ESM importers see the stubs, and deletes every `LIVEKIT_*` env var. `run.ts:122` installs it a second time around fixture setup and `:163-178` a third time around execution, then **fails the call if any attempt was recorded even if it was caught**: `if (sentinel.attempts.length) throw new EgressBlockedError(...)` (`run.ts:174`). Unchanged. The interactive loop runs entirely inside that third `withEgressSentinel` scope — `submit` must not be able to schedule work outside it, which is why the queue lives in the child and the parent only sends messages.
3. **Capability fence.** `fixtureParent` (`packages/fixture-calls/src/execute.ts:45-64`) strips `Cap.costLedger`, `Cap.carrierControl`, `Cap.legacyTelephony`, `Cap.operations` and `Cap.orchestrationStore` from the parent view across **all three** accessors (`keys`, `get`, `all`), so an installed real Twilio control is unreachable even from a live parent. `runInteractiveFixtureCall` reuses `executeFixtureCall`'s composition path and therefore the same `fixtureParent`. The blocklist is not widened, not narrowed, and not bypassed; `packages/distribution/tests/fixture-parent-isolation.test.ts:32-44` already pins it against the real `TwilioTelephonyControl` and `twilioControlFactory`, and P4 adds the interactive path to that test file's matrix.
4. **No live secrets.** The child's resolver answers only from the synthetic map `{credentialId: 'fixture-key'}` (`apps/api/src/test-call-runtime.ts:120-125`) and otherwise throws `fixture_unavailable: live secrets are disabled` (`packages/fixture-calls/src/host-service.ts:71-78`). Native tool handlers stay schema-shaped samples (`host-service.ts:16-31`). The carrier is `createFakeCarrier`, an in-memory duplex over the carrier's **real** serializer (`execute.ts:83-93`) — the wire format is genuinely exercised and no socket exists.

Stated plainly, and to be written into the package README: layer 2 is in-process monkey-patching, not a network namespace. A module that captured `net.connect` before installation, or a native addon, would bypass it. **Layers 1, 3 and 4 are what make a dial impossible**; layer 2 is a tripwire that converts a mistake into a failed call. Do not let a reviewer treat the sentinel as the boundary.

---

### Part H — audio you can hear

- **H.1 (in scope).** The agent's audio in a fixture call is whatever the selected TTS plugin's fixture template emits — synthetic bytes, not speech. Serve it anyway: with `config.recording` set, the fixture recording writer already archives both tracks as μ-law WAV (`apps/api/src/recording-runtime.ts:108-118`), and E.6 makes the console play them. That proves the whole chain — codec, framing, marks, playout acknowledgement — and it is audible. Add a per-segment seek driven by the `speech` evidence timeline so an operator can click a turn and hear exactly that segment.
- **H.2 (specified, default off, founder-gated).** Hearing the _real_ voice means letting the TTS slot egress. Design, do not enable:
  - `FixtureCallInput.providerEgress?: readonly ('tts' | 'llm')[]`, and `installEgressSentinel({allowHosts})` gains an exact host allow-list (and the `*.example.com` single-label wildcard form already used by `packages/runtime/src/net-guard.ts:7-13`);
  - the allow-list is computed **only** from the named slots' selected plugins' `manifest.runtime.egressHosts`. The composition **refuses to start** if the resulting set intersects any installed plugin of kind `carrier`, or if `providerEgress` names `carrier` or any slot not in the literal `['tts','llm']`;
  - an allowed host's request is **not** recorded in `sentinel.attempts`, so `run.ts:174` still fails the call on any genuinely blocked attempt;
  - layers 1, 3 and 4 above are untouched: the carrier is still fake, `fixtureParent` still blocks carrier control and the cost ledger, and secrets for the egressing slot must come from the real secret resolver, which means this mode **cannot** use the synthetic map and must therefore reserve budget before starting;
  - behind `OVO_TEST_CALL_PROVIDER_EGRESS=true`, refused outright when `NODE_ENV=production`, and refused when the release has no `costPolicy`.
  - **STOP CONDITION.** H.2 does not ship without a dated founder decision recorded on `PM/units/README.md`. If that decision is not on the board, build H.1, write H.2's tests as `.skip` with the reason, and say so in the handoff. Do not infer the answer. (This is the same discipline the board applies to C3/C5/C6.)

---

## MODULES (≤250 lines each unless stated)

| File                                               | Responsibility                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/contracts/src/spoken-form.ts`            | pure Indian-numbering, rupee, date and digit-string word expansion; no `Intl`, no deps (≤200) |
| `packages/plugin-cache/src/entries.ts`             | pinned entries exempt from TTL and eviction; `maxPinned*` limits                              |
| `packages/plugin-cache/src/types.ts`               | `set` options, `unpin`, `pinnedEntries`/`pinnedBytes` stats                                   |
| `packages/plugin-speech-cache/src/clip-text.ts`    | `renderClipText`, `clipTexts`; throws on a missing variable                                   |
| `packages/plugin-speech-cache/src/clip-prepare.ts` | `TemplatedClipRenderer`; deadline race, format pre-check, coalescing, char accounting         |
| `packages/plugin-speech-cache/src/clip-warm.ts`    | bounded-concurrency pinned warm pass with retry and per-locale memoisation                    |
| `apps/worker/src/clip-identity.ts`                 | the single `speechBindingFor` used by both the pre-render and the session                     |
| `apps/worker/src/clip-renderer.ts`                 | `composeClipRenderer`: one-row `compose()` of the selected TTS, no media, no engine           |
| `apps/worker/src/clip-warm.ts`                     | boot pass per release, readiness gate, log and metrics                                        |
| `apps/worker/src/clip-predial.ts`                  | `startClipPreparation` at dial admission; never awaited before `dial`; handed to the session  |
| `packages/fixture-calls/src/interactive.ts`        | the interactive caller queue and watchdogs                                                    |
| `packages/fixture-calls/src/stt-replay-net.ts`     | `append` for per-turn STT scripts; `pending()` stays honest                                   |
| `apps/api/src/test-call-interactive.ts`            | the in-flight handle registry and its reservation discipline                                  |
| `apps/api/src/routes/test-call-turns.ts`           | `POST /turns`, `POST /hangup`                                                                 |
| `apps/console/features/test-console.tsx`           | shell: pickers, mode, run/hang-up (≤300)                                                      |
| `apps/console/features/test-console-reply.tsx`     | the reply box and caller-script editor                                                        |
| `apps/console/features/test-console-trace.tsx`     | the per-turn trace table and the latency bar                                                  |

---

## TESTS (no network, no vendor host, live flags off)

Every owned test file is wrapped by an egress sentinel from `@winsendotai/ovo-conformance/drivers`. Required named tests, and the **exact prior behaviour each one fails against** — a test that cannot name its true negative does not count:

**P3**

1. `plugin-cache` pinned TTL: render the generic set, advance the injected clock past 300 s, read it back. Against today's `BoundedByteCache` the entry is gone; the test fails with `expected undefined to be defined`.
2. `plugin-cache` pinned eviction: 35 pinned entries plus 300 unpinned writes at `maxEntries: 256`. Against today's `evictToBudget` (`entries.ts:74-80`) the pinned set is evicted; assert all 35 survive and that the 301st unpinned `set` returns `false` rather than evicting one.
3. **Binding identity drift (the load-bearing one):** compose a session for a release, pre-render one clip with `speechBindingFor`, run the session, assert the `clip` event reports `hit` and the TTS was called **zero** times. Then mutate exactly one field of the pre-render binding (`bindingVersion` from the selection fingerprint to `'legacy'`, mirroring `speech-cache-v2.ts:56-59`) and assert the same scenario reports `miss` with a nonzero character count. Both directions, in one file.
4. Policy: a clip text that is not in `approvedSpeechPhrases` reaches `uncachedAudio` and emits `clip` outcome `bypass`. Against the pre-fix `ApprovedSpeechPhrase.purpose` union the `'clip'` phrase does not type-check; against the pre-fix `permits` it returns false for a `response`-kind segment and the test fails on `expected 'bypass' to be 'hit'`.
5. Deadline: a `NormalizedTts` that never resolves, `deadlineMs: 50` → `prepare` rejects `ClipDeadlineError`, the producer's signal is aborted, and `dialOwnedJob`'s observed `control.dial` start is within 5 ms of admission. Against an awaited pre-render the dial is 2 s late and the test fails on the measured delta.
6. Format guard: `prepare` with a format the binding cannot produce rejects `ClipFormatUnsupportedError` with **zero** `NormalizedTts.synthesize` calls, even when the outer caller is bypassed — the S2 spending-guard pattern.
7. Variable gaps: a contact missing one declared variable → `validateClipPreparation` throws `Clip preparation must supply every declared variable`; the dial still proceeds and the session synthesises normally.
8. Locale refine: `AgentConfig` with `language: 'ta-IN'` and a clip at `locale: 'en-IN'` fails to parse with `Clip locale must match the agent language`. Before the refine it parses clean.
9. `spoken-form`: table test pinning `rupeesWords(4850)` → `'four thousand eight hundred and fifty rupees'`, `inWords(123456789)` crore/lakh form, `digitsSpoken('8213')` → `'8 2 1 3'`, `dateWords('2026-10-03','day-first')` → `'the 3rd of October'`, `'month-first'` → `'October 3rd'`, `dayDateWords` → `'Saturday, the 3rd of October'`. Name the `Intl` values the same inputs produce today through `formatValue` — `'₹4,850'` and `'3 October 2026'` — as the pre-fix results.
10. Warm pass: a TTS failing twice then succeeding renders once with 3 attempts; a permanently failing clip leaves `failures` non-empty, the per-locale memo deleted, the worker **unready**, and a second pass retries. Concurrency never exceeds 4 (instrument the synthesize calls).
11. Boot-warm attribution: a boot render emits **no** meter against any call row; a pre-dial render emits one `tts`/`characters` meter with the call's `requestId`. Against a shared sink the boot characters land on the first call and the test fails on the call's character total.
12. Counterfactual: `clip.prepared` carries `charsWouldBillUncached > charsBilled` on a second call with the same contact name, and equality on the first.

**P4**

13. **Subscription coverage:** drive the real `streamEventName` over the recorded event rows of a real fixture call and assert the console's exported subscribed-name set covers every produced name. Against `use-event-stream.ts:38` the assertion fails naming `transcript.user.final` and `audit` as unsubscribed.
14. **Console transcript panel:** render `TestConsoleFeature` against real event rows. Today `transcript` is empty because `field(event,'text')` looks at `payload.text` while the text lives at `payload.event.text`; the test fails with `expected 0 to be 4`.
15. Stage panel from `payload.event.key`; cost panel from `/evidence`, showing `unpriced — no cost ledger on this deployment` with no ledger and a paise figure with one. Assert `costPaise` appears **nowhere** in `apps/console` after the change (a grep test, because a field with no producer is how this bug survived).
16. Terminal marker: the client observes `end` within one 500 ms poll and the server's `activeConnections` returns to 0. Against today's `finishCall` no terminal event is written and the test times out.
17. Fixture audio: `/v1/calls/:id/recordings/:recordingId/audio` returns `audio/wav` for both tracks and the inspector renders two players. Against `call-inspector.tsx:41-45` the panel renders "No recording available" and the test fails on the missing player.
18. Simulation result visible at `/evaluations`; `source=test` selectable in the performance filter.
19. **Interactive turn 2:** submit a typed turn mid-call; a `transcript.user.final` with that exact text reaches the stream and the behavior answers it. Against `child-runtime.ts:152`'s `process.once('message')` the second message is ignored and the test fails with a timeout naming turn 2.
20. **Per-turn STT script:** against today's whole-script-up-front `selectFixtureScripts` an interactive second turn fails with `FixtureMismatchError` naming the unscripted host; after `append` it passes, and `net.assertComplete()` still reports an appended script's unconsumed required step.
21. One turn in flight: a `submit` while the previous reply is unplayed answers 409 `turn_in_flight`.
22. Watchdogs: no `submit` for `idleTimeoutMs` ends the call with `no_input`; `maxCallMs` ends it with `limit`; both asserted from inside the child.
23. **Carrier unreachability, four independent negative controls plus a mutation control.** (a) with a real `TwilioTelephonyControl` installed in the parent, the interactive composition's `get(Cap.carrierControl)` is `undefined` and `all(Cap.carrierControl)` is empty — and **deleting `Cap.carrierControl` from `fixtureParent`'s blocklist makes it fail with the control defined**, proving the test has teeth. (b) an interactive turn that triggers an unscripted fetch records an attempt and the call fails with `EgressBlockedError`. (c) the interactive child forks with `stdio: ['ignore','ignore','ignore','ipc']`, accepts one `start`, refuses a second with `Invalid fixture child request`, and exits. (d) a secret lookup outside the synthetic map throws `fixture_unavailable: live secrets are disabled`.
24. Interactive concurrency: a second interactive start answers 429 `fixture_calls_capacity` while a scripted call still admits to the separate cap of 2.
25. Trace panel: with a fixture-only `route` emitter the tier, confidence and probability columns render; with every real behavior the tier column reads `—` and **no tier is inferred**. Assert that no code path writes a `route` event outside `packages/conformance/src/drivers`.
26. Console e2e: replace the fictional `event: stage` / flat `event: transcript` / `event: cost` frames in `apps/console/e2e/fixtures/console.json:5890-5932` with frames produced by the real `streamEventName`, and update `console.spec.ts:53-54`. Keep the axe pass and the 390 px overflow check green for the new panels.

---

## POST-I1 RULES

- `scripts/baselines/pending/` was deleted by I1. There is no pending baseline for this unit: resolve violations, do not park them. A genuinely unavoidable gate exception needs a dated, named row on the board before merge.
- Every new capability string lives only in `keys.ts`; import `Cap`.
- New packages are not needed. If one is added anyway it must get a `scripts/package-kinds.json` row (`scripts/check-architecture.mjs:83`) and, at kind `vendor-plugin`, a `tests/conformance.test.ts` calling an approved `describe*` (`scripts/check-conformance.mjs:19-27`). Prefer extending `plugin-speech-cache` and `plugin-cache`, which are kind `plugin` and need no kit.
- No new conformance `only:` subset: `scripts/check-conformance.mjs:38-51` allow-lists exactly three files with their exact arrays.
- Modules ≤300 lines (≤250 where the table says so), tests ≤500, every module ≤24 KiB (`scripts/check-module-size.mjs:18-21`).
- `packages/contracts` imports only zod; `packages/behaviors` imports only contracts, runtime, zod, ajv, ajv-formats and `node:*`.
- Do not run `pnpm install`. No git commits.
- **No vendor, carrier or provider endpoint is contacted by any test.** Live flags stay off. H.2 stays `.skip` without a dated founder decision.
- Done = scoped lint (seven gates), typecheck, tests green, console build and console e2e green.

---

## Acceptance

- A generic clip rendered at worker boot is still served from the cache after 20 minutes and after 300 unrelated cache writes; the `clip` event reports `hit` with `prepared: true` and the TTS was not called.
- A per-contact variable clip is rendered between dial admission and answer without delaying the dial by more than 5 ms, and a reply whose text matches it plays from the cache. When the renderer misses its deadline the call proceeds and the session synthesises normally.
- Exactly one function builds the speech binding identity. Mutating any one of its twelve hashed fields turns a pre-rendered hit into a measured miss, and a test proves both directions.
- `rupeesWords`, `inWords`, `digitsSpoken`, `dateWords` and `dayDateWords` produce the spoken Indian forms, are reachable from announcement templates through `x-ovo-format`, and the display forms are unchanged.
- `Cap.templatedClip` exists with a process-scoped spec, and `Cap.decision`, `Cap.humanHandoff` and `Cap.templatedClip` all resolve to their interfaces instead of `unknown`.
- `AgentConfig` refuses duplicate clip ids and a clip whose locale is not the agent's language.
- Clip synthesis is metered as ordinary `tts`/`characters` spend with a `requestId`; boot renders are attributed to the process and never to a call; a `clip.prepared` event carries the uncached-character counterfactual.
- An operator at `/agents/:id/test` can start a call, type a caller turn, see that text appear as a final user transcript, see the agent's reply text, play the agent's audio track, see the resolved plugin selections and `sttMode`, see a per-turn latency breakdown scored against the §5 targets, and see the call's paise where the deployment has a cost ledger — and sees a stated reason where it does not.
- Every SSE name the API emits is subscribed by the console, proven against the real `streamEventName` rather than a mock; `costPaise` appears nowhere; the stream terminates on an `end` event and the connection closes.
- The routing-tier column renders from a `route` event when one exists and reads `—` otherwise. No tier is inferred from timing, and no production code path emits a `route` event.
- A test call is still structurally incapable of reaching a carrier: the four layers of §G.5 are intact on the interactive path, each is pinned by an independent negative control, and the `fixtureParent` control fails when its blocklist is weakened.
- Scoped lint, typecheck, tests, the console build and the console e2e suite are green, and the e2e fixtures encode the real event contract.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/contracts packages/plugin-cache packages/plugin-speech-cache packages/fixture-calls packages/behaviors apps/worker apps/api apps/console`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/contracts packages/plugin-cache packages/plugin-speech-cache packages/fixture-calls packages/behaviors apps/worker apps/api apps/console`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/contracts packages/plugin-cache packages/plugin-speech-cache packages/fixture-calls packages/behaviors packages/distribution apps/worker apps/api --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm --filter @winsendotai/ovo-console build && pnpm test:console:e2e`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm --filter @winsendotai/ovo-worker build && pnpm --filter @winsendotai/ovo-api build`

## Known gaps this unit names and does not close

- **No durable clip tier.** `BoundedByteCache` is process-local, so each worker renders the generic set once per boot and a re-queued contact loses its per-contact clips. A blob-backed second tier behind `ByteCache` in `packages/plugin-storage` is the fix and is a separate unit.
- **No clip addressing from a graph.** `ScriptGraph.nodes[].prompt` and `IntentScriptNode.prompt` are bare strings; binding is by rendered-text identity. Attaching a clip id to a node belongs to the intent-graph behavior unit.
- **No `'decision'` usage operation** (`packages/contracts/src/usage.ts:18`), so a decision-model tier will meter as `'inference'` and be indistinguishable from the LLM fallback in the ledger. Roadmap item 1 owns it.
- **No `route` producer.** Roadmap item 2 owns the three routing tiers; this unit only defines and renders their trace.
- **No mic input in the console**, and no real agent voice unless H.2 is founder-approved.
- **Cost ledger remains Postgres-only.** The console states this instead of showing a blank.
- **Reply text in a fixture call is still predicted from config** (`packages/fixture-calls/src/default-script.ts:25`) for the scripted path, and the provider wire is a fixture script on both paths. An interactive turn exercises the real behavior graph and the real serializer, but not a real model, a real STT or a real voice.
