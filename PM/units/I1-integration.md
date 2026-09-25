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

GOAL: integrate wave 2, delete the transition scaffolding, prove the founder demo with an automated matrix, and update the docs and PM records. Read docs/architecture/plugin-platform.md (revision 2) in full, especially section 0.2 (the HANDOFF invariants), section 13 (gates), section 15 (coordination) and section 16. HANDOFF says: one branch (vorflux/ovo-foundation), no excessive review, the Test Report stays PARTIAL, and PM/acceptance.json keeps all 75 criteria. You may edit any file, but only to integrate, dedupe, clean up or fix defects found by the matrix or CI. No new features.

0. The W2 gate (FIRST):
   - Run pnpm install --offline, pnpm lint, pnpm typecheck and pnpm test on the combined tree, and fix every cross-unit break.
   - Collect every wave-2 report's 'Contract gaps', and resolve each one properly: move local structural types or adapters into contracts, session-host or plugin-kit where appropriate, and delete the local copies.
   - Prune dependency lines that are no longer used, for example in plugin-evaluations/package.json, then reinstall.

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

- No new features beyond integration and cleanup.
- Preserve every HANDOFF safety constraint. Never bulk-clear restore fences. Live flags stay off.
- Git: follow the user's and HANDOFF instructions. Do not create branches, and commit only if the orchestrator explicitly says the user authorized it.
- Modules ≤300 lines.

## Acceptance

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
