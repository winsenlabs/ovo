import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { mapResult, stripResult } from './run-mappers.ts';
import type { EvaluationCaseResult, EvaluationRun } from './types.ts';

type Row = Record<string, unknown>;

export async function recordRunResult(
  pool: Pool,
  claim: Pick<EvaluationRun, 'workspaceId' | 'id' | 'ownerId' | 'ownerEpoch'>,
  result: Omit<EvaluationCaseResult, 'runId' | 'workspaceId' | 'createdAt'>,
) {
  const client = await pool.connect();
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
