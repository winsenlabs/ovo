# Production control storage evidence

Date: 2026-09-20

## Scope and deployment model

OVO is a self-hosted, single-organization product. `workspaceId` remains an internal ownership and compatibility namespace for agent, credential, provider, MCP, call, evaluation, usage, audit, and operation records. This implementation does not add tenant provisioning, organization switching, row-level security, or SaaS IAM. Existing operator roles remain enforced by the management API.

## Implemented

- `ControlStore` is fully asynchronous. SQLite remains the local, single-process adapter and now presents the same Promise contract.
- `PostgresControlStore` uses the existing pinned `pg` dependency and a bounded connection pool.
- PostgreSQL migrations are versioned, checksum-verified, advisory-lock serialized, transactional, and isolated under `ovo_ctl_*` plus `ovo_control_schema_migrations`. They do not modify orchestration, operation, media, or cost tables.
- Every collection query is capped at 100 records and exposes an opaque cursor. Credential reference summaries use bounded ID samples plus independent counts.
- PostgreSQL keys and foreign keys carry the internal workspace namespace. Agent drafts use compare-and-swap updates. Event sequencing locks the call row. Credential rotation locks the credential. MCP discovery replacement and approvals are transactional. Operation intent insertion is race-safe and terminal operation identity cannot be rewritten.
- Release publication rechecks the locked agent draft inside the insert transaction. Only one immutable release may be created for a draft version.
- Releases persist `providerBindings: Record<string, ProviderBinding>` snapshots for every configured provider slot and `mcpTools` snapshots containing each allowed MCP tool's approval, connection metadata, and discovered schema in the same transaction. Snapshots include opaque credential references, never plaintext secret material. Legacy releases decode with empty snapshots; execution fails closed when a configured provider or allowed MCP tool lacks its immutable snapshot.
- Production API startup selects PostgreSQL from `OVO_CONTROL_DATABASE_URL` or `DATABASE_URL` instead of refusing all production starts. Missing PostgreSQL configuration fails startup; there is no SQLite fallback in production.
- The `encrypted-store` secret backend supports self-hosted PostgreSQL with AES-256-GCM blobs and requires an externally supplied stable `OVO_SECRETS_MASTER_KEY`. SQLite `local` secrets remain development-only. AWS Secrets Manager remains optional.
- Forwarded TLS is trusted only when `OVO_TRUSTED_PROXY_CIDRS` explicitly configures trusted proxy CIDRs. Without that setting, an arbitrary `x-forwarded-proto: https` header cannot bypass the production TLS requirement for credential submission.
- Existing recording route body limits and scoped call checks remain unchanged.

## Configuration

Production control-plane minimum:

```text
NODE_ENV=production
DATABASE_URL=postgresql://...
OVO_SECRETS_MASTER_KEY=<externally managed 32-byte key encoded as hex or base64>
OVO_SECRETS_BACKEND=encrypted-store
OVO_TRUSTED_PROXY_CIDRS=<comma-separated private ALB/reverse-proxy CIDRs, when applicable>
```

`OVO_CONTROL_DATABASE_URL` can override `DATABASE_URL`. `OVO_CONTROL_DB_POOL_MAX` can set the bounded pool size. Operators using AWS Secrets Manager set `OVO_SECRETS_BACKEND=aws-secrets-manager` instead of `encrypted-store`.

## Executed evidence

A disposable `postgres:17.6-alpine` instance was started locally and removed after testing.

| Check                                                                    | Result                                                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `packages/plugin-storage/tests/postgres.test.ts` against real PostgreSQL | 8/8 passed                                                                                                        |
| PostgreSQL management API startup with `encrypted-store`                 | 2/2 passed                                                                                                        |
| SQLite storage, secrets, recordings, API and release-runtime regressions | 17/17 passed                                                                                                      |
| Affected TypeScript files                                                | Passed; whole-workspace failures observed during the run were confined to concurrently developed sibling packages |
| Storage/API module-size gate                                             | Passed; an unrelated concurrent worker module remained over its limit during the scoped run                       |

The PostgreSQL suite exercises migration replay/checksums, bounded pagination, internal workspace lookup boundaries, concurrent draft compare-and-swap, concurrent single-release publication, failed-credential transaction rollback, encrypted secret rotation/reference constraints, immutable provider and MCP release snapshots, stale MCP publication rejection, MCP discovery/approval constraints, concurrent event sequence allocation, evaluations, usage, audit redaction, and durable operation-ID races.

## Deliberate boundaries

No live cloud database, AWS Secrets Manager, ALB, deployment, carrier, or paid provider call was made. Those environment-specific checks remain deployment gates. This evidence covers the executable storage and local protocol behavior, not external service availability or production performance certification.
