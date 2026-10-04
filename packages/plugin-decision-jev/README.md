# @winsendotai/ovo-plugin-decision-jev

The `decision` slot over TypeSafe System One (the Jev model family). It provides `Cap.decision`
(`ovo.decision`) and implements `DecisionPort` from `packages/contracts/src/decision.ts`.

Wire format pinned from the published OpenAPI document:

- source: <https://api.typesafe.ai/openapi.json>
- retrieved: 2026-10-04

## How `calibrationVersion` is resolved

`DecisionAnswer.calibrationVersion` is required on every answer by the contract. **Jev returns no
such field, and nothing in the published document resembles one.** It is therefore composed, not
passed through and not fabricated:

```
calibrationVersion = `${response.model}/${binding.calibrationLabel}`
```

Both halves are real facts about the exchange:

- `response.model` is the model that actually **answered** — documented as "The model name that
  answered", which may differ from the alias the request asked for (`jev-latest` resolves to a dated
  build). A confidence number is only comparable across answers from the same build, so the resolved
  id is the part of the identity the vendor owns.
- `binding.calibrationLabel` is **required** in `bindingSchema` and has no default. It is the
  operator's name for the cohort the confidences were measured against. A default here would hand
  every release a calibration identity nobody chose, which is exactly the fabrication the field
  exists to prevent, so a binding without it is refused in `apply` before any request is built
  (`JevBindingError`), and `resolveBinding` has a test per absent and blank form.

What this does **not** claim: it is an identity, not a measurement. No per-language ECE, cohort size
or recommended threshold is asserted anywhere in this package, because none has been measured. A
caller must not read a non-empty `calibrationVersion` as evidence that the confidence is calibrated
for its language. `PM/units/P1-decision-slot.md` EC1–EC6 define that measurement (a committed
`PM/calibration/<provider>-<model>-<date>.md` report whose filename stem becomes the calibration
version, and a `decision_uncalibrated` admission rule); neither exists yet, and this plugin does not
pretend otherwise. When that report lands, `calibrationLabel` becomes its filename stem and the
composition above still holds.

## Where the published shape differs from the brief this was built against

| Fact           | Brief said                                 | Published document says                                              |
| -------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Path           | `POST /v1/decisions`                       | `POST /v1/systemone` — the default endpoint follows the document     |
| `noul` answer  | carries `confidence` and `probabilities`   | required fields are `[noul, type]` **only**                          |
| `score` answer | `{type, score, confidence, probabilities}` | also carries a required `legend`, which the adapter drops            |
| Statuses       | 401/403/429/5xx behaviour implied          | only **200** and **422** are documented                              |
| Request id     | —                                          | no id field and no id header anywhere, so `requestId` is synthesized |

### The `noul` gap, and why it is handled two different ways

The published `NoulAnswer` carries neither `confidence` nor `probabilities`, and the contract
requires both.

- **`probabilities` is derived**: `{yes: noul, no: 1 - noul}`. This adds no information. The document
  defines `noul` as "Probability of a yes answer or a true statement, from 0 to 1", so for a binary
  question the two-element vector is a restatement of the one number returned, and
  `validateDecisionExchange`'s `noul === probabilities.yes` invariant holds by construction. When a
  body **does** carry a `probabilities` block (the request schema sets no `additionalProperties:
false`, so richer bodies are possible) it is passed through verbatim, so a vendor vector that
  disagrees with `noul` is **caught** rather than overwritten. There is a test for each half.
- **`confidence` is NOT derived**: a noul answer without `confidence` is refused by name
  (`JevProtocolError`, `answers.<id>.confidence`). Nothing in the returned body determines it and the
  document states no definition for it on this primitive, so there is no definitional bridge the way
  there is to a probability vector. Deriving `max(noul, 1 - noul)` would substitute a distance from
  the decision boundary for a measured confidence, which is the failure mode the threshold design in
  P2 cannot tolerate.

The consequence is honest and is **not** worked around: against the API exactly as documented, `noul`
questions are unusable, because every reply would be refused for a missing `confidence`. The noul
fixtures in `src/testing.ts` are annotated `UNCONFIRMED` where they carry a `confidence` the schema
does not list. Confirming whether Jev returns one needs a recorded live exchange, which is out of
scope here — no vendor endpoint is contacted by this package or its tests.

## Metering

One meter, keyed off the required `usage` block, so a release without a price card for it is refused
at admission: **`typesafe.decision.input_tokens`**.

`usage.output_tokens` is read and validated off every body but is **not** metered. Two reasons, and
both point the same way: the document calls `input_tokens` "Number of **billable** input tokens" and
`output_tokens` merely "Number of output tokens used to answer the questions", so output is free; and
`decision@1`'s `usage is emitted at most once per decision` check counts sink calls, so a second unit
per decision fails the kit. (The brief this package was built against asked for both units; one is
what the vendor bills and what the kit admits, so one is what ships. Adding the second is a one-line
change in `meters()` if Jev ever starts billing for output.)

Usage is emitted **exactly once** per `decide()` through `usageOnce`: `reconciled` when the vendor
reported a usage block, `estimated` when it did not (a refusal, a timeout, a cancelled call). It is
read **before** validation, so a body that violates the contract is still metered — the vendor billed
for those tokens either way.

## What this plugin deliberately does not do

It never thresholds, never caches on `state`, never falls back, never renormalizes a probability
vector, and never returns a substitute answer on failure. On any failure it reports and the caller
decides.
