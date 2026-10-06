# Environment variable reference

Every `OVO_*` variable the services read, plus the non-`OVO_` variables a deployment must set and
the host-side `OVO_OPS_*` variables of the deploy, live-switch, backup and probe scripts.
`infra/compose/env-reference.test.ts` fails when a variable read in `apps/*/src`, `packages/*/src`
or the console is missing here, or when Compose forwards one that is not listed, so this page cannot
silently fall behind the code.

**Columns.** _Read by_ names the services that read the variable. _Default_ is what the code uses
when the variable is unset **or empty**. _Compose_ says how `infra/compose/compose.yaml` supplies it:

- **set** — Compose sets a fixed value; change `compose.yaml` itself, not `.env`.
- **.env** — interpolated from `infra/compose/.env` (written by `scripts/bootstrap-compose.sh`).
- **fwd** — forwarded from `.env` when present, empty otherwise. Empty means "use the default", so
  you only add the variable to `.env` when you want a different value.
- **—** — not supplied by Compose; the default applies (set it in a Compose override if needed).

Values are case-sensitive. An invalid value stops the service at startup with a message naming the
variable, unless the row says otherwise. Secrets never belong in a provider binding or release config.

## Installation identity, database and queue

| Variable                                                   | Read by                          | Default                          | Compose       | Notes                                                              |
| ---------------------------------------------------------- | -------------------------------- | -------------------------------- | ------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`                                             | all                              | required                         | .env          | PostgreSQL. Percent-encode credentials.                            |
| `OVO_CONTROL_DATABASE_URL`                                 | api, dispatcher, rewrap          | `DATABASE_URL`                   | —             | Separate control database (advanced).                              |
| `OVO_ORCHESTRATION_DATABASE_URL`                           | api                              | `DATABASE_URL`                   | —             | Separate orchestration database (advanced).                        |
| `OVO_OPERATIONS_DATABASE_URL`                              | api, worker                      | `DATABASE_URL`                   | —             | Separate operations database (advanced).                           |
| `OVO_TELEMETRY_DATABASE_URL`                               | worker                           | `DATABASE_URL`                   | —             | Separate telemetry database (advanced).                            |
| `OVO_STORAGE_ADAPTER`                                      | api                              | `sqlite` outside production      | set           | Compose sets `postgres`.                                           |
| `OVO_DATABASE_FILE` / `OVO_SQLITE_FILE`                    | api                              | `./data/ovo.sqlite`              | —             | Local development only.                                            |
| `OVO_CONTROL_DB_POOL_MAX`                                  | api                              | adapter default                  | —             | Control-store pool size.                                           |
| `OVO_INFRASTRUCTURE_PG_MAX_CONNECTIONS`                    | api                              | 2                                | —             | Orchestration pool on the API.                                     |
| `OVO_OPERATIONS_PG_MAX_CONNECTIONS`                        | api, worker                      | 5 (api), plugin default (worker) | fwd (workers) | Worker range 1–20.                                                 |
| `OVO_ORGANIZATION_ID`                                      | all                              | required (`local` on the API)    | .env          | The single organization this installation serves.                  |
| `OVO_ENVIRONMENT`                                          | dispatcher (+ all labels)        | required on Fargate              | set           | Compose sets `compact`.                                            |
| `OVO_DEPLOYMENT_PROFILE`                                   | api, dispatcher, gateway, worker | `compose`                        | —             | `fargate` switches to the ECS profile.                             |
| `OVO_QUEUE_URL`                                            | dispatcher, worker               | required                         | .env          | Jobs queue.                                                        |
| `OVO_DLQ_URL`                                              | dispatcher                       | required                         | .env          | Dead-letter queue.                                                 |
| `OVO_SQS_ENDPOINT`                                         | dispatcher, worker               | AWS SQS                          | .env          | `http://queue:9324` for the bundled ElasticMQ; empty for real SQS. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | dispatcher, worker, api          | required region                  | .env          | `local` credentials work with ElasticMQ.                           |
| `POSTGRES_PASSWORD`                                        | postgres (Compose)               | required with `local-postgres`   | .env          | Bundled PostgreSQL only.                                           |
| `COMPOSE_PROFILES`                                         | Compose                          | `local-postgres,local-queue`     | .env          | Drop a profile to use a managed service.                           |

