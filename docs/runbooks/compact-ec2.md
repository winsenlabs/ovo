# Compact EC2 / Compose installation

**Trigger:** approved single-host evaluation or compact installation.  
**Owner:** host administrator.  
**Signals:** `docker compose ps`, container health/restarts, PostgreSQL/outbox rows, queue depth, worker logs.

## Procedure

1. Provision a supported Linux host with Docker/Compose, encrypted persistent storage, host firewall, clock sync, backups and enough reserved CPU/RAM for both workers.
2. Copy `infra/compose/.env.example` to an ignored `.env`; set local values and immutable image tags. Do not commit it.
3. Validate configuration without displaying interpolated secrets in an incident transcript:

```bash
docker compose --env-file .env -f infra/compose/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose/compose.yaml up -d
docker compose --env-file .env -f infra/compose/compose.yaml ps
```

4. Verify both workers have distinct IDs and one call slot. Run a synthetic duplicate-delivery check before any authorized carrier test.

## Failure and rollback

Stop admission, allow bounded drain, then stop services. Restore the previous immutable images if a new release fails. Never use `down --volumes` during ordinary rollback. A host failure interrupts both workers; reconcile external call outcomes before requeue.

## Verification

Record image digests, two isolated worker IDs/resource limits, migration result, backup location, and synthetic ownership result. This profile is not highly available and does not implement ECS task protection.
