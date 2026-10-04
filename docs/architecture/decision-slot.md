# The decision slot

A decision model answers a fixed question with a calibrated confidence. OVO treats it as a plugin
slot alongside `engine`, `carrier`, `stt`, `tts` and `llm`, selected per agent and pinned per
release. The first plugin is TypeSafe Jev (`packages/plugin-decision-jev`).

**Why it exists.** On a confident answer the turn is answered from authored text, so there is no LLM
round trip at all. That is the latency claim, and it is the one thing the tests measure directly:
in `packages/distribution/tests/decision-session.test.ts` the confident path gives the fixture LLM
an **empty** wire script, so an inference request would fail the call outright.

## What an operator authors

In the studio, per agent, under **Decision model** (agent mode only):

| Authored            | Reaches the model? | Notes                                                       |
| ------------------- | ------------------ | ----------------------------------------------------------- |
| The question text   | **yes**            | `instructions`.                                             |
| Each allowed answer | **yes**            | Its description is the only authored prose the model reads. |
| The expected answer | no                 | Reported back as `asExpected`, for drift review.            |
| The outcome         | no                 | What the agent says when that answer wins.                  |
| The threshold       | no                 | Confidence at or above which the answer is used.            |
| The fallback        | no                 | `llm` or `clarify`, below the threshold.                    |
| The state sources   | n/a                | Exactly which state the model is shown.                     |
| The deadline        | no                 | A decision sits in front of the reply.                      |

The split is enforced, not merely intended: `decisionQuestionPayload` is the only bridge, and
`packages/contracts/tests/agent-decision.test.ts` asserts the payload leaks no threshold, no
expectation and no outcome text. A model that could read what its answer will trigger is judging its
own consequences.

Three answer shapes, mirroring the published TypeSafe primitives: **choice** (2–255 described
options), **noul** (yes/no), **score** (a 2–10 level rubric, with bands over the weighted score).
All questions on an agent are asked in ONE request, so a second question costs no extra round trip.

## What the runtime does

`DecisionGate` (`packages/behaviors/src/decision-gate.ts`) compiles the request, calls the selected
plugin, and **re-validates the exchange itself** — a third-party decision plugin is the point of the
boundary, and "the answer matches the question asked" is not an invariant the host delegates.

- Confidence **at or above** the threshold → the authored line is spoken, LLM untouched.
- Below it → `llm` (the LLM composes the reply) or `clarify` (the agent asks the caller to repeat).
- Timeout, transport failure or an incoherent reply → **falls through to the LLM.** A decision model
  that is slow, down or wrong must never drop a live call. The failure is recorded on
  `behavior.decisions`, with the model id and `calibrationVersion`, for review.
- A cancelled turn is rethrown, never reported as a decision failure.

## What is refused before a release exists

| Code                             | When                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `decision_plugin_missing`        | A policy is enabled and no decision plugin is selected. **Error.**                              |
| `decision_plugin_unused`         | A decision plugin is selected and no question is enabled. Warning.                              |
| `decision_primitive_unsupported` | A primitive, criteria count or question count beyond the manifest's declared limits. **Error.** |
| `meter_uncovered`                | No price card covers the decision meter. **Error.**                                             |

## What a decision cannot do yet, and why

An outcome can only **say** something. It cannot record a business disposition
(`promise_to_pay:tomorrow`), jump to a script node, hand off to a human or hang up.

This is a deliberate absence, not an oversight. `EventSink` and `HumanHandoffPort` are declared in
contracts with no implementation and no caller anywhere in this repository, and `TranscriptObserver`
accepts only `user.transcript` and `agent.transcript` — there is no durable sink a behaviour can
write a disposition to. A script jump has no router, because `AgentConfig` refuses a script outside
announcement and FAQ mode. An outcome field that validates and then silently does nothing is worse
than its absence. These arrive with the disposition log (`PM/CURRENT-STATE.md` item 8) and the intent
graph (P2).

## Calibration is an identity, not a measurement

`DecisionAnswer.calibrationVersion` is `${model}/${binding.calibrationLabel}`, and the label is
required with no default — a default would hand every release a calibration identity nobody chose.
**No per-language calibration has been measured.** The `decision@1` kit checks that confidence
_moves_ with the input, and that it is not constant or rounded; it cannot check that confidence is
_calibrated_, because a fixture returns what it is scripted to return. A green kit run is not a
trustworthy threshold. The threshold an operator picks is a judgement until real calls measure it.

## Grounding

`DecisionRequest.state` is the only input the model gets, and it carries exactly the sources the
operator listed: the last caller turn, the recent transcript, the call variables, the briefing text.
**A decision cannot be grounded in anything the runtime cannot retrieve.** OVO has no retrieval
capability today — `faq` matching is token overlap, `context` is a prompt blob that fails
publication above its budget rather than being queried, and an HTTP or MCP tool is the only way to
reach a corpus. A `knowledge` slot that lands in `state` as one more source is the next unit.
