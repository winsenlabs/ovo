# @winsendotai/ovo-plugin-router

The conversational router of a routed call (Wave 15, R1; design: `r1-routing-design.md` §7.5-7.6).
It runs as segment 0 of a call whose number is bound to a routing release: it greets the caller,
works out language and intent from what they say (or key in), asks again when unsure, picks a pool
member or an agent, prepares that agent's session graph through the host, says a short connecting
line and completes. The worker then swaps segments on the same carrier leg.

Package kind: `plugin` (imports only contracts, runtime and zod).

## What it provides

- `createRouterBehaviorPlugin()`: behaviour plugin `@winsendotai/ovo-behavior-router` (v2 manifest,
  kind `behavior`, session scope). Requires `ovo.routing` (`RoutingHost`) and
  `ovo.segment-handoff` (`SegmentHandoffPort`), both provided by the worker host; reads
  `ovo.inference`, `ovo.decision` and `ovo.event-sink` when the router release selects them.
  Config: `{ agent, workspaceId, sessionId, routing }`, where `routing` is the
  `RoutingReleaseSnapshot` and `agent` the router release's agent config.
- `RouterCore`: the whole routing conversation, free of IO. The host, the handoff port and the
  engines are injected and time is `host.now()`, so a simulator or the eval harness (R4) can drive
  it with `opening()`, `turn()` and `idle()` and read `recorder.events`.
- `@winsendotai/ovo-plugin-router/testing`: `fakeRoutingHost`, `fakeSegmentHandoffPort`,
  `scriptedEngines` and `exampleRoutingSnapshot`, for the worker lane and for simulators.
- `simulateRoute` (R4, `src/simulate/`): runs a scripted caller through a routing snapshot with
  `RouterCore` over a simulated host (virtual clock, claims ranked like the claim store, never
  written), a simulated handoff port and scripted decision, LLM and external answers; rules run for
  real. Offline, deterministic for a fixed clock, and it never dials anything. `explainPool` says why
  each member of a pool is or is not a candidate and who would be claimed (it shares its eligibility
  predicate, `screenPool`, with `eligibleTiers`). `scoreRoutingCorpus`, `routingScorecardGate` and
  `routingCorpusDigest` (`src/eval/`) turn a corpus of cases into a scorecard and a regression gate;
  the CLI is `pnpm eval:routing`. See [docs/eval/routing.md](../../docs/eval/routing.md).
- `src/wire/`: the simulation and eval request, result and scorecard shapes (R4 design section 3).

## How a node decides

1. A value the route context already holds for the node's `sets` key, naming one of its branches
   (`engine: context`).
2. The node's engines, in order; the first `matched` at or above its threshold wins:
   - `rules`: keypad digits, caller-id prefix, time of day (`RoutingHours` in an IANA zone),
     a call variable, whole keywords, exact phrases, or the script the reply is written in. Every
     matcher of a rule must hold; the first rule wins with confidence 1. Text is compared after
     normalisation that keeps Indic letters and vowel signs.
   - `decision`: one choice question `route` to the release's decision slot (Jev today), whose
     criteria are the branch descriptions. Replies are checked with `validateDecisionExchange`.
   - `llm`: the release's LLM with exactly one tool, `ovo_route` (branch enum plus null,
     confidence, optional language, optional clarifying question).
   - `external`: the host's signed webhook. The secret and the egress policy stay in the host; the
     plugin only decides what is sent and judges the answer.
3. Nothing decided: the node's fallback chain, resumed where it last stopped: `reask` →
   `default` (pool or agent; absent target = release default) → `human` (R3; skipped in R1 and
   recorded) → `callback` → `end`. An exhausted chain, or the turn or time limit, falls to the
   release default agent; if even that cannot be prepared, a built-in goodbye.

A chosen branch with `next` enters that node and, with `reuseTurn`, evaluates it on the same
utterance (at most 8 nodes per turn). Everything is recorded as `route.node`, `route.fallback` and
one `route.decision` event (ids, keys and timings; never caller words or numbers).

## Operator notes

- **The router release's own prompt, opening, decision questions and tools are ignored.** The
  router release supplies only the voice: STT, TTS, LLM, decision slot, turn detector, language,
  timezone, recording and cost policy. What the router says comes from the routing release
  (`greeting`, node `ask` lines, fallback lines, `connecting`), never from the agent config.
- **LLM confidence is uncalibrated.** The `llm` engine's confidence is the model's own number; it
  is not measured against any cohort and is not comparable across models or languages. Treat its
  threshold as a tuning knob, not a probability, and prefer rules (keypad, keywords) where a
  route must be deterministic. Generated clarifying questions are off by default
  (`generatedClarify`), and the classifier can only ever pick a configured branch or language.
- Lines are chosen in the caller's language when it is known (an LLM with `detectLanguage`, a
  `sets: language` node, or an external slot), else in the release's default language. Only `en`
  and `hi` have built-in connecting and goodbye lines.
- Capacity is soft: when claim storage is unavailable the router still connects the chosen member
  and records `degraded: claims_unavailable` on the decision.
- A caller who barges in on the connecting line does not undo the handoff; a committed handoff is
  final. Cancelling a turn, or disposing the router, abandons a handoff that was prepared but not
  committed.
- Hours windows include their start minute and exclude their end minute, are read on the zone's
  wall clock (so DST moves the instant, not the local time), and a day missing from `weekly` is
  closed. Split an overnight window in two.
