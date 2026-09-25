# Production evaluation evidence

Date: 2026-09-20

## Implemented scope

`@winsendotai/ovo-plugin-evaluations` is a PostgreSQL-backed, asynchronous evaluation service for the self-hosted single-organization deployment. It retains `workspaceId` only as the existing ownership namespace.

- Versioned migrations own only the `ovo_eval_*` prefix and use a checksum plus PostgreSQL advisory transaction lock.
- Dataset metadata supports create/read/list/update/archive. Imports validate strict bounded case structures, reject duplicate case IDs, cap a version at 1,000 cases, compute a canonical SHA-256 fingerprint, and append an immutable version. Retrying an identical import returns the existing version.
- Evaluation runs retain dataset ID/version/fingerprint, release ID/fingerprint, executor kind, and fixture/provider-binding version. Case results retain the run and case identity.
- Run creation is idempotent and rejects reuse of an idempotency key for different immutable inputs.
- Workers use `FOR UPDATE SKIP LOCKED`, lease expiry, monotonically increasing owner epochs, heartbeats, bounded attempts, and exact owner/epoch checks for results and terminal transitions. Expired claims can be retried; exhausted work fails rather than running forever.
- Case-result inserts are collision checked and replay safe. A reclaimed job skips already persisted case IDs.
- Queued cancellation is immediately terminal. Running cancellation changes the durable state to `cancelling`; the worker checks ownership before each case, performs no later case effect, and then settles `cancelled` with persisted partial results.
- Comparisons require the same immutable dataset version and report regressions, fixes, unchanged failures, and separate pass/fail totals.
- All external collections use bounded pages with a default of 50 and maximum of 100.

## Safe executable default

The built-in executor is explicitly `fixture`. It constructs the real announcement, FAQ/tool, context, agent, and script behaviors from `@winsendotai/ovo-behaviors`. Tool cases pass through the real shared `createExecutionService` from `@winsendotai/ovo-plugin-tools`, including schema, allow-list, confirmation, durable-intent, and unknown-write handling. Its inference, connector, speech, and operation-store ports are transparent in-memory fixtures.

The fixture executor has no carrier, network, secret, or production business-system port. Therefore a default replay/evaluation cannot dial a caller or mutate a business system.

Provider execution is never silently substituted for fixture execution. The API helper `createProviderEvaluationRuntime(...)` returns no provider lane unless `OVO_PROVIDER_EVALUATIONS_ENABLED` is exactly `true`. When enabled, an admin creates a durable PostgreSQL authorization through `POST /v1/evaluation-provider-authorizations`; the server derives and pins the workspace, release fingerprint, inference binding version, provider, model, release-owned budget, and maximum reservation rather than accepting mutable provider details from the client. Authorizations are bounded-listable and explicitly revocable. A provider run names an active authorization ID, and the server derives its binding version from that record. The ledger-backed gate reloads the immutable release, verifies every authorization pin and the release reservation against the authorized maximum, validates the workspace-owned budget and immutable inference price-card/FX references, and reserves the release's configured amount before the run is created. Admission holds a shared authorization lock across reservation so a revoke that commits first cannot be followed by a new reservation. The executor rechecks active authorization before provider work. Without the exact installation flag, authorization routes return an explicit 503 and provider runs remain unavailable.

The optional provider executor uses real behavior implementations but retains the fixture-only connector, speech, and operation store. A model-selected read or write therefore reaches only dataset-provided tool results/failures and cannot dial a carrier or mutate a business system. Provider usage is normalized through the same shared ledger utility as live worker inference: detailed uncached/cache-read/cache-write input units are disjoint, output is charged once, aggregate input is used only through an explicitly configured fallback card, and missing/inconsistent request/model/counter evidence fails closed. Every native request is written immediately to the production cost ledger with stable request provenance; case results persist binding, provider, model, request IDs, and reported/estimated/unknown usage evidence.

Provider runs have one durable attempt to avoid replaying a paid request after lease loss. Each case has an installation-bounded deadline, output-token bound, and provider-request bound. The executor checks the ledger total before and after model steps and blocks further requests when the authorized reservation is exhausted. Known usage settles the reservation before a successful run transition. If a request outcome or usage is unknown, later provider requests stop and the reservation remains held for operator reconciliation rather than being released against an unmeasured charge.

## Deterministic corpus

The package includes and executes 120 meaningful cases, split into four data modules with exactly 30 cases per mode:

- Announcement: schema-bound variables, Indian currency formatting, ISO date formatting, missing fields, and undeclared fields.
- FAQ: questions and aliases, negation/no-match/ambiguous fallback, approved read-only tool lookups, and text/DTMF/script detours and terminal behavior.
- Context: grounded transparent model replies, empty-response uncertainty protocol, cancellation without late narration, and context-budget rejection.
- Agent: text replies, shared-execution reads, playback-gated write confirmation, caller cancellation, unknown write outcomes without blind retry, unknown-tool rejection, turn cancellation, and the maximum tool-loop bound.

The offline regression executes all 120 cases through those real behavior/shared-execution components; it does not mark imported JSON rows passed without execution.

## API integration surface

`registerEvaluationDatasetRoutes({ app, evaluations, store, fixtureBindingVersion, requireRole })` registers:

- `/v1/evaluation-datasets` create/list and `/:datasetId` read/update/archive
- `/:datasetId/versions` import/list, `/:version` read, and `/:version/cases` paginated cases
- `/v1/evaluation-runs` create/list, `/:runId` detail, `/:runId/cases` paginated results, `/:runId/cancel`, and `/compare`

The registrar derives the release fingerprint from the authenticated workspace's immutable release, injects the server fixture-binding version, enforces existing viewer/editor/admin roles, audits mutations, and returns an explicit 503 when the evaluation service is not configured. It does not modify the legacy single-call evaluation or simulation routes.

`createEvaluationApiRuntime({ databaseUrl, store, providerEvaluations: { ledger, secrets }, ...bounds })` migrates one bounded evaluation pool and always runs the safe fixture executor. When the installation flag is enabled, that same pool owns the durable authorization registry and the runtime adds the ledger gate and provider executor beside the fixture executor. Full immutable release snapshots retain workspace, agent, provider bindings, configuration, and fingerprint. `EVALUATION_FIXTURE_BINDING_VERSION` remains exported for route registration. The background loop has one active job, a bounded number of jobs before yielding, a bounded idle poll, lease heartbeats, an abortable shutdown, and closes only its own PostgreSQL pool. Configuration bounds are validated before pool allocation; initialization failures close a newly allocated pool. Main bootstrap remains responsible for explicit plugin registration and dependency injection.

## Verification and limitations

- Offline corpus: 120/120 behavior cases executed successfully.
- Local mock-provider tests cover the exact installation default-off flag, immutable budget/binding admission, fixture-only model-selected tools, native usage and case provenance, ledger spend cutoff, deadline cancellation, and unknown-usage reservation retention.
- PostgreSQL tests cover migration prefix/checksum replay, immutable imports, bounded versions, validation, concurrent claim single ownership, epochs, heartbeat rejection, bounded retry, result deduplication, cancellation, baseline comparison, provider authorization idempotency/pagination/workspace isolation/revocation fencing, one-attempt paid execution, and provider case provenance.
- No carrier, paid provider, customer system, or live production call was used.
- These tests establish deterministic product behavior and durable job mechanics. They do not certify human listening quality, real provider quality, load targets, security penetration testing, or full W20 launch acceptance.
