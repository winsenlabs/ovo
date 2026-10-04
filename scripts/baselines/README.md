# Gate baselines

Ratchet baselines for the code-hygiene gates (`pnpm lint` = `node scripts/lint.mjs`, design §13).
Entries record violations that existed when F2 introduced the gate. An entry may shrink or disappear,
never grow; a stale entry (the file or violation is gone) is a warning, not a failure.

| File                      | Gate                        | Shape                                              |
| ------------------------- | --------------------------- | -------------------------------------------------- |
| `architecture.json`       | `check-architecture.mjs`    | `{edges: [{from, to, reason}]}` (package → target) |
| `module-size.json`        | `check-module-size.mjs`     | `{files: {path: lines}}` for 301–400-line sources  |
| `duplication.json`        | `check-duplication.mjs`     | `{pairs: [{files: [a, b], windows}]}`              |
| `provider-names.json`     | `check-provider-names.mjs`  | `{files: {path: count}}`                           |
| `capability-keys.json`    | `check-capability-keys.mjs` | `{files: {path: count}}`                           |
| `conformance.json`        | `check-conformance.mjs`     | `{packages: [dir]}`                                |
| `runtime-violations.json` | `vitest-global-setup.ts`    | `{violations: [{pluginId, kind, key}]}`            |

`check-upstream.mjs` has no baseline: a pinned upstream hash either matches or the lock is wrong.

Top-level files are regenerated only with `node scripts/check-<gate>.mjs --write-baseline` (and
`OVO_WRITE_VIOLATION_BASELINE=1 pnpm test` for runtime violations). Wave-2 units never edit them.

`--write-baseline` always rescans the whole repository and is **refused together with `--only`**:
a scoped run only ever builds the in-scope part of a gate's state, so writing it out would delete
every entry outside the prefixes. `node scripts/lint.mjs --write-baseline --only x` therefore fails
on the first gate instead of truncating six baselines.

## I1 residue review (2026-10-02)

`module-size.json`, `architecture.json`, `provider-names.json`, `conformance.json`,
and `runtime-violations.json` are empty. I1 removed `pending/`. The two ratchets
below remain nonempty for the stated boundaries; each entry must still shrink or
disappear when the corresponding code changes.

