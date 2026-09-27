# Native voice engine

The production catalog exports the native v2 engine, its speech scheduler and
streaming output companions, and the markdown and URL text filters. The default
markdown filter remains registered as required by the F3 carry-forward.

## Normalization boundary: reproduced failure before approval — 2026-09-26

The checker requires unit-local structural adapters for frozen contract gaps.
E2 must not change `packages/session-host` or frozen interfaces. The eight units
outside Batch A remain paused. No host or contract file was changed here.

There is no E2-owned callback before the observed draft mutation:

1. `apps/api/src/routes/agents.ts` loads the draft and calls
   `buildReleaseSelections` with that object.
2. `apps/api/src/release-selections.ts:43` calls `normalizeAgentConfig(agent.config,
...)` directly.
3. `packages/session-host/src/normalize.ts:35` shallow-copies `config.voice`, then
   line 62 pushes the installed default into the shared `textFilters` array.
   `PluginRegistry.get` only searches the catalog; it does not call plugin code.
4. The storage repository compares the mutated draft with its durable copy and
   correctly rejects it as `draft_conflict`.

The E2 scheduler/output factories called during catalog preparation do not receive
the draft. Engine and filter execution happen later. An adapter placed in those
callbacks cannot protect this input. Global patches, accessor side effects, or
removing the markdown default would hide the problem and are not used.

The minimal effective alternative is the one-line API caller change
`normalizeAgentConfig(structuredClone(agent.config), ...)`. The API file is owned
by I1, so a scope exception is still needed even though it is not the frozen host
implementation. The proposed patch is kept outside the repository until that
decision; the working API file is unchanged. I1 also inherits the general host
input-immutability gap, which the caller clone does not repair for other callers.

### Executed proof

`tests/release-normalization.test.ts` uses the real `buildManagementApi`,
`app.inject`, and SQLite store. It observes the draft through the API's existing
release-plugin seam and requires the source and stored draft to remain unchanged,
publication to return 201, and both the native engine and default markdown filter
to remain selected. It does not replace normalization, persistence, or the filter.

- Current code: the new regression fails because the source `textFilters` changes
  from `[]` to the markdown filter. The existing API suite separately reports
  7 failed / 63 passed / 10 skipped; all seven failures are 409 draft conflicts.
- Temporarily applying only the caller clone: the combined API suite and new
  regression pass, 71 passed / 10 skipped. The API file was restored afterward.
- Exact commands:

```sh
pnpm exec vitest run apps/api/tests --reporter=dot
pnpm exec vitest run packages/plugin-voice/tests/release-normalization.test.ts --reporter=dot
pnpm exec vitest run apps/api/tests packages/plugin-voice/tests/release-normalization.test.ts --reporter=dot
```

These measurements used Node 22 and normal dependency resolution. The remaining
external root dependency links were copied locally before frozen offline
verification; no manifest, lockfile or tracked configuration changed. No alias or
test suppression is used. E2 remains WIP while this publication path is blocked.

### Pre-approval normal gate results with the API file restored

- `node scripts/lint.mjs --only packages/plugin-voice packages/plugin-speech-cache experiments/voice`:
  exit 0, seven gates, zero scoped architecture baseline edges, largest source
  291 canonical lines.
- `node scripts/check-duplication.mjs`: exit 0, 790 source files and 57 existing
  baseline pairs.
- `pnpm format:check`: exit 0 after authorized formatting of the rebased board.
- `pnpm typecheck`: exit 0, including console typecheck.
- `pnpm build`: exit 0, including the normal console build.
- The focused command below: exit 1, 135 passed / 1 failed. Only the new input
  immutability regression fails; existing engine and HANDOFF cases pass.
- `pnpm exec vitest run --reporter=dot`: exit 1, 1,361 passed / 138 skipped /
  8 failed (1,507 total). These are the seven existing publication failures and
  the new regression for the same shared mutation. No green full bar is claimed.

```sh
pnpm exec vitest run packages/plugin-voice packages/plugin-speech-cache apps/api/tests/voice-engine-release.test.ts apps/worker/tests/production-engine-selection.test.ts apps/worker/tests/native-extension-pins.test.ts apps/worker/tests/session-recording.test.ts --reporter=dot
```

## Approved repair — 2026-09-27

The checker authorized the one-line `structuredClone(agent.config)` at the API
caller. It is now applied with the existing real API/SQLite regression; the
frozen normalizer remains untouched. The API path is an I1-owned shared touchpoint,
not a frozen path. The earlier failed counts above are the pre-repair baseline.
Full normal verification is being rerun before Built status.

**BLOCKING I1:** the normalizer mutates its input. Fix the normalizer and regress
that contract directly at integration; this one caller clone is not a general
repair and must not become a pattern of collecting clones.

## Final normal bar — 2026-09-27

Merged at `007606f`: `pnpm check` EXIT 0, **1,369 passed / 138 skipped**;
Postgres serial **1,498 passed / 9 skipped / 0 failed**; Playwright **41 passed /
1 visibility-gated skip**. Scoped lint/full format **0 / 0**, standalone
duplication **0**. Independent real API/immutability regression **71 passed /
10 skipped**. The unit spec records exact commands, skip gates and true negatives.
E2 is **Built — awaiting check**. The normalizer's input mutation remains a
**BLOCKING I1** obligation despite the repaired API caller.
