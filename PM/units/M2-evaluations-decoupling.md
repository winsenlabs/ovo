# Work unit M2-evaluations-decoupling: Remove plugin-evaluations' imports of plugin-ledger, plugin-tools and behaviors via contracts and host-injected factories; #19 in evaluation validation

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [19]

## Owned paths

- packages/plugin-evaluations/**
- apps/api/src/evaluation-plugin.ts
- apps/api/src/evaluation-runtime.ts
- apps/api/src/provider-evaluation-runtime.ts
- apps/api/src/routes/evaluation-datasets.ts
- apps/api/src/routes/evaluation-provider-authorizations.ts
- apps/api/tests/evaluation-runtime.test.ts
- apps/api/tests/evaluation-provider-authorizations.test.ts
- apps/api/tests/provider-evaluation-runtime.test.ts
- scripts/baselines/pending/M2.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: make packages/plugin-evaluations depend only on contracts, runtime, sdk, kits and third-party, so I1 can empty the architecture baseline. Behavior stays unchanged, and paid-evaluation safety (durable admin authorization, the server-only enable flag, reservations as admission guards, meter checks) is preserved. Read docs/architecture/plugin-platform.md (revision 2): section 0.2 (invariants), section 2.1 (contracts pricing.ts and inference-evidence.ts, which F1 moved), section 13 (kind table) and section 15.5 (edge owners).

Today's edges (grep to confirm):

- provider-authorizations.ts, provider-executor.ts, provider-policy.ts and provider-gate.ts import types and functions from @winsendotai/ovo-plugin-ledger: CostLedgerService, normalizeInferenceEvidence, inferenceMeterKey, InferenceEvidenceState, InferenceUsageEvidence and InferenceMeterUnit;
- executor.ts imports behavior constructors from @winsendotai/ovo-behaviors (ExecutingFaqBehavior, createAgentBehavior, createAnnouncementBehavior, createContextBehavior, createFaqBehavior, withScript) and createExecutionService from @winsendotai/ovo-plugin-tools.

WORK:

1. Import normalizeInferenceEvidence, inferenceMeterKey and the inference-evidence types from @winsendotai/ovo-contracts; F1 moved them there verbatim, and plugin-ledger re-exports them.
2. Replace CostLedgerService with a local structural interface (EvaluationCostLedger) declaring only the methods plugin-evaluations calls. apps/api keeps passing the real PostgresCostLedger, which must satisfy it structurally (a type test).
3. Replace the behavior and tool imports with injected host factories. Define EvaluationHostFactories {createBehavior(config, deps): Behavior; createExecution(config, deps): Execution} using contracts types, passed through the evaluation service and executor constructors.
   - apps/api/src/evaluation-runtime.ts (and provider-evaluation-runtime.ts where relevant) implements the factories by importing @winsendotai/ovo-behaviors and @winsendotai/ovo-plugin-tools. Apps may import non-vendor plugins.
   - The executor's behavior selection per mode (including faqTools and withScript) moves into that host factory unchanged, or stays in evaluations with the constructors injected. Pick the smaller diff that removes the imports.
4. #19: packages/plugin-evaluations/src/validation.ts:94 uses canonicalJson from contracts instead of localeCompare. Add a non-ASCII key-ordering test.
5. Keep the provider-neutral policy F4 introduced in provider-policy.ts and provider-gate.ts (any installed llm plugin, meter checks kept).
6. Size: provider-executor.ts (398 canonical lines), runs.ts (364) and apps/api/src/routes/evaluation-datasets.ts (366) are baselined. Split any file BEFORE adding lines to it.

TESTS:

- The existing plugin-evaluations and API evaluation tests pass (updated only for constructor injection).
- A type-level test that PostgresCostLedger satisfies EvaluationCostLedger.
- A 120-case corpus smoke test (existing) still passes through the injected factories.
- The validation ordering test.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen: contracts, plugin-ledger (O2), behaviors and plugin-tools (M1), api-plugin.ts and every package.json. If plugin-evaluations/package.json still lists the removed dependencies, leave them; I1 prunes the dependency lines, because the lockfile is frozen.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/M2.json.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- No behavior change.
- Preserve the paid-evaluation authorization, idempotency and restore-fence semantics.
- Modules ≤300 lines. No git commits.

## Acceptance

- packages/plugin-evaluations/src imports no @winsendotai/ovo-plugin-* package and no @winsendotai/ovo-behaviors, so its architecture baseline entries go stale.
- The inference-evidence helpers come from contracts. The ledger is used through a local structural interface that PostgresCostLedger satisfies (type test). Behaviors and execution are created by host factories injected from apps/api.
- validation.ts uses canonicalJson (#19), with a non-ASCII test.
- The existing evaluation tests and the 120-case corpus pass unchanged apart from constructor wiring. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-evaluations apps/api/src/evaluation-plugin.ts apps/api/src/evaluation-runtime.ts apps/api/src/provider-evaluation-runtime.ts apps/api/src/routes/evaluation-datasets.ts apps/api/src/routes/evaluation-provider-authorizations.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-evaluations apps/api/src/evaluation-plugin.ts apps/api/src/evaluation-runtime.ts apps/api/src/provider-evaluation-runtime.ts apps/api/src/routes apps/api/tests`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-evaluations apps/api/tests/evaluation-runtime.test.ts apps/api/tests/evaluation-provider-authorizations.test.ts apps/api/tests/provider-evaluation-runtime.test.ts --reporter=dot`
