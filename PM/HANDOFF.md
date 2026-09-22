# OVO continuation handoff

Updated: **2026-09-22**. Read this before continuing implementation or verification.

## Current instruction: work remains paused

The user requested this documentation update, not a restart of implementation or testing. Do not start builds, browser checks, services, or deployments until the user resumes that work.

The user paused all work on September 20. On September 21, the user resumed **only engine replacement and the worker TypeScript fix**. That scoped work is complete and pushed. The broader checks below remain paused.

## Repository and delivery state

- Repository: https://github.com/winsenlabs/ovo
- Continue on the existing branch: **`vorflux/ovo-foundation`**.
- Existing draft PR: https://github.com/winsenlabs/ovo/pull/1
- Do not move implementation onto `main`, create another implementation branch, or merge the PR without authorization.
- Runtime checkpoint: `fbfba0683f18424fd4bcbf01f1fd06eedea8dbed` — completed engine replacement.
- Pre-handoff branch head: `c7d0f956c941e56910f3508e981995e6cdf632aa` — records A65 verification.
- This handoff adds documentation and a recovery snapshot. It does not apply or finish the pending setup changes.
- The overall Test Report remains **PARTIAL**. Do not describe the system as production-certified.

## Fixed product decisions

- One self-hosted installation serves one organization. No SaaS provisioning, organization switching, subteams, or team hierarchy.
- The first administrator is seeded. Administrators add users through the console. Multiple administrators can coexist.
- Email/password is the default login. Team roles are **Admin** and **User**; User maps to the existing `editor` permission.
- Explicit legacy token operators remain compatible. Seed-only installation metadata cannot authenticate as a hidden token administrator.
- `workspaceId` remains an internal isolation namespace. Do not remove its authorization checks.
- Initial provider profile: **Twilio + Deepgram streaming STT + OpenAI TTS/inference**.
- Fargate is the primary deployment profile; self-hosted Compose is also implemented.
- Keep actual DeepSeek/Cordis source reuse and plugin-owned capabilities. The four behavior modes are announcement, FAQ/script, supplied context, and agent/tools.
- The user specifically requested **one branch** and **no excessive review**.

## Infrastructure choices

| Concern | Current implementation |
| --- | --- |
| Durable data | PostgreSQL for control state, releases, jobs, ownership, users, costs, and telemetry |
| Queue notifications | Amazon SQS; local Compose uses SQS-compatible ElasticMQ |
| Job correctness | PostgreSQL leases, epochs, outboxes, and reconciliation fences; duplicate queue messages must not cause duplicate calls |
| Caching | Bounded in-process speech cache; no Redis dependency; restart clears cache, not durable state |
| Telemetry | Built-in telemetry plugin, bounded buffered PostgreSQL writes, stage timings, performance queries, SSE replay to the console |
| Logs | Application/container logs locally; CloudWatch logging in the Fargate configuration |
| Recordings | Separate recording/object-storage service; local Compose shares a durable recording volume between API and workers |

Managed PostgreSQL and managed standard SQS can replace local containers. Managed-service configuration rendering passed; actual managed services were not certified. Redis and ClickHouse are not required. Do not imply an OTLP/Prometheus/Grafana integration exists without checking the code.

## What is implemented

- Shared asynchronous PostgreSQL control storage and immutable release/provider/MCP snapshots.
- Four behavior modes, deterministic scripts, shared tool execution, and fixture-isolated multi-turn simulations.
- Provider/media gateway integration, streaming inference and speech, playback context, interruption, and heard-confirmation controls.
- Durable campaigns, suppression, handoff, inbound admission, bounded wait, and consent-based callback.
- Recording consent, capture, PCM-WAV playback, exports, tombstones, and retention.
- Price cards, FX, reservations, required live meter coverage, cache accounting, and reconciliation.
- Versioned evaluation datasets and 120 deterministic cases. Paid evaluation execution requires durable admin authorization and a server-only enable flag.
- Operating console, performance inspection, infrastructure views, and resumable SSE.
- Seeded administrator, flat user administration, password hashing, session revocation, last-admin protection, and explicit restored-user recovery.
- Exclusive release-pinned engine selection, described below.

Implementation presence does not prove all console journeys or external integrations work. Use the remaining checklist instead of reopening an obsolete foundation backlog.

## Engine replacement is finished — do not redo it

The worker formerly appended its built-in engine even when a release selected a replacement. It now selects exactly one release-pinned engine. Unselected installed engines do not alter a release. The built-in engine is the fallback only when no replacement is selected.

Normal API publication pins a worker-only replacement without applying it. Simulations execute only the behavior graph. The worker executes the selected replacement with unchanged behavior and ordered cleanup.

