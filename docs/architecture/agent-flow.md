# The state-aware decision flow

Wave 3 flow lane (AGT-1, AGT-7, AGT-14, and the AGT-5 identity gate). Contracts live in
`packages/contracts/src/agent-flow*.ts`; the runtime in `packages/behaviors/src/flow-*.ts`,
`decision-gate.ts`, `agent-decision-step.ts`, `agent-inference-step.ts` and `script.ts`; the release
checks in `packages/session-host/src/compat/flow-*.ts`; the editor in
`apps/console/components/studio/flow-*.tsx`.

## Why

The flat decision policy sent every question and every option on every turn, with no idea what the
agent had just asked and no "none of these" option. On the CreditMantri flow that was 31 options per
turn, and Jev routing was poor. The POC that worked asked only the 5 to 8 intents of the current
listen set, plus 4 global intents and `other`, grounded in what the agent just said. The flow is that
model, as data.

## Authoring

The flow sits inside the decision policy, so slot selection, metering, pre-warm and the plugin checks
treat it like any enabled policy. It replaces `questions`; a policy with both is refused.

```json
{
  "decision": {
    "enabled": true,
    "timeoutMs": 800,
    "flow": {
      "start": "greet",
      "context": "A collections agent is calling about a missed EMI.",
      "lines": {
        "intro": "Hello, I'm calling from CreditMantri.",
        "ask_identity": "Am I speaking with {{full_name}}?",
        "goodbye": "Thank you for your time. Goodbye!"
      },
      "nodes": [
        { "id": "greet", "say": ["intro", "ask_identity"], "listen": "identity" },
        { "id": "disclose", "say": ["..."], "listen": "payment", "verified": true },
        { "id": "goodbye", "say": ["goodbye"], "end": true, "disposition": "completed" }
      ],
      "listens": [
        {
          "id": "identity",
          "question": "The agent asked who picked up. How did they respond in `caller_reply`?",
          "intents": [
            {
              "key": "confirmed",
              "description": "They confirm they are the named person",
              "phrases": ["yes", "haan ji", "speaking"],
              "next": "disclose"
            }
          ]
        }
      ],
      "globalIntents": [
        {
          "key": "repeat",
          "description": "They want the agent to repeat what it said",
          "repeat": true
        },
        {
          "key": "stop_calling",
          "description": "They ask not to be called again",
          "next": "goodbye"
        }
      ],
      "threshold": 0.55,
      "fallback": "llm",
      "repeatPrefix": "repeat_prefix"
    }
  }
}
```

