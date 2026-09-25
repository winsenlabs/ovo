# Production operator console E2E handoff

Status: UI source is implemented, but production journeys are **not certified** until main registers the optional services and an authenticated browser run completes against the same PostgreSQL-backed API/worker stack.

## Browser and gateway contract

- Browser routes are real Next.js pages. The session-gated tree includes `/agents`, `/agents/new`, `/agents/:id` with Plugins/Test/Releases tabs, `/calls`, `/calls/:id`, campaigns, operations, settings, and `/team` (admin only). `/providers`, `/tools`, `/suppressions`, and `/handoffs` redirect to their settings/operations routes.
- `GET /v1/auth/me` runs on the server for every protected route using the HttpOnly cookie. A 401/403 redirects to `/login?next=<requested internal path>`; an API outage fails closed. Direct `/team` access by a signed-in non-admin returns 404.
- Every JSON request uses the same-origin console gateway prefix `/api/v1`.
- The gateway must forward to management API `/v1` without exposing a bootstrap/admin token to browser JavaScript.
- Requests use `credentials: same-origin` and `cache: no-store`.
- Binary recording/export links also use `/api/v1` and require the HttpOnly session cookie.
- The console accepts collection responses as an array or `{items:[...]}`. New production registrars should prefer bounded `{items,nextCursor?}` envelopes.
- Standard errors should be `{error:{code,message,details?}}`. Some cost routes currently emit a flat error; the UI still handles HTTP 503 but receives only the fallback message.

## Identity and roles

The product remains one server-configured organization. There is no organization picker or provisioning flow.

| Journey                                                                                          | API                                                            | Expected role                                                      |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Session check                                                                                    | `GET /v1/auth/me`                                              | authenticated                                                      |
| Login                                                                                            | `POST /v1/auth/session` body `{email,password}`                | database user; legacy `{token}` remains fixture-only compatibility |
| Logout                                                                                           | `DELETE /v1/auth/session`                                      | authenticated                                                      |
| Change own password                                                                              | `PATCH /v1/auth/password` body `{currentPassword,newPassword}` | database user; session is revoked on success                       |
| List/create/update organization users                                                            | `GET/POST /v1/users`, `PATCH /v1/users/:id`                    | admin only                                                         |
| Read operational/configuration evidence                                                          | GET routes below                                               | viewer/editor/admin                                                |
| Agent drafts, MCP approvals, campaigns, suppressions, handoffs, fixture/live recording mutations | mutations below                                                | editor or admin, as noted                                          |
| Credentials, provider-binding CRUD, live-call launch, budgets, inbound policy, retention sweep   | mutations below                                                | admin                                                              |

The default login is email and password. Inputs use browser password-manager autocomplete, password values are cleared after submission, and the console does not use local storage. The disclosed legacy token path exists only for older local fixtures and clears the token after submission.

The first administrator is seeded by the server during installation. Repeated startup must not replace that account or its password. Invalid email/password login returns the same generic `401 invalid_credentials` response.

The `/team` navigation and user-management requests are admin-only. It is a flat list for the one server-configured organization: the only creation/update role values are `admin` and `editor`, displayed as **Admin** and **User**. There are no invites, tenant selectors, role hierarchy, or self-service email changes. Administrators can create users, change labels and roles, disable accounts, and reset passwords; every successful admin update revokes that target user's existing sessions. A self-update returns the current operator directly to login, while any later API `401 unauthorized` also produces a clear re-login state instead of a domain-panel error. The API must preserve the last active administrator and return `409 last_admin` rather than allowing lockout. Duplicate normalized email returns `409 email_conflict`. Restored users return `409 restore_recovery_required` when enabled without a fresh password; the edit form supports resetting the password and enabling the user in one request. SQLite/no-directory mode returns `503 user_management_unavailable` honestly.

The `/account` password form is available to authenticated database users. Passwords are 12–128 characters. A successful `PATCH /v1/auth/password` revokes the current session and returns the operator to email/password login. No password hash, plaintext password, bootstrap token, or session token is rendered or retained.

