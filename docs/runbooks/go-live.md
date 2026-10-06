# Go live on the Compose host (ovo-dev): from Wave 1 to steady state

**Who:** the founder, on the build machine (Mac mini) and the GCP VM.
**Scope:** bringing the existing ovo-dev stack (last deployed before Wave 1) up to `ovo/waves-1-5` and
keeping it live. Every operator action from the Wave 1-5 integration reports is listed below, in the
order to do it. Nothing here was run against the VM, Twilio or GCS while it was written; the scripts
were tested against fakes only.

Related: [deploy and redeploy](deploy-ovo-dev.md) · [GCP host, alerting and Spot](compact-gcp.md) ·
[offsite backups](offsite-backups.md) · [env reference](../env-reference.md) ·
[first-call evidence](first-real-call.md) · [self-hosted Compose](self-hosted-compose.md)

## 0. Before touching the VM

1. **Rotate** every credential that was ever pasted in chat (OpenAI, AssemblyAI, the decision
   provider, the Twilio auth token, the admin password). Rotate provider keys in the console with
   `POST /v1/credentials/:id/rotate`.
2. **Disk snapshot** of the VM's boot disk (`gcloud compute disks snapshot <disk> --zone <zone>`).
   It is the rollback point until the first offsite backup (step 2.5) exists.
3. Record the Twilio number's current Voice URL, Voice method, status callback and status method.
   `scripts/deploy/ovo-live.sh status` prints them once `.env.ops` exists (step 2.3).

## 1. Build the images on the Mac mini (OPS-9)

```sh
git checkout ovo/waves-1-5
scripts/deploy/build-images.sh --registry asia-south1-docker.pkg.dev/<project>/ovo --push
# -> infra/compose/.deploy/images-<revision>.env (digest-pinned); copy it to the VM
```

Waves 2 and 4 added dependencies (`@ai-sdk/openai` 4.0.84, `pg` and `zod` in plugins, the ElevenLabs
TTS/STT packages, a workspace link in the worker), so **every image must be rebuilt**; an image from
before Wave 2 cannot run this code. The VM pulls with its service account: grant it
`roles/artifactregistry.reader` and run `gcloud auth configure-docker asia-south1-docker.pkg.dev` once.

## 2. One-time host setup on the VM

1. **Pull the branch** into the existing checkout (`git fetch origin && git checkout ovo/waves-1-5`
   is done by the deploy in step 3; this step only needs the scripts).