Missing dependencies, missing/stale pins, and multiple selected engines fail before engine apply. Regression tests verify recording and telemetry cleanup. The worker TypeScript literal-set error is also cleared.

Independent verification at `fbfba06` passed:

```sh
pnpm exec vitest run \
  apps/api/tests/voice-engine-release.test.ts \
  apps/worker/tests/production-engine-selection.test.ts \
  apps/worker/tests/native-extension-pins.test.ts \
  apps/worker/tests/session-recording.test.ts --reporter=dot
pnpm typecheck
pnpm --filter @winsendotai/ovo-worker build
node scripts/check-module-size.mjs
```

Result: **14 tests passed**, workspace typecheck passed, worker bundle passed, module gate passed for 530 files. **A65 is verified locally** in `PM/acceptance.json` and `PM/acceptance.md`.

## Other evidence already obtained

These checks occurred at different checkpoints. Do not add overlapping counts or present them as one fresh final run.

- Earlier full local CI passed **364 tests**, with **82 environment-gated skips**, before later team/engine changes.
- Dedicated PostgreSQL suites covered storage, ledger, observability, recordings, orchestration, operations, evaluations, API startup, and worker lifecycle.
- PostgreSQL + ElasticMQ WebSocket lifecycle E2E passed using local protocol fixtures.
- The restore drill passed **3/3**, including later restored-user quarantine coverage.
- Team PostgreSQL/session checks passed **8/8**. Console checks passed **26 tests** at the team checkpoint.
- The canonical evaluation corpus passed **120/120** through actual behaviors with fixture bindings.
- Browser evidence covers roles, authoring/publishing, stale-draft conflict recovery, credential creation/rotation/redaction, seeded login, and second-admin creation.
- The pending Compose worktree started **all eight services healthy** before the pause. Seed login through the console proxy, user creation/disable, and shared recording-volume writes passed. Workers stayed `dial-disabled`.
- Browser walkthrough recording failed twice during finalization and produced invalid WebM files. Those files were deleted. Use valid screenshots; do not spend more time on recorder retries without a specific request.

Two valid review blockers were fixed: restored authorization/admission quarantine and inbound durable ownership renewal. A third reported evaluation-attempt defect was retracted: the reviewed code already used `attempt >= max_attempts`. A crash regression confirms failure rather than endless running and retains unknown-spend reservations for reconciliation.

The focused production review rated its scope 6/10; team authentication received 5/10. Both found no remaining material defect in their reviewed scope after corrections. These were not whole-system certifications of the latest combined worktree. Do not repeat broad reviews unnecessarily.

## Preserve the pending setup work

The following changes still existed outside the committed implementation when this handoff was written:

```text
README.md
apps/console/components/team/team-view.tsx
apps/dispatcher/src/main.ts
docs/README.md
docs/evidence/deployment-implementation.md
infra/compose/.env.example
infra/compose/compose.yaml
infra/container/Dockerfile
docs/runbooks/self-hosted-compose.md       (new)
scripts/bootstrap-compose.sh              (new)
scripts/verify-compose.sh                 (new)
```

They include the verified Compose/bootstrap path, managed-service instructions, non-root/shared-volume integration, and a small “Initial password” label correction. Do not discard them or silently include them in an unrelated commit.

For a fresh clone, the exact pending diff is preserved as **[handoff/paused-setup.patch](handoff/paused-setup.patch)**. This is a non-applied recovery snapshot, not an additional implementation branch or a claim that those changes are integrated.

- Snapshot base: `c7d0f956c941e56910f3508e981995e6cdf632aa`
- SHA-256: `d9031e7712a8401281b07a352ecb202d81db460a5ae6d435081387a3942b5913`
- The snapshot contains only the 11 listed source/documentation/example files. It excludes real environment files, credentials, databases, recordings, and local artifacts.

**After authorization to resume**, inspect `git status --short` first. In the original workspace, these changes are already present: **do not apply the patch twice**. In a clean clone where the changes are absent, use:

```sh
git apply --check PM/handoff/paused-setup.patch
git apply PM/handoff/paused-setup.patch
```

If the check fails, stop and inspect differences. Do not force the patch or reset unrelated work. After integrating the setup changes, remove or clearly retire this snapshot so a later agent does not reapply it.

## Next work, in order — only after the user resumes

### 1. Finish actual browser verification

Use synthetic local fixtures. Keep paid evaluation and live dialing disabled. Read `apps/console/OPERATOR_E2E_HANDOFF.md` for UI/API contracts.

