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
