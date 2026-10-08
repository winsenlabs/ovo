# Working ahead of the caller: speculation

Wave 4 speculation lane (LAT-4, LAT-3), and Wave 8's LLM on partial transcripts. The runtime is in
`packages/behaviors/src/speculation{,-policy,-agent,-llm,-partial,-history,-turn}.ts`, wired through
`rules-gate.ts` (the gate holds the speculative decision), `agent-pre-reply.ts` (starts the LLM)
and `agent-session.ts` (the hooks). The release warning is
`packages/session-host/src/compat/speculative-llm-unpriced.ts`.

An agent that authors nothing gets decisions on partial transcripts and the LLM asked alongside
the decision; an agent without a decision model gets the LLM asked on the partial transcript.

```json
{
  "decision": {
    "speculation": {
      "partials": true,
      "debounceMs": 150,
      "partialEnding": "sentence",
      "maxPartialCalls": 2,
      "match": "exact",
      "llm": false,
      "llmPartials": true,
      "llmDebounceMs": 250,
      "llmMinWords": 1,
      "llmMaxPartialCalls": 1
    }
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
   of the turn. A partial the STT may still revise waits `debounceMs` unchanged, and (Wave 7) is
   decided only when it ends a sentence once the STT has punctuated a partial
   (`partialEnding: "sentence"`) and only `maxPartialCalls` times per utterance; a stable one is
   decided at once. At most one decision is in flight per call; newer words wait for it. Why, and
   the measured saving: `docs/evidence/speculation-waste.md`.
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

## The LLM on partial transcripts (Wave 8, latency fix 4)

For an agent whose decision model is off or absent (Maya: every turn goes straight to the LLM),
`prepare` asks the LLM itself on the caller's words in progress, so its first token, and any web
search the model starts, are under way before the turn ends (`speculation-partial.ts`):

1. A revisable partial must hold `llmDebounceMs` (250) unchanged, have `llmMinWords` (1) words and
   end a sentence (`partialEnding: "sentence"`; an STT that never punctuates partials gets no call
   on them). Words the STT finalised are asked at once. At most `llmMaxPartialCalls` (1) calls per
   utterance on revisable partials, and one call in flight per session: newer words abort it.
2. The request is built when the call starts, with the same function the turn uses
   (`firstInferenceRequest`, `replyContext`): the words, the played history and its cut flag
   (`PlaybackConversation.peek`), the briefing and call facts, the tools. Nothing is asked while the
   agent still has lines to play (`PlaybackConversation.speaking`): they would change the history.
   Nor for a pending confirmation, a repeat request, words outside the agent's languages, an ended
   flow or opt-out, or an agent that retrieves passages first.
3. `finalize` aborts a call asked on other words before the turn starts; the turn takes the call
   (`takeLlm`) and its inference step uses it only if its first request is the same (the caller's
   words compared as `normalizeForMatch` reads them, plus a question mark and a cut-off, which decide
   the web search tool: `callerMatchKey`). Anything else is aborted: speculation can make a turn
   faster but never change what it says. `discard` and `cancel` (barge-in, supersede) drop the
   call; words still waiting out the debounce survive a barge-in, since they are the barge-in. On a
   hang-up the engine discards the open utterance before it cancels, so no call starts after the
   session ends.
4. The request carries the turn's tools, so the OpenAI plugin decides the web search exactly as it
   would for the turn (`unclearForSearch` on the same words) and a needed search starts early.

Measured (`behaviors/tests/speculation-llm-partials-replay.test.ts`, the three Maya calls of
2026-10-07 replayed with gpt-6-luna's 1,367 ms first token): 9 of 37 turns get their first token
0.19–1.37 s sooner, 8.1 s in all as recorded (~380 ms endpointing) and 10.6 s at today's ~1 s
endpointing; no turn is later. The cost is 14–15 calls thrown away per 37 turns, each billed for its
input (and a search it had started), metered by the plugin as estimates. Call 6e1a4e3a turn 1
("हाँ।", held 1.9 s as a possible backchannel): first token 635 ms after the turn instead of 2,321
(`speculation-llm-partials.test.ts`).

Known gap: the worker stamps a reply stage (`llm_first_token`, `web_search`) with the turn running
when it starts, so a call started on a partial is timed from its own start and may be stamped on
the previous turn. `firstAudioMs` from the end of the turn is unaffected.

## Metering

`AgentBehavior.speculationMetrics`:

| Field      | Counts                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------- |
| `decision` | `started`, `modelCalls` (billed round trips), `reused`, `discarded`, `cancelled`, `skipped` |
| `llm`      | `started`, `used`, `aborted` (not asked), `discarded` (asked otherwise), `onPartials`       |

The OpenAI plugin meters an aborted call's input as `estimated` `input_tokens` and
`uncached_input_tokens` (about four characters a token over everything the request sent), request
id `openai:aborted:<n>`. Barge-in aborts are metered the same way. Output and reasoning tokens of an
aborted call are not estimated.

## `resume_flow` replies

The inference port delivers a tool call whole (`InferenceStreamEvent` has no argument deltas), so a
reply the LLM puts inside `resume_flow` is spoken only once the call has arrived. The model is told
to say its answer as plain text first, which streams. That path needs the plugin-kit fix in the
Wave 4 cross-lane patch: `AiSdkInference` refused text followed by a tool call.
