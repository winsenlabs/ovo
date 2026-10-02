# OVO build handoff: Wave 2 integration

- **Updated:** 2026-10-02 IST
- **Branch:** vorflux/ovo-foundation
- **Status:** All unheld Wave 2 build units are checker-verified and merged. I1 integration is in progress. C3 (Exotel), C5 (TCN) and C6 (Alohaa) remain founder-held on confirmed vendor contracts.
- **Test Report:** PARTIAL. No real carrier call, paid provider execution, AWS deployment or vendor sandbox confirmation has occurred.
- **Push and PR:** Neither is authorized. Keep changes local.

This is the current builder and checker entry point. [The platform design](../docs/architecture/plugin-platform.md), [unit board](units/README.md) and [I1 spec](units/I1-integration.md) hold the detailed contracts and unresolved carry-forwards. The earlier handoff is archived in [the 2026-09-22 snapshot](handoff/2026-09-22-foundation-handoff.md).

## Delivered architecture

- Contracts v2, manifest v2, guarded plugin context, selected release graphs, scoped secrets and a carrier-neutral gateway are integrated. Native and genuine LiveKit engines can be selected per agent. A third synthetic engine also passed the seam in the E3 checker audit.
- Production Twilio and Plivo ingress plugins, Deepgram and AssemblyAI STT, Sarvam STT/TTS, OpenAI TTS/inference, campaign operations, cost ledger, recording and the console are installed. The legacy provider, telephony, session and distribution bridges have been removed. The /twilio/* compatibility paths remain for operators to repoint configured numbers.
- The dispatcher publishes a capacity signal; Application Auto Scaling alone writes worker desired count on Fargate. Compose uses a fixed worker count and logs the signal. [ADR 0003](../docs/decisions/0003-aas-only-desired-count-writer.md) records that boundary.
- I1 defined decision, human-handoff, intent-graph, templated-clip and multilingual confirmation contracts. Their post-I1 implementations have not started. The [post-I1 roadmap](units/README.md#post-i1-roadmap) is tracked separately.

## Local verification at the current integration tree

All commands use Node 22 by prepending /opt/homebrew/opt/node@22/bin to PATH.

| Check                                               | Result                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| Frozen offline install                              | Exit 0                                                                   |
| Full lint, including architecture and duplication   | Exit 0; seven gates, zero baselined architecture edges                   |
| Full format check                                   | Exit 0                                                                   |
| Typecheck                                           | Exit 0                                                                   |
| Default Vitest                                      | 2,046 passed + 216 skipped = 2,262; exit 0                               |
| Production app and console builds                   | Exit 0                                                                   |
| Console Playwright                                  | 41 passed + 1 viewport skip; exit 0                                      |
| Terraform fmt, init without backend, validate       | Exit 0                                                                   |
| PostgreSQL 17.6 serial with all four database gates | 2,262 passed + 0 skipped = 2,262; exit 0 on a fresh disposable container |
| Backup and restore drill alone                      | 3 passed on disposable PostgreSQL 17.6                                   |
| Linux arm64 worker image and native LiveKit load    | Build and network-disabled `rtc-node` / glibc FFI loads exit 0           |

The commands run were `pnpm install --offline`, `pnpm install --frozen-lockfile --offline`, `pnpm check` (lint, format, typecheck, test, build, audit and console E2E) and `node scripts/check-terraform.mjs`. The serial command was `pnpm exec vitest run --no-file-parallelism --reporter=dot` with `OVO_TEST_POSTGRES_URL`, `RECORDING_TEST_DATABASE_URL`, `LEDGER_TEST_DATABASE_URL` and `OVO_BACKUP_DRILL_POSTGRES_URL` all pointing to the same fresh PostgreSQL 17.6 container bound only to 127.0.0.1. `pnpm audit` found no known vulnerabilities. Compose smoke and a live AWS plan were not run. No vendor endpoint was contacted.

The counts reconcile separately: 2,046 + 216 = 2,262. The PostgreSQL serial run has 2,262 passed + 0 skipped = 2,262. All 216 default skips are database-gated and run under PostgreSQL: 212 with OVO_TEST_POSTGRES_URL and RECORDING_TEST_DATABASE_URL, one with LEDGER_TEST_DATABASE_URL, and three restore-drill cases with OVO_BACKUP_DRILL_POSTGRES_URL. The new migration 006 preflight test adds one PostgreSQL-gated skip, not a disabled test. The former 24 macOS LiveKit matrix skips now execute. The restore drill requires a Docker-shared scratch directory and creates and drops its own source and target databases. Use a fresh disposable container for the full serial run: fixed idempotency keys can collide if separate full runs share the same database. The disposable container was removed after this run.

The local Linux check ran `docker build --target worker -f infra/container/Dockerfile -t ovo-i1-worker:local .`, then two `docker run --rm --network none --entrypoint node` probes against that image. Node 24.8.0 on Linux arm64 loaded `@livekit/rtc-node` (`Room` is a function) and `@livekit/rtc-ffi-bindings-linux-arm64-gnu` (six exports). This verifies the native binding in the built worker image, not a live LiveKit session. The macOS fixture matrix separately exercises the genuine Darwin binding. The tagged image and disposable container were removed; no global Docker prune was run.

The fixture matrix runs FAQ and confirmed-write releases across both native and genuine LiveKit engines, Twilio/Plivo, Deepgram/AssemblyAI/Sarvam STT and OpenAI/Sarvam TTS: 48 active combinations plus one held-state assertion for Exotel. Each release's selected plugins pass through the production `selectSessionGraph` and `compose` path, so these are behavioral integrations rather than catalog presence checks. The two real carrier ingresses coexist; the chosen serializer, STT, TTS, behavior and engine execute under FixtureNet. The matrix asserts provider-template STT, transcripts, speech evidence, usage, confirmation-before-write ordering, one fixture write and zero external egress. Fixture inference and the write handler replace paid/external operations. It does not drive public carrier HTTP callbacks, live vendor WebSockets, dialing, paid providers or AWS. The API demo separately creates and publishes a release, validates compatibility, runs an announcement fixture call and reads evidence through the production management API. This is local fixture evidence, not a real call.

| Engine  | Twilio                         | Plivo                          | Exotel                                                        |
| ------- | ------------------------------ | ------------------------------ | ------------------------------------------------------------- |
| Native  | 6 FAQ + 6 confirmed-write rows | 6 FAQ + 6 confirmed-write rows | **Absent/held:** authenticated 16 kHz wire format unconfirmed |
| LiveKit | 6 FAQ + 6 confirmed-write rows | 6 FAQ + 6 confirmed-write rows | **Absent/held:** authenticated 16 kHz wire format unconfirmed |

TCN has no package until its media/signing/control contract is confirmed. Alohaa has no package until callback signing is confirmed. Neither is substituted into the matrix. A real macOS Node 22 run loads the installed LiveKit Darwin binding and executes all 24 LiveKit rows. E3's `runtime.native: 'glibc'` was over-declared for this no-room engine path and has been removed; the Linux arm64 image still loads its own glibc binding.

## Integration still open

- **Founder-held carriers:** Exotel's authenticated 16 kHz wire format and end handoff, TCN's media/signature/control contract, and Alohaa callback signing are unconfirmed. The 2026-10-02 founder decision allows I1 to close with these three named, dated terminal holds. The skeleton gate rejects any unlisted skeleton and stale exemptions; Exotel execution rows are absent and labelled, never fabricated.
- **Baseline and contract cleanup:** `pending/`, `module-size.json`, `runtime-violations.json`, architecture, provider-name and conformance baselines are empty. The largest source module is 300 canonical nonblank lines. Duplication retains 13 pairs and capability keys retain 33 file entries, individually covered by the residue review in `scripts/baselines/README.md`. Additional I1 carry-forwards on the unit board remain open, so I1 is not ready for checker handoff.
- **Recent integration checks:** callback identity is validated before admission; the gateway rejects a pre-accept budget shorter than one supported frame; legacy frame-count conversion is exercised through a loopback carrier socket; the dispatcher accepts a fresh database snapshot when PostgreSQL's clock leads the host and still rejects stale input. The engine kit now waits for asynchronous barge-in clear, interrupt and flushed-mark observations. Its no-clear broken engine still fails by timeout.
- **Recording and media cleanup:** eight independent capture, service and WAV guard mutations fail the new format tests. Worker lifecycle tests use the authenticated loopback socket; the direct-open branch is gone, and removing the non-socket rejection calls the engine factory once. An incomplete carrier price snapshot now stays reserved and defers without rolling back the next valid settlement; the old code returned `-1` where the new two-row PostgreSQL test expects `2`.
- **Many-capability identity:** background tasks now register by plugin ID. A composition with two background tasks declaring the same provider exposes both tasks; reverting that rule fails with `Ambiguous service: ovo.background-task:same`. Carrier control and ingress remain provider-keyed because their public contract and production lookups use that key; same-provider carrier selection still needs an explicit contract decision.
- **Tenant SQL coverage:** the PostgreSQL secrets/MCP regression now uses the same IDs in two workspaces. An unscoped credential rotation fails on the other tenant's version/fingerprint and an unscoped MCP deletion fails on its missing connection. The broader repository mutation sweep remains open.
- **Immutable migration guard:** orchestration migration 006 remains unchanged for deployed checksum compatibility. Its runner now refuses to apply it when an extra status-related CHECK would be dropped; removing the preflight made the new PostgreSQL regression lose the unrelated `ovo_jobs_status_shadow_check`. Existing databases that already ran 006 need manual review if they had such an extra constraint.
- **Transition cleanup:** worker telemetry now closes with the typed end reason alone; the production factory and lifecycle assertion use that single argument. The unused Plivo testing `plugins = []` export is removed. The focused worker/Plivo scope passed 62 tests.
- **Conformance and speech cleanup:** the vendor conformance gate refuses a new or widened `only:` subset; its three pre-existing exact-list exceptions are recorded on the board for checker review. Sarvam STT/TTS now shares plugin-kit's runtime-neutral base64 decoder, and the STT kit measures its JSON-framed base64 audio against the advertised frame limit.
- **Local deployment evidence:** Compose smoke, public carrier routing, production backup RPO/RTO, AWS plan/apply and live scaling drills remain unverified. Terraform validation alone does not certify them.
- **Vendor and business evidence:** real callback/media traffic, provider usage and invoices, human listening, call transfer, load and outage drills remain unverified.

The verified M2 corpus was corrected by M1: eight confirmation/cancellation prompt expectations changed from raw JSON to spoken arguments. Importing that corpus can create a new immutable dataset version; operators should re-baseline comparisons or accept the one-time fingerprint change without rewriting historical runs.

## Safety constraints that must remain intact

- Validate immutable release bindings and required carrier/STT/TTS/LLM meter coverage before live admission.
- Keep budgets honest: reservations are admission guards, not strict caps on later provider invoices.
- Renew both task protection and durable job ownership. Ownership loss must drain and terminate the carrier leg.
- Honor `release.config.recording`; disabled recording must not capture or create recording rows.
- Preserve restore fences for jobs, outboxes, campaigns, paid evaluation ambiguity, authorizations, inbound admissions, and users. Never bulk-clear fences.
- Ordinary startup must not reset an existing admin password. Restored-user recovery is explicit and requires new credentials.
- Preserve write-confirmation and unknown-outcome protections. Do not revive the old `variables.confirmed` bypass.
- Keep module limits: 400 canonical nonblank lines / 24 KiB; tests 500 lines. Prefer under 300 lines. Imported upstream source has separate provenance rules.

- Carrier-processed playback evidence requires an explicit operator acknowledgement before a confirmed write.
- Fixture test calls never dial a carrier or read a real credential value.
- Close-stream carriers require the stream-end-terminates-call attestation before admission.
- A route is marked terminating before any deliberate media close.

## Next handoff

Continue the I1 carry-forwards in the [unit board](units/README.md) and run the full gate after each integrated source change. Keep code and board/documentation commits separate. When a founder supplies confirmed Exotel, TCN or Alohaa documents or authorizes a sandbox, resume only that carrier's own unit. The first real call, push, PR update, paid provider use and AWS actions all require separate founder authorization.
