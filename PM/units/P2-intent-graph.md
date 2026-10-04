# Work unit P2-intent-graph: `intent-graph` behavior mode executing the I1 `IntentScriptGraph` over three routing tiers (rules → `Cap.decision` → LLM fallback), with slots in the same decision request, global intents at every node, a static named resume point, and a playback-latched identity-verification gate built on the existing `disclosure` speech kind — no clips, no SMS, no disposition log, no speculation, no console surface

Wave: post-I1 (roadmap item 2)
Depends on: I1-integration (verified `4d8453e`), E1-turns-vad, E2-native-engine, E3-livekit-engine, M1-misc-defects, P1-decision-slot (tier 2 only; see TIER 2)
Defects fixed: none numbered. P2 closes two latent hazards named during I1: the unchecked `BEHAVIOR_PLUGIN_IDS as Record<Mode, string>` cast at `apps/api/src/release-graph.ts:8`, and the loss of `ScriptGraph`'s reachable-from-`start` check (`packages/contracts/src/script.ts:49-57`) in `IntentScriptGraph`.

## Owned paths

- packages/behaviors/src/intent/\*\* (new directory)
- packages/behaviors/src/index.ts
- packages/behaviors/package.json (devDependencies only)
- packages/behaviors/tests/p2-\*.test.ts
- packages/contracts/src/intent-policy.ts (new file)
- packages/contracts/tests/p2-intent-policy.test.ts
- packages/fixture-calls/tests/p2-intent-graph-call.test.ts

## Shared touchpoints (minimal edits allowed)

Each line below is the whole permitted edit. Nothing else in these files may change.

