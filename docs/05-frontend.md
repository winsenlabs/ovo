# Frontend, agent configuration and secret management

## 1. Product standard

Build an operating console, not a JSON editor disguised as a UI. An authorized non-developer must configure each supported bot mode, its providers and secrets, test it, publish it, watch calls, inspect failures and revise it. Advanced structured configuration may be available as a secondary import/export view, with the same validation and no secrets.

Global context: workspace, environment, timezone, date range, filters, live/stale indicator. Navigation: Overview, Agents, Calls, Campaigns, Knowledge, Tools, Providers & Secrets, Evaluations, Performance, Infrastructure, Settings. Deployment/access controls remain separate from agent settings.

## 2. Agent studio sections

| Section | Editable configuration | Validation/preview |
|---|---|---|
| Identity | Name, description, mode, tags, language | Unique identifier; supported capability matrix |
| Voice | TTS provider/voice, speed/style supported by provider, pronunciation | Sample playback, unsupported settings disabled with reason |
| Input | STT, locale, supported turn detector, interruption/backchannel settings | Recorded/browser input test; latency and transcript |
| Message | Segments, typed variables/defaults, data mappings, response branches | Rendered text/audio with sample call payload |
| Script | States, prompts, expected intents/slots, transitions, retry/end rules | Graph and accessible table; dangling/unbounded-state diagnostics |
| FAQ | Questions, aliases, answers, scope, matcher thresholds, fallback | Batch question tester, score/margin and selected answer |
| Context | Instructions, facts, files, allowed topics, uncertainty, assembly budget | Source list/version, effective context size, missing/overflow errors |
| Model | Provider binding, model selection, generation/step limits, allowed fallback | Connection test, capability and price information |
| Tools | Enabled tools, endpoint/schema mappings, confirmation, idempotency, timeout | Sandbox invocation and expected result projection |
| Processing speech | Global/agent/tool phrase overrides, language, variants, progress/failure text, caching | Resolved precedence, sample playback, mandatory coverage report |
| Call policy | Greeting/closing, identity flow, duration/silence limits, DTMF, transfer destinations | Complete simulated journey and unsupported-path errors |
| Recording/data | Recording enablement and applicable preconditions, retention selection, redaction | Policy validation and sample export |
| Deployment binding | Number/campaign, certified engine/transport, provider references | Readiness and incompatibility report |
| Test/release | Scenarios, fixture variables, sandbox tools, version diff, publish/rollback | Test evidence and immutable release ID |

Every supported runtime option that affects voice-agent behavior needs a frontend control or validated schema-generated advanced form. No undocumented `.env` edits are required for ordinary voice-provider changes. Not every capability is available for every provider; render declared capabilities honestly.

## 3. Secrets: configured in frontend, never exposed back

The user must be able to add STT/TTS/LLM/carrier credentials, custom inference endpoint credentials, tool API keys, OAuth/client credentials where the selected connector supports them, and webhook-signing references. The backend encrypts/stores these in a secret manager; runtime config holds references. Secrets are not included in prompts or available to a model.

Secret creation form: label, provider/type, environment, permitted bindings/agents, credential fields and optional expiry. Save returns a reference and metadata only. Password inputs do not disable authenticated transport; there must be no plaintext browser persistence, analytics recording, crash-report payload or network-log echo.

List/detail shows label, provider, environment, creator, creation/rotation time, validation state, bindings, expiry and masked fingerprint where safe. Actions: add, test, replace/rotate, rebind, retire/delete. Do not add a reveal button. A connection test runs server-side with bounded timeout and redacted output; it may validate credentials but cannot prove every permission or future quota.

Rotation creates a new backend secret version and updates binding policy atomically. New calls use the new binding; active connections follow documented provider behavior. Call records include a secret-version identifier but never the value. Failed rotation retains the previous binding unless explicitly revoked. Revoking a compromised secret can intentionally break active streams; show impact and audit the action.

Deletion is blocked or clearly confirms affected bindings. Existing releases cannot silently become usable with missing credentials; readiness blocks affected new calls. No production credential is copied into test exports. Test and production bindings are separate.

