# Voice and behavior implementation evidence

Date: 2026-09-20 UTC

## Implemented scope

- `@winsendotai/ovo-plugin-voice`
  - Bounded FIFO speech scheduling by segment count, queued characters, playback deadline, and retained evidence count.
  - Monotonic response epochs. Starting a new epoch aborts active output, flushes queued stale segments, and prevents a late provider completion from becoming completed evidence.
  - Separate generated/queued/started evidence and terminal completed/interrupted evidence. A simulated completion remains labelled `simulated`; it is not represented as confirmed playback.
  - Explicit `SpeechOutput` boundary and explicitly simulated local output. Scheduler, evidence history, queue budgets, output, plugin wiring, and shared types are separate modules below the repository size limits.
- `@winsendotai/ovo-behaviors`
  - Announcement behavior: no inference dependency, Ajv variable validation, own-property path-only templates, expression/prototype rejection, ISO date/time validation, and locale/time-zone/currency formatting.
  - FAQ behavior: no inference dependency, deterministic normalization and Dice matching, threshold plus top-two margin, conservative negation mismatch, and clarification instead of approval for tool-dependent entries.
  - Context behavior: full-context budget enforcement before inference, no tool exposure, and cancellation of superseded turns.
  - Agent behavior: bounded by `maxSteps`, exact allowlist and Ajv tool-input validation, local error records for rejected tool selections, and business execution only through the shared `Execution` interface. Per-turn abort propagates into shared execution; a superseded operation result is checked for staleness before it can enter inference context.
- `@winsendotai/ovo-plugin-inference`
  - Vercel AI SDK `generateText` and `streamText` adapter pinned to `ai@7.0.107`, with `maxRetries: 0`, one provider step, abort propagation, declared JSON Schema tools without SDK `execute` handlers, and normalized usage evidence. The optional stream contract emits bounded text deltas or one validated tool selection; provider errors remain redacted and the usage callback runs once at stream finish.
  - Explicit scripted `SimulatedInference` for local tests and runnable simulations. It makes no provider or network calls.
- Every capability factory uses `definePlugin(manifest, apply)`, declares `contractVersion`, `scope`, `requires`, `provides`, `configSchema`, and `secretFields`, and publishes services through `ctx.provide`.

## Stable bootstrap surface

```ts
createBehaviorPluginCatalog()
createAnnouncementBehaviorPlugin()
createFaqBehaviorPlugin()
createContextBehaviorPlugin()
createAgentBehaviorPlugin()

createSimulatedVoicePluginCatalog()
createSimulatedSpeechOutputPlugin()
createSpeechSchedulerPlugin()

createSimulatedInferencePlugin({ replies?, responder?, delayMs? })
createAiSdkInferencePlugin({ resolveModel, id? })
```

Stable plugin ID maps are exported as `BEHAVIOR_PLUGIN_IDS`, `VOICE_PLUGIN_IDS`, and `INFERENCE_PLUGIN_IDS`. Service keys are exported as `BEHAVIOR_SERVICE_KEYS`, `VOICE_SERVICE_KEYS`, and `INFERENCE_SERVICE_KEY`. `packages/behaviors/README.md` documents the row config and dependency contract used by control/bootstrap code.

## Verification

Focused command:

```sh
pnpm exec vitest run \
  packages/plugin-voice/src/index.test.ts \
  packages/behaviors/src/behaviors.test.ts \
  packages/behaviors/src/execution-cancellation.integration.test.ts \
  packages/plugin-inference/src/index.test.ts
```

The focused suite covers generated versus completed evidence, stale-epoch cancellation, queue overflow, a provider that never settles, bounded evidence retention, safe formatted announcements, schema failure, unsafe template rejection, FAQ ambiguity/tool/negation conservatism, context budget failure before inference, bounded agent tool continuation through `Execution`, rejection plus recording of unknown tools, all four modes composed through the shared runtime, AI SDK completed and streaming calls without SDK tool execution, simulated inference abort, and actual AgentBehavior plus shared Execution cancellation. Streaming regressions prove sentence playback starts before provider completion, bounded segment lookahead, barge-in interruption with no late segment, playback-only conversation history, tool continuation through the shared execution boundary, rejection of mixed streamed speech/tool side effects, one-shot compact usage, and provider error redaction. The cancellation suite supersedes pending reads and writes, verifies connector abort, stopped bounded progress, failed read state, durable `unknown` write state, no retry, ignored late write completion, explicit `cancel()`, and zero stale-result narration.

