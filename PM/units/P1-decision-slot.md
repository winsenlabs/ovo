# Work unit P1-decision-slot: the `ovo.decision` slot — a selectable, metered, conformance-tested decision-model kind with `plugin-decision-jev` (hosted) and `plugin-decision-laya` (self-hosted), no routing behavior and no OpenAI Decisions adapter

Wave: post-I1 (item 1)
Depends on: I1-integration (contracts closed), F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Blocks: P2-intent-graph-behavior (three-tier router), P3-prerendered-audio is independent
Defects fixed: none — this is new capability. It closes the I1 carry-forward that `Cap.decision` and `Cap.humanHandoff` are absent from `TypedCapabilities` (`packages/contracts/src/capabilities/map.ts:28-57`), for `Cap.decision` only.

## What this unit does

`packages/contracts/src/decision.ts` already defines the whole wire contract — `DecisionQuestion` (choice/noul/score), `DecisionRequest`, `DecisionAnswer` (confidence + `calibrationVersion` + per-option `probabilities`), `DecisionResponse`, `validateDecisionExchange` and `DecisionPort`. Nothing implements it: an exhaustive grep for every exported symbol hits only that file, `packages/contracts/tests/post-i1-contracts.test.ts`, `capabilities/keys.ts:6,101` and PM prose. `Cap.decision` resolves to `unknown` through `CapabilityMap`, there is no `decision` plugin kind, no `decision` slot, no `decision` usage operation, and no `decision@1` conformance kit.

P1 turns that contract into a **selectable slot**: a `decision` plugin kind that a release pins like `stt` or `llm`, two interchangeable providers behind it, a conformance kit that rejects a provider which fakes confidence or ignores criteria, metering that prices a decision separately from an LLM fallback, and an entry criterion that refuses to trust the confidence number until it has been measured per language on real STT transcripts.

P1 ships **no routing logic**. No tier-1 regex, no threshold comparison, no fallback, no behavior mode, no graph. The threshold lives in the caller (P2); a decision plugin that thresholds internally fails this unit's acceptance.

## Owned paths

- `packages/plugin-decision-jev/**`
- `packages/plugin-decision-laya/**`
- `packages/conformance/src/kit/decision.ts`, `decision-negatives.ts`, `decision-support.ts`
- `packages/conformance/src/drivers/fixture-decision.ts`, `src/drivers/decision-calibration.ts`
- `packages/conformance/tests/broken-fakes-decision.test.ts`
- `packages/session-host/src/compat/decision-uncalibrated.ts`
- `scripts/decision-calibration.mjs`
- `PM/calibration/**`

## Shared touchpoints (minimal edits allowed)

Every edit below is one to four lines unless stated. Each is forced by a closed list — a `satisfies`, a `z.enum`, a `Record<Slot, …>` or a hardcoded slot array — so leaving one out either fails typecheck or silently drops the slot.

