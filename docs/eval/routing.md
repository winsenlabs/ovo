# Routing eval and the route simulator

Routing decides which agent, person or ending a caller gets. This page covers how that decision
is measured without placing a call: the simulator (`simulateRoute`), the pool explainer
(`explainPool`), the scorer (`scoreRoutingCorpus`) and the offline gate (`pnpm eval:routing`). The
routing design is in [../architecture/routing.md](../architecture/routing.md); the call-quality
harness, which this one is modelled on, is in [README.md](README.md).

A corpus of caller scripts is run through a published routing release; every case says where the
call should end up; the scorecard says how many did and where the router hesitated. A scorecard
against a committed baseline is a regression gate that `scripts/mini-ci.sh` runs offline on every
merge: a change to the tree, the rules, the pools or the router itself that moves a decision fails
the build.

## What a number here means

**Offline runs measure the tree, the rules and the pools, not a model.** The LLM, decision and
external engines are _scripted_: a case carries the answer each engine gives (recorded from a real
call, or authored). A 100% offline score says the release routes those answers as intended; it says
nothing about whether a model would give them. Every scorecard carries `engineMode`: `recorded`
(scripted answers) or `live` (at least one engine ran for real, which costs money and is not
deterministic). Read a `live` score as a measurement of that engine too.

What the simulator does and does not model (its fidelity):

| Real in a simulation                                                                                                                     | Simulated                                                                                             | Not modelled                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `RouterCore`: node walking, `reuseTurn`, the fallback chain, limits, idle prompts, pool eligibility and ranking, callbacks, dispositions | The host: a virtual clock, claims that rank like the claim store and never write                      | Speech and audio: typed words are exact, there is no STT or TTS error       |
| The rules engine, with every matcher                                                                                                     | The handoff port: it accepts unless a fault says otherwise, with the real `HandoffBeginFailure` codes | In-call agent transfers after routing (the catalogue is validated, not run) |
| Member hours, read on each member's wall clock (daylight saving included)                                                                | Engine answers (`decision`, `llm`, `external`), unless the engine is run live                         | Operator staffing: a desk refuses `no_operators` only when a fault says so  |
| Human queue hours and the bound-queue precheck order                                                                                     | Time: 3 s per caller turn, the idle timeout for silence, 0 ms for scripted engines                    | A claim is a snapshot of the load, not a reservation                        |

Because the simulator drives the same `RouterCore` the worker drives, it cannot disagree with the
router about a decision. Three tests hold that line: a differential test (every router replay
conversation says the same lines and records the same `route.*` events through the simulator), a
property test (`explainPool` and `eligibleTiers` agree on 3000 generated pools, and the simulated
host claims whom the explanation picked) and a live-path test (a real routed call and its
simulation make the same decisions, `tests/e2e/routing-simulate-parity.test.ts`).

## Running it

```bash
pnpm eval:routing                                  # the committed worked-example corpus
pnpm eval:routing --baseline packages/eval/baselines/routing-worked-example.json   # the gate (exit 1)
pnpm eval:routing --corpus <dir> --label mine --out /tmp/routing
pnpm eval:routing --save-baseline packages/eval/baselines/routing-worked-example.json
pnpm eval:routing diff <baseline.json> <candidate.json> [--thresholds file]
pnpm eval:routing snapshot --write                 # regenerate the worked example's snapshot.json
pnpm eval:routing --live llm --llm-model <id> --keys ~/.ovo-eval/keys.env   # the classifier for real
pnpm eval:routing --live llm,decision --llm-model <id> --decision-calibration-label <label> --keys ~/.ovo-eval/keys.env
```

