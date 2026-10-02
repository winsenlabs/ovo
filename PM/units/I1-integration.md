# Work unit I1-integration: Integration: W2 gate, façade and bridge removal, enforce mode, all baselines and pending files emptied, cross-unit dedupe, engine×carrier×STT demo matrix, compose smoke docs, ADR/docs/PM updates, final CI

Wave: 3
Depends on: E1-turns-vad, E2-native-engine, E3-livekit-engine, C1-carrier-twilio, C2-gateway-router, C3-carrier-exotel, C4-carrier-plivo, S1-speech-split, S2-speech-new, O1-fargate-scaling, O2-ops-ledger, U1-console, D1-demo-backend, M1-misc-defects, M2-evaluations-decoupling
Defects fixed: [21]

## Owned paths

- Any file in the repository, for integration fixes, cross-unit dedupe and cleanup only (no new features)
- packages/plugin-providers/** (delete)
- packages/plugin-telephony-twilio/** (delete)
- packages/plugin-session/** (delete)
- packages/plugin-operations/src/twilio-handoff.ts (delete)
- packages/distribution/src/legacy/** (delete)
- scripts/baselines/**
- docs/**
- PM/**
- THIRD_PARTY_NOTICES.md
- README.md
- pnpm-lock.yaml

## Shared touchpoints (minimal edits allowed)

- none

## Specification

### Founder decision: vendor-evidence holds do not block I1 (2026-10-02)

The original zero-skeleton acceptance line and Exotel matrix requirement below are superseded for three named units. C3 Exotel is held for its authenticated 16 kHz media wire format; C5 TCN is held for its media, signing and call-control contract; C6 Alohaa is held for callback signing. No implementation, protocol row or compatibility value may be inferred to satisfy I1. The conformance gate must accept only named, dated exemptions for these packages and reject any new silent skeleton. The compatibility matrix must label Exotel's rows absent/held, while the installed Twilio and Plivo rows run normally. These vendor-evidence holds are terminal states for the units and do not delay I1. The founder made this decision so fourteen verified units can be released without waiting for vendor replies. All other I1 acceptance criteria remain in force.

Before handoff, I1 must also decide from installed native dependencies and a real macOS fixture run whether E3's `runtime.native: 'glibc'` is necessary. If over-declared, remove the artificial host restriction and run the LiveKit matrix on macOS; if required, name the dependency and keep the platform skips explicit. Report whether the matrix composes each selected plugin through the real session graph and which production behavior remains untested.

GOAL: integrate wave 2, delete the transition scaffolding, prove the founder demo with an automated matrix, and update the docs and PM records. Read docs/architecture/plugin-platform.md (revision 2) in full, especially section 0.2 (the HANDOFF invariants), section 13 (gates), section 15 (coordination) and section 16. HANDOFF says: one branch (vorflux/ovo-foundation), no excessive review, the Test Report stays PARTIAL, and PM/acceptance.json keeps all 75 criteria. You may edit any file for integration, dedupe, cleanup, defects found by the matrix or CI, and the contract definitions explicitly added below. Implementations of those new contracts belong to the post-I1 roadmap, not I1.

0. The W2 gate (FIRST):
   - Run pnpm install --offline, pnpm lint, pnpm typecheck and pnpm test on the combined tree, and fix every cross-unit break.
   - Collect every wave-2 report's 'Contract gaps', and resolve each one properly: move local structural types or adapters into contracts, session-host or plugin-kit where appropriate, and delete the local copies.
   - Prune dependency lines that are no longer used, for example in plugin-evaluations/package.json, then reinstall.

### Founder scope addition (2026-09-30): define post-I1 contracts while contracts are open

This is a narrow exception to I1's integration-only scope: define and validate these contracts in `packages/contracts` during I1, without implementing the post-I1 features. The [Post-I1 roadmap](README.md#post-i1-roadmap) remains unstarted. Defining these later would reopen a frozen package.

- `Cap.decision`: a decision-model capability with choice, noul and score primitives; natural-language criteria; and a calibrated confidence plus per-option probabilities in each response. Model the shape on the TypeSafe Jev API while keeping it suitable for Laya and the OpenAI Decisions API, which expose the same three primitives.
- `Cap.humanHandoff`: request, presence, accept and release behind one port. It must fit both a built-in open-pickup queue and an OCSO assignment plugin. OVO and OCSO remain separate deployments; OVO must work with neither, either or both integrations available.
- An intent-graph script schema with intent descriptions, a confidence threshold, slot extraction, slot-conditional targets, global intents layered on every node, and an LLM fallback that resumes at a named node. Base it on OCSO's validated, versioned, pure `RouterStep` (`ASK` / `CLASSIFY` / `KNOWN`) at `~/work/ocso/packages/domain/src/routing/router-definition.ts`; do not invent a parallel schema. It supersedes literal-only `ScriptGraph` transitions (`{ event, matches: string[], to }`) for the future behavior mode.
- Templated clips with variables so per-contact audio can be rendered before a call.
- Multilingual confirmation phrases extending `contracts/src/text.ts`'s English and Hindi `CONFIRM_YES` / `CONFIRM_NO` with Tamil, Telugu, Kannada, Marathi and Bengali at minimum, including code-mixed forms.

1. Remove the scaffolding:
   - delete packages/plugin-providers, packages/plugin-telephony-twilio, packages/plugin-session and packages/plugin-operations/src/twilio-handoff.ts (plus its index export);
   - delete packages/distribution/src/legacy/* and the supersede code path if nothing else uses it (keep the same-id rule for OVO_PLUGIN_MODULES if it's tested);
   - delete plugin-kit speech-shims functions that no longer have callers (keep a shim only if a test-only caller remains, and document it);
   - remove the v1 wire aliases (callSid, streamSid, and the sessionId/routeToken route params) from the gateway↔worker protocol if no code uses them;
   - keep the /twilio/* legacyPaths until phone numbers are repointed, and document this.
     Update imports across the repo, and remove the deleted packages from package-kinds.json and the catalog.

2. Enforcement: packages/runtime/src/enforcement.ts defaults v1 manifests to 'enforce'. Explicitly verify the remaining v1 infra plugins under enforce: storage, queue (SQS and ElasticMQ), secrets, recordings, telemetry, cost ledger, operations, orchestration, protection and readiness. scripts/baselines/runtime-violations.json must end EMPTY.

3. Baselines:
   - scripts/baselines/pending/ is deleted, after its entries are resolved.
   - No package.json carries the ovo.skeleton flag.
   - architecture.json and provider-names.json are EMPTY. This is the proof that adding a provider, carrier or engine needs no shared-code edits.
   - Dedupe cross-unit duplication into plugin-kit or audio. For example, C1, C3 and C4 or S1 and S2 may independently repeat httpJson error mapping or emit-once usage logic.
   - capability-keys.json and duplication.json are empty, or each remaining entry is justified in scripts/baselines/README.md.
   - module-size.json: split the remaining >300-line source modules mechanically, by responsibility and with no behavior change, until it is empty. If a split is unsafe, leave it and list the file with a reason.
   - check-conformance's baseline (plugin-voice) is empty.

4. Demo matrix: packages/distribution/tests/matrix.test.ts, using @winsendotai/ovo-fixture-calls and the real installed plugins with their exported fixtures and fixture templates, under the egress sentinel.
   - One agent release (agent mode with a confirmed write tool, plus an FAQ variant) runs across {native, livekit} × {twilio, exotel, plivo} × {deepgram, assemblyai, sarvam-stt}, with TTS {openai, sarvam-tts}.
   - Pin Exotel bindings to 8 kHz; the LiveKit engine formats are 8 kHz only.
   - The Exotel binding sets streamEndTerminatesCall true.
   - Skip the LiveKit rows with a reason if the native binding is unavailable on the host. LiveKit uses real timers, so give those rows their own describe block with a 60 s timeout and limited concurrency.
   - Assert invariants, NOT identical turn boundaries:
     - exactly one Execution.execute per operation;
     - speech evidence phases in order;
     - variables on every turn;
     - zero LiveKit tool-executor calls;
     - bounded dispose;
     - transcript events present;
     - a latency breakdown whose parts sum to the total;
     - estimated cost lines using the selected providers' meter keys (unpriced allowed);
     - recording rows only when recording is enabled;
     - sttMode is NOT 'fixture-generic' for the deepgram, assemblyai and sarvam rows (their templates were used).
   - Exotel rows show confirmations blocked by playback_evidence_insufficient unless acknowledged; with the acknowledgement, the confirmed write executes once.
   - Also add apps/api/tests/demo-path.test.ts: create an agent → set voice selections → POST compat → fixture test call → GET evidence.

5. Compose smoke: update scripts/verify-compose.sh and infra/compose/README.md for the new env (OVO_CARRIER_ENV_BINDINGS, OVO_FIXTURE_TEST_CALLS=true set explicitly, OVO_CAPACITY_SIGNAL=log, OVO_MEDIA_PUBLIC_BASE_URL, OVO_INBOUND_ROUTE_SECRET, and the glibc images). Docker is not running, so do not claim it passed; write the exact commands in docs/runbooks/self-hosted-compose.md.

6. Docs:
   - docs/decisions/0003-aas-only-desired-count-writer.md: an ADR replacing doc 08 section 4's 'choose either' with AAS as the only writer.
   - Update docs/08-plugin-first-fargate.md and docs/04-architecture.md to link docs/architecture/plugin-platform.md.
   - docs/plugin-author-guide.md v2: manifest v2, definePluginV2 (io 'input'), ctx.net and ctx.secret, companions, conformance kits, fixtures and fixture templates, and the catalog registration line. Convert packages/plugin-example to definePluginV2 as the reference if that's low risk.
   - Runbooks:
     - scale-and-drain.md (remove the manual unresolved-write SQL);
     - fargate-deployment.md;
     - provider-outage.md;
     - a new carrier-onboarding.md: Twilio, Exotel and Plivo setup, the operator URLs from GET /v1/provider-bindings/:id/carrier-urls, the Exotel flow requirement 'Voicebot → Hangup' (NO continuation applet; attested by streamEndTerminatesCall), the Plivo answer URL, and the UNCONFIRMED items.
   - docs/evidence/*.md for voice, media, providers, operations and deployment.
   - apps/console/OPERATOR_E2E_HANDOFF.md.

7. Licences: run node scripts/license-inventory.mjs (update the script for new packages if needed), and update docs/research/dependency-licenses.json and THIRD_PARTY_NOTICES.md for @livekit/agents (Apache-2.0), @livekit/rtc-node, @livekit/av (LGPL), sharp/libvips (LGPL) and @livekit/local-inference (a model licence; unused by configuration). Add Pipecat (BSD-2-Clause) only if any code was ported line by line (check the E1 and E2 reports).

8. PM: update PM/HANDOFF.md.
   - Describe the delivered architecture and the new verification evidence, with exact commands and counts.
   - Keep the 'Safety constraints that must remain intact' section verbatim, extended with:
     - carrier-processed evidence requires an explicit acknowledgement;
     - fixture test calls never dial;
     - close-stream carriers require the stream-end attestation;
     - the route is marked terminating before any deliberate media close.
   - Keep the Test Report PARTIAL, and list what couldn't be verified: the Postgres-gated suites, the Docker compose smoke, terraform validate, AWS drills, real carrier and provider traffic, browser tests if they weren't run, and every UNCONFIRMED vendor item.
   - Update PM/acceptance.json and acceptance.md evidence only where tests prove it. Keep exactly 75 criteria (the architecture gate checks this).

9. Final verification: pnpm install --offline, pnpm lint, pnpm format:check (run pnpm format on changed files only if needed), pnpm typecheck, pnpm test, pnpm build and node scripts/check-terraform.mjs. Record the exact pass and skip counts in PM/HANDOFF.md. Do not run pnpm audit if there is no network; record that it was skipped.

CONSTRAINTS:

- No new implementations beyond integration and cleanup; the founder's 2026-09-30 exception above requires contract definitions in I1.
- Preserve every HANDOFF safety constraint. Never bulk-clear restore fences. Live flags stay off.
- Git: follow the user's and HANDOFF instructions. Do not create branches, and commit only if the orchestrator explicitly says the user authorized it.
- Modules ≤300 lines.

## Acceptance

- The five founder-added post-I1 contracts are defined and validated in `packages/contracts` while it is open. Decision and handoff ports, the OCSO-derived intent graph, templated clips, and multilingual confirmation phrases have contract tests; their implementations remain in the unstarted roadmap.
- The combined tree passed the W2 gate. Every wave-2 contract gap was resolved and its local copies removed.
- plugin-providers, plugin-telephony-twilio, plugin-session, the distribution legacy bridges and twilio-handoff.ts are deleted, and nothing imports them.
- Runtime enforcement defaults to enforce for v1 manifests, the listed infra plugins are verified under enforce, and the runtime-violations baseline is empty.
- scripts/baselines/pending/ is gone and no package carries the skeleton flag. The architecture, provider-names and conformance baselines are empty. module-size, duplication and capability-keys are empty, or each residue is justified in scripts/baselines/README.md.
- The demo matrix passes across {native, livekit} × {twilio, exotel@8k, plivo} × {deepgram, assemblyai, sarvam}, with invariant assertions including template-based sttMode (LiveKit rows skipped only when the native binding is unavailable). The demo-path API test passes.
- ADR 0003, the plugin author guide v2, the runbooks (including carrier onboarding with the Exotel Voicebot → Hangup requirement), the evidence docs, the licence notices and OPERATOR_E2E_HANDOFF.md are updated.
- PM/HANDOFF.md keeps the safety constraints verbatim (extended) and the Test Report PARTIAL with the unverifiable items listed. PM/acceptance.json still has 75 criteria.
- pnpm lint, format:check, typecheck, test and build pass, check-terraform exits 0, and the exact counts are recorded.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm install --offline`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm lint`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm format:check`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm typecheck`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/distribution/tests/matrix.test.ts apps/api/tests/demo-path.test.ts --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm test`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm build`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/check-terraform.mjs`

## Incoming checker obligations (2026-09-27)

### I1 checker note: many-capability identity (2026-10-02)

The F3 carry-forward requires two background tasks from the same provider to
compose, while design §3.4 originally used `manifest.provider ?? manifest.id`
for every many-key. Background tasks are independent plugin instances, so I1
keys them by stable plugin ID, as text and audio filters already are. The
runtime test composes two same-provider task plugins; restoring provider
qualification fails with `Ambiguous service: ovo.background-task:same`.
Carrier control and ingress still use provider qualification because their
public contracts and API/worker lookups use provider keys. Supporting multiple
carrier plugins for one provider needs a separate contract decision before
changing those maps or selection lookups.

### I1 checker note: immutable orchestration migration 006 (2026-10-02)

O1 asked I1 to narrow the broad `%status%` constraint removal in migration 006. The SQL is already shipped and changing its bytes would break immutable
migration checks for databases that applied it. I1 instead added a runner
preflight before 006: any status-related CHECK beyond the expected legacy
`ovo_jobs_status_check` stops migration for manual review. A PostgreSQL test
adds an unrelated shadow CHECK; disabling the preflight makes the old SQL
delete it and fails on a concrete missing-constraint assertion. This protects
not-yet-migrated databases; it does not reconstruct constraints already
removed by a past application of 006.

- **E3 design drafting repair (2026-10-01):** amend §15.2 to name E3's
  `scripts/build.mjs` exception already granted by §15.5, as it names C2/O1's
  distribution profile exceptions. Reconcile §15.2, §15.5 and the F4 owner map
  in one pass: the O1 worker-termination shared-file edit and the PM/**
  board-update protocol are the other recorded contradictions. Preserve the
  approved scopes and state that a specific named owner grant prevails over
  the blanket freeze.

- **BLOCKING M1 MCP tombstone gap (2026-10-01):**
  `apps/api/src/routes/agents.ts` calls `validateSelections` at release stage
  without `discoveredMcpTools`, so §4.5's `mcp_tool_removed` issue is never
  emitted. `createRelease` reads the discovered tool without a `removed_at`
  predicate and accepts its unchanged schema digest. A removed tool can be
  snapshotted into a new release instead of producing HTTP 422. Supply the
  discovered state to compatibility validation and reject tombstones in the
  release write path; pin both with a production API regression.
- M1's two-tenant Postgres test pins four secret/MCP write predicates. Extend
  tenant-isolation coverage to the remaining repository statements: the M1
  checker found many `WHERE workspace_id` mutants surviving. Its pre-repair
  systematic scope had 59/77 surviving SQL sites (76.6%) and 284/751 surviving
  TypeScript sites (37.8%). Rerun the scope with the new
  `scripts/mutation-sweep.mjs --paths=...` flag after integration work. The
  injectable AWS secrets client had 12/12 surviving mutations; add fake-client
  coverage. Also pin a missing `OVO_OPERATORS_JSON` operator token in
  `apps/api/src/auth-env.ts`.
- The M1 operation-fingerprint release note also includes the `NaN`/`Infinity`
  versus `null` collision: canonical JSON serializes non-finite numbers as
  `null`, so these values cannot serve as distinct operation identities.
- `apps/dispatcher/src/dispatcher-process.test.ts` has an eight-second
  wall-clock budget and flakes under parallel load; O1/I1 should replace the
  timing-sensitive assertion with a deterministic signal.

- **HARD BLOCKING B2, reconfirmed 2026-09-27:** fix `normalizeAgentConfig`
  so it never mutates its input. Then remove all three workaround clones from
  `apps/api/src/release-selections.ts`, `apps/api/src/test-call-runtime.ts`, and
  `packages/fixture-calls/src/run.ts`. A fourth caller is currently unprotected:
  `packages/session-host/src/legacy-session-selections.ts` passes
  `input.release.config` directly and mutates a release record in memory during
  legacy worker derivation. This is an executed/live mutation path, not a
  hypothetical risk. Do not add a fourth clone; the file is frozen for wave 2.
  The current API clone-reversion proof is **nine** HTTP 409 failures (api.test,
  default-modes, f4-routes x2, real-llm-release x2, script-simulation x3), replacing
  the historical seven count after D1 added call sites. Regress all four callers
  and direct input immutability when removing the workarounds.
- `runControlMigrations` checks each entry of a hardcoded array independently
  and currently applies missing lower versions after higher recorded versions.
  Add a contiguity assertion that rejects gaps before applying migration SQL,
  with an out-of-order true negative. D1 owns control 006, and M1 must renumber
  its unpublished migration to 007 when it resumes. The second unit must rebase
  and re-verify the shared Postgres/SQLite runners; checksums of already-applied
  migrations must remain immutable. This note records future I1 work; I1 has
  not started.

- **BLOCKING before deleting legacy bridges (S1 cross-unit, 2026-09-27):**
  `metersFor` must reject a selected slot when its plugin declares role meters
  but `when` filtering selects none. Cover absent binding snapshots, missing
  condition fields, unknown values, valid model branches and plugins that declare
  no meters for that role. The immediate storage fix carries existing binding
  snapshots into reconstructed legacy selections; it does not repair this frozen
  host contract. Never compensate with unconditional meters or duplicate billing.

- Remove `@winsendotai/ovo-plugin-voice` from
  `packages/plugin-observability/package.json` and its matching lock importer;
  D1 removed the source edge but the unused manifest dependency remains.
- Close the recorded nonblocking fixture coverage gaps:
  `fixtureCallsEnvironmentEnabled` must cover undefined, true, false and invalid
  strings; exercise `sttMode: 'static'` separately from playback-gated replay.

## Incoming C2 checker carry-forwards (2026-09-27)

- **HARD BLOCKING:** repair the frozen fixture HTTP signer and verifier together:
  `conformance/src/drivers/fixture-carrier.ts` signFixtureRequest and
  `fixture-carrier-routes.ts` verified both append reconstructed query to an
  already query-bearing externalUrl. Update all consumers and reference docs
  consistently, and prove a literal raw-wire signature matches without duplicated
  or re-encoded query bytes. Their current self-consistent doubled payload is not
  vendor signature fidelity. The checker resolved sequencing on 2026-09-27:
  C2 corrects the normative document now and visibly names these known-inconsistent
  shipped drivers; this HARD I1 helper/consumer correction remains unchanged.
- Guard inbound confirmCallback with the same validateBeforeAdmission identity
  validation as admitInbound before adding its first production caller.
- I1 integrates C1/C3/C4 negative-capability coverage: clearFlushesMarkers false
  and unknown, playbackEvidence none and carrier-processed, queryOnMediaUrl true
  (especially Exotel's sid/rt/t), and legacy callSid/streamSid aliases.
- Cover 2+ inbound env bindings, explicit OVO_MEDIA_PRE_ACCEPT_MS, and deprecated
  OVO_MEDIA_MAX_PENDING_FRAMES ×20 conversion. Raise the preAcceptBufferMs schema
  minimum so a valid first frame cannot be refused by the 1 ms configuration.
- Cover the six new recordings guard branches. Declare the contracts dependency
  and use its public exports in plugin-recordings capture-types.ts, capture.ts,
  wav.ts and live-service.ts; all four currently deep-import contracts internals,
  and only capture-types.ts records the adapter.
- Remove dead gatewayInfrastructureRows (and its false host-caller comment),
  encodeWorkerMessage, sameIdentity and WorkerMediaRuntime.connect.
- Migrate the remaining media-runtime.test.ts direct fixture to the authenticated
  socket and remove open()'s production non-WorkerMediaLink test-only branch.
  C2's previous assertion that no production compatibility bypass existed was
  inaccurate; its report now acknowledges the seam explicitly.

## Wave-level S2 checker obligations (2026-09-29)

- **BLOCKING: drive selected plugins through the real session graph.** Follow
  S1's `production-entry.test.ts` pattern for AssemblyAI STT and Sarvam STT/TTS
  so a production integration test exercises each selected plugin's behavior,
  not just `graph.get(Cap.stt)` existence. The checker made all three S2 entry
  points throw; only five files failed, all inside S2's two packages. In a
  separate sweep, 86 of 140 S2 guards survived both S2-only and full-repo
  tests, and 85 simultaneous behavioral defects left the 1,952-test repository
  suite green. This is a wave-level test-architecture gap, not an S2-only
  fixture count to patch locally.
- **BLOCKING: run a production integration case with the real Twilio and Plivo
  ingresses installed together.** The C2 multi-carrier test clones one ingress
  and the carrier-neutral gateway test labels Twilio-derived code as Plivo.
  This has been possible since C4 merged and remains unproved.
- Export `decodeBase64` from plugin-kit to remove S2's three local copies;
  repair the stt@1 frame-size kit so JSON-framed Sarvam audio is measured;
  make the tts@1 non-native check independently pin each redundant guard.
- Resolve the formatted-duplicate conflict with stt@1's locked-finals
  invariant as well as the `sttAsLegacy` bridge before exposing that mode.
  Establish consumers for `ttfsP99Ms` and `maxChars`, and police conformance
  `only:` subsetting so a plugin cannot pass with one selected check.
- Vendor questions remain with Tejas: Universal-3.5-Pro Urdu support versus
  the S2 spec; Sarvam Odia `or-IN` for realtime STT versus `od-IN` for TTS;
  and the supported Sarvam speaker roster before restricting the binding
  schema. Do not resolve these by inference in I1.

## Incoming M1 confirmation corrections (2026-10-01)

M1 corrected only the frozen interrupted-confirmation scenario's utterance to
`hello there`, leaving the meta-test's interrupted receipt and zero-write
assertions intact. Suppressing the reference detector's transcript interrupt
fails that test on `completed` versus `interrupted`. Preserve this regression
and the separate genuine-`yes` ordering scenario in I1.

## BLOCKING E3 conformance timing sweep (2026-10-01)

E3 found the second frozen kit assertion that encoded the reference engine's
behavior: `engine-scenarios-turns.ts` required carrier audio in the same tick as
a generated FAQ text receipt. Asynchronous LiveKit synthesis exposed it; the
checker approved a bounded wait, with a silent-engine timeout negative. M1's
interrupted-confirmation utterance was the first known instance, passing only
because of a bug. Sweep `packages/conformance` for other assertions that assume
synchronous emission or reference-engine ordering, replace each with a bounded
wait where appropriate, and preserve explicit broken-engine negatives. This is
blocking I1 acceptance because the kit must verify independent engine authors.

Inherit this M1 release note verbatim:

> The verified M2 built-in 120-case evaluation corpus had eight agent confirmation
> and cancellation expectations that spoke raw JSON. M1 corrected only their
> expected prompt template to match §10's schema-ordered spoken arguments. The
> dataset fingerprint changes from
> `sha256:f0bdd567be030277a910c9a553196ae6b9373d4d1dbe193b55319831ebca3994`
> to `sha256:5c25fcf40110b18dccfd26576555f8ada09d587e649c8ee19e900970f1d838ec`.
> On importing the corrected built-in corpus into a dataset that holds the old
> version, operators see one new immutable dataset version rather than a dedupe;
> historical runs remain pinned to their original version. No data is backfilled.

Operator action: import the corrected built-in corpus as a new version, then
re-baseline comparisons that should use its spoken expectations or explicitly
accept the one-time fingerprint change. Retain the old version for historical
comparisons; do not rewrite prior runs.