| File                                                     | Line anchor                       | Edit                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/capabilities/map.ts`             | `28-57`                           | `[Cap.decision]: DecisionPort` in `TypedCapabilities`, plus the `import type`. Without it `ctx.get(Cap.decision)` is `unknown` and every consumer casts.                                                                                                                    |
| `packages/contracts/src/usage.ts`                        | `3-14`, `18`, `35-40`             | `USAGE_UNITS += 'decisions'`; `UsageOperation += 'decision'`; `OPERATION_SEGMENT += decision: 'decision'`. Without this a Jev call meters as `inference` and is indistinguishable from the LLM fallback in the ledger — the one number the three-tier pitch exists to show. |
| `packages/contracts/src/manifest.ts`                     | `28-45`, `56-64`, `77`, `113-118` | `PLUGIN_KINDS += 'decision'`; `CONFORMANCE_KITS += 'decision@1'`; `MeterDeclaration.role += 'decision'`; `'decision'` into `DECLARED_KINDS`, `METERED_KINDS` and `PROVIDER_KINDS`; `DecisionCapabilities` into the `ManifestCapabilities` union (`:53-54`).                 |
| `packages/contracts/src/manifest.ts`                     | `143-150`                         | `runtime.egressHostsFromBinding: z.array(z.string().min(1)).default([])` — see **Contract gaps** G1.                                                                                                                                                                        |
| `packages/contracts/src/selection.ts`                    | `4-13`, `35-48`                   | `Slot += 'decision'`; `AgentVoice.decision: VoiceSelection.optional()`.                                                                                                                                                                                                     |
| `packages/contracts/src/blockers.ts`                     | `4-28`                            | `COMPAT_CODES += 'decision_uncalibrated'`.                                                                                                                                                                                                                                  |
| `packages/contracts/src/decision.ts`                     | `3-7`                             | Rewrite the header comment so it names no vendor (see §A5 and the provider-name gate). Keep the doc URL in this unit spec and in each plugin README instead.                                                                                                                |
| `packages/contracts/src/index.ts`                        | `17-20`                           | Export `./decision-capabilities.ts`.                                                                                                                                                                                                                                        |
| `packages/runtime/src/registry.ts`                       | `9-18`                            | `PIN_COMPATIBLE_KINDS += 'decision'` so a release resolves exact-or-same-major like every other provider slot.                                                                                                                                                              |
| `packages/runtime/src/installed.ts`                      | `41-49`                           | `SESSION_KINDS += 'decision'` so two installed decision providers for the same `kind:provider` pair are refused.                                                                                                                                                            |
| `packages/runtime/src/net-guard.ts`                      | `19-48`                           | `filteredNet(hostNet, manifest, report, extraHosts?)`; admit `extraHosts` alongside `manifest.runtime.egressHosts` (G1).                                                                                                                                                    |
| `packages/runtime/src/facade.ts`                         | `148`                             | Resolve `egressHostsFromBinding` paths out of `options.config` and pass the hostnames to `filteredNet` (G1). ~12 lines.                                                                                                                                                     |
| `packages/session-host/src/meters.ts`                    | `5`, `16-18`                      | `SelectedMeter.slot` and the iterated slot list gain `'decision'`. `metersFor` skips absent selections, so this is additive.                                                                                                                                                |
| `packages/session-host/src/compat/meter-uncovered.ts`    | `7-12`                            | Add `'decision'` to `required` **only when a decision selection resolved**: `...(entries.some((e) => e.slot === 'decision') ? ['decision' as const] : [])`. Adding it unconditionally would make every existing release a `meter_uncovered` blocker.                        |
| `packages/session-host/src/compat/index.ts`              | `18-20`, `39-56`                  | Import and register `decisionUncalibrated` in `ADMISSION_RULES`.                                                                                                                                                                                                            |
| `packages/session-host/src/legacy-session-selections.ts` | `7-16`                            | `SLOTS += 'decision'`.                                                                                                                                                                                                                                                      |
| `apps/api/src/release-selections.ts`                     | `6-15`                            | `['decision', 'decision']` in `ROLES`.                                                                                                                                                                                                                                      |
| `packages/fixture-calls/src/run.ts`                      | `46-56`                           | `'decision'` in the `selectionsFromVoice` slot list, so a fixture test call can carry a decision plugin.                                                                                                                                                                    |
| `apps/console/components/plugins/types.ts`               | `37-49`                           | `decision: 'decision'` in `SLOT_KIND`. This is `Record<Slot, string>` — **typecheck fails without it.**                                                                                                                                                                     |
| `packages/distribution/src/catalog.ts`                   | after `52-61`                     | Two `FIRST_PARTY` entries, `roles: ['session']`, `load: () => import(…)`.                                                                                                                                                                                                   |
| `packages/distribution/package.json`                     | dependencies                      | Both packages as `workspace:*`.                                                                                                                                                                                                                                             |
| `packages/conformance/src/describe.ts`                   | `43-49`                           | `describeDecision`.                                                                                                                                                                                                                                                         |
| `packages/conformance/src/kit/checks.ts`                 | `12-16`                           | `checkDecision`.                                                                                                                                                                                                                                                            |
| `packages/conformance/src/index.ts`                      | `6-18`                            | Export `./kit/decision.ts`.                                                                                                                                                                                                                                                 |
| `packages/conformance/src/drivers.ts`                    | `5-19`                            | Export `./drivers/fixture-decision.ts` and `./drivers/decision-calibration.ts`. **No vitest import, directly or transitively** — `scripts/check-architecture.mjs:141-162` walks this entry.                                                                                 |
| `packages/conformance/tests/kits.test.ts`                | `23-48`                           | `describeDecision('fixture decision', …, { template: fixtureDecisionTemplate })`.                                                                                                                                                                                           |
| `scripts/check-conformance.mjs`                          | `19-27`                           | `'describeDecision'` into `KITS`.                                                                                                                                                                                                                                           |
| `scripts/check-provider-names.mjs`                       | `8`                               | `NAMES +=                                                                                                                                                                                                                                                                   | typesafe | laya`. Requires the `decision.ts`comment rewrite above;`provider-names.json`is`{}` and P1 does not grow it. |
| `scripts/package-kinds.json`                             | `kinds`                           | `"packages/plugin-decision-jev": "vendor-plugin"`, `"packages/plugin-decision-laya": "vendor-plugin"`. Without these rows `check-architecture.mjs:83` fails with `no kind in scripts/package-kinds.json`.                                                                   |

**Explicitly not edited.** `packages/contracts/src/capabilities/keys.ts` — `Cap.decision` (`:6`) and its `SESSION` spec (`:101`) already exist; adding nothing there keeps `scripts/baselines/capability-keys.json` untouched. `packages/session-host/src/select-session-graph.ts` — the default `configFor` branch (`:94-127`) already yields `{binding, credentialRef, ...config}`, which is exactly what both plugins need; **do not add a slot branch.** `packages/behaviors/**` — no behavior mode in this unit. `apps/console/features/agent-plugins.tsx` / `agent-wizard.tsx` — their `slots` arrays are plain arrays, not `Record<Slot, …>`, so the console simply will not offer the slot yet; that is a named follow-up, not a P1 gap.

## Entry criterion (blocking — satisfied before §C and §D are built)

**The confidence number is not trusted until it is measured.** `DecisionAnswer.confidence` is used by P2 to decide between a scripted branch and the LLM fallback. If confidence is uncalibrated in a target language, the threshold routes a caller into the **wrong branch** instead of falling back — a worse failure than falling back too often, because it is silent. `PM/units/README.md:186` makes this an entry criterion; this unit makes it a gate.

**EC1. Corpus.** Per target language — `en-IN`, `hi-IN`, `ta-IN`, `te-IN`, `kn-IN`, `mr-IN`, `bn-IN` and code-mixed Hinglish/Tanglish — at least 300 labelled caller utterances, drawn from **real STT transcripts that contain recognition errors**, not hand-written clean text. Labels use one intent inventory per listening state (the CM POC's nine LISTEN sets and 28 + 4 intents are the reference inventory: `lib/flow.js`). Every utterance carries its listening state, so each case is a complete `DecisionRequest`.

**EC2. Measurement, offline.** `scripts/decision-calibration.mjs <corpus.jsonl> <responses.jsonl>` consumes a corpus and a **recorded** response file and prints, per language: reliability buckets (10 bins), expected calibration error (ECE), Brier score, the confusion matrix over intents, and a threshold sweep for τ ∈ {0.40, 0.45, …, 0.90} giving accepted-set accuracy, fallback rate and wrong-branch rate at each τ. It makes **no network call of any kind** — responses are recorded in a separate, explicitly authorized session and committed as a fixture. The maths lives in `packages/conformance/src/drivers/decision-calibration.ts` and is unit-tested against hand-computed values.

**EC3. Pass bar.** For every target language: ECE ≤ 0.05; at the τ the report recommends, accepted-set accuracy ≥ 0.90 and fallback rate ≤ 0.25; and no language's accepted-set wrong-branch rate exceeds 2× the `en-IN` rate. Confidence variance across the cohort must be non-degenerate (σ ≥ 0.05) — a provider that returns 0.99 for everything is uncalibrated by construction.

**EC4. Report.** The result is committed as `PM/calibration/<provider>-<model>-<YYYY-MM-DD>.md` with the full per-language table and the recommended τ. Its filename stem is the **calibration version**: `DecisionAnswer.calibrationVersion` must equal it, `DecisionCapabilities.calibration.version` must equal it, and `binding.calibrationId` must name it.

**EC5. Stop condition.** If any target language fails EC3, **STOP**. Report the exact per-language numbers and do not ship a threshold for that language. A failing language is routed to the LLM unconditionally, or P2 ships without that language — both are decisions for the founder, not for the builder. Do not widen the bar, do not average across languages to pass, and do not substitute clean-text transcripts.

**EC6. Runtime teeth.** `calibrationId` is **required** in both plugins' `bindingSchema`. A plugin whose binding names no calibration report, or names one absent from `PM/calibration/`, throws `DecisionCalibrationError` from `apply` — it does not fabricate a `calibrationVersion` to satisfy the contract. The `decision_uncalibrated` compat rule blocks a release whose `AgentConfig.language` is outside the selected plugin's `capabilities.calibration.languages` (error at `release` and `live`, warning at `test`).

## Specification

GOAL: make `Cap.decision` a real, selectable, metered, conformance-tested slot with two interchangeable providers, and make the confidence number trustworthy before anything routes on it. Read `docs/architecture/plugin-platform.md` §2.3–2.4 (native formats; the host adapts), §3.1 (manifest), §3.3 (`ctx.net` and egress), §4.1–4.5 (slots, pinning, compat rules), §9 (vendor plugins) and §13.6 (the conformance gate). Read `packages/contracts/src/decision.ts` in full — it is the contract, it does not change except for the header comment, and `packages/contracts/tests/post-i1-contracts.test.ts` pins it.

Use `ctx.net` only (no `node:https`, no `ws`, no global `fetch`), `ctx.secret('')` for the API key — the F3 row stores the reference at the root as `{binding, credentialRef: {credentialId}}`, as recorded in `PM/units/S2-speech-new.md:107` — and `row.binding` for non-secret config. Emit usage exactly once per decision request, always with a `requestId`.

### STEP 0 — wire spike with a stop condition, before any plugin code

Retrieve the two vendor documents and pin them. Reading public documentation pages is in scope; **calling a vendor endpoint is not, at any point in this unit.**

1. **Jev / TypeSafe System One.** `packages/contracts/src/decision.ts:6` cites `https://api.typesafe.ai/openapi.json`. Retrieve it. From it, pin verbatim into `src/testing.ts`'s fixture header: the request path, the auth header form, the request field names, where the model id is carried, the response field names, the usage field names, and the documented error statuses. The only independent evidence available in-house is the CreditMantri POC client at `lib/jev.js:9-57` (`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer …`, body `{model, state, questions}`, response `{answers: {<id>: {choice, confidence, probabilities}}, model, usage.input_tokens}`); cite it as `POC evidence`, which is **not** a doc citation.
2. **Laya.** Neither OVO nor OCSO contains a single reference to Laya's wire format — the only mentions anywhere are prose (`packages/contracts/src/decision.ts:5`, `PM/units/I1-integration.md:73`, `PM/units/README.md:186`). Retrieve its public API reference from its own repository or docs site and pin the same seven facts.
3. **STOP** if either retrieved document does not show (a) natural-language criteria per option, (b) a per-option probability vector in the answer, and (c) a confidence figure with a stated definition. Report the exact missing fact with the document URL and the retrieval date. **Do not infer a wire format, and do not synthesize a probability vector from a single returned label** — a plugin that manufactures `probabilities: {chosen: 1}` passes `validateDecisionExchange` and destroys the threshold design. That is the single worst outcome available in this unit.
4. Any fact the retrieved document does not state goes into the fixture header marked `UNCONFIRMED`, as `S2:75` requires. `DecisionRequest` is `.strict()` and omits `model`; `DecisionResponse` is `.strict()` and omits `usage`. Both are deliberate (model choice is the bound plugin; usage goes out of band through `Cap.usage`). The adapter therefore injects `model` on the way out and strips `usage` on the way in — a verbatim vendor body never crosses the port in either direction.

### A. Contracts, runtime and host (shared touchpoints above, plus one new contracts file)

**A1. `packages/contracts/src/decision-capabilities.ts`** (new, ≤120 lines). The manifest capability block every decision plugin declares, as a zod schema plus its inferred type:

```ts
export const DecisionCapabilities = z
  .object({
    primitives: z.array(z.enum(['choice', 'noul', 'score'])).min(1),
    /** Largest `criteria` map the model accepts in one choice question. */
    maxCriteria: z.number().int().min(2),
    /** Questions answerable in ONE request — the slot-for-free property P2 depends on. */
    maxQuestionsPerRequest: z.number().int().min(1),
    languages: z.array(z.string().min(2)).min(1),
    p99LatencyMs: z.number().int().positive(),
    calibration: z
      .object({
        /** Equals `DecisionAnswer.calibrationVersion` and the PM/calibration report stem. */
        version: z.string().min(1),
        reportPath: z.string().regex(/^PM\/calibration\/[a-z0-9.-]+\.md$/),
        measuredAt: z.iso.date(),
        languages: z.record(
          z.string().min(2),
          z
            .object({
              ece: z.number().min(0).max(1),
              cohortSize: z.number().int().min(300),
              recommendedThreshold: z.number().min(0).max(1),
              acceptedAccuracy: z.number().min(0).max(1),
              fallbackRate: z.number().min(0).max(1),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();
```

**A2. Usage.** `'decisions'` is a new `UsageUnit`: one unit per `decide()` call, for a provider that bills compute rather than tokens. `'decision'` is a new `UsageOperation` with segment `'decision'`, so `meterKey()` yields `typesafe.decision.input_tokens` and `laya.decision.decisions`. `PriceCard.unit` is a free string (`packages/contracts/src/pricing.ts:1-9`), so no pricing change is needed.

**A3. `packages/session-host/src/compat/decision-uncalibrated.ts`** (new, ≤70 lines). One rule, one code, per the repo's one-rule-per-file convention. For each resolved `decision` selection: parse `DecisionCapabilities` from the manifest; emit `decision_uncalibrated` when `calibration.languages` has no entry for `input.config.language`, when that entry's `ece > 0.05`, or when `cohortSize < 300`. Severity `error` at `release` and `live`, `warning` at `test` — mirroring `meter-uncovered.ts:21`.

**A4. Metering admission.** With `'decision'` in `metersFor`'s slot list, `apps/worker/src/cost-runtime.ts:102-118` already refuses a release whose selected decision plugin has no price card, with `cost-meter-unconfigured:<keys>`. No worker edit is needed; a test must prove it. `scripts/seed-demo-price-cards.mjs` gains cards for both new meter keys so the local demo stays admissible.

**A5. The provider-name gate.** `scripts/check-provider-names.mjs:8` keeps vendor names out of host and shared code, and `packages/contracts` is in `HOST_PACKAGES`. Adding `typesafe|laya` to `NAMES` makes `decision.ts:3-7` a violation (it names TypeSafe, Jev and Laya), and `provider-names.json` is empty and may not grow. Rewrite the header to describe the contract without naming a vendor, keeping the three-primitive provenance and moving the doc URL into this spec and each plugin's README. `jev` is deliberately **not** added to `NAMES`: it is a model name, it collides with nothing, and the model id belongs in bindings.

### B. The `decision@1` conformance kit — with teeth

Shape follows `packages/conformance/src/kit/inference.ts` exactly: a `DecisionFactory = (env: {net, clock, usage}) => DecisionPort | Promise<DecisionPort>`, a `DecisionKitOptions {template?, scripts?}`, a `DecisionKitContext {factory, options}`, `DECISION_CHECKS: readonly KitCheck<DecisionKitContext>[]`, a vitest entry `describeDecision` and a vitest-free `checkDecision`. Every exchange runs through `createFixtureNet(scripts, {clock: acceleratedClock(0)})` inside `withEgressSentinel`, and every check ends by folding in `net.mismatches` and `net.pending()`.

**Check names** (stable — they are what a future `only:` subset would have to name, and `scripts/check-conformance.mjs:38-51` would then need an `APPROVED_SUBSETS` entry; P1 runs the full kit in both packages so no entry is added):

1. `capabilities are coherent` — `DecisionCapabilities` parses; `'choice'` is present (P2 needs it); `maxQuestionsPerRequest ≥ 2` or the plugin declares it cannot batch; `calibration.version` is non-empty; every `calibration.languages` entry satisfies EC3; `calibration.reportPath` exists on disk.
2. `a scripted choice exchange satisfies validateDecisionExchange` — a three-option question; the kit calls `validateDecisionExchange(request, response)` on the **request it built** and the **response the port returned**, so coverage, normalization to ±0.01 and argmax are checked by the contract's own function, not a copy of it.
3. `noul and score exchanges satisfy their own invariants` — `|noul − probabilities.yes| ≤ 0.01`; `score` equals the probability-weighted rubric index within 0.01 (so a two-level rubric yields a score in [0,1], not a 1–5 rating). A provider that declares it does not support a primitive skips that half and must then not accept the question.
4. `the request carries every criterion and its description` — the fixture step uses `where` to require each criterion key **and** its description text in the request body. Teeth: the kit's criteria keys are generated per run (`opt_<nonce>`), so a plugin that hardcodes, re-labels, truncates or index-numbers the criteria cannot match the script and fails with a FixtureNet mismatch.
5. `a second question over the same state answers the new criteria` — same `state`, different criteria set; the answer must be keyed to the second set. Catches a plugin that caches on `state`.
6. `several questions in one request are answered independently` — two questions (one intent choice, one slot choice) in a single `DecisionRequest`; exactly **one** HTTP step is scripted. Teeth: a plugin that fans out to one request per question consumes a step that does not exist and fails. This is the property that makes a slot cost 0 ms in P2.
7. `an answer outside the requested criteria is refused` — the script returns `choice: 'not_an_option'`; `decide()` must reject.
8. `a missing probability vector is refused` — the script omits `probabilities`; `decide()` must reject. No synthesizing `{chosen: 1}`.
9. `unnormalized probabilities are refused` — the script sums to 1.4; `decide()` must reject rather than renormalize. A plugin that silently rescales hides a broken model.
10. `a choice that is not the argmax is refused` — `choice` with 0.2 while another option holds 0.6.
11. `probabilities and confidence are passed through unchanged` — the script returns deliberately awkward values (0.4999, 0.0001, a 255-option vector); the returned numbers must be byte-equal after JSON round-trip. Catches clamping, rounding to two decimals, flooring to a minimum confidence, and "confidence = argmax probability" substitution when the provider reported something different.
12. `confidence is non-degenerate and matches the declared calibration` — the kit drives the cohort from `drivers/decision-calibration.ts` over a scripted 40-case set with known labels, computes ECE and σ over the returned confidences, and fails when σ < 0.05, when the measured ECE exceeds `capabilities.calibration.languages[lang].ece + 0.02`, or when `calibrationVersion` varies between answers in one session or differs from `capabilities.calibration.version`.
13. `an aborted decide() rejects and emits usage exactly once` — abort mid-flight; the request must be cancelled within 1 s, `decide()` must reject, and `usageFailures(usage, 'abort', 'decision')` must pass.
14. `usage is emitted exactly once per decision with a requestId and operation 'decision'` — on success, on a provider error and on a timeout, via `usageOnce` from `packages/plugin-kit/src/usage.ts:24`.
15. `no network bypasses the NetPort` — `withEgressSentinel` attempts must be empty; `net.pending()` must be empty.

**What the kit can and cannot prove.** It proves faithful pass-through, criteria fidelity, one-request batching, refusal of malformed answers, and that the declared calibration report is internally consistent with the confidences the provider actually returns. It **cannot** prove that the provider is calibrated on real speech: a fixture returns whatever it is scripted to return. Per-language calibration is the entry criterion above, measured on real STT transcripts, and no kit check substitutes for it. Say so in the kit's header comment so no future reader mistakes a green kit for a trustworthy threshold.

**Reference driver.** `drivers/fixture-decision.ts` exports `FixtureDecision` (one JSON POST per `decide()` to `https://fixture.invalid/v1/decide`, mirroring `FixtureInference` at `drivers/fixture-llm.ts:40-98`) and `fixtureDecisionTemplate`. It must pass all 15 checks, asserted from `tests/kits.test.ts`.

### C. `packages/plugin-decision-jev` — built first

Hosted and GA, so it validates the abstraction fastest and is the only provider for which in-house wire evidence exists.

- v2 plugin: id `@winsendotai/ovo-decision-jev`, version `0.1.0`, `contractVersion: 2`, `scope: 'session'`, `kind: 'decision'`, `provider: 'typesafe'`, `provides: [Cap.decision]`, `requires: []`, `optional: [Cap.usage]`.
- `configSchema`: `{binding, credentialRef, workspaceId, bindingId, updatedAt}`, `additionalProperties: false` — copy `packages/plugin-stt-assemblyai/src/index.ts:20-30`.
- `bindingSchema`: `{model (default 'jev-latest'), endpoint (default the pinned URL; https only, exact path), timeoutMs (int 200–10000, default 2000), calibrationId (required, string), maxCriteria?}`, `additionalProperties: false`. **No threshold field.** The confidence threshold belongs to the caller; a decision plugin that compares against one is rejected at review.
- `secretFields: ['']`; `capabilities: JEV_CAPABILITIES` (a `DecisionCapabilities` const in `src/provider.ts`); `meters: [{key: 'typesafe.decision.input_tokens', unit: 'input_tokens', label: 'TypeSafe decision input tokens', role: 'decision'}]` — output is free per the POC's rate card (`lib/config.js:62`), so only input tokens are declared and only one price card is required; `runtime: {egressHosts: ['api.typesafe.ai'], modelLicences: []}`; `conformance: ['decision@1']`; `ui: {label: 'TypeSafe Jev Decisions', vendor: 'TypeSafe', slot: 'decision'}`.
- `apply`: read the key with `ctx.secret('')`, resolve and verify `calibrationId` against the committed report (throw `DecisionCalibrationError` if absent), `ctx.provide(Cap.decision, jevDecision(ctx.net, key, binding, ctx.maybe(Cap.usage)))`.
- Request: `DecisionRequest.parse(request)` first, then POST `{...request, model: binding.model}` — `model` is injected here because `DecisionRequest` is `.strict()` and cannot carry it.
- Response: read the raw body; take `usage.input_tokens` **before** validation and meter it as `{operation: 'decision', unit: 'input_tokens', state: 'reconciled', requestId}`; map `model → modelId`; stamp `calibrationVersion: binding.calibrationId` onto every answer; drop `usage`; then `validateDecisionExchange(request, response)` and return. `requestId` comes from the vendor's id field if the pinned doc documents one, else `syntheticRequestId('typesafe', sessionId, n)`.
- Deadline: `AbortSignal.any([options.signal, timeout(binding.timeoutMs)])` via `withDeadline` from `packages/plugin-kit/src/abort.ts`. A timeout throws `DecisionTimeoutError` and meters an `estimated` meter. **The plugin never returns a substitute answer on failure** — the caller falls back; the plugin reports.
- Errors: 401/403 → non-retryable typed error; 429 and 5xx → retryable typed error; a body that fails `validateDecisionExchange` → `DecisionProtocolError` naming the failed invariant.

### D. `packages/plugin-decision-laya` — the production target

Self-hosted, Apache-2.0, ~35 ms, 100+ languages, no per-token fee, transcripts never leave the VPC. All four properties change the manifest.

- id `@winsendotai/ovo-decision-laya`, `provider: 'laya'`, same kind, scope, provides and conformance as §C.
- `bindingSchema`: `{endpoint (required, https URL — the operator's own host), model, timeoutMs (int 50–5000, default 500), calibrationId (required), concurrency?}`.
- `runtime: {egressHosts: [], egressHostsFromBinding: ['binding.endpoint'], modelLicences: ['apache-2.0']}` — see G1. The declared licence makes `licenceUnaccepted` (`packages/session-host/src/compat/licence-unaccepted.ts:4-16`) require `model-licence:apache-2.0` in `AgentConfig.voice.acknowledgements`; a release without it is blocked. That is correct: a self-hosted model is a licence the operator accepts.
- `meters: [{key: 'laya.decision.decisions', unit: 'decisions', label: 'Laya decisions', role: 'decision'}]` — one unit per request. The operator's price card may be zero-priced, but it must exist, so `cost-runtime.ts:102-118` still refuses an unpriced release and the per-call ledger still separates tier 2 from tier 3.
- `src/endpoint.ts` validates the operator endpoint with `validateProviderEndpoint`-style checks adapted for an operator host: https, no credentials, no query or fragment, exact path. Private addresses are **permitted** here (the whole point is a VPC-internal host) and that exception is stated in the module header with its reasoning; the SSRF helpers in `packages/plugin-kit/src/ssrf.ts` are therefore not applied to this one binding, and the egress allowance comes from the binding itself rather than from a wildcard.
- A dedicated test asserts the only host the plugin ever reaches is the binding's endpoint host, with zero other NetPort targets and zero sentinel attempts — the executable form of "transcripts never leave the VPC".
- Wire behavior: pin it in STEP 0. If the retrieved documents do not give the three facts in STEP 0.3, **STOP and report**; this package is not shippable on an inferred wire format.

### E. OpenAI Decisions — reserved, NOT built

Leave the slot shaped for it and build nothing. No package, no catalog entry, no manifest, no fixture, no mention in `defaults.ts`. The Decisions API is limited preview; a plugin written against a preview surface would be re-written. What P1 leaves ready: `kind: 'decision'`, `provider: 'openai'` is free and `SESSION_KINDS` admits exactly one provider per kind, `Slot.decision`, the `decision@1` kit, the `decision` usage operation, and both `input_tokens` and `decisions` units. A future unit adds one package and one catalog row. Record this one line in `PM/units/README.md`'s post-I1 item 1 and nowhere else.

## MODULES (≤300 canonical nonblank lines each, ≤24 KiB; tests ≤500)

**`packages/plugin-decision-jev/src`**

| File             | ≤   | Responsibility                                                                                                                                                                                                                                                    |
| ---------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`       | 140 | The manifest and `apply`. Imports no vendor SDK. `export const plugins = [jevDecisionPlugin]`; re-exports `fixtures` and `fixtureTemplates` from `./testing.ts`.                                                                                                  |
| `provider.ts`    | 90  | `JEV_CAPABILITIES` as a `DecisionCapabilities` const, including the per-language calibration block copied from the committed report. The single place a vendor fact is spelled.                                                                                   |
| `wire.ts`        | 180 | Pure mapping only: `DecisionRequest` → vendor body (model injection), vendor body → `DecisionResponse` (`model → modelId`, `calibrationVersion` stamping, `usage` extraction and removal). No `net`, no clock, no I/O — so it is unit-testable without a fixture. |
| `decision.ts`    | 200 | `JevDecision implements DecisionPort`: endpoint validation, `ctx.net` POST, deadline composition, `validateDecisionExchange`, metering through `usageOnce`, typed error mapping.                                                                                  |
| `calibration.ts` | 90  | Resolve and verify `binding.calibrationId` against `PM/calibration/`; `DecisionCalibrationError`. Refuses rather than fabricating a version.                                                                                                                      |
| `errors.ts`      | 60  | `DecisionProtocolError`, `DecisionTimeoutError`, `DecisionCalibrationError`, each with a `retryable` flag.                                                                                                                                                        |
| `testing.ts`     | 250 | `fixtures` and `fixtureTemplates`: the doc-cited `NetFixtureScript`s with `host`, `source`, `retrieved` and the `UNCONFIRMED` header, plus the negative scripts for kit checks 7–12.                                                                              |

**`packages/plugin-decision-laya/src`** — the same seven modules with the same budgets, plus:

| File          | ≤   | Responsibility                                                         |
| ------------- | --- | ---------------------------------------------------------------------- |
| `endpoint.ts` | 90  | Operator-endpoint validation and the stated private-address exception. |

**`packages/conformance/src`**

| File                              | ≤   | Responsibility                                                                                                                                                  |
| --------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit/decision.ts`                 | 280 | `DecisionFactory`, `DecisionKitOptions`, `DecisionKitContext`, checks 1–6 and 13–15, and the exported `DECISION_CHECKS` array composed with the negatives file. |
| `kit/decision-negatives.ts`       | 200 | Checks 7–12: the refusal and pass-through checks, each driving one malformed scripted body.                                                                     |
| `kit/decision-support.ts`         | 200 | Nonce criteria generation, the three primitive request builders, the 40-case cohort builder, and the shared failure assertions.                                 |
| `drivers/fixture-decision.ts`     | 200 | `FixtureDecision` + `fixtureDecisionTemplate`. No vitest import.                                                                                                |
| `drivers/decision-calibration.ts` | 180 | Pure maths: reliability bins, ECE, Brier, σ, confusion matrix, threshold sweep. No vitest import, no I/O.                                                       |

**Other new files**

| File                                                        | ≤   | Responsibility                                                                                                                    |
| ----------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/decision-capabilities.ts`           | 120 | `DecisionCapabilities` (A1). Imports nothing but `zod`.                                                                           |
| `packages/session-host/src/compat/decision-uncalibrated.ts` | 70  | The one compat rule (A3).                                                                                                         |
| `scripts/decision-calibration.mjs`                          | 200 | CLI over the pure maths module: reads two JSONL files, prints the per-language report, exits non-zero when EC3 fails. No network. |

## TESTS

Named tests, not "add tests". Each must fail against the stated prior behavior with the stated message — the repo's value-true-negative standard (`S2:140-142`, `S2:152-153`, `S2:166-168`).

**Conformance kit self-proof** — `packages/conformance/tests/broken-fakes-decision.test.ts`, following `broken-fakes-speech.test.ts`. Each fake wraps `FixtureDecision` and breaks exactly one thing; each assertion names the check it must trip:

1. Constant `confidence: 0.99` on every answer → `confidence is non-degenerate` fails with the σ message.
2. `probabilities` dropped → check 8 fails; and separately, `probabilities` replaced by `{<choice>: 1}` → check 12 fails on ECE, proving a manufactured vector does not slip past.
3. Criteria replaced by index numbers in the request → check 4 fails with a FixtureNet mismatch, not a generic error.
4. Probabilities renormalized by the plugin → check 9 fails (the plugin must reject, not repair).
5. Confidence rounded to two decimals → check 11 fails.
6. A per-question fan-out (one request per question) → check 6 fails with `unconsumed …`.
7. `calibrationVersion` hardcoded to a constant differing from `capabilities.calibration.version` → check 12 fails.
8. Usage emitted twice → `usage decisions emitted 2 times`.
9. Global `fetch` bypass → `Egress blocked`.

**Plugin tests, per package**

- `tests/conformance.test.ts` — `describeDecision` with the package's own template, **full kit, no `only:`** (so `scripts/check-conformance.mjs` needs no `APPROVED_SUBSETS` entry; a later subset would).
- `tests/wire.test.ts` — pure mapping: `model` injection; `model → modelId`; `usage` stripped before `.strict()` parsing (a verbatim vendor body must fail `DecisionResponse.parse` and must succeed after mapping — the test asserts both, which is what proves the adapter is mandatory); `calibrationVersion` stamped on every answer.
- `tests/calibration.test.ts` — a binding with no `calibrationId` and a binding naming an absent report each throw `DecisionCalibrationError` from `apply`; a valid one composes. True negative: an implementation that defaults `calibrationVersion` to `'unknown'` makes this fail with the fabricated value rather than the refusal.
- `tests/errors.test.ts` — 401 non-retryable, 429 retryable, timeout → `DecisionTimeoutError` with exactly one `estimated` meter, and **no substitute answer returned** on any of the three.
- `tests/distribution.test.ts` — loads the plugin from the real `loadDistribution({role: 'gateway', profile: 'compose', env: {}})`, composes a session graph with a fixture secret resolver and `createFixtureNet([])`, and asserts `graph.get(Cap.decision)` is defined **and typed as `DecisionPort`** (`expectTypeOf`), which is the executable proof of the `TypedCapabilities` edit. Copy `packages/plugin-stt-assemblyai/tests/distribution.test.ts:7-45`.
- Laya only: `tests/vpc.test.ts` — the only NetPort target is the binding endpoint host; zero sentinel attempts; an `endpoint` whose host differs from the binding is denied with `egress-denied`.

**Host and metering tests**

- `packages/session-host/tests/` — `metersFor` returns the decision meter when a decision plugin is selected and omits it otherwise; a decision plugin that declares meters of which none apply throws `No applicable decision meter for selected plugin <id>`.
- `apps/worker/tests/` — a release selecting `plugin-decision-jev` with no `typesafe.decision.input_tokens` price card is refused with `cost-meter-unconfigured:typesafe.decision.input_tokens`; adding the card admits it. True negative: without the `metersFor` slot-list edit the release is admitted, and the test fails on `admitted` being `true`.
- `packages/session-host/tests/` — `decision_uncalibrated` fires for a Tamil agent against a plugin whose calibration block has `en-IN` only (error at `live`, warning at `test`), and does not fire once `ta-IN` is in the report at ECE ≤ 0.05.
- `packages/runtime/tests/` — `egressHostsFromBinding` admits the host at `binding.endpoint` and denies every other host with `egress-denied`; an absent or non-URL binding value denies everything rather than admitting everything. True negative: an implementation that falls back to "allow all" when the path is missing fails this case.
- `packages/contracts/tests/` — a `decision`-kind manifest without `meters`, without `capabilities`, without `runtime` or without `conformance` each fail `ManifestV2.superRefine` with the kind-specific message (proving the three closed-list memberships).
- `packages/fixture-calls/tests/` — a fixture test call whose release carries a decision selection resolves it and reports it in `FixtureCallResult.selections`.

**Calibration harness tests**

- `packages/conformance/tests/` — ECE, Brier, σ and the threshold sweep against hand-computed values on a 10-case fixture; a perfectly calibrated synthetic cohort yields ECE ≈ 0; an always-0.99 cohort with 60% accuracy yields ECE ≈ 0.39 and fails EC3.
- `scripts/decision-calibration.mjs` exits non-zero on the failing cohort and zero on the passing one, and makes no network call under the egress sentinel.

## POST-I1 RULES

- You own only the listed paths; the shared touchpoints table is exhaustive — anything not in it is out of scope, and the console slot pickers, `packages/behaviors/**` and any routing logic are explicitly out.
- Do NOT run `pnpm install`. Both new packages depend only on existing workspace packages; neither adds a third-party dependency.
- `scripts/baselines/pending/` no longer exists — I1 deleted it. There is no pending baseline for this unit: a gate violation is fixed in place, not deferred. `provider-names.json`, `conformance.json`, `architecture.json` and `module-size.json` are empty and must stay empty.
- Contract gaps get a named entry in the section below, not a silent local workaround.
- Import only `contracts`, `runtime`, `sdk`, `plugin-kit` and `audio`. No other plugin package, no `ws`, no `node:https`, no global `fetch`, no vendor SDK.
- Never contact a vendor endpoint, in a test or otherwise. Live and paid flags stay off. Reading public documentation is in scope; calling an API is not.
- Modules ≤300 lines. No git commits.

## Done criteria

Done = scoped lint (all seven gates), scoped typecheck and the scoped test set green, **and** the entry criterion satisfied with a committed `PM/calibration/` report per provider, **and** every true negative above reproduced with its exact failure message recorded in the handoff.

## Acceptance

- `Cap.decision` resolves to `DecisionPort` through `CapabilityMap`; both plugins load from the production distribution catalog, compose into a real session graph and provide the capability, with no skeleton flag and no cast at the call site.
- A release pins a decision plugin like any other provider slot: `AgentVoice.decision` → `buildReleaseSelections` → `ReleaseSelections.decision` → `selectSessionGraph` with the default `configFor` branch, resolved exact-or-same-major.
- The `decision@1` kit rejects, with a named check and a specific message, a plugin that: returns constant or clamped confidence; omits or manufactures per-option probabilities; renormalizes instead of refusing; ignores, renames or index-numbers the criteria; fans out one request per question; varies or fabricates `calibrationVersion`; double-meters; or bypasses the `NetPort`. `FixtureDecision` passes all 15 checks; `broken-fakes-decision.test.ts` proves each rejection.
- Every vendor interaction in every test goes through `ctx.net` / `createFixtureNet` with doc-cited scripts carrying `host`, `source`, `retrieved` and explicit `UNCONFIRMED` annotations. Zero real API calls; the egress sentinel records zero attempts.
- A decision is metered as `operation: 'decision'` exactly once per request, with a `requestId`, `reconciled` on a vendor-reported body and `estimated` on a timeout or cancellation — so the ledger separates tier 2 from the tier-3 LLM fallback.
- A release selecting a decision plugin without a price card for its declared meter is refused at admission with `cost-meter-unconfigured:<key>`.
- A release whose language is outside the selected plugin's committed calibration report is blocked by `decision_uncalibrated` at `release` and `live`, and warned at `test`.
- Laya reaches only the operator's binding endpoint; no vendor host, no telemetry, no transcript egress. Its Apache-2.0 licence must be acknowledged on the release.
- Neither plugin thresholds, falls back, caches on `state`, or returns a substitute answer on failure. No OpenAI Decisions package exists.
- Scoped lint, typecheck and tests are green; no baseline grew.

## Contract gaps

**G1. `runtime.egressHosts` cannot express a self-hosted provider.** `packages/contracts/src/manifest.ts:146` is a static string array and `packages/runtime/src/net-guard.ts:19-48` admits a host only by exact match or `*.suffix`. A self-hosted Laya lives at an operator-chosen host that is unknown when the manifest is written, so the honest options were a wildcard (admits the internet), an empty list (denies everything) or a contract change. P1 takes the contract change: `runtime.egressHostsFromBinding: string[]` names config paths (e.g. `binding.endpoint`) whose URL hostnames `createFacade` resolves from `FacadeOptions.config` (`packages/runtime/src/facade.ts:11-20`) and passes to `filteredNet` as extra allowed hosts. `https`/`wss` only; a missing, non-string or non-URL value admits **nothing**. This is the only runtime behavior change in the unit and it needs the true negative listed under TESTS.

**G2. `DecisionAnswer.calibrationVersion` is an OVO invention no vendor returns.** `decision.ts:60-63` makes it mandatory on every answer. P1 resolves it as "the adapter stamps the id of a committed calibration report named by a required `binding.calibrationId`, or refuses". That is deliberately not a free-text passthrough: the field's purpose is to make an uncalibrated deployment impossible to configure. The alternative — making the field optional — was rejected because it removes the only structural defense the threshold design has.

**G3. `DecisionCapabilities` is not a `CONFORMANCE_KITS`-shaped capability.** The other `ManifestCapabilities` members are plain interfaces; this one is a zod schema because the compat rule and the kit both parse it from an untrusted manifest. If a later unit converts the others, converge on the schema form.

**G4. No `'decision'` role in `Slot`-adjacent console surfaces.** `apps/console/components/plugins/types.ts:37` is forced by `Record<Slot, string>` and is edited; `features/agent-plugins.tsx:22` and `agent-wizard.tsx` are plain arrays and are **not**, so the slot is API-selectable and console-invisible until a console unit adds it. Named, not silently skipped.

**G5. No `maxQuestionsPerRequest` enforcement at the port.** `DecisionRequest.questions` has no cap (`decision.ts:49-54`); the per-provider cap lives only in `DecisionCapabilities`. P1 enforces it inside each plugin (refuse before the request). A host-side compat rule comparing a graph's largest node question count against the selected plugin's cap belongs to P2, which is where graphs exist.

**G6. The kit cannot prove calibration.** Stated in §B and in the kit header. The entry criterion carries that weight, and it is a founder gate rather than a CI gate because it needs real recorded responses over real STT transcripts.

**G7. `UsageOperation` gained `'decision'`, but `metersFor`, `meter-uncovered`, `MeterDeclaration.role` and `SelectedMeter.slot` are four separate closed lists spelling the same four (now five) slots.** P1 edits all four. A later unit should derive them from one source; doing it here would widen the unit past its owned paths.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-decision-jev packages/plugin-decision-laya packages/conformance packages/contracts packages/runtime packages/session-host packages/distribution scripts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-decision-jev packages/plugin-decision-laya packages/conformance packages/contracts packages/runtime packages/session-host packages/distribution packages/fixture-calls apps/api apps/worker apps/console`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-decision-jev packages/plugin-decision-laya packages/conformance packages/contracts packages/runtime packages/session-host packages/distribution packages/fixture-calls --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run apps/worker apps/api --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/decision-calibration.mjs PM/calibration/fixtures/cohort.jsonl PM/calibration/fixtures/responses.jsonl`
- Full bar before handoff: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm check`
