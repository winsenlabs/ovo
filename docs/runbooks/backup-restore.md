# PostgreSQL backup and restore

**Trigger:** approved restore drill or durable state loss/corruption.

**Owner:** database/platform on-call; security owner for deletion-state review.

**Recovery objectives:** RPO ≤5 minutes and RTO ≤60 minutes remain proposals. The local measurement below does not establish either objective for a production database, production data volume, or object store.

Production OVO uses one shared PostgreSQL restore boundary. The local scripts include every `public.ovo_*` table, including:

- control, releases, secrets, operations and audit: `ovo_ctl_*` and `ovo_control_schema_migrations`
- orchestration, outbox, capacity, workers and session routes: `ovo_jobs`, `ovo_outbox`, `ovo_capacity_*`, `ovo_worker_*`, `ovo_session_*`, `ovo_carrier_callbacks` and `ovo_schema_migrations`
- recording metadata, deletion tombstones and export jobs: `ovo_recording_*`
- immutable price cards and cost entries: `ovo_cost_*`
- evaluation datasets, versions, runs and results: `ovo_eval_*`
- campaigns and business operations: `ovo_ops_*`
- telemetry: `ovo_telemetry_*`

Recording/media object bytes are a separate backup domain. Restoring PostgreSQL never makes an object safe to expose by itself: restore the matching object-store point, then verify PostgreSQL tombstones before allowing reads.

## Executable local drill

Requirements are Docker, Node.js and the workspace dependencies. It uses `postgres:17.6-alpine`, a disposable local database and no paid service:

```sh
scripts/run-postgres-restore-drill.sh
```

The drill creates source and isolated target databases, applies the real migrations, seeds representative control/release/tool-operation/recording/cost/evaluation/business-operation/orchestration state, makes a custom-format backup, restores it, applies the ownership fence and verifies:

- all durable namespaces and representative rows survived;
- a job that was only queued at the backup point cannot be claimed or dialled after restore;
- restored unsent orchestration and campaign outboxes cannot publish automatically;
- ten duplicate deliveries for an explicitly new post-restore job grant exactly one owner;
- pre-restore job, dial, evaluation and campaign owners cannot resume;
- restored queued/admitted/active campaign contacts remain `unknown` until individually reconciled;
- fixture evaluation work can retry, while ambiguous provider-backed runs fail closed;
- restored active provider-evaluation authorizations are revoked and cannot fund a fresh paid run;
- restored inbound wait and uncompleted callback admissions become terminal and cannot resume from a signed retry;
- every restored team user is disabled, marked `restore_quarantined`, and receives a new session version;
- an already deleted recording stays inaccessible after restoration.

The same local primitives can be run separately. The target database must already exist and must remain isolated from API and worker processes:

```sh
scripts/postgres-backup.sh "$SOURCE_DATABASE_URL" /var/tmp/ovo-control.dump
scripts/postgres-restore.sh "$ISOLATED_TARGET_DATABASE_URL" /var/tmp/ovo-control.dump
```

`postgres-restore.sh` runs `pg_restore --clean --if-exists --exit-on-error` and then `postgres-restore-fence.sql`. The fence increments or invalidates ownership epochs, expires leases, quarantines every restored nonterminal job as `reconcile_required` with an infinite `not_before`, holds restored unsent outboxes behind an infinite restore-fence claim, marks all restored nonterminal campaign contacts and attempts `unknown`, fails ambiguous provider-backed evaluation runs, revokes every restored active provider-evaluation authorization, terminalizes restored wait and uncompleted callback admissions, and disables restored inbound capacity. Fixture evaluation runs may retry because they cannot call paid providers or business systems. The fence does not reconcile external provider state and never constitutes permission to redeliver work.

## Production procedure

