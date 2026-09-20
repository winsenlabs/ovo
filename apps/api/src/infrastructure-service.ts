import type { Pool } from 'pg';
import type { InfrastructureService, InfrastructureSnapshot } from './infrastructure-types.ts';
import { aggregateWorkerMetrics, type WorkerSample } from './infrastructure-worker-samples.ts';

interface InfrastructureServiceOptions {
  organizationId: string;
  installationEnabled: boolean;
  capacityCeiling: number | null;
  heartbeatMaxAgeMs?: number;
  maxWorkerSamples?: number;
}

export class PostgresInfrastructureService implements InfrastructureService {
  readonly organizationId: string;
  private readonly heartbeatMaxAgeMs: number;
  private readonly maxWorkerSamples: number;

  constructor(
    private readonly pool: Pool,
    private readonly options: InfrastructureServiceOptions,
  ) {
    this.organizationId = required(options.organizationId, 'organizationId');
    this.heartbeatMaxAgeMs = bounded(options.heartbeatMaxAgeMs ?? 15_000, 1_000, 60_000);
    this.maxWorkerSamples = bounded(options.maxWorkerSamples ?? 100, 1, 100);
  }

  async snapshot(workspaceId: string, releaseId?: string): Promise<InfrastructureSnapshot> {
    if (workspaceId !== this.organizationId) throw forbiddenOrganization();
    const tables = await this.tables();
    const [workers, queue, recordings, telemetry] = await Promise.all([
      tables.orchestration ? this.workersAndQueue(workspaceId, releaseId) : undefined,
      tables.orchestration ? this.queue(workspaceId, releaseId) : undefined,
      tables.recordings ? this.recordings(workspaceId, releaseId, tables.control) : undefined,
      tables.telemetry ? this.telemetry(workspaceId, releaseId) : undefined,
    ]);
    const workerMetrics = aggregateWorkerMetrics(workers?.samples ?? []);
    const reasons = this.readinessReasons(tables.orchestration, workers, queue);
    return {
      organizationId: this.organizationId,
      generatedAt: new Date().toISOString(),
      filter: { releaseId: releaseId ?? null },
      installation: {
        enabled: this.options.installationEnabled,
        status: !this.options.installationEnabled
          ? 'disabled'
          : reasons.length === 0
            ? 'ready'
            : 'degraded',
        reasons,
        admissionSafety:
          'Snapshot readiness is advisory; every admission must still reserve a fresh worker and obtain current task protection immediately before dialing.',
      },
      workers: {
        ready: workers?.counts.ready ?? null,
        busy: workers ? workers.counts.reserved + workers.counts.active : null,
        reserved: workers?.counts.reserved ?? null,
        active: workers?.counts.active ?? null,
        starting: workers?.counts.starting ?? null,
        draining: workers?.counts.draining ?? null,
        total: workers?.counts.total ?? null,
        capacityCeiling: this.options.capacityCeiling,
        freshestHeartbeatAt: workers?.freshestHeartbeatAt ?? null,
        heartbeatMaxAgeMs: this.heartbeatMaxAgeMs,
        sampledWorkers: workers ? workers.samples.length : null,
        samplesTruncated: workers ? workers.samplesTruncated : null,
      },
      queue: queue ?? emptyQueue(),
      providers: { quotas: workerMetrics.quotas, throttling: workerMetrics.throttling },
      process: workerMetrics.process,
      recordings: recordings ?? null,
      telemetry: telemetry ?? null,
    };
  }

  private async tables() {
    const result = await this.pool.query<{
      orchestration: string | null;
      recordings: string | null;
      telemetry: string | null;
      control: string | null;
    }>(`SELECT to_regclass('public.ovo_worker_slots')::text AS orchestration,
      to_regclass('public.ovo_recording_artifacts')::text AS recordings,
      to_regclass('public.ovo_telemetry_events')::text AS telemetry,
      to_regclass('public.ovo_ctl_calls')::text AS control`);
    const row = result.rows[0]!;
    return {
      orchestration: Boolean(row.orchestration),
      recordings: Boolean(row.recordings),
      telemetry: Boolean(row.telemetry),
      control: Boolean(row.control),
    };
  }

