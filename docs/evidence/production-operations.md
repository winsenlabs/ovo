# Production operations implementation evidence

Date: 2026-09-20  
Scope: W16 single-organization campaign, inbound-admission, suppression, quota, outbox and handoff operations.  
Status: **operations persistence, services, signed inbound protocol handler and injectable management API registrar implemented and verified locally; paid-provider and executable bootstrap registration are not claimed here.**

## Deployment model

This package is for a self-hosted, single-tenant installation serving one organization. `organizationId` is fixed when `PostgresOperationsService` is constructed; it is a storage namespace and not a caller-selected tenant boundary. Service methods never accept a tenant/workspace selector. Every owned table and migration ledger is namespaced `ovo_ops_`.

`createOperationsPlugin({ organizationId, connectionString, handoffProvider, config })` installs the real PostgreSQL implementation as `ovo.operations`. `config.permittedFromNumbers` is the normalized allowlist used by the API; an empty list permits no campaign or direct-call caller number. `config.liveEnabled` defaults to false and must be set explicitly before the HTTP API admits live calls. A caller with an existing pool can construct `PostgresOperationsService` directly. Exported JSON schemas cover campaign configuration, inbound overflow policy and handoff policy; exported Zod schemas are the strict management API boundary.

## Implemented invariants

### Campaign ingestion and scheduling

- RFC-style quoted CSV preview validates unique headers, configured mappings, E.164 phone numbers, variable names and duplicate phone numbers. Input is capped at 2 MiB and previews/import batches are capped at 100 records.
- CSV export pages reject more than 100 rows and neutralize cells whose first effective character is `=`, `+`, `-` or `@`, including leading control/space characters, before CSV quoting.
- Schedules require `YYYY-MM-DDTHH:mm` plus an explicit IANA timezone. The resolver checks a bounded ±15-hour window and rejects invalid zones, spring-forward nonexistent minutes and fall-back ambiguous minutes rather than choosing an offset silently.
- Campaign configuration persists the pinned agent release, caller number, explicit `continue`/`request_end` active-call policy, per-number attempt limit, total attempt quota, local-day attempt quota, schedule instant and timezone.
- Campaign creation requires an operation ID and stores a canonical input digest. Concurrent repeats return the original campaign; reusing an operation ID with different input fails as a collision.

### Admission, pause/cancel and suppression

- PostgreSQL serializes campaign admission, authorization and pause/resume/cancel on the campaign row. Each accepted admission increments a persisted owner epoch and records the campaign version used by that lease.
- Admission creates `campaign.dial.candidate` in `ovo_ops_outbox` in the same transaction as the contact lease. The outbox uses stable deduplication keys; dispatch is bounded to 100 and targets the existing orchestration job enqueue contract through `CampaignJobPort`.
- Pause, resume and cancel atomically increment the campaign version. A candidate carrying an older campaign version/owner epoch cannot authorize a dial. Resume reclaims stale admitted rows in bounded batches. Cancelled campaign counters derive effective cancelled contacts from persisted campaign/contact state without an unbounded rewrite.
- The worker's mandatory `authorizeDial(contactId, admissionOwnerId, admissionEpoch)` call locks campaign and contact state immediately before dial. It rechecks status/version, lease ownership, suppression, per-number attempts, total quota and timezone-local daily quota. It creates one persisted attempt/request ID and is idempotent for the same live admission capability.
- Suppression is an organization-wide E.164 primary-key list with add/update, remove and cursor-bounded list operations. Adding suppression after queue dispatch but before authorization blocks the attempt; no attempt row is created.
- Attempt callbacks have event-ID deduplication, terminal-state guards and progress-order guards. Counters aggregate persisted contact and attempt states instead of mutable cache counters. Unknown outcomes do not redrive; a connected attempt is not eligible for automatic redrive.

### Inbound admission