## Authentication and the console

| Variable                                    | Read by     | Default                              | Compose | Notes                                                                                                                    |
| ------------------------------------------- | ----------- | ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `OVO_SESSION_SECRET`                        | api         | per-process random (dev)             | .env    | At least 32 UTF-8 bytes in production. Rotating it signs everyone out.                                                   |
| `OVO_SEED_ADMIN_EMAIL`                      | api         | none                                 | .env    | First administrator, inserted only into an empty installation.                                                           |
| `OVO_SEED_ADMIN_PASSWORD`                   | api         | none                                 | .env    | 12–128 dotenv-safe characters. Bootstrap only: the ops scripts never sign in with it (see `OVO_OPS_ADMIN_*`).            |
| `OVO_SEED_ADMIN_LABEL`                      | api         | none                                 | .env    |                                                                                                                          |
| `OVO_RESTORE_ADMIN_RECOVERY`                | api         | `false`                              | .env    | One-shot recovery after a restore; see `runbooks/backup-restore.md`. Never leave it `true`.                              |
| `OVO_ADMIN_ID`, `OVO_ADMIN_LABEL`           | api         | `local-admin`, `Local administrator` | .env    |                                                                                                                          |
| `OVO_ADMIN_WORKSPACE_ID`                    | api, rewrap | `OVO_ORGANIZATION_ID`                | set     |                                                                                                                          |
| `OVO_ADMIN_TOKEN`                           | api         | none (token auth off)                | —       | Legacy bearer token.                                                                                                     |
| `OVO_OPERATORS_JSON`                        | api         | `[]`                                 | —       | Operator metadata; each entry names a `tokenEnv` of the form `OVO_OPERATOR_<NAME>_TOKEN`.                                |
| `OVO_OPERATOR_<NAME>_TOKEN`                 | api         | none                                 | —       | Bearer token per operator listed in `OVO_OPERATORS_JSON`.                                                                |
| `OVO_ALLOW_LOCAL_HTTP`                      | api         | `false`                              | .env    | **Must be `false` on a public host** (bootstrap `--public-host` sets it). `verify-live.sh` checks the running container. |
| `OVO_TRUSTED_PROXY_CIDRS`                   | api         | none                                 | set     | Compose trusts forwarded TLS only from the console's pinned address.                                                     |
| `OVO_CONSOLE_ADDRESS`, `OVO_COMPOSE_SUBNET` | Compose     | `172.29.240.10`, `172.29.240.0/24`   | .env    | Change both together.                                                                                                    |
| `OVO_API_URL`                               | console     | `http://127.0.0.1:4000`              | set     | `http://api:4000` in Compose.                                                                                            |
| `OVO_API_HOST`                              | api         | `0.0.0.0`                            | —       |                                                                                                                          |

## Secrets store

| Variable                          | Read by                      | Default                                                      | Compose | Notes                                                                                                   |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| `OVO_SECRETS_BACKEND`             | api, gateway, rewrap         | `encrypted-store` (Compose), `aws-secrets-manager` (Fargate) | set     | `local`, `encrypted-store` or `aws-secrets-manager`.                                                    |
| `OVO_SECRETS_MASTER_KEY`          | api, gateway, worker, rewrap | required with `encrypted-store`                              | .env    | 32-byte hex or base64. Losing it makes every stored credential unreadable: it is in the offsite backup. |
| `OVO_SECRETS_MASTER_KEY_PREVIOUS` | api, gateway, worker, rewrap | empty                                                        | .env    | Wave 1. Retired keys, comma-separated, newest first, only until `secrets-rewrap` reports all current.   |

## Media, carriers and live admission

