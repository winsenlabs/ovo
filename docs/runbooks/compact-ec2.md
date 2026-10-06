# Compact EC2 / Compose installation

**Trigger:** approved single-host evaluation or compact installation.  
**Owner:** host administrator.  
**Signals:** `docker compose ps`, container health/restarts, PostgreSQL/outbox rows, queue depth, worker logs.

## Procedure

1. Provision a supported Linux host with Docker/Compose, encrypted persistent storage, host firewall,
   clock sync, backups and enough reserved CPU/RAM for both workers. The Compose limits reserve
   **7.5 vCPU and 8.25 GB** across the eight services, so a host below 8 vCPU / 16 GB over-commits
   them.
2. Run `./scripts/bootstrap-compose.sh --prompt-admin`. It writes a mode-0600 ignored
   `infra/compose/.env` with generated secrets and never prints them. Do not hand-copy
   `.env.example`: every value in it is a `replace-with-…` placeholder, and `compose.yaml` names this
   script in its own `DATABASE_URL` error. Add `--managed-postgres` / `--managed-sqs` for managed
   backing services (see [self-hosted-compose.md](self-hosted-compose.md)).
3. Validate configuration without displaying interpolated secrets in an incident transcript:

```bash
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml config --quiet
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d --build --wait
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps
./scripts/verify-compose.sh
```

`--build` is needed on a first run, because every image tag defaults to a local `:local` build.
After the first install, build images on another machine and deploy them by digest
(`scripts/deploy/build-images.sh`, `scripts/deploy/deploy-compose.sh --images …`; see
[deploy-ovo-dev.md](deploy-ovo-dev.md)): building on the call host competes with live calls. On GCP,
also follow [compact-gcp.md](compact-gcp.md) for restarts, alerting and the carrier fallback.

4. Verify both workers have distinct IDs and one call slot. Run a synthetic duplicate-delivery check before any authorized carrier test.

## Failure and rollback

Stop admission, allow bounded drain, then stop services. Restore the previous immutable images if a new release fails. Never use `down --volumes` during ordinary rollback. A host failure interrupts both workers; reconcile external call outcomes before requeue.

## Verification

Record image digests, two isolated worker IDs/resource limits, migration result, backup location, and synthetic ownership result. This profile is not highly available and does not implement ECS task protection.