These screens configure voice-agent integrations, not AWS IAM access keys, VPC, console login, package-publishing tokens or deployment-root credentials. Infrastructure uses workload identities and bootstrap configuration. An authorized operator can manage agent secrets; caller speech and LLM tools cannot administer them.

## 4. Tool configuration UX

Provide a reviewed tool catalogue and an HTTP connector wizard. Define method/URL, credential binding, input schema, request mapping, response projection, tool description, side-effect class, allowed states, required confirmation, deadlines/retries, reconciliation and spoken status phrases. A preview shows redacted request and sample response; a sandbox run is explicit and cannot silently hit production writes.

Schema validation alone cannot prove a financial action safe. The tool configuration binds a server-side policy and, for writes, a confirmation/idempotency/reconciliation strategy. Release checks flag unsupported guarantees. Do not allow arbitrary scripts as a shortcut for integration work.

## 5. Inspector and observability

Live call list: direction, agent/version, caller reference as permitted, elapsed time, listening/speaking/operating states, latest transcript, active operation, worker, carrier leg, error indicator and cost estimate. Filters persist in deep links. End/transfer actions show target and confirmation, then pending/confirmed/failed/unknown backend status.

Call inspector: recording player, aligned transcript with speaker and acknowledgment labels, event timeline, tool detail drawer, stage-latency waterfall, playback evidence, configuration snapshot, outcome, usage ledger and annotations. Selecting text seeks audio where alignment exists; unavailable alignment is explicit. Generated-but-unplayed text is visually distinct and excluded from delivered-transcript exports by default.

Performance: response/acknowledgment/turn/interruption latency p50/p95/p99, sample size, errors/timeouts, provider/language/version cohorts, tool durations and quality outcomes. Click a metric to open contributing calls. Do not average percentiles or compare unmatched cohorts without warning. Cost charts distinguish estimated and reconciled charges and marginal/allocated views.

Infrastructure: ready/busy/draining workers, capacity ceiling, queue depth/age, provider quotas/throttling, restarts, CPU/memory/event-loop lag and recording backlog. Operators should see an actionable explanation, not only raw logs.

## 6. Configuration lifecycle and edge cases

Draft edits autosave with visible state and optimistic concurrency. Conflicting edits show a diff instead of overwriting. Test uses a draft snapshot. Publication creates an immutable config/plugin lock and validates required fields, missing secrets, credentials/capabilities, acknowledgment coverage, template variables, reachable flow and mandatory tests. A provider test can be stale; display last validation time.

Rollback affects new calls. Active calls pin previous configuration unless an emergency action explicitly ends them. Secret revocation is a separate security operation, not a normal config rollback. Import/export retains schemas and references but not secret values; unresolved references require frontend rebinding.

No data or unavailable telemetry has its own empty/error/stale state. Reconnect resumes an event cursor or reloads a snapshot. Recording disabled/expired/finalizing/failed are separate states. Slow exports run asynchronously and can be cancelled. Permission-denied views do not reveal inaccessible record metadata.

## 7. Frontend acceptance summary

- Complete all four bot configurations from the console with no source edit or agent-provider `.env` edit.
- Add, validate, rotate and retire an integration secret; inspect no plaintext value in responses, storage, logs or exports after submission.
- Configure tool-specific “please wait” speech and hear it exactly once in a real test call; change it in a new version and verify version pinning.
- Keyboard operation, visible focus, labelled errors, non-color statuses and accessible chart tables; target WCAG 2.2 AA.
- Desktop 1280/1440 px supports authoring; 390 px supports overview and call review without page overflow. Complex graph authoring can be desktop-only, clearly stated.
- Live updates within two seconds p95 of backend ingestion under reference load; stale status within five seconds of heartbeat failure.
- At least four of five representative operators identify a seeded slow tool and open its call evidence in two minutes without engineer help.

## 8. Routing console (Wave 18)

The routing screens follow the shell's page contract: page header, KPI strip, one primary visual, detail tables, drawers for
forms, light and dark from tokens only, a phone layout and axe-clean at 390, 768 and 1280. The nav item **Routing** (group
Inbound) is visible even where routing is switched off; every screen then says "Routing is not enabled here" instead of failing
(`GET /v1/routing/status` answers while the feature is dark, every other route is `404 routing_disabled`).