Legacy multirole fixtures may still return `SessionIdentity.role` as `viewer | editor | admin`. They must not imply multiple organizations. Viewer-mode Agent Studio updates are suppressed client-side; the API remains authoritative and must reject mutations.

## Browser-route to service matrix

### `/agents` — Agent Studio

Required control-plane services:

- `GET /v1/agents`
- `GET /v1/agents/:agentId`
- `POST /v1/agents` body `{config: AgentConfig}`
- `PUT /v1/agents/:agentId` with `If-Match: "<draftVersion>"`, body `{config}`
- `GET /v1/provider-bindings`
- `GET /v1/agents/:agentId/releases`
- `POST /v1/agents/:agentId/releases` body `{}`; server derives and snapshots the exact dependency graph
- `GET /v1/agents/:agentId/readiness`

Readiness response consumed by the UI:

```ts
{
  releaseReady: boolean
  requiredPluginIds: string[]
  blockers: string[]
  details?: CompatIssue[]
  liveReady?: boolean
  liveBlockers?: string[]
}
```

Required invariants:

- Draft update conflicts return 409 with `error.details.current`.
- Publication snapshots provider bindings and MCP connection/approval/discovery records.
- Publication blockers are returned rather than converted to a successful release.
- `liveReady` must include fresh ready-idle capacity and production dependencies; it must not be inferred from control-plane configuration alone.
- UI supports all four modes, accessible ScriptGraph/FAQ authoring, exact tool definitions, provider roles, processing phrases, recording request, and `costPolicy`.
- `speechCache` controls use the landed bounded shape `{enabled:boolean, announcement?:boolean}`. The console states that only exact configured processing phrases and optionally exact announcement text are eligible. It never implies dynamic/LLM/tool-response caching or carrier savings. Main must attach the live hybrid output so eligible static phrases use the cache while every other response continues through the existing streaming output.

### `/settings/tools` and `/settings/providers` — integrations

Both pages initially read:

- `GET /v1/credentials`
- `GET /v1/provider-bindings`
- `GET /v1/mcp-connections`
- `GET /v1/agents`

Credential mutations, admin:

- `POST /v1/credentials` body `{label,provider,type,environment,value,expiresAt?,permittedAgentIds[]}`
- `POST /v1/credentials/:credentialId/rotate` body `{value}`
- `POST /v1/credentials/:credentialId/retire`

Credential responses must contain metadata only and never plaintext values.

Provider binding mutations, admin:

- `POST /v1/provider-bindings`
- `PUT /v1/provider-bindings/:bindingId`
- body `{label,provider,environment,credentialId,config}`
- `DELETE /v1/provider-bindings/:bindingId`

MCP flows, editor/admin:

- `POST /v1/mcp-connections` body `{label,endpoint,auth,credentialId?}`
- `POST /v1/mcp-connections/:connectionId/test`
- `POST /v1/mcp-connections/:connectionId/discover`
- `GET /v1/agents/:agentId/mcp-tools`
- `PUT /v1/agents/:agentId/mcp-tools/:toolId` body `{connectionId,remoteName,schemaDigest}`
- approval is followed by optimistic `PUT /v1/agents/:agentId` adding the exact discovered schema/tool definition to `AgentConfig.tools` and `allowedTools`

Discovery must never grant a tool. Approval must validate the latest server-side discovered schema digest.

### `/agents/new`, `/agents/:id/plugins`, `/agents/:id/test` — fixture demo

- `GET /v1/plugins?kind=` returns `{plugins,unavailable}` from the installed manifest registry. Plugin options stay visible when unavailable; `POST /v1/plugins/compat` supplies per-slot reasons and stage-specific issues.
- `GET /v1/provider-bindings/:id/carrier-urls` returns `{items:[{purpose,label?,url}]}`. The console displays these operator URLs for a selected carrier binding. An invalid envelope or failed request is an explicit error.
- The wizard creates a draft with `POST /v1/agents` then saves the selected config with `PUT /v1/agents/:id` and `If-Match`. It leaves the carrier unselected until the operator chooses one.
- The Test tab runs `POST /v1/agents/:id/test-calls` with `{useDraft:true}`. `GET /v1/calls/:id/stream` provides transcript, stage, cost, gap, and heartbeat events through the cookie gateway. A 404 `fixture_calls_disabled` is an explanatory empty state, and the tab never initiates live dialing.

