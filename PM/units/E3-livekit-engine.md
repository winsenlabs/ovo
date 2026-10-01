# Work unit E3-livekit-engine: LiveKit Agents JS engine plugin (audio-path spike first; no room, no LiveKit LLM/tools, OVO providers via adapters, speech companion, confirmation-safe short answers) plus glibc images and native externals in the real bundlers

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [4]

## Owned paths

- packages/plugin-engine-livekit/**
- infra/container/Dockerfile
- scripts/build.mjs
- apps/api/package.json (scripts.build only)
- apps/worker/package.json (scripts.build only)
- apps/media-gateway/package.json (scripts.build only)
- apps/dispatcher/package.json (scripts.build only)
- scripts/baselines/pending/E3.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: build a second engine plugin that proves the engine contract, so the same agent can switch between the OVO native engine and LiveKit Agents per release. Read docs/architecture/plugin-platform.md (revision 2): section 2.2 (companions), section 2.4 (host format adapters), section 2.6 (receipt ordering and engine rules) and section 7 (normative).

PINNED: @livekit/agents 1.9.0 (its TypeScript source ships under node_modules/.pnpm/@livekit+agents@1.9.0_*/node_modules/@livekit/agents/src) and @livekit/rtc-node 0.13.34. F3 created the skeleton packages/plugin-engine-livekit with these exact dependencies and a catalog entry (roles ['session']). Fill it and remove the package.json field ovo.skeleton.

STEP 0, THE SPIKE:

- experiments/voice/src/livekit.ts is text-only. It calls setAudioEnabled(false), uses no STT and sets turnDetection null, so it proves nothing about the audio path.
- First write tests/spike.test.ts: an AgentSession with no room, custom AudioInput and AudioOutput, an OvoStt with turnDetection 'stt', and say() through an OvoTts, all against scripted fakes. It must show a user turn arriving at onUserTurnCompleted, audio frames reaching CarrierAudioOutput, and the flush → playout-finished path.
- If the spike cannot pass on 1.9.0, STOP. Report the exact failure with file and line evidence rather than faking conformance.

PACKAGE: one engine plugin plus one companion.

- Engine:
  - id '@winsendotai/ovo-engine-livekit', kind 'engine', provider 'livekit', scope session;
  - requires ['ovo.behavior', 'ovo.media.duplex', 'ovo.tts-streaming', 'ovo.speech'], optional ['ovo.stt', 'ovo.vad'], provides ['ovo.voice-session-engine'];
  - companions {'ovo.speech': '@winsendotai/ovo-engine-livekit/speech'};
  - config {session: SESSION_INPUT_JSON_SCHEMA, engine: {minInterruptionWords: 2, closeDeadlineMs: 2000}};
  - capabilities {turnDetection: ['stt'], bargeIn true, dtmf true, confirmedPlayback true, ownsProviders false, formats [MULAW_8K, PCM16_8K], consumesTurnDetector false};
  - runtime {native: 'glibc', egressHosts: [], modelLicences: []}; conformance ['engine@1'].
- Companion '@winsendotai/ovo-engine-livekit/speech' (kind 'engine' is not allowed for companions; use kind 'infra', scope session): provides ovo.speech as a late-bound Speech port. speak() queues until the engine attaches its session at start, then routes through session.say with receipts. Execution's progress speech must reach the carrier only through this port.

MODULES (≤250 lines each):