| Variable                                 | Read by                          | Default                            | Compose                       | Notes                                                                                                     |
| ---------------------------------------- | -------------------------------- | ---------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `OVO_MEDIA_PUBLIC_BASE_URL`              | api, gateway, worker             | required                           | .env                          | Exact public **HTTPS origin** (no path) the carrier reaches, with a working WSS upgrade on `/carriers/*`. |
| `OVO_INBOUND_ROUTE_SECRET`               | api, gateway, worker             | required                           | .env                          | At least 32 characters; signs carrier URLs. Changing it invalidates every pasted carrier URL.             |
| `OVO_MEDIA_WORKER_TOKEN`                 | gateway, worker                  | required                           | .env                          | Gateway↔worker bearer token.                                                                              |
| `OVO_MEDIA_GATEWAY_WS_URL`               | worker                           | required                           | set                           | `ws://gateway:4001/worker`.                                                                               |
| `OVO_MEDIA_READINESS_URL`                | worker                           | required                           | set                           | `http://gateway:4001/health`.                                                                             |
| `OVO_MEDIA_HOST`, `OVO_MEDIA_PORT`       | gateway                          | `0.0.0.0`, 8080                    | set (port 4001)               |                                                                                                           |
| `OVO_MEDIA_DRAIN_TIMEOUT_MS`             | gateway                          | deregistration delay − 30 s        | set (240000)                  | Must end inside `stop_grace_period: 300s`.                                                                |
| `OVO_MEDIA_DEREGISTRATION_DELAY_SECONDS` | gateway                          | 300                                | —                             | Only used to derive the drain when it is unset.                                                           |
| `OVO_MEDIA_HANDSHAKE_TIMEOUT_MS`         | gateway                          | 5000                               | —                             |                                                                                                           |
| `OVO_MEDIA_IDLE_TIMEOUT_MS`              | gateway                          | 30000                              | —                             |                                                                                                           |
| `OVO_MEDIA_MAX_MESSAGE_BYTES`            | gateway                          | 65536                              | —                             |                                                                                                           |
| `OVO_MEDIA_MAX_AUDIO_FRAME_BYTES`        | gateway                          | 8192                               | —                             |                                                                                                           |
| `OVO_MEDIA_MAX_BUFFERED_BYTES`           | gateway                          | 262144                             | —                             |                                                                                                           |
| `OVO_MEDIA_PRE_ACCEPT_MS`                | gateway                          | 3000 (or pending frames × 20)      | —                             |                                                                                                           |
| `OVO_MEDIA_MAX_PENDING_FRAMES`           | gateway                          | derived from the pre-accept window | —                             |                                                                                                           |
| `OVO_CARRIER_ENV_BINDINGS`               | gateway, worker                  | `{}`                               | set (`'{}'`)                  | Wave 1 (OPS-2). Carrier credentials belong in the console; placeholders are ignored and logged.           |
| `OVO_LIVE_DIAL_ENABLED`                  | api, dispatcher, gateway, worker | `false`                            | .env                          | Real carrier traffic. `scripts/deploy/ovo-live.sh on` sets it.                                            |
| `OVO_INBOUND_ENABLED`                    | gateway, dispatcher              | `false`                            | .env                          | Inbound admission. Compose maps it to the workers' `OVO_INBOUND_CAPACITY_ENABLED`.                        |
| `OVO_INBOUND_CAPACITY_ENABLED`           | worker                           | `false`                            | set (= `OVO_INBOUND_ENABLED`) | Wave 1 (OPS-4). Registers protected inbound slots.                                                        |
| `OVO_INBOUND_WARM_FLOOR`                 | dispatcher, worker               | 0                                  | set (2)                       | Keep it equal to the worker count.                                                                        |
| `OVO_TRANSPORT_CERTIFIED`                | worker                           | `false`                            | .env                          | Worker readiness gate for live transport.                                                                 |
| `OVO_PERMITTED_FROM_NUMBERS`             | api, dispatcher, gateway         | empty                              | .env                          | Comma-separated E.164 caller IDs allowed for outbound dials.                                              |
| `OVO_HANDOFF_PROVIDER`                   | api                              | none                               | —                             | Only `carrier` is accepted.                                                                               |
| `OVO_FIXTURE_TEST_CALLS`                 | api                              | `false`                            | set (`true`)                  | Fixture calls cannot reach a carrier.                                                                     |
| `OVO_PROVIDER_EVALUATIONS_ENABLED`       | api                              | `false`                            | .env                          | Paid provider evaluation runs.                                                                            |