### `/calls` and `/calls/:id` — live launch and call evidence

`/calls` uses newest-first cursor pages (`limit=50`) with URL filters `agentId`, `engine`, `carrier`, `kind`, and `status`; live-call launch is in an admin-only drawer. `/calls/:id` reads `GET /v1/calls/:id/evidence` for resolved selections, recording, transcript, latency, cost, and the event timeline. Missing cost is labelled `unpriced`, never zero.

Read paths:

- `GET /v1/calls`
- `GET /v1/calls/:callId`
- `GET /v1/calls/:callId/events`
- `GET /v1/calls/:callId/usage`
- `GET /v1/calls/:callId/cost`
- `GET /v1/calls/:callId/stream` via authenticated SSE; events `telemetry`, `gap`, and server error, with cursor/`Last-Event-ID` support

Direct live launch, admin:

- `POST /v1/calls`
- body `{operationId,releaseId,fromNumber,to,variables}`
- response 202 `{callId,jobId,campaignId,contactId,status}`

The HTTP response only proves durable admission. It must not claim carrier dialing. Production `liveEnabled` remains explicitly controlled by server configuration.

Simulation fixture recording paths:

- `GET /v1/calls/:callId/recordings`
- `POST /v1/calls/:callId/recordings` for simulation WAV fixture only
- authenticated audio path supplied by the legacy fixture API

Production recording lifecycle for live/real calls:

- `GET /v1/calls/:callId/live-recordings`
- `GET /v1/calls/:callId/live-recordings/:recordingId/manifest`
- `GET /v1/calls/:callId/live-recordings/:recordingId/alignment`
- `GET /v1/calls/:callId/live-recordings/:recordingId/audio/:track` — authenticated browser-playable PCM WAV for `inbound` or `outbound`
- `GET /v1/calls/:callId/live-recordings/:recordingId/segments/:track/:sequence/audio`
- `DELETE /v1/calls/:callId/live-recordings/:recordingId` — editor/admin tombstone
- `POST /v1/calls/:callId/live-recordings/:recordingId/exports` body `{idempotencyKey}` — editor/admin
- `GET /v1/calls/:callId/live-recordings/:recordingId/exports/:exportId`
- `GET /v1/calls/:callId/live-recordings/:recordingId/exports/:exportId/download`
- `GET /v1/calls/:callId/live-recordings/:recordingId/replay`
- `POST /v1/recordings/retention/sweep` body `{limit:100}` — admin

Absent production recording services must return explicit 503 `recordings_unavailable`. The console
uses the assembled PCM-WAV route for real playback and seeking, labels inbound and outbound tracks
separately, and preserves manifest partial/missing-segment warnings. Raw μ-law segment downloads
remain source evidence, not the call player. Alignment remains wall-clock evidence with
`humanHeard:false` and not waveform-exact. The legacy WAV player is explicitly simulation-fixture
evidence and remains separate.

The assembled track route supports byte ranges (`Accept-Ranges: bytes`) for browser seeking and
returns `X-OVO-Recording-Completeness`, `X-OVO-Recording-Gap-Count`, and a concatenated-segments
timeline label. The console derives its initial partial/gap warning from the authenticated manifest,
so missing evidence remains visible even before audio metadata loads.

### `/campaigns`

- `GET /v1/operations/campaigns?limit=100`
- `POST /v1/operations/campaigns/preview` body `{csv,mapping:{phone,externalId?,variables}}`
- `POST /v1/operations/campaigns` body `{operationId,name,releaseId,fromNumber,schedule:{localDateTime,timezone},perNumberAttemptLimit,maxAttemptsTotal,maxAttemptsPerLocalDay,activeCallPolicy,contacts}`
- `POST /v1/operations/campaigns/:campaignId/pause`
- `POST /v1/operations/campaigns/:campaignId/resume`
- `POST /v1/operations/campaigns/:campaignId/cancel`

