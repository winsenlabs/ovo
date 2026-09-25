import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PostgresControlStore } from '../src/index.ts';
import { PostgresOrchestrationStore } from '../../plugin-orchestration/src/index.ts';
import { runRecordingMigrations } from '../../plugin-recordings/src/production.ts';
import { PostgresTelemetryStore } from '../../plugin-observability/src/index.ts';
import { createInfrastructureRuntime } from '../../../apps/api/src/infrastructure-runtime.ts';
import { PostgresInfrastructureService } from '../../../apps/api/src/infrastructure-service.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('PostgreSQL infrastructure snapshot', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const workspaceId = `infra-${suffix}`;
  const workerPrefix = `infra-worker-${suffix}`;
  const serviceKey = `infra-service-${suffix}`;
  let releaseId: string;
  let pool: Pool;
  let control: PostgresControlStore;
  let orchestration: PostgresOrchestrationStore;
  let telemetry: PostgresTelemetryStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    control = await PostgresControlStore.open(databaseUrl!);
    orchestration = new PostgresOrchestrationStore({ connectionString: databaseUrl! });
    await orchestration.migrate();
    await runRecordingMigrations(pool);
    telemetry = await PostgresTelemetryStore.open({ connectionString: databaseUrl! });
    await control.ensureWorkspace(workspaceId, 'Infrastructure test');
    const agent = await control.createAgent(
      workspaceId,
      AgentConfig.parse({ name: 'Infrastructure agent', mode: 'announcement', message: 'Hello' }),
    );
    releaseId = (
      await control.createRelease({
        workspaceId,
        agent,
        plugins: [{ id: 'ovo.behavior.announcement', version: '1.0.0' }],
        createdBy: 'test',
      })
    ).id;
    await seed();
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM ovo_capacity_writes WHERE service_key=$1', [serviceKey]);
      await pool.query('DELETE FROM ovo_worker_slots WHERE worker_id LIKE $1', [
        `${workerPrefix}%`,
      ]);
      await pool.query('DELETE FROM ovo_jobs WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_recording_tombstones WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_recording_exports WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_recording_artifacts WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_telemetry_events WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_telemetry_calls WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_ctl_call_events WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_ctl_usage_entries WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_ctl_calls WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_ctl_evaluations WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_ctl_releases WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_ctl_agents WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_ctl_audit_entries WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM ovo_ctl_workspaces WHERE id=$1', [workspaceId]);
      await pool.end();
    }
    await telemetry?.close();
    await orchestration?.close();
    await control?.close();
  });

  it('returns real scoped counts, nullable unknowns and fresh-heartbeat readiness', async () => {
    const service = new PostgresInfrastructureService(pool, {
      organizationId: workspaceId,
      installationEnabled: true,
      capacityCeiling: 4,
      heartbeatMaxAgeMs: 15_000,
    });
    const snapshot = await service.snapshot(workspaceId, releaseId);
    expect(snapshot.installation).toMatchObject({ enabled: true, status: 'degraded' });
    expect(snapshot.installation.reasons).toContain(
      'A capacity write has an unresolved outcome and scaling is fenced.',
    );
    expect(snapshot.workers).toMatchObject({
      ready: 1,
      draining: 0,
      capacityCeiling: 4,
    });
    // Worker slots are installation-wide; earlier serial suites may leave a fresh slot.
    expect(snapshot.workers.active).toBeGreaterThanOrEqual(1);
    expect(snapshot.workers.busy).toBeGreaterThanOrEqual(1);
    expect(snapshot.workers.total).toBeGreaterThanOrEqual(2);
    expect(snapshot.workers.busy).toBe(
      (snapshot.workers.reserved ?? 0) + (snapshot.workers.active ?? 0),
    );
    expect(snapshot.queue).toMatchObject({
      depth: 2,
      eligibleDepth: 1,
      reconciliationDepth: 1,
      unresolvedCapacityWrites: 1,
    });
    expect(snapshot.queue.oldestAgeMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.process).toMatchObject({
      cpuPercentAverage: 30,
      memoryRssBytesTotal: 300,
      memoryLimitBytesTotal: null,
      eventLoopLagMsMax: 8,
      restartsTotal: null,
    });
    expect(snapshot.providers.quotas).toEqual([
      expect.objectContaining({ provider: 'carrier', metric: 'calls', remaining: 7 }),
    ]);
    expect(snapshot.providers.throttling).toEqual([
      expect.objectContaining({ provider: 'carrier', active: true, count: 1 }),
    ]);
    expect(snapshot.recordings).toMatchObject({
      queuedExports: 1,
      pendingDeletion: 1,
      finalizingArtifacts: 1,
    });
    expect(snapshot.telemetry).toMatchObject({ eventsLastFiveMinutes: 1, activeCalls: 1 });
  });

  it('rejects another organization without querying or exposing its state', async () => {
    const service = new PostgresInfrastructureService(pool, {
      organizationId: workspaceId,
      installationEnabled: true,
      capacityCeiling: null,
    });
    await expect(service.snapshot('another-organization')).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
    });
  });

  it('opens a bounded process runtime and closes its pool idempotently', async () => {
    const runtime = await createInfrastructureRuntime({
      organizationId: workspaceId,
      databaseUrl,
      installationEnabled: true,
      capacityCeiling: 4,
      maxConnections: 2,
    });
    await expect(runtime.service.snapshot(workspaceId)).resolves.toMatchObject({
      organizationId: workspaceId,
    });
    await runtime.close();
    await runtime.close();
  });

  async function seed() {
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO ovo_worker_slots(worker_id,state,ownership_epoch,observed_at,lease_expires_at,metadata)
       VALUES
       ($1,'ready_idle',1,now(),now()+interval '1 minute',$3::jsonb),
       ($2,'active',1,now(),now()+interval '1 minute',$4::jsonb),
       ($5,'draining',1,now()-interval '1 hour',now()-interval '1 minute','{}')`,
      [
        `${workerPrefix}-ready`,
        `${workerPrefix}-active`,
        JSON.stringify({
          infrastructure: {
            process: { cpuPercent: 20, memoryRssBytes: 100, eventLoopLagMs: 4 },
            providerQuotas: [{ provider: 'carrier', metric: 'calls', limit: 10, remaining: 7 }],
            throttling: [{ provider: 'carrier', active: true, count: 1, lastAt: now }],
          },
        }),
        JSON.stringify({
          infrastructure: {
            process: { cpuPercent: 40, memoryRssBytes: 200, eventLoopLagMs: 8 },
          },
        }),
        `${workerPrefix}-expired`,
      ],
    );
    await pool.query(
      `INSERT INTO ovo_jobs(id,workspace_id,idempotency_key,payload,status,not_before)
       VALUES ($1,$4,'eligible',$5::jsonb,'queued',now()-interval '1 minute'),
              ($2,$4,'future',$5::jsonb,'queued',now()+interval '1 hour'),
              ($3,$4,'reconcile',$5::jsonb,'reconcile_required',now())`,
      [randomUUID(), randomUUID(), randomUUID(), workspaceId, JSON.stringify({ releaseId })],
    );
    await pool.query(
      `INSERT INTO ovo_capacity_writes(attempt_id,service_key,authority_id,epoch,desired_count,status)
       VALUES($1,$2,'test',1,2,'unknown')`,
      [randomUUID(), serviceKey],
    );
    const callId = `infra-call-${suffix}`;
    await control.createCall({
      workspaceId,
      id: callId,
      releaseId,
      kind: 'live',
      status: 'active',
    });
    const artifactId = randomUUID();
    await pool.query(
      `INSERT INTO ovo_recording_artifacts
       (id,workspace_id,call_id,source,state,created_at,updated_at,expires_at,codec,sample_rate,channels,segment_bytes)
       VALUES($1,$2,$3,'carrier','finalizing',now(),now(),now()+interval '1 day','audio/x-mulaw',8000,2,65536)`,
      [artifactId, workspaceId, callId],
    );
    await pool.query(
      `INSERT INTO ovo_recording_exports
       (id,workspace_id,artifact_id,idempotency_key,state,created_at,updated_at)
       VALUES($1,$2,$3,'infra-export','queued',now(),now())`,
      [randomUUID(), workspaceId, artifactId],
    );
    await pool.query(
      `INSERT INTO ovo_recording_tombstones
       (artifact_id,workspace_id,call_id,requested_at,reason,cleanup_state)
       VALUES($1,$2,$3,now(),'operator','pending')`,
      [artifactId, workspaceId, callId],
    );
    await pool.query(
      `INSERT INTO ovo_telemetry_events
       (schema_version,workspace_id,call_id,sequence,event_id,event_hash,occurred_at,source,kind,release_id,payload)
       VALUES(1,$1,$2,1,$3,decode(repeat('00',32),'hex'),now(),'live','worker.metric',$4,'{}')`,
      [workspaceId, callId, `infra-event-${suffix}`, releaseId],
    );
    await pool.query(
      `INSERT INTO ovo_telemetry_calls
       (workspace_id,call_id,source,release_id,first_at,last_at,last_sequence,event_count,status)
       VALUES($1,$2,'live',$3,now(),now(),1,1,'active')`,
      [workspaceId, callId, releaseId],
    );
  }
});
