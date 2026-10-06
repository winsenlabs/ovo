# Jev-only agents, instant rules, silence and recovery

Wave 3 jevonly lane (AGT-4, AGT-6, AGT-11, AGT-12). Contracts live in
`packages/contracts/src/agent-{rules,recovery,jev-only,rule-targets}.ts`, re-exported from
`agent.ts`. The runtime is in `packages/behaviors/src/{rules,rules-lexicons,rules-gate,reprompt,
reprompt-lines,idle}.ts`, and the silence timer in `packages/plugin-voice/src/engine/idle-watch.ts`.
The console panels are `apps/console/components/studio/{rules-editor,recovery-editor,idle-editor,
jev-only-panel}.tsx`.

Every block below is optional. An agent that sets none of them, which includes every release
published before Wave 3, parses and runs exactly as it did.

## Jev-only (AGT-4)

An agent needs an LLM only when some configured path can reach one. `agentLlmPaths(config)` lists
those paths, and an empty list makes the agent Jev-only:

| Path                                 | Reaches the LLM because                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `decision`                           | there is no enabled decision policy, so every turn goes to it  |
| `decision.questions.N.fallback`      | a question below its threshold defers to the LLM               |
| `decision.questions.N.….outcome.say` | an answer with no line lets the LLM compose the reply          |
| `decisionUnavailable`                | an unavailable decision falls through when nothing else speaks |
| `recovery.exhausted.action`          | recovery hands the turn to the LLM once it gives up            |
| `allowedTools`                       | only the LLM selects tools                                     |

With a flow (after integration with the flow lane), an `llm` fallback and a state with no lines are
paths too.

- `mode_requires_llm` (error) fires only when a path exists and no LLM is selected.
- `mode_llm_unused` (warning) fires when an LLM is selected but no path reaches it.
- The console's "LLM use" panel shows the paths in plain language, or a "Jev-only" badge.
- At run time, a turn that would still reach an absent LLM speaks the didn't-catch line.

When the decision model times out, errors or answers incoherently:

```json
{ "decisionUnavailable": { "line": "Sorry, one moment please.", "action": "reprompt" } }
```

`action: "end"` ends the call after the line (`completed`, reason `decision:unavailable`). There is
no `transfer`: `HumanHandoffPort` has no implementation yet (AGT-15). Without `line`, the recovery
re-ask is spoken. Without this block and without `recovery`, an unavailable verdict still falls
through to the LLM.

## Instant rules (AGT-6)

```json
{
  "rules": {
    "global": [
      { "intent": "intent=pay", "lexicons": ["yes"], "phrases": ["I will pay today"] },
      { "intent": "intent=bye", "lexicons": ["bye", "thanks"], "keywords": ["no need"] }
    ]
  }
}
```

A rule answers a decision question (`<question>=<answer>`, a choice key or `yes`/`no`) with
confidence 1, in memory. When rules answer every question, the decision model is not called (the
verdict's `modelId` is `ovo.rules`). When they answer some, the model is asked and the rule's answer
replaces the model's for those questions. With a flow, `listens.<listenId>` rules name that listen
set's intents; they run after the flow's own `phrases` and before the decision model.

- `phrases`: exact replies, after normalisation (lowercase, punctuation dropped, spaces collapsed;
  Devanagari and Tamil kept).
- `lexicons`: `yes`, `no`, `speaking`, `thanks`, `bye`, `repeat`, `wait`, in English, Hindi and Tamil,
  native script and romanised. Ported from the POC. They match whole replies only, so "yes but not
  today" is not a yes.
- `keywords`: whole words anywhere in a reply of at most `maxWords` words (4 by default).
- `patterns`: regular expressions, anchored to the whole normalised reply. A pattern that can
  backtrack catastrophically is refused when the config is saved: backreferences, lookbehind, a
  repeated group that itself repeats or alternates, and more than 3 unbounded repeats. Replies longer
  than 120 normalised characters skip the rules tier.

## Caller silence (AGT-11)

```json
{
  "idle": {
    "timeoutMs": 8000,
    "prompts": ["Hello? Can you hear me?"],
    "finalLine": "I'm unable to hear you, so I'll call back later. Goodbye."
  }
}
```

- When the agent finishes speaking and nothing is queued, the engine times the silence.
- Caller speech activity, a transcript or a key press disarms the timer; the end of their speech
  re-arms it.
- On each silence the engine runs an idle turn: `respond('', { inputEvent: 'idle' })`.
- Each prompt is spoken in turn as `idle-prompt` speech and kept in history. Then the final line is
  spoken, and once it has played the call ends as `caller_idle` (outcome `no_input`, detail
  `idle:no-input`).
- A caller who barges in on the final line keeps the call open, and anything the caller says starts
  the prompts over.
- While an agent has this block, the turn detector's own idle prompts and hang-up are ignored.

## Repeat, didn't-catch and re-asks (AGT-12)

```json
{
  "recovery": {
    "didntCatch": "Sorry, I didn't quite catch that. Could you say that again?",
    "reprompts": { "intent": "When would you be able to make the payment?" },
    "repeat": { "prefix": "Sure, let me repeat that.", "phrases": ["one more time"] },
    "maxAttempts": 2,
    "exhausted": {
      "action": "end",
      "line": "I'm having trouble understanding, so I'll call back later. Goodbye."
    }
  }
}
```

- `repeat` replays the last turn's lines after the prefix: the opening, a decision line or an LLM
  reply. A recovery or idle line is never replayed. The trigger is the `repeat` lexicon or one of
  `phrases`, and no decision call is made.
- A miss is a clarify verdict, an unavailable decision, an empty reply, or (with no LLM) a turn that
  would have reached it. A miss speaks the re-ask of the question that missed (with a flow, of the
  listen set) or `didntCatch`.
- After `maxAttempts` misses in a row, `exhausted` either ends the call with its line (reason
  `recovery:exhausted`) or hands the turn to the LLM. Any understood turn resets the count.

## Clip cache

Lines without `{{placeholders}}` from all four blocks are listed by `agentRecoveryLines(config)` and
pre-rendered. A Jev-only agent with no recovery block also gets the built-in didn't-catch and give-up
lines. Templated lines are validated against the declared variables like every agent template
(`template_variable_undeclared`).

## Turn-taking defaults (Wave 2 request 1)

- `DISTRIBUTION_DEFAULTS.vad` is `@winsendotai/ovo-vad-energy`, and `SessionDefaults` has a `vad`
  slot.
- A new release whose STT finalises only on a host commit (`forceEndpoint` with no end-of-turn
  signal, such as Scribe with manual commit) gets that VAD preselected.
- The turn detector's `auto` strategy already resolves to `commit` for such an STT.
- AssemblyAI bindings that name no endpointing preset connect with `fast`. This lives in the
  integration patch, because that plugin belongs to no lane.