## Capacity, dispatcher and worker process

| Variable                                | Read by         | Default                                     | Compose                   | Notes                                                                                                        |
| --------------------------------------- | --------------- | ------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `OVO_WORKER_MAX_CAPACITY`               | api, dispatcher | 100 (dispatcher), unset (api)               | set (2)                   | Live readiness refuses admission without a ceiling.                                                          |
| `OVO_CAPACITY_SIGNAL`                   | dispatcher      | profile default                             | set (`log`)               | Compose never writes ECS desired count.                                                                      |
| `OVO_CAPACITY_MAX_AGE_MS`               | api, dispatcher | 15000                                       | —                         | Heartbeat freshness.                                                                                         |
| `OVO_PERMITTED_STARTS`                  | dispatcher      | 10                                          | —                         | Admission horizon.                                                                                           |
| `OVO_PREWARM_LEAD_SECONDS`              | dispatcher      | 600                                         | —                         |                                                                                                              |
| `OVO_CARRIER_CONCURRENCY`               | dispatcher      | 100                                         | set (2)                   |                                                                                                              |
| `OVO_PROVIDER_CONCURRENCY`              | dispatcher      | 100                                         | set (2)                   |                                                                                                              |
| `OVO_SPEND_PERMITTED_STARTS`            | dispatcher      | 100                                         | set (2)                   |                                                                                                              |
| `OVO_AWS_TASK_LIMIT`                    | nothing         | —                                           | set (2)                   | Not read by any service today; kept in Compose for parity with older releases.                               |
| `OVO_COMPOSE_WORKERS`                   | dispatcher      | 2                                           | —                         | Fixed worker count in the Compose profile.                                                                   |
| `OVO_ECS_CLUSTER`, `OVO_WORKER_SERVICE` | dispatcher      | required on Fargate                         | —                         |                                                                                                              |
| `OVO_WORKER_ID`                         | worker          | `compact-<pid>` / ECS task ARN              | set                       | Distinct per worker.                                                                                         |
| `OVO_WORKER_ENDPOINT`                   | worker          | required outside ECS                        | set                       | `ws://worker-N:4100/internal/media`.                                                                         |
| `OVO_CALL_SLOTS`                        | nothing         | —                                           | set (1)                   | Not read by any service today: a worker always holds one call.                                               |
| `OVO_PROTECTION_MODE`                   | worker          | `ecs`                                       | set (`process-lifecycle`) |                                                                                                              |
| `OVO_WORKER_DRAIN_TIMEOUT_MS`           | worker          | 240000 (`process-lifecycle`), 90000 (`ecs`) | fwd                       | Wave 2 (OPS-6). 0–3600000. Keep it at most 270000 under Compose's 300 s grace.                               |
| `OVO_PLUGIN_MODULES`                    | api, worker     | `[]`                                        | .env                      | JSON array of installed extension packages.                                                                  |
| `OVO_PLUGIN_ENFORCEMENT`                | all             | `enforce`                                   | —                         | `warn` relaxes v1 manifests only.                                                                            |
| `OVO_REVISION`                          | all images      | `unknown`                                   | image                     | Wave 5 (OPS-9). Git revision baked in by `build-images.sh`; image label `org.opencontainers.image.revision`. |

## Speech cache and pre-render (Wave 2 TTS-4..11, Wave 4 TTS-10)

All read by the workers from `apps/worker/src/speech-cache-env.ts`; all **fwd** in Compose.

