# Voice upstream source research

**Status:** source audit complete; no production voice-engine decision. This document records source-read evidence only. It does **not** claim a benchmark, carrier test, or an OVO spike was run.

**Audit date:** 2026-09-20 UTC. Each repository was cloned under `/code/upstreams/<project>` at the immutable commit below. Links use those commits rather than a moving branch.

## Scope and pins

| System            | Local source tree                   | Pin / package                                                         | License                                                                                                              | Relevant dependency surface                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pipecat           | `/code/upstreams/pipecat`           | `dbdf21a017f86624fb7768e35730417169524e0d` (main at audit)            | BSD-2-Clause ([notice](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/LICENSE)) | Python >=3.11. Base runtime includes asyncio-oriented audio/data packages (`aiohttp`, `numpy`, `soundfile`, `soxr`, `pydantic`, `websockets`); provider and transport integrations are optional extras, including `livekit`, `webrtc`, `daily`, `mcp`, and `runner`. See [project metadata](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/pyproject.toml). |
| LiveKit Agents JS | `/code/upstreams/livekit-agents-js` | `5287be114b12fb16f0a3eb6ccca4173e6e3eb219`; `@livekit/agents` `1.9.0` | Apache-2.0 ([notice](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/LICENSE))    | Requires LiveKit/audio packages including `@livekit/av`, `livekit-server-sdk`, and a peer `@livekit/rtc-node`; also ships OpenTelemetry, `sharp`, `fluent-ffmpeg`, `ws`, and provider/tooling dependencies. Exact manifest: [`agents/package.json`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/package.json).                                     |
| Vercel AI SDK     | `/code/upstreams/vercel-ai`         | `20dd00abba618d5a516e0fee40ccd3e18a2bd1fb`; package `ai` `7.0.107`    | Apache-2.0 ([notice](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/LICENSE))            | Node >=22; direct runtime dependencies are `@ai-sdk/gateway`, `@ai-sdk/provider`, and `@ai-sdk/provider-utils`; peer `zod` v3.25.76 or v4.1.8+. Providers are separate packages, not bundled voice transport. Exact manifest: [`packages/ai/package.json`](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/packages/ai/package.json).                                 |

A copied/adapted portion of Pipecat or either Apache-2.0 package must retain the applicable license/notice. This audit does not import upstream source or alter OVO manifests.

## 1. Pipecat: behavioral reference, not a TypeScript dependency

### Verified source and tests

