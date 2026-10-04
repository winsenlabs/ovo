# Work unit S1-speech-split: Split plugin-providers into Deepgram STT, OpenAI TTS and OpenAI LLM v2 plugin packages, with native formats only, Deepgram usage fix, meters.when and fixture templates

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [21, 27]

## Owned paths

- packages/plugin-providers/**
- packages/plugin-inference/**
- packages/plugin-stt-deepgram/**
- packages/plugin-tts-openai/**
- packages/plugin-llm-openai/**
- scripts/baselines/pending/S1.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: turn the hardwired Deepgram and OpenAI providers into ordinary v2 plugin packages, selected per agent, and fix their known bugs. Read docs/architecture/plugin-platform.md (revision 2): sections 2.3–2.4 (plugins declare NATIVE formats only; session-host's format adapters transcode), section 3 and section 9.

What already exists and is frozen:

- the v2 contracts (SpeechToText, SttSession, SttEvent, TextToSpeech, UsageMeter, NetPort, FixtureTemplate);
- plugin-kit (openProviderSocket, httpJson, sseReader, abort helpers and AiSdkInference, which F2 moved there);
- @winsendotai/ovo-audio.
  Plugins get credentials via ctx.secret('/credentialRef'), binding config via row config 'binding', and network ONLY via ctx.net. The gate forbids ws and node:https here. Usage goes to the onUsage sink exactly once, always with a requestId.

F3 created the skeletons packages/plugin-stt-deepgram, plugin-tts-openai and plugin-llm-openai (the LLM one depends on @ai-sdk/openai 4.0.71 and ai 7.0.107) with catalog entries. Fill them and remove the ovo.skeleton flags. The distribution legacy bridges have the SAME plugin ids and are superseded automatically by the loader's same-id rule. Do NOT edit distribution or plugin-kit; I1 deletes the bridges.

A. packages/plugin-stt-deepgram. Move deepgram.ts, deepgram-session.ts and deepgram-transport.ts from plugin-providers.

- v2 plugin: id '@winsendotai/ovo-provider-deepgram-stt' (KEEP), kind 'stt', provider 'deepgram', session scope, provides ['ovo.stt'].
- bindingSchema {model (default 'nova-3'), language?, endpointingMs?, utteranceEndMs (default 1000), keyterms?}.
- capabilities:
  - inputFormats [MULAW_8K, PCM16_8K, PCM16_16K];
  - languages per model (hi, en-IN, multi, …); mark Tamil and Telugu UNCONFIRMED and exclude them;
  - interim true, wordTimestamps true, turnSignals ['speech-start','end-of-turn','utterance-end'], forceEndpoint true, ttfsP99Ms 350.
- meters [{key: 'deepgram.streaming-stt.audio_seconds', unit: 'audio_seconds', role: 'stt'}]; egressHosts ['api.deepgram.com']; conformance ['stt@1'].
- Behavior:
  - wss://api.deepgram.com/v1/listen with Authorization: Token <key>;
  - query: encoding and sample_rate from the requested native format (mulaw or linear16), interim_results=true, vad_events=true, utterance_end_ms, punctuate, smart_format;
  - Results with is_final false → interim for the current segment; is_final true → final, after which the segmentId advances; speech_final → end-of-turn; UtteranceEnd → utterance-end; SpeechStarted → speech-start;
  - forceEndpoint sends {type: 'Finalize'} (results carry from_finalize); KeepAlive every 5 s; finish sends {type: 'CloseStream'} and waits for Metadata.
- USAGE FIX: reconciled usage comes ONLY from the final Metadata.duration, with requestId = metadata.request_id. If the socket fails or closes before Metadata, emit an estimated usage from bytes written / bytesPerSecond(format). Never take Math.max over Results durations (the bug at deepgram-session.ts:153-158).
- fixtureTemplates['@winsendotai/ovo-provider-deepgram-stt']: renders each caller 'say' as doc-faithful Results messages (interims, then is_final, then is_final + speech_final), plus UtteranceEnd and SpeechStarted, and closes with Metadata.
- Fixtures (doc-faithful, https://developers.deepgram.com/docs/understanding-end-of-speech-detection):
  - interim → is_final (no speech_final) → is_final + speech_final;
  - interim → is_final → UtteranceEnd without speech_final;
  - SpeechStarted;
  - Finalize → from_finalize;
  - CloseStream → Metadata;
  - an abrupt 1011 before Metadata → estimated usage.
- Move tests/deepgram.test.ts and tests/tls.ts, adapted to FixtureNet.

B. packages/plugin-tts-openai. Move openai-tts.ts, and openai-transcription.ts as a separate batch-STT manifest if anything still uses it.

- v2 plugin: id '@winsendotai/ovo-provider-openai-tts' (KEEP), kind 'tts', provider 'openai', provides ['ovo.tts-streaming'].
- bindingSchema {model: 'gpt-4o-mini-tts' | 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts-2025-12-15', voice, instructions?, speed?}.
- capabilities: outputFormats [PCM16_24K] ONLY, languages ['*'], incrementalText false, maxChars 4096. The plugin NEVER resamples; the session-host TTS adapter converts to the carrier format with the polyphase resampler (#27a).
- meters:
  - {key: 'openai.streaming-tts.characters', unit: 'characters', role: 'tts', when: {field: 'model', in: ['tts-1','tts-1-hd']}};
  - 'openai.streaming-tts.input_tokens' and 'openai.streaming-tts.audio_output_tokens' with when model in the gpt-4o-mini-tts variants.
- egressHosts ['api.openai.com'].
- Behavior: POST /v1/audio/speech.
  - For gpt-4o-mini-tts use stream_format 'sse': parse speech.audio.delta (base64 PCM 24k); speech.audio.done usage → reconciled token usage.
  - For tts-1*: the raw chunked pcm body, with estimated character usage.
  - Handle odd-byte chunk boundaries.
  - cacheIdentity(format, voice) returns revision 'openai-tts-mulaw-8000-v1' when format is MULAW_8K (it is called with the requested format), so cache keys stay stable.
- fixtureTemplates: renders SSE deltas (or a chunked pcm body) for each agent text, sized to the text.
- Fixtures: a chunked PCM body with an odd-byte split; SSE deltas plus done{usage}; 429 and 500.

C. packages/plugin-llm-openai

- v2 plugin: id '@winsendotai/ovo-provider-openai-inference' (KEEP), kind 'llm', provider 'openai', provides ['ovo.inference'].
- bindingSchema {model, temperature?, maxOutputTokens?}; capabilities {tools: true, streaming: true}.
- meters: the existing openai.inference.* keys used by the cost runtime and price cards. egressHosts ['api.openai.com'].
- Implementation: create the AI SDK model from @ai-sdk/openai (moved out of plugin-providers) with fetch bound to ctx.net.fetch, and wrap it with plugin-kit's AiSdkInference. Inference exposes provider and model, and token usage flows to the usage sink.
- fixtureTemplates: renders the provider HTTP streaming response that this @ai-sdk/openai version actually requests (check which OpenAI API it calls). On the first user turn it calls the agent's first write tool with schema-valid input, then answers in text. It must work with the real AiSdkInference under FixtureNet.

D. Façades and removal

- packages/plugin-providers becomes a re-export façade: the old factory names and binding parsers delegate to the new packages, kept only for remaining imports (for example the distribution legacy bridges). The legacy kind is not edge-checked. I1 deletes it.
- Delete plugin-providers/src/audio.ts (the box filter), and re-export from @winsendotai/ovo-audio if something still imports it.
- packages/plugin-inference keeps the simulated inference exports session-host uses (stable names). src/ai-sdk.ts stays a re-export of plugin-kit.

TESTS:

- tests/conformance.test.ts in each new package runs describeSpeechToText, describeTextToSpeech or describeInference with FixtureNet scripts and the templates. src/testing.ts exports fixtures and fixtureTemplates, and index.ts re-exports them.
- A Deepgram usage test: estimated, not reconciled, when the socket dies before Metadata.
- An OpenAI TTS 6 kHz alias test through the real output path: wrap the plugin with the session-host TTS format adapter (frozen; import it in the test), request MULAW_8K, and check ≥60 dB attenuation.
- The LLM template drives a tool call through AiSdkInference.
- The existing plugin-providers tests are moved and adapted.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen (distribution, plugin-kit, session-host, lockfile).
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional duplication goes in scripts/baselines/pending/S1.json with removeBy 'I1'.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- New packages import only contracts, runtime, sdk, plugin-kit, audio and third-party (@ai-sdk/openai, ai). No other plugin packages. No ws or node:https.
- No real provider traffic; live flags stay off.
- Modules ≤300 lines. No git commits.

## Acceptance

- Three new v2 plugin packages keep the existing plugin ids, supersede the legacy bridges in the loaded catalog, drop the skeleton flag, and pass their conformance kits with FixtureNet scripts and fixture templates.
- Deepgram emits end-of-turn on speech_final, utterance-end on UtteranceEnd and speech-start on SpeechStarted, sends Finalize on forceEndpoint, and reports reconciled usage only from Metadata (estimated on an abrupt close).
- OpenAI TTS declares only PCM16_24K and never resamples. The alias test through the host TTS adapter passes (≥60 dB). SSE token usage is used for gpt-4o-mini-tts, meters use when by model, and the MULAW_8K cache identity is unchanged.
- The OpenAI LLM plugin exposes provider and model, emits token usage, and its fixture template drives a tool call through AiSdkInference.
- plugin-providers is only a façade and the box filter is deleted. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-stt-deepgram packages/plugin-tts-openai packages/plugin-llm-openai packages/plugin-providers packages/plugin-inference`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-stt-deepgram packages/plugin-tts-openai packages/plugin-llm-openai packages/plugin-providers packages/plugin-inference packages/distribution packages/session-host`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-stt-deepgram packages/plugin-tts-openai packages/plugin-llm-openai packages/plugin-providers packages/plugin-inference packages/distribution --reporter=dot`

## Checker note — 2026-09-25

The frozen `session-host/src/select-session-graph.ts` writes a selected binding credential as
root `{ credentialRef: { credentialId } }`, while the earlier S1 fixture shape nested that
object under `credentialRef`. Calling `ctx.secret('/credentialRef')` unconditionally fails
on the production selection path with `config /credentialRef holds no {credentialRef}`.
The three S1 providers therefore call guarded `ctx.secret('')` for the host's root shape
and retain `ctx.secret('/credentialRef')` for the nested fixture shape. The manifest
marks the root as secret-bearing so release compatibility checks accept the host shape.
Both paths resolve
through the host secret resolver; no plugin reads a raw credential or changes the frozen
session host. I1 owns normalizing the binding config shape and then removing this local
compatibility branch.

The API's legacy release fixture stores `api: 'responses'` in an OpenAI LLM binding.
S1 accepts only that value as a transitional binding field; `chat` fails closed because
the v2 provider constructs a Responses model. I1 owns removal or migration of the
legacy `api` field.
The legacy inference factory also refuses a stored `api: 'chat'` binding before
provider egress: routing it through Responses would silently change API semantics.
The helper now forwards the old `instructions` config and its one combined usage
callback, including `modelId`, while retaining the v2 per-meter usage sink.

The frozen worker session-graph runtime still appends `workspaceId`, `bindingId`, and
`updatedAt` to selected provider rows for the old bridges. S1's v2 config schemas
accept those three immutable metadata fields while ignoring them at execution.
I1 owns removing that bridge-only row augmentation after the bridges are deleted.

The legacy `plugin-providers` factories now delegate to the new provider classes
with the kit's STT shim and a local TTS adapter over the frozen host format adapter.
The old WebSocket, TTS resampler, SDK model
factory, and box-filter implementations were removed; the loader supersedes the
frozen distribution bridges in the production catalog. A bypassed bridge has no
host NetPort and fails loudly if it attempts provider traffic. Batch transcription was moved into
`plugin-tts-openai/src/batch.ts` and stays a separate, unregistered v1 capability:
the frozen contracts and catalog define no v2 batch-STT slot. I1 owns the batch
contract/catalog decision and deletion of the transitional façade and bridges.

The v1 `ovo.tts-streaming` service requests 8 kHz mu-law, and v1 `ovo.tts`
expects a `Promise<{audio,usage}>`; forwarding the native PCM16 provider directly
failed both contracts. The local `plugin-providers/src/legacy-tts.ts` façade uses
the frozen host format adapter for these two transitional ports, retains the
legacy binding and response bounds, and forwards native token meter units without
casting them to characters. I1 removes this adapter with the façade after the
legacy consumers and bridges are gone.
For PCM16 legacy output, the adapter splits on even byte boundaries, including
when the configured maximum chunk size is odd, preserving whole samples.

## Merge review correction — 2026-09-26

Independent pre-handover review found that two OpenAI syntheses in the same call
both used fallback request ID `openai:<session>:1` when no response header was
available. The production worker deduplicates usage by request ID, so it could
silently drop a later request's meter. Repeated starts on one Deepgram provider
had the same public-interface defect, although the current engine starts STT once.

Both providers now allocate an increasing request number on the provider instance
before asynchronous dispatch. Each Deepgram session retains its allocated ID for
both missing-Metadata and missing-`request_id` fallbacks. Actual provider IDs remain
authoritative; OpenAI reads the header before rejecting an HTTP error response.
No frozen contract or shared implementation changed. Later fallback usage keys
are intentionally distinct; previously omitted usage is not backfilled.

True negatives ran against the uncorrected S1 production implementation on local
merge `3ccd620` (the affected files were identical to `5af06a4`): the three TTS
headerless-success/HTTP-failure/transport-failure cases and two Deepgram
abrupt-close/missing-Metadata-ID cases each failed `expected 1 to be 2` because
only one distinct request ID represented two actual requests. A sixth test failed
with expected `provider-failed-request`, received `openai:same-call:1`, proving
that a returned provider ID was lost on HTTP failure. All tests invoke the actual
owned provider classes; Deepgram uses FixtureNet and FakeClock, and TTS supplies
responses through the actual NetPort input. No missing-export or selector failure
is counted as proof.

## Merge verification — 2026-09-26

Code merge `e2c7cc5` passed the complete normal gate with Node 22. The independent
reviewer's six request-correlation regressions passed separately (exit 0), and
no additional blocker was found. S1 is Built — awaiting checker verification.

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node scripts/lint.mjs --only packages/plugin-stt-deepgram packages/plugin-tts-openai packages/plugin-llm-openai packages/plugin-providers packages/plugin-inference
node scripts/check-duplication.mjs
pnpm check
OVO_TEST_POSTGRES_URL=postgres://postgres:ovo@127.0.0.1:32897/ovo pnpm exec vitest run --no-file-parallelism --reporter=dot
```

Each command exited **0**. The `pnpm check` command includes full lint (seven
gates), **full `pnpm format:check` exit 0**, typecheck, default tests, all three
application bundles, console production build, audit and the newly required
console E2E suite. Scoped lint and full formatting are reported together;
standalone duplication also passed (758 source files, 57 existing pairs).
No baseline was changed.

- Default: **1,199 passed / 138 skipped**.
- Postgres serial: **1,328 passed / 9 skipped / 0 failed**.
- Playwright: **41 passed / 1 skipped**, only the invisible desktop Menu trigger.
- Arithmetic: `1199 + 138 = 1337` and `1328 + 9 = 1337`; 129 tests are database-gated.

The Postgres 17.6 container was bound only to 127.0.0.1 and removed after the run.
No live provider traffic, AWS operation, push or PR change was performed. This
verification record is documentation added after the tested merge code tree.

## Checker verdict and shared correction — 2026-09-27

The checker **Verified `e2c7cc5`**: independent/mixed selection of all three
providers passed, defect 21 is closed, and all six behavioral true negatives
reproduced. E1 was separately Verified at `ac8661d`.

A later cross-unit defect is assigned to the S1 integration builder for immediate
repair: `deriveLegacySelections` discarded the already-loaded binding snapshot,
so OpenAI TTS's conditional meters disappeared on legacy releases. The checker
explicitly authorized passing that snapshot through in plugin-storage and adding
the absent-snapshot case in session-host tests. The minimal shared touchpoints
are `packages/plugin-storage/src/legacy-selections.ts`, its storage regression,
`packages/session-host/tests/selections.test.ts` and a production worker cost
admission regression. I1 inherits these tests and must separately make the frozen
`metersFor` implementation fail closed before removing the legacy bridges.
No unconditional fallback meter or frozen production-host edit is authorized.

The root `check` change in S1's merge was the checker's 2026-09-26 U1 instruction,
reconfirmed 2026-09-27: console regressions must run in the repository gate. The
board records this approved §15.2 exception and its cross-unit E2E blast radius.
All new documentation updates are committed separately from code.

## Legacy-meter correction built — 2026-09-27

Code-only commit **`724c0a0`** retains the already-loaded binding in
`deriveLegacySelections`; local adapter input/output types now describe the full
provider binding carried through. There is one behavior-line change. It neither
invents a version/fingerprint nor changes any stored snapshot, price card or
usage row. The frozen host and conditional meter declarations are unchanged.
The preceding board/verdict/exception notes are in documentation-only commit
`98b7196`; this report is also separate from code.

The tests deliberately start without per-selection binding snapshots. The host
matrix takes absent and empty legacy `selections` through reconstruction and
`metersFor` for both model branches, retaining a live LLM meter to expose the
nonempty-result trap. Production admission tests invoke
`ProductionWorkerCostRuntime.reserve` with the real Deepgram STT, OpenAI LLM and
OpenAI TTS manifests. All four TTS models are exercised: `tts-1`, `tts-1-hd`,
`gpt-4o-mini-tts` and `gpt-4o-mini-tts-2025-12-15`. Missing TTS cards must refuse
before any budget lookup/reservation; matching-card legacy and v2 cases admit.
For token-priced models, the positive cases supply no character price card,
so an unconditional fallback meter would fail them.

### Behavioral true negatives and independent measurement

With these tests installed on pre-fix `98b7196`, the normal command was:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pnpm exec vitest run packages/session-host/tests/selections.test.ts packages/plugin-storage/tests/f3-storage.test.ts apps/worker/tests/legacy-cost-meters.test.ts --reporter=dot
```

| Broken version before the one-line fix                                           | Observed failure                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All four real TTS model variants omit TTS cards while STT/LLM remain selected    | Four cases: `expected { admitted: true, …(2) } to match object { admitted: false, …(1) }`; expected reason names the character meter or both native token meters |
| Absent/empty legacy selections lose their conditional neural/basic TTS binding   | Four cases: `expected [ 'llm.tokens' ] to deeply equal [ 'tts.neural', 'llm.tokens' ]` (or `tts.basic`)                                                          |
| Storage reconstruction discards the immutable release's existing provider record | Deep equality fails on the missing `binding` object while the plugin ID and binding ID still match                                                               |

Pre-fix result: **9 failed / 16 passed**, EXIT 1. No import, selector or module
resolution error is counted. After the minimal repair, that exact command passes
**25/25**, EXIT 0. Independent read-only review ran the same three files with
Postgres variables unset and reproduced **25/25**, finding no concrete blocker.
These are complementary reconstruction/admission checks, not real paid-provider
or real-ledger traffic. Existing Postgres tests are covered by the full serial
bar below. Logs: `/tmp/ovo-legacy-meter-{red,green}.log`.

Scoped typecheck, owned-path Prettier, scoped lint/full formatting and standalone
duplication passed with Node 22:

```sh
node scripts/typecheck-scope.mjs packages/plugin-storage packages/session-host/tests/selections.test.ts apps/worker/tests/legacy-cost-meters.test.ts
pnpm exec prettier --check packages/plugin-storage/src/legacy-selections.ts packages/plugin-storage/tests/f3-storage.test.ts packages/session-host/tests/selections.test.ts apps/worker/tests/legacy-cost-meters.test.ts
node scripts/lint.mjs --only packages/plugin-storage packages/session-host/tests/selections.test.ts apps/worker/tests/legacy-cost-meters.test.ts
pnpm format:check
node scripts/check-duplication.mjs
```

**TYPECHECK_EXIT=0, SCOPED_LINT_EXIT=0, FORMAT_EXIT=0, DUPLICATION_EXIT=0.**
No baseline, manifest or lockfile changed. Logs are
`/tmp/ovo-legacy-meter-{typecheck,lint,format,duplication}.log`.

The separate missing-binding/missing-condition/unknown-value fail-closed contract
in frozen `metersFor` remains **BLOCKING I1 before legacy bridge deletion**. It
is not represented by a skipped, expected-failure or incorrectly passing test.
This correction covers the legacy reconstruction path that had discarded a valid
snapshot. Operational effect: releases missing their model's TTS price cards now
refuse admission until published with complete coverage; no persisted value is
rewritten and no fallback meter is added.

### Refreshed full current-foundation bar

The following complete bar ran on code commit **`724c0a0`**, including E2
`007606f`, D1 `043b310` with control migration 006, and the metering correction.
These are current combined-foundation numbers, not the historical S1+E1 totals.

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pnpm check
OVO_TEST_POSTGRES_URL=postgresql://postgres:fixture@127.0.0.1:32904/postgres pnpm exec vitest run --no-file-parallelism --reporter=dot --reporter=json --outputFile=/tmp/ovo-current-foundation-postgres.json
```

- `pnpm check`: **EXIT 0**; full lint (seven gates), full formatting,
  full typecheck, default tests, three application bundles, console production
  build, audit and console E2E all pass.
- Default Vitest: **1,494 passed / 147 skipped / 0 failed**.
- Full Postgres serial: **1,632 passed / 9 skipped / 0 failed**, EXIT 0.
- Playwright: **41 passed / 1 skipped**, only the desktop-hidden Menu trigger.
- Separate sums: **1,494 + 147 = 1,641**. **1,632 + 9 = 1,641**.

The 138 cases activated by Postgres are database-gated. The JSON report confirms
all nine remaining skips: one ledger case needs `LEDGER_TEST_DATABASE_URL`, four
recording cases need `RECORDING_TEST_DATABASE_URL`, three restore cases need
`OVO_BACKUP_DRILL_POSTGRES_URL`, and one worker lifecycle case additionally needs
ElasticMQ. None is disabled; the ElasticMQ case is not a database-only skip.
Logs: `/tmp/ovo-current-foundation-check.log`,
`/tmp/ovo-current-foundation-postgres.log` and the JSON report above.

The disposable loopback-only `postgres:17.6` container
`ovo-meter-foundation-0927` was stopped and removed. Two worktrees remain.
No paused branch, frozen production-host file, baseline or console code changed.
Nothing was pushed and no real provider traffic or AWS operation was performed.
The current-foundation code is handed to the checker for **E2 first**, then D1;
C2 remains unmerged and will refresh on this foundation before its later check.
The subsequent documentation-only commit contains no code changes.
