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

| Check                                               | Result                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| Frozen offline install                              | Exit 0                                                                    |
| Full lint, including architecture and duplication   | Exit 0; seven gates, zero baselined architecture edges                    |
| Full format check                                   | Exit 0                                                                    |
| Typecheck                                           | Exit 0                                                                    |
| Default Vitest                                      | 1,979 passed + 235 skipped = 2,214; exit 0                                |
| Production app and console builds                   | Exit 0                                                                    |
| Console Playwright                                  | 41 passed + 1 viewport skip; exit 0                                       |
| Terraform fmt, init without backend, validate       | Exit 0                                                                    |
| PostgreSQL 17.6 serial with all four database gates | 2,190 passed + 24 skipped = 2,214; exit 0 on a fresh disposable container |
| Backup and restore drill alone                      | 3 passed on disposable PostgreSQL 17.6                                    |

The commands run were `pnpm install --frozen-lockfile --offline`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:console:e2e` and `node scripts/check-terraform.mjs`. The serial command was `pnpm exec vitest run --no-file-parallelism` with all four database URLs named below pointing to a fresh PostgreSQL 17.6 container bound only to 127.0.0.1. Compose smoke and a live AWS plan were not run. No vendor endpoint was contacted.

The counts reconcile: 1,979 + 235 = 2,214 and 2,190 + 24 = 2,214. Of the 235 default skips, 211 are database-gated and run under PostgreSQL: 207 with OVO_TEST_POSTGRES_URL and RECORDING_TEST_DATABASE_URL, one with LEDGER_TEST_DATABASE_URL, and three restore-drill cases with OVO_BACKUP_DRILL_POSTGRES_URL. The remaining 24 LiveKit matrix rows need a Linux glibc native binding and skip on this Mac. The restore drill requires a Docker-shared scratch directory and creates and drops its own source and target databases. Use a fresh disposable container for the full serial run: fixed idempotency keys can collide if separate full runs share the same database.

The native fixture matrix runs FAQ and confirmed-write releases across Twilio/Plivo, Deepgram/AssemblyAI/Sarvam STT and OpenAI/Sarvam TTS. It asserts selected plugin execution, provider template STT, transcript, speech evidence, variables, zero LiveKit tool-executor calls and zero external egress. The API demo creates and publishes a release, validates compatibility, runs an announcement fixture call and reads evidence through the production management API. This is local fixture evidence, not a real call.

## Integration still open

- **Founder-held carriers:** Exotel's authenticated 16 kHz wire format and end handoff, TCN's media/signature/control contract, and Alohaa callback signing are unconfirmed. No implementation may infer those protocols. The I1 Exotel matrix rows and zero-skeleton gate cannot complete while C3 is held.
- **Baseline and contract cleanup:** pending baselines, runtime-violation entries and module-size residues remain; I1 is not ready for checker handoff. The current gate passes by its existing ratchets. Do not describe that as an empty baseline.
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
