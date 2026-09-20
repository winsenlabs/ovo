# Production cost ledger evidence

## Implemented service

`@winsendotai/ovo-plugin-ledger` is a private process-scope Cordis plugin. It provides:

- `ovo.cost-ledger`: `CostLedgerService`, backed by PostgreSQL through `PostgresCostLedger`;
- `ovo.cost-scenario`: the explicit `InrScenarioService`; and
- direct package exports for API and worker composition without constructing provider clients.

The package is designed for one self-hosted organization. `workspaceId` remains only as an existing compatibility/ownership namespace. The package contains no tenant provisioning, organization switching, RLS, SaaS IAM, or customer billing portal.

## PostgreSQL ownership and migrations

The versioned migration owns only `ovo_cost_*` objects. It creates immutable price-card and FX catalogs, native usage, priced charges, append-only invoice corrections, allocation batches, budgets, reservations, late adjustments, indexes, and `ovo_cost_schema_migrations`.

Migration execution uses a transaction and a PostgreSQL advisory lock. Catalog rows are immutable by `(id, version)`: an exact replay is idempotent and different content is rejected. Usage identity is protected by both an idempotency key and source-event provenance. Provider invoice lines have the same source-level uniqueness in addition to caller idempotency.

## Exact pricing semantics

Provider native-unit pricing reuses the existing, tested `priceUsage` helper from `@winsendotai/ovo-plugin-observability`. The ledger's FX conversion, allocation, signed corrections and scenario calculations extend that approach with `BigInt` rational arithmetic. Application code never converts money through JavaScript `number`. PostgreSQL stores paise and provider minor-unit totals as exact `numeric(60,0)` values.

Each native usage append records:

- provider-native quantity and unit;
- provider and optional provider request ID;
- source event type and ID;
- session, call and attempt provenance;
- normal, failed-attempt, transfer, retry, startup or idle activity;
- cache generation/hit disposition; and
- exact immutable price-card and, when needed, FX versions.

There is no fallback price card or implicit FX rate. Non-INR pricing fails unless a matching immutable conversion to INR is supplied. One usage row rounds once to provider minor units and then once at the explicit FX boundary.

Provider reconciliation is append-only. An invoice line supplies its actual provider-currency amount and explicit FX version when required. The ledger calculates a signed correction from the current effective amount, records that delta idempotently and moves the usage state from `estimated` to `reconciled`. Later invoice corrections can raise or lower the effective total without rewriting history.

## Allocation and cache accounting

Allocation batches snapshot the effective charge and assign every paise through deterministic largest-remainder weighting. Targets retain the basis and explicit failed-attempt, transfer, retry, worker-shared or shared-service reason. Allocation totals are tested to equal the source charge exactly.

The ledger rejects a `tts-generation` usage row marked as a cache hit. A generation source event can therefore be billed only once through idempotent provenance, while each carrier/media source event remains independently billable on a hit. Session summaries count the generation once and every playback charge; they never infer that cached audio makes carrier time free.

## Budget behavior

Budget policies contain an INR paise limit and an explicit bounded admission-overspend allowance. Reservation admission takes a PostgreSQL row lock and evaluates `spent + reserved + request` against that ceiling. Concurrent attempts cannot each observe stale capacity.

Reservation settlement always records the actual incurred amount, even when it exceeds the reservation or configured limit. Release returns only unused reserved capacity. Active calls are not terminated or hidden merely because the threshold is crossed; subsequent admission is blocked by the updated snapshot.

Late provider bills and corrections use idempotent signed budget adjustments under the same row lock. They may put recorded spend above both the normal limit and admission ceiling. The returned snapshot exposes `overLimit`; the implementation deliberately does not promise a hard cap for usage that was already incurred but not yet reported.

## Explicit ₹10 / two-minute scenario service

`calculateInrScenario` requires callers to provide all inputs:

- target revenue in paise and duration in seconds;
- explicit telephony, tax, speech-generation, carrier/media and idle components;
- a textual assumption for every component;
- immutable FX identity/rate for every non-INR amount;
- generated and cache-hit units;
- affirmative generation-billed-once and carrier-media-still-billed semantics; and
- a written margin scope.

The service fabricates no provider prices, taxes, FX, cache savings, idle allocation or margin scope. Its fixture calculates a ₹10 / 120-second scenario and returns component paise, total cost, signed margin and whether the explicit target is met.

## Management API boundary

`apps/api/src/routes/cost.ts` exports an injected Fastify registrar. It does not construct a second ledger or read database internals. The registrar provides:

- admin publication and viewer bounded reads for immutable price cards and FX versions;
- admin-only, workspace-scoped budget policy create/update and bounded reads;
- viewer scenario calculation through the real `calculateInrScenario` function;
- viewer call-cost reads only after `ControlStore.getCall(workspaceId, callId)` confirms the call belongs to the authenticated compatibility namespace; and
- admin invoice reconciliation with strict provenance, idempotency, exact string money and the authenticated workspace injected server-side.

All request objects are strict and bounded. Money and native quantities are accepted only as canonical decimal or integer strings, never JSON numbers. Catalog and budget pages are capped at 100 rows and use opaque keyset cursors. Mutation audit entries retain identities and version/invoice provenance but no provider credentials. When the process ledger is not injected, ledger-backed routes return an explicit `503 cost_ledger_unavailable` response rather than fabricated empty data.

There is intentionally no public reservation endpoint: accepting a caller-selected reservation amount would bypass the internal admission estimate and resource policy. Worker admission owns reserve/settle/release. Native provider usage ingestion likewise remains an internal worker/provider service boundary; authenticated users cannot post arbitrary “confirmed” usage.

## Worker admission and metering controller

`apps/worker/src/cost-policy.ts` exports `WorkerCostPolicyController` and `createWorkerCostPolicyAttachment`. The attachment is deliberately narrow enough for the durable runner/session factory to install without duplicating ledger policy:

- `reserveBeforeAdmission()` validates budget ownership, every immutable price-card version and required FX version, then uses the session ID as the durable reservation identity before dialing;
- admission derives required coverage from release behavior instead of trusting the policy's own key list: Twilio carrier seconds and OpenAI TTS characters are always required, Deepgram STT audio seconds are required when the release accepts input, and context/agent modes require OpenAI output plus either every disjoint input counter or an explicit aggregate-input estimate;
- `providerUsage` is a real `ProviderUsageSink` bridge for the existing Deepgram/OpenAI adapters, not a second synthetic usage format;
- `inferenceUsage` consumes the AI SDK callback once per provider request and validates the immutable provider/model binding before writing any token units;
- complete inference detail is charged as disjoint uncached-input, cache-read, cache-write and aggregate-output units. It never adds aggregate input tokens on top of those subsets;
- incomplete input detail can use `provider.inference.input_tokens` only when that explicit fallback meter exists, and the resulting source/evidence is marked estimated. Missing, inconsistent or mismatched evidence remains explicitly unknown instead of becoming zero or fabricated uncached usage;
- the serialized usage queue is bounded, requires stable provider request IDs for known provider units and requests termination instead of silently dropping an overflow or failed ledger write;
- `recordElapsed()` records carrier/media elapsed estimates separately with caller-supplied durable event IDs;
- `recordCacheGeneration()` records generation exactly once and ignores cache-hit generation units, while elapsed carrier/media entries remain billable;
- `beginActiveCall()` enforces the immutable maximum duration, while priced session totals request termination at the reservation threshold; and
- terminal paths are explicit: `finalizeKnownUsage()` settles only the current ledger summary and returns missing-provider/late-billing caveats, while `releaseBeforeStart()` is rejected after any start or metering evidence.

The attachment requires the durable session start timestamp and stable provider request/event IDs, so a redelivered event reconstructs the same ledger fingerprint instead of silently producing a second charge. The lifecycle integration order is: load immutable release policy → reserve before dial → attach the exported provider sink → start the duration timer only after carrier acceptance → stop/dispose providers so their final usage has arrived → finalize known usage → perform the existing terminal route/call release. Any pre-dial failure calls `releaseBeforeStart()`.

