# Self-hosted Docker Compose setup

This profile runs one OVO organization on one Docker host. It starts the console, API, media gateway, dispatcher and two bounded workers. Local PostgreSQL and ElasticMQ are enabled by default, but they may be replaced with managed PostgreSQL and AWS SQS.

## Prerequisites

- Docker Engine with Docker Compose v2.20 or newer
- OpenSSL
- At least 8 GiB of available memory for builds and the running profile

No Redis service is required. The speech-audio cache is bounded process memory and is intentionally cold after a worker restart.

## First setup

From the repository root, create the ignored installation environment. The recommended interactive mode keeps the administrator password out of shell history:

```sh
./scripts/bootstrap-compose.sh --prompt-admin
```

The bootstrap:

- creates `infra/compose/.env` with mode `0600`;
- generates independent random session, encryption, media and routing keys;
- records the first administrator email and password without printing either secret;
- enables the local PostgreSQL and ElasticMQ profiles;
- keeps live dialing, inbound calling, transport certification and provider-backed evaluations disabled.

It is safe to rerun. Existing values are preserved and the file remains mode `0600`. Do not commit or copy this file into an image. Back it up through your secret-management process because changing the encryption key makes existing provider credentials unreadable.

If you supply `OVO_SEED_ADMIN_PASSWORD` noninteractively, it must be 12–128 characters and use only letters, numbers, or these dotenv-safe characters: `!@%_+=:,.~-`. The same validation applies to the interactive prompt so the generated environment never silently misparses a password.

Start the complete stack with one Compose command:

```sh
docker compose --env-file infra/compose/.env \
  -f infra/compose/compose.yaml up --build -d --wait
```

Open http://localhost:3000 and sign in with the email and password supplied during bootstrap. The first administrator is inserted transactionally only when the installation has no users. Restarting the stack does not reset its password or create another administrator.

Verify container health and the database-backed sign-in without printing credentials:

```sh
./scripts/verify-compose.sh
```

The verifier also checks the API's explicit fixture-call flag, HTTPS media base URL, inbound route secret, carrier environment-binding shape and the dispatcher's log-only capacity signal. This command has not been run as I1 evidence on this host because the full Compose stack is not running; the exact command above is the operator smoke check once Docker is available. A local health pass does not certify public callbacks or real carrier traffic.

Stop the services without deleting data:

```sh
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml down
```

Add `--volumes` only when you intentionally want to delete the local database and recordings.

The bootstrap is intentionally non-destructive: once any database user exists, normal restarts do not replace users or reset passwords. For disaster recovery, follow the guarded [backup and restore procedure](backup-restore.md); do not attempt to replay the normal seed or improvise a bulk user reset.

## Local ports and HTTP safety

The default profile publishes only to the loopback interface:

| Service       | URL or port             |
| ------------- | ----------------------- |
| Console       | `http://127.0.0.1:3000` |
| API           | `http://127.0.0.1:4000` |
| Media gateway | `http://127.0.0.1:4001` |
| PostgreSQL    | `127.0.0.1:54329`       |
| ElasticMQ     | `127.0.0.1:9324`        |

The local profile sets `OVO_ALLOW_LOCAL_HTTP=true`, which disables the API's TLS-write requirement and `Secure` session-cookie attribute. Its safety boundary is the Compose file's fixed `127.0.0.1` port publishing; the flag is not a request-level client-IP guard. Do not publish these ports on another interface. Any shared or public installation must set the flag to `false` and terminate TLS at a trusted reverse proxy; arbitrary `X-Forwarded-Proto` headers are not trusted. The API trusts a forwarded protocol only from the console container, which Compose pins to `OVO_CONSOLE_ADDRESS` (default `172.29.240.10`) inside `OVO_COMPOSE_SUBNET` (default `172.29.240.0/24`); override both together if that subnet collides with the host. The reverse proxy must overwrite, not append to, `X-Forwarded-Proto`.

Change host ports in `infra/compose/.env` when another process already uses them. Internal container ports do not change.

## Managed PostgreSQL

OVO uses one PostgreSQL database with separate namespaced migrations. Provide a PostgreSQL URL through an environment variable so credentials do not appear in command arguments:

```sh
export OVO_BOOTSTRAP_DATABASE_URL='postgresql://USER:PERCENT_ENCODED_PASSWORD@HOST:5432/ovo?sslmode=require'
./scripts/bootstrap-compose.sh --managed-postgres --prompt-admin
unset OVO_BOOTSTRAP_DATABASE_URL
```

Then run the same `docker compose ... up --build -d --wait` command. The generated `COMPOSE_PROFILES` excludes the local PostgreSQL service. Use the provider's TLS requirement; prefer `sslmode=verify-full` with a trusted CA where supported. Percent-encode reserved characters in usernames and passwords.

The database account needs permission to create and migrate tables in the target database. Use a dedicated database/account, enable managed backups and test the [restore quarantine procedure](backup-restore.md).

