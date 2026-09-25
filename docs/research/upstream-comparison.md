# Voice upstream comparison spike

Status: local component/API viability evidence, not a production-engine decision  
Date: 2026-09-20

## Scope and source lock

`@winsendotai/ovo-voice-experiments` runs the same deterministic fixtures through two long-lived compositions:

1. The focused OVO path binds the actual `packages/behaviors`, `packages/plugin-voice`, `packages/plugin-inference`, and `packages/plugin-tools` exports through the repository's DeepSeek-derived `compose` / `definePlugin` runtime.
2. The LiveKit path wraps the real `AgentSession`, `Agent`, `voice.testing.FakeLLM`, and `tool` APIs exported by `@livekit/agents` in an OVO plugin.

The experiment pins:

- `@livekit/agents@1.9.0`, source commit [`5287be114b12fb16f0a3eb6ccca4173e6e3eb219`](https://github.com/livekit/agents-js/tree/5287be114b12fb16f0a3eb6ccca4173e6e3eb219)
- `@livekit/rtc-node@0.13.34`
- `ai@7.0.107`, source commit [`20dd00abba618d5a516e0fee40ccd3e18a2bd1fb`](https://github.com/vercel/ai/tree/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb)

No provider, network, carrier, or paid API was called. LiveKit uses its exported deterministic fake LLM with text-only/no-audio output. Local inference/model execution is explicitly disabled with `vad: null`, turn detection disabled, no STT/TTS, and no local inference API. The focused candidate resolves its production AI SDK inference plugin to AI SDK's exported `MockLanguageModelV4`. Neither candidate substitutes a hand-written class labelled as LiveKit or a fake provider labelled as production.

### Transitive license boundary

The installed LiveKit SDK dependency tree is not purely Apache-2.0:

- `@livekit/local-inference@0.2.7` declares `Apache-2.0 AND LicenseRef-LiveKit-Model`. Its bundled `MODEL_LICENSE` limits the models to use with LiveKit Agents, prohibits standalone/other-framework model use, and prohibits using the materials or model outputs/results to improve or develop non-LiveKit models.
- The platform package installed here, `@livekit/av-linux-x64@10.0.0`, declares `LGPL-2.1-or-later` for its bundled FFmpeg binary. Its notice also records the libopus BSD-3-Clause component and corresponding-source/written-offer information.

The packages remain installed transitively, so distribution and notice/source obligations still belong in the repository-wide dependency inventory. This spike never imports the local-inference API, disables AgentSession's default local VAD provisioning, and must not extract, copy, or reuse LiveKit model weights or model outputs in focused OVO.

## Actual focused composition

The focused fixture is not a parallel hand-written engine. Its composition uses:

- `createFaqBehavior(...)` for the exact FAQ response;
- `createSimulatedSpeechOutputPlugin()` and `createSpeechSchedulerPlugin()` for bounded response epochs and explicit simulated playback evidence;
- `createAiSdkInferencePlugin(...)`, whose one-step `generateText` declaration intentionally attaches no SDK tool execute handler;
- `createAgentBehaviorPlugin()`, which validates the selected tool and owns the bounded model/operation loop;
- `createExecutionPlugin(...)` as the sole operation-policy and dispatch boundary;
- `createNativeToolsPlugin(...)` for the controlled local handler;
- an experiment-only in-memory `OperationStore` provider.

The last item matters: intent, running, and settlement records in this fixture are **simulated in-memory operation records**, not durable database writes and not crash-safety evidence. Trace names and benchmark metadata say `simulated-memory`; the results make no durable/exactly-once claim.

## Shared fixtures

### Deterministic no-LLM FAQ

Input: `What are your support hours?`

Expected response: `Support is available from 9 AM to 6 PM, Monday through Friday.`

The focused path invokes the production `FaqBehavior`, then the production `BoundedSpeechScheduler` with simulated output. The LiveKit path calls `session.say(...)` and waits for its speech handle. Both assert zero model requests. Because LiveKit audio and transcription outputs are disabled, this establishes text/API/lifecycle behavior only, not audible playback.

### Interrupt immediately before a tool settles

Focused OVO executes this actual package path:

1. production AI SDK inference returns one declared tool call without an SDK execute callback;
2. production `AgentBehavior` validates it and calls shared `Execution` once;
3. the in-memory fixture store records simulated intent and running states;
4. shared execution queues one acknowledgment through the production scheduler and starts the controlled native handler;
5. after simulated acknowledgment completion, caller takeover cancels the behavior turn and scheduler epoch;
6. the already-started handler is released and shared execution records simulated success;
7. `AgentBehavior` observes its aborted turn before any second model request or response playback.

LiveKit uses `AgentSession.generateReply`, lets AgentSession invoke its single tool handler, calls `session.interrupt()` just before releasing the controlled operation, and confirms reply continuation is suppressed.

The fixture rejects a second operation attempt. Tests assert one model request, one handler attempt, acknowledgment completion before caller takeover, caller takeover before simulated settlement, successful in-memory settlement, and zero stale playback.

## Comparison

| Concern                       | Focused OVO production packages                                                                   | LiveKit Agents JS                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Plugin foundation             | Eight actual production/fixture plugins mounted by OVO `compose`                                  | Real session adapter mounted by OVO `compose`                                                                         |
| Actual upstream API exercised | AI SDK `generateText` through `AiSdkInference`, `MockLanguageModelV4`                             | `AgentSession`, `Agent`, `tool`, `session.say`, `session.generateReply`, `session.interrupt`, `voice.testing.FakeLLM` |
| FAQ ownership                 | Production `FaqBehavior`; zero model use                                                          | OVO exact match sent through a real session speech handle; zero model use                                             |
| Tool-loop owner               | Production `AgentBehavior` + shared `Execution`; AI SDK declares tools but has no execute handler | `AgentSession` invokes the only tool handler                                                                          |
| Side-effect owner             | Shared OVO `Execution` invokes one approved native connector                                      | LiveKit tool handler delegates once to the controlled fixture boundary                                                |
| Operation record evidence     | Experiment-only in-memory store; not durable                                                      | Trace-only simulated in-memory boundary; not durable                                                                  |
| Interruption boundary         | `AgentBehavior.cancel()` plus production scheduler epoch interruption                             | `AgentSession.interrupt()` plus an OVO epoch gate around the result                                                   |
| Tool after caller takeover    | Already-started handler settles; aborted behavior prevents a second model step and speech         | Already-started non-cancellable tool settles; reply continuation is suppressed                                        |
| Long-lived hot path           | One composition and scheduler reused                                                              | One `AgentSession` reused                                                                                             |
| Local inference/models        | Not applicable                                                                                    | Explicitly disabled                                                                                                   |

The single-owner invariant is deliberate. In focused OVO, AI SDK only returns a typed tool selection; it does not execute the tool. `AgentBehavior` calls shared `Execution` once. In LiveKit, AgentSession invokes one tool handler once. No candidate parses an SDK call and independently executes it again.

## Upstream source observations exercised

- LiveKit's public testing surface includes [`FakeLLM`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/testing/fake_llm.ts); the upstream text-only pattern appears in [`agent_session_text_only.test.ts`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/agent_session_text_only.test.ts).
- `AgentSession` exposes direct speech, reply generation, interruption, and close lifecycle in [`agent_session.ts`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/agent_session.ts).
- AI SDK's `generateText` accepts an abort signal and declared tools. OVO's production adapter bounds it to one step and deliberately omits execute handlers; the upstream implementation is [`generate-text.ts`](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/packages/ai/src/generate-text/generate-text.ts).

## Evidence identity and decision boundary

- Fixture source: `experiments/voice/src/`
- Assertions: `experiments/voice/tests/comparison.test.ts`
- Raw environment, every duration/failure slot, dirty-tree status, SHA-256 source identities, license controls, and observations: `experiments/voice/results/raw-2026-09-20T12-59-57-495Z.json`
- Bounded summary: [`voice-benchmark.md`](./voice-benchmark.md)

The raw run correctly records `gitDirty: true`. Its base Git SHA alone does not identify the implementation, so it additionally hashes the exact experiment source, runtime source, focused component source, and `pnpm-lock.yaml` used by the run.

This evidence establishes **local component/API viability**: the actual focused packages compose and execute the fixtures, and a long-lived real LiveKit AgentSession executes the equivalent text-only fixtures. It does **not** select a production engine or audio component. It does not verify microphones, VAD, STT, TTS, audio interruption/flush, WebRTC rooms, carrier media streams, packet loss, jitter, reconnects, durable operation recovery, or provider billing/usage reconciliation.
