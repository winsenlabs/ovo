# OVO implementation progress

Updated: 2026-09-20 UTC. Branch: `vorflux/ovo-foundation`.

## Repository baseline

The starting repository contained README and 12 specification documents only. No application, CI, package manifest, infrastructure or tests existed. All documents were read before application implementation. GitHub Actions are suspended; checks run locally.

## Current checkpoint

- Initial upstream source audit complete for DeepSeek Harness/Cordis, Pipecat, LiveKit Agents JS, AI SDK and carrier/AWS documentation.
- DeepSeek pinned to `ddefc45fbc7f8e46dd73185e68295696d1297887`; actual patched Cordis/Cosmokit and scope source imported. Profile composition and lifecycle adapted, not independently recreated.
- Strict TypeScript/pnpm workspace exists; first-party packages remain private under `@winsendotai/ovo-*`.
- Retained upstream scope/store tests: 21 passed locally on Node 22.21.0. Vendor declarations use the upstream compiler exceptions; first-party code remains strict.
- Parallel implementation: voice behaviors/scheduler, shared tool execution/MCP/HTTP, management API/storage/secrets, console design, scheduling/Fargate/Twilio and comparative real-SDK prototypes.

## Project management

[PM/README.md](../PM/README.md) tracks W01–W20. Each package has its complete task checklist. [PM/acceptance.md](../PM/acceptance.md) tracks all 75 criteria; no criterion is yet fully verified.

## Verification and blockers

Source inspection is not live integration evidence. No provider account, live carrier call, AWS deployment, paid action, package publication or customer call occurred. Production engine selection remains provisional until comparable prototypes and carrier evidence meet the research gate. No launch claim is made.

## Next actions

1. Verify composition, startup rollback, session isolation and plugin replacement.
2. Complete local vertical slices and connect the management console to persisted APIs.
3. Execute comparative prototype fixtures and local CI; keep remaining certification gates visible.

## Checkpoint 2 — foundation and independent slices

- PM now contains all 20 work-package checklists and the exact 75 acceptance requirements, with explicit dependency links.
- All 32 foundation/schema tests pass. An SDK-only external plugin adds an isolated configuration/disposal conformance test.
- The observability plugin adds exact decimal/native-unit pricing, currency-separated summaries, deterministic replay validation and conservative redaction. Five local tests pass. Durable API projection integration remains open.
- Console visual design approved; Next.js implementation uses the real management API contract.
- Local dependency audit identified vulnerable older AWS/Ajv transitive versions during parallel implementation. Builders received pinned-version upgrades. The final lockfile audit remains pending; no remote CI is assumed.

## User requirement — modular code

The user explicitly requires no large monolithic files. All active implementation tasks received this requirement. A local gate measures canonically formatted first-party code, with a 400 nonblank-line/24 KiB cap (500 lines for tests). The preferred target is under 300 lines and one responsibility per module. Exact imported upstream files retain their layout and source hashes.

## Checkpoint 3 — runnable local services and dependency audit

- The persisted management API serves its health check through the public preview proxy. The Next.js console starts on port 3000 and returns its page through the public preview host. Full browser journeys are not yet verified.
- Local bootstrap generates random keys into an ignored mode-0600 file without printing them.
- Backend bundle compilation succeeds for API, worker and dispatcher. Console TypeScript checking succeeds at this checkpoint.
- Production dependency audit reports zero advisories after pinned updates. Dependency/license inventory includes LiveKit's model-specific terms and LGPL native dependencies; experimental dependencies are not silently approved for deployment.
- The initial comparative spike uses real LiveKit `AgentSession` and AI SDK APIs under the DeepSeek-derived host. Seven tests and 80 fixture samples pass. The first cold-session timings are intentionally not a production engine ranking; a matched hot-session refinement is underway.
- Domain implementations now split oversized files under the user's modularity requirement. The local size gate currently blocks remaining oversized storage/API/MCP files until those splits finish.

## Checkpoint 4 — integrated local gate before independent verification

- `./scripts/local-ci.sh` passes: frozen install, architecture/provenance/module-size gates, formatting, full workspace/console types, 117 tests, three backend bundles, production Next.js build and all-dependency advisory audit.
- Four PostgreSQL-only cases skip in the default suite. The deployment slice separately ran its real disposable PostgreSQL suite: 5/5 passed, including ten concurrent claims with one owner.
- The first integrated build failed because the root bundler did not load SQL assets. The canonical worker/dispatcher package builds now own those artifacts, and the complete gate passes after the fix.
- All first-party source files pass the size gate. Imported upstream files remain untouched and hash-locked.
- Recording storage and the real API/console playback path exist. Local tests use generated WAV fixtures only. S3 and live carrier capture remain unverified.
- The final comparative experiment uses matched hot sessions and actual focused components. It retains 100 passing samples with source/lockfile identities; no live audio conclusion follows.
- Default API releases support announcement and FAQ. Context and agent behavior plugins work in focused tests/prototypes but need approved inference/execution/speech/tool composition before the default API can publish them. This is an open integration task, not merely a credential blocker.
- Independent browser verification and one focused post-implementation review remain before this checkpoint's handoff.