## Queue choices

The default `local-queue` profile starts ElasticMQ for a single-host installation. ElasticMQ is a development/compact substitute, not a claim of SQS durability.

Production deployments should set `OVO_QUEUE_URL` to the real SQS queue, leave `OVO_SQS_ENDPOINT` empty, disable the `local-queue` profile, and provide AWS credentials through the workload identity or deployment secret mechanism. The Compose bootstrap also accepts `--managed-sqs` with `OVO_BOOTSTRAP_QUEUE_URL`; local Docker runs must additionally supply appropriately scoped AWS credentials.

Use an existing **standard** SQS queue; the current dispatcher does not supply a FIFO message-group ID. Provision and operate the queue and its dead-letter queue outside this Compose profile. The dispatcher and workers need queue-scoped permission for `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, and `sqs:GetQueueAttributes`. OVO does not provision AWS resources during bootstrap.

## Recordings and data

The compact profile mounts the same `recordings-data` volume into the API and both workers. PostgreSQL state uses `postgres-data`. This is durable across container replacement on one host and shared by the compact workers.

For multi-host production, use the supported S3-compatible recording backend instead of a host-local named volume. Never claim a local volume is shared across hosts.

## Enabling real calls

The bootstrap deliberately sets these values to false:

- `OVO_LIVE_DIAL_ENABLED`
- `OVO_INBOUND_ENABLED`
- `OVO_TRANSPORT_CERTIFIED`
- `OVO_PROVIDER_EVALUATIONS_ENABLED`

Do not enable them merely to make a readiness indicator green. Real calls additionally require:

1. a publicly reachable HTTPS/WSS media gateway and the exact `OVO_MEDIA_PUBLIC_BASE_URL`;
2. verified carrier credentials and an owned/permitted caller ID;
3. `OVO_INBOUND_ROUTE_SECRET` retained as an installation secret;
4. configured write-only provider credentials and immutable provider bindings;
5. cost cards, FX version and budget policy;
6. completed carrier/provider transport certification before setting `OVO_TRANSPORT_CERTIFIED=true`.

The local stack remains useful for administration, fixtures, deterministic evaluations and persisted evidence while these external integrations are disabled.

## Rotating the secrets master key

`OVO_SECRETS_MASTER_KEY` encrypts every stored provider and carrier credential. Each ciphertext written since key versioning records the id of the key that wrote it (a non-secret hash prefix; older ciphertexts carry none and are matched by trial decryption). Replacing the key therefore never orphans credentials as long as the old key stays configured as `OVO_SECRETS_MASTER_KEY_PREVIOUS` until the rewrap below has succeeded.

1. Generate the new key with `openssl rand -hex 32`. In `infra/compose/.env`, move the current value to `OVO_SECRETS_MASTER_KEY_PREVIOUS` and set `OVO_SECRETS_MASTER_KEY` to the new one. Several retired keys may be listed, comma-separated, newest first.
2. Keep inbound admission off, wait for active calls to finish, then recreate the services: `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d`. The API and gateway decrypt with either key from now on.
3. Prove every credential is readable, then rewrap it under the new key:

   ```sh
   docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml \
     --profile tools run --rm secrets-rewrap --dry-run
   docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml \
     --profile tools run --rm secrets-rewrap
   ```

   Each run prints one JSON line per workspace with the key ids and the counts `current`, `pending`, `rewrapped`, `skipped` and `failed`; it never prints a credential value and exits non-zero when anything failed. A rewrap stores the same value as a new credential version, so the credential's fingerprint is unchanged. It refuses to overwrite a credential that is rotated concurrently; rerun it. The tool builds the `workspace` image stage the first time it runs. Pass `--workspace <id>` to target a workspace other than `OVO_ORGANIZATION_ID`.

4. Run the dry run again and confirm every active credential is `current`. Only then remove `OVO_SECRETS_MASTER_KEY_PREVIOUS` and recreate the services.

Workers currently read only `OVO_SECRETS_MASTER_KEY`, so until they also honor the previous key, run steps 2 and 3 back to back while no calls are admitted. Superseded credential versions stay encrypted under the old key and are never read again; if the old key was disclosed, also reissue each provider secret and rotate it with `POST /v1/credentials/:id/rotate`. Keep the old key with any database backup taken before the rotation: restoring that backup needs it.

## Troubleshooting

Inspect health and bounded logs:

```sh
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml logs --tail=100 api console
```

- `tls_required` on localhost means `OVO_ALLOW_LOCAL_HTTP=true` was not applied to the API container. The setting is safe only with the Compose file's loopback-only published ports.
- `recordings_unavailable` usually means the API recording volume/configuration is missing.
- A worker in `dial-disabled` is healthy when live dialing is false.
- A managed database connection failure should be fixed in `DATABASE_URL`/TLS configuration; OVO does not silently fall back to local PostgreSQL.
