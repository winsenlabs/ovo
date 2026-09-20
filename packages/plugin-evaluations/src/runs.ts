import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { compareResults, decodeCursor, page, pageLimit } from './helpers.ts';
import { mapResult, mapRun, stripResult } from './run-mappers.ts';
import type {
  EvaluationCaseResult,
  EvaluationRun,
  ExecutorKind,
  Page,
  RunComparison,
} from './types.ts';

type Row = Record<string, unknown>;

export class EvaluationRuns {
  constructor(private readonly pool: Pool) {}

  async create(
    input: {
      workspaceId: string;
      datasetId: string;
      datasetVersion: number;
      releaseId: string;
      releaseFingerprint: string;
      fixtureBindingVersion: string;
      executorKind?: ExecutorKind;
      budgetAuthorizationId?: string;
      idempotencyKey: string;
      maxAttempts?: number;
    },
    options: { providerAuthorized?: boolean } = {},
  ): Promise<EvaluationRun> {
    const version = await this.pool.query<Row>(
      `SELECT fingerprint,jsonb_array_length(cases) AS total FROM ovo_eval_dataset_versions
       WHERE workspace_id=$1 AND dataset_id=$2 AND version=$3`,
      [input.workspaceId, input.datasetId, input.datasetVersion],
    );
    if (!version.rowCount)
      throw Object.assign(new Error('Dataset version not found'), { statusCode: 404 });
    const executorKind = input.executorKind ?? 'fixture';
    if (executorKind === 'provider' && options.providerAuthorized !== true)
      throw Object.assign(
        new Error('Provider evaluation requires a separately authorized service'),
        {
          statusCode: 403,
          code: 'provider_evaluation_not_authorized',
        },
      );
    const id = randomUUID(),
      now = new Date().toISOString(),
      values = [
        input.workspaceId,
        id,
        input.datasetId,
        input.datasetVersion,
        String(version.rows[0]!.fingerprint),
        input.releaseId,
        input.releaseFingerprint,
        input.fixtureBindingVersion,
        executorKind,
        input.budgetAuthorizationId ?? null,
        bounded(input.idempotencyKey, 200),
        input.maxAttempts ?? 3,
        Number(version.rows[0]!.total),
        now,
      ];
    const inserted = await this.pool.query<Row>(
      `INSERT INTO ovo_eval_runs
       (workspace_id,id,dataset_id,dataset_version,dataset_fingerprint,release_id,release_fingerprint,
        fixture_binding_version,executor_kind,budget_authorization_id,idempotency_key,status,max_attempts,total,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12,$13,$14,$14)
       ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,
      values,
    );
    if (inserted.rowCount) return mapRun(inserted.rows[0]!);
    const existing = await this.pool.query<Row>(
      'SELECT * FROM ovo_eval_runs WHERE workspace_id=$1 AND idempotency_key=$2',
      [input.workspaceId, input.idempotencyKey],
    );
    const run = mapRun(existing.rows[0]!);
    if (
      run.datasetId !== input.datasetId ||
      run.datasetVersion !== input.datasetVersion ||
      run.releaseId !== input.releaseId ||
      run.releaseFingerprint !== input.releaseFingerprint ||
      run.fixtureBindingVersion !== input.fixtureBindingVersion ||
      run.executorKind !== executorKind ||
      run.budgetAuthorizationId !== input.budgetAuthorizationId
    )
      throw Object.assign(new Error('Idempotency key is already bound to another evaluation'), {
        statusCode: 409,
      });
    return run;
  }

  async get(workspaceId: string, id: string): Promise<EvaluationRun | undefined> {
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_eval_runs WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? mapRun(result.rows[0]!) : undefined;
  }

  async list(workspaceId: string, limit?: number, cursor?: string): Promise<Page<EvaluationRun>> {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_runs WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
      [workspaceId, after, size + 1],
    );
    return page(result.rows.map(mapRun), size, (item) => item.id);
  }

  async claim(ownerId: string, leaseMs = 30_000): Promise<EvaluationRun | undefined> {
    if (!ownerId || leaseMs < 1_000 || leaseMs > 300_000)
      throw new TypeError('Invalid claim options');
    await this.pool.query(
      `UPDATE ovo_eval_runs SET status='failed',error='Retry budget exhausted',completed_at=now(),updated_at=now()
       WHERE status='running' AND lease_expires_at<now() AND attempt>=max_attempts`,
    );
    const result = await this.pool.query<Row>(
      `WITH candidate AS (
         SELECT workspace_id,id FROM ovo_eval_runs
         WHERE status='queued' OR (status='running' AND lease_expires_at<now() AND attempt<max_attempts)
         ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE ovo_eval_runs r SET status='running',owner_id=$1,owner_epoch=r.owner_epoch+1,
         attempt=r.attempt+1,lease_expires_at=now()+($2::text||' milliseconds')::interval,updated_at=now(),error=NULL
       FROM candidate c WHERE r.workspace_id=c.workspace_id AND r.id=c.id RETURNING r.*`,
      [ownerId, leaseMs],
    );
    return result.rowCount ? mapRun(result.rows[0]!) : undefined;
  }

  async heartbeat(
    workspaceId: string,
    id: string,
    ownerId: string,
    epoch: number,
    leaseMs = 30_000,
  ) {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_eval_runs SET lease_expires_at=now()+($1::text||' milliseconds')::interval,updated_at=now()
       WHERE workspace_id=$2 AND id=$3 AND owner_id=$4 AND owner_epoch=$5
       AND status IN ('running','cancelling') AND lease_expires_at>=now() RETURNING *`,
      [leaseMs, workspaceId, id, ownerId, epoch],
    );
    if (!result.rowCount) throw new Error('Evaluation lease is no longer owned');
    return mapRun(result.rows[0]!);
  }

  async active(workspaceId: string, id: string, ownerId: string, epoch: number): Promise<boolean> {
    const result = await this.pool.query<{ status: string }>(
      `SELECT status FROM ovo_eval_runs WHERE workspace_id=$1 AND id=$2 AND owner_id=$3
       AND owner_epoch=$4 AND lease_expires_at>=now()`,
      [workspaceId, id, ownerId, epoch],
    );
    return result.rows[0]?.status === 'running';
  }

  async cancel(workspaceId: string, id: string): Promise<EvaluationRun | undefined> {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_eval_runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,
       completed_at=CASE WHEN status='queued' THEN now() ELSE completed_at END,updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING *`,
      [workspaceId, id],
    );
    if (result.rowCount) return mapRun(result.rows[0]!);
    return this.get(workspaceId, id);
  }

  async recordResult(
    claim: Pick<EvaluationRun, 'workspaceId' | 'id' | 'ownerId' | 'ownerEpoch'>,
    result: Omit<EvaluationCaseResult, 'runId' | 'workspaceId' | 'createdAt'>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        `SELECT 1 FROM ovo_eval_runs WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND owner_epoch=$4
         AND status IN ('running','cancelling') AND lease_expires_at>=now() FOR UPDATE`,
        [claim.workspaceId, claim.id, claim.ownerId, claim.ownerEpoch],
      );
      if (!owned.rowCount) throw new Error('Evaluation lease is no longer owned');
      const now = new Date().toISOString();
      const inserted = await client.query<Row>(
        `INSERT INTO ovo_eval_case_results
         (workspace_id,run_id,case_id,mode,passed,outputs,error,operations,provenance,duration_ms,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
        [
          claim.workspaceId,
          claim.id,
          result.caseId,
          result.mode,
          result.passed,
          JSON.stringify(result.outputs),
          result.error ?? null,
          JSON.stringify(result.operations),
          JSON.stringify(result.provenance ?? {}),
          result.durationMs,
          now,
        ],
      );
      const row = inserted.rowCount
        ? inserted.rows[0]!
        : (
            await client.query<Row>(
              'SELECT * FROM ovo_eval_case_results WHERE workspace_id=$1 AND run_id=$2 AND case_id=$3',
              [claim.workspaceId, claim.id, result.caseId],
            )
          ).rows[0]!;
      const mapped = mapResult(row);
      if (
        !isDeepStrictEqual(
          stripResult(mapped),
          stripResult({
            runId: claim.id,
            workspaceId: claim.workspaceId,
            caseId: result.caseId,
            mode: result.mode,
            passed: result.passed,
            outputs: result.outputs,
            error: result.error,
            operations: result.operations,
            provenance: result.provenance,
            durationMs: result.durationMs,
            createdAt: mapped.createdAt,
          }),
        )
      )
        throw Object.assign(new Error('Case result identity collision'), { statusCode: 409 });
      await client.query('COMMIT');
      return mapped;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(claim: Pick<EvaluationRun, 'workspaceId' | 'id' | 'ownerId' | 'ownerEpoch'>) {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_eval_runs r SET
       passed=x.passed,failed=x.failed,
       status=CASE WHEN r.status='cancelling' THEN 'cancelled'
         WHEN x.count=r.total THEN 'succeeded' ELSE 'failed' END,
       error=CASE WHEN r.status<>'cancelling' AND x.count<>r.total THEN 'Incomplete case results' ELSE NULL END,
       completed_at=now(),updated_at=now(),lease_expires_at=NULL
       FROM (SELECT count(*)::int count,count(*) FILTER(WHERE passed)::int passed,
         count(*) FILTER(WHERE NOT passed)::int failed FROM ovo_eval_case_results
         WHERE workspace_id=$1 AND run_id=$2) x
       WHERE r.workspace_id=$1 AND r.id=$2 AND r.owner_id=$3 AND r.owner_epoch=$4
       AND r.status IN ('running','cancelling') RETURNING r.*`,
      [claim.workspaceId, claim.id, claim.ownerId, claim.ownerEpoch],
    );
    if (!result.rowCount) throw new Error('Evaluation lease is no longer owned');
    return mapRun(result.rows[0]!);
  }

  async fail(
    claim: Pick<EvaluationRun, 'workspaceId' | 'id' | 'ownerId' | 'ownerEpoch'>,
    error: string,
    retryable: boolean,
  ) {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_eval_runs SET status=CASE WHEN $1 AND attempt<max_attempts THEN 'queued' ELSE 'failed' END,
       error=$2,owner_id=NULL,lease_expires_at=NULL,updated_at=now(),
       completed_at=CASE WHEN $1 AND attempt<max_attempts THEN NULL ELSE now() END
       WHERE workspace_id=$3 AND id=$4 AND owner_id=$5 AND owner_epoch=$6 AND status IN ('running','cancelling') RETURNING *`,
      [
        retryable,
        error.slice(0, 2_000),
        claim.workspaceId,
        claim.id,
        claim.ownerId,
        claim.ownerEpoch,
      ],
    );
    if (!result.rowCount) throw new Error('Evaluation lease is no longer owned');
    return mapRun(result.rows[0]!);
  }

  async listResults(workspaceId: string, runId: string, limit?: number, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_case_results WHERE workspace_id=$1 AND run_id=$2 AND case_id>$3
       ORDER BY case_id LIMIT $4`,
      [workspaceId, runId, after, size + 1],
    );
    return page(result.rows.map(mapResult), size, (item) => item.caseId);
  }

  async compare(
    workspaceId: string,
    baselineRunId: string,
    candidateRunId: string,
  ): Promise<RunComparison> {
    const runs = await this.pool.query<Row>(
      `SELECT id,dataset_id,dataset_version FROM ovo_eval_runs WHERE workspace_id=$1 AND id=ANY($2::text[])`,
      [workspaceId, [baselineRunId, candidateRunId]],
    );
    if (runs.rowCount !== 2)
      throw Object.assign(new Error('Evaluation run not found'), { statusCode: 404 });
    if (
      runs.rows.some(
        (row) =>
          row.dataset_id !== runs.rows[0]!.dataset_id ||
          row.dataset_version !== runs.rows[0]!.dataset_version,
      )
    )
      throw Object.assign(new Error('Runs must use the same immutable dataset version'), {
        statusCode: 409,
      });
    const results = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_case_results WHERE workspace_id=$1 AND run_id=ANY($2::text[])
       ORDER BY case_id`,
      [workspaceId, [baselineRunId, candidateRunId]],
    );
    const mapped = results.rows.map(mapResult);
    return compareResults(
      baselineRunId,
      candidateRunId,
      mapped.filter((item) => item.runId === baselineRunId),
      mapped.filter((item) => item.runId === candidateRunId),
    );
  }
}

function bounded(value: string, max: number) {
  if (!value || value.length > max) throw new TypeError('Idempotency key is invalid');
  return value;
}
