# Environment and deployment inventory

For whoever hosts OVO. Written 2026-10-04, against `vorflux/ovo-foundation` at Wave 2 complete.

OVO has **never handled a real phone call**. Every latency, barge-in and cost figure in this
repository is measured against fixtures and loopback only. Treat published targets as targets.

## Shape

Five services. One `docker compose up` for small scale; Fargate + RDS for enterprise. The dual
target is deliberate — see `docs/architecture/plugin-platform.md`.

| Service      | Role                                                    |
| ------------ | ------------------------------------------------------- |
| `api`        | Management API + the console's backend. TLS-terminated. |
| `console`    | Next.js operator UI.                                    |
| `gateway`    | Carrier media. Needs a public **HTTPS + WSS** origin.   |
| `worker`     | Runs sessions. Two replicas, task-protected.            |
| `dispatcher` | Capacity signals, DLQ reconciliation, background tasks. |

Backing services: PostgreSQL (durable state — the queue carries work signals only), and an SQS-
compatible queue (ElasticMQ locally, SQS on AWS).

## Hard requirements — the process refuses to start without these

Enforced by `required(env, …)` in `packages/distribution/src/profiles/*.ts`:

| Variable          | Notes                                                      |
| ----------------- | ---------------------------------------------------------- |
| `DATABASE_URL`    | PostgreSQL. SQLite exists but is never used in production. |
| `OVO_QUEUE_URL`   | Jobs queue.                                                |
| `OVO_DLQ_URL`     | Dead-letter queue. The dispatcher profile requires it.     |
| `AWS_REGION`      | Also required for ElasticMQ; `local` credentials are fine. |
| `OVO_ENVIRONMENT` | Deployment label.                                          |

## Secrets — generate real values, never the `.env.example` placeholders

| Variable                                           | Constraint                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `OVO_SESSION_SECRET`                               | **≥32 UTF-8 bytes.** Production throws on start otherwise (M1 #14). Bytes, not characters. |
| `OVO_SECRETS_MASTER_KEY`                           | 32-byte hex or base64. Encrypts the credential store.                                      |
| `OVO_SECRETS_MASTER_KEY_PREVIOUS`                  | Optional, comma-separated retired master keys that still decrypt until `secrets-rewrap`.   |
| `OVO_MEDIA_WORKER_TOKEN`                           | Gateway↔worker bearer. Gateway and both workers must match.                                |
| `OVO_INBOUND_ROUTE_SECRET`                         | ≥32 chars. API, gateway and both workers must match.                                       |
| `POSTGRES_PASSWORD`                                | —                                                                                          |
| `OVO_SEED_ADMIN_EMAIL` / `OVO_SEED_ADMIN_PASSWORD` | First console login.                                                                       |

Keep these out of shell history and out of any release config.

## Public reachability

`OVO_MEDIA_PUBLIC_BASE_URL` — the exact public **HTTPS origin**, including an explicit port if one
is used. The carrier reaches this. It needs a valid certificate and a working WSS upgrade route.
This is normally the only thing a new deployment is missing.

## Safety flags

Default `false`. They are not ceremony — each one gates a path that can touch the real world.

| Flag                               | Default           | What it gates                                                                                                           |
| ---------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OVO_LIVE_DIAL_ENABLED`            | `false`           | Outbound dialling.                                                                                                      |
| `OVO_INBOUND_ENABLED`              | `false`           | Inbound admission; maps to worker protected-capacity registration. The dispatcher reports readiness without it.         |
| `OVO_TRANSPORT_CERTIFIED`          | `false`           | Worker readiness gate.                                                                                                  |
| `OVO_PROVIDER_EVALUATIONS_ENABLED` | `false`           | Paid evaluation runs.                                                                                                   |
| `OVO_ALLOW_LOCAL_HTTP`             | `true` in Compose | **Must be `false` for a public API**, and verified _inside the running container_ — setting it in a file is not enough. |

## Logging and transcript telemetry

| Variable                               | Default | Effect                                                                                                                      |
| -------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `OVO_LOG_LEVEL`                        | `info`  | `debug`, `info`, `warn` or `error` for every service's JSON-lines log and the API request log. Unknown values mean `info`.  |
| `OVO_TELEMETRY_TRANSCRIPT_TEXT`        | `store` | Workers only. `omit` blanks caller and agent words in call events and `GET /v1/calls/:id/turns`. Other values refuse start. |
| `OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS` | empty   | Workers only. Per-agent overrides, `agent-id=omit,other-id=store`.                                                          |

## Carrier and provider credentials are NOT environment variables

Create them in the **admin console**: a credential holding the secret, then a provider binding
referencing it. Twilio, Deepgram, OpenAI, Sarvam and TypeSafe (the decision slot) all work this way.
Secrets belong in the encrypted credential store.

A TypeSafe binding additionally requires a **`calibrationLabel`**, naming the cohort whose confidence
numbers the thresholds are set against. It has no default on purpose: a default would hand every
release a calibration identity nobody chose. No per-language calibration has been measured, so the
label records which cohort was _claimed_, not one that was verified.

Compose sets `OVO_CARRIER_ENV_BINDINGS` to `{}` and does not read `TWILIO_ACCOUNT_SID` or
`TWILIO_AUTH_TOKEN`. Wherever env bindings are read, an entry whose account or token is blank,
`not-configured`, `disabled-local-*` or `replace-with-*` is dropped, and each process logs a
`carrier_env_bindings` line naming the active and ignored carriers (never their values).
`scripts/verify-compose.sh` fails if any Compose service still carries an env carrier binding.

## Verifying a deployment without touching a carrier

```
pnpm install --frozen-lockfile --offline   # must exit 0
pnpm check                                 # lint, format, typecheck, tests, build, audit, console e2e
GET /v1/readiness                          # per-agent release readiness
GET /v1/operations/inbound/capacity        # after go-live: at least one ready protected slot
dispatcher GET /health → inbound             # before go-live: ready, with readyWorkers ≥ 1
```

Workers register the protected slots that admit inbound calls only while `OVO_INBOUND_ENABLED=true`,
so `readyProtected` is 0 before go-live by design. The dispatcher's `/health` carries an `inbound`
report (`admissionEnabled`, `readyWorkers`, `readyProtected`, `warmFloor`, `ready`, `reasons`) and
logs an `inbound_readiness` line whenever it changes; `verify-compose.sh` prints it. Use it to check
readiness without enabling admission.

Fixture test calls (`OVO_FIXTURE_TEST_CALLS`) exercise the full session graph — selected engine,
carrier serializer, STT, TTS and behaviour — through FixtureNet with no network. They are
structurally incapable of reaching a carrier: `packages/fixture-calls/src/execute.ts` blocks carrier
control and legacy telephony from crossing into a fixture session, and an egress sentinel asserts
zero attempts. Use them as the preflight.

## Known deployment facts

- The container images are `node:24.8.0-bookworm-slim`. **Not alpine** — LiveKit's native bindings
  are glibc-only and the lockfile pins no musl variants.
- Postgres suites must run `--no-file-parallelism`; the test database is shared.
- `pnpm check` is **not** offline-reproducible: it runs `pnpm audit`, and `check-terraform` downloads
  the AWS provider during `init`. Frozen install itself is offline.
- Terraform is `validate`-only in this repo. No `plan`, no `apply` has ever been run.