| Variable                               | Default        | Range                                                                      |
| -------------------------------------- | -------------- | -------------------------------------------------------------------------- |
| `OVO_SPEECH_CACHE_TTL_MS`              | plugin default | 1–86400000                                                                 |
| `OVO_SPEECH_CACHE_MAX_ENTRIES`         | plugin default | 1–100000                                                                   |
| `OVO_SPEECH_CACHE_MAX_BYTES`           | plugin default | 1 B–1 GiB                                                                  |
| `OVO_SPEECH_CACHE_MAX_ENTRY_BYTES`     | plugin default | 1 B–64 MiB                                                                 |
| `OVO_SPEECH_CACHE_MAX_PENDING`         | plugin default | 1–10000                                                                    |
| `OVO_SPEECH_CLIPS_MAX_BYTES`           | 256 MiB        | Pinned in-memory clips per worker, 1 B–4 GiB                               |
| `OVO_SPEECH_CLIP_MAX_BYTES`            | 2 MiB          | One clip, 1 B–8 MiB                                                        |
| `OVO_SPEECH_CLIPS_WORKSPACE_MAX_BYTES` | 512 MiB        | Durable clips per workspace, 1 B–64 GiB                                    |
| `OVO_SPEECH_CLIPS_RETENTION_DAYS`      | 30             | 1–3650                                                                     |
| `OVO_SPEECH_PRERENDER_ENABLED`         | `true`         | `true`/`false`. Pre-render spends TTS money for routed releases.           |
| `OVO_SPEECH_PRERENDER_CONCURRENCY`     | 4              | 1–32. Each render may hold a Postgres connection.                          |
| `OVO_SPEECH_PRERENDER_POLL_MS`         | 5000           | 100–3600000                                                                |
| `OVO_SPEECH_PERCALL_ENABLED`           | `true`         | Wave 4 TTS-10. Per-call `{{variable}}` lines, memory only.                 |
| `OVO_SPEECH_PERCALL_SCOPE`             | `all`          | `all` or `opening`. `opening` cuts TTS spend on unanswered outbound calls. |
| `OVO_SPEECH_PERCALL_MAX_LINES`         | 16             | 1–64                                                                       |

## Network, providers and LLM tuning (Waves 2 and 4)

| Variable                    | Read by             | Default                                          | Compose | Notes                                                                        |
| --------------------------- | ------------------- | ------------------------------------------------ | ------- | ---------------------------------------------------------------------------- |
| `OVO_NET_KEEP_ALIVE_MS`     | worker              | net plugin default                               | fwd     | Wave 2 LAT-8. 1000–600000.                                                   |
| `OVO_NET_KEEP_ALIVE_MAX_MS` | worker              | net plugin default                               | fwd     | Wave 2 LAT-8. 1000–3600000.                                                  |
| `OVO_PROVIDER_PREWARM`      | worker              | on                                               | fwd     | Wave 2 LAT-8. Only `false` turns provider pre-warm off.                      |
| `OVO_STT_PRECONNECT`        | worker              | on                                               | fwd     | Wave 4 STT-6. Only `false` connects STT at engine start instead.             |
| `OVO_LLM_REASONING_EFFORT`  | worker (OpenAI LLM) | lowest the model accepts (`none` for gpt-6-luna) | fwd     | Wave 2 LAT-7. A binding field wins over the variable. `unset` sends nothing. |
| `OVO_LLM_TEXT_VERBOSITY`    | worker (OpenAI LLM) | `low` for gpt-5, unset for gpt-6                 | fwd     | Wave 2 LAT-7.                                                                |
| `OVO_LLM_SERVICE_TIER`      | worker (OpenAI LLM) | unset                                            | fwd     | Wave 2 LAT-7.                                                                |
| `OVO_LLM_STORE`             | worker (OpenAI LLM) | `false`                                          | fwd     | Wave 2 LAT-7. `true`/`false`.                                                |

## Logging, telemetry and recordings

