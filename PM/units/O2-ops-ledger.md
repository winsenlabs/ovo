# Work unit O2-ops-ledger: Campaign driver for multi-contact CSV campaigns, pacing from carrier capabilities, unknown-as-non-terminal, inbound-route carrier selection API, ledger migration ledger, durable reservation expiry and sweeper

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [5, 15, 16, 19]

## Owned paths

- packages/plugin-operations/** (not src/twilio-handoff.ts)
- packages/plugin-ledger/**
- apps/worker/src/cost-runtime.ts
- apps/worker/src/cost-policy.ts
- apps/worker/src/cost-policy-support.ts
- apps/worker/src/cost-policy-types.ts
- apps/worker/src/cost-inference.ts
- apps/worker/tests/cost-runtime.test.ts
- apps/worker/tests/cost-policy.test.ts
- apps/api/src/routes/operations.ts
- apps/api/src/routes/operations-realtime.ts
- apps/api/src/routes/operations-inbound-routes.ts
- apps/api/src/routes/cost.ts
- apps/api/src/operations-plugin.ts
- apps/api/src/operations-runtime.ts
- apps/api/tests/cost.test.ts
- apps/api/tests/operations-runtime.test.ts
- scripts/baselines/pending/O2.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: fix these defects:

- #5: no driver admits multi-contact CSV campaigns; only POST /v1/calls calls campaigns.admit;
- #16: cost reservations are tracked in a worker memory map and leak on a crash;
- the operations parts of #15: the 5-minute admission-lease loss, and 'unknown' shown as terminal in the campaign view;
- the #19 sites in the ledger and operations.
  Also expose carrier selection for inbound routes, and remove the ledger → observability plugin edge. Read docs/architecture/plugin-platform.md (revision 2): section 4.4 (migrations and terminal outcomes), section 8.4 (pacing) and sections 10.2 (items 5–6), 10.3 and 10.4 (normative).

The dispatcher (unit O1, in parallel) runs every installed ctx.all('ovo.background-task') plugin, and its profile provides ovo.operations, ovo.cost-ledger, orchestration.store and the carrier controls (ovo.carrier.control, many). F3 created the stub files packages/plugin-operations/src/background-tasks.ts and packages/plugin-ledger/src/background-tasks.ts, which export plugins = [], with package exports and catalog entries (role dispatcher). Fill them. F3 also added plugin-operations migration 005, inbound-routes carrier columns and src/inbound-decision.ts (inboundDecisionFor), which C2 uses; keep inboundDecisionFor and InboundGatewayDecision stable. The orchestration store exposes admissionSnapshot() {readyIdleSlots, eligibleQueuedJobs, busySlots} (read-only).

A. Campaign driver: packages/plugin-operations/src/campaign-driver.ts (≤200 lines), exported via src/background-tasks.ts.

- v2 plugin: id '@winsendotai/ovo-plugin-operations/campaign-driver', kind 'infra', scope process, requires ['ovo.operations', 'orchestration.store', 'ovo.carrier.control'], provides ['ovo.background-task'], intervalMs 1000.
- tick():
  1. Inside a transaction, take pg_try_advisory_xact_lock(hashtext('ovo-campaign-driver:' || organizationId)). If it isn't acquired, return.
  2. For running campaigns, and scheduled campaigns whose schedule_at <= now(), compute headroom = min(max_concurrency − (admitted + dialing), readyIdleSlots − eligibleQueuedJobs, pacingTokens(carrier, binding, from_number)).
  3. Call the existing admission path (campaign-admission.ts admit) up to headroom times, taking contacts from the imported CSV list in order and honouring suppressions, timezone windows and retries as today's admit does.
  - Re-queue contacts whose admission lease expired (reclassify). The epoch bump on re-admit fences the old job.
- Pacing:
  - a token bucket refilled at the carrier's capabilities.pacing.cps, read from ctx.all('ovo.carrier.control') by the release's carrier id, and overridable by binding config.cps;
  - buckets are persisted in ovo_ops_pacing_buckets;
  - do NOT import carrier packages or session-host.
- Migration 006_campaign_pacing.sql:
  - ovo_ops_campaigns.max_concurrency INT NOT NULL DEFAULT 1 CHECK (max_concurrency BETWEEN 1 AND 1000);
  - new table ovo_ops_pacing_buckets(carrier_id, binding_id, from_number, tokens numeric, refilled_at timestamptz, PRIMARY KEY(carrier_id, binding_id, from_number));
  - attempt status 'superseded' (extend the CHECK).
  - Voicemail, busy, no-answer and completed-without-session stay status 'failed' with terminal_reason, per section 4.4. Add no CHECK values for them.
- Campaign API and presenters:
  - accept max_concurrency on create and patch;
  - an attempt with status 'unknown' is presented as 'reconciling' and is non-terminal: it doesn't count as completed, and a campaign can't transition to completed while any attempt is unknown;
  - 'superseded' is terminal but not failed;
  - POST /v1/calls keeps its direct admit.
- Inbound routes API (apps/api/src/routes/operations-inbound-routes.ts): accept, validate and return carrierPluginId and carrierBindingId per number. Validate that the binding exists, that its kind is 'carrier', and that its pluginId matches. Omitted values mean the env binding.

B. Durable reservations (packages/plugin-ledger)

- Add a migration ledger to runCostMigrations (ovo_cost_schema_migrations, advisory lock, versioned like plugin-operations/src/migrations.ts), recording 001 as applied when its tables exist, so migrations no longer re-run on every boot.
- Migration 002_reservation_expiry.sql: ovo_cost_reservations.holder text, expires_at timestamptz, session_id text, plus an index on (state, expires_at).
- reserveBeforeAdmission sets holder = '<workerId>:<jobId>' and expires_at = now() + maxCallSeconds + 300 s.
- ledger.extendReservation(id, holder, until): only the holder may extend.
- Reservation sweeper, exported via src/background-tasks.ts ('@winsendotai/ovo-plugin-ledger/reservation-sweeper', requires ['ovo.cost-ledger', 'orchestration.store'], every 30 s, SKIP LOCKED), for rows that are reserved AND expires_at < now():
  - job lease live → extend;
  - session route terminal → settle at the priced sum of recorded usage events, with the carrier meter from the route's connected_at and terminal_at;
  - otherwise → release.
  - Record a 'reservation.expired' ledger event.
- Remove the plugin-ledger → plugin-observability edge: import priceUsage and the pricing types from @winsendotai/ovo-contracts (F1 moved them).
- Worker cost runtime (apps/worker/src/cost-runtime.ts): a heartbeat every 60 s that extends each active reservation it holds. It is self-contained; do not modify renewal.ts or runner.ts (O1 owns them). The in-memory map becomes a cache only.
- Calls of kind 'test' (fixture test calls) never reserve and never touch budgets.
- Keep the HANDOFF rule: reservations are admission guards, not strict caps. Keep required meter coverage before live admission (F4 made it come from metersFor; keep that).

C. #19: in packages/plugin-ledger/src/money.ts:95, replace the localeCompare tie-break with code-unit comparison. In packages/plugin-operations/src/identity.ts:8, use canonicalJson from @winsendotai/ovo-contracts.

D. Size: routes/operations.ts (387 canonical lines), routes/cost.ts (337), handoff.ts (341), inbound-gateway.ts (367) and inbound.ts (333) are in the module-size baseline. Split any of them BEFORE adding lines. Measure with node scripts/lint.mjs --only.

TESTS:

- campaign-driver.test.ts (unit, fake store and fake carrier controls): the headroom is the min of the three terms; zero ready slots → nothing admitted; pacing tokens use the carrier's cps and the binding override; lock not acquired → no-op; expired admissions are re-queued.
- Postgres-gated tests following the existing skip pattern: the driver plus the advisory lock; migration 006; the ledger migration ledger; the reservation sweeper extends, settles and releases; migration 002.
- The worker cost-runtime heartbeat extends only held reservations (fake clock).
- The API presents campaigns with an unknown attempt as not completed, and 'superseded' as neutral. Inbound-route carrier validation.
- money.ts and identity.ts ordering tests with non-ASCII keys.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen: session-host, distribution, orchestration (O1), src/twilio-handoff.ts (I1 deletes it) and every package.json except those of packages you own.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/O2.json.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- plugin-operations and plugin-ledger must not import carrier, vendor or other plugin packages (the ledger → observability edge must go).
- Preserve the restore fences for campaigns, outboxes and inbound admissions.
- Modules ≤300 lines.
- No git commits.

## Acceptance

- The campaign driver BackgroundTask admits CSV contacts up to min(max_concurrency headroom, ready idle slots minus queued jobs, pacing tokens from the carrier capabilities) under an advisory lock, and admits nothing at zero ready slots.
- Migration 006 adds max_concurrency, the pacing buckets and the superseded attempt status. Campaigns with unknown attempts never show as completed.
- The ledger migration ledger exists, and migration 002 adds reservation holder, expiry and session. The worker heartbeat extends held reservations, and the sweeper extends, settles or releases expired ones with a ledger event. Test calls never reserve.
- The inbound routes API accepts and validates carrierPluginId and carrierBindingId.
- money.ts and identity.ts no longer use localeCompare, and plugin-ledger no longer imports plugin-observability.
- The unit tests pass, and the Postgres-gated tests are written and skip cleanly without Docker. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-operations packages/plugin-ledger apps/worker/src/cost-runtime.ts apps/worker/src/cost-policy.ts apps/api/src/routes/operations.ts apps/api/src/routes/operations-inbound-routes.ts apps/api/src/routes/cost.ts apps/api/src/operations-runtime.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-operations packages/plugin-ledger apps/worker/src/cost-runtime.ts apps/worker/src/cost-policy.ts apps/worker/src/cost-inference.ts apps/api/src/routes/operations.ts apps/api/src/routes/operations-inbound-routes.ts apps/api/src/routes/cost.ts apps/api/src/operations-runtime.ts apps/api/src/operations-plugin.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-operations packages/plugin-ledger apps/worker/tests/cost-runtime.test.ts apps/worker/tests/cost-policy.test.ts apps/api/tests/cost.test.ts apps/api/tests/operations-runtime.test.ts --reporter=dot`