| `duplication.json` pair                                                                                                                                                                                                                     | Why it remains                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/agents.ts` + `apps/api/src/routes/mcp.ts`                                                                                                                                                                              | Both enforce workspace-scoped release/MCP writes, but their repository operations and error contracts differ. A shared request wrapper here would hide the distinct authorization and tombstone checks.                                                                                  |
| `apps/api/src/routes/recording-lifecycle-data.ts` + `apps/worker/src/recording-runtime.ts`                                                                                                                                                  | API disclosure mapping and worker capture mapping deliberately run on opposite sides of the process boundary; their similar field lists have different authorization and persistence responsibilities.                                                                                   |
| `apps/api/src/routes/recording-lifecycle-exports.ts` + `apps/api/src/routes/recording-lifecycle.ts`                                                                                                                                         | The common error, audit and lookup helpers are shared in `recording-lifecycle-support.ts`; the remaining windows are the independently authorized route handlers for export versus live recording.                                                                                       |
| `apps/console/components/operations/campaigns-view.tsx` + `apps/console/components/operations/suppressions-view.tsx`                                                                                                                        | The repeated page controls serve separate campaign and suppression data with different mutations; combining the handlers would erase the domain distinction for nine token windows.                                                                                                      |
| `apps/console/components/operations/fx-version-panel.tsx` + `apps/console/components/operations/price-card-panel.tsx`; each of those with `reconciliation-panel.tsx`                                                                        | These panels repeat controlled-form layout and validation feedback. The FX, price-card and reconciliation payloads and write permissions differ. A future shared form primitive can remove the layout duplication without merging their data logic.                                      |
| `packages/plugin-inference/src/simulated.ts` + `packages/plugin-voice/src/async.ts`                                                                                                                                                         | The async iterator scaffolding is similar, but inference emits model deltas and voice emits timed media; sharing the iterator now would couple their cancellation and timing semantics.                                                                                                  |
| `packages/plugin-ledger/src/postgres/catalog.ts` + `packages/plugin-ledger/src/postgres/usage-pricing.ts`                                                                                                                                   | Both inspect price-card identity, but catalog writes and usage pricing carry different transaction and historical-price invariants.                                                                                                                                                      |
| `packages/plugin-recordings/src/background-worker.ts` + `packages/plugin-recordings/src/exports.ts`                                                                                                                                         | Three windows cover independent work/expiry transitions; their durable status updates must remain separate.                                                                                                                                                                              |
| `packages/plugin-storage/src/postgres/inspection-repository.ts` + `packages/plugin-storage/src/sqlite/inspection-repository.ts`; `postgres/secrets-repository.ts` + `sqlite/secrets-repository.ts`; `postgres/store.ts` + `sqlite/store.ts` | Public row types and pure mapping were consolidated in I1. The residual SQL and transaction handling is duplicated across distinct Postgres and SQLite drivers, including different locking behavior; a common SQL implementation would not preserve both backends' isolation semantics. |

The 33 `capability-keys.json` entries are literal capability declarations or
composition bindings. These are protocol identifiers, not provider selection
branches. They remain visible in the ratchet so a newly introduced literal in
a host still fails the gate.

| Files in `capability-keys.json`                                                                                                                                                                                                                                                     | Reason                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/{api-plugin,bootstrap,evaluation-plugin,infrastructure-plugin,infrastructure-runtime,recording-runtime,user-plugin}.ts`                                                                                                                                               | API bootstrap declares and resolves installed capability slots at the composition boundary. The 20 hits in `api-plugin.ts` are its explicit wiring table. |
| `apps/worker/src/{call-recorder,cost-runtime,runtime-plugins,telemetry-stages,worker-environment,worker-plugin}.ts`                                                                                                                                                                 | Worker bootstrap binds host ports and capability slots; `worker-plugin.ts` is its explicit 14-key registration table.                                     |
| `packages/{behaviors,plugin-cache,plugin-evaluations,plugin-example,plugin-ledger,plugin-media,plugin-observability,plugin-operations,plugin-orchestration,plugin-recordings,plugin-storage}/src/{index,plugin,plugins,ports,telemetry-plugin}.ts` (only paths present in the JSON) | Plugin manifests, port exports and composition registries must declare their provided or required capability keys literally for runtime validation.       |
| `packages/{plugin-inference,plugin-speech-cache,plugin-voice}/src/{types,production-plugins}.ts` and `packages/{runtime,ui}/src/{installed,index}.ts` (only paths present in the JSON)                                                                                              | These files expose typed capability names, installed-slot registrations or public UI capability metadata; they do not choose a vendor by string.          |

## Historical pending-baseline format

A transitional violation introduced by a wave-2 unit went into that unit's own
`pending/<UNIT>.json`, which every gate and the runtime-violation teardown merged:

```json
{
  "architecture": [{ "from": "packages/x", "to": "packages/y", "reason": "…", "removeBy": "I1" }],
  "moduleSize": [{ "file": "packages/x/src/a.ts", "lines": 320, "reason": "…", "removeBy": "I1" }],
  "duplication": [{ "files": ["a.ts", "b.ts"], "windows": 4, "reason": "…", "removeBy": "I1" }],
  "providerNames": [{ "file": "apps/api/src/a.ts", "count": 2, "reason": "…", "removeBy": "I1" }],
  "capabilityKeys": [
    { "file": "packages/x/src/a.ts", "count": 1, "reason": "…", "removeBy": "I1" }
  ],
  "conformance": [{ "package": "packages/plugin-x", "reason": "…", "removeBy": "I1" }],
  "runtimeViolations": [
    { "pluginId": "…", "kind": "…", "key": "…", "reason": "…", "removeBy": "I1" }
  ]
}
```

Every pending entry needed a `reason` and `removeBy: "I1"`. Module size stayed hard-capped at 400
lines (tests 500) even for pending entries. I1 deleted `pending/`.
