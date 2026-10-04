# Work unit E1-turns-vad: Turn-detector plugin (Pipecat-style controller, aggregator, min-words, confirmation-safe mute rules, idle, DTMF) and energy VAD plugin

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [3, 18]

## Owned paths

- packages/plugin-turns/**
- packages/plugin-vad/**
- scripts/baselines/pending/E1.json

## Shared touchpoints (minimal edits allowed)

- none

## Checker note (2026-09-25)

The specification below says to emit `force-endpoint` on every `vad.stop`, but the frozen turn-detector conformance kit requires no new endpoint request after a final transcript has already arrived. The checker approved the kit's invariant as authoritative: emit `force-endpoint` on `vad.stop` only while the utterance is still awaiting a final transcript and its speech is not muted. A redundant request can incur provider cost and truncate the next turn. The regression tests assert that a final transcript preceding `vad.stop`, or speech discarded during a tool, causes no immediate or delayed `force-endpoint`. The frozen kit is unchanged; E2 inherits this behavior when it integrates the detector.

## Specification

GOAL: provide the user-turn logic as swappable plugins, so turn-taking no longer depends on one STT vendor's endpointing. This fixes defect #3:

- 'yes', 'ok', 'okay' and 'yeah' were dropped even as answers;
- identical consecutive answers were dropped;
- only speech_final text was kept;
- UtteranceEnd was ignored;
- barge-in was judged only on the first hypothesis.
  It must not lose a spoken confirmation. Read docs/architecture/plugin-platform.md (revision 2): section 2.7 (normative, including the mute-rule table and 'answers are not backchannels') and sections 6.1–6.2.

Contracts already in @winsendotai/ovo-contracts: VoiceEvent, TurnDecision, UserTurnController, TurnDetectorFactory (create({clock, stt?, vad, language, mode, overrides?})), TurnConfigSchema, defaultMuteRules, VadAnalyzer, VadAnalyzerFactory, VadParams, SttEvent, SpeechCapabilities, Clock, countWords, normalizeForMatch, classifyConfirmation, CONFIRM_YES and CONFIRM_NO.

F3 created skeleton packages at packages/plugin-turns and packages/plugin-vad, with catalog entries and dependencies. Fill them and remove the package.json field ovo.skeleton. The native engine (E2) consumes you through ctx.maybe('ovo.turn-detector') and ctx.maybe('ovo.vad'). Do NOT import plugin-voice.

A. packages/plugin-turns: one v2 plugin via sdk definePluginV2.

- id '@winsendotai/ovo-turn-detector-default', kind 'turn-detector', provider 'ovo', scope session, provides ['ovo.turn-detector'], config = TurnConfigSchema (the row config IS the TurnConfig), conformance ['turn@1'].
- The factory's create({clock, stt, vad, language, mode, overrides}) merges row config and overrides. When mute is empty, it uses defaultMuteRules(mode).
  Modules are ≤200 lines each, and every timer goes through the injected Clock:
- controller.ts: ordered start and stop strategy lists, each returning continue, start, stop, reset or stop-chain.
  - The stopTimeoutMs (5000) safety net closes an open turn once the user isn't speaking and nothing has arrived.
  - A turn never stops while the user is speaking (VAD speaking, or a provider speech-start without a speech-end).
  - It emits TurnDecision events.
- aggregator.ts: onFinal(segment) is idempotent on segmentId; an interim for an existing segment id updates only the barge-in view. take() joins finals with spacing rules (no space before punctuation or the danda '।'). NEVER dedupe by text.
- start-vad.ts, start-transcript.ts and start-min-words.ts:
  - While the bot is speaking, fewer than minWordsWhileBotSpeaking words (countWords), or a normalized backchannel → turn.reset with reason 'backchannel': the aggregation is discarded and there is no interrupt.
  - EXCEPTION: between confirmation.pending and confirmation.resolved, text containing a CONFIRM_YES or CONFIRM_NO phrase is never a backchannel. It is aggregated and released at bot.stopped.
  - While the bot is silent, one word starts the turn.
  - Evaluate on EVERY interim, not just the first.
  - Interrupt reasons are 'vad', 'transcript' and 'dtmf'.
- stop-provider.ts: STT 'end-of-turn' or 'utterance-end' stops the turn, if any text exists.
- stop-speech-timeout.ts:
  - On vad.stop, emit 'force-endpoint' and start two timers: userSpeechTimeoutMs, and max(0, (config.sttP99Ms ?? stt.ttfsP99Ms ?? 1000) − vadStopMs).
  - A final transcript cancels the STT wait.
  - Stop when both timers are done, the VAD is quiet, and text exists (waitForTranscript).
- strategies.ts: 'auto' → 'vad-timeout' if a VAD is present, else 'provider'. Throw a clear error if 'provider' is chosen and the STT turnSignals lack both end-of-turn and utterance-end.
- mute.ts, per the section 2.7 table:
  - during-confirmation covers ONLY the window from bot.started{kind:'confirmation'} to its bot.stopped. Inside it there are no interrupts and finals are BUFFERED. At bot.stopped, if classifyConfirmation(buffer) is yes or no, emit turn.stopped with that text; otherwise emit turn.reset with reason 'muted'. The answer window after the prompt is never muted.
  - during-tools: from tool.started to tool.settled, speech is discarded (turn.reset 'muted' if text had started). DTMF is allowed when allowDtmfWhileMuted.
  - always-while-speaking: no barge-in during any bot speech.
  - A 'disclosure' kind is always muted, with no buffering.
  - first-speech and until-first-complete follow Pipecat semantics.
- idle.ts:
  - The timer starts on bot.stopped only when no user turn is open and no tool is in flight. User speech, bot speech or a tool start cancels it.
  - It emits idle{retry, prompt} up to maxRetries, then idle{final: true}.
  - idle null disables it.
- dtmf.ts: interDigitMs 2000 flush, terminator '#', maxDigits 32, interruptOnFirstDigit. It emits turn.stopped{input:{kind:'dtmf', digits}}.
- index.ts exports plugins; testing.ts exports fixtures ({}) for completeness.

B. packages/plugin-vad: a v2 plugin.

- id '@winsendotai/ovo-vad-energy', kind 'vad', provider 'ovo', provides ['ovo.vad'], config = VadParams with defaults confidence 0.7, startMs 200, stopMs 200, minVolume 0.6, smoothing 0.2, conformance ['vad@1'].
- vad-state.ts: a QUIET→STARTING→SPEAKING→STOPPING machine counted in frames (startFrames = round(startMs/frameMs)). A frame counts as speech only if confidence ≥ threshold AND smoothed volume ≥ minVolume. It emits vad.start and vad.stop with times.
- energy-vad.ts: pure TypeScript, 20 ms frames (160 samples at 8 kHz, 320 at 16 kHz).
  - RMS dBFS.
  - An adaptive noise floor: slow rise (τ≈2 s), fast fall (τ≈100 ms).
  - confidence = sigmoid((dB − floor − 9)/3).
  - A zero-crossing-rate gate against hum.
  - Volume normalised over [−110, −10] dB and exponentially smoothed.
- The factory's create(rate) returns a VadAnalyzer.

FIXTURES AND TESTS (FakeClock only, no real timers)

- plugin-turns/tests/regression.test.ts, table-driven, one row each:
  - 'Say yes' then 'yes' while the bot is silent → accepted;
  - 'yes' while the bot speaks a normal response → no interrupt, nothing aggregated;
  - two separate 'yes' turns → both accepted;
  - split finals 'my number is' + '98 45' → one turn with the full text;
  - utterance-end with no end-of-turn → the turn closes;
  - barge-in on the 3rd interim after two backchannels → interrupt;
  - Devanagari 'हाँ' counted as a word;
  - DTMF '1','2','3','#' → one dtmf turn '123';
  - a 2 s DTMF gap → flush;
  - an idle retry, then final;
  - 'yes' spoken while a confirmation-kind segment plays → released as a turn at bot.stopped;
  - 'no that is not correct' during the prompt → released and classifying as no;
  - 'hello' during the prompt → discarded ('muted');
  - 'haan' while a normal response plays with a confirmation pending → aggregated, not dropped;
  - during-tools: speech discarded, DTMF allowed.
- plugin-turns/tests/provider-parity.test.ts: the SAME conversation written as doc-faithful Deepgram (Results is_final/speech_final, UtteranceEnd, SpeechStarted), AssemblyAI v3 (Turn turn_order/end_of_turn) and Sarvam realtime (vad.speech_start/end, transcript.partial/final) SttEvent scripts must produce identical accepted turns. Put the scripts in tests/fixtures with a header line citing the doc URL.
- plugin-vad tests:
  - generated audio from a seeded PRNG (300 ms speech, 150 ms pause, 400 ms speech, 800 ms silence) → exact vad.start and vad.stop frame indices;
  - an 80 ms 'cough' burst → no start;
  - 50 Hz hum → no start;
  - μ-law round-trip of the fixtures behaves the same.
- tests/conformance.test.ts in each package runs describeTurnDetector or describeVad from @winsendotai/ovo-conformance.

WAVE-2 RULES:

- You own only the paths listed. Everything in doc section 15.2 is frozen: contracts, runtime, sdk, plugin-kit, audio, conformance, session-host, distribution, scripts/*.mjs, package-kinds.json, top-level baselines, vitest.config.ts, tsconfig.json, the root package.json, pnpm-lock.yaml and every other package's package.json.
- Do NOT run pnpm install.
- If a frozen contract is insufficient, add a local structural type or adapter in your paths and list it under 'Contract gaps' in your final report.
- Transitional violations go only in scripts/baselines/pending/E1.json, each with a reason and removeBy 'I1'.
- Done = your scoped lint, scoped typecheck and your vitest paths are green. Do not knowingly break other scopes.

CONSTRAINTS:

- Import only contracts, runtime, sdk, audio and plugin-kit.
- Modules ≤300 lines (target ≤200); measure with node scripts/lint.mjs --only.
- No network. No git commits.

## Acceptance

- @winsendotai/ovo-turn-detector-default and @winsendotai/ovo-vad-energy load through the distribution catalog, pass registry v2 validation, and no longer carry the skeleton flag.
- Every regression row passes, including a 'yes' during the confirmation prompt released after it, NO precedence, 'hello' discarded, answers never treated as backchannels while a confirmation is pending, repeated answers both accepted, split finals merged, utterance-end, barge-in on later interims, Devanagari, DTMF, idle and during-tools.
- The Deepgram, AssemblyAI and Sarvam scripts of the same conversation produce identical accepted turns.
- The VAD transition frame indices match exactly, and the cough and hum fixtures don't trigger.
- Both packages pass their conformance kits, and only FakeClock is used.
- Scoped lint, scoped typecheck and the package tests are green. The pending baseline is empty or justified.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-turns packages/plugin-vad`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-turns packages/plugin-vad`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-turns packages/plugin-vad packages/distribution --reporter=dot`

## Merge review corrections — 2026-09-26

Independent review reproduced two mute-boundary defects in `ebd0cd2` (rebased
unchanged as `07dc6f5` before the corrections): a zero minimum word threshold
allowed a VAD interrupt during a confirmation prompt, and starting disclosure
left an existing transcript available to a later provider-end or timer event.

The VAD interrupt path now uses the same `canInterrupt` policy as transcript
interrupts. A confirmation can still start and buffer a user turn, but VAD cannot
interrupt its prompt regardless of the configured word threshold. Entering a
speech-discarding mute state resets the existing aggregate and cancels its stop
and safety timers. The common stop path also refuses to release speech while
that mute state remains active. Confirmation buffering remains a separate policy.
All edits are inside E1's owned package; frozen contracts and kits are unchanged.

Seven new production-factory regressions were run before changing implementation.
The zero-threshold case failed because it received `interrupt` with reason `vad`
where the expected list was empty. Six cases (disclosure and explicitly muted
response, each followed by provider-end, safety timeout or VAD timeout) failed
with `expected [ 'please change my booking' ] to deeply equal []`. They now pass
and also prove that a fresh turn after the mute window is accepted without the
old text, confirmation `yes` is released only after the prompt, and disposal
leaves no timer. The full E1 plus distribution scope passes 102 tests.

The added stop guard initially made `controller-state.ts` 301 canonical lines.
The existing DTMF decision handler was moved unchanged into `TurnController`,
which owns event dispatch, leaving an abstract callback in the shared state
base. This separates the responsibility instead of compressing code or adding a
module-size baseline; the final gate measures both modules under 300 lines.

## Merge verification — 2026-09-26

E1 was rebased onto S1's tested foundation and merged at `ac8661d`. The independent
reviewer reran the mute boundary, original regression and conformance tests after
the final DTMF handler relocation: **56 passed**, exit **0**, with no new blocker.
The E1 plus distribution scope passed **102 tests**. The complete normal gate
then ran on the merge code tree using Node 22:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node scripts/lint.mjs --only packages/plugin-turns packages/plugin-vad
pnpm format:check
node scripts/check-duplication.mjs
node scripts/typecheck-scope.mjs packages/plugin-turns packages/plugin-vad
pnpm check
OVO_TEST_POSTGRES_URL=postgres://postgres:ovo@127.0.0.1:32898/ovo pnpm exec vitest run --no-file-parallelism --reporter=dot
```

All commands exited **0**. Scoped lint and full formatting were checked together
before merging; the standalone duplication scan passed with 772 source files and
57 existing pairs. The largest E1 source is 282 canonical lines; no baseline was
changed. Normal `pnpm check` includes full seven-gate lint, full format check,
typecheck, default tests, three application bundles, console production build,
audit and console E2E.

- Default: **1,270 passed / 138 skipped**.
- Postgres serial: **1,399 passed / 9 skipped / 0 failed**.
- Playwright: **41 passed / 1 skipped**, only the invisible desktop Menu trigger.
- Arithmetic: `1270 + 138 = 1399 + 9 = 1408`; 129 tests are database-gated.

The loopback-only Postgres 17.6 container was removed. No live provider request,
AWS operation, push or PR change was performed. E1 remains Built — awaiting
checker verification. This documentation records the already-tested merge tree.