1. Stop API mutations, queue consumption, outbox publication, evaluation workers, recording exports, campaign dispatch, capacity writes and carrier admission. Confirm the old environment cannot connect to the restore target.
2. Preserve logs and record the requested restore point, source backup identifier, PostgreSQL version and object-store restore point.
3. Restore PostgreSQL to a new isolated database. Do not restore over a database still reachable by old processes.
4. Verify the dump and migration rows for every namespace listed above. Restore the matching recording/media object-store point without enabling reads.
5. Apply `scripts/postgres-restore-fence.sql` while the database is isolated. Verify active owner epochs changed, leases expired, all restored nonterminal jobs have `status='reconcile_required'` and `not_before='infinity'`, campaign contacts are `unknown`, provider evaluations are failed, provider-evaluation authorizations have `revoked_by='restore-fence'`, restored wait/callback admissions are terminal `busy` with reason `restore_quarantine`, and both outboxes carry the restore-fence claim.
6. Reapply every deletion tombstone and retention decision newer than the database restore point. Confirm tombstoned recordings remain inaccessible before enabling any artifact endpoint.
7. Reconcile every restored nonterminal job, dial, carrier call, write operation, campaign contact, export and outbox row against carrier/provider records, invoices and the old environment. A row that was merely queued at the backup point is still ambiguous: it may have executed between the backup and the disaster. Do not infer “not sent” from the restored snapshot.
8. Reauthorize only an individually reviewed item, recording the operator, external evidence and approval time. For an orchestration job confirmed never to have produced an external effect, atomically move that exact job from `reconcile_required` to `queued`, set `not_before=now()`, and release only its matching `ovo_outbox` restore-fence claim. Preserve any dial/request identity until the external check is complete. For a campaign contact, never release its restored `ovo_ops_outbox` row: after reconciliation, explicitly move only that contact from `unknown` to `queued` and set `not_before=now()`; normal admission must create a new owner epoch and a new outbox row. Provider-backed evaluation runs remain failed; reconcile provider request IDs, usage and budget/invoice state, then create a new provider authorization with a new idempotency key and a new run if rerun is desired. Never clear `revoked_at` on a restored authorization. Restored wait/callback admission IDs stay terminal permanently; after carrier reconciliation and explicit operator approval, only a genuinely new signed carrier call with a new CallSid may enter the current inbound policy. Bulk removal of restore-fence claims is prohibited.
9. Start one dispatcher/worker set against the isolated endpoint. First prove restored queued work and both restored outboxes remain blocked. Then create a new synthetic post-restore job and run the duplicate-delivery assertion. Verify stale-owner rejection, audit/event projections and cost/evaluation records.
10. Move API traffic only after database, security and operations owners approve reconciliation. Reopen carrier admission and write-capable tools gradually.

## Team access recovery after restore

The restore fence disables every `ovo_team_users` row, sets `restore_quarantined=true`, and increments `session_version`. Rotate `OVO_SESSION_SECRET` before any API or console traffic so every cookie signed before the incident is rejected independently of the database snapshot.

Recover exactly one existing user as the first administrator while the target is still isolated:

1. Verify every user row for the organization is disabled and restore-quarantined. If any row is not quarantined, stop and investigate instead of bypassing the guard.
2. Set `OVO_SEED_ADMIN_EMAIL` to that existing user's email, set `OVO_SEED_ADMIN_PASSWORD` to a new 12–128 character password that is not the restored password, and set `OVO_RESTORE_ADMIN_RECOVERY=true`.
3. Start the API once. Recovery succeeds only when all organization users are quarantined; it resets and enables only the matching user, promotes that user to admin, clears only that row's quarantine marker, and increments its session version again.
4. Stop the API and remove `OVO_RESTORE_ADMIN_RECOVERY` before the next start. Remove the one-time recovery password from shell history and temporary secret injection. Never leave the recovery flag enabled for normal operation.
5. Verify the recovered administrator can sign in with the new password before permitting traffic. Keep every other user disabled. For each additional user, use the authenticated Team workflow to set a new password before enabling the account; never clear `restore_quarantined` or bulk-enable users with SQL.

Password reset changes both the password hash and session version, so previously captured cookies remain invalid even across PITR. The `OVO_SESSION_SECRET` rotation is still mandatory as a separate installation-wide cookie-signing boundary.

## Rollback and evidence

If validation fails, keep the restored target isolated and the original environment read-only. Restore another point; never merge ownership rows or lower epochs manually.

Retain backup ID and checksum, source/target timestamps, dump size, PostgreSQL version, migration inventory, object-store point, tombstone replay, reconciled identifiers/counts, ownership fence output, duplicate simulation, and measured durations. Record production RPO/RTO only from production-like infrastructure and volume.

### Latest local synthetic measurement

On 2026-09-20, the team-and-authorization-quarantine-aware disposable drill backed up a 164,770-byte custom dump in less than one second (the whole-second script output was `0`), restored and fenced it in `1` second, and completed all three assertions in `1.54` seconds. These timings measure a tiny local synthetic dataset only and are not a production RPO or RTO claim.