- index.ts: exports plugins. It MUST NOT import @livekit/* at module top.
- plugin.ts: apply() does `await import('./session-runner.js')`, and calls initializeLogger once, routed to a silent or warn logger. Note that @livekit/agents imports sharp (src/llm/utils.ts) and @livekit/av (src/ffmpeg.ts) at module top, so selecting this engine loads those native modules.
- session-options.ts, the pinned options:
  - vad null (or an OVO VAD adapter when ovo.vad is present);
  - turnHandling {turnDetection: 'stt', interruption: {mode: 'vad', minWords}};
  - aecWarmupDuration null, userAwayTimeout null, ttsTextTransforms null;
  - preemptiveGeneration {enabled: false}, useTtsAlignedTranscript false;
  - connOptions.sttConnOptions.maxRetry 0;
  - reject any string model id.
- codec.ts: μ-law ↔ PCM16 through @winsendotai/ovo-audio, plus AudioFrame builders (8 kHz mono, 20 ms). The host format adapters already provide 8 kHz, so no resampling happens here.
- carrier-input.ts: CarrierAudioInput extends AudioInput. media.onAudio → ReadableStream<AudioFrame> with a bounded queue.
- carrier-output.ts: CarrierAudioOutput extends AudioOutput(8000).
  - captureFrame → encode → media.sendAudio.
  - flush → media.mark(segmentId); onPlayed → onPlaybackFinished({interrupted: false}).
  - clearBuffer → cancel pending marks, THEN media.clear(), and report interrupted.
  - The segment id comes from frame.userdata. A mark timeout gives evidence 'estimated'.
  - Evidence mapping per section 2.5, including the weak-evidence acknowledgement.
  - Never call onPlaybackFinished twice.
- stt-adapter.ts: OvoStt extends stt.STT with a SpeechStream. SttEvent → SpeechEvent:
  - speech-start → START_OF_SPEECH;
  - interim → INTERIM_TRANSCRIPT;
  - final → FINAL_TRANSCRIPT;
  - end-of-turn or utterance-end → END_OF_SPEECH.
    Usage stays on the OVO provider's UsageSink.
- tts-adapter.ts: OvoTts extends tts.TTS, which satisfies the say() guard at agent_activity.ts:1586-1593. Per-segment synthesis requests the carrier format (the host adapter transcodes), with lookahead 1, frames tagged with the segment id, and abort on cancel.
- ovo-agent.ts: OvoAgent extends Agent. onUserTurnCompleted(chatCtx, msg) ENQUEUES the turn to the turn driver and throws StopResponse.
  - It must NEVER await say() or waitForPlayout() inside the hook; that risks a deadlock with LiveKit's speech-task scheduling.
  - No llm and no tools. Never call generateReply.
- turn-driver.ts: runs on its own promise chain.
  - epochs and behavior.beginTurn;
  - respond or respondStream → session.say(segment, {addToChatCtx: false, allowInterruptions}) per segment, where allowInterruptions is FALSE for confirmation-kind segments (behavior.speechKind?(text) === 'confirmation').
    - LiveKit drops input under minWords while an interruptible speech plays. With interruptions off, a one-word 'yes' at the tail of a prompt is committed as a user turn.
  - receipts → behavior.onPlayback with the exact text;
  - receipt ordering: hold a user turn until every earlier segment's receipt is delivered;
  - DTMF turns (media.onDtmf) and the initial turn;
  - variables merged into every turn;
  - SpeechHandle.interrupted → behavior.cancel;
  - a watchdog for maxCallSeconds → dispose('max_duration').
- evidence.ts: EngineEvents (speech phases, user.transcript from user_input_transcribed, user.turn, agent.transcript, end).
- metrics-bridge.ts: metrics_collected and agent_state_changed → timing events. Errors → dispose('error:livekit').
- session-runner.ts:
  - build the session and set input and output before start(), with no room;
  - dispose: close media first, then session.close() bounded by closeDeadlineMs, with listener cleanup;
  - map the close reason → EndReason.
- guards.ts: throw if any LIVEKIT_* env var is set, if session._usingDefaultVad is truthy, if any Inference* instance was created, or if an llm or tool context exists.

IMAGE AND BUNDLES (the real bundlers)

- infra/container/Dockerfile:
  - change EVERY stage from node:24.8.0-alpine to node:24.8.0-bookworm-slim, because @livekit/rtc-ffi-bindings has no musl build;
  - convert apk usage to apt-get with --no-install-recommends and cleaned lists;
  - keep the non-root user and the recordings volume permissions;
  - replace the api-build stage's inline esbuild command with `pnpm --filter @winsendotai/ovo-api build`;
  - keep one image set for Compose and Fargate.
- apps/worker/package.json and apps/api/package.json scripts.build: add --external:@livekit/* --external:sharp --external:onnxruntime-node. apps/api gets a 'build' script equivalent to today's scripts/build.mjs and Dockerfile flags (esm, node24, .sql text loader, fastify, pg and pg-native externals, and the createRequire banner). The gateway and dispatcher builds stay as they are unless they reach the engine.
- scripts/build.mjs uses the app build scripts and the same externals.
- The packages must exist in pnpm deploy's node_modules. They are transitive production dependencies through distribution → plugin-engine-livekit; verify that with pnpm deploy in a temp dir when possible, and record the result otherwise.
- The worker bundle is CommonJS. Verify that the lazily-imported session-runner can load the ESM @livekit/agents (Node 24 require(esm)) with a bundle smoke test. If it can't, switch the worker build to ESM with the createRequire banner and record why.
- Dependency lists in apps/*/package.json are frozen; edit only scripts.build.

