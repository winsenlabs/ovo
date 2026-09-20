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