- [`FrameProcessorQueue`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/src/pipecat/processors/frame_processor.py#L131-L175) is an `asyncio.PriorityQueue`: `StartFrame` precedes system frames, which precede regular data/control frames; FIFO order is retained within a tier.
- [`FrameProcessor.queue_frame`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/src/pipecat/processors/frame_processor.py#L699-L736) drops work while its processor is cancelling; normal input waits for start rather than executing before setup. [`push_frame`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/src/pipecat/processors/frame_processor.py#L1003-L1023) is the directed downstream/upstream forwarding boundary.
- [`InterruptionFrame`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/src/pipecat/frames/frames.py#L1221-L1233), [`CancelFrame`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/src/pipecat/frames/frames.py#L1078-L1091), and task/worker variants encode distinct interruption/cancellation signalling.
- [`PipelineTask`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/src/pipecat/pipeline/task.py) owns the pipeline's queues and lifecycle; [`PipelineRunner`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/src/pipecat/pipeline/runner.py) starts/runs tasks. These are Python `asyncio` execution primitives, not a portable TypeScript API.
- Tests inspected: [`test_frames_interruptible.py`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/tests/test_frames_interruptible.py), [`test_tts_interruptible_service.py`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/tests/test_tts_interruptible_service.py), and [`test_async_tool_messages.py`](https://github.com/pipecat-ai/pipecat/blob/dbdf21a017f86624fb7768e35730417169524e0d/tests/test_async_tool_messages.py). The TTS tests distinguish bot speech confirmed/started/not-started across an interruption; the async-tool tests cover started/intermediate/final/cancelled message encodings.

### OVO semantics to preserve

| Semantic                                                                                  | Status                   | TypeScript adaptation boundary                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An explicit call/session epoch invalidates queued and late output after caller takeover.  | Adaptation required      | Use monotonically increasing `turnId`/`playbackEpoch`; every inference, tool and TTS output must be checked at the transport playback boundary. Do not copy Python frames/classes.                  |
| Cancellation/control has precedence over normal token/audio work.                         | Adaptation required      | Implement a bounded, per-session control lane and a bounded normal lane; preserve FIFO within lane. JavaScript promises alone do not provide a priority queue.                                      |
| Work cannot execute before the session is ready or after teardown begins.                 | Adaptation required      | The DeepSeek-derived session scope must own `AbortController`, subscriptions and idempotent disposal. Gate input acceptance on `ready` and a current epoch.                                         |
| Interrupted speech context distinguishes generated text from confirmed/observed playback. | Adaptation required      | Persist transport `playbackStarted`, clear/mark acknowledgement, and playback position events; do not append merely generated text as heard context.                                                |
| Tool progress and final result have explicit state.                                       | Reuse behavior, not code | Represent `requested`, `acknowledged`, `running`, `settled`, `ambiguous`, and `cancelled` durably. Pipecat's message convention is insufficient for OVO's durable write/reconciliation requirement. |
| Python processors, frame taxonomy, `asyncio` task management, and Python provider extras. | Not reused               | Treat as a behavioral test oracle only. OVO remains TypeScript-first and must avoid a Python sidecar becoming an implicit production engine.                                                        |

### Pipecat ownership trace

```text
transport input -> input processor -> STT/context aggregation -> LLM/tools -> TTS -> output processor -> transport
                           ^                                    |
                           +------ system/cancel/interruption ---+
PipelineTask/Runner own Python task lifetime and queues.
```

For OVO, preserve the arrows and state transitions, not the Python ownership model. A carrier transport must report actual playback/clear status; it cannot be represented solely by a Pipecat-style processor event.

## 2. LiveKit Agents JS: complete TypeScript candidate with LiveKit I/O coupling

### Verified source and tests

- [`AgentSession`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/agent_session.ts#L508-L590) is the public session coordinator. Its [`start`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/agent_session.ts#L1015-L1060) and [`close`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/agent_session.ts#L1675-L1705) establish/terminate the voice activity and resources.
- [`AgentActivity`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/agent_activity.ts#L323-L355) is the broad turn coordinator. Its source contains STT, VAD/turn handling, LLM/realtime interaction, function tools, TTS and speech/playout lifecycle in one activity.
- [`VoiceIO`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/io.ts#L1-L145) is the I/O abstraction, but its production room implementation is [`RoomIO`](https://github.com/livekit/agents-js/tree/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/room_io), backed by LiveKit room/media objects. This is a material integration boundary for direct carrier WebSockets.
- [`tool()`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/llm/tool_context.ts#L667-L790) turns a schema/handler into a function tool; `ToolContext` resolves function/provider tools. `SpeechHandle` expressly prevents waiting for the handle owning the currently running tool to avoid a circular wait ([source](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/speech_handle.ts#L85-L101)).
- Tests inspected: [`generation_interrupt_before_first_frame.test.ts`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/generation_interrupt_before_first_frame.test.ts), [`agent_activity_interrupted_commit.test.ts`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/agent_activity_interrupted_commit.test.ts), [`speech_handle.test.ts`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/speech_handle.test.ts), and [`agent_session_text_only.test.ts`](https://github.com/livekit/agents-js/blob/5287be114b12fb16f0a3eb6ccca4173e6e3eb219/agents/src/voice/agent_session_text_only.test.ts). These cover false/genuine interruption before first output, playback-aware commits after interruption, tool/handle deadlock avoidance, and a text simulation that drops STT/TTS/VAD components.

### Practical adapter API to spike

```ts
import { Agent, AgentSession, tool } from '@livekit/agents';
import { z } from 'zod';

const lookup = tool({
  description: 'Look up an account by the supplied reference.',
  parameters: z.object({ reference: z.string() }),
  execute: async ({ reference }) =>
    toolBoundary.run({
      operationId,
      reference,
      signal: sessionAbort.signal,
    }),
});

const agent = new Agent({ instructions, tools: { lookup } });
const session = new AgentSession({/* STT, LLM, TTS, turnDetection */});
await session.start({ room, agent });
// Session close must be coordinated with OVO scope disposal.
await session.close();
```

The exact constructor options should be compiled against the pinned `1.9.0` package in the proposed spike. The important boundary is that `AgentSession` owns a voice-agent loop and playout lifecycle. OVO must not simultaneously run an independent loop that executes the same tool or produces the same speech.

### Fit and boundaries

| Requirement                                | Assessment                       | Boundary/condition                                                                                                                                                                    |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Announcement without LLM                   | Adaptation required              | A direct OVO scripted-speech plugin should own it. LiveKit has a text-only test mode but this is not evidence for telephone playback/clear semantics.                                 |
| Deterministic FAQ without generative calls | Adaptation required              | Perform match/response selection in OVO before invoking a LiveKit generation loop, or use a narrowly controlled speech path. Add an egress/no-provider-call fixture.                  |
| Contextual and tool-using modes            | Verified as candidate capability | Session/activity, tools and LLM/TTS pipeline exist. OVO still owns policy, durable operation/outcome, acknowledgement ID, audit events and frontend-configured credentials.           |
| Caller interruption during speech          | Verified as candidate capability | Source/tests contain interruption/playout commit logic. Carrier interruption is only equivalent after an adapter maps carrier clear/marks and inbound audio to LiveKit I/O semantics. |
| Direct carrier transport independence      | Unknown                          | `VoiceIO` exists, but no direct OVO carrier adapter has been built or tested. RoomIO's LiveKit media coupling means this cannot be assumed.                                           |
| Fargate feasibility                        | Unknown                          | The npm surface includes native/media-sensitive dependencies (`@livekit/rtc-node`, `sharp`, `fluent-ffmpeg`). Build, network/media topology, routing and drain tests remain required. |

### LiveKit ownership trace

```text
LiveKit Room/VoiceIO -> AgentSession -> AgentActivity
  input audio/STT/turn detection      -> LLM + tool context -> TTS/SpeechHandle -> playout/RoomIO
Worker owns job process/session admission and shutdown.
```

An OVO adapter should own only translation and lifecycle attachment: call/session identity, DeepSeek-derived scope, durable event sink, provider credential resolution, and carrier I/O adapter. `AgentSession` should be the only owner of LLM continuation and LiveKit tool execution for an adapter turn. If OVO's durable tool boundary executes tools, pass a thin LiveKit tool handler into it; do not register the tool directly with both systems.

## 3. Vercel AI SDK: inference/tool-loop option, not voice transport

### Verified source and tests

- [`streamText`](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/packages/ai/src/generate-text/stream-text.ts#L375-L510) accepts `tools`, `abortSignal`, and `stopWhen`; its default `stopWhen` is `isStepCount(1)`. Source merges abort signals and applies them to streaming/provider work.
- [`ToolLoopAgent`](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/packages/ai/src/agent/tool-loop-agent.ts#L39-L150) provides an agent wrapper over `generateText`/`streamText`; absent a caller setting it defaults to `isStepCount(20)`. Its public generate/stream path forwards an `AbortSignal` ([source](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/packages/ai/src/agent/tool-loop-agent.ts#L185-L300)).
- [`invoke-tool-callbacks-from-stream.test.ts`](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/packages/ai/src/generate-text/invoke-tool-callbacks-from-stream.test.ts) asserts ordered tool callbacks and context transformation. [`tool-loop-agent.test.ts`](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/packages/ai/src/agent/tool-loop-agent.test.ts) covers forwarding abort signals, timeouts, sandbox and lifecycle/tool events. These are SDK unit tests, not OVO cancellation or durable-side-effect proof.

### Practical inference-plugin API to spike

```ts
import { streamText, isStepCount, tool } from 'ai';
import { z } from 'zod';

const result = streamText({
  model: configuredModel,
  messages: inferenceMessages,
  abortSignal: turnAbort.signal,
  stopWhen: isStepCount(4),
  tools: {
    lookup: tool({
      description: 'Lookup an account.',
      inputSchema: z.object({ reference: z.string() }),
      execute: (input) =>
        ovoToolBoundary.execute({
          operationId,
          input,
          signal: turnAbort.signal,
        }),
    }),
  },
});

for await (const part of result.fullStream) {
  if (part.type === 'text-delta' && currentEpoch(turnId)) enqueueTts(part.text);
}
const usage = await result.usage;
```

Compile the spelling/types against `ai@7.0.107` in the spike; API construction above reflects the pinned source's `streamText` and tool-loop surface. Provider construction belongs in an OVO provider adapter, with credentials resolved server-side from OVO configuration.

### Ownership and cancellation rules

| Concern                      | AI SDK supplies                                                                            | OVO must own                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider streaming           | Model/provider normalization, streams, abort signal propagation, step stop conditions.     | Per-turn epoch guard; do not send a late text delta to TTS/playback after caller takeover. Abort is necessary but cannot prove a provider emitted no late bytes.                                                                                                       |
| Tool invocation/continuation | `streamText` and `ToolLoopAgent` can execute tools and continue within bounded steps.      | Exactly one loop owner. For an SDK spike, SDK owns model continuation; OVO's durable tool boundary owns idempotency key, authorization, acknowledgement state, timeout ambiguity and reconciliation. Do not layer a second OVO continuation loop over `ToolLoopAgent`. |
| Usage                        | Result exposes usage after the stream completes.                                           | Persist usage with call/turn/attempt IDs; account for aborted/incomplete streams explicitly and do not infer usage from spoken text.                                                                                                                                   |
| Voice/media                  | No carrier, VAD, turn detection, codec, playout, clear/mark, or playback-context contract. | The OVO voice engine/transport plugins own all of these.                                                                                                                                                                                                               |
| Retries                      | SDK has request retry facilities.                                                          | Set a single retry policy at the inference boundary; never automatically retry a write tool with ambiguous outcome.                                                                                                                                                    |

**Recommended limited reuse:** evaluate `streamText` inside the focused OVO inference plugin, with OVO retaining tool execution policy and all voice orchestration. Do not use `ToolLoopAgent` in the initial focused-engine spike unless it is elected the sole model/tool continuation owner and its lifecycle/events can be mapped into OVO's durable operation record.

## 4. Comparative TypeScript prototype plan

Both disposable prototypes must mount through the same DeepSeek-derived plugin foundation. Neither prototype changes its package manifest as part of this research task.

```text
DeepSeek-derived bootstrap/scope
  ├─ CallSession { callId, activeTurnId, AbortController, disposal stack }
  ├─ Transport plugin { acceptInput, clear, play, mark, playback events }
  ├─ Speech plugins { STT, TTS, turn detector }
  ├─ Operation boundary { durable operationId, acknowledgement, idempotency/reconcile }
  └─ ConversationEngine (replaceable)
       ├─ FocusedEngine: deterministic / direct provider + optional AI SDK inference
       └─ LiveKitAdapterEngine: AgentSession/VoiceIO adapter
```

### Common contracts and fixtures

1. Define `TurnGate.accept(turnId, event)` and require it immediately before TTS enqueue and transport `play`; increment `activeTurnId` on caller takeover and session close.
2. Define `OperationBoundary.execute({ operationId, idempotencyKey, signal })` as the only tool implementation callable by either engine. It emits durable state before acknowledgement/speech and records `ambiguous` rather than retries an indeterminate write.
3. Define `PlaybackPort.clear(turnId)`, `play(segment)`, `mark(segmentId)`, `playbackStarted(segmentId)`, `playbackProgress(segmentId)`, and `playedOrCleared(segmentId)`. These fixture events are the context-commit authority.
4. Use deterministic fake STT/LLM/TTS/tool/transport fixtures first. Make a late model delta and late tool resolution occur after the fixture abort to prove `TurnGate` rejects them.
5. Run the same fixtures for focused and LiveKit adapters: scripted announcement; exact FAQ; supplied-context uncertainty; tool with immediate result; interruption during acknowledgement/generated speech/pre-settlement; late output; ambiguous write; partial initialization cleanup; isolated concurrent sessions.

### Expected prototype assertions

| Invariant                                                                            | Focused engine spike                     | LiveKit adapter spike                                                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| No-LLM announcement and FAQ issue no model request.                                  | Required.                                | Required through OVO pre-loop path or explicitly documented adapter path.                                                   |
| Caller takeover clears current playback and prevents stale new playback.             | Required.                                | Required; carrier events must be translated into LiveKit/adapter interruption and independently gated at OVO playback port. |
| One tool write attempt has one durable operation ID and one acknowledgement.         | Required.                                | Required; LiveKit `tool()` delegates only to `OperationBoundary`.                                                           |
| Model/tool late completion cannot speak or mutate current turn.                      | Required.                                | Required, including after `AgentSession` interruption/close.                                                                |
| Session disposal is idempotent and session-local.                                    | Required through DeepSeek-derived scope. | Required through scope plus awaited `AgentSession.close()`.                                                                 |
| Usage retained when model stream completes; aborted attempts recorded as incomplete. | Required if AI SDK/direct provider used. | Required through LiveKit event mapping if an LLM runs.                                                                      |

## 5. Decisions deliberately deferred

- No production selection between focused OVO engine and LiveKit Agents JS.
- No choice of telephony carrier, codec or deployment topology.
- No claim that LiveKit media/SIP infrastructure can run within the all-Fargate application profile.
- No production dependency addition, source vendoring, or DeepSeek import boundary change.

The next implementation step is a pair of bounded, fixture-driven TypeScript spikes under the shared DeepSeek-derived scope. They should emit a common event trace (`input accepted`, `turn cancelled`, `ack requested/played`, `tool state`, `tts queued`, `playback started/cleared`, `disposed`) so correctness and later measurements compare like-for-like. Only after those traces and the owned-number/carrier deployment evidence exist should an ADR select the engine.
