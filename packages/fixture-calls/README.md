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

### Current integration status — 2026-09-27

The prior pending-scope and F4-engine results below are historical. The checker
approved both storage backends' fixture snapshot/admission implementation and
allocated control migration **006 to D1**. M1 must rename its paused migration
to 007 on resumption. The frozen `ControlStore` interface remains unchanged;
D1 uses a local structural capability through existing repository binding.

Draft snapshots are private release rows with purpose `fixture-snapshot`. They
neither appear in published release reads nor consume the published draft slot.
The snapshot, test call and initial request fingerprint commit together. Runtime
admission coalesces identical local requests before reserving capacity; the
storage transaction remains the arbiter across processes. Its successful result
returns the immutable release, eliminating the postcommit lookup failure window.

E2 is now integrated normally. The real native confirmed-write fixture and the
native worker cache tests run with normal imports, without a candidate overlay.
The complete vendor demo matrix still depends on C1/C3/C4's selected fixture
encoders; these paused carrier units are not claimed as verified by D1's
conformance-carrier proof. The current durable evidence and exact gate commands
are in [the D1 unit report](../../../PM/units/D1-demo-backend.md#builder-checkpoint--2026-09-27-durable-draft-admission).

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

### Follow-up: owned type fix and local dependency repair

The D1-owned `simulationUsage` callback in `apps/api/src/release-simulation.ts`
now uses a block body so registration returns `void`. Previously the scoped
typecheck reported TS2769 because the expression returned `ctx.provide`'s
disposer. Its usage service registration is unchanged. The existing simulation
route tests exercise the registration; no new runtime test is counted for this
type correction.

The build failure was an inherited worktree dependency-layout defect:
`node_modules/.pnpm` pointed at the foundation checkout, and several dependency
scope directories did too. Turbopack correctly refused those paths outside its
root. Local APFS copies replaced those links; workspace package links now point
at this checkout. A subsequent audit found zero external links at the workspace
dependency scope/package level. No tracked configuration, manifest or lockfile
was changed. `CI=true pnpm install --frozen-lockfile --offline --ignore-scripts`
then exited 0 across all 51 workspace projects. Lifecycle scripts were disabled
to prevent dependency repair from triggering vendor downloads.

After repair, the unchanged **`pnpm build` exits 0**, including all three
application bundles and the console. This supersedes the earlier build failure.
`pnpm exec vitest run packages/fixture-calls apps/api/tests/script-simulation.test.ts --reporter=dot`
passes 23 tests. Scoped lint and scoped typecheck including
`apps/api/src/release-simulation.ts` pass. The frozen
`apps/api/tests/real-llm-release.test.ts` missing-format fixture remains a separate
checker decision; the production carrier format requirement stays strict.
The refreshed normal default suite also exits 0 (1,196 passed / 139 skipped).
Full `pnpm typecheck` still exits 2, now with only the missing-format fixture's
TS2741 diagnostic; the owned simulation diagnostic is gone.

## Batch A resumption — 2026-09-26

Rebased onto foundation `4f17b64`. The approved shared test change adds
`MULAW_8K` to the real-LLM release fixture's carrier media without weakening any
assertion. No frozen contract or storage implementation changed.

The production cache-host integration runs `createV2SpeechCachePlugin` through
real `compose`. Cached and streaming branches now both prefetch within the
configured byte bound, use the negotiated μ-law or PCM16 format, and share one
ordered send queue. The queue releases after bytes and mark are sent, while the
receipt may remain pending. Interruption cancels every queued/active segment,
waits for a blocked write to return, clears the carrier, and only then permits
new-epoch sends. A flushed mark cannot upgrade interrupted speech. Missing marks
complete with estimated evidence; explicitly accepted carrier-processed marks
retain their source. This is host-output proof; the selected native-engine demo
matrix still needs E2/C2 integration.

True negatives against the previous production adapter (same new assertions):
streaming `prepare()` produced 0 chunks instead of 2; PCM16 cache identity received
`mulaw/8000` instead of `pcm_s16le/16000`; weak confirmed playback lacked
`evidenceSource: carrier-processed`. The cancellation mutation that merely drops
the buffered audio without aborting epoch state emits extra audio and
`mark:late:3` / `mark:queued:3` after interruption. Restoring the implementation
passes all eight legacy/v2 cache cases across both formats.

The child-process runtime now handles a failed event write immediately and
cleans up if its initial IPC send throws. The old runtime left `activeCount=1`
and returned `pending` instead of `audit write refused`, also producing an
unhandled rejection; a synchronous IPC throw left child kill count at 0 instead
of 1. A separate mutation that bypasses the successful event-write barrier
settles the child result before its write, violating the expected pending state.

Two durable admission defects remain pending the storage-scope decision. A real
SQLite store with the production route and `app.inject` returns
`422 draft_snapshot_required` for `useDraft:true`; a deliberately delayed first
`fixture.request` write makes an identical concurrent key return
`409 idempotency_conflict` instead of 202. The proof uses a method wrapper at the
public store boundary, never private database access. No polling workaround or
publication of drafts as ordinary releases is included. Proposed storage methods
can be consumed via D1-local structural types and the existing dynamic repository
binding, leaving frozen `ControlStore` unchanged. That historical 007 proposal is superseded by the 2026-09-27 checker ruling:
D1 uses 006; M1 renumbers its paused migration to 007 when it resumes.

Independent cache review found three further transport defects, now covered by
`tests/cache-transport.test.ts` through real host-plugin composition. With the
normal prefetch budget, a successful small-frame synthesis was followed by an
80,000-byte cache hit/shared result that threw `audio frame exceeds limit`;
these are separate hit and shared-result cases for μ-law and PCM16. Every send
is now capped independently of prefetch capacity, with split PCM samples joined
without changing bytes. A split-sample negative previously sent one odd byte.
A carrier write failure previously left the dynamic TTS producer's signal live
(`false` instead of `true`), and a previously prepared segment with an already
aborted play signal returned `completed` rather than `interrupted`. The eight
transport cases now pass, including an additional race where the play signal aborts during the awaited prepare step; that race previously completed
and sent audio instead of returning interrupted.
The shared-cache waiter survival regression remains green: stopping one consumer
does not cancel a producer still needed by another consumer.

The recording-disabled API regression now passes a valid child recording payload
into the production route while using a real local recording archive. It proves
zero persisted recordings and no recording entry in `fixture.result`. Forcing the
route to persist the payload produces two actual archive rows instead of `[]`.
This supplements the library's recording-disabled check that observes zero
capture opens and writes; neither proof is counted as a new real-carrier demo.

## Replay and callback checkpoint — 2026-09-26

The current evidence, exact commands, true negatives and contract gaps are recorded
in [the D1 unit report](../../../PM/units/D1-demo-backend.md#builder-checkpoint--2026-09-26-fixture-replay-and-persistence-failures).
The replay/default-script command passes 21 tests; callback/run/child passes 29;
full-package scoped typecheck passes. The normal native-engine integration still
fails on D1's F4 engine and passes only in the separately disclosed, reverted E2
candidate diagnostic. Storage scope and E2/C2 integration remain open. D1 is WIP.

Normal current suite: **1,358 passed / 139 skipped / 1 failed** (native confirmation
`expected -1 to be greater than 16`). Scoped lint/full format: **0 / 0**;
full typecheck and standalone duplication: **0 / 0**. Independent callback/child
review: **12/12 passed**, no concrete blocker. Final Postgres/full green bar is
still outstanding after integration and approved storage work.

## Durable admission checkpoint — 2026-09-27

The approved SQLite/Postgres snapshots and atomic call/fingerprint admission are
implemented with migration 006 and local structural storage types. Normal native
E2 fixture execution now passes; the prior red and candidate-only counts above
are historical. The latest scoped storage/API/child run is **49/49** with the
loopback disposable Postgres container. Independent storage/API review reproduced
**22/22**, including refusal of a same-timestamp binding identity change and
acceptance of a legacy null-identity binding.

Worker cache/native tests pass **21/21**, including three direct tests for the
new fixed-capacity byte ring. This owned implementation removes the cross-unit
prefetch duplication without a frozen-kit edit or baseline. Actual native worker
sessions reuse synthesis in both 8k and 16k formats; selected paused vendor
carriers still require their own integrated fixture encoders. See the current
[unit report](../../../PM/units/D1-demo-backend.md#builder-checkpoint--2026-09-27-durable-draft-admission)
for exact commands, independent measures, every mutation failure, migration
allocation and I1 carry-forwards. Final full-repository checks and Built status
remain the root builder's next step.

## Optional illustrative demo prices

Preview without requests:

```sh
node scripts/seed-demo-price-cards.mjs
```

To write to an explicitly chosen local demo API, first set its admin token in
`OVO_ADMIN_TOKEN`, then run manually:

```sh
node scripts/seed-demo-price-cards.mjs --apply --api-url http://127.0.0.1:4000
```

The API must have its cost ledger configured. Every card's version and persisted
provenance say **ILLUSTRATIVE — NOT A QUOTE**. All values are invented (100 paise
per 1000 native units), not vendor pricing. The script writes only demo price
cards, never release selections or budgets. To use one for fixture estimates,
select its printed id/version in the release's `costPolicy.priceCards` for the
matching meter key; otherwise the meter remains explicitly unpriced. A repeat
is idempotent, while a conflicting existing immutable version fails rather than
being overwritten. Partial writes can remain if the API refuses a later card.

This is an approved new-script ownership exception inherited by I1. No existing
script, lint/check/CI step or automatic setup invokes it. The permanent test only
checks pure preview data; the actual CLI/API/Postgres proof is a separately run
manual probe documented in the D1 unit report.
