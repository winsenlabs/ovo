# How an agent starts and ends a call

Wave 2 (AGT-2, AGT-3, AGT-5, LAT-2 and the critic's voicemail item). Contracts live in
`packages/contracts/src/agent-call-control.ts`; the behaviour side in `packages/behaviors/src/agent.ts`,
`agent-variables.ts` and `agent-ending.ts`; the engine side in
`packages/plugin-voice/src/engine/{session-engine,turn-driver,answered-by-gate}.ts`; the worker side in
`apps/worker/src/answering-machine.ts`.

## Authoring (agent mode only)

```json
{
  "variables": {
    "type": "object",
    "required": ["name"],
    "properties": { "name": { "type": "string" } }
  },
  "context": "You are calling {{name}} about their account.",
  "opening": { "lines": ["Hello, this is Asha from Acme.", "Am I speaking with {{name}}?"] },
  "voicemail": { "action": "message", "message": "Please call Acme back.", "timeoutMs": 4000 },
  "ending": { "llmTool": true }
}
```

| Field                  | Effect                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `opening.lines`        | Spoken first, before the caller says anything. Its presence is what makes an agent greet first.                        |
| `voicemail`            | Outbound only. Defaults when an outbound agent has an opening: detect, wait 4s, hang up. `detect: false` turns it off. |
| `ending.llmTool`       | Offers the LLM a reserved `end_call` tool (`goodbye`, optional `reason`). Off by default.                              |
| decision outcome `end` | Ends the call once that turn's reply has played (the outcome's `say`, or the LLM's reply).                             |

Any other mode refuses these fields at validation, so they never validate and then do nothing.

## Variables (AGT-5)

`{{path}}` renders from the call's variables (campaign row, inbound route or live-call request) in
the agent's locale and timezone, using the same formatter as announcements (currency, dates). The
built-ins `today`, `date_tomorrow` and `date_week` are always available; a declared variable shadows
them. Where each template is rendered:

- **Spoken lines** (opening, voicemail message, decision `say`) render strictly. A path that is not
  declared blocks the release (`template_variable_undeclared`, error). A line the call's data cannot
  fill (a declared variable the call does not carry, or a value that does not fit its format, such
  as a non-ISO date or a CSV string for a currency) is never read aloud half-filled and never ends
  the call: an opening line is skipped and recorded on `skippedLines` by field path only (no
  values), and a decision line falls back to the LLM. Campaign rows are not validated against the
  variable schema at admission, so this is the only guard on that path.
- **The briefing** (`context`) renders leniently: an unknown path is left as written (warning).
- **The LLM** also gets a "Call facts" section listing only the declared variables this call
  carries, formatted as they would be spoken, plus today's date. Undeclared call data never reaches
  the prompt, and the prompt is not logged.

## Greet first (AGT-2, LAT-2)

`engine.start()` registers ingress (which buffers caller audio), starts the STT connect, runs the
opening turn concurrently (`respond('', { inputEvent: 'opening' })`: no decision, no LLM), and only
then awaits the STT connect. The first words never wait for the 2-5s STT handshake. The opening is
recorded in history like any played line, so the decision's `agent-last-said` is the greeting.

A line with no placeholder is identical on every call; `staticAgentLines(config)` lists them so the
clip cache can render them once.

## Answering machines (outbound)

The dial request asks the carrier for detection (Twilio async AMD, `DetectMessageEnd`) exactly when
the session will wait for it. The opening waits for the verdict: `human` or `unknown` opens at once,
no verdict opens after `timeoutMs`. `machine` cuts off whatever is playing, leaves the message (if
`action: message`) and ends the call with the `voicemail` outcome; the engine-ended audit records
`voicemail:hangup`, `voicemail:message` or `voicemail:message-failed`. Twilio posts the verdict to
the gateway, which records it in `ovo_carrier_callbacks`; the worker reads that row (100ms during the
hold, 1s after) because the callback can land on any gateway replica. Inbound calls are never held.

## Ending the call (AGT-3)

A turn arms the ending (decision `end`, or the LLM's `end_call`). The behaviour reports
`isComplete()` only once that turn has finished generating and every line it said has a completed
playback receipt; the engine then ends `behavior_completed` (outcome `completed`) with a reason such
as `decision:intent=bye` or `llm:end_call:caller-done`. A barge-in on the goodbye disarms it: the
caller has something to say. Hang-up uses the existing termination path (engine media close →
`terminateOwnedJob` → carrier control hangup).