The UI limits imported contacts to the server contract and requires a clean preview before creation. Editor/admin mutates; viewer is read-only. Service absence is shown as unavailable, not as an empty successful campaign system.

### `/operations/suppressions`

- `GET /v1/operations/suppressions?limit=100`
- `POST /v1/operations/suppressions` body `{phoneNumber,reason}`
- `DELETE /v1/operations/suppressions/:phoneNumber`

Editor/admin mutates. Worker must still recheck suppression transactionally immediately before carrier dial; this page is not the enforcement point.

### `/operations/handoffs` and `/operations/inbound`

Initial call selector reads `GET /v1/calls` and only offers live/real calls.

- `POST /v1/operations/handoffs` body `{operationId,callId,target:{kind,value},fallback,confirmationRequired}`
- `GET /v1/operations/handoffs/:handoffId`
- `POST /v1/operations/handoffs/:handoffId/confirm` body `{accepted}`
- `GET /v1/operations/inbound/policy`
- `PUT /v1/operations/inbound/policy` body `{expectedVersion,policy}` — admin
- `GET /v1/operations/inbound/capacity`
- `GET /v1/operations/inbound/routes?limit=100&cursor?`
- `PUT /v1/operations/inbound/routes/:phoneNumber` body `{expectedVersion,releaseId,variables,enabled,carrierPluginId,carrierBindingId}` — admin; a NULL binding means the environment binding
- `DELETE /v1/operations/inbound/routes/:phoneNumber?expectedVersion=<version>` — admin

The UI only labels transfer confirmed when the API returns authoritative provider receipt evidence. Missing operations/handoff transport is a 503, not a successful placeholder.

Inbound number routes bind one E.164 called number to an immutable release and string-valued
variables. Creates send `expectedVersion:null`; updates and deletes send the last observed version.
A 409 clears the stale edit and reloads the latest list instead of overwriting concurrent operator
changes. Wait uses a persisted deadline and signed Twilio Pause/Redirect polls, accepting once if fresh
protected capacity appears and otherwise ending with an explicit unavailable message. Callback uses
signed DTMF consent and creates one normal campaign/outbox candidate, so the existing suppression,
quota, dispatcher and pre-dial authorization gates still apply. It fails closed unless live outbound
calling is enabled and the called number is permitted; the webhook never dials directly.

### `/evaluations`

Current legacy evidence flow:

- `GET /v1/evaluations`
- `POST /v1/evaluations` with the selected simulation/call evidence

Simulation execution used from the same component:

- `POST /v1/simulations`
- fixture-safe default body `{releaseId,input,variables:{},bindings:{}}`
- fixture bindings may contain `modelReplies` and `toolResults`
- provider-backed mode is explicit and omits `bindings`; it is labelled as possibly using models/read tools and incurring cost

Write tools without fixture bindings must remain rejected by the API.

The production console now exposes dataset metadata create/update/archive, immutable JSON corpus import capped at 120 cases, version/case inspection, fixture/provider job submission, durable status/cancellation, case evidence, and run comparison. Browser certification still requires the PostgreSQL loop below.

Optional provider evaluations use durable administrator authorizations:

- `GET /v1/evaluation-provider-authorizations?limit=100&cursor?` — admin
- `POST /v1/evaluation-provider-authorizations` body `{releaseId,maximumReservationPaise,idempotencyKey}` — admin
- `POST /v1/evaluation-provider-authorizations/:authorizationId/revoke` — admin
- provider `POST /v1/evaluation-runs` includes `executorKind:'provider'`, the selected
  authorization's `providerBindingVersion`, `budgetAuthorizationId`, and `maxAttempts:1`

The API derives and persists the immutable release fingerprint, inference provider/model and binding
version, release budget ID, and positive reservation cap. The run form offers only active
authorizations matching the selected immutable release; it never accepts free-form binding or budget
IDs. `OVO_PROVIDER_EVALUATIONS_ENABLED` defaults false and remains server-only. A disabled
installation returns 503 `provider_evaluations_unavailable`; the console shows that state without an
enable control, while fixture jobs remain unchanged. Revocation prevents new runs from using that
authorization. Browser certification must not submit a provider-backed run without explicit paid-run
approval.