(`pnpm eval:routing` is `tsx packages/eval/src/routing/cli.ts`.) Each run writes `<label>.json`
(the scorecard, plus `label`, `generatedAt` and the commit), `<label>.md` and `<label>.html` (one
self-contained page: headline numbers, the gate's verdict, shaded confusion matrices) to `--out`
(default `packages/eval/out/`, not committed). Exit codes: 0, 1 when the gate fails, 2 on a usage
or run error. `--assume-transfer` and `--assume-human` force those switches on whatever the corpus
says.

**`--live llm,decision`** runs those engines against the real services instead of the scripted
answers. The scorecard is labelled `engineMode: live`, so it measures the engine as well as the tree;
it costs money, varies run to run, takes at most 8 caller turns a case (longer cases fail with
`run: live_turns_exceeded`), and cannot be saved as a baseline.

- **llm** is provider-configurable: `--llm-provider` (default `openai`, the only entry in
  `packages/eval/src/routing/live-llm.ts` today; add an inference plugin there to add another),
  `--llm-model`, `--llm-key-env` (the variable in the `--keys` file that holds the key; default the
  provider's own, `OPENAI_API_KEY` for `openai`) and `--llm-base-url` (an https endpoint that serves
  the provider's API; plain http only for localhost). Each also reads `OVO_EVAL_LLM_PROVIDER`,
  `OVO_EVAL_LLM_MODEL`, `OVO_EVAL_LLM_KEY_ENV` and `OVO_EVAL_LLM_BASE_URL`; a flag wins. A key can be
  in the `--keys` file or in the environment as `OVO_EVAL_<name>`.
- **decision** runs the Jev adapter: `--decision-calibration-label` (required, or
  `OVO_EVAL_DECISION_CALIBRATION_LABEL`), `--decision-model` (optional), and `JEV_API_KEY` in the keys
  file (or `OVO_EVAL_JEV_API_KEY`).
- **external** cannot be run from the CLI: it needs the release's own signed webhook host and
  secrets. The API's simulator runs it live behind its own flags.

The CLI paths are unit-tested with fake engines and have not been run against the real providers in
CI, which holds no keys.

## The corpus

A corpus is a directory:

| File            | What                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `corpus.json`   | `schema` (`ovo.routing-eval/1`), `name`, the `snapshot` and `cases` file names, `assume`, `overrides` and `router`. |
| `snapshot.json` | A `RoutingReleaseSnapshot`: the published release the cases run on, pools and bound queues included.                |
| `cases.jsonl`   | One `RoutingEvalCase` per line, at most 500, ids unique.                                                            |

`assume` sets the switches the run assumes (`transferEnabled`, default `false`; `humanQueueEnabled`,
default `true`). Transfers on is what gives the router `begin`: a pool at capacity can queue, a
human queue can be reached, the disclosure is said. `overrides` lets a tag change the assumption
(`{ "tag": "no-transfer", "assume": { "transferEnabled": false } }` runs those cases as the R1
router did, with no `begin`). `router` is what the router release's agent config contributes:
its `timezone` (the zone a promised callback is dated in) and the `disclosure` parts it says.

### A case

```json
{
  "id": "sales-hi-llm",
  "description": "A Hindi caller asks for a new card; the classifier answers sales with 0.91 in Hindi",
  "tags": ["sales"],
  "call": { "from": "+919876543210", "variables": { "vip": "yes" }, "at": "2026-10-15T06:30:00Z" },
  "turns": [{ "kind": "speech", "text": "mujhe naya credit card chahiye" }],
  "answers": [
    { "node": "intent", "engine": "llm", "branch": "sales", "confidence": 0.91, "language": "hi" }
  ],
  "faults": { "fullMembers": [], "failedReleases": [], "queues": { "desk": "no_operators" } },
  "expect": { "status": "agent", "member": "sales-hi", "language": "hi", "fallback": "none" }
}
```

- **`turns`** are the caller's, after the greeting (the opening always runs first): `speech`
  (`text`, at most 500 characters), `dtmf` (`digits`, `0-9*#`) and `silence` (the idle timeout
  passes). At most 20.
- **`call`**: `from`/`to` (E.164), `variables` (what `variable` rules read) and `at`, the clock
  `time` rules and member hours read. **Without `at` a case starts on Thursday 2026-10-15 06:30 UTC
  (noon in Kolkata)**, never the real time, so a corpus gives the same answer every day. Set `at`
  whenever hours matter.
- **`answers`** script the engines the router asks. Rules always run for real.
  - Answers are consumed **in order per (node, engine)**. `repeat: true` keeps that answer for
    every later call (put it last).
  - With a `branch` and no `outcome`, the outcome is derived the way the real engine would: `matched`
    at or above the engine's own `threshold` (missing `confidence` counts as 1), else
    `low_confidence`. With no branch, an LLM that cannot tell is `low_confidence`, a decision or
    webhook that names nothing is `no_match`. Name an `outcome` (`timeout`, `error`, `disabled`, ...)
    to script a failure.
  - Fields an engine could not produce are dropped: `language` unless the LLM has `detectLanguage`,
    `clarify` unless it has `generatedClarify` (and only on `low_confidence`), `slots` outside a
    webhook's allow-list.
  - An engine the router asks with nothing left to say answers `no_match` (`unscripted`) and the
    run warns once (`engine_unscripted`). **A node with `reuseTurn` is also asked on the turn that
    entered it**, so script that call too (an explicit `no_match`) before the answer meant for the
    next turn; or give the node `reuseTurn: false`.
- **`faults`**: `fullMembers` (`poolId` + `memberId`) are treated as at capacity; `failedReleases`
  fail when prepared (`compose_failed` or `timeout`); `queues` makes a bound queue key refuse at
  `begin` (`queue_closed`, `queue_unavailable`, `no_operators`, `queue_full`).
- **`expect`** is one or more of the fields below. A case passes when **every field it asserts**
  equals what happened.

| `expect` field      | What it asserts                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `status`            | How the route ended: `agent`, `queue` (every member full, held for capacity), `human`, `end` or `callback`.         |
| `path`              | The exact node path, root first.                                                                                    |
| `node`              | The node the route ended at.                                                                                        |
| `branches`          | `{ node: branch }`: the branch each node should choose. Feeds the confusion matrix. A node never reached is `none`. |
| `pool`              | The pool the member came from, by name or id (for `queue`, the pool that is waiting).                               |
| `member`, `agentId` | The pool member and agent that took the call.                                                                       |
| `queue`             | The bound human queue key.                                                                                          |
| `language`          | The language the route ended with (the caller's, or the default).                                                   |
| `fallback`          | The deepest fallback step reached: `none`, `default`, `human`, `callback`, `end`, `release_default` or `limit`.     |
| `clarify`           | Whether the router asked at least one clarifying question (a re-ask).                                               |

`undecided` (the script ended before the router decided) is never an expected status; a case that
should not decide asserts `clarify` or `fallback` instead.

## The scorecard

| Part                | Definition                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totals`            | Cases, passed, failed.                                                                                                                                                                                                                                                                                                                                                                                         |
| `accuracy.*`        | For each field (`status`, `path`, `node`, `branch`, `pool`, `member`, `agent`, `queue`, `language`): correct / cases that assert it. `overall` is passed / cases. A field nobody asserts has `rate: null`.                                                                                                                                                                                                     |
| `fallbackRate`      | Cases that reached a fallback step / cases. A case reaches the **deepest** of: a step that was taken, or the release default even when it failed (the chain was exhausted). Order, shallow to deep: `default`, `human`, `callback`, `end`, `release_default`, `limit`. Skipped and failed steps before it, re-asks, and a branch target that failed are not fallbacks. `byStep` counts cases per deepest step. |
| `clarifyRate`       | Cases where a re-ask was taken at least once.                                                                                                                                                                                                                                                                                                                                                                  |
| `endRate`           | Cases that ended in `end` or were `undecided`.                                                                                                                                                                                                                                                                                                                                                                 |
| `perEngine`         | Every engine verdict (`rules`, `decision`, `llm`, `external`, and `context`, a value the route already held): attempts and counts per outcome.                                                                                                                                                                                                                                                                 |
| `confusion`         | Per deciding engine, a matrix of the branch expected at a node (rows) against the branch that engine chose (columns). A node nothing decided is `none`, attributed to the last engine that tried; a node the router never reached is left out.                                                                                                                                                                 |
| `calibration`       | Matched `decision`, `llm` and `external` verdicts bucketed by confidence (`0-0.5`, `0.5-0.7`, `0.7-0.9`, `0.9-1`): how many, and how many chose the expected branch.                                                                                                                                                                                                                                           |
| `perNode`           | Per node: cases that touched it, cases it decided, cases it decided as expected, cases where a fallback step ran there.                                                                                                                                                                                                                                                                                        |
| `byTag`             | Cases and passes per tag.                                                                                                                                                                                                                                                                                                                                                                                      |
| `failures`          | At most 50: the case id, the expected and actual value of each failing field, and one line per difference. **Never the caller's words.**                                                                                                                                                                                                                                                                       |
| `corpus`, `routing` | Names and sha256 digests of the cases (canonical JSON, in order) and the snapshot, so a scorecard says what it was measured on.                                                                                                                                                                                                                                                                                |
| `ms`                | Wall time: total, p50, p95. Not part of the gate.                                                                                                                                                                                                                                                                                                                                                              |

## The gate

`routingScorecardGate(baseline, candidate, thresholds)` fails when:

1. fewer cases pass than in the baseline;
2. a case that passed in the baseline now fails (a swap with a fixed case still fails);
3. any accuracy rate falls, or the fallback, clarify or end rate rises, beyond its threshold;
4. the corpus or the snapshot digest differs from the baseline's: the baseline is stale, and rates
   of another corpus are not comparable. Regenerate it with `--save-baseline`.

Thresholds are fractions and default to zero (the offline corpus is deterministic, so any movement
is a change in the router). A `--thresholds` file may set `accuracy`, `fallbackRate`,
`clarifyRate`, `endRate`, `passed` (cases) and `allowCorpusChange`:

```json
{ "fallbackRate": 0.05, "accuracy": 0.02 }
```

A new failing case is never hidden by a threshold. After an intended change, run
`pnpm eval:routing --save-baseline packages/eval/baselines/routing-worked-example.json` and commit
the new baseline with the change that explains it; `--save-baseline` zeroes `ms`, so the file only
changes when a decision does.

## The worked-example corpus

`packages/eval/corpus/routing/worked-example/`: 45 cases on the "Main line" release of
[../architecture/routing.md](../architecture/routing.md#worked-example), with what the R2 and R3
sections add (a managed desk open in Kolkata office hours, a hold that waits for capacity, a person,
callback and opt-out branch, a billing node that asks a webhook and then the decision engine, three
router turns). The tags: `sales` (Hindi, English and Tamil callers, the Tamil agent's office hours
at 08:59, 09:00, 18:00, at night and on Saturday), `support` (keypad then keyword, the classifier,
product unknown), `reuse-turn` (one utterance answers two nodes), `dtmf-late` (the keypad after a
mumble), `fallback` (every step: re-asks, person, default, full pools, release default, the turn
limit), `clarify` (authored and generated questions), `human` (open, closed, no operators, full,
transfers off, a VIP caller-id rule that decides on the opening), `callback`, `end`, `idle`,
`queue` and `billing`. `snapshot.json` is `workedExampleSnapshot()`
(`packages/eval/src/routing/worked-example.ts`) written out; a test regenerates it, and another
requires the committed baseline to equal today's scorecard, so neither can drift.

## Adding a case

1. Pick the release: the worked example's `snapshot.json`, or your own in a new corpus directory.
2. Add a line to `cases.jsonl`: a unique `id` (`[a-z0-9._-]`, at most 80), `tags`, the `turns`, the
   `answers` the engines would give, `faults` and `call` if the case needs them, and `expect` only
   what you mean to pin. Pin fewer fields rather than more: each asserted field is a way for an
   unrelated change to fail the case.
3. Work the expectation out from the release, not from a run: what should this caller get?
4. `pnpm eval:routing --corpus <dir>`: the case should pass; if not, either the expectation or the
   release is wrong, and finding out which is the point.
5. `--save-baseline` and commit the cases, the baseline and (if the release changed) the snapshot.

The console's route tester can write a case for you ("Save as eval case"): it records the typed
script, the mock answers and what happened, to be edited into an expectation.

## From code

```ts
import {
  simulateRoute,
  explainPool,
  scoreRoutingCorpus,
  routingScorecardGate,
} from '@winsendotai/ovo-plugin-router';
```

- `simulateRoute({ snapshot, request, now, router, flags, load?, live?, signal? })` runs one script
  and returns the turns (what the router said, the `route.*` steps, virtual time), the outcome, the
  pool considerations, warnings and stats. A fixed `request.call.at`, `load` and mock engines give
  a byte-identical result. `live` supplies real implementations for the engines the request marks
  `live` (`external`, `decision`, an `Inference` for the LLM); a live engine asked for and not
  supplied throws `SimulationInputError` rather than being mocked, and a live run is limited to 8
  caller turns and a 5 s wall-clock guard.
- `explainPool({ pool, target, context, defaultLanguage, now, load?, fullMembers? })` says why each
  member is or is not a candidate and which one would be claimed; it shares its eligibility
  predicate (`screenPool`) with `eligibleTiers`.
- `scoreRoutingCorpus({ snapshot, cases, name, engineMode, flags, router, ... })` and
  `routingScorecardGate` are what the CLI and the API's eval runs both use.