TESTS (no network)

- An egress sentinel from @winsendotai/ovo-conformance/drivers wraps every test file.
- The spike (step 0).
- tests/conformance.test.ts: describeEngine passes, including zero LiveKit tool-executor calls (spy on FunctionToolsExecuted and ToolContext), Execution progress speech through the companion, receipt ordering, and a confirmation 'yes' said at the prompt's tail being accepted.
- Guards: an omitted vad or turnDetection is refused; LIVEKIT_API_KEY present is refused.
- CarrierAudioOutput: flush → mark → finished; clear → interrupted with marks cancelled first; never a double finish.
- Upstream regression slices against the pinned version: minimal versions of the agent_session_close_user_turn and agent_activity_close_commit behaviour, pinning the no-room path, the no-LLM early return (agent_activity.ts:3037) and the say() TTS guard.
- A lazy-load test: importing the package index does not load @livekit/rtc-node.
- LiveKit uses real timers internally. Give these tests a 60 s timeout, and skip them with a clear reason if the native binding fails to load on the host.
- List the LGPL and model-licence transitive dependencies (@livekit/av, sharp/libvips, @livekit/local-inference) in the package README for I1.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go only in scripts/baselines/pending/E3.json.
- Done = scoped lint, typecheck and tests green, plus the bundle smoke test.

CONSTRAINTS:

- Depend only on contracts, runtime, sdk, audio, plugin-kit and LiveKit.
- Never enable LiveKit Cloud, inference or model downloads.
- Tools stay behind Behavior → Execution.
- Modules ≤300 lines.
- No git commits.

## Acceptance

