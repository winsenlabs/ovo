import type { Pool } from 'pg';

export type PrerenderReason = 'publish' | 'worker-start' | 'first-call';
export type PrerenderState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface PrerenderJob {
  workspaceId: string;
  releaseId: string;
  agentId: string;
  reason: PrerenderReason;
  state: PrerenderState;
  total: number;
  perCall: number;
  inventorySha256: string | null;
  detail: string | null;
  attempts: number;
  workerId: string | null;
  requestedAt: string;
  finishedAt: string | null;
}

interface JobRow {
  workspace_id: string;
  release_id: string;
  agent_id: string;
  reason: PrerenderReason;
  state: PrerenderState;
  total: number;
  per_call: number;
  inventory_sha256: string | null;
  detail: string | null;
  attempts: number;
  worker_id: string | null;
  requested_at: Date;
  finished_at: Date | null;
}

const COLUMNS = `workspace_id, release_id, agent_id, reason, state, total, per_call,
  inventory_sha256, detail, attempts, worker_id, requested_at, finished_at`;

function toJob(row: JobRow): PrerenderJob {
  return {
    workspaceId: row.workspace_id,
    releaseId: row.release_id,
    agentId: row.agent_id,
    reason: row.reason,
    state: row.state,
    total: row.total,
    perCall: row.per_call,
    inventorySha256: row.inventory_sha256,
    detail: row.detail,
    attempts: row.attempts,
    workerId: row.worker_id,
    requestedAt: row.requested_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

/** The publish → worker hand-off for pre-rendering (TTS-9). Workers claim with SKIP LOCKED. */
export class PostgresSpeechPrerenderQueue {
  constructor(private readonly pool: Pool) {}

  /** Queues (or re-queues) a release. A live claim by another worker is left alone. */
  async enqueue(input: {
    workspaceId: string;
    releaseId: string;
    agentId: string;
    reason: PrerenderReason;
    total?: number;
    perCall?: number;
    inventorySha256?: string;
  }): Promise<PrerenderJob> {
    const result = await this.pool.query<JobRow>(
      `INSERT INTO ovo_speech_prerender_jobs
         (workspace_id, release_id, agent_id, reason, state, total, per_call, inventory_sha256)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7)
       ON CONFLICT (workspace_id, release_id) DO UPDATE
         SET reason = excluded.reason,
             total = excluded.total,
             per_call = excluded.per_call,
             inventory_sha256 = coalesce(excluded.inventory_sha256,
                                         ovo_speech_prerender_jobs.inventory_sha256),
             state = CASE WHEN ovo_speech_prerender_jobs.state = 'running'
                            AND ovo_speech_prerender_jobs.lease_until > now()
                          THEN 'running' ELSE 'queued' END,
             detail = NULL,
             requested_at = now()
       RETURNING ${COLUMNS}`,
      [
        input.workspaceId,
        input.releaseId,
        input.agentId,
        input.reason,
        input.total ?? 0,
        input.perCall ?? 0,
        input.inventorySha256 ?? null,
      ],
    );
    return toJob(result.rows[0]!);
  }

  /** Claims the oldest queued job, or one whose worker lease has expired. */
  async claim(workerId: string, leaseMs: number): Promise<PrerenderJob | undefined> {
    const result = await this.pool.query<JobRow>(
      `UPDATE ovo_speech_prerender_jobs job
          SET state = 'running', worker_id = $1, attempts = job.attempts + 1,
              lease_until = now() + make_interval(secs => $2::double precision / 1000),
              started_at = now(), finished_at = NULL
        WHERE (job.workspace_id, job.release_id) = (
          SELECT workspace_id, release_id FROM ovo_speech_prerender_jobs
           WHERE state = 'queued' OR (state = 'running' AND lease_until < now())
           ORDER BY requested_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING job.*`,
      [workerId, leaseMs],
    );
    return result.rows[0] ? toJob(result.rows[0]) : undefined;
  }

  async finish(input: {
    workspaceId: string;
    releaseId: string;
    workerId: string;
    state: Extract<PrerenderState, 'done' | 'failed' | 'skipped'>;
    total: number;
    perCall: number;
    inventorySha256?: string;
    detail?: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE ovo_speech_prerender_jobs
          SET state = $4, total = $5, per_call = $6,
              inventory_sha256 = coalesce($7, inventory_sha256),
              detail = $8, lease_until = NULL, finished_at = now()
        WHERE workspace_id = $1 AND release_id = $2 AND worker_id = $3 AND state = 'running'`,
      [
        input.workspaceId,
        input.releaseId,
        input.workerId,
        input.state,
        input.total,
        input.perCall,
        input.inventorySha256 ?? null,
        input.detail?.slice(0, 500) ?? null,
      ],
    );
  }

  async get(workspaceId: string, releaseId: string): Promise<PrerenderJob | undefined> {
    const result = await this.pool.query<JobRow>(
      `SELECT ${COLUMNS} FROM ovo_speech_prerender_jobs
        WHERE workspace_id = $1 AND release_id = $2`,
      [workspaceId, releaseId],
    );
    return result.rows[0] ? toJob(result.rows[0]) : undefined;
  }

  /**
   * Releases that can take a call right now: enabled inbound routes and scheduled or running
   * campaigns. The operations tables may not exist on an installation without operations.
   */
  async routedReleases(): Promise<{ workspaceId: string; releaseId: string }[]> {
    const tables = await this.pool.query<{ routes: string | null; campaigns: string | null }>(
      `SELECT to_regclass('ovo_ops_inbound_routes')::text AS routes,
              to_regclass('ovo_ops_campaigns')::text AS campaigns`,
    );
    const parts: string[] = [];
    if (tables.rows[0]?.routes)
      parts.push(`SELECT organization_id, release_id::text FROM ovo_ops_inbound_routes
                   WHERE enabled`);
    if (tables.rows[0]?.campaigns)
      parts.push(`SELECT organization_id, agent_release_id FROM ovo_ops_campaigns
                   WHERE status IN ('scheduled', 'running')`);
    if (!parts.length) return [];
    const result = await this.pool.query<{ organization_id: string; release_id: string }>(
      `SELECT DISTINCT organization_id, release_id FROM (${parts.join(' UNION ')})
         AS routed (organization_id, release_id) ORDER BY 1, 2`,
    );
    return result.rows.map((row) => ({
      workspaceId: row.organization_id,
      releaseId: row.release_id,
    }));
  }
}
