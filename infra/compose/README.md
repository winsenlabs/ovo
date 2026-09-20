# Compact single-EC2 profile

This secondary profile runs the same console/API/dispatcher/gateway/worker images with PostgreSQL and an SQS-compatible local queue. Two independent one-slot worker containers have explicit CPU/memory limits, but they share one host failure domain and are not highly available.

1. Copy `.env.example` to an ignored `.env`, set a local PostgreSQL password and immutable/local image tags.
2. Start with `docker compose --env-file .env -f infra/compose/compose.yaml up -d` from the repository root.
3. Verify PostgreSQL and queue health, then exercise only synthetic jobs unless carrier credentials and paid testing are explicitly authorized.
4. Worker live dialing is deliberately disabled. Enable it only after the supplied gateway image exposes the required session handler/readiness contract and the transport gates are certified.
5. Stop with `docker compose --env-file .env -f infra/compose/compose.yaml down`. Add `--volumes` only when intentionally deleting local data.

The Compose worker count is statically two; it does not pretend to implement ECS task protection or autoscaling. `process-lifecycle` protection means the worker stops admission during container shutdown and drains within the configured host shutdown window. Host loss still interrupts both calls.

The control API currently uses a separate SQLite local-development adapter. This PostgreSQL orchestration schema is namespaced with `ovo_` and can coexist with a future production control schema, but a shared production transaction/backup/restore story is not yet integrated. Therefore this Compose file is not end-to-end production readiness evidence.