| Route                       | What it is                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/routing`                  | KPIs and a stacked routed-calls chart (with its table) from `GET /routing/stats`; tabs Points, Pools, Hold clips; create-point and create-pool drawers.                                     |
| `/routing/points/[pointId]` | The designer: header badges, KPI strip, read-only route map, tabs Tree, Lines & languages, Hold & transfer, Human queues, Numbers, Releases, Simulate.                                       |
| `/routing/pools/[poolId]`   | Pool editor: members and attributes, live claims every 10 s (a stale chip and retry when a poll fails), "Who would answer?".                                                                |
| `/routing/simulate`         | The route tester (`?point=` or `?release=` to arrive from elsewhere); also the designer's Simulate tab, which runs the working copy.                                                         |
| `/operations/queues`        | The R3 queue admin, plus a per-queue **Activity** drawer (24 h or 7 d, ids and codes only) and links from "Used by" into the designer. Its editors now live in `components/routing/`.       |

**Working copy.** `useRoutingDraft` loads a point with its ETag, parses the draft with the contract defaults, and edits a typed
copy. Zod and `routingDraftIssues` run in the browser on every change; the server's resolution checks (`POST /validate`) run
debounced at 800 ms and only while the schema is intact. Every issue is anchored (`lib/derive/routing-anchor.ts`) onto the
question row, branch, engine, fallback step or tab it concerns, in words, with a count on the tab. Save sends `If-Match`; a
`409 routing_point_conflict` keeps the working copy, shows `routingDiff(server, mine)` and offers "load theirs" or "keep mine and
save over". Leaving with unsaved changes asks first (reload, tab close and in-app links).

**Tree.** `role="tree"` with roving tabindex: arrows move, Right and Left open, close and step in and out, Enter opens the
question's drawer. Nothing is drag-only; every reorder is an Up/Down button. The pure edits (rename a question and every
reference to it, delete refused while something leads there, rename a branch and its rules, rename a queue key everywhere) are in
`lib/derive/routing-edit.ts` and tested without a browser. The route map is a picture (`role="img"` plus the outline list, which
is the only form on a phone).

**Publish.** The drawer calls `POST /preview-publish`: blockers disable Publish, warnings are listed, "nothing changed since vN"
disables it too, and it shows the digest, the change list grouped by area and the `latest -> pinned` agent pins. Unsaved edits are
not published, so it asks to save first. After publishing, numbers keep their release until bound to the new one.

**Numbers.** A number is "Routing point" (`routingReleaseId`) or "Direct agent" (`releaseId`), stated in words. Admins bind with
`PUT /operations/inbound/routes/:phone` (`routingReleaseId`, `expectedVersion`); a direct number that becomes routed must be
confirmed, and an earlier release is a rollback.

**Simulator.** A scripted caller (typed words, keypad, silence, caller id, called number, variables, a clock in the router's zone)
runs through a release or the draft. Model, decision and external engines are scripted by default (the form lists a row per engine
in the tree); rules always run for real. A real engine is a switch, disabled with the reason from `status.simulate`. The result
shows KPIs, the route as a chain of questions with confidence meters and fallbacks, a trace table with "Answer as..." for an engine
that had no scripted answer, the conversation, the pools considered (why each member was or was not eligible) and warnings. "Save
as an eval case" turns a run into a `RoutingEvalCase` to copy or download as JSONL. Offline runs score the tree, rules and pools,
not model quality.

**Data layer.** `lib/types/routing.ts` and `routing-simulate.ts` hold the Wave 18 wire shapes until the contracts step exports them;
the pure helpers (`routingIssueAnchor`, `routingDiff`, `holdTimeline`, the edit helpers) sit in `lib/derive/routing-*.ts` and
swap for the contracts versions without touching a component. The console fixture API (`e2e/fixtures/routing-api.mjs`, scenarios
rich, empty, down, disabled) answers every route, including a small deterministic router for the simulator.