| Variable                                                                              | Read by     | Default             | Compose            | Notes                                                                            |
| ------------------------------------------------------------------------------------- | ----------- | ------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `OVO_LOG_LEVEL`                                                                       | all         | `info`              | .env               | Wave 1 (OBS-3). `debug`, `info`, `warn`, `error`. See "Debug one service" below. |
| `OVO_TELEMETRY_TRANSCRIPT_TEXT`                                                       | worker      | `store`             | .env               | Wave 1. `omit` blanks caller and agent words in events and per-turn telemetry.   |
| `OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS`                                                | worker      | empty               | .env               | Wave 1. `agent-id=omit,other-id=store`.                                          |
| `OVO_TELEMETRY_PG_MAX_CONNECTIONS`                                                    | worker      | runtime default     | fwd                | 1–10.                                                                            |
| `OVO_TELEMETRY_RETENTION_DAYS`                                                        | worker      | runtime default     | fwd                | 1–365.                                                                           |
| `OVO_TELEMETRY_MAX_QUEUED_EVENTS`                                                     | worker      | runtime default     | fwd                | 1–100000.                                                                        |
| `OVO_CALL_EVENT_MAX_QUEUED_EVENTS`                                                    | worker      | runtime default     | fwd                | 1–100000.                                                                        |
| `OVO_RECORDINGS_BACKEND`                                                              | api, worker | none                | set (`filesystem`) | `filesystem` or `s3`.                                                            |
| `OVO_RECORDINGS_DIRECTORY`                                                            | api, worker | `./data/recordings` | set                | `/var/lib/ovo-recordings` on the shared `recordings-data` volume.                |
| `OVO_RECORDINGS_DURABLE_MOUNTED`                                                      | api, worker | `false`             | set (`true`)       |                                                                                  |
| `OVO_RECORDINGS_SHARED_ACROSS_WORKERS`                                                | api, worker | `false`             | set (`true`)       |                                                                                  |
| `OVO_RECORDINGS_BUCKET`, `OVO_RECORDINGS_ENDPOINT`, `OVO_RECORDINGS_FORCE_PATH_STYLE` | api, worker | none                | —                  | S3-compatible backend.                                                           |
| `OVO_RECORDING_RETENTION_DAYS`                                                        | api, worker | 30                  | .env               | 1–365.                                                                           |

**Debug one service.** Shell variables override `.env` during Compose interpolation, so a single
service can log at `debug` without touching the others:
`OVO_LOG_LEVEL=debug docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d --no-deps worker-1`.
That recreates the container (a worker drains first). Run the same command without the variable to
return it to `info`. Container logs rotate at 5 × 20 MiB per container (OPS-17).

## Compose image pins and host ports

| Variable                                                                                                                 | Default                       | Notes                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `OVO_API_IMAGE`, `OVO_CONSOLE_IMAGE`, `OVO_GATEWAY_IMAGE`, `OVO_DISPATCHER_IMAGE`, `OVO_WORKER_IMAGE`, `OVO_TOOLS_IMAGE` | `ovo-<name>:local`            | `deploy-compose.sh --images FILE` pins them to registry digests built by `build-images.sh`. |
| `API_PORT`, `CONSOLE_PORT`, `GATEWAY_PORT`, `POSTGRES_PORT`, `ELASTICMQ_PORT`                                            | 4000, 3000, 4001, 54329, 9324 | Published on 127.0.0.1 only. A host reverse proxy (`infra/caddy`) fronts them.              |

## Host-side ops variables (`infra/compose/.env.ops`)

Read only by `scripts/deploy/*`, `scripts/ops/*` and `scripts/backup/*` on the host; never passed to
a container's environment. Keep the file mode 0600 (`.env*` files are git-ignored). The scripts parse
it as `KEY=VALUE` lines; they never `source` it.