  private async workersAndQueue(workspaceId: string, releaseId?: string) {
    const result = await this.pool.query<{
      ready: string;
      reserved: string;
      active: string;
      starting: string;
      draining: string;
      total: string;
      freshest: Date | null;
    }>(
      `SELECT
      count(*) FILTER (WHERE state='ready_idle')::text AS ready,
      count(*) FILTER (WHERE state='reserved')::text AS reserved,
      count(*) FILTER (WHERE state='active')::text AS active,
      count(*) FILTER (WHERE state='starting')::text AS starting,
      count(*) FILTER (WHERE state='draining')::text AS draining,
      count(*)::text AS total,max(observed_at) AS freshest
      FROM ovo_worker_slots
      WHERE lease_expires_at>now() AND observed_at>=now()-($1*interval '1 millisecond')`,
      [this.heartbeatMaxAgeMs],
    );
    const samples = await this.pool.query<WorkerSample>(
      `SELECT metadata,observed_at FROM ovo_worker_slots
       WHERE lease_expires_at>now() AND observed_at>=now()-($1*interval '1 millisecond')
       ORDER BY observed_at DESC,worker_id LIMIT $2`,
      [this.heartbeatMaxAgeMs, this.maxWorkerSamples + 1],
    );
    const row = result.rows[0]!;
    return {
      counts: {
        ready: Number(row.ready),
        reserved: Number(row.reserved),
        active: Number(row.active),
        starting: Number(row.starting),
        draining: Number(row.draining),
        total: Number(row.total),
      },
      freshestHeartbeatAt: row.freshest?.toISOString() ?? null,
      samples: samples.rows.slice(0, this.maxWorkerSamples),
      samplesTruncated: samples.rows.length > this.maxWorkerSamples,
      workspaceId,
      releaseId,
    };
  }

  private async queue(workspaceId: string, releaseId?: string) {
    const result = await this.pool.query<{
      depth: string;
      eligible: string;
      oldest_age_ms: number | null;
      reconciliation: string;
      unresolved: string;
    }>(
      `SELECT
      count(*) FILTER (WHERE status='queued')::text AS depth,
      count(*) FILTER (WHERE status='queued' AND not_before<=now())::text AS eligible,
      extract(epoch FROM (now()-min(created_at) FILTER (WHERE status='queued')))*1000 AS oldest_age_ms,
      count(*) FILTER (WHERE status='reconcile_required')::text AS reconciliation,
      (SELECT count(*)::text FROM ovo_capacity_writes WHERE status IN ('inflight','unknown')) AS unresolved
      FROM ovo_jobs WHERE workspace_id=$1 AND ($2::text IS NULL OR payload->>'releaseId'=$2)`,
      [workspaceId, releaseId ?? null],
    );
    const row = result.rows[0]!;
    return {
      depth: Number(row.depth),
      eligibleDepth: Number(row.eligible),
      oldestAgeMs: row.oldest_age_ms === null ? null : Math.max(0, Number(row.oldest_age_ms)),
      reconciliationDepth: Number(row.reconciliation),
      unresolvedCapacityWrites: Number(row.unresolved),
    };
  }

