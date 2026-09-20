# Engineering work breakdown and delivery plan

## 1. Estimation assumptions

Estimates are focused engineer-days, including implementation, relevant automated tests, review fixes and task documentation. They are planning ranges, not promises. They assume experienced TypeScript/backend engineers, voice/media experience available for review, one initial carrier, one launch language plus a separately certified second language, existing provider accounts/test numbers, and no complete upstream framework rewrite.

Cross-cutting research is included in W01–W03 and provider/deployment tasks; do not add the research table a second time. Full production certification, frontend polish and failure recovery are real work. AI coding assistance may reduce typing time; it does not eliminate provider lead times, audio evaluation, security review or operational testing.

## 2. Work packages

| ID | Work package | Dependencies | Engineer-days |
|---|---|---|---|
| W01 | Research, provider/stack evaluation, ADRs | None | 6–10 |
| W02 | Monorepo, contracts, CI and package conventions | W01 preliminary | 3–5 |
| W03 | Plugin host and deterministic voice harness | W02 | 6–10 |
| W04 | Audio scheduler, interruption and playback context | W03 | 8–14 |
| W05 | Carrier transport, routing and call control | W03, W01 | 6–10 |
| W06 | STT/TTS/inference adapters and provider tests | W03 | 5–8 |
| W07 | Durable jobs, ownership, outbox and recovery | W02, W05 interfaces | 6–10 |
| W08 | Announcement behavior and variable rendering | W04, W06 | 3–5 |
| W09 | Deterministic FAQ and script behavior | W08 | 4–7 |
| W10 | Supplied-context and bounded agent behavior | W04, W06 | 5–8 |
| W11 | Tool execution and acknowledgment middleware | W04, W07, W10 interfaces | 6–10 |
| W12 | Management API, versions and config validation | W02, W03 | 5–8 |
| W13 | Provider binding and secret lifecycle | W12 | 4–7 |
| W14 | Console shell, agent studio and authoring | W12, W13 interfaces | 9–15 |
| W15 | Call inspector, telemetry and performance views | W04, W07, W12 | 8–13 |
| W16 | Inbound, campaigns, quotas and handoff | W05, W07, W12 | 5–9 |
| W17 | Recording, artifact access, retention and exports | W05, W07, W12 | 4–7 |
| W18 | Cost ledger and reconciliation | W06, W07 | 3–5 |
| W19 | Fargate and EC2 profiles, drain/restore/runbooks | W05, W07 | 6–10 |
| W20 | Evaluation console, load/fault/security gates, release | W08–W19 | 8–14 |

Total baseline: 110–185 engineer-days. Add 20–30% planning contingency for media/provider integration, new requirements and hardening, giving approximately 132–241 engineer-days. This excludes legal advice, carrier procurement delays, ongoing operations, and a broad public plugin ecosystem. Re-estimate after W01 and the first real call.

A staffed example is two backend/runtime engineers, one frontend engineer, part-time voice/infrastructure expertise, product/design and QA support. At roughly 3.5 effective engineering FTE, pure effort is about 8–14 working weeks; dependencies, reviews, external integration and staged rollout make a 12–20 calendar-week production plan more plausible. One engineer should plan in months (roughly 7–12 at 20 focused days/month with contingency), not a weekend. A narrow demo may arrive in 2–4 weeks with parallel staffing; it is not launch completion.

## 3. Detailed deliverables and exit checks

### W01 — Ground the stack

- Execute the source-reuse audit in [11-deepseek-foundation.md](11-deepseek-foundation.md); record upstream commit, dependency closure, import boundaries and license obligations. Direct reuse is fixed; import mechanics and voice integration need evidence.

- Complete [the upstream research assignment](09-upstream-research-assignment.md): inspect DeepSeek Harness, Pipecat, LiveKit Agents JS, Cordis and Vercel AI SDK; retain source evidence and comparative spikes.

- Inspect source and official docs listed in research plan; record immutable source references.
- Compare custom TypeScript pipeline with LiveKit Agents JS, using Pipecat as behavior reference.
- Validate target carrier/deployment paths and credentials availability; map uncertainty explicitly.
- Deliver research matrix, initial ADRs, media topology and implementation recommendation.
- Exit: no unexamined assumption about mandatory LiveKit, Python parity, Fargate media compatibility or tool/playback ownership.

### W02 — Foundation