Observed after the cancellation correction: the 4 owned test files passed 19 tests; the combined run including the shared execution regression file passed 5 files and 31 tests.

Owned-package TypeScript validation, architecture/namespace/private-package/PM checks, pinned-upstream verification, and the repository-wide module-size gate pass.

All owned production TypeScript modules are below 300 canonical nonblank lines and 24 KiB. The largest is the scheduler at roughly 205 canonical nonblank lines; AI SDK, simulated inference, and plugin/config wiring are separate modules.

Installed dependency verification at this evidence point reports Ajv `8.20.0` and AI SDK `7.0.107`.

## Acceptance mapping

- A02-A05/A46: four explicit behavior modes compose; announcement and FAQ manifests have no inference requirement.
- A08: announcement variables validate before rendering and only declared safe scalar paths render.
- A09: over-budget context fails construction rather than silently deleting critical facts.
- A10: unknown, unapproved, and schema-invalid tool requests stop before `Execution` and are retained in local rejection evidence.
- A15/A16: newer turns and explicit cancellation propagate an abort signal through shared execution; pending read progress stops, while an already-started write remains `unknown` without retry or stale narration.
- A31/A74: agent continuation is bounded by OVO; the AI SDK receives schema-only tools and performs at most one provider step per OVO iteration with retries disabled.
- A36: active and queued stale speech is interrupted by epoch; a late old completion cannot become completed evidence.
- A70: generated evidence is distinct from terminal output evidence, including explicit `simulated` completion.

## Honest limitations and required follow-up

1. The shared `Behavior.respond()` contract returns only text. It cannot represent structured speak/confirm/operation/transition/end actions or a turn epoch. Agent mode currently forwards `variables.confirmed === true` to `Execution`; the execution service remains the policy and durable-intent authority. Add shared structured behavior actions before claiming a complete production confirmation UX.
2. `SpeechReceipt` exposes only a terminal state. Generated/queued/started evidence and subscriptions are package-local extensions. Move the evidence shape and turn/epoch identity into shared contracts when control and observability need a durable cross-package representation.
3. The supplied-context mode instructs the model to stay grounded and withholds tools, but this local suite does not prove semantic groundedness, citation quality, or provider behavior. Publication evaluation with adversarial unsupported questions is still required.
4. The FAQ matcher is intentionally lexical and conservative. Its current negation lexicon is English-oriented; multilingual morphology, semantic paraphrases, and domain-specific ambiguity need evaluated deterministic extensions rather than a silent model fallback.
5. Speech tests use an explicitly simulated output. They verify scheduler ordering and cancellation, not microphone input, STT, TTS, audible playout, WebRTC rooms, carrier media, jitter, packet loss, or human-perceived interruption. `simulated` evidence must never be presented as actual playback.
6. The AI SDK path is tested with the SDK's exported `MockLanguageModelV4`, not a paid or live provider. Deployment model resolution, credential lookup, provider-specific usage reconciliation, safety settings, and failure semantics need integration evidence. No paid calls were made.
7. Queue and evidence bounds are in-memory per session. They do not provide process-crash recovery or distributed speech ownership.
8. The comparative AgentSession/focused-engine spike in `docs/research/upstream-comparison.md` is useful local API evidence but remains unmatched to live audio scope. The production engine decision is provisional pending matched hot-session and live voice evidence.

## Provider prompt-cache usage

The AI SDK adapter retains provider-reported uncached input, cache-read input and cache-write input tokens, plus text/reasoning output details. These counters are subsets of token totals, not extra tokens to add. Missing counters remain absent rather than assumed zero. A fixture verifies two identical requests still make two inference calls: OVO does not reuse business answers or tool results as an application response cache. Provider cache configuration, retention and price-card reconciliation remain provider-specific certification work.
