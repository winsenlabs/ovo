# OVO management API contract

Status: implementation contract for the local foundation. All routes except
`GET /health` and the session endpoints require an authenticated bootstrap
identity. The API listens on port `4000` by default.

## Authentication and workspace scope

- `POST /v1/auth/session` accepts `{ "token": "...", "workspaceId"?: "..." }`.
  The server validates the token against server-configured bootstrap identities,
  validates membership in the selected workspace, and returns an opaque/signed
  `HttpOnly; SameSite=Strict` cookie. Production cookies are `Secure`.
- `DELETE /v1/auth/session` expires the cookie.
- `GET /v1/auth/me` returns the identity, selected workspace, and role.
- Non-browser clients may send `Authorization: Bearer <bootstrap token>`.
- The selected workspace comes only from the authenticated identity/session.
  `X-Workspace-Id` and other client workspace headers are ignored. Resource IDs
  are always looked up with the authenticated workspace ID.
- Roles are `viewer`, `editor`, and `admin`. Reads require `viewer`; agent,
  release, MCP, simulation, and evaluation mutations require `editor`; provider,
  credential, and audit administration require `admin`.

The console must send the bootstrap token only to `POST /v1/auth/session`; it
must not retain the token in browser storage or expose it to client JavaScript.

## Response conventions

- JSON responses use `application/json`.
- Collections return `{ "items": [...], "nextCursor": string | null }`.
- Errors return `{ "error": { "code": string, "message": string,
"details"?: object } }`.
- Draft writes require `If-Match: "<draftVersion>"`. A stale version returns
  `409` with code `draft_conflict` and the current draft in `details.current`.
- IDs are opaque UUIDs. Timestamps are ISO-8601 UTC strings.
- Decimal quantities and money are strings, never JSON binary floats.

## Health and identity

| Method | Route              | Result                                        |
| ------ | ------------------ | --------------------------------------------- |
| GET    | `/health`          | `{ status: "ok", storage: "ok" }`             |
| POST   | `/v1/auth/session` | Sets session cookie; returns current identity |
| DELETE | `/v1/auth/session` | Clears session cookie; `204`                  |
| GET    | `/v1/auth/me`      | Authenticated identity, workspace, role       |

## Agents and immutable releases

`config` is always the `AgentConfig` schema exported by
`@winsendotai/ovo-contracts`; the API does not maintain a second permissive
agent shape.

| Method | Route                          | Body / result                                                                                                                                                                                                               |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/agents`                   | Paginated drafts                                                                                                                                                                                                            |
| POST   | `/v1/agents`                   | `{ config: AgentConfig }`; creates draft version `1`                                                                                                                                                                        |
| GET    | `/v1/agents/:agentId`          | Draft and `ETag`                                                                                                                                                                                                            |
| PUT    | `/v1/agents/:agentId`          | `{ config: AgentConfig }` plus `If-Match`; replaces draft                                                                                                                                                                   |
| DELETE | `/v1/agents/:agentId`          | `If-Match`; blocked when immutable releases exist                                                                                                                                                                           |
| GET    | `/v1/agents/:agentId/releases` | Immutable release history                                                                                                                                                                                                   |
| POST   | `/v1/agents/:agentId/releases` | `{ pluginIds: string[] }`; treats IDs only as a selection from the server-approved catalogue, derives versions from installed definitions, validates the actual composition, and persists the resulting server-derived lock |
| GET    | `/v1/releases/:releaseId`      | Immutable release snapshot and plugin lock                                                                                                                                                                                  |

Publishing never mutates an existing release. Active/runtime sessions pin the
returned release ID and exact plugin lock. Execution fails closed when an exact
locked `id@version` is absent; it never substitutes another installed version.
The selected graph must contain exactly one behavior compatible with the agent
mode, and every other selected session plugin must be a transitive dependency
of that behavior. Process and management plugins cannot enter a release lock.

## Credentials and provider bindings

Plaintext credential fields are accepted only by credential create/rotate
requests, passed directly to the configured secret backend, and never returned.
Production deployments must use authenticated TLS.

| Method | Route                                  | Body / result                                                                                                     |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/credentials`                      | Redacted metadata only                                                                                            |
| POST   | `/v1/credentials`                      | `{ label, provider, type, environment, value, expiresAt?, permittedAgentIds? }`; returns metadata/reference only  |
| POST   | `/v1/credentials/:credentialId/rotate` | `{ value }`; creates a new secret version atomically                                                              |
| POST   | `/v1/credentials/:credentialId/retire` | Retires only when no active provider/MCP references remain; otherwise `409` includes bounded reference counts/IDs |
| GET    | `/v1/provider-bindings`                | Provider binding metadata                                                                                         |
| POST   | `/v1/provider-bindings`                | `{ label, provider, environment, credentialId, config? }`                                                         |
| PUT    | `/v1/provider-bindings/:bindingId`     | Rebinds metadata/credential; no secret values                                                                     |
| DELETE | `/v1/provider-bindings/:bindingId`     | Removes a binding when release policy permits                                                                     |