2. **Public origin and proxy (OPS-8):** `scripts/bootstrap-compose.sh --public-host <voice host>`.
   It keeps every existing secret, sets `OVO_MEDIA_PUBLIC_BASE_URL=https://<host>` and
   `OVO_ALLOW_LOCAL_HTTP=false`, removes the `disabled-local-*` Twilio placeholders (Wave 1, OPS-2),
   and writes `infra/compose/Caddyfile`. Compare it with the Caddy config the VM runs today; it must
   route `/carriers/*` (with WebSocket upgrades) and `/ovo-gateway-health` to the gateway and
   everything else to the console. Install it:
   `sudo install -m 644 infra/compose/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
3. **Ops settings:** create `infra/compose/.env.ops` (mode 0600; `.env*` is git-ignored) with the
   `OVO_OPS_*` values from [the env reference](../env-reference.md#host-side-ops-variables-infracomposeenvops):
   a Twilio API key (SID + secret) restricted to this account, the number, the fallback TwiML URL
   (paste `infra/twilio/fallback-twiml.xml` into a TwiML Bin), the backup bucket, the age recipient
   and the heartbeat URL. `OVO_OPS_ADMIN_EMAIL`/`OVO_OPS_ADMIN_PASSWORD` are added in step 5.0, once
   the console runs the new code.
4. **Host units (OPS-11/12/17):** `sudo apt-get install -y age` then
   `sudo scripts/ops/install-host-units.sh --apply`. That installs `ovo-compose.service`, the nightly
   `ovo-backup.timer`, the journald cap and the logrotate policy, and `/etc/docker/daemon.json` if
   none exists (log limits, `live-restore`). Restart Docker for daemon.json only while no call is up.
5. **Backup bucket (OPS-12):** `scripts/backup/gcs-bucket-setup.sh --project <p> --bucket <b> --service-account <vm sa>`,
   read the printed commands, rerun with `--apply`. Keep the age **private** key offline (password
   manager plus a printed copy): it is the only way to read a backup, including the master key in it.
6. **Monitoring (OPS-11):** create an email notification channel in Cloud Monitoring, then
   `scripts/ops/gcp-monitoring-setup.sh --project <p> --zone <z> --instance ovo-dev --host <voice host> --notification-channel <id>`
   (add `--on-demand` if the VM is not Spot), read the plan, rerun with `--apply`.
   Read [compact-gcp.md](compact-gcp.md) on Spot before putting a customer number on this VM.

## 3. Deploy (Waves 1-5 code, schema and Compose changes)

```sh
scripts/deploy/deploy-compose.sh --ref ovo/waves-1-5 --images ~/images-<revision>.env
```

What this applies, so nothing has to be done by hand:

- **Compose (Waves 1, 2, 4, 5):** `OVO_CARRIER_ENV_BINDINGS='{}'` and no `TWILIO_*` interpolation;
  `stop_grace_period: 300s` with a 240 s gateway drain and the worker SIGTERM drain (OPS-6); the
  `secrets-rewrap` tool profile; forwarding of every Wave 1-4 worker variable (`OVO_SPEECH_*`,
  `OVO_SPEECH_PERCALL_*`, `OVO_STT_PRECONNECT`, `OVO_WORKER_DRAIN_TIMEOUT_MS`,
  `OVO_NET_KEEP_ALIVE_*`, `OVO_PROVIDER_PREWARM`, `OVO_LLM_*`, telemetry queue/pool sizes); and log
  rotation on every container (OPS-17).
- **Migrations, all at service startup, safe to run concurrently:** Wave 1 telemetry migration 3
  (`ovo_telemetry_turns`); Wave 2 ledger `003_price_card_model.sql` and speech cache
  `001_speech_clips.sql` (`ovo_speech_clips`, `ovo_speech_clip_refs`, `ovo_speech_prerender_jobs`);
  Wave 3 `ovo_session_events` and `ovo_call_outcomes`. Wave 4 has none. The deploy starts the API
  alone first; it reaching healthy means its migrations ran.
- **Restart order:** API, dispatcher, console, then worker-1, worker-2 and the gateway one at a time,
  each worker after its call ends (up to `--drain-timeout`, then its own 240 s drain).

The deploy runs `verify-compose.sh` at the end. While inbound is still off, expect the dispatcher's
inbound report to say `admission disabled` with `readyWorkers` ≥ 1 (Wave 1, OPS-4).

## 4. Database checks after the first deploy

- **Connections:** Waves 2-3 added up to 10 PostgreSQL connections per worker (speech-clip pool 4,
  pre-render 4, outcomes 2) and 2 on the API. With the bundled PostgreSQL:
  `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml exec -T postgres psql -U ovo -d ovo -c "select count(*) from pg_stat_activity"`
  must stay well below `max_connections` (300 for the bundled PostgreSQL since Wave 5; check a managed
  database's own limit) during a call. If not, lower `OVO_SPEECH_PRERENDER_CONCURRENCY` in `.env`.
- **search_path (Wave 1):** the readiness probe follows `search_path`; confirm no schema named after
  the database role holds `ovo_*` tables: `select schemaname from pg_tables where tablename like 'ovo\_%' group by 1`
  must print only `public`.

## 5. Console configuration (Waves 1-4)

In this order, in the admin console:

0. **Accounts** (Wave 5, OPS-15): sign in as the seed administrator; the console asks for a new
   password, because the bootstrap `OVO_SEED_ADMIN_PASSWORD` is only good for that one sign-in. Then
   add a second **admin** user for the scripts, sign in as it once to give it its own password, and
   put both values in `infra/compose/.env.ops` as `OVO_OPS_ADMIN_EMAIL` and `OVO_OPS_ADMIN_PASSWORD`.
   `verify-live.sh`, `ovo-live.sh on` and every deploy with inbound on sign in as this account and
   stop without it; they never use the seed password.
1. **Twilio** (Wave 1, OPS-2): a credential holding the auth token, and a carrier binding
   `@winsendotai/ovo-carrier-twilio` with `config: {"accountSid": "AC…"}`. `GET /v1/provider-bindings`
   must list no `env` Twilio binding.
2. **ElevenLabs** (Wave 2): an `elevenlabs` credential; a TTS binding `@winsendotai/ovo-tts-elevenlabs`
   (model `eleven_flash_v2_5`, voice `ZUrEGyu8GFMwnHbvLhv2`, `ulaw_8000`); an STT binding
   `@winsendotai/ovo-stt-elevenlabs` (Scribe v2 realtime). With Scribe, select the energy VAD
   (`@winsendotai/ovo-vad-energy`; the publish check warns without it). Keep the OpenAI TTS binding
   as the fallback.
3. **AssemblyAI** (Wave 1, if kept): set `connectTimeoutMs: 4000` and/or a `fallbackRegion` on the
   live binding; the 3 s default failed handshakes from asia-south1. Since Wave 3 a binding that sets
   no turn fields uses the `fast` preset.
4. **Prices** (Wave 2, OPS-13/14): `POST /v1/cost/price-catalog/import`, then confirm cards exist for
   `elevenlabs.streaming-tts.characters`, `elevenlabs.streaming-stt.audio_seconds` and every meter
   in the agent's required-meters checklist. gpt-6-luna is provisional ($0.1 / $0.01 / $0.125 / $0.5
   per 1M tokens) until a real price card exists; keep the speculative LLM (LAT-3,
   `decision.speculation.llm`) **off** until then.
5. **Agent** (Waves 2-4): import the flow (`pnpm flow:import --preset creditmantri`, Wave 3), bind
   the decision provider (Jev), set `speechCache.enabled`, optionally the LAT-6 filler
   (`voice.turnDetector.config.filler`, needs the speech cache), then **re-release** the agent.
   Pre-render starts on the workers and spends TTS money once per release
   (`GET /v1/agents/:id/releases/:rid/speech-clips` reaches `done`).
6. **Inbound route and policy:** the bounded `busy` overflow policy and one enabled route for the
   number with the release and the Twilio `carrierBindingId` (see [first-real-call.md](first-real-call.md) step 6).

Behaviour that changes by default for existing releases, to listen for on the first call: Indian
number/date verbalisation and new cache keys (Wave 2); the 800 ms decision timeout (Wave 2; revert
`eead9c3` if decisions time out); AssemblyAI `fast` (Wave 3); LAT-4 speculative Jev on partials,
AGT-9 backchannels and AGT-10 stale-turn merging, one ElevenLabs context per reply (Wave 4). To cut
TTS spend on unanswered outbound calls set `OVO_SPEECH_PERCALL_SCOPE=opening` in `.env` and redeploy.

## 6. Turn it on

```sh
scripts/deploy/ovo-live.sh on        # flags on (drained restart), live checks, switch the number, re-verify
scripts/ops/verify-live.sh           # any time: "will the number answer?"
```

`on` stops before touching the number if any live check fails: `OVO_ALLOW_LOCAL_HTTP=false` inside
the running API, live flags in every container, the public certificate and WSS upgrade path, a
ready worker, at least one protected inbound slot, a live-ready release on every enabled route.
After switching it checks that the number's Voice URL and status callback equal the console's
`/carrier-urls` and that its Voice fallback is the TwiML Bin.

Then make the first call and collect the evidence in [first-real-call.md](first-real-call.md)
("Evidence to retain"), comparing `GET /v1/calls/:id/turns` with the Wave 1 baseline (LLM turns
2.5-4.7 s, Jev-only 0.9-1.9 s end of speech to first audio).

## 7. After the release is confirmed good

- `secrets-rewrap` (Wave 1): only now, because rewrapped ciphertext rules out rolling back below
  key versioning. See "Rotating the secrets master key" in [self-hosted-compose.md](self-hosted-compose.md).
- First restore drill: `scripts/backup/restore-drill.sh --identity <age key file>` (monthly after
  that; see [offsite-backups.md](offsite-backups.md)).
- Turn it off at any time with `scripts/deploy/ovo-live.sh off` (immediate; callers hear the fallback).

## Other Wave 5 lanes

What the inspector, outbound, telephony and extras lanes add, from the Wave 5 integration report.

- **Migrations, at service startup (step 3 runs them):** operations `008_outbound_compliance.sql`
  (campaign `calling_window` and `variables_schema`, the `invalid` contact state, do-not-call
  `source`/`call_id`/`updated_at`); the API's callback schema v1 (`ovo_callbacks`, tracked in
  `ovo_callback_schema_migrations`, plus a partial index on `ovo_session_events` built without
  `CONCURRENTLY`, so it briefly blocks event writes on a large table: deploy while idle).
- **Compose:** the bundled PostgreSQL now starts with `max_connections=300` (each worker holds about
  15 connections on a call; see `tests/load/README.md`), so step 3 recreates the `postgres`
  container once. `OVO_HEALTH_TOKEN` (gateway, workers) and `OVO_SESSION_TTL_SECONDS` (API) are
  forwarded empty by default; see [env-reference.md](../env-reference.md).
- **Optional `.env`:** `OVO_HEALTH_TOKEN=<random>` enables `/health?verbose=1` on the gateway and
  workers and is what you pass as a bearer token when debugging a refused call.
- **Accounts:** every console user whose password fails the OPS-15 policy (12+ characters, three
  character types or a 20+ passphrase) is asked to change it at next sign-in; five wrong passwords
  lock an account for 15 minutes. Keep `OVO_SEED_ADMIN_PASSWORD` in `.env` (Compose requires it); the
  API refuses it as a password once changed.
- **Twilio stream status (OBS-11):** inbound `<Stream>` now carries a signed `statusCallback`; nothing
  to paste. A call whose terminal status callback never arrives is reconciled with Twilio once after
  15 s, which releases its inbound slot.
- **Console, per agent (all off by default, existing releases unchanged):** Compliance (calling
  hours, recording disclosure line, opt-out) and Turn pacing (backchannels, filler, speculation,
  `reply.minFirstWords`) panels in Studio; the `handoff` block (transfer target and triggers,
  callbacks) has no Studio panel yet and is set in the agent's JSON. Any change needs a
  **re-release** so the disclosure, opt-out and handoff lines are pre-rendered. The do-not-call list
  (formerly suppressions) and Operations > Callbacks are console pages.
- **Diagnostics:** `GET /v1/diagnostics/live-path` (admin) answers 200 when a live call can go
  through, or 503 naming the blocking stage, without calling a provider.
- **Indian DID:** [indian-did.md](indian-did.md) (Plivo; Exotel stays held) and
  [../residency.md](../residency.md) before buying a number.