- Initialize pnpm workspaces and strict TypeScript with `@winsendotai/ovo-*` first-party names; applications private.
- Define configuration/event/error/ID schemas and compatibility/version rules.
- Add format/lint/typecheck/test/build CI; secret scanning and dependency/license checks appropriate to chosen tooling.
- Exit: clean checkout installs/builds; invalid payload fixtures reject; namespace check passes.

### W03 — Composition and deterministic harness

- Implement dependency graph, manifest schema, scope, lifecycle and startup rollback.
- Build virtual-clock transport, mock providers and frame inspection assertions.
- Add capability resolution, config validation and readable incompatibility errors.
- Exit: swap adapters without behavior edits; cancellation/cleanup tests reproducible without external services.

### W04 — Voice kernel

- Implement urgent and ordered work lanes, fairness, bounded buffers and backpressure.
- Implement response epochs, streaming text segmentation, audio playback queue and flush.
- Track generated/sent/played-or-estimated output; maintain interrupted conversation context.
- Exit: repeated interruptions never replay stale audio; end/hangup releases resources; slow providers do not grow queues indefinitely.

### W05 — Carrier and transport

- Implement callback verification, dial/answer/end/status, media decoding/encoding and session routing.
- Certify codec, clear/playback markers, DTMF and selected transfer capability.
- Test uncertain dial acceptance, duplicate/out-of-order callbacks and long-lived connection routing.
- Exit: real owned-number inbound/outbound calls; capability matrix and provider limitations published.

### W06 — Model providers

- Implement one STT, TTS and LLM adapter with streaming, cancellation, deadlines and exact usage capture.
- Add a second STT or inference adapter to prove replacement; expose provider-specific capability schemas.
- Record language, endpointing, voice and cache support; verify actual pricing units rather than reuse old conversation estimates.
- Exit: real provider fixtures and usage ledger agree; unsupported parameters fail before dialing.

### W07 — Durable orchestration

- Implement job/outbox transaction, SQS delivery, conditional lease/epoch and heartbeat.
- Persist session/operation intent/results and projections; implement reconciliation and DLQ/redrive.
- Test crashes around dial and write-operation boundaries; isolate queue failures from active calls.
- Exit: ten duplicate deliveries produce one owned attempt; uncertain external side effects never trigger blind retry.

### W08 — Announcement mode

- Define variable types, safe rendering, locale/timezone formatting and sample preview API.
- Implement one-way and fixed-response/DTMF branches, repeat/closing rules and cache segments.
- Supply appointment and flight-notification templates with synthetic data.
- Exit: missing variables block dial; rendered values correct; no LLM request or credential required.

### W09 — FAQ and script

- Implement FAQ CRUD/import, lexical/alias matcher, thresholds/margins and deterministic fallback.
- Implement validated state graph and interruption/FAQ resume points.
- Add batch matcher diagnostics and no-match/negation/multi-intent scenarios.
- Exit: no-generative-LLM FAQ passes approved corpus and explicitly clarifies unsupported input; no hidden embeddings dependency.

### W10 — Context and agent behavior

- Implement supplied-context assembly, provenance, budget enforcement and uncertainty behavior.
- Add bounded model/tool continuation and structured interpretation validation.
- Keep context-only mode tool-free by default and support policy-controlled behavior transitions.
- Exit: unanswerable questions do not become confirmed facts/actions; loop limits produce bounded recovery.

### W11 — Tools and acknowledgments

- Implement schema/policy/confirmation gate and durable operation identity.
- Implement configurable HTTP tool mapping, credential references, deadlines, safe retries and reconciliation.
- Implement phrase precedence, cached/live speech, progress updates, duplicate suppression and completion ordering.
- Exit: every customer-facing check says its configured phrase once, including fast results; interrupted tools preserve correct state.

### W12 — Management API

- Implement drafts/releases, optimistic edits, validation, publication and rollback.
- Add call/config/search APIs, signed business webhooks, command status and event cursors.
- Generate OpenAPI/client; enforce existing workspace/role boundaries without expanding into a separate IAM product.
- Exit: frontend can manage all required agent settings through APIs; immutable releases and stale-edit conflict tested.

### W13 — Secrets and bindings

- Implement write-only credentials API backed by selected secret store, scoped metadata and server-side validation.
- Implement rotation/rebind/retirement, environment separation, runtime resolution and comprehensive redaction.
- Add credential-impact checks to publication/readiness.
- Exit: authorized operator configures providers in browser; no plaintext read/export/log leakage; failed rotation preserves explicit state.