| File                                                    | Line(s)   | Exact edit                                                                                                                                                    |
| ------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/agent.ts`                       | `7`       | `Mode = z.enum([... , 'intent-graph'])`                                                                                                                       |
| `packages/contracts/src/agent.ts`                       | `76`      | add `intentScript: IntentScriptGraph.optional()` and `intentPolicy: IntentPolicy.optional()` beside the existing `script`                                     |
| `packages/contracts/src/agent.ts`                       | `128-135` | two new `.refine`s: `intentScript` ⇔ `mode === 'intent-graph'` (both directions), and `intentPolicy` requires `intentScript`                                  |
| `packages/contracts/src/index.ts`                       | `17-20`   | one `export * from './intent-policy.ts';` line                                                                                                                |
| `packages/contracts/src/capabilities/map.ts`            | `28-57`   | `[Cap.decision]: DecisionPort;` in `TypedCapabilities` (today `ctx.get(Cap.decision)` types as `unknown`)                                                     |
| `packages/contracts/src/voice/turn.ts`                  | `119-124` | `'intent-graph': Object.freeze(['during-confirmation'] as const)` in `DEFAULT_MUTE`. **Typecheck fails until this row exists** (`Readonly<Record<Mode, …>>`). |
| `packages/session-host/src/session-catalog.ts`          | `41-45`   | use the new `BEHAVIOR_IDS_BY_MODE` map instead of indexing `BEHAVIOR_PLUGIN_IDS`                                                                              |
| `packages/session-host/src/engine-selection.ts`         | `57`      | `release.config.script \|\| release.config.intentScript \|\| !inputEnabled ? '' : undefined`                                                                  |
| `packages/session-host/src/compat/mode-requires-llm.ts` | `4`       | add `'intent-graph'` — tier 3 needs an `llm` selection                                                                                                        |
| `packages/session-host/src/compat/meter-uncovered.ts`   | `11`      | add `'intent-graph'` to the `llm`-role list                                                                                                                   |
| `apps/worker/src/production-session-support.ts`         | `131`     | same `initialInput` change as `engine-selection.ts:57`                                                                                                        |
| `apps/worker/src/cost-policy-support.ts`                | `145`     | add `'intent-graph'` to the `llm` branch                                                                                                                      |
| `apps/api/src/release-graph.ts`                         | `8`, `40` | replace the cast with `BEHAVIOR_IDS_BY_MODE`                                                                                                                  |
| `apps/api/src/provider-evaluation-runtime.ts`           | `40-48`   | one branch constructing the intent-graph behavior; an unreachable mode must `throw`, not fall through to `createAgentBehavior`                                |
| `packages/fixture-calls/src/default-script.ts`          | `4-35`    | one `defaultCallerScript` row and one `predictedAgentTexts` row for the new mode                                                                              |

**Explicitly NOT touched.** `packages/contracts/src/intent-script.ts` (the I1 contract; P2 executes it unchanged), `packages/contracts/src/decision.ts`, `packages/contracts/src/script.ts`, `packages/plugin-voice/**`, `packages/plugin-engine-livekit/**`, `packages/plugin-turns/**`, `packages/conformance/**`, `apps/console/**`, `apps/worker/src/speech-cache-*.ts`, `packages/contracts/src/usage.ts`.

## Specification

GOAL: make the CreditMantri collections POC's conversation model expressible on OVO as a selectable behavior mode, executing the I1 `IntentScriptGraph` verbatim, so a scripted collections call routes on rules at 0 ms, on a calibrated decision model when rules miss, and on the LLM only when the decision model is unconfident — and so loan facts cannot reach the LLM before identity is verified. Read `docs/architecture/plugin-platform.md` (revision 2): §2.6 (receipt ordering), §2.7 (the mute-rule table, normative), §2.10 (text matching), §3.3–3.5 (plugin context and scope), §13 (gates). Read `PM/units/E1-turns-vad.md` in full before writing a line of speech-kind code; its mute semantics are authoritative and P2 must not fight them.

PINNED, read before building:

- `packages/contracts/src/intent-script.ts` — the executable contract. `IntentRouterStep` (`ASK`/`CLASSIFY`/`KNOWN`, `:19-70`), `IntentDefinition` (`:72-82`), `IntentScriptNode` (`:86-112`), `IntentScriptGraph` with its 56-line `superRefine` (`:114-180`). It is a faithful port of OCSO `packages/domain/src/routing/router-definition.ts:31-64`.
- `packages/contracts/src/decision.ts` — `DecisionRequest {state, questions}` (`:42-57`), `DecisionAnswer` with **required** `calibrationVersion` (`:59-70`), `validateDecisionExchange` (`:83-126`), `DecisionPort.decide(request, {signal})` (`:128-130`).
- `packages/contracts/src/ports.ts:109-119` — the `Behavior` port P2 implements, including `speechKind(text)` and the playback-gated `onPlayback(receipt)`.
- `packages/plugin-turns/src/mute.ts:14-23` — **`speechMuted` makes `kind === 'disclosure'` muted unconditionally, with no mute rule required.** This is the whole mechanism of the verification gate's input side.
- `packages/plugin-turns/tests/mute-boundaries.test.ts` — the exact confirmation-buffering and disclosure-discard behavior P2 must satisfy.
- `packages/behaviors/src/script.ts:69-80` — `ScriptBehavior.onPlayback`: a node advances only on `receipt.state === 'completed'` with a matching text and epoch. P2 keeps this invariant.
- `packages/behaviors/src/confirmation.ts:76-84` — `ToolConfirmation.played` additionally requires `evidence !== 'estimated'`. The P2 fact latch uses this stricter rule, not `ScriptBehavior`'s.
- `packages/contracts/src/text.ts` — `normalizeForMatch`, `countWords`, `CONFIRM_YES`/`CONFIRM_NO` (already Tamil, Telugu, Kannada, Marathi, Bengali plus transliterations), `classifyConfirmation`.
- `/private/tmp/claude-501/-Users-tejassuds-work/d10f06a4-0cf6-485b-b5e3-1132b2e1f82f/scratchpad/cmchatbot/lib/flow.js` — the POC's 34 nodes, 9 LISTEN sets, 28 node-local intents, 4 global intents and 1 slot. Provenance only; no code is ported.

### STEP 0, THE EXPRESSIBILITY SPIKE (do this first, before any executor code)

Hand-write the POC's `identity`, `payment` and `confirm_week` LISTEN sets plus the `greet`, `reassure`, `disclose`, `ptp_*` and `hardship` nodes as a literal `IntentScriptGraph` in `packages/behaviors/tests/p2-fixtures/cm-collections.ts`, and `IntentScriptGraph.parse` it. Record, per CONTRACT GAPS below, every POC feature that does not survive the parse.

**If the graph cannot be parsed at all, STOP.** Report the exact Zod issue path and message. Do not add a field to `intent-script.ts`, and do not build a second graph type next to it. The whole point of this unit is that I1's contract is the schema.

The spike's expected outcome, already derived from reading both sources: the three LISTEN sets parse; `ptp_when` parses as a six-label `CLASSIFY` step; `repeat`, the four global intents' targets, the per-LISTEN-set classifier framing, the multi-clip node utterance, the `|| 'ptp_ask'` default arm, the per-intent regex rules, `node.sms`, `node.log` and `node.verified` do not. The default arm maps onto `fallback: {kind:'node', to:'ptp_ask'}`; the rest are gaps.

### A. The mode

`Mode` gains `'intent-graph'`. `AgentConfig` gains `intentScript: IntentScriptGraph` (the I1 contract, unchanged) and `intentPolicy: IntentPolicy` (the sidecar in §B). The existing refine at `agent.ts:128-131` already forbids the legacy `script` outside announcement/FAQ, so the two graph types can never both be live; add the mirror refine so `intentScript` requires the new mode **and** the new mode requires `intentScript`.

`packages/behaviors/src/index.ts`:

- `BEHAVIOR_PLUGIN_IDS` gains `'intent-graph': '@winsendotai/ovo-behavior-intent-graph'`.
- Add `export const BEHAVIOR_IDS_BY_MODE: Readonly<Record<Mode, string>>`, built by naming each mode explicitly (not by spreading `BEHAVIOR_PLUGIN_IDS`, whose `faqTools` key is not a mode). This is the typecheck gate that makes a future mode impossible to forget; `session-catalog.ts:44` and `release-graph.ts:8,40` both consume it.
- `createIntentGraphBehaviorPlugin()`, modelled on `createAgentBehaviorPlugin()` (`index.ts:152-188`):
  - `id '@winsendotai/ovo-behavior-intent-graph'`, `version '0.1.0'`, `contractVersion 1`, `scope 'session'`;
  - `requires: [Cap.inference]` — tier 3 is not optional; a graph whose nonterminal nodes all need a fallback cannot run without it;
  - `optional: [Cap.decision, Cap.clock]`;
  - `provides: [Cap.behavior]`;
  - `configSchema` = `behaviorConfigSchema` (`index.ts:43-52`) with `required: ['agent', 'workspaceId', 'sessionId']`;
  - `apply` calls `parsePluginConfig`, `requireMode(config.agent, 'intent-graph')`, reads `ctx.get(Cap.inference)`, `ctx.maybe(Cap.decision)`, `ctx.maybe(Cap.clock)`, provides the behavior and registers `ctx.effect(() => () => behavior.cancel())`;
  - added to `createBehaviorPluginCatalog()` (`index.ts:191-199`).
- `withScript` (`script.ts:135-139`) must be left alone: `config.script` is undefined in this mode, so it already returns the behavior untouched. Assert that with a test rather than editing it.

Capability keys: `Cap.decision` already exists (`keys.ts:6`) with `CAPABILITY_SPECS[Cap.decision] = SESSION` (`keys.ts:101`). P2 adds no key. It adds the one missing `TypedCapabilities` row so `ctx.maybe(Cap.decision)` is `DecisionPort | undefined` instead of `unknown`. Do not spell `'ovo.decision'` anywhere; import `Cap` (`scripts/check-capability-keys.mjs` ratchets every literal per file).

### B. `IntentPolicy` — the sidecar, and its hard limits

`packages/contracts/src/intent-policy.ts`. This exists **only** because the nine CONTRACT GAPS below are real. It is not a second routing schema and the following is enforced by its own validator plus `p2-intent-policy.test.ts`:

1. It carries no intents, no steps, no routes, no conditions, no prompts that route. Every field is either a reference into the graph or a scalar policy knob.
2. Every key and every value that names a node or intent must resolve inside the graph it accompanies. An unresolved reference is a parse error, not a warning.
3. Each field's doc comment names the `intent-script.ts` gap it stands in for and the field the owning unit should add there instead.

```ts
const DecisionSafeId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const NodeId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const IntentPolicy = z
  .object({
    /** Gap 3: `globalIntents` are declared graph-wide but `routes` are node-local only. */
    globalRoutes: z.record(DecisionSafeId, NodeId).default({}),
    /** Gap 4: `IntentDefinition` has no "does not advance" marker. At most one id. */
    repeatIntentId: DecisionSafeId.optional(),
    repeatPrefix: z.string().trim().min(1).max(200).optional(),
    /** Gap 1: `IntentScriptNode.prompt` is one string, so a disclosure prefix is counted in sentences. */
    disclosurePrefix: z.record(NodeId, z.number().int().min(1).max(10)).default({}),
    /** Gap 5: no node-entry effects, so the fact latch is named here. */
    latchNodes: z.array(NodeId).max(100).default([]),
    /** Facts the LLM fallback may be given only after the latch. */
    gatedFacts: z.array(z.string().min(1).max(60)).max(50).default([]),
    /** Fallback context used BEFORE the latch. `AgentConfig.context` is used after it. */
    unverifiedContext: z.string().max(4_000).default(''),
    /** Gap 6: nothing marks a node's answer as a yes/no confirmation prompt. */
    confirmationNodes: z.array(NodeId).max(100).default([]),
    decisionTimeoutMs: z.number().int().min(100).max(10_000).default(2_000),
    minConfidenceFloor: z.number().min(0).max(1).default(0),
    maxFallbacksPerNode: z.number().int().min(0).max(5).default(2),
    otherCriterion: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .default(
        'None of the above fits: a question, a new topic, or anything the listed options do not cover',
      ),
  })
  .strict();