  private async recordings(workspaceId: string, releaseId: string | undefined, control: boolean) {
    if (releaseId && !control) return undefined;
    const releaseClause = releaseId
      ? `AND EXISTS (SELECT 1 FROM ovo_ctl_calls c WHERE c.workspace_id=a.workspace_id
           AND c.id=a.call_id AND c.release_id=$2)`
      : '';
    const result = await this.pool.query<{
      queued_exports: string;
      running_exports: string;
      pending_deletion: string;
      failed_deletion: string;
      finalizing_artifacts: string;
      failed_artifacts: string;
    }>(
      `SELECT
      count(*) FILTER (WHERE kind='export' AND state='queued')::text AS queued_exports,
      count(*) FILTER (WHERE kind='export' AND state='running')::text AS running_exports,
      count(*) FILTER (WHERE kind='tombstone' AND state='pending')::text AS pending_deletion,
      count(*) FILTER (WHERE kind='tombstone' AND state='failed')::text AS failed_deletion,
      count(*) FILTER (WHERE kind='artifact' AND state='finalizing')::text AS finalizing_artifacts,
      count(*) FILTER (WHERE kind='artifact' AND state='failed')::text AS failed_artifacts
      FROM (
        SELECT 'artifact' AS kind,a.state,a.workspace_id,a.call_id FROM ovo_recording_artifacts a
          WHERE a.workspace_id=$1 ${releaseClause}
        UNION ALL
        SELECT 'export',e.state,a.workspace_id,a.call_id FROM ovo_recording_exports e
          JOIN ovo_recording_artifacts a ON a.id=e.artifact_id WHERE e.workspace_id=$1 ${releaseClause}
        UNION ALL
        SELECT 'tombstone',t.cleanup_state,a.workspace_id,a.call_id FROM ovo_recording_tombstones t
          JOIN ovo_recording_artifacts a ON a.id=t.artifact_id WHERE t.workspace_id=$1 ${releaseClause}
      ) backlog`,
      releaseId ? [workspaceId, releaseId] : [workspaceId],
    );
    const row = result.rows[0]!;
    return {
      queuedExports: Number(row.queued_exports),
      runningExports: Number(row.running_exports),
      pendingDeletion: Number(row.pending_deletion),
      failedDeletion: Number(row.failed_deletion),
      finalizingArtifacts: Number(row.finalizing_artifacts),
      failedArtifacts: Number(row.failed_artifacts),
    };
  }

  private async telemetry(workspaceId: string, releaseId?: string) {
    const result = await this.pool.query<{
      events: string;
      active_calls: string;
      newest: Date | null;
    }>(
      `SELECT
      count(*) FILTER (WHERE ingested_at>=now()-interval '5 minutes')::text AS events,
      (SELECT count(*)::text FROM ovo_telemetry_calls c WHERE c.workspace_id=$1
        AND c.status='active' AND ($2::text IS NULL OR c.release_id=$2)) AS active_calls,
      max(ingested_at) AS newest
      FROM ovo_telemetry_events e WHERE e.workspace_id=$1
        AND ($2::text IS NULL OR e.release_id=$2)`,
      [workspaceId, releaseId ?? null],
    );
    const row = result.rows[0]!;
    return {
      eventsLastFiveMinutes: Number(row.events),
      activeCalls: Number(row.active_calls),
      newestEventAt: row.newest?.toISOString() ?? null,
    };
  }

  private readinessReasons(
    orchestration: boolean,
    workers: Awaited<ReturnType<PostgresInfrastructureService['workersAndQueue']>> | undefined,
    queue: InfrastructureSnapshot['queue'] | undefined,
  ) {
    if (!this.options.installationEnabled)
      return ['Live calling is disabled by installation configuration.'];
    const reasons: string[] = [];
    if (!orchestration) reasons.push('Orchestration tables are unavailable.');
    if (this.options.capacityCeiling === null)
      reasons.push('The installation capacity ceiling is not configured.');
    else if (this.options.capacityCeiling === 0)
      reasons.push('The installation capacity ceiling is zero.');
    if (!workers?.counts.ready) reasons.push('No fresh ready worker heartbeat is available.');
    if (queue?.unresolvedCapacityWrites)
      reasons.push('A capacity write has an unresolved outcome and scaling is fenced.');
    return reasons;
  }
}

function emptyQueue(): InfrastructureSnapshot['queue'] {
  return {
    depth: null,
    eligibleDepth: null,
    oldestAgeMs: null,
    reconciliationDepth: null,
    unresolvedCapacityWrites: null,
  };
}
function forbiddenOrganization() {
  return Object.assign(
    new Error('Infrastructure snapshot is not available for this organization'),
    {
      statusCode: 404,
      code: 'not_found',
    },
  );
}
function required(value: string, name: string) {
  if (!value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}
function bounded(value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new TypeError(`value must be an integer between ${min} and ${max}`);
  return value;
}