### W14 — Agent studio

- Build navigation/design system, mode wizard, schema-driven forms and voice/message previews.
- Add script/FAQ/context/tool editors with accessible alternatives to graph interactions.
- Add secret-management UI, acknowledgment editor, effective-config preview, test and release diff.
- Exit: four mode journeys completed without source/env edits; loading/error/stale/permission states and keyboard workflows pass.

### W15 — Inspector and performance

- Instrument stage traces and durable UI projections without blocking audio.
- Build live calls, synchronized transcript/recording, operation drawer, playback timeline and version links.
- Add cohort filters, real percentiles, alert links and actionable diagnostics.
- Exit: operator usability target passes; missing recording and estimated playback are labelled honestly.

### W16 — Operations

- Implement inbound admission, warm-capacity/overflow policy and human escalation.
- Implement campaign CSV preview, scheduling, timezones, suppression, quotas and pause/resume.
- Test redrive/cancellation races and transfer failure fallback.
- Exit: no over-capacity silent answers or suppressed queued dials; campaign counters reconcile.

### W17 — Recordings and exports

- Implement certified recording adapter, finalization/retry, metadata/checksum and partial artifacts.
- Implement tenant-authorized playback/download, retention jobs and deletion/index cleanup.
- Add redacted asynchronous export and safe replay stub bindings.
- Exit: upload failure does not fake availability; replay cannot call customers or mutate production systems.

### W18 — Cost

- Define native-unit usage entries, price/FX versions, fixed-precision money and reconciliation states.
- Allocate worker/shared costs transparently and include failed attempts, transfers, cache generation and retries.
- Build INR/paise views, budget reservation and ₹10/two-minute scenario controls.
- Exit: fixture arithmetic reconciles; no assumed cache savings shown as actual; late billing caveat explicit.

### W19 — Deployment and runbooks

- Implement Terraform Fargate and single-EC2/Compose profiles, workload identities, network/secret setup and image deployment.
- Implement the primary Fargate profile according to [08-plugin-first-fargate.md](08-plugin-first-fargate.md): one scaling authority, mutually exclusive capacity counts, scale-from-zero, inbound prewarming, quota-aware admission, protection renewal and rollout headroom.
- Add console scale-decision evidence and run burst, stale-metric, queue-empty-active-call and return-to-zero drills.
- Write install, migration, backup/restore, provider outage and lost-worker reconciliation runbooks.
- Exit: both profiles run same released agent; two EC2 workers isolated; no hidden EC2 component in all-Fargate label.

### W20 — Release evidence

- Build evaluation dataset/run/compare UI and at least 120 cases covering all bot modes and failures.
- Run realistic load, fault, security, credential and retention tests; perform human listening review.
- Package developer docs, SDK examples, capability certification and known limitations.
- Exit: all launch acceptance criteria pass, research blockers resolved, clean-account install reproduced.

## 4. Milestones and critical path

M0: W01–W03 produce decisions/contracts/harness. M1: W04–W08 plus minimum W07/W11 produce one excellent real call and variable announcement. M2: W12–W15 produce the management experience while W09/W10 add behaviors. M3: W16–W19 produce inbound/operations/recording/deployment. M4: W20 verifies full launch.

Critical path: runtime/transport choice → cancellation/playback correctness → real carrier → durable operation semantics → console evidence → load/failure certification. Frontend can start against validated schemas and fixtures once W02/W12 interfaces stabilize; it must later use real APIs. Do not wait until the end to discover the inspector lacks the events it needs.

## 5. Scope-control rules

If schedule is constrained, release a clearly labelled preview with fewer certified providers/languages or one deployment profile. Do not silently remove bot modes, frontend secrets/configuration, acknowledgments, isolation or correctness requirements. Do not label mock data as live observability. Do not expand into every Pipecat integration, video, or arbitrary workflow programming before the core acceptance gates.

## 6. Additional mandatory verification mapping

A73–A75 cover the DeepSeek import/provenance, lifecycle integration and MCP tool boundary in W01/W03/W11/W14. Re-estimate after the upstream dependency audit; do not assume extraction is cost-free.

A63–A65 are W03 architecture/conformance work; A66–A71 are W07/W15/W19 lifecycle and operations work; A72 is the W01/W03 upstream evidence gate. These elaborate existing scope. Re-estimate after the spikes if required adaptations exceed the baseline; do not present added implementation work as already complete.