| Field                 | Meaning                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodes[].say`         | Line ids spoken on entering the state, one segment each (so each line is its own cached clip). No lines: the LLM composes that turn's reply, and the state still listens. |
| `nodes[].listen`      | The listen set for the next reply. Required unless `end`.                                                                                                                 |
| `nodes[].end`         | The call ends once the lines have played; a barge-in keeps it open.                                                                                                       |
| `nodes[].disposition` | Recorded on the transition, such as `promise_to_pay:tomorrow`.                                                                                                            |
| `nodes[].verified`    | Entering the state confirms identity (see "Identity gate").                                                                                                               |
| `intents[].phrases`   | Whole replies matched after normalisation with no decision call. Never patterns.                                                                                          |
| `intents[].next`      | A state id, or `{slot, cases, otherwise}` to route by a slot answered in the same request.                                                                                |
| `intents[].repeat`    | Replays the last state's lines, after `repeatPrefix`, and stays put.                                                                                                      |
| `listens[].slots`     | Extra choice questions asked in the same round trip ("by when will they pay").                                                                                            |
| `threshold`           | Below it the intent is not trusted. Slots below it are dropped, so the route takes `otherwise`.                                                                           |
| `fallback`            | What a reply that fits nothing does: `llm` (answer, then rejoin) or `clarify` (the `clarify` line or the agent's clarification, no LLM).                                  |

Graph rules are not in the schema, so a half-built draft still saves. They are release blockers:
`flow_invalid` (unknown start, state, listen set or line; a state nothing reaches; duplicate intents,
including a local intent that repeats a global one; the reserved `other` and `intent` ids; a phrase
that means two intents; slot routes that name options the slot does not have; a reserved
`resume_flow` tool), `template_variable_undeclared` for flow lines, and
`decision_primitive_unsupported` when a listen set is wider than the selected model accepts. A line
or listen set nothing uses is a warning only.

## A turn

1. The first turn enters `start` whatever the caller said. With the agent wiring in place, a flow
   whose start state has lines greets first, after any `opening` lines, and outbound calls wait for
   the answering-machine verdict exactly as they do for an opening.
2. A reply is matched against the current listen set's phrases, then the global phrases.
3. Otherwise one request asks the `intent` question (listen intents, then globals, then `other`) and
   every slot. The state is the POC's: `caller_reply`, `agent_last_said` (everything the agent said
   since the caller last spoke), `recent_turns`, `today`, plus `variables`, `briefing` and `retrieved`
   when the policy lists those sources. Node ids, lines and dispositions never reach the model.
4. A trusted intent enters its state; `other`, low confidence, a timeout or an error runs `fallback`.
5. The step is committed only after the turn is known to be current, so a superseded turn never
   moves the call. Every transition is kept on `FlowSession.path` (last 100): tier
   (`start`/`rule`/`decision`/`fallback`/`llm`), intent, confidence, slots, model, disposition, and
   the ids of lines the call's data could not fill.

The decision port receives `trace: {flow: {node, listen}}` for telemetry. It is never sent to the
vendor (`plugin-decision-jev/tests/flow-request.test.ts`).

## The LLM rejoins (AGT-7)

When the flow hands a reply to the LLM, the LLM is offered a `resume_flow` tool:
`{reply, resume_at, action}`. `resume_at` is an enum of the listen sets the flow offers now (and
`end` when `ending.llmTool` is on); `action` is `none` or `end_call`. The prompt lists each resume
point with its question. The reply is spoken, and the next turn is judged in the chosen listen set,
back on the cheap decision path. A resume point the flow does not offer leaves the call where it was
(`reason: invalid-resume`), and so does a plain text answer. A model that streams its reply as text
and then calls the tool is handled too: the text is kept and only the resume point is applied.

Known limit: the reply inside the tool is not streamed to TTS as partial JSON, because the inference
port has no structured-output stream. A model that answers in text first keeps streaming.

## Identity gate (AGT-5 follow-up)

If any state is `verified`, the LLM's "Call facts" are replaced by a notice that identity is not
confirmed until such a state is entered, and the LLM may only resume at listen sets reachable before
it. It cannot talk its way past verification.

## Scripts mode versus agent mode (AGT-14)

- **Agent mode** routes by flat questions or by a flow, and the LLM composes what neither covers.
- **Scripts** (announcement or FAQ mode with `script`) move only along transitions the author wrote.
  With `decision: {enabled: true}` and a decision plugin selected, a reply that matches no transition
  exactly is classified among the current node's text transitions (one option per target, described
  by the replies written for it, plus `other`). Only an answer at 0.7 confidence or more moves the
  script; anything else falls through to the FAQ detour or the clarification line, as before. DTMF
  never goes to the model.
- A policy a mode would silently ignore is refused at release (`decision_mode_unsupported`): questions
  or a flow outside agent mode, any policy on a mode with no script, and an agent policy with neither
  questions nor a flow.

## Not done here

- The agent orchestration (`behaviors/src/agent.ts`), the script plugins' optional decision read
  (`behaviors/src/index.ts`), the new compat codes in `contracts/src/blockers.ts`, the voicemail
  default, the clip inventory and the telemetry fields are owned by other lanes; they were sent as a
  cross-lane patch with tests that skip until it is applied.
- Node actions (sending a payment link from a state) are not in the contract yet: a write without the
  caller's confirmation needs its own policy decision.
