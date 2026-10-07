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

| Field                   | Effect                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `opening.lines`         | Spoken first, before the caller says anything. Its presence is what makes an agent greet first.                        |
| `voicemail`             | Outbound only. Defaults when an outbound agent has an opening: detect, wait 4s, hang up. `detect: false` turns it off. |
| `ending.llmTool`        | Offers the LLM a reserved `end_call` tool (`goodbye`, optional `reason`). Off by default.                              |
| `ending.minCallerTurns` | `end_call` is refused before the caller has taken this many turns (default 2; 0 lifts it), unless they say goodbye.    |
| `ending.minCallSeconds` | ...and before the call has run this long (default 20 s; 0 lifts it). Both minimums must be met.                        |
| decision outcome `end`  | Ends the call once that turn's reply has played (the outcome's `say`, or the LLM's reply).                             |

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

## Never on a caller who is talking (wave 7, N1 and N2)

Live Maya calls hung up on a caller who had just said "Hello", and on a first turn misheard as
Russian. Three guards now stand between the LLM and the hang-up:

- **The engine never ends on an open caller turn.** When the behaviour completes while the turn
  detector has a caller turn open, or one waits to be answered, the end is deferred: a turn that is
  reset (a backchannel, noise) lets it go ahead; a turn that stops is answered. Answering it reopens
  an ending the caller can change (`end_call`, a decision `end` that did not end a flow). A final
  one (a flow's end node, an opt-out, a transfer) stays: that turn says nothing and the call ends.
  A final goodbye the caller cuts after hearing part of it still hangs up on the cut (P4).
- **`end_call` waits for an engaged caller** (`EndCallGate`): `minCallerTurns` and
  `minCallSeconds`, unless the caller says goodbye ("ok bye", "phone rakhta hoon", Tamil "பை").
  It is never taken on a turn whose words are untrusted: the turn's variables carry
  `inputUntrusted: true` (`UNTRUSTED_INPUT_VARIABLE`, for whatever judges STT confidence or
  language), or most of its letters are in a script the agent's language does not use (an `-IN`
  agent accepts Latin and every Indian script). Nor right after the agent's own text asked a
  question. A refused `end_call` that followed streamed text leaves that text said and the call
  open; one that was the model's whole reply goes back to the model as a failed operation record
  ("The call was not ended: ... answer the caller."), costing one more LLM step only on a misfire.
  Each refusal is on `toolErrors` with kind `refused`. A reply the caller spoke over before hearing
  any of it, run again on both utterances (AGT-10), counts as one caller turn.

  Decision (conservative default): a refused `end_call` after streamed text may leave a goodbye
  already said ("Thanks, goodbye!") and the call open, silent until the caller speaks or the idle
  prompt runs. Hanging up on a caller who might still be there is the worse failure; if the caller
  then hangs up, the call reads `caller_hangup`. Re-prompting the model or playing an "Anything
  else?" line instead is open.

  Nothing yet sets `inputUntrusted` from STT confidence: low-confidence English still passes the
  gate. Off-language turns (Dutch, Russian) are kept from the LLM by the agent's language guard
  (N4) before `end_call` can be offered.

- **The end reason survives the hang-up.** The engine's own ending is put on the worker's media
  link before the carrier hang-up, so the stream stop that the hang-up causes finishes the session
  `behavior_completed` (or `max_duration`) instead of `caller_hangup`; the outcome, `session.outcome`
  and the call summary's `endReason` agree with `session.engine-ended`. Only that event's detail
  carries which ending it was (`llm:end_call:<reason>`, `decision:flow:...`); carrying it into the
  outcome and the summary is follow-up work.

## How much of a line was heard (`playedMs`)

Each speech receipt carries `playedMs`: from when the line's audio reached the carrier (or the
line before it finished, when it was sent ahead) to when it completed or was cut. The behaviour
learns the call's pace from lines that played to the end (75 ms a character until 40 characters
have been timed) and counts a cut line as heard once 90% of it played. A terminal goodbye cut in
its last words therefore ends the call instead of being said again in full. A cut LLM goodbye still
disarms the ending (the caller is talking), and P5 mandatory lines (the recording disclosure, a
flow's mandatory lines) still need a completed receipt: a compliance line cut at 95% is said again.

## Protecting the opening (wave 7, N8)

The default turn detector protects the agent's first speech before the caller's first turn: for
`opening.protectMs` (1800 ms) from its start nothing barges in, and after that, with
`opening.confirmWords`, only words two transcript revisions agree on (same first word) do. The
caller's words are not lost: their turn stops as usual and is answered after the greeting. The
window runs from the opening's `bot.started`, which for the call's first line is the start of its
synthesis (no audio has reached the carrier yet to time it by), so 1800 ms leaves about 1.5 s of
heard greeting after TTS first byte (~140 ms on the Maya calls) and carrier delay. Set
`opening: { "protectMs": 0, "confirmWords": false }` on the turn detector row for the old
behaviour.
