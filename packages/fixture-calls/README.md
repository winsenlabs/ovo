# Fixture calls

This host library runs a selected session graph with FixtureNet providers and a
selected carrier serializer. It exports `runFixtureCall`; its empty `plugins`
array is intentional. The distribution's API catalog entry imports that public
export. The API production path is `index.ts`'s `--ovo-fixture-call-child` branch
→ `runFixtureCallChild(executeFixtureChildJob)` → `runFixtureCall`.

## D1 checkpoint — 2026-09-26

The owned manifest no longer declares `ovo.skeleton`. This is a metadata change:
the distribution loader and API runtime did not consult the flag. No dependency
or lockfile changed. D1 remains in progress.

`tests/catalog.test.ts` invokes the public library through the real `FIRST_PARTY`
loader, then verifies selected fixture providers, carrier media frames, telemetry,
estimated usage and outcome under a non-loopback egress prohibition. Its selected
test engine also refuses paid or carrier-control ports. This proves the catalog
library entry, not the production child process or a real demo engine/carrier.

True negative: suppressing the existing `input.telemetry?.onEvent?.(row)` call in
`src/execute.ts` produces `expected [] to deeply equal ArrayContaining` for
`user.transcript`, `speech`, `timing`, and `end` (1 failed). Restoring it gives
1 passed. Restoring F3's empty public index separately produces
`library.runFixtureCall is not a function`; that is export coverage, not the
behavioral proof. The manifest assertion separately detects the stale flag.

### Earlier D1 release compatibility note

D1's observability change from locale-sensitive sorting to contracts
`canonicalJson` changes persisted telemetry hash values when key ordering differs,
including mixed-case and non-ASCII payload keys. `telemetryEventHash` is stored in
`ovo_telemetry_events.event_hash`. Replaying an affected old event with the same
identity now increments the conflict count rather than the duplicate count;
the existing event and projections are retained. No hash backfill is included.
I1 must retain this release note when integrating D1. The current manifest change
does not change stored values.

### Pending shared work

- Draft calls still return `draft_snapshot_required`. A durable snapshot operation
  needs a ruling for `packages/plugin-storage/src/control-store.ts` and its
  `postgres/releases-repository.ts` and `sqlite/releases-repository.ts`
  implementations; any necessary schema change also needs explicit scope.
- Call creation and initial `fixture.request` insertion are separate today.
  Atomic creation needs `control-store.ts`, `postgres/calls-repository.ts` and
  `sqlite/calls-repository.ts`. Both stores bind repository methods automatically;
  no store wiring change is currently identified.
- Default agent confirmed-write fixtures fail closed pending playback-gated STT
  replay. Known frozen seams are `packages/contracts/src/net.ts` (template/step
  shape), `packages/plugin-kit/src/{fixture-net,fixture-socket}.ts`, and
  `packages/conformance/src/drivers/fixture-stt.ts`. Selected provider templates
  must then implement the same gate. A delayed-confirmation production regression
  remains required.
- `apps/worker/src/speech-cache-runtime.ts` still imports the implementation
  `StreamingMediaSpeechOutput` from plugin-voice. Moving that implementation into
  a shared kit needs a ruling; a contracts type cannot replace it.
- C2's negotiated PCM16 link/recording integration and selected carrier fixture
  encoders must land before claiming the complete demo matrix.

### Verification (Node 22)

All commands ran from the repository root, with
`PATH=/opt/homebrew/opt/node@22/bin:$PATH`.

- `node scripts/lint.mjs --only packages/fixture-calls`: exit 0, seven gates,
  zero scoped architecture baseline edges.
- `pnpm format:check`: exit 0.
- `node scripts/check-duplication.mjs`: exit 0, 780 source files and 59 existing
  baseline pairs.
- `node scripts/typecheck-scope.mjs packages/fixture-calls`: exit 0; two
  out-of-scope diagnostics were reported, not hidden.
- The exact focused command below: exit 0, 84 passed / 5 skipped. The five skips
  are the Postgres-gated observability tests; no Postgres run is claimed for this
  metadata/test-only checkpoint.
- `pnpm exec vitest run --reporter=dot`: exit 0, 1,196 passed / 139 skipped.
- `pnpm typecheck`: exit 2. Existing diagnostics are the returned disposer in
  `apps/api/src/release-simulation.ts:8` and missing `LiveCarrierMedia.format` in
  `apps/api/tests/real-llm-release.test.ts:124`.
- `pnpm build`: exit 1. All three application bundles built; console Turbopack
  refused the `apps/console/node_modules/next` symlink because its target lies
  outside the filesystem root. No alternate build is claimed.

```sh
pnpm exec vitest run packages/fixture-calls packages/plugin-observability apps/api/tests/test-calls.test.ts apps/api/tests/test-call-inspection-runtime.test.ts apps/api/tests/performance-route.test.ts apps/api/tests/script-simulation.test.ts apps/worker/tests/telemetry-runtime.test.ts apps/worker/tests/telemetry-stages.test.ts apps/worker/tests/production-session-lifecycle.test.ts apps/worker/tests/speech-cache-runtime.test.ts apps/api/tests/voice-engine-release.test.ts apps/worker/tests/production-engine-selection.test.ts apps/worker/tests/native-extension-pins.test.ts apps/worker/tests/session-recording.test.ts --reporter=dot
```
