# Working ahead of the caller: speculation

Wave 4 speculation lane (LAT-4, LAT-3). The runtime is in
`packages/behaviors/src/speculation{,-policy,-agent,-llm,-history,-turn}.ts`, wired through
`rules-gate.ts` (the gate holds the speculative decision), `agent-pre-reply.ts` (starts the LLM)
and `agent-session.ts` (the hooks). The release warning is
`packages/session-host/src/compat/speculative-llm-unpriced.ts`.

An agent that authors nothing gets decisions on partial transcripts and the LLM asked alongside
the decision.

```json
{
  "decision": {
    "speculation": { "partials": true, "debounceMs": 150, "match": "exact", "llm": false }
  }
}
```

`decision.speculation` reaches the contract with the Wave 4 integration (cross-lane request).
Until then the same fields can be set as the `speculation` option of `AgentBehavior`.

## Decisions on partial transcripts (LAT-4)

The turn driver calls the behaviour's `TurnSpeculation` hooks (`contracts/voice/turn-speculation.ts`,
turns lane): `prepare({ turnId, text, stable })` on every revision while the caller speaks,
`discard(turnId)` when the utterance will not be answered as heard. `AgentBehavior`:

1. Runs the rules tier and the decision model on the partial, exactly as the gate would at the end
   of the turn. A partial the STT may still revise waits `debounceMs` unchanged; a stable one is
   decided at once. At most one decision is in flight per call; newer words wait for it.
2. Commits nothing. The flow does not move and no verdict is recorded until a turn speaks.
3. When the turn's final transcript arrives, reuses the verdict only if the words normalise to the
   same text (`match: "prefix"` also accepts final words that continue it) and nothing else the
   verdict depends on changed: flow position, spoken history, variables, briefing, today. Anything
   else is discarded (or cancelled, if in flight) and decided normally. A failed or timed-out
   speculative call is never reused; the turn gets its own full deadline.

Not speculated: a repeat request, an empty reply, a pending confirmation, and agents whose
decision reads retrieved passages (`state.sources` has `knowledge` with a knowledge policy).

Measured with fixtures (300ms decision model): a confident flow turn's first segment goes from
300ms after end of turn to 0ms when the partial was decided in time, and to the remainder when it
is still in flight (`behaviors/tests/speculation-partials.test.ts`).

## The LLM alongside the decision (LAT-3)

On by default since the gpt-6-luna price was confirmed on the OpenAI pricing page (2026-10-06;
catalog version `2026-10-06-confirmed`). An aborted call still bills its input; `llm: false` turns
it off. While on, the turn's first LLM request starts the moment the turn has to wait on the
decision model (never for a turn the rules tier or a prepared verdict answers). Its events are
buffered; the inference step takes them only if its own first request is identical. A scripted
line, a clarification, a recovery line, or a different request (the decision moved the flow)
aborts it. Fixtures (300ms decision, 500ms to first LLM text): 800ms to 500ms.

While it is on and any LLM meter lacks a price card that says `provisional: false`, every stage
shows a `meter_uncovered` warning on `decision.speculation.llm`. The API's live-readiness check
reads each referenced card's `provisional` flag from the ledger, so an agent priced with the
confirmed catalog cards gets no warning.

## Metering

`AgentBehavior.speculationMetrics`:

| Field      | Counts                                                                              |
| ---------- | ----------------------------------------------------------------------------------- |
| `decision` | `started`, `modelCalls` (billed round trips), `reused`, `discarded`, `cancelled`    |
| `llm`      | `started`, `used`, `aborted` (the decision answered), `discarded` (asked otherwise) |

The OpenAI plugin meters an aborted call's input as `estimated` `input_tokens` and
`uncached_input_tokens` (about four characters a token over everything the request sent), request
id `openai:aborted:<n>`. Barge-in aborts are metered the same way. Output and reasoning tokens of an
aborted call are not estimated.

## `resume_flow` replies

The inference port delivers a tool call whole (`InferenceStreamEvent` has no argument deltas), so a
reply the LLM puts inside `resume_flow` is spoken only once the call has arrived. The model is told
to say its answer as plain text first, which streams. That path needs the plugin-kit fix in the
Wave 4 cross-lane patch: `AiSdkInference` refused text followed by a tool call.