- Called-number routes are persisted management configuration. Each route pins one immutable release UUID, fixed validated release variables, enabled state and optimistic version. Admission snapshots the release, variables and route version, so a later route edit cannot change an accepted call.
- `createTwilioInboundWebhookHandler` validates a bounded form-encoded `POST /twilio/inbound` against the exact configured public HTTPS URL, Twilio account SID and HMAC signature. Invalid signatures never reach durable admission. Its per-call media route token is HMAC-derived from an installation secret; PostgreSQL stores only the SHA-256 hash.
- A call is accepted only after PostgreSQL reserves a slot that is marked ready, has a worker WebSocket endpoint, is unreserved and remains protected past the handshake deadline. Capacity updates carry a monotonically increasing generation; a newer worker generation clears stale reservation ownership while an older update cannot revive a slot.
- In one PostgreSQL transaction, accepted ingress snapshots the called-number route, reserves capacity, creates an already-owned `ovo_jobs` row with `kind: inbound_call`, creates an accepted `ovo_session_routes` row bound to the incoming Twilio CallSid, creates the operations call binding and persists the admission. It does not enqueue outbound work, call `beginDial`, or invoke a carrier create-call API.
- Duplicate CallSids return the original job/session/admission identity and deterministic route token. The existing media gateway then claims the one-time session route and hands the incoming media stream only to the preassigned worker/generation.
- The overflow policy is a versioned PostgreSQL singleton. Carrier ingress implements `busy` as `<Reject reason="busy">` and `human` as an inbound `<Dial><Number>` transfer.
- `wait` persists the immutable route snapshot and deadline, then returns bounded Twilio `<Pause>` plus an absolute `<Redirect method="POST">` poll URL. Every poll is subject to the normal exact Twilio signature/account checks. The same CallSid is transaction-locked: it remains one waiting admission, transitions once to the accepted inbound job/session when fresh protected capacity appears, or atomically becomes `wait_expired` and receives an explicit `<Say>` plus `<Hangup>` fallback.
- `callback` first returns a signed Twilio `<Gather>` action and creates no outbound work. Only authenticated DTMF `1` advances it. Consent transactionally creates one one-contact callback campaign and one `campaign.dial.candidate` outbox record using the snapshotted release/variables, incoming caller as recipient and called number as caller ID. Retries return the original campaign/contact/job IDs. The normal dispatcher and worker path still calls `authorizeDial` immediately before carrier access, rechecking suppression and the campaign's one-attempt total/daily/per-number quotas. A number already suppressed produces a persisted suppressed contact and no outbox record.
- Callback admission fails closed as `callback_outbound_not_configured` unless live dialing is explicitly enabled and the called number is in `permittedFromNumbers`. The HTTP webhook never invokes a carrier dial directly.
- Verified terminal carrier status releases the matching capacity reservation and terminalizes its call binding. Ready protected capacity and cursor-bounded decision history remain observable.

### Handoff and fallback

- Handoff requests persist `awaiting_confirmation` when confirmation is required. Decline becomes `cancelled`; only an accepted confirmation can become provider-ready.
- Handoff creation has the same operation-ID/input-digest collision guard, so a retried API command cannot create two provider requests.
- Provider submission uses a stable request ID and a three-attempt ceiling. Only `{ kind: 'confirmed', receiptId }` from `HandoffProviderPort.request` can set `confirmed`.
- Transport exceptions and uncertain provider results persist `unknown`; execute/retry calls do not submit again. Reconciliation can confirm, remain pending, reject, or certify `not_found`. Only provider-certified `not_found` makes an explicit retry eligible.
- A definitive provider rejection invokes the configured fallback through `HandoffProviderPort.fallback`. Only a fallback receipt sets `fallback_completed`; rejection and uncertainty remain `fallback_failed`/`fallback_unknown`. Unknown fallback outcomes cannot retry until reconciliation certifies `not_found`; explicit fallback retry is capped at three attempts. A fallback receipt is never reported as a successful transfer.
- Public handoff input contains the internal control-plane call ID only. `OperationsCallRegistry` resolves it to a carrier call ID that a worker previously bound with an authoritative orchestration/provider receipt and pinned release ID. The registrar verifies the control-store live call, release match and active binding and never returns the carrier identifier.

### Management API registrar

- `registerOperationsRoutes({ app, operations, store, requireRole })` exports console-ready Fastify routes for a single live-call launch, campaign preview/create/list/detail/pause/resume/cancel, suppression list/upsert/delete, inbound route list/upsert/delete, inbound policy/capacity/decisions, and handoff request/status/confirmation.
- Every body, parameter and cursor uses strict bounded Zod validation. Reads require viewer; campaign/suppression/handoff mutations require editor; inbound policy and admission decisions require admin.
- Campaign creation verifies an immutable release in the authenticated control-store workspace and a normalized caller number from service configuration. The fixed operations `organizationId` must equal the principal workspace compatibility namespace.
- `POST /v1/calls` requires admin, explicit installation `liveEnabled`, a permitted caller number, an existing immutable release, E.164 recipient and variables that satisfy the release JSON Schema. It creates a one-contact campaign and goes through the same transactional admission/outbox and immediate pre-dial authorization as every campaign call; the HTTP process never calls the carrier.
- The client-supplied UUID `operationId` is also the control `CallRecord.id` and durable `jobId`. The call record is persisted before the candidate becomes dispatchable; a repeated identical request returns the same call/job/campaign/contact trace while changed input is rejected. The response is `202` and includes all four IDs.
- All successful mutations append control-store audit entries. Suppression and inbound-route audit identifiers are SHA-256 hashes rather than raw customer phone numbers.
- If no carrier handoff adapter is configured, handoff request and accepted-confirmation routes return `503 handoff_unavailable` before creating or advancing a handoff row. Campaign, suppression and inbound capabilities remain available.
- If no production operations service is injected, every operations route responds `503 operations_unavailable`; it does not return an empty or simulated dataset.

