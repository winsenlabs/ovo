import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../../plugin-orchestration/src/index.ts';
import { LiveRecordingService } from '../../plugin-recordings/src/index.ts';
import { PostgresRecordingRepository } from '../../plugin-recordings/src/production.ts';
import { PostgresEvaluationService } from '../../plugin-evaluations/src/index.ts';
import { PostgresOperationsService } from '../../plugin-operations/src/index.ts';
import {
  seedRestoreDrillFixture,
  type RestoreDrillFixture,
} from './backup-restore-drill-fixture.ts';

const exec = promisify(execFile);
const adminUrl = process.env.OVO_BACKUP_DRILL_POSTGRES_URL;
const suite = adminUrl ? describe : describe.skip;

suite('executable PostgreSQL backup and restore drill', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const sourceName = `ovo_drill_source_${suffix}`;
  const targetName = `ovo_drill_target_${suffix}`;
  const workspaceId = `drill-${suffix}`;
  let sourceUrl: string;
  let targetUrl: string;
  let scratch: string;
  let fixture: RestoreDrillFixture;

  beforeAll(async () => {
    sourceUrl = databaseUrl(sourceName);
    targetUrl = databaseUrl(targetName);
    scratch = await mkdtemp('/var/tmp/ovo-restore-drill-');
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${sourceName}`);
    await admin.query(`CREATE DATABASE ${targetName}`);
    await admin.end();
    fixture = await seedRestoreDrillFixture({ sourceUrl, workspaceId, scratch });
    const backup = `${scratch}/ovo.dump`;
    const backupResult = await exec('sh', ['scripts/postgres-backup.sh', sourceUrl, backup]);
    const restoreResult = await exec('sh', ['scripts/postgres-restore.sh', targetUrl, backup]);
    process.stdout.write(backupResult.stdout);
    process.stdout.write(restoreResult.stdout);
  }, 120_000);

  afterAll(async () => {
    fixture?.objects.close();
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=ANY($1::text[])`,
      [[sourceName, targetName]],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${sourceName}`);
    await admin.query(`DROP DATABASE IF EXISTS ${targetName}`);
    await admin.end();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('restores every shared durable namespace and representative business state', async () => {
    const pool = new Pool({ connectionString: targetUrl });
    const prefixes = await pool.query<{ prefix: string }>(`
      SELECT DISTINCT CASE
        WHEN tablename LIKE 'ovo_ctl_%' THEN 'ovo_ctl_'
        WHEN tablename LIKE 'ovo_eval_%' THEN 'ovo_eval_'
        WHEN tablename LIKE 'ovo_recording_%' THEN 'ovo_recording_'
        WHEN tablename LIKE 'ovo_cost_%' THEN 'ovo_cost_'
        WHEN tablename LIKE 'ovo_ops_%' THEN 'ovo_ops_'
        WHEN tablename LIKE 'ovo_telemetry_%' THEN 'ovo_telemetry_'
        WHEN tablename IN ('ovo_jobs','ovo_outbox','ovo_session_routes') THEN 'orchestration'
      END AS prefix
      FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ovo_%'`);
    expect(new Set(prefixes.rows.map((row) => row.prefix).filter(Boolean))).toEqual(
      new Set([
        'ovo_ctl_',
        'ovo_eval_',
        'ovo_recording_',
        'ovo_cost_',
        'ovo_ops_',
        'ovo_telemetry_',
        'orchestration',
      ]),
    );
    expect(
      await scalar(pool, 'SELECT count(*) FROM ovo_ctl_releases WHERE id=$1', [fixture.releaseId]),
    ).toBe(1);
    expect(
      await scalar(pool, 'SELECT count(*) FROM ovo_ctl_operations WHERE id=$1', [
        fixture.operationId,
      ]),
    ).toBe(1);
    expect(
      await scalar(pool, "SELECT count(*) FROM ovo_cost_price_cards WHERE id='drill-card'"),
    ).toBe(1);
    expect(
      await scalar(pool, 'SELECT count(*) FROM ovo_eval_runs WHERE id=$1', [
        fixture.evaluationRunId,
      ]),
    ).toBe(1);
    expect(
      await scalar(pool, 'SELECT count(*) FROM ovo_ops_campaign_contacts WHERE id=$1', [
        fixture.operationContactId,
      ]),
    ).toBe(1);
    expect(
      await scalar(pool, 'SELECT count(*) FROM ovo_recording_tombstones WHERE artifact_id=$1', [
        fixture.recordingId,
      ]),
    ).toBe(1);
    expect(
      await scalar(pool, 'SELECT count(*) FROM ovo_session_routes WHERE job_id=$1', [
        fixture.dialingJobId,
      ]),
    ).toBe(1);
    await pool.end();
  });

  it('quarantines restored outbound work and gives a new post-restore job one owner', async () => {
    const orchestration = new PostgresOrchestrationStore({ connectionString: targetUrl });
    expect(
      await orchestration.heartbeat(
        fixture.duplicateJobId,
        fixture.staleJobOwner.ownerId,
        fixture.staleJobOwner.ownerEpoch,
        60_000,
      ),
    ).toBe(false);
    expect(
      await orchestration.claim(fixture.queuedAtBackupJobId, 'must-not-redial', 60_000),
    ).toMatchObject({ kind: 'defer', reason: 'not_before' });
    expect(await orchestration.claimOutbox('must-not-publish-restored', 100)).toEqual([]);

    const freshJobId = randomUUID();
    await orchestration.enqueue({
      id: freshJobId,
      workspaceId,
      idempotencyKey: 'explicitly-new-post-restore-job',
      payload: { fixture: true, createdAfterRestore: true },
    });
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        orchestration.claim(freshJobId, `restored-worker-${index}`, 60_000),
      ),
    );
    expect(claims.filter((claim) => claim.kind === 'execute')).toHaveLength(1);
    expect(
      await orchestration.markDialAccepted(
        fixture.dialingJobId,
        fixture.staleDialOwner.ownerId,
        fixture.staleDialOwner.ownerEpoch,
        fixture.dialRequestId,
        'CA-stale-owner',
      ),
    ).toBe(false);
    const evaluationPool = new Pool({ connectionString: targetUrl });
    const evaluation = new PostgresEvaluationService({ pool: evaluationPool });
    await expect(
      evaluation.runs.heartbeat(
        workspaceId,
        fixture.evaluationRunId,
        'evaluation-before-restore',
        fixture.staleEvaluationEpoch,
      ),
    ).rejects.toThrow('no longer owned');
    const fixtureRetry = await evaluation.runs.claim('evaluation-after-restore', 60_000);
    expect(fixtureRetry).toMatchObject({ id: fixture.evaluationRunId, executorKind: 'fixture' });
    expect(await evaluation.runs.get(workspaceId, fixture.providerEvaluationRunId)).toMatchObject({
      status: 'failed',
      executorKind: 'provider',
      error: expect.stringContaining('provider execution or billing may have occurred'),
    });
    const restoredAuthorization = await evaluationPool.query<{
      revoked_by: string | null;
      revoked_at: Date | null;
    }>(
      `SELECT revoked_by,revoked_at FROM ovo_eval_provider_authorizations
       WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, fixture.providerAuthorizationId],
    );
    expect(restoredAuthorization.rows[0]).toMatchObject({
      revoked_by: 'restore-fence',
      revoked_at: expect.any(Date),
    });
    expect(
      await scalar(
        evaluationPool,
        'SELECT count(*) FROM ovo_eval_provider_authorizations WHERE id=$1 AND revoked_at IS NULL',
        [fixture.providerAuthorizationId],
      ),
    ).toBe(0);
    const operations = new PostgresOperationsService({
      connectionString: targetUrl,
      organizationId: workspaceId,
    });
    expect(
      await operations.campaigns.authorizeDial(
        fixture.operationContactId,
        'operations-before-restore',
        fixture.staleOperationEpoch,
      ),
    ).toMatchObject({ kind: 'blocked' });
    expect(
      await operations.campaigns.admit(fixture.operationCampaignId, 'must-not-readmit', 60_000),
    ).toEqual({ kind: 'empty' });
    expect(await operations.outbox.claim('must-not-dispatch-restored', 100)).toEqual([]);
    const contactStates = await operations.pool.query<{ id: string; state: string }>(
      'SELECT id,state FROM ovo_ops_campaign_contacts WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[fixture.operationContactId, fixture.queuedOperationContactId]],
    );
    expect(contactStates.rows).toHaveLength(2);
    expect(contactStates.rows.every((row) => row.state === 'unknown')).toBe(true);
    const inboundAdmissions = await operations.pool.query<{
      call_id: string;
      decision: string;
      reason: string;
      released_at: Date | null;
    }>(
      `SELECT call_id,decision,detail->>'reason' AS reason,released_at
       FROM ovo_ops_inbound_admissions WHERE call_id=ANY($1::text[]) ORDER BY call_id`,
      [[fixture.inboundWaitCallId, fixture.inboundCallbackCallId]],
    );
    expect(inboundAdmissions.rows).toHaveLength(2);
    expect(
      inboundAdmissions.rows.every(
        (row) =>
          row.decision === 'busy' &&
          row.reason === 'restore_quarantine' &&
          row.released_at !== null,
      ),
    ).toBe(true);
    await expect(
      operations.inboundGateway.admit({
        carrierCallId: fixture.inboundWaitCallId,
        fromNumber: fixture.inboundFromNumber,
        toNumber: fixture.inboundToNumber,
        handshakeTtlMs: 60_000,
        routeTokenHash: 'restore-drill-route-token',
      }),
    ).resolves.toMatchObject({ kind: 'busy', reason: 'restore_quarantine' });
    await expect(
      operations.inboundGateway.confirmCallback({
        carrierCallId: fixture.inboundCallbackCallId,
        fromNumber: fixture.inboundFromNumber,
        toNumber: fixture.inboundToNumber,
        handshakeTtlMs: 60_000,
        routeTokenHash: 'restore-drill-route-token',
        digits: '1',
      }),
    ).rejects.toThrow('not awaiting callback consent');
    expect(
      await scalar(
        operations.pool,
        'SELECT count(*) FROM ovo_ops_campaigns WHERE operation_id=$1',
        [`inbound-callback:${fixture.inboundCallbackCallId}`],
      ),
    ).toBe(0);
    await evaluationPool.end();
    await operations.close();
    await orchestration.close();
  });

  it('keeps tombstoned recording artifacts inaccessible after restore', async () => {
    const repository = new PostgresRecordingRepository({ connectionString: targetUrl });
    const recordings = new LiveRecordingService(repository, fixture.objects);
    await expect(
      recordings.manifest(workspaceId, 'call-recording', fixture.recordingId),
    ).rejects.toThrow('unavailable');
    await repository.close();
  });

  function databaseUrl(name: string) {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${name}`;
    return parsed.toString();
  }
});

async function scalar(pool: Pool, sql: string, values: unknown[] = []) {
  const result = await pool.query<{ count: string }>(sql, values);
  return Number(result.rows[0]!.count);
}