### `/performance`

- `GET /v1/performance`
- required `from`, `to`
- optional `bucket=hour|day`, comma-separated `groupBy`, and exact `agent`, `release`, `provider`, `model`, `language`, `stage`, `source` filters
- console bounds `maxGroups=100`, `callLimit=25`

Expected response contains bounded cohort groups, p50/p95/p99 values or null, errors, timeouts, sample/event/call counts, call IDs, truncation and ingestion statistics. Missing service is explicit 503 `performance_unavailable`.

### `/costs`

Scenario, viewer:

- `POST /v1/cost/scenario`
- body includes exact paise revenue target, duration, all five components in INR, generated/hit cache units, explicit cache assumptions, and margin scope

Budgets, admin:

- `GET /v1/cost/budgets?limit=100`
- `POST /v1/cost/budgets` body `{id,limitPaise,admissionOverspendPaise}`

Call inspector also consumes `GET /v1/calls/:callId/cost`.

The production console now exposes admin immutable price-card and rational FX-version authoring plus append-only provider invoice reconciliation. Viewer roles can inspect price/FX evidence. `AgentConfig.costPolicy` references the immutable IDs/versions. Browser certification still requires the PostgreSQL loop below.

### `/infrastructure`

- `GET /v1/infrastructure`
- optional exact `releaseId` filter
- returns installation/admission safety, nullable worker capacity and heartbeat evidence, nullable queue depth/age/reconciliation/fencing evidence, provider quota/throttle samples, process samples, recording lifecycle counts, and telemetry ingestion counts

The console preserves every missing metric as `Unknown`; it never converts null to zero. Infrastructure readiness remains advisory evidence, while admission and immediate pre-dial checks stay authoritative. Browser certification requires the final API restart because the process running while this panel was implemented predates the registrar.

## Optional-service registration expected from main

Main should keep each registrar present even when its service is absent, returning explicit 503 from the route rather than a 404:

- cost ledger and scenario routes
- operations/campaign/suppression/inbound/handoff/direct-call routes
- performance and per-call telemetry SSE
- production recording lifecycle
- evaluation dataset/jobs when their console journey is added

This distinction lets the console say “not configured” rather than “route missing.”

## Required production browser loop before claiming completion

Run in one authenticated fresh browser against the PostgreSQL-backed API and the same worker dependencies:

1. Login separately as viewer, editor and admin from server-configured tokens; verify one organization and role gates.
2. Admin creates a write-only credential and provider binding; re-fetch proves plaintext never returns.
3. Editor creates each agent mode, configures exact providers/tools, observes autosave/ETag conflict, readiness blockers, then publishes immutable release snapshots.
4. Run fixture simulation with `bindings:{}` and prove no provider/tool network requests; inspect call/events/usage and simulation WAV fixture.
5. If intentionally authorized, run provider-backed simulation and prove cost/usage evidence is labelled separately.
6. Create a campaign from CSV preview, pause/resume/cancel, add/remove suppression, and verify direct live-call admission returns durable trace IDs without claiming dial.
7. Verify handoff stays pending/unknown until an authoritative receipt and inbound zero-capacity policy executes honestly.
8. Inspect performance cohorts and SSE reconnect/gap behavior from persisted telemetry.
9. Create immutable price-card and FX versions, create/update a budget, publish a matching cost policy, append one invoice reconciliation, and verify admission/call-cost evidence from the same PG ledger.
10. Enable speech cache for exact processing phrases and announcement text; prove a repeated eligible phrase hits cache while dynamic/model/tool/caller-derived text still uses streaming synthesis, and prove carrier/media usage remains billable.
11. For a synthetic local carrier/media loop, verify live recording manifest, segment bytes, alignment disclaimer, redacted export, tombstone and retention sweep.
12. Import the 120-case production corpus, execute a fixture evaluation job, inspect case results, compare two immutable runs, and verify cancel/idempotency behavior.
13. Recheck every optional service disabled: route exists, returns explicit 503, and UI shows unavailable rather than zero/success.

External carrier/provider/AWS certification remains separate and must not be inferred from this local PostgreSQL/browser loop.