Unknown or omitted provider usage is never converted to zero usage. It is retained as a missing-meter caveat; inference finalization additionally returns reported/estimated/unknown step counts and bounded reason categories. The known amount is settled, and later authoritative provider invoice lines remain admin-only through `/v1/cost/reconciliation`. If such a correction arrives after a session reservation was settled, reconciliation appends the signed correction and atomically applies the same delta to that settled budget. The worker has no invoice-import or reconciliation capability.

## Executed evidence

A fresh disposable `postgres:17.6-alpine` database was created solely for this package, migrated from empty state, exercised, and removed. The ledger suite includes 29 tests: 16 exact arithmetic/scenario cases, one plugin-contract case and 12 PostgreSQL integration cases.

The cost API registrar adds six isolated injection cases plus one real-PostgreSQL case. They verify role enforcement, strict schemas, string-only money, bounded paging, explicit unavailable behavior, audited mutations, authenticated call ownership, server-injected reconciliation namespace, migration-backed catalog reads and scoped budget create/update/read behavior.

Eight worker controller/normalization tests pass, including six against fresh real PostgreSQL. They verify low-balance admission produces no usage/provider effect, duplicate provider usage is billed once, cache hits do not repeat generation units, elapsed carrier usage remains separate, duration and queue bounds request termination, settled budgets receive later invoice deltas, and omitted provider units remain missing rather than becoming zero. The inference loopback submits two model steps and duplicate deliveries: exactly two provider request identities remain, cache-read tokens use their lower immutable card, and no aggregate-input row double-counts detailed input categories. Unit cases cover explicit aggregate-estimate fallback and unknown inconsistent detail.

Verified behavior includes:

- very large and fractional native-unit arithmetic without floating-point money;
- positive and negative half-up rounding and rational FX;
- exact weighted allocation with deterministic remainder handling;
- immutable catalogs and source/idempotency conflicts;
- ten concurrent identical usage appends producing one native row;
- generation-once plus repeated carrier playback charging for cache hits;
- positive and negative idempotent provider-invoice deltas;
- failed-attempt, transfer and retry allocations;
- ten concurrent admissions with only the bounded number accepted;
- settlement above reservation/limit, unused release and blocked new admission; and
- idempotent late bills remaining visible above the configured limit.

Commands executed on 2026-09-20:

```text
OVO_TEST_POSTGRES_URL=postgres://... pnpm exec vitest run packages/plugin-ledger/tests
  2 files passed, 29 tests passed

LEDGER_TEST_DATABASE_URL=postgres://... pnpm exec vitest run apps/api/tests/cost.test.ts
  1 file passed, 7 tests passed

OVO_TEST_POSTGRES_URL=postgres://... pnpm exec vitest run apps/worker/tests/cost-policy.test.ts
  1 file passed, 8 tests passed

pnpm exec tsc --ignoreConfig --noEmit --target ES2024 --module ESNext \
  --moduleResolution Bundler --strict --skipLibCheck \
  --allowImportingTsExtensions --types node <plugin-ledger TypeScript files>
  passed
```

## Boundaries

- Tests use synthetic price publications, usage, invoice lines and a local PostgreSQL database. No paid provider request or live provider invoice was used.
- The API registrar and PostgreSQL integration are implemented and tested. Production worker composition reserves before dial, tees STT/TTS and inference usage using the exact immutable OpenAI model binding, starts elapsed metering after acceptance, and finalizes after session/provider disposal. No live carrier/provider certification is claimed.
- This ledger records exact supplied usage and provenance. It cannot make an unreported provider charge visible before a provider adapter or reconciliation importer submits it.
- Price/FX publication approval, provider invoice ingestion scheduling and operational alert delivery remain deployment/integration responsibilities; the ledger supplies their durable idempotent write boundary.
