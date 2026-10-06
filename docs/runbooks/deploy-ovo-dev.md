# Deploy, redeploy and roll back the Compose host

**Trigger:** a new revision for ovo-dev (or any single-host Compose install).
**Owner:** the founder. **Signals:** the deploy's `==>` steps, `verify-compose.sh`, `verify-live.sh`.

## Build off the call host (OPS-9)

The call VM has 4 vCPUs and the containers' CPU caps add up to 7.5; building there slows live calls.
Build on the Mac mini instead, for the VM's platform, and push to Artifact Registry by revision:

```sh
scripts/deploy/build-images.sh --registry asia-south1-docker.pkg.dev/<project>/ovo --push
```

- One `docker buildx bake` (`infra/container/docker-bake.hcl`) builds `api`, `console`, `gateway`,
  `dispatcher`, `worker` and `tools` for `linux/amd64` in parallel from shared stages.
- The Dockerfile fetches every dependency from `pnpm-lock.yaml` alone (`pnpm fetch`) before it copies
  any source, then installs offline. A source change reuses the dependency layer; only a lockfile
  change downloads packages again. Runtime images carry only their app's production dependencies.
- Images are `node:24.8.0-bookworm-slim` (glibc; never alpine) and labelled
  `org.opencontainers.image.revision`; `OVO_REVISION` is set inside each container.
- It refuses an uncommitted tree (`--allow-dirty` tags `<sha>-dirty`), and writes
  `infra/compose/.deploy/images-<revision>.env`: one `OVO_*_IMAGE=<registry>/ovo-<name>:<rev>@sha256:…`
  line per image. Pinning by digest means the VM runs exactly what was built. Copy that file to the VM.

`--dry-run` prints the bake command; without `--push` the images stay in the local cache.

## Deploy (OPS-8)

```sh
scripts/deploy/deploy-compose.sh --ref <commit, tag or origin/branch> --images images-<revision>.env
```

1. Preflight: the Compose `.env` exists, the checkout is clean, the pin file is well-formed.
2. `git fetch` and a detached checkout of `--ref` (or `--pull` for a fast-forward); the deploy then
   re-runs itself from the new revision, so that revision's own steps apply.
3. `bootstrap-compose.sh` adds any variable a new release introduced; it never changes a set value.
   `compose config --quiet` must render.
4. The pins are written to `.env` and pulled. `--build` builds on the host instead (slow).
5. Backing services (`postgres`, `queue`, per `COMPOSE_PROFILES`), then the **API alone**: every
   service migrates its own schema at startup, so the API turning healthy means the control,
   orchestration, ledger, speech-cache, telemetry and outcome migrations it owns have run.
6. Dispatcher and console, then **worker-1, worker-2, gateway, one at a time**. Compose recreates a
   service only if its image or configuration changed. Before recreating a worker the deploy waits
   (up to `--drain-timeout`, default 600 s) for its call to end; the gateway waits for both workers.
   Past the timeout it proceeds: the container's SIGTERM drain still lets a call finish for up to
   240 s inside the 300 s `stop_grace_period`.
7. `verify-compose.sh`, and `ops/verify-live.sh` when `OVO_INBOUND_ENABLED=true`.
8. A line in `infra/compose/.deploy/history`: time, revision, the pins it ran, the previous revision.

`--dry-run` prints every mutating command and changes nothing. While a deploy recreates the gateway,
new calls get the Twilio Voice fallback (the number's fallback URL, set by `ovo-live.sh on`).

## Roll back

```sh
scripts/deploy/deploy-compose.sh --rollback
```

Redeploys the previous history entry: its revision and its image pins (pulled again by digest), or a
rebuild when that deploy built locally. Running it twice returns to where you started. Two limits:

- **Schema:** migrations are forward-only. Every Wave 1-4 migration only adds tables or nullable
  columns, so an older image runs against the newer schema; a future migration that is not additive
  must say so in its release notes (check the Wave 5 lanes' migrations in its integration report).
- **Secrets:** after `secrets-rewrap`, images from before Wave 1's key versioning cannot read the
  credentials (see self-hosted-compose.md). Never roll back across that line.

## Live on/off

```sh
scripts/deploy/ovo-live.sh status
scripts/deploy/ovo-live.sh on       # flags on, drained restart, live checks, switch the number, verify
scripts/deploy/ovo-live.sh off      # number -> fallback TwiML at once; add --flags to also turn admission off
```

`on`/`off` switch the Twilio number's Voice URL through the carrier API with a Twilio API key from
`infra/compose/.env.ops`; the secret travels to the program on stdin, never on a command line. `off`
keeps the status callback on the stack so calls in flight still reconcile. Both accept `--dry-run`.
An Exotel or Plivo DID is switched in that carrier's console (see the telephony runbook).

## Verify any time (OPS-7)

```sh
scripts/ops/verify-live.sh                      # all checks, read-only
scripts/ops/verify-live.sh --save-snapshot s.json
scripts/ops/verify-live.sh --snapshot s.json    # re-evaluate offline, no Docker
```

Each line is `PASS`, `FAIL`, `WARN` or `SKIP` with the reason; the exit code is 1 if anything failed.

| Check                 | Fails when                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-http-off`      | the **running** API has `OVO_ALLOW_LOCAL_HTTP` other than `false`                                                                                                                             |
| `live-flags`          | a running container lacks `OVO_LIVE_DIAL_ENABLED`, `OVO_INBOUND_ENABLED` / `OVO_INBOUND_CAPACITY_ENABLED` or `OVO_TRANSPORT_CERTIFIED`                                                        |
| `public-base-url`     | `OVO_MEDIA_PUBLIC_BASE_URL` is not an https origin, or is still the bootstrap placeholder                                                                                                     |
| `public-tls`          | `https://<host>/ovo-gateway-health` has a bad certificate, is not routed, or the gateway is draining                                                                                          |
| `wss-upgrade`         | an unsigned WebSocket upgrade to the route's media URL is not refused by the gateway itself (401/403): 426 means the proxy drops upgrades, 404 that it strips them or misroutes `/carriers/*` |
| `workers`             | a worker is `dial-disabled`, `failed`, `starting`, `draining` or unreachable (all busy is a warning)                                                                                          |
| `protected-capacity`  | the dispatcher's inbound report is not ready or no protected slot is registered                                                                                                               |
| `routes`              | no enabled inbound route, or one without a carrier binding                                                                                                                                    |
| `releases-live-ready` | a routed release's `GET /v1/agents/:id/readiness` has live blockers                                                                                                                           |
| `carrier-number`      | the number's Voice URL or status callback differ from the console's `/carrier-urls` (skipped without `OVO_OPS_TWILIO_*`)                                                                      |
| `carrier-fallback`    | (warning) the number has no Voice fallback URL to `OVO_OPS_FALLBACK_URL`                                                                                                                      |

## Logs (OPS-17)

Every container's json-file log rotates at 5 × 20 MiB (compressed); the host keeps the journal under
1 GiB (`infra/systemd/journald-ovo.conf`). To debug one service without restarting the others:
`OVO_LOG_LEVEL=debug docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d --no-deps worker-1`
(a worker drains first), and the same command without the variable to go back to `info`.