```

`minConfidenceFloor` exists because `IntentDefinition.minConfidence` is author-supplied and may be `0`, which would make the threshold inert. The effective threshold is `max(intent.minConfidence, policy.minConfidenceFloor)`. Until P1 reports measured per-language calibration (the roadmap's entry criterion, `PM/units/README.md:186`), a release with `minConfidenceFloor: 0` is legal but the unit's README must say the threshold is unvalidated.

### C. Compilation (construction time, before any turn)

`intent/graph.ts` turns `(IntentScriptGraph, IntentPolicy, AgentConfig)` into an immutable plan and **throws with an exact message** for each of the following. `IntentScriptGraph.superRefine` does not check any of them; a builder who skips one ships a graph that fails mid-call instead of at release validation.

1. **Decision-id grammar.** Every global and node `IntentDefinition.id`, and every `CLASSIFY` `labels[].value`, must match `DecisionSafeId`. `IntentDefinition.id` is `NodeId` = `/^[A-Za-z0-9_-]{1,40}$/`, which admits `Balance`, `_x`, `9a` and `-a`; `decision.ts:8` requires `/^[a-z][a-z0-9_-]{0,79}$/`. `CLASSIFY.labels[].value` is a free `Label` (trimmed 1–60 chars). Either becomes an invalid `DecisionRequest.questions[*].criteria` key.
2. **Empty descriptions.** `CLASSIFY.instructions` is `z.string().trim().max(4_000)` and `CLASSIFY.labels[].description` is `z.string().trim().max(500)` — **neither has `.min(1)`**, so both can be `''`, while `DecisionQuestion.instructions` and its `criteria` values are `Description` = `.min(1)`. Reject an empty `instructions` on any `CLASSIFY` step that will be compiled into a question, and an empty `description` on any of its labels.
3. **`other` collision.** `other` is the reserved criterion id. Reject any global or node intent id equal to `other`, and any `CLASSIFY` label value equal to `other`.
4. **`maxFollowUps`.** A `CLASSIFY` step compiled into the intent request must have `maxFollowUps === 0`. A nonzero value asks for a sequential follow-up question, which contradicts single-request slot extraction.
5. **`MessageSpec.templates`.** Reject a non-empty `prompt.templates` on any `ASK` step. It is OCSO's channel-id → approved-chat-template map (`router-definition.ts:17-21`) and has no voice meaning. Silently ignoring an author-set field is how a disclosure policy gets lost.
6. **Reachability.** Compute reachable nodes from `graph.start` over `routes[].to` ∪ `fallback.to` ∪ `fallback.resumeAt` ∪ `policy.globalRoutes` values. Reject unreachable nodes. `script.ts:49-57` had this check; `intent-script.ts` dropped it.
7. **Dead globals.** Every `globalIntents[*].id` must have either a `policy.globalRoutes` entry or at least one node route, unless it is `policy.repeatIntentId`. A global intent nothing can act on is an author error.
8. **`repeat` is route-free.** If `policy.repeatIntentId` is set it must name a declared global intent, and **no** node route and no `globalRoutes` entry may reference it.
9. **Route shadowing.** Within one node, for a given `intentId`, a route whose `when` is `{}` or whose `when` is a subset of an earlier route's `when` is unreachable. Reject it. Routes are first-match-wins in array order; the contract documents neither priority nor overlap (`intent-script.ts:96-104`).
10. **Disclosure prefix bounds.** For each `policy.disclosurePrefix[node]` = `n`: let `s` = the sentence count of that node's `prompt` under the existing segmenter. Require `n <= s`, and for a **nonterminal** node require `n < s` — the last segment of a node that expects an answer must not be `disclosure`, because `speechMuted` discards everything the caller says during it (`mute.ts:18`, and `fallback-turns.ts:37-41` additionally clears any buffered text). A node whose closing question is disclosure can never be answered.
11. **Confirmation nodes are really yes/no.** For each `policy.confirmationNodes[i]`: the node's **non-global** intents must number exactly two, and each must be reachable by `classifyConfirmation` — one classifying as `yes` and one as `no` for at least one phrase in `CONFIRM_YES`/`CONFIRM_NO` respectively, as declared in the node's tier-1 rule set (§D). The E1 detector releases a buffered confirmation answer only when `classifyConfirmation(buffer)` is `yes` or `no`, and otherwise emits `turn.reset` with reason `'muted'` — so marking an open question as a confirmation silently deletes the caller's answer. The POC's `confirm_week` and `knows` qualify; `link_check` (`received` / `not_received`) does **not**, and the compiler must reject it.
12. **Policy references resolve.** Every node id in `disclosurePrefix`, `latchNodes` and `confirmationNodes`, and every value in `globalRoutes`, exists in `graph.nodes`; every key in `globalRoutes` and `repeatIntentId` names a declared global intent.
13. **Template paths.** Run the existing `validateTemplatePaths(node.prompt, config.variables)` for every node, exactly as `ScriptBehavior` does at `script.ts:30`. Node prompts use `{{path}}`; the POC's `{var}` form is not supported and P3 owns spoken-form rendering.

### D. TIER 1 — rules, 0 ms, no network

`intent/rules.ts`. Matching is whole-utterance over `normalizeForMatch` (`text.ts:6-12`), evaluated **node-local first, then global**, first match wins — the POC's order (`flow.js:274`).

The contract gives tier 1 exactly two homes, and no more (CONTRACT GAP 2):

- **`ASK` step options.** When an `ASK` step is pending at the node, the caller's normalized utterance is compared against each option's `value`, `label` and `synonyms` (`synonyms` is **optional**; absent means value and label only). A hit sets `slots[step.attribute] = option.value`.
- **Yes/no via `classifyConfirmation`.** For a node in `policy.confirmationNodes`, `classifyConfirmation(input)` resolves to the node's yes-intent or no-intent. This is the only multilingual phrase table in contracts and it already covers Hindi, Tamil, Telugu, Kannada, Marathi and Bengali with transliterations and filler stripping.

Nothing else. There is **no regex rule and no phrase list on `IntentDefinition`**, so the POC's `identity.confirmed` (`[YES, SPEAKING]`), `link_check.received`/`not_received`, `wrapup.no_more`, `identity.wrong_person` and the `repeat` rule are **not expressible as tier-1 rules** and fall to tier 2. Record it; do not add a field.

`maxAttempts` (1–5) governs an unmatched `ASK`: re-speak `step.prompt.text` until the attempt count is reached, then take the node fallback with reason `ask_exhausted`. While an `ASK` is pending, global intents still apply — both in tier 1 (yes/no only) and in tier 2 (§E).

DTMF: `IntentScriptGraph` has no DTMF member (CONTRACT GAP 8). A `turn.stopped` whose `input.kind === 'dtmf'` arrives as digits in `variables.inputEvent === 'dtmf'` (`plugin-voice/src/engine/turn-driver.ts:57`). P2 does not match it against anything: it goes straight to the node fallback with reason `no_route`, and never to tier 2 (a decision model must not be asked to classify `"123"` as a collections intent).

### E. TIER 2 — `Cap.decision`, one request, intent and slots together

`intent/decision-request.ts` and `intent/decision-answer.ts`.

**Absent provider.** `ctx.maybe(Cap.decision)` may be `undefined` — until P1 lands it always is. Tier 2 is then skipped entirely and the turn goes to tier 3 with `fallbackReason: 'decision_absent'`. No throw, no log spam, and the behavior must be fully testable in this state.

**The request.** Exactly one `DecisionRequest`, built per turn:

- `state`: a record, not a string — `{caller_reply, agent_last_said, recent_turns, today, language}`. `recent_turns` is the last four history entries as `"role: text"`. `today` is formatted in `config.timezone`. The record form keeps the body adapter-friendly; `DecisionRequest.state` accepts `string | record | non-empty array` (`decision.ts:44-48`).
- `questions.intent`: `{type: 'choice', instructions, criteria}`. `criteria` = every global intent's `description`, then every node intent's `description`, then `other: policy.otherCriterion`. When an `ASK` step is pending, the node intents are replaced by one criterion per `ASK` option (`value` → `label`), so a pending sub-question still honours globals. `instructions` is derived from `node.prompt` plus a fixed framing that names the reply field; see CONTRACT GAP 7 for why the author cannot supply it.
- One extra `choice` question **in the same request** per `CLASSIFY` step whose `attribute` is referenced by at least one of this node's `routes[].when`, keyed by `step.attribute` (`AttributeKey` is already a valid decision `Id`), with `criteria` = `labels[].value → labels[].description` and `instructions` = `step.instructions`. A step whose `skipIfKnown` is `true` and whose attribute is already in the slot store is omitted. **This is the whole latency argument: the slot rides the intent's round trip, so it costs 0 ms.** A step whose attribute no route references is also omitted — asking for a slot nothing can read is paid-for noise.
- `DecisionRequest` is `.strict()` and has no `model` field (`decision.ts:56`). The model is the plugin bound to `Cap.decision`. P2 never sends one, and `CLASSIFY.modelProfileId` is **not** used to select anything (CONTRACT GAP 9).

**Timeout and failure.** `decide(request, {signal})` is called with a signal from an injected factory (default `AbortSignal.timeout(policy.decisionTimeoutMs)`; tests inject a controller so no real timer is needed). Timeout, rejection, a `DecisionResponse` parse failure, or a `validateDecisionExchange` failure all degrade to tier 3 — never to a failed turn. The four reasons are distinct and recorded: `decision_error`, `decision_invalid`, `decision_other`, `low_confidence`.

**Validation is not optional.** Every response goes through `validateDecisionExchange(request, response)` (`decision.ts:83-126`), which checks answer/question id parity, type parity, criteria coverage, probability mass to ±0.01 and that `choice` is the argmax. `calibrationVersion` is required on every answer (`decision.ts:62`); P2 does **not** relax it. A provider that omits it produces `decision_invalid` and an LLM fallback. That settles the open I1 question (c): the burden is the adapter's, not the behavior's.

**The threshold.** Let `answer = response.answers.intent`.

- `answer.choice === 'other'` → tier 3, reason `decision_other`.
- otherwise the chosen intent's own `minConfidence` applies: `answer.confidence >= max(intent.minConfidence, policy.minConfidenceFloor)` → accept, else tier 3 with reason `low_confidence`. Per-intent thresholds are what `IntentDefinition.minConfidence` is for (`intent-script.ts:76-77`).

**Slots.** Each extra answer is accepted only if `answer.confidence >= step.minConfidence`; below it the slot is left **unresolved** (not an error, not a default). An unresolved slot simply cannot satisfy a `when`, so the node's fallback takes over — which is exactly how the POC's `|| 'ptp_ask'` default arm maps onto this schema: `fallback: {kind: 'node', to: 'ptp_ask'}`.

**Routing.** `intent/slots.ts`. With a chosen intent id:

1. If it is `policy.repeatIntentId` → replay (§G), no node change, no visit increment.
2. Node routes in array order whose `intentId` matches and whose `when` is satisfied — all keys must match, an array value accepts any one of its members (`intent-script.ts:83`), `{}` matches everything.
3. Else `policy.globalRoutes[intentId]`, if the intent is global.
4. Else the node fallback, reason `no_route`.

**Slot store.** One `Map<AttributeKey, Label>` per call, written by `ASK` hits, accepted `CLASSIFY` answers and `KNOWN` reads. `skipIfKnown` consults it. `KNOWN` steps run on node entry, before the utterance, with no turn: `from: 'customer.language'` → `config.language`; `from: 'customer.attribute:<key>'` → `variables[<key>]` if present and a string, otherwise **unresolved, with no throw**. Note that a slot extracted at an earlier node can only appear in a later node's `when` if that node re-declares it in an intent's `slots` list — the contract builds the permitted attribute set per node from that node's steps plus its intents' and the globals' `slots` (`intent-script.ts:156-160`). P2 does not work around this; it is the author's job, and the compiler's reachability message must say so.

### F. TIER 3 — LLM fallback resuming at a NAMED node

`intent/fallback.ts`.

**The resume point is static.** `fallback: {kind: 'llm', resumeAt: NodeId}` (`intent-script.ts:106`), validated to exist (`:174-175`). The POC lets its model choose the resume point per reply from an enumerated list; **P2 does not.** Reasons, in order: `resumeAt` is validated at parse time while a model-chosen node is unvalidated model output that can land on a node whose `ASK`/`KNOWN` steps were never satisfied; a prompt that enumerates every resume point is a prompt-injection surface on a regulated collections call; and `InferenceReply` is `{kind:'text'} | {kind:'tool'}` (`ports.ts:43-45`) with no strict-structured-output contract, so a `{reply, resume_at, action}` object would need a tool-call hack. With a static resume point the fallback needs only text, and `Inference.generate` already delivers that. Record the divergence (CONTRACT GAP 10); do not widen `fallback`.

`fallback: {kind: 'node', to}` does not call the LLM at all. It speaks the target node's prompt and moves there. This is the default-arm mechanism.

**Request.** `InferenceRequest {history, input, context, uncertainty, tools: [], results: [], signal}`:

- `history`: the playback-confirmed conversation, as `ScriptBehavior`/`AgentBehavior` keep it (`packages/behaviors/src/history.ts`), last 12 turns.
- `context`: **before the latch**, `policy.unverifiedContext` and nothing else. **After the latch**, `AgentConfig.context`. See §H.
- `uncertainty`: `config.uncertainty`.
- `signal`: aborted by `cancel()` and by a superseding `beginTurn`, like `AgentBehavior.runResponse` (`agent.ts:78-82`).

**Reply handling.** The returned text is spoken as one or more `response` segments and the node becomes `fallback.resumeAt`, committed on the resume node prompt's **playback receipt**, not on the generated text. If the resume node is the current node, the node does not change and `maxVisits` is not incremented by the fallback.

**Budget.** `policy.maxFallbacksPerNode` consecutive fallbacks at one node. The counter resets on any tier-1 or tier-2 route. On exhaustion the behavior speaks `config.clarification` and reports `isComplete() === true`, so the engine ends the call with `EndReason 'behavior_completed'`. `maxFallbacksPerNode: 0` means the fallback never runs: the first miss speaks `config.clarification` and ends. A fallback cannot end a call on its own and cannot fire a side effect; the POC's `action` values (`send_payment_link`, `transfer_to_human`, `end_call`, `schedule_callback`) are not implemented and belong to the effects unit.

**No speculation.** The POC speculates the decision call on partial transcripts and launches the LLM in parallel with the decision model, cancelling it when the model is confident. Neither is implementable in a `Behavior`: `respondStream` is called only after the turn detector emits `turn.stopped`, so a behavior never sees an interim transcript (`SttEvent.stability` reaches the engine, not the behavior). Speculation is an engine concern and belongs to a separate unit; so does its accounting, which `normalizeInferenceEvidence` (`inference-evidence.ts:73`) currently marks `unknown` for any aborted call with no provider request id.

### G. Utterance, segments and speech kinds

`intent/segments.ts`. `IntentScriptNode.prompt` is **one** `Description` string; a POC node says an ordered list of pre-identified clips (CONTRACT GAP 1). P2 therefore:

- renders the prompt with `renderAnnouncementTemplate(prompt, variables, config.variables, config)` (`announcement.ts:83`), then splits it with the existing `text-segmenter.ts` / `sentence-boundary.ts`;
- yields the segments from `respondStream`, so each gets its own receipt and its own kind (`plugin-voice/src/engine/turn-driver.ts:117-133` calls `speechKind(text)` per segment);
- marks the first `policy.disclosurePrefix[node]` segments `'disclosure'`, the final segment `'confirmation'` when the node is in `policy.confirmationNodes`, and everything else `'response'`.

`speechKind(text)` is keyed on **text**, and a node may legitimately repeat a sentence (the POC says `anything_else` and `ask_when` at several nodes). Build a per-turn table from `(epoch, segment index, text)` and resolve a duplicate text within one turn to the **strictest** kind present — `disclosure` > `confirmation` > `response`. A `speechKind` that returns a different kind for the same text on the same turn is how the E3 duplicate-final defect (`book Friday book Friday`) class reappears. If a text is unknown to the current turn's table, return `undefined`, which the engines read as `'response'`.

`repeat`: when `policy.repeatIntentId` is chosen, re-yield the previous turn's segment list, prefixed by `policy.repeatPrefix` if set, with the same kinds. The node, the slot store, the visit count, the fallback counter and the latch are all unchanged. This is executor-reserved behavior the schema cannot express (CONTRACT GAP 4); it must be impossible to declare a route for it (compiler rule 8).

### H. The identity-verification gate

Built entirely on the existing `disclosure` kind and E1's mute semantics. **Nothing new is invented on the input side.**

**Input side, free.** `speechMuted` returns `true` for any `kind === 'disclosure'` regardless of configured rules (`plugin-turns/src/mute.ts:14-23`). So while a disclosure segment plays: no barge-in, no buffering, aggregated text reset, stop and safety timers cancelled (E1's 2026-09-26 merge correction), and in `FallbackTurns` the finals, interim and buffer are cleared at `bot.started{kind:'disclosure'}` (`fallback-turns.ts:37-41`) and STT is ignored for the duration (`:72`). E3's LiveKit path agrees: `turn-driver.ts:82-83` sets the gate to `'discard'` for disclosure and `allowInterruptions: false`. P2 is the **first production producer** of this kind — until now it existed only in the contract, the mute table, the turn kit (`conformance/src/kit/turn-scenarios.ts:152-154`) and E3's `SttGate`. Exercise both engines.

**Consequences P2 must not fight, and must test:**

- Anything the caller said before a disclosure segment starts is discarded. A node whose first segment is disclosure therefore throws away a late utterance from the previous turn's tail. That is correct for a compliance disclosure and must be asserted, not worked around.
- A nonterminal node's closing question must not be disclosure (compiler rule 10), or the answer is unreachable.
- Disclosure and confirmation cannot be combined on one segment. `speech-events.ts:81-88` protects whichever starts first and promotes `disclosure` over `confirmation`; a node that wants both needs two segments.

**Output side, the latch.** `latched` starts `false`. It becomes `true` only in `onPlayback(receipt)`, and only when the receipt matches a pending disclosure segment of a node in `policy.latchNodes` by exact text and epoch, **and** `receipt.state === 'completed'` **and** `receipt.evidence !== 'estimated'`. The stricter evidence rule is `ToolConfirmation.played`'s (`confirmation.ts:83`), not `ScriptBehavior.onPlayback`'s (`script.ts:73`): latching on a mark timeout would release loan facts that may never have reached the caller. An `interrupted` receipt does not latch. The latch never clears.

**What the latch gates.** Only the LLM fallback's `context`. Before the latch the fallback is given `policy.unverifiedContext`; after it, `config.context`. The scripted path is gated **structurally** — the graph makes every fact-bearing node reachable only through the latch node — and the compiler asserts that: for each node whose rendered prompt contains any `policy.gatedFacts` variable path, every path from `start` to it must pass through a `latchNodes` member. That is the POC's RBI-Fair-Practices line made checkable instead of inherited by accident. Note what the POC deliberately **does** say pre-verification: the customer's full name in `reassure` and `wrong_person`, the first name in `third_party` — name, never debt. `gatedFacts` therefore lists the debt variables (amount, due date, loan number, charge, total), not the name.

A conduct-policy layer (never threaten, never promise a waiver, write for the ear) has no contract; `policy.unverifiedContext` and `config.context` are free text. State that plainly in the package README rather than implying enforcement.

### I. The routing trace

`intent/trace.ts` exports a pure `RoutingTrace` value and an in-package observer on the concrete class (not on the `Behavior` port):

```ts
export interface RoutingTrace {
  nodeId: string;
  tier: 'rule' | 'ask' | 'decision' | 'llm' | 'repeat';
  intentId?: string;
  confidence?: number;
  calibrationVersion?: string;
  probabilities?: Readonly<Record<string, number>>;
  slots?: Readonly<Record<string, string>>;
  modelId?: string;
  decisionMs?: number;
  fallbackReason?:
    | 'decision_absent'
    | 'decision_other'
    | 'low_confidence'
    | 'decision_error'
    | 'decision_invalid'
    | 'no_route'
    | 'ask_exhausted';
  to?: string;
}
```

P2 does **not** publish it as an engine event. `BehaviorEvent` is a closed union (`ports.ts:99-107`) and `plugin-voice/src/engine/session-engine.ts:121` maps `event.type` straight into `VoiceEvent`, so a new member requires widening both unions plus a filter in E2-owned code. Recorded as CONTRACT GAP 11 and left to the unit that also builds the console test driver (`apps/console/features/test-console.tsx` currently POSTs `{useDraft: true}` and never sends the `callerScript` the API already accepts at `apps/api/src/routes/test-calls.ts:45,76`). Timing uses `ctx.maybe(Cap.clock)`, with an injectable `Pick<Clock,'now'>` defaulting to `Date.now`, so tests are deterministic and the absent-clock path is covered.

### CONTRACT GAPS (recorded at spec time; do not close any of these silently)

Each names the exact file, the exact missing capability, P2's stated workaround, and the field the owning unit should add to `packages/contracts/src/intent-script.ts`.

1. **Multi-segment node utterance.** `IntentScriptNode.prompt` is one `Description` (`:88`). A POC node says an ordered clip list with per-clip identity and kind. P2 sentence-splits the prompt and marks a disclosure prefix by count. Proposed: `segments?: Array<{text: Description; kind?: 'response' | 'disclosure' | 'confirmation'; clipId?: string}>`.
2. **No tier-1 rule field.** Nothing on `IntentDefinition` (`:72-82`) or `IntentRouterStep` holds a matcher. `ASK.options[].synonyms` are at most 20 `Label`s of ≤60 chars attached to a step's attribute, not to an intent — they cannot carry the POC's `YES` alternation (60+ forms across three scripts) or its `SPEAKING` family. P2 implements only the expressible subset: `ASK` options and `classifyConfirmation`. Proposed: `IntentDefinition.phrases?: Label[] /* max 50 */`, matched whole-utterance over `normalizeForMatch` — **literal phrases, not regex**: a stored, browser-editable regex is a ReDoS surface on the hot path.
3. **No graph-level routes.** `globalIntents` is graph-level (`:120`) but `routes` is node-local (`:95`), so a global intent has no target unless every node repeats it (34 nodes × 3 globals in the POC). Sidecar: `IntentPolicy.globalRoutes`. Proposed: `IntentScriptGraph.globalRoutes: Array<{intentId, when, to}>`.
4. **No "does not advance" intent.** `repeat` must replay without changing node, visits or effects; every route has a mandatory `to`. Sidecar: `IntentPolicy.repeatIntentId` as executor-reserved behavior. Proposed: `IntentDefinition.effect?: 'route' | 'repeat'`.
5. **No node-entry effects.** `IntentScriptNode` is `.strict()` with no `sms`, `log` or `verified`. The POC has 8 SMS-emitting, 19 log-emitting and 1 verification-gating node. P2 implements only the verification gate, via `IntentPolicy.latchNodes`. SMS egress and the business-disposition log are separate units; `CallOutcome` (`voice/end-reason.ts`) has no slot for `promise_to_pay:tomorrow` or `do_not_call_requested`. Proposed: `effects?: Array<{kind: 'disposition'; value: Label} | {kind: 'latch'}>` with ordering defined relative to the utterance.
6. **No confirmation marker.** Nothing says a node's expected answer is yes/no, which is precisely what E1's buffering window needs. Sidecar: `IntentPolicy.confirmationNodes` plus compiler rule 11. Proposed: `IntentScriptNode.answer?: 'open' | 'confirmation'`.
7. **No classifier framing.** The POC's LISTEN set has a `question` ("The agent asked to confirm the identity… How did they respond?") distinct from the utterance. `IntentScriptNode.prompt` is the utterance; `CLASSIFY.instructions` is per-step only. P2 derives the intent question's `instructions` from `node.prompt` plus a fixed framing, which removes author control over the single string the decision model reads. Proposed: `IntentScriptNode.classifierInstructions?: Description`.
8. **DTMF dropped.** The old `ScriptGraph` had `event: 'dtmf'` with `[0-9*#]` matches (`script.ts:43-44`); `IntentRouterStep` has no keypad input. The CM POC needs none, but an outbound EMI IVR will. P2 routes a DTMF turn to the node fallback. Proposed: `ASK.dtmf?: Record<'0'…'9'|'*'|'#', Label>`.
9. **`modelProfileId` has no resolver.** `CLASSIFY.modelProfileId` is required (`:47`) — `z.uuid()` in OCSO, relaxed to `z.string().min(1)` in OVO — but `Cap.decision` is session-scoped with cardinality `one`, so there is exactly one bound model and nothing consumes the id. P2 ignores it. Either delete it or make it select among `all(Cap.decision)`.
10. **Static vs model-chosen resume.** `fallback.kind === 'llm'` pins one `resumeAt` per node; the POC's model picks any LISTEN set or `end` per reply. P2 implements static resume for the reasons in §F. Proposed, if ever wanted: `resumeAt: NodeId | {kind: 'model'; allowed: NodeId[]}` with the allow-list validated at parse time — never an open enum.
11. **No routing-trace event.** §I. `BehaviorEvent` (`ports.ts:99-107`) and `VoiceEvent` (`voice/turn.ts:8-14`) are closed unions bridged by `session-engine.ts:121`. `StageKey` (`voice/engine.ts:74-85`) has no rule tier, decision tier or speculation marker either.
12. **No `'decision'` usage operation.** `UsageOperation` is `'carrier' | 'stt' | 'tts' | 'inference'` (`usage.ts:18`) and `OPERATION_SEGMENT` (`:35-40`) has no decision entry, so a tier-2 call can only meter as `'inference'` and becomes indistinguishable from the tier-3 fallback in the ledger. The POC's entire cost pitch is the per-tier split. P1 owns the fix (`usage.ts:18`, `:35-40`, `MeterDeclaration.role`, `meters.ts:16-18`, `meter-uncovered.ts:7-12`); P2 meters nothing.
13. **No typed slots.** `IntentDefinition.slots` is `AttributeKey[]` — names only (`:78`). The only extractors are closed label lists. The POC's one slot (`ptp_when`, six described options) **is** expressible as a `CLASSIFY` step, so the POC is unblocked; "I'll pay ₹4,500 on the 14th" is not. The first collections flow that wants a promise-to-pay amount or date is blocked here.
14. **No wall-clock bound.** OCSO's `timeoutMinutes` (1–1,440) was dropped. `maxVisits` counts turns only. `AgentConfig.costPolicy.maxCallSeconds` bounds the call, not the graph.

### MODULES (≤300 canonical lines each; target ≤200)

- `intent/graph.ts` — compile and reject. Every rule in §C, each with its own message string. No execution.
- `intent/rules.ts` — tier 1: `ASK` option matching (incl. absent `synonyms`), `classifyConfirmation` mapping, node-then-global order.
- `intent/decision-request.ts` — build the single `DecisionRequest`; omit skipped and unreferenced slot questions; inject `other`.
- `intent/decision-answer.ts` — `validateDecisionExchange`, per-intent threshold, slot thresholds, the six fallback reasons.
- `intent/slots.ts` — slot store, `KNOWN` reads, `when` evaluation (AND across keys, OR within an array, `{}` matches all), first-match-wins.
- `intent/segments.ts` — render, split, kind table keyed on `(epoch, index, text)` with strictest-kind-wins, replay list.
- `intent/fallback.ts` — tier 3 via `Inference.generate`, gated context, static resume, per-node budget, abort wiring.
- `intent/trace.ts` — `RoutingTrace` and the in-package observer.
- `intent/behavior.ts` — the `Behavior`: `respondStream`, `respond` (join), `beginTurn` (increasing-epoch guard as `script.ts:98-108`), `onPlayback` (advance + latch), `cancel`, `isComplete`, `speechKind`, `subscribe` (returns a no-op unsubscribe; P2 emits no `BehaviorEvent`).

`packages/behaviors` may import **only** `@winsendotai/ovo-contracts`, `@winsendotai/ovo-runtime`, `zod`, `ajv`, `ajv-formats` and `node:*` (`scripts/check-architecture.mjs:109-121`). No plugin, no `sdk`, no `plugin-kit`. That is why the mode lives here and not in a new package: `createBehaviorPluginCatalog()` and `BEHAVIOR_IDS_BY_MODE` must stay in this package for `behaviorPluginId` to resolve, and this package cannot import a sibling.

### TESTS (no network; `FakeClock` and injected signals only)

**The rule for this unit: every conditional and every optional field gets its ABSENT and NEGATIVE case, in the same table as its present case.** That pattern has hidden seven real defects in this project — see E1's seven production-factory regressions, E3's four lifecycle regressions and the `0.55`-threshold class of bug. A test that only proves the happy path is not accepted here.

`packages/contracts/tests/p2-intent-policy.test.ts`

- every `IntentPolicy` field absent → parses, defaults applied; present → parses; out of range → rejected;
- `intentScript` without `mode: 'intent-graph'` → rejected; the mode without `intentScript` → rejected; `intentPolicy` without `intentScript` → rejected;
- both `script` and `intentScript` set → rejected;
- a policy reference naming a node or intent that is not in the graph → rejected, one case per field.

`packages/behaviors/tests/p2-graph-validation.test.ts` — table-driven, one row per compiler rule in §C, each row asserting the exact message, plus the passing counterpart:

- an intent id of `Balance`, `_x`, `9a`, `-a` → rejected (decision-id grammar); `balance` → accepted;
- a `CLASSIFY` label value `Not Received` → rejected; `not_received` → accepted;
- `CLASSIFY.instructions: ''` → rejected; `labels[0].description: ''` → rejected; both non-empty → accepted;
- an intent id `other` → rejected; a label value `other` → rejected;
- `maxFollowUps: 1` → rejected; `0` → accepted;
- `ASK.prompt.templates: {<uuid>: <uuid>}` → rejected; absent → accepted;
- an unreachable node → rejected; the same node reached only via `fallback.resumeAt` → accepted; only via `globalRoutes` → accepted;
- a global intent with no route anywhere → rejected; with only a node route → accepted; with only a `globalRoutes` entry → accepted;
- `repeatIntentId` naming an undeclared global → rejected; with a node route for it → rejected; with a `globalRoutes` entry for it → rejected; route-free → accepted;
- two routes for one intent where the first has `when: {}` → rejected; reversed order → accepted;
- `disclosurePrefix` equal to the sentence count on a nonterminal node → rejected; on a terminal node → accepted; one less → accepted; absent → accepted with no disclosure;
- a `confirmationNodes` entry for a node with three non-global intents → rejected; for `link_check`'s `received`/`not_received` → rejected; for `confirm_week`'s `yes`/`no` → accepted;
- a gated-fact node reachable without passing a latch node → rejected; with the latch node on every path → accepted; `gatedFacts: []` → accepted.

`packages/behaviors/tests/p2-tiers.test.ts`

- tier 1 hit → no `decide` call at all (spy count 0) and `trace.tier === 'rule'`;
- `Cap.decision` absent → `decision_absent` and the LLM runs; present → tier 2 runs;
- a decision port that throws → `decision_error`; that never settles until the injected signal aborts → `decision_error`; that returns `{choice:'other'}` → `decision_other`; that returns `confidence` one tick below the chosen intent's `minConfidence` → `low_confidence`, and one tick above → accepted;
- a response omitting `calibrationVersion` → `decision_invalid` and a fallback, **not** a thrown turn; including it → accepted;
- a response with unnormalized probabilities, a non-argmax `choice`, a missing criterion, and an extra answer → `decision_invalid`, one case each;
- `minConfidenceFloor` raising an intent's `minConfidence: 0` above the answer → `low_confidence`; floor absent → accepted;
- `maxFallbacksPerNode: 0` → the first miss speaks `config.clarification` and `isComplete()` is true; `2` → two fallbacks then clarification; a tier-1 route in between resets the counter;
- a DTMF turn → node fallback with `no_route` and **zero** `decide` calls;
- an injected clock absent → `decisionMs` is a finite number ≥ 0.

`packages/behaviors/tests/p2-slots.test.ts`

- one `DecisionRequest` carries `questions.intent` and `questions.ptp_when` — assert `decide` was called **once** and `Object.keys(request.questions).length === 2`;
- `skipIfKnown: true` with the attribute already in the store → the slot question is **absent** from the request; `skipIfKnown: false` with the same store → present;
- a `CLASSIFY` attribute no route references → absent from the request;
- a slot answer below `step.minConfidence` → slot unresolved, `when` unmatched, node fallback taken (the `ptp_ask` default arm); above it → the matching route taken;
- each of the six `ptp_when` values → its own target node, and an unrecognised value → the fallback;
- `when` with two keys where one matches → no route; with an array value matching one member → route; `when: {}` → route;
- `KNOWN from: 'customer.language'` → store holds `config.language`; `from: 'customer.attribute:dpd'` with the variable absent → unresolved, no throw; present but a number → unresolved, no throw; present as a string → stored;
- `ASK` with `synonyms` absent → value and label still match; with synonyms → a synonym matches; no match and `maxAttempts: 2` → re-asked once then `ask_exhausted`.

`packages/behaviors/tests/p2-globals.test.ts`

- each of the four POC globals (`repeat`, `human_agent`, `stop_calling`, `abusive`) resolved at two different nodes, including inside a pending `ASK` step;
- a node intent and a global intent both plausible → the global wins (the contract's documented precedence, `intent-script.ts:119`);
- a node route for a global intent id overrides `globalRoutes`; with the node route absent, `globalRoutes` applies;
- `repeat` → the previous turn's exact segment list and kinds are re-yielded, the node is unchanged, `maxVisits` is not incremented, the slot store is unchanged, the fallback counter is unchanged;
- `repeat` as the very first turn (no previous utterance) → re-speaks the current node prompt, does not throw;
- `repeatPrefix` absent → replay with no prefix; present → prefixed;
- `repeatIntentId` absent entirely → a global named `repeat` routes like any other intent.

`packages/behaviors/tests/p2-disclosure-gate.test.ts`

- a disclosure segment's receipt `{state:'completed', evidence:'confirmed'}` → latched; `{state:'completed', evidence:'estimated'}` → **not** latched; `{state:'interrupted'}` → not latched; a receipt whose text or epoch does not match → not latched;
- pre-latch fallback: `request.context === policy.unverifiedContext` and contains **none** of the `gatedFacts` values rendered from `variables`; post-latch: `request.context === config.context`;
- `latchNodes: []` → the gate never latches and the fallback keeps the unverified context for the whole call;
- `disclosurePrefix` absent → every segment is `'response'` and `speechKind` returns `undefined` for all of them;
- a node in both `disclosurePrefix` and `confirmationNodes` → the disclosure prefix and the final confirmation segment are distinct segments, and no single segment carries both kinds;
- duplicate segment text within one turn where one instance is disclosure → `speechKind` returns `'disclosure'` for both (strictest wins), and the same text on a later turn where neither is disclosure returns `'response'`;
- text never spoken this turn → `speechKind` returns `undefined`.

`packages/behaviors/tests/p2-e1-interaction.test.ts` — the **real** detector from `@winsendotai/ovo-plugin-turns` (`createTurnDetector(...).create({clock: FakeClock, vad: true, language, mode: 'intent-graph'})`), driven with `VoiceEvent`s, asserting `TurnDecision`s:

- `defaultMuteRules('intent-graph')` is `['during-confirmation']` — asserted directly, so the `voice/turn.ts` row cannot silently change;
- a one-word `'yes'` spoken during a `confirmation`-kind segment → no `interrupt`, nothing released, and `turn.stopped {text:'yes'}` at `bot.stopped`; with `minWordsWhileBotSpeaking: 0` as well (E1's zero-threshold regression);
- `'ஆமாம்'` and `'illa'` during the same prompt → released and classified `yes` / `no`;
- `'I can pay on Friday'` during a confirmation prompt → `turn.reset {reason:'muted'}`, nothing released — the documented loss that compiler rule 11 exists to prevent;
- a transcript arriving during a `disclosure` segment → discarded, no `interrupt`, no release, and a later provider end, safety timeout and VAD timeout each release nothing (E1's six mute-boundary rows);
- text finalized **before** `bot.started{kind:'disclosure'}` → discarded with `turn.reset {reason:'muted'}`, and a fresh turn after `bot.stopped` is accepted without the old text;
- an ordinary `response` segment with a two-word interruption → `interrupt {reason:'transcript'}` (barge-in still works in this mode);
- after `dispose()`, `clock.pendingTimers === 0`.

`packages/fixture-calls/tests/p2-intent-graph-call.test.ts` — a full fixture call through the real distribution:

- `runFixtureCall` with an `intent-graph` release, an explicit `CallerScript`, a fixture `DecisionPort` and a fixture inference, over **both** engine selections (native and LiveKit), asserting identical accepted turns, identical final node, and FixtureNet recording zero vendor requests;
- the same release with no `decision` selection → the call still completes through tiers 1 and 3;
- `defaultCallerScript` and `predictedAgentTexts` rows exist for the mode (a missing row leaves the default path silent);
- `sessionRequiresInput({mode:'intent-graph'})` is `true` and `initialInput` is `''`, so the agent speaks the start node first;
- `validatePermittedGraph` accepts the intent-graph behavior for the mode and rejects every other behavior id for it with the exact message `Behavior <id> is incompatible with mode intent-graph`;
- `modeRequiresLlm` blocks a release with no `llm` selection; `meterUncovered` reports the `llm` role as required.

**Value true negatives to record in the handoff** (name the prior behavior and the exact failure string, per `PM/HANDOFF.md`): remove the `voice/turn.ts` `DEFAULT_MUTE` row → typecheck fails before any test runs; remove the `BEHAVIOR_IDS_BY_MODE` row → typecheck fails (and, with the old cast restored, fails only at runtime with `Behavior … is incompatible with mode intent-graph`); relax the latch to `ScriptBehavior`'s evidence rule → the estimated-receipt case fails with the gated fact present in the fallback context; drop compiler rule 11 → the `link_check`-as-confirmation case fails with the caller's answer absent from the released turns; drop the strictest-kind-wins rule → the duplicate-text case fails with `'response'` where `'disclosure'` was expected; send `calibrationVersion`-less answers through without `validateDecisionExchange` → the invalid-response case routes on an uncalibrated confidence instead of falling back.

### CONSTRAINTS

- `packages/behaviors` imports only contracts, runtime, zod, ajv, ajv-formats and `node:*`. Test files are exempt from that gate (`scripts/check-architecture.mjs:87`) and may import `@winsendotai/ovo-conformance/drivers` and `@winsendotai/ovo-plugin-turns`; add them as `devDependencies` and resolve with `pnpm install --offline`. Both are `workspace:*`. If the offline install cannot resolve, STOP and report; do not reach the network.
- Modules ≤300 canonical lines, tests ≤500 (`scripts/check-module-size.mjs:18-21`). No new `scripts/baselines/module-size.json` entry.
- No new capability key, no new `Slot`, no new `PluginKind`, no new `UsageUnit`, no new `UsageOperation`. P1 owns the `decision` slot and its 16-file touch list, the `decision@1` conformance kit and the `'decision'` usage operation.
- No network, no vendor, no carrier, no provider. No live or paid flags. OVO has never placed a real call; nothing here places one.
- No `git stash`. No git commits.
- Out of scope, and each belongs to a named sibling unit: pre-rendered and templated clips plus spoken-form money/date rendering (P3); SMS egress and the business-disposition log (effects unit); the routing-trace engine event and the console turn-by-turn test driver (console unit); interim-transcript speculation, the parallel-LLM launch and aborted-inference accounting (engine unit); human handoff (roadmap item 4).

## Acceptance

- The POC's `identity`, `payment` and `confirm_week` LISTEN sets and the `greet` → `disclose` → `ptp_*` / `hardship` nodes parse as an unmodified `IntentScriptGraph`, or the unit stopped at STEP 0 with the exact Zod issue path recorded. `packages/contracts/src/intent-script.ts` is byte-identical to its I1 state.
- `@winsendotai/ovo-behavior-intent-graph` is the single `ovo.behavior` provider for `mode: 'intent-graph'`, resolves through `BEHAVIOR_IDS_BY_MODE` in both `session-catalog.ts` and `release-graph.ts`, and a missing mode row fails typecheck rather than a live call.
- A tier-1 hit makes zero `DecisionPort` calls. A tier-2 turn makes exactly one, carrying the intent question and every needed slot question in one `DecisionRequest`. `Cap.decision` absent degrades to tiers 1 and 3 with `fallbackReason: 'decision_absent'`.
- All six fallback reasons are reachable and distinct, and none of them fails a turn. `validateDecisionExchange` runs on every response; a response without `calibrationVersion` produces a fallback, never a route.
- The LLM fallback resumes at the validated `fallback.resumeAt`, commits on the resume prompt's playback receipt, is capped by `maxFallbacksPerNode`, and cannot end the call or fire an effect. `maxFallbacksPerNode: 0` is a working configuration.
- The four global intents resolve at every node including inside a pending `ASK`; a node route overrides `globalRoutes`; `repeat` replays without changing node, visits, slots, the fallback counter or the latch, and cannot be given a route.
- The fact latch is set only by a `completed`, non-`estimated` disclosure receipt. The pre-latch fallback context contains no `gatedFacts` value. A graph that can reach a gated-fact node without passing a latch node is rejected at compile time.
- With the real `plugin-turns` detector: a confirmation answer is buffered and released at `bot.stopped`, never interrupted; a disclosure segment discards everything including text finalized before it started; barge-in still works on ordinary responses; `dispose()` leaves no timer.
- Every compiler rule in §C has a rejecting case with its exact message and an accepting counterpart. Every optional field and every conditional in the executor has an ABSENT case.
- A full fixture call completes identically on the native and LiveKit engine selections with zero FixtureNet vendor requests, and also completes with no `decision` selection.
- All fourteen CONTRACT GAPS are restated in `packages/behaviors/README.md` with their file:line evidence and proposed fields. None has been closed by widening `intent-script.ts`.
- Scoped lint (seven gates), scoped typecheck and the listed test paths are green, and root `pnpm check` is green — a `Mode` change reaches every app.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/behaviors packages/contracts packages/session-host packages/fixture-calls apps/api apps/worker`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/behaviors packages/contracts packages/session-host packages/fixture-calls apps/api apps/worker`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/behaviors packages/contracts packages/session-host packages/fixture-calls packages/distribution packages/plugin-turns packages/plugin-voice --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm check`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && OVO_TEST_POSTGRES_URL=<disposable loopback> RECORDING_TEST_DATABASE_URL=<same> pnpm exec vitest run --no-file-parallelism --reporter=dot`