### Runnable API operations runtime

`apps/api/src/operations-runtime.ts` exports `createOperationsRuntime(options)`. Bootstrap passes the one authenticated bootstrap identity namespace as `organizationId`; the factory returns the migrated `PostgresOperationsService`, an actual process-scoped `ovo.operations` plugin, a redacted resolved configuration and an idempotent shutdown function.

Configuration is explicit and bounded:

- `OVO_OPERATIONS_DATABASE_URL`, falling back to `DATABASE_URL`, selects PostgreSQL.
- `OVO_OPERATIONS_PG_MAX_CONNECTIONS` defaults to 5 and is limited to 1–20. Owned pools use a five-second connection timeout, 30-second idle timeout and idempotent shutdown.
- `OVO_PERMITTED_FROM_NUMBERS` is a comma-separated E.164 allowlist.
- `OVO_LIVE_DIAL_ENABLED` enables carrier admission only for the exact value `true`; the default remains false. Worker and API must receive the same value and organization ID.
- Handoff remains unavailable unless `OVO_HANDOFF_PROVIDER=twilio` and both `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are present. An unsupported provider or partially configured Twilio carrier fails startup rather than installing a pretend provider. Optional `OVO_TWILIO_HANDOFF_RESUME_URL` must be HTTPS.

The exported `TwilioHandoffProvider` uses the authenticated Twilio SDK call-update API for phone/queue transfer and resume/human/end fallback. Only a resolved Twilio update carrying a call receipt becomes `confirmed`; the receipt ID is SHA-256-derived and does not expose the carrier call SID. Deterministic 4xx responses are rejected. Timeout, network, 429 and 5xx outcomes become `unknown`; Twilio offers no call-update lookup by the OVO request ID, so reconciliation stays pending and the operation is never blindly retried.

## PostgreSQL schema

The versioned migration runner holds an advisory transaction lock and records applied versions in `ovo_ops_schema_migrations`. Migration 001 creates:

- `ovo_ops_campaigns`, `ovo_ops_campaign_contacts`, `ovo_ops_suppressions`
- `ovo_ops_attempts`, `ovo_ops_attempt_events`, `ovo_ops_outbox`
- `ovo_ops_inbound_capacity`, `ovo_ops_inbound_admissions`, `ovo_ops_inbound_policy`
- `ovo_ops_call_bindings`
- `ovo_ops_handoffs`

Foreign keys, unique request/event/call keys, state checks and partial/ordered indexes enforce the service assumptions. No in-memory repository is used for production behavior.

Migration 002 adds the unique outbox aggregate/job identity used by idempotent direct live launch and durable orchestration enqueue.

Migration 003 adds `ovo_ops_inbound_routes`, called-number/release/session snapshots on inbound admissions, and the protected worker endpoint required for direct incoming media routing. The ingress transaction also requires the orchestration migrations (`ovo_jobs` and `ovo_session_routes`) in the same PostgreSQL database; startup must migrate orchestration before accepting inbound traffic.

Migration 004 adds persisted wait deadlines and unique callback campaign/contact/job identities. These identities make repeated Twilio wait polls and callback action deliveries converge on one durable result.

## Required application wiring

1. A dispatcher builds `OperationsOutboxDispatcher(dispatcherId, service.outbox, campaignJobPort)`. `CampaignJobPort.enqueue` must call the existing durable orchestration repository with `jobId = outbox.aggregateId`, `idempotencyKey = outbox.dedupKey` and the candidate payload. Replaying enqueue after a crash is therefore safe.
2. The worker recognizes `campaign_dial_candidate`, then calls `service.campaigns.authorizeDial(payload.contactId, payload.admissionOwnerId, payload.admissionEpoch)` after claiming the durable job and immediately before its orchestration `beginDial`/carrier call. A blocked result is terminal for that candidate and must not call the provider.
3. Main calls `createOperationsRuntime` with the bootstrap identity namespace, composes its returned process plugin, and registers `registerOperationsRoutes` with the returned service, async `ControlStore` and existing `requireRole`. Registration may pass `operations: undefined`; this intentionally exposes explicit 503 responses while the service is not configured. Production configuration keeps `liveEnabled: false` until an operator intentionally enables carrier-backed live calling.
4. After an accepted live call has both the internal `CallRecord.id` and authoritative carrier receipt, worker/orchestration calls `service.calls.bind({ internalCallId, carrierCallId, releaseId, bindingReceiptId })`. API callers cannot create this mapping.
5. The telephony adapter implements `HandoffProviderPort`. An adapter whose transfer method returns no authoritative receipt must return `unknown`, not `confirmed`.
6. Media-gateway bootstrap composes `createTwilioInboundWebhookHandler` before its existing HTTP handler with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, the exact public HTTPS base, WSS media URL and an operator-supplied route-token secret of at least 32 characters. The helper returns `false` for unrelated paths so the existing readiness/status/media handler remains authoritative.
7. A worker establishes and renews real task protection before calling `operations.inbound.registerProtectedCapacity({ slotId, workerId, workerEndpoint, generation, ready: true, protectedUntil })`. It advertises `ready: false` before drain/release. For a media-opened `inbound_call` job it reserves cost policy before session composition, begins active-call metering immediately on acceptance and never invokes the outbound runner/dial path.
8. After the existing signed status projector accepts a terminal callback, media-gateway bootstrap calls `projectInboundTerminalStatus(operations, event)` to release the reservation and terminalize the operations call binding.
9. Media-gateway routing must preserve the webhook query string because Twilio signs the exact wait/callback action URL. Wait polls need no worker work until admission reserves a slot. A consented callback uses the ordinary operations outbox/dispatcher and `campaign_dial_candidate` worker path; it must not receive a special direct-dial HTTP path or bypass `authorizeDial`.

These are narrow integration ports; the operations package does not perform nontransactional queue or carrier side effects while holding its PostgreSQL transaction.

## Verified locally

| Check                                        | Result                                        | What it proves                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Focused operations/API regression            | 7 files / 32 tests passed                     | Existing campaign, suppression, handoff, runtime, route-management and live-launch behavior remains green together with the new inbound wait/callback state machines.                                                                                                                      |
| Disposable PostgreSQL inbound overflow suite | 2/2 tests passed                              | Atomic accepted job/session provisioning, immutable wait snapshot, duplicate wait identity, one-time wait-to-accepted transition, explicit expiry, callback idempotency, single campaign/contact/outbox creation, one-attempt quotas, suppression, and fail-closed callback configuration. |
| Local signed inbound HTTP protocol suite     | 5/5 tests passed                              | Exact Twilio signature gating, no admission on invalid initial or DTMF signatures, WSS session/token TwiML, bounded Pause/Redirect polling, Gather consent, explicit wait expiry, busy rejection and human transfer rendering without a real carrier call.                                 |
| Twilio handoff adapter Vitest suite          | 2/2 tests passed                              | Accepted updates produce opaque receipts, deterministic rejection is bounded, uncertain outcomes remain unknown/pending and no paid provider request occurs.                                                                                                                               |
| Focused CSV/timezone Vitest suite            | 6/6 tests passed                              | Mapping validation, bounded preview, safe spreadsheet export and explicit normal/nonexistent/ambiguous/invalid timezone handling.                                                                                                                                                          |
| Operations TypeScript diagnostic filter      | No diagnostics in package or operations route | Exported contracts, registrar and implementation type-check in the integrated workspace.                                                                                                                                                                                                   |
| Module-size and whitespace checks            | Passed for the operations scope               | Production modules remain below 400 canonical nonblank lines/24 KiB and tests below 500 lines.                                                                                                                                                                                             |

The disposable PostgreSQL container was removed after testing. No paid network, carrier request or deployment was made. The Twilio adapter is real authenticated SDK code, but its tests inject local outcomes.

## Explicitly unverified production gates

- The injectable API registrar and media-gateway inbound handler exist, but shared API/media bootstrap and worker/dispatcher attachment remain owned integration changes. End-to-end calling is not safe until those callers honor the contracts above. The outbound live-enable flag remains false by default.
- No real carrier transfer, fallback, incoming phone call, Twilio wait poll or callback dial was exercised. The inbound protocol test uses a local HTTP server and generated valid Twilio signatures; PostgreSQL tests use no carrier. Production Twilio delivery and human consent audio remain external certification gates.
- No load, backup/restore, rolling-deploy, long-running DST schedule, provider outage or disaster-recovery drill was performed.
- Outbox delivery is at least once by design. Correct application integration depends on the existing orchestration repository enforcing the supplied idempotency key.
