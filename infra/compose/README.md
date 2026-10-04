# Compact single-EC2 profile

This secondary profile runs the same console/API/dispatcher/gateway/worker images with PostgreSQL and an SQS-compatible local queue. Two independent one-slot worker containers have explicit CPU/memory limits, but they share one host failure domain and are not highly available.

The API explicitly enables `OVO_FIXTURE_TEST_CALLS=true`; these calls use fixture-only network and secret ports and never dial. `OVO_CARRIER_ENV_BINDINGS` is formed from the optional Twilio environment values and stays inert while live flags are false. `OVO_MEDIA_PUBLIC_BASE_URL` and `OVO_INBOUND_ROUTE_SECRET` are required for signed callback URL generation. The dispatcher sets `OVO_CAPACITY_SIGNAL=log`; [ADR 0003](../../docs/decisions/0003-aas-only-desired-count-writer.md) assigns real Fargate desired count to Application Auto Scaling, while Compose keeps its two fixed workers.

1. Run `./scripts/bootstrap-compose.sh` from the repository root. It writes a mode-0600, ignored
   `infra/compose/.env` with freshly generated secrets and never prints them. `compose.yaml` names
   this script in its own `DATABASE_URL` error, so it is the supported path; `.env.example` documents
   the variables but its placeholders are not usable values. Use `--prompt-admin` to set the first
   administrator, and `--managed-postgres` / `--managed-sqs` to point at managed services instead of
   the bundled PostgreSQL and ElasticMQ.
2. Build and start from the repository root:
   `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d --build`.
   `--build` is needed the first time, because every image tag defaults to a local `:local` build.
3. Run `./scripts/verify-compose.sh` to check service health, local authentication and the fixture/capacity environment. Exercise only synthetic jobs unless carrier credentials and paid testing are explicitly authorized.
4. Worker live dialing is deliberately disabled. Enable it only after the supplied gateway image exposes the required session handler/readiness contract and the transport gates are certified.
5. Stop with `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml down`. Add
   `--volumes` only when intentionally deleting local data.

`OVO_MEDIA_PUBLIC_BASE_URL` must be a public **HTTPS** origin a carrier can reach, with a working WSS
upgrade — `verify-compose.sh` refuses anything else. On a laptop that means a tunnel; on a host it
means a domain and a certificate. It is normally the only thing a new deployment is missing.

Leave `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` **empty** unless an `env` carrier binding is
intended. Compose interpolates them into `OVO_CARRIER_ENV_BINDINGS` for every service, so a value
present in the shell or in `.env` creates a second credential-bearing Twilio binding silently
alongside one created in the console. `docs/deployment/environment.md` carries the verdict-only check.

The Compose worker count is statically two; it does not pretend to implement ECS task protection or autoscaling. `process-lifecycle` protection means the worker stops admission during container shutdown and drains within the configured host shutdown window. Host loss still interrupts both calls.

The control API currently uses a separate SQLite local-development adapter. This PostgreSQL orchestration schema is namespaced with `ovo_` and can coexist with a future production control schema, but a shared production transaction/backup/restore story is not yet integrated. Therefore this Compose file is not end-to-end production readiness evidence.
