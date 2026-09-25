# Local development and CI

## Requirements

- Node.js 22.19 or newer in the 22.x line, or Node 24+; this checkpoint uses 22.21.0.
- pnpm 10.23.0.
- Docker for optional real local PostgreSQL integration tests.

## Start the console and API

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm dev:api
```

Use another terminal:

```sh
pnpm dev:console
```

Open `http://localhost:3000`. Use the generated admin token from the private `.data/local.env` file in the login form. Never commit or share that file. The setup script does not print keys and does not replace an existing key. Credentials use AES-256-GCM in the local adapter. Losing the master key makes the encrypted credentials unreadable.

The API listens on port 4000. The Next.js server proxies `/api/v1/*` to the configured `OVO_API_URL`. The browser never receives the server's bootstrap environment. Preview hosts belong in the ignored `NEXT_ALLOWED_DEV_ORIGINS` environment setting, not a wildcard production allow-list.

The local profile uses a disk-backed SQLite database. It is a single-process development profile, **not** the distributed Fargate data layer. Simulations do not create carrier calls. Do not use customer credentials, real customer records or production write tools for fixture runs.

## Local CI

GitHub Actions are suspended. Run all required checks locally:

```sh
./scripts/local-ci.sh
```

This uses a frozen lockfile, checks package boundaries and first-party module sizes, verifies imported upstream hashes, checks formatting and strict TypeScript, runs unit/integration fixtures, builds actual backend bundles and the Next.js console, and checks production dependency advisories.

The module-size gate measures canonical formatting; minifying a file cannot bypass it. It caps first-party code at 400 nonblank lines/24 KiB (500 lines for tests). Exact imported upstream files remain hash-locked and retain upstream layout.

Optional PostgreSQL, Terraform and comparative fixture checks have separate commands in the relevant package/evidence documents. The default unit suite may explicitly skip PostgreSQL integration without its test database URL. Such a skip is not a verified database test.

## Evidence boundaries

- Real imported DeepSeek/Cordis code executes in every OVO composition.
- Real SDKs execute against controlled local fixtures where evidence says so.
- Fixture model responses, playback receipts and carrier/AWS mocks are simulations.
- A successful local build is not a Fargate, carrier, billing, backup/restore or live audio certification.
- Do not deploy paid resources, publish packages or place calls without authorization.

See [PM](../PM/README.md) and [progress](progress.md) for the complete remaining project scope.