| Variable                                        | Used by                               | Notes                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OVO_OPS_TWILIO_ACCOUNT_SID`                    | ovo-live, verify-live                 | `AC…` of the account that owns the number.                                                                                                                                                                                                                                                                                               |
| `OVO_OPS_TWILIO_API_KEY_SID`                    | ovo-live, verify-live                 | `SK…` of a Twilio API key (preferred), or the Account SID when using the auth token.                                                                                                                                                                                                                                                     |
| `OVO_OPS_TWILIO_API_KEY_SECRET`                 | ovo-live, verify-live                 | The API key secret (or auth token). Rotate it like any credential.                                                                                                                                                                                                                                                                       |
| `OVO_OPS_TWILIO_NUMBER`                         | ovo-live, verify-live                 | The E.164 number to switch, for example `+12025550123`.                                                                                                                                                                                                                                                                                  |
| `OVO_OPS_FALLBACK_URL`                          | ovo-live, verify-live                 | TwiML Bin (or any TwiML URL) callers hear when the stack is off or failing (`infra/twilio/fallback-twiml.xml`).                                                                                                                                                                                                                          |
| `OVO_OPS_TWILIO_API_BASE`                       | ovo-live, verify-live                 | Default `https://api.twilio.com`; tests point it at a fake.                                                                                                                                                                                                                                                                              |
| `OVO_OPS_ADMIN_EMAIL`, `OVO_OPS_ADMIN_PASSWORD` | ovo-live, verify-live, deploy-compose | **Required** for `verify-live.sh`, `ovo-live.sh on` and a deploy with inbound on. A console **administrator** (carrier URLs need the admin role) created for the scripts, never the seed account: since OPS-15 the bootstrap `OVO_SEED_ADMIN_PASSWORD` signs in only to change it. Its password must pass the console's password policy. |
| `OVO_OPS_PUBLIC_PROBE_BASE`                     | verify-live                           | Default `OVO_MEDIA_PUBLIC_BASE_URL`.                                                                                                                                                                                                                                                                                                     |
| `OVO_OPS_ALERT_WEBHOOK_URL`                     | uptime-probe                          | Slack-compatible incoming webhook (`{"text": …}`).                                                                                                                                                                                                                                                                                       |
| `OVO_OPS_BACKUP_BUCKET`                         | ovo-backup, restore-drill             | `gs://<bucket>` in asia-south1, versioned, created by `scripts/backup/gcs-bucket-setup.sh`.                                                                                                                                                                                                                                              |
| `OVO_OPS_BACKUP_AGE_RECIPIENT`                  | ovo-backup                            | `age1…` public key; the private key stays offline with the founder.                                                                                                                                                                                                                                                                      |
| `OVO_OPS_BACKUP_LOCAL_DIR`                      | ovo-backup                            | Default `/var/backups/ovo`.                                                                                                                                                                                                                                                                                                              |
| `OVO_OPS_BACKUP_KEEP_LOCAL`                     | ovo-backup                            | Newest local archives kept, default 3.                                                                                                                                                                                                                                                                                                   |
| `OVO_OPS_BACKUP_HEARTBEAT_URL`                  | ovo-backup                            | Dead-man's-switch URL pinged after a successful backup; alert on no ping for 26 h.                                                                                                                                                                                                                                                       |
| `OVO_OPS_BACKUP_DATABASE_URL`                   | ovo-backup                            | Dump this database instead of `DATABASE_URL` (with `--source url`, e.g. a managed database).                                                                                                                                                                                                                                             |
| `OVO_OPS_BACKUP_RECORDINGS_DIR`                 | ovo-backup                            | Mirror this directory instead of the `recordings-data` volume's mount point.                                                                                                                                                                                                                                                             |
| `OVO_OPS_POLL_SECONDS`                          | deploy-compose, ovo-live              | How often a restart polls a busy worker, default 5.                                                                                                                                                                                                                                                                                      |
| `OVO_OPS_ENDPOINTS`                             | verify-live, ovo-live                 | JSON overriding the in-network console/dispatcher/worker URLs; tests only.                                                                                                                                                                                                                                                               |

Two more variables are read from the calling shell only, never from a file: `OVO_RESTORE_TARGET_URL`
(the isolated database `ovo-restore.sh` restores into) and `OVO_DRILL_SERVER_URL` (a server where
`restore-drill.sh` may create its scratch database; default the bundled PostgreSQL).
