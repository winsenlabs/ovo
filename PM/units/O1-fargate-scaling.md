# Work unit O1-fargate-scaling: Fargate-native autoscaling (AAS-only desired count, capacity signal), Terraform #7 fixes, Compose profile, queue liveness sweeper with poison cap and DLQ reconciler, dispatcher task runner, worker protection changes

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [7, 15, 17, 23]

## Owned paths

- infra/terraform/**
- infra/compose/**
- packages/plugin-orchestration/**
- apps/dispatcher/** (not package.json)
- apps/worker/src/main.ts
- apps/worker/src/worker-process.ts
- apps/worker/src/worker-loop.ts
- apps/worker/src/runner.ts
- apps/worker/src/inbound-runtime.ts
- apps/worker/src/renewal.ts
- apps/worker/src/claim-delivery.ts
- apps/worker/src/campaign-dial.ts
- apps/worker/src/dial-request.ts
- apps/worker/src/dial-settlement.ts
- apps/worker/src/reconciliation.ts
- apps/worker/src/worker-cleanup.ts
- apps/worker/src/worker-environment.ts
- apps/worker/src/runtime-plugins.ts
- apps/worker/src/worker-health.ts
- apps/worker/src/worker-reporter.ts
- apps/worker/src/worker-options.ts
- apps/worker/src/worker-plugin.ts
- apps/worker/src/worker-types.ts
- apps/worker/src/infrastructure-metrics.ts
- apps/worker/src/index.ts
- apps/worker/tests/worker.test.ts
- apps/worker/tests/inbound-runtime.test.ts
- apps/worker/tests/infrastructure-metrics.test.ts
- apps/worker/tests/campaign-dial.test.ts
- apps/api/src/infrastructure-service.ts
- apps/api/src/infrastructure-types.ts
- apps/api/src/infrastructure-worker-samples.ts
- apps/api/src/infrastructure-plugin.ts
- apps/api/src/infrastructure-runtime.ts
- apps/api/src/routes/infrastructure.ts
- apps/api/tests/infrastructure.test.ts
- packages/plugin-storage/tests/infrastructure-postgres.test.ts
- packages/distribution/src/profiles/worker.ts
- packages/distribution/src/profiles/dispatcher.ts
- scripts/baselines/pending/O1.json

## Shared touchpoints (minimal edits allowed)

- apps/worker/tests/lifecycle.integration.test.ts: owned by C2; you may make compile-only edits in separate hunks for signatures you changed

## Specification

GOAL: make ECS/Application Auto Scaling the ONLY writer of worker desired count, with the dispatcher only computing and publishing a signal and running background tasks. This unit also fixes:

- #7: Terraform security groups, environment, dispatcher identity, state backend and tfvars;
- #15: the SQS DLQ liveness hole, lost admission leases, receive-count inflation and poison loops;
- #17: a capacity controller that freezes on an UpdateService timeout;
- the infrastructure half of #23 (gateway replicas).
  Compose keeps fixed workers and does no scaling. Read docs/architecture/plugin-platform.md (revision 2): sections 10.1–10.2 (normative), section 2.9 (CapacitySignal, BackgroundTask, CAPACITY_METRIC_NAMES), section 4.10 (terminateCarrierLeg) and section 15.

F3 already added the orchestration migration ledger (001 and 002 no longer re-run), migration 003, the carrier-identity store methods and admissionSnapshot(), plus stub subpaths src/background-tasks.ts and src/capacity-signals.ts with catalog entries (role dispatcher). F4 split the worker main into main.ts, worker-process.ts and worker-loop.ts. Keep every store method signature that session-host (frozen) and C2 use: bindCarrierCallId, issueStreamGrant, reissueStream, resolveSessionRoute, requestSessionTermination and admissionSnapshot.

A. Capacity signal (packages/plugin-orchestration)

- New src/capacity-signal.ts: a pure computeCapacitySignal(input) (≤150 lines) implementing the section 10.1 formula: busy, jobs, campaign demand, prewarm (OVO_PREWARM_LEAD_SECONDS, default 600), the inbound floor, and hardMax with limitingQuota, clamped to [busy, hardMax]. It returns undefined for stale or inconsistent input: rows older than the max age, or a broken counts invariant.
- Two capacity.signal plugins, exported from src/capacity-signals.ts:
  - '@winsendotai/ovo-plugin-orchestration/cloudwatch-capacity-signal': wraps the existing AwsCapacityMetricPublisher in aws.ts; namespace 'OVO/Capacity', dimensions {Environment, Service: 'workers'}, StorageResolution 1, Count and Seconds units, one PutMetricData per tick, client injected via the constructor.
  - '@winsendotai/ovo-plugin-orchestration/log-capacity-signal': structured log, with last() exposed for /health and the API infrastructure page.
- DELETE:
  - CapacityController, CapacityLeaseStore, DesiredCountWriter and the CapacityWriteGuard, Attempt and Permit types (in services.ts, types.ts and the postgres.ts delegations);
  - src/postgres/leases.ts and src/postgres/capacity-writes.ts;
  - EcsDesiredCountWriter and EcsServiceApi.update, plus the Stale, Unresolved and UncertainCapacity errors (keep a read-only describe);
  - ecsCapacityWriterPlugin;
  - the decideCapacity step and hysteresis logic in capacity.ts;
  - tests/capacity-writes.test.ts, and the lease and fence cases in tests/ownership.test.ts and packages/plugin-storage/tests/infrastructure-postgres.test.ts.
- migrations/004_job_hints_drop_capacity.sql, registered in the F3 migration ledger:
  - ovo_jobs.hinted_at timestamptz and hint_count int default 0;
  - DROP TABLE IF EXISTS ovo_capacity_writes, ovo_capacity_leases;
  - extend the job status CHECK with 'superseded' (look up the constraint name in pg_constraint).
  - Do NOT edit scripts/postgres-restore-fence.sql; its ovo_capacity_leases block is guarded by to_regclass.
- Hint sweeper, a BackgroundTask plugin exported from src/background-tasks.ts ('@winsendotai/ovo-plugin-orchestration/job-hint-sweeper', every 5 s, SKIP LOCKED, LIMIT 100):
  - selects eligible jobs (queued with not_before <= now(), or live with an expired or NULL lease) where hinted_at IS NULL OR hinted_at < now() - 150 s;
  - sets hinted_at, increments hint_count, and inserts job.eligible outbox rows;
  - POISON CAP: a job with hint_count > 20 that never got past 'owned' is failed terminally with last_error 'hint_exhausted' and an alarmable log line.
  - JobRepository.enqueue writes the outbox row only when not_before <= now().
- DLQ reconciler, a BackgroundTask plugin: receives from the DLQ. Malformed → log, count, delete. Otherwise set hinted_at = NULL and delete. Never blind-redrive; the poison cap ends loops.
- A lost admission lease → the job's terminal status is 'superseded', and the message is deleted.

B. Dispatcher (apps/dispatcher)

- Load distribution with role 'dispatcher'. packages/distribution/src/profiles/dispatcher.ts (yours) must provide rows for:
  - the orchestration store (orchestration.store);
  - SQS or ElasticMQ;
  - capacity.signal: cloudwatch on fargate, log on compose;
  - operations (createOperationsPlugin → ovo.operations);
  - the cost ledger (createCostLedgerPlugin → ovo.cost-ledger);
  - ovo.net via plugin-kit createNodeNet.
    The catalog's dispatcher-role plugins (carrier controls for pacing CPS, and the background tasks from the plugin-operations, plugin-ledger and plugin-orchestration background-tasks subpaths) compose on top. O2's campaign driver and reservation sweeper require ovo.operations, ovo.cost-ledger, orchestration.store and ovo.carrier.control; make sure all four are satisfied.
- Run every ctx.all('ovo.background-task') task on its intervalMs, with jitter, an AbortSignal and error isolation.
- Publish the capacity signal every 10 s: read the store snapshot plus DescribeServices (read-only). A failure → publish nothing and mark /health degraded.
- Delete compactCapacityWriterPlugin, the scale loop, OVO_CAPACITY_AUTHORITY and OVO_DESIRED_WRITER.
- Dispatcher identity comes from the ECS metadata TaskARN (the same approach as workers), falling back to hostname plus pid. No fixed id.

C. Worker (your listed files only)

- Idle protection only for the first inboundWarmFloor ready slots (a floor_token under pg_advisory_xact_lock). Admission still selects only slots with protected_until > now() for inbound.
- Protection expires after 60 min and renews every 2 min. A renewal failure, including DEPLOYMENT_BLOCKED, is fatal only when less than 5 min of protection remains; before that, retry with backoff and log {event: 'protection_renewal_failed'}.
- KEEP the HANDOFF rule: durable ownership loss drains and terminates the carrier leg through session-host terminateCarrierLeg (section 4.10). Keep or add the regression test.
- Re-check draining immediately before dial. If draining, release the job, delete the message and release protection.
- Deferrals (claim defer, draining, readiness failure, protection-establish failure, and inbound-reserved in worker-loop.ts): release the job with not_before = now()+defer AND hinted_at = NULL, then DELETE the queue message. Never changeVisibility.
- The worker keeps port 4100 for health, and C2 attaches /internal/media to the same server. Do not open a second port, and keep passing the health server into createProductionWorkerMediaRuntime.

D. Terraform (infra/terraform; the binary isn't installed, so rely on static tests)

- autoscaling.tf per the section 10.1 table: the AAS target, target tracking with metric math, step scaling with the 10 s high-resolution deficit alarm and no scale-in steps, and scheduled actions from var.worker_schedules.
- alarms.tf: DLQ>0, oldest eligible job > var.job_age_slo_seconds, stale signal (SampleCount<1, treat_missing_data breaching), ceiling hit, target health (api, console, gateway), a protection-renewal log metric filter, queue age, and hint_exhausted log lines. Everything goes to var.alarm_topic_arn.
- network.tf: aws_vpc_security_group_egress_rule ALB→application on 3000–4001 and application→application on 4000 (console→API); the path pattern adds /carriers/* and keeps /twilio/*.
- tasks.tf:
  - API secrets OVO_SESSION_SECRET, OVO_SEED_ADMIN_EMAIL and OVO_SEED_ADMIN_PASSWORD from runtime_secret_arn (update its description);
  - OVO_TRUSTED_PROXY_CIDRS = join(",", var.alb_subnet_cidrs);
  - OVO_MEDIA_PUBLIC_BASE_URL and OVO_INBOUND_ROUTE_SECRET for the API (carrier URLs) and the gateway;
  - remove the fixed OVO_DISPATCHER_ID and OVO_CAPACITY_AUTHORITY;
  - the OVO_CARRIER_ENV_BINDINGS JSON secret replaces TWILIO_*;
  - OVO_CAPACITY_SIGNAL=cloudwatch;
  - OVO_FIXTURE_TEST_CALLS is left unset (false) on fargate.
- services.tf:
  - dispatcher desired count 2 with a 100/200 rollout;
  - gateway desired default 2 (remove the ==1 validation in variables.tf), deregistration_delay = min(3600, var.max_call_seconds);
  - the worker keeps 100/200, the circuit breaker, and ignore_changes [desired_count], with the comment that AAS owns it.
- iam.tf: remove ecs:UpdateService. The dispatcher keeps DescribeServices and PutMetricData (with a namespace condition) and adds sqs:ReceiveMessage, DeleteMessage and GetQueueAttributes on the DLQ. The worker adds ecs:GetTaskProtection.
- versions.tf: backend "s3" {} plus backend.hcl.example (bucket, key, region, encrypt = true, use_lockfile = true). Bump required_version to >= 1.10, and document dynamodb_table for older versions in README.md.
- terraform.tfvars.example adds recordings_bucket, alb_subnet_cidrs, worker_schedules = [], alarm_topic_arn and job_age_slo_seconds. maxReceiveCount is 10 in main.tf.
- New infra/terraform/terraform.contract.test.ts (vitest, reads the .tf text) asserting:
  - no ecs:UpdateService anywhere;
  - the dispatcher IAM statement contains only Describe, PutMetricData and SQS actions;
  - aws_appautoscaling_target.worker exists with ecs:service:DesiredCount;
  - the policies use namespace OVO/Capacity with metric names equal to the exported CAPACITY_METRIC_NAMES;
  - the ALB security group has an egress rule;
  - the API env includes OVO_SESSION_SECRET, OVO_SEED_ADMIN_EMAIL, OVO_TRUSTED_PROXY_CIDRS and OVO_MEDIA_PUBLIC_BASE_URL;
  - every variable without a default appears in the tfvars example;
  - the gateway ==1 validation is gone.

E. Compose (infra/compose)

- fixed worker-1 and worker-2; OVO_CAPACITY_SIGNAL=log; remove OVO_DESIRED_WRITER and OVO_CAPACITY_AUTHORITY;
- OVO_CARRIER_ENV_BINDINGS from the .env TWILIO_* variables (update .env.example);
- OVO_FIXTURE_TEST_CALLS=true set EXPLICITLY on the api service, because the images set NODE_ENV=production;
- the same images; maxReceiveCount 10 in elasticmq.conf; the gateway service gets OVO_MEDIA_WORKER_TOKEN and OVO_MEDIA_PUBLIC_BASE_URL.

F. API infrastructure page: replace the unresolvedCapacityWrites query and readiness reason (infrastructure-service.ts around lines 152 and 247) with 'capacity signal age', and expose the last capacity signal.

TESTS:

- capacity-signal.test.ts (table-driven): no double counting of starting tasks; required is never below busy; the floor applies only when inbound is enabled; prewarm window edges; hardMax with the right limitingQuota; stale → undefined.
- cloudwatch-capacity-signal.test.ts: a fake send; namespace, dimensions, StorageResolution and units.
- dispatcher-loop.test.ts: no publish on stale input; a DescribeServices failure → no publish plus unhealthy; two instances publish identical values; background tasks run and are isolated on error; the dispatcher profile satisfies the four keys O2's tasks require.
- Worker tests: deferrals call delete (not changeVisibility) and reset hinted_at; the drain check before dial; protection renewal tolerance above and below 5 min; DEPLOYMENT_BLOCKED retryable; ownership loss still terminates via terminateCarrierLeg.
- The Postgres-gated tests for the sweeper (including the poison cap), the DLQ reconciler and migration 004 follow the existing skip pattern.
- node scripts/check-terraform.mjs prints SKIPPED without the binary.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen: session-host, distribution (except profiles/worker.ts and profiles/dispatcher.ts), C2's worker media files, O2's cost-*.ts, D1's session and telemetry files, and every package.json.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/O1.json.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- No AWS calls in tests; inject clients.
- Preserve the HANDOFF invariants: restore fences never bulk-cleared and the fence file untouched; ownership loss → hang-up; task protection and job ownership both renewed.
- Modules ≤300 lines.
- No git commits.

## Acceptance

- No code or IAM path calls ecs:UpdateService. CapacityController, the leases, capacity-writes, EcsDesiredCountWriter and the dispatcher's compact writer are deleted, and migration 004 drops the capacity tables without editing the restore-fence file.
- The dispatcher publishes a CapacitySignal via cloudwatch (fargate) or log (compose), publishes nothing on stale input, and runs every installed BackgroundTask. Its profile provides ovo.operations, ovo.cost-ledger, orchestration.store and the carrier controls.
- The hint sweeper (with the poison cap) and the DLQ reconciler exist. Worker deferrals delete messages and reset hinted_at, maxReceiveCount is 10, and lost admission leases produce 'superseded'.
- Worker protection: idle protection only for floor tokens, 60-minute expiry with tolerant renewal, a drain check before dial, and ownership loss terminating via terminateCarrierLeg (regression test).
- terraform.contract.test.ts passes, covering the autoscaling target and policies, alarms, ALB and application egress, the API secrets and env (including OVO_MEDIA_PUBLIC_BASE_URL), dispatcher identity, gateway replicas, the S3 backend, IAM trimming and tfvars completeness.
- Compose runs fixed workers with the log capacity signal and OVO_FIXTURE_TEST_CALLS=true set explicitly, with no scaling env. Scoped lint, typecheck and tests are green, and check-terraform exits 0.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only infra packages/plugin-orchestration apps/dispatcher apps/worker/src/main.ts apps/worker/src/worker-process.ts apps/worker/src/worker-loop.ts apps/worker/src/runner.ts apps/worker/src/inbound-runtime.ts apps/worker/src/renewal.ts apps/worker/src/dial-settlement.ts apps/worker/src/reconciliation.ts apps/api/src/infrastructure-service.ts packages/distribution/src/profiles/worker.ts packages/distribution/src/profiles/dispatcher.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs infra packages/plugin-orchestration apps/dispatcher apps/worker/src apps/worker/tests/worker.test.ts apps/worker/tests/inbound-runtime.test.ts apps/api/src/infrastructure-service.ts apps/api/src/routes/infrastructure.ts packages/distribution/src/profiles`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-orchestration apps/dispatcher apps/worker/tests/worker.test.ts apps/worker/tests/inbound-runtime.test.ts apps/worker/tests/infrastructure-metrics.test.ts apps/worker/tests/campaign-dial.test.ts apps/api/tests/infrastructure.test.ts infra --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/check-terraform.mjs`