- The audio-path spike passes on @livekit/agents 1.9.0, or the unit stopped with documented evidence.
- @winsendotai/ovo-engine-livekit and its ovo.speech companion load lazily through the distribution catalog, and importing the index does not load native bindings.
- describeEngine passes under the egress sentinel: 4 modes, DTMF, variables on every turn, barge-in, a confirmed write tool, an interrupted confirmation not executed, a one-word 'yes' at the prompt's tail accepted, progress speech through the companion, zero LiveKit tool executions and bounded dispose.
- onUserTurnCompleted never awaits playout. Guards reject default VAD or turn detection, LIVEKIT_* credentials, and any LLM or tool context.
- Carrier-output mark handling cancels marks before clear, yields the correct receipts and never double-finishes. The upstream regression slices pass.
- Every Dockerfile stage uses node:24.8.0-bookworm-slim, and the worker and API app build scripts (the real image bundlers) mark @livekit/*, sharp and onnxruntime-node external. The api-build stage uses the app build script, and the bundle smoke test passes.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-engine-livekit infra/container scripts/build.mjs`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-engine-livekit`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-engine-livekit --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm --filter @winsendotai/ovo-worker build && pnpm --filter @winsendotai/ovo-api build`

## Checker notes — 2026-09-26

- **Pinned confirmation contradiction.** The short-answer paragraph assumes
  `allowInterruptions: false` causes a one-word response to reach the user-turn
  hook. Agents 1.9.0 `src/voice/agent_activity.ts:2975–2981` instead returns before
  that hook whenever a non-interruptible speech is active. The real kit's tail
  confirmation failed with `timed out waiting for the confirmed write` (21/22
  checks passed). The owned `SttGate` adapter buffers provider events during
  confirmation and releases them through the real LiveKit SpeechStream only
  after the exact receipt is delivered and the speech handle completes; the
  isolated tail check then passes. Disclosure events are discarded, overflow
  fails closed, and Behavior is never called directly from this adapter.
- **Empty SDK tool context.** Agents constructs `ToolContext.empty()` even with no
  configured tools. The guard rejects populated tool contexts and any LLM, while
  permitting the unavoidable empty context. Tests exercise the real no-LLM
  early return and zero `FunctionToolsExecuted` events.
- **Conformance timing assumption.** `engine-scenario-setup.ts:43–46` defines
  `spoken()` as generated transcript; the FAQ check immediately assumes carrier
  audio exists. Asynchronous TTS can legitimately follow generation, producing
  an intermittent `no audio reached the carrier` even though the independent
  production composition completes real audio and receipts. This frozen kit
  issue is reported separately; E3 does not delay or mislabel generation events.
- **Native packaging verification.** Offline worker deploy was attempted, with
  zero downloads, and failed at missing offline metadata for root
  `prettier@3.9.8`. No install/network fallback was run. I1 inherits the native
  deploy/SBOM check; the worker CJS flags separately pass an executed native
  runner/audio smoke on Node 22.

- **Gateway reachability.** The gateway already calls `loadDistribution`, whose
  session catalog reaches the lazy engine module at bundle time. Its unchanged
  build failed with esbuild `No loader is configured for .node files`. The owned
  gateway `scripts.build` therefore adds the same native externals. This note
  described the foundation before O1; see the 2026-10-01 update below for the
  now engine-reaching dispatcher.

- **Production confirmation dependency on M1.** The current foundation's real
  `AgentBehavior` has no `speechKind` method; the conformance kit supplies a
  classifier in its spy, which cannot establish production acceptance. E3 now
  includes a separate real-class tail-confirmation regression, without that
  spy or a regex. It must be rerun after M1's exact-prompt `speechKind` and
  subscription implementation lands. E3 does not add a heuristic classifier.
- **Review regressions.** Before the fixes, four real-engine lifecycle cases
  failed: duplicate final IDs produced `book Friday book Friday`; a synchronous
  media close error left Behavior cancellation count zero and ingress attached;
  a throwing end observer rejected dispose; and a throwing unsubscribe rejected
  dispose. The adapter now deduplicates final segment IDs and attempts media
  closure first while isolating every local cleanup and observer. All four
  regressions then passed.

- **Independent re-review.** After the lifecycle fixes, the reviewer ran 43 owned
  checks successfully and found no additional owned blocker. Pairing current E3
  with M1’s actual pending `AgentBehavior` (without the kit classifier) produced
  zero executions before mark acknowledgement and one afterward. The same probe
  on the current foundation produced zero executions for the early yes. The
  unskipped `production-confirmation.test.ts` therefore remains red until M1
  lands; E3 stays WIP, not Built.

## Checker update — 2026-10-01

- **Named build grant.** Design §15.5 explicitly assigns `scripts/build.mjs`
  and the four app `scripts.build` fields to E3; §15.2 omitted the corresponding
  named exception. The checker approved only equivalent API build wiring and
  native `@livekit/*`, `sharp`, `onnxruntime-node` externals where the engine is
  reached. The dated Approved-exceptions row landed on foundation in `a2edace`
  before this unit was rebased. Dependencies remain untouched.
- **Dispatcher reachability changed under O1.** `dispatcher-process.ts` now
  imports `loadDistribution`. Its unchanged bundle failed with `No loader is
configured for .node files` at the pinned LiveKit native binding. Adding only
  the three approved externals to `apps/dispatcher/package.json` made the root
  build pass; its target, format, loader and output path remain unchanged. The
  gateway similarly reaches the distribution and already has the externals.
- **Actual engine choice.** A test composes the production distribution and
  `selectSessionGraph` twice for the same announcement release, changing only
  `release.selections.engine` between the real native and LiveKit plugins. Both
  render `Hello Asha.`, produce carrier audio, and complete without a violation.
  The existing engine kit exercises initial, speech and DTMF turns; a production
  distribution test now mutates a nested variable in the first Behavior call
  and checks the second still receives its original value. Replacing the deep
  clone with a shallow spread fails on `Mutated by Behavior` versus `Asha`.
- **M1 dependency discharged.** M1's exact `speechKind` and subscription now
  live on foundation. `production-confirmation.test.ts` passes without the kit's
  spy classifier; E3 adds no regex or Behavior bypass.
- **Offline deployment now resolved locally.** After the frozen offline install,
  `pnpm --offline --filter @winsendotai/ovo-worker deploy --prod --legacy`
  succeeded with zero downloads. The deployed package tree contains Agents,
  rtc-node and the Darwin native binding; the lockfile includes the Linux glibc
  binding. I1 retains the Linux image/SBOM verification and license notices, not
  the earlier local metadata failure. The disposable deploy directory was removed.
- **FAQ timing corrected by checker ruling.** The generated transcript is emitted
  before the asynchronous TTS carrier writer, as a direct event-time probe
  confirms. The same FAQ then reaches audio with a bounded wait. The unmodified
  frozen kit checks audio immediately after generated text: the parallel
  default suite fails with `no audio reached the carrier`, while the serial
  Postgres suite passes. The checker approved changing only that immediate
  assertion to `h.until` under the existing timeout. A broken engine whose
  carrier writer discards every frame now fails with `timed out waiting for FAQ
carrier audio`; the rest of the scenario is unchanged. E3 does not delay or
  mislabel the generated event to satisfy a timing assumption. Foundation
  records the dated exception and the blocking I1 sweep in `010f31a`.

Node 22.23.2 results before the FAQ kit correction: full lint 0 (seven gates),
format 0, typecheck 0, API/worker/gateway/dispatcher and console builds 0,
audit 0, console E2E 41 passed / 1 skipped. Default tests: 1,969 passed +
209 skipped + 1 failed = 2,179. Disposable loopback Postgres 17.6 serial:
2,175 passed + 4 skipped = 2,179; it exited 0 and its container was removed.
The 205 skip difference is Postgres-gated; the remaining pass difference is the
FAQ timing failure in the parallel default run. These are historical results
before the authorized kit correction; the full green bar follows below.

The first real alternative engine exposed a frozen kit assertion that encoded
the reference engine's same-tick timing rather than the engine contract. This
is direct evidence that per-agent engine selection is real: both production
engines now run the same release configuration, and the kit had to be made
implementation-independent without weakening its silent-engine check. I1 owns
a blocking sweep of `packages/conformance` for similar timing assumptions;
M1's interrupted-confirmation utterance is the other known instance.

### Contract gaps

The pinned LiveKit Web `ReadableStream` declaration and Node's vendored
declaration disagree on BYOB generic parameters. `carrier-input.ts` uses a
local structural cast at that SDK boundary; the runtime stream is Node's
standard stream. I1 should check whether a later pinned SDK or type update
removes the cast while preserving the bounded input queue. No OVO contract
was widened for this dependency mismatch.

### Final builder verification — 2026-10-01

All commands used Node 22.23.2. The verified code commit is `e865f42`;
the board update is a separate documentation commit. `pnpm check` exited 0,
including all seven lint gates, `format:check`, typecheck, default tests,
API/worker/dispatcher and console builds, audit and console E2E. The separately
invoked media-gateway build exited 0. The offline frozen-lockfile install and
worker production deploy exited 0 with zero downloads. The deploy contained
Agents, rtc-node and a platform native binding.

- Default suite: 1,970 passed + 209 skipped = 2,179.
- Disposable loopback Postgres 17.6 serial suite with
  `--no-file-parallelism`: 2,175 passed + 4 skipped = 2,179; 0 failed. The
  205 newly running cases were Postgres-gated, not disabled tests. The owned
  container was removed after the run.
- Console E2E: 41 passed, 1 expected desktop navigation skip.

**New true negatives:** With the frozen FAQ scenario corrected, a real LiveKit
engine whose `sendAudio` discards every frame fails on `timed out waiting for
FAQ carrier audio`; the generated-text wait still passes first. Replacing E3's
per-turn deep clone with a shallow spread makes the second production Behavior
call receive `Mutated by Behavior` instead of `Asha`. Running the unchanged
dispatcher build after O1's distribution import failed at esbuild's `No loader
is configured for .node files`; adding only the three approved native externals
makes it pass. The selected-engine test uses real distribution and both real
engines, checks the resolved plugin ID for each release selection, and observes
actual carrier audio from both.
