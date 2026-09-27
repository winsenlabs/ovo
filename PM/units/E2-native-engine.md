# Work unit E2-native-engine: OVO native engine rebuilt in plugin-voice: event bus, turn driver with receipt ordering, variables every turn, pipelined TTS with clear ordering, watchdog, latency, text filters; speech cache prepare and decoupling

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [3, 4, 9, 26]

## Owned paths

- packages/plugin-voice/**
- packages/plugin-speech-cache/**
- experiments/voice/** (compile fixes only)
- scripts/baselines/pending/E2.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: rebuild the OVO native engine in place in packages/plugin-voice, adopting Pipecat's ideas in our own TypeScript (no Pipecat, no Python). This fixes:

- #3 (wiring);
- #4: call variables reach only the first turn, so script placeholders throw on STT and DTMF turns;
- #9: play() waits for the carrier mark before the next segment's synthesis starts;
- the #26 max-duration watchdog.

Read docs/architecture/plugin-platform.md (revision 2): section 2.2 (companions and ovo.speech), section 2.4 (the host format adapters: the engine never transcodes STT or TTS), sections 2.5 (evidence and clear ordering), 2.6 (receipt ordering, Behavior hooks) and 2.7, and section 6.

KEEP:

- the epoch scheduler (BoundedSpeechScheduler);
- mark-confirmed evidence;
- PlaybackConversation;
- the manifest id '@winsendotai/ovo-plugin-voice-session-engine' (kind 'engine', provider 'ovo-native'), which HANDOFF engine selection relies on;
- the exports session-host (frozen) imports: createSpeechSchedulerPlugin, createSimulatedSpeechOutputPlugin, VOICE_PLUGIN_IDS and VOICE_SERVICE_KEYS. Grep packages/session-host before changing any export.

F4 left a v2 manifest with companions plus src/engine-v2-adapter.ts over the old engine. Replace it with a native v2 implementation and delete the adapter and turn-policy.ts.

A. Engine manifest (production-plugins.ts; v2)

- requires: ovo.behavior, ovo.speech-scheduler, ovo.media.duplex.
- optional: ovo.stt, ovo.vad, ovo.text-filter, ovo.turn-detector.
- provides: ovo.voice-session-engine.
- companions {'ovo.speech': scheduler id, 'ovo.speech-scheduler': scheduler id, 'ovo.speech-output': streaming output id}.
  - The scheduler plugin provides BOTH ovo.speech (Execution speaks progress through it) and ovo.speech-scheduler.
  - The streaming output requires ovo.tts-streaming and ovo.media.duplex and provides ovo.speech-output.
  - The worker may substitute its speech cache for ovo.speech-output.
- configSchema: {session: SESSION_INPUT_JSON_SCHEMA, engine: {prefetchSegments (default 2, range 0–4), maxPrefetchBytes (262144), markTimeoutMs, maxIngressFrames, maxIngressBytes, maxConcurrentTurns, preSttBufferMs (5000)}}.
- capabilities {turnDetection: ['provider','vad-timeout'], bargeIn true, dtmf true, confirmedPlayback true, ownsProviders false, formats [MULAW_8K, PCM16_8K, PCM16_16K], consumesTurnDetector true}.
- conformance ['engine@1'].
- Keep the row config shape {session, engine} that session-host produces.

B. Modules: ≤250 lines each, in new src/engine/ and src/speech/ folders.

- engine/events.ts: a synchronous, in-order VoiceEventBus. System events (interrupt, vad, stt, dtmf, bot started/stopped) dispatch before control events. An interruption is still scheduler.beginEpoch().
- engine/clock.ts: an injectable Clock.
- engine/ingress.ts:
  - media.onAudio → decode with @winsendotai/ovo-audio to PCM16 for the VAD ONLY;
  - write STT frames in the carrier format; the host STT adapter handles format and frame size;
  - a ring buffer up to preSttBufferMs until the STT session is ready (the worker accepts before STT connects);
  - bounded ingress, with overflow → dispose 'error:ingress_overflow'.
- engine/turn-controller-host.ts:
  - If ctx.maybe('ovo.turn-detector') exists, call create({clock, stt: stt?.capabilities, vad: Boolean(vad), language, mode: session.mode}).
  - Otherwise use engine/fallback-turns.ts (≤80 lines): aggregate finals by segmentId; stop on end-of-turn or utterance-end; barge in on an interim of ≥2 words while the bot speaks; buffer yes/no words during a confirmation segment and release them at bot.stopped.
  - Feed it VoiceEvents: stt; vad (from ovo.vad if present); dtmf; bot.started and bot.stopped with kind = behavior.speechKind?(text) ?? 'response'; and behavior.subscribe?() events mapped to tool.started/settled and confirmation.pending/resolved.
  - On 'force-endpoint', call sttSession.forceEndpoint?.().
- engine/turn-driver.ts:
  - epochs, and behavior.beginTurn(epoch) before each turn;
  - respond or respondStream, with cancel on barge-in;
  - call variables = session.variables merged into EVERY behavior call: the initial input, speech turns and DTMF turns. DTMF passes {...variables, inputEvent: 'dtmf', digits} (#4).
  - onPlayback(receipt) for every segment, with the exact spoken text;
  - RECEIPT ORDERING: before dispatching any user turn, deliver every pending receipt for earlier segments, completed or interrupted;
  - an idle decision speaks the idle prompt (kind 'idle-prompt'); a final idle → dispose('caller_idle').
- engine/watchdog.ts: session.maxCallSeconds → dispose('max_duration') (#26).
- engine/latency.ts: per-turn timing events (vad_stop_wait, stt_finalize, turn_decision, behavior_first_segment, llm_ttfb when reported, text_aggregation, tts_ttfb, carrier_first_audio, playout_ack, bargein_latency) whose parts sum to the total.
- engine/session-engine.ts: wiring only, implementing contracts VoiceSessionEngine v2.
  - start;
  - dispose(reason, {deadlineMs: 2000}): idempotent, closes media first (the host has already marked the route terminating);
  - ended, subscribe and ingressStats;
  - EngineEvents: speech, user.transcript, user.turn, agent.transcript generated/played/interrupted, timing, interrupt and end.
- speech/prefetch.ts plus the scheduler.ts and media-output.ts changes (#9):
  - SpeechOutput.prepare?(segment, signal) is in contracts. BoundedSpeechScheduler.pump calls it for the next prefetchSegments queued entries of the same epoch (≤ maxPrefetchBytes).
  - The streaming output synthesizes ahead into bounded buffers.
  - Sending segment N+1 begins once segment N's audio is fully SENT; it does not wait for N's mark.
  - Every segment still sends its own mark, and its receipt resolves only on that mark or its timeout.
  - An epoch change aborts every prefetch (a per-segment AbortController).
  - Use tts.open() when capabilities.incrementalText is set; otherwise synthesize(). Always request the carrier format; the host adapter transcodes.
- Evidence (media-output.ts):
  - 'carrier-played' → confirmed;
  - 'carrier-processed' or 'none' → estimated, UNLESS session.acknowledgements includes 'weak-playback-evidence', in which case confirmed with evidenceSource 'carrier-processed';
  - a mark timeout → estimated.
  - CLEAR ORDERING: on interrupt, cancel pending marks BEFORE sending clear. Ignore any played echo for a cancelled mark, so a flushed mark never completes a receipt. When media.clearFlushesMarkers is 'unknown', synthesize 'cleared'.
- scheduler.ts: SpeechKindV2 ('confirmation', 'disclosure', 'idle-prompt').
- speech/text-filters.ts: apply the ctx.all('ovo.text-filter') plugins in order before TTS; receipts carry the exact filtered text. Export two v2 text-filter plugins from this package, both kind 'text-filter' and provider 'ovo': '@winsendotai/ovo-text-filter-markdown' (strips markdown) and '@winsendotai/ovo-text-filter-url' (spells out URLs and emails). The existing plugin-voice catalog entry already covers them.
- plugin-speech-cache:
  - HybridSpeechOutput implements prepare(): a hit is a no-op; a miss prefetches and stores.
  - Keys use TextToSpeech.cacheIdentity.
  - Remove the plugin→plugin edges: declare a local structural ByteCache interface instead of importing @winsendotai/ovo-plugin-cache, and import SpeechKind, SpeechSegment, SpeechOutput and SpeechOutputResult from @winsendotai/ovo-contracts instead of plugin-voice.
- Delete src/turn-policy.ts, the old engine internals and src/engine-v2-adapter.ts. Split src/session-engine.ts (340 canonical lines) away.
- experiments/voice: compile fixes only, for imports you removed.

C. Tests

- Rewrite packages/plugin-voice/src/production-media.test.ts (491 lines) into tests/*.test.ts files under 500 lines each.
- tests/conformance.test.ts runs describeEngine (fakeTurnDetector plus the fallback path), including the companions/ovo.speech, receipt-ordering and clear-ordering scenarios.
- Pipelining: a fake TTS with a scripted firstByteMs and the fake carrier driver. The gap between segment 1's last sent byte and segment 2's first sent byte is ≤ one 20 ms frame. An epoch cancel aborts prefetches, and receipts still wait for marks.
- Variables reach a DTMF turn and an STT turn (script placeholders do not throw).
- The watchdog ends with max_duration.
- Evidence mapping for all three carrier levels, with and without the acknowledgement, and a flushed-mark echo after clear never completes a receipt.
- Latency parts sum to the total.
- The text-filter order is applied, and receipts carry the filtered text.
- Speech-cache prepare.
- If the HANDOFF worker tests (apps/worker/tests/production-engine-selection, native-extension-pins, session-recording) or apps/api/tests/voice-engine-release break because of your changes, fix it on your side by keeping compatible exports. You do not own those tests.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen (contracts, runtime, sdk, kits, conformance, session-host, distribution, scripts, top-level baselines, configs, lockfile, other package.json files).
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it in your report.
- Transitional violations go only in scripts/baselines/pending/E2.json, with a reason and removeBy 'I1'.
- Done = scoped lint, scoped typecheck and your vitest paths are green, without knowingly breaking other scopes.

CONSTRAINTS:

- Engines never read ovo.execution or tool connectors; the runtime enforces this.
- Import only contracts, runtime, sdk, audio and plugin-kit. plugin-turns and plugin-vad are reached only through ctx.
- Preserve write-confirmation and unknown-outcome protection. A mark is never proof a human heard the audio: never upgrade evidence without the acknowledgement.
- Modules ≤300 lines.
- No live calls. No git commits.

## Acceptance

- turn-policy.ts and the F4 adapter are deleted. The engine implements contracts VoiceSessionEngine v2 natively, declares companions providing ovo.speech, ovo.speech-scheduler and ovo.speech-output, and passes describeEngine.
- Variables reach every behavior call, including DTMF and STT turns (#4 test). Receipt ordering holds: a 'yes' said during the confirmation prompt reaches the behavior only after that prompt's receipt.
- The pipelining test shows segment N+1 starting within one frame of segment N's last byte, while each receipt still resolves on its own mark (#9). Pending marks are cancelled before clear, and flushed echoes never complete a receipt.
- The engine works with an ovo.turn-detector plugin and with the built-in fallback, and it calls forceEndpoint on a force-endpoint decision.
- The max-duration watchdog disposes with max_duration. dispose is bounded (2 s) and idempotent. Receipt evidence follows section 2.5.
- plugin-speech-cache implements prepare() and no longer imports plugin-cache or plugin-voice (its architecture baseline entries go stale).
- No plugin-voice module exceeds 300 lines. Scoped lint, typecheck and tests are green, and experiments/voice still compiles.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-voice packages/plugin-speech-cache experiments/voice`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-voice packages/plugin-speech-cache experiments/voice packages/session-host apps/worker`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-voice packages/plugin-speech-cache --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run apps/api/tests/voice-engine-release.test.ts apps/worker/tests/production-engine-selection.test.ts apps/worker/tests/native-extension-pins.test.ts apps/worker/tests/session-recording.test.ts --reporter=dot`

## Checker note (2026-09-25)

- The native v2 engine now runs directly from `src/engine/`; the F4 adapter and `src/turn-policy.ts` are deleted. The spec also says to delete the old engine internals, but frozen worker and plugin-media tests still construct the exported v1 `VoiceSessionEngine` and its old factory. Its compatibility path remains, split into `legacy-session-ingress.ts` and `legacy-turn-policy.ts`, while the production v2 catalog selects only the native engine. I1 owns removal when those callers migrate.
- The instruction that `HybridSpeechOutput` implement `prepare()` points to a private class in `apps/worker/src/speech-cache-runtime.ts`, which design §15.5 assigns to D1 and freezes for E2. E2 implements and tests `prepare()` on its owned `CachedSpeechOutput`; D1 must wire preparation in the worker hybrid output before calling the live cache path pipelined.
- The spec asks for `@winsendotai/ovo-audio` in VAD ingress and contracts imports in `plugin-speech-cache`, but their package manifests omit those dependencies while §15.2 freezes the lockfile and forbids install. E2 uses a relative import of the existing audio decoder and type-only relative contracts imports. The source has no plugin-to-plugin imports; I1 must add the two manifest dependencies, update the lockfile, and replace the relative paths when the lockfile opens.
- Frozen contracts type `SpeechSegment.kind` and `Speech.speak` with three v1 kinds although §2.7 requires confirmation, disclosure and idle-prompt. E2 uses a local structural cast so those v2 values reach the turn controller; I1 owns widening the contracts. The stale speech-cache manifest dependencies on plugin-cache and plugin-voice, and their now-stale architecture baseline entries, also belong to I1.
- The latency requirement names a `total` timing event, but frozen `StageKey` and the frozen conformance kit reject `total`. E2 computes total internally and verifies that emitted stage durations sum to the elapsed span; I1 must add `total` to the contract and conformance kit before it can be emitted. `llm_ttfb` is measured at the first streamed behavior segment because the frozen Behavior port does not expose a separate provider-token timestamp.
- The host passes engine selection config into the engine row but an empty output companion row. E2 forwards `maxPrefetchBytes` and `markTimeoutMs` through its owned scheduler/output port when the engine starts, so no frozen session-host edit is needed for those limits.

## Checker note (2026-09-26)

- `apps/worker/src/speech-cache-v2.ts` is a D1-owned host output override. It has no `prepare()`, so E2 now enables concurrent scheduler plays only for outputs with that method; cache-enabled v2 sessions remain serial until D1 adds bounded prefetch and ordered carrier sends. The host override keeps one active output per epoch, and `CachedMediaAudioPlayer` has no shared send tail. E2's multi-chunk deferred-send test proves the native output does not interleave segments; D1 must add the corresponding cache-enabled production test.
- D1 also owns receipt parity in that override: `CachedMediaAudioPlayer.waitForMark()` treats a timeout as interrupted instead of completed with estimated evidence, and carrier-processed playback with the release's `weak-playback-evidence` acknowledgement never becomes confirmed. D1 must test both paths through the cache-enabled live graph and preserve the clear-before-mark fence.

## Builder review loop (2026-09-26)

The independent review reproduced and the owned-path fixes now refute these failures:

| Broken path                                               | Failing regression before the fix                                                                              | Construction after the fix                                                                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider startup ignores cancellation                     | Four startup probes: `expected 'pending' to be 'rejected'`                                                     | Ingress owns settlement; disposal rejects startup and cancels a provider session that arrives later.                                                                                            |
| Cached preparations survive abort, rejection or interrupt | Retry raises the stale `AbortError`; cancellation counts are `0` instead of `1`                                | Abort-aware entries are removed on abandonment and play cleans them in `finally`.                                                                                                               |
| Incremental TTS push/flush throws after opening           | Both cases: close count `0` instead of `1`                                                                     | The acquired incremental session is closed by the same `finally` covering push, flush and iteration.                                                                                            |
| Response overlaps a confirmation                          | Two user-turn events before playback, expected zero                                                            | Confirmation/disclosure protects the whole overlapping playback group until all receipts settle; stale epochs cannot change the current group. The reverse ordering is a positive guard.        |
| Disclosure reaches fallback input                         | One interrupt, expected zero                                                                                   | Disclosure clears pending speech text and discards STT without buffering.                                                                                                                       |
| Detector disposal/unsubscribe throws                      | `detector failed` / `detector unsubscribe failed` escapes instead of an error outcome                          | Every cleanup is attempted within the deadline; speech evidence stays subscribed until scheduler cancellation has emitted terminal phases.                                                      |
| Receipt fails while the behavior stream waits             | Undefined end reason instead of `error:turn`, plus unhandled `TTS provider failed` / `receipt delivery failed` | Receipt rejection immediately stops the driver and aborts its iterator before dropping the tracked receipt. Independent execution observed `unhandled=[]` and failed end before stream release. |
| Arbitrary carrier chunks reach strict VAD                 | `expected 160/320 PCM samples per 20ms frame`; a single short pulse incorrectly starts speech                  | A bounded VAD-only assembler preserves split PCM bytes and exact analyzer frames; consecutive frame counts apply start/stop durations. Original STT chunks are unchanged.                       |
| VAD stop overtakes its audio                              | Operations `['force-endpoint', 'audio:320']`                                                                   | Original audio is enqueued before synchronous VAD callbacks; independent result is `['audio:320', 'force-endpoint']`.                                                                           |
| Markdown strips address characters                        | `username` / `resettoken` / `alice` replace `user_name` / `reset_token` / `~alice`                             | URL/email spans retain their literal punctuation while surrounding markdown is stripped.                                                                                                        |

The timing fixture now supplies actual 20ms speech and silence frames for its 20ms duration thresholds. Its previous one-sample input did not satisfy the declared 1ms threshold. Final focused E2 plus worker/API compatibility command: 135 passed. Independent reviewer: no remaining concrete blocker in the reviewed owned-path delta; conformance plus disposal 47/47, regression batch 21/21, and VAD/ingress/pipeline/playback-state batch 26/26.

## Pending API caller ownership decision (2026-09-26)

The latest checker ruling supersedes the earlier proposal to edit frozen
`packages/session-host/src/normalize.ts`. That file and its interfaces remain
unchanged. E2 must retain its required default markdown registration.

The real API publication path calls the normalizer before any E2-owned callback.
The normalizer shallow-copies `voice` and pushes the installed default into the
source draft's shared `textFilters`; storage correctly rejects the changed source
as `draft_conflict`. The minimal local boundary repair is
`normalizeAgentConfig(structuredClone(agent.config), ...)` in the I1-owned
`apps/api/src/release-selections.ts`. A shared-touchpoint ruling for that single
caller is pending. The proposed patch is outside the repository and the working
API file is restored. I1 also inherits the general normalizer input-immutability
gap for other callers.

The new owned `packages/plugin-voice/tests/release-normalization.test.ts` executes
`buildManagementApi` + `app.inject` against SQLite. It requires unchanged loaded
and durable drafts, HTTP 201, and the native engine plus markdown selection. The
current code fails because the source filter array changes. With only the proposed
caller clone temporarily applied, the exact combined API command passes
**71 passed / 10 skipped**. The API file was restored afterward.

Current normal commands and complete evidence are in
[`packages/plugin-voice/README.md`](../../packages/plugin-voice/README.md).
Scoped lint and full format both exit 0; standalone duplication, full typecheck,
and normal build exit 0. The default suite is **1,361 passed / 138 skipped /
8 failed** (1,507 total): seven existing publication failures and the new
immutability regression for the same defect. No aliases or suppressed tests are
used. E2 remains **In progress**, not Built; its full green bar, including the
Postgres serial run, remains required after the ownership decision.

## Checker note (2026-09-27): API caller clone approved

The checker approved the single `structuredClone(agent.config)` argument in
`apps/api/src/release-selections.ts`, together with E2's existing real API/SQLite
immutability regression. The unit specification requires registering the default
markdown filter but does not own this API caller; that required edit is now a
minimal shared touchpoint inherited by I1. `apps/**` is not on design §15.2's
frozen list: the earlier stop was an ownership question, not a frozen-path one.
No frozen normalizer or interface is changed.

**BLOCKING I1 contract gap:** `normalizeAgentConfig` mutates its input. This clone
protects one caller, but the source draft mutation and seven HTTP 409 publication
failures remain reachable for future callers. I1 must fix and directly regress
normalizer input immutability, rather than collecting caller clones. This is
recorded as blocking on the board.

The branch was rebased onto foundation `a63daec`, preserving the latest M1/D1
migration allocation and paused heads. Full normal verification is being rerun;
the failed baseline counts above describe the code before this approved repair.