Secret values, ciphertext, nonces, authentication tags, and backend payloads
are excluded from API responses, errors, and audit payloads.

## MCP connections and approvals

Initial transport is remote HTTP only. Credentials remain server-side.
Discovery records schemas but never grants an agent access.

| Method | Route                                        | Body / result                                                                                        |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET    | `/v1/mcp-connections`                        | Connection metadata and status                                                                       |
| POST   | `/v1/mcp-connections`                        | `{ label, endpoint, auth: "none"                                                                     | "bearer", credentialId? }` |
| PUT    | `/v1/mcp-connections/:connectionId`          | Updates metadata/credential binding                                                                  |
| DELETE | `/v1/mcp-connections/:connectionId`          | Blocked while agent approvals reference it                                                           |
| POST   | `/v1/mcp-connections/:connectionId/test`     | Uses the approved server-side MCP connector and credential resolver; returns bounded redacted status |
| POST   | `/v1/mcp-connections/:connectionId/discover` | Performs real tool discovery and records names, schemas, and schema digests; grants nothing          |
| GET    | `/v1/mcp-connections/:connectionId/tools`    | Last recorded discovery metadata and schema digests                                                  |
| PUT    | `/v1/agents/:agentId/mcp-tools/:toolId`      | `{ connectionId, remoteName, schemaDigest }`; explicitly approves one tool                           |
| DELETE | `/v1/agents/:agentId/mcp-tools/:toolId`      | Revokes one approval                                                                                 |
| GET    | `/v1/agents/:agentId/mcp-tools`              | Exact approved tool bindings                                                                         |

Release validation requires every MCP tool in `AgentConfig.allowedTools` to
have a matching approval and schema digest. Schema drift blocks publication.

## Simulation and evaluations

| Method | Route                           | Body / result                                                                                                                                    |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/v1/simulations`               | `{ releaseId, input, variables? }`; composes that release's real approved behavior/tool plugins and returns their output plus `callId`           |
| GET    | `/v1/evaluations`               | Stored fixture runs; honest empty collection before runs                                                                                         |
| POST   | `/v1/evaluations`               | `{ releaseId, fixtures: [{ id, input, variables?, expectedOutput?, forbiddenOutput? }] }`; runs real composition and persists objective outcomes |
| GET    | `/v1/evaluations/:evaluationId` | Fixture inputs, actual outcomes, assertions, and timestamps                                                                                      |

Simulation is explicitly labelled `simulation`; it creates no carrier call and
does not invent provider/tool data. If the release lacks runnable behavior or a
required connector, the route returns a specific validation error rather than a
mock answer.

## Calls, events, usage, and audit

| Method | Route                                             | Result                                                                                                        |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/calls`                                       | Paginated real and simulation sessions; honest empty collection                                               |
| GET    | `/v1/calls/:callId`                               | Session metadata and current status                                                                           |
| GET    | `/v1/calls/:callId/events`                        | Ordered recorded events, preserving generated/completed/interrupted evidence                                  |
| GET    | `/v1/calls/:callId/usage`                         | Native provider units and fixed-precision cost strings                                                        |
| GET    | `/v1/calls/:callId/recordings`                    | Recording metadata; honest empty collection when none exist                                                   |
| GET    | `/v1/calls/:callId/recordings/:recordingId/audio` | Authorized `audio/wav` bytes after integrity and retention checks                                             |
| POST   | `/v1/calls/:callId/recordings`                    | Editor-only base64 WAV fixture upload, accepted only for simulation calls; live customer uploads are rejected |

Recording collections use the standard `{ items, nextCursor }` envelope. Each
metadata item contains `id`, `workspaceId`, `callId`, `source`, `createdAt`,
`expiresAt`, `sha256`, `bytes`, `sampleRate`, `channels`, `bitsPerSample`,
`format`, and `durationMs`. Expired or unavailable audio is not synthesized.
Audio reads return `404 recording_not_found` when no scoped recording exists and
`410 recording_expired` after retention expiry. Archive/backend paths are never
included in these responses. Fixture upload accepts at most 5 MiB decoded WAV
data; its route has a dedicated roughly 7 MiB JSON/base64 body limit while the
global API body limit remains 256 KiB.
| POST | `/v1/calls/:callId/usage` | Admin/internal foundation endpoint: accepts a real provider usage identity and versioned price card, prices once with exact decimal arithmetic, and stores the resulting provenance |
| GET | `/v1/audit` | Admin-only redacted audit records |

Usage entries expose `quantity` as a decimal string with `unit`, provider
request ID, price-card/version fields, `amountMinor` as a decimal integer
string, `currency`, and `estimated`/`reconciled` state. Empty telemetry remains
empty and is never replaced with generated demonstration metrics.