| Area | Required remaining checks |
| --- | --- |
| Campaigns | CSV preview/import, create, pause, resume, cancel; suppression and handoff mutations |
| Costs | Price-card, FX, budget, cost-policy, and reconciliation writes; truthful unknown/estimated/reconciled labels |
| Recordings | Synthetic capture; inbound/outbound WAV playback and byte-range seek; export; tombstone/deletion and retention |
| Evaluations | Fixture execution, actual cancel/compare submissions, idempotency, and resulting state; do not equate a rendered comparison control with a successful comparison |
| Performance | Populated cohort interactions and visible SSE reconnect/cursor recovery; API replay already has evidence |
| Responsive/accessibility | 390px layout, keyboard navigation, focus, form reachability, and overflow |
| Error handling | Inject a bounded component/request failure; verify useful recovery and unaffected surrounding controls |
| Team follow-through | Confirm last-admin, disable/reset, self-password change, session revocation, and seed restart through the final combined deployment; backend tests already cover these |

Fix only concrete in-scope defects found by these checks. Report precise blockers rather than repeatedly returning a list of unattempted journeys. Capture a small set of useful screenshots. A walkthrough video is not a prerequisite.

### 2. Verify the final combined source

After pending setup changes and any browser fixes are stable, run the full local CI and the relevant isolated PostgreSQL/lifecycle/restore suites. Reuse existing regression tests instead of restarting the project or redesigning it.

```sh
./scripts/local-ci.sh
./scripts/run-postgres-restore-drill.sh
```

Follow script documentation for disposable PostgreSQL credentials. Do not point destructive restore tests at the preview database or another project's services. Rerun the Compose smoke check if the final changes affect its images or runtime configuration.

GitHub Actions were unavailable/suspended during this work. Local CI is the known evidence path; check the current situation before relying on hosted CI.

### 3. Finish the same-branch handoff

- Commit and push the remaining validated setup changes on `vorflux/ovo-foundation`.
- Update the existing PR, not a second PR or branch.
- Reconcile all **20 work packages and 75 acceptance criteria** with actual evidence. Do not mark external gates passed from fixture results.
- Update the existing Test Report with the exact title **`OVO foundation verification`**. It currently remains PARTIAL overall.
- Use the existing approved plan title **`OVO console visual design`** if revising that plan. Do not re-plan already completed work.
- Keep production certification distinct from completing local engineering.

## External validation is separate

No real carrier calls/transfers, paid provider runs, AWS provisioning, production object-store staging, invoice reconciliation, production RPO/RTO measurement, or human listening certification occurred. Obtain explicit authorization and the target configuration before those activities.

Do not enable live/provider flags as a shortcut to browser testing. A carrier playback mark is not proof that a human heard the audio.

## Safety constraints that must remain intact

- Validate immutable release bindings and required carrier/STT/TTS/LLM meter coverage before live admission.
- Keep budgets honest: reservations are admission guards, not strict caps on later provider invoices.
- Renew both task protection and durable job ownership. Ownership loss must drain and terminate the carrier leg.
- Honor `release.config.recording`; disabled recording must not capture or create recording rows.
- Preserve restore fences for jobs, outboxes, campaigns, paid evaluation ambiguity, authorizations, inbound admissions, and users. Never bulk-clear fences.
- Ordinary startup must not reset an existing admin password. Restored-user recovery is explicit and requires new credentials.
- Preserve write-confirmation and unknown-outcome protections. Do not revive the old `variables.confirmed` bypass.
- Keep module limits: 400 canonical nonblank lines / 24 KiB; tests 500 lines. Prefer under 300 lines. Imported upstream source has separate provenance rules.

## Local-machine context is not portable

The prior sandbox used PostgreSQL-backed API port 4000 and console port 3000. The console development server was stopped on request. Do not assume any process, authentication state, port, or preview link still works.

Ignored `.data/production.env`, `.data/preview-postgres.env`, and `.data/user-e2e.env` held disposable local configuration. Never print or commit their values. A fresh clone must bootstrap its own credentials.

The prior sandbox's master report was `/code/.generated_artifacts/test_report.md`; screenshots were under `/code/.generated_artifacts/images/`. Planning files were under `/code/.plans/`. These paths may not exist on another machine. The repository evidence and this handoff are the portable starting point.

## Read next

1. [NEXT.md](NEXT.md) — concise remaining-work list.
2. [acceptance.json](acceptance.json) and [acceptance.md](acceptance.md) — requirement-level evidence.
3. [tasks/](tasks/) — 20 work packages; older task notes can predate this handoff.
4. [Console operator handoff](../apps/console/OPERATOR_E2E_HANDOFF.md).
5. [Operators and extensions](../docs/runbooks/operators-and-extensions.md).
6. [Backup and restore](../docs/runbooks/backup-restore.md).
7. [Deployment evidence](../docs/evidence/deployment-implementation.md) — includes pending updates in the recovery snapshot.
8. `docs/runbooks/self-hosted-compose.md` — available in the original worktree or after authorized snapshot recovery.
