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

Top-level files are regenerated only with `node scripts/check-<gate>.mjs --write-baseline` (and
`OVO_WRITE_VIOLATION_BASELINE=1 pnpm test` for runtime violations). Wave-2 units never edit them.

## Pending baselines

A transitional violation introduced by a unit goes only into that unit's own
`pending/<UNIT>.json`, which every gate and the runtime-violation teardown merge:

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

Every pending entry needs a `reason` and `removeBy: "I1"`. Module size stays hard-capped at 400
lines (tests 500) even for pending entries. I1 deletes `pending/`.
