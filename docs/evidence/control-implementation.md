# Control-plane implementation evidence

## Implemented

- `/v1` Fastify API with health, signed HttpOnly bootstrap sessions, workspace scope derived from authenticated identities, and viewer/editor/admin checks.
- `AgentConfig`-validated drafts with optimistic `If-Match` updates and immutable, server-derived release locks from the approved runtime catalogue.
- Modular `ControlStore` interface and single-process Node `node:sqlite` development adapter. Reopen tests cover durable drafts/releases. API startup explicitly refuses this adapter in production; a PostgreSQL adapter remains a production gate.
- AES-256-GCM local secret backend, expiry checks, per-agent scoped resolution, write-only API responses, rotation versions, reference-bounded retirement, and conservative audit redaction. AWS Secrets Manager versions are pinned in metadata so a failed metadata rotation continues resolving the previously pinned version.
- Provider bindings, MCP connection metadata, real connector test/discovery, persisted schema digests, and explicit per-agent tool approvals. MCP credentials resolve server-side.
- Simulation/evaluation routes compose pinned real plugins. Unavailable capabilities fail specifically; no synthetic provider/tool answers are generated.
- Call/event/usage inspection preserves honest empty states. Usage pricing and summaries use exact observability helpers and retain native units plus price-card provenance.
- Recording inspection/audio and simulation-only fixture upload use the mounted recording service. Live customer recording upload is rejected.
- Public SDK re-exports the approved runtime composition/plugin API and contract types.

## Verification

- `node scripts/check-module-size.mjs` passes the 400 canonical nonblank line and 24 KiB module limits.
- Storage, encrypted-secret, and Fastify inject tests cover database reopen, workspace isolation, optimistic conflict, metadata-only secrets, server-derived release locks, and real announcement simulation.
- Full workspace TypeScript typecheck passes.

## Explicit boundaries

- The SQLite adapter is development-only and is not suitable for multi-task Fargate. `ControlStore` currently has a synchronous, SQLite-shaped method surface; a production PostgreSQL implementation, async interface evolution, migration operations, and certification remain open gates. It is not claimed as an interchangeable production adapter boundary yet.
- Local recording storage is development-only; production requires the S3 recording backend.
- Call-event persistence currently starts sequence numbers at 1. It is not presented as an adapter for observability `DurableEvent` projection, and no replay/projection integration is claimed.
- No paid provider calls or deployments were performed.
- The default API bootstrap catalog can publish and simulate `announcement` and
  `faq` modes. `context` and `agent` require operator-supplied, approved release
  plugin definitions for inference and (for agent mode) execution/speech/tool
  connectors through `pluginCatalog` / `createReleasePlugins`. The API does not
  install invented inference replies or live-effect fixtures by default, so
  all-four-mode API flow coverage remains an explicit integration task even
  though standalone behavior package mode tests pass.
